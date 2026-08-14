/**
 * Tests for `provisionalDrift.ts`'s classification + conservative
 * auto-remediation logic. Uses a real, throwaway temp-dir git repo for every
 * git-state assertion (never a mocked git call) combined with an in-memory
 * `MemoryStatusStore` (same fake pattern as `triggers/__tests__/engine.test.ts`)
 * so these stay fast unit tests — the full real-notes-directory,
 * real-`applyLifecycleEvent`-write-through path is covered by the mandated
 * subprocess integration test at `test/lifecycle-compliance-audit.mjs`.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { SourceRef, Status } from '../../interfaces.js';
import type { MemoryEntryRef, MemoryStatusStore } from '../../triggers/types.js';
import { detectStaleProvisional } from '../provisionalDrift.js';

const execFileAsync = promisify(execFile);

const tempRoots: string[] = [];
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

async function makeTempRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mnemosyne-audit-drift-'));
  tempRoots.push(root);
  await git(root, ['init', '--quiet', '-b', 'main']);
  await git(root, ['config', 'user.email', 'audit-drift-test@example.com']);
  await git(root, ['config', 'user.name', 'Audit Drift Test']);
  await git(root, ['commit', '--quiet', '--allow-empty', '-m', 'initial commit']);
  return root;
}

function ref(branch: string, commit_sha: string): SourceRef {
  return { branch, commit_sha, pr_url: null };
}

class FakeStore implements MemoryStatusStore {
  constructor(public entries: MemoryEntryRef[]) {}

  async findByStatus(status: Status): Promise<MemoryEntryRef[]> {
    return this.entries.filter((e) => e.status === status);
  }

  async updateStatus(entry: MemoryEntryRef, to: Status): Promise<void> {
    const found = this.entries.find((e) => e.id === entry.id);
    if (!found) throw new Error(`FakeStore: no entry with id ${entry.id}`);
    found.status = to;
  }
}

describe('detectStaleProvisional', () => {
  it('classifies a real, actually-merged commit as verified-merged and auto-promotes it with logged evidence', async () => {
    const repo = await makeTempRepo();
    await git(repo, ['checkout', '--quiet', '-b', 'feat/real-merge']);
    await git(repo, ['commit', '--quiet', '--allow-empty', '-m', 'real work']);
    const sha = await git(repo, ['rev-parse', 'HEAD']);
    await git(repo, ['checkout', '--quiet', 'main']);
    await git(repo, ['merge', '--quiet', '--no-ff', '-m', "Merge branch 'feat/real-merge'", 'feat/real-merge']);

    const store = new FakeStore([{ id: 'note-1', status: 'provisional', source_ref: ref('feat/real-merge', sha) }]);
    const result = await detectStaleProvisional(store, { cwd: repo, defaultBranch: 'main', autoRemediate: true });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.verification.classification).toBe('verified-merged');
    expect(result.findings[0]!.verification.evidence.length).toBeGreaterThan(0);

    expect(result.remediations).toHaveLength(1);
    expect(result.remediations[0]!.entryId).toBe('note-1');
    expect(result.remediations[0]!.from).toBe('provisional');
    expect(result.remediations[0]!.to).toBe('confirmed');
    expect(result.remediations[0]!.evidence.length).toBeGreaterThan(0);
    expect(result.remediations[0]!.evidence.some((e) => e.command.includes('merge-base'))).toBe(true);

    expect(store.entries[0]!.status).toBe('confirmed');
  });

  it('does NOT report or promote a still-open (legitimately unmerged) branch', async () => {
    const repo = await makeTempRepo();
    await git(repo, ['checkout', '--quiet', '-b', 'feat/still-open']);
    await git(repo, ['commit', '--quiet', '--allow-empty', '-m', 'in progress']);
    const sha = await git(repo, ['rev-parse', 'HEAD']);
    await git(repo, ['checkout', '--quiet', 'main']);

    const store = new FakeStore([{ id: 'note-2', status: 'provisional', source_ref: ref('feat/still-open', sha) }]);
    const result = await detectStaleProvisional(store, { cwd: repo, defaultBranch: 'main', autoRemediate: true });

    expect(result.findings).toHaveLength(0);
    expect(result.remediations).toHaveLength(0);
    expect(store.entries[0]!.status).toBe('provisional');
  });

  it('flags (never promotes) an ambiguous case: unknown commit + deleted branch + a real merge-commit message naming it', async () => {
    const repo = await makeTempRepo();
    await git(repo, ['commit', '--quiet', '--allow-empty', '-m', "Merge branch 'feat/ghost'"]);
    const foreignSha = 'b'.repeat(40);

    const store = new FakeStore([{ id: 'note-3', status: 'provisional', source_ref: ref('feat/ghost', foreignSha) }]);
    const result = await detectStaleProvisional(store, { cwd: repo, defaultBranch: 'main', autoRemediate: true });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.verification.classification).toBe('ambiguous');
    expect(result.findings[0]!.verification.reason).toBeTruthy();
    expect(result.remediations).toHaveLength(0);
    expect(store.entries[0]!.status).toBe('provisional');
  });

  it('treats a genuinely untraceable entry (no commit, no branch, no message trace) as out-of-scope: not a finding, not a remediation', async () => {
    const repo = await makeTempRepo();
    const foreignSha = 'c'.repeat(40);

    const store = new FakeStore([{ id: 'note-4', status: 'provisional', source_ref: ref('feat/some-other-repo', foreignSha) }]);
    const result = await detectStaleProvisional(store, { cwd: repo, defaultBranch: 'main', autoRemediate: true });

    expect(result.findings).toHaveLength(0);
    expect(result.remediations).toHaveLength(0);
    expect(result.outOfScopeCount).toBe(1);
  });

  it('never auto-remediates when autoRemediate is false, even for a verified-merged entry — still reports the finding', async () => {
    const repo = await makeTempRepo();
    await git(repo, ['checkout', '--quiet', '-b', 'feat/report-only']);
    await git(repo, ['commit', '--quiet', '--allow-empty', '-m', 'report only']);
    const sha = await git(repo, ['rev-parse', 'HEAD']);
    await git(repo, ['checkout', '--quiet', 'main']);
    await git(repo, ['merge', '--quiet', '--no-ff', '-m', "Merge branch 'feat/report-only'", 'feat/report-only']);

    const store = new FakeStore([{ id: 'note-5', status: 'provisional', source_ref: ref('feat/report-only', sha) }]);
    const result = await detectStaleProvisional(store, { cwd: repo, defaultBranch: 'main', autoRemediate: false });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.verification.classification).toBe('verified-merged');
    expect(result.remediations).toHaveLength(0);
    expect(store.entries[0]!.status).toBe('provisional');
  });
});
