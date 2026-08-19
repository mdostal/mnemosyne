/**
 * ro-10-document-ingestion-primitive (epic: mnemosyne-repo-onboarding).
 *
 * Failing-first tests (TDD, per the story's `test-spec` step) for
 * `ingestDocument()` against a stubbed/fake `MnemosyneClient` — never a live
 * Qdrant call, mirroring this codebase's existing fake-in-memory test
 * convention (see `client.test.ts`'s `stubWritableVectorLayer`).
 *
 * Covers every acceptance criterion in
 * `.pHive/epics/mnemosyne-repo-onboarding/stories/ro-10-document-ingestion-
 * primitive.yaml`: single-chunk, multi-chunk sequential ordering (never
 * concurrent), oversized-content loud rejection BEFORE any remember() call,
 * unsupported-format loud rejection BEFORE any remember() call, partial
 * mid-sequence failure reporting (exactly which chunks succeeded/failed, per
 * ro-06's own partial-state loud-failure convention), and a real recall()
 * provenance round-trip (full 7-field Provenance) proving real content
 * landed, not merely that remember() returned ok:true.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Content, Provenance, RecallResult, RememberResult, Scope } from '../interfaces.js';
import { CHUNK_SIZE_BYTES, MAX_INGEST_BYTES, ingestDocument, type IngestClient } from './ingestDocument.js';

// ---------------------------------------------------------------------------
// Stub client: records every remember() call (args + call order), returns a
// caller-scripted per-call result. Never touches Qdrant/swarm-memory.
// ---------------------------------------------------------------------------

interface RememberCall {
  content: Content;
  scope: Scope;
}

function fakeProvenance(overrides: Partial<Provenance> = {}): Provenance {
  return {
    layer: 'vector',
    source: 'fake:point:1',
    chunk_span: { index: 0 },
    index_timestamp: '2026-08-19T00:00:00.000Z',
    content_hash: 'deadbeef',
    embedder: 'fake-embedder',
    retrieval_time: null,
    ...overrides,
  };
}

/**
 * A stub client whose remember() is fully caller-scripted (results supplied
 * up front, in call order) but still records real call order/concurrency —
 * enough to prove sequential-never-parallel dispatch (AC #2) and exact
 * per-chunk success/failure (AC #5) without any live backend. A real
 * microtask delay inside remember() means a would-be-parallel implementation
 * (e.g. Promise.all) would actually overlap two in-flight calls and be
 * caught by the `getMaxConcurrent()` assertion below.
 */
function makeInstrumentedClient(results: RememberResult[]): {
  client: IngestClient;
  calls: RememberCall[];
  getMaxConcurrent: () => number;
} {
  const calls: RememberCall[] = [];
  let active = 0;
  let maxConcurrent = 0;

  const client: IngestClient = {
    remember: async (content: Content, scope: Scope): Promise<RememberResult> => {
      active++;
      maxConcurrent = Math.max(maxConcurrent, active);
      calls.push({ content, scope });
      const callIndex = calls.length - 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      const result = results[callIndex];
      if (!result) {
        throw new Error(`makeInstrumentedClient: no scripted result for call index ${callIndex}`);
      }
      return result;
    },
  };

  return { client, calls, getMaxConcurrent: () => maxConcurrent };
}

function successResult(overrides: Partial<Provenance> = {}): RememberResult {
  return { ok: true, layer: 'vector', provenance: fakeProvenance(overrides) };
}

function failureResult(message = 'layer degraded to failure'): RememberResult {
  return { ok: false, error: { layer: 'vector', message, code: 'layer_unreachable' } };
}

// ---------------------------------------------------------------------------
// AC #1 — single chunk
// ---------------------------------------------------------------------------

describe('ingestDocument — single chunk', () => {
  it('produces exactly one remember() call tagged with the filename and chunk 0, returning that chunk\'s real RememberResult', async () => {
    const { client, calls } = makeInstrumentedClient([successResult()]);

    const result = await ingestDocument(client, { content: 'a short note about the product.', filename: 'notes.txt' });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.content.text).toBe('a short note about the product.');
    expect(calls[0]?.content.metadata?.filename).toBe('notes.txt');
    expect(calls[0]?.content.metadata?.chunk_index).toBe(0);
    expect(calls[0]?.content.metadata?.chunk_count).toBe(1);

    expect(result.ok).toBe(true);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.index).toBe(0);
    expect(result.chunks[0]?.filename).toBe('notes.txt');
    expect(result.chunks[0]?.ok).toBe(true);
    expect(result.chunks[0]?.remember).toEqual(successResult());
  });

  it('supports a plain free-text description/CV with no filename at all (trivial subcase)', async () => {
    const { client, calls } = makeInstrumentedClient([successResult()]);

    const result = await ingestDocument(client, { content: 'Jane Doe — 10 years of infra experience.' });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.content.metadata?.filename).toBeNull();
    expect(result.ok).toBe(true);
    expect(result.chunks[0]?.filename).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC #2 — multi-chunk, sequential, never concurrent
// ---------------------------------------------------------------------------

describe('ingestDocument — multi-chunk sequential ordering', () => {
  it('produces N sequential remember() calls, never overlapping, each tagged with the same filename and its own chunk index', async () => {
    const content = 'A'.repeat(CHUNK_SIZE_BYTES) + 'B'.repeat(CHUNK_SIZE_BYTES) + 'C'.repeat(500);
    const { client, calls, getMaxConcurrent } = makeInstrumentedClient([successResult(), successResult(), successResult()]);

    const result = await ingestDocument(client, { content, filename: 'big-doc.md' });

    expect(calls).toHaveLength(3);
    expect(getMaxConcurrent()).toBe(1); // never more than one in-flight remember() call at a time

    expect(calls[0]?.content.text).toBe('A'.repeat(CHUNK_SIZE_BYTES));
    expect(calls[1]?.content.text).toBe('B'.repeat(CHUNK_SIZE_BYTES));
    expect(calls[2]?.content.text).toBe('C'.repeat(500));

    for (let i = 0; i < 3; i++) {
      expect(calls[i]?.content.metadata?.filename).toBe('big-doc.md');
      expect(calls[i]?.content.metadata?.chunk_index).toBe(i);
      expect(calls[i]?.content.metadata?.chunk_count).toBe(3);
    }

    expect(result.ok).toBe(true);
    expect(result.chunks.map((c) => c.index)).toEqual([0, 1, 2]);
  });
});

// ---------------------------------------------------------------------------
// AC #3 — oversized content, loud rejection BEFORE any remember() call
// ---------------------------------------------------------------------------

describe('ingestDocument — oversized content', () => {
  it('fails loudly with ok:false and an oversized-content error BEFORE calling remember() at all', async () => {
    const { client, calls } = makeInstrumentedClient([]);
    const content = 'x'.repeat(MAX_INGEST_BYTES + 1);

    const result = await ingestDocument(client, { content, filename: 'huge.txt' });

    expect(calls).toHaveLength(0); // never a silent partial ingest of the first MAX_INGEST_BYTES
    expect(result.ok).toBe(false);
    expect(result.chunks).toEqual([]);
    if (!result.ok) {
      expect(result.error.code).toBe('oversized_content');
      expect(result.error.message).toMatch(/MAX_INGEST_BYTES|exceed|too large/i);
    }
  });
});

// ---------------------------------------------------------------------------
// AC #4 — unsupported format, loud rejection BEFORE any remember() call
// ---------------------------------------------------------------------------

describe('ingestDocument — unsupported format', () => {
  it('fails loudly naming the unsupported format, never attempting to read binary content as text', async () => {
    const { client, calls } = makeInstrumentedClient([]);

    const result = await ingestDocument(client, { content: '%PDF-1.4 binary bytes here', filename: 'resume.pdf' });

    expect(calls).toHaveLength(0);
    expect(result.ok).toBe(false);
    expect(result.chunks).toEqual([]);
    if (!result.ok) {
      expect(result.error.code).toBe('unsupported_format');
      expect(result.error.message).toMatch(/\.pdf/i);
      expect(result.error.message).toMatch(/\.txt|\.md|text|markdown/i);
    }
  });

  it('rejects any extension outside the .txt/.md allowlist, not just .pdf', async () => {
    const { client, calls } = makeInstrumentedClient([]);

    const result = await ingestDocument(client, { content: 'binary-ish', filename: 'archive.docx' });

    expect(calls).toHaveLength(0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unsupported_format');
    }
  });
});

// ---------------------------------------------------------------------------
// AC #5 — partial mid-sequence failure, exact per-chunk reporting
// ---------------------------------------------------------------------------

describe('ingestDocument — partial mid-sequence failure', () => {
  it('reports exactly which chunks succeeded and which failed, never a generic all-or-nothing error', async () => {
    const content = 'A'.repeat(CHUNK_SIZE_BYTES) + 'B'.repeat(CHUNK_SIZE_BYTES) + 'C'.repeat(500);
    const { client, calls } = makeInstrumentedClient([
      successResult(),
      failureResult('vector layer degraded to failure'),
      successResult(),
    ]);

    const result = await ingestDocument(client, { content, filename: 'partial.md' });

    // All three chunks were attempted -- a mid-sequence failure never
    // truncates the remaining chunks.
    expect(calls).toHaveLength(3);

    expect(result.ok).toBe(false);
    expect(result.chunks).toHaveLength(3);
    expect(result.chunks[0]?.ok).toBe(true);
    expect(result.chunks[1]?.ok).toBe(false);
    expect(result.chunks[2]?.ok).toBe(true);
    expect(result.chunks[1]?.remember.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('partial_ingest_failure');
    }
  });
});

// ---------------------------------------------------------------------------
// AC #6 — real recall() provenance round-trip
// ---------------------------------------------------------------------------

/**
 * A genuinely-storing in-memory fake MnemosyneClient: remember() really
 * stores the chunk text and returns full 7-field provenance; recall()
 * really searches what was stored and returns it back with fresh
 * retrieval_time. This is what proves ingestDocument() causes real content
 * to land, not merely that remember() reports ok:true.
 */
function makeInMemoryClient(): {
  remember: (content: Content, scope: Scope) => Promise<RememberResult>;
  recall: (query: string, scope: Scope) => RecallResult;
} {
  const store: { text: string; scope: Scope; provenance: Provenance }[] = [];

  return {
    remember: async (content: Content, scope: Scope): Promise<RememberResult> => {
      const chunkIndex = typeof content.metadata?.chunk_index === 'number' ? content.metadata.chunk_index : 0;
      const source = typeof content.metadata?.filename === 'string' ? content.metadata.filename : 'inline-content';
      const provenance: Provenance = {
        layer: 'vector',
        source: `${source}#${chunkIndex}`,
        chunk_span: { index: chunkIndex },
        index_timestamp: new Date().toISOString(),
        content_hash: createHash('sha256').update(content.text).digest('hex'),
        embedder: 'fake-embedder',
        retrieval_time: null,
      };
      store.push({ text: content.text, scope, provenance });
      return { ok: true, layer: 'vector', provenance };
    },
    recall: (query: string, scope: Scope): RecallResult => {
      const hits = store
        .filter((entry) => entry.scope === scope && entry.text.includes(query))
        .map((entry) => ({
          content: entry.text,
          provenance: { ...entry.provenance, retrieval_time: new Date().toISOString() },
        }));
      return {
        ok: true,
        query,
        scope,
        intent: 'narrow',
        hits,
        layers_queried: ['vector'],
        layers_skipped: [],
        escalated: false,
        degraded: false,
      };
    },
  };
}

describe('ingestDocument — recall() provenance round-trip', () => {
  it('a multi-chunk ingest is really findable via recall(), with full 7-field provenance on the hit', async () => {
    const fake = makeInMemoryClient();
    const content = 'A'.repeat(CHUNK_SIZE_BYTES) + 'FINDME-MARKER' + 'C'.repeat(500);

    const ingestResult = await ingestDocument(fake, { content, filename: 'resume.md', scope: 'project' });
    expect(ingestResult.ok).toBe(true);

    const recallResult = fake.recall('FINDME-MARKER', 'project');
    expect(recallResult.ok).toBe(true);
    if (recallResult.ok) {
      expect(recallResult.hits.length).toBeGreaterThanOrEqual(1);
      const hit = recallResult.hits[0]!;
      expect(hit.content).toContain('FINDME-MARKER');
      const provenance = hit.provenance;
      // All seven fields always present as keys (loud-failure/provenance-
      // completeness contract), never omitted.
      expect(Object.keys(provenance).sort()).toEqual(
        ['chunk_span', 'content_hash', 'embedder', 'index_timestamp', 'layer', 'retrieval_time', 'source'].sort(),
      );
      expect(provenance.layer).toBe('vector');
      expect(typeof provenance.source).toBe('string');
      expect(provenance.chunk_span).not.toBeNull();
      expect(provenance.index_timestamp).not.toBeNull();
      expect(provenance.content_hash).not.toBeNull();
      expect(provenance.embedder).not.toBeNull();
      expect(provenance.retrieval_time).not.toBeNull();
    }
  });
});
