# Design Discussion — mnemosyne-persona-wizard (Epic 2 of 2)

*Revised after one collaborative-review pass (architect-lens + TPM-lens, both flagged real issues — see inline notes marked **[review]**). Architect-lens found a genuine, unaddressed feasibility gap in §3c's original UI-routing plan; TPM-lens found a fourth, independent, lower-risk slice hiding in the draft's own evidence. Both are folded in below, and the resulting server-architecture choice is surfaced as a real open question (§6, OQ1) rather than decided unilaterally.*

## 0. Prelude

No PRIOR DECISIONS/NORTH STAR blocks found. This epic was explicitly deferred by Epic 1 (`mnemosyne-persona-foundation`, shipped v0.6.0, MCP/skill-harness coverage shipped v0.7.0) — see that epic's design-discussion.md header and §5.

## 1. Goal

Build the LLM-interview wizard that authors real persona content (an operator converses with whatever agent is already running — Claude Code, Codex, Gemini — to define "what does this tier/persona know"), triggers real `remember()` writes as the "initial crawl and feeding," and a UI to view existing personas, walk the memory layer stack, and see what's assigned to what. This is the operator's stated release gate for the whole persona system: "then we are pretty solid for prepping it for release" (from Epic 1's own originating conversation).

Explicitly IN scope per the operator's repo-spinup lifecycle description: the wizard must work at both moments that lifecycle implies — authoring global-tier (company-director/project-orchestrator) personas *before* a repo exists (initial ideation), and authoring repo-local (code-architect) personas *once* a repo exists (after Hive kickoff builds it out).

Explicitly OUT of scope: the multi-repo/multi-agent rollout question (unchanged from Epic 1's framing) and any change to Epic 1's already-shipped, already-tested storage/dispatch/locking mechanics — this epic builds *on top of* that foundation, not into it.

## 2. What exists today (see research-brief.md for full detail)

- **The full persona data model is real and tested** (Epic 1): two-tier storage, `getPersonaContent` dispatch with query-up pointer rendering, locking, seed/migration, and a `sync`/`seed`/`show` CLI now also exposed as MCP tools and skill-harness actions (v0.7.0).
- **Confirmed gap: no write primitive exists anywhere.** `writeGlobalPersona`/`writeRepoLocalPersona` (real, tested, TS-only) have zero CLI/MCP/skill-harness wrapper. This is the one gap Epic 1 explicitly deferred, and it's the wizard's core blocker — an interview with nowhere to write its output isn't useful.
- **No persona listing/enumeration primitive exists** in either store — a caller must already know the `(tier, scopeId)` pair to read one.
- **No `/persona/*` HTTP route exists** on `src/server.mjs` (the standalone UI's backend) — confirmed by reading the full route table. A UI panel needs new routes.
- **[review, architect-lens] `src/server.mjs` cannot host those routes as originally proposed.** It's launched via plain `node` (`package.json`'s `start` script) and has zero `.ts` imports today; `tsconfig.json`'s `noEmit: true` means a plain-`node` process cannot import a `.ts` module (the exact constraint `bin/mnemosyne-persona.mjs`'s own doc comment documents, which is why that CLI is `tsx`-launched instead). Persona's read/write functions are TS-only. The original "mirrors `/graph/*`" analogy doesn't hold — `/graph/*` wraps a `.mjs` file. **There is already a second, separate TS-native HTTP server** at `lib/mnemosyne/server.ts` (launched via `tsx`, `package.json`'s `start:client-api` script, a different port) that explicitly documents *not* sharing routes or process with `src/server.mjs`. This is a real architectural fork the UI section below surfaces as an open question rather than resolving unilaterally.
- **No interview/multi-turn pattern exists in this repo**, but a real, working precedent exists in the plugin-hive ecosystem this repo already depends on for its own planning: `kickoff-protocol.md`'s "Phase 3b: Discovery Questions" — adaptive-skip, persistence-rules-for-skipped-fields, non-blocking-hard-fail, structured-output-schema. Agent-driven prompt sequencing, not a bespoke chat backend — matches this epic's own likely approach exactly.
- **`remember()`'s two implementations use incompatible scope vocabularies**, and neither maps onto persona `{tier, scopeId}` today — this mapping doesn't pre-exist and needs a real design decision, not an assumption.
- **The "query up, never copy down" principle is already code-enforced** (Epic 1's `pf-12`) — nothing in this epic's likely scope needs to revisit it; a UI panel or interview flow authoring `parentRefs` writes into an already-validated, already-tested field.

## 3. Proposed approach

**3a. New write primitive first — closes Epic 1's one deferred gap.**
Add a `persona_create` (or `persona_write`) verb at every transport layer that currently has `sync`/`seed`/`show`: CLI (`bin/mnemosyne-persona.mjs`), skill-harness action, MCP tool. Thin wrapper over `writeGlobalPersona`/`writeRepoLocalPersona` — both already validate (`assertValidPersona`, rejects `mandateSections`), lock, and dispatch by tier via `PERSONA_STORE_BY_TIER`. No new business logic in the write path itself; this is pure surface-area parity with the read/sync verbs Epic 1 already shipped.

**3b. The interview is a new Claude Code skill, grounded in `kickoff-protocol.md`'s Phase 3b pattern, not invented from scratch.**
A human converses with whatever agent is already running. The skill's instructions sequence structured questions ("what does this tier know," "what should it explicitly NOT hold," "does it have a parent to query up to") mirroring kickoff's adaptive-skip / persist-on-skip / non-blocking-hard-fail shape. Output: a `Persona` record (via 3a's write primitive) plus, per the operator's "initial crawl and feeding" requirement, real `remember()` calls indexing whatever source material (docs, existing context) the interview surfaced. **Open question 1 below**: how a persona's `{tier, scopeId}` maps to a `remember()` scope, since no such mapping exists today.

**3c. UI: split into a read-only "view" panel (independent, ships first) and an optional write-capable extension (depends on 3a, only if actually wanted).**

**[review, TPM-lens]** The original draft bundled GET and POST `/persona/*` routes together and sequenced the whole UI after the write primitive (3a). On inspection, everything the *viewing* feature needs — listing personas, rendering a persona's `parentRefs` pointer-only (no copy-down in the UI, same guarantee `getPersonaContent` already provides), showing the active layer stack — is 100% read-only, and every read primitive it needs (`readGlobalPersona`/`readRepoLocalPersona`/`getPersonaContent`) already exists and is tested from Epic 1. Only a new listing primitive (`listGlobalPersonas`/`listRepoLocalPersonas`, a straightforward `readdir` over the store root — no schema change) and new **GET** routes are net-new. Nothing about this needs the write primitive (3a) or the interview (3b) to exist first. The original draft never described an actual "create a persona" UI form — it asserted a POST route without a UI feature that needs it.

**Revised split:**
- **3c-i (view-only, no dependency on 3a/3b):** a new `<section class="panel panel-wide" id="personas">` matching every existing panel's exact structure/CSS convention (research-brief.md §3), a `loadPersonas()` function wired into the existing `refreshAll()`, new `GET /persona/*` routes only, and the new listing primitives. Shows existing personas (tier/scopeId/displayName), pointer-only `parentRefs`, and the active layer stack (`mnemosyne.layers.json`/`MNEMOSYNE_LAYERS`) as its own clearly-labeled section — a genuinely different data model from persona content (research-brief.md §1/§3 of Epic 1), never merged into the persona list.
- **3c-ii (write-capable, depends on 3a):** a "create/edit persona" form + `POST /persona/*` route. **RESOLVED (§6, OQ5): committed scope for this epic** — the operator confirmed persona creation/editing through the browser UI is wanted, not just via the interview skill or CLI/MCP.

**RESOLVED (operator sign-off, §6 OQ1): the new routes go on `lib/mnemosyne/server.ts`** (the already-TS-native, already-`tsx`-launched server), not `src/server.mjs`. Accepted tradeoff: the standalone UI (`ui/app.js`), which today talks only to `src/server.mjs`, will need to reach a *second* backend process/port for persona data. This avoids relaunching the zero-dep server or duplicating store logic as `.mjs` — both explicitly rejected in favor of this option.

**3d. Level 0 stays view-only in the UI, per Epic 1's own recommendation.**
Epic 1's design discussion recommended view-only-with-a-pointer-to-the-file given Level 0's global blast radius (one file affecting every repo/persona). Nothing in this epic's research changes that calculus — carrying the recommendation forward rather than relitigating it.

**3e. The repo-spinup lifecycle needs no new storage-level work — only the authoring flow, invocable at either lifecycle moment.**
Epic 1's two-store split (global personas existing independently of any repo; repo-local personas requiring one) already structurally supports "ideate at the company/project level before a repo exists, then author code-architect content once Hive kickoff builds the repo out." This epic's interview skill just needs to work correctly for both — parameterized by which tier/store it's authoring for — not build new lifecycle infrastructure.

## 4. Risks

| Risk | Mitigation |
|---|---|
| The interview skill invents its own question-sequencing mechanics instead of reusing kickoff-protocol.md's already-working shape, duplicating effort and diverging in quality/robustness. | Ground the skill's design explicitly in that reference (adaptive skip, persist-on-skip, non-blocking hard-fail, structured output schema) rather than starting from a blank page. |
| No established mapping from persona `{tier, scopeId}` to a `remember()` scope — a wizard that guesses wrong here writes memory into the wrong lane silently. | Flagged as open question 1 below — needs a real decision, not an assumption, before 3b ships. |
| A "list personas" UI panel implies enumeration, which doesn't exist today — adding it could tempt scope creep (search, filtering, pagination) beyond what's actually needed for v1. | Keep the new listing primitive to the minimum (`readdir` + parse, no search/filter/pagination) unless the operator asks for more. |
| Building `/persona/*` HTTP routes duplicates logic already correctly implemented three other times (CLI, MCP, skill-harness) if not done carefully. | The new routes should call the exact same `writeGlobalPersona`/`writeRepoLocalPersona`/`readGlobalPersona`/`readRepoLocalPersona`/list functions directly — no re-implementation, same principle Epic 1 held throughout (research-brief.md §1). |
| This epic, like Epic 1 before splitting, bundles several genuinely separable capabilities (write primitive, interview skill, UI) that don't all need to land together. | See the revised 4-slice ordering in §6/§7 — 3c-i (read-only UI) has zero dependency on 3a and can ship first; 3a, 3b, and 3c-ii each have their own real dependency chain, not a false "do everything together" bundle. |
| **[review, architect-lens] The write primitive (3a) adds three independent, never-before-exercised transport wrappers (CLI arg parsing, MCP tool schema validation, skill-harness action dispatch) around the same write call — none of which Epic 1's existing unit tests cover, since those exercised the TS store functions directly, not through a transport.** | 3a needs its own "write-then-read round-trip through all 3 transports" integration story, comparable in spirit (though lower risk in kind) to Epic 1's pf-05 real-fixture integration work — not assumed free just because the underlying store functions are already tested. |
| **[review, architect-lens] If 3c-ii (UI write) ships, it becomes a fourth concurrent write-capable transport alongside CLI/MCP/skill-harness.** | `withLock` is already file-scoped/advisory and already handles cross-transport races (Epic 1's `pf-03`) — no new locking design needed, just confirm the new transport goes through the same `writeGlobalPersona`/`writeRepoLocalPersona` calls, never a parallel write path. |
| **[review, architect-lens] The original UI-routing plan (`/persona/*` on `src/server.mjs`) was infeasible as drafted** — `src/server.mjs` cannot import the TS store functions under its current plain-`node` launch. | Resolved via §3c's revision: three real options identified, tradeoffs noted, surfaced to the operator as OQ1 rather than guessed at. |

## 5. Dependencies

- Existing, unchanged: everything from Epic 1 (`persona.ts`, both stores, `sync.ts`, `lock.ts`, `getPersonaContent`'s dispatch/render, the `sync`/`seed`/`show` transports).
- New: `listGlobalPersonas`/`listRepoLocalPersonas` enumeration primitives (3c-i) — no dependency on anything else new in this epic.
- New: a server-routing decision (§3c, OQ1) — which server hosts the new `/persona/*` routes. Blocks 3c-i and (if built) 3c-ii.
- New: `persona_create`/`persona_write` at CLI + MCP + skill-harness (3a), plus a transport-integration test story (see risk table).
- New: the interview skill itself (3b), grounded in `kickoff-protocol.md`'s Phase 3b pattern. Depends on 3a (needs somewhere to write its output).
- New: a decision + implementation for persona-to-`remember()`-scope mapping (3b only, not 3a/3c — see OQ2's corrected scope below).
- New: a "Personas" read-only UI panel + layer-stack-visibility section (3c-i), matching existing UI conventions exactly. Depends only on the routing decision, not on 3a/3b.
- New, optional: a "create/edit persona" UI form + `POST /persona/*` (3c-ii). Depends on 3a. Only build if OQ4 below confirms it's wanted.

## 6. Open questions — resolved by operator sign-off

**OQ1 (server routing) — RESOLVED: add the new `/persona/*` routes to `lib/mnemosyne/server.ts`** (the already-TS-native, already-`tsx`-launched server), not `src/server.mjs`. The standalone UI will need to reach two backend processes/ports — accepted tradeoff, operator's explicit choice over relaunching `src/server.mjs` via `tsx` or duplicating store-read logic as `.mjs`.

**OQ2 (remember()-scope mapping)** — still open, scoped to Slice 3 (the interview) only; does not block Slices 1/2/4.

**OQ3 (3a's transport surface)** — accepted default: ships to all three transports (CLI/MCP/skill-harness) for parity with `sync`/`seed`/`show`.

**OQ4 (Level 0 visibility)** — accepted default: stays view-only in the new UI, carried forward from Epic 1.

**OQ5 (UI write form) — RESOLVED: build it now, as Slice 4, not deferred.** Operator confirmed persona creation/editing through the browser UI is wanted as part of this epic.

**OQ6 (slice split) — RESOLVED: proceed with the 4-slice order**, operator-confirmed:
- **Slice 1 = 3c-i** (read-only UI: view personas + layer stack via the new `lib/mnemosyne/server.ts` routes; zero dependency on anything else new in this epic; lowest risk; ships first).
- **Slice 2 = 3a** (write primitive across 3 transports + its own transport-integration tests).
- **Slice 3 = 3b** (interview skill; depends on Slice 2; needs OQ2 resolved as part of this slice's own planning).
- **Slice 4 = 3c-ii** (UI write form on the same `lib/mnemosyne/server.ts` routes; depends on Slice 2; now committed scope, not optional).

## 7. Scale assessment

**Confirmed: Large — comparable to or larger than Epic 1's original (pre-split) scope.** Rough per-slice sizing, by analogy to Epic 1's own Slice 1 (5 stories for repo-local store + locking + fixtures alone): **Slice 1 (view-only UI) in the 3-5 story range, Slice 2 (write primitive + transport tests) in the 4-6 story range, Slice 3 (interview skill) likely the largest and least-precedented — no clean Epic-1 analog to size against — Slice 4 (UI write form) 2-4 stories.** Rough bands for planning purposes, not commitments. Proceeding to full H/V delivery planning now that the operator has confirmed the routing decision, the write-form scope, and the slice order.
