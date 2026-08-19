# Research Brief — mnemosyne-repo-onboarding

## 0. What was asked (operator's own words, verbatim)

> "you also need a way to add a new repo or spot or something to the memory
> and build out, index, get the base level and onboard it into the memory
> system and where it sits as a whole so that we can build and create our
> tree and mapping logic and where it all sits and how it works. Then it
> becomes EASY to define the roles and places and metadata across etc."

> "same thing, if we ship an individual mnemosyne WITH a product, it should
> be able to stand up, build, and have its own usage and internal memory,
> reading, and work WITH that agent etc so that the knowledgebase and
> context improve and continue to grow in that area"

Two deployment modes for one onboarding capability:
- **Mode A** — tree-integrated: a new repo joins the operator's own
  multi-repo Qdrant Cloud tree, gets classified/placed, becomes reachable by
  the tier/persona system.
- **Mode B** — standalone/embedded: Mnemosyne ships inside another product's
  repo, self-bootstraps with zero operator Qdrant dependency, and grows its
  own knowledge purely through that product's own agent calling
  recall()/remember().

## 1. The 5-level memory taxonomy (ground truth, fully shipped)

`lib/mnemosyne/memory-levels/levels.ts` (epic `mnemosyne-memory-levels`,
**all 10 stories ml-01..ml-10 status: complete**) is the single source of
truth for "what is a memory level":

| Level | Label | Mechanism | Adapter names | Live-configured check |
|---|---|---|---|---|
| 0 | Mnemosyne operator rules | `~/.mnemosyne/level0-rules.md`, read fresh every sync, hard-fails if missing | none (not in recall() cascade) | `existsSync(DEFAULT_LEVEL0_PATH)` |
| 1 | Repo agent overlay | `CLAUDE.md`/`AGENTS.md`/`GEMINI.md` managed block, spliced by `layer1/sync.ts` | none | `existsSync(<repoRoot>/mnemosyne.md)` |
| 2 | Graph | `graphify` (default) / `code-graph` (legacy) adapters | `graphify`, `code-graph` | present in `client.getConfiguredLayers()` |
| 3 | Vector | `vector` (swarm-memory/Qdrant) / `keyword` adapters | `vector`, `keyword` | present in `client.getConfiguredLayers()` |
| 4 | File doc store | `FileLayerAdapter`, brute-force walk-and-grep, no cache | `file` | present in `client.getConfiguredLayers()` |

**`GET /memory-levels` already exists and answers exactly the operator's
"get the base level" question** (`lib/mnemosyne/server.ts:415-460`, story
`ml-04-memory-levels-route`, status complete, plus a UI in `ml-05`). It
computes, per level, whether it is "configured right now" using only two
kinds of real, live check (existsSync for 0/1; presence in the already-
resolved `client.getConfiguredLayers()` cascade for 2-4) — never a second,
independent resolution. **This epic's job is to make a newly onboarded
repo's `GET /memory-levels` report levels configured, not to reinvent level
detection.**

## 2. The retrieval-cascade axis (`lib/mnemosyne/layers/`)

- `registry.ts` — name → factory map. Built-ins: `code-graph`, `vector`,
  `file`, `graphify`, `crossref-linker`, `keyword`. `create()` throws on an
  unknown name (`registry.ts:39-47`).
- `config.ts` — resolves the active stack: explicit > `MNEMOSYNE_LAYERS` env
  (JSON) > `mnemosyne.layers.json` at target root > hardcoded default
  (`graphify, vector, file` when the `graphify` binary is on PATH, else a
  soft fallback to `code-graph, vector, file` with a `console.warn`,
  `config.ts:108-120`). **No hard external-binary requirement for an
  unconfigured install** — this is exactly what makes Mode B viable.
- `client.ts` — `MnemosyneClient.recall()` cascades layer-by-layer,
  escalating on zero-hit success, stopping at the first non-empty success;
  `remember()` (v0.14.0, just shipped) cascades through every **writable**
  configured layer in stack order when no explicit target is given
  (`client.ts:447-531`), recording a `degraded` reason when it had to fall
  through. **`FileLayerAdapter` is the last entry in the default stack and
  is always writable with zero external dependency** (`FileLayerAdapter.ts`,
  `remember()` at line 132: `mkdir` + `writeFile` under
  `<root>/mnemosyne-notes/`, no network, no binary, no config file).
- `VectorLayerAdapter`'s constructor does **not** throw eagerly on missing
  credentials/binary (unlike `GraphifyLayerAdapter`, which throws
  synchronously if the `graphify` binary isn't on PATH — `config.ts`'s doc
  comment, confirmed). A vector-layer call without `swarm-memory` on PATH
  fails at call time (`VectorLayerAdapter.ts:325`, `"swarm-memory is not
  installed or not on PATH"`) and the cascade degrades past it. **A Mode B
  install with `vector` still in its layer stack but no `swarm-memory`
  binary/credential configured does not crash — it degrades to `file`,
  logged as `layer_degraded`.**
- `remember()`'s vector write path resolves `scope → collection` via a
  `cfg.scopes` map read from swarm-memory's own config
  (`VectorLayerAdapter.ts:213-226`) and fails loudly with `unknown_scope`
  when the scope isn't in that map. **This is the concrete mechanism a new
  repo must be registered into for Mode A's vector layer to become
  writable** — today nothing in this codebase creates that scope→collection
  mapping for a brand-new repo; `qdrant_inventory.py` only *reads* existing
  collections and `placement_engine.py` only *classifies* a collection name
  that already exists.

## 3. Mode A — existing pieces (Qdrant tree side)

- `mnemosyne/inventory/qdrant_inventory.py` (`inventory_collections`,
  `write_inventory_manifest`) — read-only enumeration of collections
  already in Qdrant Cloud (via `swarm-memory`'s own key/config files at
  `~/.config/swarm-memory/{qdrant.key,config.toml}`). No creation path.
- `mnemosyne/placement_engine.py` (`classify_collection`,
  `place_collections`) — pure heuristic classifier: a collection name
  containing `"project-"` or `"enterprise-"` maps to
  `org/<scope>/<remainder>`; ambiguous or unmarked names default to
  `enterprise` scope with `needs_override=True` for operator review
  (`.pHive/epics/ingest-a10ab2c1/docs/placement-rules.md`). **Operates only
  on a name string — has no concept of "this collection doesn't exist yet
  and I need to create it."**
- `.pHive/epics/ingest-a10ab2c1` ("Ingest EVERYTHING into memory and
  org-tree") — 22 planned stories, only 2 built (`qdrant-inventory`,
  `qdrant-placement-rules`). The remaining 20 (`repo-inventory`,
  `repo-categorization`, `repo-index`, `repo-continuous-index`,
  `repo-verification`, `artifact-*`, `house-*`, `gemini-*`) are a **one-time
  bulk sweep** of the operator's *entire* existing GitHub/artifact/life
  corpus — not built, not superseded by this epic. **Direct overlap risk**:
  `repo-inventory` → `repo-categorization` → `repo-index` →
  `repo-continuous-index` → `repo-verification` is, story-for-story, "Mode
  A applied once per existing repo, in bulk." This epic must build the
  general single-repo primitive; `ingest-a10ab2c1`'s repo-\* stories should
  become **callers** of it, not independent reimplementations. Flagged
  explicitly in design discussion, not silently resolved.
- Layer 1 role/tier system: `layer1/tiers.ts` (4 fixed tiers:
  top-orchestrator, company-director, project-orchestrator, code-architect —
  "the orchestration-tier axis," explicitly NOT a memory level, per
  `levels.ts`'s own doc comment), `layer1/sync.ts` (`syncAllHarnesses`,
  idempotent splice into `CLAUDE.md`/`AGENTS.md`/`GEMINI.md`),
  `layer1/persona-store-repo-local.ts` (`writeRepoLocalPersona`,
  `<repoRoot>/.mnemosyne/personas/<scopeId>.yaml`, code-architect tier only,
  git-committed). **"Roles and places and metadata become EASY to define"
  is this exact mechanism — already built and already reusable — the gap is
  that nothing today runs `syncAllHarnesses`/seeds a persona automatically
  as part of bringing a brand-new repo online; a human currently has to know
  to run `bin/mnemosyne-persona.mjs sync` by hand.**

## 4. Mode B — existing pieces (embedded/standalone side)

- `docs/install.sh` (epic `mnemosyne-agent-harness-install`, all 5 stories
  shipped) — git-clone (idempotent: `git pull` if already cloned) + `npm
  install` + symlink `bin/mnemosyne` onto PATH. Deliberately prints but
  never runs `mnemosyne agent init` (blast-radius separation,
  design-discussion.md §1.2 of that epic).
- `bin/mnemosyne-agent.mjs` — `mnemosyne agent init`/`status`. Detects
  Claude Code / Codex CLI on PATH, registers `bin/mnemosyne-mcp.mjs` as an
  MCP server (targeted `mcp get` check, never `mcp list` — a named,
  intentional idempotency contract, see file header), and (Claude Code only)
  copies `skills/mnemosyne-standalone/` +
  `skills/mnemosyne-persona-interview/` into `~/.claude/skills/`.
  **`agent init` today registers the MCP server and skills — it does NOT
  run any first-time indexing of the host product's own codebase, and does
  NOT run `syncAllHarnesses`/persona seeding.** This is the real, named gap
  Mode B's "stand up, build" quote is asking to close.
- `bin/mnemosyne-file-index.mjs` — CLI verb wrapping
  `FileStoreIndex.ts`'s `writeFileStoreIndex()` (ml-06/ml-08, shipped):
  full, from-scratch walk + write of `<root>/.mnemosyne/file-index.json`.
  Same call path for "first build" and "rebuild" — no separate code path
  needed. **This is the literal "build" primitive Mode B's own-codebase
  first-time index should call — it already exists and needs zero new
  indexing logic, only a wiring point.**
- `bin/mnemosyne-reindex.mjs` — thin HTTP client (`POST /reindex {scope,
  directory}`) against a *running* Mnemosyne service; single scope,
  vector-layer only, no state file, no resume. Requires a live service
  process — not usable at bare `agent init` time before the service is
  running for the first time in a product repo.
- `MnemosyneClient.remember()`'s file-floor cascade (§2 above) is the
  concrete mechanism making Mode B viable with **zero** external Qdrant
  dependency: an embedded install with no `swarm-memory` credential
  configured at all still has a fully working `recall()`/`remember()` loop
  through the `file` layer alone.
- `Scope` (`lib/mnemosyne/interfaces.ts:93`) is a fixed 3-value enum
  (`'project' | 'enterprise' | 'meta'`), **not** a collection name or
  org-tree path — a structurally different axis from the
  `project-`/`enterprise-` Qdrant-collection-name prefix convention
  `placement_engine.py` classifies. "Own scope isolated from the operator's
  meta-scope" for Mode B is really about **`rootDirectory` isolation**
  (`FileLayerAdapter`'s constructor takes a target directory — the host
  product's own repo root, structurally separate from any other repo on the
  same machine) plus (optionally) never configuring `vector`/`swarm-memory`
  credentials in the embedded install at all, not a new Scope value.

## 5. Existing, still-open backlog this epic must not duplicate

Read directly, not assumed — both remain `status: in_progress` /
`status: pending`-equivalent (not built):

- `m-06-continuous-indexing` (epic `mnemosyne-foundation`) — Multica-native
  scheduled/event-driven reindexing + staleness detection.
  `lib/mnemosyne/indexing/continuous.ts` + `staleness.ts` exist but are
  ONLY imported by their own test file — no runtime code path invokes them.
  **This is the real mechanism behind "continue to grow... over time" —
  this epic does not re-plan continuous background indexing; it plans the
  onboarding moment that makes a repo indexable/writable in the first
  place, and installs the Layer-1 mandate (`la-07`, already shipped
  content in `mnemosyne.md`'s "Memory-lifecycle mandate" section, spliced
  into every synced harness file) that drives ongoing manual
  remember()/recall() usage in the interim.**
- `m-07-first-god-integration` (epic `mnemosyne-foundation`) — a real
  Pantheon god (Minerva) actually calling `recall()`/`remember()` in
  production, cross-repo, not yet done from this repo's side. This is
  Mode B's real-world validation target for a *specific* consumer
  (Minerva); this epic builds the general onboarding mechanism any embedded
  consumer (Minerva included) would use, not the Minerva integration
  itself.
- `m-08-bulk-reindex-command` (epic `mnemosyne-foundation`) — idempotent,
  resumable, checksum-tracked, ALL-layers, ALL-sources bulk reindex. Real
  gap: `bin/mnemosyne-reindex.mjs` (64 lines) is single-scope,
  vector-layer-only, no resume state. **This epic's "first-time index a
  single newly-onboarded repo" story is deliberately narrower than m-08** —
  best-effort, single-repo, no checksum/resume state file. Flagged as a
  smaller, composable primitive m-08 could later subsume, not a
  replacement for it.

## 6. Confirmed real gaps this epic must close

1. No code path creates a **new** Qdrant collection / scope→collection
   mapping for a repo that doesn't have one yet (inventory + placement
   are read/classify-only).
2. No code path composes "classify + register + first index + Layer-1
   sync + persona seed" into one onboarding action for Mode A.
3. `mnemosyne agent init` (Mode B) never runs a first-time index of the
   host product's own codebase, and never runs `syncAllHarnesses`/persona
   seed — it only does MCP registration + skill copy.
4. No documented/recommended `mnemosyne.layers.json` default for an
   embedded (Mode B) install that explicitly opts out of `vector` rather
   than silently degrading past an always-attempted, always-failing layer.
5. No single place answers "is repo X onboarded, and to what degree" across
   both modes — `GET /memory-levels` answers "which levels are configured
   right now" for whatever repo the *running service's* `rootDirectory`
   happens to be, but nothing drives a fresh repo's levels from
   not-configured to configured, and nothing surfaces org-tree
   placement/scope alongside it.

## 7. Validation note

No external library/SDK/API surface requiring context7 validation — every
integration point above is internal to this repo (already-shipped
TypeScript/JavaScript modules and two existing Python scripts) or the
already-integrated `swarm-memory`/Qdrant Cloud/`graphify` externals this
codebase already depends on and already has adapters for. No web escalation
needed; confidence: high (every claim above is cited to a real file path
and, where useful, a line range, cross-checked against real story/epic
status fields on disk, not inferred from documentation alone).
