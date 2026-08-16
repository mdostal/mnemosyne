# Horizontal Plan: mnemosyne-persona-wizard

## Epic Context
**ID:** mnemosyne-persona-wizard (Epic 2 of 2 — see `docs/design-discussion.md` §0/§1)
**Goal:** Close Epic 1's one deferred gap (no write primitive), build the LLM-interview wizard that authors real persona content and triggers `remember()` writes, and ship a UI to view + (new) edit personas and the active layer stack.
**Scale:** Large — comparable to or larger than Epic 1's pre-split scope (design-discussion.md §7).
**Operator-resolved, do not re-litigate:** routing decision (new routes on `lib/mnemosyne/server.ts`, OQ1), UI write form is committed scope (OQ5), 4-slice order (OQ6). This plan grounds each layer in real source and surfaces one load-bearing gap the design discussion's "accepted tradeoff" phrasing (§3c) glossed over: browser cross-origin reachability (see Cross-Cutting Concerns).

---

## H1: Listing Primitives

**What:** `listGlobalPersonas()` / `listRepoLocalPersonas(repoRoot)` — new enumeration functions, one per store.
**Why:** Confirmed gap (research-brief.md §1): "No `listGlobalPersonas`/`listRepoLocalPersonas` enumeration function exists in either store. A caller must already know the `(tier, scopeId)` pair." Slice 1's "view existing personas" panel cannot work without this — there is no way to discover what's on disk today.

**Components:**
1. `lib/mnemosyne/layer1/persona-store-global.ts` — `listGlobalPersonas(root = DEFAULT_GLOBAL_PERSONA_ROOT): { tier, scopeId }[]`. `readdir` over `<root>/<tier>/*.yaml` for each of the 3 global tiers (`PERSONA_STORE_BY_TIER`, persona.ts:44-49) — mirrors `globalPersonaPath`'s own location convention (persona-store-global.ts:61-67). Directory-missing is not an error (empty store), consistent with `readGlobalPersona`'s existing throw-only-on-missing-file posture (persona-store-global.ts:107-109) — a missing store root is a legitimately empty list, not a failure.
2. `lib/mnemosyne/layer1/persona-store-repo-local.ts` — `listRepoLocalPersonas(repoRoot): { scopeId }[]`. `readdir` over `<repoRoot>/.mnemosyne/personas/*.yaml` (`repoLocalPersonaPath`'s convention, persona-store-repo-local.ts:49-51). Tier is always `code-architect` (`REPO_LOCAL_PERSONA_TIER`, persona-store-repo-local.ts:30) — no tier discrimination needed in the listing itself.
3. Per the risk table's explicit scope guard (design-discussion.md:58): `readdir` + parse only. No search, filter, or pagination in this primitive — the routes/UI layers above it can add that later if actually needed.

**Cross-layer dependency:** Feeds H2's GET routes directly (Slice 1). No dependency on H4 (write primitive) or H6 (interview skill) — same "zero dependency on anything else new in this epic" status the design discussion already assigned to 3c-i (design-discussion.md §5).

**Acceptance criteria:** Both functions return an empty array (not a throw) against a store root/repo that has never had a persona written; return every persona present, tier-correct, against a populated store; no schema change to `Persona` itself.

---

## H2: `lib/mnemosyne/server.ts` — `GET`/`POST /persona/*` Routes

**What:** New HTTP routes on the operator-resolved server (`lib/mnemosyne/server.ts`), wrapping H1's listing primitives and Epic 1's existing read/write functions directly — no re-implementation.
**Why:** No `/persona/*` route exists anywhere today (research-brief.md §3, confirmed by grep of `src/server.mjs`'s full route table). `lib/mnemosyne/server.ts` is the operator-resolved host (design-discussion.md §3c review note, OQ1) because it is already TS-native and already `tsx`-launched (`package.json`'s `start:client-api` script) — `src/server.mjs` is plain-`node`-launched and cannot import `.ts` modules (`tsconfig.json`'s `noEmit: true`; the same constraint `bin/mnemosyne-persona.mjs`'s own doc comment documents, lines 105-112).

**Components:**
1. **GET routes (Slice 1):** `lib/mnemosyne/server.ts`'s existing route table (`server.ts:131-211`, dispatched by `route = "${req.method} ${url.pathname}"`) grows two new branches: list personas (wraps H1) and read one persona (wraps `readGlobalPersona`/`readRepoLocalPersona`, persona-store-global.ts:101-115 / persona-store-repo-local.ts:81-91). Both call the exact same functions Epic 1 already tested — per the risk table's explicit guardrail against a fourth re-implementation (design-discussion.md:59).
2. **Layer-stack visibility needs no new route.** `GET /layers` already exists (`server.ts:142-147`, wraps `client.getConfiguredLayers()`) and is exactly the "active layer stack" data Slice 1's UI section needs (research-brief.md §6: "a UI panel showing... the layer stack" is "a genuinely different data model" from persona content, never merged). This reduces H2's actual new-route surface to persona listing/reading only — the layer-stack section is a second `loadX()` call against an already-shipped route, not new backend work.
3. **POST routes (Slice 4):** wraps `writeGlobalPersona`/`writeRepoLocalPersona` (persona-store-global.ts:78-92 / persona-store-repo-local.ts:59-74) directly — both already validate (`assertValidPersona`), lock (`withLock`), and dispatch by tier (`PERSONA_STORE_BY_TIER`). Error shape follows the existing `badRequest`/`sendJson` convention (`server.ts:69-80`) — a thrown validation error (e.g. `mandateSections` smuggling, persona-store-global.ts's tier guard) becomes a 400, not a 500.
4. **New TS imports into `server.ts`.** Today this file imports only `MnemosyneClient` (`server.ts:27`) — zero Layer 1 imports. The new routes are this file's first import of `persona.ts`/`persona-store-global.ts`/`persona-store-repo-local.ts`. Since the process is already `tsx`-launched, this is a straightforward same-runtime import, not a new build-step dependency.

**Cross-layer dependency:** Depends on H1 (GET) and, for POST, on H4 (write primitive functions already exist — they do, from Epic 1; H2's POST routes don't depend on H4's *transport* work, only on the underlying store functions H4 also wraps). Blocks H3 (UI has nothing to fetch without these routes).

**Acceptance criteria:** `GET /persona/global` and `GET /persona/repo-local` (exact path shape is an implementation choice) return every persona H1 can see; `GET /persona/:tier/:scopeId` round-trips a hand-written persona byte-for-byte (modulo YAML formatting); `POST /persona/*` produces the same on-disk file `writeGlobalPersona`/`writeRepoLocalPersona` would produce via any other transport (H4) — verified by a direct filesystem read after the HTTP call, not just a 200 response.

---

## H3: UI Personas Panel — View-Only (Slice 1) and Write-Capable (Slice 4)

**What:** A new `<section class="panel panel-wide" id="personas">` in `ui/index.html` and a `loadPersonas()` function in `ui/app.js`, matching every existing panel's exact structure/CSS convention, extended in Slice 4 with a create/edit form.
**Why:** Named as its own capability in the design discussion (§3c-i/§3c-ii) — a genuinely separate UI feature from the 6 panels that exist today (Liveliness, Settings, Lanes, Search, Graph, Operations — `ui/index.html:16-194`).

**Components:**
1. **Panel markup** (`ui/index.html`), following the existing pattern exactly: `<h2>` + `<p class="panel-status" id="personas-status">loading…</p>` (matches e.g. `lanes-status`/`graph-status`, `ui/index.html:29-30`/`107`). Two sub-sections inside: a persona list (table, following the Lanes panel's `<table>`/`<tbody>` convention, `ui/index.html:31-41`) and a layer-stack display (new — no existing panel shows this).
2. **`loadPersonas()`** (`ui/app.js`), following the `loadLanes()`/`loadGraph()` pattern (`app.js:112-138`/`946-1021`): fetch H2's GET routes, render rows, `setStatus()` for pass/fail/loading states (`app.js:16-19`, the shared helper every panel already uses).
3. **`parentRefs` render as pointer-only**, never the parent's real content — the UI must reproduce `getPersonaContent`'s own guarantee (persona.ts:216-242, `buildParentContextSections`) rather than re-fetching and inlining the parent, which would silently reintroduce the copy-down risk the design discussion explicitly closes off (research-brief.md §6).
4. **Wired into `refreshAll()`** (`app.js:1152-1160`) — `Promise.all([loadLiveliness(), loadSettings(), loadLanes(), loadSearchScopes(), loadGraph(), loadReindexLanes()])` grows a 7th call, `loadPersonas()`. No auto-polling, matching this file's explicit "no auto-polling in v1" convention (`app.js:2-3`).
5. **Level 0 stays view-only** (§3d, carried forward from Epic 1's own recommendation) — the layer-stack section may show Level 0's path/existence but never a Level 0 edit form, in either Slice 1 or Slice 4.
6. **Slice 4 addition:** a create/edit form following the `add-lane-form` pattern exactly (`ui/index.html:43-59`, `app.js:140-172`) — `<form>` + `form-row` divs + a submit handler that POSTs (H2.3), reports pass/fail via `setStatus()`, and calls `loadPersonas()` again on success to reflect the write immediately (same "re-load after mutation" convention `add-lane-form`'s handler already uses, `app.js:166`).

**Cross-layer dependency:** Depends on H2 (routes to fetch/post against) and, transitively, H1 (listing). Slice 4's form additionally depends on H4 only insofar as H2.3's POST route calls the same underlying write functions — the UI never talks to the CLI/MCP/skill-harness transports directly.

**Acceptance criteria:** Panel renders existing personas (tier/scopeId/displayName) and the active layer stack as two clearly-labeled sections, never merged (research-brief.md §6); `parentRefs` render as named pointers only; Slice 4's form successfully creates/edits a persona and the panel reflects it without a manual page reload.

---

## H4: Write Primitive Across 3 Transports (Slice 2)

**What:** A new `persona_create`/`persona_write` verb at every transport layer that currently has `sync`/`seed`/`show` — CLI, MCP, skill-harness.
**Why:** Confirmed gap (research-brief.md §2): all three transports currently expose only read/sync tools; `writeGlobalPersona`/`writeRepoLocalPersona` have zero wrapper anywhere. An interview (H6) with nowhere to write its output isn't useful (design-discussion.md §3a).

**Components — grounded in the exact layering the existing `sync`/`seed`/`show` verbs already use, not a fresh design:**
1. **CLI** (`bin/mnemosyne-persona.mjs`) is the canonical implementation layer. It already imports `lib/mnemosyne/layer1/*.ts` directly (lines 117-124) and is `tsx`-launched (doc comment, lines 105-112) — the new subcommand imports `writeGlobalPersona`/`writeRepoLocalPersona` the same way `show` already imports `readGlobalPersona` (line 123). New subcommand: `mnemosyne persona create --repo <path> --tier <tier> --scope-id <id> --file <persona.yaml>` (or equivalent), added to `run()`'s dispatcher (lines 354-378) alongside the existing `seed`/`show`/`sync` branches.
2. **skill-harness** (`bin/mnemosyne-skill-helper.mjs`) does **not** implement new logic — it subprocess-shells to the CLI, exactly like `personaSyncAction`/`personaSeedAction`/`personaShowAction` already do via `personaCliRun()` (lines 239-282). A new `personaCreateAction`/`personaWriteAction` follows the identical shape, added to `SIMPLE_ACTIONS` (lines 286-298) and to `skills/mnemosyne-standalone/SKILL.md`'s action table (the existing skill is table-driven, one action per call — confirmed by its own doc comment).
3. **MCP** (`bin/mnemosyne-mcp.mjs`) does **not** implement new logic either — it imports and wraps the skill-helper's action function directly (`persona_sync`/`persona_seed`/`persona_show` import `personaSyncAction`/`personaSeedAction`/`personaShowAction` from `mnemosyne-skill-helper.mjs`, lines 60-62), via `wrapAction()` (lines 87-96) and `server.registerTool()` (lines 241-283 for the existing three). A new `persona_create`/`persona_write` tool follows the same registration shape.
4. **This chain is a real, load-bearing dependency, not an arbitrary ordering choice** — MCP's implementation literally `import`s the skill-helper's function; the skill-helper's implementation literally subprocess-execs the CLI binary. There is no code path by which the MCP tool could exist before the skill-helper action exists, nor the skill-helper action before the CLI verb exists. See the vertical plan for the sequencing this implies.

**Cross-layer dependency:** Depends on nothing new in this epic (Epic 1's write functions already exist, tested). Blocks H5 (nothing to integration-test without it) and H6 (interview skill needs somewhere to write).

**Acceptance criteria:** all three transports produce the identical on-disk YAML file for the same logical write (verified byte-for-byte, modulo transport-specific echo/logging); a rejected write (bad tier, `mandateSections` smuggling) surfaces as a clear non-zero-exit/`isError:true` result at every transport, never a silent no-op.

---

## H5: Transport-Integration Tests (Slice 2)

**What:** A write-then-read round-trip integration story across all 3 transports, plus per-transport tests extending the existing conventions.
**Why:** Architect-lens review finding (design-discussion.md Risks table): "adds three independent, never-before-exercised transport wrappers... none of which Epic 1's existing unit tests cover, since those exercised the TS store functions directly, not through a transport." Confirmed by inspecting `test/skill-harness.mjs`'s own doc comment: it explicitly covers `recall`/`remember`/`grep`/`reindex`/`graph-*` pass-throughs but has zero persona-action coverage today (persona actions are subprocess-shell, not `fetch()`, so they fall outside that file's "diff against a direct fetch()" test strategy, lines 1-21).

**Components — extending real, already-established conventions, not inventing a new test harness:**
1. **CLI-level** — extend `test/persona-cli.mjs`'s existing pattern (real subprocess spawn of `tsx bin/mnemosyne-persona.mjs ...`, doc comment lines 1-20 lays out the AC-tagging convention already used for `sync`/`seed`/`show`) with a new `AC-create` covering argument parsing, successful write, and validation-rejection (mandate smuggling, tier mismatch) surfaced as non-zero exit.
2. **MCP-level** — extend `test/mcp-server-persona.mjs`'s existing pattern (real `StdioClientTransport`, real spawned `bin/mnemosyne-mcp.mjs` child process, fake `$HOME` per lines 18-25) with the new `persona_create`/`persona_write` tool.
3. **skill-harness-level** — new coverage (none exists today, per this capability's "Why"): a test in the same spirit as `persona-cli.mjs`/`mcp-server-persona.mjs` (real subprocess, fake `$HOME`) exercising `personaCreateAction` directly and via `bin/mnemosyne-skill-helper.mjs create '{...}'`'s CLI dispatcher.
4. **Cross-transport round-trip** — the genuinely new assertion none of the above three individually prove: write via transport A, read back via transport B's `show`/`sync` (or H2's new GET route), for all meaningful (A, B) pairs. This is what actually verifies the risk-table guardrail that all three "call the exact same... functions directly — no re-implementation" (design-discussion.md:59) rather than three independently-plausible-looking write paths that have quietly diverged.

**Cross-layer dependency:** Depends on H4 existing at all three transports. Independently exercises H2's POST route too, if scoped to include the 4th transport (UI/HTTP) once Slice 4 lands — the design discussion's `withLock` risk note (Risks table, architect-lens) calls the UI "a fourth concurrent write-capable transport," so this round-trip story's real completion (across all 4 transports, not just 3) is a natural Slice 4 extension, not solely a Slice 2 deliverable.

**Acceptance criteria:** every (write-transport, read-transport) pair round-trips correctly; a concurrent-write test (two transports racing the same target file) proves `withLock` (Epic 1's `pf-03`, already file-scoped/advisory) holds across transports, not just within one — confirms the design discussion's explicit "no new locking design needed" claim (Risks table) rather than assuming it.

---

## H6: Interview Skill (Slice 3)

**What:** A new Claude Code skill implementing the multi-turn persona-authoring interview, grounded in `kickoff-protocol.md`'s "Phase 3b: Discovery Questions" pattern.
**Why:** No interview/multi-turn pattern exists in this repo (research-brief.md §5) — `skills/mnemosyne-standalone/SKILL.md` is "stateless, table-driven, one action per call" (confirmed by reading it directly). `kickoff-protocol.md` (`~/.claude/plugins/cache/plugin-hive/plugin-hive/2.15.0/hive/references/kickoff-protocol.md:756-820`) is a real, already-battle-tested precedent in the plugin-hive ecosystem this repo already depends on for its own planning.

**Components — the concrete mechanics H6 must reproduce, read directly from kickoff-protocol.md's Phase 3b:**
1. **Adaptive question set** (kickoff-protocol.md:760-777): a small core set of individually-skippable questions ("what does this tier/persona know," "what should it explicitly NOT hold," "does it have a parent to query up to" — the wizard's own analog of kickoff's 4 core + 2 optional-follow-up questions), with an explicit skip-if-already-known rule so the interview doesn't re-ask what current context already answers.
2. **Persistence rule for skipped fields** (kickoff-protocol.md:778-786): answered questions write the operator's answer verbatim/paraphrased; skipped core fields get an explicit placeholder (kickoff's convention: `unknown`), never silently omitted; skipped optional fields are omitted entirely, not placeholder'd.
3. **Non-blocking hard-fail rule** (kickoff-protocol.md:786): the interview MUST continue and still produce a valid, writable `Persona` record regardless of how many questions are skipped — mirrors `assertValidPersona`'s actual required-field set (persona.ts:107-174: `tier`, non-empty `scopeId`/`displayName`/`scope`, well-shaped `sections`) so a maximally-skipped interview still passes validation rather than producing an unwritable candidate.
4. **Structured output schema** (kickoff-protocol.md:808-820's `north_star` block is the reference shape): H6's equivalent is the `Persona` record itself (persona.ts:60-80) — the skill's real output is a call into H4's write primitive (`persona_create`/`persona_write`), not a new file format.
5. **"Initial crawl and feeding"**: after the interview produces a `Persona`, the skill makes real `remember()` calls indexing whatever source material (docs, existing context) the interview surfaced — this is where H7's scope-mapping decision becomes load-bearing (the skill cannot call `remember()` correctly without H7 resolved).
6. **Works at both repo-spinup-lifecycle moments** (design-discussion.md §3e): parameterized by which tier/store it's authoring for — global-tier ideation before a repo exists, `code-architect` authoring once a repo exists. No new storage-level work; H1's two-store split (Epic 1) already supports this.

**Cross-layer dependency:** Depends on H4 (needs somewhere to write its output) and H7 (needs the scope-mapping decision to call `remember()` correctly). Does not depend on H2/H3 (UI) at all — the interview is a CLI/agent-driven skill, independent of the browser panel.

**Acceptance criteria:** a full interview run (all questions answered) produces a valid `Persona`, written via H4, that passes `assertValidPersona`; a maximally-skipped run still produces a valid, writable record (non-blocking hard-fail proven); skipped-field placeholders match kickoff's persistence convention; at least one real `remember()` call fires per completed interview, scoped per H7's resolved mapping.

---

## H7: `remember()`-Scope Mapping Decision (Slice 3, OQ2)

**What:** A concrete decision (and its implementation, likely a small resolver function) for how a persona's `{tier, scopeId}` maps to a `remember()` call's `scope` argument.
**Why:** Confirmed, unresolved mismatch (research-brief.md §4): `src/engine.mjs`'s `remember(text, scope, opts)` takes a free-form lane name that must match a configured collection; `lib/mnemosyne/client.ts`'s `MnemosyneClient.remember(content, scope, layer?)` takes a closed `Scope = 'project'|'enterprise'|'meta'` union (`server.ts:33`, `SCOPES` set built from the same union). **Neither vocabulary maps onto persona `{tier, scopeId}` today** — grepping `lib/mnemosyne/layers/config.ts` and `client.ts` for any existing persona-aware scope logic returns nothing. A wizard that guesses wrong here writes memory into the wrong lane silently (design-discussion.md Risks table row 2).

**Components:**
1. **The decision itself** — explicitly out of scope for this planning pass (design-discussion.md §6, OQ2: "still open, scoped to Slice 3 only"). Real candidates worth naming as the starting option set (not a decision made here): (a) map each global tier to a fixed `client.ts` `Scope` value (e.g. `company-director`→`enterprise`, `project-orchestrator`→`project`) with `scopeId` folded into `remember()`'s free-text/metadata; (b) map to `engine.mjs`'s free-form lane vocabulary instead, treating `{tier, scopeId}` as (part of) the lane name directly; (c) a hybrid where the two `remember()` implementations get reconciled as part of resolving this, rather than picking one.
2. **Whichever direction Slice 3 picks, it must not require re-litigating `remember()`'s two existing implementations wholesale** — this epic's scope is the mapping *into* one of them, not a `remember()` rewrite (out of scope per design-discussion.md §1's explicit "OUT of scope: ... any change to Epic 1's already-shipped... mechanics").

**Cross-layer dependency:** Blocks the "crawl and feeding" half of H6 only — does not block Slices 1/2/4, or H6's question-sequencing mechanics themselves (a persona can be authored and written without this being resolved; only the `remember()` step needs it).

**Acceptance criteria:** a documented, code-enforced mapping exists (not an ad-hoc per-call guess inside the skill); the same `{tier, scopeId}` always resolves to the same `remember()` scope across separate interview runs; the mapping's rationale is written down somewhere durable (a code comment or a design-discussion addendum), since this is exactly the kind of silent-wrong-lane risk the design discussion flags as needing "a real decision, not an assumption" (design-discussion.md:57).

---

## Capability Dependencies

```
H1 (Listing primitives)
  └─→ H2 (GET /persona/* routes, + reuses existing GET /layers)
        └─→ H3 (UI panel, view-only)

H4 (Write primitive: CLI → skill-harness → MCP, strictly sequential —
    MCP imports the skill-harness action; the skill-harness action
    subprocess-execs the CLI)
  ├─→ H5 (Transport-integration tests)
  ├─→ H2 (POST /persona/* routes — reuses the same underlying store
  │        write functions H4 wraps, not H4's transport code itself)
  │     └─→ H3 (UI panel, write-capable — Slice 4)
  └─→ H6 (Interview skill — needs H4 as its write target)
        ⇕ (independent, converges only at H6's "crawl and feed" step)
       H7 (remember()-scope mapping decision)
```

- H1→H2→H3 is Slice 1's real chain, fully independent of H4/H6/H7.
- H4 is a strict transport chain internally (CLI→skill-harness→MCP), but H4-as-a-whole and H2's POST routes both terminate on the *same* underlying store write functions (Epic 1's, already real) — H2's POST routes don't wait on H4's transport work to finish, only on those store functions existing (they already do).
- H6 and H7 fan out from H4 independently and only reconverge at H6's "initial crawl and feeding" step — H6's question-sequencing/persona-writing mechanics can be built and tested without H7 being resolved yet.

---

## Cross-Cutting Concerns

### Browser cross-origin reachability (real gap, not addressed by OQ1)
OQ1 resolved *which* server hosts the new routes (`lib/mnemosyne/server.ts`, `MNEMOSYNE_PORT` default `3141`) and named the tradeoff as "the standalone UI... will need to reach a second backend process/port" (design-discussion.md §3c). What it does not address: the UI's static files are served by `src/server.mjs` (`PORT` default `8477`, `src/server.mjs:86`, `/ui` static handler at lines 101-196), and every existing `fetch()` call in `ui/app.js` is a same-origin relative path (e.g. `fetch("/health")`, `app.js:47`). A relative `fetch("/persona/...")` from that page hits port `8477`, not `3141` — wrong server, 404. Pointing it at an absolute `http://127.0.0.1:3141/persona/...` URL instead makes it a genuine cross-origin browser request, which `lib/mnemosyne/server.ts` will reject implicitly: it sets no `Access-Control-Allow-Origin` header anywhere in `sendJson` (`server.ts:69-76`) or its route handlers. **This is not later polish — without a CORS header (or a same-origin proxy route added to `src/server.mjs` instead) the browser blocks the request before Slice 1's UI panel can complete a single fetch.** This needs an explicit decision as part of Slice 1 (see vertical plan).

### Data model boundary (do not blur, carried forward from Epic 1)
Persona content (`Persona`, `{tier, scopeId, sections, parentRefs}`) and the layer-stack config (`MNEMOSYNE_LAYERS`/`mnemosyne.layers.json`, `client.ts`'s `getConfiguredLayers()`) remain two separate data models, per Epic 1's own horizontal plan's identical note. Slice 1's UI panel renders both but must never merge them into one list.

### Locking (no new design needed — confirm, don't redesign)
`withLock` (Epic 1's `pf-03`) is already file-scoped/advisory and already handles cross-transport races. H4's three transports and H2's POST route all funnel through the same `writeGlobalPersona`/`writeRepoLocalPersona` calls, which already take the lock internally (persona-store-global.ts:88-90, persona-store-repo-local.ts:70-72) — no transport-specific locking code should be added anywhere in H2/H4.

### Write-path non-duplication (the epic's own explicit risk)
Design-discussion.md's Risks table states this plainly: "the new routes should call the exact same `writeGlobalPersona`/`writeRepoLocalPersona`/... functions directly — no re-implementation." Every component in H2 and H4 above is written to satisfy this by construction (thin wrappers, no inlined validation/dispatch logic) — worth re-verifying at code-review time per slice, since it is easy to accidentally duplicate a validation check "for a better error message" and quietly diverge.

---

## Horizontal Plan Metadata
- **Epic:** mnemosyne-persona-wizard
- **Capabilities:** 7 (Listing primitives, `/persona/*` routes, UI panel, write primitive×3 transports, transport-integration tests, interview skill, remember()-scope mapping)
- **Critical path:** H1 → H2 → H3 (Slice 1/4's UI chain) running independently alongside H4 → H5 (Slice 2's transport chain), which itself gates H6/H7 (Slice 3)
- **Real gap surfaced by this pass, not previously called out:** browser cross-origin reachability between the UI's origin (`src/server.mjs`, 8477) and the new routes' origin (`lib/mnemosyne/server.ts`, 3141) — see Cross-Cutting Concerns.
