# Scale Realism Critique — Mnemosyne UI Redesign Options

**Lens only:** would this structure still work once the real Personas panel (~50% of UI surface by every measure) and the real Graph panel (7 toolbar controls + inspector + SVG canvas) are dropped in at full size/density — not the idealized, thinned-down version each mockup actually shows? General craft, visual polish, and other lenses are out of scope here.

All three mockups render all 8 real panels (Liveliness, Settings, Lanes, Search, Graph, Operations, Personas, Memory Levels) and all three include the full 7-control graph toolbar (focus-node input, Go, depth select, zoom-in, zoom-out, reset view, show-whole-graph). That baseline is fair across all three. What differs is how each *arranges* those panels once Personas and Graph are allowed to actually be as big and dense as they are in the real app — and, tellingly, how faithfully each mockup even attempted to mock that real density in the first place.

---

## Option 1: collapsible-clusters

**File:** `options/collapsible-clusters.html` · **Screenshot:** `options/collapsible-clusters.png`

**Structure:** 8 panels grouped into 3 native `<details>/<summary>` clusters (System, Memory, Personas), all open by default, with a sticky top nav that jumps to the 3 cluster anchors only (`#cluster-system`, `#cluster-memory`, `#cluster-personas`, lines 516–521). `main` is capped at `max-width: 900px` (line 110).

**What works for scale:**
- Personas gets its own top-level cluster, structurally equal to System and Memory. If Personas really is ~50% of the UI, a user can collapse the System and Memory `<details>` and leave only Personas open, shrinking everything else out of the way. This is a genuine, native (no-JS) mechanism for absorbing a panel that dominates the page — the strongest scale affordance this option offers.
- The Memory cluster body is plain single-column (`.cluster-body` without `.grid-2`, confirmed at line 607/171–173), so each panel — including Graph — gets the cluster's full width rather than fighting a sibling for half a row. That's the right call once Graph needs real room for its toolbar and canvas.

**What breaks or is undertested at real scale:**
- **The Graph canvas isn't actually mocked.** Line 680: `<div id="graph-view">[ node-link diagram — 640×480 viewBox ]</div>` — literal placeholder text, not an SVG. Both other options render an actual `<svg>` with nodes, edges, and labels (see below). This means collapsible-clusters is the only one of the three that never had to lay out real graph content next to its 7-control toolbar and inspector column — exactly the kind of "idealized simplified version" the review brief warns against. We can't tell from this mockup whether `#graph-body`'s flex layout actually holds up with a dense rendered diagram.
- **Search is modeled with only 5 columns** (Layer, Match, Score, File, Snippet — lines 641–660), missing Chunk span, Embedder, Retrieved at, and Provenance that both other options include and wrap in an `overflow-x:auto` scroll container. This isn't the Personas/Graph panel the brief calls out, but it's the same failure mode: a dense real panel represented by a thinned-down stand-in, so the layout was never pressure-tested against it.
- **Nav granularity is cluster-level, not panel-level.** With only 3 anchors (line 518–520), once Memory is expanded (Lanes + Search + Graph + Memory Levels stacked), there is no way to jump straight to Graph — a user must open the Memory cluster and scroll past Lanes and Search first. At real Graph density (a large canvas + inspector), that intermediate scroll gets materially longer than in this mockup.
- **Collapse granularity is all-or-nothing per cluster.** Within Memory, Graph and Search share one `<details>` — if Graph's real canvas is tall, you cannot collapse just Graph while leaving Search open; you either see all four Memory panels or none.
- The one place this option *does* model real density better than the other two: the persona table includes an inline "why the agent proposed this" expansion row (`persona-draft-panel`, lines 796–807) with Approve/Discard actions embedded directly in the table flow — a real interactive feature neither other mockup shows. So its realism gaps are concentrated in Graph/Search, not uniformly worse.

---

## Option 2: sidebar-glanceable

**File:** `options/sidebar-glanceable.html` · **Screenshot:** `options/sidebar-glanceable.png`

**Structure:** Fixed 240px sidebar (`nav#panel-nav`, lines 73–78) listing all 8 panels with live status badges; only one `.panel.active` is displayed at a time (`display:none` / `.active{display:block}`, lines 159–167), toggled by a small inline script (lines 922–931). Visible panel is capped at `max-width: 1100px` (line 164).

**What works for scale:**
- **Single-active-panel isolation is the most direct answer to "Personas is ~50% of the UI."** Whichever panel is huge, it is the *only* thing in `main` — no sibling panel competes for width or vertical scroll budget. This scales by construction: the cost of switching to Personas is independent of how large Personas actually is.
- It gives the two dense panels the most horizontal room of the three options: 1100px vs. ~900–920px in the other two. That matters concretely — fewer forced wraps in the 7-control graph toolbar, fewer columns pushed into horizontal scroll in a real persona/search table.
- The sidebar's own cost is flat and decoupled from content size: 8 fixed nav rows with badges, independent of how many rows Personas or Search end up rendering. Nav complexity doesn't scale with content complexity here, which is exactly the property you want once one panel becomes disproportionately large.
- This is also the only option whose mock data was clearly built assuming real density: the Search table already has all 9 real columns (Layer/Collection, Match, Score, File, Chunk span, Embedder, Retrieved at, Snippet, Provenance — lines 590–592) inside an `overflow-x:auto` wrapper (`.table-scroll`), and Personas already models 3 status states (live/needs-review/draft, lines 401–412) plus a longer, more varied tier×repo persona list (7 rows across 4 tiers) than the other two mockups. Graph is a real rendered `<svg>` with actual node/edge geometry (lines 641–650), not a placeholder.

**What's a real risk at scale:**
- Because panels are `display:none` rather than absent, all 8 panels' full markup — including a real, much bigger Personas table — is in the DOM simultaneously even though only one is visible. That's not a *layout* problem (the lens here), but it means the isolation is visual/viewport-only, not a payload/DOM-size win; worth flagging so the "scale" story isn't oversold.
- Losing the ability to see two panels side by side (e.g., cross-referencing Search results against Graph) is a real tradeoff of full isolation — not scored against this lens directly, but it's the cost of the mechanism that makes this option win here.

---

## Option 3: minimal-jump-chips

**File:** `options/minimal-jump-chips.html` · **Screenshot:** `options/minimal-jump-chips.png`

**Structure:** All 8 panels rendered in document order, all always visible, no collapse/hide mechanism anywhere (confirmed by the file's own header comment, lines 1–8, and by there being **zero `<script>` tag in the entire file**). A sticky "jump chip" bar (lines 496–505) provides anchor links; `main` is a CSS grid capped at `max-width: 920px` (lines 130–141), but nearly every panel carries `.panel-wide` (Lanes, Search, Graph, Operations, Personas, Memory Levels), so the 2-column grid is in practice decorative — only Liveliness and Settings actually sit side by side. This is effectively a single long column.

**What works for scale:**
- It's the most structurally robust of the three precisely because it has no collapse/toggle state to get wrong: whatever size Personas or Graph become, they simply occupy their natural vertical space and native browser anchor-scroll jumps straight to the target section — no need to scroll past intervening panels to reach it.
- Like sidebar-glanceable, its mock data is built at closer-to-real density: real inline `<svg>` graph (lines 644–660), and the richest Personas dataset of the three — 8 rows spanning **4** status states (Live, Needs review, and uniquely here also **History** with a "View" action for a superseded draft, lines 819–834), which is a real facet of the persona lifecycle neither other option demonstrates.

**What breaks or is undertested at real scale:**
- **No mechanism exists to reduce the page once Personas/Graph balloon to real size.** This is the direct failure mode the lens is testing for: if Personas really becomes ~50% of the UI, the page becomes correspondingly ~2x longer with no way to declutter — every other panel's full weight is still sitting above and below it, permanently, for every visit. Collapsible-clusters and sidebar-glanceable both give the user a way to shrink or hide the other 7 panels; this option gives none.
- **The chip bar has no current-section / active-state indication** — confirmed by the absence of any `<script>` in the file, so there is no way to add a `.active` class on scroll. Once a user is scrolled deep inside a large real Personas panel, the sticky chip bar still shows all 8 chips with equal, undifferentiated weight — no wayfinding cue for "you are here," unlike sidebar-glanceable's `.nav-item.active` highlighting. At real scale (a much longer Personas section to scroll through), this gap gets worse, not better.
- The sticky chip bar's `top: 61px` is a hardcoded pixel offset assuming a fixed header height (line 86) — a minor fragility, not scored heavily here since it's a responsiveness issue more than a scale-of-content issue, but it compounds the wayfinding gap above if the header ever wraps to two lines.

---

## Ranking (scale realism only)

1. **sidebar-glanceable** — strongest
2. **collapsible-clusters** — middle
3. **minimal-jump-chips** — weakest

### Reasoning

- **sidebar-glanceable wins** because single-active-panel isolation is a structural property, not a workaround: the cost of viewing any one panel is independent of how large the other 7 (or that panel itself) become. It also gives the two dense panels the most width (1100px vs ~900–920px) and is the option whose mock data was most clearly built assuming real density (9-column Search table with proper overflow handling, 3-state persona statuses, a real rendered graph SVG). Nothing about the pattern degrades as Personas or Graph grow — it degrades gracefully by design.

- **collapsible-clusters lands second** because it has a genuine, native collapse mechanism that directly addresses "Personas could be half the UI" — a user can shrink System and Memory to almost nothing and let Personas dominate. But two things pull it down: (a) its Graph panel was never actually mocked with real content — it's a bare text placeholder, the single clearest piece of evidence in this review that a panel's real density wasn't stress-tested — and (b) its nav is cluster-granular, not panel-granular, so within a cluster (e.g., Memory, holding Lanes/Search/Graph/Memory Levels) there's no way to jump straight past a bulky sibling to reach Graph once it's real-sized.

- **minimal-jump-chips ranks last for this lens specifically** — not because its content modeling is weak (it's arguably the *most* realistic of the three on persona status variety), but because its structural answer to scale is "let the page get longer and rely on anchor scroll," with zero mechanism to hide or shrink anything and zero active-section wayfinding once you're deep inside a large panel. That is precisely the pattern most exposed by dropping in a Personas panel at real size: the page would become dramatically longer with no relief valve anywhere in the design.

## Strongest option(s) through this lens alone

**sidebar-glanceable** is the clear strongest. It is the only one of the three where the layout's per-panel cost is structurally decoupled from that panel's content size — the mechanism that makes "Personas is 50% of the UI" a non-issue is built into the pattern itself (isolate to one active panel, fixed-cost nav), not something the user has to manually invoke (as with collapsible-clusters' collapse-the-other-clusters workaround) or something the design has no answer for at all (as with minimal-jump-chips). It's reinforced by being the option whose own mockup data was most obviously built to actual real-world density rather than a thinned-down stand-in.

If a native, no-JS-toggle constraint rules out sidebar-glanceable, **collapsible-clusters** is the fallback — but only after fixing its most exposed gap for this lens: the Graph panel needs to actually be mocked with real rendered content (not a placeholder string) before its layout claims can be trusted, and cluster-level nav should be extended to panel-level anchors so a real-sized Graph or Search doesn't bury Personas' sibling panels behind an unnavigable scroll.
