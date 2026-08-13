import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const CLI = process.env.SWARM_MEMORY_BIN || "swarm-memory";

export class CodeGraphLayer {
  async recall(query) {
    let edges = [];
    try {
      const { stdout } = await execFileP(CLI, ["graph", "edges", "--json", query]);
      edges = JSON.parse(stdout || "[]");
    } catch (e) {
      // Ignore if graph command fails (e.g., node not found or graph empty)
      edges = [];
    }

    let impact = [];
    try {
      // "Given a 'depends_on' edge, when recall traverses it, then dependent files are included in results"
      // Traversal using graph deps (or impact)
      const { stdout } = await execFileP(CLI, ["graph", "deps", "--json", query]);
      impact = JSON.parse(stdout || "[]");
    } catch (e) {
      impact = [];
    }

    const hits = [];

    // 1. Direct edges
    for (const edge of edges) {
      hits.push({
        score: 1.0,
        match_type: "graph_edge",
        text: `${edge.src} ${edge.predicate} ${edge.dst}`,
        provenance: {
          layer: "code-graph",
          source: edge.origin || "edge",
          edge: edge,
          chunk_span: null,
          embedder: null
        }
      });
    }

    // 2. Traversed dependencies
    for (const imp of impact) {
      hits.push({
        score: 0.9,
        match_type: "graph_traversal",
        text: `Depends on: ${imp.node} (via ${imp.via})`,
        provenance: {
          layer: "code-graph",
          source: imp.via,
          chunk_span: null,
          embedder: null
        }
      });
    }

    return hits;
  }

  async remember(src, predicate, dst) {
    await execFileP(CLI, ["graph", "add", src, predicate, dst]);
    return { remembered: true, layer: "code-graph", src, predicate, dst };
  }
}
