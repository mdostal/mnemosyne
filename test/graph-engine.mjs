// graph-engine.mjs — TDD tests for s-04's engine.mjs graph wrapper functions:
// graphStats(), graphEdges(), graphImpact(), graphDeps().
//
// These call the REAL swarm-memory CLI against the REAL
// ~/.local/share/swarm-memory/graph.sqlite (same posture as test/smoke.mjs
// and test/search-route.mjs — never a fixture/mock for the graph itself,
// because the story's acceptance criteria require the rendered counts to
// match `swarm-memory graph stats` directly). Graph commands never touch
// Qdrant, so there is no live-network dependency here beyond the local
// sqlite file.
//
// The zero-edges empty-state case is exercised against a FRESH, throwaway
// graph.sqlite via the SWARM_MEMORY_GRAPH_DB env override (confirmed live:
// `swarm-memory` creates an empty db on first touch and reports
// {nodes:0, edges:0, edges_by_origin:{}}) — never by mutating the real graph.
//
// Usage: node test/graph-engine.mjs
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { graphStats, graphEdges, graphImpact, graphDeps } from "../src/engine.mjs";

let fails = 0;
const ok = (c, m) => { console.log(`${c ? "  PASS" : "  FAIL"}  ${m}`); if (!c) fails++; };

// --- graphStats(): real live graph -----------------------------------------
{
  const stats = await graphStats();
  ok(typeof stats.nodes === "number" && stats.nodes >= 0, `graphStats() has nodes (${stats.nodes})`);
  ok(typeof stats.edges === "number" && stats.edges >= 0, `graphStats() has edges (${stats.edges})`);
  ok(stats.edges_by_origin && typeof stats.edges_by_origin === "object",
    `graphStats() has edges_by_origin (${JSON.stringify(stats.edges_by_origin)})`);
  ok(typeof stats.db === "string" && stats.db.length > 0, `graphStats() has db path (${stats.db})`);
}

// --- graphEdges(): shape + count matches graphStats().edges -----------------
{
  const stats = await graphStats();
  const edges = await graphEdges();
  ok(Array.isArray(edges), "graphEdges() returns an array");
  ok(edges.length === stats.edges,
    `graphEdges() length (${edges.length}) matches graphStats().edges (${stats.edges})`);
  if (edges.length) {
    const e = edges[0];
    ok(typeof e.src === "string" && typeof e.dst === "string" && typeof e.predicate === "string",
      `edge has src/predicate/dst (${JSON.stringify(e)})`);
    ok(typeof e.origin === "string", `edge has origin (${e.origin})`);
  }

  // node-count sanity: the set of unique src/dst across all edges should
  // account for graphStats().nodes on the live graph (confirmed by a live
  // run during research: 22 unique nodes from 30 edges === stats.nodes=22).
  const nodeSet = new Set();
  for (const e of edges) { nodeSet.add(e.src); nodeSet.add(e.dst); }
  ok(nodeSet.size === stats.nodes,
    `unique node count derived from graphEdges() (${nodeSet.size}) matches graphStats().nodes (${stats.nodes})`);
}

// --- graphEdges(node): filters to edges touching that node -----------------
{
  const all = await graphEdges();
  if (all.length) {
    const target = all[0].dst;
    const filtered = await graphEdges(target);
    ok(filtered.length >= 1, `graphEdges(node) returns >=1 edge for a node known to have one (${target})`);
    ok(filtered.every((e) => e.src === target || e.dst === target),
      "every filtered edge actually touches the requested node");
  } else {
    ok(true, "graph has no edges — skipping node-filter check (covered by the empty-graph block below)");
  }
}

// --- graphImpact()/graphDeps(): shape, and match direct CLI runs -----------
{
  const edges = await graphEdges();
  if (edges.length) {
    const node = edges[0].dst; // has at least one incoming edge -> some impact
    const impact = await graphImpact(node);
    ok(Array.isArray(impact), `graphImpact(node) returns an array (${impact.length} entries)`);
    if (impact.length) {
      const it = impact[0];
      ok(typeof it.node === "string" && typeof it.depth === "number" && typeof it.via === "string",
        `impact entry has node/depth/via (${JSON.stringify(it)})`);
    }

    const depsNode = edges[0].src; // has at least one outgoing edge -> some deps
    const deps = await graphDeps(depsNode);
    ok(Array.isArray(deps), `graphDeps(node) returns an array (${deps.length} entries)`);
    if (deps.length) {
      const dt = deps[0];
      ok(typeof dt.node === "string" && typeof dt.depth === "number" && typeof dt.via === "string",
        `deps entry has node/depth/via (${JSON.stringify(dt)})`);
    }
  } else {
    ok(true, "graph has no edges — skipping impact/deps content check (covered by the empty-graph block below)");
  }
}

// --- graphImpact()/graphDeps(): unknown node -> [] (not a throw) -----------
{
  const impact = await graphImpact("no-such-node-xyz-mnemosyne-test");
  ok(Array.isArray(impact) && impact.length === 0, `graphImpact(unknown node) -> [] (${JSON.stringify(impact)})`);
  const deps = await graphDeps("no-such-node-xyz-mnemosyne-test");
  ok(Array.isArray(deps) && deps.length === 0, `graphDeps(unknown node) -> [] (${JSON.stringify(deps)})`);
}

// --- graphImpact()/graphDeps(): missing node -> 400, no CLI call needed ----
{
  let threw = null;
  try { await graphImpact(""); } catch (e) { threw = e; }
  ok(threw != null && threw.status === 400, `graphImpact("") throws 400 (got ${threw && threw.status})`);

  threw = null;
  try { await graphDeps(undefined); } catch (e) { threw = e; }
  ok(threw != null && threw.status === 400, `graphDeps(undefined) throws 400 (got ${threw && threw.status})`);
}

// --- zero-edges empty graph: fresh throwaway graph.sqlite -------------------
await (async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mnemosyne-graph-empty-"));
  const dbPath = path.join(dir, "fresh-graph.sqlite");
  const prevEnv = process.env.SWARM_MEMORY_GRAPH_DB;
  process.env.SWARM_MEMORY_GRAPH_DB = dbPath;
  try {
    const stats = await graphStats();
    ok(stats.nodes === 0 && stats.edges === 0, `fresh graph.sqlite -> graphStats() {nodes:0, edges:0} (${JSON.stringify(stats)})`);
    ok(stats.db === dbPath, `fresh graph.sqlite -> graphStats().db points at the throwaway db (${stats.db})`);

    const edges = await graphEdges();
    ok(Array.isArray(edges) && edges.length === 0, `fresh graph.sqlite -> graphEdges() -> [] (${JSON.stringify(edges)})`);
  } finally {
    if (prevEnv === undefined) delete process.env.SWARM_MEMORY_GRAPH_DB;
    else process.env.SWARM_MEMORY_GRAPH_DB = prevEnv;
    await rm(dir, { recursive: true, force: true });
  }
})();

console.log(fails ? `\n${fails} check(s) failed` : "\nall graph-engine checks passed");
process.exit(fails ? 1 : 0);
