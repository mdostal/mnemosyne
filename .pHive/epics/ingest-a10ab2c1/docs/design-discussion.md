# Design Discussion: Comprehensive Memory Ingestion

## §0 PRELUDE

### Research Brief Summary
We have scattered context across Qdrant Cloud collections, repos (FFE + mdostal orgs), client deliverables, house/compound decision discussions, and published artifacts. NONE of it is systematically in Mnemosyne + the org-tree. This epic brings ALL of it into our system through a staged ingestion pipeline.

### PRIOR DECISIONS
*(None found via /hive:why pre-flight)*

### NORTH STAR
**Goal:** Unify memory layers behind one recall/write API so 'memory over find' becomes the default retrieval path  
**Audience:** Pantheon gods + swarm agents  
**Scale:** Cross-project meta-layer serving all Pantheon components  
**Pain:** Memory infrastructure exists but is fragmented — agents fall back to grep/find

## §1 GOAL

Systematically ingest ALL scattered context into Mnemosyne memory + place it into the org-tree so the entire system knows our real world: repos, clients, house/compound decisions, artifacts, and (later) Gemini chat history.

**Success signals:**
- Every Qdrant collection inventoried + mapped to org-tree nodes
- All FFE + mdostal repos indexed (high-level: purpose, structure, key docs)
- Client work + deliverables in memory under Dostal > work > clients
- House/compound decisions captured under Dostal > personal > house/moving
- Published artifacts in marketing/company KB + org-tree
- Continuous indexing pipeline established (repeatable, not one-off)
- Recall across ≥3 layers spans ingested content

## §2 PROPOSED APPROACH

### 2.1 Staged Ingestion Pipeline

**Phase 1: Inventory**
- Qdrant: read collections list (Cloud API), count entries per collection
- Repos: GitHub API list all repos (FFE org + mdostal account)
- Artifacts: file-scan known artifact dirs (marketing/, financial/, positioning/)
- Client data: locate Clients-tab data source
- House/compound: locate discussion artifacts (Slack exports? email? docs?)

**Phase 2: Org-Tree Scaffolding**
- Establish hierarchy: Dostal > {work, personal, pantheon}
- Define placement rules per source type
- Design dedup strategy (content hashing + provenance tracking)

**Phase 3: Bulk Ingest (staged by source)**
1. **Qdrant reconciliation** — merge existing collections into Mnemosyne vector layer
2. **Repo index** — high-level indexing (README, purpose, structure, key docs) into project layer
3. **Client work** — deliverables + metadata into enterprise/project layers
4. **House/compound** — decision artifacts into meta layer (Obsidian vault?)
5. **Artifacts** — published docs into marketing KB + meta layer

**Phase 4: Continuous Indexing Setup**
- Multica-native scheduling (no box cron)
- File watchers for local artifacts
- GitHub webhooks for repo changes
- Qdrant change-feed monitoring

**Phase 5: Verification**
- Recall tests across layers confirm queryability
- Provenance tracking validates source attribution
- Coverage audit: compare inventory to indexed items

### 2.2 Key Design Decisions

**Decision 1:** Inventory-first, not inline discovery  
**Rationale:** Unknown scale (Qdrant count, repo count). Inventory phase bounds the work before bulk ingest begins.

**Decision 2:** Staged by source type, not by org-tree node  
**Rationale:** Sources have different access patterns (Qdrant API, GitHub API, file-scan). Group by tech surface, map to org-tree after retrieval.

**Decision 3:** High-level repo index only (not full code-graph)  
**Rationale:** Seed specifies "high level (purpose, structure, key docs)". Full code-graph is Mnemosyne's continuous indexing job, not this epic's scope.

**Decision 4:** Gemini discussions deferred (human blocker)  
**Rationale:** Export did NOT come out correctly. Mathew must re-export. File as HUMAN-QUEUE TODO; alert operator.

**Decision 5:** Loud failure on missing sources  
**Rationale:** Pantheon hard requirement. If a source is unreachable (Qdrant auth fail, GitHub API rate limit), halt + surface error rather than silently skip.

### 2.3 Deduplication Strategy
- **Content hash** (SHA-256 of normalized content) as primary dedup key
- **Provenance tracking** keeps original source + timestamp even when content is duplicate
- **Escalation on collision:** when same content hash appears from different sources, escalate to meta layer with both provenances recorded

### 2.4 Org-Tree Placement Rules

| Source Type | Org-Tree Path | Notes |
|-------------|---------------|-------|
| Qdrant collections | Mapped per collection metadata (project-scoped or enterprise-scoped) | Collection name hints at scope |
| FFE repos | Dostal > pantheon > gods > {repo-name} | Pantheon projects |
| mdostal repos | Dostal > work > {repo-category} | Personal/client work |
| Client deliverables | Dostal > work > clients > {client-name} | Per-client subtree |
| House/compound | Dostal > personal > house > moving | Life decisions |
| Artifacts (marketing, financial) | Dostal > work > dostal-technology > {artifact-type} | Company KB |

## §3 RISKS & MITIGATIONS

### Risk 1: Qdrant collection count unknown
**Severity:** Medium  
**Impact:** Cannot estimate ingestion time or memory requirements  
**Mitigation:** Inventory phase runs first; gates bulk ingest on bounded count

### Risk 2: Repo count explosion (hundreds of repos?)
**Severity:** Medium  
**Impact:** High-level indexing may still take hours if repo count is massive  
**Mitigation:** Parallel indexing (10 repos at a time); progress tracking; timeout per repo (skip + log on timeout)

### Risk 3: Gemini export blocker
**Severity:** High (for completeness goal)  
**Impact:** Cannot ingest Gemini chat history until Mathew re-exports  
**Mitigation:** Surface as HUMAN-QUEUE alert; proceed with other sources; Gemini is additive later

### Risk 4: Obsidian vault location unknown
**Severity:** Medium  
**Impact:** Cannot ingest meta-layer human-curated knowledge  
**Mitigation:** Detection step in Phase 1 inventory; if missing, prompt operator for path

### Risk 5: Continuous indexing scheduling (Multica dependency)
**Severity:** Medium  
**Impact:** Post-ingestion freshness depends on Multica daemon  
**Mitigation:** Multica-init verification step before Phase 4; fallback to manual re-run if Multica unavailable

### Risk 6: Silent data loss from dedup errors
**Severity:** High  
**Impact:** Collision handling bug could drop provenance or merge incorrectly  
**Mitigation:** Provenance tracking required; unit tests for dedup logic; audit log for all merges

## §4 DEPENDENCIES

### Hard Dependencies (blockers)
1. **Mnemosyne framework exists** — recall/write API + layer stack
2. **Org-tree scaffold** — hierarchy structure established
3. **Qdrant auth** — key at `~/.config/swarm-memory/qdrant.key` valid
4. **GitHub PAT** — token with read:org + read:repo scopes

### Soft Dependencies (degrade gracefully)
1. **Multica daemon** — for continuous indexing; manual fallback if unavailable
2. **Obsidian vault** — meta layer; can proceed without if not found
3. **Gemini export** — deferred to human operator

## §5 OPEN QUESTIONS

1. **Qdrant collection count?** Unknown until inventory runs. Estimate 10-50?
2. **Exact repo count?** FFE org has ~20 public repos visible; mdostal unknown. Estimate 50-100 total?
3. **Obsidian vault path?** Not auto-detected. Operator input needed.
4. **Client deliverables location?** Unknown. File-scan candidates: ~/Documents/work/clients, ~/Dropbox/clients?
5. **House/compound discussion artifacts?** Slack export? Email? Google Docs? Needs operator input.
6. **Continuous indexing frequency?** Hourly? Daily? Event-driven only?

## §6 SCALE ASSESSMENT

**Recommended Scale:** Large

**Rationale:**
- Multi-system ingestion (Qdrant, GitHub, file-system, future Gemini)
- Unknown data volume (repos could be 50-100+, Qdrant collections unknown count)
- Requires H/V planning to sequence inventory → scaffold → ingest → continuous-index
- Cross-cutting concerns: metrics (ingestion rate, recall coverage), error handling (loud failure), dedup audit trail

**H/V Planning Required:**
- Horizontal: inventory, scaffold, bulk-ingest, continuous-index, verification
- Vertical slicing: Qdrant-only vertical slice (end-to-end one source type) validates pipeline before scaling to all sources

**Structured Outline Required:** Yes — detailed plan with operator elicitation for unknown paths (Obsidian vault, client deliverables, house/compound discussions)

---

## Design Discussion Metadata
- **Epic ID:** ingest-a10ab2c1
- **Author:** orchestrator
- **Timestamp:** 2026-07-28
- **Review Status:** Pending team review
