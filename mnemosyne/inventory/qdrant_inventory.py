"""Qdrant collection inventory for Mnemosyne ingestion.

Read-only by design for every symbol that predates story ro-06
(mnemosyne-repo-onboarding). ``HttpQdrantClient.create_collection()``
(added by ro-06) is the one deliberate, narrow, additive-only exception --
it creates a brand-new collection and nothing else; no delete/drop method
exists anywhere in this module. Callers needing safe, idempotent
create-if-missing behaviour should use ``mnemosyne.onboarding.
create_collection_and_scope()``, not this method directly.
"""

from __future__ import annotations

import argparse
import configparser
import json
import os
import re
import ssl
import sys
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping

import yaml

# cm-16-triage-review-and-confirm-ui (epic: mnemosyne-conversation-memory):
# the intake collection's own real, fixed name (matches
# distributeIntakeEntries.ts's own INTAKE_COLLECTION_NAME constant
# byte-for-byte) -- used at exactly one call site (collect_intake_candidates()
# below), never caller-parameterized.
INTAKE_COLLECTION_NAME = "conversation_memory_intake"

# Mirrors distillAndRemember.ts's own private PROVENANCE_HEADER_MARKER
# constant value EXACTLY (same literal string) -- see
# extract_intake_provenance() below for why this is a deliberate, small,
# separate re-implementation rather than an import (no Python/TS bridge
# exists for this).
INTAKE_PROVENANCE_MARKER = "mnemosyne-intake-provenance"
_INTAKE_PROVENANCE_RE = re.compile(
    r"<!-- " + re.escape(INTAKE_PROVENANCE_MARKER) + r"\n(.*?)\n-->", re.DOTALL
)

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

    def _request(
        self, method: str, path: str, body: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        headers = {"content-type": "application/json"}
        if self.api_key:
            headers["api-key"] = self.api_key
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(
            self.url + path, data=data, headers=headers, method=method
        )
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

    def scroll_points(
        self, name: str, payload_filter: dict[str, Any] | None = None
    ) -> list[dict[str, Any]]:
        """Enumerate every point in collection ``name`` -- a NEW, purely
        READ-ONLY method (story cm-13-intake-distribution, epic
        mnemosyne-conversation-memory), in the SAME low-risk category as
        this class's own existing ``list_collections()``/``collection_info()``
        reads, never the same category as ``create_collection()``'s one
        deliberate write exception. Does NOT add a delete/drop capability --
        see the module docstring, still accurate after this addition.

        Wraps Qdrant's own native ``POST /collections/{name}/points/scroll``
        endpoint -- real shape confirmed directly against the operator's own
        live Qdrant Cloud cluster this story's research step (2026-08-27):
        ``{"result": {"points": [{"id": ..., "payload": {...}}, ...],
        "next_page_offset": <id> | null}, "status": "ok"}``. Despite being an
        HTTP POST (required to carry a filter/limit body), this is Qdrant's
        own genuinely read-only enumeration verb -- no point is created,
        modified, or removed by this call.

        Paginates internally via ``next_page_offset`` until Qdrant reports
        none remaining (or returns an empty page), returning the FULL,
        flattened list of ``{"id", "payload"}`` entries across every page --
        callers never need to handle pagination themselves.

        ``payload_filter``, when given, is passed through UNCHANGED as
        Qdrant's own native filter body (e.g. ``{"must": [{"key": ...,
        "match": {"value": ...}}]}``) -- this method performs no filter
        validation or rewriting of its own; omit it (default `None`) to
        enumerate every point in the collection with no filter at all.
        """
        points: list[dict[str, Any]] = []
        offset: Any = None
        while True:
            body: dict[str, Any] = {"limit": 250, "with_payload": True, "with_vector": False}
            if payload_filter is not None:
                body["filter"] = payload_filter
            if offset is not None:
                body["offset"] = offset

            result = self._request(
                "POST", f"/collections/{name}/points/scroll", body=body
            ).get("result", {})
            batch = result.get("points", [])
            points.extend(
                {"id": point.get("id"), "payload": point.get("payload", {})}
                for point in batch
            )

            offset = result.get("next_page_offset")
            if offset is None or not batch:
                break
        return points

    def create_collection(self, name: str, dim: int) -> None:
        """Create a NEW Qdrant collection (unnamed vector, cosine distance).

        Additive-only, story ro-06 (epic mnemosyne-repo-onboarding): this is
        the confirmed fallback path -- research found no swarm-memory-native
        collection-create CLI verb (see mnemosyne/onboarding.py's module
        docstring for the full research record). Mirrors the request shape
        swarm-memory's own internal QdrantClient.ensure_collection() already
        uses (swarm_memory/qdrant.py in the installed swarm-memory package):
        ``PUT /collections/{name}`` with ``{"vectors": {"size": dim,
        "distance": "Cosine"}}``.

        Callers MUST confirm via a read-only check (e.g. list_collections())
        that ``name`` does not already exist before calling this -- Qdrant's
        own PUT /collections/{name} RECREATES (silently replaces) an
        existing collection rather than erroring, so this method is never
        safe to call blindly against a name that might already exist. This
        class has no delete/drop method anywhere -- ways_of_working.md's
        hard "never wipe Qdrant" rule.
        """
        self._request(
            "PUT",
            f"/collections/{name}",
            body={"vectors": {"size": dim, "distance": "Cosine"}},
        )


def extract_intake_provenance(text: str) -> dict[str, Any] | None:
    """Re-implements distillAndRemember.ts's own buildProvenanceHeader()/
    parseProvenanceHeader() comment-marker extraction locally (~10 lines) --
    a deliberate, small, separate SECOND implementation of the SAME format
    (a JSON blob inside a fixed HTML-comment marker), mirroring
    bin/graphify-bridge.mjs's own already-accepted precedent for exactly
    this kind of low-risk cross-language duplication (docs/design-
    discussion.md §12.3, cm-16-triage-review-and-confirm-ui). Returns
    ``None`` (never raises) when `text` carries no, or a malformed,
    provenance header -- mirrors parseProvenanceHeader()'s own identical
    "never throws" contract.
    """
    match = _INTAKE_PROVENANCE_RE.search(text)
    if not match:
        return None
    try:
        parsed = json.loads(match.group(1))
    except (json.JSONDecodeError, TypeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def collect_intake_candidates(client: Any) -> dict[str, Any]:
    """Read-only: ``scroll_points(INTAKE_COLLECTION_NAME)`` -- the exact,
    fixed collection name, never caller-parameterized (mirrors
    distributeIntakeEntries.ts's own identical hard constraint: no code path
    here can ever scroll any other collection).

    Returns the RAW points list (``points``, each ``{"id", "payload"}``) --
    cm-16's own TS side (bin/mnemosyne-conversation-triage-review.mjs ->
    lib/mnemosyne/conversation-memory/distributeIntakeEntries.ts's
    ``computeIntakeCandidateStatuses()``) re-parses this SAME raw list via
    that file's own real, UNCHANGED ``partitionPoints()``/
    ``readScopeRouteConfirmations()`` -- the actual candidate/marker
    classification AND the confirmed-vs-unconfirmed status decision is never
    made here, never re-derived independently (this story's own hard
    constraint). ``candidate_count``/``marker_count`` below are a small,
    PURELY INFORMATIONAL summary (computed via extract_intake_provenance()
    above) -- never consumed by, and never a substitute for, the TS side's
    own real partitioning.
    """
    points = client.scroll_points(INTAKE_COLLECTION_NAME)
    candidate_count = 0
    marker_count = 0
    for point in points:
        payload = point.get("payload") or {}
        text = payload.get("text")
        if not isinstance(text, str):
            continue
        metadata = extract_intake_provenance(text)
        if metadata is None:
            continue
        if metadata.get("entry_type") == "distribution_marker":
            marker_count += 1
        else:
            candidate_count += 1
    return {
        "points": points,
        "candidate_count": candidate_count,
        "marker_count": marker_count,
    }


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


def run_intake_candidates(
    *,
    key_path: str | Path = DEFAULT_KEY_PATH,
    config_path: str | Path = DEFAULT_CONFIG_PATH,
    environ: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """cm-16-triage-review-and-confirm-ui's own read-only entry point --
    mirrors run_inventory()'s own credential/URL-resolution + client-build
    sequence exactly, then delegates to collect_intake_candidates() (never a
    write of any kind, never a manifest file written to disk -- this verb's
    whole result is printed to stdout by main(), below)."""
    api_key = read_qdrant_key(key_path)
    url = load_qdrant_url(config_path, environ)
    client = build_qdrant_client(url, api_key)
    return collect_intake_candidates(client)


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
    # Top-level args -- UNCHANGED, byte-for-byte, from before this story:
    # every existing caller of `main()`/this CLI with no subcommand keeps
    # working exactly as it did (this story's own "additive to its own
    # existing argparse surface" requirement).
    parser.add_argument("--key-path", default=str(DEFAULT_KEY_PATH))
    parser.add_argument("--config-path", default=str(DEFAULT_CONFIG_PATH))
    parser.add_argument("--manifest-path", default=str(DEFAULT_MANIFEST_PATH))

    # cm-16-triage-review-and-confirm-ui: ONE new, additive, READ-ONLY
    # subcommand -- `command` is `None` when omitted entirely, so the
    # default (no-subcommand) path below is completely unaffected.
    subparsers = parser.add_subparsers(dest="command")
    intake_parser = subparsers.add_parser(
        "intake-candidates",
        help=(
            "Read-only: scroll_points('conversation_memory_intake') and print "
            "the raw points + a small candidate/marker count summary as JSON "
            "(cm-16-triage-review-and-confirm-ui). No delete/write capability "
            "of any kind."
        ),
    )
    # --key-path/--config-path are deliberately NOT redefined here -- they
    # live on the top-level parser only (above), so a value given with
    # `--key-path X intake-candidates` is never silently overwritten by a
    # second Action for the same dest re-applying its own default when the
    # subcommand itself doesn't repeat the flag.
    intake_parser.add_argument(
        "--json", action="store_true", help="accepted for CLI-convention consistency; output is always JSON"
    )

    args = parser.parse_args(argv)

    if args.command == "intake-candidates":
        try:
            result = run_intake_candidates(key_path=args.key_path, config_path=args.config_path)
        except QdrantInventoryError as exc:
            print(json.dumps({"ok": False, "error": str(exc)}))
            return 1
        print(json.dumps({"ok": True, **result}))
        return 0

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
