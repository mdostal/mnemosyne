# Vertical Plan: mnemosyne-memory-levels

## Epic Context
**ID:** mnemosyne-memory-levels
**Horizontal Capabilities:** H1 Canonical taxonomy module, H2 Level 1 (`mnemosyne.md` + install), H3 `GET /memory-levels` + UI rework, H4 Level 4 sub-index, H5 Doc reconciliation + regression (see `docs/horizontal-plan.md`)
**Solo-planning order (no operator sign-off gate available this pass):** H1 first (blocks everything), then H2/H3/H4 in parallel-eligible slices, H5 last. This mirrors `mnemosyne-persona-wizard`'s own vertical-plan.md pattern of naming which slices are genuinely independent vs. genuinely sequential, rather than assuming a flat top-to-bottom order.

---

## Two Decisions That Set the Sub-Slice Boundaries

**Decision 1 — H1 (taxonomy module) ships alone, as its own slice, before any of H2/H3/H4 start.**
Every one of H2/H3/H4's acceptance criteria references the 5-level taxonomy by id/label (design-discussion.md §7.3, §7.4; horizontal-plan.md's Capability Dependencies). Building any of them against an ad hoc, inline definition of "the 5 levels" instead of H1's shared module would recreate exactly the drift risk design-discussion.md §9 names — this is a real, load-bearing sequencing requirement, not a preference for tidy layering.

**Decision 2 — H2, H3, and H4 are genuinely independent and are planned as three separate, parallel-eligible slices, not one bundled "everything else" slice.**
Horizontal-plan.md's dependency graph confirms none of the three needs another's code: H3's route can report `configured: false`/no-sub-index-status for levels 1/4 before H2/H4 ship; H2's sync-pipeline extension and H4's file-indexer touch entirely disjoint files (`layer1/sync.ts` + a new `mnemosyne.md`/reader vs. a new `lib/mnemosyne/layers/FileStoreIndex.ts`). Splitting them lets each land and be dogfooded independently rather than forcing an artificial joint slice the way `mnemosyne-persona-wizard`'s own Decision 3 split H7/H6 for the same structural reason.

---

## Slice 1: Canonical Memory-Level Taxonomy (H1)

**Goal:** A single, shared, tested module exists defining the 5 canonical memory levels (0-4) — the foundation every other slice in this epic reads from. Nothing operator-facing changes yet; this is pure groundwork, matching Epic 1 (`mnemosyne-persona-foundation`)'s own "the two-tier storage model ships before anything visible" pattern.

### Sub-slice 1a: Module + static data
**Why cut here:** the entire slice is one small, self-contained, zero-I/O module — no reason to sub-slice further; matches H1's own "static data + types, zero runtime I/O" scope exactly.
- H1 (full): `lib/mnemosyne/memory-levels/levels.ts`, `MEMORY_LEVELS` (5 entries), doc comment quoting the operator's exact words + explicit axis-disambiguation, unit test asserting exactly 5 entries / correct ids / no "tier" language / disambiguation phrase present in the doc comment / zero import-time side effects.

### Stories
1. Canonical memory-level taxonomy module (`MEMORY_LEVELS`, disambiguation doc comment, unit tests) — complexity: low.

**Dependencies:** none (first story in the epic).
**Story count:** 1.

---

## Slice 2: Level 1 — `mnemosyne.md` + Install Mechanism (H2)

**Goal:** A repo can adopt a canonical, git-committed `mnemosyne.md` and have it correctly, idempotently composed into `CLAUDE.md`/`AGENTS.md`/`GEMINI.md` via the existing, already-tested sync pipeline — with zero regression for repos that don't yet have one.

### Sub-slice 2a: `mnemosyne.md` seed content + reader module
**Why cut here:** independently real and testable without touching `sync.ts` at all — a reader that returns the right content (or `null` when absent) for a given path is a pure, small, isolable unit, exactly the shape `level0.ts` itself is (research-brief.md §2).
- H2 (reader component): `mnemosyne.md` (repo root, seeded from `MANDATE_SECTIONS`), `lib/mnemosyne/layer1/level1Source.ts`'s `readMnemosyneMdContent()` (reads fresh, returns `null`/empty when absent per design-discussion.md §7.2 — never throws, unlike Level 0's reader).
- Decision on `MANDATE_SECTIONS` sourcing (horizontal-plan.md H2 Components #1: generate-from vs. explicitly-secondary) made and documented here, since it only affects this sub-slice's two files.

**Delivered value (standalone):** `mnemosyne.md` exists and is readable/parseable correctly, independently verifiable before it touches any harness file.

### Sub-slice 2b: `sync.ts` composition + install-mechanism regression
**Why cut here:** depends on 2a's reader existing; this is where the real risk lives (design-discussion.md §9's risk table: a three-source composition, never yet exercised) — worth its own story so the composition-ordering/idempotency proof is a first-class deliverable, not a side effect of 2a.
- H2 (composition + install component): `buildManagedBody`'s 3-part join (present) / 2-part join (absent) branch; regression tests: 3-part order proven (Level 0 → Level 1 → tier, never reordered), 2-part zero-regression proven for repos without `mnemosyne.md`, idempotent re-sync after first-time `mnemosyne.md` addition proven; confirms `bin/mnemosyne-persona.mjs sync` (the existing verb) is the install surface with no new CLI needed.

### Stories
1. `mnemosyne.md` seed content + `level1Source.ts` reader + `MANDATE_SECTIONS` sourcing decision — complexity: medium (the sourcing decision is the real risk, not the file I/O).
2. `sync.ts` 3-part/2-part composition + three-source ordering/idempotency regression tests + install-mechanism (existing `sync` verb) confirmation test — complexity: medium.

**Dependencies:** Slice 1 (H1, self-identification only) → 1 → 2.
**Story count:** 2.

---

## Slice 3: `GET /memory-levels` + UI Rework (H3)

**Goal:** An operator opens the standalone UI and sees the 5 canonical memory levels, clearly and visually distinct from the existing (renamed, unmodified-behavior) retrieval-cascade panel — with an explicit architectural decision (new parallel route, `GET /layers` untouched) proven, not just asserted.

### Sub-slice 3a: Backend — `GET /memory-levels` route
**Why cut here:** independently testable via the same subprocess-spawn HTTP convention `test/http-api.mjs`/`pw-04`'s own tests already establish, without any UI code — and it carries this epic's single highest-leverage architectural decision (design-discussion.md §7.3), so it should land and be provably correct (including the "GET /layers is untouched" proof) before any UI code is written against it, matching `pw`'s own Decision 1 precedent for exactly this reasoning shape.
- H3 (route component): `GET /memory-levels` on `lib/mnemosyne/server.ts`, reusing `applyPersonaCors`/`sendJson`; reads H1's static taxonomy + a real `existsSync` check for levels 0/1 + a read (not re-resolution) of `client.getConfiguredLayers()` for levels 2-4's `activeInCascade`.
- Regression test proving `GET /layers`'s route/response is byte-for-byte unchanged (diff-based, not just "we didn't touch that code path") — this is the concrete proof for design-discussion.md §7.3's decision, not a separate story (folding it in here, adjacent to the new route, rather than deferring it to Slice 5/H5, since it's this sub-slice's own direct claim to verify).

**Delivered value (standalone):** every memory-level data point the UI needs is fetchable over real HTTP, independently of any UI code, with `GET /layers` provably unaffected.

### Sub-slice 3b: UI — panel rename + new section
**Why cut here:** pure DOM/rendering work, depends only on 3a's route existing and `GET /layers` being provably untouched; mirrors `pw-04`'s own "matches every existing panel's shape, low-risk once the route is proven" cut.
- H3 (UI component): rename "Memory Layer Stack" → "Retrieval Layer Stack" (hint copy revised, `loadPersonaLayerStack()`/`GET /layers` fetch unchanged); new "Memory Levels (0-4)" section + `loadMemoryLevels()`, wired into `refreshAll()`; explicit disambiguating copy on both sections (design-discussion.md §5's stated requirement, checked at review).

### Stories
1. `GET /memory-levels` route + `GET /layers` byte-for-byte-unchanged regression proof — complexity: medium (the regression proof is the real content here, not the route's own logic, which is a thin read).
2. UI: rename existing panel + new "Memory Levels" section + `loadMemoryLevels()` + disambiguating copy on both sections — complexity: medium.

**Dependencies:** Slice 1 (H1) → 1 → 2.
**Story count:** 2.

---

## Slice 4: Level 4 (File Doc Store) Sub-Index (H4)

**Goal:** A repo's file-doc-store layer can be indexed by area (directory + markdown heading) and queried narrowly, with today's full-walk behavior fully preserved as the fallback — the operator's explicitly named third deliverable.

### Sub-slice 4a: Index build + persisted manifest
**Why cut here:** independently real and testable without touching `FileLayerAdapter.recall()` at all — "can we build a correct, independently-verifiable manifest against a real fixture tree" is a complete, self-contained claim (mirrors `la-03`'s own "verify the raw node/line data before touching recall()" sequencing).
- H4 (build component): `lib/mnemosyne/layers/FileStoreIndex.ts` — walks the target directory (reusing `FileLayerAdapter`'s own `walk()`/ignored-directories convention), records area (dir path) + markdown headings + `sha256` hashes (reusing `FileLayerAdapter.ts`'s existing `sha256()` helper) into `<repoRoot>/.mnemosyne/file-index.json`.
- Verification discipline matching `la-03`'s own standard: read real fixture file content after building the index, assert recorded headings/line numbers/hashes match byte-for-byte, not just "a hash exists."

**Delivered value (standalone):** a correct, inspectable index artifact exists and is independently verifiable, before any query-time behavior depends on it.

### Sub-slice 4b: Query-time narrowing + rebuild trigger
**Why cut here:** depends on 4a's manifest format existing; this is where the real correctness risk lives (never returning a false negative vs. a full walk, never silently serving stale content) — worth isolating as its own proof, matching Slice 2b's same "the composition/integration step is the real risk, split it out" reasoning.
- H4 (query component): area-scoped narrowing in `recall()` (index hit → scoped walk; no index/no match/stale hash → today's exact full-walk fallback, verified byte-identical to pre-epic behavior for the no-index case).
- H4 (rebuild component): a rebuild verb (CLI, mirroring existing `bin/mnemosyne-*` conventions — exact route-vs-CLI-only call made in this story, per horizontal-plan.md's explicit deferral).
- Regression proof: area-scoped query returns a strict subset of, and never fewer correct hits than, a full walk restricted to that area; a stale (post-index-build file edit) query is proven to either exclude/flag or transparently re-read the changed file, never silently serve the old cached line.

### Stories
1. `FileStoreIndex.ts` build + persisted manifest + real-fixture verification tests — complexity: medium.
2. Query-time area-scoped narrowing in `FileLayerAdapter`/wrapper + full-walk-fallback regression + staleness-handling proof — complexity: high (the correctness bar — never a false negative, never silently stale — is the genuine risk here).
3. Rebuild trigger (CLI verb) + regression test (rebuild after a file change corrects a previously-stale entry) — complexity: low.

**Dependencies:** Slice 1 (H1) → 1 → 2 → 3.
**Story count:** 3.

---

## Slice 5: Doc Reconciliation + Full-Suite Regression + Release (H5)

**Goal:** The corrected model is documented durably (superseding, not silently deleting, the old conflated table), the full existing suite is proven unregressed exactly per this repo's own established verification bar, and the epic ships.

### Sub-slice 5a: Doc reconciliation
- `docs/layer-architecture-v2-plan.md` §1's table gets a superseded/corrected note pointing at Slice 1's taxonomy module + this epic's docs; any other stale cross-references (`README.md`, etc. — checked by grep, not assumed) updated.

### Sub-slice 5b: Full-suite regression + version bump
- `npm test` run clean; the two pre-existing, independently-documented-as-unrelated failures (`CodeGraphLayerAdapter.test.ts`'s native-binding crash, `test/http-api.mjs`'s socket-close flake) reproduced identically on a clean stash to prove zero regression, matching `la-01`'s own completion-note verification pattern exactly; version bump per `epic.yaml`.

### Stories
1. Doc reconciliation (`docs/layer-architecture-v2-plan.md` correction + cross-link check) — complexity: low.
2. Full-suite regression pass + version bump + release note — complexity: low.

**Dependencies:** Slice 2 + Slice 3 + Slice 4 (all three complete) → 1 → 2.
**Story count:** 2.

---

## Vertical Slice Summary

| Slice | Sub-slices | Stories | Working Product Increment |
|-------|-----------|---------|---------------------------|
| 1 (taxonomy) | 1a module | 1 | The 5 canonical memory levels are defined once, correctly, with a disambiguation doc comment every later slice reads from. |
| 2 (Level 1: mnemosyne.md) | 2a reader, 2b composition + install | 2 | A repo can adopt `mnemosyne.md` and have it correctly, idempotently synced into every harness file — zero regression for repos without one. |
| 3 (memory-levels route + UI) | 3a backend, 3b UI | 2 | Operator sees the 5 canonical levels in the standalone UI, clearly distinct from the (renamed, unmodified) retrieval-cascade panel; `GET /layers` proven byte-for-byte unaffected. |
| 4 (Level 4 sub-index) | 4a build, 4b query + rebuild | 3 | The file doc store can be searched by area, narrower and without regressing today's full-walk behavior when no index exists. |
| 5 (docs + regression + release) | 5a docs, 5b regression | 2 | The corrected model is documented durably, the full suite is proven clean, the epic ships. |

**Total stories:** 10

**Critical path:** Slice 1 → (Slice 2 ∥ Slice 3 ∥ Slice 4, no cross-dependency between them per Decision 2) → Slice 5. Slices 2/3/4 could in principle be staffed fully in parallel once Slice 1 lands; nothing in this plan requires them to ship in a particular relative order among themselves.

---

## Ambiguities Not Resolved by the Design Discussion (flagged, not guessed past)

1. **Exact `MANDATE_SECTIONS`-to-`mnemosyne.md` sourcing direction** (generate-TS-from-markdown vs. markdown-documented-as-now-canonical-with-TS-kept-in-sync-by-convention) — design-discussion.md §9's risk table requires ONE canonical source but doesn't pick the direction; Slice 2's first story (2a) must settle this before Slice 2's second story composes it into `sync.ts`.
2. **`GET /memory-levels`'s exact adapter-name-to-level mapping table** (e.g. does level 2 match `['graphify', 'code-graph']` literally, or does H1's taxonomy module carry this mapping itself as data) — horizontal-plan.md H3 names the requirement but leaves the exact data-ownership shape (route-local constant vs. H1 module field) to Slice 3a's first story.
3. **CLI-only vs. also-a-route for the Level 4 rebuild trigger** (horizontal-plan.md H4 Components #4 explicitly defers this) — Slice 4's third story makes this call; a CLI-only verb is the lower-risk default absent a stated operator need for a UI-triggered rebuild, but this plan does not pre-decide it.

## Resolved Ambiguities (solo-planning judgment call, not re-escalated — none rise to the level of a genuine architectural fork; all are reversible implementation details)

1. **New top-level module location** (`lib/mnemosyne/memory-levels/`, not `lib/mnemosyne/layer1/`) — design-discussion.md §8 OQ2 flags this as not fully closed at the *product-naming* level (would the operator prefer a different name/location), but this plan still needs a concrete path to build against; `lib/mnemosyne/memory-levels/` is chosen specifically to avoid compounding the already-identified `layer1`/`layers` collision (research-brief.md §0), reversible with a straightforward rename if the operator prefers otherwise.
2. **Route path: `GET /memory-levels`** (not `GET /levels`, not `GET /memory/levels`) — reads unambiguously on its own without needing the surrounding route-table doc comment for context, consistent with this file's own naming register (`/persona`, not `/p`).

## Vertical Plan Metadata
- **Epic:** mnemosyne-memory-levels
- **Slices:** 5, 9 sub-slices total
- **Total Stories:** 10
- **Sub-slicing decisions requiring justification, addressed above:** (1) H1 ships alone, first, as a hard blocker for everything else; (2) H2/H3/H4 are three independent, parallel-eligible slices, not one bundled slice, per the real (dis)connectedness of their file/dependency footprints.
