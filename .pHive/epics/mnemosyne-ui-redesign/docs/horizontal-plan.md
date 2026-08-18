# Horizontal plan — mnemosyne-ui-redesign

Maps every architectural layer this epic touches and the cross-layer dependencies between them. Real source of truth for every decision below: `.pHive/design/mnemosyne-ui-redesign/round2/candidates/hybrid-rings-original-graph-colors.html` (the confirmed mockup) plus round 2's own punch list of what it still gets wrong.

## H1 — Visual token layer (`ui/style.css` `:root`)

Migrate `--accent` from the current blue (`#7aa2f7`) to the shipped favicon's amber-gold (`#D8A84E`) — the one change every other layer below builds on. Add: `.status-pill.degraded` (red, `var(--fail)`) as a genuinely distinct class from `.status-pill.needs-review` (amber) — the color-semantics bug round 2 confirmed still live in the unfixed original and fixed in the mockup. Add chip-ring colors (`chip-pass`/`chip-fail`, sourced from `--pass`/`--fail`). The graph node's `--node-selected`/`--node-focus` custom properties are added but must alias directly to `var(--fail)`/`var(--pass)` **with an honest code comment** stating this is a deliberate operator choice to keep the original red/green graph coloring — round 2 caught the mockup's own comment overclaiming a "dedicated token" fix that doesn't actually change the rendered color, and that specific defect must not ship.

## H2 — Shell structure layer (`ui/index.html`)

Three additive changes, no wholesale rewrite (the real current shell is already a flat, always-visible document close to the confirmed direction — confirmed by research-brief.md §1): (1) a sticky `<nav id="jump-chips">` bar with one anchor per real panel, placed directly under `<header>`; (2) the real shipped favicon (`ui/favicon.png`) embedded inline via `<img>` next to the `<h1>Mnemosyne` text, not only as the existing `<link rel="icon">`; (3) Personas' write-tooling tail (the draft-propose form, the Retrieval Layer Stack sub-section, the Level 0 pointer) wrapped in one `<details id="persona-tools">`, defaulted `open` — the read-oriented identity table stays untouched, always visible, outside the disclosure.

## H3 — Render/status-propagation layer (`ui/app.js`)

New logic in `refreshAll()`'s completion path: after every panel's own `load*()` resolves and calls `setStatus()`, propagate a `chip-pass`/`chip-fail` class onto that panel's corresponding `#jump-chips` anchor — sourced from the same real status the panel itself just rendered, never fabricated (round 2 explicitly verified the mockup does this correctly: Search/Graph/Operations, which carry no `panel-status` line, correctly get no ring rather than an invented one — the real implementation must preserve that same "no data, no ring" rule). One progressive-enhancement addition: an `IntersectionObserver`-driven scroll-spy highlighting the current chip, correctly guarded (`if (!('IntersectionObserver' in window)) return;`) so its absence never affects core function — no panel visibility anywhere in this epic may depend on JavaScript running (this repo's zero-build-step, zero-framework constraint, confirmed hard in research-brief.md §4).

## H4 — Accessibility layer (cross-cutting across H2/H3)

Two concrete, round-2-cited gaps to close before shipping, neither present in the reference mockup: (1) the status rings need a real text alternative (a `visually-hidden` span or `aria-label` on the chip, not a bare `title` attribute — round 2 confirmed `title` alone is not read by screen readers in normal browse mode); (2) every form field this epic's markup touches or moves must keep (or gain) explicit `for=`/`id` label association — round 2 found round 1's own "hardening" pass on a rejected candidate introduced 8 *new* broken associations, a mistake this epic's real implementation must not repeat. A pre-integrate check (grep for orphaned `<label>` elements, a manual screen-reader-adjacent pass) is a hard acceptance criterion, not a nice-to-have.

## H5 — Regression/release layer

Full existing test suite (`.mjs` subprocess suite + `vitest` + `tsc --noEmit`) must stay clean against this epic's changes to shared shell files — Personas' own already-shipped tests (`test/persona-draft-review-approve-ui.mjs`, `test/persona-write-form.mjs`, etc.) are the highest-risk regression surface since this epic's `<details id="persona-tools">` wrap touches markup those tests assert against. Version bump + CHANGELOG entry mirroring every prior epic's closing convention this session.

## Cross-cutting concerns

- **No panel visibility may depend on JavaScript.** Every layer above (H2, H3) must degrade to "everything visible" if a script fails or is stripped — this is the property that won the confirmed direction its glanceable-monitoring lens outright in both review rounds, and it must survive translation from mockup to production code.
- **No fabricated status.** A chip's pass/fail ring reflects only a real, already-rendered `panel-status` value. A panel with no status line gets no ring — never an invented default.
- **Personas' own already-shipped internals (its table, its approve/discard flow, its `aria-live` region) are out of scope.** Only the shell-level wrapper (H2's `<details id="persona-tools">`) and any shared token/class changes (H1) may touch its markup.
