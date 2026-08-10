# Design Discussion: Consistent Memory + Auto-loading Recall Hooks

**Epic:** pantheon-memory-consistent-hooks  
**Date:** 2026-08-05  
**Status:** Draft for Review

## §0 Context

### Goal

Make Mnemosyne's memory **CONSISTENT** across all layers (no divergence between file memory, Qdrant, and service) and **AUTO-LOADING** (pre/post hooks that inject high-level context first before every turn and persist learnings after). This is the **HARD GATE** before Firefly onboarding - the 8 Firefly repos cannot integrate until memory is reliable and truthful.

### North Star Alignment

From `.pHive/project-profile.yaml`:
- **Goal:** "Unify memory layers behind one recall/write API so 'memory over find' becomes the default retrieval path for every agent"
- **Audience:** Pantheon gods (Minerva, Argus, Metis, etc.) and swarm agents
- **Pain points:** "Memory infrastructure exists but is fragmented — no single god owns the layer stack, no unified API, agents fall back to grep/find"
- **Success:** "One recall/write API in use by ≥1 other god spanning ≥3 layers; recall beats find on token cost"

This epic directly addresses the fragmentation pain point and establishes the reliability foundation for the success criteria.

## §1 Problem Statement

Mnemosyne is live (:8477, recall returns hits with provenance) but memory is spread across ~6 layers that can DISAGREE:

1. **Meta** (Obsidian vault - not yet integrated)
2. **File** (local .md notes at `~/.local/share/mnemosyne/notes/`)
3. **Qdrant Cloud** (remote vector DB)
4. **swarm-memory** (CLI wrapper with local config)
5. **Mnemosyne service** (:8477 HTTP API)
6. **Hook layer** (pre/post logic with separate client)

**The lying god-card incident:** A status dashboard reported memory was not built when Mnemosyne was actually running. This proves the health surface doesn't read live state.

**The consistency gap:** Writing via `POST /remember` updates both file and Qdrant, but there's no verification they stay in sync. If the Qdrant upsert fails after the file write succeeds, the layers diverge silently.

**The hook gap:** Pre/post hooks exist as prototypes (`hooks/pre-recall.mjs`, `hooks/post-remember.mjs`) but aren't auto-wired into the harness. The dostal-orchestrator qdrant-hooks pattern (auto-inject high-level first, persist after) isn't replicated.

### Scale Assessment

**MEDIUM scope** - Multi-layer system with cross-component coordination, but well-defined boundaries:
- 3 repos touched: mnemosyne (hooks + consistency), swarm-memory (verify contract), potentially pantheon-status (god-card)
- ~5-8 stories estimated
- Requires H/V planning to sequence layer consistency → hook auto-loading → verification

## §2 Proposed Approach

### 2.1 Single Source of Truth: Qdrant as SSOT

**Decision:** Qdrant Cloud is the authoritative layer. File notes are write-ahead log for re-indexing.

**Rationale:** 
- `swarm-memory` already treats Qdrant as authoritative
- Qdrant points have timestamps, embeddings, and metadata - richer than file content alone
- Remote Qdrant survives local file system issues

**Implementation:**
- `POST /remember` writes note file FIRST (failure-fast), then upserts to Qdrant
- On Qdrant failure, log error loudly but keep the file (it's the recovery path)
- Reconciliation pass on startup: scan notes dir, check each file has corresponding Qdrant point

### 2.2 Write-Through Consistency

Every `POST /remember` becomes a 3-step transaction:
1. **Write note file** to `~/.local/share/mnemosyne/notes/<scope>/<timestamp>-<slug>.md`
2. **Shell out to swarm-memory** `remember --scope <scope> --file <path> --tag <tag>`
3. **Verify upsert** by checking exit code + parsing JSON output for `chunks_upserted > 0`

If step 2 or 3 fails:
- **Loud failure:** Log to stderr + emit metric event
- **Keep the file:** It's the recovery artifact
- **Return error to caller:** Don't pretend the write succeeded

Add reconciliation helper `bin/mnemosyne-reconcile`:
```bash
#!/usr/bin/env bash
# Scans ~/.local/share/mnemosyne/notes/ and verifies each file has a Qdrant point
# Outputs: OK (all synced) | DRIFT (N files missing from Qdrant)
```

Called by:
- `GET /health` (reports drift count in detail field)
- CI/CD health check
- Manual troubleshooting

### 2.3 Pre/Post Hook Auto-Loading

**Goal:** Replicate dostal-orchestrator qdrant-hooks pattern - pre-recall auto-injects high-level context, post-remember persists learnings.

**Approach:**
Add hook installer: `bin/mnemosyne-install-hooks`
```bash
#!/usr/bin/env bash
# Merges hooks/settings.hooks.json into ~/.claude/settings.json
# Idempotent - checks if already installed, updates paths to absolute
# Validates Mnemosyne service is reachable before enabling
```

Hook wiring strategy:
1. **Pre-recall (UserPromptSubmit):**
   - Query Mnemosyne `/recall` with hybrid semantic + keyword
   - Build cache-safe bundle (stable prefix | cache breakpoint | variable delta)
   - Inject as `hookSpecificOutput.additionalContext`
   - "High-level first" = meta/enterprise scope hits ranked above narrow scopes

2. **Post-remember (Stop/SubagentStop):**
   - Extract learnings from transcript (last assistant message)
   - Call Mnemosyne `/remember` with status-aware tagging
   - Non-blocking - failure doesn't break stop event

**High-level first implementation:**
In `hooks/lib/format.mjs` `buildMemoryBundle()`:
- Sort hits by layer priority FIRST (meta > enterprise > project > vector > file)
- Then by score within layer
- Cap total by token budget, but reserve N tokens for meta layer hits

### 2.4 Consistency Test Pattern

Extend `test/e2e.mjs` with layer-coherence checks:

```javascript
// AC: write-then-recall returns consistent provenance
const marker = generateUniqueMarker();
const write = await remember(marker, 'personal');
const writeFile = write.body.file; // e.g. ~/.local/share/mnemosyne/notes/personal/123-marker.md

await sleep(2000); // give upsert time to land

const recall = await recall(marker, 'personal', {hits: 1});
const topHit = recall.body.scopes[0].hits[0];

// COHERENCE CHECK: recalled provenance.full_path should match write.file basename
assert(topHit.provenance.full_path.includes(path.basename(writeFile)));

// DRIFT CHECK: /health should report drift_count === 0
const health = await health();
assert(health.body.drift_count === 0);
```

Add Cura truth-reconciliation pattern:
- Health check that scans notes dir vs Qdrant
- If drift detected, flag in `/health` response: `{drift_count: N, status: "degraded"}`
- Automated reconcile on startup (or manual via `bin/mnemosyne-reconcile`)

### 2.5 God-Card Live Health Integration

**Problem:** God-card (status dashboard) doesn't read live Mnemosyne `/health`.

**Solution:** God-card must call `GET /healthz` for liveness, `GET /health` for deep health.

**Implementation:**
- Add god-card integration to separate story (likely in pantheon-status or Janus repo)
- Mnemosyne side: ensure `/health` returns structured JSON with:
  - `ok: true/false`
  - `drift_count: <number>` (from reconciliation check)
  - `detail: <string>` (human-readable status)
  - `last_check: <ISO timestamp>` (prevent stale caching)

God-card reads:
- `GET /healthz` every 10s (liveness, never cache)
- `GET /health` every 60s (deep health, cache for 30s max)
- Display: GREEN (ok=true, drift=0), YELLOW (ok=true, drift>0), RED (ok=false)

### 2.6 Reduce Bespoke Layers

**Discovery pass required:** Audit for `~/.multica` scripts and home directory workarounds.

**Search locations:**
- `~/.multica/` (if exists)
- `~/bin/` (user scripts)
- `~/Documents/work/dostal/code/` (project scripts)
- Cron jobs (`crontab -l`)

**Criteria for reduction:**
- If script does memory sync → replace with reconciliation pass
- If script does scheduling → migrate to Multica-native (out of scope for this epic, note for future)
- If script is one-off debug → document and archive

**Output:** Document any bespoke layer that stays, with justification, in `docs/bespoke-inventory.md`.

## §3 Alternatives Considered

### Alt 1: File Layer as SSOT
**Pros:** Simpler fallback (files are always local), easier to debug  
**Cons:** Loses semantic search (no embeddings in files), breaks existing swarm-memory contract  
**Rejected:** Qdrant is already the proven SSOT.

### Alt 2: Reconciliation-Only (No Write-Through)
**Pros:** Simpler `/remember` implementation (just write file, reconcile later)  
**Cons:** Drift window between write and reconcile, stale reads possible  
**Rejected:** Write-through catches divergence immediately.

### Alt 3: Hooks as Optional Add-On
**Pros:** Doesn't require installer, users opt-in manually  
**Cons:** Low adoption, doesn't achieve "auto-loading" goal  
**Rejected:** Auto-loading is a hard requirement.

### Alt 4: Embed Mnemosyne in Harness
**Pros:** No separate :8477 service, tighter integration  
**Cons:** Breaks "capability-slot" model (gods are swappable), harder to test  
**Rejected:** Service boundary is valuable.

## §4 Technical Risks

### Risk 1: Qdrant Cloud Downtime
**Likelihood:** Low (managed service, historically reliable)  
**Impact:** High (all memory reads fail)  
**Mitigation:** 
- Hooks already have CLI fallback (swarm-memory works offline with last-synced state)
- File layer is recovery path - reconcile can rebuild index

### Risk 2: Write Transaction Atomicity
**Likelihood:** Medium (network failures, CLI crashes)  
**Impact:** High (layer divergence = lying memory)  
**Mitigation:**
- Loud failure on Qdrant upsert fail
- Keep file as recovery artifact
- Reconciliation pass detects drift

### Risk 3: Hook Performance Impact
**Likelihood:** Medium (pre-recall adds latency to every turn)  
**Impact:** Medium (user-perceivable delay)  
**Mitigation:**
- Cache stable prefix (doesn't change per-turn)
- Limit recall hits (default 5 + 2 shared)
- Token budget cap (default 900 tokens)
- Async `/health` calls (don't block turn start)

### Risk 4: Breaking swarm-memory Contract
**Likelihood:** Low (we're a consumer, not a modifier)  
**Impact:** Critical (Hermes, Minerva also depend on swarm-memory)  
**Mitigation:**
- Integration tests verify swarm-memory --json output shape
- Don't modify swarm-memory, only wrap it
- Version pin swarm-memory in dependencies

### Risk 5: God-Card Staleness
**Likelihood:** High (without cache-busting headers)  
**Impact:** Medium (shows stale "not built" when actually healthy)  
**Mitigation:**
- Add `last_check` timestamp to `/health` response
- God-card compares timestamp to now, flags if >5min stale
- Use `GET /healthz` for fast liveness, `/health` for deep check

## §5 Dependencies

### Internal (This Repo)
- Extend `src/engine.mjs` with reconciliation logic
- Extend `GET /health` to include drift_count
- Add `bin/mnemosyne-install-hooks` installer
- Add `bin/mnemosyne-reconcile` reconciliation helper
- Extend `test/e2e.mjs` with coherence checks

### External (Other Repos)
- `swarm-memory` - verify CLI contract, may need to coordinate on --json output format
- Pantheon status / Janus - update god-card to read live `/health` (separate story, may be in different epic)

### Not Required
- No database schema changes (Qdrant managed by swarm-memory)
- No new package.json deps (stay zero-dependency)
- No authentication layer (local-only service)

## §6 Open Questions

1. **Where is the Obsidian vault path?** Need to locate for meta layer integration.  
   → Probably out of scope for this epic (meta layer deferred), but impacts "high-level first"

2. **What bespoke ~/.multica scripts exist?** Discovery pass required.  
   → Assign to story: "Audit and inventory bespoke layers"

3. **Does dostal-orchestrator qdrant-hooks reference implementation still exist?** Where is it?  
   → Search for repo, extract hook wiring pattern if found

4. **Should reconciliation run on every startup or on-demand only?**  
   → Recommend: light check on startup (file count vs Qdrant point count), full reconcile on-demand

5. **What's the acceptable drift threshold before flagging degraded?**  
   → Recommend: 0 drift = GREEN, 1-10 drift = YELLOW, >10 drift = RED

6. **Should hooks work if Mnemosyne service is down?**  
   → Yes - hooks already have CLI fallback path via `swarm-memory` directly

7. **How do we version the hook contract?** If we change `hookSpecificOutput` shape, do we break existing users?  
   → Add version field to hook output, maintain backward compatibility for 1 release

## §7 Success Criteria

Epic is DONE when:

1. ✅ **Consistency:** Write-then-recall round-trip test passes with provenance coherence check
2. ✅ **No divergence:** `/health` reports `drift_count: 0` after write operations
3. ✅ **Auto-loading:** Hooks installer completes successfully and hooks fire on UserPromptSubmit/Stop
4. ✅ **High-level first:** Pre-recall bundle shows meta/enterprise hits ranked above narrow scopes
5. ✅ **Truthful health:** God-card reads live `/health` and shows GREEN (not a lie)
6. ✅ **Loud failure:** Qdrant upsert failure logs loudly and returns error (doesn't silently diverge)
7. ✅ **Bespoke inventory:** Any remaining ~/.multica scripts are documented with justification

Verified by:
- Extended `test/e2e.mjs` passing
- `bin/mnemosyne-install-hooks` completing without errors
- Manual smoke test: write memory, recall it, check /health shows 0 drift
- God-card (Janus/Salus) integration story passing its own AC

## §8 Phasing Recommendation

Given MEDIUM scope assessment, recommend 3-phase approach:

**Phase 1: Consistency Foundation**
- Write-through transaction (file + Qdrant)
- Reconciliation helper + `/health` drift check
- Extended e2e test with coherence verification

**Phase 2: Hook Auto-Loading**
- Hook installer (`bin/mnemosyne-install-hooks`)
- High-level first injection (meta/enterprise ranked first)
- Pre/post hook wiring validation

**Phase 3: Verification & Integration**
- Bespoke layer inventory
- God-card live health integration (may be separate epic/repo)
- Salus/Argus metric integration
- Final smoke test across all components

Each phase gates the next - don't start Phase 2 until Phase 1 consistency tests pass.

## §9 Out of Scope (Deferred)

The following are explicitly OUT of scope for this epic (mentioned in requirements but deferred):

- **Meta layer (Obsidian) integration** - File path not yet determined, architecture TBD
- **Continuous indexing** - Multica-native scheduling, separate epic
- **Consus/Janus read model** - UI for browsing layers, separate epic
- **Transcript summarization** - Beyond simple last-message capture, separate story
- **Metrics/decisions logging** - Argus/Metis integration is verification only, not full instrumentation

These remain in the idea-brief vision but are follow-on work after this epic lands.

## §10 Metrics

How we'll measure success post-deploy:

| Metric | Baseline (current) | Target | Measurement |
|--------|-------------------|--------|-------------|
| Memory drift count | Unknown (no check) | 0 | `GET /health` `drift_count` field |
| Hook installation rate | 0% (manual) | 80% of local users | Track installer runs |
| Recall-before-grep ratio | Unknown | >50% | Compare Mnemosyne `/recall` calls vs bash `grep` calls |
| False "not built" reports | 1 known incident | 0 | God-card accuracy tracking |
| Write-then-recall latency | ~2-3s (baseline) | <3s (no regression) | E2E test timing |

Stretch goal: "Recall beats find on token cost" (from north star) - requires token tracking across memory vs grep paths.
