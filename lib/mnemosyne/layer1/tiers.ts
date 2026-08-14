/**
 * Layer 1 — tier-content model.
 *
 * "Layer 1" is the hard-locked, role/tier-scoped base-understanding content
 * every agent loads at start, piggybacking on each harness's own native
 * auto-load file (CLAUDE.md / AGENTS.md / GEMINI.md — see harness.ts). This
 * module is the single source of truth for WHAT content each tier carries.
 * `sync.ts` handles WHERE it gets written and how re-runs stay idempotent.
 *
 * Tiers are the reconciled 4-tier hierarchy from
 * docs/layer-architecture-v2-plan.md §1:
 *
 *   top orchestrator (Auriga) -> company director -> project orchestrator
 *   -> code/area architect
 *
 * Each tier gets a DIFFERENT slice of content on purpose — a code-tier agent
 * must not receive full company-level context, and a top-tier agent must not
 * receive deep per-repo code detail. Cross-project impact is always answered
 * by querying UP the hierarchy, never by holding it locally at a lower tier.
 *
 * Story: la-01-role-meta-file-sync (epic: mnemosyne-layer-architecture-v2)
 */

export const TIERS = [
  'top-orchestrator',
  'company-director',
  'project-orchestrator',
  'code-architect',
] as const;

export type Tier = (typeof TIERS)[number];

export interface TierContentSection {
  heading: string;
  body: string;
}

export interface TierContent {
  tier: Tier;
  /** Human-readable tier name, e.g. "Code/Area Architect". Rendered as a heading. */
  displayName: string;
  /** One-line statement of what this tier is responsible for and, just as importantly, what it is NOT. */
  scope: string;
  sections: TierContentSection[];
  /**
   * EXTENSION POINT for la-07 (Layer-1 enforcement mandate — recall-on-entry,
   * remember-on-exit, flight-status handling). Deliberately empty in la-01:
   * this story builds the sync mechanism and the tier-content model only, not
   * the mandate content itself. la-07 populates this array per tier; nothing
   * else in this module needs to change for that to work, and
   * `renderTierContentMarkdown` already renders it under its own heading
   * whenever entries are present.
   */
  mandateSections: TierContentSection[];
}

function tier(
  id: Tier,
  displayName: string,
  scope: string,
  sections: TierContentSection[],
): TierContent {
  return { tier: id, displayName, scope, sections, mandateSections: [] };
}

export const TIER_CONTENT: Record<Tier, TierContent> = {
  'top-orchestrator': tier(
    'top-orchestrator',
    'Top Orchestrator (Auriga)',
    'Coordinates every company director across the whole organization. Holds north-star/company-portfolio context only.',
    [
      {
        heading: 'What this tier owns',
        body: 'The single top-level view across all companies and all projects Pantheon runs. Sets and protects the overall north star. Coordinates company directors — does not talk to project orchestrators or code architects directly.',
      },
      {
        heading: 'What this tier does NOT hold',
        body: 'No per-repo, per-project, or per-task detail. If a question needs project-level or code-level specifics, delegate down to the relevant company director rather than guessing or fabricating detail at this tier.',
      },
      {
        heading: 'Cross-company impact',
        body: 'This is the only tier that can see across companies. Company directors query up to here for anything that spans more than one company.',
      },
    ],
  ),
  'company-director': tier(
    'company-director',
    'Company Director',
    "Owns one company's product/business context and coordinates that company's project orchestrators.",
    [
      {
        heading: 'What this tier owns',
        body: "This company's product and business context, and coordination across every project orchestrator inside this company. Escalates to the top orchestrator (Auriga) for anything that spans multiple companies.",
      },
      {
        heading: 'What this tier does NOT hold',
        body: 'No other company\'s context. No deep per-repo implementation detail — that belongs to project orchestrators and code architects underneath this tier; query down for it rather than assuming it.',
      },
      {
        heading: 'Cross-project impact (within this company)',
        body: "Cross-project questions within this company are answered by querying HERE — never held locally at a project orchestrator or code architect as if it were confirmed company-wide fact.",
      },
    ],
  ),
  'project-orchestrator': tier(
    'project-orchestrator',
    'Project Orchestrator',
    "Repo-level way-of-working for a single project — integrations, third-party dependencies, rough architecture. Doesn't change per-task.",
    [
      {
        heading: 'What this tier owns',
        body: "This single project's way of working: how it integrates with third-party systems and other projects, its rough architecture, and coordination across the code/area architects working inside it. This content changes rarely — new integrations, architecture shifts — not on every task.",
      },
      {
        heading: 'What this tier does NOT hold',
        body: "No company-wide or cross-company context (escalate to the company director for that). No task-by-task, module-by-module implementation detail that changes every task — that belongs to code/area architects.",
      },
      {
        heading: 'Escalation',
        body: 'Cross-project impact is answered by querying up to the company director, never assumed locally.',
      },
    ],
  ),
  'code-architect': tier(
    'code-architect',
    'Code/Area Architect',
    'Graph-scoped to the specific code area being touched right now. Changes per-task.',
    [
      {
        heading: 'What this tier owns',
        body: "Deep, current detail on the specific code area being touched for the task at hand — implementation patterns, local conventions, the parts of the code graph relevant right now. This content is expected to change per-task, unlike the tiers above it.",
      },
      {
        heading: 'What this tier does NOT hold',
        body: 'No project-wide way-of-working, no company-level, no cross-company context. Do not infer or fabricate context at those scopes — escalate a question up through the project orchestrator instead of guessing.',
      },
    ],
  ),
};

export function getTierContent(tier: Tier): TierContent {
  const found = TIER_CONTENT[tier];
  if (!found) {
    throw new Error(
      `Unknown tier: ${String(tier)}. Valid tiers are: ${TIERS.join(', ')}.`,
    );
  }
  return found;
}

function renderSection(section: TierContentSection): string {
  return `### ${section.heading}\n\n${section.body}`;
}

export function renderTierContentMarkdown(content: TierContent): string {
  const parts = [
    `## ${content.displayName}`,
    '',
    `_${content.scope}_`,
    '',
    ...content.sections.map((section) => renderSection(section)),
  ];

  if (content.mandateSections.length > 0) {
    parts.push('### Memory-lifecycle mandate', ...content.mandateSections.map((section) => renderSection(section)));
  }

  return parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}
