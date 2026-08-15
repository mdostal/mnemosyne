// kw-02-ts-client-keyword-layer: MnemosyneClient-level tests for the
// always-parallel vector+keyword cascade merge/dedupe. Deliberately a
// SEPARATE file from client.test.ts (which must stay completely unmodified
// as the regression bar for this refactor) and from
// client-layer-config.test.ts (pl-01's own separate-file convention) --
// these are additive tests for the new, strictly opt-in cascade behavior.
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MnemosyneClient } from '../client.js';
import type { Hit, RecallResult } from '../interfaces.js';
import { KeywordLayerAdapter } from '../layers/KeywordLayerAdapter.js';
import type { LayerAdapter, RecallOptions } from '../layers/LayerAdapter.js';
import { LayerRegistry } from '../layers/registry.js';
import { VectorLayerAdapter } from '../layers/VectorLayerAdapter.js';

const FAKE_SWARM_MEMORY = fileURLToPath(
  new URL('../layers/__tests__/fixtures/fake-swarm-memory.mjs', import.meta.url),
);

function hit(layer: 'vector' | 'keyword' | 'file', source: string, chunkIndex: number, content: string): Hit {
  return {
    content,
    provenance: {
      layer,
      source,
      chunk_span: { index: chunkIndex },
      index_timestamp: null,
      content_hash: null,
      embedder: layer === 'vector' ? 'nomic-embed-text' : null,
      retrieval_time: layer === 'vector' ? '2026-08-15T00:00:00Z' : null,
    },
    ...(layer === 'vector' ? { score: 0.53 } : {}),
  };
}

function okAdapter(
  layer: LayerAdapter['layer'],
  recall: (query: string, options?: RecallOptions) => Promise<RecallResult>,
): LayerAdapter {
  return { layer, recall };
}

function fixedHitsAdapter(layer: LayerAdapter['layer'], hits: Hit[]): LayerAdapter {
  return okAdapter(layer, async (query, options) => ({
    ok: true,
    query,
    scope: options?.scope ?? 'project',
    intent: options?.intent ?? 'narrow',
    hits,
    layers_queried: [layer],
    layers_skipped: [],
    escalated: false,
    degraded: false,
  }));
}

function failingAdapter(layer: LayerAdapter['layer'], code: string, message: string): LayerAdapter {
  return okAdapter(layer, async (query, options) => ({
    ok: false,
    query,
    scope: options?.scope ?? 'project',
    intent: options?.intent ?? 'narrow',
    error: { layer, message, code },
  }));
}

function fileFallbackAdapter(): LayerAdapter {
  return fixedHitsAdapter('file', [hit('file', 'notes/floor.md', 0, 'file-layer floor hit')]);
}

function registryWith(entries: Record<string, LayerAdapter>): LayerRegistry {
  const registry = new LayerRegistry();
  for (const [name, adapter] of Object.entries(entries)) {
    registry.register(name, () => adapter);
  }
  return registry;
}

describe('MnemosyneClient — always-parallel vector+keyword cascade (kw-02)', () => {
  it('pluggability: a stack that does NOT configure "keyword" never constructs or queries it — the factory is never even invoked', async () => {
    let keywordFactoryCalls = 0;
    const registry = registryWith({ vector: fixedHitsAdapter('vector', []) });
    registry.register('keyword', () => {
      keywordFactoryCalls += 1;
      return fixedHitsAdapter('keyword', [hit('keyword', 'notes/should-not-appear.md', 0, 'unreachable')]);
    });

    const client = new MnemosyneClient({
      registry,
      layerStack: { layers: [{ name: 'vector' }] },
    });
    const result = await client.recall('anything', 'project');

    expect(keywordFactoryCalls).toBe(0);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.layers_queried).toEqual(['vector']);
    expect(result.hits).toEqual([]);
  });

  it('pluggability: a "keyword"-only stack (no "vector") queries keyword normally as a single step, no pairing', async () => {
    const registry = registryWith({
      keyword: fixedHitsAdapter('keyword', [hit('keyword', 'notes/ticket.md', 0, 'exact match')]),
    });

    const client = new MnemosyneClient({ registry, layerStack: { layers: [{ name: 'keyword' }] } });
    const result = await client.recall('PAN-8968', 'project');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.layers_queried).toEqual(['keyword']);
    expect(result.hits).toHaveLength(1);
  });

  it('when both "vector" and "keyword" are configured, both are queried CONCURRENTLY, not sequentially — total time is close to the slower one, not their sum', async () => {
    const DELAY_MS = 150;
    let vectorStartedAt = 0;
    let keywordStartedAt = 0;

    const vector = okAdapter('vector', async (query, options) => {
      vectorStartedAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
      return {
        ok: true,
        query,
        scope: options?.scope ?? 'project',
        intent: options?.intent ?? 'narrow',
        hits: [],
        layers_queried: ['vector'],
        layers_skipped: [],
        escalated: false,
        degraded: false,
      };
    });
    const keyword = okAdapter('keyword', async (query, options) => {
      keywordStartedAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
      return {
        ok: true,
        query,
        scope: options?.scope ?? 'project',
        intent: options?.intent ?? 'narrow',
        hits: [],
        layers_queried: ['keyword'],
        layers_skipped: [],
        escalated: false,
        degraded: false,
      };
    });

    const registry = registryWith({ vector, keyword });
    const client = new MnemosyneClient({
      registry,
      layerStack: { layers: [{ name: 'vector' }, { name: 'keyword' }] },
    });

    const startedAt = Date.now();
    await client.recall('q', 'project');
    const elapsedMs = Date.now() - startedAt;

    // Both adapters' recall() must have started within a few ms of each
    // other (concurrent), and total wall time must be well under 2x
    // DELAY_MS (which sequential execution would produce).
    expect(Math.abs(vectorStartedAt - keywordStartedAt)).toBeLessThan(50);
    expect(elapsedMs).toBeLessThan(DELAY_MS * 2);
  });

  it('merges vector + keyword hits: the correct exact-match hit from keyword is present even though vector alone would miss it', async () => {
    // Mirrors the real, confirmed defect this epic fixes
    // (docs/qdrant-hybrid-retrieval-experiment.md): vector returns
    // confidently-wrong near-identical-ID hits, keyword finds the real one.
    const wrongVectorHit = hit('vector', 'notes/PAN-7909.md', 0, 'COMPLETED: PAN-7909 merged to dev');
    const correctKeywordHit = hit('keyword', 'notes/PAN-8968.md', 0, 'COMPLETED: PAN-8968 merged to dev');

    const registry = registryWith({
      vector: fixedHitsAdapter('vector', [wrongVectorHit]),
      keyword: fixedHitsAdapter('keyword', [correctKeywordHit]),
    });
    const client = new MnemosyneClient({
      registry,
      layerStack: { layers: [{ name: 'vector' }, { name: 'keyword' }] },
    });

    const result = await client.recall('PAN-8968', 'project');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.layers_queried).toEqual(expect.arrayContaining(['vector', 'keyword']));
    const sources = result.hits.map((h) => h.provenance.source);
    expect(sources).toContain('notes/PAN-8968.md');
    expect(sources).toContain('notes/PAN-7909.md');
    expect(result.hits).toHaveLength(2);
  });

  it('dedupes an exact source+chunk match found by both vector and keyword: appears once, with also_matched noting the other layer', async () => {
    const sharedSource = 'notes/shared.md';
    const vectorCopy = hit('vector', sharedSource, 0, 'shared content');
    const keywordCopy = hit('keyword', sharedSource, 0, 'shared content');

    const registry = registryWith({
      vector: fixedHitsAdapter('vector', [vectorCopy]),
      keyword: fixedHitsAdapter('keyword', [keywordCopy]),
    });
    const client = new MnemosyneClient({
      registry,
      layerStack: { layers: [{ name: 'vector' }, { name: 'keyword' }] },
    });

    const result = await client.recall('q', 'project');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.provenance.layer).toBe('vector'); // first-found (vector's copy) wins
    expect(result.hits[0]?.also_matched).toEqual(['keyword']);
  });

  it('dedupe never collapses two DIFFERENT hits that merely share a source but have no chunk index (mirrors kw-01\'s hitIdentity() fallback-to-content reasoning in src/engine.mjs)', async () => {
    const sharedSource = 'notes/no-chunk-index.md';
    const vectorHitNoChunk: Hit = {
      content: 'first distinct passage',
      provenance: {
        layer: 'vector',
        source: sharedSource,
        chunk_span: null,
        index_timestamp: null,
        content_hash: null,
        embedder: 'nomic-embed-text',
        retrieval_time: '2026-08-15T00:00:00Z',
      },
      score: 0.5,
    };
    const keywordHitNoChunk: Hit = {
      content: 'second, unrelated passage from the same source',
      provenance: {
        layer: 'keyword',
        source: sharedSource,
        chunk_span: null,
        index_timestamp: null,
        content_hash: null,
        embedder: null,
        retrieval_time: null,
      },
    };

    const registry = registryWith({
      vector: fixedHitsAdapter('vector', [vectorHitNoChunk]),
      keyword: fixedHitsAdapter('keyword', [keywordHitNoChunk]),
    });
    const client = new MnemosyneClient({
      registry,
      layerStack: { layers: [{ name: 'vector' }, { name: 'keyword' }] },
    });

    const result = await client.recall('q', 'project');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    // Both must survive -- they're genuinely different content, not a
    // dual-matched duplicate, even though they share a source and neither
    // has a chunk index.
    expect(result.hits).toHaveLength(2);
  });

  it('a stack with a structural layer BEFORE the vector+keyword pair still short-circuits normally when it finds hits — the pair is never even queried', async () => {
    let vectorCalls = 0;
    let keywordCalls = 0;
    const codeGraph = fixedHitsAdapter('code-graph', [hit('vector', 'ignored', 0, 'n/a')]);
    const vector = okAdapter('vector', async () => {
      vectorCalls += 1;
      throw new Error('vector should never be called');
    });
    const keyword = okAdapter('keyword', async () => {
      keywordCalls += 1;
      throw new Error('keyword should never be called');
    });

    const registry = registryWith({ 'code-graph': codeGraph, vector, keyword });
    const client = new MnemosyneClient({
      registry,
      layerStack: { layers: [{ name: 'code-graph' }, { name: 'vector' }, { name: 'keyword' }] },
    });

    const result = await client.recall('q', 'project');
    expect(result.ok).toBe(true);
    expect(vectorCalls).toBe(0);
    expect(keywordCalls).toBe(0);
  });

  it('pairing engages regardless of configured order (keyword listed before vector)', async () => {
    const registry = registryWith({
      keyword: fixedHitsAdapter('keyword', [hit('keyword', 'notes/k.md', 0, 'keyword hit')]),
      vector: fixedHitsAdapter('vector', [hit('vector', 'notes/v.md', 0, 'vector hit')]),
    });
    const client = new MnemosyneClient({
      registry,
      layerStack: { layers: [{ name: 'keyword' }, { name: 'vector' }] },
    });

    const result = await client.recall('q', 'project');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.hits).toHaveLength(2);
    expect(result.layers_queried).toEqual(expect.arrayContaining(['vector', 'keyword']));
  });

  it('partial pair failure: vector down, keyword up — the pair still succeeds with keyword\'s hits, vector recorded as skipped/degraded (never a silent empty result)', async () => {
    const registry = registryWith({
      vector: failingAdapter('vector', 'not_installed', 'swarm-memory is not installed'),
      keyword: fixedHitsAdapter('keyword', [hit('keyword', 'notes/k.md', 0, 'keyword hit')]),
    });
    const client = new MnemosyneClient({
      registry,
      layerStack: { layers: [{ name: 'vector' }, { name: 'keyword' }] },
    });

    const result = await client.recall('q', 'project');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.provenance.source).toBe('notes/k.md');
    expect(result.degraded).toBe(true);
    expect(result.layers_skipped).toEqual([
      { layer: 'vector', reason: 'not_installed', detail: 'swarm-memory is not installed' },
    ]);
  });

  it('both vector and keyword down: this cascade step fails but the stack still falls through to the next configured layer (e.g. file), never a hard client-level failure when a floor layer exists', async () => {
    const registry = registryWith({
      vector: failingAdapter('vector', 'not_installed', 'swarm-memory is not installed'),
      keyword: failingAdapter('keyword', 'not_installed', 'swarm-memory is not installed'),
      file: fileFallbackAdapter(),
    });
    const client = new MnemosyneClient({
      registry,
      layerStack: { layers: [{ name: 'vector' }, { name: 'keyword' }, { name: 'file' }] },
    });

    const result = await client.recall('q', 'project');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.provenance.source).toBe('notes/floor.md');
    expect(result.degraded).toBe(true);
    expect(result.layers_skipped.map((s) => s.layer)).toEqual(expect.arrayContaining(['vector', 'keyword']));
  });

  it('both vector and keyword down with NO other layer configured: recall() fails loudly (RecallFailure), never a silent empty success', async () => {
    const registry = registryWith({
      vector: failingAdapter('vector', 'not_installed', 'swarm-memory is not installed or not on PATH'),
      keyword: failingAdapter('keyword', 'not_installed', 'swarm-memory is not installed or not on PATH'),
    });
    const client = new MnemosyneClient({
      registry,
      layerStack: { layers: [{ name: 'vector' }, { name: 'keyword' }] },
    });

    const result = await client.recall('q', 'project');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected recall to fail');
    expect(result.error.code).toBe('not_installed');
  });

  it('end-to-end with REAL VectorLayerAdapter + KeywordLayerAdapter classes against a fake swarm-memory subprocess (not mocked functions) — merged real hits from both, no live Qdrant dependency', async () => {
    const registry = new LayerRegistry();
    registry.register('vector', (options) => new VectorLayerAdapter(options as ConstructorParameters<typeof VectorLayerAdapter>[0]));
    registry.register('keyword', (options) => new KeywordLayerAdapter(options as ConstructorParameters<typeof KeywordLayerAdapter>[0]));

    const client = new MnemosyneClient({
      registry,
      layerStack: {
        layers: [
          { name: 'vector', options: { command: FAKE_SWARM_MEMORY } },
          { name: 'keyword', options: { command: FAKE_SWARM_MEMORY } },
        ],
      },
    });

    const previous = process.env.FAKE_SWARM_MEMORY_MODE;
    process.env.FAKE_SWARM_MEMORY_MODE = 'hits'; // vector fixture mode; grep ignores this and uses its own default (grep-hits-shaped) branch
    try {
      const result = await client.recall('PAN-8968', 'project');
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.message);

      expect(result.layers_queried).toEqual(expect.arrayContaining(['vector', 'keyword']));
      const byLayer = new Set(result.hits.map((h) => h.provenance.layer));
      expect(byLayer.has('vector')).toBe(true);
      expect(byLayer.has('keyword')).toBe(true);
      // fixture's vector mode returns 2 hits, grep's default branch returns
      // 2 hits, distinct sources -- no dedupe collision expected here.
      expect(result.hits).toHaveLength(4);
    } finally {
      if (previous === undefined) {
        delete process.env.FAKE_SWARM_MEMORY_MODE;
      } else {
        process.env.FAKE_SWARM_MEMORY_MODE = previous;
      }
    }
  });
});
