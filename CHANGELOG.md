# Changelog

All notable changes to Mnemosyne are documented here.

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
