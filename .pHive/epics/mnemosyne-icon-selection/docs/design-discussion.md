# Design discussion — mnemosyne-icon-selection

## §0. Goal (verbatim operator ask)

Select and ship the favicon/install icon from the 10 already-generated options, via a real multi-swarm design review — mirroring `pu-01`'s proven 7-lens-critique → synthesis structure, but with a genuine operator touchpoint for the final pick ("the icon usually is mine to choose"). Ships as its own small, fast release, explicitly sequenced before the separate, larger "full UI look/feel/component/navigation" pass.

## §1. Proposed approach

**Ticket 1 — the swarm review itself.** A Workflow-tool-driven pass, structurally mirroring `pu-01`: 7 independently-dispatched named-lens critique agents, each reviewing all 10 existing options (no option-generation phase needed — the options already exist), producing 7 critique files. A synthesis stage combines the 7 critiques into exactly 3 refined finalists — not a re-pick of 3 of the original 10 verbatim, but genuinely informed refinement/selection, matching `pu-01`'s own "synthesized, not just chosen" precedent. Output committed to `.pHive/design/mnemosyne-icon-set/critiques/` and `synthesized/`, `.pHive/design/index.yaml` updated.

The 7 lenses (icon-appropriate, not copied from `pu-01`'s UI-panel lenses):
1. **Legibility at 16px** — does the concept survive a literal browser-tab-sized favicon render, not just a 1024px preview?
2. **Mythological/brand fit** — does it evoke Mnemosyne (memory, recall) specifically, not a generic "AI/tech" mark?
3. **Dark-UI-context fit** — the standalone UI is dark-only; does the concept read correctly against dark chrome (browser tab, OS dock)?
4. **Tab-bar distinctiveness** — would this be identifiable at a glance among a browser's other 20 open tabs?
5. **Accessibility/contrast** — sufficient contrast between the mark and its ground at small sizes, not relying on fine detail that vanishes when scaled down.
6. **Multi-resolution scalability** — does the concept hold up across the real range a favicon/install-icon needs (16×16 up through a 512×512 install icon), or does it only work at one size?
7. **Visual-language cohesion** — consistency with this repo's own already-shipped amber-gold-on-dark treatment used elsewhere in the standalone UI (`ui/style.css`'s tokens), so the icon doesn't read as a foreign import.

**Ticket 2 — the operator touchpoint + asset production.** This is the one structural departure from `pu-01`'s own precedent: `pu-01` made an autonomous synthesized pick because no interactive operator was available at plan time; this epic has one, and the operator explicitly reserved the final call. So Ticket 1's output (3 finalists) is presented to the operator as a real, blocking gate — not assumed, not auto-advanced — including honoring the operator's own stated freedom to override entirely (e.g. picking a wholly different concept like a plain brain, not constrained to the 3 finalists). Once the operator picks, this ticket produces the real production assets from that one option: a genuine transparent-background PNG (solving the checkerboard-JPEG problem via background removal or a fresh, explicitly-alpha-requested regeneration), a proper multi-resolution `.ico`, and wires `<link rel="icon">` into `ui/index.html` (confirmed via research: no such tag exists today, so this is additive, not a replacement).

**Ticket 3 — closing.** A quick version bump + release note, mirroring `pu-15`/`pf-08`'s own established closing-ticket convention. Given the small, fast-release intent, this ticket does NOT run a full stash-and-reproduce fresh-worktree investigation the way `pf-08` did (that rigor matched an 8-ticket, multi-week-equivalent epic) — a straightforward full-suite regression pass in the working tree, plus tsc, is proportionate here. If a real regression is found, it gets fixed; if the suite's already-documented pre-existing failures (the 3 `POST /remember` assertions) are the only thing seen, that's sufficient without re-deriving the fresh-worktree-artifact investigation from scratch.

## §2. Risks

- **Checkerboard-to-real-alpha conversion could subtly change the mark's silhouette** if background removal is imprecise. Mitigation: prefer a fresh, explicitly-alpha-requested regeneration of the chosen concept over post-hoc background removal, since the model can be told directly to omit any background fill this time — closer to the source of truth than reverse-engineering transparency out of a checkerboard.
- **7-lens review could produce 3 finalists none of which are the operator's already-stated favorite (`icon-01`).** Not actually a risk to mitigate — the operator explicitly said they may override with something else entirely regardless of what the synthesis recommends. The review's job is honest critique, not converging on a predetermined answer.

## §3. Dependencies

None on other in-flight epics. Independent of `mnemosyne-persona-files` (already fully built, pending release) and the separate, larger, later "full UI redesign" pass.

## §4. Open questions

**OQ1 — asset production approach (regenerate vs. remove background).** Resolved in §1 above: prefer regenerating the chosen concept with an explicit real-alpha request over post-hoc background removal from the existing checkerboard JPEG, since it's closer to the source of truth. If regeneration produces a materially different result from the reviewed/chosen concept, fall back to background removal on the original instead, so the shipped icon matches what was actually chosen.

**OQ2 — where "install icon" surfaces exist beyond the browser favicon.** Resolved via direct research: none exist in this repo today (no PWA manifest, no `apple-touch-icon`, no `.ico` reference anywhere in `ui/index.html`). Scope is a real `<link rel="icon">` addition to the standalone UI; nothing else needs updating because nothing else currently references any icon.

## §5. Scale assessment

**Small.** 3 tickets, single layer (a design-artifact pass + a small UI/asset addition), no cross-cutting architectural decisions, reuses `pu-01`'s already-proven swarm-review mechanism rather than building anything new. Design discussion is sufficient context — no H/V planning warranted.
