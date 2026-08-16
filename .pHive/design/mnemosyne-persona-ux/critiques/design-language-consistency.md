# Critique — Lens: Existing-Shell Design-Language Consistency

**Lens brief:** this repo has no `brand-system.yaml`; the real bar is fidelity
to THIS codebase's own already-established conventions across its other 6
panels (`#liveliness`, `#settings`, `#lanes`, `#search`, `#graph`,
`#operations`), confirmed by direct inspection of `ui/index.html` and
`ui/style.css`:

- One `<section class="panel panel-wide">` per concern, `<h2>`, a
  `<p class="panel-status">` (`loading…` / `pass` / `fail` / `loading`
  classes), often a `<p class="panel-hint">` explaining jargon inline.
- One flat `<table>` (`<thead>`/`<tbody>`) as the primary data surface —
  every other panel with list data uses exactly this, never grouped headers,
  never a two-pane layout, never cards.
- Forms follow one convention exactly: `<form>` → `<h3>` → repeated
  `.form-row` divs (`<label>` + `<input>`/`<select>`/`<textarea>`) → single
  `<button type="submit">` → trailing `<p class="panel-status">`. Reused
  verbatim by `#add-lane-form`, `#reindex-form`, and today's `#persona-form`.
- The only "toggle" widget anywhere in the shell is `.mode-toggle`, a plain
  `role="radiogroup"` of native `<label><input type="radio">` pairs (Search
  panel) — not a segmented-control widget, not tabs, not `<details>`.
- **`<details>`/`<summary>`, tabs, badges, chips, and accordions do not
  exist anywhere in this codebase today** — confirmed by grep across
  `index.html`, `style.css`, `app.js`. Any of these is new vocabulary for
  this shell, not a reuse of an established pattern.
- Side-by-side sub-blocks, when they occur, are plain `<div class="op-block">`
  siblings under one panel (`#operations-body`'s Reindex/Refresh blocks) —
  not tabs, not routing.
- Status/pass-fail is communicated via `.panel-status` + a `pass`/`fail`/
  `loading` CSS class (color-only, text-driven) — never an emoji/glyph
  column, never a dot-badge system.

---

## Option 1 — Efficiency-First: Unified Table with Inline Draft Actions

**Strengths**
- Keeps the exact `<section class="panel panel-wide">` → `<h2>` →
  `panel-status` → single `<table>` shape every other panel (and today's own
  Personas panel) already uses. No new section, no new route, no new page —
  this is the smallest possible vocabulary delta of the three options.
- The `+ Propose draft` control is explicitly specified as "a below-the-table
  expand/collapse (`<details>`-style toggle, matching the existing add-lane-
  form convention already in this file)" — but this claim doesn't hold up:
  `#add-lane-form` is a permanently-visible `<form>`, not a collapsible
  toggle. There is no existing `<details>`-style expand/collapse anywhere in
  this file today (confirmed by grep — zero hits for `details`/`summary`).
  So while the *intent* (stay inline, don't add a new page) is the most
  consistent instinct of the three options, the specific mechanism cited as
  precedent doesn't actually exist in this codebase, meaning it's still new
  vocabulary, just described as if it were reused.
- Re-uses `setStatus()` and the existing `parentRefsText()` helper verbatim,
  and explicitly folds the pending-count into the existing single
  `panel-status` line rather than inventing a badge widget — this is a real,
  concrete point of fidelity to the shell's existing idiom (compare
  `#lanes-status`/`#personas-status`'s plain sentence-string convention).
- The drawer is specified as a second `<tr>` toggled via a plain
  `hidden`/show class, "no animation library" — mechanically consistent with
  how `#graph-inspector-detail` and `#graph-body` already use bare `hidden`
  attributes for show/hide, which is a real, existing idiom in this file.

**Weaknesses**
- The status glyphs (`● live`, `◐ draft`, `✓ approved`, `✗ discarded`) are a
  genuinely new visual vocabulary — nothing in this shell today encodes
  state via a leading Unicode glyph in a cell. The existing convention for
  state is text + CSS class (`panel-status.pass`/`.fail`/`.loading`, plain
  color, no glyph). This is a small but real foreign element, not reused
  from anywhere else in the file.
- The filter bar (`[ All ▾ ] [ Tier: All ▾ ] [ Repo: All ▾ ]`) is described
  as "lightweight `<select>` elements already consistent with this
  codebase's zero-dep convention" — true in spirit (native `<select>` is
  used elsewhere, e.g. `#reindex-lane`), but no existing panel today filters
  a rendered table client-side via multiple simultaneous selects; this is a
  new interaction pattern for this shell even though the underlying HTML
  element is familiar.
- The Action column's per-row-kind control swap (`[Edit]` for live rows vs.
  `[▾][✓][✕]` for draft rows) is a denser action surface than any existing
  table in this file — `#lanes-table` and `#search-table` carry no
  interactive per-row buttons at all beyond the historical persona-panel's
  none. It is a plausible evolution of the table idiom, but it's still a
  new "table row as action bar" pattern this shell hasn't tried before.

## Option 2 — Guided Step-by-Step Review Flow

**Strengths**
- Explicitly checks its own tab mechanism against the shell's existing idiom
  and gets the honest answer right: "toggled via `hidden`/`display:none` —
  no router, no framework, matching every other panel's convention." The
  underlying *toggling mechanism* is genuinely consistent with e.g.
  `#graph-body`'s `hidden` attribute usage.
- The stepper/provenance-callout language is disciplined about staying
  text-and-border based ("in its own bordered block") rather than inventing
  colored badges or icons — broadly in the spirit of this shell's plain,
  undecorated aesthetic (no shadows, no gradients, no icon set anywhere in
  `style.css`).

**Weaknesses**
- The `[ Library ]   [ Review Queue (3) ]` segmented control at the top of
  the panel is the option's foundational navigation device, and it is a
  materially new widget for this shell. The only comparable existing
  control, `.mode-toggle` (Search panel), is a `role="radiogroup"` of native
  radio inputs styled as pills — visually a segmented control, but built
  from native form radios rendered inline with a form, not top-of-panel
  primary navigation with a live count badge. A tab bar as the primary way
  to navigate *within* a panel does not exist anywhere else in this shell —
  every other panel is one continuous top-to-bottom read, never a switcher.
  This is the option's single largest fidelity gap.
- The Review Queue's two-pane, inbox/detail rail-plus-panel layout has no
  precedent anywhere in this codebase. The closest existing "two-region"
  layout is `#graph-view` + `#graph-inspector` (SVG canvas + inspector
  sidebar) — but that pairing exists because a graph is visual and needs a
  canvas; it is not a list/detail master-detail pattern for tabular data.
  Applying that shape to what is fundamentally a table-of-records use case
  is a genuinely new layout language for this shell, and the biggest
  "visually foreign island" risk of the three options.
- The 4-node horizontal stepper (`Proposed → Reviewing → Decision →
  Resolved`) with filled/checkmarked/dimmed node states is entirely new
  chrome — nothing in `style.css` today implements a multi-state progress
  indicator; the nearest thing (`.mode-toggle`) is a binary choice, not a
  sequence tracker. This is the option's most stylistically ambitious
  element and the one furthest from anything already built.
- Splitting "Library" and "Review Queue" into two separate views also means
  the Personas panel stops being "one panel, one table" for the first time
  in this shell's history — every other panel (and even today's Personas
  panel) is a single continuous read. This is a structural, not just visual,
  departure.

## Option 3 — Unified Review Queue

**Strengths**
- Preserves the single-panel, single-list shape exactly like Option 1 and
  every other panel in the shell — "one panel, one list, one detail surface
  — no second scroll-down section, no modal, no route change" is stated as
  an explicit design commitment and matches the existing shell's dominant
  pattern (`#lanes`, `#search`, `#personas` today) more closely than
  Option 2's tab split.
- The Status badge is specified as "leftmost column... deliberately not a
  colored border trick, so screen readers get the state as actual cell
  text" — this is the most disciplined status-encoding of the three options
  and closest in spirit to the existing `panel-status` convention (text +
  class, not decoration), even though it still introduces glyphs (`●`,
  `◐`, `○`) that have no precedent in this file (same gap as Option 1).
- The accordion-in-row expansion ("Clicking the row's `▸` expands an
  accordion directly under it... table stays in view, no navigation, no
  modal") is functionally the same mechanism as Option 1's drawer row, and
  for the same reason is grounded in the shell's real `hidden`-attribute
  toggle idiom (`#graph-inspector-detail`) rather than an invented widget.
- Absorbs the create/edit form entirely into the row-level accordion editor
  rather than keeping a separate below-table form section — this is a
  bigger structural change than Option 1 (which keeps `+ Propose draft` as
  a separate below-table toggle, closer to today's actual `#persona-form`
  placement), so on this specific point Option 1 is marginally more
  conservative/consistent with what's on disk today, while Option 3 asks
  the reviewer to accept that the familiar standalone form section is gone
  entirely.

**Weaknesses**
- The `group by: ( Tier ● Repo Status )` control is, functionally, a
  3-way radio-styled toggle — closer in spirit to `.mode-toggle`'s existing
  radiogroup idiom than Option 2's tab bar (both are still "select one of
  several exclusive views of the same panel"), but it is still a new
  *combination* of grouping-toggle + status-filter-chips + sort-order all
  stacked in one control row; no existing panel combines three simultaneous
  view-control axes like this.
- Status filter chips (`[ Needs review (2) ● ] [ Live ] [ All ] [ History ]`)
  are, like Option 1's `<select>`-based filters, a new interaction (nothing
  in this shell currently narrows a rendered table via clickable chips —
  the closest is `.mode-toggle`'s radio pills, which pick a search *mode*
  before a fetch, not a post-fetch client-side filter over already-rendered
  rows).
- The "Current (live) / Proposed (draft)" side-by-side comparison stacks
  inside the accordion are a new content shape — no existing panel in this
  file renders two parallel labeled data stacks for comparison; the closest
  precedent, `#graph-inspector`'s Impact/Deps lists, is two *lists* side by
  side, not two versions of the *same* record's fields, so this is a
  related but not identical idiom being extended into new territory.
- Sticky group headers are called out explicitly as new chrome ("Sticky
  group headers keep tier/repo context visible even when a row is expanded
  or the list is scrolled") — `style.css` has no `position: sticky` usage
  anywhere today; this is a new CSS technique for this file, however small.

---

## Which option serves this lens best

**Option 1** serves this lens best, with **Option 3** a close second and
**Option 2** clearly the weakest fit. Option 1 makes the smallest number of
structural commitments beyond what's already on disk: it keeps the exact
single-`<table>`, single-panel shape every other panel (including today's
own Personas panel) already uses, keeps the create/draft form as a
recognizable descendant of the existing below-table `#persona-form`
placement rather than folding it into something new, and its one real
addition (the expandable drawer row) is grounded in a genuine existing
mechanism (`hidden`-attribute toggling, as `#graph-inspector-detail` already
does) rather than an invented widget — even though its citation of an
"existing `<details>`-style convention" overstates precedent that isn't
actually there. Option 3 is nearly as consistent on the panel-shape axis and
is more disciplined about accessible, text-based status encoding, but it
adds a compound view-control row (grouping + status filters + sort) and a
new comparison-stack content shape that together add slightly more new
surface area than Option 1's inline-table-plus-drawer. Option 2 is the clear
outlier through this lens: its top-of-panel tab switcher and two-pane
inbox/detail Review Queue layout have no real precedent anywhere in this
six-panel shell — every existing panel is one continuous, ungated read, and
Option 2 is the only option that turns the Personas panel into a
multi-screen navigation surface, which is the most "visually foreign island"
outcome of the three.
