import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFileStoreIndex } from '../FileStoreIndex.js';
import { FileLayerAdapter, isIndexEntryStale } from '../FileLayerAdapter.js';

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mnemosyne-file-layer-'));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await chmod(root, 0o700).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe('FileLayerAdapter', () => {
  it('returns matching lines with file path and line number provenance', async () => {
    const root = await makeTempRoot();
    const filePath = path.join(root, 'notes.md');
    await writeFile(filePath, ['alpha', 'target line', 'omega target'].join('\n'), 'utf8');

    const adapter = new FileLayerAdapter(root);
    const result = await adapter.recall('target');

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    expect(result).toMatchObject({
      query: 'target',
      scope: 'project',
      intent: 'narrow',
      layers_queried: ['file'],
      layers_skipped: [],
      escalated: false,
      degraded: false,
    });
    expect(result.hits).toHaveLength(2);
    expect(result.hits.map((hit) => hit.content)).toEqual(['target line', 'omega target']);
    expect(result.hits[0]?.provenance).toMatchObject({
      layer: 'file',
      source: filePath,
      chunk_span: { index: 2 },
    });
    expect(result.hits[1]?.provenance.chunk_span).toEqual({ index: 3 });
  });

  it('sets file-layer null provenance fields and retrieval_time', async () => {
    const root = await makeTempRoot();
    await writeFile(path.join(root, 'source.ts'), 'const needle = true;\n', 'utf8');

    const adapter = new FileLayerAdapter(root);
    const result = await adapter.recall('needle', { scope: 'enterprise', intent: 'broad' });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const provenance = result.hits[0]?.provenance;
    expect(provenance).toBeDefined();
    expect(provenance?.index_timestamp).toBeNull();
    expect(provenance?.embedder).toBeNull();
    expect(provenance?.retrieval_time).toEqual(expect.any(String));
    expect(new Date(provenance?.retrieval_time ?? '').toString()).not.toBe('Invalid Date');
  });

  it('computes content_hash as the sha256 of the matching line', async () => {
    const root = await makeTempRoot();
    const line = 'hash this exact line';
    await writeFile(path.join(root, 'hash.md'), `${line}\n`, 'utf8');

    const adapter = new FileLayerAdapter(root);
    const result = await adapter.recall('exact');

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    expect(result.hits[0]?.provenance.content_hash).toBe(
      createHash('sha256').update(line).digest('hex'),
    );
  });

  it('returns RecallFailure for an unreachable directory', async () => {
    const missingRoot = path.join(tmpdir(), `mnemosyne-missing-${Date.now()}`);
    const adapter = new FileLayerAdapter(missingRoot);

    const result = await adapter.recall('needle');

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected recall to fail');
    }

    expect(result.error).toMatchObject({
      layer: 'file',
      code: 'ENOENT',
    });
    expect(result.error.message).toContain('unreachable');
  });

  it('returns RecallFailure instead of empty hits when traversal is denied', async () => {
    const root = await makeTempRoot();
    await chmod(root, 0o000);
    const adapter = new FileLayerAdapter(root);

    const result = await adapter.recall('needle');

    await chmod(root, 0o700);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected recall to fail');
    }

    expect(result.error.layer).toBe('file');
    expect(result.error.code).toMatch(/EACCES|EPERM/);
  });
});

// ---------------------------------------------------------------------------
// ml-07-file-store-index-query: area-scoped narrowing + staleness handling +
// full-walk fallback, wired directly into FileLayerAdapter.recall() (see the
// design-decision comment block right above this describe for the "extend
// vs. sibling adapter" reasoning).
//
// Wiring shape chosen: EXTEND FileLayerAdapter.recall() directly, gated
// strictly behind `options.area !== undefined`. A sibling/wrapper adapter
// was considered and rejected: it would have to either re-implement
// FileLayerAdapter's validation (empty-query check, root-is-directory
// check, error-code mapping) and RecallResult assembly a second time, or
// delegate to a real FileLayerAdapter instance for the fallback path and
// trust that delegation to be truly transparent -- an extra seam where the
// existing, already-tested contract could silently drift. Extending
// directly means the "no `area` requested" branch is LITERALLY the original
// code (see `resolveFileSource`'s `area === undefined` branch: zero extra
// filesystem calls, no manifest read attempted), so byte-for-byte
// preservation of pre-ml-07 behavior is provable by code inspection, not
// just by hoping a wrapper's delegation is complete -- and is directly
// proven below by rerunning the EXISTING suite's exact scenarios with a
// real index present alongside.
// ---------------------------------------------------------------------------
describe('FileLayerAdapter — ml-07 area-scoped index narrowing', () => {
  const fixtureRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      fixtureRoots.splice(0).map(async (root) => {
        await chmod(root, 0o700).catch(() => undefined);
        await rm(root, { recursive: true, force: true });
      }),
    );
  });

  async function makeRoot(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), 'mnemosyne-file-layer-ml07-'));
    fixtureRoots.push(root);
    return root;
  }

  async function writeFixtureFile(root: string, relativePath: string, content: string): Promise<string> {
    const filePath = path.join(root, ...relativePath.split('/'));
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, 'utf8');
    return filePath;
  }

  /**
   * Populates a fixture tree spanning several distinct areas, including the
   * two trickiest area-truncation cases: a 2-segment area with a file
   * nested MORE than one level deep (`docs/guides/nested/deep/b.md`, still
   * area `docs/guides`), and a 1-segment area with a nested subdirectory
   * that must NOT be swept in (`lib/nested/sub.ts` is area `lib/nested`,
   * never returned for an area=`lib` query).
   */
  async function buildFixtureTree(root: string): Promise<Record<string, string>> {
    const paths: Record<string, string> = {};
    paths['docs/guides/a.md'] = await writeFixtureFile(root, 'docs/guides/a.md', 'alpha needle one\n');
    paths['docs/guides/nested/deep/b.md'] = await writeFixtureFile(
      root,
      'docs/guides/nested/deep/b.md',
      'beta needle two\n',
    );
    paths['docs/other/c.md'] = await writeFixtureFile(root, 'docs/other/c.md', 'gamma needle three\n');
    paths['docs/direct.md'] = await writeFixtureFile(root, 'docs/direct.md', 'delta needle four\n');
    paths['lib/direct.ts'] = await writeFixtureFile(root, 'lib/direct.ts', 'epsilon needle five\n');
    paths['lib/nested/sub.ts'] = await writeFixtureFile(root, 'lib/nested/sub.ts', 'zeta needle six\n');
    paths['root.md'] = await writeFixtureFile(root, 'root.md', 'eta needle seven\n');
    paths['other/unrelated.txt'] = await writeFixtureFile(root, 'other/unrelated.txt', 'theta needle eight\n');
    return paths;
  }

  function sortedSourceContentPairs(hits: { content: string; provenance: { source: string } }[]) {
    return hits
      .map((hit) => `${hit.provenance.source} ${hit.content}`)
      .sort((a, b) => a.localeCompare(b));
  }

  // --- Acceptance criterion #1: area-scoped narrowing touches fewer files
  // than a full walk of the whole target directory. -------------------------
  it('scans strictly fewer files for an area-scoped query than a full walk of the whole tree', async () => {
    const root = await makeRoot();
    await buildFixtureTree(root);
    await writeFileStoreIndex(root);

    const adapter = new FileLayerAdapter(root);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scanSpy = vi.spyOn(adapter as any, 'scanFile');

    const full = await adapter.recall('needle');
    expect(full.ok).toBe(true);
    const fullFileCount = scanSpy.mock.calls.length;
    scanSpy.mockClear();

    const scoped = await adapter.recall('needle', { area: 'docs/guides' });
    expect(scoped.ok).toBe(true);
    const scopedFileCount = scanSpy.mock.calls.length;

    // Whole tree has 8 fixture files; `.mnemosyne/` (the index/manifest
    // storage directory itself) is excluded from every walk as of
    // ml-08-file-store-index-rebuild (DEFAULT_IGNORED_DIRECTORIES in
    // fileWalk.ts), so writing the manifest never makes it indexable
    // content. docs/guides has exactly 2.
    expect(fullFileCount).toBe(8);
    expect(scopedFileCount).toBe(2);
    expect(scopedFileCount).toBeLessThan(fullFileCount);
  });

  // --- Acceptance criterion #2: area-scoped results are IDENTICAL to a full
  // walk manually restricted to that same area -- no false negative, and no
  // false positive either, from narrowing. Covers both the 2-segment
  // (recursive) and 1-segment (direct-children-only) area-truncation rules.
  // ---------------------------------------------------------------------------
  it('produces an identical hit set to a full walk manually restricted to a 2-segment area (docs/guides)', async () => {
    const root = await makeRoot();
    const paths = await buildFixtureTree(root);
    await writeFileStoreIndex(root);

    const adapter = new FileLayerAdapter(root);
    const full = await adapter.recall('needle');
    expect(full.ok).toBe(true);
    if (!full.ok) throw new Error(full.error.message);

    const expectedSources = new Set([paths['docs/guides/a.md'], paths['docs/guides/nested/deep/b.md']]);
    const fullRestrictedToArea = full.hits.filter((hit) => expectedSources.has(hit.provenance.source));
    expect(fullRestrictedToArea).toHaveLength(2);

    const scoped = await adapter.recall('needle', { area: 'docs/guides' });
    expect(scoped.ok).toBe(true);
    if (!scoped.ok) throw new Error(scoped.error.message);

    expect(sortedSourceContentPairs(scoped.hits)).toEqual(sortedSourceContentPairs(fullRestrictedToArea));
  });

  it('produces an identical hit set to a full walk manually restricted to a 1-segment area (lib), excluding its nested subdirectory', async () => {
    const root = await makeRoot();
    const paths = await buildFixtureTree(root);
    await writeFileStoreIndex(root);

    const adapter = new FileLayerAdapter(root);
    const full = await adapter.recall('needle');
    expect(full.ok).toBe(true);
    if (!full.ok) throw new Error(full.error.message);

    // Area "lib" is ONLY lib/direct.ts -- lib/nested/sub.ts is its own,
    // more specific area ("lib/nested") and must be excluded.
    const expectedSources = new Set([paths['lib/direct.ts']]);
    const fullRestrictedToArea = full.hits.filter((hit) => expectedSources.has(hit.provenance.source));
    expect(fullRestrictedToArea).toHaveLength(1);

    const scoped = await adapter.recall('needle', { area: 'lib' });
    expect(scoped.ok).toBe(true);
    if (!scoped.ok) throw new Error(scoped.error.message);

    expect(sortedSourceContentPairs(scoped.hits)).toEqual(sortedSourceContentPairs(fullRestrictedToArea));
    expect(scoped.hits.some((hit) => hit.provenance.source === paths['lib/nested/sub.ts'])).toBe(false);
  });

  it('produces an identical (empty, since no fixture file is at true root) hit set for the root area ("")', async () => {
    const root = await makeRoot();
    const paths = await buildFixtureTree(root);
    await writeFileStoreIndex(root);

    const adapter = new FileLayerAdapter(root);
    const scoped = await adapter.recall('needle', { area: '' });
    expect(scoped.ok).toBe(true);
    if (!scoped.ok) throw new Error(scoped.error.message);

    // root.md is the only true root-level fixture file.
    expect(scoped.hits.map((hit) => hit.provenance.source)).toEqual([paths['root.md']]);
  });

  // --- Acceptance criterion #3: no index present -> byte-for-byte identical
  // to pre-ml-07 behavior, even when the caller passes `area`. ---------------
  it('falls back to identical full-walk behavior when no index has been built, even if `area` is requested', async () => {
    const root = await makeRoot();
    await buildFixtureTree(root);
    // Deliberately no writeFileStoreIndex() call: no .mnemosyne/file-index.json exists.

    const adapter = new FileLayerAdapter(root);
    const withoutArea = await adapter.recall('needle');
    const withArea = await adapter.recall('needle', { area: 'docs/guides' });

    expect(withoutArea.ok).toBe(true);
    expect(withArea.ok).toBe(true);
    if (!withoutArea.ok || !withArea.ok) throw new Error('expected both recalls to succeed');

    // Same 8 hits either way -- an unrecognized/unindexed `area` never
    // narrows anything; it's a no-op fallback to the full walk.
    expect(withArea.hits).toHaveLength(8);
    expect(sortedSourceContentPairs(withArea.hits)).toEqual(sortedSourceContentPairs(withoutArea.hits));
  });

  it('reruns the existing suite\'s exact no-`area` scenario unaffected by a real index existing alongside it', async () => {
    const root = await makeRoot();
    const filePath = path.join(root, 'notes.md');
    await writeFile(filePath, ['alpha', 'target line', 'omega target'].join('\n'), 'utf8');
    await writeFileStoreIndex(root);

    const adapter = new FileLayerAdapter(root);
    const result = await adapter.recall('target');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);

    expect(result).toMatchObject({
      query: 'target',
      scope: 'project',
      intent: 'narrow',
      layers_queried: ['file'],
      layers_skipped: [],
      escalated: false,
      degraded: false,
    });
    expect(result.hits).toHaveLength(2);
    expect(result.hits.map((hit) => hit.content)).toEqual(['target line', 'omega target']);
  });

  // --- Acceptance criterion #5: an unknown area (not in the manifest) also
  // falls back to the full walk, never a silently narrower result. ----------
  it('falls back to a full walk when `area` does not match any known area in the manifest', async () => {
    const root = await makeRoot();
    await buildFixtureTree(root);
    await writeFileStoreIndex(root);

    const adapter = new FileLayerAdapter(root);
    const withoutArea = await adapter.recall('needle');
    const withUnknownArea = await adapter.recall('needle', { area: 'totally/unknown/area' });

    expect(withoutArea.ok).toBe(true);
    expect(withUnknownArea.ok).toBe(true);
    if (!withoutArea.ok || !withUnknownArea.ok) throw new Error('expected both recalls to succeed');

    expect(withUnknownArea.hits).toHaveLength(8);
    expect(sortedSourceContentPairs(withUnknownArea.hits)).toEqual(sortedSourceContentPairs(withoutArea.hits));
  });

  // --- Acceptance criterion #4: staleness -- a file modified after indexing
  // is served fresh, never as silently-stale cached content. ----------------
  it('serves a modified file\'s CURRENT content, never the stale content recorded at index time', async () => {
    const root = await makeRoot();
    const filePath = await writeFixtureFile(root, 'docs/guides/a.md', 'line with STALE_TOKEN inside\n');
    const { manifest } = await writeFileStoreIndex(root);

    const indexedEntry = manifest.files.find((entry) => entry.path === 'docs/guides/a.md');
    expect(indexedEntry).toBeDefined();

    // Stage the deliberate staleness scenario: modify the fixture file AFTER
    // the index was built, changing its content (and therefore its sha256)
    // so the manifest's recorded hash no longer matches reality.
    await writeFile(filePath, 'line with FRESH_TOKEN inside\n', 'utf8');

    // Confirm the staleness precondition is genuinely staged, not accidental.
    expect(isIndexEntryStale(indexedEntry!, 'line with FRESH_TOKEN inside\n')).toBe(true);
    expect(isIndexEntryStale(indexedEntry!, 'line with STALE_TOKEN inside\n')).toBe(false);

    const adapter = new FileLayerAdapter(root);

    const freshQuery = await adapter.recall('FRESH_TOKEN', { area: 'docs/guides' });
    expect(freshQuery.ok).toBe(true);
    if (!freshQuery.ok) throw new Error(freshQuery.error.message);
    expect(freshQuery.hits).toHaveLength(1);
    expect(freshQuery.hits[0]?.content).toBe('line with FRESH_TOKEN inside');

    // The old, index-time content must never be silently served as current.
    const staleQuery = await adapter.recall('STALE_TOKEN', { area: 'docs/guides' });
    expect(staleQuery.ok).toBe(true);
    if (!staleQuery.ok) throw new Error(staleQuery.error.message);
    expect(staleQuery.hits).toHaveLength(0);
  });

  it('isIndexEntryStale correctly distinguishes matching vs. mismatched content against a manifest entry', async () => {
    const root = await makeRoot();
    await writeFixtureFile(root, 'notes/x.md', 'original content\n');
    const { manifest } = await writeFileStoreIndex(root);
    const entry = manifest.files.find((file) => file.path === 'notes/x.md');
    expect(entry).toBeDefined();

    expect(isIndexEntryStale(entry!, 'original content\n')).toBe(false);
    expect(isIndexEntryStale(entry!, 'changed content\n')).toBe(true);
  });

  // --- Adversarial: the single most dangerous false-negative case -- a file
  // ADDED to an indexed area after the index was built (so it appears in NO
  // manifest list at all) must still be found by an area-scoped query. A
  // design that trusted the manifest's file list as its candidate set
  // (rather than doing a real live directory read) would silently MISS this.
  // ---------------------------------------------------------------------------
  it('adversarial: finds a file added to an indexed area AFTER the index was built (no false negative from a stale manifest snapshot)', async () => {
    const root = await makeRoot();
    await writeFixtureFile(root, 'docs/guides/a.md', 'alpha needle one\n');
    await writeFileStoreIndex(root);

    // Added after indexing -- absent from the manifest's docs/guides area list.
    const newFilePath = await writeFixtureFile(root, 'docs/guides/new-file.md', 'contains NEWFILE_TOKEN_UNIQUE\n');

    const adapter = new FileLayerAdapter(root);
    const result = await adapter.recall('NEWFILE_TOKEN_UNIQUE', { area: 'docs/guides' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.provenance.source).toBe(newFilePath);
  });

  // --- Adversarial: a file recorded in the manifest but deleted from disk
  // since must not crash the query and must not appear as a phantom hit. ----
  it('adversarial: a file deleted after indexing is simply absent from results, no crash, no phantom hit', async () => {
    const root = await makeRoot();
    const keepPath = await writeFixtureFile(root, 'docs/guides/keep.md', 'needle stays\n');
    const removePath = await writeFixtureFile(root, 'docs/guides/remove.md', 'needle goes\n');
    await writeFileStoreIndex(root);

    await unlink(removePath);

    const adapter = new FileLayerAdapter(root);
    const result = await adapter.recall('needle', { area: 'docs/guides' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.provenance.source).toBe(keepPath);
  });

  // --- Adversarial: the entire area directory removed after indexing yields
  // an empty (not a crashing, not a full-walk-leaking) result -- exactly what
  // a full walk restricted to a now-nonexistent area would also find. -------
  it('adversarial: an entire area directory removed after indexing returns empty hits, not a crash', async () => {
    const root = await makeRoot();
    await writeFixtureFile(root, 'docs/other/c.md', 'needle here\n');
    await writeFileStoreIndex(root);

    await rm(path.join(root, 'docs', 'other'), { recursive: true, force: true });

    const adapter = new FileLayerAdapter(root);
    const result = await adapter.recall('needle', { area: 'docs/other' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.hits).toHaveLength(0);
  });

  // --- Acceptance criterion #6: RecallResult contract (shape + semantics)
  // is preserved exactly for the area-scoped path too, not just the
  // unscoped one. -------------------------------------------------------------
  it('preserves the exact RecallResult contract shape for an area-scoped query', async () => {
    const root = await makeRoot();
    await buildFixtureTree(root);
    await writeFileStoreIndex(root);

    const adapter = new FileLayerAdapter(root);
    const result = await adapter.recall('needle', { area: 'docs/guides', scope: 'enterprise', intent: 'broad' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);

    expect(result).toMatchObject({
      query: 'needle',
      scope: 'enterprise',
      intent: 'broad',
      layers_queried: ['file'],
      layers_skipped: [],
      escalated: false,
      degraded: false,
    });
    for (const hit of result.hits) {
      expect(hit.provenance).toEqual({
        layer: 'file',
        source: expect.any(String),
        chunk_span: { index: expect.any(Number) },
        index_timestamp: null,
        content_hash: expect.any(String),
        embedder: null,
        retrieval_time: expect.any(String),
      });
    }
  });
});
