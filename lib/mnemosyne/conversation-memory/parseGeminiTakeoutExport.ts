/**
 * cm-10-gemini-conversation-ingestion (epic: mnemosyne-conversation-memory).
 *
 * Turns a real Google Takeout "Gemini in Workspace" bulk export (a ZIP file
 * -- confirmed real and staged at `~/Downloads/Google Takeout Aug 26
 * 2026.zip`, `cm-02`'s fixed, named export-file list, design-discussion.md
 * §10.1) into the SAME shared `ConversationTurn[]` normalized shape
 * (`./types.ts`, `cm-03`'s contract, imported here UNCHANGED) that
 * `parseClaudeCodeSession.ts` and `parseChatGptExport.ts` already produce --
 * a third `variation` sibling: same output contract, structurally different
 * input parser.
 *
 * Scope: this module covers ONLY the Takeout bulk-export shape. The
 * separate Share-link `AF_initDataCallback` capture shape
 * (`gemini.google.com/share/<id>`, saved HTML) has its own, still-unmet
 * precondition (design-discussion.md §9.8) and is NOT built here --
 * `parseGeminiShareExport.ts` remains unbuilt as of this story.
 *
 * ---------------------------------------------------------------------------
 * The real, research-confirmed schema (this story's own `research` step,
 * re-confirmed directly against the real staged ZIP -- content never copied
 * into this repo, only the schema shape).
 * ---------------------------------------------------------------------------
 * Real entries live at `Takeout/Gemini in Workspace/Conversation History/
 * conversation_<digits>.txt` inside the ZIP. Despite the `.txt` extension,
 * each entry's content is JSON (confirmed via `file`/parse, not assumed
 * from the extension) -- NEITHER the Share-link shape's `AF_initDataCallback`
 * data-hydration blob NOR ChatGPT's `conversations.json` array-of-DAGs
 * shape, despite surface-level "AI chat export" similarity to both. Real,
 * confirmed top-level shape per entry:
 *
 *   { conversation_turns: [...], creation_time: <ISO-8601 string>,
 *     last_modification_time: <ISO-8601 string>, title: <string> }
 *
 * `conversation_turns` is an array of single-key wrapper objects -- each
 * element is EITHER `{ user_turn: {...} }` OR `{ system_turn: {...} }`.
 * `'system_turn'` is Gemini's own vocabulary for the ASSISTANT's reply turn
 * (never a system-prompt role) -- this story's research step found no
 * `'system'`-role turn anywhere in the real staged export, so
 * `'system_turn'` normalizes onto the shared contract's `'assistant'` role,
 * never `'system'`.
 *
 * `user_turn`: `{ prompt: string, turn_index: number, turn_last_modified:
 * <ISO-8601 string> }`.
 *
 * `system_turn`: `{ text: Array<{ data: string, preamble?: string }>,
 * turn_index: number, turn_last_modified: <ISO-8601 string> }` -- a real,
 * previously-unconfirmed nuance this story's research step found directly
 * against the real staged export: a `system_turn`'s reply can be split
 * across multiple `text` array parts, and a part may carry a `preamble` (a
 * short lead-in sentence) paired with an EMPTY `data` string, immediately
 * followed by a sibling part carrying the real reply text in `data` with no
 * `preamble` key at all. Every part's `preamble` (when present and
 * non-empty) and `data` (when non-empty) are joined, in part order, into
 * one turn's `text`.
 *
 * No conversation/session id field exists ANYWHERE inside a real entry's
 * own JSON content -- confirmed directly this story's research step. The
 * only real id available is the numeric suffix of the entry's own ZIP path
 * (`conversation_<digits>.txt`), used as `ConversationTurn.sessionId`
 * (cross_cutting: provenance-completeness's "Takeout entry id").
 *
 * ---------------------------------------------------------------------------
 * `Gemini in Workspace` vs. the standalone consumer `gemini.google.com` app
 * -- genuinely UNCONFIRMED, not assumed identical.
 * ---------------------------------------------------------------------------
 * The real staged export's plain `Takeout/Gemini/` category (as opposed to
 * `Takeout/Gemini in Workspace/`) contains only two empty placeholder files
 * (`gemini_scheduled_actions_data.html`, `gemini_gems_data.html` -- each a
 * bare `<div></div>`, confirmed this pass, no scheduled-actions/gems data)
 * -- it carries NO conversation content to compare against, so the
 * standalone-app schema-equivalence question the story's own research step
 * was asked to pin down remains genuinely unconfirmed (an accepted,
 * explicitly named gap, not silently resolved). This module only ever
 * reads entries under the confirmed `Gemini in Workspace/Conversation
 * History/` path -- both sibling `Takeout/Gemini/*.html` files, and any
 * other Takeout category that might be bundled into the same ZIP (Drive,
 * Photos, etc. -- confirmed present alongside other real export bundles in
 * this operator's own Downloads directory, `discoverSources.ts`'s own doc
 * comment), are silently skipped -- never a generic ZIP-wide scan, mirroring
 * `discoverSources.ts`'s own "never a generic Downloads-directory scan"
 * discipline applied here at content-parse time.
 *
 * ---------------------------------------------------------------------------
 * Whitelist-not-blacklist (mirrors `parseClaudeCodeSession.ts`'s and
 * `parseChatGptExport.ts`'s own discipline).
 * ---------------------------------------------------------------------------
 * A `conversation_turns` element whose single key is neither `'user_turn'`
 * nor `'system_turn'` (a real, observed set of exactly two as of this
 * story's research pass -- a plausible future third kind is NOT invented or
 * guessed at here) is silently excluded, never a parse failure. A
 * `user_turn` with an empty-string (or non-string) `prompt`, or a
 * `system_turn` whose every `text` part yields no non-empty `preamble`/
 * `data`, carries no principled text to extract and is likewise excluded --
 * never surfaced as an empty/fabricated turn.
 *
 * A conversation entry whose own `conversation_turns` field is not an array
 * at all is a structurally corrupt entry -- a loud, named failure (`Error`),
 * never a silent empty/partial result, mirroring `parseChatGptExport.ts`'s
 * own dangling-reference loud-failure precedent.
 *
 * ---------------------------------------------------------------------------
 * ZIP reading -- `fflate` (pure JS, zero native dependencies), the same
 * precedent this codebase already set with `unpdf` for PDF-specific
 * parsing (`package.json`): a small, well-established, format-specific
 * dependency rather than a hand-rolled ZIP/DEFLATE implementation.
 * ---------------------------------------------------------------------------
 *
 * `cm-01` secret-scan integration (design-discussion.md §2.8, checkpoint 1
 * of 2) -- identical discipline to `parseClaudeCodeSession.ts`/
 * `parseChatGptExport.ts`. `scanForSecrets()` runs over EVERY extracted
 * turn's `text` before this module returns -- the real, unstubbed export,
 * never a mock. A match quarantines that turn.
 *
 * Story: cm-10-gemini-conversation-ingestion (epic: mnemosyne-conversation-memory).
 */

import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import { scanForSecrets } from './scanForSecrets.js';
import type { ConversationTurn } from './types.js';

// ---------------------------------------------------------------------------
// Raw export shapes. Deliberately loose (`unknown`-typed fields probed
// defensively) -- this is untrusted, externally-authored JSON from a real
// export file, not a shape this module controls. Field names match the
// real, confirmed Takeout entry keys (this story's own research step)
// exactly.
// ---------------------------------------------------------------------------

export interface RawGeminiTakeoutUserTurn {
  prompt?: unknown;
  turn_index?: unknown;
  turn_last_modified?: unknown;
}

export interface RawGeminiTakeoutSystemTextPart {
  data?: unknown;
  preamble?: unknown;
}

export interface RawGeminiTakeoutSystemTurn {
  text?: unknown;
  turn_index?: unknown;
  turn_last_modified?: unknown;
}

/**
 * A single `conversation_turns` element: a single-key wrapper whose key is
 * (as of this story's research pass) either `'user_turn'` or
 * `'system_turn'` -- but declared loosely (`Record<string, unknown>`) since
 * a real future Gemini export could carry an as-yet-unobserved third kind,
 * which this module's whitelist silently skips rather than assumes can
 * never exist (module doc comment).
 */
export type RawGeminiTakeoutTurnEntry = Record<string, unknown>;

/** The real, confirmed per-conversation-entry shape (this story's own research step). */
export interface RawGeminiTakeoutConversation {
  conversation_turns?: unknown;
  creation_time?: unknown;
  last_modification_time?: unknown;
  title?: unknown;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Real `turn_last_modified`/`creation_time` values are ISO-8601 strings with microsecond precision (e.g. a `+00:00` offset) -- normalized to the shared contract's own ISO-8601 (millisecond-precision) string via `Date`, or `null` if unparseable/absent. */
function toIsoTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

/** Extracts a `user_turn`'s text: the raw `prompt` string when non-empty, else `null` (no principled text -- module doc comment). */
function extractUserTurnText(userTurn: RawGeminiTakeoutUserTurn): string | null {
  const prompt = userTurn.prompt;
  if (typeof prompt !== 'string' || prompt.length === 0) return null;
  return prompt;
}

/**
 * Extracts a `system_turn`'s text: joins every part's non-empty `preamble`
 * (when present) and non-empty `data`, in part order (module doc comment's
 * real, confirmed multi-part nuance). Returns `null` when every part yields
 * no non-empty string (no principled text -- module doc comment).
 */
function extractSystemTurnText(systemTurn: RawGeminiTakeoutSystemTurn): string | null {
  const parts = Array.isArray(systemTurn.text) ? (systemTurn.text as RawGeminiTakeoutSystemTextPart[]) : [];
  const pieces: string[] = [];
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    if (typeof part.preamble === 'string' && part.preamble.length > 0) pieces.push(part.preamble);
    if (typeof part.data === 'string' && part.data.length > 0) pieces.push(part.data);
  }
  if (pieces.length === 0) return null;
  return pieces.join('\n\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parses ONE already-parsed real (or real-shaped fixture) Gemini Takeout
 * conversation entry into the shared `ConversationTurn[]` contract.
 *
 * `sessionId` is supplied by the caller (`parseGeminiTakeoutExport()`
 * derives it from the entry's own ZIP path -- no id field exists inside the
 * entry's own JSON content, module doc comment).
 *
 * Each `conversation_turns` element is processed in source-array order
 * (the real export's own array order already matches each element's own
 * `turn_index`, confirmed this story's research step; this function trusts
 * array order rather than re-sorting by the raw `turn_index` field, mirroring
 * `parseChatGptExport.ts`'s own "assign a fresh sequential index over
 * surviving turns" convention). An element whose single key is not
 * `'user_turn'`/`'system_turn'`, or that carries no principled non-empty
 * text, is excluded -- never surfaced as an empty/fabricated turn and never
 * a parse failure (module doc comment).
 *
 * Runs `cm-01`'s real `scanForSecrets()` over every extracted turn's text
 * before returning -- a match quarantines that turn.
 *
 * Throws if `conversation_turns` is present but not an array (a
 * structurally corrupt entry) -- the one loud-failure case in this module.
 */
export function parseGeminiTakeoutConversation(conversation: RawGeminiTakeoutConversation, sessionId: string): ConversationTurn[] {
  const rawTurns = conversation.conversation_turns;
  if (!Array.isArray(rawTurns)) {
    throw new Error(`parseGeminiTakeoutConversation: expected conversation_turns to be an array (session ${sessionId || '<unknown>'}), got ${typeof rawTurns}`);
  }

  const turns: ConversationTurn[] = [];
  let turnIndex = 0;

  for (const entry of rawTurns as RawGeminiTakeoutTurnEntry[]) {
    if (!entry || typeof entry !== 'object') continue;

    let role: 'user' | 'assistant' | null = null;
    let text: string | null = null;
    let timestamp: string | null = null;

    if ('user_turn' in entry && entry.user_turn && typeof entry.user_turn === 'object') {
      const userTurn = entry.user_turn as RawGeminiTakeoutUserTurn;
      role = 'user';
      text = extractUserTurnText(userTurn);
      timestamp = toIsoTimestamp(userTurn.turn_last_modified);
    } else if ('system_turn' in entry && entry.system_turn && typeof entry.system_turn === 'object') {
      const systemTurn = entry.system_turn as RawGeminiTakeoutSystemTurn;
      role = 'assistant';
      text = extractSystemTurnText(systemTurn);
      timestamp = toIsoTimestamp(systemTurn.turn_last_modified);
    } else {
      // Unrecognized turn-wrapper key (e.g. a real future kind neither this
      // story's research step nor the real staged export has ever shown) --
      // whitelist-skip, never coerced, never a parse failure.
      continue;
    }

    if (text === null) continue; // no principled text this element carries.

    const secretMatches = scanForSecrets(text);
    const quarantined = secretMatches.length > 0;

    turns.push({
      sessionId,
      sourceType: 'gemini-takeout',
      role,
      text,
      timestamp,
      projectSlug: null, // Gemini Takeout conversations have no repo/project association -- explicit, never omitted (cross_cutting: provenance-completeness).
      turnIndex,
      quarantined,
      quarantineReason: quarantined ? 'secret_detected' : null,
      secretMatches,
    });
    turnIndex++;
  }

  return turns;
}

/**
 * The real, confirmed path pattern for a Gemini Takeout conversation entry
 * inside the ZIP (module doc comment). The first capture group is the
 * entry's own numeric id, used as `ConversationTurn.sessionId`. Anchored to
 * the exact confirmed directory -- never a generic `.txt`-anywhere-in-zip
 * scan (module doc comment's "never a generic scan" discipline).
 */
const CONVERSATION_ENTRY_RE = /^Takeout\/Gemini in Workspace\/Conversation History\/conversation_(\d+)\.txt$/;

/**
 * Parses a real Google Takeout "Gemini in Workspace" export ZIP at
 * `filePath` into the shared `ConversationTurn[]` contract, flat-mapping
 * `parseGeminiTakeoutConversation()` over every real conversation entry
 * found under the confirmed `Gemini in Workspace/Conversation History/`
 * directory inside the ZIP.
 *
 * Every OTHER entry in the ZIP -- sibling Takeout categories bundled into
 * the same export bundle (the real, confirmed empty `Takeout/Gemini/*.html`
 * placeholder files, or any other real Takeout category such as Drive/
 * Photos/etc.) -- is silently skipped, never read as conversation content
 * and never treated as a parse error (module doc comment). A ZIP with zero
 * matching entries returns an empty array -- not an error, mirroring
 * `parseChatGptConversation()`'s own "scaffolded but never messaged is not
 * an error" precedent.
 */
export async function parseGeminiTakeoutExport(filePath: string): Promise<ConversationTurn[]> {
  const zipBuffer = await readFile(filePath);
  const entries = unzipSync(new Uint8Array(zipBuffer));

  const turns: ConversationTurn[] = [];
  for (const [entryPath, entryBytes] of Object.entries(entries)) {
    const match = CONVERSATION_ENTRY_RE.exec(entryPath);
    if (!match) continue; // Not a Conversation History entry -- silently skipped, module doc comment.

    const sessionId = match[1]!;
    const raw = new TextDecoder('utf-8').decode(entryBytes);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`parseGeminiTakeoutExport: entry "${entryPath}" is not valid JSON despite its .txt extension (${(err as Error).message})`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`parseGeminiTakeoutExport: entry "${entryPath}" expected a top-level JSON object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`);
    }

    turns.push(...parseGeminiTakeoutConversation(parsed as RawGeminiTakeoutConversation, sessionId));
  }

  return turns;
}
