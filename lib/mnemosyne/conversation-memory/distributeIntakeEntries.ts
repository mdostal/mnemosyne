/**
 * cm-13-intake-distribution (epic: mnemosyne-conversation-memory).
 *
 * Reads `cm-07`'s `intake` landing entries, resolves each one's REAL
 * destination (the operator's own `meta` collection, or a confirmed real
 * client scope), writes there, and marks the original intake entry as
 * distributed. This story now owns the confirmed-vs-unconfirmed
 * scope-routing decision `cm-07` originally carried through round 3
 * (docs/design-discussion.md §10.2), moved here verbatim in substance,
 * round 4 (§11.2/§11.3) — the epic's own highest-stakes scope-routing
 * checkpoint, held to the SAME highest-scrutiny bar `cm-07`'s own
 * persist-time scan checkpoint was held to.
 *
 * ---------------------------------------------------------------------------
 * Research findings (this story's own research step, real and live, not
 * assumed) — see this repo's `.pHive/epics/mnemosyne-conversation-memory/
 * stories/cm-13-intake-distribution.yaml` for the full brief.
 * ---------------------------------------------------------------------------
 *
 * 1. **Real, live Qdrant scroll-endpoint shape, confirmed directly against
 *    the operator's own live Qdrant Cloud cluster this pass (2026-08-27,
 *    `POST /collections/{name}/points/scroll` against a real, existing
 *    collection):** `{"result": {"points": [{"id", "payload"}, ...],
 *    "next_page_offset": <id> | null}, "status": "ok"}`. A real point's
 *    `payload.text` field is exactly the Markdown text `swarm-memory index`
 *    persisted — the SAME field `cm-07`'s own embedded provenance-header
 *    convention (`distillAndRemember.ts`'s `buildProvenanceHeader()`/
 *    `parseProvenanceHeader()`) writes into and reads back out of. This
 *    confirms `cm-07`'s own "provenance survives only in the persisted TEXT"
 *    finding (its own module doc comment) is exactly what this story must
 *    read back.
 *
 * 2. **No existing TS-side Qdrant HTTP client to import, confirmed by
 *    reading every TS file that mentions "qdrant"/"Qdrant" in this repo:**
 *    `VectorLayerAdapter.ts` never itself makes an HTTP call to Qdrant — it
 *    shells out to the `swarm-memory` CLI exclusively, and `swarm-memory
 *    --help` (re-confirmed this pass) has no scroll/enumerate verb (`cm-07`'s
 *    own §11.1 finding: `recall|search|grep|check|scopes|index|graph|
 *    config|install-hermes`). `scroll_points()` is therefore added, per the
 *    story brief, as a NEW read-only method on `mnemosyne/inventory/
 *    qdrant_inventory.py`'s Python `HttpQdrantClient` (a real, separate,
 *    additive capability for Python-side inventory/decommission tooling —
 *    see `cm-14`'s own future §11.4(b) reuse of this exact primitive). This
 *    TS pipeline module has no Python runtime to call into directly, so it
 *    declares its OWN `ScrollPointsFn` — an injectable interface mirroring
 *    the SAME real, read-only, intake-collection-only primitive, confirmed
 *    against the SAME live endpoint shape (finding 1 above). Exactly like
 *    `distillAndRemember.ts`'s own `IngestClient`, this is REQUIRED, never
 *    given an accidental default production implementation this module
 *    could construct on a caller's behalf — no code path in this file can
 *    reach live Qdrant. A real production `ScrollPointsFn` is expected to be
 *    wired by a future orchestrator (`cm-11`/`cm-12`), using the SAME URL/
 *    API-key resolution `mnemosyne/inventory/qdrant_inventory.py`'s own
 *    `load_qdrant_url()`/`read_qdrant_key()` already establish, or a thin TS
 *    HTTP client following the identical confirmed shape — building that
 *    wiring is explicitly out of THIS story's own bounded scope (no CLI/
 *    orchestrator file appears in this story's own `files_to_modify`).
 *
 * 3. **The real, safe `Scope`-type widening mechanism for a confirmed real
 *    scope key — the SAME local, one-call-site widening boundary `cm-07`'s
 *    own research step already established for `'intake'`, re-confirmed
 *    here since THIS story (not `cm-07`) is the one that actually calls
 *    `remember()` with a confirmed non-`meta` value:** `interfaces.ts`'s
 *    `Scope` type stays byte-for-byte unchanged by this story too;
 *    `resolveDestinationScope()` below performs the ONE, single,
 *    well-documented `as unknown as Scope` assertion, confined to this file,
 *    exactly mirroring `distillAndRemember.ts`'s own `INTAKE_SCOPE`
 *    constant.
 *
 * 4. **The operator's own scope-route confirmation record — no existing
 *    on-disk convention for this exists anywhere in the codebase yet
 *    (confirmed by a full repo grep for `review_reason`/`scope_route`):**
 *    `cm-06`'s own module doc comment (`clusterConversations.ts`) confirms
 *    it only ever RETURNS a `resolved_scope_candidate` as in-memory cluster
 *    metadata — no story before this one has ever written a
 *    `review_reason: 'scope_route_candidate'` line, or any confirmation of
 *    one, to disk. This story's own research finding, real and concrete:
 *    the confirmation record is a NEW, append-only JSONL line format,
 *    living in the SAME on-disk human-review queue `cm-01`/`cm-05`/`cm-07`
 *    already append to (`DEFAULT_TRIAGE_QUEUE_PATH`,
 *    `~/.mnemosyne/conversation-triage-queue.jsonl`) — mirrors that queue's
 *    own established "one JSONL file, many distinctly-tagged record kinds"
 *    convention (`quarantine_reason: 'secret_detected'` today) exactly,
 *    tagged `confirmation_reason: 'scope_route_confirmed'`, naming the
 *    EXACT `cluster_id` and `scope_key` an operator has explicitly
 *    confirmed (append is a real, human/operator-authored action against
 *    this file — this module only ever READS it, never writes a
 *    confirmation itself). See `readScopeRouteConfirmations()` below.
 *
 * ---------------------------------------------------------------------------
 * The confirmed-vs-unconfirmed destination logic — the epic's highest-stakes
 * checkpoint (design-discussion.md §10.2/§11.3, this story's own risk
 * register's one `severity: critical` entry).
 * ---------------------------------------------------------------------------
 * For a given intake entry's carried-forward `resolved_scope_candidate`
 * (`cm-06`'s own read-only output, `null` for most entries): the destination
 * is the CONFIRMED real scope ONLY IF (a) a candidate exists, AND (b) that
 * entry's own `cluster_id` is non-null, AND (c) a real, on-disk
 * confirmation record exists naming BOTH that EXACT `cluster_id` AND that
 * EXACT candidate's `scope_key` (defense in depth beyond cluster_id alone —
 * a confirmation naming the right cluster but the WRONG scope key is also
 * never trusted). EVERY other case — no candidate, a candidate with no
 * confirmation record at all, or a confirmation naming a DIFFERENT
 * cluster_id or a DIFFERENT scope_key — resolves to `scope: 'meta'`
 * unconditionally. This is the exact same safe default §10.2 established
 * for `cm-07`, now living here (`resolveDestinationScope()` below is the
 * ONE function in this file that ever decides a non-'meta' scope value; no
 * other code path in this file sets `destinationScope` any other way).
 *
 * ---------------------------------------------------------------------------
 * Marking as distributed — additive, never a mutation (design-discussion.md
 * §11.1/§11.3).
 * ---------------------------------------------------------------------------
 * No in-place update-by-id primitive exists anywhere in this epic's real
 * dependency surface (`cm-07`'s own §11.1 finding, re-confirmed unchanged
 * here) — "marking" is therefore a SECOND, NEW `ingestDocument()`/
 * `remember()` call, writing a small `distribution_marker` entry into the
 * SAME `intake` collection, never an in-place rewrite of the original
 * entry's own point. The original intake entry's point is never re-written,
 * mutated, or deleted anywhere in this file — this module contains no
 * delete/update-by-id call of any kind, only two additive `remember()`
 * calls per successfully distributed entry.
 *
 * ---------------------------------------------------------------------------
 * Idempotency (this story's own AC).
 * ---------------------------------------------------------------------------
 * An intake entry whose `entry_id` already has a matching
 * `distribution_marker` point (`metadata.marks_entry_id` equal to that
 * `entry_id`, discovered by scrolling the SAME intake collection) is
 * skipped entirely — no destination write, no second marker, on any re-run.
 *
 * ---------------------------------------------------------------------------
 * A named, accepted residual risk (this story's own risk register, severity
 * `high`) — NOT solved here, deliberately deferred.
 * ---------------------------------------------------------------------------
 * If a destination write succeeds but the FOLLOWING marker write fails
 * (e.g. a transient error), a re-run of this function has no durable way to
 * know the destination copy already exists (this module never reads the
 * destination collection) — it will re-resolve the SAME destination and
 * attempt ANOTHER destination write, producing a duplicate destination
 * copy. This is a real, accepted, NAMED possibility, not silently ignored:
 * `ways_of_working.md`'s own "additive/upsert only, everywhere" posture
 * tolerates a duplicate write (it is never destructive), and `cm-14`'s own
 * future precondition check (§11.4(b)) independently re-verifies the
 * destination copy's real presence before ever treating an entry as safe to
 * decommission from `intake` — a partial-write state here is caught there,
 * never silently trusted. This module's own idempotency guarantee is
 * strictly narrower and fully met: skip-on-existing-marker, verified by
 * this file's own test suite.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Scope } from '../interfaces.js';
import { ingestDocument, type IngestClient, type IngestDocumentResult } from '../ingest/ingestDocument.js';
import { parseProvenanceHeader, type EntryProvenanceMetadata } from './distillAndRemember.js';
import { DEFAULT_TRIAGE_QUEUE_PATH } from './triageSession.js';

// ---------------------------------------------------------------------------
// Named constants
// ---------------------------------------------------------------------------

/**
 * The `intake` collection's own real, recommended name (`cm-07`'s own
 * §11.2 recommendation, `<domain>_<memory-type>` convention). Hardcoded and
 * used at EXACTLY one call site (`distributeIntakeEntries()` below) — this
 * module never accepts a caller-supplied collection name for `scrollPoints`,
 * structurally, so `scroll_points()`'s own real invocation can never be
 * redirected against any other collection.
 */
export const INTAKE_COLLECTION_NAME = 'conversation_memory_intake';

/**
 * The ONE, single, well-documented local type-widening assertion boundary
 * in this file for the `'intake'` scope value — mirrors
 * `distillAndRemember.ts`'s own `INTAKE_SCOPE` constant exactly (same real
 * value, same reasoning: `VectorLayerAdapter.remember()`'s own
 * `cfg.scopes?.[scope]` resolution treats `scope` as a plain runtime string
 * key, so widening the TYPE only is safe). Used only for the marker write,
 * which always lands back in `intake`.
 */
const INTAKE_SCOPE = 'intake' as unknown as Scope;

/**
 * Mirrors `distillAndRemember.ts`'s own private `PROVENANCE_HEADER_MARKER`
 * constant value EXACTLY (same literal string) — deliberately, so this
 * story's own `distribution_marker` entries round-trip through the SAME,
 * imported, UNCHANGED `parseProvenanceHeader()` reader `cm-07`'s own
 * original entries already use. Not imported directly (that constant is
 * private to `distillAndRemember.ts`, and this story's own `files_to_modify`
 * does not touch that file) — duplicated here as a single, well-documented
 * literal specifically to preserve the shared read format, never to
 * reimplement `parseProvenanceHeader()`'s own parsing logic (which IS
 * imported, unchanged, below).
 */
const PROVENANCE_HEADER_MARKER = 'mnemosyne-intake-provenance';

// ---------------------------------------------------------------------------
// scroll_points() — the injectable, read-only intake-enumeration primitive.
// ---------------------------------------------------------------------------

/** One raw point as returned by Qdrant's own scroll endpoint (id + payload only — `with_vector: false`, this story never needs raw vectors). */
export interface ScrolledPoint {
  id: string;
  payload: Record<string, unknown>;
}

/**
 * Mirrors `mnemosyne/inventory/qdrant_inventory.py`'s
 * `HttpQdrantClient.scroll_points(name, payload_filter=None)` — the SAME
 * real, read-only Qdrant `POST /collections/{name}/points/scroll`
 * primitive (research finding 1 above), re-declared here as this TS
 * pipeline's own injectable interface (research finding 2 above). REQUIRED
 * — no default production implementation is constructed by this module.
 * Tests supply a stub that returns a fixed, in-memory point list; never
 * live Qdrant (this story's own hard constraint).
 */
export type ScrollPointsFn = (collectionName: string, payloadFilter?: Record<string, unknown> | null) => Promise<ScrolledPoint[]>;

// ---------------------------------------------------------------------------
// distribution_marker — the additive "marked as distributed" entry.
// ---------------------------------------------------------------------------

export interface DistributionMarkerMetadata {
  /** The marker's own new UUID — distinct from `marks_entry_id`. */
  entry_id: string;
  entry_type: 'distribution_marker';
  /** The ORIGINAL intake entry's own `entry_id` this marker refers to. */
  marks_entry_id: string;
  /** `'meta'` or the confirmed real scope key the original entry's content was written to. */
  distributed_to_scope: string;
  /** ISO 8601 timestamp this distribution completed. */
  distributed_at: string;
}

/**
 * Embeds `metadata` using the SAME comment-marker convention
 * `distillAndRemember.ts`'s `buildProvenanceHeader()` already establishes
 * (see `PROVENANCE_HEADER_MARKER` above) — a separate, small function
 * rather than a reuse of `buildProvenanceHeader()` itself, since that
 * function's own type signature requires `EntryProvenanceMetadata`'s full
 * shape (`chat_source`/`session_id`/... — fields a marker entry genuinely
 * does not have), and forcing placeholder values into those fields would be
 * actively misleading provenance, not a real reuse.
 */
export function buildDistributionMarkerHeader(metadata: DistributionMarkerMetadata): string {
  return `<!-- ${PROVENANCE_HEADER_MARKER}\n${JSON.stringify(metadata)}\n-->`;
}

// ---------------------------------------------------------------------------
// Scope-route confirmation — reading the operator's own explicit,
// per-cluster_id, on-disk confirmation record (research finding 4 above).
// ---------------------------------------------------------------------------

const SCOPE_ROUTE_CONFIRMATION_REASON = 'scope_route_confirmed' as const;

/** A real, operator-authored confirmation record — this module only ever READS this shape, never writes one. */
export interface ScopeRouteConfirmationEntry {
  recordedAt: string;
  confirmation_reason: typeof SCOPE_ROUTE_CONFIRMATION_REASON;
  /** The EXACT cluster_id this confirmation applies to. */
  cluster_id: string;
  /** The EXACT confirmed real scope key (e.g. `'arizona'`) — must match the candidate's own `scope_key` exactly (defense in depth, see module doc comment). */
  scope_key: string;
}

function isScopeRouteConfirmationEntry(value: unknown): value is ScopeRouteConfirmationEntry {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    obj.confirmation_reason === SCOPE_ROUTE_CONFIRMATION_REASON &&
    typeof obj.cluster_id === 'string' &&
    obj.cluster_id.length > 0 &&
    typeof obj.scope_key === 'string' &&
    obj.scope_key.length > 0
  );
}

/** Joins a (cluster_id, scope_key) pair into one lookup key — `\0` can never legitimately appear in either real-world field, so this never collides. */
function confirmationKey(clusterId: string, scopeKey: string): string {
  return `${clusterId} ${scopeKey}`;
}

/**
 * Reads confirmed `(cluster_id, scope_key)` pairs from the SAME on-disk
 * human-review queue `cm-01`/`cm-05`/`cm-07` already append to
 * (`DEFAULT_TRIAGE_QUEUE_PATH` by default). Mirrors `ro-04`'s own "missing
 * file is not an error, returns empty" contract exactly: a queue file that
 * does not exist yet (e.g. before any operator has ever confirmed anything)
 * returns an empty set, never throws. Malformed lines are skipped
 * defensively (mirrors this epic's own "individually-odd input tolerated,
 * whole input never rejected" convention, e.g.
 * `parseExtractionResponse()`'s per-element filtering) — never causes the
 * whole read, or this story's whole run, to fail.
 */
export function readScopeRouteConfirmations(queuePath: string = DEFAULT_TRIAGE_QUEUE_PATH): Set<string> {
  let raw: string;
  try {
    raw = readFileSync(queuePath, 'utf8');
  } catch {
    return new Set();
  }

  const confirmed = new Set<string>();
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (isScopeRouteConfirmationEntry(parsed)) {
      confirmed.add(confirmationKey(parsed.cluster_id, parsed.scope_key));
    }
  }
  return confirmed;
}

/**
 * Resolves ONE intake entry's real destination — the ONLY function in this
 * file that ever produces a non-`'meta'` scope value (module doc comment's
 * "highest-stakes checkpoint" section). Unconditionally `'meta'` unless a
 * real candidate exists AND a real, on-disk confirmation names BOTH this
 * entry's exact `cluster_id` AND the candidate's exact `scope_key`.
 */
export function resolveDestinationScope(
  metadata: EntryProvenanceMetadata,
  confirmed: Set<string>,
): { scope: Scope; scopeKey: string | null } {
  const candidate = metadata.resolved_scope_candidate;
  if (
    candidate !== null &&
    metadata.cluster_id !== null &&
    confirmed.has(confirmationKey(metadata.cluster_id, candidate.scope_key))
  ) {
    return { scope: candidate.scope_key as unknown as Scope, scopeKey: candidate.scope_key };
  }
  return { scope: 'meta', scopeKey: null };
}

// ---------------------------------------------------------------------------
// Point parsing — partitions every scrolled point into a candidate (a real
// cm-07 intake entry) or an existing marker, per this story's own AC.
// ---------------------------------------------------------------------------

interface ParsedCandidate {
  pointId: string;
  text: string;
  metadata: EntryProvenanceMetadata;
}

function extractPointText(point: ScrolledPoint): string | null {
  const text = point.payload?.text;
  return typeof text === 'string' ? text : null;
}

/**
 * Partitions `points` into candidates (`metadata.entry_type !=
 * 'distribution_marker'`) and the set of already-marked `entry_id`s (read
 * from every `distribution_marker` point's own `marks_entry_id` field) —
 * this story's own AC, using the SAME imported, UNCHANGED
 * `parseProvenanceHeader()` reader for BOTH kinds of point (see
 * `PROVENANCE_HEADER_MARKER` above for why this is safe: markers are
 * written with the identical comment-marker convention). A point whose text
 * carries no parseable provenance header at all (malformed, or genuinely
 * unrelated to this story's own convention) is defensively skipped, never
 * thrown on.
 */
function partitionPoints(points: ScrolledPoint[]): { candidates: ParsedCandidate[]; markedEntryIds: Set<string> } {
  const candidates: ParsedCandidate[] = [];
  const markedEntryIds = new Set<string>();

  for (const point of points) {
    const text = extractPointText(point);
    if (text === null) {
      continue;
    }
    const parsed = parseProvenanceHeader(text);
    if (parsed === null) {
      continue;
    }
    if ((parsed as unknown as { entry_type: string }).entry_type === 'distribution_marker') {
      const marker = parsed as unknown as DistributionMarkerMetadata;
      markedEntryIds.add(marker.marks_entry_id);
    } else {
      candidates.push({ pointId: point.id, text, metadata: parsed });
    }
  }

  return { candidates, markedEntryIds };
}

// ---------------------------------------------------------------------------
// distributeIntakeEntries() — the public entry point.
// ---------------------------------------------------------------------------

export interface DistributeIntakeEntriesOptions {
  /** Injectable ingest client — REQUIRED, mirrors `distillAndRemember.ts`'s own `IngestClient` convention (no accidental default production client). Tests MUST supply a fake — never a live Qdrant write. */
  client: IngestClient;
  /** Injectable intake-enumeration primitive — REQUIRED. See `ScrollPointsFn`'s own doc comment. Tests MUST supply a stub — never live Qdrant. */
  scrollPoints: ScrollPointsFn;
  /** Where the operator's own scope-route confirmation records are read from. Default `DEFAULT_TRIAGE_QUEUE_PATH` (the SAME queue file `cm-01`/`cm-05`/`cm-07` already write to). Tests override with a temp-dir path. */
  confirmationQueuePath?: string;
  /** Injectable clock, for deterministic `distributed_at` in marker entries. Default real `() => new Date()`. */
  now?: () => Date;
  /** Injectable marker-id generator, for deterministic tests. Default real `() => randomUUID()`. */
  generateMarkerId?: () => string;
}

export interface DistributedEntryOutcome {
  entryId: string;
  clusterId: string | null;
  /** `'meta'` or the confirmed real scope key this entry's content was written to. */
  destinationScope: string;
  /** `true` only when BOTH the destination write and the marker write succeeded. */
  ok: boolean;
  /** The real, unmodified `IngestDocumentResult` for the destination write. */
  destination: IngestDocumentResult;
  /** The real, unmodified `IngestDocumentResult` for the marker write — absent when the destination write itself failed (the marker write only ever happens after a confirmed-successful destination write, module doc comment). */
  marker?: IngestDocumentResult;
}

export interface SkippedEntryOutcome {
  entryId: string;
  reason: 'already_distributed';
}

export interface DistributeIntakeEntriesResult {
  distributed: DistributedEntryOutcome[];
  skipped: SkippedEntryOutcome[];
}

/**
 * Runs the full intake-distribution pass:
 *
 *  1. `scrollPoints(INTAKE_COLLECTION_NAME)` — the intake collection's OWN
 *     fixed, hardcoded name, never any other collection, never
 *     caller-parameterized (this story's own hard constraint).
 *  2. Partitions every point into candidates and already-marked `entry_id`s
 *     (`partitionPoints()` above).
 *  3. Reads the operator's own real, on-disk scope-route confirmations
 *     (`readScopeRouteConfirmations()` above).
 *  4. For each candidate NOT already marked distributed, sequentially
 *     (never parallel — mirrors `ingestDocument()`'s/`distillAndRemember.ts`'s
 *     own "no precedent for concurrent remember() calls" discipline):
 *       a. Resolves the real destination (`resolveDestinationScope()`).
 *       b. Writes the entry's own, UNCHANGED persisted text to that
 *          destination via `ingestDocument()` (same primitive, unchanged).
 *       c. Only on a confirmed-successful destination write, writes a NEW,
 *          additive `distribution_marker` entry back into `intake` via a
 *          SECOND `ingestDocument()` call — the original entry's own point
 *          is never itself touched.
 *
 * A mid-sequence failure never aborts the remaining entries — every
 * candidate is attempted, and the result reports exactly which succeeded/
 * were skipped/failed (mirrors `ingestDocument()`'s/`distillAndRemember.ts`'s
 * own partial-failure reporting discipline).
 */
export async function distributeIntakeEntries(options: DistributeIntakeEntriesOptions): Promise<DistributeIntakeEntriesResult> {
  const { client, scrollPoints } = options;
  const confirmationQueuePath = options.confirmationQueuePath ?? DEFAULT_TRIAGE_QUEUE_PATH;
  const now = options.now ?? (() => new Date());
  const generateMarkerId = options.generateMarkerId ?? (() => randomUUID());

  // scroll_points() called against the intake collection's OWN fixed name
  // ONLY — never any other collection (this story's own hard constraint;
  // there is no code path in this file capable of passing a different name).
  const points = await scrollPoints(INTAKE_COLLECTION_NAME);
  const { candidates, markedEntryIds } = partitionPoints(points);
  const confirmed = readScopeRouteConfirmations(confirmationQueuePath);

  const distributed: DistributedEntryOutcome[] = [];
  const skipped: SkippedEntryOutcome[] = [];

  for (const candidate of candidates) {
    if (markedEntryIds.has(candidate.metadata.entry_id)) {
      skipped.push({ entryId: candidate.metadata.entry_id, reason: 'already_distributed' });
      continue;
    }

    const { scope: destinationScope, scopeKey } = resolveDestinationScope(candidate.metadata, confirmed);
    const resolvedScopeLabel = scopeKey ?? 'meta';

    // Destination write -- the entry's own, UNCHANGED persisted text
    // (header + body, cm-07's own full provenance contract already
    // embedded), via the SAME ingestDocument()/remember() primitive,
    // unchanged.
    const destinationResult = await ingestDocument(client, {
      content: candidate.text,
      tag: candidate.metadata.entry_id,
      scope: destinationScope,
    });

    if (!destinationResult.ok) {
      distributed.push({
        entryId: candidate.metadata.entry_id,
        clusterId: candidate.metadata.cluster_id,
        destinationScope: resolvedScopeLabel,
        ok: false,
        destination: destinationResult,
      });
      // The marker write only ever happens after a CONFIRMED-successful
      // destination write -- never attempted here.
      continue;
    }

    // Marker write -- additive ONLY, a brand-new point in the SAME intake
    // collection. The original candidate's own point is never re-written,
    // mutated, or deleted anywhere in this function.
    const markerMetadata: DistributionMarkerMetadata = {
      entry_id: generateMarkerId(),
      entry_type: 'distribution_marker',
      marks_entry_id: candidate.metadata.entry_id,
      distributed_to_scope: resolvedScopeLabel,
      distributed_at: now().toISOString(),
    };
    const markerResult = await ingestDocument(client, {
      content: buildDistributionMarkerHeader(markerMetadata),
      tag: markerMetadata.entry_id,
      scope: INTAKE_SCOPE,
    });

    distributed.push({
      entryId: candidate.metadata.entry_id,
      clusterId: candidate.metadata.cluster_id,
      destinationScope: resolvedScopeLabel,
      ok: markerResult.ok,
      destination: destinationResult,
      marker: markerResult,
    });
  }

  return { distributed, skipped };
}
