/**
 * cm-05-usefulness-trash-triage (epic: mnemosyne-conversation-memory).
 *
 * Hybrid heuristic-prefilter + bounded-LLM-classification triage pipeline
 * (design-discussion.md §2.5, required-coverage #2) — NEVER LLM-only from
 * turn 1. Two stages, exactly as designed:
 *
 *  1. `computeHeuristicScore()` — a PURE, deterministic function over a
 *     session's own `ConversationTurn[]` structural signals (turn count,
 *     real elapsed wall-clock span, tool-to-text ratio, an
 *     `attributionSkill`-EQUIVALENT proxy — see the research note below).
 *     Produces a priority score, NEVER a keep/trash decision by itself.
 *  2. `triageSession()` — ONE bounded LLM call per session (via the shared
 *     `geminiClient.ts` primitive `cm-07` also reuses unchanged), fed
 *     `buildTriagePrompt()`'s own already-bounded, quarantine-excluded
 *     transcript excerpt, returns `{ verdict, summary, rationale }` where
 *     `verdict` is exactly one of `keep` | `trash` | `uncertain`.
 *
 * ---------------------------------------------------------------------------
 * Research note — why `attributionSkill`/`gitBranch` are NOT used here.
 * ---------------------------------------------------------------------------
 * design-discussion.md §2.5 names "presence/absence of an `attributionSkill`
 * (-equivalent) signal" as a candidate heuristic input. Re-reading
 * `types.ts` (the shared, ALREADY-SHIPPED `ConversationTurn` contract
 * `cm-03`/`cm-04` both produce, and which this story must not modify —
 * `cm-04` imports it unchanged, per `types.ts`'s own doc comment) confirms
 * `attributionSkill`/`gitBranch` are raw Claude-Code-JSONL-envelope fields
 * (research-brief.md §1.1) that `parseClaudeCodeSession.ts` deliberately
 * does NOT carry forward into the normalized shape — `ConversationTurn` has
 * no such field, and a ChatGPT-sourced turn (`cm-04`) has no `attribution`
 * concept at all. This story therefore uses a real, EQUIVALENT proxy built
 * purely from fields `ConversationTurn` actually has: a session whose first
 * user turn's text starts with `/` (a slash-command invocation) AND whose
 * total turn count is very small (<= 2) is the concrete, structural shape
 * of design-discussion §2.5's own named example ("a session that only ever
 * ran a one-line slash command and produced no further turns") —
 * `looksLikeSingleSlashCommand` below. This is a genuine research decision,
 * not an assumed one: the literal field named in planning does not exist on
 * the contract this story actually consumes.
 *
 * ---------------------------------------------------------------------------
 * Quarantine exclusion — structural, not merely redacted (this story's own
 * AC7).
 * ---------------------------------------------------------------------------
 * `buildTriagePrompt()` filters OUT every `turn.quarantined === true` turn
 * BEFORE building a single line of prompt text — a quarantined turn's real
 * extracted `text` (which `types.ts` deliberately still carries, for a
 * human reviewer's benefit) never has any of its characters copied into the
 * prompt string, at any offset, in any form. This is verified directly by
 * `triageSession.test.ts`'s quarantine-exclusion tests (a fake but
 * realistic-looking secret string asserted absent from the built prompt).
 *
 * ---------------------------------------------------------------------------
 * No-delete guarantee (this story's own AC6).
 * ---------------------------------------------------------------------------
 * This module performs exactly ONE filesystem write anywhere: appending one
 * JSON line to the on-disk triage queue file (`appendQueueEntry()` below,
 * via `fs.appendFileSync` — a real OS-level append, never a
 * read-whole-file-then-rewrite). It never opens `sourcePath` (a session's
 * real source file) for reading OR writing — `sourcePath` is carried
 * through purely as opaque provenance metadata into the queue entry. There
 * is no delete/unlink/truncate call anywhere in this file, against any
 * path, for any reason.
 *
 * ---------------------------------------------------------------------------
 * The queue file is a COMPLETE triage record (this story's own AC5).
 * ---------------------------------------------------------------------------
 * `triageSession()` appends a queue entry for EVERY verdict, including
 * `keep` — there is no branch anywhere below that skips the append for a
 * `keep` result. `cm-06`'s clustering step needs a real, complete
 * keep+uncertain input set, not merely an exception list (design-
 * discussion.md `[grill 2.1]`).
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { DEFAULT_GEMINI_MODEL, callGemini, type CallGeminiOptions } from './geminiClient.js';
import type { ConversationTurn } from './types.js';

// ---------------------------------------------------------------------------
// Named constants
// ---------------------------------------------------------------------------

/**
 * Hard character-count ceiling on the FULL prompt (fixed instructions +
 * transcript excerpt) handed to `callGemini()` — this story's own AC2. A
 * single named constant, checked in TWO places (defense in depth, never
 * relying on either alone): `buildTriagePrompt()` truncates the transcript
 * excerpt to fit within this bound by construction, and `geminiClient.ts`'s
 * own `callGemini()` independently re-checks `prompt.length` against
 * whatever `maxInputChars` it's given before ever touching the network.
 *
 * ~12,000 chars (~3,000 tokens) is deliberately small relative to
 * `gemini-2.5-flash`'s real 1,048,576-input-token ceiling (confirmed live,
 * this story's own research step) — the bound exists to keep real per-call
 * cost small and knowable across 234+ real sessions (design-discussion.md
 * §2.5/§9.7), not because the model itself couldn't accept more.
 */
export const MAX_TRIAGE_INPUT_CHARS = 12_000;

/** `~/.mnemosyne/conversation-triage-queue.jsonl` -- mirrors `discoverSources.ts`'s `DEFAULT_MANIFEST_PATH` convention (same `~/.mnemosyne/` root), but JSONL rather than a single YAML document specifically so every `triageSession()` call is a real, structural, OS-level APPEND -- never a read-modify-rewrite of prior entries. */
export const DEFAULT_TRIAGE_QUEUE_PATH = path.join(homedir(), '.mnemosyne', 'conversation-triage-queue.jsonl');

// ---------------------------------------------------------------------------
// Heuristic prefilter (stage 1) — pure, deterministic, no I/O.
// ---------------------------------------------------------------------------

/** Excerpt markers `parseClaudeCodeSession.ts`'s own `excerptToolUse()`/`excerptToolResult()` prefix every tool-activity line with -- the real, already-present structural signal this heuristic reads, never a re-derived guess. */
const TOOL_ACTIVITY_MARKERS = ['[tool_use:', '[tool_result]', '[tool_result:error]'];

function isToolActivityTurn(turn: ConversationTurn): boolean {
  return TOOL_ACTIVITY_MARKERS.some((marker) => turn.text.includes(marker));
}

function firstUserTurnIsSlashCommand(turns: ConversationTurn[]): boolean {
  const firstUser = turns.find((turn) => turn.role === 'user');
  return firstUser !== undefined && firstUser.text.trim().startsWith('/');
}

export interface HeuristicSignals {
  /** Real turn count -- `turns.length`, unmodified. */
  turnCount: number;
  /** Real elapsed wall-clock span (ms) from the earliest to the latest parseable `timestamp` among `turns`. `0` when fewer than 2 turns carry a parseable timestamp. */
  elapsedMs: number;
  /** `toolActivityTurns / max(nonToolTurns, 1)` when any non-tool turn exists; `toolActivityTurns` alone (never divide-by-zero) when every turn is tool-activity. */
  toolToTextRatio: number;
  /** The `attributionSkill`-equivalent proxy -- see module doc comment's research note. */
  looksLikeSingleSlashCommand: boolean;
}

export interface HeuristicResult {
  signals: HeuristicSignals;
  /** Deterministic priority score -- orders LLM-classification budget, NEVER itself a keep/trash decision (design-discussion.md §2.5). */
  priorityScore: number;
}

/** Pure function: real structural signals from `turns` alone, no I/O, no randomness. */
export function computeHeuristicSignals(turns: ConversationTurn[]): HeuristicSignals {
  const turnCount = turns.length;

  const timestampsMs = turns
    .map((turn) => turn.timestamp)
    .filter((ts): ts is string => ts !== null)
    .map((ts) => Date.parse(ts))
    .filter((ms) => !Number.isNaN(ms));
  const elapsedMs = timestampsMs.length >= 2 ? Math.max(...timestampsMs) - Math.min(...timestampsMs) : 0;

  const toolActivityTurns = turns.filter(isToolActivityTurn).length;
  const nonToolTurns = turnCount - toolActivityTurns;
  const toolToTextRatio = nonToolTurns > 0 ? toolActivityTurns / nonToolTurns : toolActivityTurns;

  const looksLikeSingleSlashCommand = turnCount > 0 && turnCount <= 2 && firstUserTurnIsSlashCommand(turns);

  return { turnCount, elapsedMs, toolToTextRatio, looksLikeSingleSlashCommand };
}

/**
 * Deterministic priority score from `computeHeuristicSignals()`'s own
 * output -- the SAME `turns` input ALWAYS produces the SAME score (AC1):
 * no `Math.random()`, no `Date.now()`, no I/O anywhere in this function or
 * anything it calls.
 *
 * The exact formula is a real, documented design decision (this story's
 * own research step), not claimed as ML-grade: a single-slash-command
 * session (the strong low-signal candidate design-discussion §2.5 names
 * explicitly) scores `0` outright; otherwise, more turns and a longer real
 * elapsed span raise the score (a session that ran longer and said more is
 * a priori more likely to contain something worth an LLM's classification
 * budget), and a higher tool-to-text ratio lowers it (proportionally more
 * of the session was tool mechanics rather than discussion/decisions).
 * This NEVER decides keep/trash by itself -- it only orders which sessions
 * `triageSession()`'s own LLM stage spends its bounded call on first.
 */
export function computeHeuristicScore(turns: ConversationTurn[]): HeuristicResult {
  const signals = computeHeuristicSignals(turns);

  if (signals.looksLikeSingleSlashCommand) {
    return { signals, priorityScore: 0 };
  }

  const elapsedMinutes = signals.elapsedMs / 60_000;
  const raw = (signals.turnCount * (1 + Math.log1p(elapsedMinutes))) / (1 + signals.toolToTextRatio);
  const priorityScore = Math.round(raw * 100) / 100;

  return { signals, priorityScore };
}

// ---------------------------------------------------------------------------
// Bounded, quarantine-excluding prompt construction (stage 2 input).
// ---------------------------------------------------------------------------

const TRIAGE_INSTRUCTIONS = `You are triaging a real developer/assistant conversation session to decide whether it is worth keeping as durable memory or safe to discard as noise.
Respond with EXACTLY one JSON object and nothing else, matching this shape:
{"verdict": "keep" | "trash" | "uncertain", "summary": "<one paragraph>", "rationale": "<one sentence>"}
"uncertain" is the correct answer when you are not confident either way -- never force a binary choice.

Transcript excerpt (role-tagged turns, oldest first; some turns may have been withheld or truncated for length/safety):
`;

/**
 * Builds the bounded LLM prompt: fixed instructions, plus a role-tagged
 * transcript excerpt built ONLY from non-quarantined turns, in original
 * order, truncated so the FULL returned string never exceeds `maxChars`
 * (AC2 + AC7 both enforced here, structurally, by construction):
 *
 *  - Quarantined turns (`turn.quarantined === true`) are filtered out
 *    BEFORE a single line is built -- their `text` never contributes any
 *    characters to the result, at any offset (AC7: excluded entirely, not
 *    merely redacted within a still-present line).
 *  - The transcript portion is truncated to fit the character budget
 *    remaining after the fixed instructions; a final defensive
 *    `slice(0, maxChars)` guarantees the overall bound even if the
 *    per-line accounting above ever has an off-by-one.
 */
export function buildTriagePrompt(turns: ConversationTurn[], maxChars: number): string {
  const nonQuarantined = turns.filter((turn) => !turn.quarantined);
  const budgetForTranscript = Math.max(0, maxChars - TRIAGE_INSTRUCTIONS.length);

  const lines: string[] = [];
  let usedChars = 0;
  for (const turn of nonQuarantined) {
    const line = `[${turn.role}] ${turn.text}`;
    const separator = lines.length > 0 ? 1 : 0; // the '\n' that will join this line to the previous one
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

  const prompt = TRIAGE_INSTRUCTIONS + lines.join('\n');
  return prompt.length > maxChars ? prompt.slice(0, maxChars) : prompt;
}

// ---------------------------------------------------------------------------
// Verdict parsing — exactly one of keep/trash/uncertain, never a fourth
// value, never left unset (AC3).
// ---------------------------------------------------------------------------

export type TriageVerdict = 'keep' | 'trash' | 'uncertain';

const VALID_VERDICTS: readonly TriageVerdict[] = ['keep', 'trash', 'uncertain'];

/** Raised when an LLM classification response does not parse to a real, valid `{verdict, summary, rationale}` shape -- always fails loudly, never silently defaults to a guessed verdict. */
export class TriageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TriageError';
  }
}

export interface ParsedTriageResult {
  verdict: TriageVerdict;
  summary: string;
  rationale: string;
}

function safePreview(value: unknown): string {
  try {
    return JSON.stringify(value)?.slice(0, 300) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Validates and narrows a raw LLM classification response. `raw` here is
 * ALWAYS the model's own output (`geminiClient.ts`'s `CallGeminiResult.raw`
 * or a test double standing in for it) -- never anything that could
 * contain a credential, so it is always safe to echo into a thrown error.
 */
export function parseTriageResponse(raw: unknown): ParsedTriageResult {
  if (!raw || typeof raw !== 'object') {
    throw new TriageError(
      `LLM classification response was not a JSON object -- real value received: ${safePreview(raw)}. Failing loudly, never guessing a verdict.`,
    );
  }
  const obj = raw as Record<string, unknown>;
  const verdict = obj.verdict;
  if (typeof verdict !== 'string' || !VALID_VERDICTS.includes(verdict as TriageVerdict)) {
    throw new TriageError(
      `LLM classification response's 'verdict' field was ${JSON.stringify(verdict)} -- expected exactly one of ${VALID_VERDICTS.join('/')}. Never guessed/defaulted; failing loudly.`,
    );
  }
  const summary = typeof obj.summary === 'string' ? obj.summary : '';
  const rationale = typeof obj.rationale === 'string' ? obj.rationale : '';
  return { verdict: verdict as TriageVerdict, summary, rationale };
}

// ---------------------------------------------------------------------------
// LLM client interface — minimal structural shape for testing (mirrors
// `ingestDocument.ts`'s `IngestClient` convention exactly).
// ---------------------------------------------------------------------------

export interface TriageLlmClient {
  /** Returns the raw, `JSON.parse`d classification response (validated by `parseTriageResponse()`), never a pre-validated shape -- keeps this interface identical whether backed by the real `geminiClient.ts` or a test stub. */
  classify(prompt: string): Promise<unknown>;
}

/** Real, production `TriageLlmClient` backed by the shared `geminiClient.ts` primitive. Never used by `triageSession.test.ts` -- every test there supplies its own stub. */
export function createDefaultTriageLlmClient(overrides: Partial<CallGeminiOptions> = {}): TriageLlmClient {
  return {
    async classify(prompt: string): Promise<unknown> {
      const result = await callGemini({
        prompt,
        maxInputChars: MAX_TRIAGE_INPUT_CHARS,
        model: DEFAULT_GEMINI_MODEL,
        ...overrides,
      });
      return result.raw;
    },
  };
}

// ---------------------------------------------------------------------------
// Queue file — append-only (this story's own AC4/AC5).
// ---------------------------------------------------------------------------

export interface TriageQueueEntry {
  /** ISO 8601 timestamp this triage call completed. */
  recordedAt: string;
  /** The session's real id (from its own `ConversationTurn[]`), or `''` when `turns` was empty. */
  sessionId: string;
  /** The session's real source file path (cm-02's manifest), for provenance -- `null` when the caller did not supply one. Carried through as opaque metadata ONLY; this module never opens this path. */
  sourcePath: string | null;
  /** The session's real byte size (cm-02's manifest), for provenance -- `null` when not supplied. */
  sizeBytes: number | null;
  /** Exactly one of keep/trash/uncertain (AC3). */
  verdict: TriageVerdict;
  summary: string;
  rationale: string;
  /** The heuristic prefilter's own output for this session, for traceability -- never itself the basis of the recorded verdict. */
  heuristic: HeuristicResult;
}

/**
 * Appends ONE JSON line to `queuePath` -- a real, OS-level
 * `fs.appendFileSync` call, never a read-the-whole-file-then-rewrite. A
 * prior entry is structurally never at risk from a later call: this
 * function never reads `queuePath` at all.
 */
function appendQueueEntry(entry: TriageQueueEntry, queuePath: string): void {
  mkdirSync(path.dirname(queuePath), { recursive: true });
  appendFileSync(queuePath, JSON.stringify(entry) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// triageSession() — the public entry point.
// ---------------------------------------------------------------------------

export interface TriageSessionOptions {
  /** The session's turns, already parsed by `cm-03`/`cm-04`. */
  turns: ConversationTurn[];
  /** The session's real source file path (cm-02's manifest), carried through as opaque provenance metadata only -- never opened by this module. */
  sourcePath?: string | null;
  /** The session's real byte size (cm-02's manifest), carried through as opaque provenance metadata only. */
  sizeBytes?: number | null;
  /** Injectable LLM client. Default: the real `geminiClient.ts`-backed client. Tests MUST supply a stub (see `triageSession.test.ts`). */
  client?: TriageLlmClient;
  /** Where the queue entry is appended. Default `DEFAULT_TRIAGE_QUEUE_PATH`. Tests override with a temp-dir path. */
  queuePath?: string;
  /** Injectable clock, for deterministic `recordedAt` in tests. Default real `() => new Date()`. */
  now?: () => Date;
}

export interface TriageSessionResult {
  sessionId: string;
  heuristic: HeuristicResult;
  verdict: TriageVerdict;
  summary: string;
  rationale: string;
  /** The exact entry that was appended to the queue file. */
  queueEntry: TriageQueueEntry;
  queuePath: string;
}

/**
 * Runs the full two-stage triage pipeline for one session:
 *
 *  1. `computeHeuristicScore(turns)` -- pure, deterministic, no I/O.
 *  2. `buildTriagePrompt(turns, MAX_TRIAGE_INPUT_CHARS)` -- bounded,
 *     quarantine-excluding transcript excerpt.
 *  3. `client.classify(prompt)` -- ONE bounded LLM call (real
 *     `geminiClient.ts`-backed by default, injectable for tests).
 *  4. `parseTriageResponse()` -- validates the response is exactly one of
 *     keep/trash/uncertain; throws `TriageError` (never records anything,
 *     never guesses) on a malformed response.
 *  5. Appends the COMPLETE result (verdict+summary+rationale+provenance)
 *     to the on-disk queue file -- for EVERY verdict, including `keep`
 *     (AC5), append-only (AC4).
 */
export async function triageSession(options: TriageSessionOptions): Promise<TriageSessionResult> {
  const { turns, sourcePath = null, sizeBytes = null } = options;
  const client = options.client ?? createDefaultTriageLlmClient();
  const queuePath = options.queuePath ?? DEFAULT_TRIAGE_QUEUE_PATH;
  const now = options.now ?? (() => new Date());

  const heuristic = computeHeuristicScore(turns);
  const prompt = buildTriagePrompt(turns, MAX_TRIAGE_INPUT_CHARS);

  const rawResponse = await client.classify(prompt);
  const parsed = parseTriageResponse(rawResponse);

  const sessionId = turns.find((turn) => turn.sessionId.length > 0)?.sessionId ?? '';

  const queueEntry: TriageQueueEntry = {
    recordedAt: now().toISOString(),
    sessionId,
    sourcePath,
    sizeBytes,
    verdict: parsed.verdict,
    summary: parsed.summary,
    rationale: parsed.rationale,
    heuristic,
  };

  // Every verdict is recorded here -- keep INCLUDED, not only
  // trash/uncertain (AC5). No branch above or below this call skips it for
  // any verdict value.
  appendQueueEntry(queueEntry, queuePath);

  return {
    sessionId,
    heuristic,
    verdict: parsed.verdict,
    summary: parsed.summary,
    rationale: parsed.rationale,
    queueEntry,
    queuePath,
  };
}
