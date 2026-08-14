import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GraphifyLayerAdapter } from '../GraphifyLayerAdapter.js';

// Real-binary gate: this suite deliberately exercises the ACTUAL `graphify`
// CLI (installed via `uv tool install graphifyy`) against real, freshly
// generated `graph.json` output — no mocking of the core recall path (see
// la-02-graphify-adapter's story). CI does not install graphify (see
// .github/workflows/ci.yml — Node-only setup), so the real-binary tests are
// skipped (not failed) when it isn't on PATH; the missing-binary/loud-failure
// tests below never depend on graphify actually being installed.
function isGraphifyOnPath(): boolean {
  try {
    execFileSync('graphify', ['--help'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const GRAPHIFY_AVAILABLE = isGraphifyOnPath();
if (!GRAPHIFY_AVAILABLE) {
  // eslint-disable-next-line no-console
  console.warn(
    '[GraphifyLayerAdapter.test] `graphify` not found on PATH -- skipping real-binary ' +
      'integration tests (install via `uv tool install graphifyy` to run them locally).',
  );
}

const tempRoots: string[] = [];

async function makeFixtureRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mnemosyne-graphify-layer-'));
  tempRoots.push(root);
  await mkdir(path.join(root, 'src'), { recursive: true });
  // Two real source files in two different languages -- satisfies the
  // story's AC1 ("a repo with real source files across at least 2
  // languages"). Real cross-references (a method calling a top-level
  // function) so the resulting graph has real edges, not just isolated
  // nodes.
  await writeFile(
    path.join(root, 'src', 'greeter.py'),
    [
      'def greet(name):',
      '    return f"Hello, {name}!"',
      '',
      '',
      'class Greeter:',
      '    def say_hi(self, name):',
      '        return greet(name)',
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    path.join(root, 'src', 'main.ts'),
    [
      'export function main() {',
      '  console.log("starting app");',
      '}',
      '',
      'export class App {',
      '  run() {',
      '    main();',
      '  }',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  return root;
}

// --- la-03-graphify-doc-index fixture -----------------------------------
//
// A repo with real markdown docs (headings at real line numbers) alongside
// a real source file -- exercises graphify's confirmed doc-node
// `source_location` (e.g. "L17") via its deterministic AST-level markdown
// parser (`_origin: "ast"`), per docs/cba-memory-layers.md's PoC findings.
// No mocked graph.json here: this fixture is run through the REAL
// `graphify update` CLI, same as makeFixtureRepo() above.
const GUIDE_MD_LINES = [
  '# Widget Guide', // L1
  '', // L2
  'Intro paragraph about the widget system.', // L3
  '', // L4
  '## Installation', // L5
  '', // L6
  'Run `npm install widget` to install.', // L7
  '', // L8
  '## Usage Examples', // L9
  '', // L10
  'Call `widget.render()` to draw it.', // L11
];

async function makeDocFixtureRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mnemosyne-graphify-doc-'));
  tempRoots.push(root);
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'docs', 'guide.md'), GUIDE_MD_LINES.join('\n') + '\n', 'utf8');
  await writeFile(
    path.join(root, 'src', 'widget.py'),
    ['def render():', '    return "<widget/>"', ''].join('\n'),
    'utf8',
  );
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('GraphifyLayerAdapter', () => {
  it('registers under the "graphify" layer name (Layer union), not overwriting code-graph', () => {
    const adapter = new GraphifyLayerAdapter({ command: process.execPath, repoRoot: '/tmp' });
    expect(adapter.layer).toBe('graphify');
  });

  it('throws a loud, actionable error at construction when the binary is an absolute path that does not exist', () => {
    expect(() => new GraphifyLayerAdapter({ command: '/nonexistent/graphify-binary-xyz' })).toThrow(
      /graphify is not installed|not found on PATH/i,
    );
  });

  it('throws a loud, actionable error at construction when the binary is not resolvable on PATH', () => {
    expect(() => new GraphifyLayerAdapter({ command: 'graphify-definitely-does-not-exist-xyz' })).toThrow(
      /uv tool install graphifyy/,
    );
  });

  it('actionable missing-binary error names the install command and the CLI', () => {
    try {
      new GraphifyLayerAdapter({ command: '/nonexistent/graphify-binary-xyz' });
      throw new Error('expected constructor to throw');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/uv tool install graphifyy/);
      expect(message).toMatch(/graphify/);
    }
  });

  it('never throws for recall() itself -- an empty query returns RecallFailure, not a throw', async () => {
    // process.execPath (node itself) is always resolvable on PATH, so
    // construction succeeds regardless of whether the real graphify CLI is
    // installed in this environment; recall('') short-circuits before ever
    // shelling out, so this assertion is unconditional.
    const adapter = new GraphifyLayerAdapter({ command: process.execPath, repoRoot: '/tmp' });
    const result = await adapter.recall('   ');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected recall to fail');
    expect(result.error.layer).toBe('graphify');
    expect(result.error.code).toBe('invalid_query');
  });

  it.skipIf(!GRAPHIFY_AVAILABLE)(
    'recall() returns real Hit[] derived from a real graphify graph.json, across 2 real languages',
    async () => {
      const root = await makeFixtureRepo();
      const adapter = new GraphifyLayerAdapter({ repoRoot: root, timeoutMs: 60_000 });

      const pyResult = await adapter.recall('Greeter');
      expect(pyResult.ok).toBe(true);
      if (!pyResult.ok) throw new Error(pyResult.error.message);
      expect(pyResult.hits.length).toBeGreaterThan(0);
      expect(pyResult.hits.some((hit) => hit.provenance.source.includes('greeter.py'))).toBe(true);
      expect(pyResult.hits.every((hit) => hit.provenance.layer === 'graphify')).toBe(true);
      expect(pyResult.layers_queried).toEqual(['graphify']);
      expect(pyResult.degraded).toBe(false);

      const tsResult = await adapter.recall('App');
      expect(tsResult.ok).toBe(true);
      if (!tsResult.ok) throw new Error(tsResult.error.message);
      expect(tsResult.hits.length).toBeGreaterThan(0);
      expect(tsResult.hits.some((hit) => hit.provenance.source.includes('main.ts'))).toBe(true);
    },
    60_000,
  );

  it.skipIf(!GRAPHIFY_AVAILABLE)(
    'provenance has null chunk_span/content_hash/embedder (no chunking/embedding concept) and a real retrieval_time',
    async () => {
      const root = await makeFixtureRepo();
      const adapter = new GraphifyLayerAdapter({ repoRoot: root, timeoutMs: 60_000 });
      const result = await adapter.recall('Greeter');
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.message);
      const hit = result.hits[0];
      expect(hit).toBeDefined();
      expect(hit?.provenance.layer).toBe('graphify');
      expect(hit?.provenance.chunk_span).toBeNull();
      expect(hit?.provenance.content_hash).toBeNull();
      expect(hit?.provenance.embedder).toBeNull();
      expect(new Date(hit?.provenance.retrieval_time ?? '').toString()).not.toBe('Invalid Date');
    },
    60_000,
  );

  it.skipIf(!GRAPHIFY_AVAILABLE)(
    'returns a legitimate empty-hits RecallSuccess (not a RecallFailure) for a query that matches nothing',
    async () => {
      const root = await makeFixtureRepo();
      const adapter = new GraphifyLayerAdapter({ repoRoot: root, timeoutMs: 60_000 });
      const result = await adapter.recall('ThisSymbolDoesNotExistAnywhere12345');
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.message);
      expect(result.hits).toEqual([]);
      expect(result.layers_queried).toEqual(['graphify']);
    },
    60_000,
  );

  it.skipIf(!GRAPHIFY_AVAILABLE)(
    'reuses an existing graph.json without re-running `graphify update` when autoUpdate is left at default and the file is already fresh',
    async () => {
      const root = await makeFixtureRepo();
      const first = new GraphifyLayerAdapter({ repoRoot: root, timeoutMs: 60_000 });
      const firstResult = await first.recall('Greeter');
      expect(firstResult.ok).toBe(true);

      // Second adapter instance, same repoRoot: graph.json now already
      // exists on disk, so recall() must read it directly rather than
      // requiring another `graphify update` pass.
      const second = new GraphifyLayerAdapter({ repoRoot: root, autoUpdate: false, timeoutMs: 60_000 });
      const secondResult = await second.recall('App');
      expect(secondResult.ok).toBe(true);
      if (!secondResult.ok) throw new Error(secondResult.error.message);
      expect(secondResult.hits.some((hit) => hit.provenance.source.includes('main.ts'))).toBe(true);
    },
    60_000,
  );

  it('fails loudly (RecallFailure, not silent empty hits) when autoUpdate is disabled and no graph.json exists yet', async () => {
    const root = await mktempEmptyRoot();
    const adapter = new GraphifyLayerAdapter({
      command: process.execPath,
      repoRoot: root,
      autoUpdate: false,
    });
    const result = await adapter.recall('anything');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected recall to fail');
    expect(result.error.layer).toBe('graphify');
    expect(result.error.code).toBe('graph_unavailable');
    expect(result.error.message).toMatch(/graph\.json/);
  });
});

// la-03-graphify-doc-index: doc nodes surfaced with real line-number
// source_location pointers, on top of la-02's code-node recall.
describe('GraphifyLayerAdapter -- doc-index recall (la-03)', () => {
  it.skipIf(!GRAPHIFY_AVAILABLE)(
    'recall() surfaces a markdown doc hit with a real line-number source_location, verified against actual fixture file content',
    async () => {
      const root = await makeDocFixtureRepo();
      const adapter = new GraphifyLayerAdapter({ repoRoot: root, timeoutMs: 60_000 });

      const result = await adapter.recall('Usage Examples');
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.message);
      expect(result.hits.length).toBeGreaterThan(0);

      const docHit = result.hits.find((hit) => hit.provenance.source.includes('guide.md'));
      expect(docHit).toBeDefined();

      // provenance.source is "<file>:<L-pointer>" (formatSource()) -- pull
      // the line number back out and verify it against the REAL file on
      // disk, not just trust the field is present (story's explicit ask).
      const match = docHit?.provenance.source.match(/:L(\d+)$/);
      expect(match, `expected an L<n> pointer in "${docHit?.provenance.source}"`).not.toBeNull();
      const lineNumber = Number(match?.[1]);

      const guidePath = path.join(root, 'docs', 'guide.md');
      const realLines = (await readFile(guidePath, 'utf8')).split('\n');
      const realLineContent = realLines[lineNumber - 1]; // source_location is 1-indexed
      expect(realLineContent).toBe('## Usage Examples');

      // Doc hits are shaped distinguishably from code hits (query-shape
      // distinction, not a second tool integration) -- content names it as
      // a doc, not a bare code-symbol summary.
      expect(docHit?.content).toMatch(/doc/i);
      expect(docHit?.content).toContain('Usage Examples');
    },
    60_000,
  );

  it.skipIf(!GRAPHIFY_AVAILABLE)(
    'the whole-file doc node (heading-less, L1) also resolves to real file content, not just heading nodes',
    async () => {
      const root = await makeDocFixtureRepo();
      const adapter = new GraphifyLayerAdapter({ repoRoot: root, timeoutMs: 60_000 });

      const result = await adapter.recall('guide.md');
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.message);
      const docHit = result.hits.find((hit) => hit.provenance.source.startsWith('docs/guide.md:L'));
      expect(docHit).toBeDefined();

      const match = docHit?.provenance.source.match(/:L(\d+)$/);
      const lineNumber = Number(match?.[1]);
      const realLines = (await readFile(path.join(root, 'docs', 'guide.md'), 'utf8')).split('\n');
      expect(realLines[lineNumber - 1]).toBe(GUIDE_MD_LINES[lineNumber - 1]);
    },
    60_000,
  );

  it.skipIf(!GRAPHIFY_AVAILABLE)(
    'doc indexing runs on the deterministic AST path with no LLM API key present -- matches the PoC no-LLM finding',
    async () => {
      // Explicitly strip any LLM credentials from the child process env so
      // this test cannot silently pass because a real key happened to be
      // configured on the host -- mirrors the PoC's own verification
      // ("Re-extracting code files... no LLM needed" per graphify's stdout).
      const savedGemini = process.env.GEMINI_API_KEY;
      const savedGoogle = process.env.GOOGLE_API_KEY;
      delete process.env.GEMINI_API_KEY;
      delete process.env.GOOGLE_API_KEY;
      try {
        const root = await makeDocFixtureRepo();
        const adapter = new GraphifyLayerAdapter({ repoRoot: root, timeoutMs: 60_000 });
        const result = await adapter.recall('Installation');
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.error.message);
        expect(result.hits.some((hit) => hit.provenance.source.includes('guide.md'))).toBe(true);
      } finally {
        if (savedGemini !== undefined) process.env.GEMINI_API_KEY = savedGemini;
        if (savedGoogle !== undefined) process.env.GOOGLE_API_KEY = savedGoogle;
      }
    },
    60_000,
  );

  it(
    'fails loudly (RecallFailure), not a silently-wrong line number, when a matched document node has a malformed source_location',
    async () => {
      // Synthetic graph.json (not real graphify output) -- this test
      // exercises OUR schema-validation guard against a hand-crafted
      // malformed doc node, per the story's risk mitigation: "fail loudly
      // on schema mismatch rather than silently misreporting line numbers."
      // The positive-path tests above cover real graphify output; this one
      // covers the defensive path real output should never hit.
      const root = await mktempEmptyRoot();
      await mkdir(path.join(root, 'graphify-out'), { recursive: true });
      const graph = {
        directed: true,
        multigraph: false,
        graph: {},
        nodes: [
          {
            id: 'docs_bad_md_heading',
            label: 'Heading',
            file_type: 'document',
            source_file: 'docs/bad.md',
            source_location: 'not-a-line-pointer',
            _origin: 'ast',
            norm_label: 'heading',
          },
        ],
        links: [],
        hyperedges: [],
        built_at_commit: 'deadbeef',
      };
      await writeFile(path.join(root, 'graphify-out', 'graph.json'), JSON.stringify(graph), 'utf8');

      const adapter = new GraphifyLayerAdapter({ command: process.execPath, repoRoot: root, autoUpdate: false });
      const result = await adapter.recall('Heading');
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected recall to fail on malformed doc source_location');
      expect(result.error.layer).toBe('graphify');
      expect(result.error.message).toMatch(/source_location/);
    },
  );
});

async function mktempEmptyRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mnemosyne-graphify-empty-'));
  tempRoots.push(root);
  return root;
}
