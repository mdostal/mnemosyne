# Research brief — mnemosyne-icon-selection

## What already exists

**10 raw icon options**, generated this session via Gemini 3 Pro Image ("Nano Banana Pro") through Portunus's boundary-only key injection, committed at `.pHive/design/mnemosyne-icon-set/options/` (main, commit `70ce30b`):

1. `icon-01-memory-spiral-brain.jpg` — a continuous spiral line coiling into a subtle brain silhouette
2. `icon-02-laurel-profile.jpg` — an abstracted classical profile wearing a laurel wreath
3. `icon-03-neural-node-network.jpg` — 5 nodes in a compact knowledge-graph constellation
4. `icon-04-scroll-quill.jpg` — a rolled scroll crossed by a quill mark
5. `icon-05-infinity-recall-loop.jpg` — a bold infinity ribbon
6. `icon-06-hourglass-memory.jpg` — an hourglass with falling memory-dots
7. `icon-07-owl-minimal.jpg` — a reduced geometric owl face
8. `icon-08-ancient-urn-vessel.jpg` — a two-handled amphora
9. `icon-09-monogram-m-thread.jpg` — an M built from one continuous thread
10. `icon-10-concentric-memory-rings.jpg` — concentric rings from a center dot

All 10 share a warm amber-gold treatment on a dark tile, matching the standalone UI's own existing dark-only visual language (`ui/style.css`'s CSS custom properties). **Confirmed via PIL (`mode: RGB`, no alpha channel)**: these are plain JPEGs where "transparent background" was rendered as a literal drawn checkerboard pattern, not real alpha — not production-ready as-is.

**`.pHive/design/index.yaml`** already has a `mnemosyne-icon-set` topic entry (added when the 10 options were generated) with `status: options-generated-review-not-yet-run` — this epic is what advances that status.

**Precedent for the swarm-review mechanism**: `mnemosyne-persona-ux`'s `pu-01` ran the exact structural pattern this epic reuses — 3 option-generation agents → 7 independently-dispatched named-lens critique agents (each reviewing all options) → 3 synthesis agents + 1 selection agent, carried out via the Workflow tool inside a dedicated `git worktree`, with all artifacts committed under `.pHive/design/<topic>/` (`options/`, `critiques/`, `synthesized/`, `selection.md`). For icons, options already exist (skip option-generation), so this epic's version of the pass is: 7-lens critique of the 10 existing options → synthesis down to 3 refined finalists — a shorter pipeline than pu-01's full 3→7→3, with one structural difference pu-01 didn't have: **a real, blocking operator touchpoint** for the final pick (pu-01's own `selection.md` made an autonomous pick since no interactive operator was available at that time; this epic's operator explicitly said "the icon usually is mine to choose").

## What's genuinely new here

1. **7 icon-appropriate critique lenses** — pu-01's 7 lenses (onboarding-clarity, agent-provenance-trust, hierarchy-legibility, accessibility, information-density, design-language-consistency, operator-efficiency) were shaped for a UI panel's interaction design, not an icon. This epic needs its own 7 lenses suited to a favicon/install-icon artifact (legibility at 16px, brand/mythological fit, dark-UI-context fit, tab-bar distinctiveness, accessibility/contrast, multi-resolution scalability, visual-language cohesion with the rest of the standalone UI).
2. **A real transparent PNG + multi-resolution `.ico`** — no code in this repo currently produces either; the checkerboard-JPEG issue needs solving via either background removal (if an alpha-capable image tool/library is available) or a fresh, explicitly-alpha regeneration pass against whichever option is chosen.
3. **Wiring a `<link rel="icon">` into `ui/index.html`** — confirmed via direct grep that no such tag exists anywhere in this repo today. This is a net-new addition, not a replacement.

## Constraints

- The operator's own preference is real signal, not to be overridden or routed around: they've already named `icon-01` (memory-spiral-brain) as an early favorite and reserved the right to pick something else entirely (e.g. "just a brain") once they see the finalists — the swarm review informs, the operator decides.
- This ships as its own small, fast release — explicitly not bundled with the separate, later, larger "full UI look/feel/component/navigation" pass the operator also asked for in the same conversation.
