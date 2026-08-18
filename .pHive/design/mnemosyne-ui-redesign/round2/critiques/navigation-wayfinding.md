# Navigation & Wayfinding — Round 2 Critique

**Lens:** Does this mockup solve the operator's actual complaint ("the ungodly long
list")? Scored on one concrete task: an operator wants ONE specific panel — Operations,
the 6th of 8 — and needs to get there and see it, as efficiently as possible, compared
to the current scroll-only baseline. Judged from the real markup/CSS/JS of each file,
not from the existence of a "nav" element.

The 8 panels, in document order, are consistent across all four candidates:
Liveliness, Settings, Lanes, Search, Graph, **Operations**, Personas, Memory Levels (0-4).

---

## 1. Collapsible Clusters (hardened)

`collapsible-clusters-hardened.html`

**Mechanism actually shipped:** a sticky `#cluster-nav` (line 521) with **three** plain
anchor links — `#cluster-system`, `#cluster-memory`, `#cluster-personas` (lines 523–526)
— each pointing at a native `<details class="cluster" open>` wrapping 2–4 panels. There
is no `<script>` tag anywhere in the file (`grep -n '<script'` returns nothing) — this is
a 100%-native-HTML solution, anchors + `<details>`, no JS at all.

Operations lives inside `<details id="cluster-system" open>` (line 533), as the third
panel after Liveliness and Settings (lines 538, 549, 566).

**Task walkthrough for "get me to Operations":**
1. The nav bar does **not** contain the word "Operations" anywhere. The operator has to
   already know (or guess) that Operations is filed under "System" — a naming/mental-model
   burden the other three candidates don't impose, since they all label the target
   directly.
2. Click "System" → jumps to `#cluster-system`, which lands the operator at the top of
   the cluster, i.e. at Liveliness — not at Operations.
3. Because every `<details>` is `open` by default (line 533, 610, 719 all say `open`),
   the operator now has to scroll/scan past Liveliness and Settings to reach Operations.
   This is a real click-then-scan compound action, not a single jump.

**The harder problem: the default state doesn't collapse anything.** All three clusters
ship pre-expanded. On first load this page is — panel-for-panel — the *same total length*
as the "ungodly long list" the operator complained about; the only change is that a
3-link jump bar now sits on top of it. The collapse affordance is real and does work
(native `<details>`/`<summary>` toggling, confirmed via the `.cluster[open] > summary::before`
rotate rule at line 148–150), but it is opt-in per session, and with zero `<script>` in
the file there is no `localStorage` or any other persistence — every fresh load resets to
fully expanded. An operator who collapses System/Memory/Personas to get a short menu has
to redo that on every page load.

**Round-1 fix check — "missing status signal on collapse":** genuinely fixed. Each
`<summary>` now carries a `.cluster-status-dot` (lines 508–511, 534, 611, 720) reflecting
aggregate cluster health (`pass`/`fail`/`review`), with a `title` attribute for the
tooltip text ("All System panels passing", "2 persona drafts need review"). This is a
real, working signal and it survives collapse. But it is *cluster-granularity* status
only — three panels share one dot — so even with the fix, the nav can tell you "System has
an issue" but not whether it's Liveliness, Settings, or Operations that has it. For the
specific task of locating Operations, this doesn't help; you still need to open the
cluster and read panel-level status once inside.

**Verdict for this lens:** the weakest of the four. It is a real improvement over raw
scroll (there is now a sticky landmark and an honest, working collapse mechanism), but
for the concrete "one named mid-list panel" task it forces the operator through an extra
mental-mapping step (which cluster?), a coarse jump (to the cluster top, not the panel),
a scan (past 1–2 preceding panels), and — worst of all — doesn't even start collapsed, so
by default it doesn't shorten anything until the operator manually intervenes with no
persistence.

---

## 2. Sidebar Glanceable (hardened)

`sidebar-glanceable-hardened.html`

**Mechanism actually shipped:** a true single-active-panel tab UI. `nav#panel-nav`
(line 467) has `role="tablist"`, `aria-orientation="vertical"`; each of the 8 items is a
`<button role="tab" aria-controls="…" aria-selected="…">` (lines 469–499) mapped 1:1 to a
`<section role="tabpanel" aria-labelledby="…" tabindex="0">` (lines 506, 517, 539, 572,
624, 665, 710, 893). CSS enforces `.panel{display:none}` / `.panel.active{display:block}`
(lines 160/168), and the click handler (lines 923–934) does a straightforward
"deactivate all, activate one" swap on both the button and its target section.

**Task walkthrough for "get me to Operations":** the sidebar item is literally labeled
`Operations` (line 489, `data-target="operations"`) with its own status badge
(`<span class="status-badge pass">pass</span>`, line 491) sitting right next to the
label — the operator can see it's not the panel with the problem, if that's relevant,
without clicking. One click on that single button and *only* the Operations panel is in
the DOM's visible flow — nothing else to scroll past, no other panel content on screen.
This is the shortest path of the four: one click, zero scrolling, and the result is fully
isolated (no visual noise from neighboring panels the operator doesn't care about right
now).

**Round-1 fix check — "missing ARIA":** genuinely fixed, and fixed correctly, not just
cosmetically. `role="tablist"` on the nav, `role="tab"` + `aria-selected` (kept in sync by
the click handler, lines 928/932) + `aria-controls` on each button, `role="tabpanel"` +
`aria-labelledby` + `tabindex="0"` on each section — this is the real WAI-ARIA tabs
pattern, not just a stray `aria-label`. One gap: no `aria-selected` toggling via keyboard
arrow-key roving tabindex (standard tabs pattern also expects Left/Right/Home/End to move
focus between tabs) — the buttons are correctly focusable and clickable, but a
keyboard-only operator has to Tab through all 8 buttons rather than arrow between them.
Real, but minor next to the fixed structural bug.

**New gap this round doesn't fix:** navigation state never touches the URL. The click
handler never sets `location.hash` or pushes history. An operator cannot bookmark or
share a link straight to "Operations," and the browser Back button does nothing to undo a
panel switch (it navigates away from the page entirely). This matters for wayfinding in
the multi-session/multi-operator sense, even though it doesn't hurt the single-session
"get me there fast" task this lens is primarily scored on.

**No-JS fallback:** `<noscript><style>.panel{display:block!important;}</style></noscript>`
(line 938) does work — with JS disabled, the CSS override makes all 8 panels visible
again — but at that point the nav buttons (plain `<button>`, no `href`) do nothing, so the
fallback degrades all the way to undifferentiated scroll with no jump mechanism at all,
worse than the anchor-based candidates' fallback (which keeps working identically with or
without JS).

**Verdict for this lens:** the strongest mechanism for the exact task asked — single
click, single panel, zero scroll, real ARIA tabs, per-item status visible without a
click. Docked slightly for no deep-linking/back-button support and a fallback that loses
the jump mechanism entirely rather than degrading gracefully.

---

## 3. Minimal Jump Chips (unchanged base)

`minimal-jump-chips-unchanged.html`

**Mechanism actually shipped:** a sticky `nav#jump-chips` (line 496) with all 8 panels
represented as individually labeled pill anchors — `#liveliness`, `#settings`, `#lanes`,
`#search`, `#graph`, `#operations`, `#personas`, `#memory-levels` (lines 497–504) — plain
`<a href="#…">` tags, no JS required for the jump itself. Each panel section carries
`scroll-margin-top: 112px` (line 148) so a native anchor jump lands the panel cleanly
below the sticky header + chip bar rather than tucked underneath it.

**Task walkthrough for "get me to Operations":** the chip literally says "Operations"
(line 502) — no mental mapping needed. One click on `#operations` triggers a native
browser anchor scroll straight to `<h2><span class="eyebrow">06</span>Operations</h2>`
(line 682), landing precisely thanks to `scroll-margin-top`. This is a real, single-jump
mechanism — the browser's own fragment-navigation, not a JS reimplementation of it — so it
is robust by construction (works with JS disabled, works with the back button, is
bookmarkable/shareable as a URL, doesn't depend on any script executing at all — there is
no `<script>` tag in this file).

**What it does *not* do:** the page itself is still one long flat document — all 8 panels
remain in normal flow (no `display:none`, no collapsing). The chips shorten *travel time*
to zero clicks-plus-scrolling, but once there, the operator is still looking at a full
document with everything else above/below Operations still rendered; there's no
isolation. The chip dots (`.chip-dot`, line 121) are purely decorative — uniform accent
color on every chip, no pass/fail/review differentiation — so the nav gives zero
at-a-glance status signal. That's a genuine gap relative to the other three candidates
(all of which give the nav *some* status signal), but it doesn't cost anything on this
specific lens, since the operator already knows they want Operations by name and doesn't
need the nav to tell them its state before clicking.

**Round 1 status:** flagged as needing no fixes and that holds up — nothing about the
core anchor-jump mechanism has changed and nothing about it was broken to begin with.

**Verdict for this lens:** essentially tied with the hybrid on the actual mechanics of
this task — same anchor-link jump, same per-panel labels, same scroll-margin fix, same
JS-independence. Ranks just behind the hybrid only because the hybrid is a strict
superset (identical jump mechanism, plus a real status ring on the chip and a shorter
document overall from the Personas collapse) with no offsetting downside for this lens.

---

## 4. Hybrid (finalist-3 rings + finalist-2 graph colors)

`hybrid-rings-original-graph-colors.html`

**Mechanism actually shipped:** built directly on minimal-jump-chips' nav (the file's own
top-of-file comment confirms the base and lists what was grafted on). Same 8-item
`nav#jump-chips` with `href="#operations"` etc. (lines 597–605), same
`scroll-margin-top: 112px` panel treatment. On top of that: chip dots now carry a real
status ring sourced from each panel's own status —
`.chip-pass .chip-dot { box-shadow: 0 0 0 3px rgba(79,209,122,.45) }` /
`.chip-fail .chip-dot { … rgba(255,107,107,.55) }` (lines 186–187) — applied as classes
directly on the anchors (`class="chip-pass"` on Liveliness/Settings/Lanes/Personas,
`class="chip-fail"` on Memory Levels, no class — correctly — on Operations/Search/Graph,
which aren't pass/fail-typed panels). A `<script>` (lines 1058–1087) adds an
`IntersectionObserver` that highlights whichever chip corresponds to the panel currently
scrolled into view — explicitly documented in-file as progressive enhancement only
("every chip still works as a plain #anchor link and every panel stays visible exactly as
without this script").

**Task walkthrough for "get me to Operations":** identical to minimal-jump-chips —
one click on the "Operations" chip, native anchor scroll, precise landing. No regression
introduced by the added rings or the observer script.

**What's actually new for this lens:** the status ring means an operator scanning the nav
bar before clicking anything can already see which panels are flagged (System/Memory
health at a glance) without opening them — this doesn't speed up reaching Operations
specifically (Operations carries no ring, correctly, since it's an action panel not a
health check), but it does make the *rest* of the nav more informative than
minimal-jump-chips' undifferentiated dots, which was a real, cited gap in round 1
("no status-at-a-glance in the nav" — see the code comment at lines 181–184 explicitly
calling this out as the fix target).

Also relevant: Personas' write/introspection tail is now behind a native
`<details id="persona-tools" open>` (lines 947–1023, open by default) rather than always
inline — this shortens the flat document somewhat, but Personas (07) sits *after*
Operations (06) in document order, so it has no effect on the distance/effort to reach
Operations itself; it's a document-length win for the page as a whole, not for this
specific task.

**Round 1 status carried in:** this candidate is new this round (a hybrid built from two
round-1 finalists' pieces), so there's no prior bug to re-check against — it inherits
minimal-jump-chips' nav mechanism whole, which round 1 already found needed no fixes.

**Verdict for this lens:** functionally tied with minimal-jump-chips on the core jump
mechanism (same anchors, same precision, same JS-independence — the observer script is
correctly non-load-bearing for navigation, only for the "current chip" highlight). Edges
ahead on the whole-nav picture because the status rings give the operator more reason to
trust the nav (they can see problems before clicking) without costing anything on the
one-target task this lens is scored against.

---

## Ranking (Navigation & Wayfinding lens only)

1. **Sidebar Glanceable (hardened)** — fastest path to a single named panel: one click,
   zero scroll, full isolation (nothing else visible), real ARIA tabs (fixed correctly),
   per-item status visible before clicking. Loses points only for no URL/back-button
   support and a no-JS fallback that degrades to undifferentiated scroll rather than
   staying jump-capable.

2. **Hybrid (rings + graph colors)** — same one-click, precise-landing anchor mechanism
   as #3, running on native browser fragment navigation (robust without JS, bookmarkable,
   back-button-friendly — genuine advantages sidebar-glanceable lacks), plus real
   per-chip status rings that make the whole nav bar more trustworthy at a glance. Ranked
   just below sidebar-glanceable only because reaching Operations lands you back in a
   still-long flat document rather than a fully isolated view.

3. **Minimal Jump Chips (unchanged base)** — mechanically identical jump for this exact
   task (same anchors, same precise scroll-margin landing, same JS-independence), ranked
   directly behind the hybrid only because the hybrid is a strict superset with no
   downside added for this lens (status rings, shorter Personas panel) — there's nothing
   this candidate does better than the hybrid on this axis.

4. **Collapsible Clusters (hardened)** — the round-1 status-dot fix genuinely landed
   (cluster-level pass/fail/review is real and working), but the structural mechanism
   itself is the weakest of the four for "one named mid-list panel": the nav never says
   "Operations" at all (only cluster names), the jump lands at the top of a 2–4-panel
   group rather than the target, the operator has to scan past preceding panels, and —
   most importantly — the page ships fully expanded by default with no persistence, so on
   a fresh load it is, panel-for-panel, exactly as long as the baseline the operator
   complained about.
