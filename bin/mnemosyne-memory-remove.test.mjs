// bin/mnemosyne-memory-remove.test.mjs
//
// Tests this CLI's own `runRemove()` handler against hand-written fakes for
// scrollCollection/deletePoints -- never a real subprocess, never a real
// scope->collection resolution, never live Qdrant. The real decision logic
// (find/backup/delete) is removeMemoryEntry.ts's own, already covered by
// its own dedicated test file -- this file only covers the CLI's OWN thin
// layer: flag parsing, the injectable-primitives requirement, and
// pass-through wiring.
//
// Run: npx tsx --test bin/mnemosyne-memory-remove.test.mjs

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { runRemove } from './mnemosyne-memory-remove.mjs';
import { buildProvenanceHeader } from '../lib/mnemosyne/conversation-memory/distillAndRemember.ts';

function makeScenario() {
  const entryId = randomUUID();
  const entryMetadata = {
    entry_id: entryId,
    entry_type: 'decision',
    source: 'external_conversation',
    chat_source: 'claude-code',
    session_id: 's1',
    project_slug: null,
    cluster_id: null,
    resolved_scope_candidate: null,
  };
  const entryText = `${buildProvenanceHeader(entryMetadata)}\n\nSome real body.`;
  return {
    entryId,
    points: [{ id: `point-${entryId}`, payload: { text: entryText } }],
  };
}

test('rejects a missing --entry-id (via runCli\'s own usage message) before touching any injected primitive', async () => {
  let called = false;
  const result = await runRemove({
    entryId: '',
    collectionName: 'some_collection',
    scrollCollection: async () => {
      called = true;
      return [];
    },
    deletePoints: async () => {
      called = true;
      return { ok: true };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(called, false);
});

test('throws if scrollCollection/deletePoints are missing -- never a default production client constructed here', async () => {
  await assert.rejects(
    () => runRemove({ entryId: 'x', collectionName: 'y', scrollCollection: async () => [] }),
    /requires injectable/,
  );
});

test('rejects a missing collectionName -- the caller must resolve scope -> collection before calling this', async () => {
  const result = await runRemove({
    entryId: 'x',
    scrollCollection: async () => [],
    deletePoints: async () => ({ ok: true }),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /collectionName is required/);
});

test('a full, wired, matching invocation returns ok:true and calls deletePoints exactly once with the real point id', async () => {
  const scenario = makeScenario();
  let deleteCallCount = 0;
  const result = await runRemove({
    entryId: scenario.entryId,
    collectionName: 'conversation_memory_meta',
    noBackup: true,
    scrollCollection: async () => scenario.points,
    deletePoints: async (pointIds) => {
      deleteCallCount++;
      assert.deepEqual(pointIds, [scenario.points[0].id]);
      return { ok: true, operationId: 1, status: 'completed' };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(deleteCallCount, 1);
});

test('--no-backup flag maps to skipBackup: true (no backup write attempted)', async () => {
  const scenario = makeScenario();
  const result = await runRemove({
    entryId: scenario.entryId,
    collectionName: 'conversation_memory_meta',
    noBackup: true,
    scrollCollection: async () => scenario.points,
    deletePoints: async () => ({ ok: true }),
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.backupPath, null);
});

test('refuses (no delete call) when scrollCollection reports no matching point for this entry_id', async () => {
  let deleteCalled = false;
  const result = await runRemove({
    entryId: randomUUID(),
    collectionName: 'conversation_memory_meta',
    scrollCollection: async () => [],
    deletePoints: async () => {
      deleteCalled = true;
      return { ok: true };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(deleteCalled, false);
});
