// Type declarations for interview-engine.mjs — kept as a thin, hand-written
// companion (no build step for this skill's helper script) so TS-aware
// callers/tests (lib/mnemosyne/layer1/__tests__/persona-interview-skill.test.ts)
// get real types instead of `any`. Source of truth for behavior is
// interview-engine.mjs itself; this file must stay in lockstep with it.

export interface InterviewQuestion {
  id: string;
  prompt: string;
  sectionHeading: string;
  contextKey: string;
}

export interface PersonaSection {
  heading: string;
  body: string;
}

export interface InterviewParentRef {
  tier: string;
  scopeId: string;
}

export interface InterviewPersona {
  tier: string;
  scopeId: string;
  displayName: string;
  scope: string;
  sections: PersonaSection[];
  parentRefs?: InterviewParentRef[];
}

export type AnswerSource = 'context' | 'answered' | 'skipped';

export interface ResolvedAnswer {
  value: unknown;
  source: AnswerSource;
}

export interface RunPersonaInterviewInput {
  tier: string;
  scopeId: string;
  displayName?: string;
  scope?: string;
  context?: Record<string, unknown>;
  responses?: Record<string, unknown>;
}

export interface RunPersonaInterviewResult {
  persona: InterviewPersona;
  asked: string[];
  skippedByContext: string[];
  skippedCore: string[];
  answeredOptional: string[];
  skippedOptional: string[];
}

export const SKIP_PLACEHOLDER: string;
export const NO_PARENT_TEXT: string;
export const CORE_QUESTIONS: InterviewQuestion[];
export const OPTIONAL_QUESTIONS: InterviewQuestion[];

export function resolveAnswer(
  question: InterviewQuestion,
  opts?: { context?: Record<string, unknown>; responses?: Record<string, unknown> },
): ResolvedAnswer;

export function runPersonaInterview(input: RunPersonaInterviewInput): RunPersonaInterviewResult;

export function buildRememberText(persona: InterviewPersona): string;
