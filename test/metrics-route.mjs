// metrics-route.mjs — GET /metrics on the real src/server.mjs (PANT-836).
//
// Spawns the service against the fake swarm-memory fixture, drives one ok
// recall, one recall on a scope that isn't configured, and one bad request,
// then asserts the matching counter/gauge values in both the Prometheus text
// and ?format=json renderings. Also unit-checks http-metrics.mjs's outcome
// mapping and scope-label cap in-process.
//
// Usage: node test/metrics-route.mjs

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHttpMetrics, outcomeFor } from "../src/observability/http-metrics.mjs";
import { createMnemosyneServer } from "../src/server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const FIXTURE = path.join(__dirname, "fixtures", "fake-swarm-memory");
const PORT = 31419;
const BASE = `http://127.0.0.1:${PORT}`;

let fails = 0;
const ok = (condition, message) => {
  console.log(`${condition ? "  PASS" : "  FAIL"}  ${message}`);
  if (!condition) fails++;
};

// Value of one sample line, e.g. sample(text, 'mnemosyne_requests_total{op="recall",...}').
function sample(text, series) {
  const line = text.split("\n").find((l) => l.startsWith(series + " "));
  return line == null ? undefined : Number(line.slice(series.length + 1));
}

async function post(pathname, rawBody) {
  const res = await fetch(BASE + pathname, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: rawBody,
  });
  return { status: res.status, body: await res.json() };
}

// --- http-metrics.mjs in-process -------------------------------------------
{
  ok(outcomeFor(200, 3) === "ok", "outcomeFor(200, 3) -> ok");
  ok(outcomeFor(200, 0) === "empty", "outcomeFor(200, 0) -> empty");
  ok(outcomeFor(200, undefined) === "ok", "outcomeFor(200, undefined) -> ok (writes have no hit count)");
  ok(outcomeFor(400, 3) === "error", "outcomeFor(400, 3) -> error");
  ok(outcomeFor(500, undefined) === "error", "outcomeFor(500) -> error");

  const m = createHttpMetrics({ maxScopes: 2 });
  m.observe({ op: "recall", scope: "a", status: 200, hits: 1, durationMs: 5 });
  m.observe({ op: "recall", scope: "b", status: 200, hits: 1, durationMs: 5 });
  m.observe({ op: "recall", scope: "c", status: 200, hits: 1, durationMs: 5 });
  m.observe({ op: "remember", scope: "a", status: 200, hits: 0, durationMs: 5 });
  const text = m.renderPrometheus();
  ok(
    sample(text, 'mnemosyne_requests_total{op="recall",scope="__other__",outcome="ok"}') === 1,
    "scope labels past maxScopes fold into scope=__other__",
  );
  ok(
    sample(text, 'mnemosyne_requests_total{op="remember",scope="a",outcome="ok"}') === 1,
    "remember is never 'empty' (hits only count for recall/grep)",
  );
  ok(
    sample(text, 'mnemosyne_request_duration_seconds_bucket{op="recall",scope="a",outcome="ok",le="0.005"}') === 1 &&
      sample(text, 'mnemosyne_request_duration_seconds_bucket{op="recall",scope="a",outcome="ok",le="+Inf"}') === 1,
    "histogram buckets are cumulative up to +Inf",
  );
  const quoted = createHttpMetrics();
  quoted.observe({ op: "grep", scope: 'x"y\\z', status: 200, hits: 1, durationMs: 1 });
  ok(
    quoted.renderPrometheus().includes('scope="x\\"y\\\\z"'),
    "label values escape quotes and backslashes",
  );
}

// --- GET /metrics over real HTTP -------------------------------------------
const child = spawn(process.execPath, [path.join(ROOT, "src", "server.mjs")], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    SWARM_MEMORY_BIN: FIXTURE,
    MNEMO_TEST_NODE: process.execPath,
    FAKE_SWARM_MODE: "success",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let serverOutput = "";
child.stdout.on("data", (c) => (serverOutput += c));
child.stderr.on("data", (c) => (serverOutput += c));

try {
  const deadline = Date.now() + 15000;
  let up = false;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) {
        up = true;
        break;
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  ok(up, "server started and is reachable");
  if (!up) {
    console.error(serverOutput);
    throw new Error("server never became reachable");
  }

  const empty = await fetch(`${BASE}/metrics`);
  const emptyText = await empty.text();
  ok(empty.status === 200, `GET /metrics before any traffic -> 200 (got ${empty.status})`);
  ok(
    String(empty.headers.get("content-type")).startsWith("text/plain; version=0.0.4"),
    `GET /metrics content-type is Prometheus text -> ${empty.headers.get("content-type")}`,
  );
  ok(emptyText.includes("# TYPE mnemosyne_requests_total counter"), "GET /metrics declares mnemosyne_requests_total as a counter");
  ok(!emptyText.includes("mnemosyne_requests_total{"), "no request samples before any traffic");

  // 1. ok recall on a configured scope (fixture config: personal, top).
  const good = await post("/recall", JSON.stringify({ query: "test semantic query", scope: "personal" }));
  ok(good.status === 200 && good.body.total_hits > 0, `ok recall -> 200 with hits (got ${good.status}, ${good.body.total_hits})`);

  // 2. recall on a scope the config doesn't have.
  const missing = await post("/recall", JSON.stringify({ query: "test semantic query", scope: "no-such-scope" }));
  const missingOutcome = missing.status >= 400 ? "error" : missing.body.total_hits === 0 ? "empty" : "ok";

  // 3. bad request: no query.
  const bad = await post("/recall", JSON.stringify({ scope: "personal" }));
  ok(bad.status === 400, `recall without a query -> 400 (got ${bad.status})`);

  // 4. and a malformed body, which fails before the handler learns its scope.
  const malformed = await post("/grep", "{not json");
  ok(malformed.status === 400, `grep with malformed JSON -> 400 (got ${malformed.status})`);

  const res = await fetch(`${BASE}/metrics`);
  const text = await res.text();

  ok(
    sample(text, 'mnemosyne_requests_total{op="recall",scope="personal",outcome="ok"}') === 1,
    'mnemosyne_requests_total{op="recall",scope="personal",outcome="ok"} == 1',
  );
  ok(
    sample(text, 'mnemosyne_requests_total{op="recall",scope="personal",outcome="error"}') === 1,
    'mnemosyne_requests_total{op="recall",scope="personal",outcome="error"} == 1 (the bad request)',
  );
  ok(
    sample(text, `mnemosyne_requests_total{op="recall",scope="no-such-scope",outcome="${missingOutcome}"}`) === 1,
    `mnemosyne_requests_total{op="recall",scope="no-such-scope",outcome="${missingOutcome}"} == 1`,
  );
  ok(
    sample(text, 'mnemosyne_requests_total{op="grep",scope="default",outcome="error"}') === 1,
    'malformed body is metered as grep/default/error',
  );
  ok(sample(text, 'mnemosyne_scope_missing{scope="no-such-scope"}') === 1, 'mnemosyne_scope_missing{scope="no-such-scope"} == 1');
  ok(sample(text, 'mnemosyne_scope_missing{scope="personal"}') === 0, 'mnemosyne_scope_missing{scope="personal"} == 0');
  ok(
    sample(text, 'mnemosyne_recall_hits{scope="personal"}') === good.body.total_hits,
    `mnemosyne_recall_hits{scope="personal"} == ${good.body.total_hits} (the latest successful recall; the 400 doesn't reset it)`,
  );
  ok(
    sample(text, 'mnemosyne_request_duration_seconds_count{op="recall",scope="personal",outcome="ok"}') === 1,
    "recall ok latency histogram has one observation",
  );
  ok(
    !text.includes('op="remember"') && !text.includes('op="reindex"'),
    "ops with no traffic emit no samples",
  );
  ok(!text.includes("/metrics"), "GET /metrics does not meter itself");

  const jsonRes = await fetch(`${BASE}/metrics?format=json`);
  const json = await jsonRes.json();
  ok(jsonRes.status === 200 && json.god === "mnemosyne", `GET /metrics?format=json -> 200 JSON (got ${jsonRes.status})`);
  const jr = (op, scope, outcome) =>
    json.requests.find((r) => r.op === op && r.scope === scope && r.outcome === outcome)?.value;
  ok(jr("recall", "personal", "ok") === 1, "JSON: recall/personal/ok == 1");
  ok(jr("recall", "personal", "error") === 1, "JSON: recall/personal/error == 1");
  ok(json.scope_missing["no-such-scope"] === 1, "JSON: scope_missing[no-such-scope] == 1");
  ok(json.recall_hits.personal === good.body.total_hits, "JSON: recall_hits.personal matches the ok recall");

  // remember + reindex route through the same meter.
  const rem = await post("/remember", JSON.stringify({ text: "metrics note", scope: "no-such-scope" }));
  ok(rem.status === 400, `remember on an unknown scope -> 400 (got ${rem.status})`);
  const re = await post("/reindex", JSON.stringify({}));
  ok(re.status === 400, `reindex without scope -> 400 (got ${re.status})`);
  const after = await (await fetch(`${BASE}/metrics`)).text();
  ok(
    sample(after, 'mnemosyne_requests_total{op="remember",scope="no-such-scope",outcome="error"}') === 1,
    "remember/no-such-scope/error == 1",
  );
  ok(sample(after, 'mnemosyne_requests_total{op="reindex",scope="default",outcome="error"}') === 1, "reindex/default/error == 1");
  ok(
    sample(after, 'mnemosyne_requests_total{op="recall",scope="personal",outcome="ok"}') === 1,
    "counters are stable across scrapes",
  );

} finally {
  child.kill();
}

// --- background reindex runs, in-process with a stubbed reindex -------------
// POST /reindex gates on MNEMOSYNE_REINDEX_ROOTS and a Qdrant collection check,
// so this part uses createMnemosyneServer()'s overrides instead of the spawned
// service above.
{
  const dir = await mkdtemp(path.join(tmpdir(), "mnemosyne-metrics-"));
  let release;
  const gate = new Promise((r) => (release = r));
  const runs = [];
  const server = createMnemosyneServer({
    scopeMap: async () => ({ scopes: { personal: "personal_coll", flaky: "flaky_coll" } }),
    collectionExists: null,
    reindexRoots: [dir],
    reindex: async (scope) => {
      runs.push(scope);
      await gate;
      return { files_scanned: 1, files_indexed: 1, errors: scope === "flaky" ? ["x.md: boom"] : [] };
    },
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const postTo = async (pathname, body) =>
    (await fetch(base + pathname, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status;
  const scrape = async () => (await fetch(`${base}/metrics`)).text();
  try {
    ok((await postTo("/reindex", { scope: "personal", directory: dir })) === 202, "reindex personal -> 202");
    ok((await postTo("/reindex", { scope: "personal", directory: dir })) === 202, "second reindex personal joins the running job -> 202");
    ok((await postTo("/reindex", { scope: "flaky", directory: dir })) === 202, "reindex flaky -> 202");
    const running = await scrape();
    ok(
      sample(running, 'mnemosyne_requests_total{op="reindex",scope="personal",outcome="ok"}') === 2,
      "both personal reindex requests are metered",
    );
    ok(!running.includes("mnemosyne_reindex_runs_total{"), "no run is counted while it's still running");
    release();
    const deadline = Date.now() + 5000;
    let text = "";
    while (Date.now() < deadline) {
      text = await scrape();
      if (text.includes('mnemosyne_reindex_runs_total{scope="flaky"')) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    ok(runs.length === 2, `the joined request didn't start a second run (runs: ${runs.join(",")})`);
    ok(
      sample(text, 'mnemosyne_reindex_runs_total{scope="personal",outcome="ok"}') === 1,
      'mnemosyne_reindex_runs_total{scope="personal",outcome="ok"} == 1 (counted once, not per request)',
    );
    ok(
      sample(text, 'mnemosyne_reindex_runs_total{scope="flaky",outcome="error"}') === 1,
      'mnemosyne_reindex_runs_total{scope="flaky",outcome="error"} == 1 (a file failed)',
    );
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

if (fails > 0) {
  console.error(`\n${fails} check(s) failed`);
  process.exit(1);
}
console.log("\nall metrics-route checks passed");
