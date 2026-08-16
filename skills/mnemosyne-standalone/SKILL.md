---
name: mnemosyne-standalone
description: Drive a standalone Mnemosyne memory-god instance directly from a bare Claude Code session — no Pantheon host required. Starts the service if it isn't already running (health-checked first, never a second instance), then exposes recall, remember, grep, reindex, graph-query, Layer 1 persona sync/seed/show/create, and persona draft propose/show/approve/discard as thin pass-throughs over Mnemosyne's own HTTP API (or, for persona-*, the already-tested persona CLI). Use when an operator wants to recall/remember/search/reindex/inspect-the-graph/manage-personas/review-persona-drafts via this repo's standalone Mnemosyne without wiring in Pantheon's L2 plugin lifecycle.
---

# Mnemosyne Standalone

Lets a bare Claude Code session drive this repo's standalone Mnemosyne
instance (`src/server.mjs`, `PORT` default `8477`) directly — no Pantheon
host, no L2 plugin lifecycle. This is the "harness plugin interaction"
piece of the `mnemosyne-standalone-app` epic: it's what makes the
standalone instance usable on its own.

This is **not** the same thing as `hooks/` (`pre-recall.mjs` /
`post-remember.mjs`) — those are `UserPromptSubmit`/`Stop` hooks meant to be
wired into *other* (consumer) repos' agent loops. This skill is invoked
directly, inside *this* repo, by an operator who wants to talk to Mnemosyne
by hand.

**Input:** `$ARGUMENTS` names an action (`recall`, `remember`, `grep`,
`reindex`, `graph-stats`, `graph-edges`, `graph-impact`, `graph-deps`,
`persona-sync`, `persona-seed`, `persona-show`, `persona-create`,
`persona-draft-propose`, `persona-draft-show`, `persona-draft-approve`,
`persona-draft-discard`, or bare `ensure` to just start/confirm the service)
plus whatever arguments that action needs (see the table below).

## Process

1. **Resolve the action and its arguments** from `$ARGUMENTS`. Every action
   below maps 1:1 onto an existing `src/server.mjs` route — there is no
   action this skill supports that Mnemosyne's HTTP API doesn't already
   expose.

2. **Run `bin/mnemosyne-skill-helper.mjs`** (from this repo's root) with the
   resolved action:

   ```bash
   node bin/mnemosyne-skill-helper.mjs <action> [args...]
   ```

   Every invocation — including a bare `ensure` — first does the
   health-check-then-start dance itself (step 3), so there is nothing extra
   to run first.

3. **Health-check-then-start (handled by the helper, not restated here):**
   `GET /health` on the configured `PORT` (default `8477`) with a short
   timeout.
   - **Already healthy** → does **not** spawn anything. No second instance,
     no second port-bind attempt.
   - **Not healthy / not running** → spawns `bin/mnemosyne` detached
     (matching `SERVICE.md`'s documented supervised-run pattern: `nohup env
     PORT=... node src/server.mjs > <logfile> 2>&1 &`), then polls
     `GET /health` until it goes green. If it never comes up within the
     timeout, the helper exits non-zero with a clear error naming the
     logfile — this failure is never swallowed.

4. **Report the `/ui` URL.** On every successful run (whether the service
   was already up or the helper just started it), the helper prints
   `http://127.0.0.1:<PORT>/ui` to stderr so the operator knows where to
   open the browser UI (Liveliness, Settings, Lanes, Search, Graph,
   Operations panels — see `SERVICE.md`).

5. **Print the action's result.** The helper prints the action's JSON result
   (Mnemosyne's own API response, byte-for-byte — see "Actions" below) to
   stdout. Relay it to the operator; do not reformat, summarize away fields,
   or silently drop provenance.

## Actions

Every `recall`/`remember`/`grep`/`reindex`/`graph-*` action is a **thin
pass-through** to the corresponding `src/server.mjs` route — same request
shape, same response shape, no new business logic invented in the skill
layer. The eight `persona-*`/`persona-draft-*` actions are a deliberate
exception: Layer 1 persona sync/seed/show/create/draft-* has no HTTP route
at all (it operates directly against the filesystem via TS imports), so they
instead shell out to the already-tested `bin/mnemosyne-persona.mjs` CLI as a
subprocess — same "wrap an existing, separately-tested module, invent
nothing new here" principle, just via a subprocess boundary instead of
`fetch()`.

| Action | Helper invocation | Underlying surface |
|---|---|---|
| `recall` | `node bin/mnemosyne-skill-helper.mjs recall '{"query":"...","scope":"...","hits":5}'` | `POST /recall` |
| `remember` | `node bin/mnemosyne-skill-helper.mjs remember '{"text":"...","scope":"...","tag":"..."}'` | `POST /remember` |
| `grep` | `node bin/mnemosyne-skill-helper.mjs grep '{"query":"...","scope":"..."}'` | `POST /grep` |
| `reindex` | `node bin/mnemosyne-skill-helper.mjs reindex '{"collection":"...","paths":["..."]}'` | `POST /index` |
| `graph-stats` | `node bin/mnemosyne-skill-helper.mjs graph-stats` | `GET /graph/stats` |
| `graph-edges` | `node bin/mnemosyne-skill-helper.mjs graph-edges '{"node":"..."}'` | `GET /graph/edges` |
| `graph-impact` | `node bin/mnemosyne-skill-helper.mjs graph-impact <node> '{"depth":2}'` | `GET /graph/impact/:node` |
| `graph-deps` | `node bin/mnemosyne-skill-helper.mjs graph-deps <node> '{"depth":2}'` | `GET /graph/deps/:node` |
| `persona-sync` | `node bin/mnemosyne-skill-helper.mjs persona-sync '{"repo":"...","tier":"...","scopeId":"...","dryRun":false}'` | `bin/mnemosyne-persona.mjs sync` (subprocess) |
| `persona-seed` | `node bin/mnemosyne-skill-helper.mjs persona-seed '{"root":"...","scopeId":"..."}'` | `bin/mnemosyne-persona.mjs seed` (subprocess) |
| `persona-show` | `node bin/mnemosyne-skill-helper.mjs persona-show <tier> <scopeId>` | `bin/mnemosyne-persona.mjs show` (subprocess) |
| `persona-create` | `node bin/mnemosyne-skill-helper.mjs persona-create '{"file":"...","repo":"...","root":"..."}'` | `bin/mnemosyne-persona.mjs create` (subprocess) |
| `persona-draft-propose` | `node bin/mnemosyne-skill-helper.mjs persona-draft-propose '{"file":"...","repo":"..."}'` | `bin/mnemosyne-persona.mjs draft propose` (subprocess) |
| `persona-draft-show` | `node bin/mnemosyne-skill-helper.mjs persona-draft-show <tier> <scopeId> '{"repo":"..."}'` | `bin/mnemosyne-persona.mjs draft show` (subprocess) |
| `persona-draft-approve` | `node bin/mnemosyne-skill-helper.mjs persona-draft-approve <tier> <scopeId> '{"repo":"..."}'` | `bin/mnemosyne-persona.mjs draft approve` (subprocess) |
| `persona-draft-discard` | `node bin/mnemosyne-skill-helper.mjs persona-draft-discard <tier> <scopeId> '{"repo":"..."}'` | `bin/mnemosyne-persona.mjs draft discard` (subprocess) |
| `ensure` | `node bin/mnemosyne-skill-helper.mjs ensure` | (no route — just the start-check itself) |

`reindex`'s `collection` and at least one `paths[]` entry are required
(matches `POST /index`'s own `400` validation — this skill invents no
"reindex everything" mode). `reindex` requires an explicit operator-named
collection, exactly like the `/ui` Operations panel does.

`persona-sync`'s `--repo` is always the harness-file write target for every
tier; for the 3 global tiers (`top-orchestrator`/`company-director`/
`project-orchestrator`) content comes from the global persona store
(`~/.mnemosyne/personas`), never from `repo` — see
`bin/mnemosyne-persona.mjs`'s own doc comment for the full write-target-
vs-content-source distinction. `persona-show` only reads the 3 global tiers
(`code-architect` personas live in a repo-local store this action does not
read).

`persona-create`'s `file` is required — a path to a YAML document with the
full persona candidate (`{tier, scopeId, displayName, scope, sections,
parentRefs?}`), passed through unchanged to the underlying store write, so a
smuggled `mandateSections` key is rejected by the store's own guard, not
silently stripped here. `repo`, when given, routes the write to the
repo-local store (required for a `code-architect` candidate); without it,
the write routes to the global store, and `root` (only meaningful without
`repo`) overrides that global store's root — mirrors `persona-seed`'s own
`root`, primarily for test isolation.

`persona-draft-propose`'s `file` is required — same YAML candidate shape as
`persona-create`'s, but written into the structurally separate draft store
(`~/.mnemosyne/persona-drafts`) instead of the real persona store, never
reachable by `persona-sync`/`persona-show` until a human runs
`persona-draft-approve`. `persona-draft-show`/`persona-draft-approve`/
`persona-draft-discard` take positional `<tier> <scopeId>`, matching
`persona-show`'s own shape; `repo`, when given, routes to a repo-local draft
(required for `code-architect`) — omit for the 3 global tiers.
`persona-draft-approve` commits the draft via the same write primitive
`persona-create` uses and archives (never deletes) the draft, firing a real
`remember()` call only when the draft carries a `sourceSummary`.
`persona-draft-discard` archives the draft to the `discarded/` subtree
without committing it — also never a bare delete.

## What this skill is NOT

- **Not a second engine.** It never imports `src/engine.mjs` and never
  shells out to the `swarm-memory` CLI directly. Every `recall`/`remember`/
  `grep`/`reindex`/`graph-*` action goes *through* Mnemosyne's own HTTP API
  (`src/server.mjs`) — this preserves the existing transport/engine split
  and every guardrail already enforced in `engine.mjs` (loud failure, full
  provenance on every hit, no collection wipe/delete verb anywhere). A
  skill that bypassed the API would silently reopen every risk `s-02`/`s-05`
  already closed off. `persona-*` actions are the one deliberate exception
  (see "Actions" above) — there is no HTTP route to go through, so they
  shell out to the separately-tested persona CLI instead; no swarm-memory
  or engine.mjs logic is duplicated there either.
- **Not a supervisor/daemon manager.** It starts the service once if
  needed and gets out of the way; it does not restart it on crash, does not
  manage multiple instances, and does not stop the service when the skill
  invocation ends (the spawned process is detached on purpose — it should
  outlive this one skill call, same as `SERVICE.md`'s own supervised-run
  instructions).
- **Not a UI.** It prints the `/ui` URL so a human can open the real
  browser UI; it does not reimplement any of the Lanes/Search/Graph/
  Operations panels itself.
- **Not a config mutator.** `POST /lanes` (add-a-scope) and
  `POST /cache/refresh` are intentionally not exposed as skill actions here.
  Operators who need those two reach them via the `/ui` Operations/Lanes
  panels directly.

## See also

- [`../../SERVICE.md`](../../SERVICE.md) — the full API surface, the
  supervised-run invocation this skill's start logic matches, and every
  guardrail (no-wipe, provenance) this skill preserves by going through the
  HTTP API instead of around it.
- [`../../bin/mnemosyne-skill-helper.mjs`](../../bin/mnemosyne-skill-helper.mjs)
  — the helper this skill invokes (health-check/start/poll logic + the
  action pass-throughs).
- [`../../hooks/README.md`](../../hooks/README.md) — the `UserPromptSubmit`/
  `Stop` hook pair for *consumer* repos (a different mechanism, a different
  audience — contrast, don't confuse, with this skill).
- [`../../test/skill-harness.mjs`](../../test/skill-harness.mjs) — TDD
  coverage: not-running-then-start, already-running-skip-start (no second
  process), and pass-through correctness for every action above except the
  four `persona-draft-*` actions.
- [`../../test/skill-harness-persona-draft.mjs`](../../test/skill-harness-persona-draft.mjs)
  — TDD coverage for the four `persona-draft-*` actions.
