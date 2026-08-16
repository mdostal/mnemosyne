/**
 * FileStoreIndex — a standalone, rebuildable, persisted index over
 * FileLayerAdapter's target directory (the level-4 raw file doc store).
 *
 * FileLayerAdapter.ts (level 4) has zero indexing: every recall() call does
 * a full recursive walk + line-by-line substring match, "no indexing step,
 * no embedder, and no cached hash store" (layers/README.md, verbatim). This
 * module builds a separate, on-disk JSON manifest keyed by "area" so a
 * future query-time narrowing step (ml-07, NOT this story) can scope its
 * walk instead of always walking the whole tree.
 *
 * Granularity (design-discussion.md §7.4): directory + markdown-heading
 * based, deliberately NOT semantic/embedding-based clustering (that's level
 * 3/vector's job, not level 4's) —
 *   - "area": the file's directory, truncated to at most its top-level and
 *     one nested level (e.g. `docs`, `docs/guides` — a file at
 *     `docs/guides/deep/x.md` still collapses to area `docs/guides`; a
 *     root-level file has area `""`).
 *   - for `.md` files specifically, each real `#`/`##` heading is also
 *     recorded as a sub-area with its 1-based line number, mirroring (at a
 *     much simpler level) how Graphify's own doc-index treats markdown
 *     headings as addressable units (la-03-graphify-doc-index).
 *
 * This module builds ONLY the index artifact and its build logic. It does
 * NOT touch FileLayerAdapter.recall() or wire query-time narrowing — that's
 * a later, separate story (ml-07).
 *
 * Reuses FileLayerAdapter's own walk()/ignoredDirectories/sha256()
 * conventions via `./fileWalk.js` (shared, not reimplemented) so this
 * index can never disagree with what FileLayerAdapter itself would walk.
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_IGNORED_DIRECTORIES, sha256, walk } from './fileWalk.js';

/** Documented, predictable manifest location, relative to the indexed root. */
export const FILE_INDEX_RELATIVE_PATH = path.join('.mnemosyne', 'file-index.json');

export interface FileIndexHeading {
  /** Heading nesting level: 1 for `#`, 2 for `##`. */
  level: 1 | 2;
  /** Heading text, with leading `#`/`##` and surrounding whitespace stripped. */
  text: string;
  /** 1-based line number of the heading within the file. */
  line: number;
}

export interface FileIndexEntry {
  /** Path relative to the indexed root, forward-slash separated. */
  path: string;
  /** Absolute path on disk, for direct inspection/debugging. */
  absolutePath: string;
  /** Directory-based area (top-level + one nested level; "" for root files). */
  area: string;
  /** sha256 hex digest of the file's full content, via the shared sha256() helper. */
  sha256: string;
  /** Markdown `#`/`##` headings found in the file (empty for non-`.md` files). */
  headings: FileIndexHeading[];
}

export interface FileStoreIndexManifest {
  /** Absolute path of the directory that was indexed. */
  root: string;
  /** ISO 8601 timestamp of when the build ran. */
  generatedAt: string;
  /** Ignored directory names applied during the walk. */
  ignoredDirectories: string[];
  /** One entry per indexed file. */
  files: FileIndexEntry[];
  /** area -> relative file paths under that area, for quick area-scoped lookup. */
  areas: Record<string, string[]>;
}

export interface FileStoreIndexOptions {
  ignoredDirectories?: Iterable<string>;
}

const MARKDOWN_HEADING_PATTERN = /^(#{1,2})\s+(.+?)\s*$/;
const MARKDOWN_EXTENSION = '.md';

/**
 * Builds the file-store index manifest for `targetDirectory`.
 *
 * Never throws: a missing, non-directory, or unreadable target directory
 * yields a valid, empty manifest (matching FileLayerAdapter's own
 * graceful-degradation posture for a missing/empty target), not an
 * exception.
 */
export async function buildFileStoreIndex(
  targetDirectory: string,
  options: FileStoreIndexOptions = {},
): Promise<FileStoreIndexManifest> {
  const root = path.resolve(targetDirectory);
  const ignoredDirectories = new Set(options.ignoredDirectories ?? DEFAULT_IGNORED_DIRECTORIES);
  const generatedAt = new Date().toISOString();

  const emptyManifest = (): FileStoreIndexManifest => ({
    root,
    generatedAt,
    ignoredDirectories: [...ignoredDirectories],
    files: [],
    areas: {},
  });

  try {
    const rootStat = await stat(root);
    if (!rootStat.isDirectory()) {
      return emptyManifest();
    }
  } catch {
    // Missing/unreachable target directory: graceful empty manifest, never a throw.
    return emptyManifest();
  }

  const files: FileIndexEntry[] = [];
  const areas: Record<string, string[]> = {};

  try {
    for await (const filePath of walk(root, ignoredDirectories)) {
      const relativePath = toRelativePosixPath(root, filePath);
      const content = await readFile(filePath, 'utf8');
      const area = computeArea(relativePath);
      const headings = isMarkdownFile(relativePath) ? extractMarkdownHeadings(content) : [];

      files.push({
        path: relativePath,
        absolutePath: filePath,
        area,
        sha256: sha256(content),
        headings,
      });

      const areaEntries = areas[area] ?? [];
      areaEntries.push(relativePath);
      areas[area] = areaEntries;
    }
  } catch {
    // Directory became unreadable mid-walk (e.g. permission change): degrade
    // gracefully to an empty manifest rather than throwing.
    return emptyManifest();
  }

  return { root, generatedAt, ignoredDirectories: [...ignoredDirectories], files, areas };
}

export interface WriteFileStoreIndexOptions extends FileStoreIndexOptions {
  /** Override the manifest's write location (defaults to `<root>/.mnemosyne/file-index.json`). */
  manifestPath?: string;
}

export interface WriteFileStoreIndexResult {
  manifest: FileStoreIndexManifest;
  manifestPath: string;
}

/**
 * Builds the manifest (see `buildFileStoreIndex`) and persists it as
 * human-inspectable, pretty-printed JSON at a documented, predictable path:
 * `<targetDirectory>/.mnemosyne/file-index.json` by default.
 */
export async function writeFileStoreIndex(
  targetDirectory: string,
  options: WriteFileStoreIndexOptions = {},
): Promise<WriteFileStoreIndexResult> {
  const manifest = await buildFileStoreIndex(targetDirectory, options);
  const manifestPath = options.manifestPath ?? path.join(manifest.root, FILE_INDEX_RELATIVE_PATH);

  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  return { manifest, manifestPath };
}

function toRelativePosixPath(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join('/');
}

function isMarkdownFile(relativePath: string): boolean {
  return relativePath.toLowerCase().endsWith(MARKDOWN_EXTENSION);
}

/**
 * The file's area: its directory path truncated to at most a top-level and
 * one nested level. Root-level files (no directory) get area `""`.
 */
function computeArea(relativePath: string): string {
  const dir = path.posix.dirname(relativePath);
  if (dir === '.') {
    return '';
  }

  return dir.split('/').slice(0, 2).join('/');
}

/** Extracts real `#`/`##` markdown headings (and their 1-based line numbers). */
function extractMarkdownHeadings(content: string): FileIndexHeading[] {
  const lines = content.split(/\r?\n/);
  const headings: FileIndexHeading[] = [];

  lines.forEach((line, index) => {
    const match = MARKDOWN_HEADING_PATTERN.exec(line);
    if (!match) {
      return;
    }

    const hashes = match[1] ?? '';
    const text = match[2] ?? '';

    headings.push({
      level: hashes.length as 1 | 2,
      text,
      line: index + 1,
    });
  });

  return headings;
}
