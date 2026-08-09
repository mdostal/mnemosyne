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
| `GET /`         | —                                                           | service info + endpoints |
| `GET /health`   | —                                                           | engine self-test (`swarm-memory check`): Qdrant + embedder + graph |
| `GET /healthz`  | —                                                           | liveness alias — always 200 if the process is up, so external checkers (Salus/Argus) don't 404 |
| `GET /scopes`   | —                                                           | scopes → collections + escalation ladders |
| `POST /recall`  | `{query, scope?, hits?, escalate?, min_score?, radius?}`    | ranked hits **with full provenance** (layer/collection, file, chunk span, embedder, retrieved_at) |
| `POST /remember`| `{text, scope?, tag?}`                                       | write-back: persists a note + indexes (upsert, `--no-prune`) it into the scope's collection so it is immediately recallable |
| `POST /reindex` | `{scope, directory?}`                                        | bulk (re)index: scans `directory` (default: service's cwd) for `.ts`/`.md`/`.yaml` files and indexes each into `scope`'s collection. Returns `202 {status: "started", scope, directory}` **immediately** — the run itself continues in the background and its outcome (`files_indexed`/`files_scanned`/`errors`) is logged, not returned synchronously |

`recall` returns the engine's native `--json` shape (`total_hits`, `scopes[].hits[]`
with `provenance`). `scope` defaults to the engine default (`top`) for recall and
to `personal` for remember.

### Bulk reindex

For initial index builds or recovering a stale index — e.g. after adding a new
scope's directory, or after the Qdrant collection has drifted from disk.
Indexing is append-only and idempotent (`swarm-memory index` upserts/dedupes
by content), so a reindex is always safe to run more than once or retry after
a partial failure — a bad file is skipped and reported in `errors`, it does
not abort the run.

```bash
# via the CLI (POSTs to a running service and prints the {status,...} body):
MNEMOSYNE_URL=http://127.0.0.1:8477 bin/mnemosyne reindex project --dir /path/to/project

# via the HTTP API directly:
curl -sX POST localhost:8477/reindex -d '{"scope":"project","directory":"/path/to/project"}'
```

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

E2E round-trip probe (headless — health counts, healthz, tagged scratch write,
recall-as-top-hit with provenance; cleans up its own scratch note file):

```bash
MNEMOSYNE_URL=http://127.0.0.1:8477 npm run test:e2e
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
