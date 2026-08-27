/**
 * cm-13-intake-distribution (epic: mnemosyne-conversation-memory).
 *
 * Failing-first tests (TDD) for `distributeIntakeEntries.ts`, against a FAKE
 * `IngestClient` and a STUBBED `scrollPoints()` -- never live Qdrant (this
 * story's own hard constraint, mirrors `distillAndRemember.test.ts`'s own
 * convention exactly). `ingestDocument.js` is module-mocked with
 * `vi.mock(..., importOriginal)`, wrapping the REAL implementation in
 * `vi.fn()` -- every call is observable while behavior stays genuinely real.
 *
 * Covers this story's acceptance criteria (see
 * `.pHive/epics/mnemosyne-conversation-memory/stories/
 * cm-13-intake-distribution.yaml`):
 *  1. No candidate -> scope: 'meta'.
 *  2. Unconfirmed candidate -> scope: 'meta' -- destination remember()
 *     call's scope argument asserted exactly 'meta'.
 *  3. Confirmed candidate (real on-disk confirmation, matching cluster_id
 *     AND scope_key) -> scope: the confirmed real value -- destination
 *     remember() call's arguments inspected directly.
 *  4. Mismatched confirmation (different cluster_id, or same cluster_id but
 *     different scope_key) -> IGNORED, falls back to 'meta'.
 *  5. Successful destination write also writes an additive
 *     distribution_marker entry into the SAME intake collection; the
 *     original entry's own point is never re-written/mutated/deleted.
 *  6. An entry with an existing matching marker is skipped entirely -- zero
 *     remember() calls reference that entry_id.
 *  7. scroll_points() is called ONLY against the intake collection's own
 *     fixed name.
 *  8. ingestDocument() is the real, unchanged primitive (module-mocked
 *     wrapper around the genuine implementation).
 *  9. A destination-write failure never triggers a marker write.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Content, RememberResult, Scope } from '../interfaces.js';
import type { ResolvedScopeCandidate } from './clusterConversations.js';

vi.mock('../ingest/ingestDocument.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ingest/ingestDocument.js')>();
  return { ...actual, ingestDocument: vi.fn(actual.ingestDocument) };
});

import { ingestDocument, type IngestClient, type IngestDocumentResult } from '../ingest/ingestDocument.js';
import { buildProvenanceHeader, type EntryProvenanceMetadata } from './distillAndRemember.js';
import {
  INTAKE_COLLECTION_NAME,
  buildDistributionMarkerHeader,
  computeIntakeCandidateStatuses,
  distributeIntakeEntries,
  isScopeRouteConfirmationEntry,
  readScopeRouteConfirmations,
  resolveDestinationScope,
  type DistributionMarkerMetadata,
  type ScrolledPoint,
  type ScrollPointsFn,
} from './distributeIntakeEntries.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeResolvedScopeCandidate(overrides: Partial<ResolvedScopeCandidate> = {}): ResolvedScopeCandidate {
  return {
    scope_key: 'arizona',
    collection: 'clients_arizona_compound_memory',
    matched_registry: 'swarm-memory-scopes',
    review_reason: 'scope_route_candidate',
    ...overrides,
  };
}

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

function makeCandidatePoint(metadata: EntryProvenanceMetadata, body = 'Some real distilled body text.'): ScrolledPoint {
  const header = buildProvenanceHeader(metadata);
  return { id: `point-${metadata.entry_id}`, payload: { text: `${header}\n\n${body}` } };
}

function makeMarkerPoint(marker: DistributionMarkerMetadata): ScrolledPoint {
  return { id: `point-${marker.entry_id}`, payload: { text: buildDistributionMarkerHeader(marker) } };
}

function makeScrollPointsStub(points: ScrolledPoint[]): {
  scrollPoints: ScrollPointsFn;
  calls: Array<{ collectionName: string; payloadFilter?: Record<string, unknown> | null }>;
} {
  const calls: Array<{ collectionName: string; payloadFilter?: Record<string, unknown> | null }> = [];
  const scrollPoints: ScrollPointsFn = async (collectionName, payloadFilter) => {
    calls.push(payloadFilter === undefined ? { collectionName } : { collectionName, payloadFilter });
    return points;
  };
  return { scrollPoints, calls };
}

interface RememberCall {
  content: Content;
  scope: Scope;
}

/** Fake IngestClient -- never a live Qdrant write. Records every remember() call. */
function makeFakeIngestClient(): { client: IngestClient; calls: RememberCall[] } {
  const calls: RememberCall[] = [];
  const client: IngestClient = {
    async remember(content: Content, scope: Scope): Promise<RememberResult> {
      calls.push({ content, scope });
      return {
        ok: true,
        layer: 'vector',
        provenance: {
          layer: 'vector',
          source: `fake:point:${randomUUID()}`,
          chunk_span: { index: 0 },
          index_timestamp: '2026-08-27T00:00:00.000Z',
          content_hash: 'deadbeef',
          embedder: 'fake-embedder',
          retrieval_time: null,
        },
      } as RememberResult;
    },
  };
  return { client, calls };
}

/** Always-fails IngestClient -- used to prove a destination-write failure never triggers a marker write. */
function makeFailingIngestClient(): { client: IngestClient; calls: RememberCall[] } {
  const calls: RememberCall[] = [];
  const client: IngestClient = {
    async remember(content: Content, scope: Scope): Promise<RememberResult> {
      calls.push({ content, scope });
      return { ok: false, error: { layer: null, message: 'fake failure' } };
    },
  };
  return { client, calls };
}

let tmpDir: string;
let confirmationQueuePath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'cm13-distribute-test-'));
  confirmationQueuePath = path.join(tmpDir, 'conversation-triage-queue.jsonl');
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeConfirmations(entries: Array<{ cluster_id: string; scope_key: string }>): void {
  mkdirSync(path.dirname(confirmationQueuePath), { recursive: true });
  const lines = entries.map((entry) =>
    JSON.stringify({ recordedAt: '2026-08-27T00:00:00.000Z', confirmation_reason: 'scope_route_confirmed', ...entry }),
  );
  writeFileSync(confirmationQueuePath, lines.length > 0 ? lines.join('\n') + '\n' : '', 'utf8');
}

// ---------------------------------------------------------------------------
// resolveDestinationScope() -- dedicated, direct unit tests for all four
// routing cases (this story's own highest-stakes checkpoint).
// ---------------------------------------------------------------------------

describe('resolveDestinationScope() -- the four required cases', () => {
  it('case 1: no candidate -> meta', () => {
    const metadata = makeEntryMetadata({ resolved_scope_candidate: null });
    const result = resolveDestinationScope(metadata, new Set());
    expect(result.scope).toBe('meta');
    expect(result.scopeKey).toBeNull();
  });

  it('case 2: unconfirmed candidate (real candidate, no confirmation on disk at all) -> meta', () => {
    const metadata = makeEntryMetadata({
      cluster_id: 'cluster-1',
      resolved_scope_candidate: makeResolvedScopeCandidate({ scope_key: 'arizona' }),
    });
    const result = resolveDestinationScope(metadata, new Set());
    expect(result.scope).toBe('meta');
    expect(result.scopeKey).toBeNull();
  });

  it('case 3: confirmed candidate (real, on-disk confirmation naming the EXACT cluster_id + scope_key) -> the confirmed real scope', () => {
    const metadata = makeEntryMetadata({
      cluster_id: 'cluster-1',
      resolved_scope_candidate: makeResolvedScopeCandidate({ scope_key: 'arizona' }),
    });
    const confirmed = readScopeRouteConfirmationsFromFixture([{ cluster_id: 'cluster-1', scope_key: 'arizona' }]);
    const result = resolveDestinationScope(metadata, confirmed);
    expect(result.scope).toBe('arizona');
    expect(result.scopeKey).toBe('arizona');
  });

  it('case 4a: mismatched confirmation (confirmation names a DIFFERENT cluster_id) -> meta', () => {
    const metadata = makeEntryMetadata({
      cluster_id: 'cluster-1',
      resolved_scope_candidate: makeResolvedScopeCandidate({ scope_key: 'arizona' }),
    });
    const confirmed = readScopeRouteConfirmationsFromFixture([{ cluster_id: 'cluster-DIFFERENT', scope_key: 'arizona' }]);
    const result = resolveDestinationScope(metadata, confirmed);
    expect(result.scope).toBe('meta');
    expect(result.scopeKey).toBeNull();
  });

  it('case 4b: mismatched confirmation (SAME cluster_id, but a DIFFERENT scope_key) -> meta', () => {
    const metadata = makeEntryMetadata({
      cluster_id: 'cluster-1',
      resolved_scope_candidate: makeResolvedScopeCandidate({ scope_key: 'arizona' }),
    });
    const confirmed = readScopeRouteConfirmationsFromFixture([{ cluster_id: 'cluster-1', scope_key: 'some-other-scope' }]);
    const result = resolveDestinationScope(metadata, confirmed);
    expect(result.scope).toBe('meta');
    expect(result.scopeKey).toBeNull();
  });

  it('candidate present but cluster_id is null (should not happen in real data, defended anyway) -> meta', () => {
    const metadata = makeEntryMetadata({
      cluster_id: null,
      resolved_scope_candidate: makeResolvedScopeCandidate({ scope_key: 'arizona' }),
    });
    const confirmed = readScopeRouteConfirmationsFromFixture([{ cluster_id: 'cluster-1', scope_key: 'arizona' }]);
    const result = resolveDestinationScope(metadata, confirmed);
    expect(result.scope).toBe('meta');
  });
});

function readScopeRouteConfirmationsFromFixture(entries: Array<{ cluster_id: string; scope_key: string }>): Set<string> {
  const dir = mkdtempSync(path.join(tmpdir(), 'cm13-confirmations-fixture-'));
  const queuePath = path.join(dir, 'queue.jsonl');
  const lines = entries.map((entry) =>
    JSON.stringify({ recordedAt: '2026-08-27T00:00:00.000Z', confirmation_reason: 'scope_route_confirmed', ...entry }),
  );
  writeFileSync(queuePath, lines.length > 0 ? lines.join('\n') + '\n' : '', 'utf8');
  const result = readScopeRouteConfirmations(queuePath);
  rmSync(dir, { recursive: true, force: true });
  return result;
}

describe('readScopeRouteConfirmations()', () => {
  it('a queue file that does not exist yet returns an empty set, never throws (mirrors ro-04\'s own convention)', () => {
    const result = readScopeRouteConfirmations(path.join(tmpDir, 'does-not-exist.jsonl'));
    expect(result.size).toBe(0);
  });

  it('malformed lines are skipped defensively, never abort the whole read', () => {
    mkdirSync(path.dirname(confirmationQueuePath), { recursive: true });
    writeFileSync(
      confirmationQueuePath,
      [
        'not valid json at all',
        JSON.stringify({ confirmation_reason: 'scope_route_confirmed', cluster_id: 'cluster-1', scope_key: 'arizona' }),
        JSON.stringify({ someOtherRecordKind: true }),
        '',
      ].join('\n'),
      'utf8',
    );
    const result = readScopeRouteConfirmations(confirmationQueuePath);
    expect(result.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// distributeIntakeEntries() -- integration-level tests, inspecting the ACTUAL
// remember() call arguments (via the fake IngestClient), not just outcomes.
// ---------------------------------------------------------------------------

describe('distributeIntakeEntries() -- destination routing, inspecting real remember() call arguments', () => {
  it('AC1/case1: no candidate -> destination remember() call scope is exactly "meta"', async () => {
    const { client, calls } = makeFakeIngestClient();
    const metadata = makeEntryMetadata({ cluster_id: null, resolved_scope_candidate: null });
    const point = makeCandidatePoint(metadata);
    const { scrollPoints } = makeScrollPointsStub([point]);
    writeConfirmations([]);

    const result = await distributeIntakeEntries({ client, scrollPoints, confirmationQueuePath });

    expect(calls).toHaveLength(2); // destination + marker
    expect(calls[0]!.scope).toBe('meta');
    expect(calls[0]!.content.text).toBe(point.payload.text);
    expect(result.distributed).toHaveLength(1);
    expect(result.distributed[0]!.destinationScope).toBe('meta');
    expect(result.distributed[0]!.ok).toBe(true);
  });

  it('AC2/case2: unconfirmed candidate -> destination remember() call scope is exactly "meta"', async () => {
    const { client, calls } = makeFakeIngestClient();
    const metadata = makeEntryMetadata({
      cluster_id: 'cluster-1',
      resolved_scope_candidate: makeResolvedScopeCandidate({ scope_key: 'arizona' }),
    });
    const point = makeCandidatePoint(metadata);
    const { scrollPoints } = makeScrollPointsStub([point]);
    writeConfirmations([]); // no confirmation recorded anywhere

    await distributeIntakeEntries({ client, scrollPoints, confirmationQueuePath });

    expect(calls[0]!.scope).toBe('meta');
  });

  it('AC3/case3: confirmed candidate -> destination remember() call scope is the confirmed real value, full provenance unchanged', async () => {
    const { client, calls } = makeFakeIngestClient();
    const metadata = makeEntryMetadata({
      cluster_id: 'cluster-1',
      resolved_scope_candidate: makeResolvedScopeCandidate({ scope_key: 'arizona' }),
    });
    const point = makeCandidatePoint(metadata);
    const { scrollPoints } = makeScrollPointsStub([point]);
    writeConfirmations([{ cluster_id: 'cluster-1', scope_key: 'arizona' }]);

    const result = await distributeIntakeEntries({ client, scrollPoints, confirmationQueuePath });

    expect(calls[0]!.scope).toBe('arizona' as unknown as Scope);
    // Full provenance-metadata contract unchanged -- the SAME persisted text
    // (header + body) travels to the destination, byte for byte.
    expect(calls[0]!.content.text).toBe(point.payload.text);
    expect(result.distributed[0]!.destinationScope).toBe('arizona');
  });

  it('AC4a/case4a: confirmation naming a DIFFERENT cluster_id is ignored -> falls back to meta, never applied to this entry', async () => {
    const { client, calls } = makeFakeIngestClient();
    const metadata = makeEntryMetadata({
      cluster_id: 'cluster-1',
      resolved_scope_candidate: makeResolvedScopeCandidate({ scope_key: 'arizona' }),
    });
    const point = makeCandidatePoint(metadata);
    const { scrollPoints } = makeScrollPointsStub([point]);
    // A real confirmation exists, but for a DIFFERENT cluster -- a stale/mismatched record.
    writeConfirmations([{ cluster_id: 'some-other-cluster', scope_key: 'arizona' }]);

    const result = await distributeIntakeEntries({ client, scrollPoints, confirmationQueuePath });

    expect(calls[0]!.scope).toBe('meta');
    expect(result.distributed[0]!.destinationScope).toBe('meta');
  });

  it('AC4b: confirmation naming the SAME cluster_id but a DIFFERENT scope_key is ignored -> falls back to meta', async () => {
    const { client, calls } = makeFakeIngestClient();
    const metadata = makeEntryMetadata({
      cluster_id: 'cluster-1',
      resolved_scope_candidate: makeResolvedScopeCandidate({ scope_key: 'arizona' }),
    });
    const point = makeCandidatePoint(metadata);
    const { scrollPoints } = makeScrollPointsStub([point]);
    writeConfirmations([{ cluster_id: 'cluster-1', scope_key: 'a-totally-different-scope' }]);

    await distributeIntakeEntries({ client, scrollPoints, confirmationQueuePath });

    expect(calls[0]!.scope).toBe('meta');
  });

  it('never applies one entry\'s confirmation to a DIFFERENT entry processed in the same run', async () => {
    const { client, calls } = makeFakeIngestClient();
    const confirmedMetadata = makeEntryMetadata({
      cluster_id: 'cluster-1',
      resolved_scope_candidate: makeResolvedScopeCandidate({ scope_key: 'arizona' }),
    });
    const unrelatedMetadata = makeEntryMetadata({
      cluster_id: 'cluster-2',
      resolved_scope_candidate: makeResolvedScopeCandidate({ scope_key: 'arizona' }),
    });
    const points = [makeCandidatePoint(confirmedMetadata), makeCandidatePoint(unrelatedMetadata)];
    const { scrollPoints } = makeScrollPointsStub(points);
    writeConfirmations([{ cluster_id: 'cluster-1', scope_key: 'arizona' }]);

    await distributeIntakeEntries({ client, scrollPoints, confirmationQueuePath });

    const destinationCalls = [calls[0]!, calls[2]!]; // index 0/2 are the two destination writes (1/3 are markers)
    expect(destinationCalls[0]!.scope).toBe('arizona' as unknown as Scope);
    expect(destinationCalls[1]!.scope).toBe('meta');
  });
});

describe('distributeIntakeEntries() -- additive marker write, never a mutation of the original entry', () => {
  it('a successful destination write also writes a NEW, additive distribution_marker entry into intake', async () => {
    const { client, calls } = makeFakeIngestClient();
    const metadata = makeEntryMetadata({ resolved_scope_candidate: null });
    const point = makeCandidatePoint(metadata);
    const { scrollPoints } = makeScrollPointsStub([point]);
    writeConfirmations([]);

    const result = await distributeIntakeEntries({
      client,
      scrollPoints,
      confirmationQueuePath,
      now: () => new Date('2026-08-27T12:00:00.000Z'),
      generateMarkerId: () => 'marker-fixed-id',
    });

    expect(calls).toHaveLength(2);
    // Call 0: the destination write, exactly the original text, unchanged.
    expect(calls[0]!.content.text).toBe(point.payload.text);
    // Call 1: the marker write -- a brand-new, DIFFERENT point, landing back
    // in intake, carrying the required marker fields.
    expect(calls[1]!.scope).toBe('intake' as unknown as Scope);
    expect(calls[1]!.content.text).not.toBe(point.payload.text);
    const markerJson = JSON.parse(/\{[\s\S]*\}/.exec(calls[1]!.content.text)![0]) as DistributionMarkerMetadata;
    expect(markerJson.entry_type).toBe('distribution_marker');
    expect(markerJson.marks_entry_id).toBe(metadata.entry_id);
    expect(markerJson.distributed_to_scope).toBe('meta');
    expect(markerJson.distributed_at).toBe('2026-08-27T12:00:00.000Z');
    expect(markerJson.entry_id).toBe('marker-fixed-id');

    expect(result.distributed[0]!.marker?.ok).toBe(true);
  });

  it('the original intake entry\'s own point is never re-written/mutated -- the fake client has no update/delete capability at all, and the destination call\'s content is byte-identical to the original', async () => {
    const { client, calls } = makeFakeIngestClient();
    const metadata = makeEntryMetadata({ resolved_scope_candidate: null });
    const point = makeCandidatePoint(metadata, 'A body that must survive unchanged.');
    const { scrollPoints } = makeScrollPointsStub([point]);
    writeConfirmations([]);

    await distributeIntakeEntries({ client, scrollPoints, confirmationQueuePath });

    // IngestClient's own real interface (imported, unchanged) exposes only
    // remember() -- structurally, this module cannot call an update/delete
    // method that does not exist on the type it depends on.
    expect(Object.keys(client)).toEqual(['remember']);
    expect(calls[0]!.content.text).toBe(point.payload.text);
  });

  it('a destination-write FAILURE never triggers a marker write', async () => {
    const { client, calls } = makeFailingIngestClient();
    const metadata = makeEntryMetadata({ resolved_scope_candidate: null });
    const point = makeCandidatePoint(metadata);
    const { scrollPoints } = makeScrollPointsStub([point]);
    writeConfirmations([]);

    const result = await distributeIntakeEntries({ client, scrollPoints, confirmationQueuePath });

    expect(calls).toHaveLength(1); // destination attempt only, no marker
    expect(result.distributed[0]!.ok).toBe(false);
    expect(result.distributed[0]!.marker).toBeUndefined();
  });
});

describe('distributeIntakeEntries() -- idempotency', () => {
  it('an entry with an existing matching distribution_marker is skipped entirely -- zero remember() calls reference it', async () => {
    const { client, calls } = makeFakeIngestClient();
    const metadata = makeEntryMetadata({ resolved_scope_candidate: null });
    const candidatePoint = makeCandidatePoint(metadata);
    const markerPoint = makeMarkerPoint({
      entry_id: 'marker-1',
      entry_type: 'distribution_marker',
      marks_entry_id: metadata.entry_id,
      distributed_to_scope: 'meta',
      distributed_at: '2026-08-27T00:00:00.000Z',
    });
    const { scrollPoints } = makeScrollPointsStub([candidatePoint, markerPoint]);
    writeConfirmations([]);

    const result = await distributeIntakeEntries({ client, scrollPoints, confirmationQueuePath });

    expect(calls).toHaveLength(0);
    expect(result.distributed).toHaveLength(0);
    expect(result.skipped).toEqual([{ entryId: metadata.entry_id, reason: 'already_distributed' }]);
  });

  it('a second run over the same intake state (now including the marker written by the first run) produces zero additional remember() calls for that entry_id', async () => {
    const { client } = makeFakeIngestClient();
    const metadata = makeEntryMetadata({ resolved_scope_candidate: null });
    const candidatePoint = makeCandidatePoint(metadata);
    writeConfirmations([]);

    // First run: no marker exists yet -- distributes normally.
    const { scrollPoints: scrollPointsRun1 } = makeScrollPointsStub([candidatePoint]);
    const firstRun = await distributeIntakeEntries({
      client,
      scrollPoints: scrollPointsRun1,
      confirmationQueuePath,
      generateMarkerId: () => 'marker-run1',
    });
    expect(firstRun.distributed).toHaveLength(1);

    // Second run: simulate the SAME intake collection now ALSO containing
    // the marker the first run wrote.
    const markerPoint = makeMarkerPoint({
      entry_id: 'marker-run1',
      entry_type: 'distribution_marker',
      marks_entry_id: metadata.entry_id,
      distributed_to_scope: 'meta',
      distributed_at: '2026-08-27T00:00:00.000Z',
    });
    const { client: client2, calls: calls2 } = makeFakeIngestClient();
    const { scrollPoints: scrollPointsRun2 } = makeScrollPointsStub([candidatePoint, markerPoint]);

    const secondRun = await distributeIntakeEntries({ client: client2, scrollPoints: scrollPointsRun2, confirmationQueuePath });

    expect(calls2).toHaveLength(0);
    expect(secondRun.distributed).toHaveLength(0);
    expect(secondRun.skipped).toHaveLength(1);
    expect(secondRun.skipped[0]!.entryId).toBe(metadata.entry_id);
  });
});

describe('distributeIntakeEntries() -- scroll_points() scoped to the intake collection only', () => {
  it('calls scrollPoints() exactly once, against INTAKE_COLLECTION_NAME, never any other collection', async () => {
    const { client } = makeFakeIngestClient();
    const { scrollPoints, calls } = makeScrollPointsStub([]);
    writeConfirmations([]);

    await distributeIntakeEntries({ client, scrollPoints, confirmationQueuePath });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.collectionName).toBe(INTAKE_COLLECTION_NAME);
    expect(calls[0]!.collectionName).toBe('conversation_memory_intake');
    expect(calls[0]!.collectionName).not.toBe('meta');
    expect(calls[0]!.collectionName).not.toBe('personal_memory');
  });

  it('points whose text carries no parseable provenance header are defensively skipped, never thrown on', async () => {
    const { client, calls } = makeFakeIngestClient();
    const malformedPoint: ScrolledPoint = { id: 'point-malformed', payload: { text: 'just some unrelated plain text' } };
    const noTextPoint: ScrolledPoint = { id: 'point-no-text', payload: {} };
    const { scrollPoints } = makeScrollPointsStub([malformedPoint, noTextPoint]);
    writeConfirmations([]);

    const result = await distributeIntakeEntries({ client, scrollPoints, confirmationQueuePath });

    expect(calls).toHaveLength(0);
    expect(result.distributed).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });
});

describe('distributeIntakeEntries() -- ingestDocument() called unchanged (real module, real internal logic)', () => {
  it('the real, unmodified ingestDocument() is genuinely invoked (module-mocked wrapper around the real implementation)', async () => {
    const { client } = makeFakeIngestClient();
    const metadata = makeEntryMetadata({ resolved_scope_candidate: null });
    const point = makeCandidatePoint(metadata);
    const { scrollPoints } = makeScrollPointsStub([point]);
    writeConfirmations([]);

    await distributeIntakeEntries({ client, scrollPoints, confirmationQueuePath });

    expect(vi.mocked(ingestDocument)).toHaveBeenCalledTimes(2);
    const firstCallResult: IngestDocumentResult = await vi.mocked(ingestDocument).mock.results[0]!.value;
    expect(firstCallResult.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cm-16-triage-review-and-confirm-ui: isScopeRouteConfirmationEntry() is now
// exported -- reused directly by cm-16's own confirm-route pre-write
// validation (bin/mnemosyne-conversation-triage-review.mjs), never a
// locally re-implemented shape check.
// ---------------------------------------------------------------------------

describe('isScopeRouteConfirmationEntry() -- exported for cm-16 reuse', () => {
  it('is a real, callable export from this module', () => {
    expect(typeof isScopeRouteConfirmationEntry).toBe('function');
  });

  it('accepts a real, well-shaped confirmation entry', () => {
    expect(
      isScopeRouteConfirmationEntry({
        recordedAt: '2026-08-27T00:00:00.000Z',
        confirmation_reason: 'scope_route_confirmed',
        cluster_id: 'cluster-1',
        scope_key: 'arizona',
      }),
    ).toBe(true);
  });

  it('rejects a value missing cluster_id/scope_key, or with the wrong discriminator', () => {
    expect(isScopeRouteConfirmationEntry({ confirmation_reason: 'scope_route_confirmed', cluster_id: 'c', scope_key: '' })).toBe(
      false,
    );
    expect(isScopeRouteConfirmationEntry({ confirmation_reason: 'something_else', cluster_id: 'c', scope_key: 's' })).toBe(false);
    expect(isScopeRouteConfirmationEntry(null)).toBe(false);
    expect(isScopeRouteConfirmationEntry('not an object')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// cm-16-triage-review-and-confirm-ui: computeIntakeCandidateStatuses() --
// the SAME scroll_points()-based enumeration + partitioning
// (partitionPoints()) and confirmation read (readScopeRouteConfirmations())
// this file's own distributeIntakeEntries() already uses, reused verbatim
// (never re-derived independently) for cm-16's own READ-ONLY status
// computation. Zero writes anywhere -- no IngestClient involved at all.
// ---------------------------------------------------------------------------

describe('computeIntakeCandidateStatuses() -- cm-16 status computation, reusing partitionPoints()/readScopeRouteConfirmations() verbatim', () => {
  it('an entry with no resolved_scope_candidate -> no_candidate, scopeKey null', async () => {
    const metadata = makeEntryMetadata({ cluster_id: null, resolved_scope_candidate: null });
    const point = makeCandidatePoint(metadata);
    const { scrollPoints } = makeScrollPointsStub([point]);
    writeConfirmations([]);

    const result = await computeIntakeCandidateStatuses(scrollPoints, confirmationQueuePath);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      entryId: metadata.entry_id,
      clusterId: null,
      scopeKey: null,
      status: 'no_candidate',
      distributedToScope: null,
    });
  });

  it('a real candidate with no matching confirmation on disk -> candidate_unconfirmed', async () => {
    const metadata = makeEntryMetadata({
      cluster_id: 'cluster-1',
      resolved_scope_candidate: makeResolvedScopeCandidate({ scope_key: 'arizona' }),
    });
    const point = makeCandidatePoint(metadata);
    const { scrollPoints } = makeScrollPointsStub([point]);
    writeConfirmations([]);

    const result = await computeIntakeCandidateStatuses(scrollPoints, confirmationQueuePath);

    expect(result[0]).toEqual({
      entryId: metadata.entry_id,
      clusterId: 'cluster-1',
      scopeKey: 'arizona',
      status: 'candidate_unconfirmed',
      distributedToScope: null,
    });
  });

  it('a real candidate with a matching (cluster_id, scope_key) confirmation on disk -> candidate_confirmed_pending_distribution', async () => {
    const metadata = makeEntryMetadata({
      cluster_id: 'cluster-1',
      resolved_scope_candidate: makeResolvedScopeCandidate({ scope_key: 'arizona' }),
    });
    const point = makeCandidatePoint(metadata);
    const { scrollPoints } = makeScrollPointsStub([point]);
    writeConfirmations([{ cluster_id: 'cluster-1', scope_key: 'arizona' }]);

    const result = await computeIntakeCandidateStatuses(scrollPoints, confirmationQueuePath);

    expect(result[0]!.status).toBe('candidate_confirmed_pending_distribution');
  });

  it('a confirmation naming the SAME cluster_id but a DIFFERENT scope_key never matches -> stays candidate_unconfirmed', async () => {
    const metadata = makeEntryMetadata({
      cluster_id: 'cluster-1',
      resolved_scope_candidate: makeResolvedScopeCandidate({ scope_key: 'arizona' }),
    });
    const point = makeCandidatePoint(metadata);
    const { scrollPoints } = makeScrollPointsStub([point]);
    writeConfirmations([{ cluster_id: 'cluster-1', scope_key: 'some-other-scope' }]);

    const result = await computeIntakeCandidateStatuses(scrollPoints, confirmationQueuePath);

    expect(result[0]!.status).toBe('candidate_unconfirmed');
  });

  it('an entry with a real distribution_marker -> distributed, distributedToScope from the real marker, regardless of confirmation state', async () => {
    const metadata = makeEntryMetadata({
      cluster_id: 'cluster-1',
      resolved_scope_candidate: makeResolvedScopeCandidate({ scope_key: 'arizona' }),
    });
    const candidatePoint = makeCandidatePoint(metadata);
    const markerPoint = makeMarkerPoint({
      entry_id: 'marker-1',
      entry_type: 'distribution_marker',
      marks_entry_id: metadata.entry_id,
      distributed_to_scope: 'arizona',
      distributed_at: '2026-08-27T00:00:00.000Z',
    });
    const { scrollPoints } = makeScrollPointsStub([candidatePoint, markerPoint]);
    writeConfirmations([]); // never confirmed on disk -- marker still wins

    const result = await computeIntakeCandidateStatuses(scrollPoints, confirmationQueuePath);

    expect(result[0]).toEqual({
      entryId: metadata.entry_id,
      clusterId: 'cluster-1',
      scopeKey: 'arizona',
      status: 'distributed',
      distributedToScope: 'arizona',
    });
  });

  it('a marker also wins over a no-candidate entry (an entry with no resolved_scope_candidate that was still distributed, to meta)', async () => {
    const metadata = makeEntryMetadata({ resolved_scope_candidate: null });
    const candidatePoint = makeCandidatePoint(metadata);
    const markerPoint = makeMarkerPoint({
      entry_id: 'marker-1',
      entry_type: 'distribution_marker',
      marks_entry_id: metadata.entry_id,
      distributed_to_scope: 'meta',
      distributed_at: '2026-08-27T00:00:00.000Z',
    });
    const { scrollPoints } = makeScrollPointsStub([candidatePoint, markerPoint]);
    writeConfirmations([]);

    const result = await computeIntakeCandidateStatuses(scrollPoints, confirmationQueuePath);

    expect(result[0]!.status).toBe('distributed');
    expect(result[0]!.distributedToScope).toBe('meta');
  });

  it('calls scrollPoints() exactly once, against INTAKE_COLLECTION_NAME, never any other collection', async () => {
    const { scrollPoints, calls } = makeScrollPointsStub([]);
    writeConfirmations([]);

    await computeIntakeCandidateStatuses(scrollPoints, confirmationQueuePath);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.collectionName).toBe(INTAKE_COLLECTION_NAME);
  });

  it('performs zero writes -- pure read, multiple real candidates classified independently in one pass', async () => {
    const unconfirmed = makeEntryMetadata({
      cluster_id: 'cluster-1',
      resolved_scope_candidate: makeResolvedScopeCandidate({ scope_key: 'arizona' }),
    });
    const confirmed = makeEntryMetadata({
      cluster_id: 'cluster-2',
      resolved_scope_candidate: makeResolvedScopeCandidate({ scope_key: 'texas' }),
    });
    const noCandidate = makeEntryMetadata({ cluster_id: null, resolved_scope_candidate: null });
    const points = [makeCandidatePoint(unconfirmed), makeCandidatePoint(confirmed), makeCandidatePoint(noCandidate)];
    const { scrollPoints } = makeScrollPointsStub(points);
    writeConfirmations([{ cluster_id: 'cluster-2', scope_key: 'texas' }]);

    const result = await computeIntakeCandidateStatuses(scrollPoints, confirmationQueuePath);

    expect(result).toHaveLength(3);
    const byEntryId = new Map(result.map((r) => [r.entryId, r]));
    expect(byEntryId.get(unconfirmed.entry_id)!.status).toBe('candidate_unconfirmed');
    expect(byEntryId.get(confirmed.entry_id)!.status).toBe('candidate_confirmed_pending_distribution');
    expect(byEntryId.get(noCandidate.entry_id)!.status).toBe('no_candidate');
  });
});
