# Build Feasibility — Round 2 Critique

**Lens:** Could this file ship as-is into a zero-build, vanilla HTML/CSS/JS repo, served byte-for-byte? No framework, no bundler, no template pipeline assumed beyond "this file is the page." Findings below are based on direct reads of the current round-2 HTML sources (grep + full-section reads), not on round-1 notes or the round-2 candidate blurbs.

---

## Collapsible Clusters (hardened) — `collapsible-clusters-hardened.html`

**Structure:** Proper `<!doctype html><html><head>…<body>` wrapper (lines 1–3, `<body>` at 514). 3 `<details class="cluster">` elements (`cluster-system`, `cluster-memory`, `cluster-personas`), all balanced (4 open/4 close counting the nested `personas-glossary` details), all default `open`. Zero `<script>` tags in the entire file, zero `<form>` tags — every interactive-looking control (`Reindex…`, `Refresh config cache`, `Save draft`, etc.) is a bare `<button>` with no wrapping form, so there is no submit/navigation landmine to worry about at all. No id collisions (checked via `grep -oE 'id="[^"]+"' | sort | uniq -c`).

**Round-1 fix verification — "missing status signal on collapse":** Genuinely fixed. Each `<summary>` now carries a static `<span class="cluster-status-dot {pass|review}">` (lines 534, 611, 720) with color driven by plain CSS classes (`.cluster-status-dot.pass/.fail/.review`, lines 508–511) and a `title` attribute for a text-equivalent on hover. Because native `<details>` only hides the `<div class="cluster-body">`, never the `<summary>` itself, the dot stays visible and readable whether the cluster is open or collapsed — this is a real fix, not a cosmetic one, and it requires zero JS to work (the dot's color is baked into the served markup).

**Nav mechanism:** `#cluster-nav` (line 521) is plain `<a href="#cluster-system">` etc. — no JS. Because every `<details>` in this file ships `open` by default, the well-known "fragment link to inside a *closed* `<details>`" gotcha (older browsers not auto-expanding) never triggers; clicking a nav link always scrolls to already-visible content. `scroll-margin-top` is set on `.cluster` to clear the sticky nav. This is about as build-safe as a jump nav can be.

**New defect from this round's fixes:** None found. No `<script>` was added, so there's no way this round's changes introduced a JS regression. The one soft inconsistency I noticed — the Personas cluster's dot says `review` (line 720) while the panel's own `.panel-status` text directly under it says `pass` — "9 personas (2 pending review)" (line 725) — is a content/semantics quibble for another lens, not a build defect; both values are static, valid markup, nothing conflicts at the DOM/CSS level.

**Verdict:** Ships as-is. Simplest possible implementation surface (no JS, no forms) minimizes what can go wrong at build time.

---

## Sidebar Glanceable (hardened) — `sidebar-glanceable-hardened.html`

**Structure:** Proper doctype/html/head/body wrapper (body at line 459). One `<script>` block (lines 923–935) doing straightforward vanilla tab-switching: on click, clear `.active`/`aria-selected` from all `.nav-item`s and `.panel`s, then set them on the clicked button and its `data-target`. All 8 `data-target` values (`liveliness, settings, lanes, search, graph, operations, personas, memory-levels`) were checked against the 8 real `<section id="…">` ids in the file — full 1:1 match, so `document.getElementById(btn.dataset.target)` can never return `null` and throw. No id collisions.

**Round-1 fix verification — "real ARIA tab semantics":** Genuinely fixed and done correctly, not just labeled. `nav#panel-nav` has `role="tablist"` + `aria-orientation="vertical"` (line 467); each nav button has `role="tab"`, a stable `id="tab-*"`, `aria-controls` pointing at the matching panel id, and `aria-selected` that the script keeps in sync with the CSS `.active` class (lines 469–500, JS lines 924–933 update `aria-selected` alongside `classList`). Each `<section class="panel">` has `role="tabpanel"`, `aria-labelledby` pointing back at its tab, and `tabindex="0"` so it's keyboard-focusable. This is a real, internally consistent ARIA tab implementation, not decoration.

**Round-1 fix verification — "no-JS fallback" (the one this round explicitly asks to be checked):** It works, and I traced through why. Base CSS: `.panel { display: none; }` / `.panel.active { display: block; }` (lines 160/168). The very last line of `<body>` (line 938) is `<noscript><style>.panel { display: block !important; }</style></noscript>`. Per the HTML parsing spec, `<noscript>` content is only parsed as literal text (inert) when scripting *is* enabled; when scripting is disabled (the exact no-JS condition being tested) its contents are parsed as real markup, so that `<style>` becomes a genuine, active stylesheet. `!important` beats the non-important `display: none` on `.panel` regardless of source order or the `.active` class being absent, and I confirmed via `grep -n "!important"` that this is the *only* `!important` declaration in the file, so there's no competing rule that could re-hide a panel. Net effect: with JS disabled, all 8 `<section class="panel">` elements become `display: block` simultaneously and the user can simply scroll through all of them. This is a correct, working fallback — not just a fallback that looks right on paper.

Minor (non-blocking) rough edge: the 8 sidebar `<button role="tab">` elements have no `href` and no server-rendered anchor behavior, so under no-JS they render as inert, non-functional buttons sitting above a page of fully-visible content. They don't break anything, but they're dead UI rather than graceful degradation — worth a one-line polish note, not a build blocker.

**Round-1 fix verification — "fixed review/fail badge color":** Confirmed fixed. `.status-badge.review { color: var(--accent) }` (amber/gold) is now visually and semantically distinct from `.status-badge.fail { color: var(--fail) }` (red) — see the CSS block (lines 146–149) and live usage at line 495 (`status-badge review`, "review" text) vs. none currently rendered as fail in the nav, but the class itself is properly isolated from `.fail` in both color and DOM. No `--fail` reuse for a non-failure state.

**Forms:** 3 `<form>` blocks (lines 554, 574, 820), all buttons inside them are explicitly `type="button"` (verified all 3 closing tags) — no submit-landmine risk.

**New defect from this round's fixes:** None found. The added ARIA attributes are inert from a JS-crash perspective (pure attributes, not selectors the script depends on), and the noscript block is appended after the closing `</script>`, so it can't interfere with the tab-switch script's execution when JS *is* enabled.

**Verdict:** Ships as-is. The heaviest JS footprint of the four (still trivial, ~12 lines), but its one behavior (tab switching) is now correctly backed by both real ARIA and a verified working no-JS fallback.

---

## Minimal Jump Chips (unchanged base) — `minimal-jump-chips-unchanged.html`

This is the file round 2's task brief describes as needing "no fixes — already the cleanest of the original 3." That characterization does not survive a direct read of the current source.

**Missing document wrapper — confirmed real defect.** `grep -n "^<html\|<head>\|<body>\|<!doctype"` returns **zero matches** in this file. It is the only one of the four candidates with no `<!doctype html>`, no `<html>`, no `<head>`, no `<body>` tags anywhere. The file opens directly with an HTML comment followed by `<meta charset="utf-8" />` and a bare `<title>`. In a repo whose whole model is "plain vanilla HTML served byte-for-byte," this is a real ship-blocker, not a cosmetic gap: this file is a markup *fragment*, not a page. Browsers will silently error-correct it (auto-insert `html`/`head`/`body` via HTML5 parsing rules) so it will often *look* fine in a quick eyeball check, which is presumably how this got waved through as "no fixes needed" — but it is invalid to serve as a standalone document, will fail any HTML validation/linting gate, and its actual in-DOM structure (where `<head>` ends and `<body>` begins) is undefined by the file itself and left to parser error-recovery heuristics that differ in edge cases across browsers/parsers.

**`type="submit"` inside action-less forms — confirmed real defect.** Two of the three `<form>` blocks use a bare, unqualified `<button>` (default `type="submit"`) with no `action`/`method`/`onsubmit` on the form and, critically, **zero `<script>` tags anywhere in this file** to intercept the event: `<button type="submit">Add lane</button>` (line 559) and `<button type="submit">Search</button>` (line 580). Clicking either — or simply pressing Enter with focus in one of the form's text inputs — triggers a native form submission with no `action`, which per spec submits to the current document URL, causing a full page reload (or a `?`-suffixed reload) and silently discarding any in-progress input. The third form (`persona-form`, line 878, "Save draft") has the same landmine. This is exactly the class of bug that "no JS in the file" should make impossible to miss, since there's no script to accidentally suppress it — it's a pure-HTML defect sitting in plain sight.

Both of the above are independently confirmed by the hybrid candidate's own header comment (`hybrid-rings-original-graph-colors.html` lines 14–17), which explicitly cites fixing "minimal-jump-chips has no `<!doctype>/<html>/<head>/<body>` wrapper" and its "Add-lane/Search/Save-draft buttons use `<button type=submit>` inside bare, action-less forms" — i.e., a sibling candidate in this same round already treats these as real, named defects in this file, not as a clean baseline.

**What is genuinely fine:** No id collisions. `.panel` sections (9, balanced) are always `display:` normal (no hide/show state to break), so the "no JS at all" design is otherwise safe — there's no single-active-panel switch that could silently fail. Chip nav (`<a href="#id">`) mirrors the collapsible-clusters approach and works identically without JS.

**Verdict:** Does **not** ship as-is. Two real, independently-verifiable defects (invalid document structure; live submit-landmine in 3 forms) that a plain `grep` surfaces immediately. This was mischaracterized as needing no fixes; it should have gotten the same hardening pass the other two round-1 survivors got.

---

## Hybrid (finalist-3 rings + finalist-2 graph colors) — `hybrid-rings-original-graph-colors.html`

**Structure:** Proper doctype/html/head/body wrapper (body at line 590), confirmed. Its own header comment (lines 1–56) is unusually explicit about being minimal-jump-chips as a base plus five named, cited fixes — I independently verified all five against the live markup rather than trusting the comment:

1. **Document wrapper + button types** — confirmed present: full doctype/html/head/body, and every form button I found (`Add lane` line 663, `Search` line 684, `Save draft` line 990) is `type="button"`, with an inline comment at line 660 explicitly noting the form has no `action` so submit would reload. Both minimal-jump-chips defects above are absent here.
2. **Per-chip status rings** — `nav#jump-chips a.chip-pass .chip-dot` / `.chip-fail .chip-dot` (lines 186–187) apply a `box-shadow` ring, driven by static `chip-pass`/`chip-fail` classes already present on the anchor tags in markup (e.g. line 605, `<a href="#memory-levels" class="chip-fail">`). Pure CSS/static-class — no JS needed for the rings to render correctly.
3. **Optional scroll-spy** — the one `<script>` block (lines 1058–1087) is a defensively-written IIFE: it first checks `if (!('IntersectionObserver' in window)) return;` before touching the DOM, and I confirmed `document.querySelectorAll('main > .panel')` actually matches all 8 real panels (checked: all 8 `<section id="…" class="panel…">` elements are direct children of `<main>`, lines 608–1052) so the observer never silently attaches to zero elements. Because `.panel` has no `display: none` in this file's CSS (checked, only background/border/padding/scroll-margin, lines 203–209), every panel is visible regardless of whether this script runs, loads, or throws — this is genuine progressive enhancement, not a load-bearing dependency.
4. **Persona draft-tools disclosure** — one added `<details id="persona-tools" open>` (line 947) wrapping only the write-form + retrieval-stack sub-content, closed correctly at line 1023 (verified balanced: 2 real `<details>` opens at 840/947 match 2 real closes at 852/1023 — the file's `grep` count of 5 "`<details`" hits includes 3 that are inside HTML comments, a false positive I checked by hand). Liveliness/Settings/Operations are untouched, exactly as the comment claims.
5. **Graph node + Memory Levels color fixes** — `--node-selected: var(--fail)` / `--node-focus: var(--pass)` (lines 71–72) are dedicated tokens no longer aliased to health-status meaning at the point of use, and `.status-pill.degraded` (red, line 499) is now a distinct class from `.status-pill.needs-review` (amber, line 493) — confirmed both classes exist and are used correctly in the Memory Levels table (a `degraded` pill for the failing store, `needs-review`/`live` pills elsewhere).

**No id collisions**, checked via the same `uniq -c` sweep as the other three.

**New defect introduced by this round's changes:** None found. This is the newest file in the round (a synthesis, not a hardening pass on a flagged bug), so there's no "did the round-1 fix actually work" question to answer for it directly — but every fix its own comment claims to make, I independently verified against the live markup rather than taking the comment's word for it, and all five check out.

**Verdict:** Ships as-is, and is the most thoroughly self-audited of the four — its inline comments name specific prior critiques and the corresponding markup/CSS actually implements each claim.

---

## Ranking (build feasibility only)

1. **Collapsible Clusters (hardened)** — zero JS, zero forms, valid document, balanced tags, no id collisions, no submit landmines by construction (nothing to submit). The smallest possible surface area for something to break at build/serve time, and its round-1 status-signal fix is real and JS-independent.
2. **Hybrid (finalist-3 rings + finalist-2 graph colors)** — valid document, one small and defensively-guarded script that is true progressive enhancement (content works identically with it absent), and every one of its five claimed fixes verified true against the markup. Ranks just behind #1 only because it does carry a `<script>` (however safe) and is the largest/densest file of the four.
3. **Sidebar Glanceable (hardened)** — valid document, correct ARIA, and a no-JS fallback I traced end-to-end and confirmed actually forces all 8 panels visible via a legitimate `!important` override with no competing rule. Ranks third only because its core navigability (switching the visibly-active panel) is genuinely JS-load-bearing in the normal case — the no-JS story is a *fallback*, not the primary path, and it leaves 8 inert nav buttons on screen when JS is off. Real fixes, real work, but structurally the most JS-dependent of the four.
4. **Minimal Jump Chips (unchanged base)** — despite the round-2 brief's "no fixes needed" framing, direct inspection shows it is the only candidate missing a `<!doctype>/<html>/<head>/<body>` wrapper entirely, and it ships two `<button type="submit">` elements inside action-less, script-less `<form>` blocks that will reload the page and drop user input on click or Enter. Both defects are trivially reproducible and are independently corroborated by the hybrid candidate's own changelog comment. This candidate needs the same hardening pass collapsible-clusters and sidebar-glanceable already received before it can be considered ship-ready.
