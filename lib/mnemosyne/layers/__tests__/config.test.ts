import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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

describe('resolveLayerStackConfig', () => {
  it('defaults to code-graph, vector, file — today\'s exact unconfigured behavior', () => {
    const config = resolveLayerStackConfig({ env: {}, root: '/nonexistent-dir-xyz' });
    expect(config).toEqual(DEFAULT_LAYER_STACK_CONFIG);
    expect(config.layers.map((l) => l.name)).toEqual(['code-graph', 'vector', 'file']);
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

  it('falls back to the default when mnemosyne.layers.json does not exist', async () => {
    const root = await makeTempRoot();
    const config = resolveLayerStackConfig({ env: {}, root });
    expect(config).toEqual(DEFAULT_LAYER_STACK_CONFIG);
  });

  it('per-layer options round-trip through resolution', () => {
    const config = resolveLayerStackConfig({
      env: { MNEMOSYNE_LAYERS: JSON.stringify({ layers: [{ name: 'vector', options: { timeoutMs: 9999 } }] }) },
    });
    expect(config.layers[0]).toEqual({ name: 'vector', options: { timeoutMs: 9999 } });
  });
});
