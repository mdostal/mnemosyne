/**
 * cm-10-gemini-conversation-ingestion (epic: mnemosyne-conversation-memory).
 *
 * Failing-first tests (TDD, per the story's `test-spec` step) for
 * `parseGeminiTakeoutConversation()` / `parseGeminiTakeoutExport()` against
 * this story's Takeout-scoped acceptance criteria (`.pHive/epics/mnemosyne-
 * conversation-memory/stories/cm-10-gemini-conversation-ingestion.yaml` --
 * the Share-link half is out of scope; its own precondition remains unmet):
 *
 *  AC1. `parseGeminiTakeoutExport()` produces the same normalized
 *       `ConversationTurn[]` shape cm-03/cm-04 already produce, against the
 *       real, research-confirmed Takeout schema (a `.txt`-extensioned but
 *       JSON-content entry under `Takeout/Gemini in Workspace/Conversation
 *       History/`) -- never an assumed/invented schema, and never the
 *       Share-link's `AF_initDataCallback` shape.
 *  AC2. `'user_turn'` -> role `'user'`; `'system_turn'` -> role
 *       `'assistant'` (Gemini's own "system" vocabulary names the AI's
 *       reply turn, never a system-prompt role -- confirmed no
 *       `'system'`-role turn exists in this schema at all).
 *  AC3. A `system_turn`'s multi-part `text` array (a real, research-
 *       confirmed nuance: a `preamble`-carrying, empty-`data` part
 *       immediately followed by a `data`-only part) is joined into one
 *       turn's text, in part order.
 *  AC4. A turn containing a fixture secret (`cm-01`'s own corpus) is
 *       flagged quarantined, identical behavior to cm-03/cm-04.
 *  AC5. Fixtures are synthetic, schema-accurate constructions -- never the
 *       operator's real staged Takeout content.
 *  AC6. Full end-to-end `parseGeminiTakeoutExport()` over a real ZIP
 *       container (synthetic entries, built in-memory with the same
 *       `fflate` library the implementation uses) -- only entries under the
 *       confirmed `Conversation History` directory are parsed; sibling
 *       Takeout categories bundled in the same zip (e.g. the real, empty
 *       `Takeout/Gemini/*.html` placeholder files this story's research
 *       step found) are silently skipped, never treated as a parse error.
 *  AC7. Whitelist-not-blacklist: an unrecognized turn-wrapper key, an
 *       empty-string `prompt`, and an all-empty `system_turn.text` are all
 *       excluded from the output -- never surfaced as an empty/fabricated
 *       turn, never a parse failure.
 *  AC8. A structurally corrupt conversation entry (`conversation_turns` not
 *       an array) fails loudly.
 *
 * Fixtures: synthetic, schema-accurate conversation objects only
 * (`__fixtures__/gemini-conversations/*.ts`) -- never the operator's own
 * real staged Takeout export content anywhere in this file.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CORRUPTED_NON_ARRAY_TURNS_CONVERSATION } from './__fixtures__/gemini-conversations/corrupted-conversation.js';
import { EDGE_CASE_CONVERSATION } from './__fixtures__/gemini-conversations/edge-case-conversation.js';
import { EMPTY_CONVERSATION } from './__fixtures__/gemini-conversations/empty-conversation.js';
import { BASIC_CONVERSATION } from './__fixtures__/gemini-conversations/basic-conversation.js';
import { WITH_SECRET_CONVERSATION } from './__fixtures__/gemini-conversations/with-secret-conversation.js';
import { POSITIVE_FIXTURES } from './__fixtures__/secrets-corpus.js';
import { parseGeminiTakeoutConversation, parseGeminiTakeoutExport } from './parseGeminiTakeoutExport.js';

// ---------------------------------------------------------------------------
// AC1/AC2 -- basic linearization, role mapping.
// ---------------------------------------------------------------------------

describe('parseGeminiTakeoutConversation -- basic linearization and role mapping', () => {
  it('produces one ConversationTurn per real user_turn/system_turn entry, in source order', () => {
    const turns = parseGeminiTakeoutConversation(BASIC_CONVERSATION, 'fixture-basic-0001');
    expect(turns).toHaveLength(4);
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(turns.map((t) => t.turnIndex)).toEqual([0, 1, 2, 3]);
  });

  it('maps user_turn to role "user" and system_turn to role "assistant" -- never "system"', () => {
    const turns = parseGeminiTakeoutConversation(BASIC_CONVERSATION, 'fixture-basic-0001');
    expect(new Set(turns.map((t) => t.role))).toEqual(new Set(['user', 'assistant']));
    expect(turns.some((t) => (t.role as string) === 'system')).toBe(false);
  });

  it('carries full provenance on every turn: sessionId, sourceType "gemini-takeout", projectSlug null, quarantine defaults', () => {
    const turns = parseGeminiTakeoutConversation(BASIC_CONVERSATION, 'fixture-basic-0001');
    for (const turn of turns) {
      expect(turn.sessionId).toBe('fixture-basic-0001');
      expect(turn.sourceType).toBe('gemini-takeout');
      expect(turn.projectSlug).toBeNull();
      expect(turn.quarantined).toBe(false);
      expect(turn.quarantineReason).toBeNull();
      expect(turn.secretMatches).toEqual([]);
    }
  });

  it('normalizes each turn_last_modified into a valid ISO 8601 timestamp', () => {
    const turns = parseGeminiTakeoutConversation(BASIC_CONVERSATION, 'fixture-basic-0001');
    for (const turn of turns) {
      expect(turn.timestamp).not.toBeNull();
      expect(new Date(turn.timestamp!).toISOString()).toBe(turn.timestamp);
    }
    // Chronological order: strictly non-decreasing.
    const times = turns.map((t) => new Date(t.timestamp!).getTime());
    for (let i = 1; i < times.length; i++) {
      expect(times[i]!).toBeGreaterThanOrEqual(times[i - 1]!);
    }
  });

  it('returns an empty array for a conversation with zero conversation_turns', () => {
    const turns = parseGeminiTakeoutConversation(EMPTY_CONVERSATION, 'fixture-empty-0001');
    expect(turns).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC3 -- multi-part system_turn.text joining (preamble + data parts).
// ---------------------------------------------------------------------------

describe('parseGeminiTakeoutConversation -- multi-part system_turn.text joining', () => {
  it('joins a preamble-carrying empty-data part with its sibling data-only part into one turn text', () => {
    const turns = parseGeminiTakeoutConversation(BASIC_CONVERSATION, 'fixture-basic-0001');
    const firstReply = turns[1]!;
    expect(firstReply.role).toBe('assistant');
    expect(firstReply.text).toContain('here is a short draft');
    expect(firstReply.text).toContain('thank you all for the fixture-project effort');
  });

  it('preserves part order (preamble before its sibling data part) in the joined text', () => {
    const turns = parseGeminiTakeoutConversation(BASIC_CONVERSATION, 'fixture-basic-0001');
    const firstReply = turns[1]!;
    const preambleIdx = firstReply.text.indexOf('here is a short draft');
    const dataIdx = firstReply.text.indexOf('thank you all for the fixture-project effort');
    expect(preambleIdx).toBeGreaterThanOrEqual(0);
    expect(dataIdx).toBeGreaterThan(preambleIdx);
  });
});

// ---------------------------------------------------------------------------
// AC7 -- whitelist-not-blacklist: unrecognized turn kind, empty prompt,
// all-empty system_turn.text are excluded, never surfaced as empty/
// fabricated turns and never a parse failure.
// ---------------------------------------------------------------------------

describe('parseGeminiTakeoutConversation -- whitelist filtering of no-principled-text / unrecognized turns', () => {
  it('excludes an unrecognized turn-wrapper key (e.g. a future tool_turn) without throwing', () => {
    const turns = parseGeminiTakeoutConversation(EDGE_CASE_CONVERSATION, 'fixture-edge-0001');
    expect(turns.every((t) => t.text.includes('fixture_calendar_lookup') === false)).toBe(true);
  });

  it('excludes a user_turn with an empty-string prompt', () => {
    const turns = parseGeminiTakeoutConversation(EDGE_CASE_CONVERSATION, 'fixture-edge-0001');
    expect(turns.some((t) => t.role === 'user' && t.text === '')).toBe(false);
  });

  it('excludes a system_turn whose every text part is empty-data/no-preamble', () => {
    const turns = parseGeminiTakeoutConversation(EDGE_CASE_CONVERSATION, 'fixture-edge-0001');
    expect(turns.some((t) => t.role === 'assistant' && t.text === '')).toBe(false);
  });

  it('produces exactly the two real, non-empty turns surrounding the excluded ones -- exclusion is per-turn, not a whole-conversation short-circuit', () => {
    const turns = parseGeminiTakeoutConversation(EDGE_CASE_CONVERSATION, 'fixture-edge-0001');
    expect(turns).toHaveLength(2);
    expect(turns[0]!.text).toContain('FIXTURE_REAL_FIRST_PROMPT');
    expect(turns[1]!.text).toContain('FIXTURE_REAL_LAST_REPLY');
    // turnIndex is compacted over surviving turns, never leaving gaps for excluded ones.
    expect(turns.map((t) => t.turnIndex)).toEqual([0, 1]);
  });
});

// ---------------------------------------------------------------------------
// AC8 -- structurally corrupt conversation fails loudly.
// ---------------------------------------------------------------------------

describe('parseGeminiTakeoutConversation -- structurally corrupt conversation fails loudly', () => {
  it('throws when conversation_turns is not an array', () => {
    expect(() => parseGeminiTakeoutConversation(CORRUPTED_NON_ARRAY_TURNS_CONVERSATION, 'fixture-corrupted-0001')).toThrow(/conversation_turns/);
  });
});

// ---------------------------------------------------------------------------
// AC4 -- quarantine flagging via cm-01's real scanForSecrets().
// ---------------------------------------------------------------------------

describe('parseGeminiTakeoutConversation -- quarantine flagging via cm-01\'s real scanForSecrets()', () => {
  it('flags the turn containing a real cm-01 fixture secret as quarantined, with the real match data attached', () => {
    const turns = parseGeminiTakeoutConversation(WITH_SECRET_CONVERSATION, 'fixture-with-secret-0001');
    expect(turns).toHaveLength(4);

    const secretTurn = turns.find((t) => t.role === 'user' && t.turnIndex === 2)!;
    expect(secretTurn).toBeDefined();
    expect(secretTurn.quarantined).toBe(true);
    expect(secretTurn.quarantineReason).toBe('secret_detected');
    expect(secretTurn.secretMatches.length).toBeGreaterThan(0);
    expect(secretTurn.secretMatches[0]!.category).toBe('api-key');

    // Quarantine is a flag, never a silent drop -- text is still present.
    expect(secretTurn.text.length).toBeGreaterThan(0);

    const otherTurns = turns.filter((t) => t !== secretTurn);
    for (const turn of otherTurns) {
      expect(turn.quarantined).toBe(false);
      expect(turn.quarantineReason).toBeNull();
      expect(turn.secretMatches).toEqual([]);
    }
  });

  it('never silently drops or silently passes through a quarantined turn (it appears in the array, flagged)', () => {
    const turns = parseGeminiTakeoutConversation(WITH_SECRET_CONVERSATION, 'fixture-with-secret-0001');
    const fixtureSecretValue = POSITIVE_FIXTURES.find((f) => f.id === 'aws-access-key-id')!.secretValue;
    const anyUnflaggedSecret = turns.some((t) => !t.quarantined && t.text.includes(fixtureSecretValue));
    expect(anyUnflaggedSecret).toBe(false);
  });

  it('secretMatches never leaks the raw secret value itself (relies on cm-01\'s own redaction contract)', () => {
    const turns = parseGeminiTakeoutConversation(WITH_SECRET_CONVERSATION, 'fixture-with-secret-0001');
    const secretTurn = turns.find((t) => t.quarantined)!;
    const serializedMatches = JSON.stringify(secretTurn.secretMatches);
    const fixtureSecretValue = POSITIVE_FIXTURES.find((f) => f.id === 'aws-access-key-id')!.secretValue;
    expect(serializedMatches).not.toContain(fixtureSecretValue);
  });
});

// ---------------------------------------------------------------------------
// AC6 -- full end-to-end run over a real ZIP container built in-memory.
// ---------------------------------------------------------------------------

describe('parseGeminiTakeoutExport -- full ZIP-container run', () => {
  let tmpDir: string;
  let zipPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'cm-10-gemini-takeout-test-'));
    zipPath = path.join(tmpDir, 'Google Takeout Aug 26 2026.zip');

    const enc = (obj: unknown) => new TextEncoder().encode(JSON.stringify(obj));
    const zipped = zipSync({
      'Takeout/Gemini in Workspace/Conversation History/conversation_1000000001.txt': enc(BASIC_CONVERSATION),
      'Takeout/Gemini in Workspace/Conversation History/conversation_1000000002.txt': enc(WITH_SECRET_CONVERSATION),
      // Mirrors the real, confirmed sibling Takeout category this story's
      // research step found: empty placeholder files under a DIFFERENT
      // `Takeout/Gemini/` directory (not `Gemini in Workspace`) -- must be
      // silently skipped, never parsed as a conversation entry.
      'Takeout/Gemini/gemini_scheduled_actions_data.html': new TextEncoder().encode('<div></div>'),
      'Takeout/Gemini/gemini_gems_data.html': new TextEncoder().encode('<div></div>'),
    });
    writeFileSync(zipPath, zipped);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses only the Conversation History entries, deriving sessionId from each entry filename', async () => {
    const turns = await parseGeminiTakeoutExport(zipPath);
    // 4 (basic) + 4 (with-secret) = 8; the two sibling-category HTML entries contribute 0.
    expect(turns).toHaveLength(8);
    expect(turns.every((t) => t.sourceType === 'gemini-takeout')).toBe(true);
    const sessionIds = new Set(turns.map((t) => t.sessionId));
    expect(sessionIds).toEqual(new Set(['1000000001', '1000000002']));
  });

  it('never surfaces the sibling Takeout category HTML content anywhere in the output', async () => {
    const turns = await parseGeminiTakeoutExport(zipPath);
    const serialized = JSON.stringify(turns);
    expect(serialized).not.toContain('<div>');
    expect(serialized).not.toContain('gemini_scheduled_actions_data');
  });

  it('propagates quarantine flagging through the full ZIP-level run', async () => {
    const turns = await parseGeminiTakeoutExport(zipPath);
    const quarantined = turns.filter((t) => t.quarantined);
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]!.sessionId).toBe('1000000002');
  });

  it('returns an empty array for a ZIP with no Conversation History entries at all (never an error)', async () => {
    const emptyZipPath = path.join(tmpDir, 'no-gemini-in-workspace.zip');
    writeFileSync(
      emptyZipPath,
      zipSync({
        'Takeout/Gemini/gemini_scheduled_actions_data.html': new TextEncoder().encode('<div></div>'),
      }),
    );
    const turns = await parseGeminiTakeoutExport(emptyZipPath);
    expect(turns).toEqual([]);
  });
});
