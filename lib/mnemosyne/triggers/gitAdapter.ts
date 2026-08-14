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
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { detectDefaultBranchName, type GitContextOptions } from '../flight-status.js';
import type { LifecycleOutcome, LifecycleTriggerEvent } from './types.js';

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

  const outcome = await deriveMergeOutcome(run, { mergedShas, mergedBranch, defaultBranch });

  return {
    transition: 'promote',
    matcher: { ...(mergedBranch !== undefined ? { branch: mergedBranch } : {}), commitShas: mergedShas },
    adapter: ADAPTER_NAME,
    detail: `merge to '${defaultBranch}', ${mergedShas.length} new commit(s)${mergedBranch ? ` from '${mergedBranch}'` : ''}`,
    outcome,
  };
}

/**
 * (la-08-lifecycle-outcome-feedback) Derives the promote side's outcome/
 * lesson data — deliberately built ONLY from what a git-hook adapter can
 * realistically supply at post-merge time (plan §3): whether the merge was
 * fast-forward or a real merge commit, and the real commit message(s) that
 * landed. Never assumes a CI/test-result shape that doesn't exist for a
 * local-git-hook adapter — see this file's own top-of-file doc comment on
 * why git-hooks is the first adapter, not GitHub Actions.
 *
 * Merge shape is determined from `HEAD`'s own parent count (`git rev-list
 * --parents -n 1 HEAD`): a fast-forward merge leaves `HEAD` as a normal,
 * single-parent commit (the feature branch's own tip); a real (`--no-ff`)
 * merge leaves `HEAD` as a merge commit with 2+ parents. Best-effort: any
 * git failure here still returns a real (if sparser) outcome rather than
 * throwing — outcome derivation must never block the promote event itself
 * from being returned (this story's risk mitigation).
 */
async function deriveMergeOutcome(
  run: (args: string[]) => Promise<{ stdout: string }>,
  info: { mergedShas: readonly string[]; mergedBranch: string | undefined; defaultBranch: string },
): Promise<LifecycleOutcome> {
  let mergeShape: 'fast-forward' | 'merge-commit' = 'fast-forward';
  try {
    const { stdout } = await run(['rev-list', '--parents', '-n', '1', 'HEAD']);
    const tokens = stdout.trim().split(/\s+/).filter(Boolean);
    if (tokens.length > 2) mergeShape = 'merge-commit'; // <sha> <parent1> <parent2> [...]
  } catch {
    // leave the fast-forward default — sparser but still real
  }

  let commitSubjects: string[] = [];
  try {
    const { stdout } = await run(['log', '--reverse', '--pretty=%s', 'ORIG_HEAD..HEAD']);
    commitSubjects = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    commitSubjects = [];
  }

  const summary =
    `merge to '${info.defaultBranch}' (${mergeShape}), ${info.mergedShas.length} commit(s)` +
    `${info.mergedBranch ? ` from '${info.mergedBranch}'` : ''}` +
    `${commitSubjects.length > 0 ? `: ${commitSubjects.join('; ')}` : ''}`;

  return {
    summary,
    detail: { mergeShape, commitSubjects, branch: info.mergedBranch ?? null, defaultBranch: info.defaultBranch },
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
 * The line-level filter shared by `deletedLocalBranches` (gated to
 * `committed` only) and la-08's `prepared`-state sha pre-resolution below:
 * `refs/heads/<name>` lines whose new-value is the null OID — the SAME
 * shape git reports whether the ref update is actually finished
 * (`committed`) or only about to happen (`prepared`), which is exactly what
 * makes it usable at `prepared` time too (see this file's la-08 section
 * doc comment).
 */
function branchHeadRefsGoingToNull(lines: readonly RefTransactionLine[]): string[] {
  const names: string[] = [];
  for (const line of lines) {
    if (line.newValue !== NULL_OID_40 && line.newValue !== NULL_OID_64) continue;
    if (!line.refname.startsWith('refs/heads/')) continue;
    names.push(line.refname.slice('refs/heads/'.length));
  }
  return names;
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
  return branchHeadRefsGoingToNull(lines);
}

/**
 * (la-08-lifecycle-outcome-feedback) The `prepared`-state counterpart:
 * candidate local branch names about to be deleted, valid at ANY state
 * (deliberately not gated to `committed` — see this file's la-08 section
 * doc comment for why the hook needs this at `prepared`, before the ref is
 * actually removed). Read-only by itself; a hook calling this at `prepared`
 * must still never do anything that could abort the transaction (only
 * read-only git queries + writing its OWN scratch file, never touching the
 * ref update itself).
 */
export function candidateDeletedBranchNames(lines: readonly RefTransactionLine[]): string[] {
  return branchHeadRefsGoingToNull(lines);
}

/** Turns deleted branch names into `supersede` events — one per branch, matched by branch name only (a deleted branch has no "new" commit shas to match on). No `outcome` is attached here — see `branchDeletionEventsWithOutcome` for the la-08 variant that derives one. */
export function branchDeletionEvents(branches: readonly string[]): LifecycleTriggerEvent[] {
  return branches.map((branch) => ({
    transition: 'supersede',
    matcher: { branch },
    adapter: ADAPTER_NAME,
    detail: `local branch '${branch}' deleted without merging`,
  }));
}

// --- la-08-lifecycle-outcome-feedback: supersede-side outcome derivation ---
//
// CONFIRMED BY DIRECT EXPERIMENT (temp repo, real `git branch -D`, not
// assumed from documentation): a forced branch delete's own
// `reference-transaction` line reports OLD-VALUE as the null OID too — at
// EVERY state (`prepared`, `committed`, even `aborted`), because `branch -D`
// deletes without a compare-and-swap check, so git's own transaction record
// never carries a real old value to hand the hook. (`git update-ref -d <ref>
// <old-sha>`, which explicitly supplies an old value to verify, DOES surface
// a real one — but that's not the command an operator actually runs.) So
// `deletedLocalBranches`'s reference-transaction stdin data alone can NEVER
// recover an abandoned branch's last commit for the realistic `branch -D`
// case that matters here.
//
// The fix, also confirmed by direct experiment: at the `prepared` state —
// BEFORE the ref is actually removed — `git rev-parse --verify
// refs/heads/<branch>` still resolves. So `resolveBranchSha` +
// `stashPendingBranchSha` capture the sha then; `takePendingBranchSha` reads
// it back once `deletedLocalBranches` confirms, at `committed`, that the
// SAME branch name was actually deleted. A small per-repo scratch file
// inside the real git dir (resolved via `--git-path`, so it follows
// worktrees the same way `bin/mnemosyne-install-git-hooks`'s `resolveHooksDir`
// does) bridges the two calls — the hook fires as a genuinely separate OS
// process per state, so nothing can be held in memory across them.

const PENDING_BRANCH_SHAS_GIT_RELPATH = 'mnemosyne-la08-pending-branch-shas.json';

async function resolveGitPath(relPath: string, options: GitContextOptions): Promise<string> {
  const cwd = options.cwd ?? process.cwd();
  const gitBin = options.gitBin ?? 'git';
  const timeout = options.timeoutMs ?? 5_000;
  const { stdout } = await execFileAsync(gitBin, ['rev-parse', '--git-path', relPath], { cwd, timeout });
  return path.resolve(cwd, stdout.trim());
}

/** Resolves `branch`'s current commit sha via `git rev-parse --verify refs/heads/<branch>`. `undefined` (never throws) if the branch doesn't exist/resolve. */
export async function resolveBranchSha(branch: string, options: GitContextOptions = {}): Promise<string | undefined> {
  const cwd = options.cwd ?? process.cwd();
  const gitBin = options.gitBin ?? 'git';
  const timeout = options.timeoutMs ?? 5_000;
  try {
    const { stdout } = await execFileAsync(gitBin, ['rev-parse', '--verify', `refs/heads/${branch}`], { cwd, timeout });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Stashes `sha` for `branch` into a small per-repo JSON scratch file inside
 * the real git dir (see this section's doc comment for why this exists).
 * Best-effort and silent — a failure here (unwritable git dir, corrupt
 * existing file, ...) must never block the `reference-transaction` hook
 * that calls it, so it never throws.
 */
export async function stashPendingBranchSha(branch: string, sha: string, options: GitContextOptions = {}): Promise<void> {
  try {
    const file = await resolveGitPath(PENDING_BRANCH_SHAS_GIT_RELPATH, options);
    let existing: Record<string, string> = {};
    try {
      existing = JSON.parse(await readFile(file, 'utf8')) as Record<string, string>;
    } catch {
      existing = {}; // missing/corrupt scratch file — start fresh, never throw
    }
    existing[branch] = sha;
    await writeFile(file, JSON.stringify(existing), 'utf8');
  } catch {
    // best-effort — see doc comment above
  }
}

/**
 * Reads back and CONSUMES (deletes) a previously-stashed sha for `branch`.
 * `undefined` if none was stashed — never throws. Consuming the entry
 * matters: it stops a stale stash from leaking into a later, unrelated
 * delete of a same-named branch.
 */
export async function takePendingBranchSha(branch: string, options: GitContextOptions = {}): Promise<string | undefined> {
  try {
    const file = await resolveGitPath(PENDING_BRANCH_SHAS_GIT_RELPATH, options);
    let existing: Record<string, string>;
    try {
      existing = JSON.parse(await readFile(file, 'utf8')) as Record<string, string>;
    } catch {
      return undefined; // no scratch file yet / corrupt — nothing was stashed
    }
    const sha = existing[branch];
    if (sha === undefined) return undefined;
    delete existing[branch];
    await writeFile(file, JSON.stringify(existing), 'utf8');
    return sha;
  } catch {
    return undefined;
  }
}

/**
 * (la-08-lifecycle-outcome-feedback) Derives the supersede side's outcome/
 * lesson data for one abandoned branch: an abandoned branch has no "new
 * commits" to describe the way a merge does, so the best available signal
 * is the branch's own last commit message, resolved from `sha` (see
 * `resolveBranchSha`/`stashPendingBranchSha` above for how the caller gets
 * one for a real `git branch -D`). `sha` is optional — when the caller has
 * none available (never stashed, or git rev-parse failed at `prepared`
 * time), this still returns a real, if sparser, outcome rather than
 * throwing (this story's risk mitigation: never block on having rich data).
 */
export async function deriveAbandonedBranchOutcome(
  branch: string,
  sha: string | undefined,
  options: GitContextOptions = {},
): Promise<LifecycleOutcome> {
  let lastCommitSubject: string | undefined;
  if (sha) {
    const cwd = options.cwd ?? process.cwd();
    const gitBin = options.gitBin ?? 'git';
    const timeout = options.timeoutMs ?? 5_000;
    try {
      const { stdout } = await execFileAsync(gitBin, ['log', '-1', '--pretty=%s', sha], { cwd, timeout });
      lastCommitSubject = stdout.trim() || undefined;
    } catch {
      lastCommitSubject = undefined;
    }
  }

  const summary = lastCommitSubject
    ? `branch '${branch}' deleted without merging — last commit: "${lastCommitSubject}"`
    : `branch '${branch}' deleted without merging (no further commit detail available)`;

  return {
    summary,
    detail: { branch, lastCommitSha: sha ?? null, lastCommitSubject: lastCommitSubject ?? null },
  };
}

/**
 * The la-08 counterpart to `branchDeletionEvents`: takes `{branch, sha?}`
 * pairs instead of bare names, and attaches a real `outcome` (via
 * `deriveAbandonedBranchOutcome`) to each resulting `supersede` event. Still
 * the SAME `applyLifecycleEvent` firing path (types.ts) as every other event
 * this adapter produces — this only changes how the events themselves get
 * built.
 */
export async function branchDeletionEventsWithOutcome(
  entries: readonly { branch: string; sha?: string | undefined }[],
  options: GitContextOptions = {},
): Promise<LifecycleTriggerEvent[]> {
  const events: LifecycleTriggerEvent[] = [];
  for (const entry of entries) {
    const outcome = await deriveAbandonedBranchOutcome(entry.branch, entry.sha, options);
    events.push({
      transition: 'supersede',
      matcher: { branch: entry.branch },
      adapter: ADAPTER_NAME,
      detail: `local branch '${entry.branch}' deleted without merging`,
      outcome,
    });
  }
  return events;
}
