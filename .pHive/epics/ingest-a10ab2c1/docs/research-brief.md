# Research Brief: Comprehensive Memory Ingestion

## Epic Context
**ID:** ingest-a10ab2c1  
**Title:** Ingest EVERYTHING into memory and org-tree  
**Scope:** Inventory + ingest all scattered context (Qdrant collections, repos, clients, house/compound decisions, artifacts) into Mnemosyne memory + place into org-tree

## Current State Discovery

### Existing Memory Infrastructure
1. **Qdrant Cloud** — remote vector DB (key at `~/.config/swarm-memory/qdrant.key`)
   - Collections already exist (scope unknown — needs inventory)
   - **CRITICAL:** Do NOT wipe existing collections
   
2. **swarm-memory CLI** — at `~/Documents/work/dostal/code/swarm-memory`
   - Existing semantic search + code-graph + escalation ladder
   - Mnemosyne wraps this as its vector + code-graph layers

3. **Obsidian vault** — Consus knowledge home (meta top-level layer)
   - Path unknown — needs detection
   - Human-curated cross-project knowledge

### Data Sources to Ingest

#### 1. Qdrant Collections
- **Location:** Cloud (key `~/.config/swarm-memory/qdrant.key`)
- **Action:** Inventory existing collections → reconcile/merge into Mnemosyne vector layer → map to org-tree nodes
- **Constraint:** Read-only inventory; no wipes

#### 2. Repositories (High-Level Index)
- **FFE org repos** — all repos under firefly-events GitHub org
- **mdostal repos** — all repos under mdostal GitHub account
- **Action:** Index at high level (purpose, structure, key docs) → memory + org-tree placement
- **Ties:** Mnemosyne bulk re-index (seed 443f67ef)

#### 3. Client Work
- **Deliverables** — completed client projects
- **Clients-tab data** — client metadata, contracts, status
- **Target:** Memory + org-tree (Dostal > work > clients / dostal-technology)

#### 4. House / Life / Compound Decisions
- **Arizona compound vs Wyoming compound** — location decision discussions
- **Moving chaos** — relocation planning, logistics
- **Target:** Memory + org-tree (Dostal > personal > house/moving)
- **Note:** Real, ongoing decisions worth capturing

#### 5. Artifacts
- **Marketing playbook**
- **Financial/Money-Lab docs**
- **Positioning docs**
- **Status reports**
- **Target:** Marketing/company KB + org-tree nodes

#### 6. Gemini Discussions ⭐ **HUMAN BLOCKER**
- **Problem:** Gemini chat export did NOT come out correctly
- **Action:** Mathew must re-export + feed later
- **Status:** Filed as HUMAN-QUEUE TODO; blocks ingestion of Gemini history
- **Alert:** Surface to Mathew as priority blocker

### Org-Tree Structure
Reference: `[[org-tree-hierarchy-structure]]`

Expected placement pattern:
```
Dostal
├── work
│   └── clients
│       └── dostal-technology
├── personal
│   └── house
│       └── moving
└── pantheon
    └── gods
        ├── mnemosyne
        ├── minerva
        └── ...
```

### Dependencies
1. **Mnemosyne framework** — must exist before bulk ingestion begins
2. **Org-tree scaffold** — hierarchy must be established
3. **Portunus** — for any secrets discovered during ingestion
4. **Continuous-indexing autopilot** — keep memory fresh post-ingestion

### Technical Constraints
1. **Multica-native scheduling** only (no localized cron)
2. **Loud failure** is a hard requirement
3. **Do NOT wipe** existing Qdrant collections or Obsidian vault
4. Build ON what exists (swarm-memory, Qdrant Cloud, Obsidian)

### Unknowns / Need Discovery
1. How many Qdrant collections currently exist?
2. Exact count of FFE + mdostal repos
3. Obsidian vault location + size
4. Client deliverables inventory (count, location)
5. House/compound discussion artifacts (where stored?)
6. Existing artifact locations

### Proposed Approach Sketch
1. **Phase 1: Inventory** — discover what exists (Qdrant, repos, artifacts, discussions)
2. **Phase 2: Structure** — establish org-tree placement rules + dedup strategy
3. **Phase 3: Ingest** — bulk load into Mnemosyne layers (staged by source type)
4. **Phase 4: Continuous Indexing** — repeatable pipeline for keeping memory fresh
5. **Phase 5: Verification** — recall tests across layers confirm everything is queryable

### Scale Assessment
**Large** — multi-system bulk ingestion spanning:
- Remote Qdrant collections (unknown count)
- All repos across 2 GitHub orgs (tens to hundreds?)
- Client work archive
- Personal life decisions
- Published artifacts
- Future Gemini discussion history (blocked)

This requires H/V planning + structured outline.
