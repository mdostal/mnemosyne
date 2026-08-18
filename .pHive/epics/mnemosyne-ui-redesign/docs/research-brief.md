# Research Brief — Mnemosyne Standalone UI Redesign

**Goal:** ground a look-and-feel/UX redesign discussion for the standalone UI
(`ui/index.html`, `ui/app.js`, `ui/style.css`) in what the codebase actually
contains today — real structure, real design tokens, the visual-identity work
already shipped for this repo, and the one panel (Personas) that has already
been through a real redesign process this session. This is research only: no
implementation, no proposal, no recommendation of a direction. All three
target files were read in full and are cited by line number below; none of
them was modified to produce this brief.

---

## 1. The full current standalone UI structure

### Top-level panels, in document order

`ui/index.html`'s `<main>` (line 16) contains exactly **8 top-level
`<section class="panel...">` elements**, in this fixed order:

| # | `id` | Heading | Line | Class |
|---|---|---|---|---|
| 1 | `liveliness` | Liveliness | `index.html:17` | `panel` |
| 2 | `settings` | Settings | `index.html:23` | `panel` |
| 3 | `lanes` | Lanes | `index.html:29` | `panel panel-wide` |
| 4 | `search` | Search | `index.html:63` | `panel panel-wide` |
| 5 | `graph` | Graph | `index.html:106` | `panel panel-wide` |
| 6 | `operations` | Operations | `index.html:148` | `panel panel-wide` |
| 7 | `personas` | Personas | `index.html:196` | `panel panel-wide` |
| 8 | `memory-levels` | Memory Levels (0-4) | `index.html:456` | `panel panel-wide` |

Nested **inside** `#personas`, at `index.html:407`, is a ninth, non-top-level
`<section id="persona-layer-stack">` (no `panel` class — it is deliberately
*not* a top-level panel, per its own comment at `index.html:378-406`), headed
`<h3>Retrieval Layer Stack</h3>` (`index.html:408`). This is the "Personas
[with a nested Retrieval Layer Stack sub-section]" the task described —
confirmed accurate. The comment at `index.html:378-390` documents that this
sub-section was originally its own top-level panel (`pw-04`) and was
deliberately re-homed inside Personas by a later ticket (`pu-11`).

So: **8 real top-level panels + 1 nested sub-section = the "9" the task
named**, and the task's list (Liveliness, Settings, Lanes, Search, Graph,
Operations, Personas-with-nested-Retrieval-Layer-Stack, Memory Levels) is
accurate as-is. Nothing else exists at either level — no hidden panels, no
panels gated behind a flag.

### Navigation: confirmed, there is none beyond scrolling

`<header>` (`index.html:11-14`) contains only an `<h1>` and one `#refresh-btn`
button — no nav links, no anchor list, no sidebar, no tabs. `<main>`
(`style.css:56-67`) is a plain CSS grid:

```css
main {
  display: grid;
  grid-template-columns: 1fr;
  gap: 1rem;
  padding: 1.5rem;
  max-width: 900px;
  margin: 0 auto;
}

@media (min-width: 760px) {
  main { grid-template-columns: 1fr 1fr; }
}
```

`.panel-wide` (`style.css:120-122`, `grid-column: 1 / -1;`) forces a panel to
span both grid columns, which every panel except Liveliness and Settings
uses — so in practice the two-column grid only ever applies to the first two
panels; everything else is full-width and stacks vertically in document
order. There is no jump-to-section control, no collapsible top-level section,
and no in-page table of contents anywhere in `index.html` or `app.js`. The
only in-page navigation-adjacent behavior anywhere in the file is
Personas' `jumpToPersonaRow()` (`app.js:1428-1447`), which scrolls to and
focuses a specific **row within the Personas table**, not a section-level
jump. Confirmed: **navigation is scrolling, full stop.**

### `ui/app.js`'s organization

One file, 2,383 lines, zero third-party dependencies (`app.js:1-3`: *"Zero
third-party deps: vanilla fetch + DOM. Loads once on open, then only on
manual refresh — no auto-polling in v1"*). It is **not** split into per-file
modules; it is one flat script organized as a sequence of comment-delimited
blocks, each covering one panel, in roughly the same order as the HTML:

- `setStatus()` / `renderDetailLines()` / `field()` — shared helpers (`app.js:21-79`)
- Liveliness + Settings loaders (`app.js:48-106`)
- `--- Lanes panel (s-02)` (`app.js:108-177`)
- `--- Search panel (s-03)` (`app.js:179-322`)
- `--- Graph panel (s-04...)` (`app.js:324-1026`) — by far the largest single
  self-contained block (~700 lines): force-directed layout, connected-component
  packing, zoom/pan, node inspector
- `--- Operations panel (s-05)` (`app.js:1028-1155`)
- `--- Personas panel (pw-03-personas-panel-view)` through
  `end pf-04-client-cap-twin` (`app.js:1157-2357`) — the single largest block
  in the file, roughly **1,200 of 2,383 lines (about half the script)**,
  covering: cross-origin persona-service fetch (`personaServiceOrigin()`,
  `app.js:1173-1175`), the pu-10 grouped/filterable shell, the pu-12
  draft-review/approve/discard flow, the pw-04 layer-stack sub-section loader,
  the ml-05 Memory Levels loader, and a pf-04 client-side file-cap "twin" of a
  server-side truncation utility
- `refreshAll()` (`app.js:2359-2378`) — the single orchestration point; every
  panel's `load*()` function is called here via one `Promise.all(...)`, and
  it is the only place that decides load order/parallelism
- `refreshBtn` click handler + initial `refreshAll()` call on page load
  (`app.js:2380-2384`) — confirms the "load once, manual refresh only, no
  polling" model stated in the file's own header comment

**Existing componentization pattern worth preserving:** `setStatus(el, kind,
text)` (`app.js:21-24`) is genuinely reused everywhere — one function, called
roughly 70 times across every panel, that sets both text and a `pass` /
`fail` / `loading` CSS class. It is the one real shared UI primitive in the
file and is the strongest existing candidate for formalizing into a real
component in any redesign.

**A duplicated pattern that is *not* shared**, and is a concrete
simplification opportunity: five separate, near-identical single-`<td>`
cell-builder functions exist, each hand-written per panel instead of sharing
one utility — `laneCell()` (`app.js:111-115`), `searchCell()`
(`app.js:217-221`), `personaCell()` (`app.js:1177-1181`),
`personaLayerStackCell()` (`app.js:1219-1223`), and `memoryLevelsCell()`
(`app.js:1233-1237`). All five do the exact same three lines of work
(`document.createElement("td"); td.textContent = ...; return td;`), just
under different names.

### `ui/style.css`'s real design tokens

The entire token system is 8 CSS custom properties on `:root`
(`style.css:1-11`), quoted verbatim:

```css
:root {
  color-scheme: light dark;
  --bg: #0f1115;
  --panel-bg: #171a21;
  --border: #2a2f3a;
  --text: #e6e8ec;
  --muted: #9aa2b1;
  --pass: #4fd17a;
  --fail: #ff6b6b;
  --accent: #7aa2f7;
}
```

Notable: **`color-scheme: light dark;` is declared, but there is no
`prefers-color-scheme` media query or light-mode variable override anywhere
in the file** — every color below is a fixed dark value; the UI is
effectively dark-only in practice despite the `color-scheme` declaration.

Type scale is minimal and ad hoc, not a formal scale — the only explicit
font-size declarations are: `h1` `1.25rem` (`style.css:31`), `.subtitle`
`0.8rem` (`style.css:37`), `.panel h2` `1rem` (`style.css:78`), and a long
tail of one-off `0.75rem`–`0.95rem` values scattered per-component (e.g.
`#lanes-table th` `0.8rem` at `style.css:141`, `#search-table th` `0.75rem`
at `style.css:281`, `.panel-hint` `0.8rem` at `style.css:328`). There is no
`--font-size-*` or `--space-*` custom property anywhere — every spacing value
(`0.4rem`, `0.6rem`, `0.75rem`, `1.25rem`, etc.) is a hardcoded literal
repeated inline, not tokenized.

Only **one breakpoint** exists in the whole file: `@media (min-width:
760px) { main { grid-template-columns: 1fr 1fr; } }` (`style.css:65-67`).
There is no tablet/mobile-specific stylesheet section beyond this single
two-column/one-column switch.

Fonts: system UI stack for body text (`style.css:17`, `-apple-system,
BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif`) and
`ui-monospace, SFMono-Regular, Menlo, monospace` reused verbatim in at least
9 separate rules for tabular/code-like content (e.g. `.detail`
`style.css:92`, `.fields dd` `style.css:116`, `#lanes-table td:nth-child(1,2)`
`style.css:148`, `#reindex-paths` `style.css:529`) — a real, consistent
convention, just not expressed as a shared custom property.

Component-scoping convention: almost every rule block is scoped by element
`id` (`#lanes-table`, `#search-form`, `#graph-toolbar`, `#persona-form`,
etc.) rather than by reusable class — each panel effectively re-declares its
own button/input/table styling instead of sharing one `.btn`/`.input`/
`.data-table` class. The handful of genuinely shared classes are `.panel`,
`.panel-wide`, `.panel-status`, `.panel-hint`, `.panel-hint-inline`,
`.fields`, `.mode-toggle`, `.detail`, and `.sr-only` — 9 classes carrying
the entire cross-panel visual consistency of an otherwise per-ID stylesheet.

Personas-specific CSS alone is `style.css:560` through end-of-file (`915`) —
**356 of 914 lines, about 39% of the entire stylesheet** — reflecting how
much larger that panel's redesign made it relative to the other 7.

---

## 2. The just-shipped visual identity

Two critique documents in `.pHive/design/mnemosyne-icon-set/critiques/`
independently evaluated a 10-concept icon set against this repo's existing
amber-gold-on-dark visual language. Both were read in full.

### `dark-ui-context-fit.md` (lens: legibility on dark chrome at favicon/dock-icon scale)

Its framing (`dark-ui-context-fit.md:3`): *"does the mark read correctly and
feel native when it lives in a dark-chrome, amber-gold-accented product UI —
specifically as a browser favicon (16–32px, dark tab bar) and an OS
dock/install icon... All ten source files share the same amber-gold hue on a
transparent ground, so hue-vs-background contrast is a wash across the
set."* Its two structural findings (`dark-ui-context-fit.md:6-8`):

> "Solid, filled silhouettes hold their edge against dark chrome at any
> size... Thin or doubled outline strokes are the highest-risk construction
> on dark backgrounds at favicon scale."

Its top 3 through this lens (`dark-ui-context-fit.md:34-36`, `45-47`):
Infinity Recall Loop (#05), Owl Minimal (#07), and **Ancient Urn / Vessel
(#08)** — the concept that shipped as the real favicon (see below). On the
Urn specifically (`dark-ui-context-fit.md:26`): *"A single solid, chunky
silhouette with handles as the only articulated sub-shapes... No hairline
strokes, no small internal cutouts... one dependable mass of amber against
dark chrome, legible from favicon size straight up to a full dock icon.
Strong, low-risk fit."*

### `visual-language-cohesion.md` (lens: form/construction against a clean, modern, minimal system — color explicitly set aside)

Its framing (`visual-language-cohesion.md:3`): *"Color (the shared
amber-on-dark treatment) is explicitly set aside; every option uses it, so
it cannot differentiate anything here."* Under this stricter formal lens the
Urn ranks lower — #8 of 10 (`visual-language-cohesion.md:56-58` ranking; body
at `visual-language-cohesion.md:32-33`): *"Rendered as a single solid
silhouette with no surface ornamentation... But the underlying contour is
inherently complex: lip, neck taper, shoulder, belly curve, foot flare, and
two independent handle loops means many curve inflections packed into one
shape. It's a naturalistic object silhouette rather than a constructed
geometric glyph — closer to clip-art of a vase than an abstracted mark, even
though the execution itself is clean and single-technique."* The top pick
under this lens was Infinity Recall Loop, with the note
(`visual-language-cohesion.md:58`) that Owl Minimal is "a close third."

**Both critiques agree the amber-gold-on-dark hue itself is the fixed given**
— they differ only on which *silhouette* best serves that palette. Neither
critique proposes an alternative hue.

### The real favicon asset

`ui/favicon.png` is a 1024×1024 PNG (confirmed via `file`), a solid amber urn
silhouette on a **transparent** background (alpha 0 at the canvas corners —
sampled directly, not white as the browser preview might suggest). The fill
color, sampled from the silhouette's center pixel, is **RGB(216, 168, 78) /
`#D8A84E`** — this is the real, shipped "Ancient Urn" concept from the icon
set, matching `dark-ui-context-fit.md`'s #08/Ancient Urn description above.
`ui/favicon.ico` (`index.html:7`, the one actually linked from the page) is a
multi-resolution ICO (16×16 through 32×32 PNG-in-ICO) of the same mark.

**A concrete tension worth flagging for the discussion:** the shipped icon
identity is amber-gold (`#D8A84E`), but `ui/style.css`'s actual `--accent`
token — the color used for every button, link, and highlight in the running
UI (`#refresh-btn` `style.css:44`, `#add-lane-form button` `style.css:181`,
`#search-form button[type="submit"]` `style.css:248`, `.graph-node circle`
`style.css:414`, `#persona-form button` `style.css:831`, 14 uses total) — is
**`#7aa2f7`, a blue**, not amber. A grep of `ui/style.css` for the words
"amber" or "gold" returns zero hits. The running UI's chrome and the
just-shipped icon identity currently use two unrelated hues.

---

## 3. The Personas panel precedent

Two documents in `.pHive/design/mnemosyne-persona-ux/` were read in full:
`selection.md` (the decision record) and `synthesized/option-2.md` (the
option it selected, "Trust-Gated Unified Queue" — read in full since it's
what actually shipped and is now live in `index.html`/`app.js`/`style.css`).

### The process that produced it

This was a real multi-option design pass: 7 independent critique lenses
(accessibility, agent-provenance-trust, design-language-consistency,
hierarchy-legibility, information-density, onboarding-clarity,
operator-efficiency) were run against 3 original design options, which were
then synthesized into 3 further options, one of which was formally selected
with a written rationale (`selection.md`). This is the only panel in the UI
that has been through a process resembling what a whole-UI redesign
discussion would need to replicate or explicitly depart from.

### What it landed on, structurally

- **No tabs, no route change, no two-pane master-detail.** `selection.md:36-39`
  states this was actually **shared ground across all 3 synthesized options**,
  not a differentiator — every one of the 7 critique lenses that touched
  layout consistency rejected a tab-bar/inbox-style split as "the most
  visually foreign island outcome of the three" (`option-2.md:442`, citing
  `design-language-consistency.md`). `#personas` keeps the exact same
  `<section class="panel panel-wide"> → <h2> → panel-status → <table>` shape
  every other panel already uses (`option-2.md:29-30`).
- **One continuous list/table holds every persona identity, live and
  drafted**, grouped by a toolbar rather than split into separate views
  (`option-2.md:3-4`). Grouping and status-filtering reuse two *existing*
  idioms rather than inventing new widgets: the group-by control is the same
  `.mode-toggle`/`role="radiogroup"` pattern the Search panel's mode toggle
  already established (`index.html:75-78` vs. `index.html:249-253`), and the
  status filter is a plain `<select>`, the same idiom `#reindex-lane`
  (`index.html:170-173`) already used (`option-2.md:64-70`).
- **Row-level expansion via the existing `hidden`-attribute toggle idiom**
  that `#graph-inspector-detail` already used (`option-2.md:216-219`), not a
  new accordion widget — confirmed live in `app.js`'s
  `buildPersonaActionsAndDetail()` (`app.js:1865-1900`).
- **A structural (not `disabled`-attribute) read-before-edit gate**: a
  draft's Edit/Approve/Discard controls do not exist in the DOM at all until
  a non-editable "I've read this — enable editing" control has been clicked
  once per session for that identity (`option-2.md:227-277`; live in
  `app.js:1810-1849`). This was a deliberate, documented departure from one
  of the two rejected synthesized options specifically because a native
  `disabled` attribute "removes an element from the tab order entirely"
  (`option-2.md:269-277`, citing `accessibility.md`).
- **Approve/Discard are always full-sentence buttons**, never icon-only —
  `"Approve — write to persona store"` / `"Discard — archive without
  committing"` (`option-2.md:152-157`, `304-306`) — both symmetrically
  gated behind a native `window.confirm()` with specific, non-generic copy
  naming the exact identity being approved/discarded.
- **A `<details><summary>` glossary block** (`index.html:226-238`) is the
  first and only use of the native `<details>` element in this codebase —
  introduced deliberately as *new* vocabulary, with `selection.md`
  specifically noting an earlier rejected option had falsely claimed
  precedent for it (`option-2.md:139-143`).
- **A batched "reviewed, ready to commit" strip** with one `[Approve all]`
  button (`option-2.md:112-118`, `379-419`) — the mechanism chosen to recover
  batch-triage efficiency without reopening a rejected single-click
  unread-approve fast path.
- **An `aria-live="polite"` region** (`index.html:271`) announces
  approve/discard outcomes and filter self-heals in plain text
  (`option-2.md:335-343`) — new; no other panel in the UI has an
  `aria-live` region.
- **Explicit "extend, don't replace"**: `style.css:565-569`'s own comment
  states the Personas CSS "Extends the existing dark-only
  custom-property/table/monospace conventions this file already
  establishes... no new custom properties" — confirmed true; no new
  `--*` token was added to `:root` for Personas.

### Why this matters for a whole-UI redesign

`selection.md:106-152` frames the deciding factor between the two closest
options as **hierarchy-legibility at real multi-tier/multi-repo scale** —
i.e., the redesign's own stated test was not "does it look nice for a
3-persona demo" but "does it scale and orient correctly." That same framing
— real operator scale over demo-case polish — is likely to recur as a
relevant lens for a whole-UI redesign, since Personas is already the
largest, most complex panel in the file (see §1 and §5).

---

## 4. Existing conventions worth knowing

### No component framework, no build step — confirmed

`package.json` (read in full) lists `dependencies`: `@modelcontextprotocol/sdk`,
`better-sqlite3`, `tsx`, `yaml`, `zod`; `devDependencies`:
`@types/better-sqlite3`, `@types/node`, `ajv`, `ajv-formats`, `typescript`,
`vitest`. **None of these is a UI/component framework** (no React, Vue,
Svelte, htm, lit, Tailwind, PostCSS, esbuild, webpack, vite, or rollup
anywhere in either list). The `scripts` block's UI-relevant entries are
`"start": "node src/server.mjs"` and `"test:ui": "node test/ui-shell.mjs"` —
both plain `node`, no bundler invocation. `"build": "tsc --noEmit"` exists,
but it is a type-check-only pass over the TypeScript backend (`lib/`,
`benchmarks/`, etc.) — it does not touch `ui/` at all (`ui/app.js` is plain
`.js`, not `.ts`). **Confirmed: `ui/` is hand-written vanilla HTML/CSS/JS
with zero build step**, exactly as `app.js`'s own header comment claims
(`app.js:2`, "Zero third-party deps").

### No design-tokens file, no brand system

A search for `.pHive/brand/` and any `*design-token*` file anywhere in the
repo returned nothing. The 8 custom properties in `style.css:1-11` (§1,
above) are the entire token system, and they live only in that one file —
there is no separate tokens JSON/YAML, no Style Dictionary config, nothing a
redesign could point at as an existing source of truth beyond
`style.css:1-11` itself.

### `src/server.mjs` — single static-file server, no bundler

`src/server.mjs` (read in full) is a plain `node:http` server. Its own header
comment (`server.mjs:9`) states: `"GET /ui, /ui/* -> static standalone UI
shell (zero-dep, no build step)"`. The actual implementation,
`serveUiAsset()` (`server.mjs:105-123`), does nothing more than resolve a
requested path inside `UI_DIR` (path-traversal-checked) and `readFile()` it
directly off disk, keyed to a small `STATIC_CONTENT_TYPES` map covering only
`.html`, `.css`, `.js`, `.json`, `.svg`, `.ico`, `.png`
(`server.mjs:92-100`). **Confirmed: any redesign has to ship as files this
map already understands, served byte-for-byte as written** — no transpile
step, no minification, no bundling, no import-map resolution beyond what a
browser does natively.

One real architectural constraint surfaced while reading this file plus
`app.js`: the Personas panel's data does **not** come from `server.mjs`
(port 8477) at all — it's fetched cross-origin from a *second*, separate
backend, `lib/mnemosyne/server.ts` on port 3141, via
`personaServiceOrigin()` (`app.js:1173-1175`) and
`mnemosyneClientApiBase()` (`app.js:1210-1212`). A redesign that touches
Personas has to keep respecting that CORS boundary between two independently
running services — it is not a detail a pure front-end restyle can ignore.

---

## 5. Real pain points, not assumed ones

Concrete, measured findings (not impressions) that bear on the "ungodly long
list" complaint:

1. **Total footprint**: `ui/index.html` is 490 lines / ~25KB;
   `ui/app.js` is 2,383 lines / ~103KB; `ui/style.css` is 914 lines / ~17KB —
   **3,787 lines across the 3 files**, all loaded and parsed on every page
   view (no code-splitting is possible without a build step per §4).
2. **No wayfinding at all** (§1): a returning operator who only cares about,
   say, Operations (panel 6 of 8) must scroll past Liveliness, Settings,
   Lanes, Search, and Graph first every single time — document order is the
   only structure, and it is fixed. No section is collapsible except
   Personas' internal glossary `<details>` block.
3. **Personas has become disproportionately large relative to every other
   panel**, by a wide, measured margin:
   - In `index.html`: `#personas` spans lines 196–444 (**249 of 490 lines,
     ~51% of the whole document**), plus it's the section that hosts the
     nested Retrieval Layer Stack sub-section on top of that.
   - In `app.js`: the Personas-related code block spans roughly lines
     1157–2357 (**~1,200 of 2,383 lines, ~50% of the whole script**).
   - In `style.css`: Personas-scoped rules span lines 560–915
     (**356 of 914 lines, ~39% of the whole stylesheet**).
   One panel is now roughly half the codebase by every measure. This is the
   single most concrete, load-bearing fact behind "the ungodly long list" —
   it is not evenly distributed across 8 roughly-equal sections; it is one
   section that has outgrown the shell it lives in.
4. **Graph is the single most control-dense panel**: its toolbar alone has 7
   interactive controls (focus-search input, Go button, depth select, zoom
   in, zoom out, reset-view, show-whole-graph — `index.html:112-126`) plus a
   side inspector panel and an SVG canvas, all inside one `<div
   id="graph-body">` with no sub-navigation of its own.
5. **A real, mechanical duplication**: 5 separate one-line `<td>`-builder
   functions (`laneCell`, `searchCell`, `personaCell`,
   `personaLayerStackCell`, `memoryLevelsCell` — §1, above) do byte-for-byte
   identical work under different names, scattered across the file instead
   of sharing one utility — a concrete, low-risk consolidation opportunity
   independent of any visual redesign decision.
6. **One genuinely reusable pattern already exists and works**: `setStatus()`
   (`app.js:21-24`), called ~70 times, is the one real shared UI primitive
   in the codebase — any redesign has a real, working precedent to build a
   formal component system on top of, rather than starting from nothing.
7. **Per-ID styling, not per-component styling** (§1): almost every table,
   form, and button is styled by element `id` rather than by a shared class,
   so visually-identical controls (e.g. every panel's primary submit button)
   are each restyled from scratch rather than sharing one `.btn` class —
   another concrete, load-bearing reason the stylesheet is 914 lines for what
   is visually a fairly small, repetitive set of control types.

---

## Open questions for the design discussion

Things this research could not resolve by reading the code — genuine
decisions, not hedges:

1. **Hue mismatch between the shipped icon identity and the running UI's
   accent color.** The favicon/icon set is amber-gold (`#D8A84E`); the live
   UI's `--accent` token is blue (`#7aa2f7`), used in 14 places. Neither
   critique document nor anything else read here states whether the UI's
   accent is *meant* to migrate to amber-gold, stay blue deliberately (e.g.
   for its own contrast/pass-fail-neutral reasons — `--pass` is green,
   `--fail` is red, and amber sitting near either could get confusing in a
   pass/fail context), or whether the two are simply unrelated design tracks
   that haven't been reconciled yet. This needs an explicit decision, not an
   inference.
2. **Whether "extend, don't replace" (Personas' own explicit rule) is meant
   to bind a whole-UI redesign, or only bound Personas' own scoped change.**
   `selection.md`/`option-2.md` state this rule for Personas specifically,
   inside an otherwise-unchanged shell. A redesign that touches the *whole*
   shell (tokens, spacing, breakpoints) is a structurally different kind of
   change than one panel extending the existing system — nothing in the
   documents read here states which mode a full redesign is supposed to
   operate in.
3. **Whether Personas' now-outsized share of the codebase (§5) is treated as
   a problem to fix (e.g. via real componentization) or an accepted cost of
   it being the most complex panel.** The persona-ux documents optimize
   *within* Personas' own scope; none of them address whether that panel's
   sheer size relative to the other 7 is itself in scope for a shell-level
   redesign.
4. **Whether a whole-UI redesign is expected to introduce real navigation**
   (jump links, a collapsible section list, a sidebar) given the confirmed
   total absence of any wayfinding today, or whether the "no auto-polling,
   manual refresh, scroll to read" philosophy stated in `app.js`'s own header
   comment is meant to extend to "no navigation" as well, as a deliberate
   simplicity constraint rather than a gap.
