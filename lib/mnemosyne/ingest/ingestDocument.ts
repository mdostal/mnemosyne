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
 * Bounded, explicit scope for this story's original cut (never hand-waved):
 * plain text (`.txt`) and Markdown (`.md`) content only — confirmed via
 * `package.json` that no PDF-parsing dependency existed anywhere in this
 * codebase at the time. A free-text description or CV/resume supplied as a
 * plain string (no file at all, `filename` omitted) is the trivial subcase
 * of the same path.
 *
 * **ro-13-pdf-document-ingestion amendment (design-discussion.md §7.9):**
 * `.pdf` is now a supported input format, landing as a NEW BRANCH inside
 * this SAME `ingestDocument()` primitive — never a second ingestion path.
 * PDF bytes are extracted via `unpdf@^1.8.1` (chosen over `pdf-parse` —
 * see the story's `design_decisions` — because it vendors Mozilla's own
 * `pdf.js` directly with zero required dependencies, registry- and
 * tarball-confirmed no `.node`/`.wasm` binaries, unlike `pdf-parse`'s hard
 * dependency on the native-binding `@napi-rs/canvas`). A NEW, separate cap
 * (`MAX_PDF_SOURCE_BYTES`, see below) bounds the raw PDF file's bytes
 * BEFORE any parsing is attempted; `unpdf`'s `extractText(pdf, {
 * mergePages: false })` then returns one text string PER PAGE, and each
 * page is run through this module's SAME existing `chunkContent()`
 * independently — the resulting `Content.metadata` for every PDF chunk
 * carries both `page` and a chunk-within-page `chunk_index`, never a single
 * flattened chunk-N-of-file tag that loses page identity. The
 * already-extracted text is then subject to this module's SAME,
 * UNCHANGED `MAX_INGEST_BYTES` check ro-10 already enforces for `.txt`/
 * `.md` — this story adds zero new, parallel size-enforcement logic for the
 * post-extraction stage. Corrupt/encrypted PDFs fail loudly: `unpdf`'s
 * vendored `pdf.js` throws real, named `PasswordException`/
 * `InvalidPDFException` classes (from `unpdf/pdfjs`), caught by name here
 * and surfaced as distinguishable errors, never a generic catch-all.
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
import { extractText, getDocumentProxy } from 'unpdf';
import { InvalidPDFException, PasswordException } from 'unpdf/pdfjs';
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

/**
 * Hard byte ceiling on a `.pdf` file's RAW, COMPRESSED SOURCE bytes,
 * checked BEFORE `getDocumentProxy()`/`extractText()` is ever called —
 * never after a partial parse attempt has already started (ro-13 grill
 * round 3, finding 1).
 *
 * Deliberately a SEPARATE constant from `MAX_INGEST_BYTES` above, not the
 * same literal cap reused: the two bound structurally different things.
 * `MAX_INGEST_BYTES` bounds already-extracted, plain TEXT bytes.
 * `MAX_PDF_SOURCE_BYTES` bounds the compressed BINARY PDF file's bytes
 * before any text has been extracted from it — a PDF's byte size is
 * dominated by embedded images/fonts and is not a reliable proxy for how
 * much text it contains, so conflating the two caps would either let a
 * huge, image-heavy PDF through (if sized for text) or reject a
 * legitimate, text-heavy, well-compressed multi-page PDF (if sized too
 * small). A future maintainer should never assume these two constants are
 * interchangeable.
 */
export const MAX_PDF_SOURCE_BYTES = 20_000_000;

/** The file extensions this module accepts (case-insensitive). Bounded, not hand-waved — see module doc comment. `.pdf` routes through a structurally different (bytes-in, extract-then-chunk) path than `.txt`/`.md`'s (text-in, chunk-directly) path — see `MAX_PDF_SOURCE_BYTES` above. */
export const SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set(['.txt', '.md', '.pdf']);

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
  /**
   * The document's content. For `.txt`/`.md`/filename-less content, a plain
   * text string (never binary). For a `.pdf` filename, the raw PDF file's
   * bytes as a `Buffer` (a `Buffer` from `fs.readFileSync()` satisfies this
   * directly) — checked against `MAX_PDF_SOURCE_BYTES` before any parsing
   * is attempted. A `string` supplied alongside a `.pdf` filename is
   * accepted too (encoded to bytes via UTF-8) purely so a caller can still
   * exercise the PDF path without a real file handle in hand; it will
   * virtually always fail extraction (`corrupt_pdf`) unless it is genuinely
   * valid PDF syntax, which a plain string essentially never is.
   */
  content: string | Buffer;
  /**
   * Optional source filename. When present, its extension MUST be in
   * `SUPPORTED_EXTENSIONS` (checked before any remember() call) and it is
   * carried into each chunk's `Content.metadata.filename` for provenance.
   * Omit entirely for a free-text description/CV supplied as a plain string
   * with no file at all (the trivial subcase of the same path). A `.pdf`
   * extension routes `content` through the PDF extraction branch (see
   * `MAX_PDF_SOURCE_BYTES`) instead of being chunked directly.
   */
  filename?: string;
  /** Optional caller-supplied tag, carried into each chunk's `Content.metadata.tag` alongside filename/chunk index. */
  tag?: string;
  /** Scope to write into. Defaults to `'project'` — ingested content is scoped exactly the same way any other remember() call already is, never a shared/global default. */
  scope?: Scope;
}

/** One chunk's outcome: which chunk it was, and its real `RememberResult`. */
export interface IngestChunkOutcome {
  /**
   * 0-based chunk index, matching `Content.metadata.chunk_index` on the
   * remember() call this chunk produced. For a PDF chunk, this is
   * PAGE-SCOPED (the chunk-within-page index — see `page` below), not a
   * document-wide index.
   */
  index: number;
  /** The source filename this chunk was tagged with, or `null` for filename-less content. */
  filename: string | null;
  /** 1-based source PDF page this chunk was extracted from, or `null` for non-PDF content (ro-13). */
  page: number | null;
  /** Convenience mirror of `remember.ok`, for filtering without unwrapping the discriminated union. */
  ok: boolean;
  /** The real, unmodified `RememberResult` this chunk's `remember()` call returned. */
  remember: RememberResult;
}

export interface IngestDocumentError {
  code:
    | 'oversized_content'
    | 'unsupported_format'
    | 'partial_ingest_failure'
    | 'oversized_pdf_source'
    | 'encrypted_pdf'
    | 'corrupt_pdf'
    | 'pdf_parse_failed';
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
// Shared failure/outcome helpers — reused unchanged by both the plain-text
// (.txt/.md) path and the PDF path below, so neither path ever grows its
// own parallel size-enforcement or partial-failure-reporting logic.
// ---------------------------------------------------------------------------

function unsupportedFormatFailure(ext: string, filename: string): IngestDocumentFailure {
  return {
    ok: false,
    chunks: [],
    error: {
      code: 'unsupported_format',
      message:
        `Unsupported format '${ext || '(no extension)'}' for '${filename}' — ingestDocument() only accepts ` +
        `.txt/.md/.pdf content (SUPPORTED_EXTENSIONS). Convert '${filename}' to plain text, Markdown, or PDF ` +
        `before ingesting; this is never a best-effort attempt to read arbitrary binary content as text.`,
    },
  };
}

/**
 * ro-10's existing oversized-content rejection, reused UNCHANGED for both
 * `.txt`/`.md` content directly and, after extraction, PDF-derived text
 * (ro-13 AC #5) — this story adds zero new, parallel size-enforcement logic
 * for the post-extraction stage, only the new pre-parse
 * `MAX_PDF_SOURCE_BYTES` gate (see `oversizedPdfSourceFailure` below).
 */
function oversizedContentFailure(actualBytes: number): IngestDocumentFailure {
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

function oversizedPdfSourceFailure(actualBytes: number, filename: string): IngestDocumentFailure {
  return {
    ok: false,
    chunks: [],
    error: {
      code: 'oversized_pdf_source',
      message:
        `'${filename}' is ${actualBytes} raw bytes, exceeding the ${MAX_PDF_SOURCE_BYTES}-byte ` +
        `MAX_PDF_SOURCE_BYTES ceiling — rejected before getDocumentProxy()/extractText() is ever invoked, never ` +
        `a silent truncate-then-parse. This bounds the PDF's compressed SOURCE bytes, distinct from ` +
        `MAX_INGEST_BYTES (which bounds already-extracted text).`,
    },
  };
}

/** One chunk of a document, ready to be handed to `client.remember()`. */
interface ChunkSpec {
  text: string;
  metadata: Record<string, unknown>;
  index: number;
  filename: string | null;
  page: number | null;
}

/**
 * Calls `client.remember()` once per `ChunkSpec`, sequentially — NEVER
 * parallel/`Promise.all` (see module doc comment: no precedent for
 * concurrent `remember()` calls exists anywhere in this codebase). A
 * mid-sequence chunk failure does not stop the remaining chunks.
 */
async function rememberSequentially(client: IngestClient, scope: Scope, specs: ChunkSpec[]): Promise<IngestChunkOutcome[]> {
  const outcomes: IngestChunkOutcome[] = [];
  for (const spec of specs) {
    const rememberResult = await client.remember({ text: spec.text, metadata: spec.metadata }, scope);
    outcomes.push({ index: spec.index, filename: spec.filename, page: spec.page, ok: rememberResult.ok, remember: rememberResult });
  }
  return outcomes;
}

/**
 * Turns a completed sequence of chunk outcomes into the final result —
 * reports exactly which chunks succeeded/failed (mirrors `ro-06`'s own
 * partial-state loud-failure convention), never a generic all-or-nothing
 * error. Shared by both the plain-text and PDF paths.
 */
function finalizeChunkOutcomes(chunkOutcomes: IngestChunkOutcome[]): IngestDocumentResult {
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

function buildTextChunkSpecs(content: string, filename: string | null, tag: string | undefined): ChunkSpec[] {
  const chunkTexts = chunkContent(content, CHUNK_SIZE_BYTES);
  return chunkTexts.map((text, index) => {
    const metadata: Record<string, unknown> = { filename, chunk_index: index, chunk_count: chunkTexts.length };
    if (tag !== undefined) {
      metadata.tag = tag;
    }
    return { text, metadata, index, filename, page: null };
  });
}

// ---------------------------------------------------------------------------
// PDF input path (ro-13-pdf-document-ingestion)
// ---------------------------------------------------------------------------

/**
 * Extracts text from `pdfBytes` (already confirmed <= `MAX_PDF_SOURCE_BYTES`
 * by the caller) via `unpdf`, enforces `MAX_INGEST_BYTES` on the resulting
 * extracted text (ro-10's SAME, UNCHANGED check), and produces one
 * `ChunkSpec` per page-chunk — each carrying BOTH the 1-based page number
 * and the chunk-within-page index, per ro-13 AC #1.
 *
 * Real, distinguishable failures: `PasswordException` (encrypted PDF) and
 * `InvalidPDFException` (corrupt/malformed PDF) are caught BY NAME —
 * confirmed directly from `unpdf`'s vendored `pdf.js` (`unpdf/pdfjs`), never
 * a generic catch-all. Any other unexpected parse error still fails loudly
 * and distinguishably (`pdf_parse_failed`), naming the underlying error.
 */
async function extractPdfChunkSpecs(
  pdfBytes: Buffer,
  filename: string,
  tag: string | undefined,
): Promise<{ specs: ChunkSpec[] } | { failure: IngestDocumentFailure }> {
  let totalPages: number;
  let pageTexts: string[];
  try {
    const pdf = await getDocumentProxy(new Uint8Array(pdfBytes));
    const extracted = await extractText(pdf, { mergePages: false });
    totalPages = extracted.totalPages;
    pageTexts = extracted.text;
  } catch (err) {
    if (err instanceof PasswordException) {
      return {
        failure: {
          ok: false,
          chunks: [],
          error: {
            code: 'encrypted_pdf',
            message:
              `'${filename}' is encrypted/password-protected (unpdf/pdf.js's PasswordException) — ingestDocument() ` +
              `does not accept a password; decrypt the PDF before ingesting. This is never a silent empty-content ` +
              `ingest, and distinguishable from a corrupt-PDF failure.`,
          },
        },
      };
    }
    if (err instanceof InvalidPDFException) {
      return {
        failure: {
          ok: false,
          chunks: [],
          error: {
            code: 'corrupt_pdf',
            message:
              `'${filename}' is corrupt/unparseable (unpdf/pdf.js's InvalidPDFException: ${err.message}) — its PDF ` +
              `structure could not be parsed. This is never a silent empty-content ingest, and distinguishable ` +
              `from an encrypted-PDF failure.`,
          },
        },
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      failure: {
        ok: false,
        chunks: [],
        error: {
          code: 'pdf_parse_failed',
          message: `'${filename}' failed to parse via unpdf for an unrecognized reason: ${message}`,
        },
      },
    };
  }

  // ro-10's SAME, UNCHANGED MAX_INGEST_BYTES check, applied to the
  // post-extraction text — ro-13 AC #5: zero new, parallel
  // size-enforcement logic for this stage.
  const fullExtractedText = pageTexts.join('\n\n');
  const extractedBytes = Buffer.byteLength(fullExtractedText, 'utf8');
  if (extractedBytes > MAX_INGEST_BYTES) {
    return { failure: oversizedContentFailure(extractedBytes) };
  }

  const specs: ChunkSpec[] = [];
  for (let pageIndex = 0; pageIndex < pageTexts.length; pageIndex++) {
    const pageNumber = pageIndex + 1;
    const pageText = pageTexts[pageIndex]!;
    // Each PAGE's text is chunked independently via the SAME chunkContent()
    // used for .txt/.md — a page whose text exceeds one chunk's bound still
    // splits into multiple chunks, exactly like ro-10's own multi-chunk
    // behavior for a long .txt/.md file.
    const pageChunkTexts = chunkContent(pageText, CHUNK_SIZE_BYTES);
    for (let chunkIndex = 0; chunkIndex < pageChunkTexts.length; chunkIndex++) {
      const metadata: Record<string, unknown> = {
        filename,
        page: pageNumber,
        page_count: totalPages,
        chunk_index: chunkIndex,
        chunk_count: pageChunkTexts.length,
      };
      if (tag !== undefined) {
        metadata.tag = tag;
      }
      specs.push({ text: pageChunkTexts[chunkIndex]!, metadata, index: chunkIndex, filename, page: pageNumber });
    }
  }

  return { specs };
}

// ---------------------------------------------------------------------------
// ingestDocument()
// ---------------------------------------------------------------------------

/**
 * Chunks bounded input content and calls `client.remember()` once per
 * chunk, sequentially (never parallel — see module doc comment). Each
 * chunk's `Content.metadata` carries the source filename and chunk index
 * (plus, for PDF input, the source page number — see the module doc
 * comment's ro-13 section), so a later `recall()` hit's provenance traces
 * back to a real position in the source document, never an anonymous blob.
 *
 * Pre-checks (oversized content/PDF source, unsupported format) run BEFORE
 * any `remember()` call and reject loudly. A mid-sequence chunk failure does
 * NOT stop the remaining chunks — every chunk is attempted, and the result
 * reports exactly which succeeded/failed.
 */
export async function ingestDocument(client: IngestClient, options: IngestDocumentOptions): Promise<IngestDocumentResult> {
  const { content, tag, scope = 'project' } = options;
  const filename = options.filename ?? null;
  const ext = filename !== null ? path.extname(filename).toLowerCase() : null;

  if (filename !== null && !SUPPORTED_EXTENSIONS.has(ext!)) {
    return unsupportedFormatFailure(ext!, filename);
  }

  if (ext === '.pdf') {
    // filename is non-null whenever ext is non-null (see above).
    const pdfBytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');

    // MAX_PDF_SOURCE_BYTES checked BEFORE getDocumentProxy()/extractText()
    // is ever called (ro-13 AC #2) — never after a partial parse attempt.
    const actualPdfBytes = pdfBytes.byteLength;
    if (actualPdfBytes > MAX_PDF_SOURCE_BYTES) {
      return oversizedPdfSourceFailure(actualPdfBytes, filename!);
    }

    const extraction = await extractPdfChunkSpecs(pdfBytes, filename!, tag);
    if ('failure' in extraction) {
      return extraction.failure;
    }

    const chunkOutcomes = await rememberSequentially(client, scope, extraction.specs);
    return finalizeChunkOutcomes(chunkOutcomes);
  }

  // Plain-text (.txt/.md) or filename-less free-text path (ro-10, unchanged).
  const textContent = typeof content === 'string' ? content : content.toString('utf8');
  const actualBytes = Buffer.byteLength(textContent, 'utf8');
  if (actualBytes > MAX_INGEST_BYTES) {
    return oversizedContentFailure(actualBytes);
  }

  const specs = buildTextChunkSpecs(textContent, filename, tag);
  const chunkOutcomes = await rememberSequentially(client, scope, specs);
  return finalizeChunkOutcomes(chunkOutcomes);
}
