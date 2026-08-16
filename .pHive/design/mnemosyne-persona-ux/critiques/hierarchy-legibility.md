# Critique — Lens 7: Multi-tier/Multi-repo Hierarchy Legibility

**Lens brief:** This system exists to author personas that orchestrate across
projects/companies/repos. Does each design scale and orient correctly as
personas grow across 4 tiers, multiple repos, `parentRefs` chains, and now
pending drafts — not just for a 3-persona demo?

---

## Option 1 — Efficiency-First: Unified Table with Inline Draft Actions

### Strengths
- Tier and repo are both present as filter `<select>`s, so an operator who
  already knows what they're looking for (a specific tier, a specific repo)
  can narrow down quickly.
- Because live and draft rows share literally one table and one query, an
  operator never has to cross-reference two surfaces to see "where does this
  draft sit relative to what already exists" — everything is in one scroll.

### Weaknesses
- **No `Repo` column in the table itself.** The wireframe's column set is
  `Status | Tier | Scope ID | Display | Parent(s) | Action` — there is a
  *filter* for repo, but nothing in the row shows which repo a
  `code-architect` persona belongs to unless the operator has already
  filtered down to one repo. Since `code-architect` is explicitly the tier
  that fans out across an open-ended number of repos, this is exactly the
  place hierarchy legibility breaks first: in an unfiltered view of, say, 15
  `code-architect` personas across 6 repos, they are visually indistinguishable
  rows differentiated only by `scopeId` text.
- **Default sort actively works against tier/hierarchy structure.** Rows are
  "sorted by status first... then by tier/scopeId" with drafts floating to
  the top. That means the moment there are pending drafts scattered across
  multiple tiers, the natural tier ordering (Top Orchestrator → Company
  Director → Project Orchestrator → Code Architect) is broken up in the
  default view — the very structure this lens cares about is the first thing
  sacrificed for triage convenience.
- **`parentRefs` stays flat pointer text with no navigation.** The doc is
  explicit: `parentRefsText()` helper "unchanged, still pointer-only." As
  `parentRefs` chains deepen (a `code-architect` persona pointing up through
  `project-orchestrator` → `company-director` → `top-orchestrator`), there is
  no way to jump to or even confirm the parent exists in the current view —
  an operator has to manually search/scroll/filter for a `scopeId` string
  they just read as plain text.
- Nothing in this design addresses what happens once tier-4 (`code-architect`)
  rows genuinely outnumber every other tier by an order of magnitude, which
  is the realistic long-run shape of this hierarchy — a flat table with no
  grouping has no structural answer besides "use the filters," which is a
  manual, one-axis-at-a-time workaround rather than a designed affordance.

---

## Option 2 — Guided Step-by-Step Review Flow

### Strengths
- **Library tab groups explicitly by tier** via four `<h3>` sub-headings, and
  **`code-architect` rows carry an explicit `Repo` column** since multiple
  repos share that tier — this is a direct, named fix for the exact gap
  Option 1 has, and shows real awareness that tier alone doesn't disambiguate
  `code-architect` personas.
- The Review Queue's left rail has tier/repo filter chips, and the design
  explicitly states this "must stay legible at real scale (lens 1, 7)" —
  the option is self-aware about this lens even outside of the split
  chosen for it.
- Keeping Library "exactly as scannable/dense as it is today" by refusing to
  let draft/lifecycle chrome leak into it means the one place tier/repo
  hierarchy is shown stays uncluttered as the persona count grows — hierarchy
  legibility isn't fighting for the same pixels as review-state legibility.

### Weaknesses
- **The split is also the weakness for this lens specifically.** The moment
  a draft leaves Library (it "is never rendered as a row inside the Library
  table"), it enters the Review Queue's left rail, which — per its own
  wireframe — is a flat, newest-proposed-first list narrowed only by filter
  chips, with **no stated grouping by tier or repo**. So the tier/repo
  structure Library takes care to build is simply absent in the one place an
  operator is actively deciding to approve or discard content — exactly when
  understanding "where does this sit in the tree, and does it conflict with
  a sibling or parent" matters most.
- **No parentRefs rendering or navigation anywhere in the Review Queue step
  panel.** The 4-node stepper (Proposed → Reviewing → Decision → Resolved)
  occupies the header real estate that could otherwise show hierarchy
  context; nothing in steps 1–3 mentions showing the draft's `parentRefs` or
  letting a reviewer confirm the named parent tier/scopeId actually exists.
  A reviewer approving a brand-new `project-orchestrator` persona has no way,
  from this surface, to sanity-check its claimed parent without leaving the
  tab.
- The `↻ draft pending` deep-link from Library to Review Queue is one
  direction only (Library → Queue); there's no described reverse pointer
  (Queue → "here is this draft's position in the tier tree relative to its
  siblings/parent") once you're inside the Queue reviewing it.
- Two structurally separate surfaces mean an operator triaging drafts spread
  across many tiers/repos has to keep tier/repo context in their head while
  switching tabs, rather than the UI carrying it forward automatically.

---

## Option 3 — Unified Review Queue

### Strengths
- **`group by: Tier / Repo / Status` is a first-class, explicit toggle over
  the same data** — this is the only option that treats tier and repo as
  equally legitimate primary organizing axes rather than tier-as-structure /
  repo-as-filter (Option 1) or tier-as-structure-in-one-tab-only (Option 2).
- **Group headers are explicitly repo-qualified for `code-architect`** — the
  wireframe literally shows `▾ code-architect — /repo/mnemosyne (3)` — solving
  the "which repo is this `code-architect` persona scoped to" problem
  directly in the row grouping, not as an afterthought filter.
- **Row identity is explicitly `{tier, repo, scopeId}` for `code-architect`**,
  called out in prose — the design acknowledges `scopeId` alone is not unique
  across repos at this tier, which is the correct compound key for a system
  meant to scale across many repos, and the only option to say so explicitly.
- **`Parent(s)` becomes a real navigation affordance**: "where the named
  parent also has a row in this same queue, it renders as an in-page anchor
  that scrolls to and flashes that row." This is the only option that turns
  `parentRefs` from inert pointer text into something a reviewer can actually
  use to verify hierarchy integrity in place, without a second fetch or
  losing their spot.
- **Sticky group headers are explicitly justified for this lens**: "hierarchy
  never disappears just because you're mid-review of one row" — this is a
  direct, named design response to exactly this lens's concern, not an
  incidental side effect.
- Draft/review state and hierarchy are two axes of *one* structure by design
  intent ("not two different UIs a human has to reconcile in their head"),
  so — unlike Option 2 — a reviewer never loses tier/repo context the moment
  they start reviewing a specific draft; the accordion expands in place,
  under its sticky group header.

### Weaknesses
- Grouping is single-select (`Tier` **or** `Repo` **or** `Status`, not
  combined) — when grouped by `Repo`, the three global tiers collapse into
  one undifferentiated "global" bucket, which could obscure the
  `top-orchestrator`/`company-director`/`project-orchestrator` hierarchy
  precisely when an operator is thinking in repo terms (e.g. "what governs
  this repo, all the way up the chain?"). The design doesn't describe a
  combined tier+repo grouping view.
- The parent-anchor-jump depends on the parent row being present in the
  *current* filtered/grouped view — the design doesn't address what happens
  when the default `Needs review` filter (or a repo/tier group filter) hides
  the parent row entirely; the anchor could point at nothing visible without
  the operator realizing why.
- At real scale (many tiers × many repos × mixed statuses, some rows
  expanded into accordions with Current-vs-Proposed stacks), a single
  ever-growing grouped-and-filtered list could become visually heavy —
  the design doesn't discuss virtualization, pagination, or collapsing
  already-reviewed groups by default beyond the `History` filter.

---

## Closing assessment

**Option 3 serves this lens most strongly, and by a clear margin.** It is the
only option that (a) treats tier and repo as equally first-class, explicit
grouping axes rather than one being structural and the other a filter
bolted on, (b) explicitly names `{tier, repo, scopeId}` as the real
compound identity for `code-architect` personas, (c) turns `parentRefs` into
an actual in-page navigation affordance instead of inert text, and (d) keeps
hierarchy context (sticky group headers) visible through the entire
review/approve interaction rather than trading it away for review-state
clarity.

Option 2 is a reasonable second: its Library tab independently solves the
same `code-architect`-needs-a-repo-column problem Option 3 solves, but it
then largely drops hierarchy context the moment a draft is actually being
reviewed (the Review Queue tab has no stated tier/repo grouping and no
parent-verification affordance), which is a real gap given that reviewing
agent-proposed hierarchy placement is arguably the highest-stakes moment for
this lens.

Option 1 is clearly the weakest here: it has no `Repo` column at all in its
one table (repo is filter-only), its default sort actively breaks tier
ordering to prioritize drafts, and `parentRefs` remains flat, unnavigable
text — none of which scales past a small, single-repo demo.
