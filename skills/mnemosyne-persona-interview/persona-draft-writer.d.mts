// Type declarations for persona-draft-writer.mjs — kept as a thin,
// hand-written companion (no build step for this skill's helper script),
// mirroring persona-writer.d.mts's own convention, so TS-aware
// callers/tests (lib/mnemosyne/layer1/__tests__/persona-interview-draft-output.test.ts)
// get real types instead of `any`. Source of truth for behavior is
// persona-draft-writer.mjs itself; this file must stay in lockstep with it.

import type { InterviewPersona } from './interview-engine.d.mts';

export interface DraftMetadataOptions {
  proposedBy?: string;
  proposedAt?: string;
  sourceSummary?: string;
}

export type DraftPersonaCandidate = InterviewPersona & {
  proposedBy: string;
  proposedAt: string;
  sourceSummary?: string;
};

export interface WriteDraftPersonaViaCliOptions extends DraftMetadataOptions {
  repo?: string;
  home?: string;
}

export interface WriteDraftPersonaViaCliResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  writtenPath: string | null;
}

export function personaToDraftCandidate(
  persona: InterviewPersona,
  opts?: DraftMetadataOptions,
): DraftPersonaCandidate;

export function personaDraftToYaml(persona: InterviewPersona, opts?: DraftMetadataOptions): string;

export function writeDraftPersonaViaCli(
  persona: InterviewPersona,
  opts?: WriteDraftPersonaViaCliOptions,
): Promise<WriteDraftPersonaViaCliResult>;
