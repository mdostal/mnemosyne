/**
 * Mnemosyne core API contracts — recall/remember interface definitions.
 *
 * This module is CONTRACTS ONLY: type/interface declarations, no runtime
 * logic. Subsequent stories (m-02..m-07) implement the layers and the
 * escalation/routing logic these types describe. Do not add executable code
 * here — see `schema.ts` for the runtime-validatable JSON Schema counterpart
 * of the wire-facing types (`Provenance`, `RecallResult`, `RememberResult`),
 * and see `flight-status.ts` for the runtime logic (transition validation,
 * git-context auto-detection) behind `Status`/`SourceRef` below.
 *
 * Story: m-01-core-recall-interface (epic: mnemosyne-foundation)
 * Updated: la-04-flight-status-schema (epic: mnemosyne-layer-architecture-v2)
 * adds `Status`/`SourceRef` and extends `RememberSuccess` with them.
 */

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

/**
 * The layers of the Mnemosyne memory stack. `meta`/`enterprise`/`project`
 * were reserved by this file's original contract but have no live adapter
 * yet (see the 2026-08-13 layer-inventory audit — src/layers/{meta,
 * enterprise,project}.mjs exist on the zero-dep JS side but are not wired
 * into any reachable call path). `code-graph`/`vector`/`file` are the three
 * live layers as of m-01..m-07. `hive-memory` (pl-02-hive-memory-layer) is
 * a fourth live, OPTIONAL layer — plugin-hive's own knowledge graph +
 * per-agent/team memory files, read-only, not part of the default stack
 * unless explicitly configured (see layers/config.ts). `graphify`
 * (la-02-graphify-adapter) is a fifth live, OPTIONAL layer: a tree-sitter
 * AST code/doc graph (Graphify-Labs/graphify, PyPI `graphifyy`), registered
 * under a distinct name alongside `code-graph` rather than replacing it
 * (see GraphifyLayerAdapter.ts; la-10 does the later A/B retirement).
 */
export type Layer =
  | 'meta'
  | 'enterprise'
  | 'project'
  | 'code-graph'
  | 'vector'
  | 'file'
  | 'hive-memory'
  | 'graphify';

/**
 * The caller-specified boundary for a recall/remember call. Deliberately a
 * narrower set than `Layer`: `Scope` answers "whose memory?" (project vs.
 * enterprise vs. cross-project meta knowledge) while `Layer` answers "via
 * which backend?" (vector, code-graph, file, ...). A single scope is served
 * by one or more layers internally (routing logic is defined by later
 * stories, notably m-05).
 *
 * "At minimum" project/enterprise/meta per the story's acceptance criteria —
 * additional scope values may be added by later stories without breaking
 * this contract, so callers should not treat this as exhaustively closed
 * when pattern-matching (prefer a `default` / exhaustiveness-check branch).
 */
export type Scope = 'project' | 'enterprise' | 'meta';

/**
 * Escalation hint for `recall()`: whether to prefer a narrow, cheap search
 * first (escalating to broader layers only on a weak/empty result) or to
 * fan out broadly up front. `Intent` is a hint, not a guarantee — the actual
 * escalation policy (thresholds, fallback order) is defined by later stories
 * (see open question #4 in the epic design discussion); this story only
 * defines the shape of the hint.
 */
export type Intent = 'narrow' | 'broad';

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * Identifies the chunk of source content a `Hit` was drawn from.
 *
 * `index` is always known once a source has been chunked at all. `start`/
 * `end` (byte, char, or line offsets — unit is layer-defined and should be
 * documented by each layer's implementation) are only populated once
 * context-expansion has run for that hit; prior to expansion a hit carries
 * only its `index`. This mirrors swarm-memory's `chunk_span` (post-expansion)
 * vs. `chunk_index` (pre-expansion) distinction, collapsed into one shape.
 */
export interface ChunkSpan {
  index: number;
  start?: number;
  end?: number;
}

/**
 * Full provenance for a single recall hit. This is the contract's central
 * "where did this come from" guarantee: ALL seven fields below are always
 * present as keys on every `Provenance` object — never optional, never
 * omitted — even when a layer has no value to report for one. In that case
 * the field is explicitly `null`, so "no embedder" (e.g. the file layer,
 * which has no embedding step) is structurally distinguishable from "field
 * not populated by a buggy implementation" (which TypeScript will reject at
 * compile time since the key is mandatory).
 *
 * This is the cross-cutting "provenance-completeness" concern encoded as a
 * type, not just documentation.
 */
export interface Provenance {
  /** Which of the six stack layers produced this hit. */
  layer: Layer;

  /**
   * Human/machine-readable origin of the content: a file path, an Obsidian
   * note path, a code-graph node id, a Qdrant point id, etc. Always a
   * non-null string — every layer can identify *some* source for a hit, even
   * if it's synthetic (e.g. a graph node id).
   */
  source: string;

  /** See `ChunkSpan`. Null when the layer has no sub-document chunking concept. */
  chunk_span: ChunkSpan | null;

  /**
   * ISO 8601 timestamp of when this content was indexed. Null for layers
   * that serve content directly without a separate indexing step (e.g. the
   * file layer's live grep has no index to timestamp).
   */
  index_timestamp: string | null;

  /**
   * Content hash (e.g. sha256) of the chunk/document at index time, used to
   * detect staleness between index and retrieval. Null where a layer does
   * not content-address its data.
   */
  content_hash: string | null;

  /**
   * Identifier of the embedding model used to index this content (e.g.
   * `"text-embedding-3-small"`). Null for non-embedding layers (file,
   * code-graph structural edges). Deliberately does NOT distinguish
   * index-time vs. query-time embedder the way swarm-memory's
   * `embed_model`/`embed_model_query` pair does — Mnemosyne assumes a single
   * embedder per layer; a query/index mismatch is a layer-internal error
   * condition, not part of this cross-layer contract.
   */
  embedder: string | null;

  /**
   * ISO 8601 timestamp of when this hit was retrieved (i.e. when the search
   * ran), as opposed to when it was indexed. Null for retrieval paths that
   * don't have a meaningful "search moment" separate from index time (e.g. a
   * plain keyword/grep fallback returns matches as it scans, with no ranked
   * retrieval step to timestamp) — mirrors swarm-memory's `retrieved_at`
   * being set only by semantic search, never by the keyword fallback.
   */
  retrieval_time: string | null;
}

// ---------------------------------------------------------------------------
// Recall
// ---------------------------------------------------------------------------

/** A single recalled piece of content plus its full provenance. */
export interface Hit {
  /** The recalled content itself (chunk text, note excerpt, graph node summary, ...). */
  content: string;

  /** Full provenance — see `Provenance`. Always present, never optional. */
  provenance: Provenance;

  /**
   * Layer-defined relevance/similarity score, if the layer that produced
   * this hit ranks results (e.g. vector cosine similarity). Absent (not
   * `null`) for layers with no ranking concept, such as a structural
   * code-graph traversal or an unranked grep match — there is no
   * "loud failure" concern here since this is metadata about the hit, not
   * part of the provenance completeness contract.
   */
  score?: number;
}

/** Records that a layer was skipped or degraded during a recall, and why. */
export interface LayerSkip {
  layer: Layer;
  /** Machine-readable reason code, e.g. `"unreachable"`, `"not_configured"`, `"timeout"`. */
  reason: string;
  /** Human-readable detail for logs/telemetry. */
  detail?: string;
}

/**
 * A recall that ran to completion. Note well: a `RecallSuccess` with an
 * empty `hits` array is a completely valid, expected outcome ("we searched
 * and found nothing") and must NOT be confused with `RecallFailure` ("the
 * search itself could not be performed"). This mirrors swarm-memory keeping
 * `ScopeResult.error` as a field distinct from an empty `hits` array — here
 * that distinction is promoted to the type level via the discriminated
 * union `RecallResult`, so "legitimate zero hits" and "recall failed" are
 * structurally different shapes, not just different field values.
 */
export interface RecallSuccess {
  ok: true;
  query: string;
  scope: Scope;
  intent: Intent;
  hits: Hit[];

  /** Layers actually queried to produce this result (loud-failure: always populated, even on 0 hits). */
  layers_queried: Layer[];

  /** Layers that were skipped/degraded, with reasons — never silently dropped. */
  layers_skipped: LayerSkip[];

  /**
   * True if the narrow→broad (or broad-first) escalation policy caused this
   * call to query more layers than the minimum implied by `intent` alone
   * (e.g. narrow intent found nothing and broadened). Escalation *policy* is
   * out of scope for this story; this field only records *whether* it fired.
   */
  escalated: boolean;

  /**
   * True if any layer in `layers_queried` operated in a degraded mode (e.g.
   * keyword fallback instead of semantic search) — the loud-failure signal
   * that lets a caller know "you got an answer, but memory was not fully
   * healthy," distinct from `layers_skipped` (layers not queried at all).
   */
  degraded: boolean;
}

/** Structured error for a recall that could not be completed. */
export interface RecallError {
  /** The layer that raised the error, or `null` if the failure predates layer dispatch (e.g. invalid scope). */
  layer: Layer | null;
  message: string;
  /** Machine-readable error code for programmatic handling, e.g. `"qdrant_unreachable"`, `"embedder_error"`. */
  code?: string;
}

/**
 * A recall that failed outright — the search could not be performed, as
 * opposed to being performed and finding nothing. See `RecallSuccess` for
 * why this is a structurally separate shape rather than an `error` field
 * alongside `hits`.
 */
export interface RecallFailure {
  ok: false;
  query: string;
  scope: Scope;
  intent: Intent;
  error: RecallError;
}

/**
 * Result of `recall()`. Discriminated on `ok` so "zero hits" (ok: true,
 * hits: []) and "recall failed" (ok: false, error: {...}) can never be
 * conflated — the loud-failure contract made structural, not conventional.
 */
export type RecallResult = RecallSuccess | RecallFailure;

// ---------------------------------------------------------------------------
// Flight status (la-04-flight-status-schema)
// ---------------------------------------------------------------------------

/**
 * Lifecycle status of a memory write, tied to the branch/PR state it was
 * written under — NOT to be confused with `hooks/post-remember.mjs`'s
 * unrelated free-text workflow-status label (`in-progress`/`reviewed`/
 * `full-send`, embedded as literal text in a note body); this is a
 * structured, validated field with its own transition rules (see
 * `flight-status.ts`'s `assertValidStatusTransition`).
 *
 * - `provisional` — written on a non-default branch; true FOR THAT BRANCH
 *   only until it merges. The default for any write whose git context
 *   resolves to a non-default branch.
 * - `confirmed` — promoted from `provisional` (merge to the default
 *   branch), or the default for a write made directly on the default
 *   branch.
 * - `superseded` — a `provisional` entry whose branch/PR did not land (e.g.
 *   closed without merging). Never deleted — stays queryable directly as
 *   "we tried this, it didn't land"; only excluded from *default* recall
 *   filtering (la-05, not implemented by this contract).
 *
 * Valid transitions are exactly `provisional -> confirmed` and
 * `provisional -> superseded` — see `flight-status.ts`. The trigger
 * mechanism that flips status on real lifecycle events (merge, PR close) is
 * la-06; this type only fixes the schema.
 */
export type Status = 'provisional' | 'confirmed' | 'superseded';

/**
 * Provenance of the branch/commit/PR a memory write happened under.
 * Auto-detected from real cwd git state when not passed explicitly by the
 * caller (see `flight-status.ts`'s `detectGitContext`/`autoDetectWriteContext`).
 * Mirrors hive-memory's `source_epic`/`source_agent` provenance columns in
 * spirit (kg.sqlite's `triples` table) — this is the git-flavored
 * equivalent, not a replacement for those fields.
 */
export interface SourceRef {
  /** Branch the write happened on, e.g. `"feat/mnemosyne-layer-architecture-v2"`. */
  branch: string;
  /** Full commit SHA at write time. */
  commit_sha: string;
  /**
   * PR URL associated with this write, when known. `null` when no PR
   * context is available — auto-detection can never populate this from
   * local git state alone (that requires a lifecycle-trigger adapter, la-06),
   * so it is explicitly `null` rather than omitted on an auto-detected
   * `SourceRef`, matching `Provenance`'s "always a key, explicit null over
   * omission" convention.
   */
  pr_url: string | null;
}

// ---------------------------------------------------------------------------
// Remember
// ---------------------------------------------------------------------------

/**
 * Content to be written via `remember()`. Deliberately minimal at this
 * layer: later stories (per-layer implementations) are responsible for
 * turning `text`/`metadata` into whatever a given layer needs (chunking,
 * embedding, graph-node construction, etc.) — this contract only fixes the
 * caller-facing input shape.
 */
export interface Content {
  text: string;
  /** Free-form, layer-agnostic metadata (e.g. title, tags) to carry alongside the write. */
  metadata?: Record<string, unknown>;
}

/**
 * Records a write that nominally succeeded but was not fully healthy — e.g.
 * one of several backing indexes for the target layer could not be updated.
 * Presence of this field does not change `RememberSuccess.ok` (the primary
 * write did succeed — "loud failure" governs whether the *operation*
 * succeeded, not whether every side-effect did); its purpose is to give
 * callers a place to observe and log degradation without forcing every
 * partial hiccup to be modeled as a hard failure.
 */
export interface DegradedWrite {
  reason: string;
  /** Sub-parts of the layer's write path that did not complete, if the layer distinguishes any. */
  failed_parts: string[];
}

/** A `remember()` call that wrote successfully. */
export interface RememberSuccess {
  ok: true;
  /**
   * The layer actually written to. Always present (never optional) even
   * though `layer` is an optional *input* to `remember()` — once a write
   * completes, the resolved target layer is always known, whether it was
   * caller-specified or auto-routed.
   */
  layer: Layer;
  /** Provenance of the freshly written content, as it would be returned by a subsequent `recall()`. */
  provenance: Provenance;
  /** Present only when the write partially degraded; absent on a fully healthy write. See `DegradedWrite`. */
  degraded?: DegradedWrite;
  /**
   * Flight status of this write (la-04-flight-status-schema) — see `Status`.
   * Optional at this cross-layer contract level: not every layer has a
   * branch/commit concept to hang a flight status on (e.g. a hypothetical
   * future recall-only-turned-writable layer with no git-context source).
   * Layers that DO support it (today: `vector`, via `VectorLayerAdapter`)
   * always populate both `status` and `source_ref` together, auto-detected
   * from real git state unless the caller passed them explicitly through
   * `RememberOptions`.
   */
  status?: Status;
  /** See `status` above — always populated together with `status`, never one without the other. */
  source_ref?: SourceRef;
}

/** Structured error for a `remember()` call that did not write. */
export interface RememberError {
  layer: Layer | null;
  message: string;
  code?: string;
}

/**
 * A `remember()` call that failed outright — nothing was written. This is
 * the "loud failure" half of the contract: there is no nullable/optional
 * field a caller could mistakenly ignore. If `ok` is `false`, the write did
 * not happen and `error` explains why.
 */
export interface RememberFailure {
  ok: false;
  error: RememberError;
}

/**
 * Result of `remember()`. Discriminated on `ok`, matching `RecallResult`'s
 * shape for consistency across the API: `ok: true` always carries a
 * resolved `layer` + `provenance`; `ok: false` always carries a structured
 * `error`. No silent nulls are possible in either branch.
 */
export type RememberResult = RememberSuccess | RememberFailure;

// ---------------------------------------------------------------------------
// Core API surface
// ---------------------------------------------------------------------------

/**
 * Recall matching content from memory.
 *
 * `scope` is required on every call — Mnemosyne never guesses which
 * project/enterprise/meta boundary to search. `intent` is optional: omitting
 * it lets the (later-story-defined) escalation policy pick a default
 * narrow/broad strategy.
 */
export type RecallFn = (
  query: string,
  scope: Scope,
  intent?: Intent,
) => RecallResult;

/**
 * Write content to memory.
 *
 * `scope` is required for the same reason as `recall()`. `layer` is
 * optional and, when omitted, is auto-routed based on `scope`/`intent`-like
 * signals — the routing policy itself is defined by a later story (see epic
 * open question #5); this contract only fixes that omission is legal and
 * that the resolved layer is always reported back in `RememberSuccess`.
 */
export type RememberFn = (
  content: Content,
  scope: Scope,
  layer?: Layer,
) => RememberResult;

/**
 * The unified memory client every Pantheon god integrates against. Grouping
 * `recall`/`remember` behind one interface (rather than two free functions)
 * is the shape gods actually consume (`inject a MnemosyneClient`), while
 * `RecallFn`/`RememberFn` remain available standalone for call-site typing,
 * mocking, or partial application.
 *
 * NOTE: both methods are declared here as synchronous return types
 * (`RecallResult`/`RememberResult`, not `Promise<...>`) to match the story's
 * acceptance criteria literally. Real implementations (later stories) will
 * almost certainly be asynchronous (network/disk I/O to Qdrant, Obsidian,
 * the file layer, etc.); implementers should wrap these in `Promise<...>` at
 * that point. This story only fixes the resolved value shapes.
 */
export interface MnemosyneClient {
  recall: RecallFn;
  remember: RememberFn;
}
