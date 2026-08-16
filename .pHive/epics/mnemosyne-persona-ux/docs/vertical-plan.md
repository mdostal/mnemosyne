# Vertical Plan: mnemosyne-persona-ux

## Epic Context
**ID:** mnemosyne-persona-ux (Epic 3 of 3, personas line of work)
**Horizontal Capabilities:** H1 Design-exploration pass, H2 Draft persona store, H3 Draft HTTP routes, H4 Draft write primitive×3 transports, H5 Draft transport tests, H6 Interview-skill extension, H7 Personas panel redesign, H8 Epic close-out (see `docs/horizontal-plan.md`)

This plan cuts 5 slices along the same two-independent-tracks-converging-at-the-end shape `horizontal-plan.md`'s Capability Dependencies diagram already establishes, and states the justification for each cut explicitly — the same discipline the wizard epic's own vertical plan used.

---

## Four Decisions That Set the Slice/Sub-Slice Boundaries

**Decision 1 — the design-exploration pass (H1) ships as its own first slice, standalone, before any UI code exists.**
The operator's own instruction is explicit (design-discussion.md §3a): this ticket must land EARLY, with UI build-out tickets depending on its output, not the other way around. Unlike a typical "design token" dependency (where a placeholder can stand in until the real one lands), H1's output — the chosen synthesized option's actual layout/interaction decisions — is the substance of the UI build-out capability, not a swappable input to it. Building H7 before H1 completes would mean building against ad-hoc judgment, defeating the entire point of the multi-swarm pass.

**Decision 2 — the draft-store backend (H2-H6) and the design/UI track (H1, H7) are two genuinely independent tracks that only converge at H8, mirroring the wizard epic's own Slice 1 ∥ Slice 2 opportunity.**
H2 (draft store) has zero dependency on H1 (design) — a persistence-layer/transport capability doesn't need a chosen wireframe to be built or tested. Symmetrically, H1 doesn't need H2 to exist (the design pass reasons about the interaction shape, not the concrete backend implementation). Serializing them would be a false dependency; this plan keeps them as two independently-staffable slices, same as the wizard epic's OQ6 explicitly permitted for its own Slice 1/2.

**Decision 3 — within the backend track, the draft write primitive ships CLI-first, then skill-harness, then MCP — not a preference, the same real dependency chain the wizard epic's H4 already established for the real store, reproduced identically here.**
`bin/mnemosyne-mcp.mjs`'s tools import skill-harness action functions directly; skill-harness actions subprocess-exec the CLI. There is no way to build the MCP draft tool as working code before the skill-harness draft action exists, which cannot exist before the CLI draft subcommand exists. This epic's draft primitive is added to a codebase that already established this exact layering twice (the original `sync`/`seed`/`show` verbs, then the wizard epic's `create` verb) — the third instance follows the same proven shape, not a new one.

**Decision 4 — the interview skill's bounded-crawl step (pu-07) and its draft-first write-target change (pu-08) are sequenced, not parallel, unlike the wizard epic's own H7/H6 split.**
The wizard epic could parallelize its `remember()`-scope-mapping decision and its interview mechanics because they were genuinely independent until the final "crawl and feed" convergence step. Here, pu-08's draft-propose call needs pu-07's `sourceSummary` output to actually attach to the proposed draft (design-discussion.md §3c: the reviewer needs to see *why* the agent proposed what it proposed) — the two are not independent in the same way, so this plan sequences pu-07 before pu-08 rather than forcing an artificial parallel split that would leave pu-08 temporarily building against an undefined `sourceSummary` shape.

---

## Slice 1: Design-Exploration Pass (H1)

**Goal:** 3 initial design directions, a 7-lens review of all 3, and 3 new synthesized options with a documented selection — real artifacts under `.pHive/design/mnemosyne-persona-ux/` that every UI-build-out story in Slices 4/5 reads and builds against directly, per Decision 1.

### Sub-slice 1a: Option generation + 7-lens review + synthesis (single story, deliberately not split further)
**Why cut as one story, not three:** the three phases (generate, review, synthesize) are a single coherent pass with a real data dependency chain (synthesis needs all 7 critiques of all 3 options; the panel needs all 3 options to exist first) — splitting them into separate stories would only fragment one ticket's internal step sequence into three tickets with no independently shippable value at the seams (a lone "3 initial directions, no review yet" deliverable is not useful on its own the way, say, H1's listing primitives were in the wizard epic).

- H1 (full): 3 initial option directions; 7 named lens critiques, each covering all 3; 3 synthesized final options; a documented selection rationale. All persisted to `.pHive/design/mnemosyne-persona-ux/`.

**Delivered value (standalone):** a reviewable, disk-persisted design decision for the entire rest of the epic to build against — genuinely useful on its own even before any code changes, the same way the wizard epic's H1 listing primitives were useful standalone even before a UI consumed them.

### Stories
1. Multi-swarm design-exploration pass: 3 options → 7-lens panel → 3 synthesized options + selection — complexity: high (7+ independent agent dispatches plus synthesis, genuinely new orchestration for this repo, no pre-existing workflow to call).

**Dependencies:** none (first story in the epic, alongside Slice 2's own first story per Decision 2).
**Story count:** 1.

---

## Slice 2: Draft Staging Backend (H2, H3, H4, H5)

**Goal:** `persona_draft_propose`/`show`/`approve`/`discard` exists and works, end-to-end and cross-transport-verified, at CLI, skill-harness, MCP, and HTTP — the concrete backend half of ask 2's "reviewed/edited before being committed via the existing persona_create write primitive, not written directly."

### Sub-slice 2a: Draft persona store
**Why cut here:** the one genuinely new persistence-layer decision in this epic (design-discussion.md §3b) — every other component in this slice wraps it, so it must land first and be independently proven (real write/read/list/dispose round-trips) before anything else in the slice can be built against it.
- H2 (full): `persona-draft-store.ts` — write/read/list/dispose, home-rooted paths for both global and repo-local drafts, archive-by-move disposal.

### Sub-slice 2b: HTTP routes + CLI (parallel — both terminate on 2a directly)
**Why cut together, in parallel, not sequentially:** same non-dependency the wizard epic's H2 (GET/POST routes) and H4 (CLI) already had on each other — both wrap H2's store functions directly; neither depends on the other's transport code.
- H3 (full): `GET/POST/DELETE /persona/draft/*` + `POST .../approve` on `lib/mnemosyne/server.ts`, reusing `applyPersonaCors`, with the draft-route-ordering guard (design-discussion.md §9 #7) as an explicit acceptance criterion.
- H4 (CLI component): `mnemosyne persona draft propose|show|approve|discard` in `bin/mnemosyne-persona.mjs`.

### Sub-slice 2c: skill-harness + MCP (strictly sequential per Decision 3)
**Why cut here:** cannot be built before 2b's CLI component exists (skill-harness subprocess-execs it); MCP cannot be built before skill-harness (imports its action functions directly).
- H4 (skill-harness component): `personaDraftProposeAction`/etc. in `bin/mnemosyne-skill-helper.mjs`.
- H4 (MCP component): `persona_draft_propose`/etc. tools in `bin/mnemosyne-mcp.mjs`.

### Sub-slice 2d: Cross-transport integration tests
**Why cut here:** a qualitatively different assertion from 2a-2c individually — proves all transports call the SAME underlying functions (the epic's own explicit "no second write path" risk) and that concurrent-transport writes don't race unsafely, plus the leak-proof negative-existence check (H5's component 3) that only makes sense once every read path (real store's `GET /persona`/`show`/`getPersonaContent`) can be checked against a real discarded draft.
- H5 (full): round-trip pairs, concurrency test, leak-proof test.

### Stories
1. Draft persona store (`persona-draft-store.ts`) — complexity: medium.
2. Draft HTTP routes (`GET/POST/DELETE /persona/draft/*` + approve) + route-ordering + CORS reuse — complexity: medium.
3. Draft CLI verbs (`propose`/`show`/`approve`/`discard`) — complexity: medium.
4. Draft skill-harness action + MCP tool wraps (both, one story — thin wraps once the CLI exists, same low-complexity shape the wizard epic's H4 MCP component had) — complexity: low.
5. Cross-transport round-trip + concurrency + leak-proof tests — complexity: medium.

**Dependencies:** 1 → (2, 3 in parallel) → 4 (needs 3) → 5 (needs 2 and 4).
**Story count:** 5.

---

## Slice 3: Interview Skill Extension (H6)

**Goal:** The agent-assisted authoring flow's real mechanics — a bounded, capped crawl producing a `sourceSummary`, and a draft-first default write target with a `--commit-directly` escape hatch — landed on top of the already-shipped `skills/mnemosyne-persona-interview`, per Decision 4's sequencing.

### Sub-slice 3a: Bounded crawl
**Why cut here (Decision 4):** independently valuable and independently testable — a capped, named-source-list crawl producing a `sourceSummary` string is real, verifiable behavior on its own, before it's ever attached to a draft-propose call.
- H6 (crawl component): named source list + cap, `sourceSummary` output, documented in `SKILL.md` and implemented as a pure, testable helper alongside `interview-engine.mjs`.

### Sub-slice 3b: Draft-first write target + escape hatch
**Why cut here:** depends on Slice 2's CLI (`draft propose`) and on 3a's `sourceSummary` (attached to the proposed draft's metadata) — cannot be built before either.
- H6 (write-target component): SKILL.md step 7 rewritten to call `draft propose` by default; `--commit-directly` flag reproduces the old `persona create` behavior exactly.

### Sub-slice 3c: Regression proof
**Why cut here:** the concrete verification that 3b didn't silently change behavior for the wizard epic's own existing tests, and that the non-blocking hard-fail rule still holds for the new default path — needs 3b to exist first.
- H6 (regression component): default-path-proposes-draft-never-commits proof; `--commit-directly`-reproduces-old-behavior-exactly proof; max-skip-still-produces-a-valid-draft proof.

### Stories
1. Bounded crawl: named source list, explicit cap, `sourceSummary` output — complexity: medium.
2. Draft-first write target: SKILL.md rewrite + `--commit-directly` escape hatch — complexity: medium.
3. Regression suite: draft-default proof, `--commit-directly`-exact-reproduction proof, max-skip-still-valid-draft proof — complexity: medium.

**Dependencies:** 1 → 2 (needs Slice 2 story 3, the CLI, as an external dependency too) → 3.
**Story count:** 3.

---

## Slice 4: Personas Panel Redesign (H7)

**Goal:** The actual UI build-out against Slice 1's chosen synthesized option — a new shell, the re-integrated layer-stack section, and a unified draft review/approve surface.

### Sub-slice 4a: Shell
**Why cut here:** everything else in this slice extends it; must land first. Depends on Slice 1 (needs the chosen option to build against) but not on Slice 2/3 (still reads the existing, unchanged `GET /persona` real-store routes at this layer).
- H7 (shell component): new panel structure/navigation per Slice 1's chosen option, replacing the current flat table.

### Sub-slice 4b: Layer-stack re-integration
**Why cut here:** pure extension of 4a's shell, no new backend route (reuses the already-shipped `GET /layers`, same as pw-04 originally did) — mechanical once 4a exists.
- H7 (layer-stack component): pw-04's section carried into the new shell, copy/labeling written defensively against today's `GET /layers` shape (design-discussion.md OQ1).

### Sub-slice 4c: Draft review/approve UI
**Why cut here:** needs Slice 1 (design), Slice 2's HTTP routes (H3, something to fetch/post/approve against), and 4a's shell (extends it) — the slice's most structurally dependent piece, ordered last.
- H7 (draft-review component): draft list + detail/edit + Approve/Discard, `sourceSummary` rendering when present, pw-17's existing form retargeted to propose a draft instead of writing directly (design-discussion.md §9 #4).

### Stories
1. Personas panel shell rebuild per Slice 1's chosen option — complexity: high (the actual "heavy UI/UX lift," genuinely new structure, not a mechanical extension of the existing single-table view).
2. Layer-stack section re-integration into the new shell — complexity: low.
3. Draft review/approve UI (list, detail/edit, approve/discard, `sourceSummary` rendering, retargeted create/edit form) — complexity: high.

**Dependencies:** 1 (needs Slice 1) → 2 (needs 1); 3 needs Slice 1, Slice 2 story 2, and story 1 above.
**Story count:** 3.

---

## Slice 5: Epic Close-Out (H8)

**Goal:** Proof the whole loop actually works end-to-end, and that the shipped UI actually matches Slice 1's chosen design — the epic's real release-gate claim (design-discussion.md §1), not each piece asserted in isolation.

### Sub-slice 5a: Full-loop end-to-end regression
**Why cut here:** the one assertion no earlier slice's own tests individually prove — that a CLI-proposed draft (Slice 3) is genuinely visible and actionable through the real browser UI (Slice 4), and a browser-side approval genuinely produces the same committed artifact the CLI-only path already proved (Slice 2's own cross-transport tests).
- H8 (e2e component): agent proposes via CLI → draft visible via HTTP/UI → human edits+approves via UI → real commit via the unchanged write primitive → panel reflects it without a manual reload.

### Sub-slice 5b: Design-fidelity review
**Why cut here, and why NOT dependent on 5a:** functional correctness (5a) and design fidelity (this) are independent axes — this only needs Slice 4's build-out to exist, not Slice 5a's own proof, so it can run in parallel rather than being needlessly serialized behind it.
- H8 (fidelity component): review pass comparing the shipped UI against Slice 1's chosen option's wireframe/brief, written comparison noting any deviation and its disposition.

### Stories
1. Full-loop end-to-end regression (agent-propose → UI-review → human-approve → real-commit) — complexity: medium.
2. Design-fidelity review against Slice 1's chosen synthesized option — complexity: low.

**Dependencies:** story 1 needs Slice 2 story 5, Slice 3 story 3, and Slice 4 story 3. Story 2 needs only Slice 4 story 3 (can run parallel to story 1).
**Story count:** 2.

---

## Vertical Slice Summary

| Slice | Sub-slices | Stories | Working Product Increment |
|-------|-----------|---------|---------------------------|
| 1 (design-exploration pass) | 1a (single combined story) | 1 | 3 synthesized, 7-lens-informed design options + a documented selection, real artifacts every later UI story builds against. |
| 2 (draft staging backend) | 2a store, 2b routes+CLI, 2c skill-harness+MCP, 2d cross-transport tests | 5 | `persona_draft_propose/show/approve/discard` works identically at all 4 transports (CLI/skill-harness/MCP/HTTP), proven not to leak into the real store, proven safe under concurrent drafts. |
| 3 (interview-skill extension) | 3a crawl, 3b draft-first target, 3c regression | 3 | The already-shipped interview skill now performs a bounded, capped crawl and proposes a draft by default instead of committing immediately — with an escape hatch preserving the old behavior exactly. |
| 4 (Personas panel redesign) | 4a shell, 4b layer-stack, 4c draft review/approve | 3 | The actual redesigned panel: new shell, re-integrated layer-stack section, and a working draft review/approve UI unifying agent-proposed and human-typed authoring. |
| 5 (epic close-out) | 5a e2e, 5b fidelity | 2 | Proof the full crawl→propose→review→approve→commit loop works for real, and that the shipped UI matches what Slice 1 actually designed. |

**Total stories:** 14 (1 + 5 + 3 + 3 + 2)

**Critical path:** Slice 1 and Slice 2 have no dependency on each other and can be staffed in parallel (Decision 2). Slice 3 depends on Slice 2's CLI story. Slice 4 depends on Slice 1 (all 3 stories) and, for its third story only, on Slice 2's routes story. Slice 5 is the true convergence point, needing Slice 2's tests, Slice 3's regression, and Slice 4's draft-review UI all complete.

---

## Ambiguities Not Resolved by the Design Discussion (flagged, not guessed past)

1. **Exact draft-route path shape beyond what design-discussion.md §3b already commits to** (e.g. whether `approve`/`discard` are sub-paths, as this plan assumes, or a `?action=` query param, or a request-body `action` field) — design-discussion.md commits to sub-paths (`POST /persona/draft/:tier/:scopeId/approve`, `DELETE /persona/draft/:tier/:scopeId` for discard) but the exact segment name for "discard" (a DELETE verb vs. a `POST .../discard` sub-path, for symmetry with `approve`) is left to Slice 2 story 2's own implementation judgment — either is a reversible, low-risk choice.
2. **Whether the CLI's `draft discard` subcommand should require a confirmation flag** given it moves (not deletes) the file, but is still a meaningful disposition action — left to Slice 2 story 3's own implementation judgment; the archive-not-delete guarantee (design-discussion.md §9 #5) already provides the real safety net regardless of CLI ergonomics.

## Resolved Ambiguities (orchestrator judgment call, not re-escalated — none rise to the level of a genuine architectural fork; all are reversible implementation details)

1. **Draft-route verb naming:** `propose`/`show`/`approve`/`discard` across CLI/skill-harness/MCP, `GET`/`POST`/`POST .../approve`/`DELETE` on HTTP — `propose` (not `create`, which is already the real-store verb pw-05 established) makes the semantic difference between "write a real persona" and "suggest one for review" unambiguous at every transport.
2. **`persona-draft-store.ts` is one module dispatching by `PERSONA_STORE_BY_TIER`, not two separate files** — unlike the real store (`persona-store-global.ts`/`persona-store-repo-local.ts` are separate because their on-disk conventions predate any shared abstraction), the draft store is new from scratch and the two locations' read/write/list/dispose shape is otherwise identical, so one module with an internal path-resolution branch avoids duplicating the same logic twice.
3. **Draft candidate validation is deliberately looser than `assertValidPersona` at propose/edit time, full-strength only at approve.** A draft is explicitly allowed to be incomplete while under review (design-discussion.md §3b) — only structural sanity (valid tier, non-empty `scopeId`) gates a propose/edit write; `assertValidPersona` remains the one real enforcement point, exercised unchanged at approval.
