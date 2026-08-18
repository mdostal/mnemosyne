# Accessibility Critique — Mnemosyne UI Redesign Options

Lens: keyboard navigability, semantic correctness, screen-reader friendliness only.
Method: read each option's HTML source directly (not just the rendered screenshot).

---

## 1. collapsible-clusters.html

**Strengths**

- The three top-level groupings (System / Memory / Personas) and the nested persona
  glossary (`#personas-glossary`) all use native `<details>`/`<summary>`. This is the
  single most robust disclosure pattern available in HTML: the browser supplies
  `aria-expanded`/expanded-collapsed state, Enter/Space activation on the summary, and
  correct exposure in every major screen reader with zero custom JS. No other option
  uses this element.
- `#cluster-nav` is a real `<nav aria-label="Cluster navigation">` containing real
  `<a href="#cluster-system">` anchors with visible counts (`System <span
  class="nav-count">3</span>`) — genuine in-page navigation, reachable and activatable
  by keyboard alone, with native browser scroll-to-anchor behavior.
- The graph toolbar's icon-only zoom controls are properly labeled:
  `<button ... title="Zoom in" aria-label="Zoom in">+</button>` and the same for
  zoom-out — not icon-only-with-no-name.
- Focus-visible styles are defined for links, summaries, and form controls
  (`:focus-visible { outline: 2px solid var(--accent); ... }`), so keyboard focus stays
  visible throughout.

**Weaknesses**

- Broken label association in two non-trivial places. "Add lane" fields and the entire
  "Propose / edit persona draft" form (8 fields: Tier, Scope ID, Display name, Scope,
  Section heading, Section body, Repo, Attach files) use the pattern
  `<div class="form-row"><label>Name</label><input placeholder="…" /></div>` — the
  `<label>` has no `for`, the input has no `id`, and the label does not wrap the input.
  A screen reader landing on any of these inputs announces only "edit text, blank" with
  no field name. This is the largest persona-authoring surface in the mockup and it is
  effectively unlabeled for AT users.
- None of the input clusters (Add lane, Search, the persona draft form) are wrapped in
  a `<form>` element at all — they're bare `<div>`s with a heading and a button. This is
  the only one of the three options that never uses `<form>` anywhere, so AT users get
  no "form" landmark to jump to and no semantic grouping of "these fields belong to this
  action."
- The Search panel's query input and scope `<select>` have no label at all, visible or
  hidden (`<input placeholder="query…" .../>`, `<select><option>(default scope)
  </option></select>`), unlike minimal-jump-chips which adds `sr-only` labels for the
  same fields.
- Row-scoped action buttons ("Remove", "Edit", "Review") carry no differentiating text
  — a screen-reader user tabbing through the Lanes or Personas tables hears "Remove,
  button" / "Edit, button" repeated with no indication which row it belongs to.

---

## 2. sidebar-glanceable.html

**Strengths**

- All form fields in Lanes, Search-adjacent, and the Personas draft form use correct
  `<label for="…">`/`id="…"` pairing throughout (e.g. `persona-tier`,
  `persona-scope-id`, `persona-display-name`, …), and those input groups are properly
  wrapped in `<form>` elements — better landmark structure than collapsible-clusters.
- The 8 sidebar entries are real `<button type="button">` elements inside a `<nav
  aria-label="panels">` — natively focusable and Enter/Space-activatable, with visible
  focus rings (`.nav-item:focus-visible`).
- Status badges are text, not icon-only (`<span class="status-badge pass">pass</span>`),
  so "pass/fail/loading" is always available to a screen reader; the decorative dot is
  a CSS `::before`, not read as content.
- Only the active panel is present in the layout flow (`.panel{display:none}`, `.panel.
  active{display:block}`) — hidden panels' controls are correctly removed from both the
  visual view and the tab order, so keyboard users are not forced through 7 panels'
  worth of dead controls.

**Weaknesses**

- The sidebar nav-item buttons carry no ARIA relationship to the panel they control:
  no `role="tab"`/`aria-selected`, no `aria-current`, no `aria-controls`. The only
  signal of "which panel is active" is a CSS class (`.active` → accent color + left
  border) that is purely visual. A screen-reader user tabbing through the 8 sidebar
  buttons gets no indication of which one currently corresponds to the visible panel —
  this is exactly the kind of state that `aria-current="page"` or a proper
  `tablist`/`tab`/`tabpanel` triad exists to solve, and it's absent here.
- Because `<nav id="panel-nav">` precedes `<main>` in the DOM and panel switching is a
  plain `click` listener with no scripted focus management, activating a sidebar button
  leaves keyboard focus sitting on that button. The next Tab press does not jump into
  the newly revealed panel — it continues through whatever sidebar buttons remain after
  the one just activated. A keyboard user who selects "Lanes" (3rd of 8) must Tab
  through Search, Graph, Operations, Personas, Memory Levels (5 more buttons) before
  reaching the Lanes panel's own "Add lane" fields. This is a real, citable keyboard-
  efficiency defect specific to this option's architecture (SPA-style single active
  panel with no focus management) — collapsible-clusters and minimal-jump-chips don't
  have it because their nav is either 3 links (not 8) or absent as a routing mechanism.
- Same unlabeled-row-button issue as the other two options ("Remove"/"Edit"/"Review"
  with no row context).
- `nav aria-label="panels"` is a serviceable but terse landmark name; "Panel
  navigation" or similar would read better in a landmarks list, minor nit.

---

## 3. minimal-jump-chips.html

**Strengths**

- No JavaScript at all — the entire document is static HTML/CSS. Every control that
  exists is reachable exactly the way native HTML behavior guarantees: no click
  handlers to fail, no dynamic show/hide to get out of sync with the accessibility
  tree, works identically with JS disabled.
- All 8 panels are always present in one continuous document in visual/reading order,
  so Tab order, DOM order, and visual order are all identical — the least ambiguous
  possible mapping for both keyboard and screen-reader users. There is no "which
  element is currently hidden vs visible" state to get wrong.
- `#jump-chips` is a real `<nav aria-label="jump to panel">` of real `<a href="#…">`
  anchors — same robust pattern as collapsible-clusters' cluster nav, but at finer
  (per-panel, 8-item) granularity, so a keyboard user can jump straight to any of the 8
  panels rather than only the 3 clusters.
- Best label hygiene of the three: the Search panel's query and scope fields get
  explicit (visually hidden but AT-exposed) labels —
  `<label for="search-query" class="sr-only">Query</label>` /
  `<label for="search-scope" class="sr-only">Scope</label>` — something neither other
  option does. The Lanes "Add lane" fields and the full persona draft form (Tier,
  Scope ID, Display name, Scope, Section heading, Section body, Repo, Attach files) all
  use correct `<label for>`/`id` pairs, and all three of these field clusters are
  wrapped in real `<form>` elements — the only option where every input cluster is
  both correctly labeled and correctly form-wrapped.
- Icon-only zoom buttons are labeled the same way as the other two
  (`aria-label="Zoom in"`/`"Zoom out"`), and `<svg role="img" aria-label="impact graph
  node-link diagram">` gives the graph visualization an accessible name.

**Weaknesses**

- The `<span class="eyebrow">01</span>` index prefixed onto every `<h2>` (e.g. `<h2>
  <span class="eyebrow">01</span>Liveliness</h2>`) is not `aria-hidden`, so a screen
  reader announces "0 1 Liveliness" / "0 2 Settings" for every single section heading —
  harmless but noisy; trivial fix (`aria-hidden="true"` on the span) not applied here.
- The sticky jump-chip bar has no way to indicate "you are here" — no `aria-current`
  on the chip matching the panel currently in view — a nice-to-have (collapsible-
  clusters and sidebar-glanceable don't have this either, but sidebar-glanceable's
  visual "active" state at least exists for sighted users; here not even that, since
  every panel is always visible).
- Being the longest single flattened document, keyboard users who ignore the jump-chip
  shortcuts and just Tab sequentially must pass through all 8 panels' worth of controls
  in one linear sequence — mitigated by the jump chips existing at all, but worth
  naming as the structural cost of "nothing collapses."
- Same shared weaknesses as the other two: row-scoped "Remove"/"Edit"/"Review" buttons
  with no distinguishing accessible name, and `<th colspan="6">` persona group-header
  rows with no `scope` attribute.

---

## Ranking (accessibility lens only)

1. **minimal-jump-chips** — strongest overall.
2. **collapsible-clusters** — close second, held back mainly by broken form labels.
3. **sidebar-glanceable** — weakest, due to missing selected-state semantics and a
   focus-order detour baked into its core interaction model.

**Reasoning**

- minimal-jump-chips wins on the combination of (a) zero reliance on JavaScript state
  management, so there's no dynamic show/hide to desync from the accessibility tree,
  (b) the most granular real anchor-link nav (8 jump targets vs. 3), and (c) the only
  fully correct label/`<form>` hygiene across Add-lane, Search, and the persona draft
  form — the other two both have at least one meaningfully unlabeled input cluster.
  Its only real cost is a longer sequential tab path if a user ignores the chips, and
  that's a wash against the other options' own defects.
- collapsible-clusters earns real credit for using native `<details>`/`<summary>` —
  the textbook-correct disclosure widget, better in principle than sidebar-glanceable's
  custom-JS single-active-panel with no ARIA state, and on par with minimal-jump-chips'
  static anchors for its 3-item cluster nav. It loses ground purely on execution: the
  persona draft form and Add-lane fields are unlabeled, and it's the only option with
  no `<form>` elements anywhere.
- sidebar-glanceable ranks last specifically because its structural idiom — a
  JS-driven single-active-panel switched by plain buttons — is the one pattern of the
  three that needed extra ARIA to be trustworthy (`aria-selected`/`aria-current`/
  `role="tab"`, plus scripted focus movement into the revealed panel) and didn't get
  it. Its label hygiene is otherwise good (better than collapsible-clusters, on par
  with minimal-jump-chips), but the missing active-state semantics and the focus-order
  detour through unrelated sidebar buttons are defects baked into the chosen
  architecture, not just missing polish.

## Strongest option(s) through this lens alone

**minimal-jump-chips**, with **collapsible-clusters** as a strong, nearly-equal
runner-up.

Both share the trait that matters most for this lens: they rely on native HTML
semantics (real anchors, and — for collapsible-clusters — native `<details>`) rather
than inventing custom interactive widgets that need hand-rolled ARIA to be legible to
assistive tech. minimal-jump-chips edges ahead only because its form-labeling is
uniformly correct where collapsible-clusters' is not; that gap is a fixable
implementation bug rather than an architectural one, so if it were corrected the two
would be roughly tied. sidebar-glanceable is the one option whose core interaction
model (single visible panel, JS-switched, no selected-state ARIA, no focus
management) actively works against keyboard and screen-reader users rather than just
having incidental gaps, and would need the most rework to reach parity.
