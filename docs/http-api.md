# MnemosyneClient HTTP API

A thin REST wrapper around [`MnemosyneClient`](../lib/mnemosyne/client.ts) for
external, non-TypeScript consumers (CLI tools, non-TS agents). Every request
is a straight pass-through to the client library — this service does
transport only, no memory logic of its own.

Story: `s2-03-http-service` (epic: `mnemosyne-operational-slice-2`).

> **Not the same service as `src/server.mjs`.** `src/server.mjs` (`:8477`) is
> the production service wrapping the swarm-memory/Qdrant engine. This API
> (`lib/mnemosyne/server.ts`, default `:3141`) wraps the newer
> `MnemosyneClient` (file layer only, as of this story). They run as separate
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
