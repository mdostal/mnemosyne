import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  ChunkSpan,
  Hit,
  RecallFailure,
  RecallResult,
  RecallSuccess,
  RememberFailure,
  RememberResult,
  RememberSuccess,
} from '../interfaces.js';
import type { LayerAdapter, RecallOptions, RememberOptions } from './LayerAdapter.js';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 5_000;
// remember()'s index step shells to the live Qdrant Cloud SSOT and can
// legitimately take several seconds (observed ~2-3s for a single-file
// index in this repo's JS-side equivalent, src/engine.mjs) — a much longer
// floor than DEFAULT_TIMEOUT_MS, which is sized for a single recall() call.
const DEFAULT_INDEX_TIMEOUT_MS = 30_000;
const DEFAULT_COMMAND = process.env.SWARM_MEMORY_BIN || 'swarm-memory';

interface SwarmMemoryConfig {
  scopes?: Record<string, string>;
}

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
  /** Timeout for remember()'s index step specifically. Defaults to `DEFAULT_INDEX_TIMEOUT_MS`. */
  indexTimeoutMs?: number;
  /** Directory remember() writes note files to before indexing. Defaults to `MNEMOSYNE_NOTES_DIR` env or `~/.local/share/mnemosyne/notes`. */
  notesDirectory?: string;
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
  private readonly indexTimeoutMs: number;
  private readonly notesDirectory: string;

  constructor(options: VectorLayerAdapterOptions = {}) {
    this.command = options.command ?? DEFAULT_COMMAND;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.indexTimeoutMs = options.indexTimeoutMs ?? DEFAULT_INDEX_TIMEOUT_MS;
    this.notesDirectory =
      options.notesDirectory ??
      process.env.MNEMOSYNE_NOTES_DIR ??
      path.join(homedir(), '.local', 'share', 'mnemosyne', 'notes');
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

  /**
   * Write content to Qdrant via `swarm-memory index`. Mirrors the
   * already-working, already-tested pattern in this repo's zero-dep JS
   * sibling service (`src/engine.mjs`'s `remember()`): persist a note file,
   * then index it with `--no-prune` (pure-additive — never wipes/prunes any
   * other file's chunks, matches the existing-infrastructure guardrail from
   * `.pHive/cross-cutting-concerns.yaml` and SERVICE.md's hard "never wipe
   * Qdrant collections" rule). Fails loudly (ok:false) on any CLI error or
   * on a report of zero chunks upserted — never a silent no-op success.
   */
  async remember(content: string, options: RememberOptions = {}): Promise<RememberResult> {
    const text = content.trim();
    const scope = options.scope ?? 'project';

    if (!text) {
      return this.rememberFailure('invalid_content', 'content must not be empty');
    }

    let collection: string;
    try {
      const configResult = await execFileAsync(this.command, ['config'], {
        timeout: this.timeoutMs,
      });
      const cfg = JSON.parse(configResult.stdout) as SwarmMemoryConfig;
      const resolved = cfg.scopes?.[scope];
      if (!resolved) {
        return this.rememberFailure(
          'unknown_scope',
          `scope '${scope}' is not configured (known: ${Object.keys(cfg.scopes ?? {}).join(', ')})`,
        );
      }
      collection = resolved;
    } catch (error) {
      const [code, message] = this.classifyExecError(error);
      return this.rememberFailure(code, `config resolution failed: ${message}`);
    }

    await mkdir(this.notesDirectory, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const tag = (options.tag ?? 'note').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40);
    const file = path.join(this.notesDirectory, `${stamp}-${tag}.md`);
    const header = `<!-- remembered via Mnemosyne (TS client) @ ${new Date().toISOString()} scope=${scope} -->\n`;
    await writeFile(file, header + text + '\n', 'utf8');

    let indexOutput: string;
    try {
      const indexResult = await execFileAsync(
        this.command,
        ['index', collection, '--no-prune', file],
        { timeout: this.indexTimeoutMs },
      );
      indexOutput = `${indexResult.stdout}${indexResult.stderr ?? ''}`.trim();
    } catch (error) {
      // The note file is already on disk and is kept regardless — it's the
      // recovery artifact for manual reconciliation if the upsert failed.
      const [code, message] = this.classifyExecError(error);
      return this.rememberFailure(code, `index command errored, file kept at ${file} for recovery: ${message}`);
    }

    const upserted = /upserted\s+(\d+)\s+chunks/i.exec(indexOutput);
    const chunksUpserted = upserted ? Number(upserted[1]) : 0;
    if (!(chunksUpserted > 0)) {
      return this.rememberFailure(
        'no_chunks_upserted',
        `swarm-memory index did not confirm any upserted chunks, file kept at ${file} for recovery: ${
          indexOutput || '(empty output)'
        }`,
      );
    }

    const indexTimestamp = new Date().toISOString();
    return {
      ok: true,
      layer: 'vector',
      provenance: {
        layer: 'vector',
        source: file,
        chunk_span: null,
        index_timestamp: indexTimestamp,
        content_hash: sha256(text),
        embedder: null,
        retrieval_time: null,
      },
    } satisfies RememberSuccess;
  }

  private rememberFailure(code: string, message: string): RememberFailure {
    return { ok: false, error: { layer: 'vector', message, code } };
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

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
