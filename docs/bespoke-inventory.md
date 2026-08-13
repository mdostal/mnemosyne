# Bespoke Memory Layer Inventory

This is the REQ4 bespoke-layer audit for the `pantheon-memory-consistent-hooks` epic
(story `mc-08-bespoke-layer-inventory`). It was produced by a filesystem audit of this
developer's machine (`~/.multica`, `~/bin`, project directories, crontab, dotfiles,
LaunchAgents) on **2026-08-06**, so Mnemosyne's team has a permanent record of what
bespoke memory-related scripts and systems exist on this machine, and whether each
one should migrate into Mnemosyne, stay as-is ("keep"), or be archived. Per REQ4,
nothing found in the audit is silently dropped — every script or system gets an
entry below, including ones judged safe to keep exactly as they are today.

## Directories checked with no bespoke scripts found

- **`~/bin`** — does not exist on this machine. No scripts to inventory there.
- **`~/.multica`** — exists, but contains no memory-specific *scripts*. It holds
  daemon/ops logs, including `svc-mnemosyne.log` (confirms the Mnemosyne god
  service is up on `:8477`) and a 41-byte `qdrant.log`. Neither is a bespoke
  script that papers over a gap — they're just logs referencing the already-running
  Mnemosyne service, so there is nothing to migrate/keep/archive from this location.

## Scripts / systems inventory

| # | Path | Purpose | Status | Justification |
|---|------|---------|--------|----------------|
| 1 | `~/Documents/work/dostal/code/dostal-swarm/bin/memory` | Query interface shim (recall/search/grep/check/scopes/index/graph) that execs the external `swarm-memory` OSS CLI directly against a Qdrant cluster (config `~/.config/swarm-memory/config.toml`). Talks straight to Qdrant with no reference to Mnemosyne. | **migrate** | This is the core of the bespoke bypass layer — it goes around Mnemosyne's HTTP surface (`:8477`) entirely. Its recall/search/index/graph capabilities are exactly what Mnemosyne is meant to own; the logic should move into a Mnemosyne client/hook path rather than continuing to exist as a standalone shim. |
| 2 | `~/Documents/work/dostal/code/dostal-swarm/bin/index-memory` | One-line wrapper: `exec "$(dirname "$0")/memory" index "$@"` — indexes docs/paths into the swarm-memory/Qdrant collections. | **migrate** | Trivial pass-through to `bin/memory` (#1); migrates together with it as part of the same bespoke pipeline. |
| 3 | `~/Documents/work/dostal/code/dostal-swarm/bin/recall-on-entry` | Startup hook meant to run "at the start of every agent task." Pulls issue context, calls `bin/memory recall` directly, writes `.agent_context/memory_context.md`. Hardcoded default path to `dostal-swarm/bin/memory`; fails loudly if swarm-memory/Qdrant is unreachable. | **migrate** | **Highest-priority finding.** Per `docs/workspace-memory-contract.md`, this script's invocation is reportedly part of the `instructions` field on every workspace agent (dev, review, QA, business, and Gemini agents — all except Multica Helper). If still true, every Multica agent may be mandated to call this bespoke script directly instead of going through Mnemosyne. This needs to migrate to a Mnemosyne-native recall-on-entry hook so agent instructions stop bypassing the memory god. |
| 4 | `~/Documents/work/dostal/code/dostal-swarm/bin/health-check` | Full-stack daily/startup health check (colima, Multica backend/frontend, Pantheon, Delphi, daemon, hive runtimes, Fable model check, Qdrant, Memory Inspector `:7807`, Don FFE isolation). | **keep** | It is a general infra health script that covers far more than memory (colima, Multica, Delphi, hive runtimes, etc.), so archiving or migrating the whole script isn't warranted. **Flag:** its Qdrant-direct check (`curl http://localhost:6333/healthz`) and Memory Inspector (`:7807`) check duplicate what Mnemosyne's own `/health` endpoint should be reporting — follow-on work should have this script defer to Mnemosyne's `:8477/health` for the memory portion instead of probing Qdrant directly. |
| 5 | `~/Documents/work/dostal/code/ds-dos557-land/bin/memory` | Byte-for-byte near-identical duplicate of #1, in a stale/older worktree of the same `dostal-swarm.git` repo. | **archive** | Stale duplicate worktree (last touched Jul 10-20 vs. the live worktree's Aug 2), superseded by the live `dostal-swarm` checkout. No unique content. |
| 6 | `~/Documents/work/dostal/code/ds-dos557-land/bin/index-memory` | Identical duplicate of #2 in the stale worktree. | **archive** | Same reasoning as #5 — stale duplicate, superseded by the live checkout. |
| 7 | `~/Documents/work/dostal/code/ds-dos557-land/bin/recall-on-entry` | Same as #3, but its internal default `MEMORY_BIN` still points at the live `dostal-swarm/bin/memory` path (line 15), meaning even this stale worktree's copy calls out to the live checkout. | **archive** | Stale duplicate worktree; the migration work belongs on #3 (the live copy), not this one. |
| 8 | `~/Documents/work/dostal/code/ds-dos557-land/bin/health-check` | Identical duplicate of #4 in the stale worktree. | **archive** | Stale duplicate; superseded by #4 in the live checkout. |
| 9 | `~/Documents/work/dostal/code/ds-dos557-land/docs/memory-architecture.md` | Design doc for the pre-Mnemosyne "5-layer vector memory" architecture (Qdrant, `kg.sqlite` temporal knowledge graph, system/team memories, working notes, code/docs impact graph). Frames "our Qdrant setup" as the substrate to keep and build on; predates/parallels Mnemosyne, no mention of it. | **archive** | Historical design doc describing a pre-Mnemosyne plan. Kept for historical/context value only (not deleting outright), but it should not be treated as a live source of truth — Mnemosyne's own docs (SERVICE.md, README.md, VISION.md) now own that role. |
| 10 | `~/Documents/work/dostal/code/ds-dos557-land/docs/workspace-memory-contract.md` | Authoritative contract doc for the bespoke wiring: `bin/memory` + `bin/recall-on-entry`, the mandate that every agent's `instructions` field calls `recall-on-entry` before task work, retrieval semantics (Ollama `nomic-embed-text`, relevance floor 0.53, surrounding-context expansion, keyword fallback), and the code/docs impact graph. No Mnemosyne integration mentioned. | **migrate** (docs follow the code) | This is the spec for the exact behavior that #3 needs to migrate into Mnemosyne. Rather than archiving outright, its retrieval-semantics content (relevance floor, context expansion, keyword fallback) should be carried into Mnemosyne's own documentation as the migration lands, then the doc itself can be archived. Until that migration is confirmed done, do not delete it — it is currently the only place this behavior is specified. |
| 11 | `~/.hermes/plugins/swarm_memory/__init__.py` | Hermes's MemoryProvider adapter — exposes swarm-memory (Qdrant) as tools to Hermes-driven agents, pushes memory via a `prefetch()` hook each turn. As of a 2026-07-30 change, tries Mnemosyne's HTTP API (`http://127.0.0.1:8477/recall`) **first**, falling back to the direct `swarm-memory` CLI only on failure. | **keep** | This is the desired pattern, not a bespoke bypass to migrate away from: it already routes through Mnemosyne first and only falls back to the bespoke CLI for resilience. Keeping it as the reference implementation for "Mnemosyne-first, CLI-fallback" routing is correct; other bespoke shims (#1-#3) should be brought in line with this pattern rather than this file being changed. |
| 12 | `~/.hermes/plugins/swarm_memory/__init__.py.bak_before_mnemosyne_20260730_113502` | Pre-migration backup of the Hermes provider — the pure bespoke, swarm-memory-only version, before Mnemosyne routing was added. | **archive** | Superseded pre-migration snapshot. Safe to archive/remove once confidence in the 2026-07-30 migration (#11) is established; keeping it indefinitely as a live file risks confusion about which version is authoritative. |
| 13 | `~/.hermes/plugins/swarm_memory/__init__.py.bak-pan6642-20260729_193117` | Earlier backup checkpoint of the same provider file (one day prior), tied to ticket "pan6642". | **archive** | Same reasoning as #12 — an older bespoke snapshot, superseded by the live #11. |
| 14 | `~/Documents/work/dostal/code/dostal-pantheon/plugins/mnemosyne/` (`bin/mnemosyne`, `src/`, `hooks/pre-recall.mjs`, `SERVICE.md`, `README.md`, `VISION.md`, `idea-brief.md`) | The proper Mnemosyne god plugin itself (Node service; `bin/mnemosyne` execs `src/server.mjs`, listens on `:8477`, exposes `/health` and `/recall`). Currently running and confirmed live. | **keep** (not bespoke) | This is the target system, not a bespoke layer — listed here only for completeness/context. It currently still wraps the same swarm-memory engine/Qdrant cluster internally rather than replacing it, which is expected at this stage of the migration; note for future scope that the engine-replacement work is separate from the client/hook migration in #1-#3. |
| 15 | `~/.config/swarm-memory/` (`config.toml`, `qdrant.key`) | Credentials/config directory for the bespoke swarm-memory engine, referenced by `bin/memory`, `bin/recall-on-entry`, and by Mnemosyne's own engine wrapper internally. | **keep** | Shared credential store used by both the bespoke layer and Mnemosyne's current internal engine — it cannot be archived without breaking Mnemosyne itself. Do not silently drop: any future work to swap Mnemosyne's underlying engine must account for this config's consumers first. |
| 16 | `~/.local/share/swarm-memory/graph.sqlite` | SQLite "code/docs impact graph" (typed edges `depends_on`/`cites`/`implements` over files/docs/components/metrics), built by `swarm-memory graph scan/add`, exposed to Hermes as the `memory_impact` tool. Confirmed live via Mnemosyne's health payload (131 nodes, 80 edges). | **keep** | A bespoke graph store that runs parallel to Mnemosyne and is not mentioned as migrated anywhere in the audit. It is live and in active use (exposed as a Hermes tool), so archiving now would break functionality. Flagging as a candidate for a future migration/unification story rather than migrating in this pass — not silently dropped, just out of scope here. |
| 17 | `~/Documents/work/dostal/code/swarm-memory/` (separate git repo) | Source checkout of the standalone swarm-memory OSS plugin/engine itself (the engine all the shims call into) — contains `inspector/` (web UI, port 7807 per `health-check`), `build/`, `examples/`, `.venv`. | **keep** | This is the underlying engine repo that Mnemosyne currently wraps rather than replaces (see #14). Migrating away from it is real follow-on work, not something to do silently as part of this inventory pass — noted here so it isn't lost. |
| 18 | `~/.claude/hive/kg.sqlite` (+ `.sqlite-shm`/`-wal`), `~/.claude/hive/memories/` (30 subdirectories) | A separate, independent bespoke memory system — "Don's Hive" (plugin-hive) temporal knowledge graph (subject-predicate-object triples with `valid_from`/`valid_until`) plus per-agent markdown memory directories (`~/.claude/hive/memories/{agent}/*.md`). | **keep** | This is a distinct system serving a different purpose than Mnemosyne's project/doc-corpus memory — it captures per-agent expertise/history rather than project/documentation recall. `docs/memory-architecture.md` (#9) explicitly notes intent to "unify Hive-memory + Dostal-Qdrant" but no evidence was found that this has happened. Recommend a dedicated future story to evaluate unification with Mnemosyne rather than folding it into this migration; not silently dropping it from the record. |

## Cron jobs

No memory-related cron jobs were found. `crontab -l` on this machine contains exactly
one entry, which is unrelated to memory:

```
@reboot cd /Users/dostal/Documents/work/dostal/code/Claud-ometer && PORT=3002 HOST=0.0.0.0 scripts/service-start.sh >> .../claudometer-3002.log 2>&1
```

No LaunchAgents plist (14 total checked in `~/Library/LaunchAgents`) matched
`memo|qdrant|swarm` by name either. The "continuous indexing pipeline" (referenced
in docs as DOS-49) and the "Memory Inspector" (`:7807`) therefore appear to be
started manually or by a supervisor not discovered in this scan — see gaps below.

## Gaps / unanswered questions

Carried forward from the audit so nothing here is silently dropped:

- Whether the live `dostal-swarm` checkout's own `docs/` directory has its own
  copies of `memory-architecture.md` and `workspace-memory-contract.md` (only the
  stale `ds-dos557-land` worktree's copies were checked) — likely yes since it's
  the same repo, but not directly verified.
- Whether the actual Multica agent `instructions` fields (server-side) still
  literally mandate calling `bin/recall-on-entry` directly, or have already been
  updated post-Mnemosyne — requires checking via the `multica agent` CLI; out of
  scope for a filesystem audit.
- Whether/how the "continuous indexing pipeline" (DOS-49) and "Memory Inspector"
  (`:7807`) are currently supervised — no cron entry and no matching launchd plist
  was found for either; they may be started manually or via an unlisted script.
- Whether `~/.claude/hive`'s `kg.sqlite`/`memories` system (#18) is considered
  in-scope for the Mnemosyne migration at all, or is a permanently-separate
  system — the design doc suggests intent to unify it with "Dostal-Qdrant," but
  no evidence of that work having started was found.
- The exact relationship between "our Qdrant" (cloud-hosted, per Mnemosyne's live
  health check: `aws.cloud.qdrant.io`) referenced in the bespoke docs, versus any
  local/self-hosted Qdrant on `localhost:6333` (the `health-check` script checks
  `localhost:6333`, but Mnemosyne's live health payload shows a remote AWS Qdrant
  Cloud endpoint) — not resolved by this audit.
