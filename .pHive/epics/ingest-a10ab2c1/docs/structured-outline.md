# Structured Outline: Comprehensive Memory Ingestion

## Epic Summary
**ID:** ingest-a10ab2c1  
**Title:** Ingest EVERYTHING into memory and org-tree  
**Goal:** Systematically ingest all scattered context (Qdrant collections, repos, clients, house/compound decisions, artifacts, future Gemini history) into Mnemosyne memory + org-tree through a staged pipeline.

**Vertical Slices:** 5 slices delivering incremental value  
**Total Stories:** 22 (5 per slice for Slices 1-4, 2 for Slice 5-deferred)

---

## SLICE 1: Qdrant-Only End-to-End

### Goal
Validate full pipeline on Qdrant collections alone before scaling to other sources.

### Story 1.1: Qdrant Collection Inventory
**Complexity:** Low  
**Depends On:** []

**Description:**
Connect to Qdrant Cloud and inventory all existing collections. This is the discovery phase that bounds the bulk ingestion work.

**Acceptance Criteria:**
- [ ] Qdrant Cloud connection established (auth key from `~/.config/swarm-memory/qdrant.key`)
- [ ] All collections listed via API
- [ ] Collection metadata extracted (name, entry count, created date)
- [ ] Inventory manifest written to `.pHive/epics/ingest-a10ab2c1/inventory/qdrant-collections.yaml`

**Context:**
- **Tech Stack:** Qdrant Cloud API, Python `qdrant-client` library
- **Key Files:**
  - `~/.config/swarm-memory/qdrant.key` — Qdrant API key
  - `~/Documents/work/dostal/code/swarm-memory/` — existing swarm-memory CLI (reference implementation)

**Files to Modify:**
- `file`: `.pHive/epics/ingest-a10ab2c1/inventory/qdrant-collections.yaml`
  - `change`: Create inventory manifest with collection list

**Design Decisions:**
- **Decision:** Use read-only API calls only (no collection deletion/modification)
  - **Rationale:** Seed specifies "do NOT wipe" existing collections

**Risks:**
- **Severity:** Medium  
  - **Description:** Qdrant auth key invalid or expired
  - **Mitigation:** Loud failure with clear error message; prompt operator for new key

**Cross-Cutting:**
- `concern`: metrics
  - `action`: Track collection count discovered

**Methodology:** classic  
**Steps:**
1. Research: Explore swarm-memory CLI for Qdrant connection patterns
2. Implement: Write inventory script
3. Test: Run against Qdrant Cloud; verify manifest
4. Review: Check manifest completeness
5. Integrate: Commit to feat/ingest-a10ab2c1

---

### Story 1.2: Qdrant Org-Tree Placement Rules
**Complexity:** Medium  
**Depends On:** [1.1]

**Description:**
Define how Qdrant collections map to org-tree nodes based on collection metadata.

**Acceptance Criteria:**
- [ ] Placement rule logic implemented
- [ ] Collection metadata → org-tree path mapping tested on sample data
- [ ] Unit tests cover edge cases (missing metadata, ambiguous names)
- [ ] Rule documentation written to `.pHive/epics/ingest-a10ab2c1/docs/placement-rules.md`

**Context:**
- **Org-Tree Reference:** `[[org-tree-hierarchy-structure]]`
- **Heuristics:**
  - Collection name contains "project-" → project-scoped
  - Collection name contains "enterprise-" → enterprise-scoped
  - Default: enterprise-scoped

**Files to Modify:**
- `file`: `mnemosyne/placement_engine.py` (new)
  - `change`: Implement placement rule logic
- `file`: `mnemosyne/tests/test_placement.py` (new)
  - `change`: Unit tests for placement rules

**Design Decisions:**
- **Decision:** Heuristic-based placement with operator override
  - **Rationale:** Collection names may not follow consistent naming; allow manual tagging

**Risks:**
- **Severity:** Low  
  - **Description:** Heuristics misclassify collections
  - **Mitigation:** Dry-run mode shows placement before committing; operator can override

---

### Story 1.3: Qdrant → Mnemosyne Ingest
**Complexity:** High  
**Depends On:** [1.2]

**Description:**
Merge Qdrant collections into Mnemosyne vector layer while preserving provenance.

**Acceptance Criteria:**
- [ ] All collections from inventory merged into Mnemosyne
- [ ] Provenance tracking records original collection name + timestamp
- [ ] Parallel workers (10 concurrent) with rate limiting
- [ ] Progress tracking logs (N of M collections ingested)
- [ ] Error handling: loud failure on auth/network errors, retry logic (3 attempts)
- [ ] Dedup logic tested (content hash collision → escalate with both provenances)

**Context:**
- **Mnemosyne API:** `mnemosyne.write(content, scope, layer='vector', provenance={...})`
- **Dedup Strategy:** SHA-256 content hash; collision → merge provenance

**Files to Modify:**
- `file`: `mnemosyne/ingestion/qdrant_ingest.py` (new)
  - `change`: Implement bulk ingest with parallel workers
- `file`: `mnemosyne/dedup.py` (new)
  - `change`: Content hashing + collision handling

**Design Decisions:**
- **Decision:** Parallel workers limited to 10 concurrent
  - **Rationale:** Avoid overwhelming Qdrant Cloud API (rate limits)

**Risks:**
- **Severity:** High  
  - **Description:** Dedup collision bug could drop provenance or merge incorrectly
  - **Mitigation:** Unit tests for dedup logic; audit log for all merges

**Cross-Cutting:**
- `concern`: metrics
  - `action`: Track ingestion rate (items/second), dedup collision count

---

### Story 1.4: Qdrant Continuous Indexing
**Complexity:** Medium  
**Depends On:** [1.3]

**Description:**
Set up continuous indexing to keep Qdrant-sourced memory fresh.

**Acceptance Criteria:**
- [ ] Multica job registered for Qdrant change-feed monitoring
- [ ] Incremental update logic implemented (only re-index changed items)
- [ ] Manual re-index command available (fallback if Multica unavailable)
- [ ] Change detection tested (manual test update triggers re-index)

**Context:**
- **Multica:** Verify daemon running; register scheduled job
- **Frequency:** Daily (default); configurable

**Files to Modify:**
- `file`: `mnemosyne/continuous_index/qdrant_watcher.py` (new)
  - `change`: Change-feed monitoring or polling logic
- `file`: `.multica/jobs/qdrant-reindex.yaml` (new)
  - `change`: Multica job definition

**Design Decisions:**
- **Decision:** Daily poll (not real-time webhooks)
  - **Rationale:** Qdrant API may not support change webhooks; polling is simpler

**Risks:**
- **Severity:** Medium  
  - **Description:** Multica daemon not running
  - **Mitigation:** Graceful degradation: manual re-index command available

---

### Story 1.5: Qdrant Recall Verification
**Complexity:** Low  
**Depends On:** [1.3]

**Description:**
Verify ingested Qdrant content is queryable through Mnemosyne.

**Acceptance Criteria:**
- [ ] Sample recalls across ≥3 ingested collections
- [ ] Provenance tracking verified (original collection name visible)
- [ ] Coverage audit: inventory count matches indexed count
- [ ] Audit report written to `.pHive/epics/ingest-a10ab2c1/audits/qdrant-verification.md`

**Context:**
- **Mnemosyne API:** `mnemosyne.recall(query, scope, layers=['vector'])`

**Files to Modify:**
- `file`: `mnemosyne/tests/test_qdrant_recall.py` (new)
  - `change`: Recall verification tests

**Design Decisions:**
- **Decision:** Sample-based verification (not exhaustive)
  - **Rationale:** Large collection count makes exhaustive testing impractical

---

## SLICE 2: Repository Index Scale-Out

### Goal
Add all repos (FFE + mdostal) while preserving Slice 1's Qdrant functionality.

### Story 2.1: GitHub Repo Inventory
**Complexity:** Low  
**Depends On:** [1.5]

**Description:**
Inventory all repositories across FFE org and mdostal account.

**Acceptance Criteria:**
- [ ] GitHub API auth established (PAT from operator or Portunus)
- [ ] FFE org repos listed
- [ ] mdostal account repos listed
- [ ] Repo metadata extracted (name, description, language, last update)
- [ ] Inventory manifest updated: `.pHive/epics/ingest-a10ab2c1/inventory/repos.yaml`

**Context:**
- **GitHub API:** `gh api orgs/firefly-events/repos`, `gh api users/mdostal/repos`
- **Auth:** Prompt operator for PAT if missing; store in Portunus

**Files to Modify:**
- `file`: `.pHive/epics/ingest-a10ab2c1/inventory/repos.yaml`
  - `change`: Create repo inventory manifest

**Cross-Cutting:**
- `concern`: metrics
  - `action`: Track repo count discovered (FFE vs mdostal breakdown)

---

### Story 2.2: Repo Categorization & Placement
**Complexity:** Medium  
**Depends On:** [2.1]

**Description:**
Categorize repos (pantheon gods vs client work) and define org-tree placement.

**Acceptance Criteria:**
- [ ] Pantheon god detection (keywords: mnemosyne, minerva, argus, etc.)
- [ ] Client/work categorization (heuristics or operator tags)
- [ ] Placement rules documented + tested
- [ ] Ambiguous repos flagged for operator review

**Context:**
- **Pantheon Keywords:** mnemosyne, minerva, argus, metis, portunus, consus, janus, vesta
- **Org-Tree Paths:**
  - Pantheon gods → `Dostal/pantheon/gods/{repo-name}`
  - Client work → `Dostal/work/repos/{category}`

**Files to Modify:**
- `file`: `mnemosyne/placement_engine.py`
  - `change`: Add repo categorization logic

**Design Decisions:**
- **Decision:** Keyword-based detection with operator review for ambiguous cases
  - **Rationale:** Some repos may not follow naming conventions

---

### Story 2.3: Repo High-Level Indexing
**Complexity:** High  
**Depends On:** [2.2]

**Description:**
Index repos at high level (README, purpose, structure) into Mnemosyne project layer.

**Acceptance Criteria:**
- [ ] For each repo: extract README, purpose (from description), top-level directory structure
- [ ] Index into Mnemosyne project layer
- [ ] Parallel workers (10 concurrent, GitHub API rate-limited)
- [ ] Progress tracking logs
- [ ] Error handling: skip + log on timeout (per-repo timeout: 30s)

**Context:**
- **Indexing Approach:** Shallow clone (depth=1) OR API-only fetch (GitHub Contents API)
- **Mnemosyne API:** `mnemosyne.write(content, scope='project', layer='project', provenance={...})`

**Files to Modify:**
- `file`: `mnemosyne/ingestion/repo_ingest.py` (new)
  - `change`: Implement repo high-level indexing

**Design Decisions:**
- **Decision:** API-only fetch (no clones)
  - **Rationale:** Faster; avoids disk overhead; README + structure available via API

**Risks:**
- **Severity:** Medium  
  - **Description:** Repo count explosion (hundreds of repos?)
  - **Mitigation:** Parallel workers + per-repo timeout

**Cross-Cutting:**
- `concern`: metrics
  - `action`: Track indexing rate (repos/second), timeout count

---

### Story 2.4: Repo Continuous Indexing
**Complexity:** Medium  
**Depends On:** [2.3]

**Description:**
Set up continuous indexing for repository changes.

**Acceptance Criteria:**
- [ ] GitHub webhook integration (if available) OR daily poll fallback
- [ ] Incremental update logic (only re-index changed repos)
- [ ] Multica job registered
- [ ] Manual test: commit change triggers re-index

**Context:**
- **Webhook:** GitHub org/repo webhooks point to Mnemosyne endpoint
- **Fallback:** Daily poll via GitHub API (compare last_updated timestamp)

**Files to Modify:**
- `file`: `mnemosyne/continuous_index/repo_watcher.py` (new)
  - `change`: Webhook handler or polling logic
- `file`: `.multica/jobs/repo-reindex.yaml` (new)
  - `change`: Multica job definition

---

### Story 2.5: Repo Recall Verification + Regression
**Complexity:** Low  
**Depends On:** [2.3]

**Description:**
Verify repo metadata queryable; regression test confirms Qdrant (Slice 1) still works.

**Acceptance Criteria:**
- [ ] Sample recalls on repo metadata (e.g., "find Minerva repo purpose")
- [ ] Coverage audit: inventory count matches indexed count
- [ ] Regression test: Qdrant recalls from Slice 1 still return results
- [ ] Audit report updated

**Files to Modify:**
- `file`: `mnemosyne/tests/test_repo_recall.py` (new)
  - `change`: Repo recall verification tests
- `file`: `mnemosyne/tests/test_qdrant_recall.py`
  - `change`: Re-run as regression test

---

## SLICE 3: Artifacts & Client Work

### Goal
Add published artifacts + client deliverables.

### Story 3.1: Artifact & Client Data Inventory
**Complexity:** Low  
**Depends On:** [2.5]

**Description:**
Inventory published artifacts (marketing, financial, positioning) and client deliverables.

**Acceptance Criteria:**
- [ ] File-scan known dirs: `~/Documents/work/`, `~/Dropbox/` (if present)
- [ ] Artifacts located: marketing/, financial/, positioning/ subdirs
- [ ] Client deliverables located (per-client subdirs)
- [ ] Inventory manifest updated: `.pHive/epics/ingest-a10ab2c1/inventory/artifacts-clients.yaml`

**Context:**
- **Scan Candidates:**
  - `~/Documents/work/dostal-technology/marketing/`
  - `~/Documents/work/dostal-technology/financial/`
  - `~/Documents/work/clients/`
  - `~/Dropbox/work/` (if Dropbox synced)

**Files to Modify:**
- `file`: `.pHive/epics/ingest-a10ab2c1/inventory/artifacts-clients.yaml`
  - `change`: Create artifact + client inventory manifest

**Cross-Cutting:**
- `concern`: metrics
  - `action`: Track artifact count, client count

---

### Story 3.2: Artifact & Client Org-Tree Placement
**Complexity:** Low  
**Depends On:** [3.1]

**Description:**
Define org-tree placement for artifacts and client deliverables.

**Acceptance Criteria:**
- [ ] Artifact paths defined: `Dostal/work/dostal-technology/{marketing|financial|positioning}`
- [ ] Client paths defined: `Dostal/work/clients/{client-name}`
- [ ] Placement rules documented + tested

**Files to Modify:**
- `file`: `mnemosyne/placement_engine.py`
  - `change`: Add artifact + client placement rules

---

### Story 3.3: Artifact & Client Ingest
**Complexity:** Medium  
**Depends On:** [3.2]

**Description:**
Ingest artifacts and client deliverables into Mnemosyne.

**Acceptance Criteria:**
- [ ] Artifacts parsed (markdown, PDF, etc.) and indexed
- [ ] Client deliverables indexed (per-client subtrees)
- [ ] Index into meta/enterprise/project layers (per source type)
- [ ] Parallel workers (10 concurrent)
- [ ] Error handling: skip + log on parse failures

**Context:**
- **Parsing:** markdown (native), PDF (pypdf or pdfplumber), docx (python-docx)
- **Layers:**
  - Published artifacts → meta layer
  - Client deliverables → enterprise/project layers

**Files to Modify:**
- `file`: `mnemosyne/ingestion/artifact_ingest.py` (new)
  - `change`: Implement artifact + client ingestion

**Risks:**
- **Severity:** Low  
  - **Description:** PDF parsing failures on complex layouts
  - **Mitigation:** Skip + log; operator can manually extract if needed

**Cross-Cutting:**
- `concern`: metrics
  - `action`: Track parse success rate, ingestion rate

---

### Story 3.4: Artifact Continuous Indexing
**Complexity:** Low  
**Depends On:** [3.3]

**Description:**
Set up file watchers for artifact directory changes.

**Acceptance Criteria:**
- [ ] File watchers registered (fswatch or inotify)
- [ ] Incremental update on file change
- [ ] Multica job registered
- [ ] Manual test: edit artifact triggers re-index

**Files to Modify:**
- `file`: `mnemosyne/continuous_index/artifact_watcher.py` (new)
  - `change`: File watcher logic
- `file`: `.multica/jobs/artifact-reindex.yaml` (new)
  - `change`: Multica job definition

---

### Story 3.5: Artifact & Client Recall Verification + Regression
**Complexity:** Low  
**Depends On:** [3.3]

**Description:**
Verify artifacts + client data queryable; regression test confirms Slices 1+2 still work.

**Acceptance Criteria:**
- [ ] Sample recalls on artifacts (e.g., "find marketing playbook section on X")
- [ ] Sample recalls on client deliverables
- [ ] Coverage audit
- [ ] Regression test: Qdrant + repo recalls still work
- [ ] Audit report updated

**Files to Modify:**
- `file`: `mnemosyne/tests/test_artifact_recall.py` (new)
  - `change`: Artifact recall verification tests
- `file`: `mnemosyne/tests/test_qdrant_recall.py`
  - `change`: Re-run as regression test
- `file`: `mnemosyne/tests/test_repo_recall.py`
  - `change`: Re-run as regression test

---

## SLICE 4: House/Compound Decisions (Life Context)

### Goal
Add personal life decisions (house-hunting, compound choice, moving chaos).

### Story 4.1: House/Compound Artifact Inventory
**Complexity:** Low  
**Depends On:** [3.5]

**Description:**
Locate and inventory house/compound discussion artifacts.

**Acceptance Criteria:**
- [ ] Operator prompted for artifact location (Slack export? email? Google Docs?)
- [ ] Artifacts located + inventoried
- [ ] Inventory manifest updated: `.pHive/epics/ingest-a10ab2c1/inventory/house-compound.yaml`

**Context:**
- **Unknown Location:** Requires operator input
- **Candidates:**
  - Slack export (if workspace archived)
  - Email threads (IMAP fetch or manual export)
  - Google Docs (Drive API or manual download)

**Files to Modify:**
- `file`: `.pHive/epics/ingest-a10ab2c1/inventory/house-compound.yaml`
  - `change`: Create house/compound inventory manifest

**Cross-Cutting:**
- `concern`: metrics
  - `action`: Track decision artifact count

---

### Story 4.2: Life Context Org-Tree Placement
**Complexity:** Low  
**Depends On:** [4.1]

**Description:**
Define org-tree placement for life context (house/compound decisions).

**Acceptance Criteria:**
- [ ] Path defined: `Dostal/personal/house/moving`
- [ ] Placement rules documented + tested

**Files to Modify:**
- `file`: `mnemosyne/placement_engine.py`
  - `change`: Add life context placement rules

---

### Story 4.3: House/Compound Decision Ingest
**Complexity:** Medium  
**Depends On:** [4.2]

**Description:**
Ingest house/compound decision artifacts into Mnemosyne meta layer.

**Acceptance Criteria:**
- [ ] Artifacts parsed (Slack JSON, email threads, docs)
- [ ] Decision points + rationale extracted
- [ ] Index into meta layer (Obsidian vault integration if available)
- [ ] Error handling: skip + log on parse failures

**Context:**
- **Obsidian Integration:** If vault detected in Slice 1, write to vault + index; else index-only

**Files to Modify:**
- `file`: `mnemosyne/ingestion/life_context_ingest.py` (new)
  - `change`: Implement house/compound decision ingestion

**Cross-Cutting:**
- `concern`: metrics
  - `action`: Track ingestion rate

---

### Story 4.4: Life Context Manual Re-Index
**Complexity:** Low  
**Depends On:** [4.3]

**Description:**
Provide manual re-index command for life context (no continuous indexing — infrequent changes).

**Acceptance Criteria:**
- [ ] CLI command available: `mnemosyne re-index --source=personal/house`
- [ ] Manual test: re-run command updates index

**Files to Modify:**
- `file`: `mnemosyne/cli.py`
  - `change`: Add re-index command

---

### Story 4.5: Life Context Recall Verification + Regression
**Complexity:** Low  
**Depends On:** [4.3]

**Description:**
Verify life context queryable; regression test confirms Slices 1+2+3 still work.

**Acceptance Criteria:**
- [ ] Sample recalls on compound decision history (e.g., "why Arizona compound preferred?")
- [ ] Coverage audit
- [ ] Regression test: Qdrant + repo + artifact recalls still work
- [ ] Audit report updated

**Files to Modify:**
- `file`: `mnemosyne/tests/test_life_context_recall.py` (new)
  - `change`: Life context recall verification tests
- `file`: `mnemosyne/tests/test_*.py`
  - `change`: Re-run Slices 1+2+3 regression tests

---

## SLICE 5: Gemini Discussions (Deferred, Human-Blocked)

### Goal
Placeholder slice for Gemini chat history (blocked on operator re-export).

### Story 5.1: Gemini Export Human-Queue Alert
**Complexity:** Low  
**Depends On:** [4.5]

**Description:**
File HUMAN-QUEUE TODO for Gemini export re-do; surface alert to operator.

**Acceptance Criteria:**
- [ ] HUMAN-QUEUE TODO created: "Re-export Gemini chat history"
- [ ] Alert surfaced to operator (console + email?)
- [ ] Placeholder written to inventory manifest

**Files to Modify:**
- `file`: `.pHive/human-queue/gemini-export-redo.yaml`
  - `change`: Create human-queue task
- `file`: `.pHive/epics/ingest-a10ab2c1/inventory/gemini.yaml`
  - `change`: Placeholder manifest entry

**Cross-Cutting:**
- `concern`: documentation
  - `action`: Document Gemini export format requirements for operator

---

### Story 5.2: Gemini Ingest (Deferred)
**Complexity:** Unknown (blocked)  
**Depends On:** [5.1, operator action]

**Description:**
Ingest Gemini chat history once operator re-export completes (pattern same as Slice 4).

**Acceptance Criteria:**
- [ ] ⭐ **BLOCKED:** Requires operator to re-export Gemini chat history
- [ ] Once unblocked: parse Gemini export format
- [ ] Extract chat threads + timestamps
- [ ] Index into meta/enterprise layer
- [ ] Recall verification

**Files to Modify:**
- `file`: `mnemosyne/ingestion/gemini_ingest.py` (new, deferred)
  - `change`: Implement Gemini chat ingestion

**Risks:**
- **Severity:** High (for completeness goal)  
  - **Description:** Operator may not re-export for extended period
  - **Mitigation:** Epic can close without this story; Gemini is additive later

---

## Story Count Summary

| Slice | Stories | Status |
|-------|---------|--------|
| 1: Qdrant-only | 5 | Ready |
| 2: Repos | 5 | Ready (depends on Slice 1) |
| 3: Artifacts + Clients | 5 | Ready (depends on Slice 2) |
| 4: House/Compound | 5 | Ready (depends on Slice 3) |
| 5: Gemini (deferred) | 2 | Blocked (human-queue) |
| **Total** | **22** | |

---

## Structured Outline Metadata
- **Epic ID:** ingest-a10ab2c1
- **Total Stories:** 22
- **Critical Path:** Slice 1 → 2 → 3 → 4 (sequential)
- **Review Status:** Pending user sign-off
