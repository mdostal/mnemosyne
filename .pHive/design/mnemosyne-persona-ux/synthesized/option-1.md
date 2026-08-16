# Synthesized Option 1 — Triage Table: One List, View-Gated Approve

**Angle:** Option 1's single merged table stays the structural backbone —
still the fastest shape of the three originals for the actual daily task
(scan everything, act on drafts, don't navigate away) — but every efficiency
win it offers is now paired with the specific fix the 7-lens review found
missing, pulled from wherever the strongest version of that fix already
existed (Option 3's default filter/grouping/diff/persistent-provenance,
Option 2's forced-exposure mechanic and labeled-button discipline). Nothing
here is a renamed original: the "view-gated approve" mechanism, the inline
source-summary excerpt, the optimistic-splice reload strategy, and the
native-radiogroup grouping control are new constructions built specifically
to resolve named critique findings, not copied from any one brief.

Tiebreaker used where critiques pulled in different directions: **operator
efficiency and information density** — this option optimizes for a technical
operator triaging drafts at real multi-tier/multi-repo scale, and every
safety/clarity fix below is deliberately shaped to cost as little speed as
possible while still being a real fix, not a token gesture.

---

## 1. Overall layout / navigation

One panel, one table, no tabs, no route change — same shell shape as today's
`#personas` section and every other panel in this file
(`design-language-consistency` critique: Option 2's tab bar is this repo's
biggest "foreign island" risk; Option 1's single-continuous-read shape is
closest to what's already on disk, so it's the base this synthesis keeps).

```
┌─ Personas ──────────────────────────────────────────────────────────────────┐
│ 14 persona(s) · 3 pending review                                            │
│                                                                              │
│ view: ( Needs review ●  Live  All  History )   group: ( Tier ●  Repo )      │
│                                                              [ + New draft ]│
│ ┌────────┬──────────┬────────────┬──────────┬───────────┬────────┬───────┐ │
│ │ Status │ Tier     │ Repo       │ Scope ID │ Display   │Parent  │Action │ │
│ ├────────┼──────────┼────────────┼──────────┼───────────┼────────┼───────┤ │
│ │▾code-architect — /repo/mnemosyne (2)                                    │ │
│ │NEEDS   │code-arch │/repo/mnemo…│new-svc   │(proposed) │project-│▾ ✓ ✕  │ │
│ │REVIEW  │          │            │          │"README + package.json…"│    │ │
│ │LIVE    │code-arch │/repo/mnemo…│mnemosyne │Code Arch  │project-│Edit   │ │
│ └────────┴──────────┴────────────┴──────────┴───────────┴────────┴───────┘ │
└──────────────────────────────────────────────────────────────────────────── ┘
```

- **`view` control** and **`group` control** are both native
  `role="radiogroup"` sets of `<label><input type="radio">` pairs, styled
  exactly like the Search panel's already-existing `.mode-toggle` —
  **reused, not reinvented** (`design-language-consistency` critique: Option
  3's status "chips" and Option 2's tab bar are both new widgets this shell
  has never built; `.mode-toggle` already is one, so the grouping/filter
  controls are built as two more instances of it, zero new CSS component).
- **`view` defaults to "Needs review"** (Option 3's finding, confirmed
  strongest by the `operator-efficiency` critique: a default landing filter
  beats Option 1's original sort-only approach — an operator opens the panel
  and sees only actionable rows, no scanning past settled ones).
- **`group` defaults to "Tier"**, with a "Repo" option that regroups
  `code-architect` rows by their `repo` field (three global tiers collapse
  into one `global` bucket under Repo grouping — same tradeoff Option 3
  accepted; see §9 for the mitigation this synthesis adds). Grouping
  re-buckets the already-merged, already-fetched row set client-side — no
  new network call (Option 3's finding, kept: "switching it just re-buckets
  what's already loaded").
- **`+ New draft`** starts a blank human-authored draft in the same
  row-editor described in §5 — one editor for both authoring paths
  (design-discussion §9.4), not a second form section.

## 2. Table columns

`Status | Tier | Repo | Scope ID | Display name | Parent(s) | Action` — one
column added relative to today's shell (`Status`, leftmost) and one restored
relative to Option 1's original brief (`Repo`, always present, not
filter-only).

- **`Status` renders as text, not a bare glyph**: `LIVE`, `NEEDS REVIEW`,
  `NEEDS REVIEW — REVISION` (an active draft overwriting an existing live
  record — Option 3's compound badge, kept because the
  `agent-provenance-trust` critique singled it out as a genuine up-front
  stakes signal), `HISTORY` (archived, hidden by default). Implemented as the
  existing `panel-status`-style text-plus-CSS-class idiom (a new
  `.badge-live` / `.badge-review` / `.badge-history` class family, same
  mechanism as `.pass`/`.fail`/`.loading`) rather than inventing a
  glyph-and-color system — **direct fix** for the `accessibility` critique's
  finding that Option 1's `●`/`◐` glyphs give screen readers no reliable
  words, and the `design-language-consistency` critique's finding that a
  glyph column has no precedent anywhere in this shell.
- **`Repo` is always a real column**, populated for `code-architect` rows,
  `—` for the three global tiers — **direct fix** for the
  `hierarchy-legibility` critique's single sharpest finding against Option
  1's original brief ("no Repo column... 15 code-architect personas across 6
  repos are visually indistinguishable rows").
- **`Parent(s)` renders as an in-page anchor when the named parent exists in
  the currently-merged dataset**, scrolling to and briefly highlighting that
  row on click, exactly reusing `parentRefsText()`'s existing data (no new
  fetch) — Option 3's mechanism, kept because both the `hierarchy-legibility`
  and `operator-efficiency` critiques praised it as the only real navigation
  affordance for `parentRefs` any option offered. **Fix applied on top**: if
  the parent exists in the full dataset but not in the *currently filtered
  or grouped* view, the link is disabled and rendered instead as
  `tier: scopeId (filtered out — switch view to "All" to see it)` — closing
  the exact gap the `hierarchy-legibility` critique flagged in Option 3
  ("the anchor could point at nothing visible without the operator
  realizing why").
- **A one-line, muted, monospace excerpt of `sourceSummary`** (first ~70
  characters, ellipsized) renders as a second line under the Scope ID cell
  for any `NEEDS REVIEW` row that carries one (i.e., agent-proposed, not
  hand-started) — see §6 for why this specific addition exists; it is the
  mechanism that lets the fast inline-approve path stay fast without being
  blind.

## 3. Row expansion (the drawer)

Clicking a row's `▾` toggles a second `<tr>` directly beneath it (`colspan`
across the table, `hidden` attribute toggling — the same real, already-used
mechanism `#graph-inspector-detail` relies on, confirmed existing by the
`design-language-consistency` critique, not the nonexistent `<details>`
precedent Option 1's original brief incorrectly cited). Contents:

- **"Why the agent proposed this"** — the full `sourceSummary` text, verbatim,
  in a bordered monospace block. This exact label is kept from Option 3
  because the `onboarding-clarity` critique named it "arguably the single
  clearest label of any option... phrased as a question a newcomer would
  actually ask."
- **Provenance line**, always rendered as plain visible text (never a
  tooltip): `Proposed by agent · <proposedAt>` or `Manually created ·
  <createdAt>`.
- **Current (live) / Proposed (draft) comparison**, shown only for
  `NEEDS REVIEW — REVISION` rows (a draft overwriting an existing live
  persona): two labeled stacks, plain text, not a diff library — kept from
  Option 3 because both the `operator-efficiency` and
  `agent-provenance-trust` critiques independently named this the strongest
  answer of the three originals to "what did the agent actually change."
  For a brand-new identity, this block is replaced by a single heading,
  "New persona — nothing live yet."
- **Editable fields** — displayName, scope, repeatable heading/body section
  rows, parentRefs, repo — the same field set pw-17's form already collects,
  living inside the expanded row (absorbs the old standalone create/edit
  form per design-discussion §9.4 — one editor, reached from either `+ New
  draft` or any row's `▾`/`Edit`).
- **`aria-expanded` on the toggle, `aria-controls` pointing at the drawer's
  `id`, and explicit focus management**: opening the drawer moves focus to
  its first heading (`Why the agent proposed this`); closing it returns
  focus to the `▾` toggle. This is a **direct fix** for the gap the
  `accessibility` critique flagged as unaddressed in *all three* original
  briefs, not just Option 1.

## 4. Status vocabulary and jargon scaffolding

Column headers `Tier`, `Scope ID`, and `Parent(s)` each carry a native
`title` attribute with a one-sentence plain-language definition (e.g. `Tier`
→ "Which level of the orchestration hierarchy this persona operates at —
top-orchestrator, company-director, project-orchestrator, or
code-architect"; `Parent(s)` → "The persona this one queries up to for
broader context — its content is never copied down, only referenced by
name"). This uses a native, zero-dep browser affordance already implicitly
available (hover tooltip) rather than inventing a widget, and is a **direct
fix** for the `onboarding-clarity` critique's single most important finding:
*none* of the three original briefs explained `tier`, `scopeId`,
`parentRefs`, or "query up, never copy down" anywhere in the UI itself. The
existing `<p class="panel-hint">` block (already present in today's markup)
is extended with the same two sentences in prose form, for anyone not
hovering.

**Empty state** (zero pending drafts): the panel-hint area shows literal
copy, quoted here because the `onboarding-clarity` critique specifically
credited Option 2 for quoting real copy rather than describing intent in the
abstract:

> *"No drafts pending review. Ask an agent to propose one
> (`mnemosyne persona draft propose ...` or the persona-interview skill), or
> start one by hand with **+ New draft** above."*

This is Option 2's exact winning move (name the crawl mechanism AND how to
invoke it, in one sentence) grafted onto Option 1's structure, which had no
empty-state copy at all per the same critique.

## 5. Crawl → propose → review → edit → approve, full flow

**Step 0 — Crawl + propose (agent-side, outside this UI).** An operator
gives an agent high-level context (tier, scopeId, repo) in a live agent
session. `skills/mnemosyne-persona-interview`'s already-shipped
crawl-then-propose loop runs its bounded crawl (design-discussion §3c) and
calls `mnemosyne persona draft propose --file <path> [--repo <repo>]`,
carrying the `sourceSummary` string the crawl produced. This UI adds **no**
"start a crawl" button or chat surface — the panel-hint text points at the
real CLI/skill invocation, matching design-discussion §3b's explicit
instruction that the trigger stays where the repo's own design already puts
it.

**Step 1 — Draft appears in the table.** The next load/refresh of the
Personas panel fetches `GET /persona` and `GET /persona/draft` in parallel
(the same extended two-branch fetch Option 1's original brief specified) and
merges both by `{tier, scopeId}` (or `{tier, repo, scopeId}` for
`code-architect` — Option 3's explicit compound-key correction, kept because
the `hierarchy-legibility` critique called it out as the only option to
state the correct identity for a tier that fans out across repos). The new
row appears with status `NEEDS REVIEW` (or `NEEDS REVIEW — REVISION`),
sorted into its tier/repo group under the default `Needs review` view, with
its `sourceSummary` excerpt already visible on the collapsed row (§2).

**Step 2 — Glance-level triage.** The operator scans the table. For a
row they already trust from its Scope ID, Repo, and one-line source-summary
excerpt alone, they can act immediately (Step 4). For anything that warrants
a closer look, they expand it first (Step 3).

**Step 3 — Review in the drawer (optional but structurally encouraged).**
Clicking `▾` opens the drawer described in §3: full source summary,
provenance, current-vs-proposed comparison (revisions only), and the
editable field set. An operator makes edits here and clicks **`Save
draft`** — a `POST` to the same draft identity, which the draft store
already treats as overwrite-in-place (design-discussion §3b); the row's
`sourceSummary`/provenance stay intact, only the candidate fields change.
This can be repeated any number of times before approval.

**Step 4 — Approve or discard.** Both actions are available as buttons
directly in the collapsed row's Action column (`✓ Approve` / `✕ Discard`,
text-labeled, never icon-only — see §6/§7 for exactly how this stays both
fast and safe) or from inside an open drawer. Either path calls the same
route:
- **Approve** → `POST /persona/draft/:tier/:scopeId/approve`. Runs the
  current candidate through the real `assertValidPersona` gate for the
  first time, writes it via the unchanged
  `writeGlobalPersona`/`writeRepoLocalPersona` primitive, fires
  `remember()` on the `sourceSummary` for agent-authored drafts only
  (design-discussion §9.9/OQ3 — a human-typed draft with no `sourceSummary`
  skips `remember()` entirely), and archive-moves the draft file to
  `approved/`.
- **Discard** → `POST /persona/draft/:tier/:scopeId/discard`. Archive-moves
  the draft to `discarded/` without touching the real store.

**Step 5 — Row updates in place.** On success, the row's data is patched
directly from the response body (no full-table refetch — see §8) and its
badge flips: approve → `LIVE`, carrying a persistent one-line note
—*"originally proposed by agent · approved `<date>`"*— that survives from
this point forward (Option 3's unique strength, kept because the
`agent-provenance-trust` critique named it the deciding factor over Option
2: *"trust calibration for this interaction doesn't end at the moment of
the approve click"*). Discard → the row leaves the `Needs review`/`Live`
views and becomes visible only under `History`.

## 6. View-gated approve — the mechanism that reconciles speed with safety

This is the one genuinely new construction in this synthesis, built because
no single original option's approach to the approve action survived the
7-lens review intact:

- The `operator-efficiency` critique ranked Option 1's zero-navigation,
  single-click approve as the strongest efficiency mechanism of the three.
- The `accessibility` and `agent-provenance-trust` critiques both
  independently named that exact mechanism — approve firing from a collapsed
  row with no confirm and no forced look at the content — as the single
  worst finding across all nine reviews ("a structural invitation to approve
  agent-authored governing content without having seen the sourceSummary...
  at all").

Neither "keep it exactly as fast as Option 1" nor "gate it behind Option 2's
five-click stepper" survives its own critique. The synthesis:

1. **The `✓ Approve` button is present on every `NEEDS REVIEW` row's
   collapsed Action column** (Option 1's fast path, kept) — but for a row
   that has **never been expanded in this browser session**, it renders
   `aria-disabled="true"` (never a native `disabled` attribute — the
   `accessibility` critique flagged native `disabled` as removing an
   element from the tab order entirely, hiding both the control and its
   rationale from keyboard/AT users) with `aria-describedby` pointing at a
   visually-adjacent, always-present hint: *"Expand to view this proposal
   before approving."* The button is genuinely clickable-looking and
   focusable, so a keyboard user always knows it exists and why it's
   currently inert — a real fix, not a cosmetic one.
2. **Expanding the row once (§3) permanently un-gates approve for that
   identity**, in the same browser session — after that, the fast
   single-click approve Option 1's original brief specified works exactly
   as described, including from the collapsed row after re-collapsing.
   This costs an operator **exactly one extra click** (expand) the very
   first time they touch a given draft, and *zero* extra clicks on every
   subsequent glance-approve for drafts they've already looked at once —
   directly answering the `agent-provenance-trust` critique's core demand
   (Option 2's "always see the agent's unedited output at least once before
   approving") at a fraction of Option 2's five-click cost.
3. **The collapsed row's `sourceSummary` excerpt (§2)** means "expand" is
   never a blind click either — an operator already has real signal about
   what the proposal is before deciding whether a closer look is warranted,
   which is itself new relative to every original brief (none of the three
   showed any source-summary content on the collapsed row).
4. **Approve and Discard are symmetrically confirm-gated**, both via native
   `window.confirm()` (the `accessibility` critique's noted advantage:
   platform-handled focus/AT announcement, no custom dialog to get wrong),
   with **specific, identity-naming copy** — *"Approve `code-architect /
   new-service`? This writes to the real persona store and fires
   remember() on its source material. Cannot be undone from here."* — the
   exact "name the identity and the real consequence" discipline the
   `onboarding-clarity` and `accessibility` critiques both singled out as
   Option 2's best-written moment, reused here rather than Option 1's
   original silent one-click approve or Option 3's unspecified generic
   confirm. This directly **reverses** Option 1's original asymmetry (only
   discard gated) that the `accessibility` and `agent-provenance-trust`
   critiques both flagged as backwards.

Net cost versus Option 1's original brief: one extra click, once, per
identity, plus a confirm click that was already present for discard and is
now present for approve too. Net cost versus Option 2: four fewer clicks
per draft and no mandatory tab/stepper navigation.

## 7. Button labeling and keyboard operability

`✓ Approve` / `✕ Discard` are rendered as short **text-labeled** buttons
(not bare icon glyphs) with `aria-label="Approve draft: code-architect /
new-service"` / `aria-label="Discard draft: code-architect / new-service"` —
**direct fix** for the `accessibility` critique's finding that Option 1's
original icon-only `[✓][✕]` controls gave screen readers no reliable
per-row identity, and for the `onboarding-clarity` critique's finding that
Option 1 gave approve "no textual cue... that this is a real, consequential
write." All interactive controls (`▾` toggle, radiogroup inputs, table
action buttons, parent-ref anchors) are real focusable elements reachable
by `Tab`, with visible focus outlines matching this shell's existing
`:focus-visible` styling — no custom keyboard trap anywhere in the design.

## 8. Reload strategy — optimistic patch, not full refetch

Both the `operator-efficiency` and `information-density` critiques flagged
the same unaddressed cost in Options 1 and 3: every approve/discard was
specified as triggering a full `loadPersonas()`-style refetch (list fetch +
per-entry detail fetch for every live persona, plus the draft list) —
"clearing a batch of 10 drafts means 10 full-table refetches over a
cross-origin connection." This synthesis fixes it directly: the approve/
discard routes' JSON response bodies already carry the full updated record
(or a simple `{ok: true}` for discard); the client **patches the single
affected row in the in-memory row set and re-renders only that row**,
never re-fetching the whole table. A cheap, debounced background refresh
(same interval this shell already uses nowhere yet, so: on next manual panel
open/switch, not a new polling loop) reconciles any drift, but the
in-session, in-triage-flow cost is one small JSON response per action, not
a full two-phase table reload. Multi-row selection (checkbox column,
`Shift`-click range select, matching no prior widget in this shell but built
from plain native checkboxes) allows **Approve selected** / **Discard
selected** as a single batch call with one combined confirm listing every
affected `{tier, scopeId}` — closing the `operator-efficiency` critique's
explicit "no bulk/multi-select triage" gap for both original density-favoring
options.

---

## 9. Critique responses

Explicit mapping of which finding, from which lens, drove which specific
decision above:

| Decision | Critique(s) that drove it | Finding cited |
|---|---|---|
| Single merged table, no tabs, default "Needs review" filter | `operator-efficiency`, `information-density` | Option 2's mandatory stepper was "clearly the weakest option... a regression from the current one-form panel for the fast case"; Option 3's default filter beat Option 1's sort-only approach for "what needs my attention right now" |
| Grouping/filter built as native `role="radiogroup"` (reusing `.mode-toggle`), not tabs or chips | `design-language-consistency` | Option 2's tab bar "does not exist anywhere else in this shell... the option's single largest fidelity gap"; Option 3's chips are "a new interaction... nothing in this shell currently narrows a rendered table via clickable chips" |
| `Repo` column always present, not filter-only | `hierarchy-legibility` | Option 1 original: "no Repo column at all... 15 code-architect personas across 6 repos are visually indistinguishable" |
| `{tier, repo, scopeId}` stated as the real compound identity | `hierarchy-legibility` | "the design acknowledges scopeId alone is not unique across repos at this tier... the only option to say so explicitly" (Option 3) |
| Status rendered as text words + CSS class, not glyphs | `accessibility`, `design-language-consistency`, `onboarding-clarity` | "screen readers get the state as actual cell text, not decoration" (Option 3, kept); Option 1's `●`/`◐` "give screen readers no reliable words"; glyph column "has no precedent anywhere in this shell" |
| `Parent(s)` as in-page anchor, with explicit filtered-out fallback text | `hierarchy-legibility` | Option 3's anchor mechanism praised, but its own gap flagged: "the anchor could point at nothing visible without the operator realizing why" — fallback text added to close it |
| Current vs. Proposed comparison stacks for revision drafts | `operator-efficiency`, `agent-provenance-trust` | Both lenses independently named this Option 3's standout mechanism absent from the other two |
| `title` attributes + expanded panel-hint prose for `tier`/`scopeId`/`parentRefs` | `onboarding-clarity` | "None of the three options actually solves the jargon problem this lens exists to test... no option proposes so much as a tooltip" |
| Quoted, literal empty-state copy naming the CLI/skill invocation | `onboarding-clarity` | Option 2's quoted empty-state copy was the critique's top-cited strength, contrasted against Option 1's total absence of one |
| Drawer gets `aria-expanded`/`aria-controls` + explicit focus movement in/out | `accessibility` | "None of the three options fully solves focus management on expand/collapse controls — that gap should be treated as a shared, mandatory fix regardless of which option is selected" |
| Approve/Discard rendered as text-labeled buttons with explicit per-row `aria-label` | `accessibility`, `onboarding-clarity` | Option 1's bare `[✓][✕]` "may not reliably know what either button does"; approve "fires with no inline explanation of what 'approve' actually does" |
| Symmetric confirm gating on Approve and Discard, with identity-specific copy | `accessibility`, `agent-provenance-trust` | "approve is the action whose bad outcome is worse... wired as a single-click, icon-only, no-confirmation control" (accessibility); "the friction asymmetry is backwards for this lens" (provenance) |
| View-gated approve (`aria-disabled` + `aria-describedby` until first expand) | `agent-provenance-trust`, `accessibility` | "a structural invitation to approve agent-authored governing content without having seen the sourceSummary... at all" — Option 2's forced-exposure mechanic adopted in minimal form; native `disabled` explicitly rejected per accessibility critique's anti-pattern finding |
| One-line `sourceSummary` excerpt visible on the collapsed row | `agent-provenance-trust`, `operator-efficiency` | Synthesizes both lenses' pulls: gives provenance visibility without forcing navigation, so the fast path (efficiency) isn't blind (provenance) |
| Persistent post-approval provenance note ("originally proposed by agent · approved `<date>`") | `agent-provenance-trust` | "the only option that keeps any provenance trail after approval... trust calibration for this interaction doesn't end at the moment of the approve click" |
| Optimistic single-row patch instead of full-table refetch after approve/discard | `operator-efficiency`, `information-density` | "clearing a batch of 10 drafts means 10 full-table refetches... a real latency cost the design doesn't acknowledge or budget for" — flagged against both Option 1 and Option 3 |
| Checkbox-based batch Approve/Discard with combined confirm | `operator-efficiency` | "No bulk/multi-select triage... the design's own pitch... is really three separate single-row actions" |
| Repo-grouping's global-tier collapse kept, explicitly flagged as a known tradeoff (not silently fixed) | `hierarchy-legibility` | Same gap Option 3 had; this synthesis does not claim a false fix — `Tier` remains the default group specifically so the collapse only happens when an operator opts into `Repo` grouping |
| Drawer uses real `hidden`-attribute toggling on a second `<tr>`, never `<details>` | `design-language-consistency` | Option 1's original brief cited a `<details>`-style precedent that "doesn't actually exist in this codebase... confirmed by grep — zero hits" |
