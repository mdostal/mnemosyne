# Vertical Plan: Comprehensive Memory Ingestion

## Epic Context
**ID:** ingest-a10ab2c1  
**Horizontal Capabilities:** Inventory, Scaffold, Bulk Ingest, Continuous Index, Verification

## Vertical Slicing Strategy

**Rationale:** Unknown data volume + multi-system complexity requires vertical slicing to validate the end-to-end pipeline before scaling. Each slice delivers a working product increment that exercises all 5 horizontal capabilities on a bounded subset.

**Slice Ordering Principle:** Start with simplest source (Qdrant — API-only, no filesystem), validate pipeline, then scale to more complex sources (repos, artifacts, life decisions).

---

## Slice 1: Qdrant-Only End-to-End
**Goal:** Validate full pipeline (inventory → scaffold → ingest → continuous-index → verify) on Qdrant collections alone

### Scope
- **Inventory:** Qdrant collections only (skip repos, artifacts, etc.)
- **Scaffold:** Org-tree subset (just Qdrant collection placement rules)
- **Ingest:** Merge Qdrant collections into Mnemosyne vector layer
- **Continuous Index:** Qdrant change-feed monitoring only
- **Verify:** Recall tests on Qdrant-sourced content

### Delivered Value
- Qdrant collections are queryable through Mnemosyne
- Org-tree has Qdrant-mapped nodes
- Continuous indexing works for Qdrant updates
- Pipeline validated before scaling to other sources

### Acceptance Criteria
- All Qdrant collections inventoried (count + metadata)
- Collections merged into Mnemosyne vector layer (provenance preserved)
- Recall test retrieves content from ≥3 collections
- Continuous indexing detects + indexes a manual test update

### Stories
1. **Qdrant Collection Inventory** (complexity: low)
   - Connect to Qdrant Cloud
   - List collections via API
   - Write inventory manifest

2. **Qdrant Org-Tree Placement Rules** (complexity: medium)
   - Map collection metadata → org-tree path
   - Implement placement logic
   - Unit test on sample collections

3. **Qdrant → Mnemosyne Ingest** (complexity: high)
   - Merge collections into vector layer
   - Preserve provenance (original collection name + timestamp)
   - Parallel workers (10 concurrent)

4. **Qdrant Continuous Indexing** (complexity: medium)
   - Multica job registration
   - Change-feed monitoring (if API supports, else poll)
   - Incremental update logic

5. **Qdrant Recall Verification** (complexity: low)
   - Sample recalls across ingested collections
   - Coverage audit (inventory vs indexed)
   - Audit report generation

**Dependencies:** 1 → 2 → 3 → 4 (parallel with 5 after 3)

---

## Slice 2: Repository Index Scale-Out
**Goal:** Add all repos (FFE + mdostal) while preserving Slice 1's Qdrant functionality

### Scope
- **Inventory:** Repos (GitHub API)
- **Scaffold:** Repo placement rules (pantheon vs work/repos categorization)
- **Ingest:** High-level repo index (README, purpose, structure)
- **Continuous Index:** GitHub webhook integration (if available)
- **Verify:** Recall tests on repo metadata

### Delivered Value
- All FFE + mdostal repos indexed at high level
- Repos placed in org-tree (auto-categorized or operator-tagged)
- Repository changes trigger re-index
- Qdrant functionality from Slice 1 still works

### Acceptance Criteria
- All repos inventoried (FFE org + mdostal account)
- High-level index (README, purpose, structure) in Mnemosyne project layer
- Recall test retrieves repo metadata (e.g., "find Minerva repo purpose")
- Continuous indexing detects + re-indexes a manual test commit

### Stories
1. **GitHub Repo Inventory** (complexity: low)
   - GitHub API auth (PAT from operator or Portunus)
   - List FFE org repos
   - List mdostal account repos
   - Merge into inventory manifest

2. **Repo Categorization & Placement** (complexity: medium)
   - Detect pantheon gods (keywords: mnemosyne, minerva, etc.)
   - Categorize work/repos by topic (heuristics or operator tags)
   - Implement placement rules

3. **Repo High-Level Indexing** (complexity: high)
   - For each repo: clone shallow (depth=1) or API-only fetch
   - Extract README, purpose, structure (top-level dirs)
   - Index into Mnemosyne project layer
   - Parallel workers (10 concurrent, rate-limited)

4. **Repo Continuous Indexing** (complexity: medium)
   - GitHub webhook integration (if available)
   - Fallback: daily poll for changes
   - Incremental update (only re-index changed repos)

5. **Repo Recall Verification** (complexity: low)
   - Sample recalls on repo metadata
   - Coverage audit
   - Regression test: Qdrant recalls still work

**Dependencies:** 1 → 2 → 3 → 4 (parallel with 5 after 3)

---

## Slice 3: Artifacts & Client Work
**Goal:** Add published artifacts + client deliverables

### Scope
- **Inventory:** Artifacts (file-scan), client deliverables
- **Scaffold:** Dostal/work/dostal-technology + Dostal/work/clients paths
- **Ingest:** Artifacts → company KB, client work → enterprise/project layers
- **Continuous Index:** File watchers on artifact dirs
- **Verify:** Recall tests on artifacts + client metadata

### Delivered Value
- Marketing playbook, financial docs, positioning docs queryable
- Client deliverables + metadata indexed
- Artifact changes trigger re-index
- Slices 1+2 functionality preserved

### Acceptance Criteria
- All artifacts inventoried (count + file types)
- Client deliverables indexed (per-client subtrees)
- Recall test retrieves artifact content (e.g., "find marketing playbook section on X")
- File watcher detects + re-indexes a manual test edit

### Stories
1. **Artifact & Client Data Inventory** (complexity: low)
   - File-scan known dirs (~/Documents/work/, ~/Dropbox/)
   - Locate marketing/, financial/, positioning/, clients/
   - Write inventory manifest

2. **Artifact & Client Org-Tree Placement** (complexity: low)
   - Define paths: Dostal/work/dostal-technology/{type}
   - Define paths: Dostal/work/clients/{client-name}
   - Implement placement rules

3. **Artifact & Client Ingest** (complexity: medium)
   - Parse docs (markdown, PDF, etc.)
   - Index into meta/enterprise/project layers
   - Parallel workers (10 concurrent)

4. **Artifact Continuous Indexing** (complexity: low)
   - File watchers (fswatch or inotify)
   - Incremental update on change
   - Multica job registration

5. **Artifact & Client Recall Verification** (complexity: low)
   - Sample recalls on artifacts + client data
   - Coverage audit
   - Regression test: Slices 1+2 still work

**Dependencies:** 1 → 2 → 3 → 4 (parallel with 5 after 3)

---

## Slice 4: House/Compound Decisions (Life Context)
**Goal:** Add personal life decisions (house-hunting, moving, compound choice)

### Scope
- **Inventory:** House/compound discussion artifacts
- **Scaffold:** Dostal/personal/house/moving path
- **Ingest:** Decisions → meta layer (Obsidian vault integration?)
- **Continuous Index:** Manual trigger (life decisions change infrequently)
- **Verify:** Recall tests on life context

### Delivered Value
- Arizona compound vs Wyoming compound decision history queryable
- Moving chaos discussions indexed
- Life context available to agents (e.g., "recall compound decision criteria")
- Slices 1+2+3 functionality preserved

### Acceptance Criteria
- House/compound artifacts inventoried (location confirmed with operator)
- Decisions indexed into meta layer
- Recall test retrieves decision rationale (e.g., "why Arizona compound preferred?")
- Manual re-index command available

### Stories
1. **House/Compound Artifact Inventory** (complexity: low)
   - Prompt operator for location (Slack export? email? docs?)
   - File-scan or API-fetch artifacts
   - Write inventory manifest

2. **Life Context Org-Tree Placement** (complexity: low)
   - Define path: Dostal/personal/house/moving
   - Implement placement rules

3. **House/Compound Decision Ingest** (complexity: medium)
   - Parse discussion artifacts (text, email threads, docs)
   - Extract decision points + rationale
   - Index into meta layer (Obsidian vault if available)

4. **Life Context Manual Re-Index** (complexity: low)
   - CLI command: `mnemosyne re-index --source=personal/house`
   - No continuous indexing (infrequent changes)

5. **Life Context Recall Verification** (complexity: low)
   - Sample recalls on compound decision history
   - Coverage audit
   - Regression test: Slices 1+2+3 still work

**Dependencies:** 1 → 2 → 3 → 4 (parallel with 5 after 3)

---

## Slice 5: Gemini Discussions (Deferred, Human-Blocked)
**Goal:** Placeholder slice for Gemini chat history (blocked on operator re-export)

### Scope
- **Inventory:** Gemini chat export (when available)
- **Scaffold:** Placement TBD (personal? pantheon/discussions?)
- **Ingest:** Chat history → meta/enterprise layer
- **Continuous Index:** Manual trigger (historical data)
- **Verify:** Recall tests on chat content

### Delivered Value
- Gemini chat history queryable (when unblocked)
- Completes "EVERYTHING" goal from seed

### Acceptance Criteria
- ⭐ **BLOCKER:** Gemini export must be re-done by operator
- Once unblocked: inventory → ingest → verify (same pattern as Slices 1-4)

### Stories
1. **Gemini Export Human-Queue Alert** (complexity: low)
   - File HUMAN-QUEUE TODO: "Re-export Gemini chat history"
   - Surface alert to operator
   - Write placeholder in inventory manifest

2. **Gemini Ingest (Deferred)** (complexity: unknown)
   - Blocked until Story 1 resolves
   - Pattern: same as Slice 4 (parse → index → verify)

**Dependencies:** 1 (alert only); Story 2 depends on operator action outside this epic

---

## Vertical Slice Summary

| Slice | Scope | Stories | Working Product Increment |
|-------|-------|---------|---------------------------|
| 1 | Qdrant-only | 5 | Qdrant collections queryable through Mnemosyne |
| 2 | + Repos | 5 | All repos indexed; Qdrant still works |
| 3 | + Artifacts & clients | 5 | Company KB + client data queryable; 1+2 still work |
| 4 | + House/compound | 5 | Life context queryable; 1+2+3 still work |
| 5 | + Gemini (deferred) | 2 | Chat history queryable (when unblocked) |

**Total Stories:** 22 (5+5+5+5+2)

**Critical Path:** Slice 1 → Slice 2 → Slice 3 → Slice 4 (sequential; each slice delivers working state)

**Parallelization:** Within each slice, stories 4 (continuous index) and 5 (verify) can run in parallel after story 3 (ingest) completes.

---

## Vertical Plan Metadata
- **Epic ID:** ingest-a10ab2c1
- **Slices:** 5 (Qdrant, Repos, Artifacts/Clients, House/Compound, Gemini-deferred)
- **Total Stories:** 22
- **Review Status:** Pending team review
