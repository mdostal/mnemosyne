# MnemosyneClient HTTP API

A thin REST wrapper around [`MnemosyneClient`](../lib/mnemosyne/client.ts) for
external, non-TypeScript consumers (CLI tools, non-TS agents). Every request
is a straight pass-through to the client library — this service does
transport only, no memory logic of its own.

Story: `s2-03-http-service` (epic: `mnemosyne-operational-slice-2`).

> **Not the same service as `src/server.mjs`.** `src/server.mjs` (`:8477`) is
> the production service wrapping the swarm-memory/Qdrant engine. This API
> (`lib/mnemosyne/server.ts`, default `:3141`) wraps the newer
> `MnemosyneClient` (code-graph/vector/file routing). They run as separate
> processes on separate ports and do not share routes.

## Run

```bash
npm run start:client-api
# or
MNEMOSYNE_PORT=3141 MNEMOSYNE_ROOT_DIR=. bin/mnemosyne-client-api
```

- `MNEMOSYNE_PORT` — port to listen on (default `3141`).
- `MNEMOSYNE_ROOT_DIR` — directory the file layer searches (default `process.cwd()`).

No authentication — localhost-only for this slice; auth is future work.

## Endpoints

### `GET /health`

Layer availability status.

```bash
curl -s http://127.0.0.1:3141/health
```

```json
{
  "ok": true,
  "layers": [
    { "layer": "file", "available": true, "root_directory": "/path/to/root" }
  ]
}
```

Returns `503` with `ok: false` when a layer is unavailable (e.g. the root
directory does not exist).

### `POST /recall`

```bash
curl -s -X POST http://127.0.0.1:3141/recall \
  -H 'content-type: application/json' \
  -d '{"query": "provenance", "scope": "project"}'
```

Body:

| field    | type                             | required |
|----------|-----------------------------------|----------|
| `query`  | `string`                          | yes |
| `scope`  | `"project" \| "enterprise" \| "meta"` | yes |
| `intent` | `"narrow" \| "broad"`             | no |

Returns the client library's `RecallResult` JSON verbatim (`RecallSuccess` on
`ok: true` with `hits`, `layers_queried`, `layers_skipped`, `escalated`,
`degraded`; `RecallFailure` on `ok: false` with a structured `error`). See
[`interfaces.ts`](../lib/mnemosyne/interfaces.ts) for the full contract.

### `POST /remember`

```bash
curl -s -X POST http://127.0.0.1:3141/remember \
  -H 'content-type: application/json' \
  -d '{"content": {"text": "decision: use file layer first"}, "scope": "project"}'
```

Body:

| field           | type                                                                   | required |
|-----------------|-------------------------------------------------------------------------|----------|
| `content.text`  | `string`                                                                 | yes |
| `content.metadata` | `object`                                                              | no |
| `scope`         | `"project" \| "enterprise" \| "meta"`                                    | yes |
| `layer`         | `"meta" \| "enterprise" \| "project" \| "code-graph" \| "vector" \| "file"` | no |

Returns the client library's `RememberResult` JSON verbatim. As of this
story `remember()` is a stub in the client (see
[`lib/mnemosyne/README.md`](../lib/mnemosyne/README.md)): it always succeeds
and returns provenance for the resolved layer, but does not persist content
yet.

## Errors

Invalid input (missing/malformed `query`, `scope`, `content.text`, or an
unparseable JSON body) returns `400` with a structured error:

```json
{ "error": { "code": "invalid_scope", "message": "\"scope\" is required and must be one of: project, enterprise, meta" } }
```

Unknown routes return `404`; unexpected failures return `500` — both with the
same `{ "error": { "code", "message" } }` shape.

## Tests

```bash
npm run test:http-api
```

Spawns the service against a throwaway root directory with known content and
exercises every route (including the 400 paths) over real HTTP.

---

## Reindex jobs and the repo-merged event (`src/server.mjs`, `:8477`)

These routes belong to the production service (`src/server.mjs`), not the
client API above. Story: PANT-837. Implementation: `src/reindex-jobs.mjs`.

A bulk reindex runs as a **job**. Starting one returns a `job_id`
straight away, and the caller polls for the outcome. Jobs are kept in memory
only (the last `MNEMOSYNE_REINDEX_JOB_HISTORY` jobs, default 50; running
jobs are never evicted). A restart forgets them.

### Configuration

| env | meaning |
|-----|---------|
| `MNEMOSYNE_REINDEX_ROOTS` | Directories a reindex may scan, separated by `:` (like `PATH`). A requested `directory` must resolve, after symlinks, to one of these roots or somewhere below one. **Unset: only the service's own cwd is allowed.** |
| `MNEMOSYNE_REPO_SCOPES` | JSON object mapping repo to `{scope, directory}`, for example `{"mdostal/mnemosyne": {"scope": "project", "directory": "/srv/repos/mnemosyne"}}`. Keys are matched case-insensitively. `https://github.com/…` and `.git` are stripped. A malformed value fails the service at startup. |
| `MNEMOSYNE_REINDEX_JOB_HISTORY` | How many jobs to keep (default `50`). |
| `MNEMOSYNE_PYTHON_BIN` | Python used for the read-only collection-existence check (default `python3`). |

### Missing collections

A reindex job **never creates a Qdrant collection**. Before it scans
anything, the job runs the same read-only existence check as `mnemosyne
onboard` (`src/collection-exists.mjs`). If the scope's collection doesn't
exist, the job ends as `failed` with an error that names the collection and
the command that creates it (`mnemosyne onboard <path> --collection <name>
--create`). Creating infrastructure stays an explicit operator step, never a
side effect of an event. If the check itself can't run (for example, missing
Qdrant credentials), the job also fails with that error.

### `POST /reindex`

```bash
curl -sX POST localhost:8477/reindex \
  -H 'content-type: application/json' \
  -d '{"scope": "project", "directory": "/srv/repos/mnemosyne"}'
```

| field | type | required |
|-------|------|----------|
| `scope` | `string` (a configured scope) | yes |
| `directory` | `string` (default: the service's cwd) | no |

`202`:

```json
{ "job_id": "6d0a…", "scope": "project", "status": "running",
  "directory": "/srv/repos/mnemosyne", "deduplicated": false }
```

If a job for the same scope is already running, the call returns **that**
job's `job_id` with `"deduplicated": true` and doesn't start a second run.
One run per scope at a time.

Errors: `400` missing or unknown `scope`, or an in-root `directory` that
doesn't exist. `403` `directory` outside `MNEMOSYNE_REINDEX_ROOTS`
(including `..` and symlink escapes).

### `GET /reindex/:job_id`

```json
{
  "job_id": "6d0a…", "scope": "project", "collection": "project_coll",
  "directory": "/srv/repos/mnemosyne",
  "trigger": { "type": "repo-merged", "repo": "mdostal/mnemosyne", "ref": "dev" },
  "status": "succeeded",
  "files_scanned": 120, "files_indexed": 119,
  "errors": [ { "file": "/srv/repos/mnemosyne/bad.md", "error": "…" } ],
  "error": null,
  "started_at": "2026-09-28T01:00:09.129Z", "finished_at": "2026-09-28T01:00:41.253Z"
}
```

- `status`: `running` → `succeeded` | `failed`.
- `succeeded` means the run completed. Individual files that failed to index
  are listed in `errors`, and the rest were still indexed. A retry is always
  safe because indexing is idempotent.
- `failed` means the run could not complete (for example, a missing
  collection or a thrown engine error). The reason is in `error`.
- `files_scanned` and `files_indexed` are `null` while the job is running.

`404` if the `job_id` is unknown or has aged out of history.

### `GET /reindex`

`200 {"jobs": [...]}`: the retained jobs, newest first, in the same shape as
above.

### `POST /events/repo-merged`

The event-driven entry point. Pantheon calls this when a merge lands (for
example, to `dev`). Mnemosyne never polls or schedules reindexes itself.

```bash
curl -sX POST localhost:8477/events/repo-merged \
  -H 'content-type: application/json' \
  -d '{"repo": "mdostal/mnemosyne", "ref": "dev"}'
```

The route looks the repo up in `MNEMOSYNE_REPO_SCOPES` and starts (or
joins, with the same dedup as `POST /reindex`) a job for the mapped scope
over the mapped directory. The directory is still subject to
`MNEMOSYNE_REINDEX_ROOTS`. It responds `202` with the `POST /reindex` body
plus `repo` and `ref`. `ref` is recorded on the job's `trigger`. Mnemosyne
indexes whatever is on disk at the mapped directory, so keeping that checkout
at the merged `ref` is the caller's job.

Errors: `400` no `repo`. `422` repo not in `MNEMOSYNE_REPO_SCOPES`; the
body names it: `{"error": "repo 'x/y' is not mapped to a scope (MNEMOSYNE_REPO_SCOPES)", "repo": "x/y"}`.
`403` the mapped directory is outside the roots.
