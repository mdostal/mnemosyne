# Build Feasibility Review — Mnemosyne UI Redesign Options

**Lens:** Build feasibility only. Hard constraint under review: zero build step, zero UI
framework, plain vanilla HTML/CSS/JS served byte-for-byte by a static file server — no
bundler, no transpile, no client-side router library. Every claim below is anchored to
what's actually in the HTML source, not the screenshot alone.

All three mockups pass the top-level test: none of them import a framework, reference a
CDN script, use JSX/template-directive syntax, or assume a module bundler. Each is a
single self-contained file with inline `<style>` and (at most) one inline `<script>`. That
part of the constraint is respected uniformly. The differences that matter are in *how much*
each option leans on JavaScript to make its core structural idea work at all, and in a
couple of concrete markup landmines that would bite whoever wires the real `app.js` in.

---

## collapsible-clusters.html

**What it actually does, structurally:** the three cluster groups are native
`<details>`/`<summary>` elements (`<details id="cluster-system" class="cluster" open>`,
etc.), and the sticky "Jump to" bar (`#cluster-nav`) is three plain `<a href="#cluster-…">`
anchors. Scanning the full 877-line file, **there is no `<script>` tag anywhere in it.**
The collapse/expand affordance, the chevron rotation (`.cluster[open] > summary::before {
transform: rotate(90deg); }`), the sticky nav, and the jump-to-section scrolling are all
achieved with zero JavaScript — pure HTML5 semantics (`<details>`) plus CSS. The
`#personas-glossary` sub-disclosure is the same pattern nested one level deeper.

This is the strongest possible build-feasibility story for a no-JS-framework, no-bundler
constraint: the structural pattern *works in the browser with the file served exactly as
written*, before a single line of `app.js` is added for data fetching. It also degrades
well — if `app.js` fails to load later, clusters are still open/closed via native browser
behavior and jump-nav still scrolls.

Interactive elements that will need real wiring later (Refresh, Reindex…, Add lane, Search,
Save draft, graph toolbar buttons) are consistently declared `type="button"`, so in the
absence of JS they are inert rather than triggering any default browser action. That's the
safe default for a mockup destined to have `app.js` bolted on afterward.

One structural caveat worth flagging for whoever implements this: `#cluster-nav` only links
to the three cluster-level `id`s, not to the 8 individual panel `id`s nested inside. If a
future revision wants deep-links to a specific panel (e.g. `#search`) while its parent
`<details>` is currently closed, plain anchor navigation will scroll to a hidden element
without opening it — `<details>` does not auto-open on browser default anchor-scroll in all
engines. That's a solvable follow-up (a few lines of JS on `hashchange`), not a violation of
the constraint, but it's not free the way the current three-way top-level jump nav is.

## sidebar-glanceable.html

**What it actually does, structurally:** a persistent left `<nav id="panel-nav">` of eight
plain `<button class="nav-item" data-target="…">` elements, each holding a `<span
class="status-badge">`. All eight `<section class="panel">` elements exist in the DOM at
once; CSS hides all but `.panel.active` (`display: none` / `.panel.active { display: block
}`). At the bottom of the file there is a real, working inline `<script>`:

```js
document.querySelectorAll('.nav-item').forEach(function (btn) {
  btn.addEventListener('click', function () {
    document.querySelectorAll('.nav-item').forEach(function (b) { b.classList.remove('active'); });
    document.querySelectorAll('.panel').forEach(function (p) { p.classList.remove('active'); });
    btn.classList.add('active');
    document.getElementById(btn.dataset.target).classList.add('active');
  });
});
```

This is exactly the kind of thing the constraint allows: plain `querySelectorAll` /
`addEventListener` / `classList`, ES5-safe, no imports, no build step, executes immediately
since it's inline in the same file. It is *not* a client-side router — no `history.pushState`,
no `location.hash` sync — so it doesn't quietly assume routing infrastructure the repo
doesn't have. Nothing here requires anything beyond what a static file server + browser
already provides.

The one real trade-off (still a build-feasibility observation, not a UX one): unlike the
other two options, this option's basic navigability is *load-bearing on that inline script
executing correctly*. If it were ever split out to an external `app.js` that fails to load,
404s, or throws before that `forEach` runs, only the first panel (`Liveliness`, the one with
`class="panel active"` baked into the HTML) is reachable — the other seven become
permanently invisible with no scroll-based fallback, because they're `display: none` rather
than merely off-screen. Collapsible-clusters and minimal-jump-chips both degrade to "still
fully visible, just not tidily organized" if JS never runs; this option degrades to
"7 of 8 panels vanish." Worth flagging as the structural single point of failure of this
design, even though the JS itself is trivial and entirely within the vanilla-JS constraint.

Also worth noting: this mockup's own placeholder content (the persona draft's "Section
body" textarea) states the intended real-world architecture almost verbatim — "The
standalone operator shell lives entirely under `ui/` — no build step, no framework, one flat
`app.js` driving fetch calls against this same server's own routes plus the persona service
on `:3141`" — which matches the constraint under review and is a reasonable sanity check
that whoever built this mockup had the right mental model.

## minimal-jump-chips.html

**What it actually does, structurally:** no collapse mechanism at all — every one of the
eight `<section class="panel">` elements is always visible, in document order. The only
navigation aid is `nav#jump-chips`, a row of plain `<a href="#id">` anchors. Like
collapsible-clusters, **there is no `<script>` tag anywhere in this file** — the entire
structural pattern is achieved with CSS (sticky positioning, `scroll-margin-top` for anchor
offset) and native anchor scrolling. This is the most conservative of the three and, on the
structural navigation question alone, just as build-feasible as collapsible-clusters: zero
JS dependency for the core pattern to work.

Two concrete issues specific to this file, though, both found by reading the raw markup
rather than the screenshot:

1. **The file has no `<!doctype html>`, `<html>`, `<head>`, or `<body>` wrapper.** It opens
   directly with an HTML comment, then `<meta charset="utf-8" />`, `<title>…</title>`, and
   `<style>…</style>`, and closes at `</footer>` with no closing `</body></html>`. Browsers
   will still render it correctly because the HTML5 parsing algorithm infers the missing
   structural elements — this isn't a build-step requirement, just permissive parsing — but
   as an artifact meant to represent a real shipped file from a static file server, it reads
   as an unfinished fragment rather than a complete document. Easy to fix, but as-is it is
   not literally what should ship; it needs a document skeleton wrapped around it, unlike
   the other two files which are complete, valid documents end to end.

2. **Several primary actions use `<button type="submit">` inside a bare `<form>` with no
   `action` attribute** — "Add lane" (line 559), "Search" (line 580), and "Save draft"
   (line 878) — while every other option in this review, and every *other* button in this
   same file (Reindex…, Refresh config cache, graph toolbar, zoom controls), consistently
   uses `type="button"`. A bare `<form>` with no `action` submits via GET to the current
   URL on click. Concretely: if `app.js`'s submit-handler is ever missing, late to attach,
   or throws before `preventDefault()` runs, clicking "Add lane" / "Search" / "Save draft"
   triggers a full page reload of the mockup against itself, silently discarding whatever
   the operator had typed into that multi-field persona draft form. That's a real landmine
   for whoever wires this up, and it's inconsistent within the same file — the author
   clearly knows the safe pattern (`type="button"`) since it's used everywhere else in this
   very document, just not on these three controls.

Neither issue disqualifies the option under the actual build constraint (no framework, no
bundler is assumed anywhere), but both are concrete "quietly wrong if shipped as literally
written" findings that the other two files don't share.

---

## Ranking (build feasibility only)

1. **collapsible-clusters** — strongest. Zero JS for the entire structural pattern (native
   `<details>`/`<summary>` + plain anchors), a complete and valid document, consistent
   `type="button"` on every not-yet-wired control, and it degrades gracefully if `app.js`
   never loads (everything stays visible and collapsible via native browser behavior).
2. **minimal-jump-chips** — nearly tied with #1 on the core question (also zero JS for its
   structural pattern), but loses ground on two concrete defects found in the source: a
   missing document skeleton (`<html>`/`<head>`/`<body>`) and three `type="submit"` buttons
   in bare, action-less `<form>`s that will reload-and-discard-state by default if the JS
   wiring is ever incomplete — a landmine none of the other two options have.
3. **sidebar-glanceable** — still fully buildable with zero tooling (the inline script is
   plain vanilla `querySelectorAll`/`addEventListener`/`classList`, not a router, not a
   framework), but it's the only option whose basic navigability is load-bearing on that
   script executing without error — a JS failure here doesn't just leave the UI unstyled or
   unwired, it makes 7 of 8 panels vanish (`display: none`), whereas the other two options
   fail safe (content stays visible/scrollable either way).

## Strongest through this lens alone

**collapsible-clusters** is the strongest, with **minimal-jump-chips** a close second on the
central question (both need zero JavaScript for their structural idea to function at all,
which is the cleanest possible fit for a zero-build, zero-framework static file server).
collapsible-clusters pulls ahead because it pairs that same zero-JS structural approach with
a clean, complete, standards-valid document and uniform `type="button"` safety on every
not-yet-wired control — it has no source-level landmines to fix before the real `app.js` gets
bolted on. minimal-jump-chips would need two concrete fixes (document skeleton, submit-button
types) to reach the same bar. sidebar-glanceable is fully within the constraint too — nothing
in it assumes a router or framework the repo doesn't have — but it is the only one of the
three where getting past "panel 1 only" depends on a script tag actually running, making it
the most JS-load-bearing (least fail-safe) of the three, purely as a structural-navigation
mechanism.
