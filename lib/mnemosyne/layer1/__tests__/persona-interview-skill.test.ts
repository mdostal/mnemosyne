// persona-interview-skill.test.ts — TDD coverage for pw-10-interview-skill-mechanics:
// skills/mnemosyne-persona-interview/'s interview-engine.mjs mechanics, and a
// structural check that SKILL.md itself actually states the required
// adaptive-skip / persistence / non-blocking-hard-fail instructions.
//
// Grounded against kickoff-protocol.md's REAL Phase 3b mechanics (see
// interview-engine.mjs's header comment for the line-by-line mapping), and
// against this repo's REAL Persona schema gate
// (lib/mnemosyne/layer1/persona.ts's assertValidPersona) and REAL
// remember()-scope resolver (persona.ts's resolveRememberScope, pw-09) —
// never a second, invented validation/mapping scheme.
//
// Two required interview runs (pw-10-interview-skill-mechanics.yaml's
// test-spec step): a full-answers run and a partially-skipped run, plus a
// max-skip run proving the non-blocking hard-fail rule against the REAL
// validator, plus an adaptive-skip-via-context run proving "does NOT re-ask."

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertValidPersona, resolveRememberScope, type Persona } from '../persona.js';
import { TIER_CONTENT } from '../tiers.js';
// interview-engine.mjs is plain ESM JS (no TS types) — imported by relative
// path exactly like the skill itself would load it; vitest resolves .mjs fine.
// eslint-disable-next-line import/extensions
import {
  CORE_QUESTIONS,
  OPTIONAL_QUESTIONS,
  NO_PARENT_TEXT,
  SKIP_PLACEHOLDER,
  buildRememberText,
  runPersonaInterview,
} from '../../../../skills/mnemosyne-persona-interview/interview-engine.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(__dirname, '../../../../skills/mnemosyne-persona-interview');
const SKILL_MD_PATH = path.join(SKILL_DIR, 'SKILL.md');
const KICKOFF_PROTOCOL_PATH = path.join(
  process.env.HOME || '',
  '.claude/plugins/cache/plugin-hive/plugin-hive/2.15.0/hive/references/kickoff-protocol.md',
);

describe('interview-engine: question sets mirror kickoff-protocol.md Phase 3b shape', () => {
  it('has exactly 3 core questions (design-discussion.md §3b: knows / not_hold / parent)', () => {
    expect(CORE_QUESTIONS.map((q) => q.id)).toEqual(['knows', 'not_hold', 'parent']);
  });

  it('has exactly 2 optional follow-ups, reusing kickoff Phase 3b\'s success/avoid shape', () => {
    expect(OPTIONAL_QUESTIONS.map((q) => q.id)).toEqual(['success', 'avoid']);
  });
});

describe('interview-engine: full-answers run', () => {
  it('produces a persona with every core + optional question answered, no placeholders', () => {
    const { persona, skippedCore, skippedOptional, answeredOptional } = runPersonaInterview({
      tier: 'code-architect',
      scopeId: 'mnemosyne',
      displayName: 'Code/Area Architect — mnemosyne',
      scope: 'Deep per-repo implementation detail for the mnemosyne repo only.',
      responses: {
        knows: 'The Layer 1 persona schema, the two-store split, and the interview skill mechanics.',
        not_hold: 'Company-wide business context or other repos\' implementation detail.',
        parent: 'project-orchestrator/mnemosyne-project',
        success: 'The interview produces a valid, writable persona every time.',
        avoid: 'Guessing at answers the operator never gave.',
      },
    });

    expect(skippedCore).toEqual([]);
    expect(skippedOptional).toEqual([]);
    expect(answeredOptional).toEqual(['success', 'avoid']);

    expect(persona.sections).toHaveLength(5);
    expect(persona.sections.map((s) => s.heading)).toEqual([
      'What this persona knows',
      'What this persona does NOT hold',
      'Parent to query up to',
      'Success',
      'Avoid',
    ]);
    expect(persona.sections.some((s) => s.body === SKIP_PLACEHOLDER)).toBe(false);
    expect(persona.parentRefs).toEqual([{ tier: 'project-orchestrator', scopeId: 'mnemosyne-project' }]);

    // Real schema gate — persona.ts's assertValidPersona, not a hand-rolled check.
    expect(() => assertValidPersona(persona as Persona, 'code-architect')).not.toThrow();

    // Real resolver (pw-09) — never a second, invented scope-mapping scheme.
    const { scope, tag } = resolveRememberScope(persona as Persona);
    expect(scope).toBe('persona-code-architect');
    expect(tag).toBe('mnemosyne');

    const rememberText = buildRememberText(persona);
    expect(rememberText).toContain('scopeId: mnemosyne');
    expect(rememberText).toContain('tier: code-architect');
  });
});

describe('interview-engine: partially-skipped run', () => {
  it('gives skipped CORE questions an explicit placeholder, omits skipped OPTIONAL questions entirely', () => {
    const { persona, skippedCore, skippedOptional, asked } = runPersonaInterview({
      tier: 'code-architect',
      scopeId: 'mnemosyne',
      displayName: 'Code/Area Architect — mnemosyne',
      scope: 'Deep per-repo implementation detail for the mnemosyne repo only.',
      responses: {
        knows: 'The Layer 1 persona schema.',
        // not_hold: skipped (no key at all)
        parent: { tier: 'project-orchestrator', scopeId: 'mnemosyne-project' },
        // success/avoid: skipped
      },
    });

    expect(asked).toEqual(['knows', 'not_hold', 'parent', 'success', 'avoid']);
    expect(skippedCore).toEqual(['not_hold']);
    expect(skippedOptional).toEqual(['success', 'avoid']);

    const notHoldSection = persona.sections.find((s) => s.heading === 'What this persona does NOT hold');
    expect(notHoldSection?.body).toBe(SKIP_PLACEHOLDER);

    // Optional sections omitted entirely — never present, not even as a placeholder.
    expect(persona.sections.some((s) => s.heading === 'Success')).toBe(false);
    expect(persona.sections.some((s) => s.heading === 'Avoid')).toBe(false);

    expect(persona.parentRefs).toEqual([{ tier: 'project-orchestrator', scopeId: 'mnemosyne-project' }]);

    expect(() => assertValidPersona(persona as Persona, 'code-architect')).not.toThrow();
  });

  it('an explicit "none" parent answer is NOT a placeholder — it is a real, answered value', () => {
    const { persona, skippedCore } = runPersonaInterview({
      tier: 'code-architect',
      scopeId: 'mnemosyne',
      responses: { knows: 'x', not_hold: 'y', parent: 'none' },
    });
    expect(skippedCore).toEqual([]);
    const parentSection = persona.sections.find((s) => s.heading === 'Parent to query up to');
    expect(parentSection?.body).toBe(NO_PARENT_TEXT);
    expect(parentSection?.body).not.toBe(SKIP_PLACEHOLDER);
    expect(persona.parentRefs).toBeUndefined();
    expect(() => assertValidPersona(persona as Persona, 'code-architect')).not.toThrow();
  });
});

describe('interview-engine: non-blocking hard-fail rule (max-skip)', () => {
  it('still produces a valid, writable Persona when every question is skipped and no overrides given', () => {
    const { persona, skippedCore, skippedOptional, asked, skippedByContext } = runPersonaInterview({
      tier: 'company-director',
      scopeId: 'acme-corp',
      // no displayName, no scope, no responses at all
    });

    expect(skippedByContext).toEqual([]);
    expect(asked).toEqual(['knows', 'not_hold', 'parent', 'success', 'avoid']);
    expect(skippedCore).toEqual(['knows', 'not_hold', 'parent']);
    expect(skippedOptional).toEqual(['success', 'avoid']);

    expect(persona.sections).toHaveLength(3);
    expect(persona.sections.every((s) => s.body === SKIP_PLACEHOLDER)).toBe(true);
    expect(persona.displayName.length).toBeGreaterThan(0);
    expect(persona.scope.length).toBeGreaterThan(0);
    expect(persona.parentRefs).toBeUndefined();

    // The actual, real gate this rule must satisfy — proves the hard-fail
    // rule end-to-end, not just structurally similar output.
    expect(() => assertValidPersona(persona as Persona, 'company-director')).not.toThrow();

    // scopeId is a required invocation parameter, not a question — a genuine
    // missing scopeId is a real programming error, not an interview skip.
    expect(() => runPersonaInterview({ tier: 'company-director', scopeId: '' })).toThrow(/scopeId/);
  });
});

describe('interview-engine: adaptive skip via context ("do NOT re-ask")', () => {
  it('uses context values verbatim and never asks for them, matching kickoff-protocol.md\'s adaptive-skip rule', () => {
    const { persona, asked, skippedByContext, skippedCore } = runPersonaInterview({
      tier: 'project-orchestrator',
      scopeId: 'mnemosyne-project',
      context: {
        knows: 'Already captured from project-profile.yaml discovery.',
        notHold: 'Already captured from project-profile.yaml discovery.',
        parent: { tier: 'company-director', scopeId: 'acme-corp' },
      },
      responses: {
        // Even if the operator answered these too, context wins (already-answered
        // items are not re-asked at all) -- proves context is checked BEFORE responses.
        knows: 'THIS SHOULD NEVER APPEAR',
      },
    });

    expect(skippedByContext).toEqual(['knows', 'not_hold', 'parent']);
    expect(asked).toEqual(['success', 'avoid']);
    expect(skippedCore).toEqual([]);

    const knowsSection = persona.sections.find((s) => s.heading === 'What this persona knows');
    expect(knowsSection?.body).toBe('Already captured from project-profile.yaml discovery.');
    expect(knowsSection?.body).not.toContain('THIS SHOULD NEVER APPEAR');

    expect(persona.parentRefs).toEqual([{ tier: 'company-director', scopeId: 'acme-corp' }]);
    expect(() => assertValidPersona(persona as Persona, 'project-orchestrator')).not.toThrow();
  });
});

describe('interview-engine: parameterized by tier/store — both repo-spinup-lifecycle moments (design-discussion.md §3e)', () => {
  it('authors a global-tier persona (top-orchestrator) with no repo involved at all', () => {
    const { persona } = runPersonaInterview({
      tier: 'top-orchestrator',
      scopeId: 'default',
      displayName: TIER_CONTENT['top-orchestrator'].displayName,
      scope: TIER_CONTENT['top-orchestrator'].scope,
      responses: { knows: 'x', not_hold: 'y', parent: 'none' },
    });
    expect(() => assertValidPersona(persona as Persona, 'top-orchestrator')).not.toThrow();
  });

  it('authors a code-architect persona (requires a repo to exist) with the same engine, just a different tier param', () => {
    const { persona } = runPersonaInterview({
      tier: 'code-architect',
      scopeId: 'mnemosyne',
      displayName: TIER_CONTENT['code-architect'].displayName,
      scope: TIER_CONTENT['code-architect'].scope,
      responses: { knows: 'x', not_hold: 'y', parent: 'project-orchestrator/mnemosyne-project' },
    });
    expect(() => assertValidPersona(persona as Persona, 'code-architect')).not.toThrow();
  });
});

describe('SKILL.md: structural grounding in kickoff-protocol.md Phase 3b', () => {
  const skillMd = readFileSync(SKILL_MD_PATH, 'utf8');

  it('names kickoff-protocol.md and Phase 3b explicitly (real grounding, not a superficial resemblance)', () => {
    expect(skillMd).toMatch(/kickoff-protocol\.md/);
    expect(skillMd).toMatch(/Phase 3b/);
  });

  it('states the adaptive-skip rule', () => {
    expect(skillMd).toMatch(/do not re-ask|does not re-ask|do NOT re-ask/i);
  });

  it('states the persistence rule with an explicit placeholder marker, distinct optional-omission behavior', () => {
    expect(skillMd).toContain(SKIP_PLACEHOLDER);
    expect(skillMd).toMatch(/omit/i);
  });

  it('states the non-blocking hard-fail rule', () => {
    expect(skillMd).toMatch(/non-blocking/i);
    expect(skillMd).toMatch(/hard-fail/i);
  });

  it('references assertValidPersona and resolveRememberScope (real integration points, not invented ones)', () => {
    expect(skillMd).toMatch(/assertValidPersona/);
    expect(skillMd).toMatch(/resolveRememberScope/);
  });

  it('documents both repo-spinup-lifecycle moments (design-discussion.md §3e)', () => {
    expect(skillMd).toMatch(/design-discussion\.md.*§3e|§3e/);
    expect(skillMd).toMatch(/before any repo exists|no repo exists/i);
    expect(skillMd).toMatch(/code-architect/);
  });

  // Skipped (not failed) if this machine doesn't have the plugin cached at
  // this exact path -- the earlier structural checks above already prove the
  // skill cites kickoff-protocol.md; this extra check, when available,
  // spot-checks that the cited mechanics genuinely exist in the real file.
  it('kickoff-protocol.md really contains a Phase 3b Discovery Questions section with adaptive skip + persistence + hard-fail rules', () => {
    let real: string;
    try {
      real = readFileSync(KICKOFF_PROTOCOL_PATH, 'utf8');
    } catch {
      return; // plugin cache not present on this machine/CI runner -- not this test's concern
    }
    expect(real).toMatch(/Phase 3b: Discovery Questions/);
    expect(real).toMatch(/Do NOT re-ask items already answered/);
    expect(real).toMatch(/Hard-fail rule/i);
  });
});
