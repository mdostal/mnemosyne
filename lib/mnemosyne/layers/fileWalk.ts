/**
 * Shared directory-walk and content-hash helpers.
 *
 * Extracted verbatim from `FileLayerAdapter.ts` (ml-06-file-store-index-build,
 * epic mnemosyne-memory-levels) so `FileStoreIndex.ts` can reuse the exact
 * same walk/ignore/hash conventions rather than reimplementing a second,
 * potentially-divergent directory-scan. `FileLayerAdapter.ts` itself now
 * imports from here too, so there is exactly one implementation of each.
 */

import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_IGNORED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
]);

/**
 * Recursively walks `directory`, yielding absolute file paths for every
 * file found, skipping any directory entry whose name is in
 * `ignoredDirectories`. Identical logic/behavior to `FileLayerAdapter`'s
 * original private `walk()` method.
 */
export async function* walk(
  directory: string,
  ignoredDirectories: Set<string> = DEFAULT_IGNORED_DIRECTORIES,
): AsyncGenerator<string> {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        yield* walk(entryPath, ignoredDirectories);
      }
      continue;
    }

    if (entry.isFile()) {
      yield entryPath;
    }
  }
}

/** sha256 hex digest of `content`. Identical to `FileLayerAdapter`'s original helper. */
export function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
