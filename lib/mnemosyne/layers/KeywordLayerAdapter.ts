import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ChunkSpan, Hit, RecallFailure, RecallResult, RecallSuccess } from '../interfaces.js';
import type { LayerAdapter, RecallOptions } from './LayerAdapter.js';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_COMMAND = process.env.SWARM_MEMORY_BIN || 'swarm-memory';

interface SwarmMemoryGrepProvenance {
  indexed_at?: string | null;
  content_sha256?: string | null;
  embed_model?: string | null;
}

interface SwarmMemoryGrepHit {
  full_path?: string;
  location?: string;
  source?: string;
  chunk_index?: number;
  chunk_span?: [number, number] | null;
  text?: string;
  score?: number | null;
  provenance?: SwarmMemoryGrepProvenance;
}

interface SwarmMemoryGrepScopeResult {
  scope: string;
  collection?: string;
  error?: string;
  hits?: SwarmMemoryGrepHit[];
}

// `swarm-memory grep --json`'s envelope is a top-level ARRAY of
// {scope, collection, hits}, structurally different from `recall --json`'s
// {query, total_hits, scopes} object (VectorLayerAdapter's
// SwarmMemoryRecallOutput) -- confirmed by running the real binary live
// against this repo's own corpus. Do not conflate the two shapes.
type SwarmMemoryGrepOutput = SwarmMemoryGrepScopeResult[];

export interface KeywordLayerAdapterOptions {
  /** Executable to shell out to. Defaults to `SWARM_MEMORY_BIN` or `swarm-memory` on PATH. */
  command?: string;
  /** Timeout for the swarm-memory shell exec, in milliseconds. */
  timeoutMs?: number;
}

/**
 * Wraps the `swarm-memory` CLI for exact/keyword recall. Shells out to
 * `swarm-memory grep <query> --json` and maps its output to Mnemosyne
 * provenance -- mirrors `VectorLayerAdapter`'s EXACT shell-out pattern
 * (command resolution, error-handling shape, loud-failure conventions),
 * just calling `grep` instead of `recall`. Never imports swarm-memory as a
 * library, matching VectorLayerAdapter's own reasoning: the CLI is the
 * stable contract between the two projects.
 *
 * NOT the same mechanism as `FileLayerAdapter` -- that is LOCAL-filesystem
 * grep over a configured root directory on disk. This adapter searches the
 * full remote Qdrant-indexed corpus the same way `VectorLayerAdapter` does,
 * just via keyword/exact-match instead of dense-vector similarity.
 *
 * Recall-only: `swarm-memory grep` has no write counterpart, so this
 * adapter (like `FileLayerAdapter`/`CodeGraphLayerAdapter`) implements no
 * `remember()` -- `LayerAdapter.remember` is optional for exactly this
 * reason.
 *
 * Story: kw-02-ts-client-keyword-layer (epic: mnemosyne-keyword-recall).
 * Real hands-on finding this exists to fix, from
 * docs/qdrant-hybrid-retrieval-experiment.md: dense embeddings cannot
 * reliably distinguish near-identical exact identifiers (e.g. this repo's
 * own real "PAN-8968" vs "PAN-7909" ticket IDs) -- keyword search finds
 * them instantly and exactly. `MnemosyneClient` (client.ts) wires this
 * adapter to run ALONGSIDE `vector`, not as a zero-hit escalation, whenever
 * a consumer's layer stack explicitly configures both.
 */
export class KeywordLayerAdapter implements LayerAdapter {
  readonly layer = 'keyword' as const;

  private readonly command: string;
  private readonly timeoutMs: number;

  constructor(options: KeywordLayerAdapterOptions = {}) {
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
      const result = await execFileAsync(this.command, ['grep', normalizedQuery, '--json'], {
        timeout: this.timeoutMs,
      });
      stdout = result.stdout;
    } catch (error) {
      const [code, message] = this.classifyExecError(error);
      return this.failure(query, scope, intent, code, message);
    }

    let parsed: SwarmMemoryGrepOutput;
    try {
      const rawParsed: unknown = JSON.parse(stdout);
      if (!Array.isArray(rawParsed)) {
        throw new Error('expected a top-level array');
      }
      parsed = rawParsed as SwarmMemoryGrepOutput;
    } catch {
      return this.failure(
        query,
        scope,
        intent,
        'invalid_response',
        `swarm-memory grep returned output that could not be parsed as JSON: ${stdout.slice(0, 200)}`,
      );
    }

    const hits: Hit[] = [];
    for (const scopeResult of parsed) {
      for (const hit of scopeResult.hits ?? []) {
        hits.push(this.toHit(hit));
      }
    }

    return {
      ok: true,
      query,
      scope,
      intent,
      hits,
      layers_queried: ['keyword'],
      layers_skipped: [],
      escalated: false,
      degraded: false,
    } satisfies RecallSuccess;
  }

  private toHit(hit: SwarmMemoryGrepHit): Hit {
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
        layer: 'keyword',
        source: hit.full_path ?? hit.location ?? hit.source ?? 'unknown',
        chunk_span: chunkSpan,
        index_timestamp: hit.provenance?.indexed_at ?? null,
        content_hash: hit.provenance?.content_sha256 ?? null,
        embedder: hit.provenance?.embed_model ?? null,
        // A keyword scan has no ranked retrieval step to timestamp -- real
        // `swarm-memory grep --json` output never includes retrieved_at
        // (only `recall`'s semantic search does). Mirrors
        // interfaces.ts's Provenance.retrieval_time doc comment exactly.
        retrieval_time: null,
      },
      // Real grep hits report `score: null` (no ranking concept) --
      // omit the field entirely rather than surfacing a null score,
      // matching Hit.score's "absent, not null" contract.
      ...(hit.score === undefined || hit.score === null ? {} : { score: hit.score }),
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
      return ['timeout', `swarm-memory grep timed out after ${this.timeoutMs}ms`];
    }

    const stderr = typeof err?.stderr === 'string' ? err.stderr.trim() : '';
    const message =
      stderr || (typeof err?.message === 'string' ? err.message : 'swarm-memory grep failed');
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
        layer: 'keyword',
        message,
        code,
      },
    };
  }
}
