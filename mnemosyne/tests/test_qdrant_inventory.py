from __future__ import annotations

import tempfile
import unittest
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from unittest.mock import patch

import yaml

import mnemosyne.inventory.qdrant_inventory as qdrant_inventory_module
from mnemosyne.inventory.qdrant_inventory import (
    CollectionInventory,
    HttpQdrantClient,
    QdrantInventoryError,
    inventory_collections,
    load_qdrant_url,
    read_qdrant_key,
    write_inventory_manifest,
)


@dataclass
class FakeCollection:
    name: str


@dataclass
class FakeCollectionsResponse:
    collections: list[FakeCollection]


@dataclass
class FakeCollectionInfo:
    points_count: int
    created_at: str | None = None


class FakeQdrantClient:
    def __init__(self):
        self.info_requests: list[str] = []

    def get_collections(self) -> FakeCollectionsResponse:
        return FakeCollectionsResponse(
            [FakeCollection("work_root_memory"), FakeCollection("clients_memory")]
        )

    def get_collection(self, collection_name: str) -> FakeCollectionInfo:
        self.info_requests.append(collection_name)
        counts = {"clients_memory": 23, "work_root_memory": 42}
        created = {
            "clients_memory": "2026-07-10T12:00:00Z",
            "work_root_memory": "2026-07-08T09:30:00Z",
        }
        return FakeCollectionInfo(counts[collection_name], created[collection_name])


class QdrantInventoryTests(unittest.TestCase):
    def test_reads_qdrant_key_from_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            key_path = Path(tmp) / "qdrant.key"
            key_path.write_text("  secret-key\n", encoding="utf-8")

            self.assertEqual(read_qdrant_key(key_path), "secret-key")

    def test_missing_qdrant_key_fails_loudly(self):
        with self.assertRaisesRegex(QdrantInventoryError, "missing"):
            read_qdrant_key("/tmp/does-not-exist/qdrant.key")

    def test_loads_qdrant_url_from_env_before_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "config.toml"
            config_path.write_text(
                '[qdrant]\nurl = "https://config.example:6333"\n',
                encoding="utf-8",
            )

            url = load_qdrant_url(
                config_path,
                environ={"SWARM_MEMORY_QDRANT_URL": "https://env.example:6333/"},
            )

            self.assertEqual(url, "https://env.example:6333")

    def test_loads_qdrant_url_from_swarm_memory_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "config.toml"
            config_path.write_text(
                '[qdrant]\nurl = "https://cloud.example:6333"\n',
                encoding="utf-8",
            )

            self.assertEqual(
                load_qdrant_url(config_path, environ={}),
                "https://cloud.example:6333",
            )

    def test_lists_collections_and_extracts_metadata(self):
        client = FakeQdrantClient()

        collections = inventory_collections(client)

        self.assertEqual(
            collections,
            [
                CollectionInventory(
                    name="clients_memory",
                    entry_count=23,
                    created_date="2026-07-10T12:00:00Z",
                ),
                CollectionInventory(
                    name="work_root_memory",
                    entry_count=42,
                    created_date="2026-07-08T09:30:00Z",
                ),
            ],
        )
        self.assertEqual(client.info_requests, ["clients_memory", "work_root_memory"])

    def test_writes_valid_yaml_inventory_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "inventory" / "qdrant-collections.yaml"
            manifest = write_inventory_manifest(
                inventory_collections(FakeQdrantClient()),
                path,
                qdrant_url="https://cloud.example:6333",
                generated_at=datetime(2026, 7, 28, tzinfo=timezone.utc),
            )

            loaded = yaml.safe_load(path.read_text(encoding="utf-8"))

        self.assertEqual(loaded, manifest)
        self.assertEqual(loaded["collection_count"], 2)
        self.assertEqual(
            loaded["metric"],
            {
                "name": "qdrant_collections_discovered",
                "value": 2,
                "unit": "count",
            },
        )
        self.assertEqual(
            loaded["collections"],
            [
                {
                    "name": "clients_memory",
                    "entry_count": 23,
                    "created_date": "2026-07-10T12:00:00Z",
                },
                {
                    "name": "work_root_memory",
                    "entry_count": 42,
                    "created_date": "2026-07-08T09:30:00Z",
                },
            ],
        )


class ScrollPointsTests(unittest.TestCase):
    """cm-13-intake-distribution: HttpQdrantClient.scroll_points() -- a new,
    purely READ-ONLY method (mirrors list_collections()/collection_info()'s
    own risk category, never create_collection()'s one deliberate write
    exception). Real Qdrant scroll shape confirmed live against the
    operator's own Qdrant Cloud cluster this story's research step
    (2026-08-27, POST /collections/{name}/points/scroll ->
    {"result": {"points": [{"id", "payload"}, ...], "next_page_offset"},
    "status": "ok"}) -- these tests stub HttpQdrantClient._request() so no
    live Qdrant call is ever made, mirroring this story's own TS-side "fake
    client, never live Qdrant" discipline at the Python layer.
    """

    def test_scroll_points_issues_only_read_shaped_scroll_requests_and_paginates(self):
        client = HttpQdrantClient("https://example.qdrant.local", "fake-key")
        calls: list[tuple[str, str, dict[str, Any] | None]] = []
        responses = [
            {
                "result": {
                    "points": [{"id": "a", "payload": {"text": "one"}}],
                    "next_page_offset": "a",
                }
            },
            {
                "result": {
                    "points": [{"id": "b", "payload": {"text": "two"}}],
                    "next_page_offset": None,
                }
            },
        ]

        def fake_request(method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
            calls.append((method, path, body))
            return responses.pop(0)

        with patch.object(client, "_request", side_effect=fake_request):
            points = client.scroll_points("conversation_memory_intake")

        self.assertEqual(
            points,
            [
                {"id": "a", "payload": {"text": "one"}},
                {"id": "b", "payload": {"text": "two"}},
            ],
        )
        # Every real HTTP call this method issues is the scroll-shaped read
        # endpoint, against the SAME collection every time -- never a
        # different collection, never a PUT/DELETE verb.
        self.assertEqual(len(calls), 2)
        for method, path, _ in calls:
            self.assertEqual(method, "POST")
            self.assertEqual(path, "/collections/conversation_memory_intake/points/scroll")
        # Pagination: the second call carries the first page's own
        # next_page_offset; the first call has no offset at all.
        self.assertIsNone(calls[0][2].get("offset") if calls[0][2] else None)
        self.assertEqual(calls[1][2]["offset"], "a")

    def test_scroll_points_passes_payload_filter_through_unchanged(self):
        client = HttpQdrantClient("https://example.qdrant.local", "fake-key")
        captured: dict[str, Any] = {}
        real_filter = {"must": [{"key": "entry_type", "match": {"value": "distribution_marker"}}]}

        def fake_request(method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
            captured["method"] = method
            captured["path"] = path
            captured["body"] = body
            return {"result": {"points": [], "next_page_offset": None}}

        with patch.object(client, "_request", side_effect=fake_request):
            result = client.scroll_points("conversation_memory_intake", payload_filter=real_filter)

        self.assertEqual(result, [])
        self.assertEqual(captured["body"]["filter"], real_filter)
        # Confirms the filter object is passed through verbatim, not
        # rewritten/reinterpreted by this method.
        self.assertIs(captured["body"]["filter"], real_filter)

    def test_scroll_points_no_filter_omits_filter_key(self):
        client = HttpQdrantClient("https://example.qdrant.local", "fake-key")
        captured: dict[str, Any] = {}

        def fake_request(method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
            captured["body"] = body
            return {"result": {"points": [], "next_page_offset": None}}

        with patch.object(client, "_request", side_effect=fake_request):
            client.scroll_points("conversation_memory_intake")

        self.assertNotIn("filter", captured["body"])

    def test_scroll_points_empty_collection_returns_empty_list(self):
        client = HttpQdrantClient("https://example.qdrant.local", "fake-key")

        def fake_request(method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
            return {"result": {"points": [], "next_page_offset": None}}

        with patch.object(client, "_request", side_effect=fake_request):
            self.assertEqual(client.scroll_points("conversation_memory_intake"), [])

    def test_scroll_points_never_issues_a_write_or_delete_verb(self):
        """Defense in depth, mirroring this story's own highest-scrutiny
        requirement: scroll_points() must be a pure read. Confirms every
        call this method ever makes uses POST (Qdrant's own read-shaped
        scroll verb) -- never PUT (create_collection()'s own verb) or
        DELETE (which does not exist anywhere in this module)."""
        client = HttpQdrantClient("https://example.qdrant.local", "fake-key")
        methods_used: list[str] = []

        def fake_request(method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
            methods_used.append(method)
            return {"result": {"points": [], "next_page_offset": None}}

        with patch.object(client, "_request", side_effect=fake_request):
            client.scroll_points("conversation_memory_intake")

        self.assertTrue(len(methods_used) > 0)
        self.assertTrue(all(method == "POST" for method in methods_used))
        self.assertNotIn("PUT", methods_used)
        self.assertNotIn("DELETE", methods_used)

    def test_module_docstring_no_delete_drop_contract_unchanged(self):
        """cm-13's addition is read-only; create_collection()'s own
        one-deliberate-write-exception status, and the module's own "no
        delete/drop method exists anywhere" contract, must still hold,
        verified directly against the real module docstring text (not
        merely asserted in a comment)."""
        normalized_doc = " ".join((qdrant_inventory_module.__doc__ or "").split())
        self.assertIn(
            "no delete/drop method exists anywhere in this module",
            normalized_doc,
        )
        # HttpQdrantClient's own real, live method surface has exactly one
        # non-read (write) method -- create_collection() -- confirmed by
        # name, not merely by docstring claim.
        public_methods = [
            name
            for name in dir(HttpQdrantClient)
            if not name.startswith("_") and callable(getattr(HttpQdrantClient, name))
        ]
        self.assertIn("create_collection", public_methods)
        self.assertIn("scroll_points", public_methods)
        self.assertNotIn("delete_collection", public_methods)
        self.assertNotIn("drop_collection", public_methods)
        self.assertFalse(any("delete" in name.lower() for name in public_methods))
        self.assertFalse(any("drop" in name.lower() for name in public_methods))


if __name__ == "__main__":
    unittest.main()
