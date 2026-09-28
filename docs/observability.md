# Observability

Mnemosyne has two separate observability surfaces. Which one you get depends
on which process you're looking at:

| Surface | Where | What it exposes | Scrapeable? |
|---|---|---|---|
| **HTTP service metrics** | `src/server.mjs` (`:8477`, the deployed memory god) | `GET /metrics`: request counters, latency histograms and gauges for `/recall`, `/remember`, `/grep`, `/reindex` | Yes: Prometheus text, or JSON with `?format=json` |
| **Library events + metrics** | `MnemosyneClient` (`lib/mnemosyne/client.ts`), via `src/observability/logger.ts` and `src/observability/metrics.ts` | Structured JSON log events plus `recall_duration_ms`, `remember_duration_ms` and `layer_degraded_total` samples | No. They're held in-process (`getMetricSamples()`); no HTTP route serves them, not even `lib/mnemosyne/server.ts` (`:3141`) |

`:8477` doesn't go through `MnemosyneClient`, so the library metrics below never
show up on `:8477/metrics`, and the `:8477` series never show up in the library
sample list.

## `:8477` `GET /metrics` (HTTP service)

Implemented in `src/observability/http-metrics.mjs` and incremented at the route
boundary in `src/server.mjs`. Everything stays in-process and is pull-only:
nothing is pushed to another god, and every counter resets when the process
restarts (`mnemosyne_uptime_seconds` shows when that happened).

Labels:

- `op`: `recall` | `remember` | `grep` | `reindex`. These are the `POST`
  routes only. `GET /search` (the UI's search panel) isn't metered.
- `scope`: the `scope` from the request body, or `default` when the caller
  left it out. Callers control this value, so the first 100 distinct scopes
  get their own label and any scope after that is reported as `__other__`.
  `POST /remember` with `layer: "code-graph"` is labelled `code-graph`.
- `outcome`: `error` for any 4xx/5xx response, including malformed JSON and
  missing `query`/`text`/`scope`. For `recall`/`grep`, a 200 with
  `total_hits == 0` is `empty`. Everything else is `ok`. `POST /reindex` is
  `ok` once it returns its 202; how the background run went is counted
  separately in `mnemosyne_reindex_runs_total`.

Series:

| Name | Type | Labels | Meaning |
|---|---|---|---|
| `mnemosyne_requests_total` | counter | `op`, `scope`, `outcome` | Requests handled |
| `mnemosyne_request_duration_seconds` | histogram | `op`, `scope`, `outcome` | Route latency. Buckets go from 5ms to 60s |
| `mnemosyne_reindex_runs_total` | counter | `scope`, `outcome` (`ok`\|`error`) | Background `POST /reindex` runs that finished. `error` means at least one file failed or the whole run threw |
| `mnemosyne_recall_hits` | gauge | `scope` | `total_hits` from the most recent successful recall on that scope |
| `mnemosyne_scope_missing` | gauge | `scope` | `1` if the most recent request that named the scope found it missing from the configured scope map (`swarm-memory config`), `0` if it was there. Left unset if the config couldn't be read |
| `mnemosyne_uptime_seconds` | gauge | — | Seconds since the process's metrics started |

Example PromQL:

- Recall volume: `sum by (scope) (rate(mnemosyne_requests_total{op="recall"}[5m]))`
- Empty-recall rate: `sum(rate(mnemosyne_requests_total{op="recall",outcome="empty"}[5m])) / sum(rate(mnemosyne_requests_total{op="recall",outcome!="error"}[5m]))`
- Per-scope errors: `sum by (scope, op) (rate(mnemosyne_requests_total{outcome="error"}[5m]))`
- p95 recall latency: `histogram_quantile(0.95, sum by (le) (rate(mnemosyne_request_duration_seconds_bucket{op="recall"}[5m])))`

`GET /metrics?format=json` returns the same data as JSON (`requests`,
`request_duration_seconds`, `reindex_runs`, `recall_hits`, `scope_missing`,
`uptime_seconds`) for callers that don't speak Prometheus.

Covered by `test/metrics-route.mjs`.

## Library events (`MnemosyneClient`)

`MnemosyneClient` writes structured JSON logs through `src/observability/logger.ts`
and records metric samples through `src/observability/metrics.ts`. None of
this applies to `:8477`.

### Recall

`recall_start`

- `query`: original caller query
- `scope`: requested memory scope
- `intent`: resolved recall intent

`layer_query`

- `layer`: queried memory layer
- `scope`: requested memory scope
- `duration_ms`: elapsed time spent in the layer adapter
- `ok`: whether the layer call returned a successful recall result

`layer_degraded`

- `layer`: degraded, skipped, or failed layer
- `scope`: requested memory scope
- `reason`: machine-readable degradation reason
- `detail`: optional human-readable detail

`recall_end`

- `duration_ms`: elapsed recall operation time
- `hit_count`: returned hit count, or `0` for failed recalls
- `layers_queried`: layers reported as queried, or `[]` for pre-dispatch failures
- `scope`: requested memory scope
- `intent`: resolved recall intent
- `ok`: whether recall succeeded
- `error_code`: present when recall failed with a code
- `error_layer`: present when recall failed

### Remember

`remember_start`

- `scope`: requested memory scope
- `layer`: resolved target layer
- `content_hash`: sha256 hash of the content text

`remember_end`

- `duration_ms`: elapsed remember operation time
- `layer`: resolved target layer
- `scope`: requested memory scope
- `ok`: whether remember succeeded

### Library metrics

Recorded in-process only; read them with `getMetricSamples()`. They are **not**
served by any HTTP endpoint.

- `recall_duration_ms`: histogram recorded once per `recall()` call.
- `remember_duration_ms`: histogram recorded once per `remember()` call.
- `layer_degraded_total`: counter incremented for each detected degradation,
  skipped layer, or layer failure.
