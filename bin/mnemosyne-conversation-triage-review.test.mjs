// bin/mnemosyne-conversation-triage-review.test.mjs — cm-16-triage-review-
// and-confirm-ui (epic: mnemosyne-conversation-memory).
//
// Failing-first tests (TDD) for bin/mnemosyne-conversation-triage-review.mjs's
// own three real route-logic handlers: runReadTriageQueue(),
// runIntakeCandidates(), runConfirm(). Every test injects a hand-written
// fake `scrollPoints` -- never a real subprocess, never live Qdrant, never
// real personal content. Real fs IS used for the triage-queue file (plain
// tmp-dir JSONL read/append, no Qdrant/network involved at all -- mirrors
// distributeIntakeEntries.test.ts's own `writeConfirmations()` tmp-dir
// convention).
//
// THE HIGHEST-STAKES TEST in this file (last describe block below): spies
// on node:fs's real write-capable functions (via the DEFAULT export, the
// only form `mock.method()` can actually intercept for this module -- a
// named `import { appendFileSync }` elsewhere captures its own live
// binding that a mock on the default-export object never reaches, verified
// directly this story's own research step) across all THREE handlers in a
// single process, asserting exactly ONE appendFileSync call total and ZERO
// calls to any other write-capable fs function.
//
// Run: npx tsx --test bin/mnemosyne-conversation-triage-review.test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import { runConfirm, runIntakeCandidates, runReadTriageQueue } from './mnemosyne-conversation-triage-review.mjs';
import { buildProvenanceHeader } from '../lib/mnemosyne/conversation-memory/distillAndRemember.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEntryMetadata(overrides = {}) {
  return {
    entry_id: `entry-${Math.random().toString(36).slice(2)}`,
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

function makeCandidatePoint(metadata, body = 'Some real distilled body text.') {
  const header = buildProvenanceHeader(metadata);
  return { id: `point-${metadata.entry_id}`, payload: { text: `${header}\n\n${body}` } };
}

function makeScrollPointsStub(points) {
  const calls = [];
  return {
    calls,
    scrollPoints: async (collectionName) => {
      calls.push(collectionName);
      return points;
    },
  };
}

async function withTmpQueuePath(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cm16-triage-review-test-'));
  const queuePath = path.join(dir, 'conversation-triage-queue.jsonl');
  try {
    // Always awaited -- fn may be sync or async; awaiting a non-Promise
    // return value is a no-op, so this is safe either way and guarantees
    // the tmp dir is never cleaned up before an async fn's own real fs
    // calls (writeFileSync/readFileSync against queuePath) have run.
    return await fn(queuePath, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// runReadTriageQueue()
// ---------------------------------------------------------------------------

test('runReadTriageQueue: a missing queue file returns empty arrays with ok:true, never throws', () => {
  const result = runReadTriageQueue({ queuePath: '/tmp/cm16-does-not-exist/queue.jsonl' });
  assert.deepEqual(result, { ok: true, quarantine: [], confirmations: [] });
});

test('runReadTriageQueue: classifies quarantine hits and confirmations by their own real discriminator field, skips cm-05 triage verdicts', async () => {
  await withTmpQueuePath((queuePath) => {
    const quarantineEntry = {
      recordedAt: '2026-08-27T00:00:00.000Z',
      quarantine_reason: 'secret_detected',
      entry_id: 'q1',
      entry_type: 'decision',
      session_id: 's1',
      chat_source: 'claude-code',
      project_slug: null,
      cluster_id: null,
      secretMatches: [{ category: 'aws', pattern: 'aws-access-key-id', line: 1, index: 0, length: 20, preview: '[REDACTED]' }],
    };
    const confirmationEntry = {
      recordedAt: '2026-08-27T00:00:00.000Z',
      confirmation_reason: 'scope_route_confirmed',
      cluster_id: 'cluster-1',
      scope_key: 'arizona',
    };
    const triageVerdict = { recordedAt: '2026-08-27T00:00:00.000Z', sessionId: 's2', verdict: 'keep', summary: 'x', rationale: 'y' };
    writeFileSync(
      queuePath,
      [JSON.stringify(quarantineEntry), 'not valid json', JSON.stringify(triageVerdict), JSON.stringify(confirmationEntry), ''].join('\n'),
      'utf8',
    );

    const result = runReadTriageQueue({ queuePath });

    assert.equal(result.ok, true);
    assert.deepEqual(result.quarantine, [quarantineEntry]);
    assert.deepEqual(result.confirmations, [confirmationEntry]);
  });
});

// ---------------------------------------------------------------------------
// runIntakeCandidates()
// ---------------------------------------------------------------------------

test('runIntakeCandidates: requires an injectable scrollPoints -- never a default production Qdrant client', async () => {
  await assert.rejects(() => runIntakeCandidates({}), /requires an injectable scrollPoints/);
});

test('runIntakeCandidates: reuses computeIntakeCandidateStatuses() -- a real candidate is tagged candidate_unconfirmed', async () => {
  await withTmpQueuePath(async (queuePath) => {
    writeFileSync(queuePath, '', 'utf8');
    const metadata = makeEntryMetadata({ cluster_id: 'cluster-1', resolved_scope_candidate: { scope_key: 'arizona', collection: 'clients_arizona_memory', matched_registry: 'swarm-memory-scopes', review_reason: 'scope_route_candidate' } });
    const point = makeCandidatePoint(metadata);
    const { scrollPoints } = makeScrollPointsStub([point]);

    const result = await runIntakeCandidates({ scrollPoints, confirmationQueuePath: queuePath });

    assert.equal(result.ok, true);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].status, 'candidate_unconfirmed');
    assert.equal(result.candidates[0].clusterId, 'cluster-1');
    assert.equal(result.candidates[0].scopeKey, 'arizona');
  });
});

// ---------------------------------------------------------------------------
// runConfirm() -- refusal, success, and duplicate-tolerance cases.
// ---------------------------------------------------------------------------

test('runConfirm: refuses (ok:false) a pair that matches NO currently-known candidate_unconfirmed row -- zero fs writes', async () => {
  await withTmpQueuePath(async (queuePath) => {
    writeFileSync(queuePath, '', 'utf8');
    const { scrollPoints } = makeScrollPointsStub([]); // no candidates at all

    const appendCalls = [];
    const result = await runConfirm({
      clusterId: 'cluster-does-not-exist',
      scopeKey: 'arizona',
      scrollPoints,
      queuePath,
      append: (...args) => appendCalls.push(args),
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /refused/);
    assert.equal(appendCalls.length, 0, 'a refused confirm must append nothing');
  });
});

test('runConfirm: refuses a stale/mismatched pair (right cluster_id, WRONG scope_key) -- zero fs writes', async () => {
  await withTmpQueuePath(async (queuePath) => {
    writeFileSync(queuePath, '', 'utf8');
    const metadata = makeEntryMetadata({
      cluster_id: 'cluster-1',
      resolved_scope_candidate: { scope_key: 'arizona', collection: 'clients_arizona_memory', matched_registry: 'swarm-memory-scopes', review_reason: 'scope_route_candidate' },
    });
    const { scrollPoints } = makeScrollPointsStub([makeCandidatePoint(metadata)]);

    const appendCalls = [];
    const result = await runConfirm({
      clusterId: 'cluster-1',
      scopeKey: 'totally-wrong-scope',
      scrollPoints,
      queuePath,
      append: (...args) => appendCalls.push(args),
    });

    assert.equal(result.ok, false);
    assert.equal(appendCalls.length, 0);
  });
});

test('runConfirm: a real candidate_unconfirmed pair succeeds -- appends exactly one real ScopeRouteConfirmationEntry line, an append only (never a rewrite)', async () => {
  await withTmpQueuePath(async (queuePath) => {
    writeFileSync(queuePath, JSON.stringify({ preexisting: 'line', untouched: true }) + '\n', 'utf8');
    const metadata = makeEntryMetadata({
      cluster_id: 'cluster-1',
      resolved_scope_candidate: { scope_key: 'arizona', collection: 'clients_arizona_memory', matched_registry: 'swarm-memory-scopes', review_reason: 'scope_route_candidate' },
    });
    const { scrollPoints } = makeScrollPointsStub([makeCandidatePoint(metadata)]);

    const appendCalls = [];
    const result = await runConfirm({
      clusterId: 'cluster-1',
      scopeKey: 'arizona',
      scrollPoints,
      queuePath,
      now: () => new Date('2026-08-27T12:00:00.000Z'),
      append: (...args) => appendCalls.push(args),
      mkdir: () => {},
    });

    assert.equal(result.ok, true);
    assert.equal(result.confirmed, true);
    assert.deepEqual(result.entry, {
      recordedAt: '2026-08-27T12:00:00.000Z',
      confirmation_reason: 'scope_route_confirmed',
      cluster_id: 'cluster-1',
      scope_key: 'arizona',
    });
    assert.equal(appendCalls.length, 1, 'exactly one append call');
    assert.equal(appendCalls[0][0], queuePath);
    assert.equal(appendCalls[0][1], JSON.stringify(result.entry) + '\n');

    // The real, on-disk pre-existing line is genuinely untouched -- this
    // test's own `append` fake never actually writes, so assert directly
    // against the queue file's real, unmodified content.
    const onDisk = fs.readFileSync(queuePath, 'utf8');
    assert.equal(onDisk, JSON.stringify({ preexisting: 'line', untouched: true }) + '\n');
  });
});

test('runConfirm: a DUPLICATE confirm of an already-confirmed pair succeeds (never refused) -- mirrors distributeIntakeEntries.ts\'s own tolerated-duplicate posture', async () => {
  await withTmpQueuePath(async (queuePath) => {
    // A real confirmation for this EXACT pair already exists on disk.
    writeFileSync(
      queuePath,
      JSON.stringify({ recordedAt: '2026-08-27T00:00:00.000Z', confirmation_reason: 'scope_route_confirmed', cluster_id: 'cluster-1', scope_key: 'arizona' }) + '\n',
      'utf8',
    );
    const metadata = makeEntryMetadata({
      cluster_id: 'cluster-1',
      resolved_scope_candidate: { scope_key: 'arizona', collection: 'clients_arizona_memory', matched_registry: 'swarm-memory-scopes', review_reason: 'scope_route_candidate' },
    });
    const { scrollPoints } = makeScrollPointsStub([makeCandidatePoint(metadata)]); // no distribution_marker yet -> candidate_confirmed_pending_distribution

    const appendCalls = [];
    const result = await runConfirm({
      clusterId: 'cluster-1',
      scopeKey: 'arizona',
      scrollPoints,
      queuePath,
      append: (...args) => appendCalls.push(args),
      mkdir: () => {},
    });

    assert.equal(result.ok, true, 'a duplicate confirm must succeed, never be refused');
    assert.equal(appendCalls.length, 1, 'a harmless second line is appended');

    // readScopeRouteConfirmations()'s own Set-based dedup still resolves
    // correctly afterward -- prove it directly against the REAL file
    // (both real lines actually written this time, no append fake).
    const realQueuePath = queuePath;
    writeFileSync(
      realQueuePath,
      JSON.stringify({ recordedAt: '2026-08-27T00:00:00.000Z', confirmation_reason: 'scope_route_confirmed', cluster_id: 'cluster-1', scope_key: 'arizona' }) + '\n' +
        JSON.stringify(result.entry) + '\n',
      'utf8',
    );
    const { readScopeRouteConfirmations } = await import('../lib/mnemosyne/conversation-memory/distributeIntakeEntries.ts');
    const confirmed = readScopeRouteConfirmations(realQueuePath);
    assert.equal(confirmed.size, 1, 'two duplicate lines for the SAME pair still dedup to one Set entry');
    // readScopeRouteConfirmations()'s own confirmationKey() joins with a
    // real NUL byte (`\0`), not a space -- confirmed directly against the
    // real function's own output rather than assumed from its doc comment.
    assert.ok(confirmed.has('cluster-1\x00arizona'));
  });
});

test('runConfirm: rejects when scrollPoints is missing -- never a default production Qdrant client constructed here', async () => {
  await assert.rejects(() => runConfirm({ clusterId: 'c', scopeKey: 's' }), /requires an injectable scrollPoints/);
});

// ---------------------------------------------------------------------------
// THE HIGHEST-STAKES TEST — an fs write-capable-function spy across ALL
// THREE route handlers in one process: exactly one appendFileSync call
// total, zero calls to any other write-capable fs function.
// ---------------------------------------------------------------------------

test('fs write-capable-function spy: across runReadTriageQueue()+runIntakeCandidates()+runConfirm(), EXACTLY ONE appendFileSync call occurs and ZERO other fs write/truncate/unlink calls occur', async () => {
  await withTmpQueuePath(async (queuePath) => {
    writeFileSync(queuePath, '', 'utf8'); // pre-seed via the REAL fs, before any spy is installed
    const metadata = makeEntryMetadata({
      cluster_id: 'cluster-1',
      resolved_scope_candidate: { scope_key: 'arizona', collection: 'clients_arizona_memory', matched_registry: 'swarm-memory-scopes', review_reason: 'scope_route_candidate' },
    });
    const { scrollPoints } = makeScrollPointsStub([makeCandidatePoint(metadata)]);

    // Spy on every node:fs write-capable function this story's own hard
    // constraint names -- write/truncate/unlink, sync AND async forms --
    // via the DEFAULT export (the only form mock.method() can intercept
    // for a module whose real call sites use `fs.<fn>(...)`, per this
    // file's own header comment). mkdirSync is deliberately NOT included --
    // this codebase's own established convention (triageSession.ts,
    // distillAndRemember.ts) already treats directory-creation as distinct
    // from a data write/truncate/unlink.
    const spies = {
      appendFileSync: mock.method(fs, 'appendFileSync', () => {}),
      writeFileSync: mock.method(fs, 'writeFileSync', () => {}),
      truncateSync: mock.method(fs, 'truncateSync', () => {}),
      unlinkSync: mock.method(fs, 'unlinkSync', () => {}),
      writeFile: mock.method(fs, 'writeFile', (...cbArgs) => cbArgs.at(-1)?.(null)),
      truncate: mock.method(fs, 'truncate', (...cbArgs) => cbArgs.at(-1)?.(null)),
      unlink: mock.method(fs, 'unlink', (...cbArgs) => cbArgs.at(-1)?.(null)),
      rmSync: mock.method(fs, 'rmSync', () => {}),
    };

    try {
      // Route 1: GET /conversation-memory/triage-queue -- pure read.
      const queueResult = runReadTriageQueue({ queuePath });
      assert.equal(queueResult.ok, true);

      // Route 2: GET /conversation-memory/intake-candidates -- pure read.
      const candidatesResult = await runIntakeCandidates({ scrollPoints, confirmationQueuePath: queuePath });
      assert.equal(candidatesResult.ok, true);

      // Route 3: POST /conversation-memory/scope-route/confirm -- the ONE
      // real write in this story's entire route surface. Uses the REAL
      // default `append`/`mkdir` (fs.appendFileSync/fs.mkdirSync) -- no
      // override passed here -- so this genuinely exercises the production
      // code path the spy is meant to observe.
      const confirmResult = await runConfirm({ clusterId: 'cluster-1', scopeKey: 'arizona', scrollPoints, queuePath });
      assert.equal(confirmResult.ok, true);

      assert.equal(spies.appendFileSync.mock.callCount(), 1, 'exactly one appendFileSync call across all three routes');
      assert.equal(spies.writeFileSync.mock.callCount(), 0, 'zero writeFileSync calls');
      assert.equal(spies.truncateSync.mock.callCount(), 0, 'zero truncateSync calls');
      assert.equal(spies.unlinkSync.mock.callCount(), 0, 'zero unlinkSync calls');
      assert.equal(spies.writeFile.mock.callCount(), 0, 'zero async writeFile calls');
      assert.equal(spies.truncate.mock.callCount(), 0, 'zero async truncate calls');
      assert.equal(spies.unlink.mock.callCount(), 0, 'zero async unlink calls');
      assert.equal(spies.rmSync.mock.callCount(), 0, 'zero rmSync calls');
    } finally {
      for (const spy of Object.values(spies)) spy.mock.restore();
    }
  });
});
