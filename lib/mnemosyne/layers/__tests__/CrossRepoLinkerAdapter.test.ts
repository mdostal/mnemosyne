import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CrossRepoLinkerAdapter } from '../CrossRepoLinkerAdapter.js';

// --- fixture repos ----------------------------------------------------------
//
// Reproduces the STRUCTURAL shape of the real, validated finding this story
// is built on (see .pHive/epics/mnemosyne-crossrepo-defaults/epic.yaml and
// cr-02's story yaml): mdostal/personal-site defines a Sanity 'tool' document
// type in sanity/schemas/tool.ts; mdostal/mdostal-tools-hub queries it via a
// GROQ template string (`_type == "tool"`) in src/lib/sanity.ts. Graphify's
// AST-based cross-repo merge finds zero edges for this pairing (confirmed
// real, 3-for-3 across repo pairs) because there is no import/package tie —
// only a shared external Sanity project. These fixtures are small, synthetic,
// hermetic temp directories — never a clone of the real repos.

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeTempRepo(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `mnemosyne-crossref-${prefix}-`));
  tempRoots.push(root);
  return root;
}

/** The schema-definer repo (shape of personal-site/sanity/schemas/tool.ts). */
async function makeDefinerRepo(): Promise<string> {
  const root = await makeTempRepo('definer');
  await mkdir(path.join(root, 'sanity', 'schemas'), { recursive: true });
  await writeFile(
    path.join(root, 'sanity', 'schemas', 'tool.ts'),
    [
      'export default {',
      "  name: 'tool',",
      "  title: 'Tool',",
      "  type: 'document',",
      '  fields: [',
      "    { name: 'title', type: 'string' },",
      "    { name: 'url', type: 'url' },",
      '  ],',
      '};',
      '',
    ].join('\n'),
    'utf8',
  );
  return root;
}

/** The consumer repo (shape of mdostal-tools-hub/src/lib/sanity.ts). */
async function makeConsumerRepo(): Promise<string> {
  const root = await makeTempRepo('consumer');
  await mkdir(path.join(root, 'src', 'lib'), { recursive: true });
  await writeFile(
    path.join(root, 'src', 'lib', 'sanity.ts'),
    [
      'export const allToolsQuery = `*[_type == "tool" && hidden != true] | order(title asc)`;',
      '',
      'export async function getTools(client: SanityClient) {',
      '  return client.fetch(allToolsQuery);',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  return root;
}

/** A repo whose schema/usage share no identifiers with definer/consumer -- negative control. */
async function makeUnrelatedRepo(): Promise<string> {
  const root = await makeTempRepo('unrelated');
  await mkdir(path.join(root, 'sanity', 'schemas'), { recursive: true });
  await writeFile(
    path.join(root, 'sanity', 'schemas', 'gadget.ts'),
    [
      'export default {',
      "  name: 'gadget',",
      "  title: 'Gadget',",
      "  type: 'document',",
      '  fields: [],',
      '};',
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    path.join(root, 'sanity', 'schemas', 'query.ts'),
    ['export const gadgetQuery = `*[_type == "gadget"]`;', ''].join('\n'),
    'utf8',
  );
  return root;
}

describe('CrossRepoLinkerAdapter', () => {
  describe('construction — loud failure', () => {
    it('throws when repos is missing/empty (never a silent empty layer)', () => {
      expect(() => new CrossRepoLinkerAdapter({ repos: [] } as never)).toThrow(/repos/i);
      expect(() => new CrossRepoLinkerAdapter({} as never)).toThrow(/repos/i);
    });

    it('throws when only 1 repo is configured — cross-repo linking is structurally impossible with one root', () => {
      expect(() => new CrossRepoLinkerAdapter({ repos: ['/tmp'] })).toThrow(/at least 2/i);
    });

    it('throws loudly when a configured repo path does not exist on disk', async () => {
      const real = await makeDefinerRepo();
      expect(() => new CrossRepoLinkerAdapter({ repos: [real, '/definitely/does/not/exist/xyz'] })).toThrow(
        /does not exist/i,
      );
    });

    it('throws loudly when a configured repo path exists but is not a directory', async () => {
      const real = await makeDefinerRepo();
      const filePath = path.join(real, 'not-a-dir.txt');
      await writeFile(filePath, 'hi', 'utf8');
      expect(() => new CrossRepoLinkerAdapter({ repos: [real, filePath] })).toThrow(/not a directory/i);
    });

    it('throws on an unknown scheme name', async () => {
      const a = await makeDefinerRepo();
      const b = await makeConsumerRepo();
      expect(() => new CrossRepoLinkerAdapter({ repos: [a, b], schemes: ['nonexistent-scheme'] })).toThrow(
        /unknown scheme/i,
      );
    });

    it('constructs cleanly with 2+ real repo paths and the default "sanity" scheme', async () => {
      const a = await makeDefinerRepo();
      const b = await makeConsumerRepo();
      expect(() => new CrossRepoLinkerAdapter({ repos: [a, b] })).not.toThrow();
    });
  });

  it('registers under the "crossref-linker" layer name', async () => {
    const a = await makeDefinerRepo();
    const b = await makeConsumerRepo();
    const adapter = new CrossRepoLinkerAdapter({ repos: [a, b] });
    expect(adapter.layer).toBe('crossref-linker');
  });

  describe('recall() — the real validated case (Sanity tool type)', () => {
    it('finds the definer->consumer cross-repo link with real file:line provenance on both sides', async () => {
      const definerRoot = await makeDefinerRepo();
      const consumerRoot = await makeConsumerRepo();
      const adapter = new CrossRepoLinkerAdapter({
        repos: [
          { path: definerRoot, name: 'personal-site' },
          { path: consumerRoot, name: 'mdostal-tools-hub' },
        ],
      });

      const result = await adapter.recall('tool');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const defHit = result.hits.find((h) => h.content.includes('Definition'));
      const usageHit = result.hits.find((h) => h.content.toLowerCase().includes('cross-repo usage'));

      expect(defHit).toBeDefined();
      expect(defHit!.provenance.source).toBe(
        `${path.join(definerRoot, 'sanity', 'schemas', 'tool.ts')}:2`,
      );
      expect(defHit!.content).toContain('personal-site');

      expect(usageHit).toBeDefined();
      expect(usageHit!.provenance.source).toBe(`${path.join(consumerRoot, 'src', 'lib', 'sanity.ts')}:1`);
      expect(usageHit!.content).toContain('mdostal-tools-hub');
      expect(usageHit!.content).toContain('personal-site');
    });

    it('detects the "_type in [...]" GROQ list form, not just equality', async () => {
      const definerRoot = await makeDefinerRepo();
      const consumerRoot = await makeConsumerRepo();
      await writeFile(
        path.join(consumerRoot, 'src', 'lib', 'featured.ts'),
        ['export const featuredQuery = `*[_type in ["tool", "project"]]`;', ''].join('\n'),
        'utf8',
      );

      const adapter = new CrossRepoLinkerAdapter({ repos: [definerRoot, consumerRoot] });
      const result = await adapter.recall('tool');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const crossRepoHits = result.hits.filter((h) => h.content.toLowerCase().includes('cross-repo usage'));
      expect(crossRepoHits.some((h) => h.provenance.source.includes('featured.ts'))).toBe(true);
    });
  });

  describe('recall() — no false positives', () => {
    it('an identifier used only WITHIN one repo is reported as NOT cross-repo', async () => {
      const definerRoot = await makeDefinerRepo();
      const consumerRoot = await makeConsumerRepo();
      const unrelatedRoot = await makeUnrelatedRepo();

      const adapter = new CrossRepoLinkerAdapter({ repos: [definerRoot, consumerRoot, unrelatedRoot] });
      const result = await adapter.recall('gadget');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.hits.length).toBeGreaterThan(0);
      // 'gadget' is defined AND queried only inside unrelatedRoot -- must
      // never be framed as a cross-repo usage.
      expect(result.hits.some((h) => h.content.toLowerCase().includes('cross-repo usage'))).toBe(false);
      expect(result.hits.some((h) => h.content.toLowerCase().includes('same-repo'))).toBe(true);
    });

    it('the unrelated repo never appears in "tool" results (definer/consumer link is exact, no bleed-through)', async () => {
      const definerRoot = await makeDefinerRepo();
      const consumerRoot = await makeConsumerRepo();
      const unrelatedRoot = await makeUnrelatedRepo();

      const adapter = new CrossRepoLinkerAdapter({ repos: [definerRoot, consumerRoot, unrelatedRoot] });
      const result = await adapter.recall('tool');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.hits.some((h) => h.provenance.source.includes(unrelatedRoot))).toBe(false);
    });

    it('returns an ok success with zero hits (not a failure) for a query matching nothing', async () => {
      const a = await makeDefinerRepo();
      const b = await makeConsumerRepo();
      const adapter = new CrossRepoLinkerAdapter({ repos: [a, b] });
      const result = await adapter.recall('does-not-exist-anywhere-xyz');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.hits).toEqual([]);
    });
  });

  describe('recall() — basic contract', () => {
    it('fails loudly (RecallFailure) on an empty query, matching every other layer', async () => {
      const a = await makeDefinerRepo();
      const b = await makeConsumerRepo();
      const adapter = new CrossRepoLinkerAdapter({ repos: [a, b] });
      const result = await adapter.recall('   ');
      expect(result.ok).toBe(false);
    });

    it('reports layers_queried: ["crossref-linker"] on success', async () => {
      const a = await makeDefinerRepo();
      const b = await makeConsumerRepo();
      const adapter = new CrossRepoLinkerAdapter({ repos: [a, b] });
      const result = await adapter.recall('tool');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.layers_queried).toEqual(['crossref-linker']);
    });
  });
});
