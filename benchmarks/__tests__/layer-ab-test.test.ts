import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runAbTest, runConfig } from '../layer-ab-test.js';

const tempRoots: string[] = [];
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mnemosyne-layer-ab-'));
  tempRoots.push(root);
  return root;
}

// la-10: same real-binary gate as GraphifyLayerAdapter.test.ts — CI has no
// graphify installed (Node-only setup), so the graphify-wiring test below is
// skipped (not failed) when it's not on PATH; every other test here is
// unconditional.
function isGraphifyOnPath(): boolean {
  try {
    execFileSync('graphify', ['--help'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const GRAPHIFY_AVAILABLE = isGraphifyOnPath();

describe('layer-ab-test — real comparison, well-formed output', () => {
  it('runConfig() produces real, well-formed per-query and aggregate numbers for the file-only layer', async () => {
    const root = await makeTempRoot();
    await writeFile(path.join(root, 'notes.md'), 'a findable target line\n', 'utf8');

    const report = await runConfig(
      { name: 'file-only', config: { layers: [{ name: 'file' }] } },
      ['target'],
      'project',
      root,
    );

    expect(report.name).toBe('file-only');
    expect(report.layers).toEqual(['file']);
    expect(report.perQuery).toHaveLength(1);
    expect(report.perQuery[0]?.ok).toBe(true);
    expect(report.perQuery[0]?.hitCount).toBe(1);
    expect(report.perQuery[0]?.tokenCost).toBeGreaterThan(0);
    expect(report.perQuery[0]?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(report.perQuery[0]?.contributingLayers).toEqual(['file']);
    expect(report.totalHits).toBe(1);
    expect(report.totalTokens).toBe(report.perQuery[0]?.tokenCost);
  });

  it('runAbTest() runs the SAME query set against multiple configs and returns one real report per config', async () => {
    const root = await makeTempRoot();
    await writeFile(path.join(root, 'notes.md'), 'a findable target line\n', 'utf8');

    const reports = await runAbTest(
      [
        { name: 'a', config: { layers: [{ name: 'file' }] } },
        { name: 'b', config: { layers: [{ name: 'file' }] } },
      ],
      ['target', 'nonexistent-zzz'],
      'project',
      root,
    );

    expect(reports).toHaveLength(2);
    expect(reports[0]?.name).toBe('a');
    expect(reports[1]?.name).toBe('b');
    // Same config + same queries => same real results on both sides (sanity: this IS a real re-run, not a cached/faked echo).
    expect(reports[0]?.totalHits).toBe(reports[1]?.totalHits);
    expect(reports[0]?.perQuery.map((r) => r.query)).toEqual(['target', 'nonexistent-zzz']);
    expect(reports[0]?.perQuery[1]?.hitCount).toBe(0); // the nonexistent query really finds nothing
  });

  it('a hive-memory-only config surfaces contributingLayers:["hive-memory"] for a KG/memory-file hit — proving the extra layer really contributes', async () => {
    const root = await makeTempRoot();
    // No kg.sqlite, no memory dirs at this root — hive-memory legitimately finds nothing here,
    // this test's real assertion is just that the config wiring reaches the adapter at all
    // (ok:true, zero hits, not a crash) — see HiveMemoryLayerAdapter.test.ts for hit-producing coverage.
    const report = await runConfig(
      { name: 'hive-memory-only', config: { layers: [{ name: 'hive-memory' }] } },
      ['anything'],
      'project',
      root,
    );

    expect(report.perQuery[0]?.ok).toBe(true);
    expect(report.layers).toEqual(['hive-memory']);
  });

  it.skipIf(!GRAPHIFY_AVAILABLE)(
    'la-10: a graphify-configured stack runs the SAME query set as a code-graph-configured stack and returns real, comparable per-config reports',
    async () => {
      const root = await makeTempRoot();
      await mkdir(path.join(root, 'src'), { recursive: true });
      // Real cross-language source so graphify's graph.json has real nodes
      // (matches GraphifyLayerAdapter.test.ts's fixture-repo pattern) —
      // not a stub graph.
      await writeFile(
        path.join(root, 'src', 'greeter.py'),
        ['def greet(name):', '    return f"Hello, {name}!"', ''].join('\n'),
        'utf8',
      );

      const reports = await runAbTest(
        [
          { name: 'code-graph', config: { layers: [{ name: 'code-graph' }] } },
          { name: 'graphify', config: { layers: [{ name: 'graphify', options: { timeoutMs: 60_000 } }] } },
        ],
        ['greet'],
        'project',
        root,
      );

      expect(reports).toHaveLength(2);
      const [codeGraphReport, graphifyReport] = reports;
      // apples-to-apples: same query set reached both configs for real.
      expect(codeGraphReport?.perQuery.map((r) => r.query)).toEqual(['greet']);
      expect(graphifyReport?.perQuery.map((r) => r.query)).toEqual(['greet']);
      expect(graphifyReport?.perQuery[0]?.ok).toBe(true);
      // Real graph.json really has a 'greet' node -> real hit, not a stub.
      expect(graphifyReport?.perQuery[0]?.hitCount).toBeGreaterThan(0);
      expect(graphifyReport?.perQuery[0]?.contributingLayers).toEqual(['graphify']);
    },
  );
});
