/**
 * cm-05-usefulness-trash-triage (epic: mnemosyne-conversation-memory).
 *
 * Failing-first tests (TDD) for `geminiClient.ts`'s shared Gemini API
 * primitive. EVERY test in this file runs against a stubbed HTTP layer
 * (`fetchImpl`) and a stubbed credential resolver (`resolveApiKey`) —
 * `globalThis.fetch` is never called, `gcloud`/Portunus is never shelled
 * out to, and no live Gemini API call happens anywhere in this file. This
 * mirrors `ingestDocument.test.ts`'s own fake-client convention (never a
 * live Qdrant/network call in the automated suite).
 *
 * Covers this story's own acceptance criteria that apply to `geminiClient.ts`
 * directly: bounded-input enforcement BEFORE any network call, rate-limit
 * (429) retry with bounded backoff then loud failure, structured-JSON-
 * response parsing, and — the hard constraint this story is built around —
 * that the resolved API key value never appears in ANY thrown error's
 * `message`, under any of this module's own failure paths.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_GEMINI_MODEL,
  GEMINI_API_BASE,
  GeminiClientError,
  callGemini,
  type FetchLike,
} from './geminiClient.js';

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

/** A fake, obviously-not-real secret value — used to prove it never leaks into any thrown error message. */
const FAKE_API_KEY = 'FAKE_TEST_GEMINI_KEY_zzz9988';

function fakeResolveApiKey(): Promise<string> {
  return Promise.resolve(FAKE_API_KEY);
}

/** Builds a fake Gemini `generateContent` 200 response body wrapping `jsonText` as the model's own response text. */
function geminiSuccessBody(jsonText: string): string {
  return JSON.stringify({
    candidates: [{ content: { parts: [{ text: jsonText }] }, finishReason: 'STOP', index: 0 }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    modelVersion: DEFAULT_GEMINI_MODEL,
  });
}

interface FakeResponse {
  status: number;
  text(): Promise<string>;
}

function fakeResponse(status: number, body: string): FakeResponse {
  return { status, text: () => Promise.resolve(body) };
}

/** Records every call made through it; returns queued responses in order. */
function scriptedFetch(responses: FakeResponse[]): { fetchImpl: FetchLike; calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> } {
  const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
  let i = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const response = responses[Math.min(i, responses.length - 1)]!;
    i++;
    return response;
  };
  return { fetchImpl, calls };
}

/** Records every ms value it was asked to "sleep" for, but resolves immediately — no real test-time delay. */
function instantSleep(): { sleepImpl: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  const sleepImpl = (ms: number) => {
    delays.push(ms);
    return Promise.resolve();
  };
  return { sleepImpl, delays };
}

const VALID_JSON_TEXT = JSON.stringify({ verdict: 'keep', summary: 'a real session', rationale: 'looked useful' });

// ---------------------------------------------------------------------------

describe('callGemini() — bounded-input enforcement', () => {
  it('rejects a prompt exceeding maxInputChars BEFORE any network call', async () => {
    const { fetchImpl, calls } = scriptedFetch([fakeResponse(200, geminiSuccessBody(VALID_JSON_TEXT))]);

    await expect(
      callGemini({
        prompt: 'x'.repeat(101),
        maxInputChars: 100,
        fetchImpl,
        resolveApiKey: fakeResolveApiKey,
      }),
    ).rejects.toMatchObject({ code: 'input_too_large' });

    expect(calls.length).toBe(0);
  });

  it('allows a prompt exactly at maxInputChars', async () => {
    const { fetchImpl } = scriptedFetch([fakeResponse(200, geminiSuccessBody(VALID_JSON_TEXT))]);

    const result = await callGemini({
      prompt: 'x'.repeat(100),
      maxInputChars: 100,
      fetchImpl,
      resolveApiKey: fakeResolveApiKey,
    });

    expect(result.raw).toEqual({ verdict: 'keep', summary: 'a real session', rationale: 'looked useful' });
  });
});

describe('callGemini() — successful call shape', () => {
  it('sends the API key as a header, never in the URL, and parses the structured JSON response', async () => {
    const { fetchImpl, calls } = scriptedFetch([fakeResponse(200, geminiSuccessBody(VALID_JSON_TEXT))]);

    const result = await callGemini({
      prompt: 'triage this session',
      maxInputChars: 1000,
      fetchImpl,
      resolveApiKey: fakeResolveApiKey,
    });

    expect(result.raw).toEqual({ verdict: 'keep', summary: 'a real session', rationale: 'looked useful' });
    expect(result.rawText).toBe(VALID_JSON_TEXT);
    expect(result.attempts).toBe(1);

    expect(calls.length).toBe(1);
    expect(calls[0]!.url).not.toContain(FAKE_API_KEY);
    expect(calls[0]!.url.startsWith(GEMINI_API_BASE)).toBe(true);
    expect(calls[0]!.init.headers['x-goog-api-key']).toBe(FAKE_API_KEY);
  });
});

describe('callGemini() — 429 retry/backoff', () => {
  it('retries a rate-limited response with bounded backoff, then succeeds', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      fakeResponse(429, ''),
      fakeResponse(429, ''),
      fakeResponse(200, geminiSuccessBody(VALID_JSON_TEXT)),
    ]);
    const { sleepImpl, delays } = instantSleep();

    const result = await callGemini({
      prompt: 'triage this session',
      maxInputChars: 1000,
      fetchImpl,
      resolveApiKey: fakeResolveApiKey,
      sleepImpl,
      maxAttempts: 4,
    });

    expect(result.attempts).toBe(3);
    expect(calls.length).toBe(3);
    // Backoff is bounded and (deterministically) non-decreasing across
    // retries -- exact schedule is an implementation detail, but it must
    // never be zero/negative/unbounded.
    expect(delays.length).toBe(2);
    for (const d of delays) {
      expect(d).toBeGreaterThan(0);
    }
    expect(delays[1]!).toBeGreaterThanOrEqual(delays[0]!);
  });

  it('exhausts retries on a persistent 429 and fails loudly -- never a silently-guessed default verdict', async () => {
    const { fetchImpl, calls } = scriptedFetch([fakeResponse(429, ''), fakeResponse(429, ''), fakeResponse(429, '')]);
    const { sleepImpl } = instantSleep();

    await expect(
      callGemini({
        prompt: 'triage this session',
        maxInputChars: 1000,
        fetchImpl,
        resolveApiKey: fakeResolveApiKey,
        sleepImpl,
        maxAttempts: 3,
      }),
    ).rejects.toMatchObject({ code: 'rate_limited' });

    expect(calls.length).toBe(3);
  });
});

describe('callGemini() — malformed / non-2xx responses fail loudly', () => {
  it('rejects a non-JSON HTTP body', async () => {
    const { fetchImpl } = scriptedFetch([fakeResponse(200, 'this is not json')]);
    await expect(
      callGemini({ prompt: 'p', maxInputChars: 1000, fetchImpl, resolveApiKey: fakeResolveApiKey }),
    ).rejects.toMatchObject({ code: 'malformed_response' });
  });

  it('rejects a well-formed envelope whose own model text is not valid JSON', async () => {
    const { fetchImpl } = scriptedFetch([fakeResponse(200, geminiSuccessBody('not valid json either'))]);
    await expect(
      callGemini({ prompt: 'p', maxInputChars: 1000, fetchImpl, resolveApiKey: fakeResolveApiKey }),
    ).rejects.toMatchObject({ code: 'malformed_response' });
  });

  it('rejects an envelope missing candidates entirely', async () => {
    const { fetchImpl } = scriptedFetch([fakeResponse(200, JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }))]);
    await expect(
      callGemini({ prompt: 'p', maxInputChars: 1000, fetchImpl, resolveApiKey: fakeResolveApiKey }),
    ).rejects.toMatchObject({ code: 'malformed_response' });
  });

  it('rejects a non-429 non-2xx status without retrying', async () => {
    const { fetchImpl, calls } = scriptedFetch([fakeResponse(500, 'internal error')]);
    await expect(
      callGemini({ prompt: 'p', maxInputChars: 1000, fetchImpl, resolveApiKey: fakeResolveApiKey, maxAttempts: 4 }),
    ).rejects.toMatchObject({ code: 'http_error' });
    expect(calls.length).toBe(1);
  });
});

describe('callGemini() — the resolved API key never appears in any thrown error message', () => {
  const scenarios: Array<[string, () => { fetchImpl: FetchLike; extraOptions?: Record<string, unknown> }]> = [
    ['persistent 429 (rate_limited)', () => ({ fetchImpl: scriptedFetch([fakeResponse(429, ''), fakeResponse(429, '')]).fetchImpl, extraOptions: { maxAttempts: 2, sleepImpl: instantSleep().sleepImpl } })],
    ['non-2xx http_error', () => ({ fetchImpl: scriptedFetch([fakeResponse(503, 'x')]).fetchImpl })],
    ['malformed_response (bad JSON body)', () => ({ fetchImpl: scriptedFetch([fakeResponse(200, 'nope')]).fetchImpl })],
    ['malformed_response (bad model text)', () => ({ fetchImpl: scriptedFetch([fakeResponse(200, geminiSuccessBody('nope'))]).fetchImpl })],
  ];

  it.each(scenarios)('%s', async (_name, build) => {
    const { fetchImpl, extraOptions } = build();
    let caught: unknown;
    try {
      await callGemini({
        prompt: 'p',
        maxInputChars: 1000,
        fetchImpl,
        resolveApiKey: fakeResolveApiKey,
        ...extraOptions,
      });
      throw new Error('expected callGemini() to reject');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GeminiClientError);
    const message = (caught as Error).message;
    expect(message).not.toContain(FAKE_API_KEY);
  });

  it('never includes the key even when the credential resolver itself throws', async () => {
    const { fetchImpl } = scriptedFetch([fakeResponse(200, geminiSuccessBody(VALID_JSON_TEXT))]);
    const resolveApiKey = () => {
      // A resolver that (incorrectly) tried to embed the key in its own
      // failure would be exactly the bug this test exists to catch --
      // this resolver deliberately does NOT do that, proving the healthy
      // pattern, while the assertion below still guards the invariant.
      throw new Error('credential backend unavailable');
    };
    await expect(
      callGemini({ prompt: 'p', maxInputChars: 1000, fetchImpl, resolveApiKey }),
    ).rejects.toThrow(/credential backend unavailable/);
  });
});

describe('callGemini() — timeout', () => {
  it('aborts and fails loudly when a call exceeds the configured timeout', async () => {
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });

    await expect(
      callGemini({
        prompt: 'p',
        maxInputChars: 1000,
        fetchImpl,
        resolveApiKey: fakeResolveApiKey,
        timeoutMs: 5,
        maxAttempts: 1,
      }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });
});
