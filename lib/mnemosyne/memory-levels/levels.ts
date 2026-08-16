/**
 * Canonical memory-level taxonomy (levels 0-4) — ml-01-memory-level-taxonomy
 * (epic: mnemosyne-memory-levels).
 *
 * This module is the single, shared source every other story in this epic
 * reads from. It is pure static data: no file reads, no environment checks,
 * no network calls, no runtime resolution of any kind. Later stories (e.g.
 * ml-04's `GET /memory-levels` route) layer LIVE checks on top of this data
 * (does `mnemosyne.md`/`level0-rules.md` exist on disk, is a level's adapter
 * currently active in the resolved retrieval cascade) — this module never
 * performs I/O itself, so it stays trivially testable and reusable by every
 * consumer without accidentally coupling them to a particular runtime
 * context.
 *
 * ## Ground truth — the operator's own, exact words
 *
 * Per `.pHive/epics/mnemosyne-memory-levels/docs/design-discussion.md` §1,
 * this is the operator's own, exact, corrected description of the model
 * this module encodes (quoted verbatim, not paraphrased):
 *
 * > "you have 3 levels listed as vector, graph, and files. those are the
 * > 2,3,4 -- 0 is the mnemosyne persona injection rules we are talking, 1 is
 * > the in repo persona overlay etc like the claude/agents/gemini/etc with
 * > the adapter (we should make our own mnemosyne.md and then include it
 * > INTO the others with an install script or something to lock that in
 * > easy or just drop in all of the TYPES (gemini, claude,agents etc) and
 * > have it include mnemosyne. then then your levels. the levels are not
 * > the orchestration or personal LEVEL -- coder isn't level 6. Each MEMORY
 * > STORE TYPE is a level -- so 0 comes from mnemosyne directly and has to
 * > be added to things from mnemosyne itself. then we have a repo level
 * > agent overview (default agent integration with their .md instructions)
 * > then we have the added graph, the vector, the file doc store (and we
 * > should do an index of the contents OF the file doc store so we can
 * > index areas of it for a quick search as well) EACH TYPE is a layer. The
 * > Orchestration MAPPINGs ARE LAYERS -- however, that is not MEMORY LAYERS
 * > but team/orchestration layers."
 *
 * ## What this module is NOT — two axes it must never be confused with
 *
 * This codebase already has THREE independent, coexisting uses of the word
 * "layer" (research-brief.md §0 has the full three-way comparison). This
 * module's 5-level memory-STORE-TYPE taxonomy is a FOURTH, correct axis,
 * deliberately disambiguated here rather than reusing either of the
 * following two:
 *
 * 1. **The orchestration-tier axis — `lib/mnemosyne/layer1/tiers.ts`.**
 *    The 4-tier `top-orchestrator` / `company-director` /
 *    `project-orchestrator` / `code-architect` hierarchy is "team/
 *    orchestration layers", the operator's own term — a WHO-is-doing-the-
 *    work axis, entirely separate from and untouched by this module. A
 *    tier is never a memory level, and "coder isn't level 6" (operator's
 *    own words above) is exactly the confusion this module exists to
 *    prevent. `tiers.ts` is read from nowhere in this module and this
 *    module changes nothing about it.
 *
 * 2. **The retrieval-cascade axis — `lib/mnemosyne/layers/` (`GET /layers`,
 *    `MNEMOSYNE_LAYERS`).** This is a runtime, WHICH-BACKENDS-ARE-ACTIVE-
 *    RIGHT-NOW resolution (`client.getConfiguredLayers()`), not a static
 *    taxonomy — levels 0 and 1 don't even participate in a `recall()`
 *    cascade at all, so they are structurally unrepresentable inside
 *    `GET /layers`'s shape. This module is read from, but never modifies,
 *    `lib/mnemosyne/layers/registry.ts`'s real adapter names (see
 *    `adapterNames` below) — it does not add, remove, or reconfigure any
 *    layer adapter.
 *
 * ## The 5 canonical levels — each a distinct MEMORY STORE TYPE
 *
 * Re-confirmed directly against the real mechanisms immediately before
 * writing this module (not assumed from planning docs alone):
 *
 *   - Level 0 — operator-global rules, `lib/mnemosyne/layer1/level0.ts`
 *     (`readLevel0Content`, `~/.mnemosyne/level0-rules.md`, read fresh every
 *     sync, hard-fails if missing).
 *   - Level 1 — in-repo harness-native instruction files, targets defined
 *     in `lib/mnemosyne/layer1/harness.ts` (`CLAUDE.md`/`AGENTS.md`/
 *     `GEMINI.md`), composed by `lib/mnemosyne/layer1/sync.ts`
 *     (`buildManagedBody`, `spliceManagedBlock`, `withLock`).
 *   - Level 2 — graph store, `lib/mnemosyne/layers/registry.ts`'s
 *     `'graphify'` (current default) and `'code-graph'` (legacy,
 *     still-registered) adapters.
 *   - Level 3 — vector store, `lib/mnemosyne/layers/registry.ts`'s
 *     `'vector'` and `'keyword'` adapters (run in parallel when both are
 *     configured).
 *   - Level 4 — raw file doc store, `lib/mnemosyne/layers/registry.ts`'s
 *     `'file'` adapter (`FileLayerAdapter`).
 *
 * Levels 0 and 1 carry an empty `adapterNames` array: they never
 * participate in the `recall()` retrieval cascade, so no
 * `lib/mnemosyne/layers/` adapter name applies to them.
 */

/** A single canonical memory level (0-4) — a distinct memory-STORE-TYPE. */
export interface MemoryLevel {
  /** The canonical level number, 0-4. Never repurposed as an orchestration tier number. */
  readonly id: 0 | 1 | 2 | 3 | 4;
  /** Short human-readable name, e.g. "Graph". Never contains the word "tier". */
  readonly label: string;
  /** The kind of store this level is, e.g. "semantic embedding store". */
  readonly storeType: string;
  /** How this level is realized today in this codebase. Never contains the word "tier". */
  readonly mechanism: string;
  /** Path(s), relative to repo root, to the real file(s) this entry's data was cross-checked against. */
  readonly sourceRef: string;
  /**
   * The real `lib/mnemosyne/layers/registry.ts` adapter name(s) backing this
   * level, if any — the exact mapping ml-04's `GET /memory-levels` route
   * needs and must not reinvent. Empty for levels 0/1, which never
   * participate in the `recall()` retrieval cascade.
   */
  readonly adapterNames: readonly string[];
}

export const MEMORY_LEVELS: readonly MemoryLevel[] = Object.freeze([
  Object.freeze({
    id: 0,
    label: 'Mnemosyne operator rules',
    storeType: 'operator-global rules file',
    mechanism:
      "Mnemosyne's own injection rules, sourced directly from Mnemosyne and added into a repo's " +
      'agent files. Read fresh from disk on every sync run (never cached module-level), prepended ' +
      'verbatim ahead of any other composed content, and never omitted -- a missing file fails the ' +
      'sync loudly rather than silently generating a harness file without it.',
    sourceRef: 'lib/mnemosyne/layer1/level0.ts',
    adapterNames: [],
  }),
  Object.freeze({
    id: 1,
    label: 'Repo agent overlay',
    storeType: 'repo-committed instruction files',
    mechanism:
      "The in-repo agent overlay -- each harness's own native auto-load instruction file " +
      '(CLAUDE.md for Claude Code, AGENTS.md for Codex, GEMINI.md for Gemini CLI), composed by ' +
      'splicing a managed block (level-0 content first, verbatim) into the file idempotently and ' +
      'lock-safely, never touching human-authored content outside the block.',
    sourceRef: 'lib/mnemosyne/layer1/harness.ts, lib/mnemosyne/layer1/sync.ts',
    adapterNames: [],
  }),
  Object.freeze({
    id: 2,
    label: 'Graph',
    storeType: 'code/doc structure graph',
    mechanism:
      'A structural graph over this repo\'s code and docs, queried as part of the recall() retrieval ' +
      "cascade. 'graphify' is the current default implementation; 'code-graph' is an earlier " +
      'implementation, still registered and selectable, not removed.',
    sourceRef: 'lib/mnemosyne/layers/registry.ts',
    adapterNames: ['graphify', 'code-graph'],
  }),
  Object.freeze({
    id: 3,
    label: 'Vector',
    storeType: 'semantic embedding store',
    mechanism:
      "A semantic embedding store queried as part of the recall() retrieval cascade. 'vector' is " +
      "the embedding-similarity adapter; 'keyword' is an exact/keyword-match adapter over the same " +
      'indexed corpus, run alongside it in parallel when both are configured.',
    sourceRef: 'lib/mnemosyne/layers/registry.ts',
    adapterNames: ['vector', 'keyword'],
  }),
  Object.freeze({
    id: 4,
    label: 'File doc store',
    storeType: 'raw filesystem content',
    mechanism:
      "A raw walk-and-grep over this repo's own filesystem content, queried as part of the " +
      "recall() retrieval cascade via the 'file' adapter. Has no index today -- every call is a " +
      'full brute-force walk of the target directory.',
    sourceRef: 'lib/mnemosyne/layers/registry.ts, lib/mnemosyne/layers/FileLayerAdapter.ts',
    adapterNames: ['file'],
  }),
]);
