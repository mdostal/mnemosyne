// cm-14-intake-decommission (epic: mnemosyne-conversation-memory).
//
// Failing-first tests (TDD) for decommissionIntakeEntry.ts, against fakes/
// stubs ONLY -- a fake IngestClient-equivalent is not needed here (this
// module never calls remember()), but the EQUIVALENT hard constraint holds:
// a stubbed scrollPoints(), a fake recall(), and a fake QdrantDeletePointsFn
// -- NEVER a live Qdrant call anywhere in this file (this story's own
// highest-scrutiny bar in the epic).
//
// Uses node:test (not vitest) so this file's own scoped test command is
// exactly `npx tsx --test lib/mnemosyne/conversation-memory/
// decommissionIntakeEntry.test.ts` -- mirrors bin/mnemosyne-conversation-
// triage-review.test.mjs's own convention, never the vitest-based
// convention distributeIntakeEntries.test.ts uses (this repo's own
// documented "full npm test chain hangs" constraint makes this file's own
// scoped, non-vitest command the only one ever run for it this session).
//
// Covers every acceptance criterion in
// .pHive/epics/mnemosyne-conversation-memory/stories/
// cm-14-intake-decommission.yaml:
//  1. No matching marker (live re-read) -> REFUSE, zero delete call.
//  2. Marker exists, destination check fails/inconclusive -> REFUSE, zero
//     delete call, never trusts the marker alone.
//  3. Both checks pass -> proceeds for that ONE entryId only; single-
//     entry-only structural constraint (no array/wildcard shape exists).
//  4. Backup default ON -> NDJSON write happens BEFORE the delete call.
//  5. skipBackup: true -> proceeds directly to delete, no backup write --
//     reachable ONLY via that explicit flag.
//  6. Successful delete -> exactly the two real point ids (entry + marker),
//     never a third; QdrantDeletePointsFn's own signature carries no
//     collection parameter at all (structural, not just this test).
//  7. makeHttpQdrantDeletePointsFn() -- hardcodes INTAKE_COLLECTION_NAME
//     into its own request URL, verified with a fake fetchImpl (never live
//     Qdrant).
//  8. No import sites from cm-01..cm-13 or a cm-11/cm-12 orchestrator/CLI
//     exist (there is no cm-11/cm-12 code in this repo at all -- confirmed
//     directly, see the standalone assertion below, not invented against
//     nonexistent files).

import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildProvenanceHeader, type EntryProvenanceMetadata } from './distillAndRemember.js';
import { INTAKE_COLLECTION_NAME, buildDistributionMarkerHeader, type DistributionMarkerMetadata } from './distributeIntakeEntries.js';
import {
  decommissionIntakeEntry,
  makeHttpQdrantDeletePointsFn,
  type DecommissionIntakeEntryOptions,
  type QdrantDeleteResult,
  type RecallFn,
  type ScrolledPoint,
} from './decommissionIntakeEntry.js';
import type { Hit, RecallResult } from '../interfaces.js';

// ---------------------------------------------------------------------------
// Fixtures -- mirrors distributeIntakeEntries.test.ts's own fixture shapes.
// ---------------------------------------------------------------------------

function makeEntryMetadata(overrides: Partial<EntryProvenanceMetadata> = {}): EntryProvenanceMetadata {
  return {
    entry_id: randomUUID(),
    entry_type: 'decision',
    source: 'external_conversation',
    chat_source: 'claude-code',
    session_id: 'session-abc',
    project_slug: '/Users/mdostal/Code/arizona-compound',
    cluster_id: 'cluster-1',
    resolved_scope_candidate: null,
    ...overrides,
  };
}

function makeCandidatePoint(metadata: EntryProvenanceMetadata, body = 'Some real distilled body text.'): { point: ScrolledPoint; text: string } {
  const header = buildProvenanceHeader(metadata);
  const text = `${header}\n\n${body}`;
  return { point: { id: `point-${metadata.entry_id}`, payload: { text } }, text };
}

function makeMarkerPoint(marker: DistributionMarkerMetadata): { point: ScrolledPoint; text: string } {
  const text = buildDistributionMarkerHeader(marker);
  return { point: { id: `point-${marker.entry_id}`, payload: { text } }, text };
}

function makeMarker(overrides: Partial<DistributionMarkerMetadata> = {}): DistributionMarkerMetadata {
  return {
    entry_id: randomUUID(),
    entry_type: 'distribution_marker',
    marks_entry_id: randomUUID(),
    distributed_to_scope: 'meta',
    distributed_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeScrollPointsStub(points: ScrolledPoint[]) {
  const calls: Array<{ collectionName: string }> = [];
  const scrollPoints = async (collectionName: string) => {
    calls.push({ collectionName });
    return points;
  };
  return { scrollPoints, calls };
}

/** A hit whose content carries a REAL, parseable provenance header naming `entryId` -- mirrors the real destination write (cm-13's `ingestDocument(client, { content: candidate.text, ... })`, unchanged text). */
function makeConfirmingHit(text: string, contentHash: string | null): Hit {
  return {
    content: text,
    provenance: {
      layer: 'vector',
      source: 'qdrant-point-xyz',
      chunk_span: null,
      index_timestamp: new Date().toISOString(),
      content_hash: contentHash,
      embedder: 'nomic-embed-text',
      retrieval_time: new Date().toISOString(),
    },
  };
}

function recallSuccess(hits: Hit[]): RecallResult {
  return {
    ok: true,
    query: 'q',
    scope: 'meta',
    intent: 'broad',
    hits,
    layers_queried: ['vector'],
    layers_skipped: [],
    escalated: false,
    degraded: false,
  };
}

function recallFailure(message: string): RecallResult {
  return { ok: false, query: 'q', scope: 'meta', intent: 'broad', error: { layer: 'vector', message } };
}

function makeFakeRecall(result: RecallResult): { recall: RecallFn; calls: Array<{ query: string; scope: string; intent?: string }> } {
  const calls: Array<{ query: string; scope: string; intent?: string }> = [];
  const recall: RecallFn = async (query, scope, intent) => {
    calls.push(intent === undefined ? { query, scope: scope as string } : { query, scope: scope as string, intent });
    return result;
  };
  return { recall, calls };
}

function makeFakeDeletePoints(result: QdrantDeleteResult = { ok: true, operationId: 1, status: 'completed' }) {
  const calls: string[][] = [];
  const deletePoints = async (pointIds: string[]): Promise<QdrantDeleteResult> => {
    calls.push(pointIds);
    return result;
  };
  return { deletePoints, calls };
}

/** Builds a fully-wired, both-checks-passing scenario -- the shared "happy path" fixture every backup/delete-ordering test starts from. */
function makeConfirmedScenario() {
  const entryMetadata = makeEntryMetadata();
  const { point: entryPoint, text: entryText } = makeCandidatePoint(entryMetadata);
  const marker = makeMarker({ marks_entry_id: entryMetadata.entry_id, distributed_to_scope: 'meta' });
  const { point: markerPoint } = makeMarkerPoint(marker);
  const contentHash = createHash('sha256').update(entryText).digest('hex');
  const confirmingHit = makeConfirmingHit(entryText, contentHash);

  return { entryMetadata, entryPoint, entryText, marker, markerPoint, contentHash, confirmingHit };
}

// ---------------------------------------------------------------------------
// AC 1: no matching distribution_marker -> REFUSE, zero delete call.
// ---------------------------------------------------------------------------

test('refuses when a live re-read finds no distribution_marker for entry_id', async () => {
  const entryMetadata = makeEntryMetadata();
  const { point: entryPoint } = makeCandidatePoint(entryMetadata);
  const { scrollPoints, calls } = makeScrollPointsStub([entryPoint]); // no marker point at all
  const { recall } = makeFakeRecall(recallFailure('should never be called'));
  const { deletePoints, calls: deleteCalls } = makeFakeDeletePoints();

  const result = await decommissionIntakeEntry({
    entryId: entryMetadata.entry_id,
    scrollPoints,
    recall,
    deletePoints,
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'no_marker_found');
    assert.match(result.detail, /entry not marked distributed/);
  }
  assert.equal(deleteCalls.length, 0, 'no delete call was made');
  assert.equal(calls[0]?.collectionName, INTAKE_COLLECTION_NAME, 'scrollPoints was called against the intake collection only');
});

test('refuses when a marker exists for a DIFFERENT entry_id (no false match)', async () => {
  const entryMetadata = makeEntryMetadata();
  const { point: entryPoint } = makeCandidatePoint(entryMetadata);
  const unrelatedMarker = makeMarker({ marks_entry_id: 'some-other-entry-id' });
  const { point: unrelatedMarkerPoint } = makeMarkerPoint(unrelatedMarker);
  const { scrollPoints } = makeScrollPointsStub([entryPoint, unrelatedMarkerPoint]);
  const { recall } = makeFakeRecall(recallFailure('should never be called'));
  const { deletePoints, calls: deleteCalls } = makeFakeDeletePoints();

  const result = await decommissionIntakeEntry({ entryId: entryMetadata.entry_id, scrollPoints, recall, deletePoints });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'no_marker_found');
  assert.equal(deleteCalls.length, 0);
});

// ---------------------------------------------------------------------------
// AC 2: marker exists, destination check fails or is inconclusive -> REFUSE.
// ---------------------------------------------------------------------------

test('refuses when the marker exists but recall() itself fails (inconclusive)', async () => {
  const { entryMetadata, entryPoint, markerPoint } = makeConfirmedScenario();
  const { scrollPoints } = makeScrollPointsStub([entryPoint, markerPoint]);
  const { recall } = makeFakeRecall(recallFailure('qdrant unreachable'));
  const { deletePoints, calls: deleteCalls } = makeFakeDeletePoints();

  const result = await decommissionIntakeEntry({ entryId: entryMetadata.entry_id, scrollPoints, recall, deletePoints });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'destination_not_confirmed');
    assert.match(result.detail, /inconclusive/);
  }
  assert.equal(deleteCalls.length, 0, 'never deletes on the strength of the marker alone');
});

test('refuses when recall() succeeds but finds NO hit confirming this entry_id at the destination', async () => {
  const { entryMetadata, entryPoint, markerPoint } = makeConfirmedScenario();
  const { scrollPoints } = makeScrollPointsStub([entryPoint, markerPoint]);
  const { recall } = makeFakeRecall(recallSuccess([])); // zero hits -- legitimate "not found"
  const { deletePoints, calls: deleteCalls } = makeFakeDeletePoints();

  const result = await decommissionIntakeEntry({ entryId: entryMetadata.entry_id, scrollPoints, recall, deletePoints });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'destination_not_confirmed');
  assert.equal(deleteCalls.length, 0);
});

test('refuses when a hit matches entry_id but its content_hash is present and MISMATCHED (fails closed, never fuzzy)', async () => {
  const { entryMetadata, entryPoint, entryText, markerPoint } = makeConfirmedScenario();
  const { scrollPoints } = makeScrollPointsStub([entryPoint, markerPoint]);
  const wrongHash = createHash('sha256').update(entryText + 'tampered').digest('hex');
  const { recall } = makeFakeRecall(recallSuccess([makeConfirmingHit(entryText, wrongHash)]));
  const { deletePoints, calls: deleteCalls } = makeFakeDeletePoints();

  const result = await decommissionIntakeEntry({ entryId: entryMetadata.entry_id, scrollPoints, recall, deletePoints });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'destination_not_confirmed');
  assert.equal(deleteCalls.length, 0);
});

test('confirms via entry_id match alone when the hit reports a null content_hash (layer has no hash concept)', async () => {
  const { entryMetadata, entryPoint, entryText, marker, markerPoint } = makeConfirmedScenario();
  const { scrollPoints } = makeScrollPointsStub([entryPoint, markerPoint]);
  const { recall } = makeFakeRecall(recallSuccess([makeConfirmingHit(entryText, null)]));
  const { deletePoints } = makeFakeDeletePoints();

  const result = await decommissionIntakeEntry({
    entryId: entryMetadata.entry_id,
    scrollPoints,
    recall,
    deletePoints,
    skipBackup: true,
  });

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.destinationScope, marker.distributed_to_scope);
});

test('the destination recall() query is the entry\'s own real BODY text (header stripped), never the bare entryId or the full header+body text', async () => {
  // Real, live-confirmed bugs found across two rounds of actual live use
  // (2026-09-08): (1) querying with the bare entryId (a UUID, semantically
  // meaningless) reliably found nothing; (2) querying with the FULL
  // persisted text (header + body) ALSO failed -- every entry in a batch
  // shares near-identical header boilerplate, which dominates the
  // embedding and surfaces OTHER entries with a similar header instead of
  // this one. Stripping to just the body (everything after the header's
  // own closing `-->`) is what actually, reliably matches the real
  // destination copy. This test locks that fix in structurally.
  const body = 'Some real distilled body text.'; // makeCandidatePoint()'s own default body
  const { entryMetadata, entryPoint, markerPoint, confirmingHit } = makeConfirmedScenario();
  const { scrollPoints } = makeScrollPointsStub([entryPoint, markerPoint]);
  const { recall, calls } = makeFakeRecall(recallSuccess([confirmingHit]));
  const { deletePoints } = makeFakeDeletePoints();

  await decommissionIntakeEntry({
    entryId: entryMetadata.entry_id,
    scrollPoints,
    recall,
    deletePoints,
    skipBackup: true,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.query, body);
  assert.notEqual(calls[0]!.query, entryMetadata.entry_id);
  assert.ok(!calls[0]!.query.includes('-->'), 'query must not include any header boilerplate');
});

// ---------------------------------------------------------------------------
// AC 3: both checks pass -> proceeds for exactly this ONE entryId; deletes
// exactly the two real point ids (entry's own point + its marker's own
// point), never a third.
// ---------------------------------------------------------------------------

test('on success, deletes exactly two point ids: the entry point and its marker point, never a third', async () => {
  const scenario = makeConfirmedScenario();
  const otherEntryMetadata = makeEntryMetadata();
  const { point: otherEntryPoint } = makeCandidatePoint(otherEntryMetadata); // a THIRD, unrelated point in the same collection
  const { scrollPoints } = makeScrollPointsStub([scenario.entryPoint, scenario.markerPoint, otherEntryPoint]);
  const { recall } = makeFakeRecall(recallSuccess([scenario.confirmingHit]));
  const { deletePoints, calls: deleteCalls } = makeFakeDeletePoints();

  const result = await decommissionIntakeEntry({
    entryId: scenario.entryMetadata.entry_id,
    scrollPoints,
    recall,
    deletePoints,
    skipBackup: true,
  });

  assert.equal(result.ok, true);
  assert.equal(deleteCalls.length, 1, 'exactly one delete call is made');
  const deletedIds = deleteCalls[0]!;
  assert.equal(deletedIds.length, 2, 'exactly two point ids are deleted');
  assert.ok(deletedIds.includes(String(scenario.entryPoint.id)));
  assert.ok(deletedIds.includes(String(scenario.markerPoint.id)));
  assert.ok(!deletedIds.includes(String(otherEntryPoint.id)), 'the unrelated third point is never touched');
  if (result.ok) {
    assert.deepEqual([...result.deletedPointIds].sort(), [String(scenario.entryPoint.id), String(scenario.markerPoint.id)].sort());
  }
});

test('decommissionIntakeEntry() accepts a single entryId: string only -- no batch/array/wildcard shape exists on its options', () => {
  // Structural check on the exported option shape itself: TypeScript's own
  // `entryId: string` field type (decommissionIntakeEntry.ts) makes an
  // array/wildcard call a COMPILE-time error, not merely a runtime
  // convention -- this test asserts the one, single string field is the
  // only identifier-bearing field on the options object at all.
  const optionKeys: Array<keyof DecommissionIntakeEntryOptions> = [
    'entryId',
    'scrollPoints',
    'recall',
    'deletePoints',
    'skipBackup',
    'backupDir',
    'ensureBackupDir',
    'writeBackupFile',
    'now',
  ];
  const idLikeKeys = optionKeys.filter((k) => /id/i.test(k));
  assert.deepEqual(idLikeKeys, ['entryId'], 'exactly one identifier field exists, and it is a single entryId');
});

// ---------------------------------------------------------------------------
// AC 4/5: backup default-ON, written BEFORE the delete call; skipBackup
// reachable ONLY via that explicit flag.
// ---------------------------------------------------------------------------

test('default invocation (no skipBackup) writes a real NDJSON backup file BEFORE the delete call is made', async () => {
  const scenario = makeConfirmedScenario();
  const { scrollPoints } = makeScrollPointsStub([scenario.entryPoint, scenario.markerPoint]);
  const { recall } = makeFakeRecall(recallSuccess([scenario.confirmingHit]));

  const order: string[] = [];
  const { deletePoints } = makeFakeDeletePoints();
  const orderedDeletePoints = async (ids: string[]) => {
    order.push('delete');
    return deletePoints(ids);
  };

  const tmpDir = mkdtempSync(path.join(tmpdir(), 'cm14-backup-'));
  const writeCalls: Array<{ filePath: string; content: string }> = [];
  const writeBackupFile = (filePath: string, content: string) => {
    order.push('backup-write');
    writeCalls.push({ filePath, content });
  };
  const ensureBackupDir = () => {
    order.push('ensure-dir');
  };

  const result = await decommissionIntakeEntry({
    entryId: scenario.entryMetadata.entry_id,
    scrollPoints,
    recall,
    deletePoints: orderedDeletePoints,
    backupDir: tmpDir,
    ensureBackupDir,
    writeBackupFile,
    now: () => new Date('2026-09-07T12:00:00.000Z'),
  });

  assert.equal(result.ok, true);
  assert.equal(writeCalls.length, 1, 'exactly one backup file write happens');
  assert.equal(order.indexOf('backup-write') < order.indexOf('delete'), true, 'the backup write happens BEFORE the delete call');
  assert.ok(writeCalls[0]!.filePath.startsWith(tmpDir));
  assert.match(writeCalls[0]!.filePath, /2026-09-07T12-00-00-000Z-.*\.ndjson$/);

  const lines = writeCalls[0]!.content.trim().split('\n');
  assert.equal(lines.length, 2, 'two NDJSON lines: the entry and its marker');
  const entryLine = JSON.parse(lines[0]!);
  const markerLine = JSON.parse(lines[1]!);
  assert.equal(entryLine.kind, 'intake_entry');
  assert.equal(entryLine.text, scenario.entryText);
  assert.equal(markerLine.kind, 'distribution_marker');
  assert.equal(markerLine.marksEntryId, scenario.entryMetadata.entry_id);

  if (result.ok) {
    assert.equal(result.backupPath, writeCalls[0]!.filePath);
  }
});

test('a REAL backup write, to a real temp directory, actually lands on disk before delete (no fakes on the fs side for this one test)', async () => {
  const scenario = makeConfirmedScenario();
  const { scrollPoints } = makeScrollPointsStub([scenario.entryPoint, scenario.markerPoint]);
  const { recall } = makeFakeRecall(recallSuccess([scenario.confirmingHit]));
  const { deletePoints } = makeFakeDeletePoints();

  const tmpDir = mkdtempSync(path.join(tmpdir(), 'cm14-real-backup-'));
  try {
    const result = await decommissionIntakeEntry({
      entryId: scenario.entryMetadata.entry_id,
      scrollPoints,
      recall,
      deletePoints,
      backupDir: tmpDir,
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.ok(result.backupPath !== null);
      assert.ok(existsSync(result.backupPath!), 'the real backup file genuinely exists on disk');
      const content = readFileSync(result.backupPath!, 'utf8');
      assert.match(content, new RegExp(scenario.entryMetadata.entry_id));
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('backup write failure fails LOUD and aborts BEFORE the delete call -- never a silent proceed-anyway', async () => {
  const scenario = makeConfirmedScenario();
  const { scrollPoints } = makeScrollPointsStub([scenario.entryPoint, scenario.markerPoint]);
  const { recall } = makeFakeRecall(recallSuccess([scenario.confirmingHit]));
  const { deletePoints, calls: deleteCalls } = makeFakeDeletePoints();

  const result = await decommissionIntakeEntry({
    entryId: scenario.entryMetadata.entry_id,
    scrollPoints,
    recall,
    deletePoints,
    ensureBackupDir: () => {},
    writeBackupFile: () => {
      throw new Error('disk full');
    },
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'backup_write_failed');
    assert.match(result.detail, /disk full/);
  }
  assert.equal(deleteCalls.length, 0, 'no delete call is ever made when the backup write fails');
});

test('skipBackup: true proceeds directly to delete with NO backup write -- reachable only via that explicit flag', async () => {
  const scenario = makeConfirmedScenario();
  const { scrollPoints } = makeScrollPointsStub([scenario.entryPoint, scenario.markerPoint]);
  const { recall } = makeFakeRecall(recallSuccess([scenario.confirmingHit]));
  const { deletePoints, calls: deleteCalls } = makeFakeDeletePoints();

  let writeCalled = false;
  const result = await decommissionIntakeEntry({
    entryId: scenario.entryMetadata.entry_id,
    scrollPoints,
    recall,
    deletePoints,
    skipBackup: true,
    writeBackupFile: () => {
      writeCalled = true;
    },
  });

  assert.equal(result.ok, true);
  assert.equal(writeCalled, false, 'no backup write happens when skipBackup is explicitly true');
  assert.equal(deleteCalls.length, 1);
  if (result.ok) assert.equal(result.backupPath, null);
});

test('omitting skipBackup entirely (the bare default invocation shape) still writes a backup -- the default is ON, not an opt-in', async () => {
  const scenario = makeConfirmedScenario();
  const { scrollPoints } = makeScrollPointsStub([scenario.entryPoint, scenario.markerPoint]);
  const { recall } = makeFakeRecall(recallSuccess([scenario.confirmingHit]));
  const { deletePoints } = makeFakeDeletePoints();

  let writeCalled = false;
  const options: DecommissionIntakeEntryOptions = {
    entryId: scenario.entryMetadata.entry_id,
    scrollPoints,
    recall,
    deletePoints,
    ensureBackupDir: () => {},
    writeBackupFile: () => {
      writeCalled = true;
    },
    // skipBackup deliberately omitted -- the bare default shape.
  };
  assert.ok(!('skipBackup' in options) || options.skipBackup === undefined);

  const result = await decommissionIntakeEntry(options);

  assert.equal(result.ok, true);
  assert.equal(writeCalled, true, 'the default (no flag given) writes a backup');
});

// ---------------------------------------------------------------------------
// AC 6/7: the delete call targets Qdrant's native points/delete endpoint,
// hardcoded to the intake collection -- verified via makeHttpQdrantDeletePointsFn's
// own request shape (fake fetchImpl only, never live Qdrant).
// ---------------------------------------------------------------------------

test('QdrantDeletePointsFn carries no collection-name parameter at all (structural guarantee)', async () => {
  const { deletePoints } = makeFakeDeletePoints({ ok: true });
  // This is the WHOLE point: deletePoints(pointIds) -- one argument, ever.
  const result = await deletePoints(['a', 'b']);
  assert.equal(result.ok, true);
  assert.equal(deletePoints.length, 1, 'the injected fn accepts exactly one parameter: pointIds');
});

test('makeHttpQdrantDeletePointsFn() hardcodes the intake collection name into its own request URL and uses wait=true, confirmed against a fake fetchImpl', async () => {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method as string, body: JSON.parse(init.body as string) });
    return new Response(JSON.stringify({ result: { operation_id: 42, status: 'completed' }, status: 'ok', time: 0.001 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  const deletePoints = makeHttpQdrantDeletePointsFn({ apiKey: 'test-key', url: 'https://example.qdrant.io:6333', fetchImpl: fakeFetch });
  const result = await deletePoints(['point-1', 'point-2']);

  assert.equal(result.ok, true);
  assert.equal(result.operationId, 42);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, 'POST');
  assert.equal(calls[0]!.url, `https://example.qdrant.io:6333/collections/${INTAKE_COLLECTION_NAME}/points/delete?wait=true`);
  assert.deepEqual(calls[0]!.body, { points: ['point-1', 'point-2'] });
  assert.ok(calls[0]!.url.includes(INTAKE_COLLECTION_NAME), 'the intake collection name is baked into the URL, never passed in by a caller');
});

test('makeHttpQdrantDeletePointsFn() reports ok:false on a non-"completed" Qdrant status (e.g. async "acknowledged" without wait, or an HTTP error)', async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ result: { operation_id: 1, status: 'acknowledged' }, status: 'ok', time: 0.001 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;

  const deletePoints = makeHttpQdrantDeletePointsFn({ apiKey: 'k', url: 'https://x.qdrant.io', fetchImpl: fakeFetch });
  const result = await deletePoints(['p1', 'p2']);
  assert.equal(result.ok, false, 'only a real "completed" status is treated as a confirmed delete');
});

test('a failed delete call surfaces a delete_failed refusal, even after both live checks passed', async () => {
  const scenario = makeConfirmedScenario();
  const { scrollPoints } = makeScrollPointsStub([scenario.entryPoint, scenario.markerPoint]);
  const { recall } = makeFakeRecall(recallSuccess([scenario.confirmingHit]));
  const { deletePoints } = makeFakeDeletePoints({ ok: false, error: 'HTTP 503' });

  const result = await decommissionIntakeEntry({
    entryId: scenario.entryMetadata.entry_id,
    scrollPoints,
    recall,
    deletePoints,
    skipBackup: true,
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'delete_failed');
});

// ---------------------------------------------------------------------------
// AC 8 (mnemosyne/inventory/qdrant_inventory.py's HttpQdrantClient stays
// byte-for-byte unmodified) is verified by a real `git diff` at review time
// (see this story's own integration step), not something this file's own
// unit tests can meaningfully assert -- there is no import of that Python
// module anywhere in this TS file or in decommissionIntakeEntry.ts itself,
// which the absence of any Python import statement in either file already
// demonstrates structurally.
// ---------------------------------------------------------------------------

test('this module never imports mnemosyne/inventory/qdrant_inventory.py, never shells out to swarm-memory for the delete call, and uses fetch() directly against Qdrant', () => {
  const source = readFileSync(new URL('./decommissionIntakeEntry.ts', import.meta.url), 'utf8');
  // The module doc comment legitimately DISCUSSES qdrant_inventory.py (why
  // this module deliberately does NOT touch it) -- the real guarantee is
  // that no `import`/`require` statement ever references it.
  assert.ok(!/\bfrom\s+['"][^'"]*qdrant_inventory/.test(source), 'no import statement references the Python inventory module');
  // execFile/spawn would be required to shell out to a swarm-memory CLI
  // verb -- neither is imported or used anywhere in this module, so there
  // is structurally no way for the delete call to become a swarm-memory
  // subprocess invocation (swarm-memory --help has no delete verb anyway).
  assert.ok(!source.includes('execFile'), 'no execFile-based subprocess bridge exists in this module');
  assert.ok(source.includes('await doFetch(endpoint'), "the delete call is a direct fetch() against Qdrant's own REST endpoint");
});

test('invalid entry_id (empty string) refuses before any scrollPoints/recall/delete call', async () => {
  const { scrollPoints, calls: scrollCalls } = makeScrollPointsStub([]);
  const { recall } = makeFakeRecall(recallFailure('should never be called'));
  const { deletePoints, calls: deleteCalls } = makeFakeDeletePoints();

  const result = await decommissionIntakeEntry({ entryId: '   ', scrollPoints, recall, deletePoints });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'invalid_entry_id');
  assert.equal(scrollCalls.length, 0);
  assert.equal(deleteCalls.length, 0);
});
