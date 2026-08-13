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
| `GET /ui`, `GET /ui/*` | —                                                      | standalone UI shell (static HTML/CSS/vanilla JS, zero-dep, no build step) — liveliness, read-only settings, lanes (scopes), and search panels with a manual refresh button |
| `GET /health`   | —                                                           | engine self-test (`swarm-memory check`): Qdrant + embedder + graph |
| `GET /healthz`  | —                                                           | liveness alias — always 200 if the process is up, so external checkers (Salus/Argus) don't 404 |
| `GET /scopes`   | —                                                           | scopes → collections + escalation ladders |
| `GET /config`   | —                                                           | read-only effective config: `qdrant_url`, `embedder` (provider/model), `default_scope`, `fallback_collection`, `scopes`, `ladder` — thin wrapper over `engine.mjs`'s cached `scopeMap()` |
| `POST /recall`  | `{query, scope?, hits?, escalate?, min_score?, radius?}`    | ranked hits **with full provenance** (layer/collection, file, chunk span, embedder, retrieved_at) |
| `POST /remember`| `{text, scope?, tag?}`                                       | write-back: persists a note + indexes (upsert, `--no-prune`) it into the scope's collection so it is immediately recallable |
| `POST /lanes`   | `{name, collection, ladder?}`                                | **add-only** atomic write of a new `[scopes]`/`[ladder]` entry to `~/.config/swarm-memory/config.toml` — see "Lanes / add-lane" below |
| `GET /search`   | query params: `q`, `scope?`, `mode?` (`recall`\|`grep`, default `recall`), `hits?`, `escalate?`, `min_score?`, `radius?` | thin dispatcher for the `/ui` Search panel — routes straight to `recall()`/`grep()` (no new query logic); invalid `mode` → `400` |
| `GET /graph/stats` | —                                                        | graph size + origin breakdown (`swarm-memory graph stats`): `{nodes, edges, edges_by_origin, db}` |
| `GET /graph/edges` | query params: `node?`                                    | list edges, or only those touching `node` when given (`swarm-memory graph edges [node]`) |
| `GET /graph/impact/:node` | query params: `depth?`                             | reverse closure: what is affected if `:node` changes (`swarm-memory graph impact NODE`) — unknown node returns `[]`, not an error |
| `GET /graph/deps/:node` | query params: `depth?`                               | forward closure: what `:node` depends on (`swarm-memory graph deps NODE`) — unknown node returns `[]`, not an error |
| `POST /index`   | `{collection, paths: [...]}`                                 | **Targeted** reindex, operator-selected: `swarm-memory index <collection> <paths...>` (default pruning, live Qdrant write, synchronous) — see "Operations" below. Distinct from `POST /reindex` below — see "Two reindex paths" |
| `POST /cache/refresh` | —                                                       | Refresh config cache: clears only `engine.mjs`'s in-memory `_scopeMap` — see "Operations" below |
| `POST /reindex` | `{scope, directory?}`                                        | **Bulk** (re)index, scope-wide: scans `directory` (default: service's cwd) for `.ts`/`.md`/`.yaml` files and indexes each into `scope`'s collection. Returns `202 {status: "started", scope, directory}` **immediately** — the run itself continues in the background and its outcome (`files_indexed`/`files_scanned`/`errors`) is logged, not returned synchronously. Distinct from `POST /index` above — see "Two reindex paths" |

**`GET /` routing:** no existing consumer (`hooks/lib/mnemo-client.mjs`, `test/smoke.mjs`,
`lib/mnemosyne/client.ts`) calls the bare `GET /` path, and Node's `fetch()`
sends `Accept: */*` when the caller doesn't set one — so the JSON info blob
remains the default response for every programmatic caller. Only a request
whose `Accept` header contains `text/html` (i.e. an actual browser
navigation) gets redirected to `/ui`. This is a non-breaking addition,
verified against real current consumers, not assumed.

**Two reindex paths, deliberately kept distinct:** `POST /index` is the
`/ui` Operations panel's targeted action — operator picks one collection and
specific path(s), runs synchronously, returns the CLI's real chunk-count
output. `POST /reindex` is the bulk/scope-wide action — used for initial
index builds or recovering a stale index across a whole directory, runs
async (returns `202` immediately, logs its own outcome). Both wrap
`swarm-memory index` with default pruning; neither wipes a collection. Do
not collapse these into one endpoint — they serve different operator intents
(surgical vs bulk) and different callers (`/ui` vs `bin/mnemosyne reindex`).

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

## Lanes / add-lane (config.toml write)

The `/ui` Lanes panel renders `GET /scopes` (scope → collection map + escalation
ladder) as a table. The **only** supported mutation is *adding* a new scope —
never removing or overwriting an existing one, and never touching Qdrant.

`POST /lanes {name, collection, ladder?}` appends a new `[scopes]` entry (and,
if `ladder` is given, a matching `[ladder]` entry) to
`~/.config/swarm-memory/config.toml` (override via `SWARM_MEMORY_CONFIG`, the
same env var swarm-memory's own CLI honors) as an **atomic write**:

1. Read the current `config.toml`.
2. Back it up to `config.toml.bak` (single generation — overwrites any prior
   backup).
3. Textually insert the new entry/entries (surgical line insertion; existing
   lines are never touched or reordered).
4. Write the result to a temp file in the same directory.
5. Validate by pointing the real CLI at the temp file
   (`swarm-memory --config <tmp> config`, which loads+dumps JSON with no
   Qdrant/network I/O) and confirming the new scope (and ladder) round-trips
   exactly.
6. Only on success: rename the temp file over the original (atomic). On
   **any** validation failure, the temp file is discarded and the original is
   left byte-identical to its pre-write state; the error is surfaced to the
   caller.

A duplicate `name` (already present in `[scopes]`) is rejected before any
file is touched. See `src/engine.mjs`'s `addLane()` and
`test/add-lane.mjs` / `test/lanes-route.mjs` for the atomic-write logic and
its test coverage (both run entirely against throwaway fixtures — never the
real config file).

## Search (GET /search)

The `/ui` Search panel is a query box + scope selector + mode toggle
(semantic **recall** vs keyword **grep**) over `GET /search`, a thin
dispatcher that reuses `engine.mjs`'s existing `recall()`/`grep()` verbatim —
no new query-building or CLI-invocation logic was added for this endpoint.

`GET /search?q=<query>&scope=<scope>&mode=recall|grep&hits=&escalate=&min_score=&radius=`

- `q` is required (`400` if missing/blank — delegated straight to
  `recall()`/`grep()`'s own validation).
- `mode` defaults to `recall` when omitted; an explicit value other than
  `recall`/`grep` is rejected with `400` (never a silent fallback to one
  mode).
- `scope`, `hits`, `escalate`, `radius` pass straight through to whichever
  engine function is dispatched to; `min_score` only applies to `mode=recall`
  (grep has no relevance floor — it's a pure exact-string scroll, no
  embedder call).
- The response is the underlying engine function's native shape
  (`{total_hits, scopes[]}`, each hit carrying full provenance) plus `mode`
  and `took_ms`. `grep()`'s response additionally carries a top-level
  `match_mode: "keyword"` field (its own normalization marker) that
  `recall()`'s response never has — a code-level tell that `GET /search`
  genuinely reached two different engine functions, not a single path
  wearing two labels.

Results render as a table with every field the engine returns (layer/
collection, match type, score, file, chunk span, embedder, retrieved_at,
plus a catch-all provenance column so no field is ever silently dropped —
recall's and grep's provenance shapes differ slightly and both are rendered
as-is). Zero hits render an explicit "No hits" empty state, not a blank
panel. See `test/search-route.mjs` for full coverage, including a live-corpus
example proving keyword mode is genuinely dispatching to grep and not just
recall in disguise.

## Graph (GET /graph/*)

The `/ui` Graph panel renders swarm-memory's real impact graph — backed by
`~/.local/share/swarm-memory/graph.sqlite` (populated by `swarm-memory graph
scan` from markdown-link + python-import scans) — as a vanilla SVG node-link
diagram. No charting/graph-viz library is used (zero-dep guardrail); layout
is a small in-browser force-directed simulation (`ui/app.js`'s
`forceLayout()`), fine at the tens-of-nodes scale this graph runs at today.

- `GET /graph/stats` wraps `swarm-memory graph stats` directly — the panel's
  header node/edge counts always match what that CLI command reports.
- `GET /graph/edges` (optionally `?node=`) wraps `swarm-memory graph edges
  [node]`; the diagram's node set is the union of every edge's `src`/`dst`.
- Clicking a node fires `GET /graph/impact/:node` and `GET /graph/deps/:node`
  (URL-encoded; node ids containing `/` round-trip correctly) in parallel and
  renders both lists in a side inspector panel — each matches
  `swarm-memory graph impact NODE` / `graph deps NODE` run directly. An
  unknown node returns `[]` (not an error) from both, matching the CLI's own
  behavior.
- Zero edges (fresh install, empty `graph.sqlite`) renders an explicit empty
  state ("Graph is empty…"), never a broken/blank render.

**Read-only, hard constraint:** this is graph *exploration* only.
`swarm-memory graph add` / `graph remove` (the graph's mutation verbs) are
never wrapped by `engine.mjs`, never routed by `server.mjs`, and never called
by `ui/app.js` — no UI action can reach them. See `test/graph-route.mjs`'s
"hard constraint" block, which greps the actual source for reachable
fetch()/route/CLI-argv patterns (not just prose) to prove this.

## Operations (Reindex / Refresh config cache)

The `/ui` Operations panel exposes **two deliberately distinct actions that
must never be conflated**. Both exist to resolve the same design-discussion
risk: an operator's ask for "clear/refresh/reindex" controls must never
become a way to wipe a Qdrant collection. There is no such verb in the
`swarm-memory` CLI, and this story invents none.

**1. Reindex (`POST /index {collection, paths: [...]}`)** — wraps
`swarm-memory index <collection> <paths...>` directly. It:

- Requires an explicit, operator-selected `collection` (chosen from the
  lanes list in the UI) and **at least one** path — both are validated
  (`400`) before any subprocess is spawned. There is no "reindex
  everything" / no-target / wildcard mode.
- Runs with the CLI's **default pruning behavior** — it never passes
  `--no-prune`. Per `swarm_memory/indexer.py`'s `index_paths()`, default
  pruning only deletes points matching that **exact file's own
  `full_path`** with `chunk_index >= <its new chunk count>` — i.e. the
  stale tail chunks of a file that shrank since its last index. It never
  touches any other file's chunks and never drops a collection. (This is
  different from `remember()`'s `--no-prune`, which exists only because a
  freshly generated note file has nothing to prune anyway — the two flags
  serve different, non-overlapping write patterns.)
- Shells out against the **live Qdrant Cloud SSOT** and can take real time
  on a large path set, so the UI shows an explicit confirmation dialog
  (naming the target collection + paths) before it runs, and a "reindexing…"
  status while the request is in flight.
- Reports the CLI's own real output back to the caller: `files_indexed`,
  `chunks_upserted`, `embed_failures`, `total_points` (parsed from the
  CLI's own summary line), plus the raw `engine_output`.

**2. Refresh config cache (`POST /cache/refresh`)** — a purely local action.
It calls `engine.mjs`'s `resetScopeMapCache()`, which does nothing more than
set the in-memory `_scopeMap` variable back to `null`. That's it: **no
subprocess is spawned, no Qdrant call, no `config.toml` read or write, no
`graph.sqlite` touch.** The only observable effect is that the *next* call to
`scopeMap()` (reached via `GET /scopes`, `GET /config`, or `remember()`'s
scope→collection lookup) re-shells out to `swarm-memory config` instead of
serving the cached copy. The UI labels this **"Refresh config cache"** —
never "Clear" — specifically so it cannot be mistaken for a data-deletion
action. See `test/reindex-route.mjs` for a test that proves this directly:
it swaps in a throwaway stub CLI (via the `SWARM_MEMORY_BIN` env override)
and asserts the call-log the stub keeps is byte-for-byte unchanged by the
refresh call itself.

**Hard constraint, verified, not assumed:** `test/reindex-route.mjs`'s
closing block greps the actual source of `engine.mjs`, `server.mjs`, and
`ui/app.js` (not prose/comments) for any destructive-verb pattern
(`delete`/`remove`/`drop`/`wipe`/`purge`/`truncate`/DELETE-method routes),
confirms `engine.mjs` has exactly two `"index"`-argv call sites
(`remember()` and `reindex()`, both upsert/refresh, never delete), and
confirms `resetScopeMapCache()`'s body contains no subprocess or
filesystem-mutation call at all.

## Skill harness (Claude Code)

`skills/mnemosyne-standalone/SKILL.md` lets a **bare Claude Code session
drive this standalone instance directly** — no Pantheon host, no L2 plugin
lifecycle required. It's built on `bin/mnemosyne-skill-helper.mjs`, a small
helper that:

1. **Checks `GET /healthz`** (liveness alias — no CLI shell-out) on the
   configured `PORT` (default `8477`) with a short timeout. If already alive,
   it does **not** spawn anything — no second instance, no second port-bind
   attempt. Deliberately checks `/healthz`, not the deeper `/health`: the
   latter now runs a live `swarm-memory check` plus drift reconciliation and
   can legitimately take 30s+ against real Qdrant/embedder infra, which
   would make a liveness probe unreliable.
2. **If not running**, spawns `bin/mnemosyne` detached (matching the
   supervised-run invocation documented above: `nohup env PORT=... node
   src/server.mjs > <logfile> 2>&1 &`) and polls the deeper `GET /health`
   until it goes green (per-attempt and overall timeouts sized for that
   endpoint's real cost), failing loudly (not silently) if it never comes up.
3. **Exposes `recall`/`remember`/`grep`/`reindex`/`graph-*` as thin
   pass-throughs** to the corresponding HTTP routes above — same request
   shape, same response shape, no new business logic. The helper never
   imports `src/engine.mjs` and never shells out to `swarm-memory` directly;
   every action goes *through* this service's own API, preserving the
   transport/engine split and every guardrail already enforced in
   `engine.mjs` (loud failure, full provenance, no collection wipe).
4. **Prints the `/ui` URL** on every successful run so the operator knows to
   open the browser UI.

```bash
node bin/mnemosyne-skill-helper.mjs ensure
node bin/mnemosyne-skill-helper.mjs recall '{"query":"...","scope":"..."}'
node bin/mnemosyne-skill-helper.mjs reindex '{"collection":"...","paths":["..."]}'
```

This is distinct from `hooks/` (`pre-recall.mjs`/`post-remember.mjs`),
which are `UserPromptSubmit`/`Stop` hooks meant to be wired into *other*
(consumer) repos' agent loops — see `hooks/README.md`. The skill is invoked
directly, inside this repo, by an operator talking to Mnemosyne by hand.
See `test/skill-harness.mjs` for full coverage (not-running-then-start,
already-running-skip-start, and pass-through correctness for every action).

## Minerva / library integration

`lib/mnemosyne/` is a separate, typed client surface (`MnemosyneClient`,
layer adapters, interfaces/schema) consumed in-process by other Pantheon
gods — Minerva's decision/memory integration (`lib/minerva/`) is the real,
working example. This is a different consumption path than the HTTP API
above: gods that can share a Node/TS process import `MnemosyneClient`
directly; gods that can't (or that are calling from outside this process,
like the standalone `/ui` and the Claude Code skill harness) use the HTTP
API. Both paths ultimately call through the same `src/engine.mjs`.

Minerva-style client integration test (headless — imports `MnemosyneClient`,
checks vector provenance and file fallback, starts the client HTTP API, and
verifies `POST /recall` matches the library result):

```bash
npm run test:e2e
```

## Port / route

- Local: `http://127.0.0.1:8477`
- Tailnet (if served): `https://hive.tail9a130d.ts.net:8448` → `127.0.0.1:8477`

## Guardrails honored

- Wraps the existing engine — **no new store, no re-embed**. `remember` is
  **additive** (`--no-prune`, upsert of a brand-new note file only); `reindex`
  (`POST /index`) uses the CLI's own default pruning (stale tail chunks of a
  shrunk file, scoped to that one file's own path); the Qdrant collections
  (SSOT) are never wiped. There is no delete/wipe/drop-collection endpoint,
  UI action, or CLI verb anywhere in this service — see "Operations" above.
- No secrets printed. No Don-stack / multica-daemon / auriga touched.
- Zero third-party deps — runs on the hive's Node with no install step.

## Deferred (honest scope — see idea-brief for the full design)

- Obsidian **meta layer** + enterprise/project layer routing (recall/remember
  currently ride the swarm-memory scope ladder, which already covers
  vector + code-graph + file layers).
- **Continuous indexing** (Multica-native scheduling).
- **Consus/Janus read model** (browse layers / trace provenance in the UI).
- Argus/Metis decision+metric logging per call.
