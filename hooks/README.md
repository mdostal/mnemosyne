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

## Design (Mathew's spec, v1 slice)

- **Pointers, not files.** `pre-recall` feeds an *index* of relevant hits, each
  with its **layer** (collection), **file**, and **line range** (`chunk_span`),
  plus a short excerpt — because "Claude's memory is trash, it feeds WHOLE
  files." The agent opens the file or calls the memory tools for full detail and
  can **bubble up** to other layers.
- **Role-scoped** (`hooks/lib/scope.mjs`): `orchestrator → top` (all-repo,
  escalates), `architect → repo scope` (escalates), `developer → repo slice`
  (no escalation). This is the **seam** the later layers grow into.
- **Status-aware write-back** (`post-remember.mjs`): every stored note is stamped
  `STATUS: in-progress|reviewed|full-send` + ticket + role, so recall can tell a
  work-in-progress note from full-send truth.

## Wire it into the agent loop

Merge `hooks/settings.hooks.json` into a Claude Code `settings.json` (adjust the
absolute ROOT path). That fires `pre-recall` on every prompt submit and
`post-remember` on stop/subagent-stop.

For plugin-hive step wiring or manual use, just pipe JSON in:

```bash
echo '{"query":"ATT retainer pricing","scope":"att","role":"developer"}' \
  | node hooks/pre-recall.mjs

echo '{"text":"Decided X because Y","scope":"att","status":"reviewed","ticket":"PAN-123"}' \
  | node hooks/post-remember.mjs
```

## Input shapes (both hooks are shape-tolerant)

`pre-recall` reads any of `prompt` (Claude Code), `query`, `task_description`,
`task`, `text` — plus optional `scope`, `role`, `cwd`, `hits`, `ticket`.
It emits `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"…"}}`.

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
| `SWARM_MEMORY_BIN` | `swarm-memory` | CLI fallback binary |

## Prove it

```bash
node test/hooks.mjs
```

Stores a unique token via `post-remember`, then recalls it via `pre-recall` and
asserts the token + line-range provenance land in the injected context — over
the **live Qdrant corpus**, in both service and CLI-fallback modes.

## NOT in v1 (follow-on layers — do not assume these exist)

- code-graph layer feeding impact edges into recall
- per-ticket line-range **document indexing** (known-relevant docs pre-selected)
- richer role-scoping (per-repo meta bundles, architect graph views)
- transcript summarization (what changed / decisions) beyond last-message capture
- Consus/Janus read model + Argus/Metis per-call decision+metric logging
