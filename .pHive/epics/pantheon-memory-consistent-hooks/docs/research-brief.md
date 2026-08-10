# Research Brief: Consistent Memory + Auto-loading Recall Hooks

**Epic:** pantheon-memory-consistent-hooks  
**Date:** 2026-08-05  
**Researcher:** System

## Executive Summary

Mnemosyne is currently live (:8477) with a working memory service that wraps `swarm-memory` over Qdrant Cloud. However, memory is fragmented across ~6 layers that can disagree, and there's no automatic pre/post recall hook integration. This epic makes memory CONSISTENT (single source of truth across all layers) and AUTO-LOADING (hooks that inject memory before every turn and persist learnings after).

## Current State

### What EXISTS and WORKS
1. **Mnemosyne HTTP service** (`src/server.mjs`) running on port 8477
   - `/health` - engine self-test (Qdrant + embedder + graph)
   - `/healthz` - liveness alias for external checkers (Salus/Argus)
   - `/recall` - semantic query with provenance
   - `/remember` - write-back with indexing
   - `/scopes` - configured memory scopes

2. **Engine layer** (`src/engine.mjs`) wraps `swarm-memory` CLI
   - Shells out to existing `swarm-memory` binary
   - Reads from `~/.config/swarm-memory/qdrant.key` for Qdrant Cloud access
   - Writes notes to `~/.local/share/mnemosyne/notes/`

3. **Hook prototypes** (`hooks/`) 
   - `pre-recall.mjs` - recalls memory and injects as context (UserPromptSubmit)
   - `post-remember.mjs` - persists learnings after work (Stop/SubagentStop)
   - `lib/mnemo-client.mjs` - HTTP client for Mnemosyne service
   - `lib/scope.mjs` - role-based scope resolution
   - `lib/format.mjs` - cache-safe bundle formatting
   - `settings.hooks.json` - Claude Code hook wiring template

4. **Test suite**
   - `test/e2e.mjs` - round-trip probe (PAN-7547): health → remember → recall → provenance verification
   - `test/hooks.mjs` - live hook test over Qdrant corpus
   - `test/bundle.mjs` - cache-safe layout + bundle formatting
   - `test/smoke.mjs` - service smoke test

### The 6-Layer Problem

Memory is currently spread across:
1. **Meta layer** (Obsidian vault) - NOT YET INTEGRATED
2. **File memory** (local .md files at `~/.local/share/mnemosyne/notes/`)
3. **Qdrant Cloud** (remote vector DB, credential at `~/.config/swarm-memory/qdrant.key`)
4. **swarm-memory** (CLI wrapper with local caching/config at `~/.config/swarm-memory/config.toml`)
5. **Mnemosyne service** (:8477 HTTP API with its own request/response layer)
6. **Hook layer** (`hooks/` - pre/post logic with its own client)

**The consistency gap:** A write to one layer may not immediately appear in another. No single source of truth. The health endpoint (PAN-7514 pattern) reads from Mnemosyne service, but doesn't verify layer coherence.

### Hook Integration Gap

Current hooks exist as **prototypes** but are:
- NOT auto-wired into harness by default
- Require manual merge of `settings.hooks.json` into user's Claude Code settings
- No automatic "high-level first" injection strategy
- No automated persistence after every turn
- Missing the dostal-orchestrator qdrant-hooks pattern (pre/post with auto-inject)

## Technical Stack

- **Runtime:** Node.js (ESM modules, no deps beyond built-ins)
- **Vector Store:** Qdrant Cloud (remote, accessed via `swarm-memory` CLI)
- **Embedder:** nomic-embed-text (via `swarm-memory`)
- **File Layer:** Markdown notes in `~/.local/share/mnemosyne/notes/`
- **HTTP Server:** Node built-in `http` module
- **Testing:** Custom test harness (no framework), runs against live Qdrant

## Key Files & Paths

| Path | Purpose | Notes |
|------|---------|-------|
| `src/server.mjs` | HTTP API layer | Transport only, delegates to engine |
| `src/engine.mjs` | swarm-memory CLI wrapper | Shells out with --json |
| `hooks/pre-recall.mjs` | Pre-work memory injection | UserPromptSubmit hook |
| `hooks/post-remember.mjs` | Post-work persistence | Stop/SubagentStop hook |
| `hooks/lib/mnemo-client.mjs` | HTTP client for Mnemosyne | Fallback to CLI if service down |
| `hooks/lib/scope.mjs` | Role → scope resolution | orchestrator→top, architect→repo, developer→slice |
| `hooks/lib/format.mjs` | Bundle formatting | Cache-safe layout, prompt breakpoint |
| `~/.config/swarm-memory/qdrant.key` | Qdrant Cloud credential | DO NOT WIPE |
| `~/.local/share/mnemosyne/notes/` | File memory scratch | Markdown notes written here |
| `test/e2e.mjs` | Round-trip probe | PAN-7547 AC verification |

## Existing Patterns to Preserve

### 1. PAN-7514 Health Pattern
The `/health` endpoint shells out to `swarm-memory check` and returns:
```javascript
{ ok: true/false, engine: "swarm-memory", detail: "... N collections, M points ..." }
```
This pattern must be extended to verify layer consistency.

### 2. Cache-Safe Prompt Layout
`pre-recall.mjs` builds a bundle with three parts:
- **Cacheable prefix** - stable per repo/role, deterministic
- **Cache breakpoint** - `<!-- mnemosyne-cache-breakpoint: variable-ticket-memory-below -->`
- **Variable memory delta** - per-ticket recall, capped by token budget

This layout keeps the expensive stable context cached.

### 3. Hybrid Recall (Semantic + Keyword)
Combines:
- **Semantic** recall (embedding similarity via Qdrant)
- **Keyword** grep (exact identifier matching for ticket IDs, tokens)

Keyword-exact hits surface first for deterministic ticket-specific memory.

### 4. Role-Scoped Memory
- `orchestrator` → `top` scope (all-repo, escalates)
- `architect` → repo scope (escalates)
- `developer` → repo slice (no escalation)

Implemented in `hooks/lib/scope.mjs`.

### 5. Status-Aware Write-Back
Every note written by `post-remember.mjs` is stamped:
- `STATUS: in-progress | reviewed | full-send`
- `TICKET: <id>`
- `ROLE: <role>`

This lets recall distinguish WIP from verified truth.

### 6. Resilience Contract
Hooks NEVER block the agent loop. Any failure → exit 0, no context injection. Memory miss ≠ ticket failure.

## Bespoke Layers to Reduce

Several ~/.multica shell scripts exist that paper over memory gaps. These need audit:
- Check for cron-like scheduling scripts (should use Multica native)
- Check for manual sync scripts between layers
- Check for health-check wrappers

The requirement says "note (do not silently drop) anything that stays a script" - so we need an inventory pass.

## Missing Pieces (Requirements Mapping)

### REQ 1: Single Consistent Read/Write
**Gap:** No write-through or reconciliation pass. Writing via `POST /remember` updates Qdrant via swarm-memory, writes a file to `~/.local/share/mnemosyne/notes/`, but:
- No meta layer (Obsidian) integration yet
- No verification that file write = Qdrant point upsert
- No reconciliation on startup or health check
- God-card (status dashboard) doesn't read live Mnemosyne `/health`

**What exists:** 
- `POST /remember` writes note file + calls `swarm-memory remember --scope <scope> --tag <tag>`
- E2E test verifies round-trip but not layer coherence

### REQ 2: Pre/Post Recall Hooks
**Gap:** Hooks exist as prototypes but aren't auto-wired.
- No harness-level integration (require manual settings.json merge)
- No "high-level first" injection strategy implemented
- dostal-orchestrator qdrant-hooks pattern not replicated

**What exists:**
- `hooks/pre-recall.mjs` - can inject memory
- `hooks/post-remember.mjs` - can persist learnings
- `hooks/settings.hooks.json` - template for manual wiring

### REQ 3: Consistency Test
**Gap:** E2E test verifies round-trip (write then recall) but not:
- Cross-layer consistency (file = Qdrant point)
- Stale status detection
- Lying god-card detection
- Cura truth-reconciliation pattern

**What exists:**
- `test/e2e.mjs` - proves semantic round-trip with provenance
- `GET /health` - proves engine is up, Qdrant reachable
- Both work independently but don't verify coherence

### REQ 4: Reduce Bespoke Layer
**Gap:** Need to inventory ~/.multica scripts and home directory for:
- Manual sync scripts
- Cron scheduling (should be Multica-native)
- Workaround wrappers

**Action required:** Discovery pass to find bespoke scripts.

### REQ 5: Health Surface Verification
**Gap:** After landing, need to verify:
- Janus memory god-card reads live `/health` and shows GREEN/truthful
- Salus health monitoring integrated
- Argus metrics integrated

**What exists:**
- `GET /healthz` endpoint (liveness alias for external checkers)
- `GET /health` endpoint with engine detail
- No god-card implementation yet (that's in Janus, separate repo)

## Architecture Decisions to Make

### Decision 1: Source of Truth Layer
**Options:**
- A) Qdrant Cloud as SSOT, file layer as cache
- B) File layer as SSOT, Qdrant as index
- C) Both as peers, reconciliation pass

**Recommendation:** A (Qdrant as SSOT). Current `swarm-memory` design already treats Qdrant as authoritative. File notes are write-ahead log for re-indexing.

### Decision 2: Write-Through vs Reconcile
**Options:**
- A) Write-through: `POST /remember` atomically updates both file + Qdrant
- B) Reconcile: Periodic reconciliation pass checks file ↔ Qdrant consistency

**Recommendation:** A (write-through) for new writes. B (reconcile) as health-check safety net.

### Decision 3: Hook Auto-Loading
**Options:**
- A) Auto-wire hooks into harness settings on mnemosyne install
- B) Provide installer script that merges settings.hooks.json
- C) Harness detects Mnemosyne presence and auto-enables hooks

**Recommendation:** B for v1 (explicit install step), C for v2 (auto-detection).

### Decision 4: High-Level First Injection
**Options:**
- A) Pre-recall queries meta layer first, falls back to narrower scopes
- B) Pre-recall queries all layers, ranks by relevance + layer priority
- C) Pre-recall uses fixed ladder: meta → enterprise → project → vector

**Recommendation:** C (fixed ladder with escalation), consistent with existing scope.mjs role mapping.

## Risks & Constraints

### Risk 1: Qdrant Cloud Availability
**Impact:** If Qdrant Cloud is down, entire memory layer fails  
**Mitigation:** Hooks already have CLI fallback (`swarm-memory` binary works offline with last-synced state)

### Risk 2: Write Atomicity
**Impact:** File write succeeds but Qdrant upsert fails = divergence  
**Mitigation:** Reconciliation pass + health check that compares file count vs Qdrant point count

### Risk 3: Breaking Existing `swarm-memory` Users
**Impact:** Other Pantheon gods (Hermes, Minerva) use `swarm-memory` directly  
**Mitigation:** Mnemosyne wraps but doesn't replace. Existing CLI usage unaffected.

### Risk 4: Lying God-Card
**Impact:** Status dashboard shows memory healthy when it's not  
**Mitigation:** God-card must call live `GET /health`, not cache result. Add staleness timestamp.

### Constraint 1: Do NOT Wipe Collections
Hard requirement. All writes are additive (`--no-prune`). No `DELETE` operation in API.

### Constraint 2: Loud Failure Required
Memory must NEVER silently degrade. If a layer is down, flag it prominently. Don't fall back silently.

### Constraint 3: Build ON Existing Infrastructure
Do not reinvent: Qdrant Cloud, swarm-memory, Obsidian vault are proven. Mnemosyne unifies, doesn't replace.

## Dependencies

### Internal
- `swarm-memory` CLI (must remain stable, Mnemosyne depends on its --json contract)
- Qdrant Cloud access (credential at `~/.config/swarm-memory/qdrant.key`)
- Obsidian vault (for meta layer integration - location TBD)

### External
- Node.js runtime (ESM, built-in modules only)
- Qdrant Cloud service (remote, mdostal account)
- nomic-embed-text embedder (via swarm-memory)

### Not Required (Greenfield)
- No new package.json deps (zero third-party)
- No database migrations (Qdrant schema managed by swarm-memory)
- No auth layer (local-only service on 127.0.0.1:8477)

## Testing Strategy

### Unit Level
- Mock `swarm-memory` CLI responses (stub execFile)
- Test bundle formatting (cache-safe layout)
- Test scope resolution (role → scope mapping)

### Integration Level
- Hook wiring (pre-recall → Mnemosyne → post-remember)
- Write-through consistency (file write + Qdrant upsert)
- Health check reconciliation pass

### E2E Level (Already Exists)
- `test/e2e.mjs` - semantic round-trip with provenance
- `test/hooks.mjs` - live hook over Qdrant corpus
- Extend with layer-coherence verification

### Contract Testing
- Verify `swarm-memory --json` output shape doesn't break
- Verify `/health` matches PAN-7514 pattern
- Verify hook output matches Claude Code hook contract

## Performance Considerations

### Current Performance (Measured)
- `GET /health` - shells out to `swarm-memory check`, ~2-3s
- `POST /recall` - semantic query, ~500-1500ms depending on corpus size
- `POST /remember` - write note + upsert, ~300-800ms
- E2E round-trip (remember + 1.5s wait + recall) - ~2-3s total

### Optimization Opportunities
1. **Health check caching** - cache `GET /health` for 30s (liveness vs deep health)
2. **Bundle caching** - pre-recall cacheable prefix can be memoized per repo/role
3. **Batch writes** - if multiple learnings, batch into single `/remember` call
4. **Async indexing** - don't wait for Qdrant upsert to return from `/remember`

### Scalability Limits
- Single Mnemosyne instance per user (127.0.0.1:8477)
- Qdrant Cloud collection size (currently unknown, appears adequate)
- File system writes (bounded by note volume, not a concern at current scale)

## Open Questions

1. **Where is the Obsidian vault?** - Path not found in initial discovery. Need to locate or create.
2. **What bespoke ~/.multica scripts exist?** - Inventory required per REQ 4.
3. **Where is the Janus god-card implementation?** - Separate repo, need cross-reference.
4. **What is the current Qdrant collection count/size?** - Health detail shows it, but not baseline.
5. **Does dostal-orchestrator qdrant-hooks still exist?** - Need to find reference implementation.

## References

- `idea-brief.md` - Full Mnemosyne vision (layer stack, continuous indexing, Consus/Janus integration)
- `SERVICE.md` - Current v0.1.0 service implementation
- `README.md` - Quick start and status
- `hooks/README.md` - Hook contract and wiring guide
- `test/e2e.mjs` - PAN-7547 acceptance criteria
- `.pHive/CONTEXT.md` - Domain glossary
- `.pHive/project-profile.yaml` - Project metadata and north star
