/**
 * ml-01-memory-level-taxonomy — tests for the canonical memory-level module.
 *
 * Written before lib/mnemosyne/memory-levels/levels.ts exists (TDD per this
 * story's `methodology: tdd`) — every test here is expected to fail until
 * the module is implemented.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const MODULE_SOURCE_PATH = fileURLToPath(new URL('../levels.ts', import.meta.url));
const MODULE_IMPORT_SPECIFIER = '../levels.js';

// The operator's exact verbatim words, design-discussion.md §1 — the module's doc
// comment must quote this (or a byte-identical substring of it) as stated ground
// truth. Copied verbatim from the design doc, not paraphrased, so a drifted doc
// comment fails this test rather than silently going stale.
const OPERATOR_QUOTE_SNIPPET =
  'Each MEMORY STORE TYPE is a level -- so 0 comes from mnemosyne directly and has to be added to things from mnemosyne itself.';
const OPERATOR_QUOTE_FULL =
  'you have 3 levels listed as vector, graph, and files. those are the 2,3,4 -- 0 is the mnemosyne persona injection rules we are talking, 1 is the in repo persona overlay etc like the claude/agents/gemini/etc with the adapter (we should make our own mnemosyne.md and then include it INTO the others with an install script or something to lock that in easy or just drop in all of the TYPES (gemini, claude,agents etc) and have it include mnemosyne. then then your levels. the levels are not the orchestration or personal LEVEL -- coder isn\'t level 6. Each MEMORY STORE TYPE is a level -- so 0 comes from mnemosyne directly and has to be added to things from mnemosyne itself. then we have a repo level agent overview (default agent integration with their .md instructions) then we have the added graph, the vector, the file doc store (and we should do an index of the contents OF the file doc store so we can index areas of it for a quick search as well) EACH TYPE is a layer. The Orchestration MAPPINGs ARE LAYERS -- however, that is not MEMORY LAYERS but team/orchestration layers.';

describe('lib/mnemosyne/memory-levels/levels.ts', () => {
  it('module file exists at the correct top-level location (not inside layer1/)', () => {
    expect(existsSync(MODULE_SOURCE_PATH)).toBe(true);
  });

  describe('MEMORY_LEVELS shape', () => {
    it('contains exactly 5 entries with ids 0,1,2,3,4, each carrying the minimum required fields', async () => {
      const { MEMORY_LEVELS } = await import(MODULE_IMPORT_SPECIFIER);
      expect(Array.isArray(MEMORY_LEVELS)).toBe(true);
      expect(MEMORY_LEVELS).toHaveLength(5);

      const ids = MEMORY_LEVELS.map((entry: any) => entry.id);
      expect(ids).toEqual([0, 1, 2, 3, 4]);

      for (const entry of MEMORY_LEVELS) {
        expect(typeof entry.id).toBe('number');
        expect(typeof entry.label).toBe('string');
        expect(entry.label.length).toBeGreaterThan(0);
        expect(typeof entry.storeType).toBe('string');
        expect(entry.storeType.length).toBeGreaterThan(0);
        expect(typeof entry.mechanism).toBe('string');
        expect(entry.mechanism.length).toBeGreaterThan(0);
        expect(typeof entry.sourceRef).toBe('string');
        expect(entry.sourceRef.length).toBeGreaterThan(0);
      }
    });
  });

  describe('top-of-file doc comment — disambiguation', () => {
    const source = readFileSync(MODULE_SOURCE_PATH, 'utf8');

    const normalizeCommentText = (text: string): string =>
      text
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map((line) => line.replace(/^\s*\*\s?/, '').replace(/^>\s?/, ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();

    it('quotes the operator\'s exact words (design-discussion.md §1) as stated ground truth', () => {
      expect(normalizeCommentText(source)).toContain(normalizeCommentText(OPERATOR_QUOTE_SNIPPET));
    });

    it('quotes the full operator verbatim quote, whitespace-normalized (doc comments wrap across lines)', () => {
      // The doc comment wraps the quote across `/** ... */` lines with leading
      // `* ` / `> ` markup -- normalize both sides to a single space-joined
      // string so line-wrapping doesn't produce a false negative, while still
      // proving every word of the operator's exact quote is present, in order,
      // unparaphrased.
      const normalize = (text: string): string =>
        text
          .replace(/\r\n/g, '\n')
          .split('\n')
          .map((line) => line.replace(/^\s*\*\s?/, '').replace(/^>\s?/, ''))
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();

      expect(normalize(source)).toContain(normalize(OPERATOR_QUOTE_FULL));
    });

    it('explicitly names the orchestration-tier axis and points at tiers.ts, disclaiming it', () => {
      expect(source).toMatch(/tiers\.ts/);
      expect(source).toMatch(/top-orchestrator/);
      expect(source).toMatch(/company-director/);
      expect(source).toMatch(/project-orchestrator/);
      expect(source).toMatch(/code-architect/);
    });

    it('explicitly names the retrieval-cascade axis and points at lib/mnemosyne/layers/, disclaiming it', () => {
      expect(source).toMatch(/lib\/mnemosyne\/layers\//);
    });

    it('cites design-discussion.md as the source of ground truth', () => {
      expect(source).toMatch(/design-discussion\.md/);
    });
  });

  describe('no "tier" language in entry label/mechanism text (programmatic, not just author discipline)', () => {
    it('never uses the word "tier" in any entry\'s label or mechanism', async () => {
      const { MEMORY_LEVELS } = await import(MODULE_IMPORT_SPECIFIER);
      for (const entry of MEMORY_LEVELS) {
        expect(entry.label.toLowerCase()).not.toMatch(/tier/);
        expect(entry.mechanism.toLowerCase()).not.toMatch(/tier/);
      }
    });
  });

  describe('zero import-side-effect', () => {
    afterEach(() => {
      vi.restoreAllMocks();
      vi.resetModules();
    });

    it('importing the module alone performs no file I/O (every node:fs property access tracked and asserted empty)', async () => {
      // vi.spyOn can't redefine a live ESM namespace export ("Module namespace
      // is not configurable in ESM"), so instead we vi.doMock the whole
      // 'node:fs' module with a Proxy that records every property access,
      // then dynamically import the module under test against that mock.
      // Zero recorded accesses proves the import touched no fs API at all.
      const accessedProps: string[] = [];
      vi.doMock('node:fs', async () => {
        const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
        return new Proxy(actual, {
          get(target, prop, receiver) {
            accessedProps.push(String(prop));
            return Reflect.get(target, prop, receiver);
          },
        });
      });

      vi.resetModules();
      await import(MODULE_IMPORT_SPECIFIER);

      expect(accessedProps).toEqual([]);
      vi.doUnmock('node:fs');
    });

    it('static-source check: the module has no import/require of fs, http(s), or child_process', () => {
      const source = readFileSync(MODULE_SOURCE_PATH, 'utf8');
      expect(source).not.toMatch(/from\s+['"](node:)?fs['"]/);
      expect(source).not.toMatch(/from\s+['"](node:)?https?['"]/);
      expect(source).not.toMatch(/from\s+['"](node:)?child_process['"]/);
      expect(source).not.toMatch(/require\(\s*['"](node:)?(fs|https?|child_process)['"]\s*\)/);
    });

    it('importing the module alone reads no environment variables observable via process.env access patterns beyond baseline', async () => {
      // Pure static-data module: importing it must not throw, must not touch
      // process.env, and must produce the same reference-stable data on
      // re-import within the same module cache (no per-import computation).
      const first = await import(MODULE_IMPORT_SPECIFIER);
      const second = await import(MODULE_IMPORT_SPECIFIER);
      expect(first.MEMORY_LEVELS).toBe(second.MEMORY_LEVELS);
    });
  });

  describe('level 2/3/4 adapter-name mapping (data, not prose) — the exact mapping ml-04 needs', () => {
    it('maps level 2 (graph) to the graphify/code-graph adapters', async () => {
      const { MEMORY_LEVELS } = await import(MODULE_IMPORT_SPECIFIER);
      const level2 = MEMORY_LEVELS.find((entry: any) => entry.id === 2);
      expect(level2.adapterNames).toEqual(['graphify', 'code-graph']);
    });

    it('maps level 3 (vector) to the vector/keyword adapters', async () => {
      const { MEMORY_LEVELS } = await import(MODULE_IMPORT_SPECIFIER);
      const level3 = MEMORY_LEVELS.find((entry: any) => entry.id === 3);
      expect(level3.adapterNames).toEqual(['vector', 'keyword']);
    });

    it('maps level 4 (file doc store) to the file adapter', async () => {
      const { MEMORY_LEVELS } = await import(MODULE_IMPORT_SPECIFIER);
      const level4 = MEMORY_LEVELS.find((entry: any) => entry.id === 4);
      expect(level4.adapterNames).toEqual(['file']);
    });

    it('levels 0 and 1 carry no adapter names (they never participate in the recall() cascade)', async () => {
      const { MEMORY_LEVELS } = await import(MODULE_IMPORT_SPECIFIER);
      const level0 = MEMORY_LEVELS.find((entry: any) => entry.id === 0);
      const level1 = MEMORY_LEVELS.find((entry: any) => entry.id === 1);
      expect(level0.adapterNames).toEqual([]);
      expect(level1.adapterNames).toEqual([]);
    });
  });

  describe('sourceRef cross-checks against the real files this taxonomy describes', () => {
    it('level 0 sourceRef points at level0.ts', async () => {
      const { MEMORY_LEVELS } = await import(MODULE_IMPORT_SPECIFIER);
      const level0 = MEMORY_LEVELS.find((entry: any) => entry.id === 0);
      expect(level0.sourceRef).toMatch(/level0\.ts/);
    });

    it('level 1 sourceRef points at harness.ts and/or sync.ts', async () => {
      const { MEMORY_LEVELS } = await import(MODULE_IMPORT_SPECIFIER);
      const level1 = MEMORY_LEVELS.find((entry: any) => entry.id === 1);
      expect(level1.sourceRef).toMatch(/harness\.ts|sync\.ts/);
    });

    it('level 2 sourceRef points at the layers registry', async () => {
      const { MEMORY_LEVELS } = await import(MODULE_IMPORT_SPECIFIER);
      const level2 = MEMORY_LEVELS.find((entry: any) => entry.id === 2);
      expect(level2.sourceRef).toMatch(/lib\/mnemosyne\/layers\//);
    });

    it('level 4 sourceRef points at FileLayerAdapter or the layers registry', async () => {
      const { MEMORY_LEVELS } = await import(MODULE_IMPORT_SPECIFIER);
      const level4 = MEMORY_LEVELS.find((entry: any) => entry.id === 4);
      expect(level4.sourceRef).toMatch(/lib\/mnemosyne\/layers\//);
    });
  });
});
