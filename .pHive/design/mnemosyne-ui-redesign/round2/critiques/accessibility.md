# Accessibility — Round 2 Critique

**Lens:** Keyboard navigability, semantic correctness (native `<details>`/`<summary>`, real ARIA roles/states where used), and screen-reader friendliness. Findings below come from a direct read of the current round-2 HTML sources — markup, CSS selectors that carry meaning (color-only status, focus states), and full `<script>` blocks where present — not from round-1 notes or the candidate blurbs.

---

## Collapsible Clusters (hardened) — `collapsible-clusters-hardened.html`

**Structural mechanism:** Zero `<script>` tags in the entire file. All grouping is native `<details>`/`<summary>` (`cluster-system`, `cluster-memory`, `cluster-personas`, all default `open`, plus a nested `personas-glossary` details). This is the single most robust accessibility primitive available in HTML — keyboard toggling (Enter/Space) and expanded/collapsed state exposure to AT come from the browser for free, with no ARIA and no JS to get wrong. On raw mechanism, this is the strongest foundation of the four.

**Round-1 fix verification — "headings restored":** Confirmed real. Every one of the 8 panels has a genuine `<h2 class="panel-title">` (Liveliness, Settings, Operations, Lanes, Search, Graph, Memory Levels, Personas — lines 538, 549, 566, 615, 634, 670, 698, 724). A screen-reader user opening the Headings list (NVDA/JAWS "H" navigation) will find all 8 panel headings present and in order. This is a genuine fix, not cosmetic.

**Round-1 fix verification — "live status dot on each cluster summary":** Partially fixed, and weaker than it looks. Each `<summary>` has `<span class="cluster-status-dot {pass|review}" title="...">` (lines 534, 611, 720) — a colored dot whose only text equivalent is a `title` attribute ("All System panels passing", "2 persona drafts need review"). `title` on a plain, non-interactive `<span>` is a well-documented unreliable accessibility pattern: it is not read as part of normal document/browse-mode reading by any major screen reader, has no keyboard path to trigger (the span itself isn't focusable — only the parent `<summary>` is), and is invisible on touch. So for a **sighted** user, the collapse-time status signal genuinely works (color is visible whether the cluster is open or closed). For a **screen-reader** user, the status is not exposed at all when reading the summary normally — the same gap the round-1 fix was meant to close still exists for that population, just relocated from "no signal" to "signal that requires knowing to inspect a `title` attribute nobody will voice." A `visually-hidden` text node or `aria-label` on the dot would have closed this completely; `title` alone does not.

**New gap — cluster-level names are not headings.** The visible cluster labels ("System", "Memory", "Personas") live only as plain text inside `<summary>`, never wrapped in an `h1`–`h6`. A screen-reader user navigating by heading will jump straight from the document's `h1` to the first panel's `h2` ("Liveliness") and never encounter "System" as a heading at all — the one level of grouping information this whole structural direction exists to convey is invisible to heading-based navigation. (It's still reachable by Tab, since `<summary>` is a native focusable disclosure control announced with expanded/collapsed state — but that's a different navigation strategy than the one heading-outline users rely on.)

**New regression — broken label/input association on 8 fields, unique to this candidate.** Of 21 `<label>` elements in this file, only 3 use `for=`/`id` association; the rest that wrap radio buttons are fine via implicit association (5 of them), but **8 are genuinely broken** — visible label text that is programmatically disconnected from its control:
- "Add lane" block: Name, Collection, Ladder (lines 627–629)
- Persona draft form: Tier, Scope ID, Display name, Section heading, Section body, Repo, Attach files (lines 835, 838–844)

None of these `<input>`/`<select>`/`<textarea>` elements have an `id`, and the `<label>` is a sibling, not a wrapper — so a screen reader landing on any of these fields announces only "edit text, blank" with no field name at all. This is a real, citable defect and, notably, **not shared** by the other three candidates: `sidebar-glanceable-hardened` (16/21 `for=`), `minimal-jump-chips-unchanged` (18/23), and `hybrid-rings-original-graph-colors` (18/23) all correctly associate every non-radio label. This is the single biggest accessibility regression found in this round, and it sits in the file whose whole pitch is "hardened."

**Nav mechanism:** `#cluster-nav` (line 521) is 3 plain `<a href="#cluster-*">` anchors — real, keyboard-operable, no JS. But it only offers 3 jump targets (System/Memory/Personas) versus 8 in the other candidates' nav — a keyboard user wanting to jump straight to "Search" has to land on "Memory" and then tab/arrow through everything before it in that cluster. A wayfinding cost, not a correctness bug, but real friction for keyboard-only users specifically.

**Graph:** No live SVG — `#graph-view` is a static placeholder string (`[ node-link diagram — 640×480 viewBox ]`), so this candidate is the only one of the four with nothing to critique on graph-node color semantics. Not a design strength (it's simply not implemented), but worth noting for completeness.

**Verdict:** Best raw mechanism (native disclosure, zero JS), but the round-1 fix for its own named bug turns out to be sighted-only, and the "hardening" pass introduced a form-labeling regression not present in any of the other three files.

---

## Sidebar Glanceable (hardened) — `sidebar-glanceable-hardened.html`

**Round-1 fix verification — "real ARIA tab semantics," script traced end to end:** This is genuinely wired, not decorative. `nav#panel-nav` carries `role="tablist"` and `aria-orientation="vertical"` (line 467). Each of the 8 `<button class="nav-item" role="tab" id="tab-*" aria-controls="*" aria-selected="...">` has a stable id/controls pair that I checked 1:1 against the 8 real `<section role="tabpanel" aria-labelledby="tab-*">` ids — every reference resolves, no dangling `aria-controls`. The `<script>` block (lines 923–936) is 13 lines and does exactly what the markup promises on click:
```js
document.querySelectorAll('.nav-item').forEach(b => {
  b.classList.remove('active');
  b.setAttribute('aria-selected', 'false');
});
...
btn.classList.add('active');
btn.setAttribute('aria-selected', 'true');
document.getElementById(btn.dataset.target).classList.add('active');
```
`aria-selected` is flipped on *every* tab on every click (not just added to the new one, so there's never a moment with two tabs marked selected), and the corresponding `.panel.active` toggle is driven by the same handler, so visual state and AT state cannot drift apart. This is real, functioning tab semantics.

**Round-1 fix verification — "no-JS fallback":** Confirmed working, not just present. Base CSS hides all `.panel` (`display: none`) except `.active`; the file's *only* `!important` rule lives inside `<noscript><style>.panel { display: block !important; }</style></noscript>` (line 938), placed after the closing `</script>`. Per spec, `<noscript>` content is inert markup when scripting is enabled and live markup when it's disabled — exactly the condition being tested — so with JS off, all 8 panels become visible simultaneously and the page degrades to a flat, fully-readable document. I did not find a competing rule that could re-hide a panel.

**Round-1 fix verification — "fixed review/fail badge color":** Confirmed. `.status-badge.review { color: var(--accent) }` (amber) is fully separated from `.status-badge.fail { color: var(--fail) }` (red) in the CSS (lines 146–149) and in live use (Personas nav item, line 495, badge text literally reads "review"). Crucially, **every status badge carries its state as visible, literal text** ("pass"/"fail"/"review"/"loading") in addition to color and the `::before` dot — this is the strongest status-conveyance of all four candidates for screen-reader users specifically, since the word itself is read, not just implied by color or a `title` tooltip.

**Labels:** Clean. 16 of 21 `<label>`s use explicit `for=`/`id`; the remaining 5 are radio-button labels that correctly wrap their `<input>` (implicit association, fine). No broken label found anywhere in this file.

**Forms:** 3 `<form>` blocks, all buttons explicitly `type="button"` — no submit-landmine risk.

**Real gaps found:**
- Not a roving-tabindex tablist per the WAI-ARIA APG pattern — there's no `keydown` handler anywhere in the file (verified via grep for `keydown`/`Arrow*`/`keyCode` — zero matches), so arrow-key navigation between tabs doesn't work; a screen-reader/keyboard user must Tab through all 8 tab buttons individually rather than arrow between them. Each button is still independently focusable and operable via Enter/Space, so this is a best-practice deviation, not a keyboard trap.
- Graph node colors reuse `--fail`/`--pass` for "selected"/"focus" node states (`.graph-node.selected circle { fill: var(--fail); }`, `.graph-node.focus circle { stroke: var(--pass); }`, lines 370–371) — same issue found in minimal-jump-chips and hybrid (see below); a selected node renders in the same red used everywhere else in the app to mean "failing." Mitigated somewhat by a real non-color cue (selected nodes are also larger, `r="9"` vs default `r="6"`).
- Clicking a tab does not move focus into the newly shown panel (focus stays on the tab button); the panel has `tabindex="0"` so a following Tab press reaches it, but there's no automatic focus move or live-region announcement of the panel switch. Minor, common in real tab implementations, not a hard failure.

**Verdict:** The most rigorously-verified fix in this round — the ARIA wiring is real, the no-JS fallback genuinely works, and status is conveyed as literal readable text rather than color/tooltip alone. Costs are all minor and shared or mitigated.

---

## Minimal Jump Chips (unchanged base) — `minimal-jump-chips-unchanged.html`

This is described in the round-2 brief as needing "no fixes — already the cleanest of the original 3." On direct read, that does not hold for this lens specifically, for two independent reasons.

**Missing `<html lang>` — a real WCAG 3.1.1 (Language of Page) failure.** `grep -c "<html lang"` and `grep -c "^<!doctype"` both return 0 for this file — it is the *only* one of the four with no `<!doctype html>`, no `<html>`, no `<head>`, no `<body>` tag anywhere; the source goes straight from an HTML comment to `<title>` to `<style>`. Browsers will silently auto-construct an implied `<html>`/`<head>`/`<body>` via HTML5 parser error-recovery, so the page *renders* fine — but that auto-constructed `<html>` element carries no `lang` attribute, because one was never present in the source to carry forward. `document.documentElement.lang` is the empty string. Every screen reader uses that attribute to select the correct pronunciation/voice profile; with it absent, a user on a non-English system default voice will have all-English content read in the wrong language's phonetics. This is a Level A failure and it is unique to this candidate — the other three all declare `<html lang="en">` (verified by grep, 1 match each).

**Unguarded `type="submit"` inside action-less forms — a real keyboard-operability defect.** Three `<form>` elements (`Add lane` line 545, `Search` line 565, persona draft line 838) have no `action` attribute and a `<button type="submit">` as their only submit control, with **zero `<script>` tags anywhere in the file** to intercept the event. Pressing Enter with focus in *any* text input inside one of these forms — which is completely standard, expected keyboard behavior for anyone filling in a multi-field form — triggers a native form submission with no destination, i.e. a full-page reload that silently discards whatever was typed. This disproportionately affects keyboard-first users, who reach for Enter-to-advance/submit far more habitually than mouse users do, and it's not something a screen-reader user has any way to anticipate or avoid. (This matches what the build-feasibility critique in this same round independently found from a different angle — cross-confirmed, not a one-off read.)

**What is genuinely strong here, and should be credited:** the visible content itself is excellent for this lens. Every one of the 8 panels has a real `<h2>` (with the whole document as one continuous flow, so nothing is ever hidden behind a disclosure or a tab — the strongest possible baseline for "everything is one heading-jump away," no interaction required to reach any content). All non-radio labels are correctly `for=`/`id`-associated (18/23; remaining 5 are correctly-wrapped radio labels). Status is conveyed via literal, visible `<span class="status-pill live/needs-review/history">` text, not color alone. Two fields (`search-query`, `search-scope`) use a genuine `.sr-only` visually-hidden-label technique rather than relying on `placeholder` as a label substitute — the only candidate to do this.

**Verdict:** Best raw content/heading structure of the four, undermined by two real, independently-verifiable defects — one a hard WCAG Level A failure (no declared page language), one a live keyboard-triggered data-loss bug (unguarded submit). Both are things a "no fixes needed" pass should have caught.

---

## Hybrid (finalist-3 rings + finalist-2 graph colors) — `hybrid-rings-original-graph-colors.html`

**Base carried over correctly:** Proper `<!doctype html><html lang="en"><head>...<body>`, all 8 panels as real `<h2>` headings in one always-visible flat document (same strong baseline as minimal-jump-chips), all non-radio labels `for=`/`id`-associated (18/23, same clean ratio), and the two `.sr-only` visually-hidden labels for Search preserved. Critically, **both of minimal-jump-chips' real defects are actually fixed here**, not just claimed: `grep -c "<html lang"` returns 1, and every `<form>`'s button is explicitly `type="button"` (verified 0 occurrences of `type="submit"` in the whole file) — so the Enter-triggers-reload landmine is gone. This candidate is a genuine, verified hardening of minimal-jump-chips' real gaps, not a relabeling.

**New disclosure — `#persona-tools`:** One additional native `<details id="persona-tools" open>` wraps the write-oriented draft form + retrieval-stack/Level-0 read-only content under Personas, defaulted `open`. Same robust native mechanism as collapsible-clusters, applied narrowly (doesn't touch Liveliness/Settings/Operations), and defaulting open means no content is hidden in the shipped mockup. Its `<summary>` label ("Draft tools & retrieval stack") is, like collapsible-clusters, plain text rather than a heading — same heading-outline gap noted above, but scoped to one disclosure instead of three.

**New feature — per-chip status rings — real color-only-status defect, unique to this candidate.** `nav#jump-chips` links now carry `class="chip-pass"` / `class="chip-fail"` (e.g. line 604, Memory Levels), rendered as a colored `box-shadow` ring around the (otherwise purely decorative in the base file) `chip-dot` span (CSS lines 186–187). There is **no text alternative anywhere** — no `aria-label`, no `title`, no visually-hidden text, nothing — attached to the ring or the link communicating "this section's status is fail." A screen-reader user hears "Memory Levels, link" with zero indication that it's the one section with a problem; a sighted colorblind user gets the size of the ring (which doesn't change) as the only non-hue cue, and there isn't one. This is a real regression relative to both minimal-jump-chips (which has no status signal in its nav *at all*, so there's nothing to get wrong) and sidebar-glanceable (whose badges spell the status out as words). It's also weaker than collapsible-clusters' dot, which at least has a `title` attempting a text equivalent, however unreliably delivered.

**Graph node colors — the in-file comment claims a fix that the CSS does not deliver.** The header comment (lines 45–53) states this candidate uses "dedicated `--node-selected`/--node-focus` tokens for the graph... never reusing `--fail` for a non-failure." The actual token definitions:
```css
--node-selected: var(--fail);
--node-focus: var(--pass);
```
These are aliases, not new colors — a selected graph node still renders in the exact same red as every "fail" status elsewhere in the app, and the focused node in the exact same green as "pass." The rename gives the *appearance* of a fix (a reviewer skimming class names sees `--node-selected` instead of `--fail`) while the computed color a screen-reader-adjacent low-vision or colorblind user actually perceives is unchanged. This is the file's own self-description overstating what the code does — worth flagging explicitly given this round's instruction to verify fixes against real behavior rather than trust labels. (Same underlying color reuse is also present, unremarked, in sidebar-glanceable and minimal-jump-chips; hybrid is the only one of the three that explicitly claims to have fixed it and hasn't.)

**Progressive enhancement — scroll-spy:** `<script>` (lines 1057+) is correctly guarded (`if (!('IntersectionObserver' in window)) return;`), only adds a `.current` class to whichever nav chip corresponds to the in-view panel, and every chip remains a plain working `#anchor` link regardless of whether this script runs — genuinely non-load-bearing, unlike a tab-switcher. Minor miss: it never sets `aria-current` on the "current" chip, so the enhancement is sighted-only; low-impact since the underlying document order means a screen-reader user reading top-to-bottom reaches the "current" section in natural flow anyway.

**Verdict:** Real, verified fixes to both of minimal-jump-chips' hard defects (page language, submit landmine), on the same strong flat-document/heading baseline — but it adds one new color-only status defect (nav rings, no text equivalent) and one fix that's cosmetic rather than real (graph node color aliasing, contradicting its own comment).

---

## Ranking for this lens

1. **Sidebar Glanceable (hardened)** — the only candidate whose headline round-1 fix (ARIA tab semantics) was fully traced through both markup and script and holds up completely, plus a working no-JS fallback and the strongest status-conveyance in the set (literal text, not color/tooltip). Costs are minor (no roving tabindex, shared graph-color reuse) and don't rise to the level of the defects found elsewhere.
2. **Hybrid (rings + graph colors)** — inherits the strongest content baseline (flat document, full heading coverage, clean labels) and genuinely fixes minimal-jump-chips' two real defects (page language, submit landmine). Held out of first place by a new, unmitigated color-only status signal in the nav chips and a graph-color "fix" that's an alias, not a change — the file's own comment overstates what it did.
3. **Minimal Jump Chips (unchanged base)** — the best raw semantic content and heading structure of the four, but carries a hard WCAG Level A failure (no `<html lang>`, and no `<html>`/`<head>`/`<body>` at all) and a live keyboard-triggered submit/reload bug in three forms. These are real and were not addressed for this round, contrary to the "no fixes needed" framing.
4. **Collapsible Clusters (hardened)** — best raw mechanism (native `<details>`, zero JS, most resilient by construction) undercut by the round's largest single accessibility regression: 8 form fields with visually-present but programmatically disconnected labels, unique to this file. Its own named round-1 fix (status dot) also turns out to work for sighted users only (`title`-only text equivalent), and its cluster-level names never surface as headings — a bigger heading-outline gap than hybrid's single scoped instance of the same pattern.
