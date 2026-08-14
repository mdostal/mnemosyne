import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

async function mktempEmptyRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mnemosyne-graphify-empty-'));
  tempRoots.push(root);
  return root;
}
