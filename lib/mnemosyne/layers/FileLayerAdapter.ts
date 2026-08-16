import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Hit, RecallFailure, RecallResult, RecallSuccess } from '../interfaces.js';
import { DEFAULT_IGNORED_DIRECTORIES, sha256, walk } from './fileWalk.js';
import { FILE_INDEX_RELATIVE_PATH, type FileIndexEntry, type FileStoreIndexManifest } from './FileStoreIndex.js';
import type { LayerAdapter, RecallOptions } from './LayerAdapter.js';

export interface FileLayerAdapterOptions {
  ignoredDirectories?: Iterable<string>;
}

/**
 * Pure staleness check: true when `entry`'s manifest-recorded sha256 no
 * longer matches `liveContent`'s live sha256.
 *
 * Exported standalone (and directly unit-testable) rather than embedded
 * inline, because `recall()`'s own correctness does NOT depend on ever
 * calling this: every candidate file's content is always re-read live at
 * query time (see `FileLayerAdapter`'s private `scanFile`), so a stale
 * manifest hash can never cause old, cached content to be served -- there is
 * no cache to serve it from. This function exists so that guarantee is
 * directly, explicitly articulated in code (and provable in isolation)
 * rather than merely implied by "there's no caching layer, trust us."
 */
export function isIndexEntryStale(entry: Pick<FileIndexEntry, 'sha256'>, liveContent: string): boolean {
  return sha256(liveContent) !== entry.sha256;
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
      const fileSource = await this.resolveFileSource(options.area);
      for await (const filePath of fileSource) {
        if (hits.length >= limit) {
          break;
        }

        await this.scanFile(filePath, normalizedQuery, retrievalTime, hits, limit);
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

  /**
   * Reads a single file's content live and pushes any matching lines onto
   * `hits`. Factored out of `recall()`'s main loop so BOTH the unscoped
   * full-walk path and the area-scoped path share the exact same per-file
   * read+match logic (a single source of truth for what "matching" means),
   * and so tests can spy on this method to directly count how many files a
   * given `recall()` call actually touched (ml-07 acceptance criterion #1:
   * an area-scoped query must read/scan strictly fewer files than a full
   * walk of the whole target directory).
   *
   * Always reads `filePath` live via `readFile` -- never from any cached/
   * indexed copy -- which is also this design's whole answer to the
   * staleness acceptance criterion (#4): there is no cache to go stale.
   */
  private async scanFile(
    filePath: string,
    query: string,
    retrievalTime: string,
    hits: Hit[],
    limit: number,
  ): Promise<void> {
    const content = await readFile(filePath, 'utf8');
    const lines = content.split(/\r?\n/);
    for (const [offset, line] of lines.entries()) {
      if (!line.includes(query)) {
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

  /**
   * Resolves which files `recall()` should scan.
   *
   * - `area === undefined` (every pre-ml-07 caller, and every ml-07 caller
   *   that simply doesn't pass `area`): returns the exact same
   *   `walk(this.root, this.ignoredDirectories)` full-tree walk
   *   `recall()` has always used, with ZERO extra filesystem calls (no
   *   manifest read attempted at all) -- this is what makes the no-index/
   *   no-`area` behavior byte-for-byte identical to pre-ml-07
   *   `FileLayerAdapter`, provable by the existing test suite passing
   *   completely unmodified.
   * - `area` given but no manifest exists, or the manifest doesn't know
   *   that area: safe fallback to the SAME full-tree walk -- never a
   *   silently-narrower-than-intended result just because an area was
   *   requested that the index can't (yet) answer for (acceptance
   *   criterion #5).
   * - `area` given and known to the manifest: delegates to `walkArea`, a
   *   REAL, LIVE, directory-scoped walk (not a replay of the manifest's
   *   possibly-stale file list) -- see `walkArea`'s own doc comment for why
   *   this is what makes false negatives structurally impossible.
   */
  private async resolveFileSource(area: string | undefined): Promise<AsyncIterable<string>> {
    if (area === undefined) {
      return walk(this.root, this.ignoredDirectories);
    }

    const manifest = await this.tryLoadManifest();
    const candidates = manifest?.areas?.[area];
    if (!manifest || !candidates || candidates.length === 0) {
      return walk(this.root, this.ignoredDirectories);
    }

    return this.walkArea(area);
  }

  /**
   * Loads and minimally shape-validates the ml-06 manifest at
   * `<root>/.mnemosyne/file-index.json`. Returns `null` (never throws) for
   * ANY failure -- missing file, unreadable, invalid JSON, or a parsed
   * value that doesn't even have an `areas` object -- so every caller of
   * this method treats "no usable index" uniformly as "fall back to full
   * walk," matching acceptance criterion #5's "index doesn't exist at all"
   * case exactly.
   */
  private async tryLoadManifest(): Promise<FileStoreIndexManifest | null> {
    try {
      const manifestPath = path.join(this.root, FILE_INDEX_RELATIVE_PATH);
      const raw = await readFile(manifestPath, 'utf8');
      const parsed: unknown = JSON.parse(raw);

      if (
        !parsed ||
        typeof parsed !== 'object' ||
        typeof (parsed as { areas?: unknown }).areas !== 'object' ||
        (parsed as { areas?: unknown }).areas === null
      ) {
        return null;
      }

      return parsed as FileStoreIndexManifest;
    } catch {
      return null;
    }
  }

  /**
   * A REAL, live, directory-scoped walk for `area`, mirroring
   * `FileStoreIndex.ts`'s own `computeArea` truncation rule exactly (area =
   * a file's directory path truncated to at most a top-level + one nested
   * level):
   *
   * - `area` has >= 2 path segments (e.g. `"docs/guides"`): every file
   *   whose own directory collapses to this area is necessarily physically
   *   located AT OR BELOW `<root>/docs/guides` (any further nesting still
   *   truncates to the same 2 segments) -- so a full recursive `walk()` of
   *   exactly that subdirectory finds precisely the same file set a full
   *   walk of the whole tree, filtered to this area, would find. No more,
   *   no fewer.
   * - `area` has 0 or 1 path segments (e.g. `""` or `"docs"`): any file one
   *   level deeper belongs to a DIFFERENT, more specific area (its own
   *   directory truncates to 2 segments, not this 1-segment/root area) --
   *   so only that directory's DIRECT file children are included; nested
   *   subdirectories are deliberately never recursed into here.
   *
   * This is why area-scoped narrowing can never introduce a false negative
   * (acceptance criterion #2) purely by construction: the manifest is used
   * ONLY to decide whether `area` is worth narrowing to at all
   * (`resolveFileSource`); the actual file enumeration here is always a
   * live, current-as-of-this-call directory read, so files added/removed/
   * moved since the index was last built are reflected correctly without
   * any special-case staleness logic -- there is no stale snapshot being
   * trusted for existence, only for the initial "is this a known area"
   * gate (and getting that gate wrong just means an unnecessarily full
   * walk runs, never a missed file).
   *
   * A directory that no longer exists (`ENOENT` -- e.g. the whole area was
   * deleted after indexing) yields no files, which is exactly correct: a
   * full walk restricted to a now-nonexistent area would also find
   * nothing. Any other error (e.g. a permissions problem) propagates, to
   * be caught by `recall()`'s own try/catch exactly as a full-walk
   * permission failure already is.
   */
  private async *walkArea(area: string): AsyncGenerator<string> {
    const segments = area === '' ? [] : area.split('/');
    const dir = segments.length === 0 ? this.root : path.join(this.root, area);

    if (segments.length >= 2) {
      try {
        yield* walk(dir, this.ignoredDirectories);
      } catch (error) {
        if (this.errorCode(error, '') === 'ENOENT') {
          return;
        }
        throw error;
      }
      return;
    }

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (this.errorCode(error, '') === 'ENOENT') {
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      if (entry.isFile()) {
        yield path.join(dir, entry.name);
      }
    }
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
