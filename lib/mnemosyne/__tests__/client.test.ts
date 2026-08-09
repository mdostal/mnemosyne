import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../../src/observability/logger.js';
import type { Metrics } from '../../../src/observability/metrics.js';
import { MnemosyneClient, type MnemosyneClientOptions } from '../client.js';
import type { RecallResult } from '../interfaces.js';
import type { LayerAdapter } from '../layers/LayerAdapter.js';

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

  it('remember() returns a stub RememberSuccess', async () => {
    const root = await makeTempRoot();
    const client = makeClient({ rootDirectory: root });

    const result = await client.remember({ text: 'remember this' }, 'project');

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(result.layer).toBe('file');
    expect(result.provenance.content_hash).toEqual(expect.any(String));
    expect(result.provenance.retrieval_time).toEqual(expect.any(String));
  });

  it('remember() resolves to the caller-specified layer', async () => {
    const root = await makeTempRoot();
    const client = makeClient({ rootDirectory: root });

    const result = await client.remember({ text: 'remember this' }, 'project', 'vector');

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(result.layer).toBe('vector');
    expect(result.provenance.layer).toBe('vector');
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
        hits: [],
        layers_queried: ['vector'],
        layers_skipped: [],
        escalated: false,
        degraded: true,
      })),
    };

    const client = makeClient({ layerAdapter: degradedLayer, logger, metrics });
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
    const { logger, metrics } = makeObservabilityMocks();
    const client = makeClient({ logger, metrics });

    await client.remember({ text: 'remember this' }, 'project');

    expect(logger.info).toHaveBeenCalledWith(
      'remember_start',
      expect.objectContaining({
        scope: 'project',
        layer: 'file',
        content_hash: expect.any(String),
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      'remember_end',
      expect.objectContaining({
        duration_ms: expect.any(Number),
        layer: 'file',
        scope: 'project',
        ok: true,
      }),
    );
    expect(metrics.histogram).toHaveBeenCalledWith(
      'remember_duration_ms',
      expect.any(Number),
      expect.objectContaining({
        layer: 'file',
        scope: 'project',
        ok: true,
      }),
    );
  });
});
