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
   * The la-07 memory-lifecycle mandate (recall-on-entry, remember-on-exit,
   * flight-status awareness) -- see `MANDATE_SECTIONS` below. Identical
   * across every tier on purpose: it is a universal policy for "every agent,
   * regardless of harness", not a tier-scoped concern the way `sections` is.
   * `renderTierContentMarkdown` renders it under its own "Memory-lifecycle
   * mandate" heading whenever entries are present (unchanged from la-01).
   */
  mandateSections: TierContentSection[];
}

/**
 * la-07-layer1-enforcement-mandate: the actual enforcement-mandate content
 * la-01 left this extension point for. Closes the epic's previously-
 * identified highest-leverage gap -- recall works (real content, real high
 * similarity scores) but nothing forced an agent to call it, which is why
 * "we've discussed this before" kept recurring across sessions.
 *
 * Applies to every agent, regardless of harness (Claude Code / Codex /
 * Gemini CLI / whatever comes next) and regardless of tier: (a) recall on
 * entry, (b) remember on exit with outcome, (c) understand and respect
 * flight-status when building on recalled memory. Kept deliberately compact
 * -- Codex caps combined AGENTS.md content at `project_doc_max_bytes` (32
 * KiB default, see harness.ts), so this is not the place for a long essay.
 *
 * Where a harness has a real startup-hook mechanism, this text says so and
 * names it -- Claude Code's `hooks/pre-recall.mjs`/`hooks/post-remember.mjs`
 * (see hooks/README.md), wired to `UserPromptSubmit`/`Stop`/`SubagentStop`
 * via `bin/mnemosyne-install-hooks`, is real and already fires automatically
 * once installed (proven end-to-end, without a live Qdrant dependency, by
 * `test/hooks.mjs`'s `testHighLevelFirstThroughHook` and this story's own
 * `test/layer1-mandate-hook.mjs`). Codex and Gemini CLI have no equivalent
 * hook mechanism (la-01's harness.ts research findings) -- for those, this
 * instruction text IS the enforcement surface, degraded but not absent, per
 * this story's third acceptance criterion.
 *
 * Flight-status wording here must stay in lockstep with what la-05's
 * `status-filter.ts` actually implements (`isEntryVisible`): confirmed is
 * always visible, the caller's OWN branch's provisional is visible,
 * cross-branch provisional and superseded are hidden by default (never
 * deleted, reachable via the explicit `includeCrossBranchProvisional`
 * opt-in). Do not restate this from memory if `status-filter.ts` changes --
 * re-read it and update this text to match.
 *
 * Exported (pf-02) so `persona.ts`'s `getPersonaContent` can re-inject it as
 * an explicit, named step for scoped-persona content too -- the same shared,
 * code-owned constant the `tier()` builder below injects inline for the
 * hardcoded TIER_CONTENT map. A persona itself is never allowed to carry its
 * own `mandateSections` (see `persona.ts`'s `assertValidPersona`); this is
 * the one constant every render path re-attaches at render time.
 */
export const MANDATE_SECTIONS: readonly TierContentSection[] = [
  {
    heading: 'Recall on entry (mandatory)',
    body:
      "Before doing any work -- reading code, answering a question, planning a task -- call recall for this tier's scope first. On Claude Code, this already happens automatically: the installed `hooks/pre-recall.mjs` fires on every `UserPromptSubmit` (including the first prompt of a session, i.e. on entry) and injects prior memory into context -- see hooks/README.md; run `bin/mnemosyne-install-hooks` if this checkout's hooks are not yet wired into your settings.json. Codex and Gemini CLI have no equivalent startup-hook mechanism -- on those harnesses, YOU must call recall explicitly (the Mnemosyne service's `POST /recall`, or the `swarm-memory recall` CLI) before starting; this instruction is the enforcement surface. Skipping recall and re-deriving something already decided is the exact failure this mandate exists to close.",
  },
  {
    heading: 'Remember on exit (mandatory)',
    body:
      'Before ending a session or task, call remember with the outcome -- what you did, decided, or learned -- even a short note. On Claude Code this happens automatically via the installed `hooks/post-remember.mjs` on `Stop`/`SubagentStop`. On harnesses without a hook, call remember explicitly (`POST /remember`, or the `swarm-memory` CLI) before finishing. A task that ends without a remember() call leaves no trace for the next agent -- recall on entry only works if someone wrote it down.',
  },
  {
    heading: 'Flight-status awareness (mandatory)',
    body:
      "Every remembered entry carries a flight status resolved from real git state: `confirmed` on the default branch, `provisional` on any other branch, or `superseded` once replaced (never deleted). Default recall only surfaces `confirmed` entries plus your OWN current branch's `provisional` entries -- another branch's unmerged `provisional` work is hidden by default and must NOT be treated as settled fact, including if you deliberately surface it via the explicit cross-branch opt-in for review/debugging. If recall surfaces something and you are unsure of its status, treat it as provisional until independently confirmed -- never build on another branch's in-flight memory as if it were merged ground truth.",
  },
];

function tier(
  id: Tier,
  displayName: string,
  scope: string,
  sections: TierContentSection[],
): TierContent {
  return { tier: id, displayName, scope, sections, mandateSections: [...MANDATE_SECTIONS] };
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
