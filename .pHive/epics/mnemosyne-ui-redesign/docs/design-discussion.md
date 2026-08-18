# Design discussion — mnemosyne-ui-redesign

## §0. Goal (verbatim operator ask)

A full look-and-feel/UX redesign of the standalone UI — "user look, feel, style, how to break out the components, tabs versus the ungodly long list, etc" — run through the same real, multi-swarm design-review process this session already used for the icon and the Personas panel, "no corners get cut." Explicitly sequenced to start only after the favicon shipped (it has: v0.11.1, live on `main`/`dev`). A hard operator requirement carried over from that process: any component/navigation/visual decision must be shown to the operator as real rendered mockups before it's locked in and built out — prose specs are not sufficient for "look and feel," and the operator reserves the right to override the swarm's recommendation entirely.

## §1. Current state (grounded in research-brief.md — see it for full citations)

Eight top-level panels (Liveliness, Settings, Lanes, Search, Graph, Operations, Personas, Memory Levels), stacked in fixed document order with zero navigation beyond scrolling. Three concrete, measured problems, not impressions:

1. **No wayfinding.** An operator who wants Operations (panel 6 of 8) scrolls past 5 panels every time. Nothing is collapsible except one `<details>` block inside Personas.
2. **Personas has outgrown the shell it lives in.** ~51% of `index.html`, ~50% of `app.js`, ~39% of `style.css` are Personas-scoped, following its own dedicated redesign this session. One panel is now roughly half the codebase.
3. **The shipped visual identity and the running UI disagree.** The favicon is amber-gold (`#D8A84E`), chosen through a real 7-lens review that explicitly evaluated dark-chrome legibility. The live UI's actual `--accent` token — used in every button, link, and highlight, 14 call sites — is blue (`#7aa2f7`). Zero occurrences of "amber" or "gold" anywhere in `style.css`. These are two unreconciled design tracks today.

Working in this redesign's favor: zero build step, zero UI framework, one real reused primitive (`setStatus()`, ~70 call sites), and one real design-process precedent already shipped (Personas' `selection.md`/`option-2.md` — 7-lens critique → synthesis → selection, landing on: no tabs, one continuous table, native `<details>`/`role="radiogroup"` idioms, a structural read-before-approve gate, `aria-live` announcements). That precedent is the closest thing this repo has to prior art for the questions this redesign has to answer, and every one of its own critique lenses that touched layout rejected a tab-bar/inbox split as "the most visually foreign island outcome" — a real, evidenced data point against literal tabs, not just an aesthetic guess.

## §2. Proposed approach

### 2.1 Information architecture: grouped, collapsible sections with a sticky jump nav — not literal tabs

Recommendation, with reasoning:

- **Not tabs.** Tabs hide everything except the active panel. Several of these panels are monitoring surfaces (Liveliness, Settings, Operations) that an operator plausibly wants glanceable while working elsewhere on the page — hiding them behind a tab click trades one scroll problem for a worse one (state going invisible, not just distant). This is also not a hypothetical concern: Personas' own 7-lens review already tested a tab-bar/inbox-style option and every layout-relevant lens rejected it as foreign to this codebase's existing shape.
- **Not a heavy sidebar app-shell either.** That's a bigger structural rewrite (real page-region division, likely persistent-state/routing concerns) for a tool whose own stated design ethos is "zero third-party deps... loads once, manual refresh only, no auto-polling." A sidebar-app-shell direction fights that ethos more than it serves it.
- **Recommended instead:** group the 8 panels into a small number of named clusters (a first cut, to be pressure-tested by the swarm review, not locked here — e.g. *System* = Liveliness + Settings + Operations; *Memory* = Lanes + Search + Graph + Memory Levels; *Personas* stays its own group given its size), each cluster collapsible using the same native `<details>`/disclosure idiom Personas already introduced as this codebase's first precedent for exactly this kind of progressive disclosure — not a new widget vocabulary. A slim, sticky top nav bar (plain anchor links to each cluster, no client-side router, no hash-based SPA behavior) gives real jump-to-section wayfinding without adding any framework or build step. This directly answers pain point #1 and #2 above: an operator can collapse what they don't need and jump straight to what they do, and Personas' outsized share stops dominating the *page*, without touching Personas' own already-decided internal UX.
- **Explicitly deferred, not decided here:** the exact cluster boundaries and default collapsed/expanded state per cluster. That's real design-review work, not a call to make unilaterally in a discussion doc — it's the first thing the visual-mockup swarm pass should pressure-test with real alternatives.

### 2.2 Visual design system: reconcile the accent color, then formalize what already exists

Recommendation: **migrate `--accent` from blue (`#7aa2f7`) to the shipped amber-gold (`#D8A84E`)**, so the running product and its own icon agree with each other — a UI whose favicon and chrome contradict each other reads as unfinished, and there is no evidence anywhere in either shipped icon critique or the Personas documents that blue was a deliberate choice being protected. The one real risk raised by the research (amber sitting near the existing `--pass`/`--fail` green/red in a status-heavy UI) is a legitimate check to run during the visual-mockup pass, not a reason to avoid reconciling the identity — amber is hue-distinct enough from both green and red that a real rendered mockup, not a hypothetical, should settle it either way.

Beyond the accent, this redesign should **formalize, not reinvent**, what's already there: turn the 8 ad hoc custom properties into a real, complete token set (spacing scale, type scale, the existing dark palette plus the reconciled accent), extract the one duplicated mechanical pattern the research found (5 near-identical `<td>`-builder functions) into one shared utility, and move the per-`id` styling convention toward a small set of real shared classes (`.btn`, `.data-table`, etc.) so future panels don't each re-derive their own button/table styling from scratch. None of this touches Personas' own internal UX decisions (its layout, its approve/discard flow, its `aria-live` region) — those were already through a real review this session and are out of scope here; only shell-level concerns (tokens, the collapsible-cluster wrapper, shared component extraction) are in scope for this pass.

### 2.3 Component breakdown

Given zero build step is a hard, confirmed constraint (`src/server.mjs` serves files byte-for-byte, no bundler, no transpile), "components" here means disciplined vanilla-JS conventions, not a framework migration:

- Promote `setStatus()`'s pattern (the one thing already proven to work at scale) as the template for a small number of additional shared render helpers — a generic table-cell builder (replacing the 5 duplicates), a generic collapsible-cluster wrapper (built once, used by every top-level group), and a generic status-badge/panel-header renderer.
- Keep `app.js` as one file (no evidence a module split is needed to hit the goals above; splitting is a maintainability nice-to-have that can be reconsidered separately if it turns out to matter, not a blocking requirement of this redesign).

## §3. The blocking visual-mockup requirement (hard, not optional)

Per the operator's own explicit instruction, no cluster grouping, no token/color decision, and no component-extraction choice above gets built out until the operator has reacted to **real rendered HTML/CSS mockups** of the top-level shell (the collapsible-cluster + jump-nav structure, and the reconciled amber-gold palette applied across a couple of representative panels) — not written option docs alone. This mirrors `is-02`'s own structural pattern in `mnemosyne-icon-selection` (`.pHive/epics/mnemosyne-icon-selection/stories/is-02-operator-pick-and-assets.yaml`): a real ticket with an `operator-touchpoint` step that is not agent-executable, sitting as a hard dependency in front of any ticket that touches production `ui/*` files. The story graph (Phase C) makes this dependency structural, not a note in prose.

## §4. Risks

- **Reconciling the accent color could look worse in practice than on paper** if amber reads too close to `--pass` green in some real component (e.g. a status pill). Mitigation: the mockup pass renders real status states (pass/fail/loading) side-by-side with the new accent before this is locked in, per §3.
- **Collapsible clusters could hide state an operator actually wanted glanceable**, reintroducing a version of the "hidden information" problem this approach was chosen specifically to avoid with tabs. Mitigation: default state (which clusters start expanded vs. collapsed) is exactly the kind of question the mockup review should test with a real operator reaction, not assume.
- **Touching shell-level CSS/JS risks regressing Personas**, which is already shipped, tested, and half the codebase. Mitigation: shell changes (tokens, cluster wrapper, shared helpers) are additive/refactor-only around Personas' existing markup, never a rewrite of its internals; regression coverage for Personas' existing tests is a hard requirement of any build-out ticket that touches shared files.
- **Cross-origin constraint on Personas' data (port 3141 vs. the shell's own port 8477, via `personaServiceOrigin()`) is easy to silently break** if a redesign assumes all data is same-origin. Mitigation: explicitly called out in every build-out story that touches Personas' shell wrapper.

## §5. Dependencies

None on other in-flight work — `mnemosyne-icon-selection` and `mnemosyne-persona-files` are both already merged and live on `dev`/`main` (v0.11.1), and this redesign builds on top of both (the shipped amber-gold identity, and Personas' already-final internal UX). No dependency the other direction either — nothing else in flight depends on this redesign landing.

## §6. Open questions carried forward from research-brief.md, with a recommended answer each

1. **Accent hue migration** — recommend yes (§2.2), final call happens at the mockup review (§3).
2. **Does "extend, don't replace" bind the whole shell, or only bound Personas?** — recommend: it extends to the whole shell. This redesign formalizes the *existing* dark/monospace/table-based visual language into real tokens and shared components; it does not invent an unrelated new system. Personas' own already-shipped internals are untouched.
3. **Is Personas' outsized share of the codebase itself a problem to fix?** — recommend: not in scope to re-architect Personas' own code in this pass (it already went through its own review), but the shell-level cluster/collapse structure (§2.1) directly addresses the *page-weight* symptom without touching Personas' internals.
4. **Should real navigation be introduced?** — recommend: yes, a sticky jump nav (§2.1) — the "no polling/manual refresh" simplicity ethos is about *data-fetching* behavior, not about *wayfinding*; nothing in the research suggests the two are meant to be coupled.

## §7. Scale assessment

**Large.** Whole-UI surface (not one panel), touches shared shell files every other panel depends on, real information-architecture and visual-identity decisions with genuine tradeoffs, and a hard operator-facing visual checkpoint gating build-out. Warrants full Horizontal/Vertical planning plus a structured outline before story decomposition — the next step in this planning pass.
