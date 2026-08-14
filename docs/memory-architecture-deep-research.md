# Deep Research: Agentic Memory Architecture — Final Layer Proposal

**Status:** decision-ready research + a concrete final architecture proposal. Not yet implemented.
**Date:** 2026-08-14
**Scope:** 22-agent multi-phase research sweep (grounding → 61-tool discovery → primary-source verification → synthesis) plus an independent hands-on Graphify PoC (see `cba-memory-layers.md`, which this document supersedes on architecture questions and extends on tooling).
**Companion doc:** `docs/cba-memory-layers.md` (the earlier, narrower code-graph/doc-index CBA — still valid for its specific Graphify recommendation).

---

## 1. Resolved: "how many layers did we actually design before?"

The operator recalled "7 layers or so" from a prior design pass, documented at [mdostal.com/blog/35-agent-ai-coding-swarm](https://mdostal.com/blog/35-agent-ai-coding-swarm) (Mar 2026). Direct primary-source research (including extracting the raw SVG text from the post's own architecture diagrams, since the summarizer kept truncating the diagram content) found the real answer: **it was never one 7-layer stack — it's two separate diagrams, a 3-layer infrastructure hierarchy and a 5-layer memory hierarchy, 3+5=8.** The confusion is explained by the post's own prose: it narrates the *second* item in each hierarchy as "Layer 2" (never naming the first item "Layer 1" in body text, only in the diagram artwork), which is almost certainly why the layer count undercounts in memory.

**The 3-layer infra hierarchy** (Git-Watcher build triggers → Ops Runner infra health → Directors/AI coding layer) is orchestration scaffolding, not memory — not directly relevant to Mnemosyne.

**The 5-layer memory hierarchy** (verbatim from the diagrams, axis-labeled "persistence: session → machine → network → permanent"):

| # | Name | What it held | Persistence |
|---|---|---|---|
| 1 | Context window | 200K tokens/session, sub-agents get fresh windows | Dies on session end |
| 2 | CLAUDE.md | Workflows, anti-patterns, team protocols, checked into git | Permanent, version-controlled |
| 3 | `~/.claude/projects/` file memory | 20+ auto-loaded topic files (build pipelines, secrets, deploy, lessons) | Cross-session, per machine |
| 4 | Qdrant + Ollama vector memory | ~13.7–16K knowledge points (the post's own numbers disagree by ~2K — treat as approximate), 768-dim `nomic-embed-text`, pre-work query + post-work write-back | Cross-session, cross-agent, network-wide |
| 5 | Linear tickets | Human decisions embedded in ticket descriptions/comments; the only layer with direct human authorship | Permanent |

This maps closely onto a memory note found live in this session's own diagnostic (see §3): "1. META knowledge... 2. ENTERPRISE/company... 3. PROJECT... 4. CODE GRAPH... 5. QDRANT semantic lookup — LIVE today... 6. FILE/README INDEX" — a *related but distinct* 6-layer scheme from a different prior conversation (2026-07-10). These are not the same taxonomy; both are real prior art and neither is "the" answer — see §5 for the reconciled proposal.

### What actually failed in production (real incidents, with fixes and lessons — verbatim from the blog, kept because they're load-bearing for Mnemosyne's design, not just historical color)

- **"124 Pull Requests Overnight"** — no dedup guard; the director re-processed already-done tickets. *Lesson: "If your agent loop doesn't track what it already did, it will do everything twice."*
- **"Every Session Ran on Opus"** — a missing `--model` flag defaulted 747+ sessions to the most expensive model, turning a $15/day operation into $65/day. *Lesson: defaults matter enormously at scale.*
- **"46 out of 46 Sessions Failed in One Cycle"** — rate-limit errors were mis-treated as task failures and burned through retry budgets. *Lesson: "Your orchestrator must distinguish between 'the task failed' and 'the infrastructure failed.'"*
- **The Firebase wild-goose-chase** — a cheap model confidently told the operator to change external config that was already correct; the real bug was in code it never inspected. Fix: **memory wins by default; claims that contradict recorded memory require escalation to a stronger model plus file-and-line evidence before being trusted.** This is the only concrete cross-conflict trust policy found anywhere in this entire research pass (see §6 — no surveyed industry tool has an equivalent).
- **"Five Zombie Detectors, All Broken"** — five overlapping, independently-blind-spotted detection mechanisms gave false confidence; one correct detector beat five bad ones.
- **Root framing, verbatim, worth keeping as Mnemosyne's own thesis statement**: *"AI agents are amnesiac by default... the fundamental problem is the same [regardless of context window size]. The moment the session ends, everything it learned disappears... Bigger [context windows] helps — but... persistence architecture is [the actual answer]."*

---

## 2. Internal prior art: "ruvflow" / "claudflo"

Neither exact spelling exists anywhere (local repos or GitHub) — they're a garbled reference to **`ruvnet/claude-flow`** (since renamed `ruvnet/ruflo`) and its sibling **`ruv-swarm`**, real, actively-maintained (MIT, latest release `v3.38.9` as of 2026-08-13) open-source multi-agent orchestration tools.

**The operator genuinely built and ran two real production deployments of this exact tool family** — `firefly-events/dostal-claude-flow` and `firefly-events/monitoring/.claude-flow` — between roughly January and July 2026, before consolidating onto the current Multica/Hive/Pantheon stack. Both are real, with real CI history, real scripts, real configuration.

**Did it work?** No. A prior self-audit already in this operator's own files (`~/Documents/work/clients/RECOVERY-v1-ffe-orchestration.md`) found **zero successful autonomous CI runs** across a 3-day burst (~398 scheduled runs, all `failure`), before the system went dormant and was formally torn down. That same document's own conclusion — worth adopting rather than re-litigating: treat claude-flow as **"a proven-DESIGN / pattern-library... not a turnkey engine,"** and harvest its patterns (worktree isolation, orphan reclaim, TTL locks, rate-limit circuit breaker) rather than reviving the tool itself.

**Recommendation (§7 covers this in full): do not adopt claude-flow/ruflo/ruv-swarm as Mnemosyne's orchestration substrate.** Build in-house, as the operator's own director already does; the useful patterns (hooks-based auto-persist to memory namespaces) are independently and more cleanly available via LangGraph's checkpointer/store model.

---

## 3. Why Qdrant recall didn't surface 30+ prior conversations — the most important finding in this entire research pass

**The memory system is not broken. It found the content clearly.** A live diagnostic (service started, ~70 real recall/grep queries run across 5 scopes) found strong, on-topic hits at 0.6–0.79 cosine similarity — well above this corpus's noise floor (~0.4–0.5) — including:

- A memory note dated **2026-07-10** that explicitly reads: *"The memory plugin (proposed god-name MNEMOSYNE) was always meant to be MULTI-LEVEL — ~6 layers... **this had been discussed before and lost**"* — found at 0.69 similarity for the literal query "memory architecture." This is a month-old artifact that already predicted the exact frustration behind this research request.
- `dostal-swarm/docs/memory-architecture.md`, `plugin-hive/hive/references/agent-memory-schema.md`, `monitoring/docs/MEMORY-SYSTEM.md`, `plugin-hive/hive/agents/orchestrator.md`, and a CBA doc (`dos-1117-ruflo-cba.md`) on memory tiering — all real, all indexed, all semantically well-clustered around exactly these query terms.

**Root cause: not indexing failure, not embedding quality — the content was never reliably *queried*.** The mnemosyne service was found *down* at the start of this diagnostic. The most likely explanation, given the evidence: recall is **available-but-optional tooling** that nothing forces an agent/orchestrator to call at session start, so each new conversation "rediscovers" the topic because nothing automatically surfaces prior takeaways — even though they're one API call away.

**This directly determines Mnemosyne's single highest-leverage design requirement (see §5's cross-cutting section): every tier's context injection must be enforced by the orchestrator at spawn time, not offered as an optional tool call.** This is not a novel idea — it's exactly what the operator's own blog-documented director already does (`processTicket()` unconditionally injects ticket + CLAUDE.md + RAG context into every session) — Mnemosyne itself just doesn't have the equivalent hook wired yet.

---

## 4. Tool survey — 61 tools across 6 categories (target: 50+, met)

Full per-tool detail (license, maturity signal, what it does, layer fit, confidence) lives in the workflow journal; this table is the decision-relevant summary. **License column reflects real verification** — a meaningful fraction of "open source" claims in this space turn out to be source-available (BSL/SSPL), not permissive OSS; flagged explicitly, not glossed over.

### Vector / embedding stores (layer 5 candidates, beyond Qdrant)

| Tool | License | Verdict |
|---|---|---|
| **Weaviate** | BSD-3-Clause (genuinely permissive, verified) | Strongest self-hosted Qdrant alternative if ever needed |
| **Milvus** | Apache-2.0 | Real option; heavier ops footprint |
| **Chroma** | Apache-2.0 | Local-first, embedded — also a real layer-3 (doc-index) candidate |
| **LanceDB** | Apache-2.0 | **Best structural fit for layer 3** in this whole category — file-based, embedded, serverless |
| **pgvector** | PostgreSQL License (permissive) | Only relevant if colocating with an existing Postgres |
| **Vespa** | Apache-2.0 | Real hybrid (BM25+vector+ML ranking) strength, heavyweight |
| Pinecone, Turbopuffer, Vald, Vectara | Proprietary/cloud-only | Not recommended — violate local-first constraint |
| **Marqo** | Apache-2.0 on a *frozen, functionally dead* codebase | **Verified false claim caught**: discovery pass wrongly said "Vespa-backed, deprecated with a notice" — real primary source shows OpenSearch-backed, no deprecation notice text exists. Still not recommended (unmaintained), but for the right reason. |

### Agent memory frameworks (layer 2 candidates, purpose-built for this exact problem)

| Tool | License | Verdict |
|---|---|---|
| **Letta** (formerly MemGPT) | Apache-2.0, 24k+ stars | **Strongest architectural analog to a hierarchical, tiered memory system** — core/archival/recall memory tiers map closely onto Mnemosyne's own layer concept |
| **Graphiti** (getzep) | Apache-2.0, ~29.9k stars | Purpose-built temporal knowledge graph for agent memory — closest direct match to layer 2's "hierarchical meta-knowledge" concept of any tool surveyed |
| **Cognee** | Apache-2.0, **30,007 stars — verified discovery pass understated this by ~2.5x (claimed 12k+)** | Real, active, directly targets the same problem Mnemosyne solves end-to-end |
| **Mem0** | Apache-2.0, 63,212 stars (verified) | User/Session/Agent scoping — closest analog for tracking company/product entities as structured, evolving state |
| **Zep** (Community Edition) | Apache-2.0 | **Verified discrepancy**: discontinued **2025**, not 2026 as originally claimed — code remains public but unsupported |
| Memary, Supermemory, Memobase | MIT/Apache-2.0 | Smaller, less battle-tested; reference-only |

### Knowledge-graph tools (layer 2/4 storage engines, beyond Neo4j/SurrealDB)

| Tool | License | Verdict |
|---|---|---|
| **Kuzu** | MIT | Strong technical fit, but **archived upstream — do not adopt as a dependency** |
| Memgraph, ArangoDB | BSL (source-available, not permissive OSS) | Same category-wide licensing caveat as SurrealDB in the earlier CBA |
| FalkorDB | SSPL (source-available) | Same caveat |
| NebulaGraph, Dgraph | Apache-2.0 | Real OSS, but distributed/heavyweight — not a near-term local-first fit |
| **Microsoft GraphRAG** | MIT | Methodology reference for layer-2 construction, not a standalone tool to adopt |

### Code-graph / code-understanding tools (layer 4, beyond Graphify/CodeGraph/Understand-Anything)

| Tool | License | Verdict |
|---|---|---|
| **Sourcegraph SCIP** | Apache-2.0 | Real, mature interchange protocol — the "correct architectural approach" (deterministic AST → graph), same conclusion Gemini's synthesis reached independently in the earlier CBA |
| **CodeQL** | MIT for queries, but the **CLI/engine has a restrictive license** — private/proprietary-code analysis in CI/CD is prohibited without a paid GitHub Advanced Security license | Richest representation in the whole set, but **not usable for this repo's private code without a paid license** — a real, decision-relevant constraint |
| **Kythe** (Google) | Apache-2.0 | Real, mature, heavyweight |
| **stack-graphs** (GitHub) | Apache-2.0/MIT | **Archived Sept 2025** — do not adopt |
| **tree-sitter-graph** | Apache-2.0/MIT | Low-level building block, not a turnkey tool |
| Aider repo-map | Apache-2.0 | Interesting hybrid of code-graph + line-addressable doc context, lightweight |
| Sourcegraph Cody | Effectively closed-source since 2025 | Not usable as an OSS dependency |
| ast-grep | MIT | Point-in-time structural search, not a persistent memory layer |
| Continue.dev indexing | Apache-2.0 | Semantic-search-oriented, light structural chunking |

**No code-graph tool surveyed — including Graphify — does cross-project blast-radius analysis natively.** This is a real, confirmed gap across the entire industry, not a Mnemosyne-specific miss (see §5, Tier 3).

### Orchestration / swarm memory patterns

| Tool | License | Verdict |
|---|---|---|
| **AutoGen** (Microsoft) | MIT | Society-of-Mind pattern — sub-team deliberation discarded, only final message crosses to parent. **Directly the mechanism Tier 1→2 delegation needs (§5).** |
| **LangGraph** | MIT | Thread-scoped checkpointer vs. cross-thread store, nested subgraphs with explicit private/shared state. **The load-bearing pattern recommended for Mnemosyne's own orchestration logic (§7).** |
| **CrewAI** | MIT | Hierarchical process — manager delegates, doesn't inherit worker context |
| **Semantic Kernel** (Microsoft) | MIT | Magentic manager holds a rolled-up view, not raw subordinate detail |
| MetaGPT | MIT | Structured pub/sub role-based pattern |
| claude-flow/ruflo, ruv-swarm | MIT | See §2 — real, but not recommended as infrastructure |
| OpenAI Swarm | MIT, deprecated | Educational only |

### Agentic RAG / context frameworks

| Tool | License | Verdict |
|---|---|---|
| LlamaIndex | Apache-2.0 core (mixed at plugin level — some connectors are GPL-3.0) | Semantic-search primary; PropertyGraphIndex is a real layer-2/3 hybrid pattern |
| Haystack | Apache-2.0 | Semantic-search + doc-index |
| LangChain / LangMem | MIT | Semantic-search when vector-backed |
| R2R | MIT | Semantic-search plus a genuine graph component |
| DSPy | MIT | Doesn't cleanly fit any of the 5 layers |

---

## 5. Final proposed architecture — the three-tier context-minimization hierarchy

This directly answers the operator's own framing, addressed tier by tier, not generically:

### Tier 1 — Top-level orchestrator (broad, shallow, across ALL companies/projects)

- **Holds:** a small, hand-curated, git-tracked registry — one short entry per company/project (repo list, primary resources/contacts, one-line product description). This generalizes the blog's own Layer 2 (CLAUDE.md — permanent, always-loaded) *across* companies instead of within one repo.
- **No vector search at this tier.** The corpus must be small enough to load in full every time — that's what "shallow" means operationally. If it ever outgrows always-loadable, the fallback is a Letta-style "core memory block" (small, agent-editable, always in context), not RAG — introducing retrieval here would mean this tier has stopped being shallow.
- **Delegation mechanism:** AutoGen's Society-of-Mind / LangGraph's nested-subgraph pattern — dispatch to a company-director agent, receive back only its compact final result, never its full working context. This is the concrete mechanism that keeps depth from leaking upward.
- **Open gap:** no registry-size ceiling was found anywhere in the research — needs empirical testing, not a research answer.

### Tier 2 — Company-level director (medium depth, ONE company)

- **Holds:** a company-wide CLAUDE.md-equivalent, a company-scoped semantic index, and a human-decision layer (Linear-ticket-equivalent) — this is the blog's Layer 2–5 pattern, re-scoped to one company.
- **Isolation mechanism:** one Qdrant collection (or payload-filtered namespace) per company, so a director's RAG queries are *structurally incapable* of pulling another company's data. The operator's own blog names this as aspirational ("Qdrant already supports multiple collections and namespaces... every node contributes to shared memory") — this design makes it real, not just claimed. **Unverified at scale — needs a real load/isolation test before being load-bearing.**
- **Entity tracking:** Mem0's User/Session/Agent scoping and CrewAI's entity memory are the closest patterns for tracking a company's products/resources as structured, evolving entities — worth adopting the *pattern*, integrated into Mnemosyne's own layer adapters, not bolting on a separate product.

### Tier 3 — Area architect (deep, ONE codebase, plus cross-project impact awareness)

- **Holds:** repo-scoped CLAUDE.md, the already-recommended Graphify code graph (deterministic AST, confirmed via PoC — see `cba-memory-layers.md`) for that codebase specifically, and a codebase-scoped Qdrant collection.
- **The hard part — cross-project impact:** confirmed, industry-wide, that **no surveyed tool does this natively** (SCIP, CodeQL, Kythe, Aider's repo-map, Graphify — all single-repo scoped by design). Resolution that preserves the hierarchy's own logic: **cross-project impact does not live at Tier 3.** An area architect holding deep context on every codebase it might affect would violate its own "deep but scoped" mandate. Instead: the company director (Tier 2, which already spans all of that company's repos at medium depth) maintains a lightweight cross-repo dependency index and answers a targeted *query upward* from the architect ("what else references this function?") with a compact, filtered answer — never bulk context pushed down.
- **Open gap:** this cross-repo dependency index doesn't exist anywhere as a tool — it's new engineering work, not a tool-adoption decision. Whether SCIP's cross-repo symbol interchange could seed it is plausible but unevaluated.

### Cross-cutting requirement for ALL three tiers: enforced injection, not optional retrieval

Directly following from §3's diagnostic: **every tier's context recipe must be injected by the orchestrator at spawn time, unconditionally** — mirroring the operator's own director's `processTicket()`. No tier should be able to skip its scoped retrieval step. This is pre-flight, mandatory, and logged — never a tool the spawned agent may or may not decide to call. **This is the single highest-leverage fix this entire research pass identified**, and Mnemosyne does not have it wired today.

---

## 6. Industry lessons learned

- **Tiered, scope-bounded memory is the near-universal converged pattern**, not a novel bet — Mem0 (User/Session/Agent), CrewAI (short/long-term/entity/contextual), Letta (core/archival/recall), LangGraph (thread-scoped vs. cross-thread), and the operator's own 2026 blog design all independently reinvent the same shape.
- **Pre-task retrieval + post-task write-back is equally converged** — the operator's own "key insight" is structurally identical to Mem0, LangMem's background manager, and Graphiti's episode ingestion. Systems differ on whether the loop is *enforced or optional* — see §3/§5, this is where Mnemosyne needs to differentiate.
- **Hierarchical delegation with compact upward summarization is the converged mechanism for keeping upper tiers shallow** — AutoGen, LangGraph, Semantic Kernel, and CrewAI all solve exactly the problem Tier 1→2→3 needs solved.
- **Memory-conflict trust-precedence is genuinely unsolved industry-wide.** The operator's own Firebase-incident rule (memory wins by default, contradicting claims escalate) has no equivalent in any surveyed framework — this is real, reusable IP worth keeping, not something to source externally.
- **Duplicate/repeated agent work (the 124-PR incident) is an orchestration-discipline problem, not a memory-layer problem** — no memory tool prevents this; don't expect a tool adoption to fix idempotency.
- **A meta-lesson from the verification pass itself, directly relevant to a memory-system CBA**: of 12 tools independently re-verified, roughly a third had real errors in the discovery pass (Marqo's backend, Zep's discontinuation year, Cognee's star count, txtai's framework attribution). **This is the exact failure mode Mnemosyne exists to prevent, and it recurred inside the research that's producing this document.** Anything adopted from this survey needs re-verification immediately before implementation, not trust-by-citation.

---

## 7. Recommendation on claude-flow/ruflo-style orchestration

**Do not adopt.** Two independent, convergent reasons: (1) the operator's own two production deployments of this exact tool family produced zero successful autonomous CI runs and were torn down — already self-audited as "pattern-library, not turnkey engine"; (2) its headline performance claims (84.8% SWE-Bench, 2.8–4.4x speedup) are self-reported in its own README, not independently verified anywhere in this research.

**What IS worth adopting: the underlying pattern**, sourced more cleanly from elsewhere in the survey — claude-flow's hooks system (auto-persist without an explicit agent call) is directionally what §5's "enforced injection" needs, but the same mechanism is independently validated with cleaner licensing in **LangGraph's checkpointer/store split**. Recommendation: build the three-tier hierarchy's orchestration logic in-house (as the operator's director already does), with a scoped PoC evaluating LangGraph as a state/checkpoint substrate — not adopting claude-flow/ruflo as infrastructure.

---

## 8. Open items before implementation

1. Cross-project impact index (Tier 3's hardest requirement) — original design work, not a tool adoption. Needs a build-vs-defer decision.
2. Qdrant collection/namespace-per-company isolation — unverified at scale, needs a real load/isolation test.
3. Enforced-recall/hook mechanism — the single highest-leverage fix identified; has no concrete implementation spec yet.
4. Cross-tier trust-precedence (stale Tier-2 summary vs. Tier-3 ground truth) — no industry precedent found; novel design work.
5. Consolidation mechanics — named everywhere (6-hour memory-agent container, LangMem's background manager) but never specified in enough detail to copy.
6. Tier 1's registry size ceiling — undefined, needs empirical testing.
7. Maintenance-risk tools flagged for exclusion if ever reconsidered: Kuzu (archived), Zep CE (discontinued 2025), stack-graphs (archived Sept 2025), CodeQL (restrictive license for private code).
8. This document does not include a story-level implementation plan — that's the next step once the above are resolved, and should happen through this repo's normal planning process (`.pHive/epics/`), not silently bundled into unrelated work.
