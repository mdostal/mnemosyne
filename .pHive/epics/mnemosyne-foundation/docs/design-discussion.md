# Design Discussion: Mnemosyne Foundation

**Epic:** mnemosyne-foundation  
**Created:** 2026-07-27  
**Status:** Draft  

## §0 Prelude

### North Star

**Goal:** Unify memory layers behind one recall/write API so 'memory over find' becomes the default retrieval path for every agent

**Audience:** Pantheon gods (Minerva, Argus, Metis, etc.) and swarm agents

**Scale:** Cross-project meta-layer serving all Pantheon components

**Pain:** Memory infrastructure exists but is fragmented — no single god owns the layer stack, no unified API, agents fall back to grep/find

**Success:** One recall/write API in use by ≥1 other god spanning ≥3 layers; recall beats find on token cost

**Avoid:** Reinventing existing vector DB or embedder; wiping Qdrant collections; silent failures

## §1 Goal

Build Mnemosyne, the Pantheon's memory god — a unified recall/write API that consolidates six memory layers (meta/Obsidian → enterprise → project → code-graph → vector/Qdrant → file) behind a single interface. The immediate goal is to make "memory over find" the default retrieval path for all Pantheon agents, replacing fragmented grep/find calls with layered, provenance-tracked recall.

**Why now:** Memory infrastructure already exists (Qdrant Cloud, swarm-memory, Obsidian vault, flat markdown auto-memory) but it's manually wired and un-unified. Agents fall back to find/grep because there's no single memory API. This epic establishes Mnemosyne as the memory capability slot in the Pantheon.

## §2 Proposed Approach

### Architecture

**Layer Stack** (ordered, meta → narrow):

1. **Meta Layer** — Obsidian vault (human-curated cross-project knowledge)
2. **Enterprise Layer** — Cross-project org-wide standards
3. **Project Layer** — Per-project working knowledge
4. **Code-Graph Layer** — Impact graph with typed edges (depends_on, cites, implements)
5. **Vector Layer** — Qdrant Cloud for semantic search
6. **File Layer** — Raw grep fallback with loud failure

**Core APIs:**

- `recall(query, scope, intent)` — walks the layer stack (narrow→broad or broad→first depending on intent), merges/ranks hits, returns with provenance
- `remember(content, scope, layer?)` — routes write to appropriate layer(s), keeps indexes coherent

**Integration Strategy:**

- **Adopt, don't rewrite:** Wrap existing `swarm-memory` (~/Documents/work/dostal/code/swarm-memory) for vector + code-graph layers
- **Preserve existing data:** Do NOT wipe Qdrant collections (`~/.config/swarm-memory/qdrant.key`) or Obsidian vault
- **Pluggable backends:** Qdrant/Obsidian are defaults; layer contracts allow swapping

### Implementation Phases

**Phase 1: Core Recall API + File Layer**
- Define recall/remember interface contracts
- Implement file layer (grep-based) with loud failure
- Provenance schema (layer, source, chunk, timestamp, hash, embedder, retrieval time)

**Phase 2: Vector Layer Integration**
- Wrap swarm-memory Qdrant operations
- Implement recall escalation (file → vector)
- Test with existing Qdrant collections (read-only first)

**Phase 3: Code-Graph Layer**
- Wrap swarm-memory impact graph (SQLite-backed)
- Add graph edges to recall results
- Continuous indexing (event-driven)

**Phase 4: Project/Enterprise/Meta Layers**
- Obsidian vault indexer (markdown → vector)
- Project-scoped memory (decisions, context)
- Enterprise layer (promoted CBAs, org standards)

**Phase 5: Continuous Indexing + Viewability**
- Multica-native scheduling for index refresh
- Consus/Janus read model integration
- Staleness tracking

## §3 Scale Assessment

**Recommendation: LARGE**

**Rationale:**

- **Multi-system:** Integrates 6 distinct memory layers, 3 existing systems (Qdrant, swarm-memory, Obsidian)
- **Cross-stack:** Spans vector DB, SQLite graph, markdown parsing, scheduling
- **Long-horizon:** 5 implementation phases, continuous indexing, integration with Consus/Janus
- **Hard constraints:** Must preserve existing data, loud failure requirement, pluggable backends

**Complexity drivers:**

- Escalation logic (when to move narrow→broad, merge/rank across layers)
- Provenance tracking across heterogeneous sources
- Continuous indexing without box cron (Multica-native only)
- Integration surface for other gods (Minerva, Argus, Metis)

## §4 Open Questions

1. **Runtime model:** Should Mnemosyne be a library (imported by gods) or a service (HTTP/RPC)? Library avoids network latency; service enables shared index state.

2. **Obsidian vault location:** Where is the "hive's default Obsidian vault"? The idea brief references it but no path is detected in integrations.

3. **Enterprise layer scope:** What defines "org-wide standards" vs "project memory"? Is there a physical boundary (directory, repo)?

4. **Escalation triggers:** When does recall escalate from narrow→broad? Token budget? Zero hits? Confidence threshold?

5. **Write routing:** How does `remember(content, scope, layer?)` decide the target layer when `layer` is omitted? Intent-based? Scope-based?

## §5 Risks & Dependencies

### Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Qdrant collection corruption** | HIGH | Read-only mode first; backup before write ops; loud-fail on unexpected state |
| **swarm-memory API drift** | MEDIUM | Pin to specific commit; integration tests against real repo |
| **Escalation performance** | MEDIUM | Layer-specific timeouts; short-circuit on high-confidence hits |
| **Obsidian vault missing** | HIGH | Graceful degradation; file layer fallback; document setup in README |

### Dependencies

- **Existing:** Qdrant Cloud account + key at `~/.config/swarm-memory/qdrant.key`
- **Existing:** swarm-memory repo at `~/Documents/work/dostal/code/swarm-memory`
- **Missing:** Obsidian vault (integrations show `detected: false`)
- **Missing:** Multica scheduler (referenced but not detected)
- **External:** Consus/Janus for viewability surface

### Cross-Cutting Concerns

From `.pHive/cross-cutting-concerns.yaml`:

- **Loud failure:** Every layer must flag degraded state; file layer is the loud-failure floor
- **Provenance completeness:** All 7 fields required (layer, source, chunk_span, index_timestamp, content_hash, embedder, retrieval_time)
- **Existing infrastructure:** Preserve Qdrant collections, swarm-memory state, Obsidian vault structure
- **Documentation:** API contracts, layer implementations, integration guides
- **Versioning:** Semver bumps for recall/remember API changes

## §6 Success Criteria

**Acceptance:**

- One `recall(query, scope, intent)` API in use by ≥1 other Pantheon god
- Hits span ≥3 layers (e.g., project → code-graph → vector)
- Every hit includes full provenance (7 fields)
- Recall beats `find` on token cost for representative queries

**Validation:**

- Integration test with real Qdrant collections (read-only)
- Layer escalation test (file → vector → code-graph)
- Provenance completeness test (all fields present)
- Performance benchmark (recall vs grep on 1000-file codebase)

## §7 Alternatives Considered

**Alternative 1: Extend swarm-memory directly**
- **Rejected:** swarm-memory is Qdrant-focused; adding 5 more layers bloats its scope
- **Pro:** Reuses existing CLI
- **Con:** Doesn't establish Mnemosyne as a standalone god

**Alternative 2: Service-first architecture**
- **Deferred:** Start with library for latency; service wrapper can come later
- **Pro:** Shared index state across gods
- **Con:** Network overhead, deployment complexity

**Alternative 3: Single-layer MVP (vector only)**
- **Rejected:** Doesn't solve the fragmentation problem; just wraps one existing system
- **Pro:** Faster to ship
- **Con:** No layered recall, no escalation, no unified API

## §8 Next Steps

1. **Resolve open questions** (runtime model, vault location, escalation triggers)
2. **Confirm tech stack** (language/runtime for unified API)
3. **Decompose into stories** — prioritize Phase 1 (core API + file layer) for quick feedback loop
4. **Set up integration test harness** (read-only Qdrant, swarm-memory fixture)
