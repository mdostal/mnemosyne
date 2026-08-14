/**
 * Unit tests for `lib/mnemosyne/flight-status.ts` (la-04-flight-status-schema).
 *
 * Per the story's TDD methodology + the operator's testing-bar decision for
 * this story specifically: unit tests only, covering exactly the two things
 * the acceptance criteria hinge on —
 *   1. status-transition validity (provisional->confirmed,
 *      provisional->superseded are the only valid transitions; every other
 *      transition, including no-ops and unknown values, must be rejected —
 *      not silently allowed)
 *   2. git-context auto-detection resolved from REAL `git` subprocess calls
 *      against a real (throwaway, temp-dir) git repo — never assumed/mocked
 *      string data — including the "fail loudly on ambiguous state"
 *      contract (detached HEAD).
 *
 * The real subprocess *integration* test (branch -> provisional write ->
 * merge -> assert promotion) and live dogfooding are explicitly la-05's
 * testing bar, not this story's — see the story YAML's `note:` field.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  STATUSES,
  InvalidStatusTransitionError,
  GitContextDetectionError,
  assertValidStatusTransition,
  autoDetectWriteContext,
  detectDefaultBranchName,
  detectGitContext,
  isStatus,
  isValidStatusTransition,
  resolveDefaultStatus,
} from '../flight-status.js';
import type { Status } from '../interfaces.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

describe('isValidStatusTransition / assertValidStatusTransition', () => {
  it.each([
    ['provisional', 'confirmed'],
    ['provisional', 'superseded'],
  ] satisfies Array<[Status, Status]>)('accepts %s -> %s', (from, to) => {
    expect(isValidStatusTransition(from, to)).toBe(true);
    expect(() => assertValidStatusTransition(from, to)).not.toThrow();
  });

  it.each([
    ['provisional', 'provisional'],
    ['confirmed', 'provisional'],
    ['confirmed', 'superseded'],
    ['confirmed', 'confirmed'],
    ['superseded', 'provisional'],
    ['superseded', 'confirmed'],
    ['superseded', 'superseded'],
  ] satisfies Array<[Status, Status]>)('rejects %s -> %s', (from, to) => {
    expect(isValidStatusTransition(from, to)).toBe(false);
    expect(() => assertValidStatusTransition(from, to)).toThrow(InvalidStatusTransitionError);
  });

  it('the thrown error names the attempted transition, not a generic message', () => {
    try {
      assertValidStatusTransition('confirmed', 'superseded');
      throw new Error('expected assertValidStatusTransition to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidStatusTransitionError);
      const err = error as InvalidStatusTransitionError;
      expect(err.from).toBe('confirmed');
      expect(err.to).toBe('superseded');
      expect(err.message).toContain('confirmed');
      expect(err.message).toContain('superseded');
    }
  });

  it('an invalid transition never silently no-ops — it always throws, never returns a falsy value instead', () => {
    // isValidStatusTransition() is the query form (returns boolean); this
    // test pins down that assertValidStatusTransition() (the enforcement
    // form) actually throws rather than e.g. logging and continuing.
    expect(() => assertValidStatusTransition('superseded', 'confirmed')).toThrow();
  });
});

describe('isStatus / STATUSES', () => {
  it('STATUSES enumerates exactly the three documented values', () => {
    expect(STATUSES).toEqual(['provisional', 'confirmed', 'superseded']);
  });

  it.each(STATUSES)('isStatus(%s) is true', (status) => {
    expect(isStatus(status)).toBe(true);
  });

  it.each(['pending', 'reviewed', 'in-progress', '', 'CONFIRMED', 42, null, undefined])(
    'isStatus(%s) is false for anything outside the enum',
    (value) => {
      expect(isStatus(value)).toBe(false);
    },
  );
});

describe('resolveDefaultStatus', () => {
  it('resolves confirmed on the default branch', () => {
    expect(resolveDefaultStatus('main', 'main')).toBe('confirmed');
  });

  it('resolves provisional on any non-default branch', () => {
    expect(resolveDefaultStatus('feat/whatever', 'main')).toBe('provisional');
    expect(resolveDefaultStatus('dev', 'main')).toBe('provisional');
  });

  it('respects a non-"main" default branch (e.g. this repo\'s own dev-canonical convention)', () => {
    expect(resolveDefaultStatus('dev', 'dev')).toBe('confirmed');
    expect(resolveDefaultStatus('main', 'dev')).toBe('provisional');
  });
});

// ---------------------------------------------------------------------------
// Git-context auto-detection — real `git` subprocess calls against a real,
// throwaway temp-dir repo. Never mocked/assumed.
// ---------------------------------------------------------------------------

const tempRoots: string[] = [];
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeTempRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mnemosyne-flight-status-'));
  tempRoots.push(root);
  await execFileAsync('git', ['init', '--quiet', '-b', 'main'], { cwd: root });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  await execFileAsync('git', ['config', 'user.name', 'Flight Status Test'], { cwd: root });
  await execFileAsync('git', ['commit', '--quiet', '--allow-empty', '-m', 'initial commit'], { cwd: root });
  return root;
}

async function currentRealCommitSha(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd });
  return stdout.trim();
}

describe('detectGitContext', () => {
  it('resolves branch + commit_sha from real git state on the default branch', async () => {
    const root = await makeTempRepo();
    const expectedSha = await currentRealCommitSha(root);

    const result = await detectGitContext({ cwd: root });

    expect(result.branch).toBe('main');
    expect(result.commit_sha).toBe(expectedSha);
    expect(result.commit_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.pr_url).toBeNull();
  });

  it('resolves a non-default feature branch by its real name, not a guess', async () => {
    const root = await makeTempRepo();
    await execFileAsync('git', ['checkout', '--quiet', '-b', 'feat/la-04-flight-status'], { cwd: root });
    const expectedSha = await currentRealCommitSha(root);

    const result = await detectGitContext({ cwd: root });

    expect(result.branch).toBe('feat/la-04-flight-status');
    expect(result.commit_sha).toBe(expectedSha);
  });

  it('reflects a real new commit — commit_sha changes after committing, not stale', async () => {
    const root = await makeTempRepo();
    const before = await detectGitContext({ cwd: root });
    await execFileAsync('git', ['commit', '--quiet', '--allow-empty', '-m', 'second commit'], { cwd: root });
    const after = await detectGitContext({ cwd: root });

    expect(after.commit_sha).not.toBe(before.commit_sha);
    expect(after.commit_sha).toBe(await currentRealCommitSha(root));
  });

  it('fails loudly (does not guess) on a detached HEAD', async () => {
    const root = await makeTempRepo();
    const sha = await currentRealCommitSha(root);
    await execFileAsync('git', ['checkout', '--quiet', sha], { cwd: root });

    await expect(detectGitContext({ cwd: root })).rejects.toBeInstanceOf(GitContextDetectionError);
  });

  it('fails loudly when cwd is not inside a git repo at all', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mnemosyne-flight-status-non-git-'));
    tempRoots.push(root);

    await expect(detectGitContext({ cwd: root })).rejects.toBeInstanceOf(GitContextDetectionError);
  });

  it('fails loudly when the git binary cannot be found', async () => {
    const root = await makeTempRepo();

    await expect(
      detectGitContext({ cwd: root, gitBin: '/nonexistent/git-binary-xyz' }),
    ).rejects.toBeInstanceOf(GitContextDetectionError);
  });
});

describe('detectDefaultBranchName', () => {
  it('falls back to "main" when there is no origin remote (not an ambiguous-state error)', async () => {
    const root = await makeTempRepo();
    const name = await detectDefaultBranchName({ cwd: root });
    expect(name).toBe('main');
  });

  it('resolves the real origin/HEAD symref when one is configured', async () => {
    const upstream = await makeTempRepo();
    const clone = await mkdtemp(path.join(tmpdir(), 'mnemosyne-flight-status-clone-'));
    tempRoots.push(clone);
    await execFileAsync('git', ['clone', '--quiet', upstream, clone]);

    const name = await detectDefaultBranchName({ cwd: clone });
    expect(name).toBe('main');
  });
});

describe('autoDetectWriteContext', () => {
  it('resolves status=confirmed + real source_ref on the default branch', async () => {
    const root = await makeTempRepo();
    const expectedSha = await currentRealCommitSha(root);

    const result = await autoDetectWriteContext({ cwd: root, defaultBranch: 'main' });

    expect(result.status).toBe('confirmed');
    expect(result.source_ref).toEqual({ branch: 'main', commit_sha: expectedSha, pr_url: null });
  });

  it('resolves status=provisional + real source_ref on a non-default branch', async () => {
    const root = await makeTempRepo();
    await execFileAsync('git', ['checkout', '--quiet', '-b', 'feat/something'], { cwd: root });
    const expectedSha = await currentRealCommitSha(root);

    const result = await autoDetectWriteContext({ cwd: root, defaultBranch: 'main' });

    expect(result.status).toBe('provisional');
    expect(result.source_ref.branch).toBe('feat/something');
    expect(result.source_ref.commit_sha).toBe(expectedSha);
  });

  it('auto-resolves the default branch itself when defaultBranch is not passed', async () => {
    const root = await makeTempRepo(); // no origin remote -> falls back to 'main'
    const result = await autoDetectWriteContext({ cwd: root });
    expect(result.status).toBe('confirmed'); // repo's own branch IS 'main', the resolved fallback default
  });

  it('propagates GitContextDetectionError (does not swallow it into a guessed status)', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mnemosyne-flight-status-non-git-2-'));
    tempRoots.push(root);

    await expect(autoDetectWriteContext({ cwd: root })).rejects.toBeInstanceOf(GitContextDetectionError);
  });
});
