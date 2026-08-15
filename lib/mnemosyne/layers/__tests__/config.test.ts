import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LAYER_STACK_CONFIG, resolveLayerStackConfig } from '../config.js';

const tempRoots: string[] = [];
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mnemosyne-layer-config-'));
  tempRoots.push(root);
  return root;
}

/**
 * A fake PATH directory containing (or not containing) an executable named
 * "graphify" -- lets tests deterministically simulate "graphify installed"
 * or "graphify missing from PATH" regardless of what's actually installed
 * on the machine running the suite (this sandbox happens to have the real
 * CLI installed; CI does not -- see .github/workflows/ci.yml).
 */
async function makeFakePathWithGraphify(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mnemosyne-fake-path-'));
  tempRoots.push(dir);
  const binPath = path.join(dir, 'graphify');
  await writeFile(binPath, '#!/bin/sh\necho fake-graphify\n', 'utf8');
  await chmod(binPath, 0o755);
  return dir;
}

async function makeEmptyPath(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mnemosyne-fake-empty-path-'));
  tempRoots.push(dir);
  return dir;
}

describe('resolveLayerStackConfig', () => {
  // cr-01-graphify-default-layer: DEFAULT_LAYER_STACK_CONFIG's first entry
  // is now 'graphify', not 'code-graph' -- la-10's real A/B benchmark
  // (docs/layer-architecture-v2-plan.md §7) found code-graph's backing
  // store had ZERO nodes from this repo (22 nodes total, all from two
  // unrelated repos) vs. graphify's 1470 real nodes/2484 links from this
  // repo's own source, at 33% lower average latency and never a worse hit
  // count on any benchmarked query. This intentionally breaks this file's
  // OLD assertion (and the OLD "byte-for-byte identical to before" promise
  // in config.ts's module doc, which was correct for pl-01's own refactor,
  // not a permanent constraint -- see config.ts's updated doc comment).
  it('defaults to graphify, vector, file when graphify is on PATH (the common case, e.g. after `uv tool install graphifyy`)', async () => {
    const fakePath = await makeFakePathWithGraphify();
    const config = resolveLayerStackConfig({ env: { PATH: fakePath }, root: '/nonexistent-dir-xyz' });
    expect(config.layers.map((l) => l.name)).toEqual(['graphify', 'vector', 'file']);
  });

  // Soft-default fallback (mirrors bin/graphify-bridge.mjs's
  // isGraphifyConfigured() on the JS zero-dep server side): a genuinely
  // unconfigured install (no explicit config, no MNEMOSYNE_LAYERS, no
  // mnemosyne.layers.json) must stay fully functional even without the
  // `graphify` binary installed -- never a hard requirement for a bare
  // install. This is what keeps CI (which does not install graphify) and
  // every existing consumer that hasn't run `uv tool install graphifyy`
  // working exactly as before, unchanged.
  it('falls back to code-graph, vector, file (with a warning) when graphify is NOT on PATH and nothing is configured', async () => {
    const emptyPath = await makeEmptyPath();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const config = resolveLayerStackConfig({ env: { PATH: emptyPath }, root: '/nonexistent-dir-xyz' });
      expect(config.layers.map((l) => l.name)).toEqual(['code-graph', 'vector', 'file']);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toMatch(/graphify.*not.*(on PATH|installed)/i);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does NOT warn or fall back when graphify is unavailable but a config IS explicit (pluggability preserved)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const explicit = { layers: [{ name: 'vector' }] }; // deliberately graphify-less PATH
      const config = resolveLayerStackConfig({ explicit, env: { PATH: '' } });
      expect(config).toBe(explicit);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does NOT warn or fall back when MNEMOSYNE_LAYERS explicitly requests a single non-graphify layer, even with graphify unavailable', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const config = resolveLayerStackConfig({
        env: { PATH: '', MNEMOSYNE_LAYERS: JSON.stringify({ layers: [{ name: 'vector' }] }) },
      });
      expect(config.layers.map((l) => l.name)).toEqual(['vector']);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('explicit config takes top priority', () => {
    const explicit = { layers: [{ name: 'file' }] };
    const config = resolveLayerStackConfig({
      explicit,
      env: { MNEMOSYNE_LAYERS: JSON.stringify({ layers: [{ name: 'vector' }] }) },
    });
    expect(config).toBe(explicit);
  });

  it('MNEMOSYNE_LAYERS env var wins over the default when no explicit config is given', () => {
    const config = resolveLayerStackConfig({
      env: { MNEMOSYNE_LAYERS: JSON.stringify({ layers: [{ name: 'vector' }, { name: 'file' }] }) },
    });
    expect(config.layers.map((l) => l.name)).toEqual(['vector', 'file']);
  });

  it('MNEMOSYNE_LAYERS with invalid JSON throws a clear error', () => {
    expect(() => resolveLayerStackConfig({ env: { MNEMOSYNE_LAYERS: '{not json' } })).toThrow(/not valid JSON/);
  });

  it('MNEMOSYNE_LAYERS with the wrong shape throws a clear error', () => {
    expect(() => resolveLayerStackConfig({ env: { MNEMOSYNE_LAYERS: JSON.stringify({ foo: 'bar' }) } })).toThrow(
      /does not match/,
    );
  });

  it('reads mnemosyne.layers.json from the given root when no env var is set', async () => {
    const root = await makeTempRoot();
    await writeFile(
      path.join(root, 'mnemosyne.layers.json'),
      JSON.stringify({ layers: [{ name: 'hive-memory' }, { name: 'file' }] }),
      'utf8',
    );

    const config = resolveLayerStackConfig({ env: {}, root });
    expect(config.layers.map((l) => l.name)).toEqual(['hive-memory', 'file']);
  });

  it('falls back to the default when mnemosyne.layers.json does not exist (graphify on PATH)', async () => {
    const root = await makeTempRoot();
    const fakePath = await makeFakePathWithGraphify();
    const config = resolveLayerStackConfig({ env: { PATH: fakePath }, root });
    expect(config.layers.map((l) => l.name)).toEqual(['graphify', 'vector', 'file']);
  });

  it('per-layer options round-trip through resolution', () => {
    const config = resolveLayerStackConfig({
      env: { MNEMOSYNE_LAYERS: JSON.stringify({ layers: [{ name: 'vector', options: { timeoutMs: 9999 } }] }) },
    });
    expect(config.layers[0]).toEqual({ name: 'vector', options: { timeoutMs: 9999 } });
  });
});

describe('DEFAULT_LAYER_STACK_CONFIG', () => {
  it('is graphify-first (the constant itself, independent of PATH availability)', () => {
    expect(DEFAULT_LAYER_STACK_CONFIG.layers.map((l) => l.name)).toEqual(['graphify', 'vector', 'file']);
  });
});
