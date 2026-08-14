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
// la-08-lifecycle-outcome-feedback: also records an outcome/lesson (the
// abandoned branch's last commit message, when resolvable) against every
// note it supersedes — see this file's "prepared" branch below for how that
// commit sha is captured. This is NOT optional detail bolted on afterward:
// a real `git branch -D`'s reference-transaction line reports its OLD value
// as the null OID too (confirmed by direct experiment against real git, not
// assumed from documentation), so the branch's last commit sha would
// otherwise be unrecoverable by the time "committed" fires. The fix: at
// "prepared" — BEFORE the ref is actually removed — `git rev-parse --verify
// refs/heads/<branch>` still resolves, so this script resolves + stashes it
// then (src/triggers.mjs's resolveBranchSha/stashPendingBranchSha, a small
// scratch file inside the real git dir), and reads it back
// (takePendingBranchSha) once "committed" confirms the branch was actually
// deleted. This read/stash at "prepared" is READ-ONLY git state plus a
// write to this script's OWN scratch file — it never touches the ref
// update itself, so it carries none of the abort risk described below.
//
// CRITICAL safety contract, stricter than post-merge.mjs's: git's
// reference-transaction hook can ABORT the transaction (the ref update
// itself, e.g. the branch delete) if the hook exits non-zero during the
// "prepared" state. This script therefore:
//   - only does the read-only sha pre-resolution above during "prepared",
//     never anything that touches the ref update itself, and always exits 0
//   - does nothing at all for any other non-"committed" state (e.g.
//     "aborted") — never risks vetoing a ref update the operator asked for
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
  branchDeletionEventsWithOutcome,
  candidateDeletedBranchNames,
  deletedLocalBranches,
  NotesDirectoryStatusStore,
  parseReferenceTransactionLines,
  resolveBranchSha,
  stashPendingBranchSha,
  takePendingBranchSha,
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
  const cwd = process.cwd();

  if (state === "prepared") {
    // la-08: resolve + stash each about-to-be-deleted branch's CURRENT sha
    // while its ref still resolves (see file-level doc comment for why —
    // by "committed" it's too late to learn this from git itself for a
    // real `git branch -D`). Read-only git query + a write to our own
    // scratch file only — never touches the ref update, so exiting 0 here
    // carries none of the "prepared can abort the transaction" risk.
    const lines = parseReferenceTransactionLines(stdin);
    const candidates = candidateDeletedBranchNames(lines);
    for (const branch of candidates) {
      const sha = await resolveBranchSha(branch, { cwd });
      if (sha) await stashPendingBranchSha(branch, sha, { cwd });
    }
    return;
  }

  if (state !== "committed") return; // e.g. "aborted" — see file-level doc comment: never act outside "committed"

  const lines = parseReferenceTransactionLines(stdin);
  const deleted = deletedLocalBranches(state, lines);
  if (deleted.length === 0) return;

  const entries = [];
  for (const branch of deleted) {
    const sha = await takePendingBranchSha(branch, { cwd }); // consumes the la-08 stash from "prepared", if any
    entries.push({ branch, sha });
  }
  const events = await branchDeletionEventsWithOutcome(entries, { cwd });

  const store = new NotesDirectoryStatusStore({ notesDirectory: NOTES_DIR });
  let totalSuperseded = 0;
  for (const event of events) {
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
