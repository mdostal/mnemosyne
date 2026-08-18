# Finalist 3 — synthesis rationale

**File:** `synthesized/finalist-3.html`
**Base:** `minimal-jump-chips` (structure, order, and idioms preserved almost unchanged)
**Nature of the change:** refinement, not a hybrid of structural patterns — no JS single-active-panel switching (sidebar-glanceable) or cluster-bundling (collapsible-clusters) was imported. Five targeted, critique-cited fixes are layered on top of the minimal-jump-chips base.

## Why minimal-jump-chips as the base

Tallying the seven lens critiques by which option each ranked **first**:

| Option | #1 rankings | Lenses |
|---|---|---|
| minimal-jump-chips | 3 | glanceable-monitoring, accessibility, consistency-with-existing-conventions |
| collapsible-clusters | 2 | visual-identity-cohesion, build-feasibility |
| sidebar-glanceable | 2 | navigation-wayfinding, scale-realism |

minimal-jump-chips is the only option that wins outright on the three lenses most directly about whether the redesign is *sound* rather than merely *fast to navigate*: it never hides real content, it's the most accessible, and it's the most faithful to the app's own existing conventions. Specifically:

- **glanceable-monitoring**: "minimal-jump-chips.html: No collapsing, no active-panel JS anywhere (verified: no `display:none` panel rule, no script tag at all) — all 8 panels' full real content render simultaneously, always. ... Nothing is ever gated behind a click; the only cost is scroll distance." Ranked it **strongest** of the three, ahead of collapsible-clusters and sidebar-glanceable.
- **accessibility**: "minimal-jump-chips.html — No JavaScript at all; every panel stays in one flat document so DOM order, tab order, and visual order always match. ... the only option with fully correct label/`<form>` hygiene everywhere." Ranked it **first**, ahead of collapsible-clusters ("a close second ... let down by unlabeled forms") and sidebar-glanceable ("last ... its core interaction model ... means screen-reader users can't tell which sidebar item is active").
- **consistency-with-existing-conventions**: "minimal-jump-chips: leaves every load-bearing convention untouched — same panel IDs, same `<h2>` (undemoted), same `.panel-status`, same flat always-visible document order, same lone `<details>` glossary. Its only addition (a jump-chip bar) is small, additive, and reversible." Ranked it **strongest**, versus sidebar-glanceable's container being "the biggest invention ... most likely to read as a different product ... than Mnemosyne."

It also placed **second** (not last) on two more lenses — navigation-wayfinding ("a close second ... it matches sidebar-glanceable on raw click-to-target precision") and visual-identity-cohesion ("most complete/systematic amber application"). Its only clear "weakest of three" placements are scale-realism and (on source-level defects, not pattern choice) build-feasibility — both addressed below rather than left as-is.

## The five fixes, each tied to a specific critique finding

**1. Document wrapper + button types (build-feasibility).**
The original file "has no `<!doctype>`/`<html>`/`<head>`/`<body>` wrapper — it's an unclosed fragment," and three buttons ("Add lane," "Search," "Save draft") "use `<button type="submit">` inside bare, action-less `<form>`s — a landmine where incomplete JS wiring causes a full page reload that silently discards form state, inconsistent with every other button in the same file which correctly uses `type="button"`." Finalist 3 adds the full document wrapper and changes all three buttons to `type="button"`, matching every other button already in the file.

**2. Per-chip status rings (navigation-wayfinding).**
"[minimal-jump-chips] doesn't shrink or isolate the page — it's fast travel over the same 'ungodly long list,' with no status-at-a-glance in the nav." Finalist 3 adds a thin pass/fail ring around each chip's existing dot, sourced only from that panel's own real status text (Liveliness/Settings/Lanes/Personas = pass, Memory Levels = fail because one store is genuinely degraded). The dot itself stays amber-filled, preserving the trait visual-identity-cohesion praised in this option ("most complete/systematic amber application ... always-lit chip dots").

**3. Optional scroll-spy (scale-realism + build-feasibility, together).**
Scale-realism noted the "sticky chip bar has no active/current-section indication, so once a real-sized Personas panel makes the page much longer, there's no relief valve and weak wayfinding once scrolled deep inside it." A small `IntersectionObserver` now highlights the current chip as you scroll. Per build-feasibility's warning about the *other* option — "sidebar-glanceable.html ... is the only option whose basic navigability is load-bearing on that script executing without error — since inactive panels are `display: none`, a JS failure hides 7 of 8 panels entirely" — this addition is deliberately non-load-bearing: every chip is still a plain working `#anchor` and every panel stays visible with the script absent, so finalist 3 does not inherit that risk.

**4. Persona draft-tools `<details>` (scale-realism, addressed without collapsible-clusters' mistake).**
Scale-realism's core complaint about minimal-jump-chips was "most conservative — all panels always visible, no collapse mechanism anywhere ... no relief valve." The fix reuses the one collapse idiom that's actually native to the app — the same `<details>` element already used for `#personas-glossary`, which accessibility-lens called "the most robust HTML-native pattern available." A second `<details id="persona-tools">` now wraps the write-oriented draft form plus the read-only Retrieval Layer Stack / Level 0 pointer — the least frequently needed, bulkiest part of the single densest panel. Critically, this collapses *only* Personas' own tail content. It deliberately does **not** copy collapsible-clusters' mistake, per glanceable-monitoring: "the 'System' cluster bundles Liveliness + Settings + Operations behind a single collapse toggle — exactly the three panels flagged as needing to stay visible ... collapsing hides all three with zero passive fallback." Those three panels are never touched here. Nor does it copy collapsible-clusters' nav-wayfinding failure mode ("all three `<details>` clusters ship `open` by default, so there's no length reduction out of the box ... the collapse affordance ... isn't actually being used to solve the stated complaint as shipped") — the affordance in finalist 3 targets exactly the panel scale-realism identified as oversized, not an arbitrary grouping.

**5. Graph node + Memory Levels color fixes (visual-identity-cohesion).**
Two distinct color-semantics bugs were flagged and fixed:
- "All three files also reuse `--fail` (red) and `--pass` (green) for unrelated graph node interaction states (selected/focus) in their inline SVG graphs (sidebar-glanceable and minimal-jump-chips only ...)." Finalist 3 introduces dedicated `--node-selected` / `--node-focus` tokens so the graph's selection/focus states no longer borrow the same reds/greens that mean "failing"/"passing" everywhere else in the UI.
- "[minimal-jump-chips] is the only option that stretches amber into health-status meaning — the Memory Levels table uses the same amber 'needs-review' pill class to label a store as 'Degraded,' directly under three green 'Active' rows ... it borrows a job `--fail` (red) should be doing." Finalist 3 adds a distinct `.status-pill.degraded` (red, `--fail`) separate from `.status-pill.needs-review` (amber), so a genuine store failure is never rendered in the same color as a pending human-review draft. This also lets the new Memory Levels nav chip legitimately carry a fail-ring (fix #2) without reintroducing the exact defect visual-identity-cohesion found in sidebar-glanceable — "a permanent red `fail` badge on the Personas nav item for '2 drafts need review' (not an actual failure)." The Personas chip in finalist 3 stays pass/green precisely because pending drafts are a workflow count, not a failure; only Memory Levels, which has a real degraded store, gets the red ring.

## What was deliberately *not* imported

- **sidebar-glanceable's single-active-panel JS pattern** — rejected on accessibility ("no `role="tab"`/`aria-selected` ... focus-order detour"), consistency ("no precedent" for hide/show panel switching or pill badges in the live app, "most likely to read as a different product"), glanceable-monitoring (hides 7 of 8 panels at any moment), and build-feasibility (navigability load-bearing on JS).
- **collapsible-clusters' cluster-bundling** — rejected on navigation-wayfinding (only 3 nav targets for 8 panels, ships open by default so provides no actual reduction) and glanceable-monitoring (bundles the three panels that most need to stay passively visible under one toggle). Its one strongest trait — genuinely disciplined color use, e.g. "keeps per-row status as plain uncolored text" and the amber/red Approve-Discard pairing being "the best-judged use of the three colors together in the whole set" — was judged not worth restructuring the whole table/pill system to import, given the two concrete color bugs it actually has (fix #5) were cheaper and more targeted to resolve directly.

## Verification

Rendered `file:///tmp/mnemosyne-worktrees/ui-redesign-review/.pHive/design/mnemosyne-ui-redesign/synthesized/finalist-3.html` in the Playwright browser — all 8 panels render with full realistic density (9-column Search table, real inline SVG impact graph, dense Personas identity table + open draft-tools disclosure), jump chips show status rings, and a full-page screenshot was saved to `synthesized/finalist-3.png`.
