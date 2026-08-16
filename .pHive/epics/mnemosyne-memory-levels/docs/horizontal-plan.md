# Horizontal Plan: mnemosyne-memory-levels

## Epic Context
**ID:** mnemosyne-memory-levels
**Goal:** Correct Mnemosyne's memory-level model to the operator's actual 5-level (0-4), memory-STORE-TYPE taxonomy — strictly distinct from the 4-tier orchestration hierarchy and from the runtime retrieval-cascade config — and build the three real gaps it exposes: a canonical `mnemosyne.md` Level-1 source + install mechanism, a corrected UI/route surface for the 5 levels, and a Level 4 (file doc store) sub-index.
**Scale:** Medium-to-large (design-discussion.md §11).
**Ground truth:** the operator's verbatim quote in design-discussion.md §1 — not re-litigated by this plan, only decomposed into buildable capabilities.

---

## H1: Canonical Memory-Level Taxonomy Module

**What:** A new, small, static module defining the 5 canonical levels (0-4): id, label, store-type description, and a pointer to that level's real source-of-truth mechanism — plus explicit doc comments distinguishing this from both the orchestration-tier axis and the retrieval-cascade axis.
**Why:** Every other capability in this epic (Level 1's install mechanism, the new `GET /memory-levels` route, the Level 4 sub-index's own self-description) needs one shared, authoritative definition of "what are the 5 levels" to read from — without it, each would end up hardcoding its own copy of the same 5 facts, exactly the kind of drift design-discussion.md §9's risk table warns about for the "3rd/4th layer vocabulary" risk.

**Components:**
1. A new module — `lib/mnemosyne/memory-levels/levels.ts` (OQ2, design-discussion.md §8, is flagged as not fully closed; this plan places it outside `layer1/` deliberately, per design-discussion.md §7's stated reasoning, to avoid compounding the already-identified `layer1`/`layers` naming collision — research-brief.md §0).
2. `MEMORY_LEVELS: MemoryLevel[]` — exactly 5 entries (0-4), each `{ id: 0-4, label: string, storeType: string, mechanism: string (short description of the real code path), sourceRef: string (file path or doc pointer) }`.
3. A doc comment at the top of the module quoting the operator's exact words (design-discussion.md §1) as the module's own stated ground truth, and explicitly naming the two axes this module must never be confused with (orchestration tiers; retrieval cascade), with one-line pointers to where each of those actually lives (`tiers.ts`; `lib/mnemosyne/layers/`).
4. Zero runtime I/O in this module itself — pure static data + types. Live checks (does `mnemosyne.md` exist, is a level-2/3/4 adapter in the current cascade) belong to H3's route, not this module.

**Cross-layer dependency:** Blocks every other capability in this epic (H2 reads it for Level 1's composition metadata if useful; H3's route is built directly against its 5 entries; H4's sub-index self-describes as "level 4" via this module; H5's docs cross-link it).

**Acceptance criteria:** exactly 5 entries, ids 0-4, no entry's label or doc comment uses the word "tier"; a unit test asserts the module's own doc comment contains the phrase distinguishing it from the orchestration hierarchy (a cheap, durable regression against copy drift); importing this module has zero side effects (no file reads at import time).

---

## H2: Level 1 — `mnemosyne.md` Canonical Source + Install Mechanism

**What:** A new, repo-root, git-committed `mnemosyne.md` file (seeded from `tiers.ts`'s `MANDATE_SECTIONS`), a reader module analogous to `level0.ts`, and an extension to `sync.ts`'s `buildManagedBody` composing it as the second part of the managed block (Level 0 → Level 1 → tier content).
**Why:** Confirmed gap (research-brief.md §2): Level 1's underlying splice mechanism is already real and shipped, but there is no canonical, human-editable markdown file today — Level 1's content is generated purely from TypeScript. Design-discussion.md §4/§7.1 resolves the shape (full-content splice via the existing pipeline, reusing `spliceManagedBlock`/`lock.ts` as-is) and the install surface (extend the existing `bin/mnemosyne-persona.mjs sync` verb, not a new bin script).

**Components:**
1. **`mnemosyne.md`** (repo root) — canonical content, initially the `MANDATE_SECTIONS` text (recall-on-entry/remember-on-exit/flight-status-awareness) reauthored as plain markdown, human-editable, git-committed. `tiers.ts`'s `MANDATE_SECTIONS` becomes either (a) generated FROM this file at build/test time, or (b) explicitly documented as the now-secondary copy — design-discussion.md §9's risk table requires one of these, not two independently hand-maintained copies (this plan leaves the exact mechanism to the implementing story, since it's a small, contained decision, not a repo-wide architectural fork).
2. **A reader module** (e.g. `lib/mnemosyne/layer1/level1Source.ts`) mirroring `level0.ts`'s shape exactly: `readMnemosyneMdContent(path = DEFAULT_MNEMOSYNE_MD_PATH)`, reads fresh every call (no caching, matching Level 0's own hard rule), but — unlike Level 0 — returns `null`/empty (not a thrown error) when the file is missing, per design-discussion.md §7.2's resolved optionality.
3. **`sync.ts`'s `buildManagedBody` extended** to a 3-part join when `mnemosyne.md` is present (`[level0Content, '', '---', '', level1Content, '', '---', '', tierMarkdown]`) and the existing 2-part join when it's absent — zero change to `spliceManagedBlock`/`block.ts`/`lock.ts`, which operate on the whole composed body string regardless of how many parts fed into it.
4. **Install mechanism**: `bin/mnemosyne-persona.mjs sync` (already real, already the Layer-1-install verb per research-brief.md §8) picks up the new composition automatically once `buildManagedBody` changes — no new CLI surface required for the "install" ask itself. A regression test confirms re-running `sync` against a repo that previously had no `mnemosyne.md` and now has one correctly adds the new Level-1 section on the very next sync, with no manual re-trigger needed beyond the existing verb.

**Cross-layer dependency:** Depends on H1 (names itself "Level 1" consistently with the taxonomy). Independent of H3/H4 — can ship and be dogfooded on its own.

**Acceptance criteria:** a repo with `mnemosyne.md` present gets a 3-part composed body (Level 0, Level 1, tier — in that exact order, never reordered) in all 3 harness files (`CLAUDE.md`/`AGENTS.md`/`GEMINI.md`); a repo without `mnemosyne.md` gets today's exact 2-part body (zero regression); re-running sync after adding `mnemosyne.md` for the first time updates the managed block correctly (idempotent, no duplication); no second, independently-drifting copy of the mandate text exists once this ships (either generated-from or explicitly documented as canonical, per Components #1).

---

## H3: `GET /memory-levels` Route + UI Rework

**What:** A new, parallel HTTP route on `lib/mnemosyne/server.ts` (never extending or repurposing `GET /layers`, per design-discussion.md §5/§7.3's resolved architectural decision), plus a UI rework: rename the existing "Memory Layer Stack" panel to "Retrieval Layer Stack" (data source unchanged) and add a new, adjacent "Memory Levels (0-4)" section fetching the new route.
**Why:** The existing panel/route (`GET /layers`, `loadPersonaLayerStack()`) shows the retrieval cascade, not the operator's 5-level taxonomy (research-brief.md §7) — a real, structural gap, not a copy-only fix, since `GET /layers`'s response shape cannot represent levels 0/1 at all (they never participate in a `recall()` cascade).

**Components:**
1. **`GET /memory-levels`** on `lib/mnemosyne/server.ts`, following the exact `applyPersonaCors`/`sendJson` convention every existing route already uses (`server.ts:228-247` is the direct template). Response: `{ levels: [{ id, label, storeType, configured: boolean, sourceRef: string, activeInCascade?: boolean }] }` — `id 0-4` from H1's static module; `configured` for levels 0/1 is a real `existsSync` check against `~/.mnemosyne/level0-rules.md`/repo-root `mnemosyne.md`; `activeInCascade` for levels 2-4 is a read (not a re-resolution) of `client.getConfiguredLayers()`'s already-computed cascade, matched by the adapter-name(s) H1's taxonomy already documents as belonging to that level (e.g. level 2 matches `graphify` or `code-graph`; level 3 matches `vector` or `keyword`; level 4 matches `file`).
2. **UI panel rename** (`ui/index.html:276-294`): `<h2>Memory Layer Stack</h2>` → `<h2>Retrieval Layer Stack</h2>`, hint copy revised to state explicitly this is the runtime `recall()`/`remember()` cascade order, not the canonical memory-level taxonomy. `loadPersonaLayerStack()` (`ui/app.js:1346-1387`) itself is otherwise untouched — still fetches `GET /layers`, still renders `{layer, writable}` rows.
3. **New UI section**, "Memory Levels (0-4)," structurally distinct (its own `<section>`, own table, own status element — following the exact pattern `persona-layer-stack`'s own section already establishes), a new `loadMemoryLevels()` function in `ui/app.js` fetching H3.1's route, rendering all 5 levels (id, label, store type, configured/active status, source pointer) in level order, wired into `refreshAll()`.
4. **Explicit copy on both sections** stating neither is the team/orchestration tier hierarchy — a literal sentence in the hint text of each section, not left implicit (design-discussion.md §5's stated requirement).

**Cross-layer dependency:** Depends on H1 (the 5-level data). Reads (never writes, never modifies the resolution logic of) the retrieval cascade already backing `GET /layers`. Independent of H2/H4's actual implementation — the route can report `configured: false` for level 1 until H2 ships, and simply reflects whatever levels 2-4 adapters are actually configured regardless of H4's sub-index status (the sub-index doesn't change whether level 4 is "configured," only how it searches).

**Acceptance criteria:** `GET /memory-levels` returns exactly 5 entries, ids 0-4, in order; `GET /layers`'s route/response is provably unchanged (a diff/regression test, not just "didn't touch the code" — see H5); the renamed panel and the new section render side by side, visually distinct, each with the required disambiguating copy; no existing consumer of `GET /layers` (the current Personas panel's layer-stack section, `pw-04`) breaks.

---

## H4: Level 4 (File Doc Store) Sub-Index

**What:** A rebuildable, on-disk area index over `FileLayerAdapter`'s target directory (directory + markdown-heading granularity, per design-discussion.md §7.4), consulted by `recall()` for area-scoped queries, falling back to today's full walk-and-grep unmodified when the index is absent, stale, or doesn't match.
**Why:** Confirmed, total gap (research-brief.md §6): `FileLayerAdapter` has zero persisted state between calls today — "no indexing step, no embedder, no cached hash store," verbatim from this repo's own `layers/README.md`. This is the operator's explicit third named deliverable.

**Components:**
1. **Index build** — a new module (e.g. `lib/mnemosyne/layers/FileStoreIndex.ts`) that walks the same target directory `FileLayerAdapter` does (reusing its `walk()`/ignored-directories convention, not a second, divergent directory-scan implementation), and for each file: records its top-level (and one nested level of) directory as its "area," extracts markdown `#`/`##` heading text (for `.md` files) as finer-grained sub-areas, and computes the same `sha256` content-hash convention `FileLayerAdapter` already uses per line (`FileLayerAdapter.ts`'s `sha256()` helper, reused not reinvented) so staleness is detectable identically to how the adapter already thinks about content identity.
2. **Persisted manifest** — a JSON file (e.g. `<repoRoot>/.mnemosyne/file-index.json`), rebuildable, never hand-edited, structured as `{area: string, files: [{path, hash, headings?: [{text, line}]}]}[]`.
3. **Query-time narrowing** — `FileLayerAdapter.recall()` (or a thin wrapper) consults the manifest first: if the query text matches a known area name (or a heading), scope the walk to that area's file set; otherwise (no index, no match, or a matched file's live hash mismatches the recorded one) fall through to today's exact full-walk behavior for the unmatched/stale portion — never a silently wrong or silently narrower-than-intended result.
4. **Rebuild trigger** — a CLI verb or route (mirroring, in spirit not code, the existing `POST /index`/Operations-panel reindex UX pattern, research-brief.md §9) to rebuild the manifest on demand; exact surface (CLI-only vs. also a route) is this plan's call for the vertical plan to place, not pre-decided here.

**Cross-layer dependency:** Depends on H1 (self-identifies as "level 4" consistently). Independent of H2/H3 — can be built, tested, and dogfooded standalone against any repo's file tree.

**Acceptance criteria:** a fresh index build against a real fixture directory (containing subdirectories and markdown files with real headings) produces a manifest whose recorded areas/headings/hashes are independently verifiable against the real fixture content (mirroring `la-03`'s own verification discipline — read the real file, confirm the recorded line/heading matches, not just "a hash exists"); an area-scoped query against the index returns a narrower file set than a full walk would, and returns the SAME hits a full walk would have found within that area (never a false negative because of narrowing); a query against a repo with no index present behaves identically to today's `FileLayerAdapter` (zero regression); a file changed after indexing and queried by area is either correctly detected as stale (hash mismatch) and excluded/flagged rather than silently served as fresh, or the query transparently falls through to a live re-read for that file — exact behavior is the implementing story's call, but "silently wrong due to staleness" is explicitly disallowed either way.

---

## H5: Doc Reconciliation + Full-Suite Regression

**What:** Update `docs/layer-architecture-v2-plan.md` §1's conflated "reconciled architecture" table (research-brief.md §0) to point at the new canonical taxonomy rather than continuing to use "Layer 1/2/3" for memory-store types; a full existing-test-suite regression pass; version bump.
**Why:** Closing the loop on the exact miscommunication this epic exists to correct (design-discussion.md §0/§9's risk table) — without this, the new correct model and the old conflated doc would coexist indefinitely, reintroducing the same confusion for the next reader.

**Components:**
1. `docs/layer-architecture-v2-plan.md` §1's table gets an explicit superseded/corrected note (not a silent rewrite of history — this repo's docs consistently preserve "what we used to think and why we changed it," e.g. `cr-01`'s own doc comment pattern in `config.ts`) pointing at the new taxonomy module + this epic's docs.
2. `README.md`/any top-level doc index that references the old layer vocabulary gets a cross-link to the new canonical model, if any such reference exists (a real grep check, not assumed).
3. Full `npm test` (vitest suite + the `.mjs` subprocess suite, `package.json`'s `test` script) run clean, with the two pre-existing, already-documented-as-unrelated failures (the `better-sqlite3` native-binding crash in `CodeGraphLayerAdapter.test.ts`, the `test/http-api.mjs` socket-close flake — both called out by name in multiple prior stories' completion notes, e.g. `la-01`'s note) reproduced identically on the unmodified tree to confirm zero regression caused by this epic, not just "tests pass."
4. Version bump per this epic's `epic.yaml` (`minor`, matching both prior epics' convention for a real, backward-compatible feature addition).

**Cross-layer dependency:** Depends on H2, H3, and H4 all being complete (it is the epic's closing, integrative story).

**Acceptance criteria:** the corrected doc note exists and accurately describes the new model without deleting the historical record of the old one; a real `npm test` run is pasted/summarized in the story's completion note with the two known-unrelated failures named and independently reproduced on a clean stash, exactly matching this repo's own established verification bar (`la-01`'s completion note is the direct template); version bumped.

---

## Capability Dependencies

```
H1 (Canonical taxonomy module)
  ├─→ H2 (Level 1: mnemosyne.md + install mechanism)
  ├─→ H3 (GET /memory-levels + UI rework)
  └─→ H4 (Level 4 sub-index)
        (H2, H3, H4 are mutually independent — no cross-dependency
         between them; all three read H1, none reads another)

H2, H3, H4 ─→ H5 (Doc reconciliation + full-suite regression + release)
```

- H1 is the only true blocker for everything else — small, low-risk, ships first.
- H2/H3/H4 are genuinely parallelizable once H1 exists: none needs another's code to be buildable or testable (H3's route can report `configured: false` for level 1 before H2 ships; H3's UI can render level 4 as "no sub-index status" data before H4 ships — H3 only needs H1's static taxonomy, plus the already-real `GET /layers`/adapter data for levels 2-4).
- H5 is the epic's integrative closing story, gated on all three.

---

## Cross-Cutting Concerns

### Vocabulary discipline (the epic's own core risk, design-discussion.md §9)
Every new module, route, and UI string this epic introduces uses "memory level" (never bare "layer") for the 0-4 model, and never uses "level" for the orchestration tiers or a bare "layer" number for the retrieval cascade. This is not a style preference — research-brief.md §0 documents three real, pre-existing vocabulary collisions in this exact codebase; a fourth would compound the exact problem this epic exists to fix. Worth a literal grep-for-conflation check at H5's review step, not just author discipline.

### `GET /layers` and the existing Personas panel's layer-stack section are load-bearing and must not regress
`pw-04-layer-stack-visibility` already shipped, tested, and got operator sign-off on the exact route/response this epic reads from (never modifies) for levels 2-4's `activeInCascade` cross-reference. H3/H5's acceptance criteria explicitly require proving `GET /layers` is byte-for-byte unchanged, not merely "we didn't edit that function."

### Level 0's view-only status is carried forward, not relitigated
Every prior epic that's touched Level 0 in the UI (`pf`, `pw`) settled on view-only-with-a-pointer given its global blast radius. This epic's new "Memory Levels" section (H3) shows Level 0's `configured`/pointer status exactly like every other level, but introduces no edit affordance for it anywhere — same standing convention, not a new decision.

### No change to the 4-tier orchestration hierarchy's code, schema, or UI
`tiers.ts`'s `TIERS`/`TierContent`/tier-scoped persona storage are entirely out of scope for every capability in this epic. The only touch point is H2's `MANDATE_SECTIONS` sourcing decision (Components #1) — and even that changes only where the mandate TEXT is sourced from, never the tier model itself.

---

## Horizontal Plan Metadata
- **Epic:** mnemosyne-memory-levels
- **Capabilities:** 5 (Canonical taxonomy, Level 1 mnemosyne.md + install, Memory-levels route + UI rework, Level 4 sub-index, Doc reconciliation + regression)
- **Critical path:** H1 → (H2 ∥ H3 ∥ H4) → H5
- **Real architectural decision surfaced and resolved by this pass:** new parallel route (`GET /memory-levels`), never extending `GET /layers` — design-discussion.md §5/§7.3.
