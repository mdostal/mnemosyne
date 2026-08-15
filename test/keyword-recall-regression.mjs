// test/keyword-recall-regression.mjs — kw-03-keyword-recall-regression-tests
//
// Higher-rigor, cross-implementation regression layer on top of kw-01's own
// test-spec-driven test (test/parallel-keyword.mjs, magic KWTEST_* query
// substrings against test/fixtures/fake-swarm-memory.mjs). THIS suite:
//
//   1. Spawns a REAL src/server.mjs subprocess (real HTTP, not a direct
//      in-process import of engine.mjs) -- the actual live-service
//      entrypoint, same rigor as test/recall-status-filtering.mjs.
//   2. Points it at test/fixtures/fake-swarm-memory-kw03.mjs, a hermetic,
//      deterministic test double seeded from test/fixtures/
//      keyword-recall-corpus.mjs -- NOT the operator's real live Qdrant
//      data (which could change/be deleted over time), and NOT kw-01's own
//      magic-marker fixture (this is a separate, complementary fixture).
//   3. Reproduces the EXACT shape of the real defect this whole epic exists
//      to fix (docs/qdrant-hybrid-retrieval-experiment.md's Test 1): three
//      near-identical ticket-completion notes (TEST-1001/1002/1003, same
//      template, short prefix + sequential numbers -- mirrors the real
//      PAN-8968/PAN-7909 near-collision shape) where dense vector search
//      for the exact target ID (TEST-1002) returns its wrong-but-plausible
//      NEIGHBORS, never the correct entry -- while keyword search finds the
//      correct one instantly and exactly.
//   4. Proves the fix (kw-01's always-parallel merge) surfaces the correct
//      entry anyway, via the real merged POST /recall response.
//   5. Proves a purely conceptual query (Test 2's paraphrase, zero literal
//      overlap with any corpus entry) still surfaces the real semantic
//      match -- no regression to plain semantic recall.
//   6. Runs the whole query set TWICE against the same fixture to prove
//      determinism (no ordering/timing flakiness) -- kw-03's 4th
//      acceptance criterion.
//
// The companion TS-side suite (lib/mnemosyne/__tests__/
// keyword-recall-regression.test.ts) asserts the SAME real answers (same
// TARGET_TICKET entry found for the exact-ID query, same CONCEPT_ENTRY found
// for the conceptual query) via MnemosyneClient.recall() against a
// byte-identical corpus (both fixtures import test/fixtures/
// keyword-recall-corpus.mjs directly) -- proving the two independently
// maintained implementations are behaviorally consistent, per this epic's
// "kept in sync" convention, without requiring byte-identical response
// envelopes (src/server.mjs's POST /recall returns engine.mjs's raw
// {query,total_hits,scopes} shape; the TS client returns its own
// RecallResult shape -- see test/recall-status-filtering.mjs's own doc
// comment on this exact envelope difference).
//
// Usage: node test/keyword-recall-regression.mjs
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONCEPT_ENTRY,
  CONCEPT_QUERY,
  NEIGHBOR_TICKETS,
  TARGET_TICKET,
  ticketEntry,
} from "./fixtures/keyword-recall-corpus.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SERVER = path.join(ROOT, "src", "server.mjs");
const FIXTURE = fileURLToPath(new URL("./fixtures/fake-swarm-memory-kw03", import.meta.url));
const PORT = Number(process.env.MNEMOSYNE_TEST_PORT || 31419);
const BASE = `http://127.0.0.1:${PORT}`;

let fails = 0;
const ok = (condition, message) => {
  console.log(`${condition ? "  PASS" : "  FAIL"}  ${message}`);
  if (!condition) fails++;
};

function allHits(recallBody) {
  return (recallBody.scopes ?? []).flatMap((s) => s.hits ?? []);
}

async function postRecall(query) {
  const res = await fetch(BASE + "/recall", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, scope: "personal", hits: 5 }),
  });
  return { status: res.status, body: await res.json() };
}

async function waitForServer(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE + "/healthz");
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

// Runs the two real-world scenarios once and returns the two responses, so
// the caller can both assert on them AND re-run this to prove determinism.
async function runScenarios() {
  const exact = await postRecall(TARGET_TICKET);
  const concept = await postRecall(CONCEPT_QUERY);
  return { exact, concept };
}

function assertExactIdScenario(res, label) {
  ok(res.status === 200, `${label}: POST /recall (exact ID) -> 200 (got ${res.status})`);
  const hits = allHits(res.body);
  const correctEntry = ticketEntry(TARGET_TICKET);
  const correctHit = hits.find((h) => h.source === correctEntry.source);
  ok(
    !!correctHit,
    `${label}: the real, correct entry for ${TARGET_TICKET} is present in the merged response (the real defect this epic fixes)`,
  );
  ok(
    correctHit && correctHit.text === correctEntry.text,
    `${label}: correct hit's text matches the fixture entry exactly (got ${JSON.stringify(correctHit && correctHit.text)})`,
  );
  ok(
    correctHit && correctHit.match_type === "keyword" && correctHit.provenance?.layer === "file",
    `${label}: correct hit came via the keyword (file) layer, not vector -- proves vector alone would have missed it`,
  );

  // The WRONG, near-identical neighbors are what vector search returns for
  // this query (the real defect) -- they must ALSO be present (merged, not
  // replaced), each still tagged as the vector layer's own (wrong) guess.
  for (const neighborId of NEIGHBOR_TICKETS) {
    const neighborEntry = ticketEntry(neighborId);
    const neighborHit = hits.find((h) => h.source === neighborEntry.source);
    ok(
      !!neighborHit && neighborHit.match_type === "semantic" && neighborHit.provenance?.layer === "vector",
      `${label}: wrong-but-plausible neighbor ${neighborId} is present, tagged as vector/semantic (mirrors the real defect: vector returns nonzero WRONG hits)`,
    );
  }

  ok(
    Array.isArray(res.body.layers_attempted) &&
      res.body.layers_attempted.includes("vector") &&
      res.body.layers_attempted.includes("file"),
    `${label}: layers_attempted honestly includes both vector and file (got ${JSON.stringify(res.body.layers_attempted)})`,
  );
}

function assertConceptScenario(res, label) {
  ok(res.status === 200, `${label}: POST /recall (conceptual query) -> 200 (got ${res.status})`);
  const hits = allHits(res.body);
  const semanticHit = hits.find((h) => h.source === CONCEPT_ENTRY.source);
  ok(
    !!semanticHit,
    `${label}: the real conceptual match is present for a query sharing ZERO literal words with it -- no regression to plain semantic recall`,
  );
  ok(
    semanticHit && semanticHit.match_type === "semantic" && semanticHit.provenance?.layer === "vector",
    `${label}: conceptual match came via the vector (semantic) layer`,
  );
  ok(
    !hits.some((h) => h.match_type === "keyword"),
    `${label}: keyword layer genuinely found nothing for this query (no literal overlap with the corpus) -- mirrors the source doc's Test 2`,
  );
}

async function main() {
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      SWARM_MEMORY_BIN: FIXTURE,
      MNEMO_TEST_NODE: process.execPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let serverOutput = "";
  child.stdout.on("data", (c) => (serverOutput += c));
  child.stderr.on("data", (c) => (serverOutput += c));

  try {
    const up = await waitForServer();
    ok(up, "real src/server.mjs subprocess (kw-03 fixture) started and is reachable");
    if (!up) {
      console.error(serverOutput);
      throw new Error("server never became reachable");
    }

    // --- Run 1 -----------------------------------------------------------
    const run1 = await runScenarios();
    assertExactIdScenario(run1.exact, "run 1");
    assertConceptScenario(run1.concept, "run 1");

    // --- Run 2 (kw-03 AC4: determinism across repeated runs) -------------
    const run2 = await runScenarios();
    assertExactIdScenario(run2.exact, "run 2");
    assertConceptScenario(run2.concept, "run 2");

    const correctEntry = ticketEntry(TARGET_TICKET);
    const sources1 = allHits(run1.exact.body).map((h) => h.source).sort();
    const sources2 = allHits(run2.exact.body).map((h) => h.source).sort();
    ok(
      JSON.stringify(sources1) === JSON.stringify(sources2),
      `determinism: identical exact-ID query returns the identical hit set across two runs (got ${JSON.stringify(sources1)} vs ${JSON.stringify(sources2)})`,
    );
    ok(
      sources1.includes(correctEntry.source),
      "determinism: the correct entry is present in both runs' hit sets",
    );

    const conceptSources1 = allHits(run1.concept.body).map((h) => h.source).sort();
    const conceptSources2 = allHits(run2.concept.body).map((h) => h.source).sort();
    ok(
      JSON.stringify(conceptSources1) === JSON.stringify(conceptSources2),
      `determinism: identical conceptual query returns the identical hit set across two runs (got ${JSON.stringify(conceptSources1)} vs ${JSON.stringify(conceptSources2)})`,
    );
  } finally {
    child.kill();
  }

  if (fails) {
    console.log("\n--- server output (for debugging) ---");
    console.log(serverOutput);
  }

  console.log(fails ? `\n${fails} check(s) failed` : "\nall keyword-recall-regression (JS server) checks passed");
  process.exit(fails ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
