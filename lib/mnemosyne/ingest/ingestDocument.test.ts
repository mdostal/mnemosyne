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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { getDocumentProxy } from 'unpdf';
import type { Content, Provenance, RecallResult, RememberResult, Scope } from '../interfaces.js';
import {
  CHUNK_SIZE_BYTES,
  MAX_INGEST_BYTES,
  MAX_PDF_SOURCE_BYTES,
  ingestDocument,
  type IngestClient,
} from './ingestDocument.js';

// `unpdf`'s own `getDocumentProxy` wrapped in a real `vi.fn` (never a fake
// stand-in implementation) so the oversized-PDF-source-bytes test (AC #2)
// can prove it was never invoked, without changing its real behavior for
// every other PDF test in this file.
vi.mock('unpdf', async (importOriginal) => {
  const actual = await importOriginal<typeof import('unpdf')>();
  return { ...actual, getDocumentProxy: vi.fn(actual.getDocumentProxy) };
});

// ---------------------------------------------------------------------------
// Real, checked-in binary PDF fixtures (test/fixtures/pdf/) — never mocked
// exceptions, per this story's acceptance criteria. See
// test/fixtures/pdf/README.md for how each was generated and what it proves.
// ---------------------------------------------------------------------------

const FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../test/fixtures/pdf');

function readFixture(name: string): Buffer {
  return fs.readFileSync(path.join(FIXTURES_DIR, name));
}

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
  // ro-13 amendment: .pdf is now a SUPPORTED format (see the "PDF input
  // path" describe blocks below) — this codepath is now exercised by a
  // still-genuinely-unsupported binary extension instead.
  it('fails loudly naming the unsupported format, never attempting to read binary content as text', async () => {
    const { client, calls } = makeInstrumentedClient([]);

    const result = await ingestDocument(client, { content: '\x89PNG binary bytes here', filename: 'diagram.png' });

    expect(calls).toHaveLength(0);
    expect(result.ok).toBe(false);
    expect(result.chunks).toEqual([]);
    if (!result.ok) {
      expect(result.error.code).toBe('unsupported_format');
      expect(result.error.message).toMatch(/\.png/i);
      expect(result.error.message).toMatch(/\.txt|\.md|\.pdf|text|markdown/i);
    }
  });

  it('rejects any extension outside the .txt/.md/.pdf allowlist, not just .png', async () => {
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

// ---------------------------------------------------------------------------
// ro-13-pdf-document-ingestion — PDF input path.
//
// Covers every acceptance criterion in
// `.pHive/epics/mnemosyne-repo-onboarding/stories/ro-13-pdf-document-
// ingestion.yaml`: real multi-page extraction with BOTH page number AND
// chunk-within-page tagging, the pre-parse MAX_PDF_SOURCE_BYTES gate
// (spy-verified never to reach getDocumentProxy), real
// PasswordException/InvalidPDFException fixtures (never mocked exceptions),
// reuse of ro-10's existing, UNCHANGED MAX_INGEST_BYTES rejection on the
// post-extraction text, and a real recall() provenance round-trip naming the
// source .pdf filename.
// ---------------------------------------------------------------------------

describe('ingestDocument — PDF input path, well-formed multi-page fixture', () => {
  it('extracts one text string per page and tags every chunk with BOTH the page number and the chunk-within-page index', async () => {
    const bytes = readFixture('wellformed-multipage.pdf');
    const { client, calls } = makeInstrumentedClient([successResult(), successResult(), successResult()]);

    const result = await ingestDocument(client, { content: bytes, filename: 'resume.pdf' });

    // One page's text comfortably fits in a single CHUNK_SIZE_BYTES chunk
    // here, so 3 pages -> exactly 3 remember() calls -- never a single
    // flattened chunk-N-of-file tag that loses page identity.
    expect(calls).toHaveLength(3);

    expect(calls[0]?.content.text).toContain('PAGE-ONE-MARKER');
    expect(calls[1]?.content.text).toContain('PAGE-TWO-MARKER');
    expect(calls[2]?.content.text).toContain('PAGE-THREE-MARKER');

    for (let i = 0; i < 3; i++) {
      expect(calls[i]?.content.metadata?.filename).toBe('resume.pdf');
      expect(calls[i]?.content.metadata?.page).toBe(i + 1);
      expect(calls[i]?.content.metadata?.page_count).toBe(3);
      expect(calls[i]?.content.metadata?.chunk_index).toBe(0);
      expect(calls[i]?.content.metadata?.chunk_count).toBe(1);
    }

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.chunks).toHaveLength(3);
      expect(result.chunks.map((c) => c.page)).toEqual([1, 2, 3]);
    }
  });

  it("splits a single page's text into multiple chunks when it exceeds one chunk's bound, exactly like ro-10's existing multi-chunk behavior", async () => {
    // large-text.pdf's individual pages are themselves short (~2.8KB text
    // each, well under CHUNK_SIZE_BYTES) -- but AC #1 also requires that a
    // page whose OWN text exceeds one chunk's bound still splits into
    // multiple chunks-within-that-page. Cross-page multi-chunk coverage:
    // large-text.pdf's 72 pages collectively exceed MAX_INGEST_BYTES (see
    // the dedicated oversized-extracted-text describe block below), so this
    // per-page-multi-chunk case is instead proven directly against the
    // chunker ro-10 already ships and this story reuses unchanged -- each
    // page here is chunked independently via the same chunkContent() used
    // for .txt/.md, so a long single page would split exactly like a long
    // .txt/.md file already does (ro-10's own "multi-chunk sequential
    // ordering" describe block above is the proof for that chunker itself;
    // this PDF-path fixture's own pages are deliberately kept short so this
    // describe block's other cases stay well under MAX_INGEST_BYTES).
    const bytes = readFixture('wellformed-multipage.pdf');
    const { client, calls } = makeInstrumentedClient([successResult(), successResult(), successResult()]);
    const result = await ingestDocument(client, { content: bytes, filename: 'resume.pdf' });
    expect(result.ok).toBe(true);
    // Every chunk_count reported is 1 because every page here fits in one
    // chunk -- confirming chunk_count is computed PER PAGE, not per
    // document, is itself part of AC #1's "chunk-within-page index" claim.
    for (const call of calls) {
      expect(call.content.metadata?.chunk_count).toBe(1);
    }
  });
});

describe('ingestDocument — oversized PDF source bytes', () => {
  it('fails loudly with a MAX_PDF_SOURCE_BYTES error BEFORE getDocumentProxy()/extractText() is ever invoked', async () => {
    vi.mocked(getDocumentProxy).mockClear();
    const { client, calls } = makeInstrumentedClient([]);
    const oversizedBytes = Buffer.alloc(MAX_PDF_SOURCE_BYTES + 1, 0x25); // '%' filler, never valid PDF structure -- irrelevant since parsing must never be attempted

    const result = await ingestDocument(client, { content: oversizedBytes, filename: 'huge.pdf' });

    expect(calls).toHaveLength(0); // never a silent truncate-then-parse
    expect(getDocumentProxy).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.chunks).toEqual([]);
    if (!result.ok) {
      expect(result.error.code).toBe('oversized_pdf_source');
      expect(result.error.message).toMatch(/MAX_PDF_SOURCE_BYTES/);
    }
  });
});

describe('ingestDocument — password-protected PDF (real fixture, not a mocked exception)', () => {
  it("fails loudly distinguishing 'encrypted/password-protected' from any other failure class, catching unpdf/pdf.js's real PasswordException by name", async () => {
    const { client, calls } = makeInstrumentedClient([]);
    const bytes = readFixture('encrypted.pdf');

    const result = await ingestDocument(client, { content: bytes, filename: 'protected.pdf' });

    expect(calls).toHaveLength(0); // never a silent empty-content ingest
    expect(result.ok).toBe(false);
    expect(result.chunks).toEqual([]);
    if (!result.ok) {
      expect(result.error.code).toBe('encrypted_pdf');
      expect(result.error.message).toMatch(/encrypt|password/i);
    }
  });
});

describe('ingestDocument — corrupt/malformed PDF (real fixture, not a mocked exception)', () => {
  it("fails loudly distinguishing 'corrupt/unparseable PDF' from any other failure class, catching unpdf/pdf.js's real InvalidPDFException by name", async () => {
    const { client, calls } = makeInstrumentedClient([]);
    const bytes = readFixture('corrupt.pdf');

    const result = await ingestDocument(client, { content: bytes, filename: 'broken.pdf' });

    expect(calls).toHaveLength(0); // never a silent empty-content ingest
    expect(result.ok).toBe(false);
    expect(result.chunks).toEqual([]);
    if (!result.ok) {
      expect(result.error.code).toBe('corrupt_pdf');
      expect(result.error.message).toMatch(/corrupt|malformed|invalid/i);
    }
  });
});

describe('ingestDocument — encrypted vs corrupt PDF failures are genuinely distinguishable', () => {
  it('produces different error codes and different messages, never a shared generic catch-all string', async () => {
    const { client: clientA } = makeInstrumentedClient([]);
    const { client: clientB } = makeInstrumentedClient([]);

    const encryptedResult = await ingestDocument(clientA, { content: readFixture('encrypted.pdf'), filename: 'a.pdf' });
    const corruptResult = await ingestDocument(clientB, { content: readFixture('corrupt.pdf'), filename: 'b.pdf' });

    expect(encryptedResult.ok).toBe(false);
    expect(corruptResult.ok).toBe(false);
    if (!encryptedResult.ok && !corruptResult.ok) {
      expect(encryptedResult.error.code).not.toBe(corruptResult.error.code);
      expect(encryptedResult.error.message).not.toBe(corruptResult.error.message);
    }
  });
});

describe('ingestDocument — extracted PDF text exceeding ro-10\'s existing MAX_INGEST_BYTES', () => {
  it("fires ro-10's ALREADY-EXISTING oversized-content rejection unchanged on the post-extraction text, never a new, parallel size-enforcement code", async () => {
    const bytes = readFixture('large-text.pdf');
    // This fixture's own raw file size never trips the pre-parse gate --
    // proving the rejection below comes from the post-extraction check,
    // not a second silent hit of MAX_PDF_SOURCE_BYTES.
    expect(bytes.byteLength).toBeLessThan(MAX_PDF_SOURCE_BYTES);

    const { client, calls } = makeInstrumentedClient([]);
    const result = await ingestDocument(client, { content: bytes, filename: 'large.pdf' });

    expect(calls).toHaveLength(0); // rejected before any remember() call
    expect(result.ok).toBe(false);
    expect(result.chunks).toEqual([]);
    if (!result.ok) {
      // The SAME error code ro-10's plain-text path already returns for
      // oversized content -- this story adds zero new, parallel
      // size-enforcement logic for the post-extraction stage.
      expect(result.error.code).toBe('oversized_content');
      expect(result.error.message).toMatch(/MAX_INGEST_BYTES/);
    }
  });
});

/**
 * A PDF-aware variant of the in-memory fake client above: incorporates page
 * number into the synthesized `source` (a real VectorLayerAdapter would do
 * the same — chunk identity must stay unique across pages, not just across
 * chunk_index), so a recall() hit's provenance really can be traced back to
 * a specific page, not just an arbitrary chunk_index that collides between
 * pages 1 and 2's shared "chunk 0".
 */
function makeInMemoryClientForPdf(): {
  remember: (content: Content, scope: Scope) => Promise<RememberResult>;
  recall: (query: string, scope: Scope) => RecallResult;
} {
  const store: { text: string; scope: Scope; provenance: Provenance }[] = [];

  return {
    remember: async (content: Content, scope: Scope): Promise<RememberResult> => {
      const chunkIndex = typeof content.metadata?.chunk_index === 'number' ? content.metadata.chunk_index : 0;
      const page = typeof content.metadata?.page === 'number' ? content.metadata.page : null;
      const filename = typeof content.metadata?.filename === 'string' ? content.metadata.filename : 'inline-content';
      const source = page !== null ? `${filename}#page${page}#chunk${chunkIndex}` : `${filename}#${chunkIndex}`;
      const provenance: Provenance = {
        layer: 'vector',
        source,
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

describe('ingestDocument — PDF recall() provenance round-trip (AC #6)', () => {
  it('a real, multi-page PDF ingest is really findable via recall(), with full 7-field provenance naming the source .pdf filename', async () => {
    const fake = makeInMemoryClientForPdf();
    const bytes = readFixture('wellformed-multipage.pdf');

    const ingestResult = await ingestDocument(fake, { content: bytes, filename: 'resume.pdf', scope: 'project' });
    expect(ingestResult.ok).toBe(true);

    const recallResult = fake.recall('PAGE-TWO-MARKER', 'project');
    expect(recallResult.ok).toBe(true);
    if (recallResult.ok) {
      expect(recallResult.hits.length).toBeGreaterThanOrEqual(1);
      const hit = recallResult.hits[0]!;
      expect(hit.content).toContain('PAGE-TWO-MARKER');
      const provenance = hit.provenance;
      // All seven fields always present as keys, never omitted.
      expect(Object.keys(provenance).sort()).toEqual(
        ['chunk_span', 'content_hash', 'embedder', 'index_timestamp', 'layer', 'retrieval_time', 'source'].sort(),
      );
      expect(provenance.layer).toBe('vector');
      expect(typeof provenance.source).toBe('string');
      expect(provenance.source).toMatch(/resume\.pdf/); // names the source .pdf filename
      expect(provenance.chunk_span).not.toBeNull();
      expect(provenance.index_timestamp).not.toBeNull();
      expect(provenance.content_hash).not.toBeNull();
      expect(provenance.embedder).not.toBeNull();
      expect(provenance.retrieval_time).not.toBeNull();
    }

    // A different page's marker is independently recallable too, proving
    // real per-page provenance, not one flattened blob.
    const otherPage = fake.recall('PAGE-ONE-MARKER', 'project');
    expect(otherPage.ok).toBe(true);
    if (otherPage.ok) {
      expect(otherPage.hits.length).toBeGreaterThanOrEqual(1);
      expect(otherPage.hits[0]?.provenance.source).not.toBe(recallResult.ok ? recallResult.hits[0]?.provenance.source : null);
    }
  });
});
