# Horizontal Plan: mnemosyne-persona-foundation

## Epic Context
**ID:** mnemosyne-persona-foundation (Epic 1 of 2 — see `docs/design-discussion.md` §0/§1)
**Goal:** Turn Layer 1 tier content from hardcoded TypeScript (`lib/mnemosyne/layer1/tiers.ts`) into real, data-driven, two-store persona storage, and make the sync mechanism that writes it into harness files (`lib/mnemosyne/layer1/sync.ts`) real, locked, migrated, and tested. No wizard, no UI, no persona-content write route (Epic 2).
**Scale:** Medium-to-Large, concentrated (design discussion §7).

This plan enumerates every architectural layer the epic touches, the real signature/schema deltas each requires, and the cross-layer dependencies between them. It grounds each layer in the actual current source (`tiers.ts`, `sync.ts`, `block.ts`, `level0.ts`, `harness.ts`) rather than a green-field design.

---

## H1: Persona Schema + Two Storage Backends

**What:** Define the `Persona` data shape and the two on-disk stores that hold it.
**Why:** `TIER_CONTENT` (`tiers.ts:116-189`) is currently a single hardcoded object with no notion of scope or storage location. Everything else in this epic (signature threading, seed migration, query-up, locking, CLI) operates on top of this schema — it has to exist first, even though it lands as code alongside H2 in practice.

**Components:**

1. **Persona schema module** (new — `lib/mnemosyne/layer1/persona.ts`)
   - `Persona = { tier: Tier; scopeId: string; displayName: string; scope: string; sections: TierContentSection[]; parentRefs?: { tier: Tier; scopeId: string }[] }`.
   - Deliberately **excludes** `mandateSections` — per design discussion §3a, `MANDATE_SECTIONS` (`tiers.ts:89-105`) stays a shared, code-owned constant, re-injected at render time, never stored per-persona and never author-editable (Risk table row 3).
   - `parentRefs` is new: how a repo-local (`code-architect`) persona names which global-store persona(s) it queries up into (H5). Optional — global-store personas (`top-orchestrator`/`company-director`/`project-orchestrator`) don't need it since they're already the top of the chain or query up within the same store.
   - Validation function `assertValidPersona(candidate, expectedTier)`: rejects any `mandateSections` key present in raw input (closes the enforcement gap the design discussion flags as "currently only asserted, not enforced" — Risk table row 3), rejects tier/store mismatches (see H1.2/H1.3).

2. **Global persona store** (new — `lib/mnemosyne/layer1/persona-store-global.ts`)
   - Location: `~/.mnemosyne/personas/<tier>/<scopeId>.yaml`, sibling convention to `DEFAULT_LEVEL0_PATH` (`level0.ts:21`, `~/.mnemosyne/level0-rules.md`).
   - Holds `top-orchestrator`, `company-director`, `project-orchestrator` only — write path throws if called with `code-architect`.
   - Not git-committed (lives outside any repo, same rationale as Level 0: applies across companies/projects, not scoped to one repo).
   - Read/write functions mirror `level0.ts`'s "read fresh, never cache" contract (`level0.ts:23-33`) — no module-level caching, same failure posture (loud throw, not silent fallback) when a referenced `scopeId` file is missing and no seed default exists (see H3).

3. **Repo-local persona store** (new — `lib/mnemosyne/layer1/persona-store-repo-local.ts`)
   - Location: `<repoRoot>/.mnemosyne/personas/<scopeId>.yaml`, git-committed. Tier is implicitly `code-architect` — the store only ever holds this one tier (design discussion §3a: "Scoped to exactly one repo — never interacts with all repos, only whichever repo(s) it's actually checked out in").
   - `scopeId` here allows more than one code-architect persona per repo (e.g. distinct areas in a monorepo) without forcing a 1:1 repo:persona assumption prematurely — but the minimum slice (H-cut in vertical plan) only needs exactly one.
   - Write path throws if called with any tier other than `code-architect` — enforces the store split as a real invariant, not just documentation.

4. **Store-kind resolution** (new, small — part of `persona.ts` or a `persona-store.ts` facade)
   - `PERSONA_STORE_BY_TIER: Record<Tier, 'global' | 'repo-local'>` — single source of truth for which store a tier belongs to, referenced by both stores' guard clauses (H1.2/H1.3) and by H2's dispatch logic. Avoids the tier↔store mapping being duplicated/drifting between modules.

**Adapter-layer note (operator correction, post-H/V):** persona files are YAML — Mnemosyne's own canonical, harness-agnostic format — not shaped by any single harness's conventions. `sync.ts`/`harness.ts`'s existing `CLAUDE.md`/`AGENTS.md`/`GEMINI.md` splice mechanism is *an* adapter (the markdown-harness adapter), not the only one — H1-H5 must not assume it's the sole consumer of persona content. `persona show` (H5/H6) is the harness-agnostic fetch surface any future adapter (a different harness, eventually Pantheon's own runner integration) would call instead of reading YAML files directly. Building those other adapters is explicitly out of scope for this epic.

**Cross-layer dependency:** H2 (signature threading) depends on this schema/store split existing. H3 (seed/migration) writes into these stores. H4 (locking) wraps these stores' write paths, not just `sync.ts`'s. H5 (query-up) reads from the global store via H1.2's read function.

**Acceptance criteria:** `Persona` type + both store read/write functions exist, unit-tested in isolation (no `sync.ts` involvement yet); tier/store mismatch is a thrown error, not a silent no-op; `mandateSections` injection attempts are rejected at the schema-validation boundary.

---

## H2: `scopeId`/Store-Kind Signature Threading (`tiers.ts` → `sync.ts`)

**What:** Replace the bare-`tier` assumption in `getTierContent`/`syncHarnessFile`/`syncAllHarnesses` with a real scoped-persona resolution path.
**Why:** Design discussion §3a is explicit this is "not a zero-change drop-in" — `getTierContent(tier)` (`tiers.ts:191-199`) and `syncHarnessFile`/`syncAllHarnesses` (`sync.ts:47-76`) currently assume exactly one content object per tier. The research brief's "swapping the hardcoded object for a function reading from disk... no changes needed to `sync.ts`" (research-brief.md:26) is the exact framing the design discussion corrects — this layer is a real signature change, not a swap.

**Components:**

1. **New content-read function** (`persona.ts` or `tiers.ts` extension): `getPersonaContent(tier: Tier, scopeId: string, ctx: { repoRoot?: string }): TierContent`
   - Dispatches to global or repo-local store per `PERSONA_STORE_BY_TIER[tier]` (H1.4).
   - Explicitly re-injects `MANDATE_SECTIONS` (currently done inline by the `tier()` builder helper, `tiers.ts:107-114`) as a named step — design discussion §3a calls this out specifically: "needs to be a named, specified step, not assumed."
   - Falls back to `TIER_CONTENT[tier]` (the current hardcoded default) when no persona file exists for the given `scopeId` **only** as the seed/migration safety net (H3), not as silent permanent behavior — logs/warns when this fallback fires so an empty store doesn't go unnoticed.

2. **`SyncOptions` / call-signature changes** (`sync.ts:24-27`, `47-76`)
   - `syncHarnessFile(targetFilePath, tier, harnessId, scopeId, options)` — `scopeId` becomes a required positional (or a required field in a new options object; exact call shape is an implementation choice, but it must be required, not optional-with-implicit-default, per design discussion's correction).
   - `syncAllHarnesses(repoRoot, tier, scopeId, options)` — same. `repoRoot` already exists on this function (`sync.ts:72`) and becomes load-bearing for repo-local-store resolution (H1.3), not just harness file paths.
   - `buildManagedBody` (`sync.ts:37-41`) changes its `getTierContent(tier)` call (`sync.ts:38`) to `getPersonaContent(tier, scopeId, { repoRoot })`.

3. **Test-suite migration**: every existing call site in `lib/mnemosyne/layer1/__tests__/sync.test.ts` (e.g. `sync.test.ts:32`, `45`, `56`, `76`, `99`, `110`, `134`, `162`, `186`) passes a bare tier today — all need a `scopeId` argument added. This is mechanical but real; flag as its own checklist item so it isn't missed mid-refactor.

**Cross-layer dependency:** Depends on H1 (schema/stores must exist to dispatch to). H6 (CLI) and H7 (dry-run/tests) both call through this new signature, so H2 must land before either can be meaningfully exercised end-to-end. H5 (query-up) extends `getPersonaContent`'s rendering step, not its signature.

**Acceptance criteria:** `getTierContent(tier)` (old, bare-tier signature) is fully replaced (not left as a parallel path) by `getPersonaContent(tier, scopeId, ctx)`; every call site compiles against the new signature; existing `sync.test.ts` behavior (idempotency, Level 0 ordering, fresh-read, mandate presence) still passes with an explicit `scopeId` threaded through.

---

## H3: Seed / Migration Export

**What:** One-time export of the current hardcoded `TIER_CONTENT` (`tiers.ts:116-189`) into the new two-store model.
**Why:** Risk table row 4 (design-discussion.md:58): "if the new data store starts empty on cutover, every harness regresses to zero Layer 1 content until 4 tiers are re-authored from scratch." This is the single highest-blast-radius risk in the epic — it's the difference between a refactor and a regression that silently empties every `CLAUDE.md`/`AGENTS.md`/`GEMINI.md` in every repo on next sync.

**Components:**

1. **Migration script** (new — `bin/mnemosyne-persona-seed.mjs`, following the `bin/mnemosyne-reindex.mjs` pattern of a standalone `parseArgs`/`run` module invoked via `bin/mnemosyne`)
   - Reads `TIER_CONTENT['top-orchestrator' | 'company-director' | 'project-orchestrator']` and writes each as a global-store persona at a well-known default `scopeId` (e.g. `"default"`) — this becomes the fallback content referenced in H2.1.
   - Does **not** auto-write a repo-local `code-architect` persona into every checked-out repo (that would mean the seed script touching arbitrary git working trees it doesn't own) — instead, `syncAllHarnesses`'s repo-local path falls back to `TIER_CONTENT['code-architect']` (H2.1's fallback) until a repo explicitly authors its own repo-local persona file. This is the seed's realistic boundary, not a gap: repo-local content is git-committed per-repo by design (§3a), so a global seed script can't and shouldn't own it.
   - Idempotent and safe to re-run: skips (does not overwrite) any `scopeId` file that already exists, so a partial or re-run migration can't clobber operator edits made after the first run.

2. **Fallback contract** (shared with H2.1): the "seed empty → fall back to hardcoded `TIER_CONTENT`" behavior in `getPersonaContent` is what actually prevents regression on cutover day, independent of whether the seed script has been run yet in a given environment. The seed script is the *durable* fix (personas become real, editable files); the fallback is the *safety net* that makes the epic non-regressive even before/without the seed step running everywhere.

**Cross-layer dependency:** Depends on H1 (store write functions) and H2 (fallback contract in `getPersonaContent`). Should land before H6 (CLI) ships to real users, since the CLI's first invocation against a real environment is exactly the cutover moment this risk describes.

**Acceptance criteria:** running the seed script against an empty `~/.mnemosyne/personas/` produces 3 files (one per global-store tier) whose rendered markdown is byte-for-byte equivalent (modulo the wrapping) to today's `renderTierContentMarkdown(TIER_CONTENT[tier])` output; re-running the script twice is a no-op the second time; a fresh environment with the seed never run still produces correct (fallback) content via H2.1, not empty content.

---

## H4: File Locking

**What:** Advisory locking around `syncHarnessFile`'s read-splice-write sequence (`sync.ts:58-63`) and around persona-store writes (H1.2/H1.3).
**Why:** Risk table row 2 (design-discussion.md:57): "No locking on `syncHarnessFile` (`readFileSync` → splice → `writeFileSync`, no lock)... two concurrent syncs (wizard + manual CLI run, or two personas racing) can clobber a real harness file (TOCTOU)." Confirmed in source: `sync.ts:58-63` has zero coordination between the `existsSync`/`readFileSync` read and the final `writeFileSync`.

**Components:**

1. **Lock utility** (new — `lib/mnemosyne/layer1/lock.ts`)
   - Zero-dependency advisory lock (project has no `proper-lockfile`-style dependency today — see `package.yaml` `dependencies`; consistent with the project's stated zero-dep posture per design discussion §3c) via exclusive file creation (`fs.openSync(lockPath, 'wx')`), not a third-party package.
   - Lock file path derived from the target path (`<targetFilePath>.mnemosyne.lock` for harness files; `<personaFilePath>.mnemosyne.lock` for persona store files).
   - Stale-lock detection: if a lock file's mtime exceeds a timeout (e.g. 30s), treat it as abandoned (crashed process) and steal it rather than deadlocking forever — a real, boring correctness feature this needs, not a nice-to-have.
   - `withLock(path, fn)` wraps acquire → run → release (`finally`), used at both `syncHarnessFile`'s read-splice-write boundary and each persona-store write.

2. **Call-site integration**
   - `syncHarnessFile` (`sync.ts:47-66`) wraps its body (lines 58-63) in `withLock(targetFilePath, ...)`.
   - Persona-store write functions (H1.2/H1.3) wrap their own read-modify-write (relevant when the seed script and a manual persona edit could race) in `withLock`.

**Cross-layer dependency:** Wraps H1 (store writes) and H2 (`syncHarnessFile`'s existing splice sequence) — doesn't change either's external signature, purely an internal safety wrapper. Independent of H3/H5/H6 but must exist before H6's CLI ships against real files (design discussion explicitly gates "before this ships against real files" on locking, same as seed/migration).

**Acceptance criteria:** a concurrency test (two `syncHarnessFile` calls racing against the same target path) proves no lost update / no corrupted output — the second call either waits and applies cleanly or fails loudly, never silently drops the first write.

---

## H5: Query-Up Mechanism (Repo-Local → Global)

**What:** How a `code-architect` persona reaches its applicable global-store parent tier content **on demand**, without copying that content down into the repo's harness file.
**Why:** Risk table row 6 (design-discussion.md:63) is explicit this must not become a copy-down: "that contradicts the existing, already-settled `docs/layer-architecture-v2-plan.md` principle that cross-tier impact is answered by querying UP the hierarchy, never held locally at a lower tier" (confirmed in `docs/layer-architecture-v2-plan.md:35`: "Cross-project impact is still answered by querying **up** to the company director, never held locally at the code tier"). This is architecturally distinct from Mnemosyne's `recall()`/`Scope` vector-search system (`client.ts:275`, `Scope = 'project'|'enterprise'|'meta'`) — personas are structured JSON files, not embedded/indexed content, and research-brief.md §2 is explicit that the layer-stack (vector/keyword/etc.) and Layer 1 tier content are "genuinely different data models." Query-up here means a direct, on-demand *read* of the global store, not a `recall()` call through the vector/keyword layer stack.

**Components:**

1. **`parentRefs` on repo-local personas** (H1.1's schema field) — a code-architect persona names its applicable parent(s) as explicit `{tier, scopeId}` pairs, human-assigned (consistent with Risk mitigation row 2: "Keep `scopeId` a plain human-assigned label for now — no auto-detection").

2. **Pointer rendering, not content rendering**: `getPersonaContent`'s repo-local path (H2.1) renders a new **"Parent context (query up)"** section into the synced markdown — naming each parent's tier/scopeId and a short instruction for how to fetch it on demand (H5.3) — but does **not** inline the parent's `sections` content. This is the concrete mechanism that keeps the repo-local harness file from silently regressing into a copy-down.

3. **On-demand fetch surface** (reuses H1.2's global-store read function directly, plus a thin CLI wrapper — see H6.3): `getGlobalPersonaContent(tier, scopeId)`. An agent following the rendered pointer calls this (via the CLI verb, not by writing new vector-recall integration) to actually retrieve the parent tier's content when it's needed for a specific decision — mirroring the existing `MANDATE_SECTIONS` pattern (`tiers.ts:93`) of instructing the agent to take an explicit action rather than force-feeding everything into context on every sync.

**Cross-layer dependency:** Depends on H1.2 (global store read) and H2.1 (repo-local rendering path). Depends on H6 (CLI) to give the "on demand" fetch a real invocation surface — without H6, the pointer has nothing to point at operationally.

**Acceptance criteria:** a repo-local persona's synced `CLAUDE.md` contains a named pointer to its parent scopeId(s) but does not contain the parent's `sections` bodies verbatim; a separate CLI call against the named parent scopeId returns that parent's real content.

---

## H6: CLI / Invocation Surface

**What:** A real entrypoint that actually calls `syncAllHarnesses`/`syncHarnessFile` in production — closing the pre-existing gap the research brief confirms (research-brief.md §5: "the only real invocation path... is the Vitest suite. No CLI verb... no hook, no HTTP route").
**Why:** Without this, everything in H1-H5 is only ever exercised by tests — the epic's own named minimum slice (design-discussion.md:85) requires "run the new CLI verb" as a first-class step.

**Components:**

1. **CLI verb group**: `bin/mnemosyne persona <subcommand>`, wired into the existing dispatcher in `bin/mnemosyne` (currently only branches on `reindex`, `bin/mnemosyne:9-15`) the same way `reindex` dispatches to `bin/mnemosyne-reindex.mjs`. New implementation file `bin/mnemosyne-persona.mjs` (or split per-subcommand, matching the existing one-verb-one-file convention).
   - `mnemosyne persona sync --repo <path> --tier <tier> --scope-id <id> [--dry-run]` → calls `syncHarnessFile`/`syncAllHarnesses` (H2) through the locked (H4), scope-aware path.
   - `mnemosyne persona seed` → invokes the H3 migration script (or the seed script is this subcommand directly).
   - `mnemosyne persona show <tier> <scope-id> [--repo <path>]` → the H5.3 on-demand fetch surface; prints a persona's rendered content without writing anywhere.

2. **Dry-run/preview mode** (also required by H7 — listed here because it's the same code path as `sync`): `--dry-run` runs the full read-resolve-render pipeline (H1 read → H2 dispatch → H5 pointer rendering) and prints the would-be diff against the current file content, without calling `writeFileSync` or taking a lock. Cheapest correct implementation: reuse `spliceManagedBlock` (`block.ts:37-57`) to compute the next content in memory, diff against current, print — never call the real `syncHarnessFile` write path.

**Cross-layer dependency:** Depends on H1-H5 all existing with real signatures — this is the outermost layer, gated on everything underneath. H7's integration tests exercise this surface directly (or the library functions it calls), so the two should be built and validated together, not sequentially.

**Acceptance criteria:** `bin/mnemosyne persona sync` against a real (non-fixture) throwaway repo directory produces correct, locked, idempotent output; `--dry-run` produces a preview with zero filesystem writes; `persona show` returns a parent tier's content without touching any harness file.

---

## H7: Integration Test Infrastructure + Dry-Run Validation

**What:** Tests that exercise the sync/splice mechanism against realistic, marker-free, human-edited files — not just the existing clean Vitest fixtures (`sync.test.ts` currently only ever constructs files via `writeFile` in a temp dir with fully-controlled content, e.g. `sync.test.ts:93-97`).
**Why:** Risk table row 7 (design-discussion.md:60) and the TPM-lens review note in §2 (design-discussion.md:19): "that test suite never exercises the splice against realistic, marker-free, human-edited real files — production would be the first real-world test of that mechanism." This is explicitly named as a pre-condition for H6 being safe to run against real files, not an optional add-on.

**Components:**

1. **New fixture corpus** (`lib/mnemosyne/layer1/__tests__/fixtures/real-world/`): sample `CLAUDE.md`/`AGENTS.md`/`GEMINI.md` files that look like actual human-maintained repo docs — no `mnemosyne:layer1` markers at all, mixed heading levels, trailing whitespace variance, an existing `---` divider unrelated to Layer 1's own divider convention (`sync.ts:40`), one file with a *partial*/malformed marker pair (only `BLOCK_START` present, no matching `BLOCK_END` — `block.ts:44-51`'s `startIdx !== -1 && endIdx !== -1` guard is the exact code path this exercises) to confirm `spliceManagedBlock` (`block.ts:37-57`) falls back to append-mode correctly rather than corrupting the file.

2. **Integration test suite** (new — `lib/mnemosyne/layer1/__tests__/sync.integration.test.ts`, separate from the existing unit-style `sync.test.ts`): runs `syncHarnessFile`/CLI (H6) against copies of the real-world fixtures, asserts human content survives byte-for-byte outside the managed block, asserts no marker duplication, asserts locking (H4) holds under concurrent invocation.

3. **Dry-run assertions**: for every real-world fixture, assert `--dry-run`'s preview output matches what a real (non-dry-run) run would have produced, and assert dry-run never touches `mtime`/content of the fixture file.

**Cross-layer dependency:** Exercises H1-H6 together as a system; should be the last layer to land in each vertical slice (see vertical plan) but its fixture corpus and integration-test scaffolding can be built in parallel with H2-H5's implementation, since fixtures don't depend on the new code existing yet.

**Acceptance criteria: **all real-world fixtures round-trip correctly through `syncHarnessFile`; the malformed-partial-marker fixture does not corrupt output; dry-run output is provably a no-op on the filesystem (checksum/mtime unchanged).

---

## Capability Dependencies

```
H1 (Schema + Stores)
  ├─→ H2 (scopeId/store-kind signature threading)
  │     ├─→ H3 (Seed/migration — needs H2's fallback contract)
  │     ├─→ H4 (Locking — wraps H1 + H2's write paths)
  │     └─→ H5 (Query-up — extends H2's rendering step)
  │           └─→ H6 (CLI — needs H1-H5 all real)
  │                 └─→ H7 (Integration tests + dry-run — validates H1-H6 together)
```

- H1 is the true root — nothing else compiles or has anywhere to write without the schema/stores existing.
- H3 and H4 can proceed in parallel once H2 lands (seed/migration and locking are independent of each other).
- H5 depends on H2's rendering path (`getPersonaContent`) but not on H3/H4 — query-up pointers can be built and tested before seed/locking are finished, though they shouldn't ship to real files until H4 is in place (design discussion gates "real files" on locking specifically).
- H6 is a thin outer layer over H1-H5 — most of its risk is integration risk, which is exactly what H7 exists to catch.
- H7's fixture corpus has no code dependency and can be authored anytime; its test suite is gated on H6 (or at minimum H2+H4) existing to run against.

---

## Cross-Cutting Concerns

### Data model boundary (do not blur)
Layer 1 persona content (this epic) and the layer-stack config (`mnemosyne.layers.yaml` / `MNEMOSYNE_LAYERS`, `config.ts`) remain two separate data models — this epic touches only the former. No component above should read/write `LayerStackEntry`/`resolveLayerStackConfig`.

### Error handling
Loud failure, consistent with `level0.ts:26-30`'s existing posture: missing Level 0 file throws; by the same logic, an unresolvable `scopeId` with no seed fallback available should throw, not silently render empty sections. Lock acquisition timeout throws with an actionable message (which process/lock file), not a silent retry-forever.

### Backward compatibility
`TierContent` interface shape (`tiers.ts:38-54`) is explicitly "existing, unchanged" per design-discussion.md §5 — `Persona` (H1.1) is a related-but-distinct shape (drops `mandateSections`, adds `scopeId`/`parentRefs`), not a replacement of `TierContent`, which continues to be `getPersonaContent`'s render-time output shape (mandate re-injected, H2.1).

### Documentation
The two-store split is new ground for the layer architecture (design-discussion.md:37) — `docs/layer-architecture-v2-plan.md`'s tier model needs a documented addition once H1 lands, not left implicit in code alone (explicit dependency in design-discussion.md §5).

---

## Horizontal Plan Metadata
- **Epic:** mnemosyne-persona-foundation
- **Capabilities:** 7 (Schema+Stores, Signature Threading, Seed/Migration, Locking, Query-Up, CLI, Integration Tests+Dry-Run)
- **Critical path:** H1 → H2 → H6 → H7 (H3/H4/H5 fan out from H2 and reconverge at H6)
