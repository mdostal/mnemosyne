# Horizontal Plan: Comprehensive Memory Ingestion

## Epic Context
**ID:** ingest-a10ab2c1  
**Goal:** Systematically ingest all scattered context into Mnemosyne memory + org-tree  
**Scale:** Large (multi-system, unknown volume)

## Horizontal Capabilities Scan

### H1: Inventory & Discovery
**What:** Discover what exists across all data sources before bulk ingestion
**Why:** Unknown scale (Qdrant collections count, repo count, artifact locations)

**Components:**
1. **Qdrant Collection Inventory**
   - Connect to Qdrant Cloud (key: `~/.config/swarm-memory/qdrant.key`)
   - List all collections via API
   - Count entries per collection
   - Extract metadata (scope hints, created dates)

2. **Repository Discovery**
   - GitHub API: list all FFE org repos
   - GitHub API: list all mdostal account repos
   - Extract: name, description, primary language, last update, README

3. **Artifact Location Discovery**
   - File-scan candidates: `~/Documents/work/`, `~/Dropbox/`
   - Locate: marketing/, financial/, positioning/ subdirs
   - Inventory file counts + types

4. **Client Data Discovery**
   - Locate Clients-tab data source (unknown format)
   - Inventory deliverables directories

5. **House/Compound Discussion Discovery**
   - Locate discussion artifacts (Slack? email? docs?)
   - **Requires operator input** (location unknown)

6. **Obsidian Vault Detection**
   - Auto-detect or prompt for vault path
   - Inventory structure if found

**Acceptance Criteria:**
- Bounded counts for all sources (or "not found" status)
- Inventory manifest written to `.pHive/epics/ingest-a10ab2c1/inventory-manifest.yaml`

---

### H2: Org-Tree Scaffolding
**What:** Establish hierarchy + placement rules for ingested content
**Why:** Need structured placement before bulk ingest; dedup requires stable paths

**Components:**
1. **Hierarchy Definition**
   ```
   Dostal/
   ├── work/
   │   ├── clients/
   │   │   └── {client-name}/
   │   ├── dostal-technology/
   │   │   ├── marketing/
   │   │   ├── financial/
   │   │   └── positioning/
   │   └── repos/
   │       └── {repo-category}/
   ├── personal/
   │   └── house/
   │       └── moving/
   └── pantheon/
       └── gods/
           ├── mnemosyne/
           ├── minerva/
           └── ...
   ```

2. **Placement Rule Engine**
   - Map source type → org-tree path
   - Handle ambiguous cases (repo could be client work OR pantheon god)
   - Collision resolution (same content hash, different sources)

3. **Dedup Strategy Implementation**
   - Content hash (SHA-256 normalized)
   - Provenance tracking (source + timestamp)
   - Escalation on collision

**Acceptance Criteria:**
- Org-tree YAML schema written
- Placement rules documented + tested on sample data
- Dedup logic implemented + unit tested

---

### H3: Bulk Ingestion Pipeline
**What:** Load content from sources into Mnemosyne layers
**Why:** Core capability — make scattered data queryable through unified API

**Components:**
1. **Qdrant Reconciliation**
   - Merge existing collections into Mnemosyne vector layer
   - Map collection → org-tree node (per metadata)
   - Preserve provenance (original collection name + timestamp)

2. **Repo High-Level Index**
   - For each repo: extract README, purpose, structure, key docs
   - Index into Mnemosyne project layer
   - Map to org-tree path (pantheon vs work/repos)

3. **Client Work Ingest**
   - Deliverables → project layer
   - Metadata → enterprise layer
   - Map to Dostal/work/clients/{client-name}

4. **House/Compound Decisions Ingest**
   - Decision artifacts → meta layer (Obsidian vault integration)
   - Map to Dostal/personal/house/moving

5. **Published Artifacts Ingest**
   - Marketing/financial/positioning docs → company KB
   - Map to Dostal/work/dostal-technology/{type}

**Shared Infrastructure:**
- Progress tracking (N of M items ingested)
- Error handling (loud failure on auth/network errors)
- Parallel workers (10 concurrent, rate-limited)
- Retry logic (3 attempts with exponential backoff)

**Acceptance Criteria:**
- All sources ingested (or failed loudly with error logs)
- Ingestion audit log written
- Recall tests pass across ≥3 layers

---

### H4: Continuous Indexing Setup
**What:** Keep memory fresh after initial bulk ingest
**Why:** One-off ingestion goes stale; need repeatable pipeline

**Components:**
1. **Multica Scheduling**
   - Verify Multica daemon running
   - Register scheduled jobs per source type
   - Frequency TBD (default: daily for now)

2. **Change Detection**
   - GitHub webhooks for repo changes (if available)
   - File watchers for local artifacts (fswatch or equivalent)
   - Qdrant change-feed monitoring (if API supports)

3. **Incremental Update Logic**
   - Diff against last-indexed timestamp
   - Only re-index changed items
   - Update provenance (indexed_at timestamp)

**Acceptance Criteria:**
- Multica jobs registered + tested
- Manual re-run command available (fallback if Multica unavailable)
- Incremental update faster than full re-index

---

### H5: Verification & Audit
**What:** Confirm ingested content is queryable + coverage is complete
**Why:** Silent data loss would violate loud-failure requirement

**Components:**
1. **Recall Tests**
   - Sample queries across layers (meta, enterprise, project, vector)
   - Verify provenance tracking works
   - Test org-tree navigation

2. **Coverage Audit**
   - Compare inventory manifest to indexed items
   - Flag missing items (ingestion failures)
   - Dedup audit (collision report)

3. **Performance Baselines**
   - Recall latency benchmarks
   - Memory footprint (Qdrant storage used)
   - Index freshness metrics

**Acceptance Criteria:**
- All sampled recalls return expected results
- Coverage ≥95% (or all failures explained)
- Audit report generated

---

## Capability Dependencies

```
H1 (Inventory) → H2 (Scaffold) → H3 (Bulk Ingest) → H5 (Verification)
                                        ↓
                                   H4 (Continuous Index)
```

- H1 must complete first (bounds the work)
- H2 depends on H1 (placement rules need source metadata)
- H3 depends on H2 (org-tree must exist before placement)
- H4 can proceed in parallel with H5 (continuous indexing doesn't block verification)
- H5 depends on H3 (can't verify what hasn't been ingested)

---

## Cross-Cutting Concerns

### Metrics
- **Ingestion rate:** items/second during bulk ingest
- **Recall coverage:** % of inventory successfully queryable post-ingest
- **Index freshness:** time since last update (for continuous indexing)

### Error Handling
- **Loud failure:** halt + surface error on auth failures, network errors
- **Partial success:** if 1 of N sources fails, complete others + report failed source
- **Retry budget:** max 3 attempts per item; log + skip on exhaustion

### Security
- **Qdrant key:** read from `~/.config/swarm-memory/qdrant.key` (Portunus integration?)
- **GitHub PAT:** prompt if missing; store in Portunus
- **Client data:** sanitize PII before indexing (if applicable)

---

## Horizontal Plan Metadata
- **Epic ID:** ingest-a10ab2c1
- **Capabilities:** 5 (Inventory, Scaffold, Bulk Ingest, Continuous Index, Verification)
- **Critical Path:** H1 → H2 → H3 → H5
- **Review Status:** Pending team review
