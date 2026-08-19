# Design Discussion — mnemosyne-repo-onboarding

## 0. Prelude

No prior KG decisions surfaced (no `/hive:why` infra wired in this
consumer repo — treated as zero results, silence per convention). No
`north_star` block in `.pHive/project-profile.yaml` with non-`unknown`
core fields found — omitted.

**Revised after grill pass** (`docs/grill-record.md`, round 1, 6/6 findings
resolved). Every change below is annotated `[grill N.M]` at its point of
origin so a reader can trace which finding drove which revision.

## 1. Goal

Give Mnemosyne one coherent "onboard a repo" capability with two real
deployment modes, both built on top of already-shipped mechanisms (never
duplicating them):

- **Mode A — tree-integrated onboarding.** A new repo/location the
  operator wants tracked joins their own multi-repo Qdrant Cloud memory
  tree: gets a real collection/scope, gets classified and placed on the
  org-tree (project- vs enterprise-scoped, per `placement_engine.py`'s
  existing heuristics), gets its Layer 1 role overlay and a seed
  code-architect persona installed, and gets a first-time index across
  whichever memory levels apply.
- **Mode B — standalone/embedded onboarding.** Mnemosyne ships inside
  another product's own repo as a self-contained dependency (the already-
  shipped `mnemosyne-agent-harness-install` install path). At `agent
  init` time it stands itself up, builds a first-time index of that
  product's own codebase, and is immediately usable by that product's own
  agent for `recall()`/`remember()` — with zero dependency on the
  operator's Qdrant Cloud tree. Growth after that point happens through
  that product's own agent actually calling `remember()` over time (this
  epic installs the mechanism and the Layer-1 mandate that drives that
  usage; it does not re-plan `m-06-continuous-indexing`'s background
  scheduling).

Both modes are one underlying sequence — **classify → register (Mode A
only) → sync Layer 1 → seed persona → first-time index → report base
level** — with Mode A adding a real Qdrant-tree registration/placement
step Mode B skips entirely (Mode B's "own scope" is directory isolation
plus the file-layer floor, never a Qdrant collection).

## 2. Proposed approach

### 2.1 Shared core (`lib/mnemosyne/onboarding/`, new)

A new TypeScript module, `onboardRepo()`, that both modes call with a
different `mode: 'tree' | 'standalone'` option and the same shared steps:

1. **Resolve target.** `repoRoot` (absolute path), `scopeId` (Layer-1
   persona/tier scope id — reuses the existing convention from
   `layer1/persona-store-repo-local.ts`).
2. **Layer 1 sync.** Call the existing `syncAllHarnesses(repoRoot,
   'code-architect', scopeId)` (`layer1/sync.ts`) — idempotent, already
   handles Level 0 (hard-fail if missing) + Level 1 (`mnemosyne.md`, only
   if present) + tier content composition. **Zero new code for this
   step** — this epic only adds the call site that currently doesn't
   exist anywhere in an automated onboarding flow.
3. **Persona seed.** Write a starter code-architect persona via
   `writeRepoLocalPersona(repoRoot, ...)` (`layer1/persona-store-repo-
   local.ts`) if one doesn't already exist at `repoLocalPersonaPath`.
4. **First-time index.** Always run the Level 4 file-store build
   (`writeFileStoreIndex`, already shipped, `bin/mnemosyne-file-index.mjs`'s
   own call path — reused directly, not reimplemented). Additionally run
   a graph build when the `graphify` binary is on PATH (mirrors
   `config.ts`'s own soft-availability check — `isCommandOnPath`). Mode A
   additionally triggers a vector index via the existing `POST /reindex`
   contract (`src/server.mjs`) once the collection/scope exists (step 5).
5. **Mode A only — register + place.** Shell out to the existing Python
   `mnemosyne.placement_engine.classify_collection(name)` for the
   org-tree path (never re-implement the heuristic in TypeScript — single
   source of truth stays Python, called via subprocess exactly the way
   `VectorLayerAdapter` already shells out to `swarm-memory`). A **new**
   Python function, `create_collection_and_scope(name, scope)`
   (`mnemosyne/onboarding.py`, new file, sibling to `placement_engine.py`
   and `inventory/qdrant_inventory.py`), creates the Qdrant collection and
   writes the `scope → collection` mapping `VectorLayerAdapter.remember()`
   already reads (`cfg.scopes[scope]`, `VectorLayerAdapter.ts:213-226`)
   into swarm-memory's own config, so `remember()` against the new repo
   stops failing with `unknown_scope` on the very next call. **`[grill
   2.1]`** Whether `swarm-memory` itself exposes a collection-create CLI
   verb was never confirmed — `swarm-memory` lives in a sibling repo
   (`~/Documents/work/dostal/code/swarm-memory`) outside this research
   pass's scope. This is now an explicit research spike inside story
   `ro-06`, not an assumed implementation detail: prefer a
   `swarm-memory`-native create path if the real CLI has one; fall back to
   a direct, additive-only Qdrant HTTP call (mirroring
   `qdrant_inventory.py`'s existing `HttpQdrantClient` shape, extended
   with a `PUT /collections/{name}` capability) only if confirmed no
   native path exists — and treat that fallback as strictly higher-risk,
   requiring its own explicit no-wipe safety proof before merge.
6. **Report base level.** **`[grill 3.1]`** `GET /memory-levels`'s current
   implementation (`ml-04`, `lib/mnemosyne/server.ts:415-460`) computes
   against ONE ambient, module-level `MnemosyneClient` singleton scoped to
   the running service's own `ROOT_DIRECTORY` — it cannot answer "what's
   configured for repo X" for an arbitrary `repoRoot` onboarding is being
   run against. This step is real, new-code work, not a pure reuse:
   extract the route's per-level `configured` computation
   (existsSync for levels 0/1, `client.getConfiguredLayers()` presence for
   levels 2-4) into a standalone function parameterized on `(client,
   repoRoot)`, then have `onboardRepo()` construct its own scoped
   `MnemosyneClient({ rootDirectory: repoRoot })` (the same constructor
   option every other consumer already uses — no new client capability
   needed) and call the extracted function against it. `GET
   /memory-levels` itself is refactored to call the same extracted
   function against its existing singleton — same output, zero behavior
   change for that route, single source of truth for both callers.

### 2.2 Mode A entry point

New CLI verb, `mnemosyne onboard <path> [--scope-id <id>] [--collection
<name>] [--override project|enterprise]`, wired into `bin/mnemosyne`'s
existing dispatch pattern (same shape as `reindex`/`persona`/`agent`).
`--override` maps directly to `placement_engine.py`'s existing
`needs_override` escape hatch — an ambiguous/unmarked collection name still
gets an org-tree path, flagged for operator review, exactly as it does
today for already-existing collections. **`[grill 1.1]`** Naming: kept
`onboard` (the operator's own verb, verbatim: "onboard it into the memory
system") rather than aligning to the codebase's existing "ingest"
vocabulary — see §2.4's explicit relationship to `ingest-a10ab2c1` instead
of silently picking one convention over the other.

### 2.3 Mode B entry point

Extend `bin/mnemosyne-agent.mjs`'s existing `agent init` (not a new
top-level verb — Mode B's contract is "one command stands the whole thing
up," matching the harness-install epic's own design intent) to run the
shared `onboardRepo({ mode: 'standalone', repoRoot: process.cwd(), ... })`
step after MCP registration + skill copy, gated behind a new **`--build`
opt-IN flag (default OFF)**. **`[grill 3.2]`** Originally scoped as an
opt-out (build on by default); reversed after the grill pass identified
this as the same class of surprise-heavy-action-on-first-run
`docs/install.sh` was explicitly written to avoid (its own header comment:
mutating/heavy steps stay separate, explicit, operator-confirmed — the
reason `install.sh` prints but never runs `agent init` itself). `agent
init`'s own output now prints "next step (not run automatically):
`mnemosyne agent init --build`" the same way `install.sh` already prints
`agent init` itself as a separate next step — one consistent convention up
and down the stack, not two different defaults for two similarly-heavy
actions. Also ship a recommended `mnemosyne.layers.json` template
(`docs/embedded-layers.json`, referenced from the `--build` output) that
omits `vector` entirely for a bare embedded install with no `swarm-memory`
credential configured — an explicit, documented choice rather than relying
on the existing silent-degrade-past-a-failing-layer behavior, which still
works but is not today surfaced to an operator deciding how to configure a
fresh embedded install.

### 2.4 Where Mode A and Mode B diverge (explicit)

| Step | Mode A | Mode B |
|---|---|---|
| Layer 1 sync | same shared call | same shared call |
| Persona seed | same shared call | same shared call |
| L4 file index | same shared call | same shared call |
| L2 graph index | same shared call (if `graphify` on PATH) | same shared call (if `graphify` on PATH) |
| L3 vector index | **new**: create collection + scope mapping, then reindex | **skipped by default** (no operator Qdrant tree to join); optional if the embedding product configures its own `swarm-memory` credentials |
| Org-tree placement | **new**: `placement_engine.py` classification, `needs_override` flag | **N/A** — no org-tree; isolation is `rootDirectory`, not a tree node |
| "Own scope" isolation | scope→collection mapping keyed to this repo's own collection | `rootDirectory` passed to `FileLayerAdapter`'s constructor; never shares another repo's `mnemosyne-notes/` |
| Continuous growth | `m-06` (existing backlog, unchanged) + this epic's Layer-1 mandate install | this epic's Layer-1 mandate install + the product's own agent calling `remember()` in production (validated in anger by `m-07`, unchanged) |

## 3. Risks

- **Collection creation touches live Qdrant Cloud infra** — the repo's own
  hard rule (`ways_of_working.md`: never wipe Qdrant) makes this the
  single highest-blast-radius piece of this epic. Mitigation: the new
  `create_collection_and_scope` function is additive-only (create, never
  delete/drop), and every story touching it requires an explicit,
  independently-run verification step (mirroring `aha-01`'s own real-
  machine safety check pattern) confirming zero existing collections are
  touched.
- **Two independently-maintained default-resolution paths** — `config.ts`
  (TS client) and `src/engine.mjs`/`bin/graphify-bridge.mjs` (JS zero-dep
  server) each have their own graphify-availability soft-fallback, per
  `cr-01`'s own doc comment ("independently implemented since the two
  sides don't share code"). The onboarding flow's first-time L2 index step
  must call whichever path the running mode actually uses — a naive single
  implementation risks silently indexing through the wrong side.
- **`ingest-a10ab2c1` overlap** — if this epic's Mode A onboarding ships
  first, `ingest-a10ab2c1`'s still-unbuilt `repo-inventory` →
  `repo-index` chain becomes stale-by-design (it would reimplement a
  subset of this epic's `onboardRepo()`). Surfaced explicitly (§ Open
  Questions) rather than silently resolved — the operator owns the call on
  whether to re-scope `ingest-a10ab2c1`'s remaining stories to consume
  `onboardRepo()` in a loop.
- **Python/TypeScript split adds a process boundary** inside a single
  onboarding action (Mode A's collection-create step shells out to Python;
  everything else is TS). Mitigation: mirrors the exact pattern already
  proven safe by `VectorLayerAdapter` shelling out to the `swarm-memory`
  CLI — same shell-out-to-CLI discipline, not a new architectural pattern.
- **`agent init`'s new build step could turn a fast, cheap MCP-registration
  action into a slow, first-time-index action** for a large embedded host
  repo. Mitigation `[grill 3.2]`: `--build` is opt-IN (default OFF),
  consistent with `install.sh`'s own established "heavy/mutating steps stay
  separate and explicit" convention; the file-index/graph-index steps
  themselves are the same already-proven-fast primitives (`ml-06`/`ml-08`'s
  shipped benchmarks), not new indexing code with unknown performance.
- **Cross-cutting concerns** `[grill 4.1]`: this repo's
  `.pHive/cross-cutting-concerns.yaml` (documentation, versioning,
  loud-failure, provenance-completeness) applies across this epic's
  stories — evaluated per-story, not globally waved through, given
  Qdrant-collection creation is the single highest-blast-radius action in
  this epic and `ways_of_working.md`'s "never wipe Qdrant" rule is this
  project's most safety-critical convention. See each story YAML's
  `cross_cutting:` block; the collection-creation story additionally
  carries an explicit, named no-wipe safety proof requirement not covered
  by the generic concern list.
- **Forward-compatibility with `m-06-continuous-indexing`** `[grill 5.1]`:
  this epic's Mode B first-time L4 index writes the same
  `<root>/.mnemosyne/file-index.json` manifest `m-06`'s (still unbuilt)
  continuous-indexing design will eventually also write to on a schedule.
  Not a conflict today (nothing else writes that manifest yet), but flagged
  explicitly — via a `references:` pointer from story `ro-04` to
  `m-06-continuous-indexing.yaml` — as a manifest-write-coordination
  question for whoever implements `m-06`, rather than silently assumed
  safe.

## 4. Dependencies

- `lib/mnemosyne/layer1/sync.ts`, `persona-store-repo-local.ts` (both
  shipped, epic `mnemosyne-layer-architecture-v2` / `mnemosyne-persona-
  foundation`) — reused as-is.
- `lib/mnemosyne/layers/FileStoreIndex.ts` (`ml-06`/`ml-08`, shipped) —
  reused as-is via `bin/mnemosyne-file-index.mjs`'s own call path.
- `lib/mnemosyne/server.ts`'s `GET /memory-levels` computation (`ml-04`,
  shipped) — factored into a shared function, not reimplemented.
- `mnemosyne/placement_engine.py` (shipped, `ingest-a10ab2c1`) — reused
  as-is for classification; extended with a new sibling module for
  creation (never modifying the existing read/classify-only contract).
- `config.ts`'s graphify soft-availability check (`isCommandOnPath`,
  shipped) — reused for the L2 build gate.
- Blocked on nothing outside this repo. Requires real Qdrant Cloud
  credentials (`~/.config/swarm-memory/qdrant.key`) to exercise Mode A's
  collection-creation path end-to-end in testing — mitigated the same way
  `qdrant_inventory.py`'s own tests already do (mockable HTTP client, per
  `mnemosyne/tests/test_qdrant_inventory.py`).

## 5. Open questions

**Genuinely open — need the operator's explicit answer before execution:**

1. Should `ingest-a10ab2c1`'s remaining `repo-*` stories (0/5 built:
   `repo-inventory`, `repo-categorization`, `repo-index`,
   `repo-continuous-index`, `repo-verification`) be re-scoped to call this
   epic's `onboardRepo()` in a loop, or left as an independent, parallel
   implementation? This epic does not unilaterally edit another open
   epic's story list — recommendation is re-scope, but the operator owns
   that call.
2. What is the real, final collection-naming convention for a brand-new
   Mode A repo — does the operator want to type the collection name
   explicitly every time (`--collection <name>`), or should onboarding
   derive one from the repo's path/git remote? `placement_engine.py`'s
   heuristic only classifies a name that already exists; it has no naming
   convention of its own to generate one. This epic's stories default to
   `--collection` required (explicit, no guessing) pending an answer.
3. Does `swarm-memory` (sibling repo, not read by this research pass)
   actually expose a collection-create CLI verb, or does story `ro-06`
   need to fall back to a direct Qdrant HTTP call? Resolved as a research
   spike inside `ro-06` itself (§2.1 step 5), not blocking planning, but
   the fallback path is materially higher-risk and the operator should be
   aware it may be needed.

**Resolved during this planning pass (no longer open):**

- Mode B's `agent init` build-step default — resolved opt-IN (`--build`,
  default OFF) per grill finding 3.2.

## 6. Scale assessment

**Large.** Confirmed by real code, not assumed: cross-stack (new
TypeScript onboarding module + a new Python collection-creation module +
CLI wiring across `bin/mnemosyne` and `bin/mnemosyne-agent.mjs`), touches
five already-shipped subsystems (Layer 1 sync, persona store, file-store
index, memory-levels route, placement engine) plus one genuinely new
external-infra-touching capability (live Qdrant collection creation), and
has real, confirmed overlap with two other epics' open backlog
(`mnemosyne-foundation`'s `m-06`/`m-07`/`m-08`, `ingest-a10ab2c1`'s
`repo-*` chain) that must be reconciled rather than ignored. Full H/V +
structured outline with risk registry and elicitation required.
