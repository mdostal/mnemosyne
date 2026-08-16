# Horizontal Plan: mnemosyne-persona-ux

## Epic Context
**ID:** mnemosyne-persona-ux (Epic 3 of 3, personas line of work — see `docs/design-discussion.md` §0/§1)
**Goal:** A heavily redesigned Personas panel, produced through a real multi-swarm design-exploration pass, and a new agent-assisted persona build-and-approve interaction (bounded crawl → propose a draft → human reviews/edits/approves → real commit), replacing the single free-text create/edit form.
**Scale:** Large — comparable to or larger than the wizard epic's own 17-story scope (design-discussion.md §7).
**Solo-planned, judgment calls logged, not re-litigated here:** the draft-store architecture (design-discussion.md §3b, §9 #5/#6), the 7 review lenses (§4), the 3-initial/7-lens/3-final shape of the design pass (§9 #1/#2), the draft-first interview default + escape hatch (§9 #3), and the unified review/approve surface (§9 #4). This plan grounds each capability in real source and does not reopen any of those.

---

## H1: Multi-Swarm Design-Exploration Pass

**What:** A 3-phase fan-out-then-synthesize design pass — 3 initial option directions, a 7-distinct-lens review panel critiquing all 3, then synthesis into 3 new refined options — for both the redesigned Personas panel and the new agent-assisted build/approve flow.
**Why:** Direct operator mandate, quoted verbatim in design-discussion.md §0 ask 1: *"take this through a real multi swarm design phase... have 7 personas review and give feedback and then make 3 new options from all of the feedback."* No pre-existing skill in this repo's Hive tooling performs this shape — `/design` is a single ui-designer dispatch (research-brief.md §5); this capability is genuinely new orchestration, not a call to something that already exists.

**Components:**
1. **Option generation** — 3 independently-dispatched agents, each producing one initial design direction (wireframe-level: layout, navigation, interaction flow for the panel redesign AND the crawl→propose→approve flow), following `/design`'s own wireframe-protocol conventions for artifact shape where applicable.
2. **7-lens review panel** — 7 distinct, independently-dispatched persona/stakeholder-lens agents (design-discussion.md §4: operator efficiency, new-user onboarding clarity, accessibility, agent-provenance/trust-calibration, information density/scannability, existing-shell design-language consistency, multi-tier/multi-repo hierarchy legibility), each reviewing all 3 initial directions and producing a written critique.
3. **Synthesis** — synthesis agent(s) reading all 3 directions + all 7 critiques, producing 3 NEW refined options (not a pick-one-of-the-original-3) plus a documented, reasoned selection among them (design-discussion.md §9 #2 — no interactive operator touchpoint in this unattended pass).
4. **Artifacts to disk**, following `/design`'s own directory convention (research-brief.md §5): `.pHive/design/mnemosyne-persona-ux/` — initial option briefs, 7 lens critiques, 3 final synthesized option briefs (wireframe descriptions, layout decisions, interaction-flow diagrams), and the selection rationale.

**Cross-layer dependency:** No dependency on anything else new in this epic — pure design-artifact generation. Blocks H7 (UI build-out has nothing to build against without a chosen option).

**Acceptance criteria:** exactly 3 initial directions, 7 named lens critiques (each covering all 3 directions), exactly 3 final synthesized options, a written selection rationale, all persisted under `.pHive/design/mnemosyne-persona-ux/` in a form later tickets can read and build against without re-deriving it from a summary.

---

## H2: Draft Persona Store

**What:** A new, structurally separate persistence layer for in-review persona drafts — `~/.mnemosyne/persona-drafts/<tier>/<scopeId>.yaml` (global tiers) and `~/.mnemosyne/persona-drafts/repo-local/<repoSlug>/<scopeId>.yaml` (`code-architect`), plus `approved/`/`discarded/` archive subtrees for disposed drafts.
**Why:** Confirmed gap (research-brief.md §3): no draft/staging concept exists anywhere in this codebase's persistence layer. The real architectural decision this epic's operator explicitly asked to be made and documented, not hand-waved (design-discussion.md §3b) — home-rooted, never inside a consuming repo's git-tracked tree (`persona-store-repo-local.ts`'s own doc comment confirms that store is deliberately NOT gitignored), one active draft per `{tier, scopeId}`, disposition by archive-move rather than hard delete (mirrors the already-shipped flight-status "never delete, mark disposition" philosophy).

**Components:**
1. `lib/mnemosyne/layer1/persona-draft-store.ts` (new file, single module dispatching by `PERSONA_STORE_BY_TIER` the same way the real stores' callers already do — not two separate files, since both draft locations share the same read/write/list/dispose shape once the path-resolution differs): `writeDraftPersona`, `readDraftPersona`, `listDraftPersonas`, `disposeDraftPersona(disposition: 'approved' | 'discarded')`.
2. Repo slug derivation reuses `resolveRememberScope()`'s exact sanitization rule (`persona.ts`, `.replace(/[^a-zA-Z0-9_-]/g, '-')`) applied to `path.resolve(repoRoot)` — no new sanitization scheme.
3. Draft records are deliberately NOT required to pass full `assertValidPersona` at write/edit time (a draft may be genuinely incomplete while a human is still reviewing it) — only structural sanity (valid tier, non-empty `scopeId`) is checked here; full schema validation happens exactly once, at approval (H3), by calling the real write functions unchanged.
4. Draft-only metadata fields (`proposedBy: 'agent' | 'human'`, `proposedAt`, `sourceSummary?`) travel alongside the candidate in the same YAML document, stripped by the approval route before the candidate reaches the real write functions — never smuggled into the committed `Persona` record.

**Cross-layer dependency:** No dependency on anything else new in this epic. Feeds H3 (routes) and H4 (CLI) directly, same "both terminate on the same underlying functions, neither depends on the other's transport code" shape the wizard epic's H1→H2/H4 already established.

**Acceptance criteria:** write/read/list/dispose round-trip correctly for both global and repo-local drafts; disposal MOVES the file (never `unlink`s it) to the correct archive subtree with a timestamped name; a second write to the same `{tier, scopeId}` overwrites the active draft in place, never creating a second active draft; a repo-local draft is never written anywhere inside the target repo's own working tree (verified by asserting no file exists under `<repoRoot>/.mnemosyne/` after a repo-local draft write).

---

## H3: Draft Persona HTTP Routes

**What:** New routes on `lib/mnemosyne/server.ts`, wrapping H2 directly: `GET /persona/draft` (list), `GET /persona/draft/:tier/:scopeId` (read one), `POST /persona/draft/:tier/:scopeId` (propose/overwrite), `POST /persona/draft/:tier/:scopeId/approve` (commit via the real write primitive), `DELETE /persona/draft/:tier/:scopeId` (discard).
**Why:** The browser is the human-review surface (design-discussion.md §3b) — a human reviewing/editing/approving a draft needs an HTTP path, same reasoning that already justified `/persona/*`'s existence for the real store (wizard epic OQ1).

**Components:**
1. All 5 routes reuse `applyPersonaCors()` exactly as-is — same allow-listed origins, same scoped-not-wildcard posture, no second CORS implementation (research-brief.md §4). The existing `OPTIONS /persona/*` preflight handler already covers these routes structurally (its own prefix check is `/persona/`), confirmed by reading `server.ts` directly — no new preflight branch needed.
2. **Route-ordering guard (design-discussion.md §3b, §9 #7):** the new `/persona/draft/*` dispatch branches are added and checked BEFORE the existing generic `GET`/`POST /persona/:tier/:scopeId` handlers in source order — not relied on to be harmlessly rejected by those handlers' own `segments.length !== 2` guard as an implicit safety net.
3. `POST /persona/draft/:tier/:scopeId/approve` reads the active draft (H2), strips draft-only metadata, and calls `writeGlobalPersona`/`writeRepoLocalPersona` **unchanged** — the exact same functions every other write transport already calls. On success, archives the draft (H2's `disposeDraftPersona('approved')`) and returns the same `{created, store, tier, scopeId, path}` shape `POST /persona/:tier/:scopeId` already returns, plus the archived draft's path for traceability. On validation failure (the candidate doesn't pass `assertValidPersona`), the draft stays active — a human can go fix it — and the error surfaces via the existing `badRequest` convention.
4. `DELETE /persona/draft/:tier/:scopeId` calls `disposeDraftPersona('discarded')` — never a bare filesystem delete.

**Cross-layer dependency:** Depends on H2. Blocks H7's draft review/approve UI component (pu-12) — nothing to fetch/post/approve against without these routes.

**Acceptance criteria:** every route round-trips against a real subprocess-spawned `lib/mnemosyne/server.ts` (extending `test/http-api.mjs`'s existing convention); approve produces the identical on-disk committed file `POST /persona/:tier/:scopeId` would produce for the same candidate (verified by a direct filesystem read, not just a 200/201 response); a discarded or never-approved draft never appears via `GET /persona` (the real store's list route) at any point.

---

## H4: Draft Write Primitive Across Transports

**What:** CLI verbs (`mnemosyne persona draft propose|show|approve|discard`) as the canonical implementation layer, then skill-harness action + MCP tool wraps around the same CLI, mirroring the wizard epic's own H4 chain exactly (CLI → skill-harness subprocess-execs CLI → MCP imports skill-harness action).
**Why:** The agent-assisted flow's "propose" step runs inside a live agent session (design-discussion.md §3b) — the interview skill already established, for the exact same reason, that the CLI is the one write surface guaranteed reachable with zero additional transport setup (SKILL.md step 7's own documented reasoning). Draft-propose needs the identical guarantee.

**Components:**
1. **CLI** (`bin/mnemosyne-persona.mjs`): new `draft propose --file <path> [--repo <repo>]`, `draft show <tier> <scope-id> [--repo <repo>]`, `draft approve <tier> <scope-id> [--repo <repo>]`, `draft discard <tier> <scope-id> [--repo <repo>]` subcommands, added to the existing `run()` dispatcher alongside `create`/`sync`/`seed`/`show`/`resolve-remember-scope`. Imports H2's `persona-draft-store.ts` functions directly, the same way the existing `create` subcommand imports `writeGlobalPersona`/`writeRepoLocalPersona`.
2. **skill-harness** (`bin/mnemosyne-skill-helper.mjs`): new `personaDraftProposeAction`/`personaDraftApproveAction`/`personaDraftDiscardAction`/`personaDraftShowAction`, each subprocess-shelling to the CLI via the existing `personaCliRun()` helper — no new logic, same shape as `personaCreateAction`/etc.
3. **MCP** (`bin/mnemosyne-mcp.mjs`): `persona_draft_propose`/`persona_draft_approve`/`persona_draft_discard`/`persona_draft_show` tools, each importing and wrapping the corresponding skill-harness action function directly via `wrapAction()` — same registration shape as the existing `persona_create` tool.

**Cross-layer dependency:** Depends on H2 (needs the store functions to wrap) — no dependency on H3 (a different transport chain terminating on the same underlying H2 functions). Feeds H6 (the interview skill's propose step calls this CLI directly, same as it already calls `persona create`).

**Acceptance criteria:** all 3 transports produce the identical on-disk draft file for the same logical propose call; approve via any transport produces the identical committed file `POST /persona/draft/:tier/:scopeId/approve` (H3) would produce for the same draft; a rejected approve (invalid candidate) surfaces as a clear non-zero-exit/`isError:true` result at every transport, never a silent no-op — matching the wizard epic's own H4 acceptance bar exactly.

---

## H5: Draft Transport-Integration Tests

**What:** Cross-transport round-trip and concurrency tests for the draft mechanism, extending the exact conventions the wizard epic's H5 already established for the real write primitive.
**Why:** Same risk class the wizard epic's architect-lens review already flagged for its own H4/H5: new transport wrappers around a shared underlying implementation are exactly where quiet divergence hides if not independently proven.

**Components:**
1. Propose via transport A, read/approve via transport B (or H3's HTTP routes), for every meaningful (A, B) pair — proves H2/H4's "same underlying store functions, no re-implementation" guardrail rather than assuming it.
2. A concurrent-write test: two transports racing a propose against the same `{tier, scopeId}` draft identity — proves the draft store needs (and has) the same file-scoped locking discipline `withLock` already gives the real store, not a second, unlocked path.
3. A proof that a discarded/never-approved draft never becomes reachable through any read path the real store exposes (`GET /persona`, `mnemosyne persona show`, `getPersonaContent`) — the concrete verification of H2/H3's "structurally separate, never leaks into a live-render path" guarantee.

**Cross-layer dependency:** Depends on H3 and H4 (needs all transports to exist first). Feeds H8 (the epic-closing end-to-end regression builds on these individual transport proofs, doesn't re-derive them).

**Acceptance criteria:** every (propose-transport, approve-transport) pair round-trips to the identical committed file; the concurrency test proves no lost update / no two active drafts for one identity; the leak-proof test proves negative (nothing) across all 3 real-store read paths for a discarded draft.

---

## H6: Interview Skill Extension — Bounded Crawl + Draft-First Default

**What:** Two real changes to the already-shipped `skills/mnemosyne-persona-interview` skill: (1) an explicit, capped, named-source-list crawl step replacing today's opportunistic "load context" step 2; (2) the write step (step 7) targets H4's `draft propose` by default instead of `persona create`, with a `--commit-directly` flag reproducing the exact old behavior.
**Why:** Both are direct, load-bearing requirements of ask 2 (design-discussion.md §0/§3c): *"give it a way to crawl and help build a short, reasonable context on there without overdoing it"* and *"a human to approve it, rather than expecting a full drill down in one text body."* Neither exists today (research-brief.md §2) — the skill currently commits immediately with no review gate, and its context-loading step has no defined bound.

**Components:**
1. **Bounded crawl (pu-07):** a fixed, small source list — repo README, package/project manifest, existing `CLAUDE.md`/`AGENTS.md` if present, the applicable parent persona's own summary via query-up (never its full content — preserves the already-code-enforced "query up, never copy down" guarantee, `persona.ts`'s `buildParentContextSections`) — with an explicit file-count/line cap, producing a short `sourceSummary` string. This is a new, documented step in `SKILL.md`, with a corresponding pure helper in `interview-engine.mjs` (or a new sibling module) implementing the cap deterministically, testable the same way `resolveAnswer()`/`runPersonaInterview()` already are.
2. **Draft-first write target (pu-08):** SKILL.md step 7 rewritten to call H4's `mnemosyne persona draft propose` by default; a new `--commit-directly` invocation flag reproduces today's exact `persona create` behavior byte-for-byte, preserving backward compatibility for the wizard epic's own already-shipped tests and any existing automation that depends on immediate-commit semantics.
3. **Regression proof (pu-09):** tests proving the default path proposes a draft and NEVER auto-commits; `--commit-directly` reproduces the pre-epic behavior exactly (same acceptance shape the wizard epic's own `persona-interview-*.test.ts` files already assert); the non-blocking hard-fail rule (pw-10/12) still holds for the draft-propose path — a maximally-skipped interview still proposes a valid, reviewable draft, not an error.

**Cross-layer dependency:** Depends on H4 (needs `draft propose` to exist) and, for pu-08 specifically, on pu-07 (the crawl step's `sourceSummary` output is part of what gets proposed). Independent of H7 (UI) entirely — the interview skill is a CLI/agent-driven flow; the UI is a separate consumer of the same draft store via H3.

**Acceptance criteria:** a full interview run with no `--commit-directly` flag produces an ACTIVE DRAFT (readable via H3/H4), never a committed persona; the same run with `--commit-directly` produces a committed persona identical (modulo timestamps) to what the pre-epic skill would have produced; `sourceSummary` is present and non-empty on every proposed draft, bounded by the documented cap (never a full-repo dump).

---

## H7: Personas Panel Redesign

**What:** The actual UI build-out — a new structural shell, the re-integrated layer-stack section, and a unified draft review/approve surface absorbing the old create/edit form — built against whichever of H1's 3 synthesized options is selected.
**Why:** Ask 1's stated goal (design-discussion.md §1) — the heavy UI/UX lift itself. Depends structurally on H1: building this before H1 completes would mean building against ad-hoc judgment instead of the actual multi-lens-informed synthesis the operator explicitly asked for.

**Components:**
1. **Shell (pu-10):** the new panel structure/navigation per H1's chosen option, replacing the current single flat table + single flat form (research-brief.md §1) — still reading the same `GET /persona`/`GET /persona/:tier/:scopeId` routes underneath (no data-model change at this layer, pure view rebuild).
2. **Layer-stack re-integration (pu-11):** the existing pw-04 layer-stack section carried into the new shell, with copy/labeling that renders whatever `GET /layers` actually returns today rather than hard-coding the sibling epic's not-yet-shipped 0-4 numbering (design-discussion.md OQ1) — a documented, deliberate defensive posture, not an oversight.
3. **Draft review/approve UI (pu-12):** the new surface consuming H3's draft routes — lists active drafts (agent-proposed and human-authored alike, design-discussion.md §9 #4), shows a draft's proposed content plus its `sourceSummary` when present (the concrete UI expression of lens 4, agent-provenance/trust-calibration), supports inline edits, and Approve/Discard actions. pw-17's existing create/edit form is retargeted to `POST /persona/draft/:tier/:scopeId` instead of the real write route — one review/approve surface for both authoring paths, not two.

**Cross-layer dependency:** pu-10 depends on H1. pu-11 depends on pu-10 (extends its shell). pu-12 depends on H1 (design) and H3 (draft routes) and pu-10 (extends its shell).

**Acceptance criteria:** the shell matches H1's chosen synthesized option's documented layout/interaction decisions; the layer-stack section renders correctly against today's real `GET /layers` shape with no hard-coded level-numbering assumption; the draft review/approve UI lists and correctly renders both agent-proposed drafts (with `sourceSummary` shown) and human-typed drafts (without one), and Approve/Discard round-trip against H3's real routes with the panel reflecting the result immediately (no manual reload, matching every existing panel's convention).

---

## H8: Epic Close-Out — Full-Loop Regression + Design-Fidelity Review

**What:** (1) an end-to-end regression proving the complete loop — agent proposes via CLI (H4/H6) → draft is visible in the UI (H7, fetched via H3) → human edits and approves via the UI → the real persona is committed via the unchanged real write primitive → the panel reflects it immediately; (2) a design-fidelity review checking the shipped UI (H7) against H1's chosen synthesized option.
**Why:** Mirrors the wizard epic's own closing pattern (pw-14/pw-16/pw-17's "closes the loop" proofs) — this epic's actual release-gate claim (design-discussion.md §1) is the full crawl→propose→review→approve→commit loop working for real, not each piece in isolation. The design-fidelity check closes the loop on ask 1 concretely (a checked claim, not just an asserted one).

**Components:**
1. **Full-loop e2e (pu-13):** builds on H5's individual transport proofs and H6's regression, adding the one assertion neither alone provides — a real draft proposed through the CLI is genuinely visible and actionable through the browser UI, and a real browser-side approval genuinely produces the same committed artifact the CLI-only path (H4/H5) already proved.
2. **Design-fidelity review (pu-14):** a review pass (this repo's own `/design-review` conventions, or an equivalent lighter single-dispatch check) comparing the shipped Personas panel/draft-review UI against H1's chosen option's wireframe/brief — verifying the "heavy UI/UX lift" actually landed as designed, not just as implemented.

**Cross-layer dependency:** pu-13 depends on H5 (pu-06), H6 (pu-09), and H7's draft review/approve component (pu-12). pu-14 depends on H7's full build-out (pu-12) but not on pu-13 — the two checks are independent axes (functional correctness vs. design fidelity) and can run in parallel once pu-12 lands.

**Acceptance criteria:** pu-13's full loop passes against a real subprocess-spawned server (no mocked transport boundary); pu-14 produces a written comparison against H1's artifacts, explicitly noting any deviation and whether it's accepted or needs a follow-up.

---

## Capability Dependencies

```
H1 (Design-exploration pass: 3 options -> 7 lenses -> 3 synthesized options)
  └─→ H7.pu-10 (UI shell)
        └─→ H7.pu-11 (layer-stack re-integration)
  └─→ H7.pu-12 (draft review/approve UI) ←── also depends on H3, pu-10

H2 (Draft persona store)
  ├─→ H3 (Draft HTTP routes)
  │     └─→ H7.pu-12 (draft review/approve UI)
  └─→ H4 (Draft write primitive: CLI -> skill-harness -> MCP, strictly
          sequential, same shape as the wizard epic's H4)
        ├─→ H5 (Draft transport-integration tests) ←── also depends on H3
        └─→ H6 (Interview skill extension: bounded crawl + draft-first
                default + regression)

H5, H6, H7.pu-12 ─→ H8 (Full-loop e2e regression + design-fidelity review)
```

- H1 and H2 have no dependency on each other and can be staffed in parallel — same "two independent starting points" shape the wizard epic's Slice 1 ∥ Slice 2 already established.
- H3/H4 both terminate on H2's store functions directly, neither depends on the other's transport code (same non-dependency the wizard epic's H2/H4 already established for the real store).
- H7's three components form a strict internal chain (pu-10 → pu-11; pu-10 & H1 & H3 → pu-12) but the whole of H7 depends on H1 completing first, not on H2-H6.
- H8 is the true convergence point — it cannot start until both tracks (H2-H6's backend/skill chain and H1/H7's design/UI chain) have each independently proven their own piece.

---

## Cross-Cutting Concerns

### Draft-store leak prevention (the epic's own explicit, load-bearing risk)
Every component in H2/H3/H4 above is written to satisfy design-discussion.md's core guarantee by construction: drafts live at a structurally separate root (`~/.mnemosyne/persona-drafts/`) that `getPersonaContent`/`sync.ts` never read from, so there is no runtime filter to forget — worth re-verifying at code-review time per story, since it would be easy to accidentally point a new list/read helper at the wrong root "to save a duplicate function."

### No second write path (carried forward from the wizard epic's own risk table)
Approval (H3) and every draft-transport wrapper (H4) call the SAME `writeGlobalPersona`/`writeRepoLocalPersona`/H2 store functions directly — no re-implemented validation or locking anywhere in this epic's new code, the identical principle Epic 1/2 held throughout.

### CORS (already solved, reused, not re-solved)
All new HTTP routes (H3) reuse `applyPersonaCors()` and the existing `OPTIONS /persona/*` preflight handler unchanged — the wizard epic already paid the cost of discovering and fixing the real preflight gap (pw-17's note-on-completion); this epic must not reopen or duplicate that work.

### Sibling-epic forward-compatibility (design-discussion.md OQ1)
H7.pu-11's layer-stack UI section is written defensively against today's `GET /layers` shape, never the sibling `mnemosyne-memory-levels` epic's not-yet-shipped 0-4 numbering — flagged explicitly rather than silently assumed, and expected to need a follow-up once that epic ships (out of this epic's own scope).

---

## Horizontal Plan Metadata
- **Epic:** mnemosyne-persona-ux
- **Capabilities:** 8 (Design-exploration pass, draft store, draft routes, draft write primitive×3 transports, draft transport tests, interview-skill extension, Personas panel redesign, epic close-out)
- **Critical path:** H2 → H4 → H6 running independently alongside H1 → H7's early components, both tracks converging at H8; H3 sits alongside H4 (both depend only on H2) and feeds both H5 and H7.pu-12.
- **Real gap surfaced by this pass, not previously called out:** the draft-route/generic-route ordering interaction in `server.ts` (design-discussion.md §3b) — a 3-segment `/persona/draft/:tier/:scopeId` path would already be harmlessly rejected by the existing 2-segment guard today, but explicit dispatch ordering is the real guarantee, not an implicit reliance on that guard never changing shape.
