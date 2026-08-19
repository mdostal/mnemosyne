import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../../src/observability/logger.js';
import type { Metrics } from '../../../src/observability/metrics.js';
import { MnemosyneClient, type MnemosyneClientOptions } from '../client.js';
import type { Hit, RecallResult, RememberResult } from '../interfaces.js';
import type { LayerAdapter, RecallOptions, RememberOptions } from '../layers/LayerAdapter.js';

function stubVectorLayer(recall: (query: string, options?: RecallOptions) => Promise<RecallResult>): LayerAdapter {
  return { layer: 'vector', recall };
}

function stubWritableVectorLayer(
  remember: (content: string, options?: RememberOptions) => Promise<RememberResult>,
): LayerAdapter {
  return {
    layer: 'vector',
    recall: async (query, options) => ({
      ok: true,
      query,
      scope: options?.scope ?? 'project',
      intent: options?.intent ?? 'narrow',
      hits: [],
      layers_queried: ['vector'],
      layers_skipped: [],
      escalated: false,
      degraded: false,
    }),
    remember,
  };
}

function stubCodeGraphLayer(
  recall: (query: string, options?: RecallOptions) => Promise<RecallResult>,
): LayerAdapter {
  return { layer: 'code-graph', recall };
}

function unavailableLayer(layer: 'code-graph' | 'vector'): LayerAdapter {
  return {
    layer,
    recall: async (query, options) => ({
      ok: false,
      query,
      scope: options?.scope ?? 'project',
      intent: options?.intent ?? 'narrow',
      error: {
        layer,
        message: `${layer} unavailable`,
        code: 'not_installed',
      },
    }),
  };
}

function emptyCodeGraphLayer(): LayerAdapter {
  return stubCodeGraphLayer(async (query, options) => ({
    ok: true,
    query,
    scope: options?.scope ?? 'project',
    intent: options?.intent ?? 'narrow',
    hits: [],
    layers_queried: ['code-graph'],
    layers_skipped: [],
    escalated: false,
    degraded: false,
  }));
}

function vectorHit(overrides: Partial<Hit> = {}): Hit {
  return {
    content: 'a semantic match',
    provenance: {
      layer: 'vector',
      source: 'qdrant:point:123',
      chunk_span: { index: 0 },
      index_timestamp: '2026-08-01T00:00:00Z',
      content_hash: 'deadbeef',
      embedder: 'nomic-embed-text',
      retrieval_time: '2026-08-09T00:00:00Z',
    },
    ...overrides,
  };
}

function codeGraphHit(overrides: Partial<Hit> = {}): Hit {
  return {
    content: 'src/consumer.ts --depends_on--> src/core.ts',
    provenance: {
      layer: 'code-graph',
      source: 'src/consumer.ts',
      chunk_span: null,
      index_timestamp: '2026-08-09T00:00:00Z',
      content_hash: null,
      embedder: null,
      retrieval_time: '2026-08-09T00:00:01Z',
    },
    ...overrides,
  };
}

const tempRoots: string[] = [];
const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
const silentMetrics: Metrics = {
  histogram: () => undefined,
  counter: () => undefined,
};

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mnemosyne-client-'));
  tempRoots.push(root);
  return root;
}

function makeClient(options: MnemosyneClientOptions = {}): MnemosyneClient {
  return new MnemosyneClient({
    codeGraphLayer: unavailableLayer('code-graph'),
    vectorLayer: unavailableLayer('vector'),
    logger: silentLogger,
    metrics: silentMetrics,
    ...options,
  });
}

function makeObservabilityMocks(): { logger: Logger; metrics: Metrics } {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    metrics: {
      histogram: vi.fn(),
      counter: vi.fn(),
    },
  };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe('MnemosyneClient', () => {
  it('constructs successfully', () => {
    expect(() => makeClient()).not.toThrow();
  });

  it('recall(query, "project") queries the file layer and returns RecallSuccess', async () => {
    const root = await makeTempRoot();
    await writeFile(path.join(root, 'notes.md'), 'a target line\n', 'utf8');

    const client = makeClient({ rootDirectory: root });
    const result = await client.recall('target', 'project');

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    expect(result.scope).toBe('project');
    expect(result.layers_queried).toEqual(['file']);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.content).toBe('a target line');
  });

  it('returns RecallFailure for an empty query', async () => {
    const root = await makeTempRoot();
    const client = makeClient({ rootDirectory: root });

    const result = await client.recall('   ', 'project');

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected recall to fail');
    }
    expect(result.error.code).toBe('invalid_query');
    expect(result.error.layer).toBeNull();
  });

  it('propagates RecallFailure from the file layer without swallowing it into empty hits', async () => {
    const missingRoot = path.join(tmpdir(), `mnemosyne-client-missing-${process.pid}`);
    const client = makeClient({ rootDirectory: missingRoot });

    const result = await client.recall('needle', 'project');

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected recall to fail');
    }
    expect(result.error.layer).toBe('file');
  });

  it('merges/ranks multiple hits from the same file into line order', async () => {
    const root = await makeTempRoot();
    const filePath = path.join(root, 'multi.md');
    await writeFile(filePath, ['omega target', 'alpha', 'target line'].join('\n'), 'utf8');

    const client = makeClient({ rootDirectory: root });
    const result = await client.recall('target', 'project');

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    expect(result.hits).toHaveLength(2);
    expect(result.hits.map((hit) => hit.provenance.chunk_span?.index)).toEqual([1, 3]);
    expect(result.hits.map((hit) => hit.content)).toEqual(['omega target', 'target line']);
  });

  it('preserves layer provenance untouched on the merged hits', async () => {
    const root = await makeTempRoot();
    await writeFile(path.join(root, 'source.ts'), 'const needle = true;\n', 'utf8');

    const client = makeClient({ rootDirectory: root });
    const result = await client.recall('needle', 'enterprise', 'broad');

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const provenance = result.hits[0]?.provenance;
    expect(provenance).toMatchObject({
      layer: 'file',
      source: path.join(root, 'source.ts'),
      chunk_span: { index: 1 },
      index_timestamp: null,
      embedder: null,
    });
    expect(provenance?.content_hash).toEqual(expect.any(String));
    expect(provenance?.retrieval_time).toEqual(expect.any(String));
  });

  it('remember() delegates to the vector layer adapter and returns its real result', async () => {
    const root = await makeTempRoot();
    const rememberSpy = vi.fn(async (content: string): Promise<RememberResult> => ({
      ok: true,
      layer: 'vector',
      provenance: {
        layer: 'vector',
        source: '/notes/real-write.md',
        chunk_span: null,
        index_timestamp: '2026-08-13T00:00:00.000Z',
        content_hash: 'abc123',
        embedder: null,
        retrieval_time: null,
      },
    }));
    const client = makeClient({ rootDirectory: root, vectorLayer: stubWritableVectorLayer(rememberSpy) });

    const result = await client.remember({ text: 'remember this' }, 'project');

    expect(rememberSpy).toHaveBeenCalledWith('remember this', { scope: 'project' });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(result.layer).toBe('vector');
    // Not the old stub shape — a real source path from the layer's own write.
    expect(result.provenance.source).toBe('/notes/real-write.md');
    expect(result.provenance.source).not.toContain('stub:remember');
  });

  it('remember() rejects an explicit target naming a recall-only layer', async () => {
    const root = await makeTempRoot();
    const client = makeClient({ rootDirectory: root, codeGraphLayer: emptyCodeGraphLayer() });

    const result = await client.remember({ text: 'remember this' }, 'project', 'code-graph');

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected remember to fail');
    }
    expect(result.error.layer).toBe('code-graph');
    expect(result.error.code).toBe('layer_not_writable');
  });

  it('remember() falls back to the file layer when vector has no remember() (auto-routing, no explicit layer)', async () => {
    const root = await makeTempRoot();
    const recallOnlyVectorLayer = stubVectorLayer(async (query, options) => ({
      ok: true,
      query,
      scope: options?.scope ?? 'project',
      intent: options?.intent ?? 'narrow',
      hits: [],
      layers_queried: ['vector'],
      layers_skipped: [],
      escalated: false,
      degraded: false,
    }));
    const client = makeClient({ rootDirectory: root, vectorLayer: recallOnlyVectorLayer });

    const result = await client.remember({ text: 'remember this' }, 'project');

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(result.layer).toBe('file');
  });

  it('remember() returns RememberFailure (not a fake success) when NO configured layer is writable', async () => {
    const root = await makeTempRoot();
    const recallOnlyVectorLayer = stubVectorLayer(async (query, options) => ({
      ok: true,
      query,
      scope: options?.scope ?? 'project',
      intent: options?.intent ?? 'narrow',
      hits: [],
      layers_queried: ['vector'],
      layers_skipped: [],
      escalated: false,
      degraded: false,
    }));
    const recallOnlyFileLayer: LayerAdapter = { layer: 'file', recall: recallOnlyVectorLayer.recall };
    const client = makeClient({
      rootDirectory: root,
      vectorLayer: recallOnlyVectorLayer,
      layerAdapter: recallOnlyFileLayer,
    });

    const result = await client.remember({ text: 'remember this' }, 'project');

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected remember to fail');
    }
    expect(result.error.code).toBe('layer_not_writable');
    expect(result.error.layer).toBeNull();
  });

  it('remember() propagates a real RememberFailure from an explicitly-targeted vector layer without swallowing it', async () => {
    const root = await makeTempRoot();
    const failingRemember = vi.fn(async (): Promise<RememberResult> => ({
      ok: false,
      error: { layer: 'vector', message: 'qdrant upsert failed', code: 'swarm_memory_error' },
    }));
    const client = makeClient({ rootDirectory: root, vectorLayer: stubWritableVectorLayer(failingRemember) });

    // Explicit 'vector' target — no fallback, unlike the auto-routing default.
    const result = await client.remember({ text: 'remember this' }, 'project', 'vector');

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected remember to fail');
    }
    expect(result.error.code).toBe('swarm_memory_error');
    expect(result.error.message).toBe('qdrant upsert failed');
  });

  it('logs recall_start when recall begins', async () => {
    const root = await makeTempRoot();
    await writeFile(path.join(root, 'notes.md'), 'a target line\n', 'utf8');
    const { logger, metrics } = makeObservabilityMocks();

    const client = makeClient({ rootDirectory: root, logger, metrics });
    await client.recall('target', 'project', 'broad');

    expect(logger.info).toHaveBeenCalledWith('recall_start', {
      query: 'target',
      scope: 'project',
      intent: 'broad',
    });
  });

  it('logs recall_end with duration, hit count, and queried layers', async () => {
    const root = await makeTempRoot();
    await writeFile(path.join(root, 'notes.md'), 'a target line\n', 'utf8');
    const { logger, metrics } = makeObservabilityMocks();

    const client = makeClient({ rootDirectory: root, logger, metrics });
    await client.recall('target', 'project');

    expect(logger.info).toHaveBeenCalledWith(
      'recall_end',
      expect.objectContaining({
        duration_ms: expect.any(Number),
        hit_count: 1,
        layers_queried: ['file'],
        scope: 'project',
        intent: 'narrow',
        ok: true,
      }),
    );
    expect(metrics.histogram).toHaveBeenCalledWith(
      'recall_duration_ms',
      expect.any(Number),
      expect.objectContaining({
        scope: 'project',
        intent: 'narrow',
        ok: true,
        hit_count: 1,
        layers_queried: ['file'],
      }),
    );
  });

  it('logs layer_query when a layer returns', async () => {
    const root = await makeTempRoot();
    await writeFile(path.join(root, 'notes.md'), 'a target line\n', 'utf8');
    const { logger, metrics } = makeObservabilityMocks();

    const client = makeClient({ rootDirectory: root, logger, metrics });
    await client.recall('target', 'enterprise');

    expect(logger.info).toHaveBeenCalledWith(
      'layer_query',
      expect.objectContaining({
        layer: 'file',
        scope: 'enterprise',
        duration_ms: expect.any(Number),
        ok: true,
      }),
    );
  });

  it('logs and counts layer_degraded when a layer reports degraded recall', async () => {
    const { logger, metrics } = makeObservabilityMocks();
    const degradedLayer: LayerAdapter = {
      layer: 'vector',
      recall: vi.fn(async (query, options): Promise<RecallResult> => ({
        ok: true,
        query,
        scope: options?.scope ?? 'project',
        intent: options?.intent ?? 'narrow',
        hits: [vectorHit()],
        layers_queried: ['vector'],
        layers_skipped: [],
        escalated: false,
        degraded: true,
      })),
    };

    const client = makeClient({
      codeGraphLayer: emptyCodeGraphLayer(),
      vectorLayer: degradedLayer,
      logger,
      metrics,
    });
    await client.recall('target', 'project');

    expect(logger.warn).toHaveBeenCalledWith('layer_degraded', {
      layer: 'vector',
      scope: 'project',
      reason: 'degraded',
    });
    expect(metrics.counter).toHaveBeenCalledWith('layer_degraded_total', 1, {
      layer: 'vector',
      scope: 'project',
      reason: 'degraded',
    });
  });

  it('logs remember_start and remember_end with duration metrics', async () => {
    const root = await makeTempRoot();
    const { logger, metrics } = makeObservabilityMocks();
    const rememberSpy = vi.fn(async (): Promise<RememberResult> => ({
      ok: true,
      layer: 'vector',
      provenance: {
        layer: 'vector',
        source: '/notes/logged-write.md',
        chunk_span: null,
        index_timestamp: '2026-08-13T00:00:00.000Z',
        content_hash: 'abc123',
        embedder: null,
        retrieval_time: null,
      },
    }));
    const client = makeClient({ rootDirectory: root, logger, metrics, vectorLayer: stubWritableVectorLayer(rememberSpy) });

    await client.remember({ text: 'remember this' }, 'project');

    // remember_start logs BEFORE a layer is resolved (that's the whole point
    // of auto-routing) — 'auto' when no explicit layer was requested, never
    // a hardcoded 'vector' that presumes the outcome.
    expect(logger.info).toHaveBeenCalledWith(
      'remember_start',
      expect.objectContaining({
        scope: 'project',
        layer: 'auto',
        content_hash: expect.any(String),
      }),
    );
    // remember_end logs the layer that ACTUALLY resolved — vector succeeded
    // on the first cascade attempt here, so file is never reached.
    expect(logger.info).toHaveBeenCalledWith(
      'remember_end',
      expect.objectContaining({
        duration_ms: expect.any(Number),
        layer: 'vector',
        scope: 'project',
        ok: true,
      }),
    );
    expect(metrics.histogram).toHaveBeenCalledWith(
      'remember_duration_ms',
      expect.any(Number),
      expect.objectContaining({
        layer: 'vector',
        scope: 'project',
        ok: true,
      }),
    );
  });

  it('logs and counts layer_degraded when an explicitly-targeted remember() fails', async () => {
    const root = await makeTempRoot();
    const { logger, metrics } = makeObservabilityMocks();
    const failingRemember = vi.fn(async (): Promise<RememberResult> => ({
      ok: false,
      error: { layer: 'vector', message: 'qdrant upsert failed', code: 'swarm_memory_error' },
    }));
    const client = makeClient({ rootDirectory: root, logger, metrics, vectorLayer: stubWritableVectorLayer(failingRemember) });

    // Explicit 'vector' target — isolates "the target itself failed" from
    // the auto-routing fallback-to-file case covered separately below.
    await client.remember({ text: 'remember this' }, 'project', 'vector');

    expect(logger.warn).toHaveBeenCalledWith('layer_degraded', {
      layer: 'vector',
      scope: 'project',
      reason: 'swarm_memory_error',
      detail: 'qdrant upsert failed',
    });
    expect(metrics.counter).toHaveBeenCalledWith('layer_degraded_total', 1, {
      layer: 'vector',
      scope: 'project',
      reason: 'swarm_memory_error',
      detail: 'qdrant upsert failed',
    });
  });

  it('logs and counts layer_degraded for the layer skipped along the way when remember() auto-falls-back to file', async () => {
    const root = await makeTempRoot();
    const { logger, metrics } = makeObservabilityMocks();
    const failingRemember = vi.fn(async (): Promise<RememberResult> => ({
      ok: false,
      error: { layer: 'vector', message: 'qdrant upsert failed', code: 'swarm_memory_error' },
    }));
    const client = makeClient({ rootDirectory: root, logger, metrics, vectorLayer: stubWritableVectorLayer(failingRemember) });

    const result = await client.remember({ text: 'remember this' }, 'project');

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(result.layer).toBe('file');
    expect(logger.warn).toHaveBeenCalledWith('layer_degraded', {
      layer: 'vector',
      scope: 'project',
      reason: 'remember_fallback',
      detail: "superseded by successful write to 'file'",
    });
    expect(metrics.counter).toHaveBeenCalledWith('layer_degraded_total', 1, {
      layer: 'vector',
      scope: 'project',
      reason: 'remember_fallback',
      detail: "superseded by successful write to 'file'",
    });
  });

  it('queries the code-graph layer before vector recall and returns impact hits', async () => {
    const root = await makeTempRoot();
    await writeFile(path.join(root, 'notes.md'), 'a target line\n', 'utf8');
    let vectorCalls = 0;

    const codeGraphLayer = stubCodeGraphLayer(async (query, options) => ({
      ok: true,
      query,
      scope: options?.scope ?? 'project',
      intent: options?.intent ?? 'narrow',
      hits: [codeGraphHit()],
      layers_queried: ['code-graph'],
      layers_skipped: [],
      escalated: false,
      degraded: false,
    }));
    const vectorLayer = stubVectorLayer(async (query, options) => {
      vectorCalls += 1;
      return {
        ok: true,
        query,
        scope: options?.scope ?? 'project',
        intent: options?.intent ?? 'narrow',
        hits: [vectorHit()],
        layers_queried: ['vector'],
        layers_skipped: [],
        escalated: false,
        degraded: false,
      };
    });

    const client = makeClient({ rootDirectory: root, codeGraphLayer, vectorLayer });
    const result = await client.recall('src/core.ts', 'project');

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(result.layers_queried).toEqual(['code-graph']);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.provenance.layer).toBe('code-graph');
    expect(vectorCalls).toBe(0);
  });

  it('queries the vector layer when code-graph succeeds with zero hits', async () => {
    const root = await makeTempRoot();
    await writeFile(path.join(root, 'notes.md'), 'a target line\n', 'utf8');

    const vectorLayer = stubVectorLayer(async (query, options) => ({
      ok: true,
      query,
      scope: options?.scope ?? 'project',
      intent: options?.intent ?? 'narrow',
      hits: [vectorHit()],
      layers_queried: ['vector'],
      layers_skipped: [],
      escalated: false,
      degraded: false,
    }));

    const client = makeClient({
      rootDirectory: root,
      codeGraphLayer: emptyCodeGraphLayer(),
      vectorLayer,
    });
    const result = await client.recall('target', 'project');

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(result.layers_queried).toEqual(['code-graph', 'vector']);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.provenance.layer).toBe('vector');
    expect(result.escalated).toBe(false);
    expect(result.degraded).toBe(false);
  });

  it('escalates to the file layer when the vector layer succeeds with zero hits', async () => {
    const root = await makeTempRoot();
    await writeFile(path.join(root, 'notes.md'), 'a target line\n', 'utf8');

    const vectorLayer = stubVectorLayer(async (query, options) => ({
      ok: true,
      query,
      scope: options?.scope ?? 'project',
      intent: options?.intent ?? 'narrow',
      hits: [],
      layers_queried: ['vector'],
      layers_skipped: [],
      escalated: false,
      degraded: false,
    }));

    const client = makeClient({
      rootDirectory: root,
      codeGraphLayer: emptyCodeGraphLayer(),
      vectorLayer,
    });
    const result = await client.recall('target', 'project');

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(result.layers_queried).toEqual(['code-graph', 'vector', 'file']);
    expect(result.escalated).toBe(true);
    expect(result.degraded).toBe(false);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.provenance.layer).toBe('file');
  });

  it('falls back to the file layer with loud degradation when the vector layer fails', async () => {
    const root = await makeTempRoot();
    await writeFile(path.join(root, 'notes.md'), 'a target line\n', 'utf8');

    const vectorLayer = stubVectorLayer(async (query, options) => ({
      ok: false,
      query,
      scope: options?.scope ?? 'project',
      intent: options?.intent ?? 'narrow',
      error: {
        layer: 'vector',
        message: 'swarm-memory is not installed or not on PATH',
        code: 'not_installed',
      },
    }));

    const client = makeClient({
      rootDirectory: root,
      codeGraphLayer: emptyCodeGraphLayer(),
      vectorLayer,
    });
    const result = await client.recall('target', 'project');

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(result.layers_queried).toEqual(['code-graph', 'file']);
    expect(result.layers_skipped).toEqual([
      {
        layer: 'vector',
        reason: 'not_installed',
        detail: 'swarm-memory is not installed or not on PATH',
      },
    ]);
    expect(result.degraded).toBe(true);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.provenance.layer).toBe('file');
  });

  it('returns RecallFailure when both vector and file layers fail', async () => {
    const missingRoot = path.join(tmpdir(), `mnemosyne-client-missing-${process.pid}`);

    const vectorLayer = stubVectorLayer(async (query, options) => ({
      ok: false,
      query,
      scope: options?.scope ?? 'project',
      intent: options?.intent ?? 'narrow',
      error: {
        layer: 'vector',
        message: 'swarm-memory is not installed or not on PATH',
        code: 'not_installed',
      },
    }));

    const client = makeClient({
      rootDirectory: missingRoot,
      codeGraphLayer: emptyCodeGraphLayer(),
      vectorLayer,
    });
    const result = await client.recall('needle', 'project');

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected recall to fail');
    }
    expect(result.error.layer).toBe('file');
  });
});
