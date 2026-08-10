// test/vector.mjs - integration tests for vector layer fallback and provenance
import { fileURLToPath } from "node:url";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-swarm-memory", import.meta.url));
process.env.SWARM_MEMORY_BIN = FIXTURE;
process.env.FAKE_SWARM_MODE = "success";
process.env.MNEMO_TEST_NODE = process.execPath;

const { recall, grep } = await import("../src/engine.mjs?vector-test");

async function runTests() {
  console.log("Running vector layer tests...");
  let fails = 0;
  const ok = (c, m) => { console.log(`${c ? "  PASS" : "  FAIL"}  ${m}`); if (!c) fails++; };

  try {
    // 1. Semantic query should have layer='vector'
    const result = await recall("test semantic query that should get some hits", "personal", { hits: 1 });
    if (result.total_hits > 0 && result.scopes[0].hits.length > 0) {
      const hit = result.scopes[0].hits[0];
      ok(hit.provenance && hit.provenance.layer === "vector", "Vector hits should be decorated with layer='vector'");
      ok(result.layers_attempted && result.layers_attempted.includes("vector"), "layers_attempted should include 'vector'");
    }

    // 2. Zero vector hits should fallback to file layer
    // We enforce 0 hits by requiring an impossibly high minScore for a nonsense query.
    const randomQuery = "nonexistent_guid_fallback_" + Date.now();
    const fallbackResult = await recall(randomQuery, "personal", { hits: 1, minScore: 0.999 });
    ok(fallbackResult.total_hits === 0, "Obscure query should return 0 hits in fallback");
    ok(fallbackResult.layers_attempted && fallbackResult.layers_attempted.includes("vector") && fallbackResult.layers_attempted.includes("file"), "Fallback should include both layers attempted");
    
    // 3. Test grep provenance decoration
    const grepResult = await grep("test", "personal", { hits: 1 });
    if (grepResult.total_hits > 0 && grepResult.scopes[0].hits.length > 0) {
       const gHit = grepResult.scopes[0].hits[0];
       ok(gHit.provenance && gHit.provenance.layer === "file", "File hits should be decorated with layer='file'");
    }

  } catch (err) {
    console.error("Test error:", err);
    fails++;
  }

  console.log(fails ? `\n${fails} check(s) failed` : "\nall vector checks passed");
  process.exit(fails ? 1 : 0);
}

runTests();

import { spawnSync } from "child_process";

// To test full vector layer failure, we can temporarily move the Qdrant key or set an env var if swarm-memory supports it
// Let's run a test where SWARM_MEMORY_BIN points to a failing mock.
