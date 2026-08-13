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
| `GET /scopes`   | —                                                           | scopes → collections + escalation ladders |
| `GET /config`   | —                                                           | read-only effective config: `qdrant_url`, `embedder` (provider/model), `default_scope`, `fallback_collection`, `scopes`, `ladder` — thin wrapper over `engine.mjs`'s cached `scopeMap()` |
| `POST /recall`  | `{query, scope?, hits?, escalate?, min_score?, radius?}`    | ranked hits **with full provenance** (layer/collection, file, chunk span, embedder, retrieved_at) |
| `POST /remember`| `{text, scope?, tag?}`                                       | write-back: persists a note + indexes (upsert, `--no-prune`) it into the scope's collection so it is immediately recallable |
| `POST /lanes`   | `{name, collection, ladder?}`                                | **add-only** atomic write of a new `[scopes]`/`[ladder]` entry to `~/.config/swarm-memory/config.toml` — see "Lanes / add-lane" below |
| `GET /search`   | query params: `q`, `scope?`, `mode?` (`recall`\|`grep`, default `recall`), `hits?`, `escalate?`, `min_score?`, `radius?` | thin dispatcher for the `/ui` Search panel — routes straight to `recall()`/`grep()` (no new query logic); invalid `mode` → `400` |

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
