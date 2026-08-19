# Structured Outline — mnemosyne-repo-onboarding

> **Amendment addendum (2026-08-19):** three new stories (`ro-10` document
> ingestion, `ro-11` website crawl, `ro-12` two explicit install paths) and
> two small in-place amendments (`ro-02`, `ro-03` — configurable storage
> location) were added after this outline was written. See
> `docs/design-discussion.md` §7 and `docs/grill-record.md` round 2 for the
> full design/grill trail, and `vertical-plan.md`'s own addendum for where
> the new stories sit in slice order. The parts below (summary, file
> manifest, risk registry, elicitation) describe the ORIGINAL six-story
> scope only and are left as originally written, not retrofitted — treat
> §7 of the design discussion as the amendment's own structured detail
> rather than interleaving it here.

## Part 1 — Summary

One onboarding capability, two deployment modes, built entirely by
composing already-shipped Mnemosyne mechanisms plus three genuinely new
pieces: (1) a repo-scoped extraction of the existing `GET /memory-levels`
computation, (2) a shared TypeScript orchestrator sequencing Layer-1 sync +
persona seed + first-time indexing + base-level reporting, and (3) a new,
additive-only Python primitive that creates a Qdrant collection + scope
mapping for a repo that has never touched the tree before. Four vertical
slices, sequenced from lowest to highest blast radius (see
`vertical-plan.md`).

## Part 2 — Detailed approach

### 2.1 Shared orchestrator contract

```ts
// lib/mnemosyne/onboarding/onboardRepo.ts (new)
export interface OnboardRepoOptions {
  mode: 'tree' | 'standalone';
  repoRoot: string;
  scopeId: string;
  /** Mode 'tree' only — the swarm-memory collection this repo writes to. */
  collection?: string;
  /** Skip L2 graph build even if `graphify` is on PATH (mainly for tests). */
  skipGraph?: boolean;
}

export interface OnboardRepoResult {
  layer1Synced: SyncResult[];
  personaSeeded: { created: boolean; path: string };
  fileIndex: { files: number; areas: number };
  graphIndex: { ran: boolean; reason?: string };
  vectorIndex: { ran: boolean; reason?: string }; // mode:'tree' only, real when ro-07 lands
  baseLevel: ReturnType<typeof computeMemoryLevels>; // ro-01's extracted function
}

export async function onboardRepo(options: OnboardRepoOptions): Promise<OnboardRepoResult>;
```

`onboardRepo()` never throws on a single sub-step's soft failure (e.g. no
`graphify` on PATH) — each sub-step's own result records `ran: false,
reason: ...`, mirroring `MnemosyneClient`'s own established
"record-degradation, never silently drop" convention
(`client.ts`'s `recordDegradation`/`layers_skipped`). It DOES throw loudly
on a hard failure that would leave the repo in a half-onboarded state
without the operator knowing (e.g. Level 0 missing — `readLevel0Content`
already throws for this; `onboardRepo()` lets that propagate uncaught,
never swallows it).

### 2.2 `computeMemoryLevels` extraction (ro-01)

Before:

```ts
// server.ts, GET /memory-levels handler — inline computation
const activeAdapterNames = new Set<string>(client.getConfiguredLayers().map((l) => l.layer));
const level0Configured = existsSync(DEFAULT_LEVEL0_PATH);
const level1Configured = existsSync(path.join(ROOT_DIRECTORY, 'mnemosyne.md'));
const levels = MEMORY_LEVELS.map((level) => { /* ... */ });
```

After:

```ts
// lib/mnemosyne/memory-levels/computeMemoryLevels.ts (new)
export function computeMemoryLevels(
  client: MnemosyneClient,
  repoRoot: string,
  level0Path: string = DEFAULT_LEVEL0_PATH,
): MemoryLevelStatus[] { /* exact same body, parameterized */ }

// server.ts, GET /memory-levels handler
const levels = computeMemoryLevels(client, ROOT_DIRECTORY);

// lib/mnemosyne/onboarding/onboardRepo.ts
const scopedClient = new MnemosyneClient({ rootDirectory: options.repoRoot });
const baseLevel = computeMemoryLevels(scopedClient, options.repoRoot);
```

Regression contract: `test/http-api.mjs`'s existing `GET /memory-levels`
assertions must pass byte-identically before and after this extraction —
the whole point is zero behavior change for the existing route.

### 2.3 Mode A: org-tree registry (ro-04)

`~/.mnemosyne/org-tree.yaml` (new canonical path, mirroring the existing
`~/.mnemosyne/level0-rules.md` "operator-global, not per-repo" convention —
deliberately NOT under any single epic's `.pHive/` directory, unlike
`placement_engine.py`'s own default `DEFAULT_PLACEMENT_PATH`, which is
epic-scratch and not a permanent home):

```yaml
# ~/.mnemosyne/org-tree.yaml
entries:
  - repo_path: /Users/mdostal/Documents/work/pantheon/mnemosyne
    collection: project-mnemosyne
    scope: project
    org_tree_path: org/project/mnemosyne
    needs_override: false
    onboarded_at: "2026-08-19T00:00:00Z"
```

`lib/mnemosyne/onboarding/orgTree.ts` exports `appendOrgTreeEntry(entry)`
(read-modify-write, dedupes on `repo_path`, last-write-wins on re-onboard)
and `listOrgTreeEntries()`. Read fresh off disk every call — no
module-level caching, mirroring `level0.ts`'s and `persona-store-repo-
local.ts`'s own established "read fresh" contract for operator-global
state.

### 2.4 Mode A: classification subprocess call (ro-05)

```ts
// lib/mnemosyne/onboarding/classify.ts (new)
import { execFile } from 'node:child_process';
export async function classifyCollection(name: string): Promise<PlacementResult> {
  // shells out to: python3 -m mnemosyne.placement_engine --inventory-path ... (or a
  // new, narrower single-name entry point — see file manifest below for the
  // real research decision point: classify_collection() is already a pure,
  // no-IO function; a thin `python3 -c` one-liner invocation may be simpler
  // than adding a new CLI flag to placement_engine.py's own argparse surface).
}
```

Mirrors `VectorLayerAdapter`'s own established shell-out-to-CLI discipline
— never a `python-shell`/FFI dependency, plain `execFile`.

### 2.5 Mode A: collection creation (ro-06) — research-gated

This story's `research` step must answer, against the REAL `swarm-memory`
CLI (not assumed): does `swarm-memory` expose a collection-create verb? Two
paths, chosen based on that answer:

- **If yes:** `mnemosyne/onboarding.py`'s `create_collection_and_scope`
  shells out to it (mirrors `placement_engine.py`'s own subprocess-free,
  pure-Python style is NOT required here — this function does real I/O by
  design, unlike `classify_collection`).
- **If no:** extend `qdrant_inventory.py`'s `HttpQdrantClient` (currently
  read-only: `list_collections`, `collection_info`) with a `create_collection
  (name, vector_size, distance)` method calling `PUT /collections/{name}`
  directly — explicitly named as the higher-risk fallback in this story's
  own risk section, requiring an additional, explicit no-wipe safety proof
  (real collection list diffed before/after, asserting only ONE new
  collection appeared and zero existing ones changed) before merge.

Either path also writes the `scope → collection` mapping into whatever
config file `VectorLayerAdapter.ts:213-226`'s `cfg.scopes` reads from at
runtime — this must be read from swarm-memory's real config file/schema,
not assumed to be `~/.config/swarm-memory/config.toml`'s `[qdrant]` section
(that section is confirmed, per `qdrant_inventory.py`'s
`load_qdrant_url`; the `scopes` map's real location is NOT yet confirmed
anywhere in this research pass and is this story's own first research
task).

## Part 3 — File manifest

| File | Kind | Story |
|---|---|---|
| `lib/mnemosyne/memory-levels/computeMemoryLevels.ts` | new | ro-01 |
| `lib/mnemosyne/server.ts` | modify (extract call) | ro-01 |
| `lib/mnemosyne/onboarding/onboardRepo.ts` | new | ro-02 |
| `lib/mnemosyne/onboarding/onboardRepo.test.ts` | new | ro-02 |
| `bin/mnemosyne-agent.mjs` | modify (`--build` flag) | ro-03 |
| `docs/install.sh` | modify (printed next-step text) | ro-03 |
| `docs/embedded-layers.json` | new | ro-03 |
| `README.md` | modify (Quickstart) | ro-03, ro-09 |
| `lib/mnemosyne/onboarding/orgTree.ts` | new | ro-04 |
| `lib/mnemosyne/onboarding/orgTree.test.ts` | new | ro-04 |
| `lib/mnemosyne/onboarding/classify.ts` | new | ro-05 |
| `bin/mnemosyne` | modify (`onboard` dispatch branch) | ro-05 |
| `bin/mnemosyne-onboard.mjs` | new | ro-05 |
| `mnemosyne/onboarding.py` | new | ro-06 |
| `mnemosyne/tests/test_onboarding.py` | new | ro-06 |
| `mnemosyne/inventory/qdrant_inventory.py` | modify (only if swarm-memory-native path absent) | ro-06 |
| `bin/mnemosyne-onboard.mjs` | modify (`--create` flag) | ro-07 |
| `test/onboard-cli.mjs` | new | ro-05, ro-07 |
| `lib/mnemosyne/layer1/persona-store-repo-local.ts` | read-only reference | ro-08 |
| `test/http-api.mjs` | modify (regression assertions) | ro-01, ro-09 |
| `CHANGELOG.md` | modify | ro-09 |
| `package.json` | modify (version bump) | ro-09 |

## Part 4 — Risk registry

| # | Risk | Severity | Story | Mitigation |
|---|---|---|---|---|
| R1 | Collection creation touches live Qdrant Cloud, violating "never wipe" hard rule if implemented carelessly | **critical** | ro-06 | Additive-only function signature (no delete/drop path exists in the module at all); explicit before/after collection-list diff proof required in review; independent verification step mirroring `aha-01`'s real-machine safety check |
| R2 | `swarm-memory`'s real collection-create surface is unknown (never read) | high | ro-06 | Research spike is the story's first step, gates which of two implementation paths is taken |
| R3 | `GET /memory-levels` extraction regresses the existing route's behavior | medium | ro-01 | Byte-identical output required against `test/http-api.mjs`'s existing assertions; extraction is copy-then-parameterize, not a rewrite |
| R4 | Two independently-maintained graphify-availability checks (TS `config.ts` vs JS `bin/graphify-bridge.mjs`) drift, causing Mode A/Mode B's L2 index step to disagree with what `recall()` itself would actually use | medium | ro-02 | `onboardRepo()` reuses `config.ts`'s exact `isCommandOnPath` helper (not a re-implementation); JS-side parity explicitly out of scope and named as a known gap, not silently assumed fine |
| R5 | `agent init --build` surprises an operator with a slow first-run action | medium | ro-03 | Opt-in, default OFF (grill 3.2 resolution); printed-not-run guidance mirrors `install.sh`'s own established convention |
| R6 | `ingest-a10ab2c1`'s unbuilt `repo-*` stories silently duplicate this epic's Mode A capability once both are eventually built | medium | (cross-epic, not a story) | Explicitly surfaced in design discussion + open questions; operator decision required, not resolved unilaterally |
| R7 | `~/.mnemosyne/org-tree.yaml` concurrent-write race (two onboarding calls at once) | low | ro-04 | Reuses `layer1/lock.ts`'s existing `withLock` pattern (already proven for `syncHarnessFile`/`writeRepoLocalPersona`) around the registry's read-modify-write |
| R8 | Collection-naming convention left to the operator (`--collection` required, no auto-derivation) creates friction vs. the "EASY" framing of the operator's own ask | low | ro-05 | Named explicitly as open question #2; default behavior (explicit flag) is the safe, unambiguous starting point, refinable later without a breaking change |
| R9 | Mode B's L4 first-index writes the same manifest file `m-06-continuous-indexing` will eventually also write to on a schedule | low | ro-02 | `references:` pointer from ro-02 to `m-06-continuous-indexing.yaml`; no coordination code written now (nothing else writes the manifest yet) |

## Part 5 — Ambiguities not resolved (deliberately deferred, named)

1. Whether `mnemosyne onboard` without `--create` should auto-detect a
   missing collection and prompt (interactively) to create it, vs. this
   epic's simpler design (two explicit, separate flag states:
   `--collection <existing>` vs `--collection <name> --create`). Deferred
   to keep story `ro-05`/`ro-07`'s CLI surface unambiguous and scriptable
   (no interactive prompts needed in either path) — revisit once real
   operator usage surfaces friction.
2. Whether the org-tree registry (`ro-04`) should eventually be queryable
   via an HTTP route (mirroring `GET /memory-levels`/`GET /layers`) rather
   than YAML-file-only. Out of scope for this epic — no story currently
   asks for a UI/route surface over it; `mnemosyne-standalone-app`'s own
   UI epic is the natural home for that if/when requested.

## Part 6 — Cross-cutting concerns applied (summary; full detail per story YAML)

- `documentation` — applies to ro-03 (install.sh/README), ro-05/ro-07 (new
  CLI verb needs a discoverable doc), ro-09 (release notes).
- `versioning` — applies epic-wide; `version_bump: minor` (new, additive
  CLI verbs + a new optional flag, no breaking changes to any existing
  contract).
- `loud-failure` — applies to ro-02 (Level 0 missing must still hard-fail
  through `onboardRepo()`, never swallowed), ro-06 (any collection-create
  failure must be loud, never a silent partial state).
- `provenance-completeness` — applies to ro-02's vector-index sub-step
  (once ro-07 lands, a first-time vector index must produce hits with full
  7-field provenance, same as any other `recall()` path).
- **New, named safety concern (not in the generic list, added directly
  from `ways_of_working.md`)**: no-Qdrant-wipe — applies to ro-06 and
  ro-07 specifically, with its own explicit before/after collection-list
  diff proof requirement (see R1 above).

## Part 7 — Elicitation (the planning team's own stress-test)

**Q1 (researcher): Is the "reuse `computeMemoryLevels` for an arbitrary
repo" design (ro-01→ro-02) actually cheap, or does it hide real
complexity?**
A: Genuinely cheap for levels 0/1/4 (pure `existsSync`/walk, no state).
Level 2/3 cost real time proportional to `MnemosyneClient` construction +
`getConfiguredLayers()` — but that's a synchronous adapter-instantiation
call, not a network round-trip (confirmed reading `client.ts`'s
constructor — layer construction, not layer querying). Cheap.

**Q2 (tpm): Does slice ordering (Mode B before Mode A-existing before
Mode A-new) actually minimize risk, or does it just feel safer?**
A: Real minimization, not just a feeling — Slice 1 makes zero live Qdrant
Cloud writes at all (file/graph layers only); Slice 2 makes zero NEW
Qdrant writes (only reads an existing collection + writes to an
already-provisioned one via the already-shipped `POST /reindex`); Slice 3
is the only slice that creates new remote state. Each slice is a strict
superset of risk over the last, confirmed by re-reading each story's own
`files_to_modify`.

**Q3 (architect-equivalent stress test): Does the Python/TypeScript split
in Mode A (classify+create in Python, everything else in TypeScript)
create a maintenance seam that will rot?**
A: Real risk, mitigated by precedent — `VectorLayerAdapter` already proves
this exact shell-out-to-Python(-via-CLI) pattern works and stays
maintained in this codebase (it shells to `swarm-memory`, itself a Python-
adjacent-or-not implementation detail the TS side never needs to know).
The seam is the subprocess boundary (`execFile`), which is already a
first-class, tested pattern here (`VectorLayerAdapter.ts`, `bin/
mnemosyne-agent.mjs`'s own harness-CLI execs) — not a new kind of fragility
this epic introduces.

**Q4 (ui-designer-equivalent, UI detection scan): Does this epic contain
any UI story?**
A: No. Scanned every story's description/acceptance criteria against the
UI-keyword list (screen, view, page, modal, dialog, button, form, layout,
etc.) — zero matches. This epic is CLI/library/infra only; no `/design`
delegation required.

**Q5 (operator-facing, the team's own hardest question): Is "onboarding"
actually one coherent capability, or is this secretly two epics wearing
one epic's clothes because the operator described them back-to-back?**
A: One coherent capability, confirmed by the shared-core design itself —
`ro-01` and `ro-02` are used by BOTH modes with zero mode-specific
branching inside their own implementation (`onboardRepo()`'s `mode` field
only ever gates whether Mode-A-only steps run at all, never changes what
the shared steps do). If Mode A and Mode B needed materially different
Layer-1-sync/persona-seed/base-level-report logic, that would be the
tell-tale sign of two epics; they don't. The operator's own framing
("same thing, if we ship...") is corroborated by the code-level design,
not just taken on faith.
