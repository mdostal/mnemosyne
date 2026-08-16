// Type declarations for persona-writer.mjs — kept as a thin, hand-written
// companion (no build step for this skill's helper script), mirroring
// interview-engine.d.mts's own convention, so TS-aware callers/tests
// (lib/mnemosyne/layer1/__tests__/persona-interview-output.test.ts) get
// real types instead of `any`. Source of truth for behavior is
// persona-writer.mjs itself; this file must stay in lockstep with it.

import type { InterviewPersona } from './interview-engine.d.mts';

export interface WritePersonaViaCliOptions {
  repo?: string;
  root?: string;
  home?: string;
}

export interface WritePersonaViaCliResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  writtenPath: string | null;
}

export interface ShowPersonaViaCliOptions {
  home?: string;
}

export interface ShowPersonaViaCliResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export function personaToYaml(persona: InterviewPersona): string;

export function writePersonaViaCli(
  persona: InterviewPersona,
  opts?: WritePersonaViaCliOptions,
): Promise<WritePersonaViaCliResult>;

export function showPersonaViaCli(
  tier: string,
  scopeId: string,
  opts?: ShowPersonaViaCliOptions,
): Promise<ShowPersonaViaCliResult>;
