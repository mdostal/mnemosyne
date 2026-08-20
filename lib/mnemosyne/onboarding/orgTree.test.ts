import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { OrgTreeEntry } from './orgTree.js';
import { appendOrgTreeEntry, DEFAULT_ORG_TREE_PATH, listOrgTreeEntries } from './orgTree.js';

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A fresh temp directory to hold this test's own org-tree.yaml -- never the operator's real home. */
function makeTempOrgTreePath(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'mnemosyne-org-tree-'));
  tempRoots.push(root);
  return path.join(root, 'org-tree.yaml');
}

function makeEntry(overrides: Partial<OrgTreeEntry> = {}): OrgTreeEntry {
  return {
    repo_path: '/Users/mdostal/Documents/work/pantheon/mnemosyne',
    collection: 'project-mnemosyne',
    scope: 'project',
    org_tree_path: 'org/project/mnemosyne',
    needs_override: false,
    onboarded_at: '2026-08-19T00:00:00Z',
    ...overrides,
  };
}

describe('DEFAULT_ORG_TREE_PATH', () => {
  it('resolves to ~/.mnemosyne/org-tree.yaml -- mirrors level0.ts DEFAULT_LEVEL0_PATH convention', () => {
    expect(DEFAULT_ORG_TREE_PATH).toBe(path.join(homedir(), '.mnemosyne', 'org-tree.yaml'));
  });
});

describe('appendOrgTreeEntry / listOrgTreeEntries', () => {
  it('creates the file with a single entries: [...] list, given a fresh machine with no org-tree.yaml', () => {
    const orgTreePath = makeTempOrgTreePath();
    expect(existsSync(orgTreePath)).toBe(false);

    appendOrgTreeEntry(makeEntry(), orgTreePath);

    expect(existsSync(orgTreePath)).toBe(true);
    expect(listOrgTreeEntries(orgTreePath)).toEqual([makeEntry()]);
  });

  it('writes real YAML, not JSON', () => {
    const orgTreePath = makeTempOrgTreePath();
    appendOrgTreeEntry(makeEntry(), orgTreePath);

    const raw = readFileSync(orgTreePath, 'utf8');
    expect(raw.trim().startsWith('{')).toBe(false);
    expect(raw).toContain('entries:');
    expect(raw).toContain('repo_path: /Users/mdostal/Documents/work/pantheon/mnemosyne');
  });

  it('replaces the existing entry for the SAME repo_path in place (not duplicated) on re-onboard with different fields', () => {
    const orgTreePath = makeTempOrgTreePath();
    appendOrgTreeEntry(makeEntry({ collection: 'project-mnemosyne' }), orgTreePath);
    appendOrgTreeEntry(makeEntry({ collection: 'renamed-collection', scope: 'enterprise' }), orgTreePath);

    const entries = listOrgTreeEntries(orgTreePath);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(makeEntry({ collection: 'renamed-collection', scope: 'enterprise' }));
  });

  it('replaces the entry in its original array position, not moved to the end', () => {
    const orgTreePath = makeTempOrgTreePath();
    const x = makeEntry({ repo_path: '/repos/x' });
    const y = makeEntry({ repo_path: '/repos/y' });
    appendOrgTreeEntry(x, orgTreePath);
    appendOrgTreeEntry(y, orgTreePath);
    appendOrgTreeEntry(makeEntry({ repo_path: '/repos/x', collection: 'x-v2' }), orgTreePath);

    const entries = listOrgTreeEntries(orgTreePath);
    expect(entries.map((e) => e.repo_path)).toEqual(['/repos/x', '/repos/y']);
    expect(entries[0]!.collection).toBe('x-v2');
  });

  it('appends a new entry for a NEW repo_path, ending with 3 entries and existing entries byte-unchanged', () => {
    const orgTreePath = makeTempOrgTreePath();
    const x = makeEntry({ repo_path: '/repos/x' });
    const y = makeEntry({ repo_path: '/repos/y', collection: 'project-y' });
    appendOrgTreeEntry(x, orgTreePath);
    appendOrgTreeEntry(y, orgTreePath);
    const afterXY = readFileSync(orgTreePath, 'utf8');

    const z = makeEntry({ repo_path: '/repos/z', collection: 'project-z' });
    appendOrgTreeEntry(z, orgTreePath);

    const entries = listOrgTreeEntries(orgTreePath);
    expect(entries).toHaveLength(3);
    expect(entries).toEqual(expect.arrayContaining([x, y, z]));

    // X and Y's own serialized YAML text is untouched by Z's append: the whole
    // pre-Z file content reappears verbatim as a prefix of the post-Z file.
    const afterXYZ = readFileSync(orgTreePath, 'utf8');
    expect(afterXYZ.startsWith(afterXY)).toBe(true);
  });

  it('returns an empty array, never throws, when listOrgTreeEntries is called on a machine with no org-tree.yaml at all', () => {
    const orgTreePath = makeTempOrgTreePath();
    expect(existsSync(orgTreePath)).toBe(false);
    expect(() => listOrgTreeEntries(orgTreePath)).not.toThrow();
    expect(listOrgTreeEntries(orgTreePath)).toEqual([]);
  });

  it('reads fresh from disk on every call -- no module-level caching (mirrors level0.ts / persona-store-repo-local.ts contract)', () => {
    const orgTreePath = makeTempOrgTreePath();
    appendOrgTreeEntry(makeEntry({ collection: 'v1' }), orgTreePath);
    expect(listOrgTreeEntries(orgTreePath)[0]!.collection).toBe('v1');

    appendOrgTreeEntry(makeEntry({ collection: 'v2' }), orgTreePath);
    expect(listOrgTreeEntries(orgTreePath)[0]!.collection).toBe('v2');
  });

  describe('concurrency (real cross-process contention)', () => {
    const workerPath = fileURLToPath(new URL('./fixtures/orgtree-worker.ts', import.meta.url));

    async function tsxLoaderPath(): Promise<string> {
      const resolved = import.meta.resolve('tsx');
      return fileURLToPath(resolved);
    }

    async function runWorker(orgTreePath: string, repoPath: string, barrierPath: string): Promise<void> {
      const loader = await tsxLoaderPath();
      return new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--import', loader, workerPath, orgTreePath, repoPath, barrierPath],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.on('error', reject);
        child.on('exit', (code) => {
          if (code !== 0) {
            reject(new Error(`orgtree-worker exited with code ${code}. stderr:\n${stderr}`));
            return;
          }
          resolve();
        });
      });
    }

    async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
      const start = Date.now();
      while (!predicate()) {
        if (Date.now() - start > timeoutMs) {
          throw new Error('waitFor: timed out');
        }
        await new Promise((r) => setTimeout(r, 5));
      }
    }

    it(
      'two appendOrgTreeEntry() calls racing concurrently (real subprocess-level) both land -- never a lost update',
      async () => {
        const orgTreePath = makeTempOrgTreePath();
        const barrierRoot = mkdtempSync(path.join(tmpdir(), 'mnemosyne-org-tree-barrier-'));
        tempRoots.push(barrierRoot);
        const barrierPath = path.join(barrierRoot, 'go');

        // Each worker writes <barrierPath>.<pid>.ready as soon as it's up and polling -- we
        // can't know their pids ahead of time, so wait for TWO *.ready files to appear before
        // releasing the shared barrier, maximizing the two workers' actual call-time overlap.
        const readyCount = () =>
          existsSync(barrierRoot) ? readdirSync(barrierRoot).filter((f) => f.endsWith('.ready')).length : 0;

        const workerA = runWorker(orgTreePath, '/repos/concurrent-a', barrierPath);
        const workerB = runWorker(orgTreePath, '/repos/concurrent-b', barrierPath);

        await waitFor(() => readyCount() >= 2, 5_000);
        writeFileSync(barrierPath, '', 'utf8');

        await Promise.all([workerA, workerB]);

        const entries = listOrgTreeEntries(orgTreePath);
        const repoPaths = entries.map((e) => e.repo_path).sort();
        expect(repoPaths).toEqual(['/repos/concurrent-a', '/repos/concurrent-b']);
      },
      20_000,
    );
  });
});
