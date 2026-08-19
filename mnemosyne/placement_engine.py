"""Heuristic-based Qdrant collection-to-org-tree placement rules.

Classifies each Qdrant collection (as discovered by
``mnemosyne.inventory.qdrant_inventory``) into a project-scoped or
enterprise-scoped org-tree node using naming heuristics. Collections whose
scope cannot be determined confidently default to enterprise-scoped and are
flagged with ``needs_override=True`` so an operator can review and correct
the placement -- see docs/placement-rules.md for the override process.
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping

import yaml

DEFAULT_INVENTORY_PATH = Path(
    ".pHive/epics/ingest-a10ab2c1/inventory/qdrant-collections.yaml"
)
DEFAULT_PLACEMENT_PATH = Path(
    ".pHive/epics/ingest-a10ab2c1/inventory/qdrant-placement.yaml"
)

PROJECT_MARKER = "project-"
ENTERPRISE_MARKER = "enterprise-"

SCOPE_PROJECT = "project"
SCOPE_ENTERPRISE = "enterprise"


class PlacementError(RuntimeError):
    """Raised when a collection cannot be placed with trustworthy input."""


@dataclass(frozen=True)
class PlacementResult:
    name: str
    scope: str
    org_tree_path: str
    needs_override: bool
    reason: str


def _org_tree_path(scope: str, name: str, marker: str | None) -> str:
    """Build an org-tree path, using the text after the marker as the node
    identifier when a marker was matched, and the full collection name
    otherwise."""
    identifier = name
    if marker:
        _, _, remainder = name.lower().partition(marker)
        offset = len(name) - len(remainder)
        identifier = name[offset:]
    identifier = identifier.strip("-_") or name
    return f"org/{scope}/{identifier}"


def classify_collection(name: str | None) -> PlacementResult:
    """Classify a single collection name using prefix heuristics.

    Raises PlacementError for missing or empty names -- placement cannot
    proceed without a name to key off of.
    """
    if name is None:
        raise PlacementError("collection name is missing; cannot place")
    stripped = name.strip()
    if not stripped:
        raise PlacementError("collection name is empty; cannot place")

    lowered = stripped.lower()
    has_project = PROJECT_MARKER in lowered
    has_enterprise = ENTERPRISE_MARKER in lowered

    if has_project and has_enterprise:
        return PlacementResult(
            name=stripped,
            scope=SCOPE_ENTERPRISE,
            org_tree_path=_org_tree_path(SCOPE_ENTERPRISE, stripped, None),
            needs_override=True,
            reason=(
                f"ambiguous: name contains both '{PROJECT_MARKER}' and "
                f"'{ENTERPRISE_MARKER}'; defaulted to enterprise pending "
                "operator review"
            ),
        )
    if has_project:
        return PlacementResult(
            name=stripped,
            scope=SCOPE_PROJECT,
            org_tree_path=_org_tree_path(SCOPE_PROJECT, stripped, PROJECT_MARKER),
            needs_override=False,
            reason=f"name contains '{PROJECT_MARKER}'",
        )
    if has_enterprise:
        return PlacementResult(
            name=stripped,
            scope=SCOPE_ENTERPRISE,
            org_tree_path=_org_tree_path(
                SCOPE_ENTERPRISE, stripped, ENTERPRISE_MARKER
            ),
            needs_override=False,
            reason=f"name contains '{ENTERPRISE_MARKER}'",
        )
    return PlacementResult(
        name=stripped,
        scope=SCOPE_ENTERPRISE,
        org_tree_path=_org_tree_path(SCOPE_ENTERPRISE, stripped, None),
        needs_override=True,
        reason="no scope hint in name; defaulted to enterprise pending operator review",
    )


def classify_collection_metadata(collection: Mapping[str, Any]) -> PlacementResult:
    """Classify a collection given an inventory-style metadata mapping
    (e.g. one entry from qdrant-collections.yaml)."""
    if not isinstance(collection, Mapping) or "name" not in collection:
        raise PlacementError(
            "collection metadata is missing a 'name' field; cannot place"
        )
    return classify_collection(collection.get("name"))


def place_collections(
    collections: Iterable[Mapping[str, Any]]
) -> list[PlacementResult]:
    return [classify_collection_metadata(collection) for collection in collections]


def load_inventory(path: str | Path = DEFAULT_INVENTORY_PATH) -> list[dict[str, Any]]:
    inventory_path = Path(path)
    try:
        raw = inventory_path.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise PlacementError(f"inventory manifest missing: {inventory_path}") from exc
    data = yaml.safe_load(raw) or {}
    collections = data.get("collections")
    if collections is None:
        raise PlacementError(
            f"inventory manifest has no 'collections' key: {inventory_path}"
        )
    return collections


def write_placement_manifest(
    results: Iterable[PlacementResult],
    path: str | Path = DEFAULT_PLACEMENT_PATH,
) -> dict[str, Any]:
    entries = [asdict(result) for result in results]
    override_count = sum(1 for entry in entries if entry["needs_override"])
    manifest = {
        "placement_count": len(entries),
        "override_needed_count": override_count,
        "placements": entries,
    }

    manifest_path = Path(path)
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(
        yaml.safe_dump(manifest, sort_keys=False), encoding="utf-8"
    )
    return manifest


def run_placement(
    *,
    inventory_path: str | Path = DEFAULT_INVENTORY_PATH,
    placement_path: str | Path = DEFAULT_PLACEMENT_PATH,
) -> dict[str, Any]:
    collections = load_inventory(inventory_path)
    results = place_collections(collections)
    return write_placement_manifest(results, placement_path)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory-path", default=str(DEFAULT_INVENTORY_PATH))
    parser.add_argument("--placement-path", default=str(DEFAULT_PLACEMENT_PATH))
    args = parser.parse_args(argv)

    try:
        manifest = run_placement(
            inventory_path=args.inventory_path,
            placement_path=args.placement_path,
        )
    except PlacementError as exc:
        print(f"qdrant placement failed: {exc}", file=sys.stderr)
        return 1

    print(
        "wrote "
        f"{args.placement_path} with {manifest['placement_count']} placements "
        f"({manifest['override_needed_count']} need operator override)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
