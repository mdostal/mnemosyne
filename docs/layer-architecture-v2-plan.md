# Layer Architecture v2 — Plan

**Status:** design agreed, decisions made (2026-08-13), now formalized as epic `mnemosyne-layer-architecture-v2` (`.pHive/epics/mnemosyne-layer-architecture-v2/`). Build starts with `la-02` (Graphify adapter).

**Supersedes nothing** — extends `docs/cba-memory-layers.md` and `docs/memory-architecture-deep-research.md` (2026-08-14 CBA), and closes out the design questions raised in that session's live discussion (not previously written down anywhere but this doc and Mnemosyne's own Qdrant memory).

## 0. Level 0 — operator-global rules (added 2026-08-13, mid-epic)

Sits ABOVE Layer 1 and the entire 4-tier company/project hierarchy — not scoped to any repo,
company, or project. Direct response to a real incident in this epic: work got committed
directly to `main` instead of `dev` because a stale `project-profile.yaml` doc field said "off
main" — the operator's framing: "we need them to pull first, work off dev... make feature
branches then PR to dev, merge that in, then we merge to main for a release," enforced "no
matter what LLM starts and works with code" across every repo.

Canonical source: `~/.mnemosyne/level0-rules.md` — outside any single repo (not `~/.claude/`,
since this must apply to Codex/Gemini/etc. too). `la-01`'s per-harness sync mechanism reads
this file and prepends its content to every generated `CLAUDE.md`/`AGENTS.md`/`GEMINI.md`,
ahead of any tier-specific content (`la-01` now depends on `la-00`). Story: `la-00`.

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

## 1a. `la-09` finding: `graphify global`/`merge-graphs` evaluated for the company-director tier — **don't adopt as the tier's data source** (2026-08-14)

`docs/cba-memory-layers.md`'s "New finding" flagged Graphify's cross-repo merge commands
(`graphify global add/remove/list`, `graphify merge-graphs`, `~/.graphify/global-graph.json`)
as possibly the right mechanism for the company-director tier's "light understanding of a
company's resources/products/repos without holding full per-repo depth" need (§1 above). This
was evaluated for real, not inferred from docs — verdict: **the merged graph itself is the
wrong altitude for this tier; don't adopt it as company-director's data source.**

**What was actually run** (real CLI, confirmed via `graphify --help` first — the CBA's
paraphrase of the command surface was accurate): `graphify update .` against this repo
(mnemosyne, at commit `a0e957a`) and against a second real Pantheon repo on this machine
(`/Users/mdostal/Documents/work/pantheon/minerva`, branch `feat/fix-startrun-heimdall-routing`)
to produce two real per-repo `graph.json` files (mnemosyne: 1467 nodes/2480 edges/104
communities; minerva: 849 nodes/1526 edges/57 communities). Then both real cross-repo paths:
`graphify global add <graph.json> --as <tag>` for each repo (writes/accumulates
`~/.graphify/global-graph.json` + a `global-manifest.json`), and separately `graphify
merge-graphs <g1> <g2> --out <path>` (a one-shot merge of two named files, no persistent
store). Both commands produced numerically identical results (2316 nodes, 4006 edges) —
confirmed to be the same underlying merge logic with two different persistence models.

**Directly inspected content of the real merged output** (`~/.graphify/global-graph.json`,
2.5MB for just these two modest repos):
- It is a **structural union, not a synthesis**. `2316 = 1467 + 849` exactly — every function/
  class/doc node from both repos' full-depth per-repo graphs is present verbatim, just
  namespaced (`id: "mnemosyne::src_errors_..."` / `"minerva::src_driver_claudeadapter"`, new
  `repo` field added per node).
- **Zero cross-repo edges.** Of the 4006 merged edges, a direct check (`source`/`target` repo
  comparison on every edge) found 0 edges connecting a mnemosyne node to a minerva node. The
  merge does not discover or infer any real relationship between repos (shared dependencies,
  API usage, imports) — it only avoids ID collisions. Running `graphify query "how does
  mnemosyne relate to minerva" --graph ~/.graphify/global-graph.json` confirmed this live: the
  BFS traversal it returned was entirely local to mnemosyne's own `package.json`/`docs/
  architecture.md` nodes (lexical matches on the words "mnemosyne"/"minerva" within one repo's
  own graph), not a real cross-repo path.
- **Community IDs collide across repos** (both repos number communities `0..N` independently;
  after merge, `community: 1` exists in both mnemosyne, `community_name: "metrics.ts"`, and
  minerva, `community_name: "consus-resume.ts"`, as two unrelated things sharing one number).
  Not fatal — every node still carries a distinct `id`/`repo` field — but a real footgun for
  any naive consumer that groups by the bare `community` integer.
- `god-nodes`/`query`/`explain`/`--json` all run fine against the merged file (same
  `graph.json` shape reused, confirmed live) — the tooling itself is reusable, but what comes
  back is full function/class-level detail from whichever repo the traversal happened to land
  in, not a repo- or product-level rollup.
- The one artifact from this whole workflow that actually is small and repo-scoped is
  `~/.graphify/global-manifest.json`, written as a side effect of `global add`: `{repo tag,
  added_at, source_path, node_count, edge_count, source_hash}` per repo — a few hundred bytes
  per repo, and exactly the shape of "which repos exist and how big/fresh are they" that a
  company-director tier could actually hold cheaply. `graphify global list` surfaces the same
  thing as a one-line-per-repo summary.

**Recommendation: don't adopt `graphify global add`/`merge-graphs`'s merged graph.json as the
company-director tier's data source.** It fails the tier's own stated requirement two ways:
(1) it is full per-repo AST-level depth for every company repo concatenated into one file with
unbounded, linear growth per repo added (2.5MB for 2 modest repos — a real company's 10-30
repo fleet would put tens of MB of raw code-graph nodes in a tier explicitly meant to avoid
holding per-repo depth), and (2) its only real value-add over just concatenating files by hand
— actual cross-repo relationship discovery — doesn't exist; 0 of 4006 edges cross a repo
boundary.

**Adopt-with-modification, narrowly:** the `global add`/`global list` side effect
(`global-manifest.json` — repo tag, size, freshness, provenance) is a legitimate, already-free
"which repos/products exist" inventory signal for company-director tier, cheap enough to hold
directly. It should NOT be confused with or expanded into holding the merged graph itself.
Real cross-repo/cross-project *impact* questions (already scoped in §1's tier design — "cross-
project impact is still answered by querying up... never held locally at the code tier")
should be answered by the company-director tier querying **down** into a specific project's
own already-adopted (`la-02`) per-repo Graphify graph on demand, not by maintaining one
permanently-fused blob. This is a sketch for a future story if/when company-director-tier work
is actually scheduled — not built here; `la-09` is evaluation-only per its own spec.

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
| `la-10` | A/B: Graphify vs. retired in-house code-graph | `la-02` | **complete — see §7** |
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

## 7. `la-10`: Graphify vs. code-graph A/B benchmark — go/no-go on retirement (2026-08-14)

Extended the existing `pl-03` A/B harness (`benchmarks/layer-ab-test.ts`) with a `graphify`-configured
stack (`graphify -> vector -> file`) run alongside the existing `code-graph`-configured baseline
(`code-graph -> vector -> file`) — `vector`/`file` held identical on both sides so the only variable is
the graph layer itself. Ran for real against this repo (`npm run benchmark:layer-ab`), using the
harness's own existing default query set (`mnemosyne`, `layer registry`, `secrets-adapter` — no new
query set invented, per the story's guidance). Both `code-graph` and `graphify` stay registered
side by side (`registry.ts`) — this story does not remove either.

**Root cause found (not assumed):** directly inspected `code-graph`'s actual backing store,
`~/.local/share/swarm-memory/graph.sqlite` — 22 nodes total, and **zero of them are from this repo**
(`mnemosyne`); all 22 are from two unrelated repos (`dostal-swarm/...`, `swarm-memory/...`). Confirmed
in `CodeGraphLayerAdapter.ts` too: it takes no `repoRoot`/per-repo scoping at all — it always shells to
one global `swarm-memory graph impact <query>` (or reads the one shared `graph.sqlite`), so it is
architecturally unable to reflect this repo's own code structure, regardless of query. `graphify`, by
contrast, is repo-scoped: a fresh `graphify update .` against this repo (steady state, cached
`graph.json`) indexed **1470 nodes / 2484 links** from this repo's own source.

**Benchmark numbers (steady state, `graph.json` cached — matches real operational use, not a
cold-start number):**

| Config | Total hits | Total tokens (`estimateTokens()`) | Avg latency | Queries ok |
|---|---|---|---|---|
| `baseline (code-graph)` [`code-graph -> vector -> file`] | 12 | 4808 | 2502.7ms | 3/3 |
| `graphify` [`graphify -> vector -> file`] | 28 | 4797 | 1666.0ms | 3/3 |

Per-query breakdown: for `"mnemosyne"`, `graphify` matched directly (20 hits, 174 tokens, 7ms — the
graph layer alone, no fallback needed) while `code-graph` missed entirely and fell through to `vector`
(4 hits, 185 tokens, 2483ms). For `"layer registry"` and `"secrets-adapter"`, neither graph layer had a
direct match, so both configs fell through identically to `vector` (identical hit/token counts on those
two queries — a tie, not a loss for either side). Net across all 3 queries: `graphify` hit-count is
never worse than `code-graph`'s on any query, total tokens are within noise (-0.2%), and average latency
is 33% lower (the short-circuit on `"mnemosyne"` avoids `vector`'s ~2.3-2.6s cost entirely).

**Qualitative relevance spot-check** (not just counts — inspected actual hit content for `"mnemosyne"`):
`code-graph`'s 4 fallback hits are generic changelog/memory-log entries that happen to mention the word
"mnemosyne" in passing (`vector`-layer text search, not graph-structural). `graphify`'s 20 hits are real,
line-addressable code/doc structure nodes and edges naming this repo directly — `.mcp.json:L1`,
`README.md:L1`, `package.json:L11`, `bin/mnemosyne:L1`, `README.md --contains--> Mnemosyne` — i.e. actual
"what references what" impact-graph answers, which is `code-graph`'s stated job and what it structurally
cannot deliver against this repo today.

**Recommendation: GO** — proceed toward retiring the in-house `code-graph` implementations
(`CodeGraphLayerAdapter.ts`'s better-sqlite3 path + the JS CLI wrapper onto the same shared
`graph.sqlite`), as a separate, later story (not bundled here, per this story's explicit scope).
`graphify` matched or beat `code-graph` on every metric measured against this repo, and the root-cause
finding above means this isn't a close call that might flip with more queries — `code-graph` cannot
structurally produce a relevant hit for this repo's own code no matter what's asked, since this repo
was never indexed into its shared dataset. One pre-removal check for that later story: confirm no other
consumer depends on the shared `swarm-memory` `graph.sqlite` for a *different* repo's data before
deleting the wiring — its 22 nodes span `dostal-swarm`/`swarm-memory` themselves, so removing
`CodeGraphLayerAdapter.ts` from Mnemosyne is not the same decision as decommissioning `swarm-memory`
itself, which may still serve other consumers.
