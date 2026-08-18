# Vertical plan — mnemosyne-ui-redesign

Minimum cross-stack increments, each leaving the product in a working state.

## Slice 1 — Visual identity reconciliation (H1)

Migrates `--accent` to amber-gold, fixes the `.status-pill.degraded`/`.needs-review` color-semantics bug, adds the honestly-documented graph-node color tokens. Zero structural/markup change — a pure token/CSS slice, independently shippable and immediately visible (every existing button/link/highlight across all 8 panels picks up the new accent with no other change). Lowest risk in the epic: touches one file, no JS, no new markup.

Stories: ui-01 (token migration + color-semantics fixes).

## Slice 2 — Real icon in the shell (H2, narrow)

The favicon is already shipped (`ui/favicon.png`/`.ico`, `<link rel="icon">`) — this slice only adds it inline in the header next to the `<h1>`, per the operator's explicit request to see the actual icon, not just a browser tab glyph. Independent of every other slice; can ship in any order.

Stories: ui-02 (inline header icon).

## Slice 3 — Jump-chip navigation + live status wiring (H2 + H3)

The core new feature: the sticky nav bar, and the real status-propagation logic that colors each chip from the panel it points at. Depends on Slice 1 (chip-ring colors are defined there) but not on Slice 2. This is the slice that actually answers "the ungodly long list" — independently demoable and useful the moment it lands, even before Slice 4's Personas collapse or Slice 5's accessibility pass.

Stories: ui-03 (nav markup + chip status-propagation logic + styles).

## Slice 4 — Personas draft-tools collapse (H2, narrow)

The one collapse point in this epic, scoped tightly to Personas' write-tooling tail. Depends on nothing else structurally, but sequenced after Slice 3 so the jump-chip nav already exists to link to `#personas` before this slice changes what's visible inside it — reduces the chance of the two slices' diffs conflicting on the same section.

Stories: ui-04 (Personas `<details id="persona-tools">` wrap).

## Slice 5 — Accessibility hardening (H4)

Closes round 2's two concrete, cited gaps: a real text alternative on the status rings (depends on Slice 3, which creates them), and a full label-association audit across every panel this epic's own changes touch (depends on Slices 2–4, since it must check their output, not just the pre-existing markup). Sequenced last among the feature slices deliberately — auditing accessibility against a moving target wastes work; auditing once after Slices 1–4 land catches everything in one real pass.

Stories: ui-05 (status-ring text alternative + label-association audit + fixes).

## Slice 6 — Closing regression + release (H5)

Full-suite regression pass (with explicit attention to Personas' own existing tests, the highest-risk regression surface per horizontal-plan.md H5), version bump, CHANGELOG entry — mirroring every prior epic's closing convention this session (`pf-08`, `is-03`).

Stories: ui-06 (full-suite regression + version bump + release note).

## Deferred (explicitly out of scope, not silently dropped)

- **Full spacing/type-scale tokenization and the 5-way duplicated `<td>`-builder consolidation** — design-discussion.md §2.2/§2.3 named both as real formalization work ("turn the 8 ad hoc custom properties into a real, complete token set... extract the one duplicated mechanical pattern... into one shared utility"). Neither went through the two-round swarm review (which scoped itself to navigation/IA and visual-identity/color, per both rounds' own lens sets) and the operator's own repeated focus this session has been navigation, visual identity, and the icon — never stylesheet/component hygiene. Flagged here as a real traceability gap (caught during story decomposition, not silently dropped) and left for a smaller, separate follow-up rather than expanding this epic's build-out scope after the design review already ran.
- **Re-architecting Personas' own internals** (its table structure, its approve/discard flow, its provenance labeling) — already shipped and tested this session via a dedicated epic; this redesign's scope is the shell around it, confirmed in design-discussion.md §2.2/§6.
- **A real URL-routable/bookmarkable panel-focus state** — the confirmed direction deliberately rejected the single-active-panel pattern (and the URL/back-button benefits that would have come with it) specifically because it hid too much content behind a click; native anchor-link jump navigation (`#panel-id`) already gives free bookmarkability without that tradeoff, so no further routing work is needed.
- **Arrow-key roving-tabindex keyboard navigation between chips** — round 2 flagged this as a nice-to-have on the sidebar direction specifically (a true ARIA tablist pattern); the confirmed direction's chips are plain anchor links, not a tablist, so this pattern doesn't apply and isn't needed.
