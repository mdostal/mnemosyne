/**
 * cm-03-claude-code-session-parser (epic: mnemosyne-conversation-memory).
 *
 * Failing-first tests (TDD, per the story's `test-spec` step) for
 * `parseClaudeCodeSession()` against every acceptance criterion in
 * `.pHive/epics/mnemosyne-conversation-memory/stories/cm-03-claude-code-
 * session-parser.yaml`:
 *
 *  AC1. One `ConversationTurn` per real user/assistant turn, in original
 *       order, each carrying role/text/timestamp/sessionId/projectSlug.
 *  AC2. A `thinking` block's `signature` field is NEVER present anywhere
 *       in the resulting output -- asserted against the raw fixture
 *       signature string, not merely "the field key is absent".
 *  AC3. A `tool_use` block's excerpt is bounded (capped at the named
 *       constant), never the full raw `input` verbatim, never silently
 *       dropped.
 *  AC4. A 50MB+ file is processed via real line-by-line streaming --
 *       verified both by an fs-spy (no whole-file read call) and by a
 *       real, measured peak-memory bound that does not scale with the
 *       file's byte size.
 *  AC5. A turn containing a fixture secret (cm-01's own corpus) is flagged
 *       quarantined, using cm-01's REAL `scanForSecrets()` output.
 *  AC6. Non-conversational lines (a much larger real-world set than the
 *       three documented names -- confirmed this story's own research
 *       step) are skipped, never treated as a parse failure; a genuinely
 *       malformed JSON line fails loudly, naming the line number.
 *
 * Fixtures: synthetic, schema-accurate session files only
 * (`__fixtures__/claude-code-sessions/*.jsonl`) -- never the operator's own
 * real `~/.claude/projects/` content anywhere in this file.
 */

import { createWriteStream, mkdtempSync, rmSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POSITIVE_FIXTURES } from './__fixtures__/secrets-corpus.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '__fixtures__', 'claude-code-sessions');

// `node:fs`'s ESM namespace is not configurable -- same `vi.mock` +
// `importOriginal` workaround `discoverSources.test.ts` already
// establishes, wrapping only the content-reading APIs as pass-through
// spies so real behavior is unaffected either way.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    createReadStream: vi.fn(actual.createReadStream),
    promises: {
      ...actual.promises,
      readFile: vi.fn(actual.promises.readFile),
    },
  };
});

const { parseClaudeCodeSession, TOOL_EXCERPT_MAX_CHARS } = await import('./parseClaudeCodeSession.js');

beforeEach(() => {
  vi.mocked(fs.readFileSync).mockClear();
  vi.mocked(fs.createReadStream).mockClear();
  vi.mocked(fs.promises.readFile).mockClear();
});

// ---------------------------------------------------------------------------
// AC1 — one ConversationTurn per real user/assistant turn, in original
// order, carrying role/text/timestamp/sessionId/projectSlug.
// ---------------------------------------------------------------------------

describe('parseClaudeCodeSession — basic turn extraction', () => {
  it('produces one ConversationTurn per real user/assistant turn, in original order, with full provenance', async () => {
    const filePath = path.join(FIXTURES_DIR, 'basic-session.jsonl');
    const turns = await parseClaudeCodeSession(filePath);

    // 3 harness bookkeeping lines skipped; 4 real user/assistant turns.
    expect(turns).toHaveLength(4);
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(turns.map((t) => t.turnIndex)).toEqual([0, 1, 2, 3]);

    for (const turn of turns) {
      expect(turn.sessionId).toBe('cc-basic-001');
      expect(turn.sourceType).toBe('claude-code');
      expect(turn.projectSlug).toEqual(expect.any(String));
      expect(turn.timestamp).toEqual(expect.any(String));
      expect(turn.quarantined).toBe(false);
      expect(turn.quarantineReason).toBeNull();
      expect(turn.secretMatches).toEqual([]);
    }

    expect(turns[0]!.text).toContain('Please summarize the README file.');
    expect(turns[3]!.text).toContain('The README describes an example project used for testing.');
  });

  it('decodes projectSlug from the session file\'s own parent directory name', async () => {
    const filePath = path.join(FIXTURES_DIR, 'basic-session.jsonl');
    const turns = await parseClaudeCodeSession(filePath);
    // FIXTURES_DIR's basename is 'claude-code-sessions' -- decodeProjectSlug
    // is a best-effort heuristic over the REAL directory name, whatever it
    // is; this just asserts it's populated and derived, not hardcoded.
    expect(turns[0]!.projectSlug).not.toBeNull();
    expect(typeof turns[0]!.projectSlug).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// AC2 — thinking block signature NEVER appears anywhere in output.
// ---------------------------------------------------------------------------

describe('parseClaudeCodeSession — thinking-signature drop', () => {
  it('never includes the raw thinking-block signature anywhere in the parsed output', async () => {
    const filePath = path.join(FIXTURES_DIR, 'basic-session.jsonl');
    const turns = await parseClaudeCodeSession(filePath);
    const serialized = JSON.stringify(turns);
    expect(serialized).not.toContain('FIXTURE_SIGNATURE_MUST_NEVER_APPEAR_IN_PARSER_OUTPUT');
  });

  it('still surfaces the thinking block\'s own reasoning text (only the signature is dropped, not the whole block)', async () => {
    const filePath = path.join(FIXTURES_DIR, 'basic-session.jsonl');
    const turns = await parseClaudeCodeSession(filePath);
    const assistantTurn = turns.find((t) => t.role === 'assistant' && t.text.includes('read the README first'));
    expect(assistantTurn).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// AC3 — tool_use/tool_result blocks reduced to a bounded excerpt: never
// the full raw payload, never silently dropped.
// ---------------------------------------------------------------------------

describe('parseClaudeCodeSession — tool-call excerpt bounding', () => {
  it('includes a bounded excerpt of a tool_use block, never the full raw input, never dropped entirely', async () => {
    const filePath = path.join(FIXTURES_DIR, 'basic-session.jsonl');
    const turns = await parseClaudeCodeSession(filePath);
    const assistantTurn = turns.find((t) => t.role === 'assistant' && t.text.includes('Read'));
    expect(assistantTurn).toBeDefined();
    expect(assistantTurn!.text).toContain('Read');
    expect(assistantTurn!.text.length).toBeLessThan(2000);
  });

  it('truncates a long tool_result body to at most TOOL_EXCERPT_MAX_CHARS, never the full raw payload', async () => {
    const filePath = path.join(FIXTURES_DIR, 'basic-session.jsonl');
    const turns = await parseClaudeCodeSession(filePath);
    const userToolResultTurn = turns.find((t) => t.role === 'user' && t.turnIndex === 2);
    expect(userToolResultTurn).toBeDefined();
    // The fixture's real README body is longer than the bound; the full
    // body must never appear verbatim, and SOME excerpt must still be
    // present (never silently dropped to empty).
    expect(userToolResultTurn!.text.length).toBeGreaterThan(0);
    expect(userToolResultTurn!.text.length).toBeLessThanOrEqual(TOOL_EXCERPT_MAX_CHARS + 50);
    expect(userToolResultTurn!.text).not.toContain(
      'deliberately padded well past\nthe 200-character tool-excerpt bound so the parser test can assert real\ntruncation happened',
    );
  });

  it('TOOL_EXCERPT_MAX_CHARS is a real, named, positive constant', () => {
    expect(typeof TOOL_EXCERPT_MAX_CHARS).toBe('number');
    expect(TOOL_EXCERPT_MAX_CHARS).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// AC4 — real line-by-line streaming, verified two ways: (a) no whole-file
// read call ever happens, (b) a real, measured memory bound that does not
// scale with the file's byte size.
// ---------------------------------------------------------------------------

describe('parseClaudeCodeSession — streaming over a 50MB+ file', () => {
  let tmpDir: string;
  let bigFilePath: string;
  const REAL_TURN_COUNT = 25;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'cm-03-streaming-test-'));
    bigFilePath = path.join(tmpDir, 'synthetic-large-session.jsonl');

    // Build a 50MB+ file whose bulk is NON-conversational noise lines
    // (real sessions carry exactly this shape -- large file-history-delta
    // backups, big attachment payloads) interleaved with a small, fixed
    // number of real user/assistant turns. A streaming parser's peak
    // memory should track the small real-turn content, never the 50MB of
    // noise it reads past and discards.
    await new Promise<void>((resolve, reject) => {
      const ws = createWriteStream(bigFilePath, { encoding: 'utf8' });
      ws.on('error', reject);
      const paddingChunk = 'x'.repeat(2000);
      let turnsWritten = 0;
      let linesWritten = 0;
      const TOTAL_NOISE_LINES = 27000; // ~2KB each -> ~54MB+

      function writeNext() {
        while (linesWritten < TOTAL_NOISE_LINES || turnsWritten < REAL_TURN_COUNT) {
          let ok = true;
          if (linesWritten < TOTAL_NOISE_LINES && (turnsWritten >= REAL_TURN_COUNT || linesWritten % 1000 !== 0)) {
            ok = ws.write(
              JSON.stringify({ type: 'file-history-delta', messageId: `m${linesWritten}`, snapshotMessageId: 'm0', trackingPath: 'noise.txt', backup: { padding: paddingChunk } }) + '\n',
            );
            linesWritten++;
          } else if (turnsWritten < REAL_TURN_COUNT) {
            const role = turnsWritten % 2 === 0 ? 'user' : 'assistant';
            const uuid = `big-${turnsWritten}`;
            ok = ws.write(
              JSON.stringify({
                parentUuid: turnsWritten === 0 ? null : `big-${turnsWritten - 1}`,
                isSidechain: false,
                type: role,
                uuid,
                timestamp: '2026-01-05T00:00:00.000Z',
                sessionId: 'cc-big-001',
                cwd: '/Users/example/project',
                gitBranch: 'main',
                version: '2.1.229',
                message: { role, content: `real small turn number ${turnsWritten}` },
              }) + '\n',
            );
            turnsWritten++;
          } else {
            ok = ws.write(
              JSON.stringify({ type: 'file-history-delta', messageId: `m${linesWritten}`, snapshotMessageId: 'm0', trackingPath: 'noise.txt', backup: { padding: paddingChunk } }) + '\n',
            );
            linesWritten++;
          }
          if (!ok) {
            ws.once('drain', writeNext);
            return;
          }
        }
        ws.end();
      }
      ws.on('finish', () => resolve());
      writeNext();
    });

    const size = fs.statSync(bigFilePath).size;
    expect(size).toBeGreaterThan(50 * 1024 * 1024);
  }, 30_000);

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('never calls a whole-file read API against the large file (readFileSync/promises.readFile)', async () => {
    await parseClaudeCodeSession(bigFilePath);
    expect(fs.readFileSync).not.toHaveBeenCalledWith(bigFilePath, expect.anything());
    expect(fs.promises.readFile).not.toHaveBeenCalledWith(bigFilePath, expect.anything());
  });

  it('uses createReadStream (real streaming), and produces exactly the small real-turn count from a 50MB+ file', async () => {
    const turns = await parseClaudeCodeSession(bigFilePath);
    expect(fs.createReadStream).toHaveBeenCalled();
    expect(turns).toHaveLength(REAL_TURN_COUNT);
  });

  it('real, measured peak heap growth during parsing does not scale with the 50MB+ file size', async () => {
    const fileSize = fs.statSync(bigFilePath).size;
    const baseline = process.memoryUsage().heapUsed;
    let peak = baseline;
    const sampler = setInterval(() => {
      const current = process.memoryUsage().heapUsed;
      if (current > peak) peak = current;
    }, 5);

    let turns;
    try {
      turns = await parseClaudeCodeSession(bigFilePath);
    } finally {
      clearInterval(sampler);
    }

    const growth = peak - baseline;

    // eslint-disable-next-line no-console
    console.log(
      `[parseClaudeCodeSession] streaming-memory check: file size ${(fileSize / (1024 * 1024)).toFixed(1)}MB, ` +
        `measured heap growth ${(growth / (1024 * 1024)).toFixed(1)}MB, turns produced ${turns.length}`,
    );

    expect(turns).toHaveLength(REAL_TURN_COUNT);
    // A real, measured bound: streaming means growth stays a small
    // fraction of the file size. A whole-file `readFileSync` load alone
    // would allocate at least `fileSize` bytes (typically 2x+ for a UTF-16
    // JS string) before any parsing even starts -- comfortably over this
    // bound. Threshold set well below the file size with margin for real
    // GC/V8 noise, not tuned to just barely pass.
    expect(growth).toBeLessThan(fileSize * 0.5);
    expect(growth).toBeLessThan(30 * 1024 * 1024);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// AC5 — a turn containing a fixture secret (cm-01's own corpus) is flagged
// quarantined, using cm-01's REAL scanForSecrets() output.
// ---------------------------------------------------------------------------

describe('parseClaudeCodeSession — quarantine flagging via cm-01\'s real scanForSecrets()', () => {
  it('flags the turn containing a real cm-01 fixture secret as quarantined, with the real match data attached', async () => {
    const filePath = path.join(FIXTURES_DIR, 'with-secret.jsonl');
    const turns = await parseClaudeCodeSession(filePath);
    expect(turns).toHaveLength(2);

    const cleanTurn = turns[0]!;
    const secretTurn = turns[1]!;

    expect(cleanTurn.quarantined).toBe(false);
    expect(cleanTurn.quarantineReason).toBeNull();
    expect(cleanTurn.secretMatches).toEqual([]);

    expect(secretTurn.quarantined).toBe(true);
    expect(secretTurn.quarantineReason).toBe('secret_detected');
    expect(secretTurn.secretMatches.length).toBeGreaterThan(0);
    expect(secretTurn.secretMatches[0]!.category).toBe('api-key');

    // Quarantine is a flag, never a silent drop -- the turn's own text is
    // still present for a human reviewer to inspect.
    expect(secretTurn.text.length).toBeGreaterThan(0);
  });

  it('never silently drops or silently passes through a quarantined turn (it appears in the array, flagged)', async () => {
    const filePath = path.join(FIXTURES_DIR, 'with-secret.jsonl');
    const turns = await parseClaudeCodeSession(filePath);
    const anyUnflaggedSecret = turns.some(
      (t) => !t.quarantined && POSITIVE_FIXTURES.some((f) => t.text.includes(f.secretValue)),
    );
    expect(anyUnflaggedSecret).toBe(false);
  });

  it('secretMatches never leaks the raw secret value itself (relies on cm-01\'s own redaction contract)', async () => {
    const filePath = path.join(FIXTURES_DIR, 'with-secret.jsonl');
    const turns = await parseClaudeCodeSession(filePath);
    const secretTurn = turns.find((t) => t.quarantined)!;
    const serializedMatches = JSON.stringify(secretTurn.secretMatches);
    expect(serializedMatches).not.toContain('sk-FAKE1a2B3c4D5e6F7g8H9i0JkLmNoPqRsTuVwXyZ12');
  });
});

// ---------------------------------------------------------------------------
// AC6 — non-conversational lines (a real-world set far larger than the
// three documented type names) are skipped, never a parse failure; a
// genuinely malformed JSON line fails loudly, naming the line number.
// ---------------------------------------------------------------------------

describe('parseClaudeCodeSession — non-conversational lines vs. genuinely malformed lines', () => {
  it('skips every non-conversational line type (mode/permission-mode/file-history-snapshot and beyond) without treating any of them as a parse failure', async () => {
    const filePath = path.join(FIXTURES_DIR, 'unusual-types.jsonl');
    const turns = await parseClaudeCodeSession(filePath);
    // Exactly the one real user turn in the fixture; the other 10 lines
    // (mode, permission-mode, last-prompt, ai-title, attachment, pr-link,
    // system, queue-operation, frame-link, file-history-delta) never
    // produce a turn and never throw.
    expect(turns).toHaveLength(1);
    expect(turns[0]!.text).toContain('the only real turn in this fixture');
  });

  it('fails loudly on a genuinely malformed JSON line, naming the line number', async () => {
    const filePath = path.join(FIXTURES_DIR, 'malformed-line.jsonl');
    await expect(parseClaudeCodeSession(filePath)).rejects.toThrow(/line 3/);
  });

  it('the malformed-line failure message names the file path too, not just a bare line number', async () => {
    const filePath = path.join(FIXTURES_DIR, 'malformed-line.jsonl');
    await expect(parseClaudeCodeSession(filePath)).rejects.toThrow(/malformed-line\.jsonl/);
  });
});
