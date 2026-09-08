#!/usr/bin/env node
// bin/mnemosyne-conversation-decommission.mjs — cm-14-intake-decommission
// (epic: mnemosyne-conversation-memory).
//
// The epic's ONE, deliberate, separate, real operator-invocation entry
// point for `decommissionIntakeEntry()` (lib/mnemosyne/conversation-memory/
// decommissionIntakeEntry.ts). NEVER wired into any other command's default
// flow -- this file is the only code path that can reach this capability at
// all. A future operator running `mnemosyne harvest` (or any other verb)
// never triggers a delete as a side effect.
//
// Mirrors this epic's own established thin-CLI convention (bin/mnemosyne-
// conversation-triage-review.mjs) exactly -- `makePythonScrollPointsFn()`/
// `PYTHON_BIN`/`REPO_ROOT` are imported and reused from that file
// byte-for-byte, never reimplemented (this story's own hard constraint).
// NOTE: `bin/mnemosyne-conversation-distribute.mjs`, named in this story's
// own brief as the file that "already" reuses these three exports the same
// way, does not exist anywhere in this repo (confirmed by a repo-wide
// search this story's own build step) -- cm-13's own distributeIntakeEntries.ts
// has no dedicated CLI wrapper of its own yet. This file therefore reuses
// bin/mnemosyne-conversation-triage-review.mjs's exports DIRECTLY, exactly
// as that non-existent file would have, rather than reimplementing them a
// second time or inventing a dependency on a file that isn't there.
//
// ---------------------------------------------------------------------------
// Real production wiring for decommissionIntakeEntry()'s three REQUIRED,
// injectable primitives -- none has a default constructed inside the
// library module itself (this story's own hard constraint, exceeding every
// other story's in this epic).
// ---------------------------------------------------------------------------
//   - scrollPoints -> makePythonScrollPointsFn() (reused from triage-review,
//     shells out to mnemosyne/inventory/qdrant_inventory.py's read-only
//     `intake-candidates` verb -- the SAME live re-read cm-13's own
//     distribution pass and cm-16's own panel already use).
//   - recall        -> a real, wired `MnemosyneClient` (lib/mnemosyne/
//     client.ts, TS-native, run directly via tsx -- unlike scrollPoints,
//     no cross-language bridge is needed here at all). `client.recall`
//     bound to that instance is passed through unchanged.
//   - deletePoints  -> makeHttpQdrantDeletePointsFn() (decommissionIntakeEntry.ts's
//     own factory) -- resolves the real Qdrant URL/API key the same way
//     mnemosyne/inventory/qdrant_inventory.py's read_qdrant_key()/
//     load_qdrant_url() already do, ported to TS, and hardcodes the intake
//     collection's own resolved name into its own request URL at
//     construction time.
//
// Every test in this file's own `.test.mjs` supplies hand-written fakes for
// all three -- never a real subprocess, never a real MnemosyneClient, never
// live Qdrant.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makePythonScrollPointsFn, PYTHON_BIN, REPO_ROOT } from './mnemosyne-conversation-triage-review.mjs';
import { decommissionIntakeEntry, makeHttpQdrantDeletePointsFn } from '../lib/mnemosyne/conversation-memory/decommissionIntakeEntry.ts';
import { MnemosyneClient } from '../lib/mnemosyne/client.ts';

export { PYTHON_BIN, REPO_ROOT };

const USAGE = `Usage:
  mnemosyne-conversation-decommission --entry-id <id> [--no-backup] [--json]

Removes exactly ONE already-distributed intake entry (its own original
conversation_memory_intake point AND its own distribution_marker point).
Refuses loudly, with zero delete call, unless a LIVE re-read confirms both
(1) a real distribution_marker exists for --entry-id, and (2) the real
destination copy is independently confirmed present. Backup (a timestamped
NDJSON file under ~/.mnemosyne/intake-decommission-backups/) is written
BEFORE the delete call by default -- pass --no-backup to skip it.`;

function parseFlagArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--entry-id') flags.entryId = argv[++i];
    else if (a === '--no-backup') flags.noBackup = true;
    else if (a === '--json') flags.json = true;
  }
  return flags;
}

/**
 * The real entry point this file's own CLI dispatch calls -- accepts
 * already-parsed flags plus injectable primitives (REQUIRED for every
 * caller, including production -- mirrors runIntakeCandidates()'s/
 * runConfirm()'s own "no default production client constructed here"
 * convention exactly). Exported so this file's own `.test.mjs` can call it
 * directly with fakes, never spawning the real CLI process.
 */
export async function runDecommission({ entryId, noBackup = false, scrollPoints, recall, deletePoints } = {}) {
  if (typeof entryId !== 'string' || entryId.trim().length === 0) {
    return { ok: false, error: '--entry-id <id> is required (exactly one, non-empty, no batch/wildcard form exists)' };
  }
  if (typeof scrollPoints !== 'function' || typeof recall !== 'function' || typeof deletePoints !== 'function') {
    throw new Error(
      'runDecommission() requires injectable scrollPoints/recall/deletePoints functions -- never a default production Qdrant client constructed here.',
    );
  }

  const result = await decommissionIntakeEntry({
    entryId,
    scrollPoints,
    recall,
    deletePoints,
    skipBackup: noBackup === true,
  });

  return result;
}

// ---------------------------------------------------------------------------
// Direct-run CLI dispatch -- real production wiring, never used by this
// file's own test suite.
// ---------------------------------------------------------------------------

async function runCli(argv) {
  const flags = parseFlagArgs(argv);

  if (!flags.entryId) {
    console.error(USAGE);
    return { ok: false, error: '--entry-id <id> is required' };
  }

  const scrollPoints = makePythonScrollPointsFn();
  const client = new MnemosyneClient({ rootDirectory: process.env.MNEMOSYNE_ROOT_DIR || process.cwd() });
  const recall = (query, scope, intent) => client.recall(query, scope, intent);
  const deletePoints = makeHttpQdrantDeletePointsFn();

  return runDecommission({ entryId: flags.entryId, noBackup: flags.noBackup === true, scrollPoints, recall, deletePoints });
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const result = await runCli(process.argv.slice(2));
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
