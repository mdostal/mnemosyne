/**
 * Tests for `gitVerify.ts` against REAL git subprocess state in a real,
 * throwaway temp-dir repo — real `git init`/`checkout -b`/`commit`/`merge`,
 * never a mocked/hand-crafted string standing in for git output. Mirrors
 * la-04's `flight-status.test.ts` / la-06's `gitAdapter.test.ts` rigor.
 *
 * These are the independent-verification primitives la-11's audit is built
 * on: every classification `provisionalDrift.ts` makes has to be traceable
 * back to one of these real commands' real exit code/output.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { grepMergeCommitMessage, isAncestorOf, refExists } from '../gitVerify.js';

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
  const root = await mkdtemp(path.join(tmpdir(), 'mnemosyne-audit-gitverify-'));
  tempRoots.push(root);
  await git(root, ['init', '--quiet', '-b', 'main']);
  await git(root, ['config', 'user.email', 'audit-test@example.com']);
  await git(root, ['config', 'user.name', 'Audit GitVerify Test']);
  await git(root, ['commit', '--quiet', '--allow-empty', '-m', 'initial commit']);
  return root;
}

describe('isAncestorOf', () => {
  it('returns "ancestor" with real merge-base evidence when the commit really is merged', async () => {
    const repo = await makeTempRepo();
    await git(repo, ['checkout', '--quiet', '-b', 'feat/x']);
    await git(repo, ['commit', '--quiet', '--allow-empty', '-m', 'feat commit']);
    const sha = await git(repo, ['rev-parse', 'HEAD']);
    await git(repo, ['checkout', '--quiet', 'main']);
    await git(repo, ['merge', '--quiet', '--no-ff', '-m', "Merge branch 'feat/x'", 'feat/x']);

    const result = await isAncestorOf(sha, 'main', { cwd: repo });
    expect(result.outcome).toBe('ancestor');
    expect(result.evidence.command).toEqual(['git', 'merge-base', '--is-ancestor', sha, 'main']);
    expect(result.evidence.cwd).toBe(repo);
    expect(result.evidence.result).toContain(sha);
  });

  it('returns "not-ancestor" (never "ancestor") for a known commit that has not merged', async () => {
    const repo = await makeTempRepo();
    await git(repo, ['checkout', '--quiet', '-b', 'feat/still-open']);
    await git(repo, ['commit', '--quiet', '--allow-empty', '-m', 'still open']);
    const sha = await git(repo, ['rev-parse', 'HEAD']);

    const result = await isAncestorOf(sha, 'main', { cwd: repo });
    expect(result.outcome).toBe('not-ancestor');
  });

  it('returns "unknown-object" (never guesses) for a commit sha this repo has never seen', async () => {
    const repo = await makeTempRepo();
    const foreignSha = 'a'.repeat(40);

    const result = await isAncestorOf(foreignSha, 'main', { cwd: repo });
    expect(result.outcome).toBe('unknown-object');
    expect(result.evidence.result.toLowerCase()).toContain('not');
  });
});

describe('refExists', () => {
  it('finds a real local branch', async () => {
    const repo = await makeTempRepo();
    await git(repo, ['checkout', '--quiet', '-b', 'feat/live']);
    await git(repo, ['checkout', '--quiet', 'main']);

    const result = await refExists('feat/live', { cwd: repo });
    expect(result.exists).toBe(true);
    expect(result.ref).toBe('refs/heads/feat/live');
  });

  it('reports false for a branch that was never created', async () => {
    const repo = await makeTempRepo();
    const result = await refExists('feat/never-existed', { cwd: repo });
    expect(result.exists).toBe(false);
    expect(result.ref).toBeNull();
  });

  it('reports false for a real branch that was deleted', async () => {
    const repo = await makeTempRepo();
    await git(repo, ['checkout', '--quiet', '-b', 'feat/gone']);
    await git(repo, ['checkout', '--quiet', 'main']);
    await git(repo, ['branch', '-D', 'feat/gone']);

    const result = await refExists('feat/gone', { cwd: repo });
    expect(result.exists).toBe(false);
  });
});

describe('grepMergeCommitMessage', () => {
  it('finds a real merge-commit message on the default branch naming the branch', async () => {
    const repo = await makeTempRepo();
    // Simulate a squash-merge-then-delete: the message names the branch, but
    // there is no structural merge relationship.
    await git(repo, ['commit', '--quiet', '--allow-empty', '-m', "Merge branch 'feat/ghost'"]);

    const result = await grepMergeCommitMessage('feat/ghost', 'main', { cwd: repo });
    expect(result.found).toBe(true);
    expect(result.evidence.stdout ?? '').toContain('feat/ghost');
  });

  it('finds a GitHub-style "Merge pull request" message naming the branch', async () => {
    const repo = await makeTempRepo();
    await git(repo, ['commit', '--quiet', '--allow-empty', '-m', 'Merge pull request #42 from someorg/feat/hosted-merge']);

    const result = await grepMergeCommitMessage('feat/hosted-merge', 'main', { cwd: repo });
    expect(result.found).toBe(true);
  });

  it('reports false when no commit on the default branch mentions the branch', async () => {
    const repo = await makeTempRepo();
    const result = await grepMergeCommitMessage('feat/never-mentioned', 'main', { cwd: repo });
    expect(result.found).toBe(false);
  });
});
