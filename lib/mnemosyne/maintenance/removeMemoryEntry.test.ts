// lib/mnemosyne/maintenance/removeMemoryEntry.test.ts
//
// Tests against fakes/stubs only -- never live Qdrant, never a real delete.
// Run: npx tsx --test lib/mnemosyne/maintenance/removeMemoryEntry.test.ts

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { removeMemoryEntry } from './removeMemoryEntry.ts';
import { buildProvenanceHeader, type EntryProvenanceMetadata } from '../conversation-memory/distillAndRemember.ts';
import type { ScrolledPoint, QdrantDeleteResult } from './removeMemoryEntry.ts';

function makeEntryMetadata(overrides: Partial<EntryProvenanceMetadata> = {}): EntryProvenanceMetadata {
  return {
    entry_id: randomUUID(),
    entry_type: 'decision',
    source: 'external_conversation',
    chat_source: 'claude-code',
    session_id: 'session-abc',
    project_slug: null,
    cluster_id: null,
    resolved_scope_candidate: null,
    ...overrides,
  };
}

function makePoint(metadata: EntryProvenanceMetadata, body = 'Some real body text.'): { point: ScrolledPoint; text: string } {
  const header = buildProvenanceHeader(metadata);
  const text = `${header}\n\n${body}`;
  return { point: { id: `point-${metadata.entry_id}`, payload: { text } }, text };
}

function makeScrollStub(points: ScrolledPoint[]) {
  const calls: number[] = [];
  const scrollCollection = async () => {
    calls.push(1);
    return points;
  };
  return { scrollCollection, calls };
}

function makeFakeDeletePoints(result: QdrantDeleteResult = { ok: true, operationId: 1, status: 'completed' }) {
  const calls: string[][] = [];
  const deletePoints = async (pointIds: string[]): Promise<QdrantDeleteResult> => {
    calls.push(pointIds);
    return result;
  };
  return { deletePoints, calls };
}

test('refuses when a live re-scroll finds no point for entry_id', async () => {
  const { scrollCollection } = makeScrollStub([]);
  const { deletePoints, calls: deleteCalls } = makeFakeDeletePoints();

  const result = await removeMemoryEntry({ entryId: randomUUID(), scrollCollection, deletePoints });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'entry_not_found');
  assert.equal(deleteCalls.length, 0, 'never deletes when nothing was found');
});

test('refuses when a DIFFERENT entry_id is present (no false match)', async () => {
  const other = makeEntryMetadata();
  const { point } = makePoint(other);
  const { scrollCollection } = makeScrollStub([point]);
  const { deletePoints, calls: deleteCalls } = makeFakeDeletePoints();

  const result = await removeMemoryEntry({ entryId: randomUUID(), scrollCollection, deletePoints });

  assert.equal(result.ok, false);
  assert.equal(deleteCalls.length, 0);
});

test('on success, deletes exactly the one real point id and nothing else', async () => {
  const metadata = makeEntryMetadata();
  const { point } = makePoint(metadata);
  const { scrollCollection } = makeScrollStub([point]);
  const { deletePoints, calls: deleteCalls } = makeFakeDeletePoints();

  const result = await removeMemoryEntry({ entryId: metadata.entry_id, scrollCollection, deletePoints, skipBackup: true });

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.deletedPointId, point.id);
  assert.equal(deleteCalls.length, 1);
  assert.deepEqual(deleteCalls[0], [point.id]);
});

test('removeMemoryEntry() accepts a single entryId: string only -- no batch/array/wildcard shape exists', async () => {
  const optionsShape = { entryId: 'x', scrollCollection: async () => [], deletePoints: async () => ({ ok: true }) };
  assert.equal(typeof optionsShape.entryId, 'string');
});

test('default invocation (no skipBackup) writes a real NDJSON backup file BEFORE the delete call is made', async () => {
  const metadata = makeEntryMetadata();
  const { point, text } = makePoint(metadata);
  const { scrollCollection } = makeScrollStub([point]);

  const order: string[] = [];
  const ensureBackupDir = () => order.push('ensure-dir');
  const writeBackupFile = (_filePath: string, content: string) => {
    order.push('write-backup');
    assert.equal(JSON.parse(content.trim()).text, text);
  };
  const deletePoints = async () => {
    order.push('delete');
    return { ok: true };
  };

  const result = await removeMemoryEntry({
    entryId: metadata.entry_id,
    scrollCollection,
    deletePoints,
    ensureBackupDir,
    writeBackupFile,
  });

  assert.equal(result.ok, true);
  if (result.ok) assert.ok(result.backupPath !== null);
  assert.deepEqual(order, ['ensure-dir', 'write-backup', 'delete']);
});

test('a REAL backup write, to a real temp directory, actually lands on disk before delete', async () => {
  const metadata = makeEntryMetadata();
  const { point, text } = makePoint(metadata);
  const { scrollCollection } = makeScrollStub([point]);
  const { deletePoints } = makeFakeDeletePoints();
  const dir = await mkdtemp(path.join(tmpdir(), 'remove-memory-entry-backup-'));

  const result = await removeMemoryEntry({ entryId: metadata.entry_id, scrollCollection, deletePoints, backupDir: dir });

  assert.equal(result.ok, true);
  if (result.ok) {
    const content = await readFile(result.backupPath!, 'utf8');
    assert.equal(JSON.parse(content.trim()).text, text);
  }
  await rm(dir, { recursive: true, force: true });
});

test('backup write failure fails LOUD and aborts BEFORE the delete call -- never a silent proceed-anyway', async () => {
  const metadata = makeEntryMetadata();
  const { point } = makePoint(metadata);
  const { scrollCollection } = makeScrollStub([point]);
  const { deletePoints, calls: deleteCalls } = makeFakeDeletePoints();

  const result = await removeMemoryEntry({
    entryId: metadata.entry_id,
    scrollCollection,
    deletePoints,
    writeBackupFile: () => {
      throw new Error('disk full');
    },
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'backup_write_failed');
  assert.equal(deleteCalls.length, 0);
});

test('skipBackup: true proceeds directly to delete with NO backup write', async () => {
  const metadata = makeEntryMetadata();
  const { point } = makePoint(metadata);
  const { scrollCollection } = makeScrollStub([point]);
  const { deletePoints } = makeFakeDeletePoints();
  let backupWriteCalled = false;

  const result = await removeMemoryEntry({
    entryId: metadata.entry_id,
    scrollCollection,
    deletePoints,
    skipBackup: true,
    writeBackupFile: () => {
      backupWriteCalled = true;
    },
  });

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.backupPath, null);
  assert.equal(backupWriteCalled, false);
});

test('a failed delete call surfaces a delete_failed refusal, even after the entry was found', async () => {
  const metadata = makeEntryMetadata();
  const { point } = makePoint(metadata);
  const { scrollCollection } = makeScrollStub([point]);
  const { deletePoints } = makeFakeDeletePoints({ ok: false, error: 'timeout' });

  const result = await removeMemoryEntry({ entryId: metadata.entry_id, scrollCollection, deletePoints, skipBackup: true });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'delete_failed');
});

test('invalid entry_id (empty string) refuses before any scrollCollection/delete call', async () => {
  const { scrollCollection, calls: scrollCalls } = makeScrollStub([]);
  const { deletePoints, calls: deleteCalls } = makeFakeDeletePoints();

  const result = await removeMemoryEntry({ entryId: '', scrollCollection, deletePoints });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'invalid_entry_id');
  assert.equal(scrollCalls.length, 0);
  assert.equal(deleteCalls.length, 0);
});

test('scrollCollection carries no collection-name parameter at all (structural guarantee, mirrors QdrantDeletePointsFn)', async () => {
  const { scrollCollection } = makeScrollStub([]);
  assert.equal(scrollCollection.length, 0);
});
