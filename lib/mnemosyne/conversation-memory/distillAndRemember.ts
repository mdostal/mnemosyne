/**
 * cm-07-distillation-and-persist (epic: mnemosyne-conversation-memory).
 *
 * **Round-4 revision (2026-08-26, docs/design-discussion.md §11.2) — this
 * module implements the SIMPLIFIED, single-destination design, superseding
 * any earlier round-3 scope-routing shape.** Every successful distillation
 * writes with `scope: 'intake'` — UNCONDITIONALLY, no exceptions, no
 * branching on `resolvedScopeCandidate` or anything else anywhere in this
 * file. The confirmed-vs-unconfirmed candidate-consumption logic round 3
 * originally designed for this story has MOVED, verbatim in substance, to
 * `cm-13-intake-distribution` (not built here).
 *
 * This is the ONLY module in this epic that calls `ingestDocument()`/
 * `remember()` — every other story (`cm-01`...`cm-06`) produces
 * intermediate, in-memory or locally-cached artifacts, never touching
 * Qdrant.
 *
 * ---------------------------------------------------------------------------
 * Research findings (this story's own research step, real and live, not
 * assumed) — see this repo's `.pHive/epics/mnemosyne-conversation-memory/
 * stories/cm-07-distillation-and-persist.yaml` for the full brief.
 * ---------------------------------------------------------------------------
 *
 * 1. **`intake` scope's real, live behavior, confirmed directly against
 *    `VectorLayerAdapter.ts`/`client.ts` (not assumed from the type system):**
 *    `VectorLayerAdapter.remember()` resolves `scope` -> collection via
 *    `cfg.scopes?.[scope]` (a real `swarm-memory config` shell-out, plain
 *    string-keyed lookup — `VectorLayerAdapter.ts` around line 251). This
 *    story's own live re-read of `~/.config/swarm-memory/config.toml`'s
 *    `[scopes]` table (2026-08-27) confirms neither `meta` NOR `intake`
 *    exists as a key today — a real write with `scope: 'intake'` against the
 *    LIVE stack would currently fail loudly with `unknown_scope` until an
 *    operator adds the key (the exact same unresolved state `meta` itself is
 *    still in). This is a real, live-confirmed finding, not a guess.
 *
 * 2. **Collection-naming recommendation, applied as a documented
 *    recommendation, NOT applied directly to the operator's live
 *    `~/.config/swarm-memory/config.toml`:** per `ways_of_working.md`'s
 *    repo-scoped-autonomy rule, that file lives outside this repo (a
 *    personal-machine config shared across many unrelated swarms/projects),
 *    so this agent does not edit it autonomously. Recommended, for real
 *    operator action before any live `cm-08` pilot run that actually
 *    persists to `intake`:
 *      ```
 *      [scopes]
 *      intake = "conversation_memory_intake"
 *      ```
 *    following the exact same `<domain>_<memory-type>` convention already
 *    live in that table (`clients_arizona_compound_memory`, `personal_memory`,
 *    `work_root_memory`). This does NOT block or affect the automated test
 *    suite below, which uses a fake `IngestClient` exclusively and never
 *    shells out to `swarm-memory` or touches the live config file.
 *
 * 3. **The real, safe `Scope`-type widening mechanism — a LOCAL widening,
 *    confined to this one file, not a change to the shared `interfaces.ts`
 *    contract:** `interfaces.ts`'s `Scope` type (`'project'|'enterprise'|
 *    'meta'`) is a cross-cutting contract many unrelated modules import.
 *    `VectorLayerAdapter.remember()`'s own resolution (`cfg.scopes?.[scope]`,
 *    finding 1 above) treats `scope` as a plain runtime string key — there is
 *    no compile-time enum enforcement anywhere in the real write path, so
 *    widening the TYPE only (not the runtime behavior) is genuinely safe.
 *    `INTAKE_SCOPE` below is the ONE, single, well-documented type assertion
 *    boundary in this file — `'intake' as unknown as Scope` — used at
 *    exactly one call site (the `ingestDocument()` call in the persist loop).
 *    No other file changes; `interfaces.ts` stays byte-for-byte unchanged by
 *    this story.
 *
 * 4. **`dostal-shared-gemini` re-confirmed live, independently, this pass
 *    (not assumed carried over from `cm-05`):** a real `generateContent`
 *    call against `gemini-2.5-flash` via the same `gcloud secrets versions
 *    access`/Portunus resolution path, 2026-08-27 — HTTP 200,
 *    `x-gemini-service-tier: standard` (paid tier, billing enabled), no
 *    explicit RPM/TPM quota header present (matches `geminiClient.ts`'s own
 *    documented "handles rate limiting reactively off real 429s" design).
 *    The key value was never printed to any tool output or log.
 *
 * ---------------------------------------------------------------------------
 * The real `Content.metadata` gap this module's design deliberately works
 * around (a genuine finding, not hand-waved).
 * ---------------------------------------------------------------------------
 * `ingestDocument()`'s public `IngestDocumentOptions` is `{content, filename?,
 * tag?, scope?}` — there is no hook for a caller to attach arbitrary
 * structured metadata (e.g. `chat_source`/`session_id`/`cluster_id`/
 * `entry_id`) onto the `Content.metadata` object it builds internally
 * (`buildTextChunkSpecs()` only ever sets `{filename, chunk_index,
 * chunk_count, tag}`). Reading further up the real write chain confirms this
 * is not merely `ingestDocument()`'s own limitation: `MnemosyneClient.
 * remember()` (`client.ts:447`) discards `content.metadata` entirely when
 * calling the adapter (`targetAdapter.remember(content.text, {scope})` —
 * only `content.text` and `scope` cross that boundary), and
 * `VectorLayerAdapter.remember()` persists a plain Markdown note file whose
 * only structured metadata is its own generated header comment
 * (scope/status/branch/commit). **Given this story's hard constraint that
 * `ingestDocument()` is called completely UNCHANGED, the only way the full
 * provenance contract actually survives to the persisted content is the
 * SAME convention `VectorLayerAdapter.remember()` itself already
 * establishes: embed structured metadata directly in the persisted TEXT**
 * (see `buildProvenanceHeader()`/`parseProvenanceHeader()` below) — extended
 * here, not invented fresh. `entry_id` additionally rides through
 * `ingestDocument()`'s one real caller-supplied-identifier channel (`tag`),
 * so it is reachable both structurally (via `Content.metadata.tag`, the one
 * channel that DOES survive to `client.remember()`) and via the embedded
 * header. Every `DistilledEntryOutcome` returned by `distillAndRemember()`
 * ALSO carries the same metadata as a first-class, directly-inspectable
 * object (`entries[i].metadata`) — not constrained by `ingestDocument()`'s
 * internal shape at all, since it is this module's own return value — which
 * is what this story's own tests assert against directly.
 *
 * ---------------------------------------------------------------------------
 * Bounded distillation (design-discussion.md §2.1/§2.7).
 * ---------------------------------------------------------------------------
 * Per session: exactly ONE summary entry (`cm-05`'s own triage summary,
 * carried forward verbatim), plus up to `MAX_DECISION_ENTRIES` decision/fact
 * entries and up to `MAX_OPEN_QUESTION_ENTRIES` open-question entries — a
 * small, NAMED maximum (`MAX_TOTAL_ENTRIES_PER_SESSION` below), never one
 * entry per raw 4KB chunk of the original transcript (which would produce
 * ~12,500 entries for a 50MB session under `ingestDocument()`'s own
 * `CHUNK_SIZE_BYTES = 4_000` — explicitly rejected, §2.7). Each entry's own
 * persisted text is additionally byte-bounded
 * (`MAX_ENTRY_FINAL_TEXT_BYTES`, well under `CHUNK_SIZE_BYTES`) so every
 * entry produces exactly ONE `ingestDocument()` chunk, keeping the
 * "one scan immediately before one remember() call" invariant simple and
 * airtight per entry (see the persist loop below and this module's own
 * test file for a direct, real-constant-derived proof).
 *
 * The decision/open-question extraction itself is ONE bounded call to
 * `cm-05`'s own shared `geminiClient.ts` primitive (imported UNCHANGED),
 * deliberately SEPARATE from `cm-05`'s own triage call (design-
 * discussion.md §9.6) — this call only ever runs for the strict subset of
 * sessions that already passed triage as `keep`/`uncertain`, never for a
 * `trash`-verdict session (defensively short-circuited below, mirroring
 * `clusterConversations.ts`'s own defensive trash-verdict filter).
 *
 * ---------------------------------------------------------------------------
 * The persist-time secret-scan checkpoint (design-discussion.md §2.8) — the
 * epic's single highest-scrutiny requirement.
 * ---------------------------------------------------------------------------
 * `cm-01`'s real, unmodified `scanForSecrets()` is called on each entry's
 * OWN final distilled text, IMMEDIATELY before that entry's own
 * `ingestDocument()` call — never batched, never run once upfront for the
 * whole session, never skipped for any entry type (summary/decision/
 * open-question are all scanned identically). A match quarantines THAT
 * SPECIFIC entry (appended to the same on-disk human-review queue
 * `cm-05`'s own triage pipeline already establishes, `DEFAULT_TRIAGE_
 * QUEUE_PATH`, tagged `quarantine_reason: 'secret_detected'` — mirrors
 * design-discussion.md §2.8/§10.2 point 2's "same queue file, same
 * non-automatic posture" convention) and the run CONTINUES with the
 * remaining entries — never a full-run abort.
 */

import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Scope } from '../interfaces.js';
import { ingestDocument, type IngestClient, type IngestDocumentResult } from '../ingest/ingestDocument.js';
import type { ResolvedScopeCandidate } from './clusterConversations.js';
import { DEFAULT_GEMINI_MODEL, callGemini, type CallGeminiOptions } from './geminiClient.js';
import { scanForSecrets, type SecretMatch } from './scanForSecrets.js';
import { DEFAULT_TRIAGE_QUEUE_PATH, type TriageVerdict } from './triageSession.js';
import type { ConversationSourceType, ConversationTurn } from './types.js';

// ---------------------------------------------------------------------------
// Named constants — every one a real, load-bearing value a test can assert
// against, never a scattered magic number (this epic's own established
// convention).
// ---------------------------------------------------------------------------

/** Bounded-input discipline for this story's own extraction call — same numeric value/rationale as cm-05's own `MAX_TRIAGE_INPUT_CHARS` (a small fraction of gemini-2.5-flash's real 1,048,576-token ceiling), independently named here since this is a genuinely separate call (design-discussion.md §9.6). */
export const MAX_EXTRACTION_INPUT_CHARS = 12_000;

/** Hard cap on decision/fact entries produced per session. */
export const MAX_DECISION_ENTRIES = 5;

/** Hard cap on open-question entries produced per session. */
export const MAX_OPEN_QUESTION_ENTRIES = 3;

/** `MAX_DECISION_ENTRIES + MAX_OPEN_QUESTION_ENTRIES` + exactly 1 summary entry — the real, named ceiling on entries-per-session this story's AC1 requires, directly comparable to `cm-09`'s own `conversation_memory.persisted_entries_per_session` metric (target: 10). */
export const MAX_TOTAL_ENTRIES_PER_SESSION = MAX_DECISION_ENTRIES + MAX_OPEN_QUESTION_ENTRIES + 1;

/** Per-entry BODY text byte ceiling (UTF-8), before the provenance header is prepended. */
export const MAX_ENTRY_BODY_BYTES = 1_500;

/** Per-field byte ceiling for variable-length fields embedded in the provenance header (`project_slug`, `session_id`, and `resolved_scope_candidate`'s own string fields) — bounds the header's own worst-case size regardless of how long a real project path or scope key happens to be. */
const MAX_HEADER_FIELD_BYTES = 200;

/**
 * Hard ceiling on the FULL persisted text (header + body) for a single
 * entry — deliberately well under `ingestDocument()`'s own real, imported
 * `CHUNK_SIZE_BYTES` (4,000, confirmed by reading `ingestDocument.ts`
 * directly, not assumed), so every entry produces exactly ONE
 * `ingestDocument()` chunk and therefore exactly one `remember()` call,
 * immediately preceded by exactly one `scanForSecrets()` call — see the
 * module doc comment and this file's own test suite for a direct proof
 * against the real imported constant.
 */
export const MAX_ENTRY_FINAL_TEXT_BYTES = 3_500;

const PROVENANCE_HEADER_MARKER = 'mnemosyne-intake-provenance';

/**
 * The ONE, single, well-documented local type-widening assertion boundary
 * in this file (this story's own research step finding #3 above) — never
 * scattered, never used anywhere except this single constant. `interfaces.
 * ts`'s `Scope` type stays byte-for-byte unchanged by this story; this is a
 * compile-time-only widening, safe because the real write path
 * (`VectorLayerAdapter.remember()`, confirmed live this story's research
 * step) treats `scope` as a plain runtime string key, never a compile-time
 * enum check.
 */
const INTAKE_SCOPE = 'intake' as unknown as Scope;

// ---------------------------------------------------------------------------
// Extraction — decision/fact + open-question extraction (cm-05's shared
// geminiClient.ts, imported UNCHANGED, called via a SEPARATE, own bounded
// call — design-discussion.md §9.6).
// ---------------------------------------------------------------------------

const EXTRACTION_INSTRUCTIONS = `You are extracting durable decisions/facts and open/unresolved questions from a real developer/assistant conversation session, for long-term memory storage.
Respond with EXACTLY one JSON object and nothing else, matching this shape:
{"decisions": ["<concrete, durable claim or decision established in this session>", ...], "openQuestions": ["<unresolved thread, explicitly open, never presented as settled fact>", ...]}
Both arrays may be empty when nothing durable was established -- never invent a decision or question not actually present in the transcript below.

Transcript excerpt (role-tagged turns, oldest first; some turns may have been withheld or truncated for length/safety):
`;

/**
 * Builds the bounded extraction prompt: fixed instructions plus a
 * role-tagged transcript excerpt built ONLY from non-quarantined turns
 * (mirrors `triageSession.ts`'s `buildTriagePrompt()` exactly — a quarantined
 * turn's real text never contributes a single character, at any offset),
 * truncated so the full returned string never exceeds `maxChars`. A separate
 * implementation from `buildTriagePrompt()` (this story's own extraction
 * call is deliberately separate from cm-05's triage call, design-discussion
 * §9.6) rather than a shared/imported helper — this epic's own established
 * convention is one bounded-prompt builder per call site, not a shared
 * generic-prompt-builder module no story has ever asked for.
 */
export function buildExtractionPrompt(turns: ConversationTurn[], maxChars: number): string {
  const nonQuarantined = turns.filter((turn) => !turn.quarantined);
  const budgetForTranscript = Math.max(0, maxChars - EXTRACTION_INSTRUCTIONS.length);

  const lines: string[] = [];
  let usedChars = 0;
  for (const turn of nonQuarantined) {
    const line = `[${turn.role}] ${turn.text}`;
    const separator = lines.length > 0 ? 1 : 0;
    if (usedChars + separator + line.length > budgetForTranscript) {
      const remaining = budgetForTranscript - usedChars - separator;
      if (remaining > 0) {
        lines.push(line.slice(0, remaining));
      }
      break;
    }
    lines.push(line);
    usedChars += separator + line.length;
  }

  const prompt = EXTRACTION_INSTRUCTIONS + lines.join('\n');
  return prompt.length > maxChars ? prompt.slice(0, maxChars) : prompt;
}

export interface ExtractionResult {
  decisions: string[];
  openQuestions: string[];
}

/** Raised when the extraction LLM response does not parse to a real, valid `{decisions, openQuestions}` shape -- always fails loudly, never silently guesses/defaults (mirrors triageSession.ts's TriageError convention, and geminiClient.ts's own loud-failure discipline). */
export class DistillationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DistillationError';
  }
}

function safePreview(value: unknown): string {
  try {
    return JSON.stringify(value)?.slice(0, 300) ?? String(value);
  } catch {
    return String(value);
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validates and narrows the raw extraction LLM response. Both `decisions`
 * and `openQuestions` must be present and be arrays (an empty array is a
 * legitimate, valid outcome — a session may establish nothing durable);
 * a missing key or a non-array value fails loudly. Individual non-string/
 * empty array elements are defensively filtered out, never causing the
 * whole response to be rejected (mirrors `scanForSecrets.ts`'s own
 * dedupe-don't-reject tolerance for individually-odd matches).
 */
export function parseExtractionResponse(raw: unknown): ExtractionResult {
  if (!raw || typeof raw !== 'object') {
    throw new DistillationError(
      `Extraction LLM response was not a JSON object -- real value received: ${safePreview(raw)}. Failing loudly, never guessing decisions/open-questions.`,
    );
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.decisions) || !Array.isArray(obj.openQuestions)) {
    throw new DistillationError(
      `Extraction LLM response's 'decisions'/'openQuestions' fields were not both arrays -- real value received: ${safePreview(raw)}. Never guessed/defaulted; failing loudly.`,
    );
  }
  return {
    decisions: obj.decisions.filter(isNonEmptyString),
    openQuestions: obj.openQuestions.filter(isNonEmptyString),
  };
}

/** Minimal structural shape for testing (mirrors `TriageLlmClient`/`IngestClient`'s own convention). */
export interface ExtractionLlmClient {
  /** Returns the raw, `JSON.parse`d extraction response (validated by `parseExtractionResponse()`), never a pre-validated shape. */
  extract(prompt: string): Promise<unknown>;
}

/** Real, production `ExtractionLlmClient`, backed by `cm-05`'s shared `geminiClient.ts` primitive, imported UNCHANGED. Never used by `distillAndRemember.test.ts` directly with live credentials -- every test either overrides `llmClient` with a stub or injects `fetchImpl`/`resolveApiKey` overrides here to exercise the real wiring offline. */
export function createDefaultExtractionLlmClient(overrides: Partial<CallGeminiOptions> = {}): ExtractionLlmClient {
  return {
    async extract(prompt: string): Promise<unknown> {
      const result = await callGemini({
        prompt,
        maxInputChars: MAX_EXTRACTION_INPUT_CHARS,
        model: DEFAULT_GEMINI_MODEL,
        ...overrides,
      });
      return result.raw;
    },
  };
}

// ---------------------------------------------------------------------------
// Provenance header — embedded in the persisted text itself (see module doc
// comment's "real Content.metadata gap" section for why).
// ---------------------------------------------------------------------------

export type EntryType = 'decision' | 'open_question' | 'summary';

export interface EntryProvenanceMetadata {
  /** UUID, generated at persist time -- distinct from `content_hash` (cm-13's own future per-entry reference, round 4 §11.2). */
  entry_id: string;
  entry_type: EntryType;
  /** Always `'external_conversation'` -- fixed, never derived. */
  source: 'external_conversation';
  chat_source: ConversationSourceType;
  session_id: string;
  project_slug: string | null;
  /** `null` for a session cm-06 did not cluster -- never omitted. */
  cluster_id: string | null;
  /**
   * `cm-06`'s own read-only output, carried forward as INERT pass-through
   * metadata only (round 4, §11.2) -- this module never reads or branches on
   * this field's value anywhere in its own logic. See
   * `distillAndRemember.test.ts`'s dedicated "inert pass-through" test.
   */
  resolved_scope_candidate: ResolvedScopeCandidate | null;
}

function clipUtf8Bytes(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) {
    return text;
  }
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) {
    end--;
  }
  const decoder = new TextDecoder('utf-8');
  return decoder.decode(bytes.slice(0, end));
}

/** Defensively clips the variable-length fields of `metadata` for EMBEDDING in the persisted text header only -- the `metadata` object this module returns to its own caller (`DistilledEntryOutcome.metadata`) always carries the full, unclipped values. */
function clipMetadataForHeader(metadata: EntryProvenanceMetadata): EntryProvenanceMetadata {
  return {
    ...metadata,
    session_id: clipUtf8Bytes(metadata.session_id, MAX_HEADER_FIELD_BYTES),
    project_slug: metadata.project_slug === null ? null : clipUtf8Bytes(metadata.project_slug, MAX_HEADER_FIELD_BYTES),
    resolved_scope_candidate:
      metadata.resolved_scope_candidate === null
        ? null
        : {
            ...metadata.resolved_scope_candidate,
            scope_key: clipUtf8Bytes(metadata.resolved_scope_candidate.scope_key, MAX_HEADER_FIELD_BYTES),
            collection: clipUtf8Bytes(metadata.resolved_scope_candidate.collection, MAX_HEADER_FIELD_BYTES),
          },
  };
}

/**
 * Embeds `metadata` as a deterministic, machine-parseable JSON block inside
 * an HTML comment -- extends `VectorLayerAdapter.remember()`'s own existing
 * "metadata as an embedded text header" convention (its own scope/status/
 * branch/commit comment header) to this story's own, richer provenance
 * contract.
 */
export function buildProvenanceHeader(metadata: EntryProvenanceMetadata): string {
  return `<!-- ${PROVENANCE_HEADER_MARKER}\n${JSON.stringify(clipMetadataForHeader(metadata))}\n-->`;
}

/** Round-trip counterpart to `buildProvenanceHeader()` -- `null` when `text` carries no (or a malformed) provenance header, never throws. */
export function parseProvenanceHeader(text: string): EntryProvenanceMetadata | null {
  const marker = PROVENANCE_HEADER_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<!-- ${marker}\\n([\\s\\S]*?)\\n-->`);
  const match = re.exec(text);
  if (!match) {
    return null;
  }
  try {
    return JSON.parse(match[1]!) as EntryProvenanceMetadata;
  } catch {
    return null;
  }
}

/**
 * Builds the FINAL persisted text: `header + blank line + body`, where
 * `body` is clipped so the WHOLE result never exceeds
 * `MAX_ENTRY_FINAL_TEXT_BYTES` -- the header itself is never truncated (its
 * own fields are already individually bounded by `clipMetadataForHeader()`),
 * only the body ever absorbs the remaining budget. This is the exact text
 * `scanForSecrets()` scans and `ingestDocument()` persists -- see the
 * persist loop below.
 */
function buildFinalText(header: string, body: string): string {
  const separator = '\n\n';
  const headerBytes = Buffer.byteLength(header, 'utf8') + Buffer.byteLength(separator, 'utf8');
  const bodyBudget = Math.max(0, Math.min(MAX_ENTRY_BODY_BYTES, MAX_ENTRY_FINAL_TEXT_BYTES - headerBytes));
  const clippedBody = clipUtf8Bytes(body, bodyBudget);
  return header + separator + clippedBody;
}

// ---------------------------------------------------------------------------
// Quarantine — persist-time secret-scan matches, appended into the SAME
// on-disk human-review queue cm-05's own triage pipeline already
// establishes (design-discussion.md §2.8/§10.2 point 2), tagged distinctly.
// ---------------------------------------------------------------------------

export interface IntakeQuarantineQueueEntry {
  recordedAt: string;
  quarantine_reason: 'secret_detected';
  entry_id: string;
  entry_type: EntryType;
  session_id: string;
  chat_source: ConversationSourceType;
  project_slug: string | null;
  cluster_id: string | null;
  /** cm-01's own real match objects -- already redaction-safe by `scanForSecrets()`'s own contract (never a raw secret value). */
  secretMatches: SecretMatch[];
}

/** Real, OS-level `fs.appendFileSync` -- never a read-the-whole-file-then-rewrite (mirrors `triageSession.ts`'s own `appendQueueEntry()` exactly). */
function appendIntakeQuarantineEntry(entry: IntakeQuarantineQueueEntry, queuePath: string): void {
  mkdirSync(path.dirname(queuePath), { recursive: true });
  appendFileSync(queuePath, JSON.stringify(entry) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// distillAndRemember() -- the public entry point.
// ---------------------------------------------------------------------------

export interface DistillAndRememberOptions {
  sessionId: string;
  chatSource: ConversationSourceType;
  /** The session's turns, already parsed (cm-03/cm-04) and quarantine-flagged (cm-01, checkpoint 1 of 2). */
  turns: ConversationTurn[];
  /** cm-05's own triage verdict for this session -- a `trash` verdict short-circuits this function defensively (see module doc comment). */
  verdict: TriageVerdict;
  /** cm-05's own triage summary text, carried forward verbatim as the ONE session-summary entry's body. */
  summary: string;
  projectSlug: string | null;
  /** `null` for a session cm-06 did not cluster. */
  clusterId: string | null;
  /** cm-06's own read-only output -- carried as INERT pass-through metadata only, never read/branched on here (round 4, §11.2). */
  resolvedScopeCandidate: ResolvedScopeCandidate | null;
  /** Injectable ingest client -- REQUIRED (mirrors `ingestDocument()`'s own convention: no accidental default production client this module could construct on a caller's behalf). Tests MUST supply a fake -- never a live Qdrant write (this story's own hard constraint). */
  client: IngestClient;
  /** Injectable extraction LLM client. Default: the real `geminiClient.ts`-backed client (`createDefaultExtractionLlmClient()`). Tests MUST supply a stub or inject `fetchImpl`/`resolveApiKey` overrides via `createDefaultExtractionLlmClient()` itself -- see `distillAndRemember.test.ts`. */
  llmClient?: ExtractionLlmClient;
  /** Where a persist-time secret-scan quarantine is appended. Default `DEFAULT_TRIAGE_QUEUE_PATH` (the SAME queue file cm-05's own triage pipeline writes to). Tests override with a temp-dir path. */
  quarantineQueuePath?: string;
  /** Injectable clock, for deterministic `recordedAt` in quarantine entries. Default real `() => new Date()`. */
  now?: () => Date;
  /** Injectable entry-id generator, for deterministic tests. Default real `() => randomUUID()`. */
  generateEntryId?: () => string;
}

export interface DistilledEntryOutcome {
  /** The full provenance-metadata contract for this entry -- UNCLIPPED, directly inspectable (see module doc comment's "real Content.metadata gap" section for why this is this module's own first-class return value, not merely `Content.metadata`). */
  metadata: EntryProvenanceMetadata;
  /** The entry's own distilled body text (post byte-clip, pre-header-wrap). */
  bodyText: string;
  /** `true` when a persist-time secret-scan match quarantined this entry -- `remember()`/`ingestDocument()` was NEVER called for a quarantined entry. */
  quarantined: boolean;
  /** cm-01's own real match objects, `[]` when `quarantined` is `false`. */
  secretMatches: SecretMatch[];
  /** `true` only when this entry was both un-quarantined AND its `ingestDocument()` call succeeded. */
  ok: boolean;
  /** The real, unmodified `IngestDocumentResult` for this entry's persist attempt -- absent (never attempted) when `quarantined` is `true`. */
  ingest?: IngestDocumentResult;
}

export interface DistillAndRememberResult {
  sessionId: string;
  verdict: TriageVerdict;
  /** `true` for a trash-verdict session -- the defensive short-circuit fired; `entries` is always `[]` in that case, and neither the extraction LLM call nor any `ingestDocument()` call was ever made. */
  skipped: boolean;
  entries: DistilledEntryOutcome[];
}

/**
 * Runs the full per-session distillation-and-persist pipeline:
 *
 *  1. Defensive trash-verdict short-circuit (never trusts the caller alone
 *     to have already filtered -- mirrors `clusterConversations.ts`'s own
 *     defensive filter for the exact same reason).
 *  2. ONE bounded call to the shared `geminiClient.ts` primitive (via
 *     `llmClient`), producing `{decisions, openQuestions}`, each bounded to
 *     its own named max count.
 *  3. Builds the bounded entry list: exactly 1 summary + up to
 *     `MAX_DECISION_ENTRIES` decisions + up to `MAX_OPEN_QUESTION_ENTRIES`
 *     open-questions.
 *  4. For EACH entry, sequentially (never parallel -- mirrors
 *     `ingestDocument()`'s own "no precedent for concurrent remember()
 *     calls" discipline): builds the final persisted text (provenance
 *     header + bounded body), scans it with cm-01's real `scanForSecrets()`
 *     IMMEDIATELY before persisting, and either quarantines it (match found
 *     -- appended to the human-review queue, `remember()` never called for
 *     THAT entry, loop continues) or calls `ingestDocument()` UNCHANGED with
 *     `scope: INTAKE_SCOPE` (always `'intake'`, never any other value, for
 *     any entry, ever).
 *
 * A mid-sequence quarantine or persist failure never aborts the remaining
 * entries -- every entry is attempted, and the result reports exactly which
 * succeeded/quarantined/failed (mirrors `ingestDocument()`'s own partial-
 * failure reporting discipline).
 */
export async function distillAndRemember(options: DistillAndRememberOptions): Promise<DistillAndRememberResult> {
  const { sessionId, chatSource, turns, verdict, summary, projectSlug, clusterId, resolvedScopeCandidate, client } = options;
  const llmClient = options.llmClient ?? createDefaultExtractionLlmClient();
  const quarantineQueuePath = options.quarantineQueuePath ?? DEFAULT_TRIAGE_QUEUE_PATH;
  const now = options.now ?? (() => new Date());
  const generateEntryId = options.generateEntryId ?? (() => randomUUID());

  // Defensive short-circuit -- a caller SHOULD never invoke this function
  // for a trash-verdict session (a future orchestrator, cm-11, owns that
  // responsibility), but this function never trusts that alone: the
  // extraction LLM call and every persist call below are structurally
  // unreachable for a trash verdict, verified directly by this file's own
  // test suite (geminiClient.ts's real callGemini is asserted never
  // invoked).
  if (verdict === 'trash') {
    return { sessionId, verdict, skipped: true, entries: [] };
  }

  const extractionPrompt = buildExtractionPrompt(turns, MAX_EXTRACTION_INPUT_CHARS);
  const rawExtraction = await llmClient.extract(extractionPrompt);
  const extraction = parseExtractionResponse(rawExtraction);

  const decisions = extraction.decisions.slice(0, MAX_DECISION_ENTRIES);
  const openQuestions = extraction.openQuestions.slice(0, MAX_OPEN_QUESTION_ENTRIES);

  const specs: Array<{ entryType: EntryType; body: string }> = [
    { entryType: 'summary', body: summary },
    ...decisions.map((body): { entryType: EntryType; body: string } => ({ entryType: 'decision', body })),
    ...openQuestions.map((body): { entryType: EntryType; body: string } => ({ entryType: 'open_question', body })),
  ];

  const entries: DistilledEntryOutcome[] = [];

  for (const spec of specs) {
    const entryId = generateEntryId();
    const metadata: EntryProvenanceMetadata = {
      entry_id: entryId,
      entry_type: spec.entryType,
      source: 'external_conversation',
      chat_source: chatSource,
      session_id: sessionId,
      project_slug: projectSlug,
      cluster_id: clusterId,
      // Inert pass-through ONLY -- never read/branched on anywhere in this
      // function. See distillAndRemember.test.ts's dedicated proof.
      resolved_scope_candidate: resolvedScopeCandidate,
    };

    const header = buildProvenanceHeader(metadata);
    const finalText = buildFinalText(header, spec.body);

    // cm-01's real, unmodified scanForSecrets() -- called IMMEDIATELY
    // BEFORE this entry's own persist call, on the FINAL distilled text
    // (post header-wrap, exactly what would be handed to ingestDocument()
    // next). Never batched across entries, never run once upfront.
    const secretMatches = scanForSecrets(finalText);

    if (secretMatches.length > 0) {
      appendIntakeQuarantineEntry(
        {
          recordedAt: now().toISOString(),
          quarantine_reason: 'secret_detected',
          entry_id: entryId,
          entry_type: spec.entryType,
          session_id: sessionId,
          chat_source: chatSource,
          project_slug: projectSlug,
          cluster_id: clusterId,
          secretMatches,
        },
        quarantineQueuePath,
      );

      entries.push({
        metadata,
        bodyText: spec.body,
        quarantined: true,
        secretMatches,
        ok: false,
      });
      // Never abort the whole run -- continue with the remaining entries.
      continue;
    }

    // ingestDocument() -- the real, UNCHANGED ro-10/ro-13 primitive, the
    // ONE and only persist path. scope is ALWAYS the single INTAKE_SCOPE
    // constant here -- no ternary, no config lookup, no branch of any kind
    // on resolvedScopeCandidate or anything else (round 4, §11.2).
    const ingestResult = await ingestDocument(client, {
      content: finalText,
      tag: entryId,
      scope: INTAKE_SCOPE,
    });

    entries.push({
      metadata,
      bodyText: spec.body,
      quarantined: false,
      secretMatches: [],
      ok: ingestResult.ok,
      ingest: ingestResult,
    });
  }

  return { sessionId, verdict, skipped: false, entries };
}
