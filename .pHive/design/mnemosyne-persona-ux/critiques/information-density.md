# Critique — Information Density / Scannability

**Lens brief:** Every existing panel in this UI (Lanes, Search, Graph,
Operations) is a dense, structured-data, table/monospace surface operating at
real multi-tier/multi-repo scale, not toy-demo scale. Does this design
regress "scan a lot of real data fast" in service of looking cleaner?

---

## Option 1 — Efficiency-First: Unified Table with Inline Draft Actions

**Strengths**

- Never removes a draft from the primary scanning surface. Live and draft
  rows are literally the same table, same query, same render loop — an
  operator never has to reconcile two different UIs in their head to answer
  "what exists" vs. "what's pending," which is the single biggest
  density-preserving move any of the three options makes.
- The fast path for the actual bottleneck action — approve/discard — needs
  **zero expansion**. `[✓]`/`[✕]` sit directly in the collapsed row's Action
  column and "work whether or not the drawer is open" (§3, step 5). An
  operator triaging five or ten drafts from a batch of repo crawls can clear
  the obviously-correct ones in one click each without ever leaving the
  table — no other option offers this.
- The one piece of content that genuinely can't fit in a cell
  (`sourceSummary` + section content) is pushed into an on-demand
  `<tr>` drawer, not a permanently-reserved pane — so the reading investment
  is opt-in per row, and the table's baseline density is untouched for rows
  nobody needs to inspect closely.
- Explicitly reuses the existing `panel-status` line for the pending count
  ("12 persona(s), 3 pending review") rather than inventing a badge widget —
  no new chrome competing for space.

**Weaknesses**

- The wireframe's sort order — "drafts pending review float to the top by
  default... then by tier/scopeId" — means the table's ordering is not
  purely hierarchical. An operator scanning specifically for "where does
  scopeId X sit in the tree" has to mentally subtract the draft block at the
  top first; this is a real, if minor, scan-cost the tier-first grouping in
  Options 2 and 3 avoids.
- No grouping/sub-heading structure is shown anywhere in the wireframe — it
  stays one flat table with a Tier *column* rather than tier *sections*. At
  the scale this system is designed for (4 tiers × N repos), a flat sorted
  list is measurably harder to visually chunk than grouped headers, and nothing
  in this option's own text argues for flat-over-grouped — it's simply not
  addressed, which is a gap relative to Option 3's explicit sticky-group-header
  treatment of the same density problem.
- The Action column's shape changes entirely by row kind — a single `[Edit]`
  link for live rows vs. three controls (`[▾][✓][✕]`) for draft rows. That's
  a ragged, inconsistent column that a fast top-to-bottom scan has to
  re-parse per row, a small but real cost the more uniform row shapes in
  Options 2/3 don't have.

---

## Option 2 — Guided Step-by-Step Review Flow

**Strengths**

- The Library tab is explicit and disciplined about protecting density: "A
  draft is *never* rendered as a row inside the Library table... Library
  stays exactly as scannable/dense as it is today." Tier sub-headings
  (`<h3>` per tier, own `<tbody>`) plus a Repo column for code-architect
  rows is a genuine, concrete improvement to hierarchy-driven scanning of the
  *live* population specifically — the best-specified live-list grouping of
  the three options.
- Leakage of draft state into Library is deliberately minimal — a single
  `↻ draft pending` link, not a status field to parse — so the live-scanning
  surface truly stays undiluted by lifecycle chrome.

**Weaknesses**

- This is the clearest regression of the three, and the option's own text
  says so directly: the two-pane Review Queue layout is "the one, deliberate
  information-density exception in this design." That's not a neutral
  design choice through this lens — it's an admitted tradeoff of density for
  ceremony.
- The Review Queue's step panel "always shows exactly one draft" — reviewing
  N pending drafts means selecting each one individually in a left rail,
  advancing it through a mandatory 4-node stepper (Proposed → Reviewing →
  Decision → Resolved), often across multiple visits to the tab, before the
  next draft can be looked at. There is no way to approve a batch of
  obviously-fine drafts without this per-item sequential ritual — a direct
  regression against "scan a lot of real data fast" for exactly the
  workflow (triage across tiers/repos) this lens cares about.
- The left rail itself under-displays per row relative to the other two
  options' tables: the wireframe shows only tier badge, scopeId, and a step
  glyph per row — no display name, no parent, no repo. An operator scanning
  the queue to decide *which* draft to open first has less information per
  row than either Option 1's or Option 3's row before committing to a click.
- Buttons are explicitly disabled ("disabled with a tooltip") if edits are
  unsaved, and Decision requires a second confirm click on top of the
  stepper navigation — several extra required interactions per draft that
  the inline-button options don't impose, at odds with high-volume triage.
- The panel is entirely hidden behind a tab switch by default — the pending
  count badge is the *only* signal visible from Library, meaning the actual
  content (which drafts, from where, proposing what) is never glanceable
  without a navigation action, unlike Options 1 and 3 where at least some
  draft content is visible in the base view.

---

## Option 3 — Unified Review Queue

**Strengths**

- Keeps the "one list" principle Option 1 has, but adds real structure on
  top of it: sticky group headers by Tier/Repo/Status, switchable without a
  re-fetch, directly targeting hierarchy-at-scale legibility that Option 1's
  wireframe leaves unaddressed. This is the strongest of the three for
  "scan a lot of real data organized by the axis I currently care about."
- Row expansion happens in place (`▸` accordion under the row, table stays
  in view) — no navigation, no modal, no separate pane permanently
  reserved — so baseline table density is preserved the same way Option 1's
  drawer preserves it.
- Status badge is a real leftmost table cell (explicitly "not a colored
  border trick... screen readers get the state as actual cell text"), same
  4 existing columns otherwise — the smallest structural delta from today's
  table of the three options, which matters for scan-cost since operators
  already have a working mental model of the current 4-column shape.
- `Needs review` is a filter chip on the *same* list, not a separate tab —
  switching to `All` or `Live` is one click and re-buckets already-loaded
  data rather than a new fetch/new surface, unlike Option 2's tab model.

**Weaknesses**

- Unlike Option 1, this option's collapsed row has **no inline
  approve/discard controls** — both actions are described only as available
  "Clicking the row's `▸` expand[s]... Operator clicks `Approve`" (§3, steps
  3 and 5). Every single approve/discard, even for an obviously-correct
  agent proposal an operator already trusts, requires expanding the row
  first. This is a real, measurable throughput cost against Option 1's
  fast path when triaging a batch of drafts from a multi-repo crawl —
  exactly the scenario this lens is most concerned with.
- The expanded accordion's "Current vs. proposed" block renders full stacked
  text for *every* section on *both* sides ("two labeled stacks... rendering
  displayName, scope, and each sections entry — plain stacked text, not a
  diff library") when revising an existing persona. For a persona with
  several sections this is a substantial vertical read per review, larger
  than Option 1's single-drawer summary-plus-sections rendering and without
  Option 1's affordance of not needing to open it at all for a trusted
  proposal.
- Grouped headers (sticky, per Tier/Repo) introduce the same vertical-space
  tradeoff any grouped list has vs. a flat table — more chrome between rows
  of actual data than Option 1's ungrouped table, a real (if smaller) cost
  paid for the hierarchy-legibility gain.
- `Needs review` as the default landing filter means, like Option 2, an
  operator's first view is not the full inventory — though this is a single
  chip-click away rather than a tab/route change, so the cost is real but
  much smaller than Option 2's.

---

## Conclusion

**Option 1 serves this lens best.** It is the only one of the three that
lets an operator both see every draft inline with the live population *and*
resolve the two highest-frequency actions (approve, discard) without any
expansion or navigation step — the fast path this lens cares about most
directly. Its weaknesses (no tier grouping, a ragged action column) are
real but minor and additive — they could be folded into Option 1's own
shape without touching its core mechanic. Option 3 is the strongest
runner-up: it preserves the single-list principle and adds genuinely useful
grouping/filtering, but forces every approve/discard through a row
expansion first, which is a real throughput tax at batch scale. Option 2 is
the clearest loser through this lens — it explicitly and knowingly trades
away density in the Review Queue for a sequential, one-draft-at-a-time
stepper ceremony, which is at direct odds with "scan a lot of real data
fast" for the very workflow (triaging agent-proposed drafts across tiers and
repos) this epic exists to make efficient.
