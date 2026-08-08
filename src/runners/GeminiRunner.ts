import { validatePlanResponse, type PlanResponse } from '../types/PlanResponse.js';
import {
  RunnerStrategy,
  RunnerUnavailableError,
  type RunnerInvocationContext,
} from './RunnerStrategy.js';

type Env = Record<string, string | undefined>;

interface ProcessLike {
  env?: Env;
}

interface FetchResponseLike {
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<FetchResponseLike>;

declare const process: ProcessLike | undefined;
declare const fetch: FetchLike | undefined;

interface GeminiRunnerOptions {
  apiKey?: string;
  env?: Env;
  fetch?: FetchLike;
  endpoint?: string;
}

interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
}

const DEFAULT_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent';

export class GeminiRunner extends RunnerStrategy {
  readonly name = 'gemini';
  readonly priority = 3;
  readonly model = 'gemini-1.5-pro';

  private readonly apiKey: string | undefined;
  private readonly endpoint: string;
  private readonly fetchImpl: FetchLike | undefined;

  constructor(options: GeminiRunnerOptions = {}) {
    super();
    const env = options.env ?? process?.env ?? {};
    this.apiKey = options.apiKey ?? env.GOOGLE_API_KEY ?? env.GEMINI_API_KEY;
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async isAvailable(): Promise<boolean> {
    return Boolean(this.apiKey);
  }

  async invoke(prompt: string, _context?: RunnerInvocationContext): Promise<PlanResponse> {
    if (!this.apiKey) {
      throw new RunnerUnavailableError('Gemini runner is unavailable: GOOGLE_API_KEY is not configured');
    }

    if (!this.fetchImpl) {
      throw new RunnerUnavailableError('Gemini runner is unavailable: fetch is not available');
    }

    let response: FetchResponseLike;
    try {
      response = await this.fetchImpl(`${this.endpoint}?key=${encodeURIComponent(this.apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [{ text: buildPlanningPrompt(prompt) }],
            },
          ],
          generationConfig: {
            responseMimeType: 'application/json',
          },
        }),
      });
    } catch (error) {
      throw new RunnerUnavailableError('Gemini runner request failed', { cause: error });
    }

    if (!response.ok) {
      const detail = await readErrorDetail(response);
      throw new RunnerUnavailableError(
        `Gemini runner request failed with ${response.status} ${response.statusText}${detail}`,
      );
    }

    try {
      const payload = (await response.json()) as GeminiGenerateContentResponse;
      const text = payload.candidates?.[0]?.content?.parts?.find((part) => typeof part.text === 'string')?.text;
      if (!text) {
        throw new Error('Gemini response did not include text content');
      }

      return validatePlanResponse(JSON.parse(text));
    } catch (error) {
      throw new RunnerUnavailableError('Gemini runner returned an invalid PlanResponse', { cause: error });
    }
  }
}

function buildPlanningPrompt(prompt: string): string {
  return [
    'Generate a planning response as strict JSON only.',
    'The JSON object must match this TypeScript shape:',
    '{ "summary": string, "steps": [{ "id": string, "title": string, "description": string, "depends_on"?: string[] }], "risks"?: string[] }',
    'Do not wrap the JSON in Markdown.',
    '',
    prompt,
  ].join('\n');
}

async function readErrorDetail(response: FetchResponseLike): Promise<string> {
  try {
    const body = await response.text();
    return body ? `: ${body}` : '';
  } catch {
    return '';
  }
}
