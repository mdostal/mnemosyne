import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileLayerAdapter, isIndexEntryStale } from '../FileLayerAdapter.js';
import {
  buildFileStoreIndex,
  FILE_INDEX_RELATIVE_PATH,
  type FileStoreIndexManifest,
  writeFileStoreIndex,
} from '../FileStoreIndex.js';

// bin/mnemosyne-file-index.mjs is the ml-08 CLI verb under test here, reused
// directly (its exported `run()` is the exact function the CLI's own
// direct-run guard invokes) rather than re-implemented against
// writeFileStoreIndex a second time.
//
// TS ambient module declarations don't apply to relative (`./`/`../`)
// specifiers -- TS always attempts real file resolution for those and never
// consults an ambient `declare module` for them -- so bin/'s plain-JS,
// declaration-file-less .mjs unavoidably surfaces one TS7016 on the import
// line itself. Suppressed there only (mirrors sync.integration.test.ts's
// identical `bin/mnemosyne-persona.mjs` import); the re-typed const below
// keeps every actual USE of runFileIndexCli in this file properly
// type-checked.
interface FileIndexCliResult {
  ok: boolean;
  manifest: FileStoreIndexManifest;
  root: string;
  manifestPath: string;
  generatedAt: string;
  files: number;
  areas: number;
}
type FileIndexCliRunFn = (
  argv: string[],
  options?: { log?: (message: string) => void; warn?: (message: string) => void; cwd?: string },
) => Promise<FileIndexCliResult>;
// @ts-expect-error -- bin/mnemosyne-file-index.mjs is plain JS with no .d.ts; see doc comment above.
import { run as runFileIndexCliUntyped } from '../../../../bin/mnemosyne-file-index.mjs';
const runFileIndexCli: FileIndexCliRunFn = runFileIndexCliUntyped;

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mnemosyne-file-store-index-'));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Real markdown content with real `#`/`##` headings at known 1-based line numbers. */
const GUIDE_MD_LINES = [
  '# Guide Title', // line 1
  '', // line 2
  'Intro paragraph.', // line 3
  '', // line 4
  '## Setup', // line 5
  'Setup content.', // line 6
  '', // line 7
  '## Usage', // line 8
  'Usage content line.', // line 9
];
const GUIDE_MD = GUIDE_MD_LINES.join('\n');

const DEEP_MD_LINES = [
  '# Deep Doc', // line 1
  '## Nested Heading', // line 2
  'Body text.', // line 3
];
const DEEP_MD = DEEP_MD_LINES.join('\n');

async function buildNestedFixture(root: string): Promise<void> {
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await mkdir(path.join(root, 'docs', 'nested', 'extra'), { recursive: true });
  await mkdir(path.join(root, 'src'), { recursive: true });

  await writeFile(path.join(root, 'docs', 'guide.md'), GUIDE_MD, 'utf8');
  await writeFile(path.join(root, 'docs', 'nested', 'extra', 'deep.md'), DEEP_MD, 'utf8');
  await writeFile(path.join(root, 'src', 'index.ts'), 'export const x = 1;\n', 'utf8');
  await writeFile(path.join(root, 'root-notes.md'), '# Root Notes\n', 'utf8');
}

describe('FileStoreIndex — build (ml-06)', () => {
  it('records directory-based area (top-level + one nested level) for each file', async () => {
    const root = await makeTempRoot();
    await buildNestedFixture(root);

    const manifest = await buildFileStoreIndex(root);
    const byPath = new Map(manifest.files.map((entry) => [entry.path, entry]));

    expect(byPath.get('docs/guide.md')?.area).toBe('docs');
    // Three levels deep (docs/nested/extra) collapses to the top-level +
    // one-nested-level area convention, not a third level.
    expect(byPath.get('docs/nested/extra/deep.md')?.area).toBe('docs/nested');
    expect(byPath.get('src/index.ts')?.area).toBe('src');
    expect(byPath.get('root-notes.md')?.area).toBe('');

    // areas map is keyed by area, listing member relative paths.
    expect(manifest.areas['docs']).toEqual(['docs/guide.md']);
    expect(manifest.areas['docs/nested']).toEqual(['docs/nested/extra/deep.md']);
    expect(manifest.areas['src']).toEqual(['src/index.ts']);
    expect(manifest.areas['']).toEqual(['root-notes.md']);
  });

  it('records real markdown heading text + line number as sub-areas', async () => {
    const root = await makeTempRoot();
    await buildNestedFixture(root);

    const manifest = await buildFileStoreIndex(root);
    const guide = manifest.files.find((entry) => entry.path === 'docs/guide.md');
    expect(guide).toBeDefined();

    expect(guide?.headings).toEqual([
      { level: 1, text: 'Guide Title', line: 1 },
      { level: 2, text: 'Setup', line: 5 },
      { level: 2, text: 'Usage', line: 8 },
    ]);

    // non-markdown files carry no headings.
    const src = manifest.files.find((entry) => entry.path === 'src/index.ts');
    expect(src?.headings).toEqual([]);
  });

  it('independently verifies recorded heading/line-number data against the real fixture file content', async () => {
    // Mirrors la-03-graphify-doc-index's own verification discipline: read
    // the real fixture file after indexing and confirm the recorded line
    // number's content matches the recorded heading text, not just assert
    // a value was written.
    const root = await makeTempRoot();
    await buildNestedFixture(root);

    const manifest = await buildFileStoreIndex(root);
    const guide = manifest.files.find((entry) => entry.path === 'docs/guide.md');
    expect(guide).toBeDefined();

    const realContent = await readFile(path.join(root, 'docs', 'guide.md'), 'utf8');
    const realLines = realContent.split(/\r?\n/);

    for (const heading of guide?.headings ?? []) {
      const realLine = realLines[heading.line - 1];
      expect(realLine).toBeDefined();
      const expectedText = (realLine ?? '').replace(/^#{1,2}\s+/, '').trim();
      expect(heading.text).toBe(expectedText);
    }

    // Concrete, hand-checkable assertions against the known fixture too.
    expect(realLines[4]).toBe('## Setup');
    expect(realLines[7]).toBe('## Usage');
  });

  it('carries a sha256 content hash computed via the same sha256() helper FileLayerAdapter uses', async () => {
    const root = await makeTempRoot();
    await buildNestedFixture(root);

    const manifest = await buildFileStoreIndex(root);
    const guide = manifest.files.find((entry) => entry.path === 'docs/guide.md');
    expect(guide).toBeDefined();

    const expectedHash = createHash('sha256').update(GUIDE_MD).digest('hex');
    expect(guide?.sha256).toBe(expectedHash);

    const indexTs = manifest.files.find((entry) => entry.path === 'src/index.ts');
    const expectedTsHash = createHash('sha256')
      .update('export const x = 1;\n')
      .digest('hex');
    expect(indexTs?.sha256).toBe(expectedTsHash);
  });

  it('applies identical ignored-directory rules to FileLayerAdapter\'s own real walk', async () => {
    const root = await makeTempRoot();
    await buildNestedFixture(root);

    const marker = 'PARITY_MARKER';
    await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    await mkdir(path.join(root, '.git'), { recursive: true });
    await mkdir(path.join(root, 'dist'), { recursive: true });
    await mkdir(path.join(root, 'build'), { recursive: true });
    await mkdir(path.join(root, 'coverage'), { recursive: true });
    await writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), marker, 'utf8');
    await writeFile(path.join(root, '.git', 'HEAD'), marker, 'utf8');
    await writeFile(path.join(root, 'dist', 'bundle.js'), marker, 'utf8');
    await writeFile(path.join(root, 'build', 'output.js'), marker, 'utf8');
    await writeFile(path.join(root, 'coverage', 'report.html'), marker, 'utf8');
    // Also stamp the marker into a real, non-ignored file so FileLayerAdapter
    // has at least one true hit to compare against.
    await writeFile(path.join(root, 'src', 'marked.ts'), marker, 'utf8');

    const adapter = new FileLayerAdapter(root);
    const recallResult = await adapter.recall(marker);
    expect(recallResult.ok).toBe(true);
    if (!recallResult.ok) {
      throw new Error(recallResult.error.message);
    }
    const adapterSources = new Set(recallResult.hits.map((hit) => hit.provenance.source));

    const manifest = await buildFileStoreIndex(root);
    const manifestPaths = new Set(manifest.files.map((entry) => entry.absolutePath));

    // FileLayerAdapter's own real walk found exactly one marker-bearing file
    // (the non-ignored one); confirm the index's file set doesn't include
    // any of the ignored-directory files either.
    expect(adapterSources).toEqual(new Set([path.join(root, 'src', 'marked.ts')]));
    for (const ignoredFile of [
      path.join(root, 'node_modules', 'pkg', 'index.js'),
      path.join(root, '.git', 'HEAD'),
      path.join(root, 'dist', 'bundle.js'),
      path.join(root, 'build', 'output.js'),
      path.join(root, 'coverage', 'report.html'),
    ]) {
      expect(manifestPaths.has(ignoredFile)).toBe(false);
    }
    // And the one real file both should see is present in both.
    expect(manifestPaths.has(path.join(root, 'src', 'marked.ts'))).toBe(true);
  });

  it('produces a valid, empty manifest (not a throw) for a non-existent target directory', async () => {
    const missingRoot = path.join(tmpdir(), `mnemosyne-file-store-index-missing-${Date.now()}`);

    const manifest = await buildFileStoreIndex(missingRoot);

    expect(manifest.files).toEqual([]);
    expect(manifest.areas).toEqual({});
    expect(manifest.root).toBe(path.resolve(missingRoot));
  });

  it('produces a valid, empty manifest (not a throw) for an empty target directory', async () => {
    const root = await makeTempRoot();

    const manifest = await buildFileStoreIndex(root);

    expect(manifest.files).toEqual([]);
    expect(manifest.areas).toEqual({});
  });
});

describe('FileStoreIndex — persisted manifest (ml-06)', () => {
  it('writes a human-inspectable JSON manifest at the documented, predictable path', async () => {
    const root = await makeTempRoot();
    await buildNestedFixture(root);

    const { manifest, manifestPath } = await writeFileStoreIndex(root);

    expect(manifestPath).toBe(path.join(root, '.mnemosyne', 'file-index.json'));
    expect(manifestPath).toBe(path.join(root, FILE_INDEX_RELATIVE_PATH));

    const raw = await readFile(manifestPath, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual(manifest);
    // Human-inspectable: pretty-printed, not minified/opaque.
    expect(raw).toContain('\n  ');
  });
});

// ---------------------------------------------------------------------------
// ml-08-file-store-index-rebuild: the operator-triggered CLI verb
// (bin/mnemosyne-file-index.mjs) that (re)builds the Level 4 index.
//
// Exercises the verb's exported `run()` directly (the same function the
// verb's direct-run guard invokes) against real fixtures on disk -- not a
// re-implementation of ml-06's build logic, just proof that the CLI wiring
// around `writeFileStoreIndex` behaves per the story's acceptance criteria:
// full overwrite (never merge), a stale-manifest-refreshed-by-rebuild
// scenario, and no special-cased "first build" vs. "rebuild" branching.
// ---------------------------------------------------------------------------
describe('mnemosyne-file-index CLI verb (ml-08) — rebuild', () => {
  it('fully regenerates the manifest, overwriting a deleted file\'s stale entry rather than merging it in', async () => {
    const root = await makeTempRoot();
    await buildNestedFixture(root);

    // Initial build (pre-existing, possibly-stale index the story's AC#1
    // describes).
    const { manifest: initial } = await writeFileStoreIndex(root);
    expect(initial.files.map((f) => f.path)).toContain('docs/guide.md');
    expect(initial.areas['docs']).toContain('docs/guide.md');

    // A batch of changes since that build: one indexed file removed, a new
    // one added in the same area.
    await rm(path.join(root, 'docs', 'guide.md'));
    await writeFile(path.join(root, 'docs', 'new-guide.md'), '# New Guide\n', 'utf8');

    const log = vi.fn();
    const result = await runFileIndexCli([root], { log, warn: vi.fn() });

    expect(result.ok).toBe(true);
    const rebuiltPaths = result.manifest.files.map((f: { path: string }) => f.path);

    // Overwrite, not merge: the deleted file's entry is gone entirely --
    // a merge would still carry it forward from the prior manifest.
    expect(rebuiltPaths).not.toContain('docs/guide.md');
    expect(result.manifest.areas['docs']).not.toContain('docs/guide.md');
    // The new file is present.
    expect(rebuiltPaths).toContain('docs/new-guide.md');
    expect(result.manifest.areas['docs']).toContain('docs/new-guide.md');

    // The verb's own summary output reflects the CURRENT tree, not a union
    // of old + new.
    expect(result.files).toBe(result.manifest.files.length);
    expect(log).toHaveBeenCalledTimes(1);
    const printed = JSON.parse(log.mock.calls[0]![0] as string);
    expect(printed.files).toBe(result.manifest.files.length);

    // Byte-identical (modulo the generatedAt timestamp) to what ml-06's own
    // buildFileStoreIndex produces for the tree in its now-current state --
    // proof the CLI verb didn't reimplement or diverge from the build logic.
    const directBuild = await buildFileStoreIndex(root);
    const { generatedAt: _rebuiltGeneratedAt, ...rebuiltRest } = result.manifest;
    const { generatedAt: _directGeneratedAt, ...directRest } = directBuild;
    expect(rebuiltRest).toEqual(directRest);
  });

  it('overwrites the manifest\'s persisted JSON file on disk too, not just the in-memory result', async () => {
    const root = await makeTempRoot();
    await writeFile(path.join(root, 'old.md'), '# Old\n', 'utf8');
    await writeFileStoreIndex(root);

    await rm(path.join(root, 'old.md'));
    await writeFile(path.join(root, 'fresh.md'), '# Fresh\n', 'utf8');

    await runFileIndexCli([root], { log: vi.fn(), warn: vi.fn() });

    const raw = await readFile(path.join(root, FILE_INDEX_RELATIVE_PATH), 'utf8');
    const persisted = JSON.parse(raw);
    const persistedPaths = persisted.files.map((f: { path: string }) => f.path);
    expect(persistedPaths).not.toContain('old.md');
    expect(persistedPaths).toContain('fresh.md');
  });

  // --- Staleness-resolved-after-rebuild --------------------------------------
  it('refreshes a stale manifest entry\'s recorded sha256 to match a file\'s current content after rebuild', async () => {
    const root = await makeTempRoot();
    const filePath = path.join(root, 'notes', 'x.md');
    await mkdir(path.join(root, 'notes'), { recursive: true });
    await writeFile(filePath, 'original content\n', 'utf8');

    const { manifest: before } = await writeFileStoreIndex(root);
    const beforeEntry = before.files.find((f) => f.path === 'notes/x.md');
    expect(beforeEntry).toBeDefined();
    expect(isIndexEntryStale(beforeEntry!, 'original content\n')).toBe(false);

    // Modify the file after the index was built: the persisted manifest's
    // recorded hash is now stale relative to the file's real, current content.
    await writeFile(filePath, 'modified content\n', 'utf8');
    expect(isIndexEntryStale(beforeEntry!, 'modified content\n')).toBe(true);

    const result = await runFileIndexCli([root], { log: vi.fn(), warn: vi.fn() });
    expect(result.ok).toBe(true);

    const afterEntry = result.manifest.files.find((f: { path: string }) => f.path === 'notes/x.md');
    expect(afterEntry).toBeDefined();
    // The rebuild actually refreshed the stale entry: its recorded hash now
    // matches the file's current (post-modification) content.
    expect(isIndexEntryStale(afterEntry!, 'modified content\n')).toBe(false);
    expect(afterEntry!.sha256).not.toBe(beforeEntry!.sha256);
  });

  it('a query repeated after rebuild reflects fresh content via the refreshed index directly, no full-walk fallback needed', async () => {
    const root = await makeTempRoot();
    // A multi-area fixture so a full-walk fallback is distinguishable (more
    // files scanned) from a narrow, area-scoped walk (fewer files scanned).
    await buildNestedFixture(root);
    await writeFileStoreIndex(root);

    const adapter = new FileLayerAdapter(root);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scanSpy = vi.spyOn(adapter as any, 'scanFile');

    // A batch of changes introduces a brand-new area the stale manifest has
    // never seen -- the exact "subsequent queries ... repeatedly falling
    // through file-by-file" cost the story's description calls out.
    await mkdir(path.join(root, 'newarea'), { recursive: true });
    const newFilePath = path.join(root, 'newarea', 'fresh.md');
    await writeFile(newFilePath, 'contains FRESH_REBUILD_TOKEN\n', 'utf8');

    // Before rebuild: "newarea" is unknown to the (now-stale) manifest, so
    // FileLayerAdapter's own documented fallback kicks in -- correct content,
    // but via a full walk of the whole tree, not a scoped one.
    const beforeRebuild = await adapter.recall('FRESH_REBUILD_TOKEN', { area: 'newarea' });
    expect(beforeRebuild.ok).toBe(true);
    if (!beforeRebuild.ok) throw new Error(beforeRebuild.error.message);
    expect(beforeRebuild.hits).toHaveLength(1);
    const scannedBeforeRebuild = scanSpy.mock.calls.length;
    scanSpy.mockClear();

    // Rebuild via the CLI verb.
    const rebuildResult = await runFileIndexCli([root], { log: vi.fn(), warn: vi.fn() });
    expect(rebuildResult.ok).toBe(true);
    expect(rebuildResult.manifest.areas['newarea']).toEqual(['newarea/fresh.md']);

    // Repeat the exact same query: fresh content is still found, but now via
    // the refreshed index's scoped walkArea() path directly -- strictly
    // fewer files scanned than the pre-rebuild full-walk fallback needed.
    const afterRebuild = await adapter.recall('FRESH_REBUILD_TOKEN', { area: 'newarea' });
    expect(afterRebuild.ok).toBe(true);
    if (!afterRebuild.ok) throw new Error(afterRebuild.error.message);
    expect(afterRebuild.hits).toHaveLength(1);
    expect(afterRebuild.hits[0]?.provenance.source).toBe(newFilePath);
    expect(afterRebuild.hits[0]?.content).toBe('contains FRESH_REBUILD_TOKEN');

    const scannedAfterRebuild = scanSpy.mock.calls.length;
    expect(scannedAfterRebuild).toBeLessThan(scannedBeforeRebuild);
    expect(scannedAfterRebuild).toBe(1);
  });

  // --- No special-casing for "first build" vs. "rebuild" --------------------
  it('rebuilding a target with no prior index at all behaves identically to ml-06\'s own first-time build (same code path)', async () => {
    const root = await makeTempRoot();
    await buildNestedFixture(root);
    // Deliberately no prior writeFileStoreIndex()/index file: this target
    // has never been indexed before.

    // What ml-06's own build logic produces for this exact, unindexed tree
    // (a pure read -- no side effects, doesn't itself create the manifest).
    const expected = await buildFileStoreIndex(root);

    const result = await runFileIndexCli([root], { log: vi.fn(), warn: vi.fn() });
    expect(result.ok).toBe(true);

    const { generatedAt: _expectedGeneratedAt, ...expectedRest } = expected;
    const { generatedAt: _resultGeneratedAt, ...resultRest } = result.manifest;
    expect(resultRest).toEqual(expectedRest);
  });

  it('running the verb a second time ("rebuild") produces the same shape of result as the first run ("first build") when nothing on disk changed -- no branching between the two', async () => {
    const root = await makeTempRoot();
    await buildNestedFixture(root);

    const firstRun = await runFileIndexCli([root], { log: vi.fn(), warn: vi.fn() });
    expect(firstRun.ok).toBe(true);

    const secondRun = await runFileIndexCli([root], { log: vi.fn(), warn: vi.fn() });
    expect(secondRun.ok).toBe(true);

    const { generatedAt: _firstGeneratedAt, ...firstRest } = firstRun.manifest;
    const { generatedAt: _secondGeneratedAt, ...secondRest } = secondRun.manifest;
    // Same target, same files on disk both times -> the exact same manifest
    // content (modulo the timestamp) whether or not a prior index existed --
    // there is no "first build" vs. "rebuild" special case to diverge.
    expect(secondRest).toEqual(firstRest);
  });

  it('defaults the target directory to the given cwd when no <directory> argument is passed', async () => {
    const root = await makeTempRoot();
    await writeFile(path.join(root, 'root.md'), '# Root\n', 'utf8');

    const result = await runFileIndexCli([], { log: vi.fn(), warn: vi.fn(), cwd: root });
    expect(result.ok).toBe(true);
    expect(result.manifest.root).toBe(path.resolve(root));
    expect(result.manifest.files.map((f: { path: string }) => f.path)).toContain('root.md');
  });

  it('prints a clear, parseable success summary and reports failure clearly for an unwritable manifest location', async () => {
    const root = await makeTempRoot();
    await writeFile(path.join(root, 'a.md'), '# A\n', 'utf8');

    const log = vi.fn();
    const ok = await runFileIndexCli([root], { log, warn: vi.fn() });
    expect(ok.ok).toBe(true);
    const summary = JSON.parse(log.mock.calls[0]![0] as string);
    expect(summary).toMatchObject({ ok: true, root: path.resolve(root), files: 1, areas: 1 });
    expect(typeof summary.generatedAt).toBe('string');
    expect(typeof summary.manifestPath).toBe('string');

    // An impossible manifest write location (a path through a regular file,
    // not a directory) fails clearly rather than silently or with a crash.
    const blockerFile = path.join(root, 'blocker');
    await writeFile(blockerFile, 'not a directory', 'utf8');
    const warn = vi.fn();
    const failed = await runFileIndexCli([root, '--manifest-path', path.join(blockerFile, 'file-index.json')], {
      log: vi.fn(),
      warn,
    });
    expect(failed.ok).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('mnemosyne-file-index');
  });
});
