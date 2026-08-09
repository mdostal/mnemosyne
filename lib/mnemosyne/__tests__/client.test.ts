import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MnemosyneClient } from '../client.js';

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mnemosyne-client-'));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('MnemosyneClient', () => {
  it('constructs successfully', () => {
    expect(() => new MnemosyneClient()).not.toThrow();
  });

  it('recall(query, "project") queries the file layer and returns RecallSuccess', async () => {
    const root = await makeTempRoot();
    await writeFile(path.join(root, 'notes.md'), 'a target line\n', 'utf8');

    const client = new MnemosyneClient({ rootDirectory: root });
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
    const client = new MnemosyneClient({ rootDirectory: root });

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
    const client = new MnemosyneClient({ rootDirectory: missingRoot });

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

    const client = new MnemosyneClient({ rootDirectory: root });
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

    const client = new MnemosyneClient({ rootDirectory: root });
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
    const client = new MnemosyneClient({ rootDirectory: root });

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
    const client = new MnemosyneClient({ rootDirectory: root });

    const result = await client.remember({ text: 'remember this' }, 'project', 'vector');

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(result.layer).toBe('vector');
    expect(result.provenance.layer).toBe('vector');
  });
});
