// http-metrics.mjs — in-process request metrics for the :8477 HTTP service
// (src/server.mjs), exposed pull-style on GET /metrics.
//
// Why not src/observability/metrics.ts: that module is the MnemosyneClient
// library's sink — TypeScript (src/server.mjs runs under plain `node`, no
// tsx) and an append-only sample list with no aggregation, so it grows
// without bound in a long-lived process and can't answer "how many recalls
// errored for scope X". This keeps fixed-size aggregates instead and renders
// them in the Prometheus text exposition format (0.0.4). Zero dependencies.
//
// Series:
//   mnemosyne_requests_total{op,scope,outcome}            counter
//   mnemosyne_request_duration_seconds{op,scope,outcome}  histogram
//   mnemosyne_reindex_runs_total{scope,outcome}           counter (background runs)
//   mnemosyne_recall_hits{scope}      gauge: total_hits of the latest recall
//   mnemosyne_scope_missing{scope}    gauge: 1 if the latest request naming
//                                     this scope found it unconfigured, else 0
//
// op: recall | remember | grep | reindex. outcome: ok | empty | error.
// `scope` is caller input, so distinct scope labels are capped (maxScopes);
// anything past the cap is folded into scope="__other__".

export const OPS = ["recall", "remember", "grep", "reindex"];
export const OUTCOMES = ["ok", "empty", "error"];
export const DEFAULT_SCOPE_LABEL = "default";
export const OVERFLOW_SCOPE_LABEL = "__other__";

// Seconds. recall/grep/remember shell out to swarm-memory (embedder + Qdrant
// round-trip), so the interesting range is ~50ms to tens of seconds.
export const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

// ok/empty/error for one finished request. `hits` is only meaningful for the
// read ops (recall/grep); a write either lands or errors.
export function outcomeFor(status, hits) {
  if (status >= 400) return "error";
  if (hits === 0) return "empty";
  return "ok";
}

export function createHttpMetrics({ maxScopes = 100, buckets = DURATION_BUCKETS } = {}) {
  const startedAt = Date.now();
  const knownScopes = new Set();
  const requests = new Map(); // "op\0scope\0outcome" -> count
  const durations = new Map(); // same key -> {buckets: number[], sum, count}
  const reindexRuns = new Map(); // "scope\0outcome" -> count
  const recallHits = new Map(); // scope -> last total_hits
  const scopeMissing = new Map(); // scope -> 0|1

  function scopeLabel(scope) {
    const s = scope == null || String(scope).trim() === "" ? DEFAULT_SCOPE_LABEL : String(scope);
    if (knownScopes.has(s)) return s;
    if (knownScopes.size >= maxScopes) return OVERFLOW_SCOPE_LABEL;
    knownScopes.add(s);
    return s;
  }

  function observe({ op, scope, status, hits, durationMs, scopeMissing: missing }) {
    const label = scopeLabel(scope);
    const outcome = outcomeFor(status, op === "recall" || op === "grep" ? hits : undefined);
    const key = `${op}\0${label}\0${outcome}`;
    requests.set(key, (requests.get(key) || 0) + 1);

    let h = durations.get(key);
    if (!h) {
      h = { buckets: buckets.map(() => 0), sum: 0, count: 0 };
      durations.set(key, h);
    }
    const seconds = Math.max(0, Number(durationMs) || 0) / 1000;
    for (let i = 0; i < buckets.length; i++) if (seconds <= buckets[i]) h.buckets[i] += 1;
    h.sum += seconds;
    h.count += 1;

    if (op === "recall" && status < 400 && typeof hits === "number") recallHits.set(label, hits);
    // undefined = couldn't tell (config lookup failed) -> leave the gauge alone.
    if (typeof missing === "boolean") scopeMissing.set(label, missing ? 1 : 0);
    return outcome;
  }

  function observeReindexRun({ scope, ok }) {
    const key = `${scopeLabel(scope)}\0${ok ? "ok" : "error"}`;
    reindexRuns.set(key, (reindexRuns.get(key) || 0) + 1);
  }

  function snapshot() {
    const split = (k) => k.split("\0");
    return {
      uptime_seconds: (Date.now() - startedAt) / 1000,
      requests: [...requests].map(([k, value]) => {
        const [op, scope, outcome] = split(k);
        return { op, scope, outcome, value };
      }),
      request_duration_seconds: [...durations].map(([k, h]) => {
        const [op, scope, outcome] = split(k);
        return {
          op,
          scope,
          outcome,
          count: h.count,
          sum: h.sum,
          buckets: Object.fromEntries(buckets.map((le, i) => [String(le), h.buckets[i]])),
        };
      }),
      reindex_runs: [...reindexRuns].map(([k, value]) => {
        const [scope, outcome] = split(k);
        return { scope, outcome, value };
      }),
      recall_hits: Object.fromEntries(recallHits),
      scope_missing: Object.fromEntries(scopeMissing),
    };
  }

  function renderPrometheus() {
    const lines = [];
    const header = (name, type, help) => lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    const snap = snapshot();

    header("mnemosyne_requests_total", "counter", "Requests to /recall, /remember, /grep and /reindex by scope and outcome.");
    for (const r of snap.requests) lines.push(`mnemosyne_requests_total${labels(r)} ${r.value}`);

    header("mnemosyne_request_duration_seconds", "histogram", "Request latency for /recall, /remember, /grep and /reindex.");
    for (const h of snap.request_duration_seconds) {
      const base = { op: h.op, scope: h.scope, outcome: h.outcome };
      for (const le of buckets) {
        lines.push(`mnemosyne_request_duration_seconds_bucket${labels({ ...base, le: String(le) })} ${h.buckets[String(le)]}`);
      }
      lines.push(`mnemosyne_request_duration_seconds_bucket${labels({ ...base, le: "+Inf" })} ${h.count}`);
      lines.push(`mnemosyne_request_duration_seconds_sum${labels(base)} ${h.sum}`);
      lines.push(`mnemosyne_request_duration_seconds_count${labels(base)} ${h.count}`);
    }

    header("mnemosyne_reindex_runs_total", "counter", "Finished background POST /reindex runs (error = at least one file failed, or the run threw).");
    for (const r of snap.reindex_runs) lines.push(`mnemosyne_reindex_runs_total${labels(r)} ${r.value}`);

    header("mnemosyne_recall_hits", "gauge", "total_hits returned by the most recent successful recall for the scope.");
    for (const [scope, v] of Object.entries(snap.recall_hits)) lines.push(`mnemosyne_recall_hits${labels({ scope })} ${v}`);

    header("mnemosyne_scope_missing", "gauge", "1 if the most recent request naming the scope found it absent from the configured scope map, else 0.");
    for (const [scope, v] of Object.entries(snap.scope_missing)) lines.push(`mnemosyne_scope_missing${labels({ scope })} ${v}`);

    header("mnemosyne_uptime_seconds", "gauge", "Seconds since this process's metrics were initialised (counters reset on restart).");
    lines.push(`mnemosyne_uptime_seconds ${snap.uptime_seconds}`);

    return lines.join("\n") + "\n";
  }

  return { observe, observeReindexRun, snapshot, renderPrometheus };
}

function labels(obj) {
  const parts = Object.entries(obj)
    .filter(([k]) => k !== "value")
    .map(([k, v]) => `${k}="${escapeLabel(v)}"`);
  return `{${parts.join(",")}}`;
}

function escapeLabel(v) {
  return String(v).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}
