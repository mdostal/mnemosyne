// bin/mnemosyne-conversation-decommission.test.mjs — cm-14-intake-decommission
// (epic: mnemosyne-conversation-memory).
//
// Tests this CLI's own `runDecommission()` handler against hand-written
// fakes for scrollPoints/recall/deletePoints -- never a real subprocess,
// never a real MnemosyneClient, never live Qdrant. The real decision logic
// (marker/destination re-checks, backup ordering, delete scoping) is
// decommissionIntakeEntry.ts's own, already covered by its own dedicated
// test file -- this file only covers the CLI's OWN thin layer: flag
// parsing, the injectable-primitives requirement, and pass-through wiring.
//
// Run: npx tsx --test bin/mnemosyne-conversation-decommission.test.mjs

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { runDecommission } from './mnemosyne-conversation-decommission.mjs';
import { buildProvenanceHeader } from '../lib/mnemosyne/conversation-memory/distillAndRemember.ts';
import { buildDistributionMarkerHeader, INTAKE_COLLECTION_NAME } from '../lib/mnemosyne/conversation-memory/distributeIntakeEntries.ts';

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
  const marker = {
    entry_id: randomUUID(),
    entry_type: 'distribution_marker',
    marks_entry_id: entryId,
    distributed_to_scope: 'meta',
    distributed_at: new Date().toISOString(),
  };
  const markerText = buildDistributionMarkerHeader(marker);

  return {
    entryId,
    points: [
      { id: `point-${entryId}`, payload: { text: entryText } },
      { id: `point-${marker.entry_id}`, payload: { text: markerText } },
    ],
    entryText,
  };
}

test('rejects a missing --entry-id before touching any injected primitive', async () => {
  let called = false;
  const result = await runDecommission({
    scrollPoints: async () => {
      called = true;
      return [];
    },
    recall: async () => {
      called = true;
      return { ok: true, hits: [] };
    },
    deletePoints: async () => {
      called = true;
      return { ok: true };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(called, false);
});

test('throws if any of scrollPoints/recall/deletePoints is missing -- never a default production client constructed here', async () => {
  await assert.rejects(() => runDecommission({ entryId: 'x', scrollPoints: async () => [] }), /requires injectable/);
});

test('a full, wired, both-checks-passing invocation returns ok:true and calls deletePoints exactly once', async () => {
  const scenario = makeScenario();
  let deleteCallCount = 0;
  const result = await runDecommission({
    entryId: scenario.entryId,
    noBackup: true,
    scrollPoints: async (collectionName) => {
      assert.equal(collectionName, INTAKE_COLLECTION_NAME);
      return scenario.points;
    },
    recall: async (query, scope) => {
      assert.equal(query, 'Some real body.'); // body-only, header stripped (2026-09-08 fix)
      assert.equal(scope, 'meta');
      return {
        ok: true,
        query,
        scope,
        intent: 'broad',
        hits: [
          {
            content: scenario.entryText,
            provenance: {
              layer: 'vector',
              source: 'x',
              chunk_span: null,
              index_timestamp: null,
              content_hash: null,
              embedder: null,
              retrieval_time: null,
            },
          },
        ],
        layers_queried: ['vector'],
        layers_skipped: [],
        escalated: false,
        degraded: false,
      };
    },
    deletePoints: async (pointIds) => {
      deleteCallCount++;
      assert.equal(pointIds.length, 2);
      return { ok: true, operationId: 1, status: 'completed' };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(deleteCallCount, 1);
});

test('--no-backup flag maps to skipBackup: true (no backup write attempted)', async () => {
  const scenario = makeScenario();
  let backupAttempted = false;
  const result = await runDecommission({
    entryId: scenario.entryId,
    noBackup: true,
    scrollPoints: async () => scenario.points,
    recall: async (query, scope) => ({
      ok: true,
      query,
      scope,
      intent: 'broad',
      hits: [
        {
          content: scenario.entryText,
          provenance: { layer: 'vector', source: 'x', chunk_span: null, index_timestamp: null, content_hash: null, embedder: null, retrieval_time: null },
        },
      ],
      layers_queried: ['vector'],
      layers_skipped: [],
      escalated: false,
      degraded: false,
    }),
    deletePoints: async () => ({ ok: true }),
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.backupPath, null);
  assert.equal(backupAttempted, false);
});

test('refuses (no delete call) when scrollPoints reports no marker for this entry_id', async () => {
  const scenario = makeScenario();
  let deleteCalled = false;
  const result = await runDecommission({
    entryId: scenario.entryId,
    scrollPoints: async () => [scenario.points[0]], // marker point omitted
    recall: async () => ({ ok: false, query: 'q', scope: 'meta', intent: 'broad', error: { layer: null, message: 'should not be called' } }),
    deletePoints: async () => {
      deleteCalled = true;
      return { ok: true };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_marker_found');
  assert.equal(deleteCalled, false);
});
