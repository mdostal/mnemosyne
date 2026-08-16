# Changelog

All notable changes to Mnemosyne are documented here.

## [0.9.0] — 2026-08-16

Full `mnemosyne-memory-levels` epic (`ml-01`..`ml-10`) — corrects the
operator-facing memory-STORE-TYPE model from a stale, conflated 3-tier
picture to the real 5-level taxonomy (0-4), and builds the three concrete
gaps that taxonomy exposed: the missing `mnemosyne.md` canonical Level 1
source, a `GET /memory-levels` route + UI section giving the taxonomy a
real surface, and a persisted Level 4 file-store sub-index with
area-scoped query-time narrowing. Every story independently verified
against real fixtures (real on-disk manifests, real HTTP round-trips, real
adversarial staleness/false-negative probes) before merging — zero
regressions found across the epic; the only failures on either side of the
`git diff` are pre-existing and unrelated (see Verification below).

### Added

- **Canonical memory-level taxonomy module** (`lib/mnemosyne/memory-levels/levels.ts`,
  ml-01) — the single source of truth for the 5 real memory-STORE-TYPE
  levels (0: operator-global rules, 1: role-scoped meta file, 2: enterprise/
  KG+vector, 3: project graph/doc-index, 4: file-store sub-index), each
  disambiguated in its own doc comments against the two other, unrelated
  "layer"/"tier" vocabularies already in this codebase (the retrieval-cascade
  layer stack in `lib/mnemosyne/layers/`, and the orchestration-tier
  hierarchy in `layer1/tiers.ts`) so the three never get conflated again.
- **`mnemosyne.md` canonical Level 1 source + `level1Source.ts` reader**
  (ml-02) — `mnemosyne.md` is now the single authored source for Level 1's
  mandate content; `MANDATE_SECTIONS` is generated from it at module load
  (anchored to the module's own file location, never `process.cwd()`
  dependent), replacing what had been implicit/undocumented sourcing.
- **`sync.ts` 3-part composition** (ml-03) — the existing harness-sync
  pipeline (`block.ts`/`lock.ts`/`harness.ts`, all unchanged) now composes
  Level 0 → Level 1 (`mnemosyne.md`) → tier content when Level 1 content is
  present, and falls back to the original 2-part (Level 0 → tier) output,
  byte-identical to the pre-epic behavior, when it is absent.
- **`GET /memory-levels` route** (`lib/mnemosyne/server.ts`, ml-04) — a new,
  parallel route (never a repurposing of the existing `GET /layers`) that
  surfaces all 5 levels with their live configured/available status: levels
  0/1 via a direct file-existence check, levels 2-4 via the already-resolved
  layer-stack output (no second resolution). `GET /layers`'s own response
  shape is unchanged (purely additive diff, byte-for-byte regression-proofed
  against a pre-capture baseline).
- **"Memory Levels (0-4)" UI section** (`ui/index.html`, `ui/app.js`, ml-05)
  — the standalone UI's former "Memory Layer Stack" panel is renamed
  "Retrieval Layer Stack" (to stop implying it's the whole taxonomy), and a
  new, separate "Memory Levels (0-4)" section renders `GET /memory-levels`'s
  output. Both panels carry explicit disambiguation text; `ui/app.js`'s diff
  is purely additive.
- **Level 4 file-store sub-index build** (`lib/mnemosyne/layers/FileStoreIndex.ts`,
  a shared `fileWalk.ts` extracted from `FileLayerAdapter.ts`, ml-06) — a
  persisted, directory+markdown-heading-granularity manifest of the file
  store, with graceful empty-manifest degradation when the target directory
  is missing or empty.
- **Query-time area-scoped narrowing** (`FileLayerAdapter.ts`, ml-07) — file
  recall can now narrow a query to a specific indexed area (falling back to
  a full walk when no area applies), always reading live content rather
  than the persisted manifest's text — proven via two independent
  adversarial checks (a file added to an area after indexing is still
  found; a file's content modified after indexing is never served stale).
- **`mnemosyne-file-index` CLI verb** (`bin/mnemosyne-file-index.mjs`, ml-08)
  — an operator-triggered rebuild of the Level 4 sub-index, calling ml-06's
  `writeFileStoreIndex` directly (always a full from-scratch walk +
  overwrite, no merge path). Fixed a real bug found during this story: the
  index's own `.mnemosyne` manifest directory was missing from
  `DEFAULT_IGNORED_DIRECTORIES`, which caused a second build to self-index
  its own prior manifest.

### Fixed

- **`docs/layer-architecture-v2-plan.md`'s conflated Layer 1/2/3 table**
  (ml-09) — added a note correcting the document's old table, which had
  mislabeled the harness-sync module as "Layer 1", merged hive-memory's
  KG+vector retrieval into "Layer 2", and merged Graphify's doc-index and
  code-graph into "Layer 3" — none of which match this epic's real 5-level
  taxonomy. The old table is preserved byte-for-byte (purely additive diff);
  the new note disambiguates all three "layer" vocabularies in one place and
  cross-links to `lib/mnemosyne/memory-levels/levels.ts` and this epic's own
  `.pHive/epics/mnemosyne-memory-levels/` ticket set.

### Verification

- Full suite (`npm test`'s vitest + `.mjs` subprocess composition) and
  `npx tsc --noEmit` run clean on this epic's final state, with the sole
  exception of 3 pre-existing, already-independently-documented-as-unrelated
  `test/http-api.mjs` assertion failures on `POST /remember`'s default-layer
  behavior (`ok:true` / `layer:file (default)` / `has provenance` — the
  route's real default is `'vector'`, a `pluggable-layers-implementation`
  epic decision that predates `mnemosyne-memory-levels` entirely; first
  flagged in ml-04's own completion note). Confirmed via a real
  stash-and-reproduce proof: checked out this branch's merge-base with
  `main` (commit `e079b17`, pre-epic), reran the identical full suite +
  `tsc --noEmit` there, and got the exact same 3 failures — nothing else —
  proving they predate this epic and are not caused by it.

## [0.8.0] — 2026-08-16

Full `mnemosyne-persona-wizard` epic (`pw-01`..`pw-17`) — Epic 2 of 2 in the
persona work. Turns Layer 1 from a code-and-CLI-only surface into a real,
browser-usable authoring tool: an operator can now list, view, and create
personas from the standalone UI, and an LLM-driven interview can author a
persona and index its own source material as real memory — the "initial
crawl and feeding" the operator asked for. Every story independently
verified with real tests (real subprocesses, real HTTP calls, real disk
read-backs) before merging; one real, live-breaking CORS preflight gap was
found and fixed during final verification (see below).

### Added

- **Personas panel (view + write) in the standalone UI** — a new panel
  lists every persona (global tiers plus, when a repo is given, that repo's
  `code-architect` personas), rendering a persona's `parentRefs` as
  pointer-only text (never fetching/inlining the parent's actual content —
  the same "query up, never copy down" guarantee Epic 1 enforces
  server-side). A create/edit form, following the existing `add-lane-form`
  convention exactly, writes a new persona via the HTTP route below and
  refreshes the list in place, no manual reload.
- **Memory layer stack panel** — a second, distinct panel shows the
  currently configured memory layer stack (via the already-shipped
  `GET /layers` route) and a view-only Level 0 pointer, kept structurally
  separate from the persona list.
- **`GET`/`POST /persona/:tier/:scopeId` + `GET /persona`** on
  `lib/mnemosyne/server.ts` — Layer 1 persona read/write is now reachable
  over plain HTTP, not just the CLI/MCP/skill-harness. Scoped
  `Access-Control-Allow-Origin` CORS (an allow-list of the UI's own known
  origins, never a wildcard) plus a real preflight `OPTIONS` handler, so
  the UI's write form actually works from a real browser (a gap found
  during this epic's own final verification — every server-side `fetch()`
  test had passed without ever exercising real preflight; see Fixed below).
- **`mnemosyne persona create` (CLI) / `persona_create` (MCP) /
  `persona-create` (skill-harness)** — the fourth write surface joining
  HTTP, all four now proven to funnel through the exact same
  `writeGlobalPersona`/`writeRepoLocalPersona` + `withLock` path via a real
  cross-transport round-trip test, including a genuine cross-transport
  concurrency race (a CLI subprocess and an MCP tool call racing a write to
  the same file) proving no lost updates or corruption.
- **`mnemosyne-persona-interview` skill** — a multi-turn, adaptive
  interview that authors a Layer 1 `Persona` record by conversing with an
  operator, grounded line-by-line in plugin-hive's own
  `kickoff-protocol.md` "Phase 3b: Discovery Questions" pattern (adaptive
  skip, explicit-marker-never-silent-omission persistence, non-blocking
  hard-fail rule). Works at both repo-spinup-lifecycle moments — authoring
  a global-tier persona before any repo exists, and a `code-architect`
  persona once one does — with zero new storage-level work, reusing Epic
  1's two-store split as-is.
- **`resolveRememberScope()`** (`lib/mnemosyne/layer1/persona.ts`) — the
  first real, deterministic mapping from a persona's `{tier, scopeId}` to a
  `remember()` call's scope/tag arguments (tier selects one of four fixed
  `persona-*` lanes; `scopeId` returns as a sanitized tag rather than being
  folded into the scope string, to avoid unbounded per-persona lane
  provisioning). Documented in both a code comment and a design-discussion
  addendum.
- **Crawl-and-feed wiring** — a completed interview now fires a real
  `remember()` call indexing its own source material, scoped via
  `resolveRememberScope()`, proven to fire even for a maximally-skipped
  interview (crawl-and-feed never silently no-ops just because most
  questions were skipped).

### Fixed

- **CORS preflight on `/persona/*`** — `POST /persona/:tier/:scopeId`'s
  JSON body makes it a non-"simple" cross-origin request, so a real browser
  sends an `OPTIONS` preflight before the actual write. `lib/mnemosyne/server.ts`
  had no `OPTIONS` handler at all, so that preflight fell through to the
  404 catch-all with no CORS header — silently blocking the new Personas
  panel's write form in every real browser, despite every unit test (which
  calls `fetch()` server-side and never enforces preflight) passing green.
  Found during this epic's own final verification pass, fixed alongside the
  UI form that surfaced it.

## [0.7.0] — 2026-08-15

Full MCP/skill-harness coverage for the persona CLI shipped in `v0.6.0` —
`persona_sync`/`persona_seed`/`persona_show` are now real tools/actions
whenever Mnemosyne is installed locally (MCP server or the Claude Code
skill harness), not just a standalone CLI. Closes the gap where the new
persona work was only reachable via `bin/mnemosyne persona ...` directly.

### Added

- **`persona_sync` / `persona_seed` / `persona_show` MCP tools**
  (`bin/mnemosyne-mcp.mjs`) — the full Layer 1 persona surface is now
  callable the same way `recall`/`remember`/`grep`/`graph_*` already are:
  as real MCP tools over stdio, verified end-to-end with a real MCP client
  against a real spawned server process (no mocks), including a real
  `$HOME`-sandboxed round trip (seed a global persona, read it back via
  `persona_show`, prove `persona_sync --dry-run` writes nothing).
- **`persona-sync` / `persona-seed` / `persona-show` skill-harness
  actions** (`bin/mnemosyne-skill-helper.mjs`, `skills/mnemosyne-standalone`)
  — same three operations, reachable from a bare Claude Code session via
  the existing skill harness. Unlike every other action in this file
  (which `fetch()` the HTTP API), these are a deliberate, documented
  exception: Layer 1 persona sync/seed/show has no HTTP route at all, so
  they shell out to the already-tested `bin/mnemosyne-persona.mjs` CLI as a
  subprocess instead — no swarm-memory/engine.mjs logic duplicated either
  way.

## [0.6.0] — 2026-08-15

Full `mnemosyne-persona-foundation` epic (`pf-01`..`pf-14`) — Epic 1 of 2 in the
persona work (`mnemosyne-persona-wizard`, Epic 2, is unbuilt and separate: no
LLM-interview wizard or UI ships in this release). Data-driven, two-tier persona
storage replaces the old hardcoded `TIER_CONTENT` map as the source of Layer 1's
tier content, with the old hardcoded path kept fully working as a non-regressive
fallback. Shipped the same way as prior epics: every story independently
verified with real tests (including real subprocess CLI invocations and real
cross-process locking) before merging.

### Added

- **Data-driven, two-tier persona storage** — `top-orchestrator`,
  `company-director`, and `project-orchestrator` personas now live in a new
  GLOBAL store (`~/.mnemosyne/personas/<tier>/<scopeId>.yaml`, not repo-scoped,
  not git-committed); `code-architect` personas live in a new REPO-LOCAL store
  (`<repoRoot>/.mnemosyne/personas/<scopeId>.yaml`, git-committed alongside the
  code it describes). `getPersonaContent` is the single content-resolution
  entry point `sync.ts` now calls, dispatching on the tier/store split; when no
  persona is seeded yet for a given tier/scopeId it falls back to the original
  hardcoded `TIER_CONTENT`, with a loud (non-silent) warning, so a bare install
  needs no seeding step to keep working.
- **Query-up pointer rendering, never copy-down** — a `code-architect` persona
  can name parent-tier context via `parentRefs` (`{tier, scopeId}` pairs). The
  rendered output for such a persona includes a "Parent context (query up)"
  section naming each parent's tier and scopeId plus a fetch instruction — it
  never inlines the parent's actual content. Verified by real tests against
  real parent personas written to a real (temp) global store: the parent's
  distinctive body text is proven absent from the rendered/synced output, for
  every tier combination and, since this release, across the full real-world
  fixture corpus (not just one example).
- **`mnemosyne persona sync` / `seed` / `show` CLI verbs**
  (`bin/mnemosyne-persona.mjs`, `bin/mnemosyne-persona-seed.mjs`) — `sync`
  writes the resolved persona content into a repo's harness file(s)
  (`CLAUDE.md`/`AGENTS.md`/`GEMINI.md`), with `--dry-run` support (zero
  filesystem writes, byte-identical preview to a real run); `seed` populates
  the global store from the old hardcoded `TIER_CONTENT`, proven
  byte-for-byte equivalent (modulo wrapping) to the pre-migration rendered
  output — a non-regressive cutover, not a rewrite; `show <tier> <scope-id>`
  is the on-demand fetch surface a `parentRefs` pointer instructs an agent to
  use.
- **Advisory file locking** (`lib/mnemosyne/layer1/lock.ts`) — a
  zero-third-party-dependency exclusive lock (`fs.writeFileSync(..., { flag:
  'wx' })`, with stale-lock takeover) now guards every persona-store write and
  every `syncHarnessFile` read-splice-write sequence. Closes a real,
  design-discussion-documented TOCTOU race: two overlapping sync invocations
  against the same file, previously uncoordinated between their read and their
  final write, could corrupt or duplicate the managed block. Verified with a
  real two-OS-process race test against a real-world fixture, not a synthetic
  counter file: the two invocations' critical sections provably never overlap
  in wall-clock time, and no lock file is left behind afterward.

### Fixed

- `block.ts`'s managed-block splice (`spliceManagedBlock`/
  `extractManagedBlockBody`) paired the FIRST `BLOCK_START` with the FIRST
  `BLOCK_END` (`indexOf`) instead of the LAST well-formed pair
  (`lastIndexOf`). A file that had accumulated a stray, never-closed
  `BLOCK_START` ahead of the real block (e.g. an interrupted manual paste)
  would have that stray marker wrongly treated as the real block's start on
  the next sync, silently deleting every human-authored line trapped between
  it and the real end marker. Found via a real-world fixture built specifically
  to exercise this shape (`gemini-md-partial-marker.md`); fixed by switching
  both functions to `lastIndexOf`. This fix benefits every consumer of
  `block.ts`, not just persona sync — it is the general-purpose managed-block
  splicing module every harness-file sync in this project shares.

## [0.5.0] — 2026-08-15

Full `mnemosyne-keyword-recall` epic (`kw-01`..`kw-03`) — closes a real, confirmed gap
found by `docs/qdrant-hybrid-retrieval-experiment.md`'s hands-on testing: dense-vector
semantic search cannot reliably distinguish near-identical exact identifiers (e.g. a
real ticket ID like `PAN-8968` vs. `PAN-7909` in this project's own memory corpus).
`swarm-memory grep` already found these correctly — the actual defect was that
`recall()`'s escalation logic only tried keyword search on zero vector hits, so a
query returning confidently-wrong semantic matches never got a chance to find the
real answer. Shipped the same way as `v0.3.0`/`v0.4.0`: every story independently
verified with real tests and real live-server checks against production data before
merging.

### Fixed

- **`recall()` now runs keyword search alongside vector search for every call**, in
  both implementations — the JS zero-dep server (`src/engine.mjs`) and the TS client
  (`lib/mnemosyne/client.ts`, via a new opt-in `KeywordLayerAdapter`/`"keyword"`
  layer). Not a sequential zero-hit escalation and not hybrid score-fusion — both are
  queried in parallel and merged, with a hit found by both paths deduped and tagged
  (`match_type: "both"` / `also_matched`) rather than either being silently dropped.
  Verified live: a real query for a real ticket ID now correctly returns the exact
  match via the keyword layer, alongside (not instead of) the wrong-but-plausible
  semantic neighbors that used to be the only result.
- Real regression coverage added for the exact failure shape (near-identical IDs
  sharing one template, mirroring the real corpus's `PAN-XXXX` pattern) as a
  synthetic, hermetic fixture shared by both implementations' test suites — so this
  can't silently regress again.

## [0.4.0] — 2026-08-14

Full `mnemosyne-crossrepo-defaults` epic (`cr-01`..`cr-04`) — Graphify promoted to
the default code-graph layer, and a new pluggable layer for the one real
cross-repo signal Graphify's own merge can't see. Shipped via the same
overnight autonomous execute/verify loop as `v0.3.0`; every story independently
verified (real tests, real subprocess proof, real diffs read) before merging.

### Added

- **Graphify is now the default code-graph layer** (both the TS client and the
  zero-dep JS server) — `la-10`'s real A/B benchmark found the old in-house
  `code-graph` layer's backing store held zero nodes from a real target repo at
  all (22 nodes total, from an unrelated repo), while Graphify indexed the real
  codebase. The promotion is a **soft default**: when nothing is explicitly
  configured and the `graphify` binary isn't installed, it falls back to the old
  `code-graph` layer with a loud warning rather than hard-failing — a bare
  install still needs no external binary. An *explicit* `MNEMOSYNE_LAYERS`
  request for `graphify` still fails loudly if the binary is missing, exactly as
  before — no silent downgrade for a deliberate choice. `code-graph` stays fully
  registered and selectable.
- **Cross-repo shared-identifier linker** (`"crossref-linker"`, a new optional
  layer) — real research this release, not speculation: Graphify's own
  cross-repo graph merge (`graphify global`/`merge-graphs`) was tested against
  three separate real repo pairings and found **zero** cross-repo edges every
  time whenever the real relationship was a network API or shared external SaaS
  backend rather than a shared imported package. This layer closes that gap for
  one real, validated case — cross-referencing schema/type *definition* sites
  against *query/usage* sites by shared string identifier. Ships with one
  built-in scheme (`"sanity"`), proven against a real link a hand-written
  prototype found and this layer now detects automatically: a Sanity document
  type defined in one repo, queried via GROQ in another. Multi-repo by design
  (every other layer scopes to one `repoRoot`; this one takes a list) — never
  invoked unless a consumer explicitly configures it.
- **Single-layer configs, proven not assumed** — real subprocess tests confirm
  pure-vector-only, pure-file-only, graphify-only, and crossref-linker-only
  `MNEMOSYNE_LAYERS` configs each work standalone with zero cross-layer
  leakage (verified via process/output inspection, not just response shape).
  Mnemosyne's customizable-layer promise is now backed by real tests, not just
  registry code that was assumed to behave correctly.

### Fixed

- `POST /remember`'s layer-name validation was stale against the real `Layer`
  union — explicitly targeting an already-shipped optional layer by name (e.g.
  `graphify` or `crossref-linker`) was wrongly rejected as `invalid_layer`
  instead of the correct `layer_not_writable` for a real, live, recall-only
  layer. Found via the single-layer-config proof work above.

## [0.3.0] — 2026-08-14

Full `mnemosyne-layer-architecture-v2` epic (`la-00`..`la-11`) — flight-aware memory,
Graphify as a real multi-language code+doc graph layer, and a harness-agnostic
enforcement mandate. Shipped via an overnight autonomous execute/verify loop; every
story independently verified (real tests re-run, real git operations exercised, real
diffs read) before merging forward — see `docs/layer-architecture-v2-plan.md` for the
full design.

### Added

- **Flight-aware memory** — every write now carries a `status`
  (`provisional` | `confirmed` | `superseded`) and `source_ref` (`branch`, `commit_sha`,
  `pr_url`), auto-detected from real git context. Work on a non-default branch is
  `provisional` (true for that branch only) until merged; recall defaults to
  confirmed-only across branches/agents, but a caller always sees its own in-flight
  `provisional` writes on its own branch. Nothing is ever deleted on supersede — a
  rejected approach stays queryable.
- **Pluggable lifecycle-trigger system**, local git hooks first — `bin/mnemosyne-install-git-hooks`
  installs a real `post-merge` hook (promotes matching `provisional` entries to
  `confirmed` on a real merge) and a `reference-transaction` hook (supersedes entries
  on branch deletion/abandonment). Deliberately not GitHub-Actions-based; the adapter
  interface stays open for future trigger sources (ticket-queue transitions, etc.).
  Each promote/supersede transition also writes an outcome/lesson entry (merge shape,
  real commit messages) back into memory.
- **Memory-lifecycle compliance audit** (`bin/mnemosyne-audit-lifecycle`) — the backstop
  for the git-hook system's own documented gap (hooks only fire on the machine where a
  merge happens). Independently re-derives, from real git state
  (`git merge-base --is-ancestor`), whether a still-`provisional` entry should already
  be `confirmed`; auto-remediates only on structurally-proven cases, flags anything
  merely plausible for manual review, and logs every remediation with the exact
  evidence that justified it.
- **Graphify adapter** (`lib/mnemosyne/layers/GraphifyLayerAdapter.ts`) — a new
  `"graphify"` layer (alongside, not replacing, `"code-graph"`) giving real
  multi-language (Python/TS/JS/Go/Rust/Java/C/C++/Ruby/C#/Kotlin/Scala) AST-based code
  structure and line-addressable markdown doc indexing, no LLM required. A real A/B
  benchmark (`benchmarks/layer-ab-test.ts`) found the existing in-house `code-graph`
  layer's backing store held zero nodes from this repo at all (22 nodes total, all from
  an unrelated repo) — Graphify is the recommended replacement, retirement tracked as a
  separate future story.
- **Level 0 — operator-global rules** (`~/.mnemosyne/level0-rules.md`) and **Layer 1 —
  role-scoped meta-file sync** (`lib/mnemosyne/layer1/`) — an idempotent generator that
  syncs a single source of truth into every harness's own native auto-load file
  (`CLAUDE.md`/`AGENTS.md`/`GEMINI.md`), always prepended with the operator's global
  rules (git workflow discipline, etc.), then tier-specific content
  (top-orchestrator/company-director/project-orchestrator/code-architect). Includes a
  real enforcement mandate — recall-on-entry and remember-on-exit are now wired into a
  real Claude Code hook, not just documented as a should-do.

### Fixed

- `graph_impact`/`graph_deps` MCP tools (`bin/mnemosyne-mcp.mjs`) silently always
  queried `node=undefined` regardless of caller input — a parameter-destructuring bug
  in how they were wired into `wrapAction`. Found and fixed while building the Graphify
  MCP bridge.

## [0.2.0] — 2026-08-13

### Added

- **Standalone UI** (`GET /ui`) — zero-dep browser shell over the existing HTTP
  service: liveliness + read-only settings, lanes (scopes) browser with
  add-lane, collections search (recall/grep with full provenance), a
  vanilla-SVG impact-graph view, and Operations panel (targeted reindex +
  local-cache refresh — deliberately never a Qdrant wipe).
- **Claude Code skill harness** (`skills/mnemosyne-standalone/`,
  `bin/mnemosyne-skill-helper.mjs`) — lets a bare Claude Code session drive a
  standalone Mnemosyne instance (auto-starts the service if not already
  running) without Pantheon present.
- **MCP server** (`bin/mnemosyne-mcp.mjs`) — the third standalone harness
  surface. Exposes `recall`, `remember`, `grep`, `reindex`, `graph_stats`,
  `graph_edges`, `graph_impact`, `graph_deps` as MCP tools over stdio, for
  any MCP-compatible client (Claude Code, Claude Desktop, T3 Chat, etc.).
  Registered as this repo's own project-scoped MCP server (`.mcp.json`).
- New HTTP endpoints: `GET /config`, `GET /search`, `GET /graph/*`,
  `POST /lanes`, `POST /index`, `POST /cache/refresh`.
- Real, live-verified benchmark (`npm run benchmark:recall-vs-find`) proving
  recall beats a full-file-read "find" baseline on token cost.

### Fixed

- `lib/mnemosyne/client.ts`'s `MnemosyneClient.remember()` was a stub
  returning fake success with no real write. Now delegates to a real
  vector-layer write path (mirrors `src/engine.mjs`'s proven pattern:
  additive note write + `swarm-memory index --no-prune`, loud failure on
  any error).
- `benchmarks/recall-vs-find.ts` never awaited its `recall()` call and used
  a hardcoded fake "find" baseline; now measures both sides for real.
- Reconciled a significant `main`/`dev` divergence (77 commits) — `dev`'s
  TypeScript layer-adapter implementation (file/vector/code-graph layers,
  continuous indexing, Minerva-integration library) is now unified with the
  zero-dep JS HTTP service on one history.

### Changed

- `north_star` success criteria reframed: standalone-first via any harness
  (hooks/MCP/skillsets) is the actual target, not bespoke per-god wiring.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
