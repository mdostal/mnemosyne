# Finalist 1 — flat document + status-aware jump chips

**Base:** `minimal-jump-chips.html`, with targeted fixes and one borrowed pattern from `sidebar-glanceable` and `collapsible-clusters`, each pulled in only where a critique specifically demonstrated a gap in the base and the donor option's mechanism didn't carry its own worse defect along with it.

## Why this base

Across the seven lenses, `minimal-jump-chips` wins or ties for first on four, and is a close, not-worst second on the rest. That is a stronger record than either other option, both of which have one standout strength (sidebar-glanceable on navigation/scale, collapsible-clusters on visual-identity/build-feasibility) offset by a lens where they're flagged as actively worse than doing nothing:

- **accessibility** — *"minimal-jump-chips first... it has the most granular real anchor nav (8 jump chips vs. 3 in collapsible-clusters), and is the only option with fully correct label/`<form>` hygiene everywhere... sidebar-glanceable last (its active-panel architecture needed ARIA state and focus management it doesn't have)."*
- **glanceable-monitoring** — *"minimal-jump-chips.html: No collapsing, no active-panel JS anywhere... all 8 panels' full real content render simultaneously, always... the only cost is scroll distance."* This is the strongest position on the lens the whole review exists to protect: sidebar-glanceable hides 7 of 8 panels behind `display:none` at any moment, and collapsible-clusters' one cluster bundles exactly the three panels (Liveliness/Settings/Operations) "flagged as needing to stay visible" behind a single collapse toggle.
- **consistency-with-existing-conventions** — *"minimal-jump-chips: leaves every load-bearing convention untouched — same panel IDs, same `<h2>` (undemoted), same `.panel-status`, same flat always-visible document order, same lone `<details>` glossary. Its only addition (a jump-chip bar) is small, additive, and reversible."* sidebar-glanceable was flagged as *"most likely to read as a different product (a settings console) than Mnemosyne."*
- **build-feasibility** — *"essentially tied"* with collapsible-clusters for the zero-JS/zero-build ideal; sidebar-glanceable's core navigability is *"load-bearing on that script executing without error — since inactive panels are `display: none`, a JS failure hides 7 of 8 panels entirely."*

The two lenses where `minimal-jump-chips` lost outright — navigation and scale-realism — both lost to sidebar-glanceable specifically because of its status badges and single-active-panel width isolation, and both of those mechanisms carry defects flagged elsewhere (accessibility's missing ARIA state, glanceable-monitoring's 7-hidden-panels problem). So rather than swap architectures, this finalist imports *only the passive signal*, not the interaction model that produces it.

## What changed on top of the base, and why

### 1. Colored status dot on every jump chip (borrowed idea, not borrowed mechanism)
Navigation-wayfinding's own case for sidebar-glanceable was *"plus live status badges per nav item give pre-click glanceability,"* and glanceable-monitoring called that badge sidebar *"a real (if coarse) mitigation"* even while ranking the option last overall. Meanwhile minimal-jump-chips' own weakness on navigation was explicit: *"it doesn't shrink or isolate the page... with no status-at-a-glance in the nav."*

This finalist adds a small colored dot to each of the 8 jump chips (pass / fail / loading / review) reflecting that panel's real status, with a legend in the corner of the nav bar. Critically, the mechanism stays pure CSS class + always-rendered content — no JS, no `display:none`, no hidden panels — so it inherits none of sidebar-glanceable's accessibility or glanceable-monitoring defects. It's the coarse mitigation, without the interaction model that made it coarse *and* risky.

### 2. Personas gets `review` (amber), not `fail` (red)
Visual-identity-cohesion's sharpest finding was specific to this exact status: *"the persistent sidebar shows a permanent red `fail` badge on the Personas nav item for '2 drafts need review' (not an actual failure), while the same condition is shown as amber `needs-review` pills at the row level inside that same panel — red and amber both signaling the same non-error condition in different places."* The same critique separately praised collapsible-clusters' amber-for-review judgment as *"the best-judged use of the three colors together in the whole set."* This finalist's Personas chip and panel-status both use a new `.review` (amber) state, kept distinct from `.fail` (red), so "needs a decision" and "something is actually broken" never share a color.

### 3. Memory Levels' "Degraded" row is now red, not amber
Visual-identity-cohesion flagged the base file directly: *"it's the only option that stretches amber into health-status meaning — the Memory Levels table uses the same amber 'needs-review' pill class to label a store as 'Degraded,' directly under three green 'Active' rows... it borrows a job `--fail` (red) should be doing."* Fixed by giving `.status-pill.fail` its own red-tinted style and using it for the Degraded row, while `needs-review` stays reserved for Personas' actual pending-decision rows. The Memory Levels chip dot and new panel-status line ("1 store degraded") are red for the same reason.

### 4. Graph node interaction states no longer borrow `--pass`/`--fail`
Cross-cutting finding, explicitly named against this file: *"All three files also reuse `--fail` (red) and `--pass` (green) for unrelated graph node interaction states (selected/focus) in their inline SVG graphs (sidebar-glanceable and minimal-jump-chips only...)."* Selected node fill is now a distinct lighter-amber (`#f2c675`), and the focus ring uses `var(--text)` instead of `var(--pass)` — interaction state and health state are visually disjoint now.

### 5. Real `<!doctype>`/`<html>`/`<head>`/`<body>` wrapper
Build-feasibility, verbatim: *"the file has no `<!doctype>`/`<html>`/`<head>`/`<body>` wrapper — it's an unclosed fragment that only renders correctly because browsers infer the missing structure."* Fixed outright; no behavioral change, just a complete document.

### 6. `type="submit"` → `type="button"` on Add lane / Search / Save draft
Build-feasibility again, verbatim: *"three primary actions ('Add lane,' 'Search,' 'Save draft') use `<button type="submit">` inside bare, action-less `<form>`s — a landmine where incomplete JS wiring causes a full page reload that silently discards form state, inconsistent with every other button in the same file which correctly uses `type="button"`."* All three now match every other button in the file.

### 7. CSS-only `:target` landing highlight
Scale-realism's residual complaint about the base, after the above fixes still stands on its own terms: *"the sticky chip bar has no active/current-section indication, so once a real-sized Personas panel makes the page much longer, there's no relief valve and weak wayfinding once scrolled deep inside it."* Rather than adding JS scroll-spy (which would reopen the build-feasibility and accessibility concerns raised against sidebar-glanceable's script dependency), this finalist uses `.panel:target { border-color: var(--accent); box-shadow: ...; }` — the browser natively applies `:target` to whatever section's `id` matches the URL fragment after a chip click, giving a visible "you landed here" confirmation with zero script. It's a smaller, safer answer to the same gap than sidebar-glanceable's isolation model, consistent with build-feasibility's preference for *"no source-level defects to fix before shipping."*

### 8. Personas gets an inline Approve/Discard draft-review block
Not a fix to a flagged defect, but a direct import of visual-identity-cohesion's single most positive citation in the whole review: collapsible-clusters' *"one deliberate accent-vs-fail pairing (Approve=amber / Discard=red on the inline draft-review panel) is the best-judged use of the three colors together in the whole set."* Reproduced here under the first "needs review" row, which also happens to make Personas' real density closer to what scale-realism wants stress-tested (*"its layout claims for the densest panel were never actually stress-tested"* — said of collapsible-clusters' placeholder graph, but the general principle that dense real content should be shown, not summarized, applies equally here).

## What this finalist deliberately does not take

- **No single-active-panel switching.** Both accessibility (*"screen-reader users can't tell which sidebar item is active... keyboard users hit a focus-order detour"*) and glanceable-monitoring (*"7 of 8 panels are fully hidden at any moment"*) independently disqualify that mechanism regardless of its navigation-lens upside.
- **No cluster-level collapse.** Navigation-wayfinding's finding that collapsible-clusters' System cluster bundles exactly the three panels *"flagged as needing to stay visible"* behind one toggle, combined with glanceable-monitoring's *"collapsed `<summary>` rows carry no status glyph at all... zero passive fallback,"* rules out hiding any of the 8 panels behind a click at all, native `<details>` or not.
- **No 1100px single-panel width cap.** Scale-realism's point about sidebar-glanceable giving dense panels more room is real, but it's a side effect of isolating one panel at a time — not something to chase once every panel stays visible in a flat, two-column-collapsing-to-one document. This finalist instead widens the shared container from 920px to 1000px, a smaller, architecture-neutral nod to the same concern.

## Files
- Mockup: `/tmp/mnemosyne-worktrees/ui-redesign-review/.pHive/design/mnemosyne-ui-redesign/synthesized/finalist-1.html`
- Screenshot: `/tmp/mnemosyne-worktrees/ui-redesign-review/.pHive/design/mnemosyne-ui-redesign/synthesized/finalist-1.png`
