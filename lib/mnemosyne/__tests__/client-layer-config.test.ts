// pl-01-layer-registry: MnemosyneClient-level tests for the config-driven
// swap mechanism. Deliberately a SEPARATE file from client.test.ts, which
// must stay completely unmodified as the regression bar for the cascade
// refactor — these are additive tests for the new pluggability surface.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MnemosyneClient } from '../client.js';
import type { RecallResult } from '../interfaces.js';
import { LayerRegistry } from '../layers/registry.js';

function okLayer(layer: 'file' | 'vector' | 'code-graph', content: string) {
  return {
    layer,
    recall: async (query: string, options?: { scope?: string; intent?: string }): Promise<RecallResult> => ({
      ok: true,
      query,
      scope: (options?.scope as 'project') ?? 'project',
      intent: (options?.intent as 'narrow') ?? 'narrow',
      hits: [
        {
          content,
          provenance: {
            layer,
            source: `${layer}:test`,
            chunk_span: null,
            index_timestamp: null,
            content_hash: null,
            embedder: null,
            retrieval_time: null,
          },
        },
      ],
      layers_queried: [layer],
      layers_skipped: [],
      escalated: false,
      degraded: false,
    }),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('MnemosyneClient — config-driven layer swap (pl-01)', () => {
  it('a test can register a fake layer under a test-only name via a custom registry and configure the client to use it, with zero client.ts source changes', async () => {
    const registry = new LayerRegistry();
    registry.register('test-only-layer', () => okLayer('file', 'from the test-only layer'));

    const client = new MnemosyneClient({
      registry,
      layerStack: { layers: [{ name: 'test-only-layer' }] },
    });

    const result = await client.recall('anything', 'project');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.hits[0]?.content).toBe('from the test-only layer');
  });

  it('throws a clear error when the configured stack names an unregistered layer', () => {
    const registry = new LayerRegistry();
    expect(
      () => new MnemosyneClient({ registry, layerStack: { layers: [{ name: 'nonexistent' }] } }),
    ).toThrow(/unknown layer 'nonexistent'/);
  });

  it('a different order/subset of layers changes cascade behavior with no client.ts source changes', async () => {
    const registry = new LayerRegistry();
    let fileCalls = 0;
    registry.register('file', () => {
      const layer = okLayer('file', 'file hit');
      const originalRecall = layer.recall;
      layer.recall = async (...args) => {
        fileCalls += 1;
        return originalRecall(...args);
      };
      return layer;
    });
    registry.register('vector', () => okLayer('vector', 'vector hit'));

    // Reversed order vs. the real default (vector, file) — vector should win
    // immediately since it returns non-empty hits, file should never be reached.
    const client = new MnemosyneClient({ registry, layerStack: { layers: [{ name: 'vector' }, { name: 'file' }] } });
    const result = await client.recall('q', 'project');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.hits[0]?.content).toBe('vector hit');
    expect(fileCalls).toBe(0);
  });

  it('getConfiguredLayers() reflects the resolved stack and each layer\'s write capability', () => {
    const registry = new LayerRegistry();
    registry.register('recall-only', () => okLayer('file', 'x'));
    registry.register('writable', () => ({ ...okLayer('vector', 'x'), remember: async () => ({ ok: true as const, layer: 'vector' as const, provenance: { layer: 'vector' as const, source: 's', chunk_span: null, index_timestamp: null, content_hash: null, embedder: null, retrieval_time: null } }) }));

    const client = new MnemosyneClient({
      registry,
      layerStack: { layers: [{ name: 'recall-only' }, { name: 'writable' }] },
    });

    expect(client.getConfiguredLayers()).toEqual([
      { layer: 'file', writable: false },
      { layer: 'vector', writable: true },
    ]);
  });

  it('an unconfigured client (no options at all) resolves the real default 3-layer stack in order', () => {
    const client = new MnemosyneClient();
    const layers = client.getConfiguredLayers().map((l) => l.layer);
    expect(layers).toEqual(['code-graph', 'vector', 'file']);
  });

  it('MNEMOSYNE_LAYERS env var is honored end-to-end through a real MnemosyneClient construction', () => {
    vi.stubEnv('MNEMOSYNE_LAYERS', JSON.stringify({ layers: [{ name: 'file' }] }));
    const client = new MnemosyneClient();
    expect(client.getConfiguredLayers().map((l) => l.layer)).toEqual(['file']);
  });
});
