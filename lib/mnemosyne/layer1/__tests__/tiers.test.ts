import { describe, expect, it } from 'vitest';
import { TIERS, TIER_CONTENT, getTierContent, renderTierContentMarkdown } from '../tiers.js';

describe('tier content model', () => {
  it('defines exactly the reconciled 4-tier hierarchy, in order top -> code', () => {
    expect(TIERS).toEqual(['top-orchestrator', 'company-director', 'project-orchestrator', 'code-architect']);
  });

  it('has a TierContent entry for every declared tier', () => {
    for (const tier of TIERS) {
      expect(TIER_CONTENT[tier]).toBeDefined();
      expect(TIER_CONTENT[tier].tier).toBe(tier);
    }
  });

  it('getTierContent throws a clear error for an unknown tier', () => {
    // @ts-expect-error deliberately invalid tier for the runtime check
    expect(() => getTierContent('nonexistent-tier')).toThrow(/unknown tier/i);
  });

  it('content differs meaningfully between the top orchestrator and code architect tiers', () => {
    const top = renderTierContentMarkdown(getTierContent('top-orchestrator'));
    const codeArchitect = renderTierContentMarkdown(getTierContent('code-architect'));
    expect(top).not.toEqual(codeArchitect);
    // A code-tier agent should not receive full company-level context.
    expect(codeArchitect.toLowerCase()).not.toContain('company director');
    // The top tier should not carry deep per-repo/code detail language.
    expect(top.toLowerCase()).not.toContain('graph-scoped');
  });

  it('content differs meaningfully between at least two adjacent tiers (company director vs project orchestrator)', () => {
    const companyDirector = renderTierContentMarkdown(getTierContent('company-director'));
    const projectOrchestrator = renderTierContentMarkdown(getTierContent('project-orchestrator'));
    expect(companyDirector).not.toEqual(projectOrchestrator);
  });

  it('every tier has an explicit, currently-empty mandate extension point for la-07', () => {
    for (const tier of TIERS) {
      expect(Array.isArray(TIER_CONTENT[tier].mandateSections)).toBe(true);
      expect(TIER_CONTENT[tier].mandateSections).toHaveLength(0);
    }
  });

  it('renderTierContentMarkdown includes mandate sections when present (extension point works)', () => {
    const base = getTierContent('code-architect');
    const withMandate = {
      ...base,
      mandateSections: [{ heading: 'Recall on entry', body: 'Call recall() before starting work.' }],
    };
    const rendered = renderTierContentMarkdown(withMandate);
    expect(rendered).toContain('Recall on entry');
    expect(rendered).toContain('Call recall() before starting work.');
  });

  it('rendered content includes the tier display name so a human can tell which tier a file is', () => {
    for (const tier of TIERS) {
      const rendered = renderTierContentMarkdown(getTierContent(tier));
      expect(rendered).toContain(TIER_CONTENT[tier].displayName);
    }
  });
});
