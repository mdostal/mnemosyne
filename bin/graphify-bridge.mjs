#!/usr/bin/env node
// bin/graphify-bridge.mjs — la-02-graphify-adapter's MCP-surface wiring.
//
// bin/mnemosyne-mcp.mjs's graph_stats/graph_edges/graph_impact/graph_deps
// tools normally proxy (via bin/mnemosyne-skill-helper.mjs's action
// functions) to the running Mnemosyne HTTP service's GET /graph/* routes,
// which are backed by src/engine.mjs shelling out to the `swarm-memory`
// CLI. That whole path is the zero-dep JS side of the stack and has no
// reachable dependency on lib/mnemosyne's TypeScript layer registry/
// MnemosyneClient (a plain `node bin/mnemosyne-mcp.mjs` process cannot
// import a `.ts` module directly — no build step/loader is configured for
// this bin, see tsconfig.json's `noEmit: true`).
//
// So this module is a SEPARATE, deliberately small implementation of the
// same four read shapes (stats/edges/impact/deps), reading graphify's
// `graph.json` directly instead of shelling out to `swarm-memory` — the
// zero-dep-JS-side counterpart to lib/mnemosyne/layers/GraphifyLayerAdapter.ts,
// exactly mirroring the pre-existing duality this story's CBA describes
// between CodeGraphLayerAdapter.ts and src/engine.mjs's own graph* functions
// (two thin access paths onto swarm-memory; this is the same architectural
// split applied to graphify instead). bin/mnemosyne-mcp.mjs selects between
// the two implementations per graph_* tool, gated on whether MNEMOSYNE_LAYERS
// configures a "graphify" layer — see wireGraphTools() there.
//
// Never wraps `graphify`'s mutation paths (there are none read-only tools
// need to avoid here beyond graph.json itself, which this module only
// reads, never writes) and never invents data: a missing/unreadable
// graph.json is always a thrown, actionable error (loud failure), never a
// silently empty result.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const INSTALL_HINT = "uv tool install graphifyy";
const PROJECT_URL = "https://github.com/Graphify-Labs/graphify";
const DEFAULT_DEPTH = 2;
const UPDATE_TIMEOUT_MS = 60_000;

// --- MNEMOSYNE_LAYERS gating -------------------------------------------------
//
// Mirrors lib/mnemosyne/layers/config.ts's MNEMOSYNE_LAYERS shape
// ({ layers: [{ name, options? }, ...] }) without importing TS — this file
// only ever reads the env var as plain JSON.

export function readLayersConfig(env = process.env) {
  const raw = env.MNEMOSYNE_LAYERS;
  if (!raw || !raw.trim()) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`MNEMOSYNE_LAYERS is set but is not valid JSON: ${error.message}`);
  }
  if (!parsed || !Array.isArray(parsed.layers)) {
    throw new Error('MNEMOSYNE_LAYERS is set but does not match { layers: [{ name: string, options?: object }, ...] }');
  }
  return parsed;
}

// findGraphifyLayerEntry — returns the { name: "graphify", options? } entry
// from MNEMOSYNE_LAYERS if configured, else null. Never throws on a config
// that simply doesn't mention "graphify" (that's the common, unconfigured
// case, not an error).
export function findGraphifyLayerEntry(env = process.env) {
  const config = readLayersConfig(env);
  if (!config) return null;
  return config.layers.find((entry) => entry && entry.name === "graphify") ?? null;
}

export function isGraphifyConfigured(env = process.env) {
  return findGraphifyLayerEntry(env) !== null;
}

function resolveOptions(env = process.env) {
  const entry = findGraphifyLayerEntry(env);
  const options = (entry && entry.options) || {};
  const repoRoot = path.resolve(options.repoRoot || env.MNEMOSYNE_ROOT_DIR || process.cwd());
  const graphPath = options.graphPath
    ? path.resolve(options.graphPath)
    : path.join(repoRoot, "graphify-out", "graph.json");
  const command = options.command || env.GRAPHIFY_BIN || "graphify";
  const autoUpdate = options.autoUpdate !== false;
  return { repoRoot, graphPath, command, autoUpdate };
}

// --- loud failure -------------------------------------------------------------

function missingBinaryError(command) {
  return new Error(
    `graphify is not installed or not found on PATH (command: "${command}"). ` +
      `Install it with: ${INSTALL_HINT} -- see ${PROJECT_URL}`,
  );
}

function describeExecError(error, command) {
  if (error?.code === "ENOENT") {
    return missingBinaryError(command).message;
  }
  if (error?.killed === true || error?.signal === "SIGTERM") {
    return `graphify update timed out`;
  }
  const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
  return stderr || error?.message || "unknown error";
}

// --- graph.json load ----------------------------------------------------------

async function loadGraph(opts) {
  if (!existsSync(opts.graphPath)) {
    if (!opts.autoUpdate) {
      throw new Error(
        `graphify graph.json not found at ${opts.graphPath} and autoUpdate is disabled -- ` +
          `run \`graphify update ${opts.repoRoot}\` first.`,
      );
    }
    try {
      await execFileAsync(opts.command, ["update", opts.repoRoot], { timeout: UPDATE_TIMEOUT_MS });
    } catch (error) {
      throw new Error(`graphify update ${opts.repoRoot} failed: ${describeExecError(error, opts.command)}`);
    }
    if (!existsSync(opts.graphPath)) {
      throw new Error(
        `graphify update ${opts.repoRoot} completed but ${opts.graphPath} still does not exist -- ` +
          "pass an explicit graphPath in MNEMOSYNE_LAYERS's graphify options.",
      );
    }
  }

  let raw;
  try {
    raw = await readFile(opts.graphPath, "utf8");
  } catch (error) {
    throw new Error(`could not read graphify graph.json at ${opts.graphPath}: ${error.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`graphify graph.json at ${opts.graphPath} could not be parsed as JSON`);
  }

  if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.links)) {
    throw new Error(`graphify graph.json at ${opts.graphPath} has an unexpected shape (missing nodes[]/links[])`);
  }

  return parsed;
}

function matchNodeIds(graph, query) {
  const needle = String(query).toLowerCase();
  const exact = graph.nodes.filter(
    (node) =>
      node.id?.toLowerCase() === needle ||
      node.label?.toLowerCase() === needle ||
      node.norm_label?.toLowerCase() === needle,
  );
  const matches = exact.length > 0
    ? exact
    : graph.nodes.filter(
        (node) => node.label?.toLowerCase().includes(needle) || node.norm_label?.toLowerCase().includes(needle),
      );
  return new Set(matches.map((node) => node.id));
}

function labelOf(graph, id) {
  return graph.nodes.find((node) => node.id === id)?.label ?? id;
}

function fileTypeOf(graph, id) {
  return graph.nodes.find((node) => node.id === id)?.file_type ?? null;
}

// --- public actions -------------------------------------------------------
//
// Same (port, args) call shape as bin/mnemosyne-skill-helper.mjs's
// graph*Action functions so bin/mnemosyne-mcp.mjs's wrapAction() can swap
// between the two without changing its own wiring shape. `port` is unused
// here -- this bridge never talks to the HTTP service, it reads graph.json
// directly.

// Response envelopes below deliberately match src/server.mjs's real GET
// /graph/* route shapes exactly (confirmed live: `{ ...stats, took_ms }` for
// stats; `{ node, count, edges/impact/deps, took_ms }` for the other three)
// -- that's the actual shape MCP callers receive today via
// bin/mnemosyne-skill-helper.mjs's graph*Action pass-throughs, so AC4
// ("same response shape consumers already expect") means this envelope,
// not a bare array.

export async function graphifyStatsAction(_port, _args = {}, env = process.env) {
  const t0 = Date.now();
  const opts = resolveOptions(env);
  const graph = await loadGraph(opts);
  const edgesByOrigin = {};
  for (const link of graph.links) {
    const origin = link._origin ?? "unknown";
    edgesByOrigin[origin] = (edgesByOrigin[origin] ?? 0) + 1;
  }
  return {
    nodes: graph.nodes.length,
    edges: graph.links.length,
    edges_by_origin: edgesByOrigin,
    db: opts.graphPath,
    took_ms: Date.now() - t0,
  };
}

export async function graphifyEdgesAction(_port, { node } = {}, env = process.env) {
  const t0 = Date.now();
  const opts = resolveOptions(env);
  const graph = await loadGraph(opts);

  let links = graph.links;
  if (node) {
    const ids = matchNodeIds(graph, node);
    links = links.filter((link) => ids.has(link.source) || ids.has(link.target));
  }

  const edges = links.map((link) => ({
    src: labelOf(graph, link.source),
    predicate: link.relation,
    dst: labelOf(graph, link.target),
    origin: link._origin ?? null,
    // graphify's graph.json carries no per-edge timestamp (unlike
    // swarm-memory's edges.created_at) -- explicit null, not a fabricated
    // value.
    created_at: null,
  }));

  return { node: node || null, count: edges.length, edges, took_ms: Date.now() - t0 };
}

function requireNode(node, who) {
  if (!node || !String(node).trim()) {
    const err = new Error(`${who}: node is required`);
    err.status = 400;
    throw err;
  }
}

async function traverse(env, node, { depth } = {}, direction) {
  requireNode(node, direction === "reverse" ? "graph impact" : "graph deps");
  const opts = resolveOptions(env);
  const graph = await loadGraph(opts);
  const maxDepth = depth != null ? Number(depth) : DEFAULT_DEPTH;

  const startIds = matchNodeIds(graph, node);
  if (startIds.size === 0) {
    return []; // unknown node -> clean empty result, matching swarm-memory's own behavior
  }

  const results = [];
  const seen = new Set(startIds);
  let frontier = [...startIds].map((id) => ({ id, via: labelOf(graph, id) }));

  for (let d = 1; d <= maxDepth && frontier.length > 0; d += 1) {
    const nextFrontier = [];
    for (const current of frontier) {
      const edges =
        direction === "reverse"
          ? graph.links.filter((link) => link.target === current.id)
          : graph.links.filter((link) => link.source === current.id);

      for (const edge of edges) {
        const neighborId = direction === "reverse" ? edge.source : edge.target;
        const neighborLabel = labelOf(graph, neighborId);
        // Forward (deps): current genuinely points AT neighbor, so
        // "current --relation--> neighbor" reads correctly (current depends
        // on neighbor). Reverse (impact): the real edge direction is
        // neighbor -> current (neighbor calls/imports/references current),
        // so the chain must read "neighbor --relation--> current" or it
        // silently reverses the relationship's meaning.
        const via =
          direction === "reverse"
            ? `${neighborLabel} --${edge.relation}--> ${current.via}`
            : `${current.via} --${edge.relation}--> ${neighborLabel}`;

        results.push({
          node: neighborLabel,
          node_type: fileTypeOf(graph, neighborId),
          depth: d,
          via,
        });

        if (!seen.has(neighborId)) {
          seen.add(neighborId);
          nextFrontier.push({ id: neighborId, via });
        }
      }
    }
    frontier = nextFrontier;
  }

  return results;
}

export async function graphifyImpactAction(_port, node, opts = {}, env = process.env) {
  const t0 = Date.now();
  const impact = await traverse(env, node, opts, "reverse");
  return { node, count: impact.length, impact, took_ms: Date.now() - t0 };
}

export async function graphifyDepsAction(_port, node, opts = {}, env = process.env) {
  const t0 = Date.now();
  const deps = await traverse(env, node, opts, "forward");
  return { node, count: deps.length, deps, took_ms: Date.now() - t0 };
}
