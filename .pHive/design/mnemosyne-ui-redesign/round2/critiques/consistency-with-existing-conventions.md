# Lens: Consistency with Existing Conventions — Round 2

Scope: does each candidate extend the real, shipped idioms of `ui/index.html` /
`ui/style.css` / `ui/app.js` (bare `<h2>` per `<section class="panel">`, a
`<p class="panel-status pass|fail|loading">` immediately under most `<h2>`s,
monospace `.mono`/`.detail` for data, `--pass`/`--fail`/`--accent` color
tokens, plain `type="button"` buttons, a full `<!doctype>…<body>` document) —
or invents a foreign vocabulary the shipped app doesn't have. All four files
were read directly (not screenshots). Line numbers cite the actual candidate
files.

Ground truth checked directly against the live app:
- `ui/index.html`: every panel is `<section id="…" class="panel">` → bare
  `<h2>Title</h2>` → (usually) `<p class="panel-status" id="…">`. Search and
  Memory Levels both have a `panel-status` element in the shipped page
  (`search-status` at index.html:82, `memory-levels-status` at
  index.html:467). Operations does **not** have a top-level panel-status
  (goes straight from `<h2>` to `<p class="panel-hint">`) — that's the one
  legitimate exception.
- `ui/app.js`: `setStatus()` only ever writes class `loading`, `pass`, or
  `fail` (app.js:21-24). There is **no third "review" status kind** anywhere
  in the real app — `loadDrafts()` reports "`N draft(s) pending review`" with
  kind `"pass"` (app.js:2034), i.e. pending-review is modeled as a *pass*,
  not a warning tier.
- `ui/style.css:426-433`: the real graph already reuses `--fail` (red) for
  `.graph-node.selected` and `--pass` (green) for `.graph-node.focus`. That
  color reuse is the *existing* convention, not a bug to fix.
- `.status-pill` (live/needs-review/degraded/history) does not exist
  anywhere in the real codebase (`ui/style.css`, `ui/index.html`, or
  elsewhere) — it's a component all four mockups share from earlier design
  rounds, not part of the shipped app. Since all four use it equally, it
  doesn't differentiate them on this lens, but none of them can claim it as
  "unchanged from the real app" either.

---

## Collapsible Clusters (hardened)

**Round-1 fix claimed:** headings restored, live status dot on each cluster
`<summary>`.

**Did it work?** Partially. The dot fix is real and effective: each
`<details class="cluster">` summary now carries a
`<span class="cluster-status-dot pass|fail|review">` (lines 508-511 CSS,
534/611/720 markup) so cluster-level health survives collapse — that
specifically resolves the round-1 "missing status signal on collapse"
complaint, and it does so cleanly: the dot is a new *aggregation-only*
vocabulary layered on top of the panels, not a rewrite of the per-panel
`panel-status` idiom. Inside each panel, `panel-status` stays strictly binary
(`pass`/`fail`/`loading`) exactly as canonical — e.g. Personas is
`<p class="panel-status pass">9 personas (2 pending review)</p>` (line 725),
matching `app.js`'s real "review isn't a failure" semantics, while the
cluster dot alone carries the extra "review" shade (line 720). That's the
most semantically correct handling of the pending-review state of any of the
four candidates.

**But the `<h2>` restoration is incomplete/imperfect in ways not mentioned in
the fix description:**
- Every restored heading uses `<h2 class="panel-title">` (lines 538, 549,
  566, 615, 634, 670, 698, 724) instead of the canonical bare `<h2>`. Minor,
  but it's a class the real app doesn't have on any heading.
- Two of eight panels are **missing the `panel-status` paragraph entirely**,
  which canonical has for both: `#search` (line 634, jumps straight from
  `<h2>` to the query row, no status text at all — canonical has
  `search-status`) and `#memory-levels` (line 698, jumps from `<h2>` to
  `panel-hint` — canonical has `memory-levels-status`). This is a real
  regression against both the shipped app and this file's own sibling
  panels (Liveliness/Settings/Lanes/Graph/Personas all correctly have one).
- The Memory Levels table itself lost data along with the status text: all
  five rows read `class="mono">active` (lines 706-710) — the "File doc
  store / Degraded" row present in every other candidate's Memory Levels
  table is simply gone here, which conveniently avoids the amber/red
  color-reuse question by deleting the failing case rather than modeling it.
- New foreign element: `<h1>` now wraps a large embedded base64 raster logo
  (line 517) ahead of the plain-text title. Canonical's `<h1>` is
  text-only. Minor for this lens (more a visual-identity concern) but it is
  vocabulary the app doesn't have.
- Structurally, every panel now lives two levels deeper than canonical:
  `<details class="cluster"><div class="cluster-body">` wraps
  `<section class="panel">` (lines 533-536) where the real app has `<section
  class="panel">` as a direct child of `<main>`. This is the largest
  structural departure from the shipped document shape of any candidate.

## Sidebar Glanceable (hardened)

**Round-1 fix claimed:** real ARIA tab semantics, no-JS fallback, fixed
review/fail badge color.

**Did it work — partially, and the badge fix is internally contradicted.**
The ARIA hardening is real: `nav#panel-nav` is `role="tablist"`
(line 467), each nav button is `role="tab"` with `id`/`aria-controls`/
`aria-selected` (lines 469-499), each `<section>` is `role="tabpanel"
aria-labelledby="tab-…" tabindex="0"` (lines 506, 517, 539, 572, 624, 665,
710, 893), and there's a `<noscript><style>.panel{display:block!important}
</style></noscript>` fallback (line 938) so the page degrades to "all panels
visible" without JS — a legitimate, working no-JS escape hatch. However this
is still a complete WAI-ARIA `tab` pattern only in the roles/attributes; the
interaction is click-only (`btn.addEventListener('click', …)`, line 925) —
there's no `keydown`/arrow-key handling anywhere in the file, so the
roving-tabindex/arrow-navigation the `tablist` role implies for sighted
keyboard and screen-reader users isn't actually implemented. That's a
residual accessibility-pattern gap, but not the thing this lens cares most
about.

More importantly for *this* lens: the round-1 "color-semantics bug" (using
`--fail`/red for a non-failure) is only half-fixed. The **nav badge** for
Personas now correctly reads `<span class="status-badge review">review</span>`
(line 495, using the new `.status-badge.review` class at line 148, amber).
But the **panel's own status text**, two clicks away in the same file, still
says `<p class="panel-status fail">fail — 2 drafts need review</p>`
(line 712) — red, for the identical underlying condition the nav badge just
called "review" in amber. That is a genuine internal contradiction the
hardening pass introduced/left in: two UI elements in the same document
disagree about whether "2 drafts pending" is a `fail` or a `review`, and
neither matches canonical, where `loadDrafts()` reports this exact condition
as `pass` (app.js:2034). So the specific defect that was supposedly fixed
is still present, just moved to a different element.

Setting the bug aside, this candidate has the cleanest literal heading markup
of the four — bare `<h2>Liveliness</h2>` etc. (lines 507, 518, 540, 573, 625,
666, 711, 894), no added classes, an exact match to canonical — and full
`panel-status` coverage on every panel including Search (`loading…`,
line 584) and Memory Levels (`pass`, line 903), which none of the other three
manage completely. But those wins sit on top of the single biggest
structural break from the shipped app of any candidate: canonical is one
flat, always-visible document (every section rendered, plain scroll,
Ctrl+F reaches everything); this candidate hides seven of eight panels via
`.panel{display:none}` (line 160) and swaps them in with JS, a
single-active-panel/tab paradigm that exists nowhere in the real app. That's
not a bug the hardening pass could plausibly fix — it's the candidate's
entire premise — but it is the largest "foreign vocabulary" of the four for
a lens specifically about matching existing conventions.

## Minimal Jump Chips (unchanged base)

No round-1 fixes were applied (explicitly "no fixes needed"). Reading it
directly turns up real, uncorrected consistency problems that the other
lenses evidently didn't catch or didn't weight the same way this lens does:

- **No document wrapper.** `grep`-confirmed: no `<!doctype>`, `<html>`,
  `<head>`, or `<body>` tag anywhere in the file — it opens directly with an
  HTML comment, then a bare `<meta charset>`/`<style>` block, then content.
  Every other candidate (and the real app) has a full document skeleton.
  This is about as basic a document-shape convention as exists and it's
  simply absent here.
- **`type="submit"` on action-less forms.** Add-lane (line 559), Search
  (line 580), and Save-draft (line 878) buttons are `<button
  type="submit">` inside `<form>` elements with no `action`, while every
  other button in the same file (`#refresh-btn`, graph toolbar, persona
  action buttons) correctly uses `type="button"`. That's an internal
  inconsistency within this file's own convention, not just against
  canonical.
- **`<span class="eyebrow">01</span>` inside every `<h2>`** (lines 510, 520,
  532, 564, 625, 682, 723, 914) — a decorative numbering prefix the real
  app's bare `<h2>Title</h2>` never has. Structurally minor (still one `h2`
  per panel, still text-first) but it is vocabulary canonical doesn't use.
- **Unfixed color-reuse bug**: Memory Levels row 4 is `<span class="status-pill
  needs-review">Degraded</span>` (line 929) — the same amber "needs-review"
  pill class used for pending persona drafts is reused to mean "this store
  is actually failing," collapsing two different real-world severities into
  one color. Canonical's own `pass`/`fail` split (app.js) treats these as
  different states; this file doesn't.
- Also missing `panel-status` under both `#search` (line 564) and
  `#memory-levels` (line 914), same gap collapsible-clusters has.

Where it's genuinely strong: the document stays flat (no hidden panels, no
collapse), section nesting is exactly one level (`<section class="panel">`
directly under `<main>`, matching canonical depth precisely), and
`panel-status` where present is styled identically to canonical
(`.panel-status.pass/.fail/.loading`, nothing extra). It just also ships with
four concrete, checkable defects that "no fixes needed" doesn't own up to.

## Hybrid (finalist-3 rings + finalist-2 graph colors)

This file is explicitly a hardened build on top of minimal-jump-chips, and
reading it confirms the claimed fixes actually landed:

- **Document wrapper present**: `<!doctype html><html lang="en"><head>…
  <body>` (lines 1-3, 590) — fixed vs. the base.
- **All buttons are `type="button"`**, confirmed by grep across the whole
  file (lines 594, 640-642, 663, 684, 736, 741-744, 811, 821, 878-937, 990)
  — fixed vs. the base's `type="submit"` landmine.
- **Graph node coloring matches canonical exactly, not just "restores
  something."** `--node-selected: var(--fail); --node-focus: var(--pass);`
  (lines 71-72) are new *named* tokens, but they resolve to the identical
  values `ui/style.css:426-433` already uses for `.graph-node.selected` /
  `.graph-node.focus`. This is the one candidate whose graph coloring is
  provably byte-identical in behavior to the shipped app's existing (if
  semantically odd) convention — the "fix" here is a rename for
  self-documentation, not a value change, and for *this* lens that's exactly
  right: it doesn't drift from canonical at all.
- **Degraded vs. needs-review are now distinct**, and correctly modeled:
  persona draft rows stay `.status-pill.needs-review` (amber) while Memory
  Levels row 4 is now `.status-pill.degraded` (red) with an inline comment
  explaining the distinction (lines 1044-1047). This also gets the
  `panel-status` right where the base didn't:
  `<p class="panel-status fail">1 store degraded</p>` now sits directly
  under Memory Levels' `<h2>` (line 1028) — canonical shape, canonical
  color for a real failure, unlike collapsible-clusters (which has no
  panel-status there at all) or minimal-jump-chips (which has a color bug
  there instead).
- The one native `<details id="persona-tools" open>` (line 947) used to
  collapse the write-oriented draft form is explicitly modeled on
  `#personas-glossary`'s existing `<details>` (line 840) — i.e. it extends
  an idiom the file (and canonical, which also has a `#personas-glossary`
  details block) already establishes, rather than inventing a new one. This
  is the correct way to add a collapse mechanism without introducing a
  foreign pattern — contrast with collapsible-clusters' `<details>`-wraps-
  everything approach, which nests panels two levels deeper than canonical
  everywhere, not just where density actually demands it.
- Residual, unfixed gaps inherited from the base: `<span class="eyebrow">NN
  </span>` inside every `<h2>` is still present (line-for-line same pattern
  as minimal-jump-chips), and `#search` (line 667) still has no
  `panel-status` paragraph.

Net effect: this candidate fixes three of minimal-jump-chips' four real
defects (doctype/body wrapper, button types, color-reuse) while keeping its
structurally-correct flat, always-visible, one-level-deep document, and adds
exactly one new collapse mechanism that mirrors an idiom canonical already
uses. It's the only file where "restored/fixed" claims in its own header
comment were verifiable line-by-line against the real app's source.

---

## Ranking (most → least consistent with existing conventions)

1. **Hybrid (finalist-3 rings + finalist-2 graph colors)** — flat
   always-visible document at canonical's exact nesting depth; full
   `<!doctype>`/`<html>`/`<head>`/`<body>` wrapper; every button
   `type="button"`; graph node coloring is provably identical to
   `ui/style.css`'s real values (not just similarly-styled); the
   degraded/needs-review split is the most semantically correct status
   modeling of any candidate outside collapsible-clusters; its one new
   `<details>` collapse extends an idiom canonical already has instead of
   inventing a new structural layer. Remaining flaws (eyebrow span, missing
   `#search` panel-status) are real but minor and shared with its base.

2. **Minimal Jump Chips (unchanged base)** — same flat, correctly-nested
   document shape as the hybrid, but ships with the four defects the hybrid
   fixed: no document wrapper at all, `type="submit"` inconsistent with its
   own file's other buttons, the amber-pill color-reuse bug, and the same
   missing-panel-status gaps. Structurally sound, textually/semantically
   sloppier than its own derivative.

3. **Collapsible Clusters (hardened)** — the cluster-status-dot fix
   genuinely resolves the round-1 "status disappears on collapse" complaint,
   and does so without corrupting the underlying binary pass/fail/loading
   panel-status vocabulary (its Personas status text correctly stays
   "pass," matching `app.js`'s real semantics — the best of the four on
   that specific point). But it wraps every panel two structural levels
   deeper than canonical (`<details><div class="cluster-body"><section
   class="panel">`, vs. canonical's `<section class="panel">` as a direct
   child of `<main>`), drops the `panel-status` paragraph entirely from two
   of eight panels (Search, Memory Levels) where canonical and its own
   sibling panels have one, quietly deletes the "Degraded" data row instead
   of modeling it, adds a `panel-title` class to every `<h2>` canonical
   doesn't use, and bolts a large embedded logo image onto `<h1>`. The
   headline round-1 fix (status dot) worked; several things not mentioned
   in that fix description didn't.

4. **Sidebar Glanceable (hardened)** — the ARIA hardening (real
   `tablist`/`tab`/`tabpanel` roles, `aria-selected`, a working no-JS
   fallback) is a genuine, verifiable improvement, and its `<h2>` tags are
   the single cleanest match to canonical of any candidate. But the
   specific bug the round-1 critique flagged — reusing a failure color for
   a non-failure state — is still present: the nav badge now correctly says
   "review" (amber) while the panel's own status text two clicks away
   still says "fail" (red) for the identical condition, an internal
   contradiction the hardening pass introduced rather than resolved. And
   independent of that bug, this candidate's core mechanism — hiding seven
   of eight panels via `display:none` and swapping them with JS into a
   single-active-panel tab view — has no precedent anywhere in the real
   app, which is one flat always-visible document end to end. That's the
   largest structural departure from canonical of the four, and no amount
   of correct ARIA wiring makes a pattern the shipped app doesn't have into
   one that's "consistent" with it.
