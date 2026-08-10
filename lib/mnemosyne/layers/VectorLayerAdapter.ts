import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ChunkSpan, Hit, RecallFailure, RecallResult, RecallSuccess } from '../interfaces.js';
import type { LayerAdapter, RecallOptions } from './LayerAdapter.js';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_COMMAND = process.env.SWARM_MEMORY_BIN || 'swarm-memory';

interface SwarmMemoryProvenance {
  indexed_at?: string | null;
  content_sha256?: string | null;
  embed_model?: string | null;
  retrieved_at?: string | null;
}

interface SwarmMemoryHit {
  full_path?: string;
  location?: string;
  source?: string;
  chunk_index?: number;
  chunk_span?: [number, number];
  text?: string;
  score?: number;
  provenance?: SwarmMemoryProvenance;
}

interface SwarmMemoryScopeResult {
  scope: string;
  error?: string;
  hits?: SwarmMemoryHit[];
}

interface SwarmMemoryRecallOutput {
  query: string;
  total_hits: number;
  scopes?: SwarmMemoryScopeResult[];
}

export interface VectorLayerAdapterOptions {
  /** Executable to shell out to. Defaults to `SWARM_MEMORY_BIN` or `swarm-memory` on PATH. */
  command?: string;
  /** Timeout for the swarm-memory shell exec, in milliseconds. Qdrant Cloud can be slow. */
  timeoutMs?: number;
}

/**
 * Wraps the `swarm-memory` CLI for semantic recall. Shells out to
 * `swarm-memory recall <query> --json` and maps its output to Mnemosyne
 * provenance — never imports swarm-memory as a library, since the CLI is the
 * stable contract between the two projects.
 *
 * Story: s2-05-vector-layer-adapter (epic: mnemosyne-operational-slice-2)
 */
export class VectorLayerAdapter implements LayerAdapter {
  readonly layer = 'vector' as const;

  private readonly command: string;
  private readonly timeoutMs: number;

  constructor(options: VectorLayerAdapterOptions = {}) {
    this.command = options.command ?? DEFAULT_COMMAND;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async recall(query: string, options: RecallOptions = {}): Promise<RecallResult> {
    const normalizedQuery = query.trim();
    const scope = options.scope ?? 'project';
    const intent = options.intent ?? 'narrow';

    if (!normalizedQuery) {
      return this.failure(query, scope, intent, 'invalid_query', 'query must not be empty');
    }

    let stdout: string;
    try {
      const result = await execFileAsync(this.command, ['recall', normalizedQuery, '--json'], {
        timeout: this.timeoutMs,
      });
      stdout = result.stdout;
    } catch (error) {
      const [code, message] = this.classifyExecError(error);
      return this.failure(query, scope, intent, code, message);
    }

    let parsed: SwarmMemoryRecallOutput;
    try {
      parsed = JSON.parse(stdout) as SwarmMemoryRecallOutput;
    } catch {
      return this.failure(
        query,
        scope,
        intent,
        'invalid_response',
        `swarm-memory returned output that could not be parsed as JSON: ${stdout.slice(0, 200)}`,
      );
    }

    const retrievalTime = new Date().toISOString();
    const hits: Hit[] = [];
    for (const scopeResult of parsed.scopes ?? []) {
      for (const hit of scopeResult.hits ?? []) {
        hits.push(this.toHit(hit, retrievalTime));
      }
    }

    return {
      ok: true,
      query,
      scope,
      intent,
      hits,
      layers_queried: ['vector'],
      layers_skipped: [],
      escalated: false,
      degraded: false,
    } satisfies RecallSuccess;
  }

  private toHit(hit: SwarmMemoryHit, fallbackRetrievalTime: string): Hit {
    const chunkSpan: ChunkSpan | null =
      hit.chunk_index === undefined
        ? null
        : {
            index: hit.chunk_index,
            ...(hit.chunk_span ? { start: hit.chunk_span[0], end: hit.chunk_span[1] } : {}),
          };

    return {
      content: hit.text ?? '',
      provenance: {
        layer: 'vector',
        source: hit.full_path ?? hit.location ?? hit.source ?? 'unknown',
        chunk_span: chunkSpan,
        index_timestamp: hit.provenance?.indexed_at ?? null,
        content_hash: hit.provenance?.content_sha256 ?? null,
        embedder: hit.provenance?.embed_model ?? null,
        retrieval_time: hit.provenance?.retrieved_at ?? fallbackRetrievalTime,
      },
      ...(hit.score === undefined ? {} : { score: hit.score }),
    };
  }

  private classifyExecError(error: unknown): [string, string] {
    const err = error as {
      code?: unknown;
      killed?: boolean;
      signal?: string | null;
      stderr?: string;
      message?: string;
    };

    if (err?.code === 'ENOENT') {
      return [
        'not_installed',
        `swarm-memory is not installed or not on PATH (command: "${this.command}")`,
      ];
    }

    if (err?.killed === true || err?.signal === 'SIGTERM') {
      return ['timeout', `swarm-memory recall timed out after ${this.timeoutMs}ms`];
    }

    const stderr = typeof err?.stderr === 'string' ? err.stderr.trim() : '';
    const message =
      stderr || (typeof err?.message === 'string' ? err.message : 'swarm-memory recall failed');
    return ['swarm_memory_error', message];
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
        layer: 'vector',
        message,
        code,
      },
    };
  }
}
