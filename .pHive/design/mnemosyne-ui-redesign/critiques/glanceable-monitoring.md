# Glanceable Monitoring — Critique

**Lens only.** Question asked of each mockup: while the operator's attention is
elsewhere (mid-scroll, focused on Search or Personas, glancing at the screen
in passing), how much of the *actual state* of Liveliness / Settings /
Operations (and, by extension, every other panel) is still readable without a
click — versus fully invisible behind an interaction?

Source reviewed for each option: full rendered screenshot + full HTML/CSS
(and inline `<script>` where present).

---

## 1. `collapsible-clusters.html`

**Mechanism:** three `<details>`/`<summary>` clusters — System (Liveliness,
Settings, Operations), Memory (Lanes, Search, Graph, Memory Levels), Personas
(Personas). All three ship with the `open` attribute, so the mockup's default
state has zero panels hidden.

**What's actually hidden, and when:**

- The clustering groups exactly the three panels the design discussion
  flagged as needing to stay visible — Liveliness, Settings, and
  Operations — into a *single* collapsible unit (`#cluster-system`). One
  click on the "System" summary collapses all three simultaneously. There
  is no way to collapse Settings without also collapsing Liveliness. This
  is the specific failure mode the lens is checking for, and this option's
  grouping makes it worse than a per-panel toggle would: one interaction
  blinds the operator to health check status, config values, *and*
  reindex/cache-refresh state all at once.
- When a cluster is collapsed, the `<summary>` row shows only the cluster
  name and a static tagline (e.g. "— health, config, and index/cache
  operations"). I read the CSS and markup closely for any status glyph on
  the summary itself: there is none. `#cluster-nav`'s `.nav-count` badges
  (`System <span class="nav-count">3</span>`) are static panel counts, not
  live pass/fail state — confirmed by the markup (`<span
  class="nav-count">3</span>` is a fixed literal, no binding to any status
  value). So a collapsed "System" cluster gives literally zero signal about
  whether Liveliness is currently passing or failing — not even a colored
  dot.
- Native `<details>` collapse is equivalent to `display:none` for assistive
  tech too, so this isn't just a visual gap.
- Upside: at rest (all open, as shipped), this is fully glanceable — a
  passive scroll shows every panel's real content, same as
  minimal-jump-chips. The risk is entirely conditional on an operator (or a
  future "collapse all" affordance) actually using the collapse
  interaction the component exists to offer. Since collapsibility is the
  entire point of this structural direction, treating it as "safe because
  it defaults open" undersells the risk — the affordance will get used.

---

## 2. `sidebar-glanceable.html`

**Mechanism:** persistent left nav (240px, always visible) driving a
single-active-panel content area via JS (`.panel{display:none}` /
`.panel.active{display:block}`, toggled by a click listener on
`.nav-item`). Confirmed in the `<script>` block: clicking a nav item removes
`.active` from all panels and adds it only to the target — this is a literal
tab pattern, not a visual reprioritization.

**What's actually hidden, and when:**

- At any given moment, 7 of 8 panels are fully removed from the render tree
  (`display:none`). If the operator is looking at Personas (as the screenshot
  demonstrates is the visually "loudest" panel, deliberately denser per the
  CSS comment), Liveliness, Settings, Lanes, Search, Graph, Operations, and
  Memory Levels are **all** simultaneously invisible — not just Liveliness.
  Every one of the specific facts the lens cares about (which of the 6
  liveliness checks passed, the exact `qdrant_url`, whether Operations'
  Reindex form has a lane selected) requires a click to reveal, with no
  partial/summary view in between.
- Real mitigation: the sidebar itself is always visible and carries a
  `status-badge` (pass/fail/loading, colored dot + word) next to every one of
  the 8 nav items, all 8 rendered at once regardless of which panel is
  active. This is a genuine glanceable surface — an operator working in
  Personas can still see, in peripheral vision, that Search is `loading` and
  Personas itself is `fail`. This is the only one of the three options that
  gives every hidden panel *any* passively-visible signal.
- But the badge is coarse by construction: one word, one dot, no numbers. It
  answers "is something wrong" but not "what, how badly, since when." Compare
  the actual Liveliness panel content (`✓ Qdrant Cloud reachable
  (research_memory, code_memory, ops_memory)`, `✓ Graph store reachable
  (1,842 nodes / 6,110 edges)`, a timestamp) against the sidebar's rendering
  of that same panel when inactive: just a green dot and the word "pass."
  Every specific number, every config value in Settings (`qdrantUrl`,
  `embedderModel`, `graphScanIntervalMin`, etc.), every Reindex/cache-refresh
  affordance in Operations — invisible until clicked. The "fail" badge on
  Personas in the screenshot is a good example of the ceiling on this
  approach: you know something needs review, not what, not why, not how
  urgently.

---

## 3. `minimal-jump-chips.html`

**Mechanism:** no collapsing, no active/inactive panel state anywhere. All 8
panels (`#liveliness` … `#memory-levels`) are ordinary `<section class="panel">`
elements in normal document flow, 2-column grid on desktop. The
`#jump-chips` nav bar is confirmed (by reading the CSS/markup fully) to
contain only `<a href="#id">` anchor links — no JS file, no `display:none`
rule targeting `.panel` anywhere in the stylesheet. Jump chips scroll the
page; they do not hide or reveal anything.

**What's actually hidden, and when:**

- Nothing. Every panel's real content — Liveliness's 5 check lines, Settings'
  5 config fields, Operations' two full op-blocks with their live
  lane-selector and path textarea, the Personas table with all 8 rows and
  both pending-review entries, the Memory Levels table with per-level status
  pills — is rendered in the DOM and on screen simultaneously, all the time.
  A passive glance (or a slow scroll, which costs attention but never a
  click) surfaces the full state of every monitoring surface at once. This
  is the literal absence of the tab-like pattern the lens is checking for.
- The only "cost" is vertical distance: on the actual screenshot, Personas
  and Memory Levels sit ~4500px down the page, so "glanceable while focused
  on Search" means scrolling, not a single eye movement. That's a real
  practical tradeoff (page length, need to scroll to correlate distant
  panels) — but it's a cost of *effort*, not of *information being deleted*.
  Everything scrolled-past is still fully rendered and still updates live if
  the app polls; nothing needs to be re-fetched or re-opened to become
  visible again.
- No JS-driven state at all also means there's no risk of the design
  regressing toward hiding things later via a "collapse" or "focus panel"
  feature creeping in — the structural direction itself doesn't offer that
  affordance to begin with.

---

## Ranking (glanceable monitoring only)

1. **minimal-jump-chips — strongest.** Zero panels are ever hidden behind an
   interaction. Every fact (check-by-check liveliness detail, exact config
   values, live Operations form state, full persona table, per-level memory
   status) is simultaneously on-page. The jump-chip nav is purely additive
   (fast navigation) and never subtracts visibility. This is the only option
   with no failure mode to describe under this lens — the worst that can be
   said is "you may have to scroll," which is a different concern
   (information density / page length), not glanceability.

2. **collapsible-clusters — middle, but with a specific sharp edge.** Ships
   fully open, so at rest it's as glanceable as option 3. The risk is
   structural: the System cluster bundles exactly Liveliness + Settings +
   Operations — the three panels called out as needing to stay visible —
   behind one collapse toggle, and the collapsed state exposes no status
   signal whatsoever (no badge, no pass/fail glyph, static item-count only).
   If this collapse affordance gets used the way collapsible components
   normally get used (to reduce clutter while working in Memory or
   Personas), the operator loses all three flagged panels at once with zero
   passive fallback. Better than option 2 only in that the *default* state
   is fully open and the collapse is operator-initiated rather than baked
   into the navigation model.

3. **sidebar-glanceable — weakest for the specific things this lens cares
   about, despite a real mitigation.** Structurally this is the closest to
   the tab pattern the design discussion warned about: single active panel,
   7/8 panels fully removed from the DOM's visible state at any time. It
   does the most work of the three to blunt that risk (always-visible
   sidebar with a status badge per panel, so operators get *some* passive
   signal for all 8 panels at once) — genuinely better than "nothing," and
   better than collapsible-clusters' collapsed state which shows nothing at
   all. But the badges only carry a one-word/one-dot status, not the actual
   content (numbers, config values, specific failing check, live form
   state) that "glanceable monitoring" was asking for. If the operator is
   parked on Personas, Liveliness's six individual checks, Settings' seven
   config fields, and Operations' reindex-lane selection are all completely
   invisible — only a green dot and the word "pass" survive.

## Strongest option(s) through this lens alone

**minimal-jump-chips** is unambiguously the strongest for glanceable
monitoring: it is the only option that never hides real state behind a
click, under any interaction path, for any panel. If a hard pick between
"nothing hidden, costs scroll distance" and "aggregate status always visible,
detail hidden" is required, minimal-jump-chips wins outright because the lens
is specifically about *information being invisible*, not about layout
efficiency.

If some structuring/collapsing is non-negotiable for other reasons (density,
scannability of an 8-panel page), **sidebar-glanceable**'s persistent
status-badge sidebar is the only one of the other two that gives the
operator any passive signal at all when a panel isn't the active one, and
should be preferred over collapsible-clusters as designed — specifically
because collapsible-clusters' collapsed state offers no status indicator
whatsoever and, worse, groups Liveliness/Settings/Operations into a single
collapse unit, which is precisely the failure case this lens exists to
catch. If collapsible-clusters is pursued further, the fix implied by this
review is to add a live status glyph to each cluster's `<summary>` row (so
collapsing still leaves a pass/fail signal) and/or stop bundling
Liveliness+Settings+Operations behind one toggle.
