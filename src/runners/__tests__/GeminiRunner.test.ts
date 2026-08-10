import { describe, expect, it, vi } from 'vitest';
import { GeminiRunner } from '../GeminiRunner.js';
import { RunnerUnavailableError } from '../RunnerStrategy.js';

interface FetchInitForTest {
  method: string;
  headers: Record<string, string>;
  body: string;
}

const validPlan = {
  summary: 'Ship runner-agnostic planning',
  steps: [
    {
      id: 'implement',
      title: 'Implement runner',
      description: 'Add the Gemini runner strategy',
    },
  ],
  risks: ['Gemini quota may be unavailable'],
};

describe('GeminiRunner', () => {
  it('returns available when GOOGLE_API_KEY is configured', async () => {
    const runner = new GeminiRunner({ env: { GOOGLE_API_KEY: 'test-key' }, fetch: mockFetch(validPlan) });

    await expect(runner.isAvailable()).resolves.toBe(true);
    expect(runner.priority).toBe(3);
  });

  it('calls Google Gemini generateContent with gemini-1.5-pro model', async () => {
    const fetchMock = mockFetch(validPlan);
    const runner = new GeminiRunner({ env: { GOOGLE_API_KEY: 'test-key' }, fetch: fetchMock });

    await expect(runner.invoke('Plan the work')).resolves.toEqual(validPlan);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchMock.mock.calls[0];
    if (!firstCall) {
      throw new Error('expected Gemini API request');
    }
    const [url, init] = firstCall;
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=test-key',
    );
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });

    const body = JSON.parse(init.body) as {
      contents: Array<{ role: string; parts: Array<{ text: string }> }>;
      generationConfig: { responseMimeType: string };
    };
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.contents[0]?.role).toBe('user');
    expect(body.contents[0]?.parts[0]?.text).toContain('Plan the work');
  });

  it('throws RunnerUnavailableError when the API returns an error', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      json: async () => ({}),
      text: async () => 'quota exceeded',
    }));
    const runner = new GeminiRunner({ env: { GOOGLE_API_KEY: 'test-key' }, fetch: fetchMock });

    await expect(runner.invoke('Plan the work')).rejects.toBeInstanceOf(RunnerUnavailableError);
    await expect(runner.invoke('Plan the work')).rejects.toThrow('429 Too Many Requests');
  });

  it('throws RunnerUnavailableError when the response is not a valid PlanResponse', async () => {
    const runner = new GeminiRunner({
      env: { GOOGLE_API_KEY: 'test-key' },
      fetch: mockFetch({ summary: 'missing steps' }),
    });

    await expect(runner.invoke('Plan the work')).rejects.toBeInstanceOf(RunnerUnavailableError);
  });
});

function mockFetch(plan: unknown) {
  return vi.fn(async (_url: string, _init: FetchInitForTest) => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({
      candidates: [
        {
          content: {
            parts: [{ text: JSON.stringify(plan) }],
          },
        },
      ],
    }),
    text: async () => '',
  }));
}
