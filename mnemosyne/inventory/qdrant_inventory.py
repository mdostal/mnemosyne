"""Read-only Qdrant collection inventory for Mnemosyne ingestion."""

from __future__ import annotations

import argparse
import configparser
import json
import os
import ssl
import sys
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping

import yaml

DEFAULT_KEY_PATH = Path("~/.config/swarm-memory/qdrant.key").expanduser()
DEFAULT_CONFIG_PATH = Path("~/.config/swarm-memory/config.toml").expanduser()
DEFAULT_MANIFEST_PATH = Path(
    ".pHive/epics/ingest-a10ab2c1/inventory/qdrant-collections.yaml"
)


class QdrantInventoryError(RuntimeError):
    """Raised when inventory cannot complete with trustworthy data."""


@dataclass(frozen=True)
class CollectionInventory:
    name: str
    entry_count: int
    created_date: str | None


class HttpQdrantClient:
    """Tiny read-only client used when qdrant-client is not installed."""

    def __init__(self, url: str, api_key: str, timeout: int = 20):
        self.url = url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout
        self._ssl = ssl.create_default_context()

    def _request(self, method: str, path: str) -> dict[str, Any]:
        headers = {"content-type": "application/json"}
        if self.api_key:
            headers["api-key"] = self.api_key
        req = urllib.request.Request(self.url + path, headers=headers, method=method)
        try:
            with urllib.request.urlopen(
                req, timeout=self.timeout, context=self._ssl
            ) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode(errors="replace")[:300]
            raise QdrantInventoryError(
                f"Qdrant {method} {path} failed with HTTP {exc.code}: {detail}"
            ) from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise QdrantInventoryError(f"Qdrant unreachable at {self.url}: {exc}") from exc

    def list_collections(self) -> list[str]:
        result = self._request("GET", "/collections").get("result", {})
        return [
            str(collection["name"])
            for collection in result.get("collections", [])
            if "name" in collection
        ]

    def collection_info(self, name: str) -> dict[str, Any]:
        result = self._request("GET", f"/collections/{name}").get("result")
        if not isinstance(result, dict):
            raise QdrantInventoryError(f"Qdrant returned no metadata for {name!r}")
        return result


def read_qdrant_key(path: str | Path = DEFAULT_KEY_PATH) -> str:
    key_path = Path(path).expanduser()
    try:
        key = key_path.read_text(encoding="utf-8").strip()
    except FileNotFoundError as exc:
        raise QdrantInventoryError(f"Qdrant API key file missing: {key_path}") from exc
    if not key:
        raise QdrantInventoryError(f"Qdrant API key file is empty: {key_path}")
    return key


def load_qdrant_url(
    config_path: str | Path = DEFAULT_CONFIG_PATH,
    environ: Mapping[str, str] | None = None,
) -> str:
    env = environ or os.environ
    if env.get("SWARM_MEMORY_QDRANT_URL"):
        return env["SWARM_MEMORY_QDRANT_URL"].rstrip("/")

    path = Path(config_path).expanduser()
    if not path.is_file():
        raise QdrantInventoryError(
            "Qdrant URL not configured: set SWARM_MEMORY_QDRANT_URL or "
            f"create {path}"
        )

    parser = configparser.ConfigParser()
    parser.read(path)
    url = parser.get("qdrant", "url", fallback="").strip().strip('"').strip("'")
    if not url:
        raise QdrantInventoryError(f"Qdrant URL missing from {path}")
    return url.rstrip("/")


def build_qdrant_client(url: str, api_key: str) -> Any:
    try:
        from qdrant_client import QdrantClient
    except ImportError:
        return HttpQdrantClient(url, api_key)
    return QdrantClient(url=url, api_key=api_key)


def list_collection_names(client: Any) -> list[str]:
    if hasattr(client, "get_collections"):
        response = client.get_collections()
        collections = _value(response, "collections", default=[])
        return sorted(
            str(_value(collection, "name"))
            for collection in collections
            if _value(collection, "name") is not None
        )
    if hasattr(client, "list_collections"):
        return sorted(str(name) for name in client.list_collections())
    raise QdrantInventoryError("Qdrant client cannot list collections")


def extract_collection_metadata(client: Any, name: str) -> CollectionInventory:
    info = _collection_info(client, name)
    count = _first_present(
        info,
        "points_count",
        "vectors_count",
        "indexed_vectors_count",
        default=0,
    )
    created_date = _first_present(
        info,
        "created_at",
        "created_date",
        "creation_time",
        "created_time",
        default=None,
    )
    return CollectionInventory(
        name=name,
        entry_count=int(count or 0),
        created_date=str(created_date) if created_date else None,
    )


def inventory_collections(client: Any) -> list[CollectionInventory]:
    return [
        extract_collection_metadata(client, name)
        for name in list_collection_names(client)
    ]


def write_inventory_manifest(
    collections: Iterable[CollectionInventory],
    path: str | Path = DEFAULT_MANIFEST_PATH,
    *,
    qdrant_url: str,
    generated_at: datetime | None = None,
) -> dict[str, Any]:
    generated = generated_at or datetime.now(timezone.utc)
    entries = [asdict(collection) for collection in collections]
    manifest = {
        "generated_at": generated.isoformat().replace("+00:00", "Z"),
        "source": {
            "kind": "qdrant",
            "url": qdrant_url,
            "read_only": True,
        },
        "collection_count": len(entries),
        "metric": {
            "name": "qdrant_collections_discovered",
            "value": len(entries),
            "unit": "count",
        },
        "collections": entries,
    }

    manifest_path = Path(path)
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(
        yaml.safe_dump(manifest, sort_keys=False), encoding="utf-8"
    )
    return manifest


def run_inventory(
    *,
    key_path: str | Path = DEFAULT_KEY_PATH,
    config_path: str | Path = DEFAULT_CONFIG_PATH,
    manifest_path: str | Path = DEFAULT_MANIFEST_PATH,
    environ: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    api_key = read_qdrant_key(key_path)
    url = load_qdrant_url(config_path, environ)
    client = build_qdrant_client(url, api_key)
    collections = inventory_collections(client)
    return write_inventory_manifest(collections, manifest_path, qdrant_url=url)


def _collection_info(client: Any, name: str) -> Any:
    if hasattr(client, "get_collection"):
        return client.get_collection(collection_name=name)
    if hasattr(client, "collection_info"):
        return client.collection_info(name)
    raise QdrantInventoryError("Qdrant client cannot fetch collection metadata")


def _value(value: Any, key: str, default: Any = None) -> Any:
    if isinstance(value, Mapping):
        return value.get(key, default)
    return getattr(value, key, default)


def _first_present(value: Any, *keys: str, default: Any = None) -> Any:
    for key in keys:
        found = _value(value, key, default=None)
        if found is not None:
            return found
    return default


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--key-path", default=str(DEFAULT_KEY_PATH))
    parser.add_argument("--config-path", default=str(DEFAULT_CONFIG_PATH))
    parser.add_argument("--manifest-path", default=str(DEFAULT_MANIFEST_PATH))
    args = parser.parse_args(argv)

    try:
        manifest = run_inventory(
            key_path=args.key_path,
            config_path=args.config_path,
            manifest_path=args.manifest_path,
        )
    except QdrantInventoryError as exc:
        print(f"qdrant inventory failed: {exc}", file=sys.stderr)
        return 1

    print(
        "wrote "
        f"{args.manifest_path} with {manifest['collection_count']} collections"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
