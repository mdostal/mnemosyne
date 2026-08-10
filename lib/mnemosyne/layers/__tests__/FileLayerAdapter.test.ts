import { createHash } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileLayerAdapter } from '../FileLayerAdapter.js';

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mnemosyne-file-layer-'));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await chmod(root, 0o700).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe('FileLayerAdapter', () => {
  it('returns matching lines with file path and line number provenance', async () => {
    const root = await makeTempRoot();
    const filePath = path.join(root, 'notes.md');
    await writeFile(filePath, ['alpha', 'target line', 'omega target'].join('\n'), 'utf8');

    const adapter = new FileLayerAdapter(root);
    const result = await adapter.recall('target');

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    expect(result).toMatchObject({
      query: 'target',
      scope: 'project',
      intent: 'narrow',
      layers_queried: ['file'],
      layers_skipped: [],
      escalated: false,
      degraded: false,
    });
    expect(result.hits).toHaveLength(2);
    expect(result.hits.map((hit) => hit.content)).toEqual(['target line', 'omega target']);
    expect(result.hits[0]?.provenance).toMatchObject({
      layer: 'file',
      source: filePath,
      chunk_span: { index: 2 },
    });
    expect(result.hits[1]?.provenance.chunk_span).toEqual({ index: 3 });
  });

  it('sets file-layer null provenance fields and retrieval_time', async () => {
    const root = await makeTempRoot();
    await writeFile(path.join(root, 'source.ts'), 'const needle = true;\n', 'utf8');

    const adapter = new FileLayerAdapter(root);
    const result = await adapter.recall('needle', { scope: 'enterprise', intent: 'broad' });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const provenance = result.hits[0]?.provenance;
    expect(provenance).toBeDefined();
    expect(provenance?.index_timestamp).toBeNull();
    expect(provenance?.embedder).toBeNull();
    expect(provenance?.retrieval_time).toEqual(expect.any(String));
    expect(new Date(provenance?.retrieval_time ?? '').toString()).not.toBe('Invalid Date');
  });

  it('computes content_hash as the sha256 of the matching line', async () => {
    const root = await makeTempRoot();
    const line = 'hash this exact line';
    await writeFile(path.join(root, 'hash.md'), `${line}\n`, 'utf8');

    const adapter = new FileLayerAdapter(root);
    const result = await adapter.recall('exact');

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    expect(result.hits[0]?.provenance.content_hash).toBe(
      createHash('sha256').update(line).digest('hex'),
    );
  });

  it('returns RecallFailure for an unreachable directory', async () => {
    const missingRoot = path.join(tmpdir(), `mnemosyne-missing-${Date.now()}`);
    const adapter = new FileLayerAdapter(missingRoot);

    const result = await adapter.recall('needle');

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected recall to fail');
    }

    expect(result.error).toMatchObject({
      layer: 'file',
      code: 'ENOENT',
    });
    expect(result.error.message).toContain('unreachable');
  });

  it('returns RecallFailure instead of empty hits when traversal is denied', async () => {
    const root = await makeTempRoot();
    await chmod(root, 0o000);
    const adapter = new FileLayerAdapter(root);

    const result = await adapter.recall('needle');

    await chmod(root, 0o700);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected recall to fail');
    }

    expect(result.error.layer).toBe('file');
    expect(result.error.code).toMatch(/EACCES|EPERM/);
  });
});
