# Finalist 2 — hardened jump-chips (derived from `minimal-jump-chips`)

**File:** `synthesized/finalist-2.html`

## Base option and why

This finalist is **`options/minimal-jump-chips.html`, structurally unchanged**, not a
blend of all three. It is the base because it is the only option that wins or
ties for first on a majority of the seven critique lenses, and it never drops
below third on any of them:

| Lens | Rank of minimal-jump-chips |
|---|---|
| glanceable-monitoring | **1st** (of 3) |
| accessibility | **1st** |
| consistency-with-existing-conventions | **1st** |
| build-feasibility | 2nd (effectively tied for 1st before fixes below) |
| visual-identity-cohesion | 2nd |
| navigation-wayfinding | 2nd |
| scale-realism | 3rd |

No other option has that profile. `sidebar-glanceable` wins navigation-wayfinding
and scale-realism outright but is *last* on accessibility, glanceable-monitoring,
and consistency — three lenses that speak directly to what an operator-facing
diagnostic shell needs (see below). `collapsible-clusters` wins build-feasibility
and visual-identity-cohesion but is *last* on navigation-wayfinding and only
narrowly better than last on glanceable-monitoring, undermined by its own
namesake feature.

## Why the alternatives were not chosen as the base

**`sidebar-glanceable`'s core mechanism actively works against two of the
project's stated priorities.** The accessibility critique is blunt about it:

> "its core interaction model — a JS-driven single-active-panel switched by
> plain `<button>`s with no `role="tab"`/`aria-selected`/`aria-current` and no
> scripted focus movement — means screen-reader users can't tell which sidebar
> item is active, and keyboard users hit a focus-order detour."

And glanceable-monitoring found the same mechanism hides almost everything by
default:

> "True single-active-panel tab pattern ... 7 of 8 panels are fully hidden at
> any moment."

Build-feasibility adds that this isn't just a design tradeoff, it's a
reliability risk baked into the markup itself:

> "it's the only option whose basic navigability is load-bearing on that
> script executing without error — since inactive panels are `display: none`,
> a JS failure hides 7 of 8 panels entirely."

Three independent lenses converge on the same mechanism as the root cause of
three different failures. That's disqualifying for a base, whatever its
navigation-speed and information-density wins (real, and partially reused
below).

**`collapsible-clusters` doesn't actually deliver on its own premise.** The
critique that should most favor it — navigation-wayfinding, since collapsing is
literally what it's for — instead ranks it last, because the collapse isn't
doing the job it was built for:

> "all three `<details>` clusters ship `open` by default, so there's no length
> reduction out of the box ... Operations sits 3rd inside the 'System' cluster
> with no direct anchor exposed in the UI."

And when a user *does* use the collapse affordance, glanceable-monitoring found
it takes out exactly the three panels an operator most needs visible at once:

> "the 'System' cluster bundles Liveliness + Settings + Operations behind a
> single collapse toggle — exactly the three panels flagged as needing to stay
> visible... Collapsed `<summary>` rows carry no status glyph at all."

Consistency-with-existing-conventions also flags a real, non-cosmetic
regression versus the live app: "the Personas panel loses its own heading
entirely (relies on the ancestor `<summary>`)" and panel titles are demoted
from `<h2>` to `<h3>` — structural regressions with no upside since the
collapse they're in service of doesn't even solve the stated problem.

## Three fixes applied on top of `minimal-jump-chips`, each tied to a specific critique finding

The base option is not defect-free, and each defect below has a direct citation.
All three are fixed in `finalist-2.html`; nothing else about the structure changed.

1. **Missing document wrapper.** Build-feasibility: "the file has no
   `<!doctype>`/`<html>`/`<head>`/`<body>` wrapper — it's an unclosed fragment
   that only renders correctly because browsers infer the missing structure."
   → `finalist-2.html` adds the full `<!doctype html><html><head>…</head><body>…</body></html>` wrapper.

2. **Submit buttons in action-less forms.** Build-feasibility: "three primary
   actions ('Add lane,' 'Search,' 'Save draft') use `<button type="submit">`
   inside bare, action-less `<form>`s — a landmine where incomplete JS wiring
   causes a full page reload that silently discards form state, inconsistent
   with every other button in the same file which correctly uses
   `type="button"`." → all three changed to `type="button"`, matching every
   other button already in the file (Reindex, Refresh, persona actions, graph
   toolbar).

3. **Amber pill reused for a health-status meaning.** Visual-identity-cohesion:
   "it's the only option that stretches amber into health-status meaning — the
   Memory Levels table uses the same amber 'needs-review' pill class to label a
   store as 'Degraded,' directly under three green 'Active' rows... it borrows
   a job `--fail` (red) should be doing." → a new `.status-pill.fail` (red,
   using the existing `--fail` token) is added and used for the Degraded row.
   `.status-pill.needs-review` (amber) is left untouched everywhere else in the
   file, where its meaning (a persona draft awaiting review) is the one place
   visual-identity-cohesion did *not* flag it as a problem.

## One additive enhancement, addressing the two lenses where the base was weakest

The two lenses where `minimal-jump-chips` placed lowest — navigation-wayfinding
(2nd) and scale-realism (3rd) — both point at the same specific gap: the chip
bar gives no sense of *where you are* or *what state things are in* without
clicking. Navigation-wayfinding notes sidebar-glanceable's advantage is
"live status badges per nav item give pre-click glanceability" that the chip
bar otherwise lacks ("no status-at-a-glance in the nav"). Scale-realism notes:

> "the sticky chip bar has no active/current-section indication, so once a
> real-sized Personas panel makes the page much longer, there's no relief
> valve and weak wayfinding once scrolled deep inside it."

`finalist-2.html` addresses both without adopting sidebar-glanceable's
disqualified hide/show mechanism:

- Each chip now carries a small status dot, colored from the same
  `--pass`/`--fail`/`--muted` tokens `.panel-status` already uses elsewhere in
  this file (not amber — deliberately, to avoid reintroducing the exact
  amber-as-health-status problem fix #3 above just removed).
- A small `IntersectionObserver` script highlights whichever chip corresponds
  to the section currently in the viewport, so the bar functions as a
  "you are here" indicator on a long page.

Both are strictly progressive enhancement. Every chip is a plain `#anchor`
link and every panel is visible in the DOM with zero script execution — if the
script fails or is stripped, the page degrades to exactly the original
`minimal-jump-chips` behavior, never to a broken or content-hiding state. This
preserves the specific property that won `minimal-jump-chips` the
glanceable-monitoring lens outright ("No collapsing, no active-panel JS
anywhere ... all 8 panels' full real content render simultaneously, always ...
the only cost is scroll distance") and the property build-feasibility
contrasted favorably against `sidebar-glanceable` (the other two options "fail
safe (content stays visible/scrollable regardless of JS state)").

## What was deliberately left unchanged

- Flat document order, undemoted `<h2>` panel titles, `.panel-status` classes,
  and the single `<details id="personas-glossary">` idiom — all called out by
  consistency-with-existing-conventions as the load-bearing conventions of the
  live app (`ui/index.html` / `ui/style.css`), and as exactly what
  `minimal-jump-chips` gets right: "leaves every load-bearing convention
  untouched ... Its only addition (a jump-chip bar) is small, additive, and
  reversible."
- The `sr-only` labels on the Search query/scope fields and correct
  `<label for>`/`<form>` hygiene throughout — accessibility's basis for
  ranking this option first: "the only option with fully correct label/`<form>`
  hygiene everywhere."
- No collapse, no single-active-panel switching, no cluster grouping — the
  mechanisms responsible for every worst-case finding against the other two
  options above.

## Net effect against the seven lenses

- **navigation-wayfinding**: unchanged 1:1 chip-to-panel mapping and correct
  `scroll-margin-top`, now with a status dot and current-section highlight
  closing the specific gap the critique named.
- **glanceable-monitoring**: unchanged — still the only option where nothing
  is ever gated behind a click.
- **accessibility**: unchanged — still zero JavaScript required for any core
  function, correct label/form hygiene throughout.
- **visual-identity-cohesion**: improves on the base — its one flagged defect
  (amber misused for "Degraded") is fixed; amber's meaning is now consistent
  everywhere in the file.
- **consistency-with-existing-conventions**: unchanged — still the closest
  match to the live app's real markup conventions.
- **scale-realism**: improves on the base — the "no active/current-section
  indication" gap is closed by the scroll-spy, without adopting the
  single-active-panel pattern that cost `sidebar-glanceable` three other
  lenses.
- **build-feasibility**: improves on the base — both concrete defects
  (missing document wrapper, submit-in-action-less-form landmine) are fixed;
  the file remains zero-build, zero-framework, and (new) fails safe even if
  its one small enhancement script doesn't run.
