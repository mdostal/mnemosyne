import { describe, expect, it } from 'vitest';
import { TIERS, TIER_CONTENT, renderTierContentMarkdown } from '../tiers.js';

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

  it('content differs meaningfully between the top orchestrator and code architect tiers', () => {
    const top = renderTierContentMarkdown(TIER_CONTENT['top-orchestrator']);
    const codeArchitect = renderTierContentMarkdown(TIER_CONTENT['code-architect']);
    expect(top).not.toEqual(codeArchitect);
    // A code-tier agent should not receive full company-level context.
    expect(codeArchitect.toLowerCase()).not.toContain('company director');
    // The top tier should not carry deep per-repo/code detail language.
    expect(top.toLowerCase()).not.toContain('graph-scoped');
  });

  it('content differs meaningfully between at least two adjacent tiers (company director vs project orchestrator)', () => {
    const companyDirector = renderTierContentMarkdown(TIER_CONTENT['company-director']);
    const projectOrchestrator = renderTierContentMarkdown(TIER_CONTENT['project-orchestrator']);
    expect(companyDirector).not.toEqual(projectOrchestrator);
  });

  it('every tier has the la-07 memory-lifecycle mandate populated in its mandate extension point', () => {
    for (const tier of TIERS) {
      expect(Array.isArray(TIER_CONTENT[tier].mandateSections)).toBe(true);
      expect(TIER_CONTENT[tier].mandateSections.length).toBeGreaterThan(0);
    }
  });

  it('the mandate covers recall-on-entry, remember-on-exit, and flight-status awareness for every tier (la-07 acceptance criteria)', () => {
    for (const tier of TIERS) {
      const rendered = renderTierContentMarkdown(TIER_CONTENT[tier]).toLowerCase();
      // (a) call recall on entry
      expect(rendered).toContain('recall');
      // (b) call remember on exit with outcome
      expect(rendered).toContain('remember');
      // (c) understand and respect flight-status
      expect(rendered).toContain('provisional');
      expect(rendered).toContain('confirmed');
      expect(rendered).toContain('superseded');
    }
  });

  it('mandate content is rendered under the "Memory-lifecycle mandate" heading for every tier', () => {
    for (const tier of TIERS) {
      const rendered = renderTierContentMarkdown(TIER_CONTENT[tier]);
      expect(rendered).toContain('Memory-lifecycle mandate');
    }
  });

  it('mandate content is identical across every tier -- this is a universal policy, not a per-tier one', () => {
    const mandates = TIERS.map((tier) => JSON.stringify(TIER_CONTENT[tier].mandateSections));
    expect(new Set(mandates).size).toBe(1);
  });

  it('mandate content warns against treating another branch\'s provisional memory as confirmed ground truth', () => {
    const rendered = renderTierContentMarkdown(TIER_CONTENT['code-architect']).toLowerCase();
    expect(rendered).toMatch(/own (current )?branch|caller's own branch/);
    expect(rendered).toContain('cross-branch');
  });

  it('renderTierContentMarkdown includes mandate sections when present (extension point works)', () => {
    const base = TIER_CONTENT['code-architect'];
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
      const rendered = renderTierContentMarkdown(TIER_CONTENT[tier]);
      expect(rendered).toContain(TIER_CONTENT[tier].displayName);
    }
  });
});
