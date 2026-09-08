#!/usr/bin/env node
// bin/mnemosyne-memory-remove.mjs — general-purpose, single-entry memory
// maintenance (2026-09-08), distinct from the mnemosyne-conversation-memory
// epic's own cm-14 intake-only decommission tool.
//
// The operator's own framing (this session): `intake` is a deliberately
// SEPARATE, temporary "figuring out where things go" staging area with its
// own archive/wipe lifecycle (cm-14, bin/mnemosyne-conversation-decommission.mjs) --
// this tool is the ordinary, ongoing "remove and re-index as we go"
// maintenance capability for the REAL destination scopes themselves
// (`meta`, a project scope like `gigradar`, etc.), which cm-14 explicitly
// and deliberately never touches.
//
// Usage:
//   mnemosyne-memory-remove --scope <scope> --entry-id <id> [--no-backup] [--json]
//
// Removes exactly ONE memory entry (matched by its own real, embedded
// `entry_id`) from the given scope's real, resolved Qdrant collection.
// Refuses loudly, with zero delete call, unless a LIVE re-scroll of that
// exact collection finds a point whose provenance names --entry-id. Backup
// (a timestamped NDJSON file under ~/.mnemosyne/memory-remove-backups/) is
// written BEFORE the delete call by default -- pass --no-backup to skip it.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readSwarmMemoryConfig } from '../lib/mnemosyne/layers/VectorLayerAdapter.ts';
import { makePythonScrollCollectionFn } from './mnemosyne-conversation-triage-review.mjs';
import { removeMemoryEntry, makeHttpQdrantDeletePointsForCollection } from '../lib/mnemosyne/maintenance/removeMemoryEntry.ts';

const USAGE = `Usage:
  mnemosyne-memory-remove --scope <scope> --entry-id <id> [--no-backup] [--json]

Removes exactly ONE memory entry (matched by its own real entry_id) from
the given scope's real, resolved Qdrant collection. Refuses loudly, with
zero delete call, unless a LIVE re-scroll of that exact collection finds a
matching point. Backup (a timestamped NDJSON file under
~/.mnemosyne/memory-remove-backups/) is written BEFORE the delete call by
default -- pass --no-backup to skip it.`;

function parseFlagArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--scope') flags.scope = argv[++i];
    else if (a === '--entry-id') flags.entryId = argv[++i];
    else if (a === '--no-backup') flags.noBackup = true;
    else if (a === '--json') flags.json = true;
  }
  return flags;
}

/**
 * The real entry point this file's own CLI dispatch calls -- accepts
 * already-resolved scope->collection plus injectable primitives (REQUIRED
 * for every caller, including production). Exported so this file's own
 * `.test.mjs` can call it directly with fakes, never spawning the real
 * CLI process or resolving a live scope.
 */
export async function runRemove({ entryId, collectionName, noBackup = false, scrollCollection, deletePoints } = {}) {
  if (typeof entryId !== 'string' || entryId.trim().length === 0) {
    return { ok: false, error: '--entry-id <id> is required (exactly one, non-empty, no batch/wildcard form exists)' };
  }
  if (typeof collectionName !== 'string' || collectionName.trim().length === 0) {
    return { ok: false, error: 'collectionName is required (the caller must resolve scope -> collection before calling this)' };
  }
  if (typeof scrollCollection !== 'function' || typeof deletePoints !== 'function') {
    throw new Error(
      'runRemove() requires injectable scrollCollection/deletePoints functions -- never a default production Qdrant client constructed here.',
    );
  }

  return removeMemoryEntry({ entryId, scrollCollection, deletePoints, skipBackup: noBackup === true });
}

// ---------------------------------------------------------------------------
// Direct-run CLI dispatch -- real production wiring, never used by this
// file's own test suite.
// ---------------------------------------------------------------------------

async function runCli(argv) {
  const flags = parseFlagArgs(argv);

  if (!flags.scope || !flags.entryId) {
    console.error(USAGE);
    return { ok: false, error: '--scope <scope> and --entry-id <id> are both required' };
  }

  // Real scope -> collection resolution, the SAME mechanism remember()
  // already uses and trusts (VectorLayerAdapter.ts's readSwarmMemoryConfig(),
  // shelling out to `swarm-memory config`) -- never a second, independently
  // reimplemented config reader.
  const cfg = await readSwarmMemoryConfig();
  const collectionName = cfg.scopes?.[flags.scope];
  if (!collectionName) {
    const known = Object.keys(cfg.scopes ?? {}).join(', ');
    const result = { ok: false, error: `scope '${flags.scope}' is not configured (known: ${known})` };
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  const scrollCollection = makePythonScrollCollectionFn(collectionName);
  const deletePoints = makeHttpQdrantDeletePointsForCollection(collectionName);

  return runRemove({ entryId: flags.entryId, collectionName, noBackup: flags.noBackup === true, scrollCollection, deletePoints });
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const result = await runCli(process.argv.slice(2));
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
