/**
 * The local-git-hooks `TriggerAdapter` (la-06-lifecycle-trigger-system) —
 * the FIRST concrete adapter against `types.ts`'s pluggable interface,
 * explicitly chosen over GitHub Actions (docs/layer-architecture-v2-plan.md
 * §2/§6 — operator's direct instruction: cost + "I prefer my own build
 * boxes"). Detection only lives here; matching/validating/persisting the
 * status flip is `types.ts`'s `applyLifecycleEvent` + a `MemoryStatusStore`
 * (`notesStore.ts`) — this file never touches either directly.
 *
 * Two real git mechanisms back the two detections below, both verified
 * against real git subprocess behavior (see this dir's `__tests__/
 * gitAdapter.test.ts` and `test/git-hooks.mjs`'s real-merge/real-branch-
 * delete integration test), not assumed from git's documentation alone:
 *
 *   - `detectMergePromotion`: git's `post-merge` hook fires after HEAD moves
 *     via a merge (fast-forward or real merge commit). `ORIG_HEAD` is git's
 *     own record of what HEAD was immediately before the merge, in BOTH
 *     cases — so `git rev-list ORIG_HEAD..HEAD` is exactly the set of
 *     commits the merge introduced, uniformly, without needing to special-
 *     case fast-forward vs. merge-commit.
 *   - `parseReferenceTransactionLines`/`branchDeletionEvents`: git's
 *     `reference-transaction` hook fires for every ref update (including
 *     branch deletes) with `<old-value> <new-value> <ref-name>` lines on
 *     stdin, called multiple times per operation with a `prepared`/
 *     `committed`/`aborted` state as argv[1]. A local branch delete shows up
 *     as a `refs/heads/<name>` line whose new-value is the all-zero OID at
 *     the `committed` state — confirmed by direct experiment (`git branch
 *     -D` against a real repo), not just documentation.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { detectDefaultBranchName, type GitContextOptions } from '../flight-status.js';
import type { LifecycleTriggerEvent } from './types.js';

const execFileAsync = promisify(execFile);

export const ADAPTER_NAME = 'git-hooks';

const NULL_OID_40 = '0'.repeat(40);
const NULL_OID_64 = '0'.repeat(64);

export interface DetectMergePromotionOptions extends GitContextOptions {
  /** Overrides default-branch auto-detection (see `../flight-status.ts`'s `detectDefaultBranchName`). */
  defaultBranch?: string | undefined;
}

/**
 * Meant to be called from an installed `post-merge` hook (see
 * `../../hooks/git/post-merge.mjs`), with `cwd` = the repo the merge just
 * happened in. Returns `null` (nothing to do) when:
 *   - the merge did not land on the repo's default branch (a merge into a
 *     feature branch is not a promotion event — only merges TO the default
 *     branch confirm anything), or
 *   - `ORIG_HEAD` doesn't resolve (e.g. this is the repo's very first
 *     commit, or the hook fired for something other than a real merge).
 *
 * Otherwise returns a `promote` event whose matcher carries BOTH the newly
 * merged commit shas (`git rev-list ORIG_HEAD..HEAD` — robust to squash-less
 * merges, ff or not) AND, best-effort, the merged branch's name parsed from
 * the merge commit's own subject line (git's default `Merge branch
 * '<name>'` / GitHub's default `Merge pull request #N from <owner>/<name>`
 * message shapes) — a fallback for the case where the PR was rebased before
 * merging, so an entry's recorded commit sha no longer exists but its
 * recorded branch name still matches.
 */
export async function detectMergePromotion(
  options: DetectMergePromotionOptions = {},
): Promise<LifecycleTriggerEvent | null> {
  const cwd = options.cwd ?? process.cwd();
  const gitBin = options.gitBin ?? 'git';
  const timeout = options.timeoutMs ?? 5_000;

  const run = (args: string[]) => execFileAsync(gitBin, args, { cwd, timeout });

  let currentBranch: string;
  try {
    currentBranch = (await run(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  } catch {
    return null; // no resolvable branch (e.g. detached HEAD) — not a promotion-eligible state
  }

  const defaultBranch = options.defaultBranch ?? (await detectDefaultBranchName({ cwd, gitBin, timeoutMs: timeout }));
  if (currentBranch !== defaultBranch) return null; // merge landed somewhere other than the default branch

  let mergedShas: string[];
  try {
    const { stdout } = await run(['rev-list', 'ORIG_HEAD..HEAD']);
    mergedShas = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return null; // no ORIG_HEAD (e.g. repo's first-ever commit) — nothing was merged
  }
  if (mergedShas.length === 0) return null;

  let mergedBranch: string | undefined;
  try {
    const subject = (await run(['log', '-1', '--pretty=%s'])).stdout.trim();
    const branchMatch = /Merge branch '([^']+)'/.exec(subject);
    const prMatch = /Merge pull request #\d+ from [^/]+\/(\S+)/.exec(subject);
    mergedBranch = branchMatch?.[1] ?? prMatch?.[1] ?? undefined;
  } catch {
    mergedBranch = undefined;
  }

  return {
    transition: 'promote',
    matcher: { ...(mergedBranch !== undefined ? { branch: mergedBranch } : {}), commitShas: mergedShas },
    adapter: ADAPTER_NAME,
    detail: `merge to '${defaultBranch}', ${mergedShas.length} new commit(s)${mergedBranch ? ` from '${mergedBranch}'` : ''}`,
  };
}

interface RefTransactionLine {
  oldValue: string;
  newValue: string;
  refname: string;
}

/** Parses git's `reference-transaction` hook stdin format (`<old> <new> <ref>` per line). Never throws on malformed input — a line that doesn't split into exactly 3 fields is silently skipped, never crashes a hook that must always exit 0. */
export function parseReferenceTransactionLines(stdin: string): RefTransactionLine[] {
  const lines: RefTransactionLine[] = [];
  for (const raw of stdin.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length !== 3) continue;
    const [oldValue, newValue, refname] = parts;
    lines.push({ oldValue: oldValue as string, newValue: newValue as string, refname: refname as string });
  }
  return lines;
}

/**
 * From a `reference-transaction` hook's `state` (argv[1]) and parsed stdin
 * lines, returns the local branch names that were just DELETED. Only acts
 * on `state === 'committed'` — `prepared`/`aborted` are not a completed
 * change (and, per git's contract, exiting non-zero during `prepared` can
 * abort the transaction outright, so a hook built on this function must
 * never risk that by treating `prepared` as actionable).
 */
export function deletedLocalBranches(state: string, lines: readonly RefTransactionLine[]): string[] {
  if (state !== 'committed') return [];
  const deleted: string[] = [];
  for (const line of lines) {
    if (line.newValue !== NULL_OID_40 && line.newValue !== NULL_OID_64) continue;
    if (!line.refname.startsWith('refs/heads/')) continue;
    deleted.push(line.refname.slice('refs/heads/'.length));
  }
  return deleted;
}

/** Turns deleted branch names into `supersede` events — one per branch, matched by branch name only (a deleted branch has no "new" commit shas to match on). */
export function branchDeletionEvents(branches: readonly string[]): LifecycleTriggerEvent[] {
  return branches.map((branch) => ({
    transition: 'supersede',
    matcher: { branch },
    adapter: ADAPTER_NAME,
    detail: `local branch '${branch}' deleted without merging`,
  }));
}
