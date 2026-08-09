import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { VectorLayerAdapter } from '../VectorLayerAdapter.js';

const FAKE_SWARM_MEMORY = fileURLToPath(
  new URL('./fixtures/fake-swarm-memory.mjs', import.meta.url),
);

function makeAdapter(
  mode: string,
  options: { timeoutMs?: number } = {},
): VectorLayerAdapter {
  return new VectorLayerAdapter({
    command: FAKE_SWARM_MEMORY,
    ...options,
  });
}

async function withMode<T>(mode: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.FAKE_SWARM_MEMORY_MODE;
  process.env.FAKE_SWARM_MEMORY_MODE = mode;
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.FAKE_SWARM_MEMORY_MODE;
    } else {
      process.env.FAKE_SWARM_MEMORY_MODE = previous;
    }
  }
}

describe('VectorLayerAdapter', () => {
  it('shells out to swarm-memory recall and parses JSON hits', async () => {
    const adapter = makeAdapter('hits');
    const result = await withMode('hits', () => adapter.recall('needle'));

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    expect(result.layers_queried).toEqual(['vector']);
    expect(result.hits).toHaveLength(2);
    expect(result.hits.map((hit) => hit.content)).toEqual([
      'first matching chunk',
      'second matching chunk',
    ]);
  });

  it('maps all 7 provenance fields from swarm-memory output', async () => {
    const adapter = makeAdapter('hits');
    const result = await withMode('hits', () => adapter.recall('needle'));

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const [first] = result.hits;
    expect(first?.provenance).toEqual({
      layer: 'vector',
      source: '/repo/notes/one.md',
      chunk_span: { index: 0, start: 0, end: 0 },
      index_timestamp: '2026-08-01T00:00:00+00:00',
      content_hash: 'deadbeef',
      embedder: 'nomic-embed-text',
      retrieval_time: '2026-08-09T00:00:00+00:00',
    });
    expect(first?.score).toBe(0.87);
  });

  it('returns RecallSuccess with empty hits when swarm-memory finds nothing', async () => {
    const adapter = makeAdapter('empty');
    const result = await withMode('empty', () => adapter.recall('needle'));

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(result.hits).toEqual([]);
    expect(result.layers_queried).toEqual(['vector']);
  });

  it('returns RecallFailure (not empty hits) when swarm-memory exits non-zero', async () => {
    const adapter = makeAdapter('error');
    const result = await withMode('error', () => adapter.recall('needle'));

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected recall to fail');
    }
    expect(result.error.layer).toBe('vector');
    expect(result.error.code).toBe('swarm_memory_error');
    expect(result.error.message).toContain('qdrant unreachable');
  });

  it('returns RecallFailure when swarm-memory is not installed', async () => {
    const adapter = new VectorLayerAdapter({ command: '/nonexistent/swarm-memory-binary-xyz' });
    const result = await adapter.recall('needle');

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected recall to fail');
    }
    expect(result.error.layer).toBe('vector');
    expect(result.error.code).toBe('not_installed');
  });

  it('returns RecallFailure on timeout instead of hanging', async () => {
    const adapter = makeAdapter('timeout', { timeoutMs: 200 });
    const result = await withMode('timeout', () => adapter.recall('needle'));

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected recall to fail');
    }
    expect(result.error.layer).toBe('vector');
    expect(result.error.code).toBe('timeout');
  }, 10_000);

  it('returns RecallFailure when swarm-memory output is not valid JSON', async () => {
    const adapter = makeAdapter('bad-json');
    const result = await withMode('bad-json', () => adapter.recall('needle'));

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected recall to fail');
    }
    expect(result.error.layer).toBe('vector');
    expect(result.error.code).toBe('invalid_response');
  });

  it('returns RecallFailure for an empty query without shelling out', async () => {
    const adapter = new VectorLayerAdapter({ command: '/nonexistent/should-not-run' });
    const result = await adapter.recall('   ');

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected recall to fail');
    }
    expect(result.error.code).toBe('invalid_query');
  });
});
