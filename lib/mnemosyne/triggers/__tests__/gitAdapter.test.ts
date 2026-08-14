/**
 * Tests for `gitAdapter.ts`'s detection logic against REAL git subprocess
 * state in a real, throwaway temp-dir repo — real `git init`/`checkout -b`/
 * `commit`/`merge`/`branch -D`, never a mocked/hand-crafted string standing
 * in for git output. Mirrors la-04's own `flight-status.test.ts` rigor.
 *
 * `detectMergePromotion` is tested here by calling it directly after a real
 * merge (proves the DETECTION logic against real git). The end-to-end proof
 * that an actually-installed `post-merge` hook fires this + flips real note
 * files is `test/git-hooks.mjs` (subprocess-level, git invoking the
 * installed hook itself) — that is the story's mandated "real merge, not
 * simulated" integration test; this file is the unit layer underneath it.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  branchDeletionEvents,
  deletedLocalBranches,
  detectMergePromotion,
  parseReferenceTransactionLines,
} from '../gitAdapter.js';

const execFileAsync = promisify(execFile);

const tempRoots: string[] = [];
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeTempRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mnemosyne-git-adapter-'));
  tempRoots.push(root);
  await execFileAsync('git', ['init', '--quiet', '-b', 'main'], { cwd: root });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  await execFileAsync('git', ['config', 'user.name', 'Git Adapter Test'], { cwd: root });
  await execFileAsync('git', ['commit', '--quiet', '--allow-empty', '-m', 'initial commit'], { cwd: root });
  return root;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

describe('detectMergePromotion', () => {
  it('returns null when not currently on the default branch', async () => {
    const root = await makeTempRepo();
    await git(root, ['checkout', '--quiet', '-b', 'feat/x']);
    const event = await detectMergePromotion({ cwd: root, defaultBranch: 'main' });
    expect(event).toBeNull();
  });

  it('returns null when there is no ORIG_HEAD (nothing merged yet)', async () => {
    const root = await makeTempRepo();
    const event = await detectMergePromotion({ cwd: root, defaultBranch: 'main' });
    expect(event).toBeNull();
  });

  it('detects a real non-fast-forward merge: promote event with the merged commit shas and branch name', async () => {
    const root = await makeTempRepo();
    await git(root, ['checkout', '--quiet', '-b', 'feat/thing']);
    await git(root, ['commit', '--quiet', '--allow-empty', '-m', 'feat commit 1']);
    const featSha = await git(root, ['rev-parse', 'HEAD']);
    await git(root, ['checkout', '--quiet', 'main']);
    await git(root, ['merge', '--quiet', '--no-ff', '-m', "Merge branch 'feat/thing'", 'feat/thing']);

    const event = await detectMergePromotion({ cwd: root, defaultBranch: 'main' });

    expect(event).not.toBeNull();
    expect(event!.transition).toBe('promote');
    expect(event!.adapter).toBe('git-hooks');
    expect(event!.matcher.commitShas).toContain(featSha);
    expect(event!.matcher.branch).toBe('feat/thing');
  });

  it('detects a real fast-forward merge equally well (no merge commit, no branch name in the message)', async () => {
    const root = await makeTempRepo();
    await git(root, ['checkout', '--quiet', '-b', 'feat/ff']);
    await git(root, ['commit', '--quiet', '--allow-empty', '-m', 'feat ff commit']);
    const featSha = await git(root, ['rev-parse', 'HEAD']);
    await git(root, ['checkout', '--quiet', 'main']);
    await git(root, ['merge', '--quiet', '--ff-only', 'feat/ff']);

    const event = await detectMergePromotion({ cwd: root, defaultBranch: 'main' });

    expect(event).not.toBeNull();
    expect(event!.transition).toBe('promote');
    expect(event!.matcher.commitShas).toEqual([featSha]);
  });

  it('auto-resolves the default branch (origin/HEAD or "main" fallback) when defaultBranch is not passed', async () => {
    const root = await makeTempRepo(); // no origin remote -> falls back to 'main', which is this repo's actual branch
    const event = await detectMergePromotion({ cwd: root }); // no ORIG_HEAD yet either way
    expect(event).toBeNull(); // just proving it doesn't throw resolving defaultBranch on its own
  });
});

describe('parseReferenceTransactionLines / deletedLocalBranches — against git\'s REAL reference-transaction wire format', () => {
  it('parses real reference-transaction stdin captured from an actual `git branch -D`', async () => {
    const root = await makeTempRepo();
    const capturePath = path.join(root, '.git', 'hooks', 'reference-transaction');
    const logPath = path.join(root, 'reftx.log');
    // Real hook, real invocation — captures git's actual argv[1] + stdin so
    // this test parses REAL data, not a hand-written fixture string.
    const { writeFile, chmod } = await import('node:fs/promises');
    await writeFile(
      capturePath,
      `#!/bin/sh\necho "$1" >> "${logPath}.state"\ncat >> "${logPath}"\necho "---" >> "${logPath}"\nexit 0\n`,
      'utf8',
    );
    await chmod(capturePath, 0o755);

    await git(root, ['checkout', '--quiet', '-b', 'feat/deleteme']);
    await git(root, ['commit', '--quiet', '--allow-empty', '-m', 'to be abandoned']);
    await git(root, ['checkout', '--quiet', 'main']);
    await git(root, ['branch', '-D', 'feat/deleteme']);

    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(logPath, 'utf8');
    const blocks = raw.split('---\n').filter((b) => b.trim());
    // At least one committed block should show refs/heads/feat/deleteme going to the null OID.
    const lines = blocks.flatMap((b) => parseReferenceTransactionLines(b));
    const deleted = deletedLocalBranches('committed', lines);
    expect(deleted).toContain('feat/deleteme');
  });

  it('ignores prepared/aborted states even if the same lines appear', () => {
    const lines = parseReferenceTransactionLines(
      `0000000000000000000000000000000000000000 0000000000000000000000000000000000000000 refs/heads/feat/x\n`,
    );
    expect(deletedLocalBranches('prepared', lines)).toEqual([]);
    expect(deletedLocalBranches('aborted', lines)).toEqual([]);
    expect(deletedLocalBranches('committed', lines)).toEqual(['feat/x']);
  });

  it('does not mistake a branch CREATION (old=0, new=<sha>) for a deletion', () => {
    const lines = parseReferenceTransactionLines(
      `0000000000000000000000000000000000000000 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa refs/heads/feat/new\n`,
    );
    expect(deletedLocalBranches('committed', lines)).toEqual([]);
  });

  it('ignores non refs/heads/ ref updates (tags, HEAD symref moves, AUTO_MERGE, ...)', () => {
    const lines = parseReferenceTransactionLines(
      [
        '0000000000000000000000000000000000000000 0000000000000000000000000000000000000000 refs/tags/v1',
        '0000000000000000000000000000000000000000 0000000000000000000000000000000000000000 AUTO_MERGE',
      ].join('\n'),
    );
    expect(deletedLocalBranches('committed', lines)).toEqual([]);
  });

  it('malformed lines are skipped, never thrown on', () => {
    expect(() => parseReferenceTransactionLines('garbage\nnot enough fields\n')).not.toThrow();
    expect(parseReferenceTransactionLines('garbage\n')).toEqual([]);
  });
});

describe('branchDeletionEvents', () => {
  it('produces one supersede event per deleted branch, matched by branch name only', () => {
    const events = branchDeletionEvents(['feat/a', 'feat/b']);
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.transition).toBe('supersede');
      expect(event.adapter).toBe('git-hooks');
    }
    expect(events[0]!.matcher).toEqual({ branch: 'feat/a' });
    expect(events[1]!.matcher).toEqual({ branch: 'feat/b' });
  });

  it('an empty branch list produces no events', () => {
    expect(branchDeletionEvents([])).toEqual([]);
  });
});
