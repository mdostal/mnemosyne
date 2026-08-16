import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileLayerAdapter } from '../FileLayerAdapter.js';
import {
  buildFileStoreIndex,
  FILE_INDEX_RELATIVE_PATH,
  writeFileStoreIndex,
} from '../FileStoreIndex.js';

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
