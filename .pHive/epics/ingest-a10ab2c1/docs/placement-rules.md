# Qdrant Org-Tree Placement Rules

Story: `qdrant-placement-rules` (epic `ingest-a10ab2c1`)
Implementation: `mnemosyne/placement_engine.py`
Tests: `mnemosyne/tests/test_placement.py`

## Purpose

The inventory step (`qdrant-inventory`) discovers every Qdrant collection and
writes `.pHive/epics/ingest-a10ab2c1/inventory/qdrant-collections.yaml`. This
step decides *where in the org tree* each of those collections belongs --
under a specific project, or under the shared enterprise node -- so later
ingestion work knows which scope to write into.

Placement is heuristic, not authoritative. It is meant to get the obvious
cases right automatically and flag everything else for a human to confirm.

## Heuristics

Given a collection name, `classify_collection()` applies these rules in
order:

1. **Ambiguous -> enterprise + override.** If the name contains *both*
   `project-` and `enterprise-`, the signal is contradictory. Placement
   defaults to enterprise-scoped and sets `needs_override=True`.
2. **Project-scoped.** If the name contains `project-` (and not
   `enterprise-`), the collection maps to a project-scoped org-tree node:
   `org/project/<identifier>`, where `<identifier>` is the text following the
   `project-` marker (falling back to the full name if that would be empty).
   `needs_override` is `False`.
3. **Enterprise-scoped.** If the name contains `enterprise-` (and not
   `project-`), the collection maps to `org/enterprise/<identifier>` the same
   way. `needs_override` is `False`.
4. **No scope hint -> default to enterprise + override.** If the name
   contains neither marker, placement defaults to
   `org/enterprise/<name>` and sets `needs_override=True`. This is the
   fallback for names that don't follow the `project-`/`enterprise-`
   convention at all (which, as of this writing, is every collection
   currently in Qdrant Cloud -- see "Current inventory" below).

The match is a substring check (`"project-" in name`), not a strict prefix,
so a collection like `clients_project-atlas_memory` is still recognized as
project-scoped. This mirrors the story's acceptance criteria, which specify
"collection name **contains** 'project-'" / "'enterprise-'".

Matching is case-insensitive; the collection's original casing is preserved
in the output.

### Edge cases

- **Missing metadata**: a collection record with no `name` field (or
  `name: null`) raises `PlacementError` -- there's nothing to key placement
  off of, so this fails loudly rather than guessing.
- **Empty / whitespace-only name**: also raises `PlacementError`, for the
  same reason.
- **Ambiguous name** (both markers present): handled by rule 1 above --
  does not raise, defaults with an override flag instead, since this is a
  data-quality signal an operator should resolve rather than a hard failure.

## Output shape

`classify_collection()` / `classify_collection_metadata()` return a
`PlacementResult`:

```python
PlacementResult(
    name="project-atlas",
    scope="project",              # "project" | "enterprise"
    org_tree_path="org/project/atlas",
    needs_override=False,
    reason="name contains 'project-'",
)
```

`place_collections()` runs this over a full inventory list (i.e. the
`collections` array from `qdrant-collections.yaml`).
`write_placement_manifest()` writes the results to
`.pHive/epics/ingest-a10ab2c1/inventory/qdrant-placement.yaml` (by default)
with a `placement_count` and `override_needed_count` summary:

```yaml
placement_count: 15
override_needed_count: 15
placements:
  - name: arizona_compound
    scope: enterprise
    org_tree_path: org/enterprise/arizona_compound
    needs_override: true
    reason: no scope hint in name; defaulted to enterprise pending operator review
  # ...
```

`run_placement()` chains `load_inventory()` -> `place_collections()` ->
`write_placement_manifest()`, reading from and writing to the default paths
above. It can also be run as a script:

```
python -m mnemosyne.placement_engine \
  --inventory-path .pHive/epics/ingest-a10ab2c1/inventory/qdrant-collections.yaml \
  --placement-path .pHive/epics/ingest-a10ab2c1/inventory/qdrant-placement.yaml
```

## Current inventory

Running placement against the real inventory
(`qdrant-collections.yaml`, 15 collections) as of this story produces
`needs_override: true` for all 15 -- none of the existing collections use a
`project-`/`enterprise-` naming convention (`arizona_compound`,
`claude_knowledge`, `clients_memory`, `ffe_knowledge`, `work_root_memory`,
etc.). This is expected: the heuristic is intentionally conservative, and
real-world collection names predate this convention. Every one of these is
flagged for operator review rather than silently misplaced.

## Override process

Because the heuristic defaults ambiguous/unclear collections to
enterprise-scoped rather than guessing a project, every such collection is
marked `needs_override: true` with a human-readable `reason`. The intended
operator workflow (dry-run, per the story's risk mitigation) is:

1. Run placement to produce `qdrant-placement.yaml`.
2. Review entries where `needs_override: true` -- these are proposals, not
   committed placements.
3. For each one that actually belongs to a project, manually correct its
   `scope` and `org_tree_path` in the placement manifest (or in whatever
   downstream org-tree config consumes it) before it is committed /ingested.
4. Entries with `needs_override: false` (an explicit `project-`/
   `enterprise-` match) can be trusted without review, but remain visible in
   the manifest for auditability.

No collection is ever placed silently without appearing in the manifest, and
no automatic write to the org tree happens as part of placement itself --
placement only produces the proposal that a human (or a later, separate
ingestion step) acts on.
