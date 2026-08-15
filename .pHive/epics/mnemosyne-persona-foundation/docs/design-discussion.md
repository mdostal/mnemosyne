# Design Discussion — mnemosyne-persona-foundation

*Revised after one collaborative-review pass (architect-lens + TPM-lens, both flagged real issues — see inline notes marked **[review]**), then again after the operator's sign-off split this into two epics.*

**This epic is Epic 1 of 2** (operator decision, see §6): data-driven tier content, the two-tier persona storage model, and the sync-invocation fix. **Epic 2 — `mnemosyne-persona-wizard`** (the LLM-interview authoring flow + the UI) is deferred, planned separately, and depends on this epic's storage model and sync mechanism being real and tested. Do not plan Epic 2's stories here.

## 0. Prelude

No PRIOR DECISIONS or NORTH STAR blocks found (`.pHive/project-profile.yaml` has no `north_star` field; no relevant KG hits). This is genuinely new scope — see research brief §7: no prior doc proposes making Layer 1 tier content data-driven or introduces a "persona" concept.

## 1. Goal

Turn Layer 1 (the 4-tier `top-orchestrator / company-director / project-orchestrator / code-architect` content injected into every harness's `CLAUDE.md`/`AGENTS.md`/`GEMINI.md`) from hardcoded TypeScript into real, data-driven, two-tier persona storage (§3a) — and make the sync mechanism that pushes it into harness files real, locked, migrated, and tested (§3b). This is Epic 1 of 2 (see header) — it does not include the LLM-interview wizard or any UI; it exists so Epic 2 has a real, safe, tested foundation to build on. It is still part of the operator's stated release gate: "then we are pretty solid for prepping it for release."

Explicitly OUT of scope: the LLM-interview wizard and UI (Epic 2, `mnemosyne-persona-wizard`, planned separately), and the multi-repo/multi-agent rollout question (per-repo graph loading vs. multiple Qdrant collections — real, known follow-on work, not either persona epic).

## 2. What exists today (see research-brief.md for full detail)

- **Layer 1 tier content** is a hardcoded `TIER_CONTENT: Record<Tier, TierContent>` object (`tiers.ts`). `sync.ts` composes Level 0 (read fresh from `~/.mnemosyne/level0-rules.md`) + tier markdown into each harness file via idempotent HTML-comment-marker splicing. **No production entrypoint calls this today** — only a Vitest suite exercises it, and only against clean fixture files. **[review, TPM-lens]** that test suite never exercises the splice against realistic, marker-free, human-edited real files — production would be the first real-world test of that mechanism.
- **The layer stack** (`vector`/`keyword`/`file`/`graphify`/`crossref-linker`/`code-graph`/`hive-memory`) is a *separate* config surface (`mnemosyne.layers.json` / `MNEMOSYNE_LAYERS`) governing which recall/remember backends are active. It is not the same data model as Layer 1 tier content, even though the operator's ask ("walk through the memory levels... see what gets assigned to what") wants both visualized together.
- **`remember()`** has two live entry points (`POST /remember` over HTTP; `MnemosyneClient.remember()`) with two different scope vocabularies. Either is real and usable for "initial crawl and feeding" writes.
- **No wizard/chat/interview pattern exists anywhere in this codebase.** Every existing surface (skill, MCP server, HTTP routes) is a stateless one-shot pass-through — including `skills/mnemosyne-standalone/SKILL.md`, which is explicitly table-driven with "no new business logic invented in the skill layer." **[review, architect-lens]** a multi-turn interview is structurally new territory, not a reuse of that pattern.
- **No repo/company identity model exists.** Git-context detection resolves branch + commit only; nothing identifies "which repo, which company" above that. `syncAllHarnesses` does take an explicit `repoRoot` parameter, but only a bare `tier` — not a scoped persona identifier (see §3a below).
- **No persona-content write route exists anywhere** — MCP tools are only `recall`/`remember`/`grep`/`reindex`/`graph_*`; none write `TierContent`-shaped records. **[review, architect-lens]** this must be built net new, not reused.
- **Prior decision to respect**: Graphify's cross-repo graph merge is already proven (twice) to produce zero cross-repo edges — a company-director persona's default content must not silently lean on that as a data source.

## 3. Proposed approach

**3a. Persona = one tier instance, scoped by an explicit identifier, stored across TWO distinct storage tiers.**
A "persona" is `{tier, scopeId, content: TierContent minus mandateSections}` — `mandateSections` stays a shared, code-owned constant, never author-editable.

**Resolved after operator sign-off — this is not one storage location, it is a genuine second architectural level, not a config detail:**

- **Global persona store** (`~/.mnemosyne/personas/`, alongside Level 0's existing convention) holds `top-orchestrator`, `company-director`, and `project-orchestrator` tier personas. This store is where ideation happens **before a repo exists** — company/project-level thinking that isn't tied to any one codebase. Content here is scoped by a human-assigned `scopeId` (company/project name) and **can cascade down into a specific repo** once one exists.
- **Repo-local store** (in-repo, git-committed) holds `code-architect` tier personas. Scoped to exactly one repo — never interacts with all repos, only whichever repo(s) it's actually checked out in. This is a genuinely separate level from the global store, not a variant of it — the operator's own framing: *"that by definition is a separate level not a mix."*
- **This models a real lifecycle**, not just a storage preference (operator, verbatim intent): a new repo/project starts as a ticket; the initial ideation happens at the orchestrator/company level in the **global** store — before any repo exists; orchestration then builds out the actual codebase, at which point **repo-local**, code-architect-tier content gets created *in* that repo; a Hive kickoff then runs in the new repo to build out the rest, feeding further detail back into memory as work continues. The two-store split exists because step 1 (company-level ideation) structurally happens before step 2 (a repo to put anything "in-repo" even exists) — one location could not have served both moments.
- This is new ground for the layer architecture (research brief §7 confirmed no prior doc names this) and should be documented as a formal addition to `docs/layer-architecture-v2-plan.md`'s tier model, not left implicit in this epic's code alone.

**Correction after review [architect-lens], still applies to both stores:** this is *not* a zero-change drop-in regardless of storage split. `getTierContent(tier)` and `syncHarnessFile`/`syncAllHarnesses` currently take a bare `tier` and assume exactly one content object per tier — nothing resolves *which* persona/scope/store to render. Making this real requires threading a `scopeId` (and a store-kind: global vs. repo-local) through `syncHarnessFile`/`syncAllHarnesses`/the new content-read function — a genuine signature change, not a no-op swap. The new read function must also explicitly re-inject the shared `MANDATE_SECTIONS` constant (currently done inline by the `tier()` builder helper) — this needs to be a named, specified step, not assumed.

**3b. Close the sync-invocation gap as part of this epic, first — with real production-safety testing.**
Add the missing "actually run `syncAllHarnesses`" surface — a CLI verb or server-side action. **Correction after review [TPM-lens]:** this needs a dry-run/preview mode and integration tests against realistic, marker-free, human-edited fixture files (not just the existing clean-fixture Vitest suite) before it's safe to call minimal — the first production invocation is otherwise also the first real-world test of the splice mechanism against a file that matters.

**3c. The interview is agent-driven, not an embedded chat backend.**
Recommendation stands, but reframed after review: this is a **new** skill (not a mirror of the existing stateless pass-through pattern) that *whatever agent is already running* (Claude Code, Codex, Gemini — matching Level 0's harness-agnostic stance) walks through with the human, then writes structured output through a **new** persona-content write route (does not exist today — must be built) and triggers real `remember()` calls for the "initial crawl." This still avoids embedding an LLM API client/key inside Mnemosyne itself, preserving the project's zero-dep, harness-agnostic posture — but it's honestly new surface area, not reuse.

**3d. Default layer-stack visibility per persona, not new per-ticket scoping infra.**
Satisfiable by showing/editing each persona's default `mnemosyne.layers.json`-shaped layer stack in the new UI — already a real config surface. True per-ticket dynamic recall scoping is bigger, separate, not yet justified — proposed as future work, not this epic.

## 4. Risks

| Risk | Mitigation |
|---|---|
| Layer 1 content and layer-stack config are genuinely different data models; a UI that visually unifies them could mislead users. | Show them as two clearly-labeled sections under one persona ("what it knows" vs "what it can search"), not a merged list. |
| No repo/company identity model exists; inventing one badly could conflict with the future multi-repo rollout epic (out of scope here). | Keep `scopeId` a plain human-assigned label for now — no auto-detection. Multi-repo rollout epic owns anything more sophisticated. |
| Level 0 is one global file affecting every repo/persona; exposing it as editable in a per-repo UI risks a false sense of per-repo scope. | View-only-with-a-pointer-to-the-file in v1. |
| **[review, architect-lens] No locking on `syncHarnessFile`** (`readFileSync` → splice → `writeFileSync`, no lock) — two concurrent syncs (wizard + manual CLI run, or two personas racing) can clobber a real harness file (TOCTOU). | Add a simple file lock (lockfile or advisory OS lock) around the read-splice-write sequence before this ships against real files. |
| **[review, architect-lens] No seed/migration path** — if the new data store starts empty on cutover, every harness regresses to zero Layer 1 content until 4 tiers are re-authored from scratch. | One-time export of current hardcoded `TIER_CONTENT` into the new store as seed data, as part of §3a's implementation, not an afterthought. |
| **[review, architect-lens] `mandateSections` "never author-editable" is currently only asserted, not enforced** — nothing stops a wizard-driven interview or the write route from accepting mandate-shaped content. | The new persona-write route validates/strips any attempt to set `mandateSections`; the interview skill's prompt explicitly steers away from it, but the route is the real enforcement point. |
| **[review, TPM-lens] Production splice is untested against realistic real-world files.** | New integration tests against marker-free, human-edited fixtures; dry-run/preview mode before real writes. |
| The sync-invocation gap is real pre-existing debt; scope-creep risk if this epic tries to fix it "properly" (hooks, CI) instead of minimally. | Ship the minimal invocation surface needed for the wizard to work — no hook/CI integration unless asked. |
| An agent-driven interview (3c) depends on the running harness actually following the skill faithfully. | Acceptable tradeoff — the zero-dep/harness-agnostic constraint is a standing project value, not new here. |
| **[new, two-store model]** "Cascade down into a specific repo" could be misread as copying global company-director/project-orchestrator content into every repo's `CLAUDE.md` — that contradicts the existing, already-settled `docs/layer-architecture-v2-plan.md` principle that cross-tier impact is answered by querying UP the hierarchy, never held locally at a lower tier. | The repo-local persona's synced content should reference/point at its applicable global `scopeId`(s) so a code-architect agent can `recall()` up into company-director/project-orchestrator memory on demand — not a copy-down. Precise mechanism is H/V planning's job, not this doc's. |

## 5. Dependencies

- New: two persona storage backends — global (`~/.mnemosyne/personas/`, top-orchestrator/company-director/project-orchestrator) and repo-local (in-repo, git-committed, code-architect only). Formalize as a documented addition to `docs/layer-architecture-v2-plan.md`'s tier model, not left implicit in code.
- New: `scopeId` + store-kind-aware signature changes to `syncHarnessFile`/`syncAllHarnesses`/the content-read function (corrected from "no changes needed").
- New: the query-up mechanism for repo-local personas to reach applicable global-store content on demand (not a copy-down — see Risks).
- New: file locking around the sync read-splice-write sequence.
- New: seed/migration export of current hardcoded `TIER_CONTENT` into the two-store model.
- New: integration tests against realistic, marker-free fixture files + a dry-run/preview mode, before real writes ship.
- New: sync-invocation surface (§3b) — closes existing gap.
- Existing, unchanged: `tiers.ts`'s `TierContent` interface shape, `block.ts`/`level0.ts`, the layer registry/config system (reused as-is).
- **Out of this epic** (Epic 2, `mnemosyne-persona-wizard`): persona-content write route, persona-authoring skill, `remember()`-driven initial-crawl flow, UI panels. Epic 2's scope must incorporate the full repo-spinup lifecycle described in §3a (ticket → global ideation → repo build-out → Hive kickoff → memory feedback loop), not just a generic "create a persona" flow.

## 6. Open questions — resolved by operator sign-off

**Q1 (storage location) — RESOLVED: split by tier into two storage levels**, per §3a: global store for top-orchestrator/company-director/project-orchestrator, repo-local store for code-architect. This is the operator's explicit decision, reasoned from the real repo-spinup lifecycle (ideation happens before a repo exists, so one location can't serve both moments).

**Q2–Q5 — accepted as documented defaults**, not relitigated: agent-driven interview (Q2), Level 0 view-only-with-pointer (Q3), sync-gap closure belongs in Epic 1 (Q4, confirmed by the epic split itself), per-ticket dynamic scoping deferred (Q5) — all deferred to Epic 2 where applicable; flag if wrong when Epic 2 is planned.

**Q6 (split into two epics) — RESOLVED: split.** This document (`mnemosyne-persona-foundation`) is Epic 1. Epic 2 (`mnemosyne-persona-wizard`) is deferred and will be planned separately once this epic ships.

**Named minimum viable slice for this epic**: hand-author a persona JSON file (in the correct store for its tier) → run the new CLI verb → see it land correctly, locked and tested, in a real `CLAUDE.md`, including a code-architect persona correctly reaching up into its applicable global-store parent tier content.

## 7a. Harness-agnostic adapter layer (operator correction, post-H/V)

**Correction to §3a/H5/H6:** persona storage must be Mnemosyne's own canonical format — **YAML, not JSON** (operator, verbatim: "we define our own yaml") — and getting that content into any given harness is explicitly an **adapter** concern, not something baked into the core storage/fetch mechanism.

- **Core (this epic owns):** the canonical `Persona` YAML schema + location (H1, now YAML not JSON) and the fetch/query mechanism (H5's query-up, H6's `persona show`). This is harness-agnostic by construction — nothing about it assumes any particular target file format.
- **The existing `CLAUDE.md`/`AGENTS.md`/`GEMINI.md` splice mechanism (`sync.ts`/`harness.ts`) is one adapter** — the "markdown-harness adapter" — not the only possible integration model. It happens to already cover 3 harnesses (Claude Code, Codex via `AGENTS.md`, Gemini) through one shared strategy (full rendered content spliced into a managed block). This epic keeps that adapter as-is (still real, still needed, still in scope — Slice 1-3 all sync through it) but names it explicitly as *an* adapter rather than *the* mechanism, so it doesn't get treated as the universal answer later.
- **A lighter injection strategy is a legitimate future adapter variant, not required now**: e.g. installing a skillset that adds a *pointer* into `CLAUDE.md` ("call mnemosyne, it pulls the right persona file") rather than the full content — operator's own example. Whether a future adapter does full-content-splice or thin-pointer-plus-live-fetch is that adapter's own decision; H5's `persona show`/query-up mechanism already supports either style (it's a live, on-demand read either way).
- **Explicitly OUT of scope for this epic**: building adapters for anything beyond the existing markdown-harness one — including any Pantheon-specific runner integration. Operator's own framing: that's "outside of you... luckily, when we do the pantheon, that adapter is going to be to the pantheon which will pass that into the runners." This epic's job is to make the core (storage + fetch) solid and harness-agnostic enough that a future Pantheon adapter (or a Codex-specific one beyond today's `AGENTS.md` coverage) can be built without touching H1-H5.
- **Rollout sequencing (operator intent, informs nothing structural in this epic, but shapes what "done" means):** try locally first (this repo, the existing markdown-harness adapter) → other agents/harnesses → set defaults in T3 (T3 Chat, an existing MCP-compatible consumer per `bin/mnemosyne-mcp.mjs`) → eventually Pantheon. This epic only needs to deliver the "try locally" step; the rest is future work already flagged as out of scope.

## 7. Scale assessment

**Recommendation: Medium-to-Large, now more precisely scoped after the split.** Real surfaces: two storage backends + their seed/migration, `scopeId`/store-kind signature threading through `syncHarnessFile`/`syncAllHarnesses`, the query-up mechanism, file locking, and new integration tests + dry-run mode. Concentrated (no UI, no wizard, no LLM interview) but touches several interlocking pieces with real correctness risk (concurrent writes, empty-store regression). Recommend H/V planning to slice this correctly; let the H/V phase make the final call on whether a structured outline is also warranted.
