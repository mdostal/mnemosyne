import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Hit, RecallFailure, RecallResult, RecallSuccess } from '../interfaces.js';
import { DEFAULT_IGNORED_DIRECTORIES, sha256, walk } from './fileWalk.js';
import type { LayerAdapter, RecallOptions } from './LayerAdapter.js';

export interface FileLayerAdapterOptions {
  ignoredDirectories?: Iterable<string>;
}

export class FileLayerAdapter implements LayerAdapter {
  readonly layer = 'file' as const;

  private readonly root: string;
  private readonly ignoredDirectories: Set<string>;

  constructor(targetDirectory: string, options: FileLayerAdapterOptions = {}) {
    this.root = path.resolve(targetDirectory);
    this.ignoredDirectories = new Set(options.ignoredDirectories ?? DEFAULT_IGNORED_DIRECTORIES);
  }

  async recall(query: string, options: RecallOptions = {}): Promise<RecallResult> {
    const normalizedQuery = query.trim();
    const scope = options.scope ?? 'project';
    const intent = options.intent ?? 'narrow';

    if (!normalizedQuery) {
      return this.failure(query, scope, intent, 'invalid_query', 'query must not be empty');
    }

    try {
      const rootStat = await stat(this.root);
      if (!rootStat.isDirectory()) {
        return this.failure(
          query,
          scope,
          intent,
          'not_directory',
          `file layer target is not a directory: ${this.root}`,
        );
      }
    } catch (error) {
      return this.failure(
        query,
        scope,
        intent,
        this.errorCode(error, 'directory_unreachable'),
        `file layer target is unreachable: ${this.root}`,
      );
    }

    const retrievalTime = new Date().toISOString();
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    const hits: Hit[] = [];

    try {
      for await (const filePath of walk(this.root, this.ignoredDirectories)) {
        if (hits.length >= limit) {
          break;
        }

        const content = await readFile(filePath, 'utf8');
        const lines = content.split(/\r?\n/);
        for (const [offset, line] of lines.entries()) {
          if (!line.includes(normalizedQuery)) {
            continue;
          }

          hits.push({
            content: line,
            provenance: {
              layer: 'file',
              source: filePath,
              chunk_span: { index: offset + 1 },
              index_timestamp: null,
              content_hash: sha256(line),
              embedder: null,
              retrieval_time: retrievalTime,
            },
          });

          if (hits.length >= limit) {
            break;
          }
        }
      }
    } catch (error) {
      return this.failure(
        query,
        scope,
        intent,
        this.errorCode(error, 'file_search_failed'),
        `file layer search failed under ${this.root}`,
      );
    }

    return {
      ok: true,
      query,
      scope,
      intent,
      hits,
      layers_queried: ['file'],
      layers_skipped: [],
      escalated: false,
      degraded: false,
    } satisfies RecallSuccess;
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
        layer: 'file',
        message,
        code,
      },
    };
  }

  private errorCode(error: unknown, fallback: string): string {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string'
    ) {
      return error.code;
    }

    return fallback;
  }
}
