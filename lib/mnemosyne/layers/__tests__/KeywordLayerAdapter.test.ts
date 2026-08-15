import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { KeywordLayerAdapter } from '../KeywordLayerAdapter.js';
import type { LayerAdapter } from '../LayerAdapter.js';

const FAKE_SWARM_MEMORY = fileURLToPath(
  new URL('./fixtures/fake-swarm-memory.mjs', import.meta.url),
);

function makeAdapter(options: { timeoutMs?: number } = {}): KeywordLayerAdapter {
  return new KeywordLayerAdapter({
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

describe('KeywordLayerAdapter', () => {
  it('shells out to `swarm-memory grep <query> --json` (not `recall`)', async () => {
    const adapter = makeAdapter();
    const result = await withMode('grep-hits', () => adapter.recall('PAN-8968'));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);

    expect(result.layers_queried).toEqual(['keyword']);
    expect(result.hits).toHaveLength(2);
    expect(result.hits.map((hit) => hit.content)).toEqual([
      'exact keyword match for PAN-8968',
      'second exact keyword match for PAN-8968',
    ]);
  });

  it('parses the real `swarm-memory grep --json` shape: a top-level ARRAY of {scope, collection, hits}, not an object', async () => {
    // This is the whole reason KeywordLayerAdapter can't just reuse
    // VectorLayerAdapter's SwarmMemoryRecallOutput parsing verbatim --
    // `grep --json`'s envelope is structurally different from
    // `recall --json`'s {query, total_hits, scopes} object, confirmed by
    // running the real binary live against this repo's own corpus.
    const adapter = makeAdapter();
    const result = await withMode('grep-hits', () => adapter.recall('anything'));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.hits).toHaveLength(2);
  });

  it('maps provenance with layer "keyword", retrieval_time null (matches interfaces.ts: only semantic search sets retrieved_at), and no score (grep hits score null)', async () => {
    const adapter = makeAdapter();
    const result = await withMode('grep-hits', () => adapter.recall('PAN-8968'));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);

    const [first] = result.hits;
    expect(first?.provenance).toEqual({
      layer: 'keyword',
      source: '/repo/notes/ticket-one.md',
      chunk_span: { index: 0 },
      index_timestamp: '2026-08-11T00:00:00+00:00',
      content_hash: 'keyword1hash',
      embedder: 'nomic-embed-text',
      retrieval_time: null,
    });
    expect(first?.score).toBeUndefined();
  });

  it('returns RecallSuccess with empty hits when swarm-memory grep finds nothing', async () => {
    const adapter = makeAdapter();
    const result = await withMode('grep-empty', () => adapter.recall('nothing-matches-this'));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.hits).toEqual([]);
    expect(result.layers_queried).toEqual(['keyword']);
  });

  it('returns RecallFailure (not empty hits) when swarm-memory exits non-zero', async () => {
    const adapter = makeAdapter();
    const result = await withMode('error', () => adapter.recall('needle'));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected recall to fail');
    expect(result.error.layer).toBe('keyword');
    expect(result.error.code).toBe('swarm_memory_error');
    expect(result.error.message).toContain('qdrant unreachable');
  });

  it('returns RecallFailure loudly (never a silent empty result) when swarm-memory is not installed', async () => {
    const adapter = new KeywordLayerAdapter({ command: '/nonexistent/swarm-memory-binary-xyz' });
    const result = await adapter.recall('needle');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected recall to fail');
    expect(result.error.layer).toBe('keyword');
    expect(result.error.code).toBe('not_installed');
    expect(result.error.message).toContain('swarm-memory is not installed or not on PATH');
  });

  it('returns RecallFailure on timeout instead of hanging', async () => {
    const adapter = makeAdapter({ timeoutMs: 200 });
    const result = await withMode('timeout', () => adapter.recall('needle'));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected recall to fail');
    expect(result.error.layer).toBe('keyword');
    expect(result.error.code).toBe('timeout');
  }, 10_000);

  it('returns RecallFailure when swarm-memory output is not valid JSON', async () => {
    const adapter = makeAdapter();
    const result = await withMode('bad-json', () => adapter.recall('needle'));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected recall to fail');
    expect(result.error.layer).toBe('keyword');
    expect(result.error.code).toBe('invalid_response');
  });

  it('returns RecallFailure for an empty query without shelling out', async () => {
    const adapter = new KeywordLayerAdapter({ command: '/nonexistent/should-not-run' });
    const result = await adapter.recall('   ');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected recall to fail');
    expect(result.error.code).toBe('invalid_query');
  });

  it('has no remember() -- keyword/grep is recall-only, matching FileLayerAdapter/CodeGraphLayerAdapter', () => {
    const adapter: LayerAdapter = makeAdapter();
    expect(adapter.remember).toBeUndefined();
  });
});
