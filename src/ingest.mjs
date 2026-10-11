// ingest.mjs — PANT-1046: batch document ingest for the running server
// (src/server.mjs, :8477).
//
//   POST /ingest {scope, docs: [{path, text, metadata?}], status?, source_ref?}
//
// Until now, chunked .md/.txt ingest lived only in lib/mnemosyne/server.ts
// (bin/mnemosyne-client-api, :3141), a second process the Pantheon container
// never runs and whose image doesn't even ship lib/. This module carries the
// same chunking rules (CHUNK_SIZE_BYTES / MAX_INGEST_BYTES and the
// UTF-8-safe split from lib/mnemosyne/ingest/ingestDocument.ts) in plain Node,
// and writes each chunk through engine.mjs's remember(), the same
// write-through path POST /remember uses. No second process, no new storage.
//
// Target scope: any scope in the scope map, client and repo scopes alike
// (e.g. `firefly-events--flayr`, `pantheon-v2`). Unknown scope -> 400.
//
// Dedupe is by content hash, per scope: every chunk's note carries an
// `ingest-sha256:<sha256 of the chunk text>` marker line. Before a write the
// chunk is skipped as `duplicate` if this process already wrote that hash to
// the same collection, or if a keyword grep of the scope finds a hit whose
// text carries the marker. The collection is the source of truth, so dedupe
// survives restarts (the container persists no notes dir). If the grep
// itself fails the chunk is written anyway and a warning is returned:
// a failed dedupe check never blocks an ingest.
//
// Per-doc source metadata (path, chunk index/count, doc hash, the caller's
// metadata object) is written into each chunk's note text, so a recall hit
// traces back to its source document.
//
// Chunks are written sequentially, never in parallel (same rule as
// ingestDocument.ts). A failed chunk doesn't stop the rest; the response
// says exactly which chunks landed.

import { createHash } from "node:crypto";
import path from "node:path";
import { STATUSES, normalizeSourceRef } from "./flight-status.mjs";

// Same values as lib/mnemosyne/ingest/ingestDocument.ts.
export const MAX_INGEST_BYTES = 200_000;
export const CHUNK_SIZE_BYTES = 4_000;
export const SUPPORTED_EXTENSIONS = new Set([".md", ".txt"]);
export const MAX_DOCS_PER_REQUEST = 50;
export const MAX_PATH_CHARS = 512;
export const MAX_METADATA_BYTES = 2_000;
export const INGEST_MARKER = "ingest-sha256:";

// Defaults for remember()'s provenance: the server has no git checkout to
// auto-detect from, and an ingested document isn't branch work, so it lands
// `confirmed` (visible to every recall) unless the caller says otherwise.
const DEFAULT_STATUS = "confirmed";
const DEFAULT_SOURCE_REF = { branch: "ingest" };

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// Splits content into chunks of at most maxBytes UTF-8 bytes without splitting
// a multi-byte sequence. Same algorithm as ingestDocument.ts's chunkContent().
export function chunkContent(content, maxBytes = CHUNK_SIZE_BYTES) {
  const bytes = Buffer.from(content, "utf8");
  const chunks = [];
  let offset = 0;
  while (offset < bytes.length) {
    let end = Math.min(offset + maxBytes, bytes.length);
    while (end < bytes.length && end > offset && (bytes[end] & 0xc0) === 0x80) end--;
    chunks.push(bytes.subarray(offset, end).toString("utf8"));
    offset = end;
  }
  return chunks;
}

// The note text one chunk is remembered as. The marker and the provenance
// comment sit on their own lines so recall/grep hits show them verbatim.
export function chunkNoteText({ docPath, index, count, docSha, chunkSha, metadata, text }) {
  const prov = JSON.stringify({
    source_path: docPath,
    chunk_index: index,
    chunk_count: count,
    doc_sha256: docSha,
    metadata,
  }).replace(/-->/g, "--\\u003e");
  return (
    `[ingested document] source: ${docPath} (chunk ${index + 1}/${count})\n` +
    `<!-- mnemosyne-ingest ${prov} -->\n` +
    `${INGEST_MARKER}${chunkSha}\n\n` +
    text
  );
}

// Per-doc checks. Returns an error string, or null when the doc is ingestible.
function validateDoc(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return "doc must be an object {path, text, metadata?}";
  if (typeof doc.path !== "string" || !doc.path.trim()) return "path is required";
  if (doc.path.length > MAX_PATH_CHARS) return `path is longer than ${MAX_PATH_CHARS} characters`;
  if (/[\r\n]/.test(doc.path) || doc.path.includes("-->")) return "path must be a single line with no '-->'";
  const ext = path.extname(doc.path).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    return `unsupported format '${ext || "(none)"}': only ${[...SUPPORTED_EXTENSIONS].join(", ")} are ingested`;
  }
  if (typeof doc.text !== "string" || !doc.text.trim()) return "text is required";
  const bytes = Buffer.byteLength(doc.text, "utf8");
  if (bytes > MAX_INGEST_BYTES) {
    return `text is ${bytes} bytes, over the ${MAX_INGEST_BYTES}-byte limit; split the document and ingest the parts`;
  }
  if (doc.metadata != null) {
    if (typeof doc.metadata !== "object" || Array.isArray(doc.metadata)) return "metadata must be an object";
    if (Buffer.byteLength(JSON.stringify(doc.metadata), "utf8") > MAX_METADATA_BYTES) {
      return `metadata is over ${MAX_METADATA_BYTES} bytes as JSON`;
    }
  }
  return null;
}

/**
 * Builds the ingest handler. `deps` are engine.mjs's scopeMap/remember/grep
 * (tests pass stubs). The returned function keeps a per-process set of
 * hashes it has written, the fast path in front of the grep check.
 */
export function createIngest({ scopeMap, remember, grep }) {
  const written = new Set(); // `${collection}\0${sha}`

  async function alreadyStored(scope, collection, chunkSha) {
    if (written.has(`${collection}\0${chunkSha}`)) return true;
    const result = await grep(chunkSha, scope, { hits: 5 });
    const marker = `${INGEST_MARKER}${chunkSha}`;
    for (const s of result.scopes || []) {
      if (s.collection && s.collection !== collection) continue;
      for (const h of s.hits || []) {
        if (String(h.text || "").includes(marker)) return true;
      }
    }
    return false;
  }

  return async function ingest(body = {}) {
    const scope = body.scope == null ? "" : String(body.scope).trim();
    if (!scope) throw badRequest("scope is required");
    if (!Array.isArray(body.docs) || body.docs.length === 0) throw badRequest("docs must be a non-empty array of {path, text, metadata?}");
    if (body.docs.length > MAX_DOCS_PER_REQUEST) {
      throw badRequest(`at most ${MAX_DOCS_PER_REQUEST} docs per request (got ${body.docs.length})`);
    }
    const m = await scopeMap();
    const collection = m.scopes[scope];
    if (!collection) throw badRequest(`unknown scope '${scope}'. known: ${Object.keys(m.scopes).join(", ")}`);

    // Checked once up front so a bad value is a 400 before anything is
    // written, not a failure halfway through the batch.
    const status = body.status ?? DEFAULT_STATUS;
    if (!STATUSES.includes(status)) throw badRequest(`invalid status '${status}'. must be one of: ${STATUSES.join(", ")}`);
    let sourceRef;
    try {
      sourceRef = normalizeSourceRef(body.source_ref ?? body.sourceRef ?? DEFAULT_SOURCE_REF);
    } catch (e) {
      throw badRequest(`invalid source_ref: ${e.message}`);
    }
    const warnings = [];
    const totals = { docs: body.docs.length, chunks: 0, ingested: 0, duplicate: 0, failed: 0, rejected_docs: 0 };
    const docs = [];

    for (const doc of body.docs) {
      const invalid = validateDoc(doc);
      if (invalid) {
        totals.rejected_docs++;
        docs.push({ path: typeof doc?.path === "string" ? doc.path : null, status: "rejected", error: invalid, chunks: [] });
        continue;
      }
      const docSha = sha256(doc.text);
      const metadata = doc.metadata ?? {};
      const pieces = chunkContent(doc.text);
      const chunks = [];
      for (let index = 0; index < pieces.length; index++) {
        const chunkSha = sha256(pieces[index]);
        totals.chunks++;
        let dup = false;
        try {
          dup = await alreadyStored(scope, collection, chunkSha);
        } catch (e) {
          warnings.push(`dedupe check failed for ${doc.path} chunk ${index}, written anyway: ${e.message || e}`);
        }
        if (dup) {
          totals.duplicate++;
          chunks.push({ index, sha256: chunkSha, status: "duplicate" });
          continue;
        }
        const text = chunkNoteText({ docPath: doc.path, index, count: pieces.length, docSha, chunkSha, metadata, text: pieces[index] });
        try {
          const r = await remember(text, scope, { tag: "ingest", status, sourceRef });
          written.add(`${collection}\0${chunkSha}`);
          totals.ingested++;
          chunks.push({ index, sha256: chunkSha, status: "ingested", file: r.file, chunks_upserted: r.chunks_upserted });
        } catch (e) {
          totals.failed++;
          chunks.push({ index, sha256: chunkSha, status: "failed", error: String(e.message || e) });
        }
      }
      const failed = chunks.filter((c) => c.status === "failed").length;
      const docStatus =
        failed === 0
          ? chunks.every((c) => c.status === "duplicate") ? "duplicate" : "ingested"
          : failed === chunks.length ? "failed" : "partial";
      docs.push({ path: doc.path, doc_sha256: docSha, status: docStatus, chunk_count: pieces.length, chunks });
    }

    return {
      ok: totals.failed === 0 && totals.rejected_docs === 0,
      scope,
      collection,
      totals,
      docs,
      warnings,
    };
  };
}
