/**
 * ro-10-document-ingestion-primitive (epic: mnemosyne-repo-onboarding).
 *
 * Amendment story (design-discussion.md §7.2), closing the "upload files,
 * CV, description" half of the operator's ask (`ro-11` closes "crawl
 * website" by reusing this module's own `ingestDocument()` unchanged, per
 * design-discussion.md §7.3).
 *
 * Real reuse root, confirmed by reading the code, not assumed:
 * `MnemosyneClient.remember()` (shipped, v0.14.0) already cascades a single
 * write through every WRITABLE configured layer in stack order
 * (`client.ts:447-531`) — the exact "multi-level memory... created and
 * updated" mechanism the operator asked for. This module does not
 * reimplement that cascade; it feeds it, one bounded chunk at a time.
 *
 * Bounded, explicit scope for this story's cut (never hand-waved): plain
 * text (`.txt`) and Markdown (`.md`) content only — confirmed via
 * `package.json` that no PDF-parsing dependency exists anywhere in this
 * codebase today; PDF support is an explicit, separate follow-on
 * (`ro-13-pdf-document-ingestion`), never silently promised here. A
 * free-text description or CV/resume supplied as a plain string (no file at
 * all, `filename` omitted) is the trivial subcase of the same path.
 *
 * Mirrors this codebase's one existing precedent for "read external content
 * safely, without overdoing it" —
 * `skills/mnemosyne-persona-interview/crawl-context.mjs`'s named-cap
 * discipline (`MAX_LINES_PER_SOURCE`/`MAX_CHARS_PER_SOURCE`/
 * `MAX_SOURCE_SUMMARY_CHARS`, every cap enforced in code, not just
 * documented) — as a PATTERN only; that module is persona-interview- and
 * local-file-specific and is not imported here.
 *
 * Design decisions (design-discussion.md §7.2, story design_decisions):
 *  - Chunks are ingested sequentially, one `await`ed `client.remember()`
 *    call at a time, NEVER `Promise.all`/parallel — no precedent for
 *    concurrent remember() calls exists anywhere in this codebase, and
 *    `VectorLayerAdapter.remember()`'s own doc comment already notes a
 *    single index call can take several seconds against live Qdrant Cloud.
 *    No background queue/worker system is introduced.
 *  - `MAX_INGEST_BYTES`/format checks run BEFORE any `remember()` call —
 *    an oversized or unsupported-format document is rejected loudly,
 *    up front, never as a partial-then-fail sequence and never a silent
 *    partial ingest of only the first `MAX_INGEST_BYTES`.
 *  - A mid-sequence chunk failure does NOT abort the remaining chunks —
 *    every chunk is still attempted, and the result reports EXACTLY which
 *    chunks succeeded and which failed (mirrors `ro-06`'s own "report which
 *    half succeeded" partial-state loud-failure convention), never a
 *    generic all-or-nothing error that hides which chunks actually landed.
 *
 * Exported shape is deliberately stable: `ro-11` (bounded website crawl) and
 * `ro-13` (PDF ingestion) both compose `ingestDocument()` unchanged, feeding
 * it already-extracted text — this module's signature must not need to
 * change for either to land.
 */

import path from 'node:path';
import type { Content, RememberResult, Scope } from '../interfaces.js';

// ---------------------------------------------------------------------------
// Named caps (crawl-context.mjs's "every cap enforced in code, not just
// documented" discipline, mirrored here for a structurally different input —
// arbitrary uploaded/pasted content, not a fixed local-file list).
// ---------------------------------------------------------------------------

/**
 * Hard byte ceiling on any single ingested document, checked BEFORE any
 * chunking/remember() call. Oversized input is rejected loudly — never
 * silently truncated to a misleadingly-partial memory (a policy choice
 * distinct from crawl-context.mjs's "truncate and mark it": losing part of
 * an operator-uploaded CV/description silently would misrepresent what the
 * product now "knows").
 *
 * A single named constant (not a scattered magic number) — deliberately
 * generous enough for a genuinely long CV/description/README (~200KB is
 * already a very long plain-text document) while keeping a single ingest
 * call's worst-case sequential-chunk latency bounded (see `CHUNK_SIZE_BYTES`
 * below). Revisiting this value post-ship is not a breaking change (see the
 * story's risk log).
 */
export const MAX_INGEST_BYTES = 200_000;

/**
 * Byte ceiling per chunk. Each chunk becomes its own sequential
 * `remember()` call (never parallel — see module doc comment), so this
 * bounds both a single write's payload size and, combined with
 * `MAX_INGEST_BYTES`, the worst-case number of sequential remember() calls
 * one `ingestDocument()` call can produce (at most
 * `MAX_INGEST_BYTES / CHUNK_SIZE_BYTES` ≈ 50).
 */
export const CHUNK_SIZE_BYTES = 4_000;

/** The only file extensions this story's cut accepts (case-insensitive). Bounded, not hand-waved — see module doc comment. */
export const SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set(['.txt', '.md']);

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/**
 * The minimal structural slice of `MnemosyneClient` this module needs —
 * exactly `remember()`, nothing else. Kept as a local structural type
 * (rather than importing the concrete `MnemosyneClient` class from
 * `client.ts`) so tests can pass a plain stubbed/fake object, mirroring this
 * codebase's existing fake-in-memory test convention, never a live Qdrant
 * call.
 */
export interface IngestClient {
  remember(content: Content, scope: Scope): Promise<RememberResult>;
}

export interface IngestDocumentOptions {
  /** The document's full text content (plain text or Markdown). Never binary. */
  content: string;
  /**
   * Optional source filename. When present, its extension MUST be in
   * `SUPPORTED_EXTENSIONS` (checked before any remember() call) and it is
   * carried into each chunk's `Content.metadata.filename` for provenance.
   * Omit entirely for a free-text description/CV supplied as a plain string
   * with no file at all (the trivial subcase of the same path).
   */
  filename?: string;
  /** Optional caller-supplied tag, carried into each chunk's `Content.metadata.tag` alongside filename/chunk index. */
  tag?: string;
  /** Scope to write into. Defaults to `'project'` — ingested content is scoped exactly the same way any other remember() call already is, never a shared/global default. */
  scope?: Scope;
}

/** One chunk's outcome: which chunk it was, and its real `RememberResult`. */
export interface IngestChunkOutcome {
  /** 0-based chunk index, matching `Content.metadata.chunk_index` on the remember() call this chunk produced. */
  index: number;
  /** The source filename this chunk was tagged with, or `null` for filename-less content. */
  filename: string | null;
  /** Convenience mirror of `remember.ok`, for filtering without unwrapping the discriminated union. */
  ok: boolean;
  /** The real, unmodified `RememberResult` this chunk's `remember()` call returned. */
  remember: RememberResult;
}

export interface IngestDocumentError {
  code: 'oversized_content' | 'unsupported_format' | 'partial_ingest_failure';
  message: string;
}

export interface IngestDocumentSuccess {
  ok: true;
  /** Every chunk's outcome, in order, all successful. */
  chunks: IngestChunkOutcome[];
}

export interface IngestDocumentFailure {
  ok: false;
  error: IngestDocumentError;
  /**
   * Populated for a mid-sequence partial failure (every attempted chunk's
   * real outcome, success or failure — never hidden behind a generic
   * all-or-nothing error). Empty for a pre-check rejection
   * (`oversized_content`/`unsupported_format`), since no chunk was ever
   * attempted — always present, never omitted, matching this codebase's
   * "explicit empty over omission" convention (see `interfaces.ts`'s
   * `Provenance` doc comment).
   */
  chunks: IngestChunkOutcome[];
}

export type IngestDocumentResult = IngestDocumentSuccess | IngestDocumentFailure;

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

/**
 * Splits `content` into chunks of at most `maxBytesPerChunk` UTF-8 bytes
 * each, never splitting a multi-byte UTF-8 sequence across two chunks
 * (backs the boundary off while the next byte is a UTF-8 continuation byte,
 * `10xxxxxx`). Empty content produces zero chunks. Deterministic and pure —
 * no I/O, mirrors crawl-context.mjs's `capExcerpt`'s "every cap enforced in
 * code" style.
 */
function chunkContent(content: string, maxBytesPerChunk: number): string[] {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8');
  const bytes = encoder.encode(content);

  const chunks: string[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    let end = Math.min(offset + maxBytesPerChunk, bytes.length);
    while (end < bytes.length && end > offset && (bytes[end]! & 0xc0) === 0x80) {
      end--;
    }
    chunks.push(decoder.decode(bytes.slice(offset, end)));
    offset = end;
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// ingestDocument()
// ---------------------------------------------------------------------------

/**
 * Chunks bounded input content and calls `client.remember()` once per
 * chunk, sequentially (never parallel — see module doc comment). Each
 * chunk's `Content.metadata` carries the source filename and chunk index,
 * so a later `recall()` hit's provenance traces back to "chunk N of
 * <filename>," never an anonymous blob.
 *
 * Pre-checks (oversized content, unsupported format) run BEFORE any
 * `remember()` call and reject loudly. A mid-sequence chunk failure does
 * NOT stop the remaining chunks — every chunk is attempted, and the result
 * reports exactly which succeeded/failed.
 */
export async function ingestDocument(client: IngestClient, options: IngestDocumentOptions): Promise<IngestDocumentResult> {
  const { content, tag, scope = 'project' } = options;
  const filename = options.filename ?? null;

  if (filename !== null) {
    const ext = path.extname(filename).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      return {
        ok: false,
        chunks: [],
        error: {
          code: 'unsupported_format',
          message:
            `Unsupported format '${ext || '(no extension)'}' for '${filename}' — ingestDocument() only accepts ` +
            `.txt/.md content (SUPPORTED_EXTENSIONS). Convert '${filename}' to plain text or Markdown before ` +
            `ingesting; PDF/binary support is an explicit, separate follow-on (ro-13), never a best-effort ` +
            `attempt to read binary content as text.`,
        },
      };
    }
  }

  const actualBytes = Buffer.byteLength(content, 'utf8');
  if (actualBytes > MAX_INGEST_BYTES) {
    return {
      ok: false,
      chunks: [],
      error: {
        code: 'oversized_content',
        message:
          `Content is ${actualBytes} bytes, exceeding the ${MAX_INGEST_BYTES}-byte MAX_INGEST_BYTES ceiling — ` +
          `rejected before any remember() call, never a silent partial ingest of only the first ` +
          `${MAX_INGEST_BYTES} bytes. Split the document into smaller pieces and ingest each separately.`,
      },
    };
  }

  const chunkTexts = chunkContent(content, CHUNK_SIZE_BYTES);
  const chunkOutcomes: IngestChunkOutcome[] = [];

  // Sequential, never parallel/Promise.all — see module doc comment.
  for (let index = 0; index < chunkTexts.length; index++) {
    const chunkText = chunkTexts[index]!;
    const metadata: Record<string, unknown> = {
      filename,
      chunk_index: index,
      chunk_count: chunkTexts.length,
    };
    if (tag !== undefined) {
      metadata.tag = tag;
    }

    const rememberResult = await client.remember({ text: chunkText, metadata }, scope);
    chunkOutcomes.push({ index, filename, ok: rememberResult.ok, remember: rememberResult });
  }

  const failedCount = chunkOutcomes.filter((outcome) => !outcome.ok).length;
  if (failedCount > 0) {
    return {
      ok: false,
      chunks: chunkOutcomes,
      error: {
        code: 'partial_ingest_failure',
        message:
          `${failedCount} of ${chunkOutcomes.length} chunk(s) failed to write via remember() — see chunks[] for ` +
          `exactly which succeeded and which failed; this is never a generic all-or-nothing error.`,
      },
    };
  }

  return { ok: true, chunks: chunkOutcomes };
}
