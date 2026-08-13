import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { CodeGraphLayerAdapter } from '../CodeGraphLayerAdapter.js';

const FAKE_SWARM_MEMORY = fileURLToPath(
  new URL('./fixtures/fake-swarm-memory.mjs', import.meta.url),
);

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mnemosyne-code-graph-layer-'));
  tempRoots.push(root);
  return root;
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

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await chmod(root, 0o700).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe('CodeGraphLayerAdapter', () => {
  it('shells out to swarm-memory graph impact and returns dependent files', async () => {
    const adapter = new CodeGraphLayerAdapter({
      command: FAKE_SWARM_MEMORY,
      dbPath: '/nonexistent/graph.sqlite',
    });

    const result = await withMode('graph-hits', () => adapter.recall('src/core.ts'));

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    expect(result.layers_queried).toEqual(['code-graph']);
    expect(result.degraded).toBe(false);
    expect(result.hits.map((hit) => hit.provenance.source)).toEqual([
      'src/consumer.ts',
      'src/feature.ts',
    ]);
    expect(result.hits[0]?.content).toContain('depends_on');
  });

  it('sets graph provenance with no chunk span and no embedder', async () => {
    const adapter = new CodeGraphLayerAdapter({
      command: FAKE_SWARM_MEMORY,
      dbPath: '/nonexistent/graph.sqlite',
    });

    const result = await withMode('graph-hits', () =>
      adapter.recall('src/core.ts', { scope: 'enterprise', intent: 'broad' }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    expect(result.hits[0]?.provenance).toEqual({
      layer: 'code-graph',
      source: 'src/consumer.ts',
      chunk_span: null,
      index_timestamp: null,
      content_hash: null,
      embedder: null,
      retrieval_time: expect.any(String),
    });
    expect(new Date(result.hits[0]?.provenance.retrieval_time ?? '').toString()).not.toBe(
      'Invalid Date',
    );
  });

  it('falls back to reading the swarm-memory SQLite graph when the graph CLI is unavailable', async () => {
    const root = await makeTempRoot();
    const dbPath = path.join(root, 'graph.sqlite');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE nodes (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL DEFAULT 'file',
        created_at TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT '',
        pointer TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE edges (
        src TEXT NOT NULL,
        predicate TEXT NOT NULL,
        dst TEXT NOT NULL,
        origin TEXT NOT NULL DEFAULT 'manual',
        created_at TEXT NOT NULL,
        PRIMARY KEY (src, predicate, dst)
      );
      CREATE INDEX idx_edges_dst ON edges (dst);
    `);
    const createdAt = '2026-08-09T00:00:00Z';
    db.prepare('INSERT INTO nodes (id, type, created_at) VALUES (?, ?, ?)').run(
      'src/core.ts',
      'file',
      createdAt,
    );
    db.prepare('INSERT INTO nodes (id, type, created_at) VALUES (?, ?, ?)').run(
      'src/consumer.ts',
      'file',
      createdAt,
    );
    db.prepare('INSERT INTO nodes (id, type, created_at) VALUES (?, ?, ?)').run(
      'src/feature.ts',
      'file',
      createdAt,
    );
    db.prepare('INSERT INTO edges (src, predicate, dst, origin, created_at) VALUES (?, ?, ?, ?, ?)').run(
      'src/consumer.ts',
      'depends_on',
      'src/core.ts',
      'scan:imports',
      createdAt,
    );
    db.prepare('INSERT INTO edges (src, predicate, dst, origin, created_at) VALUES (?, ?, ?, ?, ?)').run(
      'src/feature.ts',
      'implements',
      'src/consumer.ts',
      'scan:imports',
      createdAt,
    );
    db.close();

    const adapter = new CodeGraphLayerAdapter({
      command: '/nonexistent/swarm-memory-binary-xyz',
      dbPath,
    });
    const result = await adapter.recall('src/core.ts');

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    expect(result.layers_queried).toEqual(['code-graph']);
    expect(result.degraded).toBe(true);
    expect(result.hits.map((hit) => hit.provenance.source)).toEqual([
      'src/consumer.ts',
      'src/feature.ts',
    ]);
    expect(result.hits[0]?.provenance.index_timestamp).toBe(createdAt);
    expect(result.hits[0]?.provenance.embedder).toBeNull();
  });

  it('returns RecallFailure when neither the graph CLI nor SQLite graph can be read', async () => {
    const adapter = new CodeGraphLayerAdapter({
      command: '/nonexistent/swarm-memory-binary-xyz',
      dbPath: '/nonexistent/graph.sqlite',
    });

    const result = await adapter.recall('src/core.ts');

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected recall to fail');
    }

    expect(result.error.layer).toBe('code-graph');
    expect(result.error.code).toBe('graph_unavailable');
  });
});
