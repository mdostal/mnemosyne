from __future__ import annotations

import tempfile
import unittest
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import yaml

from mnemosyne.inventory.qdrant_inventory import (
    CollectionInventory,
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


if __name__ == "__main__":
    unittest.main()
