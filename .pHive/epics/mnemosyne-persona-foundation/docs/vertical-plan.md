# Vertical Plan: mnemosyne-persona-foundation

## Epic Context
**ID:** mnemosyne-persona-foundation (Epic 1 of 2)
**Horizontal Capabilities:** H1 Schema+Stores, H2 Signature Threading, H3 Seed/Migration, H4 Locking, H5 Query-Up, H6 CLI, H7 Integration Tests+Dry-Run (see `docs/horizontal-plan.md`)
**Named candidate MVP slice** (design-discussion.md:85): hand-author a persona JSON → run the new CLI verb → see it land correctly, locked and tested, in a real `CLAUDE.md`, including a code-architect persona reaching up into its applicable global-store parent tier content.

## Two Decisions That Set the Slice Boundaries

**Decision 1 — locking and dry-run are not a later slice; they gate the *first* real write, full stop.**
Both risk mitigations in the design discussion are phrased as preconditions, not nice-to-haves: locking is needed "before this ships against real files" (design-discussion.md:57), and integration tests + dry-run are needed "before it's safe to call [the sync surface]... minimal" (design-discussion.md:42) — because the first production invocation would otherwise also be the first real-world test of the splice mechanism against a file that matters (research-brief.md §5, design-discussion.md:19). There is no safe intermediate state where a CLI verb writes to a real `CLAUDE.md` without a lock and without having been proven against realistic fixtures first. So every slice below that ships a real write includes its own scoped locking (H4) and dry-run/integration-test coverage (H7) — these are not deferred to a "hardening" slice at the end.

**Decision 2 — split the named MVP slice into three: repo-local-only, then global store, then query-up.**
The design discussion's candidate slice bundles three genuinely separable capabilities: (a) a working repo-local persona → sync → CLAUDE.md pipeline, (b) a working global persona store with seeded defaults, and (c) the query-up pointer mechanism connecting the two. Bundling all three into one slice is not necessary for it to be "genuinely working" at each step:

- Slice 1 (repo-local only) is independently real and testable: a code-architect persona syncs into a real harness file, locked, dry-run-able, tested against realistic fixtures. The three global tiers are **not regressed** — they keep working exactly as today, via `TIER_CONTENT` (H2's fallback contract, which H3 needs anyway, is what makes this safe rather than a hack). Nothing about repo-local-only leaves the system in a partially-broken state.
- Slice 2 (global store) is independently real and testable: a human can author top-orchestrator/company-director/project-orchestrator personas and sync them, with a seed migration guaranteeing no regression from the cutover itself. It does not need query-up to be valuable — most repos may never author a repo-local persona at all and would still benefit from real, editable global-tier content.
- Slice 3 (query-up) is the smallest slice and the one place genuine new architectural risk lives (Risk row 6, design-discussion.md:63 — the copy-down trap). Isolating it means that risk gets its own focused test surface instead of being buried inside a larger slice's test suite.

Each slice is a strict superset in capability of the previous one and never regresses it — verified by carrying forward the prior slice's integration tests as regression checks in the next slice's acceptance criteria (same pattern as the `ingest-a10ab2c1` epic's slicing).

---

## Slice 1: Repo-Local Persona → Sync → Real Harness File

**Goal:** A hand-authored `code-architect` persona, stored git-committed in a repo, syncs correctly (locked, dry-run-able, tested against realistic fixtures) into that repo's `CLAUDE.md`/`AGENTS.md`/`GEMINI.md` via a real CLI verb — with the three global tiers continuing to work exactly as they do today (zero regression).

### Scope
- **H1 (subset):** `Persona` schema (`lib/mnemosyne/layer1/persona.ts`) and the repo-local store only (`persona-store-repo-local.ts`, `<repoRoot>/.mnemosyne/personas/<scopeId>.yaml`, git-committed). `PERSONA_STORE_BY_TIER` map exists but only the `code-architect → repo-local` branch is exercised. Global store module is stubbed/typed but not implemented.
- **H2 (subset):** `getPersonaContent(tier, scopeId, ctx)` is introduced and re-injects `MANDATE_SECTIONS`. Dispatch: `tier === 'code-architect'` → repo-local store; every other tier → `TIER_CONTENT[tier]` unchanged (no regression risk — this is the existing, already-tested path). `syncHarnessFile`/`syncAllHarnesses` gain the `scopeId` parameter in their final signature shape now (avoids a second signature migration in Slice 2), but for non-`code-architect` tiers the value is currently unused.
- **H3:** Not needed yet — no global store exists to seed. (The repo-local fallback-to-`TIER_CONTENT['code-architect']` behavior, needed so an un-authored repo doesn't regress to empty, is built here as part of H2's dispatch, not as a separate H3 deliverable.)
- **H4 (full):** Lock utility (`lock.ts`) applied to `syncHarnessFile`'s read-splice-write and to repo-local persona-store writes.
- **H5:** Not built yet — `parentRefs` field may exist on the schema (harmless if unused) but no pointer-rendering or on-demand fetch.
- **H6 (subset):** `bin/mnemosyne persona sync --repo <path> --tier code-architect --scope-id <id> [--dry-run]`. No `persona show`, no `persona seed` yet (nothing for them to do until Slice 2).
- **H7 (subset):** Real-world fixture corpus (marker-free, human-edited, partial-marker files) and integration tests scoped to the repo-local/code-architect path; dry-run assertions for this path.

### Delivered Value
- A human can hand-write a repo-local persona JSON file, run one real CLI command, and see it land correctly in their repo's actual `CLAUDE.md`/`AGENTS.md`/`GEMINI.md` — closing the "no production entrypoint" gap (research-brief.md §5) for the first time, for real files.
- Concurrent syncs can no longer corrupt a harness file (locking proven under test).
- The sync/splice mechanism is proven against realistic, marker-free, human-edited fixtures for the first time — not just clean Vitest-authored ones.
- Top-orchestrator/company-director/project-orchestrator harness content is provably unaffected (regression tests against existing `sync.test.ts` behavior).

### Acceptance Criteria
- Hand-authoring `<repoRoot>/.mnemosyne/personas/<scopeId>.yaml` and running `bin/mnemosyne persona sync --repo <repoRoot> --tier code-architect --scope-id <id>` produces correct managed-block content in all three harness files, idempotently, with human-authored content outside the block untouched.
- `--dry-run` produces an accurate preview with zero filesystem writes (checksum/mtime unchanged).
- A concurrency test (two overlapping `persona sync` invocations against the same target) proves no corruption/lost update.
- All real-world fixtures (including the partial-marker fixture) round-trip correctly.
- Existing `sync.test.ts` suite passes unmodified in behavior (only call-site signatures updated to pass `scopeId`) — proves global-tier sync is unaffected.

### Stories
1. **Persona schema + repo-local store** (complexity: medium) — `persona.ts`, `persona-store-repo-local.ts`, validation (tier/store mismatch guard, `mandateSections`-rejection).
2. **`getPersonaContent` + signature threading through `sync.ts`** (complexity: high) — new read function, `syncHarnessFile`/`syncAllHarnesses` signature change, `buildManagedBody` update, migrate all `sync.test.ts` call sites.
3. **File locking** (complexity: medium) — `lock.ts`, wire into `syncHarnessFile` and repo-local store writes, stale-lock handling, concurrency test.
4. **CLI: `persona sync` + `--dry-run`** (complexity: medium) — `bin/mnemosyne-persona.mjs`, dispatcher wiring in `bin/mnemosyne`, dry-run preview via `spliceManagedBlock` diff.
5. **Real-world fixture corpus + integration test suite** (complexity: medium) — marker-free/partial-marker fixtures, `sync.integration.test.ts`, dry-run no-op assertions.

**Dependencies:** 1 → 2 → (3, 4 in parallel) → 5 (5 exercises 1-4 together; can be scaffolded in parallel and finalized last).

---

## Slice 2: Global Persona Store + Seed/Migration

**Goal:** Top-orchestrator, company-director, and project-orchestrator personas become real, authorable, git-independent global-store files — with a seed migration guaranteeing the cutover itself never regresses any harness to empty content. Slice 1's repo-local/code-architect functionality is unaffected.

### Scope
- **H1 (remainder):** Global store module (`persona-store-global.ts`, `~/.mnemosyne/personas/<tier>/<scopeId>.yaml`), read-fresh-never-cache contract mirroring `level0.ts`.
- **H2 (remainder):** `getPersonaContent`'s dispatch now routes `top-orchestrator`/`company-director`/`project-orchestrator` to the global store instead of the Slice-1 fallback-only path; falls back to `TIER_CONTENT[tier]` **only** when no persona file exists yet for that `scopeId` (the safety-net behavior, now actually exercisable since a real store exists to be empty or populated).
- **H3 (full):** `mnemosyne persona seed` — one-time, idempotent export of `TIER_CONTENT`'s 3 global tiers into the global store at a default `scopeId`.
- **H4 (extend):** Lock utility (already built in Slice 1) now also wraps global-store writes (seed script + any manual persona edits).
- **H5:** Still not built — global personas exist and sync correctly, but nothing yet points a repo-local persona at them.
- **H6 (extend):** `bin/mnemosyne persona seed`; `persona sync` now also works for the 3 global tiers (`--tier company-director --scope-id <id>`, no `--repo` needed since the global store isn't repo-scoped).
- **H7 (extend):** Fixture/test coverage extended to global-tier sync; a specific regression test proving Slice 1's repo-local/code-architect sync still passes unchanged.

### Delivered Value
- Global-tier content stops being hardcoded TypeScript that requires a code change + deploy to edit — it's a real file a human can author, following the exact repo-spinup lifecycle described in design-discussion.md §3a (company/project ideation before a repo exists).
- Cutover from hardcoded to data-driven content is provably non-regressive: seeding an empty global store reproduces today's exact rendered output.
- Slice 1's repo-local pipeline continues to work untouched (explicit regression proof, not just "should still work").

### Acceptance Criteria
- `mnemosyne persona seed` against an empty `~/.mnemosyne/personas/` produces 3 files whose rendered markdown matches today's `renderTierContentMarkdown(TIER_CONTENT[tier])` output; re-running is a no-op.
- `mnemosyne persona sync --tier company-director --scope-id default` (etc.) produces correct locked output in a target harness file, dry-run-able, using the newly-seeded content.
- A fresh environment with seed *not yet run* still produces correct (fallback) content for global tiers — no empty-content regression window.
- Slice 1's full acceptance suite (fixtures, locking, dry-run, repo-local sync) still passes without modification.

### Stories
1. **Global persona store module** (complexity: medium) — `persona-store-global.ts`, read-fresh contract, tier/store guard.
2. **`getPersonaContent` global-tier dispatch** (complexity: medium) — wire global store into the dispatch built in Slice 1, safety-net fallback now real.
3. **Seed/migration script** (complexity: medium) — `bin/mnemosyne-persona-seed.mjs`, idempotency guarantee, byte-for-byte equivalence test against current `TIER_CONTENT` render output.
4. **CLI: `persona seed` + `persona sync` for global tiers** (complexity: low) — extend Slice 1's CLI dispatcher; global-tier sync doesn't take `--repo` for content resolution (still needs a target repo to write the harness file into).
5. **Global-tier fixture/regression coverage** (complexity: low) — extend integration suite; explicit Slice-1-still-passes regression test.

**Dependencies:** 1 → 2 → 3 → (4, 5 in parallel). Reuses Slice 1's `lock.ts` and dry-run mechanism directly — no new locking/dry-run design work, only new call sites.

---

## Slice 3: Query-Up (Repo-Local → Global Parent Content)

**Goal:** A code-architect persona can name its applicable global-store parent(s) and an agent working in that repo can reach that parent content on demand — completing the design discussion's named MVP scenario in full, without ever copying parent content down into the repo's harness file.

### Scope
- **H1 (remainder):** `parentRefs: { tier, scopeId }[]` field on repo-local `Persona` records (schema already allowed for it in Slice 1; now actually populated and read).
- **H5 (full):** Pointer rendering — `getPersonaContent`'s repo-local path renders a "Parent context (query up)" section naming each parent tier/scopeId, with an instruction to fetch it via H6's new `persona show`, and explicitly does **not** inline the parent's `sections` body.
- **H6 (remainder):** `bin/mnemosyne persona show <tier> <scope-id>` — the on-demand fetch surface; read-only, no harness-file involvement, reuses Slice 2's global-store read function directly.
- **H7 (extend):** A test asserting the synced repo-local harness file contains the parent pointer (tier + scopeId) but does **not** contain the parent's `sections` text verbatim — the concrete, automatable check against the copy-down risk (design-discussion.md:63). Full regression pass of Slices 1 and 2.

### Delivered Value
- The exact scenario named in design-discussion.md:85 is now true end-to-end: a code-architect persona correctly reaches up into its applicable global-store parent tier content, on demand, without a copy-down.
- `docs/layer-architecture-v2-plan.md`'s "query up, never hold locally" principle is now enforced in code and covered by an automated test, not just documentation.

### Acceptance Criteria
- A repo-local persona with `parentRefs: [{tier: 'project-orchestrator', scopeId: 'default'}]` produces a synced `CLAUDE.md` containing a clearly labeled pointer to that parent, and provably does not contain that parent's `sections` bodies verbatim.
- `bin/mnemosyne persona show project-orchestrator default` returns that parent's real, current content.
- Editing the parent persona's content and re-running `persona show` (no repo-local re-sync needed) reflects the change immediately — proving this is a live on-demand read, not a cached/synced copy.
- Full Slice 1 + Slice 2 regression suites still pass.

### Stories
1. **`parentRefs` schema support + validation** (complexity: low) — extend `persona.ts`, accept in repo-local persona JSON.
2. **Pointer rendering in `getPersonaContent`** (complexity: medium) — new "Parent context (query up)" section, explicit non-inlining test.
3. **CLI: `persona show`** (complexity: low) — thin wrapper over the global-store read function built in Slice 2.
4. **Copy-down regression test + full-suite regression pass** (complexity: low) — the automated check that pointer content stays a pointer, not a copy; re-run Slice 1/2 suites.

**Dependencies:** 1 → 2 → 3 → 4.

---

## Vertical Slice Summary

| Slice | Scope | Stories | Working Product Increment |
|-------|-------|---------|---------------------------|
| 1 | Repo-local (code-architect) only — schema, store, signature threading, locking, dry-run, CLI `sync`, realistic fixtures | 5 | A hand-authored repo-local persona syncs correctly, locked and tested, into a real harness file. Global tiers unaffected. |
| 2 | + Global store (3 tiers) + seed/migration | 5 | Global-tier personas are real, authorable files; cutover is provably non-regressive; Slice 1 still works. |
| 3 | + Query-up (parentRefs, pointer rendering, `persona show`) | 4 | Named MVP scenario complete: code-architect personas reach up into global parent content on demand, no copy-down. Slices 1+2 still work. |

**Total stories:** 14 (5 + 5 + 4)

**Critical path:** Slice 1 → Slice 2 → Slice 3 (sequential — Slice 2's global store is a real dependency of Slice 3's query-up target; Slice 3 has no independent value without Slice 2's global content to point at).

**What's explicitly still out of scope after Slice 3:** the LLM-interview wizard, any UI, the persona-content write route/skill (all Epic 2, `mnemosyne-persona-wizard`, per design-discussion.md header and §5).

---

## Vertical Plan Metadata
- **Epic:** mnemosyne-persona-foundation
- **Slices:** 3 (Repo-local, Global store, Query-up)
- **Total Stories:** 14
- **Slicing decisions requiring justification, addressed above:** (1) locking + dry-run/integration-tests are non-negotiable in Slice 1, not deferred; (2) the named MVP slice splits into 3 increments along store/query-up boundaries, each independently real and non-regressive.
