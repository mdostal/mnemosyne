/**
 * cm-07-distillation-and-persist (epic: mnemosyne-conversation-memory).
 *
 * Failing-first tests (TDD) for `distillAndRemember.ts` against a FAKE
 * `IngestClient` only -- never a live Qdrant write (this story's own hard
 * constraint). `ingestDocument.js`, `geminiClient.js`, and `scanForSecrets.js`
 * are module-mocked with `vi.mock(..., importOriginal)`, wrapping the REAL
 * implementation in `vi.fn()` (mirrors `ingestDocument.test.ts`'s own
 * `unpdf` mock and `clusterConversations.test.ts`'s own `node:fs`/
 * `node:child_process` mocks) -- this makes every call OBSERVABLE (call
 * count, call order, call args) while behavior stays byte-for-byte real,
 * never a hand-rolled reimplementation standing in for the genuine module.
 *
 * Covers this story's round-4 acceptance criteria (see
 * `.pHive/epics/mnemosyne-conversation-memory/stories/
 * cm-07-distillation-and-persist.yaml`):
 *  1. Bounded entry count (MAX_TOTAL_ENTRIES_PER_SESSION), never one entry
 *     per raw chunk.
 *  2. cm-01's real scanForSecrets() called IMMEDIATELY BEFORE each entry's
 *     own ingestDocument() call -- real call-order instrumentation via
 *     vitest's own `mock.invocationCallOrder`, not a comment.
 *  3. A scan match quarantines THAT entry only; the run continues.
 *  4. scope: 'intake' UNCONDITIONALLY + full provenance-metadata contract
 *     (source/chat_source/session_id/project_slug/cluster_id/entry_id) on
 *     every successfully persisted entry.
 *  5. ingestDocument() called UNCHANGED (real module, real internal chunk
 *     logic observably ran).
 *  6. open_question entries are distinctly tagged (entry_type).
 *  7. Exactly ONE call to the real, shared geminiClient.ts primitive for a
 *     keep/uncertain session.
 *  8. geminiClient.ts's real callGemini is NEVER invoked for a trash-verdict
 *     session.
 *  9. scope is exactly 'intake' for every fixture case, no code path
 *     capable of anything else (also a static source-text self-check).
 *  10. metadata.entry_id is a real UUID, distinct from content_hash.
 *  11. resolved_scope_candidate is genuinely inert pass-through (identical
 *      remember() behavior whether null or a real matched candidate).
 *  Plus: real-constant-derived byte-bound proofs (CHUNK_SIZE_BYTES/
 *  MAX_INGEST_BYTES, read directly from ingestDocument.ts, not assumed).
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Content, RememberResult, Scope } from '../interfaces.js';
import type { ResolvedScopeCandidate } from './clusterConversations.js';
import type { ConversationTurn } from './types.js';

// ---------------------------------------------------------------------------
// Module mocks -- wrap the REAL implementation in vi.fn() so every call is
// observable (count/order/args) while behavior is genuinely unchanged.
// Hoisted by vitest to the top of the file automatically.
// ---------------------------------------------------------------------------

vi.mock('./scanForSecrets.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./scanForSecrets.js')>();
  return { ...actual, scanForSecrets: vi.fn(actual.scanForSecrets) };
});

vi.mock('../ingest/ingestDocument.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ingest/ingestDocument.js')>();
  return { ...actual, ingestDocument: vi.fn(actual.ingestDocument) };
});

vi.mock('./geminiClient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./geminiClient.js')>();
  return { ...actual, callGemini: vi.fn(actual.callGemini) };
});

import { CHUNK_SIZE_BYTES, MAX_INGEST_BYTES, ingestDocument, type IngestClient } from '../ingest/ingestDocument.js';
import { callGemini, type CallGeminiResult, type FetchInit, type FetchResponseLike } from './geminiClient.js';
import { scanForSecrets } from './scanForSecrets.js';
import {
  DistillationError,
  MAX_ENTRY_FINAL_TEXT_BYTES,
  MAX_EXTRACTION_INPUT_CHARS,
  MAX_DECISION_ENTRIES,
  MAX_OPEN_QUESTION_ENTRIES,
  MAX_TOTAL_ENTRIES_PER_SESSION,
  buildExtractionPrompt,
  buildProvenanceHeader,
  createDefaultExtractionLlmClient,
  distillAndRemember,
  parseExtractionResponse,
  parseProvenanceHeader,
  type DistillAndRememberOptions,
  type ExtractionLlmClient,
  type ExtractionResult,
} from './distillAndRemember.js';

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
    makeTurn({ turnIndex: 0, role: 'user', text: 'Can you help me refactor the auth module?' }),
    makeTurn({ turnIndex: 1, role: 'assistant', text: "Sure -- I've refactored it to use a shared validator." }),
  ];
}

function successResult(overrides: Partial<RememberResult> = {}): RememberResult {
  return {
    ok: true,
    layer: 'vector',
    provenance: {
      layer: 'vector',
      source: `fake:point:${randomUUID()}`,
      chunk_span: { index: 0 },
      index_timestamp: '2026-08-27T00:00:00.000Z',
      content_hash: 'deadbeef',
      embedder: 'fake-embedder',
      retrieval_time: null,
    },
    ...overrides,
  } as RememberResult;
}

interface RememberCall {
  content: Content;
  scope: Scope;
}

/** Fake IngestClient -- never a live Qdrant write. Records every remember() call. */
function makeFakeIngestClient(): { client: IngestClient; calls: RememberCall[] } {
  const calls: RememberCall[] = [];
  const client: IngestClient = {
    async remember(content: Content, scope: Scope): Promise<RememberResult> {
      calls.push({ content, scope });
      return successResult();
    },
  };
  return { client, calls };
}

/** Scripted ExtractionLlmClient -- mirrors triageSession.test.ts's scriptedClient() convention. */
function scriptedExtraction(responses: ExtractionResult[]): { llmClient: ExtractionLlmClient; prompts: string[] } {
  const prompts: string[] = [];
  let i = 0;
  const llmClient: ExtractionLlmClient = {
    extract(prompt: string) {
      prompts.push(prompt);
      const response = responses[Math.min(i, responses.length - 1)];
      i++;
      return Promise.resolve(response);
    },
  };
  return { llmClient, prompts };
}

/** Deterministic, resettable UUID-shaped id generator for tests that need reproducible entry_ids across two separate distillAndRemember() calls. */
function makeSequentialIdGenerator(prefix = 'entry'): () => string {
  let n = 0;
  return () => `${prefix}-${n++}`;
}

let tmpDir: string;
let quarantineQueuePath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'cm07-distill-test-'));
  quarantineQueuePath = path.join(tmpDir, 'conversation-triage-queue.jsonl');
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function readQuarantineEntries(): unknown[] {
  const raw = readFileSync(quarantineQueuePath, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function baseOptions(overrides: Partial<DistillAndRememberOptions> = {}): DistillAndRememberOptions {
  const { client } = makeFakeIngestClient();
  return {
    sessionId: 'session-abc',
    chatSource: 'claude-code',
    turns: realisticSessionTurns(),
    verdict: 'keep',
    summary: 'Refactored the auth module to use a shared validator.',
    projectSlug: '/Users/mdostal/Code/example',
    clusterId: 'cluster-0',
    resolvedScopeCandidate: null,
    client,
    quarantineQueuePath,
    now: () => new Date('2026-08-27T12:00:00.000Z'),
    ...overrides,
  };
}

const SECRET_TEXT = 'sk-thisIsAFakeButRealisticLookingSecretValue1234567890';

// ---------------------------------------------------------------------------
// AC1 -- bounded entry count
// ---------------------------------------------------------------------------

describe('distillAndRemember() -- bounded entry count (AC1)', () => {
  it('produces exactly MAX_TOTAL_ENTRIES_PER_SESSION entries when the LLM returns FAR more than the bound', async () => {
    const { llmClient } = scriptedExtraction([
      {
        decisions: Array.from({ length: 50 }, (_, i) => `decision ${i}`),
        openQuestions: Array.from({ length: 50 }, (_, i) => `question ${i}`),
      },
    ]);
    const { client, calls } = makeFakeIngestClient();

    const result = await distillAndRemember(baseOptions({ client, llmClient }));

    expect(result.entries.length).toBe(MAX_TOTAL_ENTRIES_PER_SESSION);
    expect(result.entries.filter((e) => e.metadata.entry_type === 'decision').length).toBe(MAX_DECISION_ENTRIES);
    expect(result.entries.filter((e) => e.metadata.entry_type === 'open_question').length).toBe(MAX_OPEN_QUESTION_ENTRIES);
    expect(result.entries.filter((e) => e.metadata.entry_type === 'summary').length).toBe(1);
    expect(calls.length).toBe(MAX_TOTAL_ENTRIES_PER_SESSION);
  });

  it('produces exactly one summary entry even when the LLM returns zero decisions/open-questions', async () => {
    const { llmClient } = scriptedExtraction([{ decisions: [], openQuestions: [] }]);

    const result = await distillAndRemember(baseOptions({ llmClient }));

    expect(result.entries.length).toBe(1);
    expect(result.entries[0]!.metadata.entry_type).toBe('summary');
  });

  it('never produces one entry per raw chunk -- MAX_TOTAL_ENTRIES_PER_SESSION * MAX_ENTRY_FINAL_TEXT_BYTES stays tiny relative to MAX_INGEST_BYTES (the ~12,500-chunk worst case this story exists to avoid)', () => {
    const worstCaseTotalBytes = MAX_TOTAL_ENTRIES_PER_SESSION * MAX_ENTRY_FINAL_TEXT_BYTES;
    expect(worstCaseTotalBytes).toBeLessThan(MAX_INGEST_BYTES);
  });
});

// ---------------------------------------------------------------------------
// AC2 -- persist-time scan called IMMEDIATELY BEFORE each remember() call
// (real call-order instrumentation).
// ---------------------------------------------------------------------------

describe('distillAndRemember() -- persist-time scan call order (AC2)', () => {
  it('calls scanForSecrets() immediately before each entry\'s own ingestDocument() call, verified via real invocation-order instrumentation (vitest mock.invocationCallOrder), never merely asserted present', async () => {
    const { llmClient } = scriptedExtraction([{ decisions: ['decision one', 'decision two'], openQuestions: ['question one'] }]);
    const { client } = makeFakeIngestClient();

    await distillAndRemember(baseOptions({ client, llmClient }));

    const scanOrder = vi.mocked(scanForSecrets).mock.invocationCallOrder;
    const ingestOrder = vi.mocked(ingestDocument).mock.invocationCallOrder;

    // summary + 2 decisions + 1 open-question = 4 entries.
    expect(scanOrder.length).toBe(4);
    expect(ingestOrder.length).toBe(4);

    // Strict interleaving: scan[i] < ingest[i], and scan[i] > ingest[i-1] --
    // i.e. scan0, ingest0, scan1, ingest1, ... never scan0, scan1, ingest0,
    // ingest1 (which would prove batched-upfront scanning, not
    // immediately-before-each-persist-call discipline).
    for (let i = 0; i < scanOrder.length; i++) {
      expect(scanOrder[i]!).toBeLessThan(ingestOrder[i]!);
      if (i > 0) {
        expect(scanOrder[i]!).toBeGreaterThan(ingestOrder[i - 1]!);
      }
    }
  });

  it('scans the FINAL distilled text (post provenance-header-wrap) -- the exact string handed to ingestDocument()', async () => {
    const { llmClient } = scriptedExtraction([{ decisions: ['a real decision'], openQuestions: [] }]);
    const { client, calls } = makeFakeIngestClient();

    await distillAndRemember(baseOptions({ client, llmClient }));

    const scanCalls = vi.mocked(scanForSecrets).mock.calls;
    expect(scanCalls.length).toBe(calls.length);
    for (let i = 0; i < calls.length; i++) {
      expect(scanCalls[i]![0]).toBe(calls[i]!.content.text);
    }
  });
});

// ---------------------------------------------------------------------------
// AC3 -- a scan match quarantines THAT entry only; the run continues.
// ---------------------------------------------------------------------------

describe('distillAndRemember() -- quarantine-then-continue (AC3)', () => {
  it('quarantines only the matching entry; remember() is never called for it, but IS called for every other entry', async () => {
    const { llmClient } = scriptedExtraction([
      { decisions: ['a clean decision', 'leaked key: ' + SECRET_TEXT, 'another clean decision'], openQuestions: [] },
    ]);
    const { client, calls } = makeFakeIngestClient();

    const result = await distillAndRemember(baseOptions({ client, llmClient }));

    expect(result.entries.length).toBe(4); // summary + 3 decisions
    const quarantined = result.entries.filter((e) => e.quarantined);
    const persisted = result.entries.filter((e) => !e.quarantined);
    expect(quarantined.length).toBe(1);
    expect(quarantined[0]!.secretMatches.length).toBeGreaterThan(0);
    expect(quarantined[0]!.ok).toBe(false);
    expect(persisted.length).toBe(3);
    expect(persisted.every((e) => e.ok)).toBe(true);

    // remember() (via ingestDocument()) was attempted for the 3 clean
    // entries ONLY -- never for the quarantined one.
    expect(calls.length).toBe(3);
    expect(calls.some((c) => c.content.text.includes(SECRET_TEXT))).toBe(false);

    // scanForSecrets() itself still ran for EVERY entry, including the ones
    // after the quarantined one -- proving the run continued, not aborted.
    expect(vi.mocked(scanForSecrets).mock.calls.length).toBe(4);
  });

  it('never aborts the whole run -- a quarantine on the FIRST entry still lets later entries persist', async () => {
    const { llmClient } = scriptedExtraction([{ decisions: [SECRET_TEXT, 'a clean decision after the secret'], openQuestions: [] }]);
    const { client, calls } = makeFakeIngestClient();

    const result = await distillAndRemember(baseOptions({ client, llmClient }));

    expect(result.entries[1]!.quarantined).toBe(true); // first decision, index 1 (0 is summary)
    expect(result.entries[2]!.quarantined).toBe(false);
    expect(result.entries[2]!.ok).toBe(true);
    expect(calls.length).toBe(2); // summary + the clean decision
  });

  it('appends the quarantined match to the SAME on-disk human-review queue file cm-05\'s own triage pipeline writes to, tagged quarantine_reason: secret_detected', async () => {
    const { llmClient } = scriptedExtraction([{ decisions: ['leak: ' + SECRET_TEXT], openQuestions: [] }]);

    await distillAndRemember(baseOptions({ llmClient }));

    const entries = readQuarantineEntries() as Array<{
      quarantine_reason: string;
      entry_type: string;
      session_id: string;
      chat_source: string;
    }>;
    expect(entries.length).toBe(1);
    expect(entries[0]!.quarantine_reason).toBe('secret_detected');
    expect(entries[0]!.entry_type).toBe('decision');
    expect(entries[0]!.session_id).toBe('session-abc');
    expect(entries[0]!.chat_source).toBe('claude-code');
  });

  it('never exposes the raw secret value in the quarantine queue record (secretMatches previews are already redaction-safe by scanForSecrets\'s own contract)', async () => {
    const { llmClient } = scriptedExtraction([{ decisions: ['leak: ' + SECRET_TEXT], openQuestions: [] }]);

    await distillAndRemember(baseOptions({ llmClient }));

    const raw = readFileSync(quarantineQueuePath, 'utf8');
    expect(raw).not.toContain(SECRET_TEXT);
  });
});

// ---------------------------------------------------------------------------
// AC4 -- scope: 'intake' + full provenance-metadata contract on every
// persisted entry.
// ---------------------------------------------------------------------------

describe('distillAndRemember() -- scope + provenance-metadata contract (AC4, AC9)', () => {
  it('every successfully persisted entry uses scope exactly \'intake\' and carries the full provenance contract', async () => {
    const candidate: ResolvedScopeCandidate = {
      scope_key: 'arizona',
      collection: 'clients_arizona_compound_memory',
      matched_registry: 'swarm-memory-scopes',
      review_reason: 'scope_route_candidate',
    };
    const { llmClient } = scriptedExtraction([{ decisions: ['decision one'], openQuestions: ['question one'] }]);
    const { client, calls } = makeFakeIngestClient();

    const result = await distillAndRemember(
      baseOptions({
        client,
        llmClient,
        chatSource: 'chatgpt',
        sessionId: 'session-xyz',
        projectSlug: '/Users/mdostal/Code/other-project',
        clusterId: 'cluster-7',
        resolvedScopeCandidate: candidate,
      }),
    );

    expect(calls.length).toBe(3);
    for (const call of calls) {
      expect(call.scope).toBe('intake');
    }

    for (const entry of result.entries) {
      expect(entry.metadata.source).toBe('external_conversation');
      expect(entry.metadata.chat_source).toBe('chatgpt');
      expect(entry.metadata.session_id).toBe('session-xyz');
      expect(entry.metadata.project_slug).toBe('/Users/mdostal/Code/other-project');
      expect(entry.metadata.cluster_id).toBe('cluster-7');
      expect(entry.metadata.resolved_scope_candidate).toEqual(candidate);
      expect(entry.metadata.entry_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    }
  });

  it('carries cluster_id explicitly as null (never omitted) for a session cm-06 did not cluster', async () => {
    const { llmClient } = scriptedExtraction([{ decisions: [], openQuestions: [] }]);

    const result = await distillAndRemember(baseOptions({ llmClient, clusterId: null }));

    expect(result.entries.length).toBe(1);
    expect('cluster_id' in result.entries[0]!.metadata).toBe(true);
    expect(result.entries[0]!.metadata.cluster_id).toBeNull();
  });

  it('tags an open_question entry distinctly (entry_type: open_question), never indistinguishable from a decision entry (AC6)', async () => {
    const { llmClient } = scriptedExtraction([{ decisions: ['a decision'], openQuestions: ['an open question'] }]);

    const result = await distillAndRemember(baseOptions({ llmClient }));

    const decision = result.entries.find((e) => e.bodyText === 'a decision');
    const openQuestion = result.entries.find((e) => e.bodyText === 'an open question');
    expect(decision!.metadata.entry_type).toBe('decision');
    expect(openQuestion!.metadata.entry_type).toBe('open_question');
    expect(decision!.metadata.entry_type).not.toBe(openQuestion!.metadata.entry_type);
  });

  it('embeds the same provenance contract in the persisted TEXT itself (round-trippable via parseProvenanceHeader), given ingestDocument()\'s own real Content.metadata shape cannot carry it (see module doc comment)', async () => {
    const { llmClient } = scriptedExtraction([{ decisions: ['a decision'], openQuestions: [] }]);
    const { client, calls } = makeFakeIngestClient();

    const result = await distillAndRemember(baseOptions({ client, llmClient }));

    for (let i = 0; i < calls.length; i++) {
      const parsed = parseProvenanceHeader(calls[i]!.content.text);
      expect(parsed).not.toBeNull();
      expect(parsed!.entry_id).toBe(result.entries[i]!.metadata.entry_id);
      expect(parsed!.session_id).toBe(result.entries[i]!.metadata.session_id);
    }
  });

  it('entry_id also rides through ingestDocument()\'s own real tag channel (Content.metadata.tag) -- a structural, not merely textual, hook for cm-13', async () => {
    const { llmClient } = scriptedExtraction([{ decisions: ['a decision'], openQuestions: [] }]);
    const { client, calls } = makeFakeIngestClient();

    const result = await distillAndRemember(baseOptions({ client, llmClient }));

    for (let i = 0; i < calls.length; i++) {
      expect(calls[i]!.content.metadata?.tag).toBe(result.entries[i]!.metadata.entry_id);
    }
  });
});

// ---------------------------------------------------------------------------
// AC5 -- ingestDocument() called UNCHANGED.
// ---------------------------------------------------------------------------

describe('distillAndRemember() -- ingestDocument() called unchanged (AC5)', () => {
  it('imports and calls the REAL ro-10/ro-13 ingestDocument() -- its own real internal chunk-building logic observably ran (filename/chunk_index/chunk_count shape), never a forked/reimplemented copy', async () => {
    const { llmClient } = scriptedExtraction([{ decisions: ['a short decision'], openQuestions: [] }]);
    const { client, calls } = makeFakeIngestClient();

    const result = await distillAndRemember(baseOptions({ client, llmClient }));

    expect(vi.mocked(ingestDocument).mock.calls.length).toBe(calls.length);

    for (const entry of result.entries) {
      expect(entry.ingest).toBeDefined();
      expect(entry.ingest!.ok).toBe(true);
      // ro-10's real internal shape: exactly one chunk (our bounded entry
      // text always fits under CHUNK_SIZE_BYTES), filename null (free-text
      // path), chunk_index 0.
      expect(entry.ingest!.chunks.length).toBe(1);
      expect(entry.ingest!.chunks[0]!.filename).toBeNull();
      expect(entry.ingest!.chunks[0]!.index).toBe(0);
    }
  });

  it('the source module imports ingestDocument from the real ro-10/ro-13 path only, with no local reimplementation of remember-call logic anywhere in the file', () => {
    const sourcePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'distillAndRemember.ts');
    const source = readFileSync(sourcePath, 'utf8');

    const importMatches = [...source.matchAll(/from ['"]([^'"]*ingest\/ingestDocument\.js)['"]/g)];
    expect(importMatches.length).toBe(1);
    expect(importMatches[0]![1]).toBe('../ingest/ingestDocument.js');

    // Exactly one call site invokes ingestDocument(...).
    const callSites = [...source.matchAll(/\bawait ingestDocument\(/g)];
    expect(callSites.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AC7/AC8 -- exactly one shared geminiClient.ts call for keep/uncertain;
// never invoked for trash.
// ---------------------------------------------------------------------------

describe('distillAndRemember() -- geminiClient.ts wiring (AC7, AC8)', () => {
  it('the REAL, shared geminiClient.ts callGemini() is invoked exactly once, via createDefaultExtractionLlmClient(), for a keep-verdict session (real module, real wiring, offline via fetchImpl/resolveApiKey injection)', async () => {
    const scriptedResponse: CallGeminiResult = {
      raw: { decisions: ['a decision from the real wiring path'], openQuestions: [] },
      rawText: JSON.stringify({ decisions: ['a decision from the real wiring path'], openQuestions: [] }),
      attempts: 1,
    };
    const fetchImpl = vi.fn(
      async (_url: string, _init: FetchInit): Promise<FetchResponseLike> => ({
        status: 200,
        text: async () =>
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: scriptedResponse.rawText }] } }],
          }),
      }),
    );
    const llmClient = createDefaultExtractionLlmClient({ fetchImpl, resolveApiKey: async () => 'fake-test-key' });
    const { client } = makeFakeIngestClient();

    const result = await distillAndRemember(baseOptions({ client, llmClient }));

    expect(vi.mocked(callGemini).mock.calls.length).toBe(1);
    expect(fetchImpl.mock.calls.length).toBe(1);
    expect(result.entries.some((e) => e.bodyText === 'a decision from the real wiring path')).toBe(true);
  });

  it('geminiClient.ts\'s real callGemini() is NEVER invoked for a trash-verdict session', async () => {
    const { client, calls } = makeFakeIngestClient();

    const result = await distillAndRemember(baseOptions({ client, verdict: 'trash' }));

    expect(result.skipped).toBe(true);
    expect(result.entries).toEqual([]);
    expect(vi.mocked(callGemini).mock.calls.length).toBe(0);
    expect(vi.mocked(ingestDocument).mock.calls.length).toBe(0);
    expect(calls.length).toBe(0);
  });

  it('an uncertain-verdict session is treated the same as keep -- extraction and persist both run', async () => {
    const { llmClient } = scriptedExtraction([{ decisions: ['an uncertain-session decision'], openQuestions: [] }]);
    const { client, calls } = makeFakeIngestClient();

    const result = await distillAndRemember(baseOptions({ client, llmClient, verdict: 'uncertain' }));

    expect(result.skipped).toBe(false);
    expect(calls.length).toBe(2);
  });

  it('buildExtractionPrompt() never exceeds MAX_EXTRACTION_INPUT_CHARS, regardless of source session size', () => {
    const hugeTurns: ConversationTurn[] = Array.from({ length: 5000 }, (_, i) =>
      makeTurn({ turnIndex: i, role: i % 2 === 0 ? 'user' : 'assistant', text: 'x'.repeat(500), timestamp: null }),
    );
    const prompt = buildExtractionPrompt(hugeTurns, MAX_EXTRACTION_INPUT_CHARS);
    expect(prompt.length).toBeLessThanOrEqual(MAX_EXTRACTION_INPUT_CHARS);
  });

  it('excludes quarantined turns entirely from the extraction prompt (mirrors cm-05\'s own quarantine-exclusion discipline)', () => {
    const turns = [
      makeTurn({ turnIndex: 0, role: 'user', text: 'here is my api key ' + SECRET_TEXT, quarantined: true, quarantineReason: 'secret_detected' }),
      makeTurn({ turnIndex: 1, role: 'assistant', text: 'Got it, noted.' }),
    ];
    const prompt = buildExtractionPrompt(turns, MAX_EXTRACTION_INPUT_CHARS);
    expect(prompt).not.toContain(SECRET_TEXT);
    expect(prompt).toContain('Got it, noted.');
  });

  it('parseExtractionResponse() throws loudly on a malformed response, never silently guessing a decision/open-question', () => {
    expect(() => parseExtractionResponse('not an object')).toThrow(DistillationError);
    expect(() => parseExtractionResponse({ decisions: 'not-an-array', openQuestions: [] })).toThrow(DistillationError);
    expect(() => parseExtractionResponse(null)).toThrow(DistillationError);
  });

  it('parseExtractionResponse() accepts a well-formed empty result (a legitimate outcome, not malformed)', () => {
    const result = parseExtractionResponse({ decisions: [], openQuestions: [] });
    expect(result).toEqual({ decisions: [], openQuestions: [] });
  });

  it('a malformed extraction response fails the whole distillAndRemember() call loudly -- never a silently-guessed entry', async () => {
    const llmClient: ExtractionLlmClient = { extract: async () => 'not an object' };
    await expect(distillAndRemember(baseOptions({ llmClient }))).rejects.toThrow(DistillationError);
  });
});

// ---------------------------------------------------------------------------
// THE CORE REQUIREMENT -- unconditional scope: 'intake', no code path
// capable of anything else, resolved_scope_candidate is genuinely inert.
// ---------------------------------------------------------------------------

describe('distillAndRemember() -- scope: intake is unconditional; resolved_scope_candidate is genuinely inert (round 4, §11.2)', () => {
  it.each([
    { label: 'null resolved_scope_candidate', candidate: null },
    {
      label: 'a real matched resolved_scope_candidate',
      candidate: {
        scope_key: 'arizona',
        collection: 'clients_arizona_compound_memory',
        matched_registry: 'swarm-memory-scopes',
        review_reason: 'scope_route_candidate',
      } as ResolvedScopeCandidate,
    },
  ])('scope is exactly \'intake\' for every entry regardless of resolved_scope_candidate ($label)', async ({ candidate }) => {
    const { llmClient } = scriptedExtraction([{ decisions: ['decision one', 'decision two'], openQuestions: ['question one'] }]);
    const { client, calls } = makeFakeIngestClient();

    await distillAndRemember(baseOptions({ client, llmClient, resolvedScopeCandidate: candidate }));

    expect(calls.length).toBe(4);
    for (const call of calls) {
      expect(call.scope).toBe('intake');
    }
  });

  it('produces IDENTICAL remember() call behavior (same scope, same entry count/order/ok-outcomes) whether resolved_scope_candidate is null or a real matched key -- proving it is inert pass-through, never silently influencing the write', async () => {
    const candidate: ResolvedScopeCandidate = {
      scope_key: 'arizona',
      collection: 'clients_arizona_compound_memory',
      matched_registry: 'swarm-memory-scopes',
      review_reason: 'scope_route_candidate',
    };

    async function run(resolvedScopeCandidate: ResolvedScopeCandidate | null) {
      const { llmClient } = scriptedExtraction([{ decisions: ['decision one', 'decision two'], openQuestions: ['question one'] }]);
      const { client, calls } = makeFakeIngestClient();
      const result = await distillAndRemember(
        baseOptions({
          client,
          llmClient,
          resolvedScopeCandidate,
          generateEntryId: makeSequentialIdGenerator(),
        }),
      );
      return {
        scopes: calls.map((c) => c.scope),
        entryTypes: result.entries.map((e) => e.metadata.entry_type),
        okOutcomes: result.entries.map((e) => e.ok),
        entryIds: result.entries.map((e) => e.metadata.entry_id),
      };
    }

    const withNull = await run(null);
    const withCandidate = await run(candidate);

    expect(withCandidate.scopes).toEqual(withNull.scopes);
    expect(withCandidate.entryTypes).toEqual(withNull.entryTypes);
    expect(withCandidate.okOutcomes).toEqual(withNull.okOutcomes);
    expect(withCandidate.entryIds).toEqual(withNull.entryIds);
    // Every scope is 'intake' in both runs -- the candidate value never
    // changes what gets written.
    expect(withNull.scopes.every((s) => (s as string) === 'intake')).toBe(true);
    expect(withCandidate.scopes.every((s) => (s as string) === 'intake')).toBe(true);
  });

  it('static self-check: the source file never contains a scope literal other than \'intake\' assigned at the ingestDocument() call site, and INTAKE_SCOPE is defined exactly once', () => {
    const sourcePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'distillAndRemember.ts');
    const source = readFileSync(sourcePath, 'utf8');

    expect(source).not.toMatch(/scope:\s*['"]meta['"]/);
    expect(source).not.toMatch(/scope:\s*['"]project['"]/);
    expect(source).not.toMatch(/scope:\s*['"]enterprise['"]/);
    // Never reads/branches on resolvedScopeCandidate anywhere (only ever
    // assigns it straight through into `metadata.resolved_scope_candidate`).
    expect(source).not.toMatch(/if\s*\(\s*resolvedScopeCandidate/);
    expect(source).not.toMatch(/resolvedScopeCandidate\s*\?/);

    const intakeConstDefs = [...source.matchAll(/const INTAKE_SCOPE =/g)];
    expect(intakeConstDefs.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// entry_id -- a real UUID, distinct from content_hash.
// ---------------------------------------------------------------------------

describe('distillAndRemember() -- metadata.entry_id (round 4, §11.2)', () => {
  it('every entry gets a distinct UUID entry_id, never equal to its own content_hash', async () => {
    const { llmClient } = scriptedExtraction([{ decisions: ['decision one', 'decision two'], openQuestions: [] }]);
    const { client } = makeFakeIngestClient();

    const result = await distillAndRemember(baseOptions({ client, llmClient }));

    const ids = result.entries.map((e) => e.metadata.entry_id);
    expect(new Set(ids).size).toBe(ids.length); // all distinct
    for (const entry of result.entries) {
      const contentHash = entry.ingest?.ok ? entry.ingest.chunks[0]?.remember.ok && entry.ingest.chunks[0]!.remember.provenance.content_hash : undefined;
      if (contentHash) {
        expect(entry.metadata.entry_id).not.toBe(contentHash);
      }
    }
  });

  it('respects an injected deterministic id generator (test determinism hook)', async () => {
    const { llmClient } = scriptedExtraction([{ decisions: ['d'], openQuestions: [] }]);
    const result = await distillAndRemember(baseOptions({ llmClient, generateEntryId: makeSequentialIdGenerator('fixed') }));
    expect(result.entries[0]!.metadata.entry_id).toBe('fixed-0');
    expect(result.entries[1]!.metadata.entry_id).toBe('fixed-1');
  });
});

// ---------------------------------------------------------------------------
// buildProvenanceHeader() / parseProvenanceHeader() -- round-trip.
// ---------------------------------------------------------------------------

describe('buildProvenanceHeader() / parseProvenanceHeader() -- round-trip', () => {
  it('round-trips every field exactly', () => {
    const metadata = {
      entry_id: 'abc-123',
      entry_type: 'decision' as const,
      source: 'external_conversation' as const,
      chat_source: 'claude-code' as const,
      session_id: 'session-1',
      project_slug: '/Users/x/y',
      cluster_id: 'cluster-2',
      resolved_scope_candidate: null,
    };
    const header = buildProvenanceHeader(metadata);
    const parsed = parseProvenanceHeader(header + '\n\nsome body text');
    expect(parsed).toEqual(metadata);
  });

  it('returns null for text with no provenance header, never throws', () => {
    expect(parseProvenanceHeader('just some plain text')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Byte bounds, derived from ingestDocument.ts's REAL, imported constants
// (not assumed).
// ---------------------------------------------------------------------------

describe('distillAndRemember() -- byte bounds vs. ingestDocument.ts\'s real constants', () => {
  it('MAX_ENTRY_FINAL_TEXT_BYTES stays safely under the REAL, imported CHUNK_SIZE_BYTES', () => {
    expect(MAX_ENTRY_FINAL_TEXT_BYTES).toBeLessThan(CHUNK_SIZE_BYTES);
  });

  it('every persisted entry\'s final text stays under CHUNK_SIZE_BYTES even for pathologically long fields, producing exactly ONE ingestDocument() chunk per entry', async () => {
    const hugeSlug = '/Users/'.padEnd(5000, 'x');
    const hugeCandidate: ResolvedScopeCandidate = {
      scope_key: 'k'.repeat(2000),
      collection: 'c'.repeat(2000),
      matched_registry: 'swarm-memory-scopes',
      review_reason: 'scope_route_candidate',
    };
    const { llmClient } = scriptedExtraction([{ decisions: ['x'.repeat(5000)], openQuestions: [] }]);
    const { client, calls } = makeFakeIngestClient();

    const result = await distillAndRemember(
      baseOptions({ client, llmClient, projectSlug: hugeSlug, resolvedScopeCandidate: hugeCandidate }),
    );

    for (const call of calls) {
      expect(Buffer.byteLength(call.content.text, 'utf8')).toBeLessThan(CHUNK_SIZE_BYTES);
    }
    for (const entry of result.entries) {
      if (entry.ingest?.ok) {
        expect(entry.ingest.chunks.length).toBe(1);
      }
    }
  });
});
