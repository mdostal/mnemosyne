// index-guard.mjs — which files an index run may read (first-cut-trust t1k).
//
// swarm-memory's indexer checks the suffix of a file's NAME and then reads it,
// following symlinks. A link such as `x.json -> /repos/pantheon-v2/.env` (or
// -> /proc/self/environ) inside a mounted checkout would be indexed and then
// served back by POST /grep. So Mnemosyne never hands the CLI a directory to
// walk on its own: it walks the tree here and passes explicit regular files
// only. A file is indexed only when:
//   - neither it nor any directory on the way to it is a symlink (lstat),
//   - its real path is still under the root being indexed,
//   - its name does not start with "." (dotfiles: .env, .env.*, .npmrc, ...),
//   - no directory on the way starts with "." unless it is in
//     ALLOWED_HIDDEN_DIRECTORIES (tracked project content such as .pHive).

import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";

/** Mirrors swarm-memory's INDEXABLE_EXTENSIONS (indexer.py), used by POST /index. */
export const INDEX_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".yaml", ".yml", ".json", ".toml", ".rst", ".pdf"]);

/** Directories never descended into (swarm-memory's SKIP_DIRS plus build output). */
export const IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
  ".multica",
  "dist",
  "build",
  "coverage",
]);

/** Hidden directories that hold tracked project content and may be indexed. */
export const ALLOWED_HIDDEN_DIRECTORIES = new Set([".pHive", ".github"]);

export function isWithin(child, root) {
  const rel = path.relative(root, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function isHidden(name) {
  return name.startsWith(".");
}

/**
 * Yields every indexable regular file under `root` (which must already be a
 * real path). Symlinks are never followed, hidden files are never yielded,
 * and each file's real path must stay under `root`. Skipped entries are
 * reported through `onSkip({path, reason})`.
 */
export async function* walkIndexable(root, { extensions = INDEX_EXTENSIONS, onSkip = () => {} } = {}) {
  const realRoot = await realpath(root);
  async function* walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        onSkip({ path: entryPath, reason: "symlink" });
        continue;
      }
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        if (isHidden(entry.name) && !ALLOWED_HIDDEN_DIRECTORIES.has(entry.name)) {
          onSkip({ path: entryPath, reason: "hidden directory" });
          continue;
        }
        yield* walk(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isHidden(entry.name)) {
        onSkip({ path: entryPath, reason: "dotfile" });
        continue;
      }
      if (!extensions.has(path.extname(entry.name).toLowerCase())) continue;
      let real;
      try {
        real = await realpath(entryPath);
      } catch {
        continue;
      }
      if (!isWithin(real, realRoot)) {
        onSkip({ path: entryPath, reason: "outside the indexed root" });
        continue;
      }
      yield real;
    }
  }
  yield* walk(realRoot);
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

/**
 * Resolves POST /index's `paths` to the explicit regular files the CLI may
 * read. Each requested path must sit under one of `roots` both as written and
 * after realpath (else 403, like POST /reindex). A directory is expanded with
 * walkIndexable(); a requested path that is itself a symlink, a dotfile or not
 * a regular file is skipped and reported, never passed to the CLI.
 *
 * Returns {files, skipped}. `files` is deduplicated and in a stable order.
 */
export async function resolveIndexTargets(paths, roots, { cwd = process.cwd(), extensions = INDEX_EXTENSIONS } = {}) {
  const realRoots = (await Promise.all(roots.map((r) => realpath(r).catch(() => null)))).filter(Boolean);
  const files = [];
  const seen = new Set();
  const skipped = [];
  const onSkip = (s) => skipped.push(s);
  const add = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    files.push(file);
  };

  for (const raw of paths) {
    const requested = path.resolve(cwd, String(raw));
    const forbidden = () =>
      httpError(403, `path '${requested}' is outside the allowed index roots (MNEMOSYNE_REINDEX_ROOTS)`);
    if (!roots.some((root) => isWithin(requested, path.resolve(root)))) throw forbidden();

    let st;
    try {
      st = await lstat(requested);
    } catch {
      throw httpError(400, `path '${requested}' does not exist`);
    }
    if (st.isSymbolicLink()) {
      onSkip({ path: requested, reason: "symlink" });
      continue;
    }
    const real = await realpath(requested);
    const root = realRoots.find((r) => isWithin(real, r));
    if (!root) throw forbidden();
    const hiddenDir = path
      .relative(root, st.isDirectory() ? real : path.dirname(real))
      .split(path.sep)
      .find((part) => part && isHidden(part) && !ALLOWED_HIDDEN_DIRECTORIES.has(part));
    if (hiddenDir) {
      onSkip({ path: requested, reason: "hidden directory" });
      continue;
    }

    if (st.isDirectory()) {
      for await (const file of walkIndexable(real, { extensions, onSkip })) add(file);
      continue;
    }
    if (!st.isFile()) {
      onSkip({ path: requested, reason: "not a regular file" });
      continue;
    }
    if (isHidden(path.basename(real))) {
      onSkip({ path: requested, reason: "dotfile" });
      continue;
    }
    add(real);
  }
  return { files, skipped };
}
