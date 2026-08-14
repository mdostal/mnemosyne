# CBA: Mnemosyne Memory Layers — Code Graph & Doc Index

**Status:** decision-ready research, not yet implemented. Nothing in this document has been built — this is the analysis the operator asked for before any layer-4/layer-3 work proceeds.
**Date:** 2026-08-14
**Method:** two independent research passes (a live-tool-verified pass using WebFetch/WebSearch/`gh api` against primary sources, and a Gemini 3.1 Pro synthesis pass), cross-checked against each other, with every disputed claim re-verified directly against primary sources before being trusted. See "Methodology note" below — this cross-checking caught a real, significant error.

## The target architecture (operator's spec, verbatim intent)

1. **Ways-of-working memory** — terse, repo-local operating rules. (Already fixed this session — see `.claude` memory for this repo.)
2. **Hierarchical meta-knowledge memory** — broader knowledge above a single repo, composing upward. **This is what `hive-memory` (plugin-hive's `kg.sqlite`) already is** — confirmed by querying real live rows (`phase_blocked`, `decided`, `validated`, `assigned_to` — a decision/lifecycle graph, not code structure).
3. **Indexed docs/READMEs/file store** — repo docs/files indexed with line-number/chunk addressability.
4. **Code graph** — structural relationships (imports, calls, dependencies, impact analysis).
5. **Semantic search** — already real (Qdrant Cloud + Ollama embeddings).

This CBA covers layers 3 and 4 — the two layers with no real solution today.

## What's actually real today (corrected understanding)

The original framing assumed two *independent* code-graph implementations. Direct code reading found otherwise: `CodeGraphLayerAdapter.ts`'s SQLite fallback reads the **same** `~/.local/share/swarm-memory/graph.sqlite` file the JS CLI wrapper also uses — they're two access paths onto one small dataset (~22 nodes / 30 edges, from markdown-link + Python-import scanning only — no real AST parsing, no JS/TS/Go/Rust support). Neither implementation has unique logic worth preserving; both are thin wrappers around an under-powered scan.

## Methodology note — a real finding, not a footnote

The two research passes **directly contradicted each other** on the single most important recommendation. The independent pass (real `WebFetch` + `gh api` calls against primary sources) found **Graphify** to be a massive (106,041 real GitHub stars, verified directly), local, tree-sitter-based code-graph tool. The Gemini pass confidently described "Graphify" as an experimental, LLM-based, Neo4j-backed extraction pipeline — a completely different tool.

Direct verification (fetching the real README) sided entirely with the independent pass: Graphify-Labs/graphify was created April 2026, is a genuine `/graphify` Claude Code skill, uses deterministic tree-sitter parsing for code (LLM-assisted only for docs/PDFs/images), stores locally in `graph.json`, and has zero relationship to Neo4j. Gemini's answer was a confident, detailed, wrong hallucination — almost certainly because a tool created in April 2026 postdates its training data, and it pattern-matched a plausible-sounding but fabricated description from the name alone.

**Takeaway:** for anything created in roughly the last year, treat single-LLM-synthesis claims as unverified until checked against a primary source (`gh api`, the actual README, the actual docs) — this applies to every future CBA/research pass this system does, not just this one. (Already captured in this session's `ways_of_working` memory: "verify agent self-reports before merging.")

## Tool-by-tool findings (primary-source verified)

| Tool | License | Verified facts | Layer fit |
|---|---|---|---|
| **Graphify** (`Graphify-Labs/graphify`) | Apache-2.0 | 106,041★ (verified `gh api`). Hybrid: **deterministic tree-sitter AST** for code (Python/TS/JS/Go/Rust/Java/C/C++/Ruby/C#/Kotlin/Scala), **LLM-assisted** (Claude) for docs/PDFs/images. Local `graph.json`, SHA256 content caching, zero telemetry. Literal `/graphify` Claude Code skill; also works with Cursor/Codex/Gemini CLI. | **Layer 4 AND layer 3** — the only candidate confirmed (via real README, not inference) to handle both code structure and documentation/PDF ingestion in one tool. |
| **CodeGraph** (`colbymchenry/codegraph`) | MIT | 66,291★ (verified `gh api`). Rust kernel (not Python — corrects a Gemini error), tree-sitter parsing, local SQLite + FTS5 (`.codegraph/codegraph.db`), auto-sync on file change. **Confirmed does NOT index markdown/docs** — code-only. | **Layer 4 only.** Real edge over Graphify: automatic re-sync (no manual re-scan step). Best fallback if Graphify's LLM-assisted doc path is undesirable. |
| **Understand-Anything** (`Egonex-AI/Understand-Anything`) | MIT | 79,228★ (verified `gh api`). Six-agent pipeline (scanner/analyzer/tour-builder/reviewer/domain-analyzer) → `.ua/knowledge-graph.json`. Local Ollama model support. | Layer 4, but shaped for **human-facing** guided tours/architecture explanation, not raw agent-queryable structure. Better fit for onboarding docs generation than Mnemosyne's programmatic recall path. |
| **SurrealDB** | BSL 1.1 (source-available, not permissive OSS; → Apache-2.0 after 4 years) | Multi-model DB, embeddable in Node via WASM/native bindings, native graph traversal syntax. Does **not** parse code itself — a storage engine, not an ingestion tool. | Possible layer 4 storage backend if SQLite's recursive-CTE queries become a real bottleneck at scale — not a near-term need. |
| **Neo4j** | GPLv3 (Community, free/self-hosted) or commercial (AuraDB, $65.70/mo+) | Mature, industry-standard, requires a running JVM service. | Not recommended — violates the local-first/low-dependency constraint for no clear benefit over the SQLite-based options above. |
| **Anthropic's KG cookbook** | N/A — a methodology, not a product | Structured-output extraction (`messages.parse()`) + LLM entity resolution + NetworkX graph. Validates the *existing* `hive-memory` (layer 2) approach. | Layer 2 pattern reference, not a layer 3/4 tool. |
| **paelladoc code-knowledge-graph** | Unconfirmed | Blog post describing the SCIP/LSIF/tree-sitter deterministic-AST approach — directionally correct methodology, but the actual product's license/maturity wasn't confirmed by either pass. | Directionally validates the tree-sitter approach; not independently actionable without further digging. |
| **Obsidian graph view** | Proprietary app, free personal use; vault is portable markdown+wikilinks | GUI-only, no agent-queryable API. | Conceptual reference for local/file-based layer 1-2 design, not a layer 3/4 tool for an agent-driven system. |
| **Mintlify** | Commercial SaaS | Docs-website generator for human consumption (MDX → hosted site). Line-number/chunk addressability for an embedded agent **not confirmed** — homepage-only research, would need a real docs deep-dive. | Not validated for layer 3 as-is. Don't adopt without a real technical check. |
| **Greptile** | Commercial SaaS ($30/seat/mo Pro, enterprise self-host option) | Real graph+vector ingestion, but code leaves your environment (cloud-primary) and is productized around PR review, not general agent recall. | Not recommended — violates local-first; wrong product shape. |

## Recommendation

**Layer 4 (code graph): adopt Graphify**, replacing both existing thin in-house implementations (neither has unique logic worth preserving — see above). CodeGraph is the documented fallback if Graphify's LLM-assisted doc path proves undesirable in practice. Both slot behind Mnemosyne's existing `LayerAdapter` interface and the `pl-01` pluggable registry — already the right seam for this, no client-side rework needed.

**Layer 3 (indexed docs): also Graphify**, given its confirmed (not inferred) doc/PDF ingestion — pending one direct verification step before committing: **does Graphify's doc-indexing preserve line-number/byte-offset addressability**, matching the layer-3 requirement, or does it only produce graph nodes without exact source-location pointers? Neither research pass confirmed this at the byte/line level — Gemini's fallback proposal (a simple SQLite FTS5 `(file, start_line, end_line, text)` table, hand-rolled) is a reasonable, low-risk backstop if Graphify's addressability turns out to be too coarse.

**Do NOT** adopt Neo4j, SurrealDB (yet), Mintlify, or Greptile for these layers — each violates the local-first/low-dependency constraint or isn't actually validated for the specific requirement (line-number addressability). SurrealDB stays a plausible future swap-in only if per-repo SQLite ever becomes a real bottleneck at a much larger fleet scale — not a near-term concern, and consistent with the operator's existing rejection of premature cross-repo architecture.

## Open items before implementation

1. **Verify Graphify's doc-indexing addressability directly** (run `/graphify` against this repo's own docs, inspect `graph.json` for line/byte pointers) — the one unconfirmed fact this recommendation still rests on.
2. **Decide whether to also fire off the async "fire off / poll / request more" pattern as a first-class Mnemosyne capability** — raised mid-session (2026-08-14): the operator flagged that the job-lifecycle shape used for the Gemini research call (submit, get a handle, poll status, request more) mirrors "how we deploy it, how we index, re-index, fire off those, inject, read, request" from their original vision. Not yet scoped as a story — worth a dedicated design pass, not bundled silently into the Graphify integration.
3. This document does not include an implementation plan/epic — that's the next step once the above two items are resolved, not before.
