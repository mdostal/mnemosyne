/**
 * cm-05-usefulness-trash-triage (epic: mnemosyne-conversation-memory).
 *
 * Failing-first tests (TDD) for `triageSession.ts`. Every test runs against
 * a STUBBED `TriageLlmClient` (never the real `geminiClient.ts`-backed
 * client, never a live Gemini call), mirroring `ingestDocument.test.ts`'s
 * own fake-client convention. Uses synthetic `ConversationTurn[]` fixtures,
 * never a real session file.
 *
 * Covers this story's own acceptance criteria: heuristic-score determinism,
 * bounded-input enforcement at the prompt-construction layer, exactly-
 * three-way verdict parsing, append-only queue-file recording of EVERY
 * verdict (including `keep`), quarantined-content exclusion from the LLM
 * prompt, and (by inspection, see this file's own dedicated describe
 * block) that no code path here ever touches a source file for
 * delete/truncate/modify.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConversationTurn } from './types.js';
import {
  MAX_TRIAGE_INPUT_CHARS,
  TriageError,
  buildTriagePrompt,
  computeHeuristicScore,
  parseTriageResponse,
  triageSession,
  type TriageLlmClient,
} from './triageSession.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTurn(overrides: Partial<ConversationTurn> = {}): ConversationTurn {
  return {
    sessionId: 'session-abc',
    sourceType: 'claude-code',
    role: 'user',
    text: 'hello',
    timestamp: '2026-08-20T10:00:00.000Z',
    projectSlug: '/Users/mdostal/Code/example',
    turnIndex: 0,
    quarantined: false,
    quarantineReason: null,
    secretMatches: [],
    ...overrides,
  };
}

function realisticSessionTurns(): ConversationTurn[] {
  return [
    makeTurn({ turnIndex: 0, role: 'user', text: 'Can you help me refactor the auth module?', timestamp: '2026-08-20T10:00:00.000Z' }),
    makeTurn({ turnIndex: 1, role: 'assistant', text: 'Sure, let me look at the code.\n\n[tool_use:Read] {"file":"auth.ts"}', timestamp: '2026-08-20T10:01:00.000Z' }),
    makeTurn({ turnIndex: 2, role: 'assistant', text: '[tool_result] file contents here', timestamp: '2026-08-20T10:01:05.000Z' }),
    makeTurn({ turnIndex: 3, role: 'assistant', text: "I've refactored the module to use a shared validator.", timestamp: '2026-08-20T10:15:00.000Z' }),
  ];
}

/** A stub client whose classify() is fully caller-scripted; records every prompt it was called with. */
function scriptedClient(responses: unknown[]): { client: TriageLlmClient; prompts: string[] } {
  const prompts: string[] = [];
  let i = 0;
  const client: TriageLlmClient = {
    classify(prompt: string) {
      prompts.push(prompt);
      const response = responses[Math.min(i, responses.length - 1)];
      i++;
      return Promise.resolve(response);
    },
  };
  return { client, prompts };
}

let tmpDir: string;
let queuePath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'cm05-triage-test-'));
  queuePath = path.join(tmpDir, 'conversation-triage-queue.jsonl');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function readQueueEntries(): unknown[] {
  const raw = readFileSync(queuePath, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

// ---------------------------------------------------------------------------
// AC1 — heuristic prefilter determinism
// ---------------------------------------------------------------------------

describe('computeHeuristicScore() — deterministic priority score', () => {
  it('produces the SAME score for the SAME input, called repeatedly', () => {
    const turns = realisticSessionTurns();
    const first = computeHeuristicScore(turns);
    const second = computeHeuristicScore(turns);
    const third = computeHeuristicScore(JSON.parse(JSON.stringify(turns)));
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it('never produces NaN/Infinity for an empty turn list', () => {
    const result = computeHeuristicScore([]);
    expect(Number.isFinite(result.priorityScore)).toBe(true);
  });

  it('flags a single-slash-command session as the strong low-signal candidate (design-discussion §2.5)', () => {
    const turns = [
      makeTurn({ turnIndex: 0, role: 'user', text: '/compact', timestamp: '2026-08-20T10:00:00.000Z' }),
      makeTurn({ turnIndex: 1, role: 'assistant', text: 'Compacted.', timestamp: '2026-08-20T10:00:01.000Z' }),
    ];
    const result = computeHeuristicScore(turns);
    expect(result.signals.looksLikeSingleSlashCommand).toBe(true);
    expect(result.priorityScore).toBe(0);
  });

  it('computes a real, non-zero elapsed span from first to last real timestamp', () => {
    const turns = realisticSessionTurns();
    const result = computeHeuristicScore(turns);
    expect(result.signals.elapsedMs).toBe(15 * 60 * 1000); // 10:00:00 -> 10:15:00
  });

  it('computes turnCount and a real tool-to-text ratio from structural signals alone', () => {
    const turns = realisticSessionTurns();
    const result = computeHeuristicScore(turns);
    expect(result.signals.turnCount).toBe(4);
    // 2 tool-activity turns (indices 1,2 contain tool markers), 2 non-tool turns.
    expect(result.signals.toolToTextRatio).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AC2 — bounded LLM input
// ---------------------------------------------------------------------------

describe('buildTriagePrompt() — bounded input', () => {
  it('never exceeds maxChars, regardless of source session size', () => {
    const hugeTurns: ConversationTurn[] = Array.from({ length: 5000 }, (_, i) =>
      makeTurn({ turnIndex: i, role: i % 2 === 0 ? 'user' : 'assistant', text: 'x'.repeat(500), timestamp: null }),
    );
    const prompt = buildTriagePrompt(hugeTurns, MAX_TRIAGE_INPUT_CHARS);
    expect(prompt.length).toBeLessThanOrEqual(MAX_TRIAGE_INPUT_CHARS);
  });

  it('respects an arbitrary caller-supplied cap, not just the module default', () => {
    const turns = realisticSessionTurns();
    const prompt = buildTriagePrompt(turns, 50);
    expect(prompt.length).toBeLessThanOrEqual(50);
  });
});

describe('triageSession() — the LLM call is never made with input exceeding the cap', () => {
  it('the prompt handed to client.classify() never exceeds MAX_TRIAGE_INPUT_CHARS for a huge synthetic session', async () => {
    const hugeTurns: ConversationTurn[] = Array.from({ length: 20000 }, (_, i) =>
      makeTurn({ turnIndex: i, role: i % 2 === 0 ? 'user' : 'assistant', text: 'y'.repeat(1000), timestamp: null, sessionId: 'huge-session' }),
    );
    const { client, prompts } = scriptedClient([{ verdict: 'uncertain', summary: 's', rationale: 'r' }]);

    await triageSession({ turns: hugeTurns, client, queuePath });

    expect(prompts.length).toBe(1);
    expect(prompts[0]!.length).toBeLessThanOrEqual(MAX_TRIAGE_INPUT_CHARS);
  });
});

// ---------------------------------------------------------------------------
// AC3 — exactly one of keep/trash/uncertain, never a fourth value
// ---------------------------------------------------------------------------

describe('parseTriageResponse() — verdict is exactly one of keep/trash/uncertain', () => {
  it.each(['keep', 'trash', 'uncertain'])('accepts the real, valid verdict %s', (verdict) => {
    const result = parseTriageResponse({ verdict, summary: 's', rationale: 'r' });
    expect(result.verdict).toBe(verdict);
  });

  it('throws loudly for a fourth/invented value, never coercing it to a valid one', () => {
    expect(() => parseTriageResponse({ verdict: 'maybe', summary: 's', rationale: 'r' })).toThrow(TriageError);
  });

  it('throws loudly when verdict is missing entirely, never defaulting silently', () => {
    expect(() => parseTriageResponse({ summary: 's', rationale: 'r' })).toThrow(TriageError);
  });

  it('throws loudly when the response is not even an object', () => {
    expect(() => parseTriageResponse('keep')).toThrow(TriageError);
    expect(() => parseTriageResponse(null)).toThrow(TriageError);
    expect(() => parseTriageResponse(undefined)).toThrow(TriageError);
  });
});

describe('triageSession() — a malformed verdict fails loudly, never a silent default', () => {
  it('rejects rather than silently recording a guessed verdict', async () => {
    const { client } = scriptedClient([{ verdict: 'not-a-real-verdict', summary: 's', rationale: 'r' }]);
    await expect(triageSession({ turns: realisticSessionTurns(), client, queuePath })).rejects.toThrow(TriageError);
    // Nothing should have been recorded for a call that never produced a
    // real verdict.
    expect(() => readFileSync(queuePath, 'utf8')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC4 + AC5 — the queue file records EVERY verdict (keep included),
// append-only.
// ---------------------------------------------------------------------------

describe('triageSession() — queue file recording', () => {
  it('records a trash verdict to the on-disk queue file', async () => {
    const { client } = scriptedClient([{ verdict: 'trash', summary: 'low signal', rationale: 'just a typo fix' }]);
    await triageSession({ turns: realisticSessionTurns(), client, queuePath });

    const entries = readQueueEntries() as Array<{ verdict: string; summary: string; rationale: string }>;
    expect(entries.length).toBe(1);
    expect(entries[0]!.verdict).toBe('trash');
    expect(entries[0]!.summary).toBe('low signal');
    expect(entries[0]!.rationale).toBe('just a typo fix');
  });

  it('records an uncertain verdict to the on-disk queue file', async () => {
    const { client } = scriptedClient([{ verdict: 'uncertain', summary: 'unclear', rationale: 'mixed signals' }]);
    await triageSession({ turns: realisticSessionTurns(), client, queuePath });

    const entries = readQueueEntries() as Array<{ verdict: string }>;
    expect(entries[0]!.verdict).toBe('uncertain');
  });

  it('ALSO records a keep verdict -- the queue is a complete record, not merely an exception list (AC5)', async () => {
    const { client } = scriptedClient([{ verdict: 'keep', summary: 'real design decision', rationale: 'durable and useful' }]);
    await triageSession({ turns: realisticSessionTurns(), client, queuePath });

    const entries = readQueueEntries() as Array<{ verdict: string }>;
    expect(entries.length).toBe(1);
    expect(entries[0]!.verdict).toBe('keep');
  });

  it('is append-only: a second triageSession() call adds a NEW entry, never overwriting the first', async () => {
    const { client: client1 } = scriptedClient([{ verdict: 'keep', summary: 'first', rationale: 'r1' }]);
    await triageSession({ turns: realisticSessionTurns(), client: client1, queuePath });

    const { client: client2 } = scriptedClient([{ verdict: 'trash', summary: 'second', rationale: 'r2' }]);
    await triageSession({ turns: realisticSessionTurns().map((t) => ({ ...t, sessionId: 'session-xyz' })), client: client2, queuePath });

    const entries = readQueueEntries() as Array<{ sessionId: string; summary: string }>;
    expect(entries.length).toBe(2);
    expect(entries[0]!.summary).toBe('first');
    expect(entries[0]!.sessionId).toBe('session-abc');
    expect(entries[1]!.summary).toBe('second');
    expect(entries[1]!.sessionId).toBe('session-xyz');
  });

  it('carries the session id/source path/size for provenance (cross_cutting: provenance-completeness)', async () => {
    const { client } = scriptedClient([{ verdict: 'keep', summary: 's', rationale: 'r' }]);
    await triageSession({
      turns: realisticSessionTurns(),
      client,
      queuePath,
      sourcePath: '/Users/mdostal/.claude/projects/-Users-mdostal-Code-example/session-abc.jsonl',
      sizeBytes: 123456,
    });

    const entries = readQueueEntries() as Array<{ sessionId: string; sourcePath: string; sizeBytes: number }>;
    expect(entries[0]!.sessionId).toBe('session-abc');
    expect(entries[0]!.sourcePath).toBe('/Users/mdostal/.claude/projects/-Users-mdostal-Code-example/session-abc.jsonl');
    expect(entries[0]!.sizeBytes).toBe(123456);
  });
});

// ---------------------------------------------------------------------------
// AC7 — quarantined content is structurally EXCLUDED from the LLM prompt.
// ---------------------------------------------------------------------------

describe('quarantine exclusion — quarantined turn text never reaches the LLM prompt', () => {
  const secretText = 'sk-thisIsAFakeButRealisticLookingSecretValue1234567890';

  it('excludes a quarantined turn entirely from buildTriagePrompt() output', () => {
    const turns = [
      makeTurn({ turnIndex: 0, role: 'user', text: 'here is my api key ' + secretText, quarantined: true, quarantineReason: 'secret_detected' }),
      makeTurn({ turnIndex: 1, role: 'assistant', text: 'Got it, noted.' }),
    ];
    const prompt = buildTriagePrompt(turns, MAX_TRIAGE_INPUT_CHARS);
    expect(prompt).not.toContain(secretText);
    expect(prompt).not.toContain('here is my api key');
    expect(prompt).toContain('Got it, noted.');
  });

  it('excludes quarantined turns from the actual prompt sent to client.classify() end-to-end', async () => {
    const turns = [
      makeTurn({ turnIndex: 0, role: 'user', text: 'connection string: postgres://admin:' + secretText + '@db.example.com/prod', quarantined: true, quarantineReason: 'secret_detected' }),
      makeTurn({ turnIndex: 1, role: 'assistant', text: 'Understood, will not log that.' }),
    ];
    const { client, prompts } = scriptedClient([{ verdict: 'keep', summary: 's', rationale: 'r' }]);

    await triageSession({ turns, client, queuePath });

    expect(prompts[0]).not.toContain(secretText);
  });

  it('a session consisting ONLY of quarantined turns still triages (prompt has zero transcript content, never crashes)', async () => {
    const turns = [makeTurn({ turnIndex: 0, role: 'user', text: 'token=' + secretText, quarantined: true, quarantineReason: 'secret_detected' })];
    const { client, prompts } = scriptedClient([{ verdict: 'uncertain', summary: 'nothing usable', rationale: 'all quarantined' }]);

    const result = await triageSession({ turns, client, queuePath });

    expect(prompts[0]).not.toContain(secretText);
    expect(result.verdict).toBe('uncertain');
  });
});

// ---------------------------------------------------------------------------
// AC6 — no delete/truncate/modify of a source session file, and no delete
// of already-persisted memory, anywhere in this module. (Structural
// self-check: this module's own public surface never accepts anything
// resembling a "delete" verb, and never opens `sourcePath` for writing --
// see the full independent review pass for the exhaustive diff-level
// check; this test guards the observable behavior.)
// ---------------------------------------------------------------------------

describe('no-delete guarantee', () => {
  it('never touches the file at sourcePath in any way -- a nonexistent sourcePath does not error', async () => {
    const { client } = scriptedClient([{ verdict: 'trash', summary: 's', rationale: 'r' }]);
    // sourcePath deliberately points at a file that does not exist --
    // triageSession() must never open it (read OR write); if it did, this
    // call would throw ENOENT.
    await expect(
      triageSession({ turns: realisticSessionTurns(), client, queuePath, sourcePath: '/nonexistent/path/does-not-exist.jsonl' }),
    ).resolves.toBeDefined();
  });

  it('exposes no exported function whose name suggests deletion/truncation of source or persisted memory', async () => {
    const mod = await import('./triageSession.js');
    const exportedNames = Object.keys(mod);
    for (const name of exportedNames) {
      expect(name.toLowerCase()).not.toMatch(/delete|unlink|truncate|purge|wipe/);
    }
  });
});
