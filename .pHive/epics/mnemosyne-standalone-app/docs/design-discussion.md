# Design Discussion: Mnemosyne Standalone App

## 0. Prelude

**North Star** (`.pHive/project-profile.yaml`):
- Goal: unify memory layers behind one recall/write API so "memory over find" becomes the default retrieval path for every agent
- Audience: Pantheon gods (Minerva, Argus, Metis, etc.) and swarm agents
- Pain: memory infrastructure exists but is fragmented — no single god owns the layer stack, no unified API, agents fall back to grep/find

**Prior decisions:** none in the knowledge graph yet — this is a new epic.

## 1. Goal

Give Mnemosyne a standalone mode: a local web UI + a harness/skill layer that let a human or a Claude Code session drive, observe, and operate the memory god **without Pantheon running**. Pantheon plugin-mode (L2 `ServiceDescriptorSchema`, port 8477, health endpoint) already exists via the current HTTP service and is explicitly **out of scope** for this epic — confirmed by the user: standalone comes first, plugin tie-in later.

## 2. Current state (verified, not assumed)

- `src/server.mjs`: zero-dep Node `http` service on `PORT` (default 8477). Routes today: `GET /`, `GET /health`, `GET /scopes`, `POST /recall`, `POST /remember`, `POST /grep`.
- `src/engine.mjs`: the only file that shells to the `swarm-memory` CLI (`execFile`). Exports `health()`, `scopes()`, `recall()`, `remember()`, `grep()`.
- `swarm-memory` CLI surface (confirmed via `--help` and live runs against the real Qdrant SSOT, not docs):
  - `check` — self-test: Qdrant reachability + collection count, embedder reachability, **impact graph node/edge count**. This is real, structured-enough liveliness data (`✓ Qdrant reachable — 16 collections`, `✓ default collection accessible (work_root_memory, 430 points)`, `✓ impact graph: 22 nodes, 30 edges`).
  - `scopes` (`--json` supported) — scope → collection map + escalation ladders. This is what "lanes" maps to.
  - `search`, `recall`, `grep` — query surfaces (recall = semantic + context; grep = keyword, no embedder).
  - `index <collection> <paths...> [--no-prune]` — chunk/embed/upsert. **This is the real reindex primitive.** Default behavior prunes stale tail chunks of shrunk files (i.e. a plain `index` run already behaves like a refresh); `--no-prune` is what `remember()` uses for pure-additive writes.
  - `graph {add,remove,impact,deps,edges,scan,stats}` — a real impact graph backed by `~/.local/share/swarm-memory/graph.sqlite` (22 nodes / 30 edges today, from markdown-link + python-import scans). `graph edges` / `graph stats` / `graph impact` / `graph deps` are genuine structured data — a real graph view is buildable from this, not aspirational.
  - `config` (`--json`) — effective config, secrets redacted.
  - **No `clear`/`wipe`/`delete-collection` verb exists anywhere in the CLI.** This is not an oversight — it matches SERVICE.md's hard guardrail: "the Qdrant collections (SSOT) are never wiped."
- `docs/PANTHEON-CONTRACTS.md` (pantheon-v2, confirmed current): Mnemosyne is already declared `type: "service"` with a real health endpoint and fixed port — the plugin-mode contract is already satisfiable by the existing service with no changes needed for that path.

## 3. Proposed approach

**Stay zero-dep.** SERVICE.md's guardrail ("Zero third-party deps — runs on the hive's Node with no install step") extends to the UI: server-rendered HTML + vanilla JS/CSS, no framework, no build step, no npm install. A force-directed graph render is achievable in vanilla JS+SVG/canvas at this data scale (tens of nodes today).

**Serve the UI from the same process.** Extend `src/server.mjs` to serve static UI assets under `GET /ui/*` (or mount at `/`) alongside the existing JSON API, rather than standing up a second process. One `PORT`, one process, matches the existing "just runs" philosophy.

**New engine/API surface needed** (additive to `engine.mjs`/`server.mjs`, same transport/engine split already in place):
- `GET /graph/stats`, `GET /graph/edges` → wraps `swarm-memory graph stats` / `graph edges` for the graph view.
- `GET /config` → wraps `swarm-memory config --json` (already fetched internally as `scopeMap()`; exposing it read-only is additive).
- `POST /index` → wraps `swarm-memory index <collection> <paths>`, the real reindex action. Requires an explicit collection + path selection from the UI — no "reindex everything" button with no target, to keep the action legible and auditable.
- `GET /search` → thin UI-facing wrapper composing `recall`/`grep` for the collections browser's search box.
- **No wipe/clear-collection endpoint, ever.** "Clear" in the UI is scoped to Mnemosyne's own local state only: the in-memory `scopeMap()` cache in `engine.mjs` (a "refresh config" action) and the local notes cache dir (`MNEMOSYNE_NOTES_DIR`) — never Qdrant data. This is a direct application of the existing guardrail, not a new decision requiring sign-off.

**"Lanes" = scopes.** The lanes view lists `swarm-memory scopes` output (scope → collection + ladder) as first-class rows. "Add a new lane" means adding a new scope → collection mapping. `swarm-memory` has no CLI verb for this today (scopes are config.toml entries) — the standalone UI writes a new entry to `~/.config/swarm-memory/config.toml` directly (atomic write: write to temp file, validate it round-trips through `swarm-memory config --json`, then rename over the original; keep a single last-known-good backup). This is a config-file mutation, not a Qdrant mutation, so it's inside Mnemosyne's existing blast radius.

**Harness/skill layer.** A Claude Code skill (new `hive/skills` style file or a plain `.claude/skills/mnemosyne` entry shipped by this repo, distinct from the existing `hooks/` which are UserPromptSubmit/Stop hooks for *consumers*) that: checks if the standalone server is running on the configured port, starts it if not (`bin/mnemosyne`), and exposes recall/remember/reindex/graph-query actions as skill invocations. This is what lets a bare Claude Code session (no Pantheon) drive Mnemosyne.

**Auth/exposure.** No new auth for v1 — the service already binds to `127.0.0.1` by convention (per SERVICE.md's "Local: http://127.0.0.1:8477") and this doesn't change. Mutating actions (remember, index, add-lane) are already possible today via the raw API with zero auth; the UI doesn't increase the actual attack surface, it just makes existing capabilities visible. Documented as an accepted risk, not deferred to the user — if Mnemosyne is ever exposed off-localhost (the Tailnet route SERVICE.md mentions), auth becomes a real gap, but that's a pre-existing condition this epic doesn't change.

## 4. Vertical slices (delivery order — each leaves a genuinely working state)

1. **Liveliness + settings shell** — `GET /ui` serves a static shell; renders `GET /health` and the new `GET /config` live. Working state: open a browser tab, see the service is alive and what it's configured to talk to.
2. **Lanes browser** — renders `GET /scopes` as a lanes table (scope, collection, ladder). Add-lane form writes `config.toml` per §3's atomic-write rule.
3. **Collections search** — query box wired to `GET /search` (recall + grep), results table with provenance (layer/collection/file/chunk/embedder/timestamp — already returned by the engine).
4. **Graph view** — `GET /graph/stats` + `GET /graph/edges` rendered as a node-link view (vanilla SVG/canvas).
5. **Reindex controls** — `POST /index` wired to an explicit collection+path picker, plus a "refresh config cache" action (the safe, local meaning of "clear/refresh").
6. **Skill/harness layer** — the Claude Code skill described in §3, usable standalone.

Plugin-mode tie-in (Pantheon L2 registration beyond what already exists) is explicitly **not** a slice here — deferred by the user's own sequencing.

## 5. Risks

- **Guardrail violation risk (clear/wipe):** highest-severity risk in this epic. Mitigated by design (§3) — no wipe endpoint exists in the CLI or will exist in the API; enforced again at story/review time.
- **`config.toml` mutation risk:** a malformed write could break every scope resolution. Mitigated by atomic write + round-trip validation via `swarm-memory config --json` + single-backup-on-write, per §3.
- **No structured per-collection point counts beyond the default collection:** `check` only reports the *default* collection's point count in free text; other collections aren't enumerated with counts by any CLI verb seen so far. The lanes/collections view may need a small `swarm-memory` capability addition (a different repo/god's surface) or must degrade gracefully to "collection configured, count unknown" for non-default scopes. Flagged for story-level research, not blocking epic kickoff.
- **Zero-dep UI complexity ceiling:** vanilla JS graph rendering is fine at 22 nodes; if the graph grows to thousands of nodes this approach may need revisiting. Not a v1 blocker.

## 6. Dependencies

- None blocking. This epic is independent of `mnemosyne-foundation`'s layer-stack build-out (m-01..m-07) — the standalone UI works over whatever's live today (single Qdrant scope + graph layer) and gets richer for free as that epic lands more layers. No sequencing dependency either direction.

## 7. Scale assessment

**Medium** — multi-file (new UI assets, new API routes, new skill file), multiple layers (transport/engine/UI/harness), but not a system migration and no cross-repo work required for this epic specifically (the swarm-memory CLI gap noted in Risks is investigated, not built, by this epic).

**SCALE DECISION: Medium — proceeding to story decomposition** (H/V planning skipped; the 6 vertical slices above already give clean delivery sequencing for a project this size).
