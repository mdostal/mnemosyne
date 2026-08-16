#!/usr/bin/env node
// bin/mnemosyne-mcp.mjs — the MCP harness surface (mcp-01-server).
//
// Third thin transport wrapper over Mnemosyne's actions, alongside
// src/server.mjs's HTTP API and bin/mnemosyne-skill-helper.mjs's CLI
// pass-throughs. Exposes recall/remember/grep/reindex/graph-*/persona-* as
// MCP tools over stdio (the transport Claude Desktop / Claude Code MCP
// configs expect for a locally-launched server: one process, stdio, no port
// to manage).
//
// This file contains NO business logic of its own — every tool handler
// below is a direct call into bin/mnemosyne-skill-helper.mjs's existing,
// already-tested action functions (recallAction/rememberAction/grepAction/
// reindexAction/graphStatsAction/graphEdgesAction/graphImpactAction/
// graphDepsAction) and ensureRunning(), which already do exactly the right
// thing: ensure the underlying Mnemosyne HTTP service is running (starting
// it if needed) and fetch() against it. Duplicating that logic here would
// reopen every guardrail already closed in engine.mjs (loud failure, full
// provenance, no collection wipe) — see SERVICE.md.
//
// ONE deliberate, documented exception (la-02-graphify-adapter, extended by
// cr-01-graphify-default-layer): the four graph_* tools below are wired
// against bin/graphify-bridge.mjs instead of the skill-helper's
// swarm-memory-backed graph*Action functions whenever isGraphifyConfigured()
// says so (see wireGraphTools()) — graphify-bridge.mjs is its own small,
// separately-tested module (not business logic inlined here), the
// zero-dep-JS-side counterpart to lib/mnemosyne/layers/GraphifyLayerAdapter.ts.
// Every other tool is unaffected. isGraphifyConfigured() is a SOFT default,
// not a plain "did MNEMOSYNE_LAYERS mention graphify" check: MNEMOSYNE_LAYERS
// entirely unset now tries graphify first (if its binary is on PATH), only
// falling back to the swarm-memory-backed behavior (with a logged warning)
// when it isn't. An explicit MNEMOSYNE_LAYERS that names a different single
// layer (e.g. just "vector") still gets byte-for-byte the pre-existing
// swarm-memory-backed behavior, unaffected — see bin/graphify-bridge.mjs's
// isGraphifyConfigured() doc comment for the exact three-case gating.
//
// No tool below maps to Qdrant collection deletion/wipe. There is no such
// verb in the swarm-memory CLI, in engine.mjs, or in the skill-helper's
// action set, and none is added here.
//
// Usage (stdio MCP server — launched by an MCP client, not run standalone):
//   node bin/mnemosyne-mcp.mjs
//
// PORT env (default 8477) — same convention as every other surface in this repo.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  DEFAULT_PORT,
  ensureRunning,
  recallAction,
  rememberAction,
  grepAction,
  reindexAction,
  graphStatsAction,
  graphEdgesAction,
  graphImpactAction,
  graphDepsAction,
  personaSyncAction,
  personaSeedAction,
  personaShowAction,
} from "./mnemosyne-skill-helper.mjs";
import {
  isGraphifyConfigured,
  graphifyStatsAction,
  graphifyEdgesAction,
  graphifyImpactAction,
  graphifyDepsAction,
} from "./graphify-bridge.mjs";

function textResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function errorResult(error) {
  return {
    content: [{ type: "text", text: `Error: ${error.message || String(error)}` }],
    isError: true,
  };
}

// wrapAction — every tool handler below follows this exact shape: run the
// underlying skill-helper action, JSON-stringify its result as the tool's
// text content, and turn a thrown error into an isError:true result (never
// let a rejected fetch() crash the MCP server process).
function wrapAction(port, fn) {
  return async (args) => {
    try {
      const result = await fn(port, args);
      return textResult(result);
    } catch (e) {
      return errorResult(e);
    }
  };
}

export function createServer({ port = DEFAULT_PORT } = {}) {
  const server = new McpServer({ name: "mnemosyne", version: "0.1.0" });

  server.registerTool(
    "recall",
    {
      title: "Recall",
      description:
        "Semantic recall with surrounding context and full provenance, escalating vector -> file on zero hits.",
      inputSchema: {
        query: z.string().describe("The search query"),
        scope: z.string().optional().describe("Scope to search (defaults to the engine default)"),
        hits: z.number().optional().describe("Max hits to return"),
        escalate: z.boolean().optional().describe("Escalate up the scope ladder on zero hits"),
        min_score: z.number().optional().describe("Minimum relevance score"),
        radius: z.number().optional().describe("Surrounding-context radius"),
      },
    },
    wrapAction(port, recallAction),
  );

  server.registerTool(
    "remember",
    {
      title: "Remember",
      description: "Write-back: persists a note and indexes it into the scope's collection so it's immediately recallable.",
      inputSchema: {
        text: z.string().describe("The content to remember"),
        scope: z.string().optional().describe("Scope to write into (defaults to 'personal')"),
        tag: z.string().optional().describe("A short tag for the note filename"),
      },
    },
    wrapAction(port, rememberAction),
  );

  server.registerTool(
    "grep",
    {
      title: "Grep",
      description: "Keyword scroll (exact-string, no embedder) — the reliable path for identifiers semantic recall misses.",
      inputSchema: {
        query: z.string().describe("The exact string to search for"),
        scope: z.string().optional().describe("Scope to search"),
        hits: z.number().optional().describe("Max hits to return"),
        escalate: z.boolean().optional().describe("Escalate up the scope ladder on zero hits"),
        radius: z.number().optional().describe("Surrounding-context radius"),
      },
    },
    wrapAction(port, grepAction),
  );

  server.registerTool(
    "reindex",
    {
      title: "Reindex",
      description:
        "Targeted reindex: swarm-memory index <collection> <paths...> with default pruning. Requires an explicit collection and >=1 path — no reindex-everything mode.",
      inputSchema: {
        collection: z.string().describe("The target Qdrant collection"),
        paths: z.array(z.string()).min(1).describe("One or more file/directory paths to index"),
      },
    },
    wrapAction(port, reindexAction),
  );

  // wireGraphTools — la-02-graphify-adapter, soft-defaulted by
  // cr-01-graphify-default-layer: the four graph_* tools below read
  // graphify's graph.json (via bin/graphify-bridge.mjs) instead of proxying
  // to the swarm-memory-backed GET /graph/* routes whenever
  // isGraphifyConfigured() says so -- true when MNEMOSYNE_LAYERS explicitly
  // names "graphify", OR when MNEMOSYNE_LAYERS is entirely unset AND the
  // `graphify` binary is on PATH (soft default; a logged warning + the
  // pre-existing swarm-memory-backed pass-throughs otherwise, never a hard
  // failure). An explicit MNEMOSYNE_LAYERS naming a different single layer
  // keeps today's exact skill-helper pass-through behavior, unaffected.
  // Response *shape* is identical either way (nodes/edges/edges_by_origin/db
  // for stats; src/predicate/dst/origin/created_at for edges;
  // node/node_type/depth/via for impact/deps) so no MCP-side schema change
  // was needed to add graphify coverage.
  const useGraphify = isGraphifyConfigured();

  server.registerTool(
    "graph_stats",
    {
      title: "Graph stats",
      description: useGraphify
        ? "Graphify graph size + edge-origin breakdown (graphify graph.json)."
        : "Impact graph size + origin breakdown (swarm-memory graph stats).",
      inputSchema: {},
    },
    useGraphify ? wrapAction(port, () => graphifyStatsAction(port)) : wrapAction(port, () => graphStatsAction(port)),
  );

  server.registerTool(
    "graph_edges",
    {
      title: "Graph edges",
      description: "List impact-graph edges, optionally only those touching a given node.",
      inputSchema: {
        node: z.string().optional().describe("Restrict to edges touching this node"),
      },
    },
    useGraphify ? wrapAction(port, graphifyEdgesAction) : wrapAction(port, graphEdgesAction),
  );

  server.registerTool(
    "graph_impact",
    {
      title: "Graph impact",
      description: "Reverse closure: what is affected if this node changes.",
      inputSchema: {
        node: z.string().describe("The node to inspect"),
        depth: z.number().optional().describe("Traversal depth"),
      },
    },
    useGraphify
      ? wrapAction(port, (p, { node, depth }) => graphifyImpactAction(p, node, { depth }))
      : wrapAction(port, (p, { node, depth }) => graphImpactAction(p, node, { depth })),
  );

  server.registerTool(
    "graph_deps",
    {
      title: "Graph deps",
      description: "Forward closure: what this node depends on.",
      inputSchema: {
        node: z.string().describe("The node to inspect"),
        depth: z.number().optional().describe("Traversal depth"),
      },
    },
    useGraphify
      ? wrapAction(port, (p, { node, depth }) => graphifyDepsAction(p, node, { depth }))
      : wrapAction(port, (p, { node, depth }) => graphDepsAction(p, node, { depth })),
  );

  // persona_* tools (mnemosyne-persona-mcp-tools) -- unlike every tool above,
  // these never fetch() the HTTP API at all; they shell out to the already-
  // tested bin/mnemosyne-persona.mjs CLI (via mnemosyne-skill-helper.mjs's
  // personaSyncAction/personaSeedAction/personaShowAction), since Layer 1
  // persona sync/seed/show has no HTTP route (see that file's header for
  // why). `port` is still threaded through wrapAction for a uniform handler
  // shape; these three actions ignore it.

  server.registerTool(
    "persona_sync",
    {
      title: "Persona sync",
      description:
        "Write resolved Layer 1 persona content into a repo's harness files (CLAUDE.md/AGENTS.md/GEMINI.md). --repo is always the write target for every tier; for the 3 global tiers (top-orchestrator/company-director/project-orchestrator) content comes from the global persona store, not from repo. Use dryRun to preview with zero filesystem writes.",
      inputSchema: {
        repo: z.string().describe("Path to the target repo whose harness files get synced"),
        tier: z.string().describe("One of: top-orchestrator, company-director, project-orchestrator, code-architect"),
        scopeId: z.string().describe("The persona's scope identifier"),
        dryRun: z.boolean().optional().describe("Compute the would-be diff only, with zero filesystem writes"),
      },
    },
    wrapAction(port, personaSyncAction),
  );

  server.registerTool(
    "persona_seed",
    {
      title: "Persona seed",
      description:
        "Idempotently seed the 3 global tiers (top-orchestrator/company-director/project-orchestrator) from the hardcoded TIER_CONTENT default into the global persona store (~/.mnemosyne/personas), skipping any tier already present.",
      inputSchema: {
        root: z.string().optional().describe("Override the global persona store's root (defaults to ~/.mnemosyne/personas)"),
        scopeId: z.string().optional().describe("Override the seed scopeId (defaults to 'default')"),
      },
    },
    wrapAction(port, personaSeedAction),
  );

  server.registerTool(
    "persona_show",
    {
      title: "Persona show",
      description:
        "Read-only, live fetch of a global-tier persona's real, current content straight off the global persona store. No harness file is touched, no lock is taken, nothing is cached. Only valid for top-orchestrator/company-director/project-orchestrator -- code-architect personas live in a repo-local store this tool does not read.",
      inputSchema: {
        tier: z.string().describe("One of: top-orchestrator, company-director, project-orchestrator"),
        scopeId: z.string().describe("The persona's scope identifier"),
      },
    },
    wrapAction(port, (p, { tier, scopeId }) => personaShowAction(p, tier, scopeId)),
  );

  return server;
}

async function main() {
  const port = DEFAULT_PORT;

  // Same auto-start contract as the skill harness: never spawn a second
  // instance if one is already healthy, start bin/mnemosyne detached and
  // wait for it to go green if not. Errors here are fatal — an MCP server
  // that silently can't reach its own backend is worse than one that fails
  // loudly at startup.
  const readiness = await ensureRunning({ port });
  process.stderr.write(
    `[mnemosyne-mcp] ${readiness.started ? `started mnemosyne on port ${port}` : "mnemosyne already running"} — UI: ${readiness.ui}\n`,
  );

  const server = createServer({ port });
  await server.connect(new StdioServerTransport());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    process.stderr.write(`[mnemosyne-mcp] fatal: ${e.message || e}\n`);
    process.exit(1);
  });
}
