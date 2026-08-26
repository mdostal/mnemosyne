/**
 * cm-04-chatgpt-export-parser (epic: mnemosyne-conversation-memory).
 *
 * Failing-first tests (TDD, per the story's `test-spec` step) for
 * `parseChatGptConversation()` / `parseChatGptExport()` against every
 * acceptance criterion in `.pHive/epics/mnemosyne-conversation-memory/
 * stories/cm-04-chatgpt-export-parser.yaml`:
 *
 *  AC1. Linearizes by walking BACKWARD from `current_node` through `parent`
 *       pointers, producing one `ConversationTurn` per real message node in
 *       the active path, in chronological order.
 *  AC2. A genuine multi-branch (edited-message) fixture -- only the ACTIVE
 *       path (per `current_node`) is included; the abandoned sibling
 *       branch is fully excluded. Named, first-class acceptance criterion,
 *       not an edge case.
 *  AC3. A `message: null` scaffold node, or a node whose
 *       `message.metadata.is_visually_hidden_from_conversation` is `true`,
 *       is excluded -- never surfaced as a real turn.
 *  AC4. `message.author.role` maps EXACTLY onto the resulting turn's
 *       `role` -- and a real fourth role value (`'tool'`, confirmed this
 *       story's research step) is excluded, never coerced.
 *  AC5. The full multi-conversation export parses via `parseChatGptExport()`
 *       without ever reading attachment/image blob content as text.
 *  AC6. A turn containing a fixture secret (`cm-01`'s own corpus) is
 *       flagged quarantined, identical behavior to `cm-03`.
 *
 * Fixtures: synthetic, schema-accurate conversation objects only
 * (`__fixtures__/chatgpt-conversations/*.ts`) -- never the operator's own
 * real ChatGPT export content anywhere in this file.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BASIC_CONVERSATION } from './__fixtures__/chatgpt-conversations/basic-conversation.js';
import { BRANCHED_CONVERSATION } from './__fixtures__/chatgpt-conversations/branched-conversation.js';
import {
  CORRUPTED_DANGLING_CURRENT_NODE_CONVERSATION,
  CORRUPTED_DANGLING_PARENT_CONVERSATION,
} from './__fixtures__/chatgpt-conversations/corrupted-conversation.js';
import { EMPTY_CONVERSATION } from './__fixtures__/chatgpt-conversations/empty-conversation.js';
import { MIXED_CONTENT_TYPE_CONVERSATION } from './__fixtures__/chatgpt-conversations/mixed-content-type-conversation.js';
import { WITH_SECRET_CONVERSATION } from './__fixtures__/chatgpt-conversations/with-secret-conversation.js';
import { POSITIVE_FIXTURES } from './__fixtures__/secrets-corpus.js';
import { parseChatGptConversation, parseChatGptExport } from './parseChatGptExport.js';

// ---------------------------------------------------------------------------
// AC1 — backward walk from current_node, one turn per real node, chronological.
// ---------------------------------------------------------------------------

describe('parseChatGptConversation — basic linearization', () => {
  it('walks backward from current_node and produces one ConversationTurn per real user/assistant/system turn, in chronological order', () => {
    const turns = parseChatGptConversation(BASIC_CONVERSATION);

    // Scaffold root (message: null) and hidden system node excluded ->
    // exactly the 4 real user/assistant turns.
    expect(turns).toHaveLength(4);
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(turns.map((t) => t.turnIndex)).toEqual([0, 1, 2, 3]);

    // Chronological order: each turn's timestamp strictly increases.
    const timestamps = turns.map((t) => new Date(t.timestamp!).getTime());
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]!).toBeGreaterThan(timestamps[i - 1]!);
    }

    expect(turns[0]!.text).toContain('small raised garden bed');
    expect(turns[3]!.text).toContain('twice a week');
  });

  it('carries full provenance on every turn: sessionId, sourceType, projectSlug null, quarantine defaults', () => {
    const turns = parseChatGptConversation(BASIC_CONVERSATION);
    for (const turn of turns) {
      expect(turn.sessionId).toBe('fixture-basic-conversation-0001');
      expect(turn.sourceType).toBe('chatgpt');
      // Explicit null, not omitted (cross_cutting: provenance-completeness).
      expect(turn.projectSlug).toBeNull();
      expect(turn.quarantined).toBe(false);
      expect(turn.quarantineReason).toBeNull();
      expect(turn.secretMatches).toEqual([]);
    }
  });

  it('returns an empty array for a conversation with no active path (current_node null)', () => {
    const turns = parseChatGptConversation(EMPTY_CONVERSATION);
    expect(turns).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC2 — genuine multi-branch (edited-message) fixture: only the ACTIVE path
// is included, the abandoned sibling branch is fully excluded.
// ---------------------------------------------------------------------------

describe('parseChatGptConversation — multi-branch (edited-message) linearization', () => {
  it('includes only the active (current_node) branch, excluding the abandoned edited-away sibling branch entirely', () => {
    const turns = parseChatGptConversation(BRANCHED_CONVERSATION);
    const allText = turns.map((t) => t.text).join('\n');

    // The active, edited branch's real content IS present.
    expect(allText).toContain('FIXTURE_ACTIVE_EDITED_QUESTION');
    expect(allText).toContain('FIXTURE_ACTIVE_EDITED_REPLY');

    // The abandoned original branch's content is NEVER present, anywhere.
    expect(allText).not.toContain('FIXTURE_ABANDONED_ORIGINAL_QUESTION');
    expect(allText).not.toContain('FIXTURE_ABANDONED_ORIGINAL_REPLY');

    // Shared ancestor content above the branch point is still present once.
    expect(allText).toContain('beginner sourdough recipe');
    const occurrences = turns.filter((t) => t.text.includes('beginner sourdough recipe')).length;
    expect(occurrences).toBe(1);
  });

  it('produces exactly the active-path turn count (shared ancestors + edited branch only, never both branches)', () => {
    const turns = parseChatGptConversation(BRANCHED_CONVERSATION);
    // system(hidden, excluded) + user(shared) + assistant(shared) + user(edited) + assistant(edited) = 4 real turns.
    // Never 6 (which would mean both branches leaked in).
    expect(turns).toHaveLength(4);
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('never includes the abandoned branch even when it structurally appears earlier in mapping insertion order', () => {
    // Object.entries(mapping) insertion order places node-4-user-original
    // (abandoned) before node-5-user-edited (active) -- a naive "walk
    // mapping in object order" implementation would still leak the
    // abandoned branch in. The real algorithm must walk from current_node.
    const turns = parseChatGptConversation(BRANCHED_CONVERSATION);
    expect(turns.some((t) => t.text.includes('ABANDONED'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC3 — scaffold (message: null) and hidden nodes never surfaced as turns.
// ---------------------------------------------------------------------------

describe('parseChatGptConversation — scaffold and hidden-node filtering', () => {
  it('excludes the root scaffold node (message: null) from the output', () => {
    const turns = parseChatGptConversation(BASIC_CONVERSATION);
    expect(turns.every((t) => t.text !== '')).toBe(true);
    // The scaffold node has no message at all -- if it leaked through,
    // accessing role would have thrown/produced 'system' with empty text
    // as the very first turn; assert the first REAL turn is the user turn.
    expect(turns[0]!.role).toBe('user');
  });

  it('excludes a node whose message.metadata.is_visually_hidden_from_conversation is true, even though it has real message content', () => {
    const turns = parseChatGptConversation(BASIC_CONVERSATION);
    // The hidden system node in the fixture is never surfaced.
    expect(turns.some((t) => t.role === 'system')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC4 — role maps exactly; a real fourth role ('tool') is excluded, never
// coerced onto the shared 3-role contract. Content-type whitelist likewise.
// ---------------------------------------------------------------------------

describe('parseChatGptConversation — role fidelity and content-type whitelist', () => {
  it('maps message.author.role onto the turn role exactly for system/user/assistant', () => {
    const turns = parseChatGptConversation(BASIC_CONVERSATION);
    expect(new Set(turns.map((t) => t.role))).toEqual(new Set(['user', 'assistant']));
  });

  it('excludes a real "tool"-authored node entirely -- never coerced into user/assistant/system', () => {
    const turns = parseChatGptConversation(MIXED_CONTENT_TYPE_CONVERSATION);
    expect(turns.every((t) => (t.role as string) !== 'tool')).toBe(true);
    expect(turns.some((t) => t.text.includes('FIXTURE_TOOL_OUTPUT'))).toBe(false);
  });

  it('excludes a content_type: "code" node (outside this story\'s text-extraction whitelist)', () => {
    const turns = parseChatGptConversation(MIXED_CONTENT_TYPE_CONVERSATION);
    expect(turns.some((t) => t.text.includes('FIXTURE_CODE_BLOCK'))).toBe(false);
  });

  it('extracts only the string part of a multimodal_text node, never the image-asset-pointer content', () => {
    const turns = parseChatGptConversation(MIXED_CONTENT_TYPE_CONVERSATION);
    const captionTurn = turns.find((t) => t.text.includes('FIXTURE_CAPTION'));
    expect(captionTurn).toBeDefined();
    const serialized = JSON.stringify(turns);
    expect(serialized).not.toContain('FIXTURE_NEVER_READ_AS_TEXT');
    expect(serialized).not.toContain('image_asset_pointer');
  });

  it('produces exactly the expected surviving turns for the mixed-content-type fixture (tool + code excluded, image caption + text turns kept)', () => {
    const turns = parseChatGptConversation(MIXED_CONTENT_TYPE_CONVERSATION);
    expect(turns.map((t) => t.role)).toEqual(['user', 'user', 'assistant']);
    expect(turns[0]!.text).toContain('FIXTURE_CAPTION');
    expect(turns[1]!.text).toContain('FIXTURE_FOLLOWUP');
    expect(turns[2]!.text).toContain('FIXTURE_CARE_TIPS');
  });
});

// ---------------------------------------------------------------------------
// AC5 — full multi-conversation export run, never reading attachment blobs.
// ---------------------------------------------------------------------------

describe('parseChatGptExport — full-file run over multiple conversations', () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'cm-04-export-test-'));
    filePath = path.join(tmpDir, 'conversations.json');
    const exportArray = [BASIC_CONVERSATION, BRANCHED_CONVERSATION, WITH_SECRET_CONVERSATION, MIXED_CONTENT_TYPE_CONVERSATION, EMPTY_CONVERSATION];
    writeFileSync(filePath, JSON.stringify(exportArray), 'utf8');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses every conversation in the top-level array into the shared ConversationTurn contract', async () => {
    const turns = await parseChatGptExport(filePath);
    // 4 (basic) + 4 (branched, active path only) + 4 (with-secret) + 3 (mixed) + 0 (empty) = 15.
    expect(turns).toHaveLength(15);
    expect(turns.every((t) => t.sourceType === 'chatgpt')).toBe(true);
    const sessionIds = new Set(turns.map((t) => t.sessionId));
    expect(sessionIds).toEqual(
      new Set([
        'fixture-basic-conversation-0001',
        'fixture-branched-conversation-0001',
        'fixture-with-secret-conversation-0001',
        'fixture-mixed-content-type-conversation-0001',
      ]),
    );
  });

  it('never surfaces an image-asset-pointer reference or its content anywhere in the full-export output', async () => {
    const turns = await parseChatGptExport(filePath);
    const serialized = JSON.stringify(turns);
    expect(serialized).not.toContain('FIXTURE_NEVER_READ_AS_TEXT');
    expect(serialized).not.toContain('sediment://');
  });

  it('rejects a top-level JSON shape that is not an array', async () => {
    const badFilePath = path.join(tmpDir, 'not-an-array.json');
    writeFileSync(badFilePath, JSON.stringify({ not: 'an array' }), 'utf8');
    await expect(parseChatGptExport(badFilePath)).rejects.toThrow(/expected a top-level JSON array/);
  });
});

// ---------------------------------------------------------------------------
// AC6 — quarantine flagging via cm-01's real scanForSecrets(), identical
// discipline to cm-03.
// ---------------------------------------------------------------------------

describe('parseChatGptConversation — quarantine flagging via cm-01\'s real scanForSecrets()', () => {
  it('flags the turn containing a real cm-01 fixture secret as quarantined, with the real match data attached', () => {
    const turns = parseChatGptConversation(WITH_SECRET_CONVERSATION);
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
    const turns = parseChatGptConversation(WITH_SECRET_CONVERSATION);
    const fixtureSecretValue = POSITIVE_FIXTURES.find((f) => f.id === 'openai-shaped-sk-key')!.secretValue;
    const anyUnflaggedSecret = turns.some((t) => !t.quarantined && t.text.includes(fixtureSecretValue));
    expect(anyUnflaggedSecret).toBe(false);
  });

  it('secretMatches never leaks the raw secret value itself (relies on cm-01\'s own redaction contract)', () => {
    const turns = parseChatGptConversation(WITH_SECRET_CONVERSATION);
    const secretTurn = turns.find((t) => t.quarantined)!;
    const serializedMatches = JSON.stringify(secretTurn.secretMatches);
    const fixtureSecretValue = POSITIVE_FIXTURES.find((f) => f.id === 'openai-shaped-sk-key')!.secretValue;
    expect(serializedMatches).not.toContain(fixtureSecretValue);
  });
});

// ---------------------------------------------------------------------------
// Structural-corruption loud failure (dangling node references).
// ---------------------------------------------------------------------------

describe('parseChatGptConversation — structurally corrupt conversations fail loudly', () => {
  it('throws when current_node names a node id absent from mapping', () => {
    expect(() => parseChatGptConversation(CORRUPTED_DANGLING_CURRENT_NODE_CONVERSATION)).toThrow(/node-does-not-exist/);
  });

  it('throws when a parent pointer partway up the chain names a node id absent from mapping', () => {
    expect(() => parseChatGptConversation(CORRUPTED_DANGLING_PARENT_CONVERSATION)).toThrow(/node-0-does-not-exist/);
  });
});
