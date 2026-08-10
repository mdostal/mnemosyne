import assert from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function runTests() {
  const fixture = fileURLToPath(new URL("./fixtures/fake-swarm-memory", import.meta.url));
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "mnemosyne-code-graph-"));
  process.env.SWARM_MEMORY_BIN = fixture;
  process.env.FAKE_SWARM_GRAPH_STORE = path.join(tempDir, "graph.json");
  process.env.MNEMO_TEST_NODE = process.execPath;
  await writeFile(process.env.FAKE_SWARM_GRAPH_STORE, "[]", "utf8");

  const { CodeGraphLayer } = await import("../src/layers/code-graph.mjs");
  const { mergeLayerResults } = await import("../src/merge.mjs");
  const layer = new CodeGraphLayer();

  try {
    console.log("TEST 1: graph query returns typed edges");
    // We use "att:funnel:visitor" from the fake graph fixture.
    const hits = await layer.recall("att:funnel:visitor");

    assert.ok(hits.length > 0, "Expected at least one edge hit");

    const edgeHit = hits.find(h => h.match_type === "graph_edge");
    assert.ok(edgeHit, "Expected a graph_edge hit");
    assert.strictEqual(edgeHit.provenance.layer, "code-graph");
    assert.strictEqual(edgeHit.provenance.chunk_span, null);
    assert.ok(edgeHit.provenance.edge.predicate, "Expected a typed predicate");

    console.log("TEST 2: edge traversal includes dependent files");
    const traversalHit = hits.find(h => h.match_type === "graph_traversal");
    assert.ok(traversalHit, "Expected a graph_traversal hit");
    assert.strictEqual(traversalHit.provenance.layer, "code-graph");
    assert.strictEqual(traversalHit.provenance.chunk_span, null);

    console.log("TEST 3: remember() on code-graph updates SQLite");
    const rememberResult = await layer.remember("test:node:src", "depends_on", "test:node:dst");
    assert.strictEqual(rememberResult.remembered, true);
    assert.strictEqual(rememberResult.layer, "code-graph");
    assert.strictEqual(rememberResult.src, "test:node:src");

    // Verify it actually exists in the fake graph store now.
    const newHits = await layer.recall("test:node:src");
    const foundNew = newHits.find(h => h.match_type === "graph_edge" && h.text.includes("test:node:dst"));
    assert.ok(foundNew, "Expected to find the newly remembered edge");

    console.log("TEST 4: result merging includes vector + code-graph");
    const mockVectorResult = {
      query: "test",
      total_hits: 1,
      scopes: [
        {
          scope: "top",
          hits: [
            { score: 0.8, match_type: "semantic", provenance: { layer: "vector" } }
          ]
        }
      ]
    };

    const merged = mergeLayerResults(mockVectorResult, hits);
    assert.strictEqual(merged.total_hits, 1 + hits.length);
    assert.ok(merged.scopes[0].hits.some(h => h.match_type === "semantic"));
    assert.ok(merged.scopes[0].hits.some(h => h.match_type === "graph_edge"));

    console.log("All CodeGraph tests passed!");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

runTests().catch(e => {
  console.error("Test failed:", e);
  process.exit(1);
});
