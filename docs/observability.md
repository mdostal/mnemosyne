# Observability Events

Mnemosyne emits structured JSON logs through `src/observability/logger.ts` and
operation metrics through `src/observability/metrics.ts`.

## Recall

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

## Remember

`remember_start`

- `scope`: requested memory scope
- `layer`: resolved target layer
- `content_hash`: sha256 hash of the content text

`remember_end`

- `duration_ms`: elapsed remember operation time
- `layer`: resolved target layer
- `scope`: requested memory scope
- `ok`: whether remember succeeded

## Metrics

- `recall_duration_ms`: histogram recorded once per `recall()` call.
- `remember_duration_ms`: histogram recorded once per `remember()` call.
- `layer_degraded_total`: counter incremented for each detected degradation,
  skipped layer, or layer failure.
