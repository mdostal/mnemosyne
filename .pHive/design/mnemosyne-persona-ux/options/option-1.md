# Option 1 — Efficiency-First: Unified Table with Inline Draft Actions

**Angle:** Keep the current table-centric shell as the primary metaphor. Draft
status becomes a first-class column, not a separate mode or screen. Review and
approve/discard happen inline, in the row, with a slide-down detail drawer for
the one piece of information that can't fit in a cell (`sourceSummary` +
section diff). No modal takeover, no separate "review queue" page — the table
*is* the queue.

This option deliberately does not chase the "big reveal / focused review
screen" instinct other directions will likely explore. It bets that for this
tool's actual users, staying in one dense, sortable, filterable surface beats
a more ceremonial per-persona review flow, even for the new agent-approval
interaction.

---

## 1. Overall layout / navigation structure

The `#personas` panel keeps its existing single-section shape — no new tab,
no new route, no separate "Drafts" panel living apart from the real list.
One table, one panel, same place operators already look.

```
┌─ Personas ────────────────────────────────────────────────────────────────┐
│ [status: 12 persona(s), 3 pending review]                                 │
│                                                                            │
│ Filter: [ All ▾ ] [ Tier: All ▾ ] [ Repo: All ▾ ]      [ + Propose draft ]│
│                                                                            │
│ ┌────────┬──────────┬─────────────────┬───────────┬────────────┬───────┐ │
│ │ Status │ Tier     │ Scope ID        │ Display   │ Parent(s)   │ Action│ │
│ ├────────┼──────────┼─────────────────┼───────────┼────────────┼───────┤ │
│ │ ● live │ code-arch│ mnemosyne       │ Code Arch │ project-orc…│ [Edit]│ │
│ │ ◐ draft│ code-arch│ new-service     │ (proposed)│ project-orc…│[▾][✓✕]│ │
│ │ ● live │ top-orch │ acme            │ Top Orch  │ —            │ [Edit]│ │
│ │ ◐ draft│ project- │ mnemosyne-proj  │ (proposed)│ company-dir…│[▾][✓✕]│ │
│ └────────┴──────────┴─────────────────┴───────────┴────────────┴───────┘ │
└────────────────────────────────────────────────────────────────────────── ┘
```

- **Status column** (new, leftmost — first-class per the assigned angle):
  a small glyph + label, one of `● live` (an approved persona in the real
  store), `◐ draft` (pending review, either agent-proposed or human-started),
  `✓ approved` / `✗ discarded` only shown transiently right after the action
  fires (then the row leaves the table on next reload, since disposition is
  archive-by-move — the row simply stops existing at that identity once
  moved).
- **Filter bar**: a status filter (`All` / `Live` / `Drafts pending review`)
  is the one new piece of chrome. Tier and repo filters are lightweight
  `<select>` elements already consistent with this codebase's zero-dep
  convention — no new library, just `<option>` population from the loaded
  rows client-side, same pattern the layer-stack section already uses for
  static option lists.
- **`+ Propose draft` button**: opens the *same* create/edit form that exists
  today (pw-17's form, unchanged in field shape), just retargeted to POST to
  the draft route instead of the live route. This is the "human directly
  types a draft" path — same UI as the agent-proposed path converges into,
  per design-discussion.md §9.4 (one review surface, not two). The form
  itself stays a below-the-table expand/collapse (`<details>`-style toggle,
  matching the existing add-lane-form convention already in this file) —
  not a modal, not a new page.
- No separate "pending review" section header, no badge-counter widget
  requiring extra layout — the count lives in the existing `panel-status`
  line (`"12 persona(s), 3 pending review"`), reusing `setStatus()` verbatim.

## 2. How the persona list and drafts-pending-review are both represented

**Same table, same rows, one query.** `loadPersonas()` is extended to fetch
both `GET /persona` (live) and `GET /persona/draft` (a new listing route,
mirroring the shape of the existing list route) in parallel via
`Promise.all`, then merges both arrays into one client-side row set tagged
with a `kind: 'live' | 'draft'` field before rendering. This is a genuine
change to `loadPersonas()`'s existing fetch — it already does a two-phase
fetch (list, then per-entry detail) for live personas; the draft fetch is a
third parallel branch feeding the same render loop, not a second rendering
path.

Drafts are **interleaved in the same table**, not grouped into a separate
block — sorted by status first (drafts pending review float to the top by
default, since they're the actionable items) then by tier/scopeId, matching
this tool's own "scan a lot of real data fast" precedent (design-discussion
§4, lens 5). A user who wants live-only or draft-only view uses the filter
bar rather than the table restructuring itself.

Each draft row's **Display name cell** shows `(proposed)` in place of a
missing displayName if the agent didn't set one, and the **Action column**
swaps entirely for draft rows: instead of a single `[Edit]` link (live rows),
draft rows get `[▾ details] [✓ approve] [✕ discard]` — three compact controls,
no dropdown menu hiding them, because these are the two most consequential
and most frequent actions this whole epic exists to enable, and hiding them
behind a menu click costs the operator a step for the common case.

## 3. Step-by-step interaction flow: crawl → propose → review → edit → approve

1. **Crawl + propose (agent side, outside the browser).** An operator runs
   `mnemosyne-persona-interview` (or the future bounded-crawl variant, pu-07)
   in a live agent session, giving it high-level context (tier, scopeId,
   repo). The skill's step 7 write target is now the draft store by default
   (pu-08) — it calls `mnemosyne persona draft propose --file <path>
   [--repo <repo>]`, which also carries the `sourceSummary` string the
   bounded crawl produced (design-discussion §3c). This step is entirely
   outside this UI's control flow — the panel's job starts at step 2.

2. **Draft appears in the table on next load/poll.** The operator (same
   person or a reviewer) opens or refreshes the Personas panel. The new
   draft row appears inline, tagged `◐ draft`, sorted to the top. No
   notification system, no websocket — this UI has no live-push precedent
   anywhere else (every other panel is fetch-on-load/fetch-on-action), so a
   manual refresh is consistent with the rest of the shell, not a gap.

3. **Reviewer clicks `▾ details` to expand the row.** This is the one piece
   of real estate the table can't hold inline: a slide-down `<tr>`
   (a second row, `colspan` across the table, toggled via a plain
   `hidden`/show class — no animation library) containing:
   - **Source summary** (design-discussion §3c's whole reason to exist): the
     bounded crawl's short summary text, verbatim, in a monospace block —
     "why the agent proposed what it proposed."
   - **Proposed content**: the draft's `sections` rendered as
     heading/body pairs, plus `parentRefs` via the existing
     `parentRefsText()` helper (unchanged, still pointer-only).
   - **Provenance line**: `proposedBy` + `proposedAt` timestamp, satisfying
     lens 4 (agent-provenance/trust calibration) — always visible whenever
     the row is expanded, never buried in a tooltip.
   This drawer is read-only rendering — no new fetch, since `GET
   /persona/draft` already returns the full draft record (not a
   summary-only list shape), matching the existing live-list convention
   research already confirmed doesn't over-fetch.

4. **Edit, if needed.** An `[Edit]` link inside the expanded drawer opens the
   *same* create/edit form used for `+ Propose draft`, pre-filled from the
   draft's current field values (tier/scopeId locked read-only — identity
   doesn't change mid-review — display name/scope/section fields editable).
   Submitting POSTs to the same draft route with the same `{tier, scopeId}`,
   which the draft store already treats as "overwrite the active draft in
   place" (design-discussion §3b) — no new endpoint, no new state machine.
   This directly satisfies §9.4's "exactly one review/approve surface."

5. **Approve or discard, inline, from the collapsed row — no drawer expansion
   required for the fast path.** The `[✓]`/`[✕]` buttons in the Action
   column work whether or not the drawer is open, because a reviewer who
   already trusts a well-known scopeId's proposal (or is triaging many
   drafts at once) shouldn't be forced to expand first. Clicking either:
   - shows a native `confirm()` dialog for discard only (approve is the
     "safe," reversible-by-re-proposing direction; discard is the one that
     archives content out of the active workflow, so it gets the one bit of
     friction — matches this shell's existing convention of confirm-gating
     destructive actions, e.g. reindex/clear-cache buttons elsewhere in this
     file),
   - POSTs to `POST /persona/draft/:tier/:scopeId/approve` or `.../discard`,
   - on success, re-runs the same merged `loadPersonas()` fetch — the row
     disappears from "pending" (moved to `approved/` or `discarded/` on
     disk) and, for approve, a new `● live` row appears in its place on the
     very next render pass, giving immediate confirmation the write landed
     through the real primitive.
   Both buttons reuse the exact `setStatus()` pass/fail convention every
   other action in this file already uses, surfaced in the row itself via a
   small transient status text under the Action column (not a global toast
   system this codebase doesn't have).

6. **`remember()` fires server-side on approval** (design-discussion §9.9) —
   invisible to this UI beyond the approve call's own response; no separate
   "indexing..." UI state is invented, since the operator-confirmed behavior
   is that this happens synchronously within the approve request the button
   already issues.

## 4. Why this angle serves this tool's real users

The people using this panel are technical operators managing personas across
four tiers and an open-ended number of repos — the same audience who already
tolerates (and prefers) this codebase's dense, un-styled, sortable tables over
every other panel in the shell. Forcing a dedicated "review screen" per draft
would mean a context switch for every single approve/discard, which doesn't
scale once an operator is triaging five or ten drafts proposed across a batch
of repo crawls — the inline-action table lets them approve three obviously-
correct drafts in three clicks without ever leaving the list, and reserves the
one real reading investment (the drawer) for the drafts that actually need
scrutiny. It also costs almost nothing structurally: it is one extended fetch,
one new column, and one new row-state, not a new page, new routing concept, or
new visual language this zero-dependency shell would otherwise have to grow.
