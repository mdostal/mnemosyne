// mcp-server.mjs — tests for mcp-01-server: bin/mnemosyne-mcp.mjs.
//
// Real end-to-end: a real MCP Client (StdioClientTransport) spawns the real
// bin/mnemosyne-mcp.mjs as a child process (which itself spawns/reuses a
// real Mnemosyne HTTP service), talks real MCP JSON-RPC over stdio — no
// mocked transport, matching this repo's existing skill-harness.mjs
// convention of testing against a real subprocess.
//
// Uses a distinct PORT (8499) so this never collides with any other test
// file's port range (server.mjs default 8477; other test files use
// 8491/8492/8497/8498).
//
// Usage: node test/mcp-server.mjs

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const MCP_SERVER_PATH = path.join(ROOT, "bin", "mnemosyne-mcp.mjs");
const PORT = 8499;

let fails = 0;
const ok = (condition, message) => {
  console.log(`${condition ? "  PASS" : "  FAIL"}  ${message}`);
  if (!condition) fails++;
};

// --- source-level hard constraint: no destructive verb reachable ---------
// Proves, from the actual code (not runtime tool names, not prose), that no
// tool handler can reach a Qdrant collection delete/wipe/drop — same style
// as test/reindex-route.mjs's and test/graph-route.mjs's hard-constraint
// blocks.
{
  const src = await readFile(MCP_SERVER_PATH, "utf8");
  ok(
    !/["'`](delete|remove|drop|wipe|purge)["'`]/i.test(src.replace(/\/\/.*$/gm, "")),
    "mnemosyne-mcp.mjs source references no delete/remove/drop/wipe/purge string literal (comments excluded)",
  );
  ok(
    !/registerTool\(\s*["'`]/.test(src) || !/\.(delete|remove)\(/i.test(src),
    "mnemosyne-mcp.mjs never calls a .delete()/.remove() method anywhere",
  );
}

function toolResultJson(result) {
  const text = result.content?.find((c) => c.type === "text")?.text;
  return text ? JSON.parse(text) : null;
}

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_SERVER_PATH],
    env: { ...process.env, PORT: String(PORT) },
  });
  const client = new Client({ name: "mcp-server-test", version: "0.1.0" });

  try {
    await client.connect(transport);
    ok(true, "client connected to the real mnemosyne-mcp server over stdio");

    // --- tools/list ---------------------------------------------------
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    const expected = [
      "graph_deps",
      "graph_edges",
      "graph_impact",
      "graph_stats",
      "grep",
      "persona_create",
      "persona_seed",
      "persona_show",
      "persona_sync",
      "recall",
      "reindex",
      "remember",
    ];
    ok(
      expected.every((n) => names.includes(n)),
      `tools/list returns all ${expected.length} expected tools (got: ${names.join(", ")})`,
    );
    ok(tools.length === expected.length, `tools/list returns exactly ${expected.length} tools (got ${tools.length})`);

    const recallTool = tools.find((t) => t.name === "recall");
    ok(
      !!recallTool.inputSchema?.properties?.query,
      "recall tool schema has a 'query' input property",
    );

    // --- recall pass-through correctness --------------------------------
    const recallResult = await client.callTool({
      name: "recall",
      arguments: { query: "mnemosyne mcp server pass-through test", hits: 3 },
    });
    ok(!recallResult.isError, `recall tool call did not error (${recallResult.isError ? JSON.stringify(recallResult) : "ok"})`);
    const recallData = toolResultJson(recallResult);
    ok(
      recallData && typeof recallData.total_hits === "number" && Array.isArray(recallData.scopes),
      `recall tool result matches POST /recall's real shape (total_hits, scopes[]) — got keys: ${recallData ? Object.keys(recallData).join(",") : "null"}`,
    );

    // --- graph_stats pass-through correctness ---------------------------
    const graphStatsResult = await client.callTool({ name: "graph_stats", arguments: {} });
    const graphStatsData = toolResultJson(graphStatsResult);
    ok(
      graphStatsData && typeof graphStatsData.nodes === "number" && typeof graphStatsData.edges === "number",
      `graph_stats tool result matches GET /graph/stats's real shape (nodes, edges) — got ${JSON.stringify(graphStatsData)}`,
    );

    // --- reindex validation error surfaces as isError, not a crash ------
    const badReindex = await client.callTool({ name: "reindex", arguments: { collection: "", paths: [] } });
    ok(badReindex.isError === true, "reindex with empty collection/paths surfaces as isError:true, not a crash");

    // --- hard constraint: no destructive tool exists --------------------
    const destructivePattern = /delete|wipe|drop|purge|clear/i;
    const suspiciousTools = names.filter((n) => destructivePattern.test(n));
    ok(
      suspiciousTools.length === 0,
      `no MCP tool name matches a destructive verb pattern (checked: ${names.join(", ")})`,
    );
  } finally {
    await client.close().catch(() => {});
  }

  console.log(fails ? `\n${fails} check(s) failed` : "\nall mcp-server checks passed");
  process.exit(fails ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
