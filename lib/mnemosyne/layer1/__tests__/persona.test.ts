import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PERSONA_STORE_BY_TIER, assertValidPersona, getPersonaContent, type Persona } from '../persona.js';
import { writeRepoLocalPersona } from '../persona-store-repo-local.js';
import { writeGlobalPersona } from '../persona-store-global.js';
import { TIER_CONTENT, TIERS, type Tier } from '../tiers.js';

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

describe('getPersonaContent', () => {
  const tempRoots: string[] = [];
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function makeTempRepoRoot(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), 'mnemosyne-getpersonacontent-'));
    tempRoots.push(root);
    return root;
  }

  /**
   * A temp `globalPersonaRoot` for every getPersonaContent call in this
   * describe block that touches a global tier -- keeps global-tier dispatch
   * tests hermetic (never reads/writes the real `~/.mnemosyne/personas`),
   * mirroring `makeTempRepoRoot`'s role for the repo-local path.
   */
  async function makeTempGlobalRoot(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), 'mnemosyne-getpersonacontent-global-'));
    tempRoots.push(root);
    return root;
  }

  it("dispatches code-architect to the repo-local store and returns that persona's content when one exists for the scopeId", async () => {
    const root = await makeTempRepoRoot();
    const persona = validPersona({
      scopeId: 'my-scope',
      displayName: 'Custom Architect — my-scope',
      scope: 'A custom, persona-authored scope statement.',
      sections: [{ heading: 'Custom heading', body: 'Custom body specific to my-scope.' }],
    });
    writeRepoLocalPersona(root, persona);

    const content = getPersonaContent('code-architect', 'my-scope', { repoRoot: root });

    expect(content.tier).toBe('code-architect');
    expect(content.displayName).toBe('Custom Architect — my-scope');
    expect(content.scope).toBe(persona.scope);
    expect(content.sections).toEqual(persona.sections);
  });

  it('re-injects MANDATE_SECTIONS as an explicit step on a repo-local persona hit (personas never store their own mandate)', async () => {
    const root = await makeTempRepoRoot();
    writeRepoLocalPersona(root, validPersona({ scopeId: 'mandate-check' }));

    const content = getPersonaContent('code-architect', 'mandate-check', { repoRoot: root });

    expect(content.mandateSections).toEqual(TIER_CONTENT['code-architect'].mandateSections);
    expect(content.mandateSections.length).toBeGreaterThan(0);
  });

  it("falls back to TIER_CONTENT['code-architect'] and warns (not silently) when no repo-local persona exists yet for the scopeId", async () => {
    const root = await makeTempRepoRoot();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const content = getPersonaContent('code-architect', 'never-seeded', { repoRoot: root });

    expect(content).toEqual(TIER_CONTENT['code-architect']);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/fallback|falling back/i);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('never-seeded');

    warnSpy.mockRestore();
  });

  it('does not warn when a repo-local persona is actually found', async () => {
    const root = await makeTempRepoRoot();
    writeRepoLocalPersona(root, validPersona({ scopeId: 'found-scope' }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    getPersonaContent('code-architect', 'found-scope', { repoRoot: root });

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it.each(['top-orchestrator', 'company-director', 'project-orchestrator'] as const)(
    "falls back to TIER_CONTENT[tier] for non-code-architect tier '%s' when no global persona exists yet (pf-07: now via the real global-store check, not an unconditional return)",
    async (tier) => {
      const globalRoot = await makeTempGlobalRoot();
      const content = getPersonaContent(tier, 'any-scope-id', { repoRoot: '/does/not/exist', globalPersonaRoot: globalRoot });
      expect(content).toEqual(TIER_CONTENT[tier]);
    },
  );

  it('never touches the repo-local store for a non-code-architect tier, even if a persona file happens to exist at that path', async () => {
    // Regression guard for the epic's flagged medium-severity risk: a
    // dispatch bug could route a non-code-architect tier through the
    // repo-local store by mistake.
    const root = await makeTempRepoRoot();
    const globalRoot = await makeTempGlobalRoot();
    writeRepoLocalPersona(root, validPersona({ scopeId: 'shared-scope' }));

    const content = getPersonaContent('project-orchestrator', 'shared-scope', { repoRoot: root, globalPersonaRoot: globalRoot });

    expect(content).toEqual(TIER_CONTENT['project-orchestrator']);
  });

  it('throws a clear error for an unknown tier (equivalent to the old getTierContent behavior)', () => {
    expect(() =>
      // @ts-expect-error deliberately invalid tier for the runtime check
      getPersonaContent('nonexistent-tier', 'some-scope', { repoRoot: '/does/not/exist' }),
    ).toThrow(/unknown tier/i);
  });

  describe('global-tier dispatch (top-orchestrator / company-director / project-orchestrator via the global store, pf-07)', () => {
    const globalTiers = ['top-orchestrator', 'company-director', 'project-orchestrator'] as const;

    function validGlobalPersona(tier: Tier, overrides: Partial<Persona> = {}): Persona {
      return validPersona({
        tier,
        scopeId: 'acme-corp',
        displayName: `${TIER_CONTENT[tier].displayName} — acme-corp`,
        scope: 'A custom, persona-authored scope statement for the global store.',
        sections: [{ heading: 'Custom heading', body: 'Custom body specific to acme-corp.' }],
        ...overrides,
      });
    }

    it.each(globalTiers)(
      "dispatches '%s' to the global store and returns that persona's content when one exists for the (tier, scopeId) pair",
      async (tier) => {
        const globalRoot = await makeTempGlobalRoot();
        const persona = validGlobalPersona(tier);
        writeGlobalPersona(persona, globalRoot);

        const content = getPersonaContent(tier, 'acme-corp', { repoRoot: '/does/not/exist', globalPersonaRoot: globalRoot });

        expect(content.tier).toBe(tier);
        expect(content.displayName).toBe(persona.displayName);
        expect(content.scope).toBe(persona.scope);
        expect(content.sections).toEqual(persona.sections);
      },
    );

    it.each(globalTiers)(
      "re-injects MANDATE_SECTIONS as an explicit step on a global persona hit for '%s' (personas never store their own mandate)",
      async (tier) => {
        const globalRoot = await makeTempGlobalRoot();
        writeGlobalPersona(validGlobalPersona(tier, { scopeId: 'mandate-check' }), globalRoot);

        const content = getPersonaContent(tier, 'mandate-check', { repoRoot: '/does/not/exist', globalPersonaRoot: globalRoot });

        expect(content.mandateSections).toEqual(TIER_CONTENT[tier].mandateSections);
        expect(content.mandateSections.length).toBeGreaterThan(0);
      },
    );

    it.each(globalTiers)(
      "falls back to TIER_CONTENT['%s'] and warns (not silently) when no global persona exists yet for the (tier, scopeId) pair",
      async (tier) => {
        const globalRoot = await makeTempGlobalRoot();
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        const content = getPersonaContent(tier, 'never-seeded', { repoRoot: '/does/not/exist', globalPersonaRoot: globalRoot });

        expect(content).toEqual(TIER_CONTENT[tier]);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0]?.[0]).toMatch(/fallback|falling back/i);
        expect(warnSpy.mock.calls[0]?.[0]).toContain('never-seeded');

        warnSpy.mockRestore();
      },
    );

    it('does not warn when a global persona is actually found', async () => {
      const globalRoot = await makeTempGlobalRoot();
      writeGlobalPersona(validGlobalPersona('company-director', { scopeId: 'found-scope' }), globalRoot);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      getPersonaContent('company-director', 'found-scope', { repoRoot: '/does/not/exist', globalPersonaRoot: globalRoot });

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('never touches the global store for the code-architect tier, even if a global persona file happens to exist at that (tier-shaped) path', async () => {
      // Mirror of the existing repo-local regression guard above, in the other direction: a
      // dispatch bug could route code-architect through the global store by mistake.
      const root = await makeTempRepoRoot();
      const globalRoot = await makeTempGlobalRoot();
      writeGlobalPersona(validGlobalPersona('company-director', { scopeId: 'cross-store-scope' }), globalRoot);

      const content = getPersonaContent('code-architect', 'cross-store-scope', { repoRoot: root, globalPersonaRoot: globalRoot });

      expect(content).toEqual(TIER_CONTENT['code-architect']);
    });

    it('defaults globalPersonaRoot to DEFAULT_GLOBAL_PERSONA_ROOT when omitted from ctx (real call-site shape: sync.ts only ever passes repoRoot)', () => {
      // No globalPersonaRoot given at all -- this must not throw, and since nothing is seeded
      // under the real ~/.mnemosyne/personas for this scopeId, it must fall back cleanly.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      const content = getPersonaContent('top-orchestrator', 'pf-07-default-root-probe-scope', { repoRoot: '/does/not/exist' });

      expect(content).toEqual(TIER_CONTENT['top-orchestrator']);
      warnSpy.mockRestore();
    });

    it('fallback warning wording matches the repo-local path\'s pattern exactly, save for the store-kind word -- proves the two paths share one implementation, not a drifted copy', async () => {
      const root = await makeTempRepoRoot();
      const globalRoot = await makeTempGlobalRoot();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      getPersonaContent('code-architect', 'shared-wording-check', { repoRoot: root, globalPersonaRoot: globalRoot });
      const repoLocalMessage = warnSpy.mock.calls[0]?.[0] as string;
      warnSpy.mockClear();

      getPersonaContent('company-director', 'shared-wording-check', { repoRoot: root, globalPersonaRoot: globalRoot });
      const globalMessage = warnSpy.mock.calls[0]?.[0] as string;
      warnSpy.mockRestore();

      // Same shape modulo the store-kind word and tier/scopeId values -- normalize those out and
      // the two messages should collapse to the same template string.
      const normalize = (msg: string) =>
        msg
          .replace(/repo-local|global/g, '<store-kind>')
          .replace(/'code-architect'|'company-director'/g, '<tier>')
          .replace(/\(expected at [^)]+\)/, '(expected at <path>)');
      expect(normalize(repoLocalMessage)).toBe(normalize(globalMessage));
    });
  });
});
