# Layer Architecture v2 — Plan

**Status:** design agreed, decisions made (2026-08-13), now formalized as epic `mnemosyne-layer-architecture-v2` (`.pHive/epics/mnemosyne-layer-architecture-v2/`). Build starts with `la-02` (Graphify adapter).

**Supersedes nothing** — extends `docs/cba-memory-layers.md` and `docs/memory-architecture-deep-research.md` (2026-08-14 CBA), and closes out the design questions raised in that session's live discussion (not previously written down anywhere but this doc and Mnemosyne's own Qdrant memory).

## 1. Reconciled architecture (agreed)

The operator's 3-layer simplification and the CBA's 5-layer research map onto each other directly — not in tension, the 3-layer view is a correct collapse:

| Operator's layer | CBA doc's layer(s) | What it is |
|---|---|---|
| **Layer 1 — Hard-locked meta file** | *(new, not in the CBA — the CBA was scoped to memory/graph tooling only)* | Role-scoped, tier-scoped base understanding loaded at agent start. Piggybacks on each harness's own native auto-load file — `CLAUDE.md` (Claude Code), `AGENTS.md` (Codex), `GEMINI.md` (Gemini CLI) — rather than inventing a new convention. Mnemosyne's job: be the source of truth that *generates/syncs* the right content into each harness's native file per tier, not replace the harness convention. |
| **Layer 2 — memory framework** (Letta/Graphiti/Cognee/Qdrant) | CBA layer 2 (hive-memory/KG) + layer 5 (semantic/Qdrant) merged | Queryable memory of decisions and facts — structured KG query and vector search are two retrieval mechanisms over conceptually one tier. |
| **Layer 3 — graph tool** (Graphify) | CBA layer 3 (indexed docs) + layer 4 (code graph) merged | Confirmed by the Graphify PoC: `_origin: "ast"` doc nodes already give line-addressable doc indexing with no LLM required, so docs and code structure were never separate problems for Graphify specifically — one tool, one graph. |

**Orchestrator hierarchy — adopting the operator's 4-tier version over the CBA's 3-tier one.** The CBA doc collapsed "project" and "code area" into one "area architect" tier; the Flayr example shows these are genuinely different scopes with different change-frequency:

`top (Auriga)` → `company director` → `project orchestrator` (repo-level way-of-working: integrations, 3rd-party, rough architecture — doesn't change per-task) → `code/area architect` (graph-scoped to the specific area being touched — changes per-task).

Cross-project impact is still answered by querying **up** to the company director, never held locally at the code tier — that part of the CBA's design holds regardless of 3 vs 4 tiers.

## 2. New design element: flight-status-aware memory (agreed direction, mechanism proposed)

**Problem the operator raised:** work in progress on a feature branch is true *for that branch*, not globally true, until a PR merges. An agent must not build on another branch's unmerged memory as if it were confirmed ground truth. This likely extends to the Layer 3 code graph too (built from whatever's checked out, not just main).

**Proposed mechanism** (extends the existing `hive-memory` `kg.sqlite` pattern — `valid_from`/`valid_until`, `source_epic`, `source_agent` — rather than inventing a second storage system):

- Every memory write gets `status: provisional | confirmed | superseded` + `source_ref: {branch, commit_sha, pr_url}`, auto-detected from cwd git context if not passed explicitly.
- Default `status` for anything written on a non-default branch is `provisional`.
- A promote step flips `provisional → confirmed` on merge to the default branch. PR closed-without-merge flips `provisional → superseded` — **never deleted**, so a rejected approach stays queryable as "we tried this, it didn't land" rather than vanishing.
- Recall defaults to `confirmed`-only across repos/company tier. Same-branch/same-session recall may include the caller's own `provisional` entries. Another agent on a different branch never inherits unmerged state as ground truth.
- **Rejected alternative:** memory keyed by ticket/PR as its primary storage location. Rejected because it fragments retrieval (now searching two places for one fact) — same data, ticket/branch as provenance metadata, status as a recall-time filter, not a location.

**Trigger decision (2026-08-13):** not a single mechanism — the primary enforcement point is **Layer 1**, not any one trigger. The mandate to check/update flight-status memory (and to call recall/remember at all) has to be baked into the hard-locked meta file every agent loads at start (`la-01`/`la-07`), so it applies across every harness (Claude/Codex/Gemini/whatever) and every team's workflow — not all teams even use git the same way, so nothing git-specific can be the sole enforcement point. Concretely:

- **Local git hooks, built for real** (post-merge, etc.), auto-installed per repo/agent setup — explicitly chosen over GitHub Actions ("I hate github actions and it is already costing a fortune, I prefer my own build boxes"). This is the first concrete trigger adapter, not the only one.
- **Pluggable trigger architecture** — Mnemosyne needs the *parts in place* for multiple lifecycle-event sources (git hooks, ticket-queue transitions, other process/lifecycle events), not a hardcoded git-only path. Adapters plug into the same promote/supersede + outcome-write mechanism from a common interface.
- **A second system to verify compliance** — baking the mandate into Layer 1 and building trigger adapters isn't sufficient on its own; Mnemosyne also needs something that checks agents/repos are *actually* calling these correctly (the same shape of problem as the recall-enforcement gap in `la-07`/originally-flagged "highest-leverage gap"). This is `la-11` below — echoes the operator's original "let mnemosyne sleep, go through, clean, and fix" idea from earlier in this session.

## 3. Feedback loop: CI outcome → memory (new, not previously identified)

Not a new layer — a write-path event. Test/lessons-learned feedback (CI pass/fail, review feedback) becomes a memory write back into Layer 2, tagged with outcome, at the same moment a PR merges or gets rejected. Shares the same trigger mechanism as the promote/supersede step in §2 — one trigger, two effects (status flip + outcome-tagged memory write).

## 4. Ticket breakdown — formalized as epic `mnemosyne-layer-architecture-v2`

Epic: **`mnemosyne-layer-architecture-v2`** — "Flight-aware layers, hard-locked role files, and Graphify adoption." Story IDs use an `la-` prefix (continuing the `pl-`/`m-` convention; builds on the already-shipped `mnemosyne-pluggable-layers` epic, `pl-01/02/03`). Full story detail lives in `.pHive/epics/mnemosyne-layer-architecture-v2/stories/*.yaml`.

| ID | Title | Depends on | Status |
|---|---|---|---|
| `la-01` | Role-scoped meta-file sync (Layer 1), embeds the lifecycle-memory mandate | — | pending |
| `la-02` | Graphify adapter (replaces in-house code-graph) | — | **pending — starting story** |
| `la-03` | Graphify doc-index wiring | `la-02` | pending |
| `la-04` | Flight-status write schema | — | pending |
| `la-05` | Recall status filtering | `la-04` | pending |
| `la-06` | Pluggable lifecycle-trigger system — local git hooks first, ticket-queue/other adapters as extension points, no GitHub Actions dependency | `la-04` | pending |
| `la-07` | Layer-1 enforcement mandate — bakes recall-on-entry/remember-on-exit + flight-status handling into every harness's native meta file | `la-01`, `la-05` | pending |
| `la-08` | Lifecycle-outcome → memory feedback loop (generalized beyond CI — any lifecycle event via `la-06`'s adapters) | `la-06` | pending |
| `la-09` | Graphify cross-repo eval (`graphify global`/`merge-graphs`) | `la-02` | pending |
| `la-10` | A/B: Graphify vs. retired in-house code-graph | `la-02` | pending |
| `la-11` | Memory-lifecycle compliance audit — verifies agents/repos are actually calling recall/remember/promote correctly, not just that the mandate exists | `la-06`, `la-07` | pending |

**Decided (2026-08-13):** start with `la-02`. Testing bar for the flight-status stories (`la-04`/`la-05`/`la-06`): all three of — unit tests on status transitions, a real subprocess integration test (branch → provisional write → merge → assert promotion, same rigor as the `pl-02` regression test), and live dogfooding in this repo before any other repo adopts it.

## 5. North-star addendum

Original north star (`(.pHive/project-profile.yaml`): "Unify memory layers behind one recall/write API so 'memory over find' becomes the default retrieval path for every agent" — standalone-first, already substantially met.

**v2 addition (2026-08-13):** memory truth must be flight-aware (provisional vs. confirmed vs. superseded, tied to branch/PR state — §2 above), and the layer stack must be harness-agnostic at the role-meta-file tier (§1, Layer 1) — not just harness-agnostic at the recall/write API tier. Recorded in `project-profile.yaml` under `north_star` as a dated addendum, not a rewrite of the original goal.

## 6. Decisions log (2026-08-13)

1. **Trigger architecture** — not a single mechanism (see §2 above). Layer 1 is the primary enforcement point (mandate baked into every harness's meta file); local git hooks are the first real trigger adapter (no GitHub Actions — explicit operator preference, cost + build-box reasons); the trigger interface stays pluggable (ticket-queue transitions and other lifecycle events are real future adapters, not hypothetical); a separate compliance-audit story (`la-11`) checks the mandate is actually being followed, not just that it exists.
2. **Testing bar for `la-04`/`la-05`/`la-06`** — all three: unit tests on status transitions, a real subprocess integration test, and live dogfooding in this repo first.
3. **Starting story: `la-02`** (Graphify adapter) — highest confidence, already PoC'd, immediately valuable standalone.
4. **`la-06`/`la-08` scope note** — since the trigger system is pluggable and git-hook-first (not CI-webhook-first), there's no single "does it live in Mnemosyne or in each repo's CI" question anymore — the git-hook adapter installs per-repo by design; a future ticket-queue adapter would be a separate integration per queue system, evaluated when that need is concrete rather than speculated now.
