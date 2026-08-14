#!/usr/bin/env node
// hooks/git/reference-transaction.mjs — the FIRST concrete lifecycle-trigger
// adapter's supersede side (la-06-lifecycle-trigger-system, epic:
// mnemosyne-layer-architecture-v2). Installed by
// bin/mnemosyne-install-git-hooks as the target repo's real `.git/hooks/
// reference-transaction`; git invokes this for EVERY ref update (branch
// creation, commits, merges, deletes, ...) with a state (argv[1]:
// prepared/committed/aborted) and `<old-value> <new-value> <ref-name>`
// lines on stdin — confirmed against real git (2.48) behavior, not just
// documentation (see lib/mnemosyne/triggers/gitAdapter.ts's doc comment).
//
// What it does: only on state === "committed" (see below for why), finds
// refs/heads/<branch> lines whose new-value is the null OID (a real local
// branch delete) and supersedes matching LOCAL provisional notes — never
// deletes them (../../src/triggers.mjs's NotesDirectoryStatusStore just
// rewrites `status=` in place).
//
// CRITICAL safety contract, stricter than post-merge.mjs's: git's
// reference-transaction hook can ABORT the transaction (the ref update
// itself, e.g. the branch delete) if the hook exits non-zero during the
// "prepared" state. This script therefore:
//   - does nothing at all (immediate exit 0) for any state other than
//     "committed" — never risks vetoing a ref update the operator asked for
//   - never throws past its own top-level catch, always exits 0, even for
//     "committed" (where a non-zero exit no longer has anything to abort,
//     but "always exit 0" is the simplest correct contract to hold to)
//   - runs fast: this hook fires many times per git operation (git's own
//     internal AUTO_MERGE/HEAD housekeeping refs included), so every
//     no-op path below returns as early as possible.

import path from "node:path";
import { homedir } from "node:os";
import {
  applyLifecycleEvent,
  branchDeletionEvents,
  deletedLocalBranches,
  NotesDirectoryStatusStore,
  parseReferenceTransactionLines,
} from "../../src/triggers.mjs";

const NOTES_DIR =
  process.env.MNEMOSYNE_NOTES_DIR || path.join(homedir(), ".local", "share", "mnemosyne", "notes");

function readStdin() {
  return new Promise((resolve) => {
    let buf = "";
    if (process.stdin.isTTY) return resolve("");
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", () => resolve(buf));
  });
}

async function main() {
  const state = process.argv[2] || "";
  const stdin = await readStdin(); // always drain stdin, even on a state we'll ignore — never leave git's pipe hanging

  if (state !== "committed") return; // see file-level doc comment: never act (or risk vetoing) outside "committed"

  const lines = parseReferenceTransactionLines(stdin);
  const deleted = deletedLocalBranches(state, lines);
  if (deleted.length === 0) return;

  const store = new NotesDirectoryStatusStore({ notesDirectory: NOTES_DIR });
  let totalSuperseded = 0;
  for (const event of branchDeletionEvents(deleted)) {
    const result = await applyLifecycleEvent(event, store);
    totalSuperseded += result.updated.length;
  }

  if (totalSuperseded > 0) {
    process.stderr.write(
      `[mnemosyne] reference-transaction: branch(es) deleted (${deleted.join(", ")}) -> superseded ${totalSuperseded} provisional entr${
        totalSuperseded === 1 ? "y" : "ies"
      } (never deleted)\n`
    );
  }
  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(`[mnemosyne] reference-transaction hook error (non-fatal): ${error?.stack || error}\n`);
  process.exit(0);
});
