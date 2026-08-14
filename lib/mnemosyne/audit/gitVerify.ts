/**
 * Real-git independent-verification primitives for the memory-lifecycle
 * compliance audit (la-11-memory-lifecycle-compliance-audit, epic:
 * mnemosyne-layer-architecture-v2).
 *
 * Every function here runs one real `git` subprocess and returns BOTH the
 * verdict and the exact `Evidence` (command/cwd/result/stdout) that produced
 * it — never a guess, never a heuristic dressed up as a fact. This is the
 * layer `provisionalDrift.ts`'s classification logic is built on; nothing
 * above this module invents its own git-state opinions.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Evidence } from './types.js';

const execFileAsync = promisify(execFile);

export interface GitVerifyOptions {
  cwd: string;
  gitBin?: string | undefined;
  timeoutMs?: number | undefined;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runGit(args: readonly string[], options: GitVerifyOptions): Promise<RunResult> {
  const gitBin = options.gitBin ?? 'git';
  try {
    const { stdout, stderr } = await execFileAsync(gitBin, args as string[], {
      cwd: options.cwd,
      timeout: options.timeoutMs ?? 5_000,
    });
    return { code: 0, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    const err = error as { code?: number | string; stdout?: string; stderr?: string };
    const code = typeof err.code === 'number' ? err.code : 1;
    return { code, stdout: (err.stdout ?? '').trim(), stderr: (err.stderr ?? '').trim() };
  }
}

function makeEvidence(
  args: readonly string[],
  cwd: string,
  result: string,
  stdout?: string,
): Evidence {
  return { command: ['git', ...args], cwd, result, ...(stdout !== undefined ? { stdout } : {}) };
}

/** The three real outcomes of `git merge-base --is-ancestor <sha> <ref>` — see `types.ts`'s `DriftClassification` doc comment for how each maps to a classification. */
export type AncestryOutcome = 'ancestor' | 'not-ancestor' | 'unknown-object';

export interface AncestryResult {
  outcome: AncestryOutcome;
  evidence: Evidence;
}

/**
 * `git merge-base --is-ancestor <sha> <ref>` distinguishes all three
 * outcomes from its own exit code, in ONE real subprocess call:
 *   - exit 0  -> `sha` really is in `ref`'s ancestry (structurally merged).
 *   - exit 1  -> `sha` is a known, valid commit, just not an ancestor of
 *     `ref` (still legitimately in-flight).
 *   - anything else (typically 128, "fatal: Not a valid commit name") ->
 *     this repo has never seen `sha` at all. Any exit code other than 0/1 is
 *     treated as `unknown-object` — the conservative default, since guessing
 *     "merged" from an unrecognized exit code would be exactly the kind of
 *     silent wrong fix this story exists to prevent.
 */
export async function isAncestorOf(sha: string, ref: string, options: GitVerifyOptions): Promise<AncestryResult> {
  const args = ['merge-base', '--is-ancestor', sha, ref];
  const res = await runGit(args, options);

  if (res.code === 0) {
    return {
      outcome: 'ancestor',
      evidence: makeEvidence(
        args,
        options.cwd,
        `exit 0 — '${sha}' IS an ancestor of '${ref}' (structurally reachable from its history)`,
      ),
    };
  }
  if (res.code === 1) {
    return {
      outcome: 'not-ancestor',
      evidence: makeEvidence(
        args,
        options.cwd,
        `exit 1 — '${sha}' is a known commit but is NOT an ancestor of '${ref}'`,
      ),
    };
  }
  return {
    outcome: 'unknown-object',
    evidence: makeEvidence(
      args,
      options.cwd,
      `exit ${res.code} — this repo does not recognize '${sha}' as a valid object (${res.stderr || 'no stderr'})`,
    ),
  };
}

export interface RefExistsResult {
  exists: boolean;
  ref: string | null;
  evidence: Evidence;
}

/**
 * Real existence check for a branch, local first then remote-tracking, via
 * `git show-ref --verify --quiet`. Used to tell "still legitimately open
 * (just not merged yet, or not fetched here)" apart from "genuinely gone".
 */
export async function refExists(branch: string, options: GitVerifyOptions): Promise<RefExistsResult> {
  const localRef = `refs/heads/${branch}`;
  const localArgs = ['show-ref', '--verify', '--quiet', localRef];
  const local = await runGit(localArgs, options);
  if (local.code === 0) {
    return {
      exists: true,
      ref: localRef,
      evidence: makeEvidence(localArgs, options.cwd, `exit 0 — local branch '${localRef}' exists`),
    };
  }

  const remoteRef = `refs/remotes/origin/${branch}`;
  const remoteArgs = ['show-ref', '--verify', '--quiet', remoteRef];
  const remote = await runGit(remoteArgs, options);
  if (remote.code === 0) {
    return {
      exists: true,
      ref: remoteRef,
      evidence: makeEvidence(remoteArgs, options.cwd, `exit 0 — remote-tracking branch '${remoteRef}' exists`),
    };
  }

  return {
    exists: false,
    ref: null,
    evidence: makeEvidence(
      [...localArgs, '(and', ...remoteArgs, ')'],
      options.cwd,
      `neither '${localRef}' nor '${remoteRef}' exists`,
    ),
  };
}

export interface GrepMergeCommitResult {
  found: boolean;
  evidence: Evidence;
}

/**
 * A real (not fabricated) `git log` search of `defaultBranch`'s own history
 * for a merge-commit message naming `branch` — mirrors `gitAdapter.ts`'s own
 * `detectMergePromotion` message-parsing patterns (`Merge branch '<name>'` /
 * GitHub's `Merge pull request #N from <owner>/<name>`), run RETROSPECTIVELY
 * here instead of at hook-fire time. This is a real, git-verifiable, in-repo
 * signal — but a message string is not structural proof of ancestry, so
 * callers must never auto-remediate off this alone (see
 * `provisionalDrift.ts`'s `ambiguous` classification, which is exactly
 * "this positive signal exists but ancestry doesn't structurally confirm
 * it" — flagged for human review, never promoted).
 */
export async function grepMergeCommitMessage(
  branch: string,
  defaultBranch: string,
  options: GitVerifyOptions,
): Promise<GrepMergeCommitResult> {
  const args = [
    'log',
    defaultBranch,
    `--grep=Merge branch '${branch}'`,
    `--grep=from [^ ]*/${branch}$`,
    '--extended-regexp',
    '--oneline',
    '--max-count=1',
  ];
  const res = await runGit(args, options);
  const found = res.code === 0 && res.stdout.length > 0;
  return {
    found,
    evidence: makeEvidence(
      args,
      options.cwd,
      found
        ? `found a merge-commit message on '${defaultBranch}' naming '${branch}'`
        : `no merge-commit message on '${defaultBranch}' names '${branch}'`,
      res.stdout || undefined,
    ),
  };
}
