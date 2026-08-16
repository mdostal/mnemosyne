# Vertical Plan: mnemosyne-persona-wizard

## Epic Context
**ID:** mnemosyne-persona-wizard (Epic 2 of 2)
**Horizontal Capabilities:** H1 Listing primitives, H2 `/persona/*` routes, H3 UI panel, H4 Write primitive×3 transports, H5 Transport-integration tests, H6 Interview skill, H7 remember()-scope mapping (see `docs/horizontal-plan.md`)
**Operator-confirmed top-level order (OQ6, not re-litigated):** Slice 1 (view-only UI) → Slice 2 (write primitive) → Slice 3 (interview skill) → Slice 4 (UI write form).

This plan does not reopen the 4-slice order. It cuts real sub-slice boundaries *within* each of the 4, where the underlying code's actual structure warrants it, and states the justification for each cut explicitly — the same pattern Epic 1's vertical plan used ("locking and dry-run are not a later slice, they gate the first real write").

---

## Three Decisions That Set the Sub-Slice Boundaries

**Decision 1 — CORS/cross-origin reachability is not later polish; it gates Slice 1's UI sub-slice, the same way Epic 1 treated locking as gating its first real write.**
Horizontal-plan.md's Cross-Cutting Concerns section identifies a load-bearing gap the design discussion's "accepted tradeoff" language (§3c) didn't actually resolve: the UI is served from `src/server.mjs` (port 8477) and the new routes live on `lib/mnemosyne/server.ts` (port 3141, `MNEMOSYNE_PORT`) — two different origins. A relative `fetch()` (every existing call in `ui/app.js` is relative) silently hits the wrong server; an absolute cross-port `fetch()` gets blocked by the browser unless `lib/mnemosyne/server.ts` sends `Access-Control-Allow-Origin` (it currently sends no CORS headers at all, `server.ts:69-76`). This is a real, undecided implementation detail, not a solved problem — it must be resolved and shipped as part of Slice 1's backend work, before any UI code is written against it, or Slice 1's own "genuinely working, testable state" bar isn't met (a panel that can never complete a fetch isn't working). **Real call: add `Access-Control-Allow-Origin` headers to `lib/mnemosyne/server.ts`'s responses scoped to the UI's known origin, rather than a same-origin proxy route on `src/server.mjs`** — a proxy would mean `src/server.mjs` (plain-`node`-launched, cannot import `.ts`) shelling out or re-implementing the fetch, which re-opens exactly the "duplicated logic" risk the design discussion already rejected once for the routing decision itself (OQ1). CORS headers on the TS-native server are the smaller, more consistent change.

**Decision 2 — Slice 2's write primitive ships CLI-first, then skill-harness, then MCP: not a preference, a real dependency chain.**
Horizontal-plan.md H4.4 traces the actual import graph: `bin/mnemosyne-mcp.mjs`'s `persona_sync`/`persona_seed`/`persona_show` tools import `personaSyncAction`/`personaSeedAction`/`personaShowAction` directly from `bin/mnemosyne-skill-helper.mjs` (`mnemosyne-mcp.mjs:60-62`); those functions in turn subprocess-exec `bin/mnemosyne-persona.mjs` via `personaCliRun()` (`mnemosyne-skill-helper.mjs:239-282`). This is not three independent, parallelizable transport wrappers around one call the way Epic 1's H6 vertical plan might imply "wire three things at once" — **the MCP tool cannot exist as working code before the skill-harness action exists, which cannot exist as working code before the CLI verb exists.** Unlike Epic 1 (which had no MCP/skill-harness surface yet to compare against — those shipped as a v0.7.0 follow-on, per design-discussion.md's prelude), this epic's write primitive is being added to a codebase that already established this exact layering for `sync`/`seed`/`show`. The new verb should follow the same real shape, not invent a different one.

**Decision 3 — Slice 3's `remember()`-scope mapping (H7) and the interview's question-sequencing mechanics (H6, minus crawl-and-feed) are independent and should be built in parallel, converging only at the "crawl and feed" step.**
H7 (the scope-mapping decision) has no code dependency on H6's kickoff-protocol-grounded question-sequencing, and H6's mechanics — adaptive skip, persist-on-skip, non-blocking hard-fail, writing a valid `Persona` via Slice 2's primitive — have no dependency on `remember()` at all. Forcing them into one sequential sub-slice would make Slice 3, already flagged as "likely the largest and least-precedented" (design-discussion.md §7), needlessly serial. Splitting them lets the interview's core value (a working, testable authoring flow) land and be validated independently of the harder, less-precedented scope-mapping design work.

---

## Slice 1: View-Only UI (3c-i)

**Goal:** An operator can open the standalone UI and see every existing persona (tier/scopeId/displayName, pointer-only `parentRefs`) and the active layer stack, via new `GET /persona/*` routes on `lib/mnemosyne/server.ts`. Zero dependency on anything else new in this epic (design-discussion.md §5) — the lowest-risk, first-to-ship slice per OQ6.

### Sub-slice 1a: Backend — listing primitives + GET routes + CORS
**Why cut here:** Independently real and testable without any browser involvement — `curl`/subprocess tests (extending `test/http-api.mjs`'s existing "spawn `lib/mnemosyne/server.ts`, hit it over real HTTP" convention) can prove this sub-slice complete on its own. It also carries the one piece of genuinely new architectural risk in this slice (Decision 1's CORS gap), so it should land — and be provably correct — before any UI code is written against it, matching Epic 1's own "the thing that gates real use ships with the first real increment, not after" posture.

- H1 (full): `listGlobalPersonas`/`listRepoLocalPersonas`.
- H2 (GET subset): list + read routes on `lib/mnemosyne/server.ts`; `Access-Control-Allow-Origin` header addition (Decision 1); confirm `GET /layers` (already shipped) is reused as-is for the layer-stack data, not duplicated.
- Test extension of `test/http-api.mjs`'s subprocess-spawn convention: new routes return correct data against a populated store and an empty one; a real cross-origin browser-equivalent check (e.g. asserting the CORS header is present) so Sub-slice 1b isn't the first place this gets verified.

**Delivered value (standalone):** every persona/layer-stack data point the UI needs is fetchable over real HTTP, from the correct origin, with a header a browser will actually accept — even before any UI code exists to consume it. A CLI/`curl` user already gets full read access to "what personas exist and what layer stack is active" through this sub-slice alone.

### Sub-slice 1b: UI panel — view rendering
**Why cut here:** Pure DOM/rendering work with zero new business logic, dependent only on 1a's routes existing and being reachable. Matches every existing panel's own shape (`loadLanes()`/`loadGraph()`) — low-risk, mechanical once 1a is proven.

- H3 (view-only subset): `<section class="panel panel-wide" id="personas">` in `ui/index.html`; `loadPersonas()` in `ui/app.js`, wired into `refreshAll()`; persona list table + layer-stack section, kept visually and structurally distinct (research-brief.md §6); `parentRefs` rendered as named pointers only, never fetched-and-inlined.
- Level 0 stays view-only (§3d) — carried through, no new code needed beyond "don't add an edit affordance."

**Delivered value:** the actual operator-facing feature — open `/ui`, see personas and the layer stack.

### Stories
1. Listing primitives (`listGlobalPersonas`/`listRepoLocalPersonas`) — complexity: low.
2. GET `/persona/*` routes + CORS header + route-level tests — complexity: medium (the CORS piece is the real risk here, not the route logic itself).
3. Personas panel markup + `loadPersonas()` (persona list, pointer-only `parentRefs`) — complexity: medium.
4. Layer-stack visibility section (reuses `GET /layers`, Level 0 pointer, wired into `refreshAll()`) — complexity: low.

**Dependencies:** 1 → 2 → (3, 4 in parallel, both depend only on 2).
**Story count:** 4 (within the design discussion's 3-5 band).

---

## Slice 2: Write Primitive Across 3 Transports (3a)

**Goal:** `persona_create`/`persona_write` exists and works, end-to-end and cross-transport-verified, at CLI, skill-harness, and MCP — closing Epic 1's one deferred gap.

### Sub-slice 2a: CLI
**Why cut here (Decision 2):** the canonical implementation layer — nothing downstream can be built before this exists.
- H4 (CLI component): new `mnemosyne persona create` (naming: design discussion itself uses `persona_create`/`persona_write` interchangeably without settling one — flagged as unresolved in this plan's ambiguity list below; this plan uses `create` as a placeholder) subcommand in `bin/mnemosyne-persona.mjs`, imports `writeGlobalPersona`/`writeRepoLocalPersona` directly, added to `run()`'s dispatcher.
- H5 (CLI component): extends `test/persona-cli.mjs`'s existing AC-tagged convention with `AC-create` (arg parsing, successful write, validation-rejection surfaced as non-zero exit).

**Delivered value (standalone):** an operator (or, later, Slice 3's interview skill, once it exists) can already author a persona from a terminal — the real functional gap Epic 1 deferred is closed here, before either other transport exists.

### Sub-slice 2b: skill-harness
**Why cut here:** depends on 2a (subprocess-execs the CLI verb, same shape as existing `personaSyncAction`/etc.) — cannot be built first.
- H4 (skill-harness component): `personaCreateAction` in `bin/mnemosyne-skill-helper.mjs`, added to `SIMPLE_ACTIONS`; new row in `skills/mnemosyne-standalone/SKILL.md`'s action table.
- H5 (skill-harness component): new test (no existing coverage — `test/skill-harness.mjs` explicitly excludes persona actions today) following `test/persona-cli.mjs`/`test/mcp-server-persona.mjs`'s real-subprocess, fake-`$HOME` convention.

### Sub-slice 2c: MCP
**Why cut here:** depends on 2b (imports the skill-harness action function directly) — cannot be built before 2b, and gains nothing by being attempted in parallel with it.
- H4 (MCP component): `persona_create`/`persona_write` tool in `bin/mnemosyne-mcp.mjs`, wraps `personaCreateAction` via `wrapAction()`.
- H5 (MCP component): extends `test/mcp-server-persona.mjs`'s real `StdioClientTransport` convention.

### Sub-slice 2d: Cross-transport round-trip
**Why cut here:** a qualitatively different assertion from 2a/2b/2c individually — each of those proves "this transport's write works in isolation"; this proves the risk-table guardrail that all three call the *same* underlying functions rather than three write paths that look alike but have quietly diverged. Also the natural place to prove `withLock` holds under a genuinely cross-transport race (not just same-transport, which Epic 1 already covered).
- H5 (integration component): write via transport A, read back via transport B (`show`/H2's GET route), for every meaningful (A, B) pair; a concurrent-write test with two *different* transports racing the same target file.

### Stories
1. CLI `persona create` verb + `AC-create` tests — complexity: medium.
2. skill-harness `personaCreateAction` + SKILL.md table row + new subprocess test — complexity: medium.
3. MCP `persona_create` tool + extended `mcp-server-persona.mjs` test — complexity: low (thin wrap once 2 exists).
4. Cross-transport round-trip integration test + cross-transport concurrency test — complexity: medium.

**Dependencies:** 1 → 2 → 3 → 4 (strictly sequential per Decision 2 — no parallel track here, unlike Slice 1's 3/4 split).
**Story count:** 4 (within the design discussion's 4-6 band).

---

## Slice 3: Interview Skill (3b)

**Goal:** A new Claude Code skill, grounded in `kickoff-protocol.md`'s Phase 3b pattern, that interviews an operator, produces a valid `Persona` written via Slice 2's primitive, and (once H7 is resolved) triggers real `remember()` calls as "initial crawl and feeding." Largest, least-precedented slice — no clean Epic-1 analog to size against (design-discussion.md §7).

### Sub-slice 3a: `remember()`-scope mapping (H7)
**Why cut here (Decision 3):** no dependency on 3b's mechanics; the harder, less-precedented design decision, worth isolating so it doesn't block the interview's core mechanics from landing and being validated.
- Resolve OQ2: pick and implement a concrete `{tier, scopeId}` → `remember()`-scope mapping (see horizontal-plan.md H7's candidate option set — this plan does not pre-decide which). Document the rationale durably (code comment or design-discussion addendum), per the design discussion's explicit "a real decision, not an assumption" bar.

### Sub-slice 3b: Interview mechanics + persona authoring
**Why cut here (Decision 3):** independently valuable and independently testable without `remember()` — an interview that correctly authors a `Persona` record (adaptive skip, persist-on-skip, non-blocking hard-fail, writes via Slice 2) is real, working product on its own, even before it does any memory indexing.
- H6 (minus crawl-and-feed): the skill itself, grounded in kickoff-protocol.md:756-820's adaptive question set / persistence rule / non-blocking hard-fail / structured-output-schema shape; works at both repo-spinup-lifecycle moments (global-tier pre-repo, `code-architect` post-repo), parameterized by tier/store per design-discussion.md §3e; output is a `Persona` written through Slice 2's write primitive.

### Sub-slice 3c: Crawl-and-feed wiring
**Why cut here:** the actual convergence point of 3a and 3b — cannot be built before either sub-slice above exists, and is genuinely the epic's stated release-gate requirement ("triggers real `remember()` writes as the 'initial crawl and feeding'" — design-discussion.md §1).
- Wire real `remember()` calls into the completed interview flow, using 3a's resolved mapping to scope each call correctly.
- Tests proving at least one real `remember()` call fires per completed interview, correctly scoped.

### Stories
1. `remember()`-scope mapping: decision + resolver implementation + documentation — complexity: medium (the decision itself is the risk, not the code).
2. Interview skill: adaptive question sequencing (skip/persist/hard-fail), grounded in kickoff-protocol.md — complexity: high (genuinely new territory for this codebase, per research-brief.md §5).
3. Interview skill: structured output → `Persona` record → Slice 2 write primitive, both lifecycle moments (pre-repo global, post-repo `code-architect`) — complexity: medium.
4. Interview skill: skip-all / maximally-skipped-still-valid regression test, non-blocking hard-fail proof — complexity: low.
5. Crawl-and-feed: `remember()` wiring using story 1's mapping — complexity: medium.
6. Crawl-and-feed: end-to-end test (interview → persona written → `remember()` call(s) fired, correctly scoped) — complexity: medium.

**Dependencies:** (1, 2 in parallel per Decision 3) → 3 → 4 → 5 (needs 1 and 3/4 done) → 6.
**Story count:** 6 — above the design discussion's rough sizing note (no band was given here, only "likely the largest... no clean Epic-1 analog to size against"), consistent with that flagged uncertainty rather than contradicting it.

---

## Slice 4: UI Write Form (3c-ii)

**Goal:** An operator can create/edit a persona directly in the browser UI, via new `POST /persona/*` routes on the same `lib/mnemosyne/server.ts`. Depends on Slice 2 (write primitive functions — already real from Epic 1, but Slice 2 is what proves the transport-parity bar this epic holds itself to) and Slice 1 (the panel this form extends).

### Sub-slice 4a: Backend — POST routes
**Why cut here:** same justification as Sub-slice 1a — independently testable via the same `test/http-api.mjs`-style subprocess convention, and reuses 1a's already-solved CORS header rather than needing a second design pass.
- H2 (POST subset): `POST /persona/*` on `lib/mnemosyne/server.ts`, wraps `writeGlobalPersona`/`writeRepoLocalPersona` directly; validation errors (mandate smuggling, tier mismatch) surface as 400s via the existing `badRequest`/`sendJson` convention.
- H5 extension: this is the natural point to complete the "4th transport" round-trip story Sub-slice 2d left open (horizontal-plan.md H5's cross-layer-dependency note) — write via HTTP, read via CLI/MCP/skill-harness and vice versa.

### Sub-slice 4b: UI form
**Why cut here:** pure form/DOM work, depends only on 4a's route existing; follows the `add-lane-form` convention already established in this same file (`ui/app.js:140-172`), so it's mechanical once 4a is proven.
- H3 (write-capable subset): create/edit form in the Personas panel, `form-row` structure matching `add-lane-form`, submit handler POSTs to 4a's route, `setStatus()` for pass/fail, re-calls `loadPersonas()` on success (Slice 1's `loadPersonas()` — not rebuilt, reused).

### Stories
1. `POST /persona/*` routes + validation-error surfacing + route-level tests — complexity: medium.
2. 4th-transport (HTTP) round-trip integration test, completing Sub-slice 2d's deferred scope — complexity: low (mechanical extension of an already-built test).
3. Create/edit form in the Personas panel + submit handler + `loadPersonas()` re-invocation on success — complexity: medium.

**Dependencies:** 1 → (2, 3 in parallel — 2 needs only 1; 3 needs only 1).
**Story count:** 3 (within the design discussion's 2-4 band).

---

## Vertical Slice Summary

| Slice | Sub-slices | Stories | Working Product Increment |
|-------|-----------|---------|---------------------------|
| 1 (view-only UI) | 1a backend (listing + GET routes + CORS), 1b UI panel | 4 | Operator sees every persona + the active layer stack in the browser, over a correctly cross-origin-reachable route. |
| 2 (write primitive) | 2a CLI, 2b skill-harness, 2c MCP, 2d cross-transport round-trip | 4 | `persona_create` works identically at all 3 transports, proven not to have diverged, proven safe under cross-transport concurrent writes. |
| 3 (interview skill) | 3a remember()-scope mapping, 3b interview mechanics, 3c crawl-and-feed | 6 | A grounded, kickoff-protocol-style interview authors a real persona and indexes real memory, correctly scoped, at both repo-spinup-lifecycle moments. |
| 4 (UI write form) | 4a backend (POST routes), 4b UI form | 3 | Operator creates/edits a persona directly in the browser; the 4th transport (HTTP) is proven consistent with the other 3. |

**Total stories:** 17 (4 + 4 + 6 + 3)

**Critical path:** Slice 1 and Slice 2 have no dependency on each other and could in principle be staffed in parallel (Slice 1 depends only on H1/H2-GET/H3; Slice 2 depends only on H4/H5, which are already-existing Epic 1 functions plus new transport wrappers) — but Slice 3 depends on Slice 2 (needs H4 to write into) and Slice 4 depends on both Slice 1 (extends its panel) and Slice 2 (needs H4's parity bar proven, and reuses its POST-route validation shape). OQ6's operator-confirmed sequential order (1→2→3→4) is not contradicted by this — it is a safe, valid serialization of a graph that has one genuine parallel opportunity (1 ∥ 2) the operator may choose to exploit if staffing allows, without needing to reopen the 4-slice decision itself.

---

## Ambiguities Not Resolved by the Design Discussion (flagged, not guessed past)

1. **Verb naming: `persona_create` vs. `persona_write`.** The design discussion itself uses both names interchangeably (§3a: "`persona_create` (or `persona_write`)") without settling one. This plan uses `create` as a placeholder in story text; Slice 2's first story should settle this before the CLI subcommand ships, since CLI/MCP/skill-harness all need to agree on one name.
2. **Exact `/persona/*` route path shape** (e.g. `GET /persona/global` vs. `GET /persona?tier=...&scopeId=...` vs. `GET /persona/:tier/:scopeId`) is left as an implementation choice for Sub-slice 1a's first story — the design discussion never specifies a shape, only that the routes must wrap the same H1/Epic-1 functions.
3. **CORS vs. proxy for cross-origin reachability** (Decision 1 above) — genuinely undecided by the design discussion's OQ1, which resolved *which server* but not *how the browser reaches it*. This plan recommends CORS headers on `lib/mnemosyne/server.ts` and states why, but this is this plan's own call, not an operator-confirmed resolution — worth explicit operator sign-off before Sub-slice 1a's implementation, the same way OQ1 itself got sign-off.

---

## Resolved Ambiguities (orchestrator judgment call, not re-escalated — none rise to the level of a genuine architectural fork; all are reversible implementation details)

1. **Verb naming: `persona_create`.** Reads as the natural CRUD verb for authoring a NEW persona, distinct from `sync` (writes into a harness file) — used consistently across CLI (`mnemosyne persona create`), skill-harness (`personaCreateAction`/`persona-create`), and MCP (`persona_create`).
2. **Route path shape:** `GET /persona` (list — global tiers by default; `?repo=<path>` adds/switches to that repo's `code-architect` personas), `GET /persona/:tier/:scopeId` (read one; repo-local reads need `?repo=<path>`), `POST /persona/:tier/:scopeId` (create one; repo-local writes need `repo` in the request body or query, same convention as the GET).
3. **CORS, not a proxy** — confirmed per the vertical plan's own Decision 1 reasoning: `lib/mnemosyne/server.ts` sends `Access-Control-Allow-Origin` scoped to the UI's known origins (`http://127.0.0.1:8477`, `http://localhost:8477`) rather than routing through a same-origin proxy on `src/server.mjs`, which would re-open the "duplicated logic" risk the routing decision (OQ1) already rejected once.

## Vertical Plan Metadata
- **Epic:** mnemosyne-persona-wizard
- **Slices:** 4 (operator-confirmed order), 11 sub-slices total
- **Total Stories:** 17
- **Sub-slicing decisions requiring justification, addressed above:** (1) CORS/cross-origin reachability gates Slice 1's UI sub-slice, not deferred; (2) Slice 2's write primitive is CLI→skill-harness→MCP, strictly sequential per the real import graph, not three parallelizable transports; (3) Slice 3's `remember()`-scope mapping and interview mechanics are independent and parallelizable, converging only at crawl-and-feed.
