// Type declarations for persona-remember.mjs — kept as a thin, hand-written
// companion (no build step for this skill's helper script), mirroring
// persona-writer.d.mts's own convention, so TS-aware callers/tests
// (lib/mnemosyne/layer1/__tests__/persona-interview-crawl-and-feed.test.ts)
// get real types instead of `any`. Source of truth for behavior is
// persona-remember.mjs itself; this file must stay in lockstep with it.

import type { InterviewPersona } from './interview-engine.d.mts';

export { buildRememberText } from './interview-engine.d.mts';

export interface ResolveRememberScopeViaCliResult {
  ok: boolean;
  scope?: string;
  tag?: string;
  stdout: string;
  stderr: string;
  error?: string;
}

export function resolveRememberScopeViaCli(
  persona: Pick<InterviewPersona, 'tier' | 'scopeId'>,
): Promise<ResolveRememberScopeViaCliResult>;

export interface FireRememberCallInput {
  text: string;
  scope: string;
  tag: string;
}

export interface FireRememberCallOptions {
  port?: number;
  env?: Record<string, string>;
}

export interface RememberResponse {
  remembered: boolean;
  scope: string;
  collection: string;
  file: string;
  chunks_upserted: number;
  engine_output: string;
  status: string;
  source_ref: unknown;
  took_ms?: number;
}

export interface FireRememberCallResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  result: RememberResponse | null;
  error: string | null;
}

export function fireRememberCall(
  input: FireRememberCallInput,
  opts?: FireRememberCallOptions,
): Promise<FireRememberCallResult>;

export interface RememberInterviewSourceResult {
  ok: boolean;
  stage: 'resolve-scope' | 'remember-call' | 'done';
  scope: string | null;
  tag: string | null;
  text: string | null;
  file: string | null;
  chunksUpserted: number | null;
  response: RememberResponse | null;
  stdout: string;
  stderr: string;
  error: string | null;
}

export function rememberInterviewSource(
  persona: InterviewPersona,
  opts?: FireRememberCallOptions,
): Promise<RememberInterviewSourceResult>;
