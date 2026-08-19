from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from mnemosyne.onboarding import (
    CollectionCreationResult,
    OnboardingError,
    create_collection_and_scope,
    write_scope_mapping,
)


class FakeCreatableQdrantClient:
    """Mockable read-write Qdrant client -- mirrors
    mnemosyne/inventory/qdrant_inventory.py's own HttpQdrantClient shape
    (list_collections/create_collection), never a live Qdrant call.
    """

    def __init__(self, initial_collections: list[str] | None = None, fail_create: bool = False):
        self._collections = list(initial_collections or [])
        self.create_calls: list[tuple[str, int]] = []
        self.list_calls = 0
        self.fail_create = fail_create

    def list_collections(self) -> list[str]:
        self.list_calls += 1
        return list(self._collections)

    def create_collection(self, name: str, dim: int) -> None:
        self.create_calls.append((name, dim))
        if self.fail_create:
            raise RuntimeError("simulated Qdrant PUT failure")
        self._collections.append(name)


class FailingListQdrantClient:
    def list_collections(self) -> list[str]:
        raise RuntimeError("simulated Qdrant unreachable")

    def create_collection(self, name: str, dim: int) -> None:  # pragma: no cover
        raise AssertionError("create_collection must never be called when listing fails")


REAL_CONFIG_TEXT = """# swarm-memory config — example
[qdrant]
url = "https://example.qdrant.io:6333"

[embedder]
provider = "ollama"
model = "nomic-embed-text"
dim = 768

[scopes]
top = "work_root_memory"
clients = "clients_memory"

[ladder]
clients = ["top"]
"""


class WriteScopeMappingTests(unittest.TestCase):
    """Real (temp-file) tests of the confirmed real write target:
    swarm-memory's own config.toml [scopes] table -- the same file/table
    VectorLayerAdapter.ts:213-226 reads via `swarm-memory config`'s JSON
    `scopes` field (research finding, see mnemosyne/onboarding.py's
    module docstring)."""

    def test_writes_new_scope_into_existing_scopes_table(self):
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "config.toml"
            config_path.write_text(REAL_CONFIG_TEXT, encoding="utf-8")

            wrote = write_scope_mapping("newrepo", "newrepo_memory", config_path)

            self.assertTrue(wrote)
            updated = config_path.read_text(encoding="utf-8")
            self.assertIn('newrepo = "newrepo_memory"', updated)
            # additive-only: every pre-existing line must still be present verbatim
            for line in REAL_CONFIG_TEXT.splitlines():
                self.assertIn(line, updated)

    def test_creates_scopes_table_when_none_exists(self):
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "config.toml"
            config_path.write_text('[qdrant]\nurl = "https://example.qdrant.io:6333"\n', encoding="utf-8")

            wrote = write_scope_mapping("newrepo", "newrepo_memory", config_path)

            self.assertTrue(wrote)
            updated = config_path.read_text(encoding="utf-8")
            self.assertIn("[scopes]", updated)
            self.assertIn('newrepo = "newrepo_memory"', updated)

    def test_idempotent_same_mapping_is_a_noop(self):
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "config.toml"
            config_path.write_text(REAL_CONFIG_TEXT, encoding="utf-8")

            first = write_scope_mapping("newrepo", "newrepo_memory", config_path)
            after_first = config_path.read_text(encoding="utf-8")
            second = write_scope_mapping("newrepo", "newrepo_memory", config_path)
            after_second = config_path.read_text(encoding="utf-8")

            self.assertTrue(first)
            self.assertFalse(second)
            self.assertEqual(after_first, after_second)

    def test_conflicting_mapping_fails_loudly_without_overwriting(self):
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "config.toml"
            config_path.write_text(REAL_CONFIG_TEXT, encoding="utf-8")

            with self.assertRaisesRegex(OnboardingError, "already mapped"):
                write_scope_mapping("clients", "some_other_collection", config_path)

            # never silently overwritten
            self.assertIn('clients = "clients_memory"', config_path.read_text(encoding="utf-8"))

    def test_missing_config_file_creates_one(self):
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "nested" / "config.toml"

            wrote = write_scope_mapping("newrepo", "newrepo_memory", config_path)

            self.assertTrue(wrote)
            self.assertIn('newrepo = "newrepo_memory"', config_path.read_text(encoding="utf-8"))

    def test_unsafe_scope_key_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "config.toml"
            config_path.write_text(REAL_CONFIG_TEXT, encoding="utf-8")

            with self.assertRaises(OnboardingError):
                write_scope_mapping('bad"scope', "x_memory", config_path)


class CreateCollectionAndScopeTests(unittest.TestCase):
    def _config_path(self, tmp: str) -> Path:
        path = Path(tmp) / "config.toml"
        path.write_text(REAL_CONFIG_TEXT, encoding="utf-8")
        return path

    def test_fresh_creation_creates_collection_and_writes_scope_mapping(self):
        with tempfile.TemporaryDirectory() as tmp:
            config_path = self._config_path(tmp)
            client = FakeCreatableQdrantClient(initial_collections=["work_root_memory"])

            result = create_collection_and_scope(
                "newrepo_memory", "newrepo", client=client, config_path=config_path
            )

            self.assertIsInstance(result, CollectionCreationResult)
            self.assertTrue(result.ok)
            self.assertTrue(result.collection_created)
            self.assertTrue(result.scope_mapped)
            self.assertEqual(client.create_calls, [("newrepo_memory", 768)])
            self.assertIn(
                'newrepo = "newrepo_memory"',
                config_path.read_text(encoding="utf-8"),
            )

    def test_idempotent_second_call_creates_nothing_new_and_raises_no_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            config_path = self._config_path(tmp)
            client = FakeCreatableQdrantClient(initial_collections=["work_root_memory"])

            first = create_collection_and_scope(
                "newrepo_memory", "newrepo", client=client, config_path=config_path
            )
            second = create_collection_and_scope(
                "newrepo_memory", "newrepo", client=client, config_path=config_path
            )

            self.assertTrue(first.ok)
            self.assertTrue(second.ok)
            self.assertFalse(second.collection_created)
            self.assertFalse(second.scope_mapped)
            # exactly one create_collection call ever, never a second/duplicate
            self.assertEqual(client.create_calls, [("newrepo_memory", 768)])
            self.assertEqual(client.list_calls, 2)

    def test_collection_already_exists_only_writes_scope_mapping(self):
        with tempfile.TemporaryDirectory() as tmp:
            config_path = self._config_path(tmp)
            client = FakeCreatableQdrantClient(
                initial_collections=["work_root_memory", "newrepo_memory"]
            )

            result = create_collection_and_scope(
                "newrepo_memory", "newrepo", client=client, config_path=config_path
            )

            self.assertTrue(result.ok)
            self.assertFalse(result.collection_created)
            self.assertTrue(result.scope_mapped)
            self.assertEqual(client.create_calls, [])

    def test_scope_already_mapped_only_creates_collection(self):
        with tempfile.TemporaryDirectory() as tmp:
            config_path = self._config_path(tmp)
            client = FakeCreatableQdrantClient(initial_collections=["work_root_memory"])

            result = create_collection_and_scope(
                "clients_memory", "clients", client=client, config_path=config_path
            )

            self.assertTrue(result.ok)
            self.assertTrue(result.collection_created)
            self.assertFalse(result.scope_mapped)

    def test_partial_failure_collection_created_but_scope_write_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            config_path = self._config_path(tmp)
            client = FakeCreatableQdrantClient(initial_collections=["work_root_memory"])

            # scope "clients" already maps to a DIFFERENT collection -> the
            # scope-mapping half must fail loudly after the collection half
            # already succeeded.
            result = create_collection_and_scope(
                "brand_new_memory", "clients", client=client, config_path=config_path
            )

            self.assertFalse(result.ok)
            self.assertTrue(result.collection_created)
            self.assertFalse(result.scope_mapped)
            self.assertIn("collection", result.detail.lower())
            self.assertIn("scope", result.detail.lower())
            # the collection itself really was created despite the overall failure
            self.assertIn("brand_new_memory", client.list_collections())

    def test_collection_creation_failure_reports_before_scope_write_attempted(self):
        with tempfile.TemporaryDirectory() as tmp:
            config_path = self._config_path(tmp)
            client = FakeCreatableQdrantClient(
                initial_collections=["work_root_memory"], fail_create=True
            )
            before = config_path.read_text(encoding="utf-8")

            result = create_collection_and_scope(
                "newrepo_memory", "newrepo", client=client, config_path=config_path
            )

            self.assertFalse(result.ok)
            self.assertFalse(result.collection_created)
            self.assertFalse(result.scope_mapped)
            self.assertIn("creation failed", result.detail.lower())
            # config.toml must be byte-identical -- no scope write was even attempted
            self.assertEqual(before, config_path.read_text(encoding="utf-8"))

    def test_listing_failure_reports_before_anything_is_attempted(self):
        with tempfile.TemporaryDirectory() as tmp:
            config_path = self._config_path(tmp)
            client = FailingListQdrantClient()
            before = config_path.read_text(encoding="utf-8")

            result = create_collection_and_scope(
                "newrepo_memory", "newrepo", client=client, config_path=config_path
            )

            self.assertFalse(result.ok)
            self.assertFalse(result.collection_created)
            self.assertFalse(result.scope_mapped)
            self.assertEqual(before, config_path.read_text(encoding="utf-8"))

    def test_empty_name_or_scope_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            config_path = self._config_path(tmp)
            client = FakeCreatableQdrantClient()

            with self.assertRaises(OnboardingError):
                create_collection_and_scope("", "newrepo", client=client, config_path=config_path)
            with self.assertRaises(OnboardingError):
                create_collection_and_scope("newrepo_memory", "", client=client, config_path=config_path)


if __name__ == "__main__":
    unittest.main()
