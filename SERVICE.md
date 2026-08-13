# Mnemosyne service (v0.1.0) — running memory god

> This is the **first running slice** of the memory god described in
> [`idea-brief.md`](./idea-brief.md). It is deliberately **minimal but real**: a
> thin HTTP service that wraps the already-working `swarm-memory` engine (remote
> Qdrant Cloud SSOT) and exposes the core memory ops as the god's API. It does
> **not** reinvent the store, and it does **not** yet implement the full layered
> stack (Obsidian meta layer, continuous indexing, Consus/Janus read model) —
> those remain for the Minerva-planned epic.

## What it is

`src/server.mjs` (Node built-in `http`, zero deps) → `src/engine.mjs`
(shells out to `swarm-memory --json`, exactly like the Hermes MemoryProvider).
Every memory op runs over the live Qdrant corpus; nothing is stubbed or mocked.

## API

| Method / path   | Body                                                        | Returns |
|-----------------|-------------------------------------------------------------|---------|
| `GET /`         | —                                                           | service info + endpoints (JSON) for any caller **except** one sending `Accept: text/html` (a browser), which gets a `302` to `GET /ui` instead — see below |
| `GET /ui`, `GET /ui/*` | —                                                      | standalone UI shell (static HTML/CSS/vanilla JS, zero-dep, no build step) — liveliness + read-only settings panels with a manual refresh button |
| `GET /health`   | —                                                           | engine self-test (`swarm-memory check`): Qdrant + embedder + graph |
| `GET /scopes`   | —                                                           | scopes → collections + escalation ladders |
| `GET /config`   | —                                                           | read-only effective config: `qdrant_url`, `embedder` (provider/model), `default_scope`, `fallback_collection`, `scopes`, `ladder` — thin wrapper over `engine.mjs`'s cached `scopeMap()` |
| `POST /recall`  | `{query, scope?, hits?, escalate?, min_score?, radius?}`    | ranked hits **with full provenance** (layer/collection, file, chunk span, embedder, retrieved_at) |
| `POST /remember`| `{text, scope?, tag?}`                                       | write-back: persists a note + indexes (upsert, `--no-prune`) it into the scope's collection so it is immediately recallable |

**`GET /` routing:** no existing consumer (`hooks/lib/mnemo-client.mjs`, `test/smoke.mjs`)
calls the bare `GET /` path, and Node's `fetch()` sends `Accept: */*` when the
caller doesn't set one — so the JSON info blob remains the default response for
every programmatic caller. Only a request whose `Accept` header contains
`text/html` (i.e. an actual browser navigation) gets redirected to `/ui`. This
is a non-breaking addition, verified against the two real current consumers,
not assumed.

`recall` returns the engine's native `--json` shape (`total_hits`, `scopes[].hits[]`
with `provenance`). `scope` defaults to the engine default (`top`) for recall and
to `personal` for remember.

## Run

```bash
cd ~/Documents/work/dostal/code/mnemosyne
PORT=8477 bin/mnemosyne            # foreground
# supervised (survives the session):
nohup env PORT=8477 node src/server.mjs > ~/.local/share/mnemosyne/mnemosyne.log 2>&1 &
```

Smoke test (health + scopes + recall + remember round-trip):

```bash
MNEMOSYNE_URL=http://127.0.0.1:8477 npm run smoke
```

## Port / route

- Local: `http://127.0.0.1:8477`
- Tailnet (if served): `https://hive.tail9a130d.ts.net:8448` → `127.0.0.1:8477`

## Guardrails honored

- Wraps the existing engine — **no new store, no re-embed**. `remember` is
  **additive** (`--no-prune`, upsert of a brand-new note file only); the Qdrant
  collections (SSOT) are never wiped.
- No secrets printed. No Don-stack / multica-daemon / auriga touched.
- Zero third-party deps — runs on the hive's Node with no install step.

## Deferred (honest scope — see idea-brief for the full design)

- Obsidian **meta layer** + enterprise/project layer routing (recall/remember
  currently ride the swarm-memory scope ladder, which already covers
  vector + code-graph + file layers).
- **Continuous indexing** (Multica-native scheduling).
- **Consus/Janus read model** (browse layers / trace provenance in the UI).
- Argus/Metis decision+metric logging per call.
