import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Hit, RecallFailure, RecallResult, RecallSuccess } from '../interfaces.js';
import type { LayerAdapter, RecallOptions } from './LayerAdapter.js';

const execFileAsync = promisify(execFile);

const DEFAULT_COMMAND = process.env.GRAPHIFY_BIN || 'graphify';
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_LIMIT = 20;
const INSTALL_HINT = 'uv tool install graphifyy';
const PROJECT_URL = 'https://github.com/Graphify-Labs/graphify';

// --- graphify's real graph.json shape ---------------------------------------
//
// Confirmed by actually installing graphify (`uv tool install graphifyy`)
// and running `graphify update .` against this repo AND against a small
// two-language (Python + TypeScript) fixture repo -- see
// docs/cba-memory-layers.md for the original PoC and
// GraphifyLayerAdapter.test.ts for the fixture-repo verification. Top-level
// keys: {directed, multigraph, graph, nodes, links, hyperedges,
// built_at_commit}. Only `nodes`/`links` matter for recall().

interface GraphifyNode {
  id: string;
  label: string;
  file_type?: string;
  source_file?: string;
  source_location?: string;
  norm_label?: string;
  _origin?: string;
  [key: string]: unknown;
}

interface GraphifyLink {
  source: string;
  target: string;
  relation: string;
  source_file?: string;
  source_location?: string;
  confidence_score?: number;
  _origin?: string;
  [key: string]: unknown;
}

interface GraphifyGraph {
  nodes: GraphifyNode[];
  links: GraphifyLink[];
  [key: string]: unknown;
}

function isGraphifyGraph(value: unknown): value is GraphifyGraph {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { nodes?: unknown }).nodes) &&
    Array.isArray((value as { links?: unknown }).links)
  );
}

export interface GraphifyLayerAdapterOptions {
  /** Executable to shell out to. Defaults to `GRAPHIFY_BIN` or `graphify` on PATH. */
  command?: string;
  /** Directory graphify indexes. Defaults to `process.cwd()`. */
  repoRoot?: string;
  /** Explicit path to graphify's `graph.json`. Defaults to `<repoRoot>/graphify-out/graph.json`. */
  graphPath?: string;
  /** Timeout for the `graphify update` shell exec, in milliseconds. */
  timeoutMs?: number;
  /**
   * Run `graphify update <repoRoot>` when `graph.json` doesn't exist yet.
   * Defaults to true. Never re-runs update on an existing graph.json --
   * recall() is a reader, not a reindex trigger; callers own freshness
   * (e.g. via a reindex/watch flow), matching CodeGraphLayerAdapter's
   * read-only posture.
   */
  autoUpdate?: boolean;
  /** Default cap on hits returned by recall() when the caller doesn't pass options.limit. */
  limit?: number;
}

/**
 * Wraps Graphify (Graphify-Labs/graphify, PyPI `graphifyy`, CLI `graphify`)
 * as a Mnemosyne layer -- deterministic tree-sitter AST parsing across
 * Python/TS/JS/Go/Rust/Java/C/C++/Ruby/C#/Kotlin/Scala (and markdown docs),
 * confirmed via a real PoC (see docs/cba-memory-layers.md: 1297 nodes/2123
 * edges/94 communities on this repo, no LLM required).
 *
 * The primary contract is the CLI (`graphify update <repoRoot>` to build/
 * refresh the graph) plus reading its resulting `graph.json` directly for
 * queries -- graphify's own query subcommands (`affected`, `query`, ...)
 * emit human-readable text, not JSON, so recall() does its own in-memory
 * node/edge lookup over graph.json rather than parsing CLI prose output.
 *
 * Deliberately does NOT use graphify's optional LLM-assisted path (Gemini
 * community labeling / doc-image extraction): `graphify update` with no
 * extra flags is the no-LLM deterministic path the PoC verified, and this
 * adapter never opts into more than that -- see la-02's risk/mitigation on
 * GEMINI_API_KEY environment variance.
 *
 * Registered under the NEW layer name "graphify" (see registry.ts), not a
 * replacement for CodeGraphLayerAdapter's "code-graph" -- that's la-10's
 * job, after an A/B comparison.
 *
 * Story: la-02-graphify-adapter (epic: mnemosyne-layer-architecture-v2)
 */
export class GraphifyLayerAdapter implements LayerAdapter {
  readonly layer = 'graphify' as const;

  private readonly command: string;
  private readonly repoRoot: string;
  private readonly graphPath: string;
  private readonly timeoutMs: number;
  private readonly autoUpdate: boolean;
  private readonly defaultLimit: number;

  constructor(options: GraphifyLayerAdapterOptions = {}) {
    this.command = options.command ?? DEFAULT_COMMAND;
    this.repoRoot = options.repoRoot ?? process.cwd();
    this.graphPath = options.graphPath ?? path.join(this.repoRoot, 'graphify-out', 'graph.json');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.autoUpdate = options.autoUpdate ?? true;
    this.defaultLimit = options.limit ?? DEFAULT_LIMIT;

    // Loud failure, at the earliest possible point: verify the binary is
    // actually resolvable before this adapter is usable at all, rather than
    // waiting for the first recall() to discover it's missing. Never a
    // silent "recall() just returns zero hits forever" failure mode.
    ensureBinaryOnPath(this.command);
  }

  async recall(query: string, options: RecallOptions = {}): Promise<RecallResult> {
    const normalizedQuery = query.trim();
    const scope = options.scope ?? 'project';
    const intent = options.intent ?? 'narrow';

    if (!normalizedQuery) {
      return this.failure(query, scope, intent, 'invalid_query', 'query must not be empty');
    }

    const retrievalTime = new Date().toISOString();

    try {
      const graph = await this.loadGraph();
      const matches = matchNodes(graph.nodes, normalizedQuery);
      const limit = options.limit ?? this.defaultLimit;
      const hits = buildHits(graph, matches, retrievalTime, limit);
      return this.success(query, scope, intent, hits);
    } catch (error) {
      return this.failure(
        query,
        scope,
        intent,
        'graph_unavailable',
        `graphify unavailable: ${errorMessage(error, this.command, this.repoRoot)}`,
      );
    }
  }

  private async loadGraph(): Promise<GraphifyGraph> {
    if (!existsSync(this.graphPath)) {
      if (!this.autoUpdate) {
        throw new Error(
          `graphify graph.json not found at ${this.graphPath} and autoUpdate is disabled -- ` +
            `run \`graphify update ${this.repoRoot}\` first.`,
        );
      }
      await this.runUpdate();
      if (!existsSync(this.graphPath)) {
        throw new Error(
          `graphify update ${this.repoRoot} completed but ${this.graphPath} still does not exist ` +
            '-- graphify may have written its output elsewhere; pass an explicit graphPath option.',
        );
      }
    }

    let raw: string;
    try {
      raw = await readFile(this.graphPath, 'utf8');
    } catch (error) {
      throw new Error(`could not read graphify graph.json at ${this.graphPath}: ${errorMessage(error)}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`graphify graph.json at ${this.graphPath} could not be parsed as JSON`);
    }

    if (!isGraphifyGraph(parsed)) {
      throw new Error(
        `graphify graph.json at ${this.graphPath} has an unexpected shape (missing nodes[]/links[] arrays)`,
      );
    }

    return parsed;
  }

  private async runUpdate(): Promise<void> {
    try {
      // No extra flags: the deterministic, no-LLM path (per the PoC and
      // this adapter's design decision to never opt into the LLM path
      // implicitly).
      await execFileAsync(this.command, ['update', this.repoRoot], { timeout: this.timeoutMs });
    } catch (error) {
      throw new Error(`graphify update ${this.repoRoot} failed: ${errorMessage(error, this.command, this.repoRoot)}`);
    }
  }

  private success(query: string, scope: RecallSuccess['scope'], intent: RecallSuccess['intent'], hits: Hit[]): RecallSuccess {
    return {
      ok: true,
      query,
      scope,
      intent,
      hits,
      layers_queried: ['graphify'],
      layers_skipped: [],
      escalated: false,
      degraded: false,
    };
  }

  private failure(
    query: string,
    scope: RecallFailure['scope'],
    intent: RecallFailure['intent'],
    code: string,
    message: string,
  ): RecallFailure {
    return {
      ok: false,
      query,
      scope,
      intent,
      error: { layer: 'graphify', message, code },
    };
  }
}

// --- binary-on-PATH check ----------------------------------------------------
//
// Pure fs-based lookup (no subprocess) so the check is synchronous and can
// run at construction time. A command containing a path separator is
// treated as an explicit path (checked directly via existsSync, matching
// how a shell resolves `./foo` or `/abs/foo`); a bare command name is
// resolved by scanning PATH, same as `which`.

function ensureBinaryOnPath(command: string): void {
  if (command.includes(path.sep) || (path.sep !== '/' && command.includes('/'))) {
    if (existsSync(command)) {
      return;
    }
    throw missingBinaryError(command);
  }

  const pathEnv = process.env.PATH ?? '';
  const dirs = pathEnv.split(path.delimiter).filter((dir) => dir.length > 0);
  const extensions = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];

  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = path.join(dir, command + ext);
      if (existsSync(candidate)) {
        return;
      }
    }
  }

  throw missingBinaryError(command);
}

function missingBinaryError(command: string): Error {
  return new Error(
    `graphify is not installed or not found on PATH (command: "${command}"). ` +
      `Install it with: ${INSTALL_HINT} -- see ${PROJECT_URL}`,
  );
}

function errorMessage(error: unknown, command?: string, repoRoot?: string): string {
  const err = error as {
    code?: unknown;
    killed?: boolean;
    signal?: string | null;
    stderr?: string;
    message?: string;
  };

  if (err?.code === 'ENOENT') {
    return command
      ? `graphify is not installed or not found on PATH (command: "${command}"). Install it with: ${INSTALL_HINT} -- see ${PROJECT_URL}`
      : `command not found. Install graphify with: ${INSTALL_HINT} -- see ${PROJECT_URL}`;
  }

  if (err?.killed === true || err?.signal === 'SIGTERM') {
    return `graphify update ${repoRoot ?? ''} timed out`.trim();
  }

  const stderr = typeof err?.stderr === 'string' ? err.stderr.trim() : '';
  return stderr || (typeof err?.message === 'string' ? err.message : 'unknown error');
}

// --- recall() query mapping --------------------------------------------------

function matchNodes(nodes: GraphifyNode[], query: string): GraphifyNode[] {
  const needle = query.toLowerCase();

  const exact = nodes.filter(
    (node) =>
      node.id.toLowerCase() === needle ||
      node.label?.toLowerCase() === needle ||
      node.norm_label?.toLowerCase() === needle,
  );
  if (exact.length > 0) {
    return exact;
  }

  return nodes.filter(
    (node) =>
      node.label?.toLowerCase().includes(needle) ||
      node.norm_label?.toLowerCase().includes(needle) ||
      node.source_file?.toLowerCase().includes(needle),
  );
}

function buildHits(graph: GraphifyGraph, matchedNodes: GraphifyNode[], retrievalTime: string, limit: number): Hit[] {
  const hits: Hit[] = [];
  const matchedIds = new Set(matchedNodes.map((node) => node.id));
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));

  for (const node of matchedNodes) {
    if (hits.length >= limit) break;
    hits.push(nodeHit(node, retrievalTime));
  }

  for (const link of graph.links) {
    if (hits.length >= limit) break;
    if (!matchedIds.has(link.source) && !matchedIds.has(link.target)) continue;

    const src = nodesById.get(link.source);
    const dst = nodesById.get(link.target);
    hits.push(linkHit(link, src, dst, retrievalTime));
  }

  return hits.slice(0, limit);
}

function nodeHit(node: GraphifyNode, retrievalTime: string): Hit {
  const source = formatSource(node.source_file, node.source_location);
  return {
    content: `${node.label} (${node.file_type ?? 'unknown'}) -- ${source}`,
    provenance: {
      layer: 'graphify',
      source,
      chunk_span: null,
      index_timestamp: null,
      content_hash: null,
      embedder: null,
      retrieval_time: retrievalTime,
    },
  };
}

function linkHit(link: GraphifyLink, src: GraphifyNode | undefined, dst: GraphifyNode | undefined, retrievalTime: string): Hit {
  const srcLabel = src?.label ?? link.source;
  const dstLabel = dst?.label ?? link.target;
  const source = formatSource(link.source_file, link.source_location);

  const hit: Hit = {
    content: `${srcLabel} --${link.relation}--> ${dstLabel}`,
    provenance: {
      layer: 'graphify',
      source,
      chunk_span: null,
      index_timestamp: null,
      content_hash: null,
      embedder: null,
      retrieval_time: retrievalTime,
    },
  };

  if (typeof link.confidence_score === 'number') {
    hit.score = link.confidence_score;
  }

  return hit;
}

function formatSource(sourceFile?: string, sourceLocation?: string): string {
  if (!sourceFile) return 'unknown';
  return sourceLocation ? `${sourceFile}:${sourceLocation}` : sourceFile;
}
