# Mnemosyne memory hooks (v1) — pre-recall + post-remember

The **minimal, proven** memory loop for the Pantheon agent loop, built directly
on the existing base:

- the **Mnemosyne service** (`src/server.mjs`, `:8477`) which wraps
- the **`swarm-memory` engine** over the **remote Qdrant Cloud SSOT**.

Nothing here reinvents the store. Two hooks bracket a ticket:

| Hook | When | What it does |
|------|------|--------------|
| **`pre-recall.mjs`** | before the agent works (Claude Code `UserPromptSubmit`) | recalls relevant memory and **injects it as context** — as *pointers with line ranges*, not whole files |
| **`post-remember.mjs`** | after the agent finishes (Claude Code `Stop` / `SubagentStop`) | **stores what it learned**, **status-aware** (`in-progress` / `reviewed` / `full-send`) |

Both are **non-blocking**: any memory miss or a down service exits 0 with no
effect — a memory problem never breaks a ticket. If the HTTP service is down the
client **falls back to the `swarm-memory` CLI directly** (same engine, same
corpus), so the hooks work with or without the service running.

`pre-recall` creates **one canonical memory bundle**. Claude Code receives it in
`hookSpecificOutput.additionalContext`; Codex, Kimi, or any other runner can
read the exact same text from `mnemosyne.canonical_bundle` and inject it as a
system/context block. Runner adapters do not reformat or rerank memory.

## Design (Mathew's spec, v1 slice)

- **Pointers, not files.** `pre-recall` feeds an *index* of relevant hits, each
  with its **layer** (collection), **file**, and **line range** (`chunk_span`),
  plus a short excerpt — because "Claude's memory is trash, it feeds WHOLE
  files." The agent opens the file or calls the memory tools for full detail and
  can **bubble up** to other layers.
- **Cache-safe prompt layout.** The injected bundle is always:
  `[stable cached prefix] + [small variable memory delta] + [ticket]`.
  The stable prefix is deterministic for the repo scope, shared scope, and role;
  it does not include the ticket, query, recalled hit count, timestamps, or any
  per-run ordering. The per-ticket recall output starts after:
  `<!-- mnemosyne-cache-breakpoint: variable-ticket-memory-below -->`.
- **Hybrid recall (semantic + keyword).** `pre-recall` runs both **semantic**
  recall (concepts) and **keyword** grep (exact identifiers — ticket IDs,
  tokens, error codes that embeddings do *not* encode). Keyword-exact hits are
  surfaced first. This is why per-ticket recall by an exact ID is deterministic,
  while a brand-new single note's *semantic* rank against a large corpus is not.
- **Role-scoped** (`hooks/lib/scope.mjs`): `orchestrator → top` (all-repo,
  escalates), `architect → repo scope` (escalates), `developer → repo slice`
  (no escalation). Scope can come from `scope`, `target_repo`, `repo`,
  `repository`, `cwd`, or env. `pre-recall` also queries a small shared/global
  scope (`MNEMOSYNE_SHARED_SCOPE`, default `top`) and lets the bundle budget
  decide what survives.
- **Small variable delta, high-level first.** Hits are sorted by **layer
  priority first** — `meta` → `enterprise` → `project` → `vector` → `file`
  (missing/unrecognized layer is treated as `file`, the lowest priority) — then
  keyword-exact first, then by score, deduped by source/chunk, capped by max
  hit count, and kept within `MNEMOSYNE_MEMORY_TOKEN_BUDGET` (default about 900
  tokens). A high-scoring low-level hit still ranks below a low-scoring
  high-level hit: a high-scoring file hit is less valuable than a low-scoring
  meta hit. Up to `MNEMOSYNE_HIGH_LEVEL_TOKEN_BUDGET` (default 300, about a
  third of the budget) is reserved for `meta`+`enterprise` hits so they're
  never crowded out by noisy low-level hits — and capped at that reservation so
  a busy meta layer can't consume the whole budget either. When there are no
  high-level hits, the full budget is available to lower layers (no wasted
  space). Lower-ranked hits are omitted instead of bloating the ticket prompt.
- **Status-aware write-back** (`post-remember.mjs`): every stored note is stamped
  `STATUS: in-progress|reviewed|full-send` + ticket + role, so recall can tell a
  work-in-progress note from full-send truth.

## Install the hooks

Run the installer instead of hand-editing `settings.json`:

```bash
bin/mnemosyne-install-hooks
```

It merges `hooks/settings.hooks.json` into `~/.claude/settings.json`, rewriting
every hook `command` to an absolute path for **this** checkout (no manual ROOT
editing), so `pre-recall` fires on `UserPromptSubmit` and `post-remember` fires
on `Stop`/`SubagentStop`. Before writing, it probes `GET /healthz` on the
Mnemosyne service (`MNEMOSYNE_URL`, default `http://127.0.0.1:8477`) and warns
if it's unreachable — pass `--yes` to install anyway, or start the service
first and re-run. Safe to re-run any time (e.g. after moving/re-cloning the
repo): it updates each hook's path in place instead of duplicating entries, and
backs up the previous `settings.json` to `settings.json.bak` first.

Flags: `--yes` / `-y` skip the reachability prompt; `--settings <path>` target
a `settings.json` other than the default; `--service-url <url>` probe a
different Mnemosyne base URL.

For plugin-hive step wiring or manual use, just pipe JSON in:

```bash
echo '{"query":"ATT retainer pricing","scope":"att","role":"developer"}' \
  | node hooks/pre-recall.mjs

echo '{"text":"Decided X because Y","scope":"att","status":"reviewed","ticket":"PAN-123"}' \
  | node hooks/post-remember.mjs
```

## Input shapes (both hooks are shape-tolerant)

`pre-recall` reads any of `prompt` (Claude Code), `query`, `task_description`,
`task`, `text` — plus optional `scope`, `target_repo`, `repo`, `repository`,
`role`, `cwd`, `hits`, `shared_scope`, `token_budget`, `runner`, and `ticket`.
It emits both the Claude hook payload and the runner-neutral Mnemosyne payload:
`hookSpecificOutput.additionalContext === mnemosyne.canonical_bundle`.

`post-remember` reads any of `text`, `summary`, `learned`, `note`, or a
`transcript_path` (Claude Code Stop — pulls the last assistant message) — plus
optional `scope`, `role`, `status`, `ticket`.

## Env knobs

| Var | Default | Meaning |
|-----|---------|---------|
| `MNEMOSYNE_URL` | `http://127.0.0.1:8477` | service base URL |
| `MNEMOSYNE_SCOPE` | — | force a scope (overrides role→repo mapping) |
| `MNEMOSYNE_ROLE` | — | role when not in stdin (`orchestrator`/`architect`/`developer`) |
| `MNEMOSYNE_STATUS` | `in-progress` | default write-back status |
| `MNEMOSYNE_HITS` | `5` | recall hit count |
| `MNEMOSYNE_SHARED_SCOPE` | `top` | small shared/global recall scope |
| `MNEMOSYNE_SHARED_HITS` | `2` | shared/global recall hit count |
| `MNEMOSYNE_MEMORY_TOKEN_BUDGET` | `900` | approximate token cap for the variable delta |
| `MNEMOSYNE_HIGH_LEVEL_TOKEN_BUDGET` | `300` | token cap reserved for `meta`+`enterprise` layer hits within the delta budget |
| `MNEMOSYNE_RUNNER` | `generic` | runner label for diagnostics; does not alter bundle text |
| `SWARM_MEMORY_BIN` | `swarm-memory` | CLI fallback binary |

## Prove it

```bash
node test/bundle.mjs
node test/hooks.mjs
```

`test/bundle.mjs` proves the cache-safe layout, runner-neutral canonical text,
target-repo scope resolution, keyword-first ordering, and budget capping without
network dependencies. `test/hooks.mjs` stores a unique token via `post-remember`,
then recalls it via `pre-recall` and asserts the token + line-range provenance
land in the injected context — over the **live Qdrant corpus**, in both service
and CLI-fallback modes.

## NOT in v1 (follow-on layers — do not assume these exist)

- code-graph layer feeding impact edges into recall
- per-ticket line-range **document indexing** (known-relevant docs pre-selected)
- richer role-scoping (per-repo meta bundles, architect graph views)
- transcript summarization (what changed / decisions) beyond last-message capture
- Consus/Janus read model + Argus/Metis per-call decision+metric logging
