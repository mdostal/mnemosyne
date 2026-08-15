import { describe, expect, it } from 'vitest';
import { PERSONA_STORE_BY_TIER, assertValidPersona, type Persona } from '../persona.js';
import { TIERS } from '../tiers.js';

function validPersona(overrides: Partial<Persona> = {}): Persona {
  return {
    tier: 'code-architect',
    scopeId: 'mnemosyne',
    displayName: 'Code/Area Architect — mnemosyne',
    scope: 'Deep per-repo implementation detail for this repo only.',
    sections: [{ heading: 'What this tier owns', body: 'Repo-specific conventions and patterns.' }],
    ...overrides,
  };
}

describe('PERSONA_STORE_BY_TIER', () => {
  it('maps every declared tier to a store kind', () => {
    for (const tier of TIERS) {
      expect(PERSONA_STORE_BY_TIER[tier]).toBeDefined();
    }
  });

  it('maps code-architect to repo-local -- the only tier the repo-local store holds', () => {
    expect(PERSONA_STORE_BY_TIER['code-architect']).toBe('repo-local');
  });

  it('maps top-orchestrator, company-director, and project-orchestrator to global', () => {
    expect(PERSONA_STORE_BY_TIER['top-orchestrator']).toBe('global');
    expect(PERSONA_STORE_BY_TIER['company-director']).toBe('global');
    expect(PERSONA_STORE_BY_TIER['project-orchestrator']).toBe('global');
  });
});

describe('assertValidPersona', () => {
  it('accepts a well-formed persona whose tier matches the expected tier', () => {
    expect(() => assertValidPersona(validPersona(), 'code-architect')).not.toThrow();
  });

  it('rejects a candidate with a mandateSections key present, even if empty -- never author-storable', () => {
    const candidate = { ...validPersona(), mandateSections: [] };
    expect(() => assertValidPersona(candidate, 'code-architect')).toThrow(/mandateSections/);
  });

  it('rejects a candidate with a mandateSections key present with real content', () => {
    const candidate = {
      ...validPersona(),
      mandateSections: [{ heading: 'Recall on entry', body: 'Call recall() first.' }],
    };
    expect(() => assertValidPersona(candidate, 'code-architect')).toThrow(/mandateSections/);
  });

  it('rejects a candidate whose tier does not match the expected tier', () => {
    const candidate = validPersona({ tier: 'company-director' });
    expect(() => assertValidPersona(candidate, 'code-architect')).toThrow(/tier/i);
  });

  it('rejects a candidate with an unknown tier value', () => {
    // assertValidPersona's first param is `unknown` -- deliberately invalid
    // tier value here to exercise the runtime check, no cast needed.
    const candidate = { ...validPersona(), tier: 'nonexistent-tier' };
    expect(() => assertValidPersona(candidate, 'code-architect')).toThrow();
  });

  it('rejects a candidate missing scopeId', () => {
    const candidate: Record<string, unknown> = { ...validPersona() };
    delete candidate.scopeId;
    expect(() => assertValidPersona(candidate, 'code-architect')).toThrow(/scopeId/i);
  });

  it('rejects a candidate with a blank scopeId', () => {
    const candidate = validPersona({ scopeId: '   ' });
    expect(() => assertValidPersona(candidate, 'code-architect')).toThrow(/scopeId/i);
  });

  it('rejects a candidate missing displayName', () => {
    const candidate: Record<string, unknown> = { ...validPersona() };
    delete candidate.displayName;
    expect(() => assertValidPersona(candidate, 'code-architect')).toThrow(/displayName/i);
  });

  it('rejects a candidate missing scope', () => {
    const candidate: Record<string, unknown> = { ...validPersona() };
    delete candidate.scope;
    expect(() => assertValidPersona(candidate, 'code-architect')).toThrow(/scope/i);
  });

  it('rejects a candidate missing sections', () => {
    const candidate: Record<string, unknown> = { ...validPersona() };
    delete candidate.sections;
    expect(() => assertValidPersona(candidate, 'code-architect')).toThrow(/sections/i);
  });

  it('rejects a candidate whose sections entries are malformed', () => {
    const candidate = { ...validPersona(), sections: [{ heading: 'ok' }] };
    expect(() => assertValidPersona(candidate, 'code-architect')).toThrow(/sections/i);
  });

  it('accepts an optional parentRefs array of {tier, scopeId} pairs', () => {
    const candidate = validPersona({
      parentRefs: [{ tier: 'project-orchestrator', scopeId: 'project-x' }],
    });
    expect(() => assertValidPersona(candidate, 'code-architect')).not.toThrow();
  });

  it('accepts a persona with no parentRefs at all (optional field)', () => {
    const candidate = validPersona();
    expect(() => assertValidPersona(candidate, 'code-architect')).not.toThrow();
  });

  it('rejects a non-array parentRefs', () => {
    const candidate = { ...validPersona(), parentRefs: 'acme-corp' };
    expect(() => assertValidPersona(candidate, 'code-architect')).toThrow(/parentRefs/i);
  });

  it('rejects a parentRefs array containing bare strings instead of {tier, scopeId} pairs', () => {
    const candidate = { ...validPersona(), parentRefs: ['acme-corp', 'project-x'] };
    expect(() => assertValidPersona(candidate, 'code-architect')).toThrow(/parentRefs/i);
  });

  it('rejects a parentRefs entry with an invalid tier', () => {
    const candidate = {
      ...validPersona(),
      parentRefs: [{ tier: 'not-a-real-tier', scopeId: 'project-x' }],
    };
    expect(() => assertValidPersona(candidate, 'code-architect')).toThrow(/parentRefs/i);
  });

  it('rejects a parentRefs entry with an empty scopeId', () => {
    const candidate = {
      ...validPersona(),
      parentRefs: [{ tier: 'project-orchestrator', scopeId: '' }],
    };
    expect(() => assertValidPersona(candidate, 'code-architect')).toThrow(/parentRefs/i);
  });

  it('rejects a non-object candidate', () => {
    expect(() => assertValidPersona(null, 'code-architect')).toThrow();
    expect(() => assertValidPersona('not-an-object', 'code-architect')).toThrow();
    expect(() => assertValidPersona(42, 'code-architect')).toThrow();
  });
});
