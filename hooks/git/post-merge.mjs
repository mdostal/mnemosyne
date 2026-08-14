#!/usr/bin/env node
// hooks/git/post-merge.mjs — the FIRST concrete lifecycle-trigger adapter's
// promote side (la-06-lifecycle-trigger-system, epic:
// mnemosyne-layer-architecture-v2). Installed by
// bin/mnemosyne-install-git-hooks as the target repo's real `.git/hooks/
// post-merge` (via a tiny absolutized shell shim — see that installer's own
// doc comment); git invokes this script for real after every merge.
//
// What it does: detects whether the merge just landed on the repo's default
// branch (../../src/triggers.mjs's detectMergePromotion, built on la-04's
// git-context logic), and if so, promotes every LOCAL provisional note
// (../../src/triggers.mjs's NotesDirectoryStatusStore, over
// MNEMOSYNE_NOTES_DIR — the same directory both this repo's real write
// paths, src/engine.mjs and lib/mnemosyne/layers/VectorLayerAdapter.ts,
// already write to) whose source_ref matches the merge, via
// applyLifecycleEvent -> la-04's assertValidStatusTransition. Never
// reimplements that validation.
//
// Resilience contract, same as hooks/post-remember.mjs: a git hook must
// NEVER block or fail a real git operation. Every code path below either
// completes or is caught and logged to stderr; this script always exits 0
// (git doesn't fail the merge on a post-merge hook's exit code anyway, but
// the explicit process.exit(0) below matches this repo's existing
// hooks/*.mjs convention rather than leaving it implicit).

import path from "node:path";
import { homedir } from "node:os";
import { applyLifecycleEvent, detectMergePromotion, NotesDirectoryStatusStore } from "../../src/triggers.mjs";

const NOTES_DIR =
  process.env.MNEMOSYNE_NOTES_DIR || path.join(homedir(), ".local", "share", "mnemosyne", "notes");

async function main() {
  const cwd = process.cwd();
  const event = await detectMergePromotion({
    cwd,
    defaultBranch: process.env.MNEMOSYNE_DEFAULT_BRANCH || undefined,
  });
  if (!event) return; // not a merge to the default branch (or nothing new) — no-op

  const store = new NotesDirectoryStatusStore({ notesDirectory: NOTES_DIR });
  const result = await applyLifecycleEvent(event, store);

  if (result.updated.length > 0) {
    process.stderr.write(
      `[mnemosyne] post-merge: ${event.detail} -> promoted ${result.updated.length} provisional entr${
        result.updated.length === 1 ? "y" : "ies"
      } to confirmed\n`
    );
  }
  process.exit(0);
}

main().catch((error) => {
  // Never block/fail the merge itself over a trigger-system error.
  process.stderr.write(`[mnemosyne] post-merge hook error (non-fatal, merge unaffected): ${error?.stack || error}\n`);
  process.exit(0);
});
