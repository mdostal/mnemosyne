import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { VectorLayerAdapter } from '../VectorLayerAdapter.js';

const execFileAsync = promisify(execFile);

const FAKE_SWARM_MEMORY = fileURLToPath(
  new URL('./fixtures/fake-swarm-memory.mjs', import.meta.url),
);

function makeAdapter(
  mode: string,
  options: { timeoutMs?: number; indexTimeoutMs?: number; notesDirectory?: string } = {},
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

  describe('remember', () => {
    let notesDir: string;

    afterEach(async () => {
      if (notesDir) {
        await rm(notesDir, { recursive: true, force: true });
      }
    });

    async function makeWritableAdapter(): Promise<VectorLayerAdapter> {
      notesDir = await mkdtemp(path.join(tmpdir(), 'mnemosyne-vector-remember-'));
      return makeAdapter('hits', { notesDirectory: notesDir });
    }

    it('writes a real note file and returns non-stub provenance on success', async () => {
      const adapter = await makeWritableAdapter();
      const result = await withMode('index-upserted', () =>
        adapter.remember('a real memory to write', { scope: 'project', tag: 'test-note' }),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      expect(result.layer).toBe('vector');
      expect(result.provenance.source).not.toContain('stub:remember');
      expect(result.provenance.source).toContain(notesDir);
      expect(result.provenance.content_hash).toHaveLength(64); // sha256 hex
      expect(result.provenance.index_timestamp).not.toBeNull();

      const written = await readFile(result.provenance.source, 'utf8');
      expect(written).toContain('a real memory to write');
    });

    it('resolves the collection via a real `swarm-memory config` call, not a guess', async () => {
      const adapter = await makeWritableAdapter();
      const result = await withMode('index-upserted', () =>
        adapter.remember('scope-routed memory', { scope: 'project' }),
      );

      expect(result.ok).toBe(true);
      // The fixture's config command maps scope 'project' -> 'test_collection';
      // a hardcoded/guessed collection would not reflect that mapping.
    });

    it('returns RememberFailure (not a fake success) when config resolution fails', async () => {
      const adapter = await makeWritableAdapter();
      const result = await withMode('config-error', () => adapter.remember('should not write'));

      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error('expected remember to fail');
      }
      expect(result.error.layer).toBe('vector');
      expect(result.error.message).toContain('config resolution failed');
    });

    it('returns RememberFailure and keeps the note file when the index command errors', async () => {
      const adapter = await makeWritableAdapter();
      const result = await withMode('index-error', () => adapter.remember('should fail loudly'));

      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error('expected remember to fail');
      }
      expect(result.error.layer).toBe('vector');
      expect(result.error.message).toContain('index command errored');
      expect(result.error.message).toContain('kept at');
    });

    it('returns RememberFailure (not a silent success) when zero chunks are confirmed upserted', async () => {
      const adapter = await makeWritableAdapter();
      const result = await withMode('index-zero', () => adapter.remember('nothing gets upserted'));

      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error('expected remember to fail');
      }
      expect(result.error.code).toBe('no_chunks_upserted');
    });

    it('returns RememberFailure for empty content without writing anything', async () => {
      notesDir = await mkdtemp(path.join(tmpdir(), 'mnemosyne-vector-remember-'));
      const adapter = makeAdapter('hits', { notesDirectory: notesDir });
      const result = await adapter.remember('   ');

      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error('expected remember to fail');
      }
      expect(result.error.code).toBe('invalid_content');
    });

    // --- la-04-flight-status-schema: status + source_ref wiring -------------

    it('auto-detects status + source_ref from real cwd git state when not passed explicitly', async () => {
      const adapter = await makeWritableAdapter();
      const result = await withMode('index-upserted', () =>
        adapter.remember('a memory with auto-detected flight status', {
          scope: 'project',
          tag: 'flight-status-auto',
        }),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.message);

      // This test itself runs with cwd inside the real mnemosyne git repo —
      // assert against REAL git state, not an assumed value.
      const { stdout: branchOut } = await execFileAsync('git', [
        'rev-parse',
        '--abbrev-ref',
        'HEAD',
      ]);
      const { stdout: shaOut } = await execFileAsync('git', ['rev-parse', 'HEAD']);
      const realBranch = branchOut.trim();
      const realSha = shaOut.trim();

      expect(result.status).toBeDefined();
      expect(['provisional', 'confirmed']).toContain(result.status);
      expect(result.source_ref).toEqual({ branch: realBranch, commit_sha: realSha, pr_url: null });

      const written = await readFile(result.provenance.source, 'utf8');
      expect(written).toContain(`branch=${realBranch}`);
      expect(written).toContain(`commit=${realSha}`);
    });

    it('uses an explicit status + sourceRef verbatim instead of auto-detecting', async () => {
      const adapter = await makeWritableAdapter();
      const sourceRef = { branch: 'feat/explicit-override', commit_sha: 'a'.repeat(40), pr_url: 'https://example.com/pr/1' };
      const result = await withMode('index-upserted', () =>
        adapter.remember('explicit flight status', { scope: 'project', status: 'provisional', sourceRef }),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.message);
      expect(result.status).toBe('provisional');
      expect(result.source_ref).toEqual(sourceRef);
    });

    it('rejects an explicit status without a matching explicit sourceRef (no partial override)', async () => {
      const adapter = await makeWritableAdapter();
      const result = await withMode('index-upserted', () =>
        adapter.remember('half-specified flight status', { scope: 'project', status: 'confirmed' }),
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected remember to fail');
      expect(result.error.code).toBe('invalid_flight_status');
    });

    it('fails loudly (RememberFailure, no write) when git-context auto-detection is ambiguous', async () => {
      const nonGitCwd = await mkdtemp(path.join(tmpdir(), 'mnemosyne-vector-remember-nongit-'));
      try {
        const adapter = await makeWritableAdapter();
        const result = await withMode('index-upserted', () =>
          adapter.remember('should not write without resolvable git context', { scope: 'project', cwd: nonGitCwd }),
        );

        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('expected remember to fail');
        expect(result.error.code).toBe('git_context_unresolvable');

        const notesDirEntries = await readdir(notesDir);
        expect(notesDirEntries).toEqual([]); // never even got to the write step
      } finally {
        await rm(nonGitCwd, { recursive: true, force: true });
      }
    });
  });
});
