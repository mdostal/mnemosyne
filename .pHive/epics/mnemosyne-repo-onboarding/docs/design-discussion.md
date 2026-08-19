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

## 7. Amendment (2026-08-19) — configurable storage, document ingestion,
web crawl, two explicit install paths

The operator added three more real requirements after the design above was
already grilled (round 1) and verified sound, before any story's build
started. Authorized, real scope, folded into THIS epic now rather than
deferred — per the operator's explicit instruction. Everything in §§1-6
above stands unchanged; this section is additive.

**Operator's own words, verbatim (session 2):**

> "the standalone should be able to run with it specifying the location of
> storage -- as we will often want to package mnemosyne AS the memory agent
> for a product so that product can get its own multi-level memory created
> and updated and can upload files, CV, description, crawl website, etc to
> improve memory and then use the context fully to verify and inject as it
> works along"

> "we ALSO want the big one going that allows the bigger full framework on a
> system when you install it on your system and are using your harness with
> it and specifying the collection etc -- so i should be able to do 2
> installs -- 1 packaged as a sidecar with an application behind the scenes
> -- another as part of pantheon OR on a system to run and work with my
> harness /agents"

One quote decomposes into four sub-asks (§7.1-7.4 below); the second is one
coherent ask (§7.5).

### 7.1 (A) Configurable storage location for Mode B — small addition to ro-02/ro-03, not a new story

Read the real code before designing this (not assumed): `FileLayerAdapter`'s
constructor already takes an explicit `targetDirectory` (`FileLayerAdapter.ts:47`),
and `registry.ts`'s `file` factory already wires it straight from
`MnemosyneClientOptions.rootDirectory` (`registry.ts:74`) — the file layer,
the file-index manifest (`<root>/.mnemosyne/file-index.json`), and the
repo-local persona store (`<root>/.mnemosyne/personas/`) are ALL already
fully colocated under whatever `repoRoot` the caller passes. **No gap
there.** `VectorLayerAdapter`'s `notesDirectory`, however, defaults to
`MNEMOSYNE_NOTES_DIR` env or `~/.local/share/mnemosyne/notes`
(`VectorLayerAdapter.ts:97-100`) — a **machine-global** default,
independent of `repoRoot` — unless a caller explicitly overrides it via
constructor options (already plumbed: `registry.ts:73` passes per-layer
`options` straight into `new VectorLayerAdapter(options)`, so
`notesDirectory` is technically already settable per-layer via
`mnemosyne.layers.json`, just never surfaced as a CLI flag or colocated by
default).

The one genuine, concrete gap: `bin/mnemosyne-agent.mjs`'s planned `agent
init --build` (`ro-03`) hardcodes `repoRoot: process.cwd()` — a product
that wants to "package mnemosyne AS the memory agent for a product" cannot
say "put ALL of my memory state under `/var/lib/my-product/mnemosyne`"
without first `cd`-ing there, which is real friction for install
tooling/entrypoints/systemd units that don't want to be coupled to a
specific invocation cwd.

**Resolution — small, additive changes to already-planned stories, not a
new story** (confirms the task's own framing; my own research agrees):

- `ro-03` gains a new, optional `--storage-dir <dir>` flag on `agent init
  --build`. When passed, `onboardRepo()`'s `repoRoot` becomes
  `options.storageDir` instead of `process.cwd()` (mkdir -p'd first if it
  doesn't exist yet — a real, new, tiny piece of code, not assumed).
  Omitted: byte-identical to `ro-03`'s already-planned behavior
  (`repoRoot: process.cwd()`), zero regression.
- `ro-02`'s orchestrator gains one small enhancement: when it constructs its
  scoped client and the resolved layer stack includes `vector` (only
  possible today if a Mode B product explicitly added `vector` back to its
  own `mnemosyne.layers.json`, since `docs/embedded-layers.json` omits it by
  default per `ro-03`'s existing design), it passes `notesDirectory:
  path.join(repoRoot, 'mnemosyne-notes')` as that layer's per-layer option —
  colocating vector's note-staging directory under the SAME
  product-controlled `repoRoot`/`storageDir`, instead of leaking to the
  machine-global default. Without this, a containerized sidecar deployment
  (where `~/.local/share/mnemosyne` may not even be a writable/persistent
  path relative to the product's own container) would silently write
  outside the directory the product asked for.
- Mode A (`mnemosyne onboard <path> ...`, `ro-05`/`ro-07`) already has an
  explicit storage-location parameter — its `<path>` positional argument —
  so this amendment does not touch Mode A's CLI surface at all.

### 7.2 (B) Document-ingestion primitive — new story `ro-10`

**Real reuse root, confirmed by reading the code, not assumed:**
`MnemosyneClient.remember()` (already shipped, v0.14.0) already cascades a
single write through every WRITABLE configured layer in stack order
(`client.ts:447-531`, cited in `research-brief.md` §2) — this is already
the multi-level write path the operator's "product can get its own
multi-level memory created and updated" describes; `ro-10` does not
reimplement it, only feeds it.

**What already exists that this reuses, not reinvents:**
`skills/mnemosyne-persona-interview/crawl-context.mjs` (`pu-07-bounded-
crawl-context`) already establishes this codebase's one existing precedent
for "read external content safely, without overdoing it": a FIXED,
named source list, three explicit caps (`MAX_LINES_PER_SOURCE`,
`MAX_CHARS_PER_SOURCE`, `MAX_SOURCE_SUMMARY_CHARS`) applied in order, and a
truncation marker rather than a silent cut. `ro-10` mirrors this PATTERN
(named caps, truncate-not-silently-drop) for a structurally different input
(arbitrary uploaded content, not a fixed local-file list) — it does not
import or extend `crawl-context.mjs` itself, which is persona-interview-
specific and repo-local-file-only.

**Bounded, concrete scope (real, not hand-waved):**

- File types, this story's cut: **plain text (`.txt`) and Markdown (`.md`)
  only.** Confirmed by reading `package.json`: no PDF-parsing dependency
  exists anywhere in this codebase today. PDF support is named an explicit,
  separate, NOT-in-this-story follow-on (a new binary-parsing dependency is
  its own risk surface, deliberately not bundled into the same story as the
  safe, zero-new-dependency text/markdown path) — surfaced in Open
  Questions below, not silently promised.
- A free-text description or CV/resume-style document supplied as a plain
  string (no file at all) is the trivial subcase of the same path — no
  parsing needed.
- Size bound: a hard byte ceiling on any single ingested document
  (`MAX_INGEST_BYTES`), oversized input rejected loudly (never silently
  truncated to a misleadingly-partial memory) — a policy choice distinct
  from `crawl-context.mjs`'s "truncate and mark it," because losing part of
  an operator-uploaded CV/description silently would misrepresent what the
  product now "knows," where `crawl-context.mjs`'s persona-interview
  context is explicitly advisory/best-effort by design.
- Chunking/attribution: content is split into bounded chunks (mirroring the
  same named-cap discipline); each chunk becomes its own `remember()` call,
  tagged via the ALREADY-EXISTING `RememberOptions.tag` and `Content.metadata`
  fields (`interfaces.ts:368-372`, no interface change needed) with the
  source document's filename/description-id and chunk index — so a later
  `recall()` hit's provenance traces back to "chunk 3 of resume.md,
  ingested at T," not an anonymous blob.
- Synchronous, sequential, never parallel: `VectorLayerAdapter.remember()`'s
  own doc comment already notes a single index call can take several
  seconds against live Qdrant Cloud; chunks are indexed one at a time,
  returning a per-chunk result array (mirrors `ro-06`'s own "report which
  half succeeded" loud-failure convention) rather than an all-or-nothing
  result. A background queue/worker system is an explicit non-goal — this
  codebase has no such infrastructure today, and inventing one is
  materially bigger than "a document-ingestion primitive."
- Surface: reuses the SAME three surfaces `recall()`/`remember()` already
  have — a new MCP tool (`bin/mnemosyne-mcp.mjs` already has the exact
  `registerTool(name, {title, description, inputSchema}, wrapAction(...))`
  pattern this reuses verbatim, e.g. lines 106-136 for `recall`/`remember`),
  a new CLI verb (mirrors `bin/mnemosyne-reindex.mjs`'s thin-HTTP-client
  shape), and a new HTTP route (`server.ts` already documents its route
  list in a header comment including `POST /remember`, ~line 93 — this
  story adds one more line to that same list, the established convention).

### 7.3 (C) Website crawling — new story `ro-11`, deliberately isolated

The highest-new-risk piece of this amendment, per the operator's own
instruction — treated with `ro-06`'s exact rigor (research-gated, explicit
non-goals, a NEW named cross-cutting safety concern not in the generic
`.pHive/cross-cutting-concerns.yaml` list, exactly as `ro-06` added
no-Qdrant-wipe).

**Real research first:** this codebase already uses the Node 20+ global
`fetch()` repeatedly (`server.ts:248`, `bin/mnemosyne-reindex.mjs:39`,
`bin/mnemosyne-skill-helper.mjs:104/122/195`, `bin/mnemosyne-install-hooks:108`)
with `AbortController`/`signal`-based timeouts — a real, established
in-codebase pattern this story reuses for its own per-request timeout,
rather than inventing a new HTTP-client convention. **No HTML-parsing
library** (no cheerio/jsdom/etc.) exists in this codebase — confirmed via
`package.json`. This story's first cut therefore does **naive,
best-effort tag-stripping text extraction**, explicitly named as such (not
a readability-grade content-extraction engine) — adding a real HTML-parser
dependency is named an explicit non-goal / open question, not silently
assumed.

**Explicit non-goals (never hand-waved):**
- Not a general-purpose web scraper/spider.
- Not unbounded or recursive crawling by default.
- Not able to authenticate, inject credentials, use cookies, or otherwise
  bypass any access control on a target URL — plain, unauthenticated GET
  only; a 401/403 response fails loudly, never worked around.
- Not a scheduled/background crawler — one bounded, on-demand call.
- Not a readability/content-extraction engine — naive tag-stripping only,
  in this story's cut.

**Scope limits (smallest safe default, explicit opt-in for more):**
- Default: **exactly one page** (the given URL). Multi-page (same-domain
  only, never cross-domain) crawling is a separate, explicit opt-in
  parameter, hard-capped at a small maximum page count regardless of what
  the caller requests — never truly unbounded even when opted in.

**Politeness / rate limiting (real, testable, not "best effort"):**
- `robots.txt` for the target host is fetched and checked BEFORE any page
  fetch; disallowed paths fail loudly with a clear message — never silently
  skipped, never silently ignored.
- An honest, self-identifying `User-Agent` (names Mnemosyne + this repo's
  URL) — never a spoofed browser UA to dodge robots.txt/rate limits,
  matching this project's own loud-failure-never-silent-workaround ethos.
- A minimum, real, enforced delay between requests to the same host when
  multi-page crawling is opted into (a named constant, tested directly —
  mirrors `crawl-context.mjs`'s own "every cap enforced in code, not just
  documented" discipline).

**Size/time bounds (real ceilings, not assumed safe):**
- A hard per-request timeout (mirrors the existing `AbortController`
  precedent cited above).
- A hard total-crawl wall-clock ceiling when multi-page.
- A hard per-page byte-size cap, reusing the SAME `MAX_INGEST_BYTES`
  constant `ro-10` defines (one shared cap, not two independently-drifting
  ones) — oversized or non-text (`Content-Type` checked before reading the
  body) responses are rejected, never partially buffered into memory
  unbounded.
- Landing mechanism: extracted text is fed through `ro-10`'s
  `ingestDocument()` unchanged — never a second, parallel storage path.

**New, named safety concern** (mirroring `ro-06`'s own precedent — not in
the generic `.pHive/cross-cutting-concerns.yaml` list, which has no entry
for outbound network fetches): **external-fetch-safety** — applies to
`ro-11` by name, with its own explicit acceptance criteria for robots.txt
compliance, rate limiting, and the size/time ceilings above.

**Named, accepted risk (not solved here):** repeated crawls of the same URL
create new, additive chunks each time (`remember()`'s vector write path is
`--no-prune`, additive-only by design, per `VectorLayerAdapter.ts`'s own
doc comment) — unbounded storage growth from repeat crawls is a real risk,
explicitly named and deferred to whoever eventually builds staleness/dedup
handling (the same class of forward-compatibility note `ro-02` already
carries toward `m-06-continuous-indexing` for the file-index manifest — see
grill finding 5.1), not solved inside `ro-11` itself.

### 7.4 (D) Verify-and-inject usage loop — already fully covered by shipped infrastructure, zero new code

Read `hooks/README.md` and `lib/mnemosyne/layer1/tiers.ts` in full before
concluding anything here (not assumed). Finding: **this is already real and
already reused — no new story, no new code.**

- `hooks/pre-recall.mjs` / `hooks/post-remember.mjs` (`hooks/README.md`) are
  the actual, already-shipped, automated "recall before work, remember
  after work" loop — installed via `bin/mnemosyne-install-hooks` into a
  harness's own `settings.json` (Claude Code today), firing on
  `UserPromptSubmit`/`Stop`/`SubagentStop`.
- `lib/mnemosyne/layer1/tiers.ts`'s own doc comment (lines ~86-96,
  `la-07-layer1-enforcement-mandate`) ALREADY names this exact mechanism
  explicitly in the mandate text every `syncAllHarnesses()` call splices
  into a synced repo's `CLAUDE.md`/`AGENTS.md`/`GEMINI.md`: *"Where a
  harness has a real startup-hook mechanism, this text says so and names
  it -- Claude Code's `hooks/pre-recall.mjs`/`hooks/post-remember.mjs`... is
  real and already fires automatically once installed... Codex and Gemini
  CLI have no equivalent hook mechanism -- for those, this instruction text
  IS the enforcement surface, degraded but not absent."*
- `ro-02`'s Layer-1-sync sub-step ALREADY calls `syncAllHarnesses()`
  unmodified — which already splices this exact, already-hook-aware mandate
  text into whatever repo/product `onboardRepo()` runs against, Mode A or
  Mode B alike. **A Mode-B-onboarded product's agent gets the identical
  mandate text — naming the identical real hook mechanism — as the
  operator's own harness. Not a second, bespoke mechanism; the same one,
  reached through the same already-planned `ro-02` call.**

**The one real, small gap, closed as a tiny addition (not a new story):**
`bin/mnemosyne-install-hooks` is a machine-global action
(`~/.claude/settings.json`) that nothing in this epic (or the shipped
`mnemosyne-agent-harness-install` epic) ever auto-runs — consistent with
this codebase's own established "heavy/mutating steps stay separate,
explicit, operator-confirmed" convention (`install.sh`'s header comment,
`grill 3.2`'s resolution for `--build` itself). `ro-03`'s `agent init
--build` completion output gains one more printed line surfacing `bin/
mnemosyne-install-hooks` as a next step (same "print, never auto-run"
convention, one more line in the same style `install.sh` already uses for
`agent init` itself and `ro-03` already uses for `--build` itself) — making
the ALREADY-real mechanism discoverable at the exact moment a Mode B
operator most needs to know about it, never inventing a new one.

### 7.5 (E) Two explicit install paths — new story `ro-12`

Read `docs/install.sh` and `README.md`'s Quickstart in full before
designing this (not assumed). Today there is genuinely **one** flow:
`curl|bash install.sh` (clone + `npm install` + symlink `bin/mnemosyne`)
→ prints (never runs) `mnemosyne agent init` as the single next step.
`agent init --build` (`ro-03`, this epic) and `mnemosyne onboard`
(`ro-05`/`ro-07`, this epic) both build ON TOP of that one flow — but
nothing in the docs or CLI output ever frames them as two DELIBERATE,
named, discoverable choices. This confirms the task's own framing: **the
new work is discoverability, not re-architecture.** No third install
mechanism is introduced anywhere in this story.

- **Sidecar / embedded install** — the README/CLI-facing name for exactly
  what design-discussion.md already calls **Mode B**: `mnemosyne agent
  init --build [--storage-dir <dir>]` (`ro-03` + §7.1's amendment above).
  Same thing, one more name for the same concept, not a third mode.
- **Full / system install** — the README/CLI-facing name for **Mode A**:
  `mnemosyne agent init` (unchanged, no `--build`) to register the
  operator's own harness, plus `mnemosyne onboard <path> --collection
  <name> [--create]` (`ro-05`/`ro-07`) to join the operator's own Pantheon
  tree — or, on a standalone system running its own harness/agents with no
  Pantheon tree of its own, the same `mnemosyne onboard` verb against
  whatever collection that system's own `swarm-memory`/Qdrant Cloud
  configuration resolves to. Confirmed via real code reading: `mnemosyne
  onboard` has no dependency on being "inside" any particular tree beyond
  the collection name it's given — "part of Pantheon" vs. "standalone on a
  system" is an operator-side Qdrant/collection-naming choice, not a
  code-level branch this story needs to add.

**Concrete, small, docs/CLI-output-only changes:**
1. `README.md`'s Quickstart gains an explicit "choose your install path"
   fork right after the existing `curl|bash install.sh` step, naming both
   paths above with their real commands.
2. `docs/install.sh`'s existing step-4 print block (today: prints only
   `mnemosyne agent init`) gains a short, additive "two ways to finish
   setup" section naming both `agent init --build` (sidecar) and `agent
   init` + `mnemosyne onboard` (full/system) — no new script logic, no new
   mutating step, same print-only discipline the file already has.
3. `mnemosyne agent status` (already-shipped, already read-only) gains one
   printed line surfacing which path is/isn't yet run for the current repo
   (e.g., "Onboarding: not yet run. Sidecar: `agent init --build`. Full
   (join your tree): `mnemosyne onboard <path> --collection <name>`").

### 7.6 Updated risks (additive to §3 above)

- **R10 (new) — a naive HTML tag-stripper produces low-quality extracted
  text for complex pages**, degrading `recall()` hit quality for crawled
  content. Mitigation: named as an explicit limitation in `ro-11`'s own
  docs/acceptance criteria, not silently promised as high-fidelity;
  upgrading to a real HTML-parsing dependency is named as a genuine,
  separate open question, not bundled into this story.
- **R11 (new) — unbounded storage growth from repeated crawls/ingests of
  the same source** (both `ro-10` and `ro-11`'s writes are additive-only,
  matching `VectorLayerAdapter`'s `--no-prune` design) — named explicitly,
  deferred to whoever eventually builds dedup/staleness handling (same
  class of note as `ro-02`'s existing forward-compatibility pointer to
  `m-06-continuous-indexing`), not solved by this amendment.
- **R12 (new) — a crawl call to an internal/private URL** (e.g.
  `http://169.254.169.254/...` cloud-metadata endpoints, or another service
  on the same host/network) **could be used as a network probe** if the
  crawl target is ever caller-supplied without validation. Mitigation:
  `ro-11`'s research step must confirm whether a real SSRF guard (reject
  non-public/loopback/link-local targets) is warranted for this story's
  real deployment context, and its acceptance criteria must state the
  decision explicitly — not silently assumed safe because "it's just
  fetch()."

### 7.7 Updated dependencies (additive to §4 above)

- `lib/mnemosyne/client.ts`'s `MnemosyneClient.remember()` cascade
  (shipped, v0.14.0) — reused as-is by `ro-10`/`ro-11`, no changes to its
  own contract.
- `bin/mnemosyne-mcp.mjs`'s `registerTool(...)` pattern (shipped) — reused
  for `ro-10`'s new `ingest_document` MCP tool.
- Node 20+ global `fetch()` (already used repeatedly across this codebase,
  cited above) — reused for `ro-11`'s HTTP fetches; no new HTTP-client
  dependency.
- `skills/mnemosyne-persona-interview/crawl-context.mjs` (shipped,
  `pu-07`) — its bounded-cap PATTERN is mirrored by `ro-10`/`ro-11`, its
  code is not imported (different domain).
- `lib/mnemosyne/layer1/tiers.ts`'s `la-07` mandate text (shipped) — cited,
  not modified, by §7.4's finding that D is already fully covered.

### 7.8 Open questions added by this amendment

**Genuinely open — need the operator's explicit answer before `ro-10`/`ro-11` execution:**

4. ~~Should PDF ingestion be added as a fast-follow story once `ro-10`'s
   plain-text/Markdown cut ships, and if so, which parsing dependency
   (there is no existing precedent in this codebase to default to)? This
   amendment's `ro-10` deliberately excludes it — named here so it is not
   silently forgotten, not because the operator's "PDF" mention was
   dropped.~~ **RESOLVED, round 3 — see §7.9.** PDF ingestion is real
   scope, not a fast-follow: new story `ro-13-pdf-document-ingestion`,
   `unpdf@^1.8.1` chosen as the parsing dependency.
5. ~~Does `ro-11`'s crawl target ever need SSRF protection (rejecting
   internal/private-network URLs), or is this story's real deployment
   context (an operator or a product's own agent supplying URLs, not
   arbitrary untrusted end-user input) low-risk enough that the research
   step can document the decision and move on without adding a guard? See
   risk R12 above — resolved as a required, explicit research-step
   decision inside `ro-11`, not blocking planning.~~ **RESOLVED, round 3
   — see §7.9.** The operator's own explicit answer makes the SSRF guard
   firm and default-on, no bypass flag; see `ro-11-bounded-website-crawl
   .yaml`'s revised acceptance criteria (the new resolved-IP-range-check
   criteria, immediately following the existing timeout criterion).
6. **(New, round 3, NOT resolved.)** Does the epic ever need a legitimate
   way for `ro-11`'s crawl target to reach a private-network address? A
   concrete, plausible (not merely hypothetical) case surfaced during
   round-3 research: a Mode B product being onboarded while its own
   "website" is still an internal-only staging deployment (this epic's
   own Mode B narrative, §1/§7, is explicitly about products still under
   active development — an internal-only staging URL for such a product
   is a realistic, not contrived, scenario). The firm, default-on SSRF
   guard (§7.9) would reject that legitimate target with no escape hatch
   in this story's current cut. No bypass flag has been added to resolve
   this — per the operator's own explicit instruction ("SSRF, lets put a
   guard in place unless that blocks something explicitly"), the default
   stays guard-on/no-bypass, and this tension is surfaced here for the
   operator's own future call rather than silently worked around or
   silently ignored.

**Resolved during this amendment pass (no longer open):**

- Whether (A) needed a new story: resolved no — small, additive changes to
  already-planned `ro-02`/`ro-03`.
- Whether (D) needed a new story or new code: resolved no — already fully
  covered by `ro-02`'s existing reuse of `syncAllHarnesses()` /
  `la-07`'s already-hook-aware mandate text; one small printed-output line
  added to `ro-03`.

**Resolved during round 3 (see §7.9 for the full trail):**

- Open question #4 (PDF ingestion): resolved yes, real scope now — new
  story `ro-13-pdf-document-ingestion`.
- Open question #5 (SSRF guard): resolved firm/default-on, no bypass —
  `ro-11`'s acceptance criteria revised accordingly.

## 7.9 Amendment, round 3 (2026-08-19, same day) — PDF ingestion is real
scope, SSRF guard is firm and default-on

Two of this epic's own open questions (§7.8 #4 and #5) were left open
pending the operator's explicit answer. The operator answered both
directly, in the same session as this amendment. `docs/grill-record.md`
round 3 (5/5 findings resolved) grills these two changes at the same
rigor as rounds 1/2; this section documents the resolutions themselves.
Everything in §§1-7.8 above stands unchanged except the two open-question
annotations updated in place, immediately above.

### 7.9.1 Open question #4 RESOLVED — PDF ingestion, new story `ro-13`

**Operator's own words, verbatim:** PDF ingestion must happen, not be
deferred to an unscoped follow-on.

New story `ro-13-pdf-document-ingestion`
(`.pHive/epics/mnemosyne-repo-onboarding/stories/ro-13-pdf-document-
ingestion.yaml`), `depends_on: [ro-10-document-ingestion-primitive]`.
Extends the SAME `ingestDocument()` primitive `ro-10` ships — never a
second, parallel ingestion path, per the operator's explicit instruction
and this epic's own established "one primitive, multiple input formats"
discipline (`ro-11` already does the same thing for crawled HTML text).

**Real dependency research, npm registry and tarball read directly (not
assumed):**

| | `pdf-parse@2.4.5` | `unpdf@1.8.1` (chosen) |
|---|---|---|
| Required deps | `pdfjs-dist` + `@napi-rs/canvas` (native, REQUIRED) | none (registry-confirmed: no `dependencies` field) |
| `@napi-rs/canvas` | hard dependency, always installed | `peerDependency`, `peerDependenciesMeta.optional: true` — never installed unless the consumer imports image-rendering features this story never calls |
| Native/WASM binaries in package | yes (`@napi-rs/canvas` native addon) | zero — tarball-confirmed, zero `.node`/`.wasm` files in 157 packaged files |
| Vendored PDF engine | pulls external `pdfjs-dist` | vendors Mozilla's own `pdf.js` directly (`dist/pdfjs.mjs`, 1.68MB) — the same parser shipped in every Firefox install |
| `engines.node` | `>=20.16.0 <21 \|\| >=22.3.0` | `>=22` |
| Maintainer | community fork (mehmet-kozan) | UnJS collective (`unbuild`/`ofetch`/`h3` maintainers) |
| Last publish (at research time) | 2025-10-29 | 2026-08-13 (6 days before this amendment) |
| Weekly downloads | ~6.99M | ~2.35M |

`pdf-parse` was rejected specifically because its hard, required
dependency on `@napi-rs/canvas` (a native N-API addon) is exactly the
class of dependency this codebase already has one avoidable instance of
(`better-sqlite3`, whose native-binding crash is a named, already-
documented pre-existing test flake per `mnemosyne-memory-levels`'s own
`horizontal-plan.md`) and has no reason to add a second. `unpdf`'s only
reference to `@napi-rs/canvas` is an unused, optional peer dependency for
a feature (`renderPageAsImage`) this story never imports. Depending on
raw `pdfjs-dist` directly was also considered and rejected: its current
version (6.2.108) requires an even stricter Node floor
(`>=22.13.0 || >=24`) with no packaging convenience `unpdf` doesn't
already provide for text-only extraction. Grill round 3 pushed this
verification one level deeper than the declared-dependency graph: the
vendored `dist/pdfjs.mjs` bundle itself was grepped directly for
`require(`/`process.dlopen`/`.node`-suffixed dynamic-load patterns — zero
matches, confirming no native module loads at runtime through an
undeclared path either.

**Real, honest tradeoff, not silently absorbed:** `unpdf`'s `engines.node`
floor (`>=22`) is stricter than this package's own current declared floor
(`>=20`). This repo's actual CI (`ci.yml`, `node-version: '22'`) and local
dev environment (`node --version` -> v24.18.1 at research time) both
already satisfy it, and the entire modern `pdf.js` ecosystem has moved
past Node 20 (confirmed by `pdfjs-dist`'s own even-stricter floor above)
— not a quirk unique to this one dependency choice. `package.json`'s
`engines.node` is bumped from `>=20` to `>=22` as a real, named,
package-wide effect of this story (npm's `engines` field is not
conditional per feature), called out explicitly in `ro-09`'s CHANGELOG
entry rather than silently absorbed as a PDF-only change.

**Bounded scope, mirroring `ro-10`'s own discipline exactly (never parse
first, bound later):** a new `MAX_PDF_SOURCE_BYTES` constant caps the raw
PDF file's byte size BEFORE `unpdf`'s `getDocumentProxy()` is ever
called — deliberately a separate constant from `ro-10`'s existing
`MAX_INGEST_BYTES` (the two measure structurally different things:
compressed binary source bytes vs. already-extracted text bytes; a
PDF's byte size is dominated by embedded images/fonts, not proportional
to its text content). After extraction, the resulting text still flows
through `ro-10`'s existing, unmodified `MAX_INGEST_BYTES` enforcement —
zero new post-extraction size logic. Corrupt/encrypted PDFs fail loudly:
confirmed directly from the vendored `pdf.js` source that it throws real,
named, distinguishable exception classes (`PasswordException` for
encrypted/password-protected PDFs, `InvalidPDFException` for corrupt/
malformed structure) — never a silent empty-content ingest.
Page/chunk granularity is preserved explicitly: `unpdf`'s `extractText()`
returns one string per page; each page's text runs through `ro-10`'s
existing chunker independently, and every resulting chunk's tag carries
BOTH page number and chunk-within-page index — a `recall()` hit's
provenance traces back to a real page, not an anonymous flattened
position.

**Full acceptance criteria, dependencies, risks, cross-cutting
evaluation:** see `ro-13-pdf-document-ingestion.yaml` in full.
`epic.yaml`'s `stories:` list and `ro-09`'s `depends_on` both extended to
include `ro-13`.

### 7.9.2 Open question #5 RESOLVED — `ro-11`'s SSRF guard is firm and
default-on

**Operator's own words, verbatim:** "SSRF, lets put a guard in place
unless that blocks something explicitly."

This is no longer a research-step judgment call (as rounds 1/2 left it,
risk R12) — `ro-11-bounded-website-crawl.yaml`'s acceptance criteria are
revised to make the guard a firm requirement: the target hostname is
resolved and the resolved IP is checked against the blocked ranges
(`127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`,
`169.254.0.0/16` including the `169.254.169.254` cloud-metadata address,
`::1`, `fc00::/7`, `fe80::/10`) BEFORE any fetch is attempted, failing
loudly and naming the specific matched range. No flag, option, or
environment variable exists anywhere in the module to bypass the guard —
confirmed as its own explicit acceptance criterion, not merely a default
that a later option could quietly override.

**The escape-hatch instruction, honored explicitly:** the operator's own
instruction was conditional — "unless that blocks something explicitly."
Research re-read `ro-11`'s own §7.3/§7.6 real-deployment-context framing
and grill round 2's finding 2.3.1 (this story's caller is "an operator or
a product's own agent supplying URLs, not arbitrary untrusted end-user
input") looking for a genuine conflict. **One real, concrete tension was
found, named explicitly rather than silently resolved either direction:**
a Mode B product being onboarded while its own "website" is still an
internal-only staging deployment — plausible, not contrived, given this
epic's own Mode B narrative is explicitly about products still under
active development. That legitimate target would be rejected by the same
guard, with no escape hatch in this story's current cut. Per the
operator's own explicit instruction, **no bypass flag was added** to
resolve this tension — the default stays guard-on/no-bypass, full stop,
and the tension is now open question #6 (§7.8, newly added) for the
operator's own future call, not silently worked around or silently
ignored.

**A second real gap surfaced by grill round 3, finding 3.3.1, and
resolved (not silently left as a false sense of completeness):** a naive
"resolve DNS once, then fetch separately" implementation has a
DNS-rebinding TOCTOU (time-of-check-to-time-of-use) gap — a rebinding DNS
server could return a public IP for the guard's own check and a private
IP for `fetch()`'s own later internal resolution, bypassing the guard
entirely despite it being real, present code. A full fix (pinning the
exact validated socket for the actual connection while preserving TLS
SNI correctness) requires connection-level control this story's "first
cut" (plain global `fetch()`) does not have — named explicitly as a new
risk, R13, in `ro-11`, not silently treated as closed. Mitigated (not
eliminated): the guard re-resolves and re-checks immediately before
EVERY individual fetch, including each page of a multi-page crawl, never
cached/trusted once for the whole crawl call — a new, explicit
acceptance criterion requires call-count-instrumented proof of this in
`ro-11`'s own tests.

**Full acceptance criteria, risks (R12 updated, R13 new), design
decisions, and implementation-step revisions:** see
`ro-11-bounded-website-crawl.yaml` in full — no change to `ro-11`'s
`depends_on`, non-goals, robots.txt/rate-limit/size-bound requirements,
or three-surface (MCP tool/CLI/HTTP route) shape; this round's changes
are additive to the existing story, not a re-scope.

### 7.9.3 Scope discipline confirmed

Both changes land as: one new story (`ro-13`) that extends an existing
primitive rather than duplicating it, and one story's acceptance criteria
revised in place (`ro-11`) rather than re-architected. `epic.yaml`'s
`version_bump` stays `minor`: `ro-13` adds a new dependency and bumps
`engines.node`, but introduces zero breaking changes to any existing
CLI/MCP/HTTP contract; `ro-11`'s revision only tightens an
already-planned story's own acceptance criteria before any of its code
was written. No build-out has started on either story — planning only.
