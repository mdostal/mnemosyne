import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CrossRepoLinkerAdapter } from '../CrossRepoLinkerAdapter.js';
import type { Hit, RecallResult } from '../../interfaces.js';

// --- cr-03-crossrepo-linker-regression-tests --------------------------------
//
// cr-02's own test file (CrossRepoLinkerAdapter.test.ts) already covers the
// adapter's unit-level contract: construction failures, the basic
// definer->consumer link, the "_type in [...]" list form, same-repo-not-
// cross-repo framing, empty-query failure, etc. -- written first, per TDD,
// against a single minimal fixture pair. This file does NOT re-test any of
// that.
//
// This is a SEPARATE, higher-rigor regression layer, built against fixture
// repos that are deliberately busier/more realistic than cr-02's (multiple
// files per repo, decoy schemas/queries that share no identifiers with the
// case under test, a schema whose `fields` array precedes its `type:
// 'document'` key -- forcing the adapter's documented lazy-window regex to
// skip past several unrelated nested `type: 'string'`-shaped keys before
// finding the real one, exactly the shape the adapter's own header comment
// calls out). It exists to answer three questions cr-02's tests don't:
//
//   1. With 3 repos in play (definer, consumer, unrelated), does the linker
//      find EXACTLY the one real cross-repo link and nothing involving the
//      unrelated repo -- including the unrelated repo's OWN identifier
//      staying fully confined to itself?
//   2. The "fork" edge case the real prototype run actually surfaced:
//      mdostal/personal-site and its own fork mdostal/me-mdostal-com define
//      the IDENTICAL Sanity 'tool' schema type in both repos, but neither
//      queries the other's definition. That's a duplicate-DEFINITION case,
//      not a cross-repo USAGE case -- does the linker correctly avoid
//      reporting a false "cross-repo usage" link here?
//   3. Are results deterministic across independently-regenerated copies of
//      the same fixtures (no ordering flakiness from directory listing
//      order, Set/Map iteration, etc.)?
//
// Fixtures are hermetic mkdtemp() temp directories, never real git clones --
// see cr-03's story yaml risk/mitigation: these reproduce the STRUCTURAL
// pattern (name+type:document, _type== query), not a copy of real file
// content, so they stay durable as the real repos evolve.

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeTempRepo(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `mnemosyne-crossref-regression-${prefix}-`));
  tempRoots.push(root);
  return root;
}

/**
 * Realistic multi-field Sanity 'tool' document schema, shaped like the real
 * personal-site/sanity/schemas/tool.ts. Deliberately puts the `fields` array
 * -- itself full of nested `type: 'string'`/`type: 'url'`/etc. keys --
 * BEFORE the schema's own `type: 'document'` key, so the adapter's lazy
 * [\s\S]{0,400}? window has to skip past several non-matching `type:`
 * occurrences to find the real one. Line 2 is always `name: 'tool'`.
 */
function toolSchemaFileContent(): string {
  return [
    'export default {',
    "  name: 'tool',",
    "  title: 'Tool',",
    '  fields: [',
    "    { name: 'title', type: 'string' },",
    "    { name: 'url', type: 'url' },",
    "    { name: 'description', type: 'text' },",
    "    { name: 'category', type: 'reference', to: [{ type: 'category' }] },",
    '  ],',
    "  type: 'document',",
    '};',
    '',
  ].join('\n');
}

/** Decoy document schema sharing no identifiers with the 'tool' case -- pure noise. */
function decoySchemaFileContent(name: string): string {
  return [
    'export default {',
    `  name: '${name}',`,
    `  title: '${name[0]!.toUpperCase()}${name.slice(1)}',`,
    "  type: 'document',",
    '  fields: [],',
    '};',
    '',
  ].join('\n');
}

/** The schema-definer repo (shape of personal-site/sanity/schemas/*). */
async function buildDefinerRepo(): Promise<string> {
  const root = await makeTempRepo('definer');
  await mkdir(path.join(root, 'sanity', 'schemas'), { recursive: true });
  await writeFile(path.join(root, 'sanity', 'schemas', 'tool.ts'), toolSchemaFileContent(), 'utf8');
  // Decoy sibling schema -- never queried anywhere in these fixtures. Proves
  // its presence doesn't leak into 'tool' results.
  await writeFile(path.join(root, 'sanity', 'schemas', 'article.ts'), decoySchemaFileContent('article'), 'utf8');
  return root;
}

/** The consumer repo (shape of mdostal-tools-hub/src/lib/sanity.ts). */
async function buildConsumerRepo(): Promise<string> {
  const root = await makeTempRepo('consumer');
  await mkdir(path.join(root, 'src', 'lib', 'queries'), { recursive: true });
  await writeFile(
    path.join(root, 'src', 'lib', 'sanity.ts'),
    [
      'export const allToolsQuery = `*[_type == "tool" && hidden != true] {',
      '  _id,',
      '  title,',
      '  url,',
      '  description,',
      '  "categoryName": category->title',
      '} | order(title asc)`;',
      '',
      'export async function getTools(client: SanityClient) {',
      '  return client.fetch(allToolsQuery);',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  // Decoy query for an identifier that is never defined anywhere in these
  // fixtures -- proves multi-file scanning correctly isolates per-query
  // results instead of bleeding every identifier it has ever seen into
  // every recall() call.
  await writeFile(
    path.join(root, 'src', 'lib', 'queries', 'authors.ts'),
    ['export const authorsQuery = `*[_type == "author"] | order(name asc)`;', ''].join('\n'),
    'utf8',
  );
  return root;
}

/** A repo whose own schema/query pair shares NO identifiers with definer/consumer -- negative control. */
async function buildUnrelatedRepo(): Promise<string> {
  const root = await makeTempRepo('unrelated');
  await mkdir(path.join(root, 'sanity', 'schemas'), { recursive: true });
  await mkdir(path.join(root, 'src', 'lib'), { recursive: true });
  await writeFile(path.join(root, 'sanity', 'schemas', 'recipe.ts'), decoySchemaFileContent('recipe'), 'utf8');
  await writeFile(
    path.join(root, 'src', 'lib', 'sanity.ts'),
    ['export const allRecipesQuery = `*[_type == "recipe"] | order(title asc)`;', ''].join('\n'),
    'utf8',
  );
  // Decoy file with zero Sanity-shaped content at all -- proves the walker
  // scanning it doesn't produce spurious matches.
  await writeFile(
    path.join(root, 'src', 'lib', 'analytics.ts'),
    ["export function trackEvent(name: string) {", "  console.log('event', name);", '}', ''].join('\n'),
    'utf8',
  );
  return root;
}

/**
 * A fork of the definer repo: the IDENTICAL 'tool' schema definition (shape
 * of mdostal/me-mdostal-com, a real fork of mdostal/personal-site), and
 * deliberately NO query file at all -- reproducing the real prototype
 * finding exactly: both repos define the same document type, neither
 * queries it anywhere.
 */
async function buildForkRepo(): Promise<string> {
  const root = await makeTempRepo('fork');
  await mkdir(path.join(root, 'sanity', 'schemas'), { recursive: true });
  await writeFile(path.join(root, 'sanity', 'schemas', 'tool.ts'), toolSchemaFileContent(), 'utf8');
  return root;
}

function expectOk(result: RecallResult): asserts result is RecallResult & { ok: true; hits: Hit[] } {
  expect(result.ok).toBe(true);
}

describe('CrossRepoLinkerAdapter regression — realistic fixture repos', () => {
  describe('3-repo scenario: definer, consumer, unrelated (AC1)', () => {
    it('finds exactly the definer->consumer link and reports zero hits touching the unrelated repo', async () => {
      const definerRoot = await buildDefinerRepo();
      const consumerRoot = await buildConsumerRepo();
      const unrelatedRoot = await buildUnrelatedRepo();

      const adapter = new CrossRepoLinkerAdapter({
        repos: [
          { path: definerRoot, name: 'personal-site' },
          { path: consumerRoot, name: 'mdostal-tools-hub' },
          { path: unrelatedRoot, name: 'other-project' },
        ],
      });

      const result = await adapter.recall('tool');
      expectOk(result);

      // Exactly one definition + one cross-repo usage -- the decoy
      // article/author/recipe identifiers and files must not add noise.
      expect(result.hits).toHaveLength(2);

      const defHit = result.hits.find((h) => h.content.startsWith('Definition:'));
      const usageHit = result.hits.find((h) => h.content.toLowerCase().includes('cross-repo usage'));

      expect(defHit).toBeDefined();
      expect(defHit!.content).toContain('personal-site');
      expect(defHit!.provenance.source).toBe(`${path.join(definerRoot, 'sanity', 'schemas', 'tool.ts')}:2`);

      expect(usageHit).toBeDefined();
      expect(usageHit!.content).toContain('mdostal-tools-hub');
      expect(usageHit!.content).toContain('personal-site');
      expect(usageHit!.provenance.source).toBe(`${path.join(consumerRoot, 'src', 'lib', 'sanity.ts')}:1`);

      // Zero involvement of the unrelated repo anywhere in the result.
      expect(result.hits.every((h) => !h.provenance.source.includes(unrelatedRoot))).toBe(true);
      expect(result.hits.every((h) => !h.content.includes('other-project'))).toBe(true);
    });

    it('the unrelated repo\'s own identifier stays fully confined to itself', async () => {
      const definerRoot = await buildDefinerRepo();
      const consumerRoot = await buildConsumerRepo();
      const unrelatedRoot = await buildUnrelatedRepo();

      const adapter = new CrossRepoLinkerAdapter({
        repos: [
          { path: definerRoot, name: 'personal-site' },
          { path: consumerRoot, name: 'mdostal-tools-hub' },
          { path: unrelatedRoot, name: 'other-project' },
        ],
      });

      const result = await adapter.recall('recipe');
      expectOk(result);

      // 'recipe' is defined AND queried only inside the unrelated repo --
      // exactly a definition + a same-repo (not cross-repo) usage, and
      // nothing sourced from definer/consumer.
      expect(result.hits).toHaveLength(2);
      expect(result.hits.every((h) => h.provenance.source.includes(unrelatedRoot))).toBe(true);
      expect(result.hits.some((h) => h.content.toLowerCase().includes('cross-repo usage'))).toBe(false);
      expect(result.hits.some((h) => h.content.toLowerCase().includes('same-repo'))).toBe(true);
    });
  });

  describe('fork scenario: duplicate schema definitions, no cross-repo usage (AC2)', () => {
    it('does not report a false cross-repo usage link between two repos that both merely define the identical type', async () => {
      // Reproduces the real prototype finding precisely: personal-site and
      // its fork me-mdostal-com both define the same 'tool' document type;
      // neither has any query file referencing it at all.
      const forkARoot = await buildForkRepo();
      const forkBRoot = await buildForkRepo();

      const adapter = new CrossRepoLinkerAdapter({
        repos: [
          { path: forkARoot, name: 'personal-site' },
          { path: forkBRoot, name: 'me-mdostal-com' },
        ],
      });

      const result = await adapter.recall('tool');
      expectOk(result);

      // The actual, verified behavior: two independent Definition hits (one
      // per repo) -- a duplicate-definition signal, and NOTHING framed as
      // usage of any kind (cross-repo or same-repo), because scanAllRepos()
      // found zero usage occurrences of 'tool' anywhere. recall()'s
      // per-definition loop only ever emits a usage hit when a real usage
      // site exists to pair with a definition -- with none, it emits none.
      expect(result.hits).toHaveLength(2);
      expect(result.hits.every((h) => h.content.startsWith('Definition:'))).toBe(true);
      expect(result.hits.some((h) => h.content.includes('personal-site'))).toBe(true);
      expect(result.hits.some((h) => h.content.includes('me-mdostal-com'))).toBe(true);

      // The specific false positive this test exists to rule out: no hit,
      // of any kind, ever mentions "usage" -- cross-repo or same-repo.
      expect(result.hits.some((h) => h.content.toLowerCase().includes('usage'))).toBe(false);

      // And provenance ties each Definition hit to its own repo's file,
      // never to the other fork.
      const defForkA = result.hits.find((h) => h.content.includes('personal-site'));
      const defForkB = result.hits.find((h) => h.content.includes('me-mdostal-com'));
      expect(defForkA!.provenance.source).toBe(`${path.join(forkARoot, 'sanity', 'schemas', 'tool.ts')}:2`);
      expect(defForkB!.provenance.source).toBe(`${path.join(forkBRoot, 'sanity', 'schemas', 'tool.ts')}:2`);
    });
  });

  describe('determinism across regenerated fixtures (AC3)', () => {
    /** Path-independent shape of one recall() result, for cross-run comparison. */
    interface NormalizedHit {
      content: string;
      source: string;
      chunkIndex: unknown;
    }

    function normalize(hits: Hit[], roots: Array<{ root: string; label: string }>): NormalizedHit[] {
      return hits
        .map((h) => {
          let content = h.content;
          let source = h.provenance.source;
          for (const { root, label } of roots) {
            content = content.split(root).join(label);
            source = source.split(root).join(label);
          }
          return { content, source, chunkIndex: h.provenance.chunk_span?.index };
        })
        .sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
    }

    async function runFullScenario(): Promise<{
      roots: { definerRoot: string; consumerRoot: string; unrelatedRoot: string };
      normalizedHits: NormalizedHit[];
    }> {
      const definerRoot = await buildDefinerRepo();
      const consumerRoot = await buildConsumerRepo();
      const unrelatedRoot = await buildUnrelatedRepo();

      const adapter = new CrossRepoLinkerAdapter({
        repos: [
          { path: definerRoot, name: 'personal-site' },
          { path: consumerRoot, name: 'mdostal-tools-hub' },
          { path: unrelatedRoot, name: 'other-project' },
        ],
      });

      const result = await adapter.recall('tool');
      expectOk(result);

      const normalizedHits = normalize(result.hits, [
        { root: definerRoot, label: '<definer>' },
        { root: consumerRoot, label: '<consumer>' },
        { root: unrelatedRoot, label: '<unrelated>' },
      ]);

      return { roots: { definerRoot, consumerRoot, unrelatedRoot }, normalizedHits };
    }

    it('produces identical results when the fixture repos are deleted and regenerated between runs', async () => {
      const first = await runFullScenario();

      // Literally delete the first run's fixtures (not just letting the
      // afterEach clean them up later) before regenerating a fresh,
      // independent set -- proving the second run's identical result isn't
      // an artifact of reusing any state from the first.
      await rm(first.roots.definerRoot, { recursive: true, force: true });
      await rm(first.roots.consumerRoot, { recursive: true, force: true });
      await rm(first.roots.unrelatedRoot, { recursive: true, force: true });

      const second = await runFullScenario();

      expect(second.normalizedHits).toEqual(first.normalizedHits);
      // Sanity check the normalization didn't collapse everything to
      // nothing -- the comparison above must be over real content.
      expect(first.normalizedHits.length).toBeGreaterThan(0);
    });
  });
});
