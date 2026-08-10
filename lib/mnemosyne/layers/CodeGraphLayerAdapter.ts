import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import type { Hit, RecallFailure, RecallResult, RecallSuccess } from '../interfaces.js';
import type { LayerAdapter, RecallOptions } from './LayerAdapter.js';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_COMMAND = process.env.SWARM_MEMORY_BIN || 'swarm-memory';

interface SwarmMemoryImpactHit {
  node?: string;
  node_type?: string;
  depth?: number;
  via?: string;
}

interface GraphEdgeRow {
  src: string;
  predicate: string;
  dst: string;
  origin: string;
  created_at: string;
}

interface TraversedEdge extends GraphEdgeRow {
  depth: number;
  via: string;
}

export interface CodeGraphLayerAdapterOptions {
  /** Executable to shell out to. Defaults to `SWARM_MEMORY_BIN` or `swarm-memory` on PATH. */
  command?: string;
  /** Timeout for the swarm-memory graph shell exec, in milliseconds. */
  timeoutMs?: number;
  /** Explicit swarm-memory graph SQLite path. Defaults to common swarm-memory data paths. */
  dbPath?: string;
}

/**
 * Wraps swarm-memory's code/docs impact graph. The primary contract is the
 * CLI (`swarm-memory graph impact <node> --json`); if that CLI path is not
 * available, the adapter opens swarm-memory's SQLite graph read-only and
 * walks reverse edges (`dst -> src`) to answer "what depends on this?".
 *
 * Story: s2-07-code-graph-layer-adapter (epic: mnemosyne-operational-slice-2)
 */
export class CodeGraphLayerAdapter implements LayerAdapter {
  readonly layer = 'code-graph' as const;

  private readonly command: string;
  private readonly timeoutMs: number;
  private readonly dbPath: string | undefined;

  constructor(options: CodeGraphLayerAdapterOptions = {}) {
    this.command = options.command ?? DEFAULT_COMMAND;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.dbPath = options.dbPath;
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
      const hits = await this.recallViaCli(normalizedQuery, retrievalTime, options.limit);
      return this.success(query, scope, intent, hits, false);
    } catch (cliError) {
      try {
        const hits = this.recallViaSqlite(normalizedQuery, retrievalTime, options.limit);
        return this.success(query, scope, intent, hits, true);
      } catch (sqliteError) {
        const cliMessage = this.errorMessage(cliError);
        const sqliteMessage = this.errorMessage(sqliteError);
        return this.failure(
          query,
          scope,
          intent,
          'graph_unavailable',
          `code-graph unavailable: CLI failed (${cliMessage}); SQLite fallback failed (${sqliteMessage})`,
        );
      }
    }
  }

  private async recallViaCli(
    query: string,
    retrievalTime: string,
    limit = Number.POSITIVE_INFINITY,
  ): Promise<Hit[]> {
    const result = await execFileAsync(this.command, ['graph', 'impact', query, '--json'], {
      timeout: this.timeoutMs,
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error(
        `swarm-memory graph returned output that could not be parsed as JSON: ${result.stdout.slice(0, 200)}`,
      );
    }

    if (!Array.isArray(parsed)) {
      throw new Error('swarm-memory graph impact JSON must be an array');
    }

    return parsed
      .slice(0, limit)
      .map((hit) => this.cliHitToHit(hit as SwarmMemoryImpactHit, retrievalTime));
  }

  private cliHitToHit(hit: SwarmMemoryImpactHit, retrievalTime: string): Hit {
    const source = hit.node ?? 'unknown';
    const via = hit.via ?? source;

    return {
      content: via,
      provenance: {
        layer: 'code-graph',
        source,
        chunk_span: null,
        index_timestamp: null,
        content_hash: null,
        embedder: null,
        retrieval_time: retrievalTime,
      },
    };
  }

  private recallViaSqlite(
    query: string,
    retrievalTime: string,
    limit = Number.POSITIVE_INFINITY,
  ): Hit[] {
    const dbPath = this.resolveDbPath();
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });

    try {
      const rows = this.walkReverseEdges(db, query, limit);
      return rows.map((row) => this.edgeToHit(row, retrievalTime));
    } finally {
      db.close();
    }
  }

  private walkReverseEdges(db: Database.Database, query: string, limit: number): TraversedEdge[] {
    const selectIncoming = db.prepare<string, GraphEdgeRow>(
      'SELECT src, predicate, dst, origin, created_at FROM edges WHERE dst = ? ORDER BY created_at, src, predicate',
    );
    const hits: TraversedEdge[] = [];
    const seenNodes = new Set<string>([query]);
    const queue: Array<{ node: string; depth: number; via: string }> = [
      { node: query, depth: 0, via: query },
    ];

    while (queue.length > 0 && hits.length < limit) {
      const current = queue.shift();
      if (!current) {
        break;
      }

      const edges = selectIncoming.all(current.node);
      for (const edge of edges) {
        if (hits.length >= limit) {
          break;
        }

        const via = `${edge.src} --${edge.predicate}--> ${current.via}`;
        const traversed = { ...edge, depth: current.depth + 1, via };
        hits.push(traversed);

        if (!seenNodes.has(edge.src)) {
          seenNodes.add(edge.src);
          queue.push({ node: edge.src, depth: traversed.depth, via });
        }
      }
    }

    return hits;
  }

  private edgeToHit(edge: TraversedEdge, retrievalTime: string): Hit {
    return {
      content: edge.via,
      provenance: {
        layer: 'code-graph',
        source: edge.src,
        chunk_span: null,
        index_timestamp: edge.created_at || null,
        content_hash: null,
        embedder: null,
        retrieval_time: retrievalTime,
      },
    };
  }

  private resolveDbPath(): string {
    if (this.dbPath !== undefined) {
      return expandHome(this.dbPath);
    }

    if (process.env.SWARM_MEMORY_GRAPH_DB !== undefined) {
      return expandHome(process.env.SWARM_MEMORY_GRAPH_DB);
    }

    const candidates = [
      '~/.local/share/swarm-memory/graph.sqlite',
      '~/.config/swarm-memory/graph.db',
      '~/.config/swarm-memory/graph.sqlite',
    ].filter((candidate): candidate is string => candidate !== undefined && candidate.length > 0);

    for (const candidate of candidates) {
      const resolved = expandHome(candidate);
      if (existsSync(resolved)) {
        return resolved;
      }
    }

    return expandHome(candidates[0] ?? '~/.local/share/swarm-memory/graph.sqlite');
  }

  private success(
    query: string,
    scope: RecallSuccess['scope'],
    intent: RecallSuccess['intent'],
    hits: Hit[],
    degraded: boolean,
  ): RecallSuccess {
    return {
      ok: true,
      query,
      scope,
      intent,
      hits,
      layers_queried: ['code-graph'],
      layers_skipped: [],
      escalated: false,
      degraded,
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
      error: {
        layer: 'code-graph',
        message,
        code,
      },
    };
  }

  private errorMessage(error: unknown): string {
    const err = error as {
      code?: unknown;
      killed?: boolean;
      signal?: string | null;
      stderr?: string;
      message?: string;
    };

    if (err?.code === 'ENOENT') {
      return `swarm-memory is not installed or not on PATH (command: "${this.command}")`;
    }

    if (err?.killed === true || err?.signal === 'SIGTERM') {
      return `swarm-memory graph impact timed out after ${this.timeoutMs}ms`;
    }

    const stderr = typeof err?.stderr === 'string' ? err.stderr.trim() : '';
    return stderr || (typeof err?.message === 'string' ? err.message : 'unknown error');
  }
}

function expandHome(input: string): string {
  if (input === '~') {
    return homedir();
  }

  if (input.startsWith('~/')) {
    return path.join(homedir(), input.slice(2));
  }

  return input;
}
