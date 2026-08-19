from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import yaml

from mnemosyne.placement_engine import (
    PlacementError,
    PlacementResult,
    classify_collection,
    classify_collection_metadata,
    load_inventory,
    place_collections,
    write_placement_manifest,
)


class ProjectScopedDetectionTests(unittest.TestCase):
    def test_name_containing_project_prefix_maps_to_project_scope(self):
        result = classify_collection("project-atlas")

        self.assertEqual(result.scope, "project")
        self.assertFalse(result.needs_override)
        self.assertEqual(result.org_tree_path, "org/project/atlas")

    def test_project_prefix_detected_mid_name(self):
        result = classify_collection("clients_project-atlas_memory")

        self.assertEqual(result.scope, "project")
        self.assertFalse(result.needs_override)


class EnterpriseScopedDetectionTests(unittest.TestCase):
    def test_name_containing_enterprise_prefix_maps_to_enterprise_scope(self):
        result = classify_collection("enterprise-shared")

        self.assertEqual(result.scope, "enterprise")
        self.assertFalse(result.needs_override)
        self.assertEqual(result.org_tree_path, "org/enterprise/shared")

    def test_enterprise_prefix_detected_mid_name(self):
        result = classify_collection("acme_enterprise-shared_memory")

        self.assertEqual(result.scope, "enterprise")
        self.assertFalse(result.needs_override)


class DefaultPlacementWithOverrideTests(unittest.TestCase):
    def test_no_scope_hint_defaults_to_enterprise_with_override_flag(self):
        result = classify_collection("clients_memory")

        self.assertEqual(result.scope, "enterprise")
        self.assertTrue(result.needs_override)
        self.assertIn("no scope hint", result.reason)

    def test_real_inventory_sample_names_default_with_override(self):
        for name in ("arizona_compound", "claude_knowledge", "work_root_memory"):
            with self.subTest(name=name):
                result = classify_collection(name)
                self.assertEqual(result.scope, "enterprise")
                self.assertTrue(result.needs_override)

    def test_ambiguous_name_with_both_markers_defaults_with_override(self):
        result = classify_collection("project-enterprise-shared")

        self.assertEqual(result.scope, "enterprise")
        self.assertTrue(result.needs_override)
        self.assertIn("ambiguous", result.reason)


class EdgeCaseTests(unittest.TestCase):
    def test_missing_name_raises_placement_error(self):
        with self.assertRaisesRegex(PlacementError, "missing"):
            classify_collection(None)

    def test_empty_name_raises_placement_error(self):
        with self.assertRaisesRegex(PlacementError, "empty"):
            classify_collection("")

    def test_whitespace_only_name_raises_placement_error(self):
        with self.assertRaisesRegex(PlacementError, "empty"):
            classify_collection("   ")

    def test_metadata_missing_name_field_raises_placement_error(self):
        with self.assertRaisesRegex(PlacementError, "name"):
            classify_collection_metadata({"entry_count": 5})

    def test_metadata_with_none_name_raises_placement_error(self):
        with self.assertRaisesRegex(PlacementError, "missing"):
            classify_collection_metadata({"name": None, "entry_count": 5})

    def test_load_inventory_missing_file_raises_placement_error(self):
        with self.assertRaisesRegex(PlacementError, "missing"):
            load_inventory("/tmp/does-not-exist/qdrant-collections.yaml")

    def test_load_inventory_missing_collections_key_raises_placement_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "qdrant-collections.yaml"
            path.write_text(yaml.safe_dump({"generated_at": "now"}), encoding="utf-8")

            with self.assertRaisesRegex(PlacementError, "collections"):
                load_inventory(path)


class BatchPlacementTests(unittest.TestCase):
    def test_place_collections_returns_result_per_entry(self):
        collections = [
            {"name": "project-atlas", "entry_count": 10, "created_date": None},
            {"name": "enterprise-shared", "entry_count": 20, "created_date": None},
            {"name": "clients_memory", "entry_count": 30, "created_date": None},
        ]

        results = place_collections(collections)

        self.assertEqual(
            [r.scope for r in results], ["project", "enterprise", "enterprise"]
        )
        self.assertEqual(
            [r.needs_override for r in results], [False, False, True]
        )

    def test_place_collections_propagates_missing_name_error(self):
        with self.assertRaises(PlacementError):
            place_collections([{"entry_count": 1}])


class WritePlacementManifestTests(unittest.TestCase):
    def test_writes_valid_yaml_with_override_count(self):
        results = [
            PlacementResult(
                name="project-atlas",
                scope="project",
                org_tree_path="org/project/atlas",
                needs_override=False,
                reason="name contains 'project-'",
            ),
            PlacementResult(
                name="clients_memory",
                scope="enterprise",
                org_tree_path="org/enterprise/clients_memory",
                needs_override=True,
                reason="no scope hint in name; defaulted to enterprise pending operator review",
            ),
        ]

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "placement" / "qdrant-placement.yaml"
            manifest = write_placement_manifest(results, path)

            loaded = yaml.safe_load(path.read_text(encoding="utf-8"))

        self.assertEqual(loaded, manifest)
        self.assertEqual(loaded["placement_count"], 2)
        self.assertEqual(loaded["override_needed_count"], 1)
        self.assertEqual(loaded["placements"][0]["name"], "project-atlas")
        self.assertEqual(loaded["placements"][1]["needs_override"], True)


if __name__ == "__main__":
    unittest.main()
