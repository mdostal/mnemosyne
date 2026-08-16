#!/usr/bin/env -S npx tsx
// mnemosyne-file-index — CLI verb that (re)builds the Level 4 file-store
// index (ml-08-file-store-index-rebuild).
//
// Closes the last gap in the Level 4 sub-index: ml-07 already handles a
// single stale file gracefully at query time (every recall() call always
// reads matched file content live -- there is no cache to go stale), but a
// batch of changes (files added/removed/moved into new or existing areas)
// can leave the PERSISTED MANIFEST's own area map out of date, which costs
// query-time efficiency: an area the manifest doesn't know about falls back
// to a full walk of the whole tree (FileLayerAdapter's own documented,
// correct-but-slower fallback) instead of a narrow, scoped walk. Rebuilding
// regenerates the manifest from scratch so subsequent queries get the full
// narrowing benefit again.
//
// Deliberately CLI-only, no HTTP route (vertical-plan.md's "Ambiguities Not
// Resolved" #3, resolved by ml-08: the lower-risk default absent a stated
// operator need for a UI-triggered rebuild) -- mirrors this repo's existing
// bin/mnemosyne-* verb conventions (bin/mnemosyne-reindex.mjs's CLI-arg/
// output shape, even though that verb targets a different store: the vector
// layer via a running service's HTTP route, not the file layer locally).
//
// Unlike mnemosyne-reindex.mjs (a thin HTTP client with zero business
// logic), this verb calls ml-06's `writeFileStoreIndex` directly -- no
// reimplementation of the build logic, and no re-invention of the manifest
// format. writeFileStoreIndex() ALWAYS does a full, from-scratch walk +
// write (see FileStoreIndex.ts): there is no separate "first build" vs.
// "rebuild" code path anywhere in this file or in FileStoreIndex.ts itself,
// so running this verb against a target with no prior index at all behaves
// identically to running it against a target with a stale one -- both go
// through the exact same call. The manifest write is a full overwrite (the
// whole file is rewritten from the fresh walk result), never a merge, so a
// file deleted since the last build can never leave an orphaned entry
// behind.
//
// Must be launched via tsx, not plain node -- imports
// lib/mnemosyne/layers/FileStoreIndex.ts directly (noEmit:true means there
// is no build step to import a .ts module any other way; see
// bin/mnemosyne-persona.mjs's identical doc-comment for the same reason).
// The `#!/usr/bin/env -S npx tsx` shebang above (matching
// lib/mnemosyne/audit/cli.ts's own convention) makes the file directly
// executable once `chmod +x`'d; the package.json `bin` entry relies on the
// same shebang when installed/linked.
//
// Usage: mnemosyne-file-index [<directory>] [--manifest-path <path>]
//
//   <directory>        directory to (re)index (default: process.cwd())
//   --manifest-path P  override the manifest's write location (default:
//                      <directory>/.mnemosyne/file-index.json, ml-06's
//                      documented, predictable path)
//
// Idempotent and safe to re-run: every run fully regenerates the manifest
// from the target directory's CURRENT state, so re-running immediately
// after a no-op (no filesystem changes) produces the same file set/areas
// again (only `generatedAt` changes).

import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileStoreIndex } from "../lib/mnemosyne/layers/FileStoreIndex.ts";

export function parseArgs(argv) {
  const args = { directory: undefined, manifestPath: undefined };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--manifest-path") args.manifestPath = argv[++i];
    else positional.push(a);
  }
  args.directory = positional[0];
  return args;
}

export async function run(argv, { log = console.log, warn = console.error, cwd = process.cwd() } = {}) {
  const args = parseArgs(argv);
  const targetDirectory = args.directory ?? cwd;

  let result;
  try {
    result = await writeFileStoreIndex(
      targetDirectory,
      args.manifestPath ? { manifestPath: args.manifestPath } : {},
    );
  } catch (e) {
    warn(`mnemosyne-file-index: failed to rebuild index for ${targetDirectory} (${e.message})`);
    return { ok: false };
  }

  const { manifest, manifestPath } = result;
  const summary = {
    ok: true,
    root: manifest.root,
    manifestPath,
    generatedAt: manifest.generatedAt,
    files: manifest.files.length,
    areas: Object.keys(manifest.areas).length,
  };

  log(JSON.stringify(summary, null, 2));
  return { ...summary, manifest };
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const { ok } = await run(process.argv.slice(2));
  process.exit(ok ? 0 : 1);
}
