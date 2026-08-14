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
  branchDeletionEventsWithOutcome,
  deletedLocalBranches,
  deriveAbandonedBranchOutcome,
  detectMergePromotion,
  parseReferenceTransactionLines,
  resolveBranchSha,
  stashPendingBranchSha,
  takePendingBranchSha,
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

    // la-08-lifecycle-outcome-feedback: a real non-fast-forward merge carries
    // an outcome whose detail correctly identifies the merge shape and lists
    // the real commit message(s) that landed — derived from actual git
    // output, not synthesized/boilerplate text.
    expect(event!.outcome).toBeDefined();
    expect(event!.outcome!.detail?.mergeShape).toBe('merge-commit');
    expect(event!.outcome!.summary).toContain('feat/thing');
    expect(event!.outcome!.summary).toContain('feat commit 1');
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

    // la-08: a fast-forward merge is correctly distinguished from a real
    // merge commit, and the commit message still shows up in the outcome
    // even though there's no "Merge branch" subject line to parse for it.
    expect(event!.outcome).toBeDefined();
    expect(event!.outcome!.detail?.mergeShape).toBe('fast-forward');
    expect(event!.outcome!.summary).toContain('fast-forward');
    expect(event!.outcome!.summary).toContain('feat ff commit');
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

  it('produces no outcome by default — outcome derivation is a separate, opt-in step (branchDeletionEventsWithOutcome)', () => {
    const events = branchDeletionEvents(['feat/a']);
    expect(events[0]!.outcome).toBeUndefined();
  });
});

/**
 * la-08-lifecycle-outcome-feedback — the supersede-side outcome derivation.
 *
 * IMPORTANT, confirmed by direct experiment against real git (not assumed
 * from documentation): `git branch -D`'s `reference-transaction` hook lines
 * report the OLD value as the null OID too — at EVERY state (`prepared`,
 * `committed`, even `aborted`) — because `branch -D` deletes without a
 * compare-and-swap check, so git's own transaction record never carries a
 * real old value to report (unlike `git update-ref -d <ref> <old-sha>`,
 * which DOES surface a real old value when the caller supplies one to
 * verify against). This means `deletedLocalBranches`'s reference-transaction
 * stdin data alone can never recover the abandoned branch's last commit for
 * the realistic `branch -D` case.
 *
 * The fix verified here: at the `prepared` state (BEFORE the ref is
 * actually removed), `git rev-parse --verify refs/heads/<branch>` STILL
 * resolves — so `resolveBranchSha` + `stashPendingBranchSha` capture it
 * then, and `takePendingBranchSha` reads it back once the SAME branch name
 * is confirmed actually deleted at `committed` (a small per-repo scratch
 * file inside the real git dir bridges the two — hooks fire as separate
 * processes per state, so this can't be done in memory).
 */
describe('resolveBranchSha — real git, resolves a local branch ref to its current commit sha', () => {
  it('resolves an existing branch', async () => {
    const root = await makeTempRepo();
    await git(root, ['checkout', '--quiet', '-b', 'feat/resolve-me']);
    await git(root, ['commit', '--quiet', '--allow-empty', '-m', 'work']);
    const sha = await git(root, ['rev-parse', 'HEAD']);

    await expect(resolveBranchSha('feat/resolve-me', { cwd: root })).resolves.toBe(sha);
  });

  it('returns undefined (never throws) for a branch that does not exist', async () => {
    const root = await makeTempRepo();
    await expect(resolveBranchSha('feat/no-such-branch', { cwd: root })).resolves.toBeUndefined();
  });
});

describe('stashPendingBranchSha / takePendingBranchSha — bridges a branch sha across the prepared -> committed hook-process boundary', () => {
  it('round-trips a stashed sha, and consumes it (a second take returns undefined)', async () => {
    const root = await makeTempRepo();
    await stashPendingBranchSha('feat/x', 'a'.repeat(40), { cwd: root });

    await expect(takePendingBranchSha('feat/x', { cwd: root })).resolves.toBe('a'.repeat(40));
    await expect(takePendingBranchSha('feat/x', { cwd: root })).resolves.toBeUndefined();
  });

  it('taking a branch that was never stashed returns undefined, never throws', async () => {
    const root = await makeTempRepo();
    await expect(takePendingBranchSha('feat/never-stashed', { cwd: root })).resolves.toBeUndefined();
  });

  it(
    'the REAL scenario: resolveBranchSha + stash BEFORE a real `git branch -D`, take AFTER — ' +
      'proves the stash survives a real forced branch delete even though git’s own ' +
      'reference-transaction data for that delete reports no usable old value',
    async () => {
      const root = await makeTempRepo();
      await git(root, ['checkout', '--quiet', '-b', 'feat/stash-real']);
      await git(root, ['commit', '--quiet', '--allow-empty', '-m', 'work before abandoning']);
      const sha = await resolveBranchSha('feat/stash-real', { cwd: root });
      expect(sha).toBeDefined();
      await stashPendingBranchSha('feat/stash-real', sha!, { cwd: root });

      await git(root, ['checkout', '--quiet', 'main']);
      await git(root, ['branch', '-D', 'feat/stash-real']); // real forced delete

      // The branch no longer resolves via git itself...
      await expect(resolveBranchSha('feat/stash-real', { cwd: root })).resolves.toBeUndefined();
      // ...but the sha captured BEFORE the delete is still recoverable.
      await expect(takePendingBranchSha('feat/stash-real', { cwd: root })).resolves.toBe(sha);
    },
  );
});

describe('deriveAbandonedBranchOutcome — real git, resolves the abandoned branch\'s last commit message', () => {
  it('summarizes the branch deletion including the real last commit subject, given a resolved sha', async () => {
    const root = await makeTempRepo();
    await git(root, ['checkout', '--quiet', '-b', 'feat/abandoned-outcome']);
    await git(root, ['commit', '--quiet', '--allow-empty', '-m', 'try approach X (later abandoned)']);
    const lastSha = await git(root, ['rev-parse', 'HEAD']);
    await git(root, ['checkout', '--quiet', 'main']);

    const outcome = await deriveAbandonedBranchOutcome('feat/abandoned-outcome', lastSha, { cwd: root });

    expect(outcome.summary).toContain('feat/abandoned-outcome');
    expect(outcome.summary).toContain('try approach X (later abandoned)');
    expect(outcome.detail?.lastCommitSubject).toBe('try approach X (later abandoned)');
  });

  it('falls back to a still-informative summary when no sha was available at all (undefined), never throws', async () => {
    const root = await makeTempRepo();
    const outcome = await deriveAbandonedBranchOutcome('feat/gone', undefined, { cwd: root });

    expect(outcome.summary).toContain('feat/gone');
    expect(outcome.summary.length).toBeGreaterThan(0);
    expect(outcome.detail?.lastCommitSubject).toBeNull();
  });

  it('falls back gracefully when a sha was captured but no longer resolves to a commit (e.g. pruned), never throws', async () => {
    const root = await makeTempRepo();
    const outcome = await deriveAbandonedBranchOutcome('feat/pruned', '0'.repeat(40), { cwd: root });

    expect(outcome.summary).toContain('feat/pruned');
    expect(outcome.summary.length).toBeGreaterThan(0);
  });
});

describe('branchDeletionEventsWithOutcome — ties resolveBranchSha/stash + deriveAbandonedBranchOutcome together', () => {
  it('produces one supersede event per deleted branch, each carrying a real outcome', async () => {
    const root = await makeTempRepo();
    await git(root, ['checkout', '--quiet', '-b', 'feat/full-flow']);
    await git(root, ['commit', '--quiet', '--allow-empty', '-m', 'work that will be abandoned']);
    const lastSha = await git(root, ['rev-parse', 'HEAD']);
    await git(root, ['checkout', '--quiet', 'main']);

    const events = await branchDeletionEventsWithOutcome([{ branch: 'feat/full-flow', sha: lastSha }], {
      cwd: root,
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.transition).toBe('supersede');
    expect(events[0]!.matcher).toEqual({ branch: 'feat/full-flow' });
    expect(events[0]!.outcome?.summary).toContain('work that will be abandoned');
  });

  it('an entry with no resolvable sha still produces a real (sparser) event, not a throw', async () => {
    const root = await makeTempRepo();
    const events = await branchDeletionEventsWithOutcome([{ branch: 'feat/no-sha' }], { cwd: root });

    expect(events).toHaveLength(1);
    expect(events[0]!.outcome?.summary).toContain('feat/no-sha');
  });
});
