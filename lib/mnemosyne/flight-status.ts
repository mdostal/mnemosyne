/**
 * Flight-status write schema — status transitions + git-context
 * auto-detection (la-04-flight-status-schema, epic:
 * mnemosyne-layer-architecture-v2).
 *
 * Background: work in progress on a non-default branch is true FOR THAT
 * BRANCH only, until it merges. An agent must not treat another branch's
 * unmerged memory as confirmed ground truth (docs/layer-architecture-v2-plan.md
 * §2). This module extends hive-memory's existing kg.sqlite pattern
 * (valid_from/valid_until/source_epic/source_agent — see
 * HiveMemoryLayerAdapter.ts and plugin-hive's knowledge-graph-schema.md)
 * rather than inventing a second storage system: every write now also
 * carries a `status` and a `source_ref`, auto-detected from real cwd git
 * state when the caller doesn't pass them explicitly.
 *
 * Scope note: this module is write-path/schema only.
 *   - Recall-side filtering on `status` (e.g. "only surface `confirmed`
 *     entries by default") is la-05, not implemented here.
 *   - The promote/supersede TRIGGER mechanism (flipping status on merge/PR
 *     close, via git hooks or other lifecycle adapters) is la-06. This
 *     module only defines/validates the schema and exposes
 *     `assertValidStatusTransition` for whatever later calls it.
 *
 * "Nothing is ever deleted on supersede" (mirrors the KG's
 * valid_until-flip-plus-insert pattern, never a DELETE): a `superseded`
 * entry stays exactly as retrievable as any other — it just isn't returned
 * by default recall (la-05's concern), the same way the KG's
 * `valid_until IS NOT NULL` rows are still queryable directly, just excluded
 * from the KG's own default "current state" query pattern.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SourceRef, Status } from './interfaces.js';

const execFileAsync = promisify(execFile);

/** All valid `Status` values, for runtime validation (interfaces.ts's `Status` type has no runtime representation on its own). */
export const STATUSES: readonly Status[] = ['provisional', 'confirmed', 'superseded'];

export function isStatus(value: unknown): value is Status {
  return typeof value === 'string' && (STATUSES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

/**
 * The only two valid transitions in this story's scope, per
 * la-04-flight-status-schema's acceptance criteria: provisional->confirmed
 * (promote) and provisional->superseded (reject/abandon). `confirmed` and
 * `superseded` are terminal from this module's point of view — any further
 * evolution (e.g. a later decision superseding an already-confirmed one) is
 * la-06's promote/supersede trigger mechanism to define, not assumed here.
 */
const VALID_TRANSITIONS: Readonly<Record<Status, ReadonlySet<Status>>> = {
  provisional: new Set<Status>(['confirmed', 'superseded']),
  confirmed: new Set<Status>(),
  superseded: new Set<Status>(),
};

/** True iff `from -> to` is one of the valid transitions. Never guesses — an unrecognized `from`/`to` value is simply not valid. */
export function isValidStatusTransition(from: Status, to: Status): boolean {
  return VALID_TRANSITIONS[from]?.has(to) ?? false;
}

/** Thrown by `assertValidStatusTransition` — carries the attempted transition so callers can log/report it without re-parsing the message. */
export class InvalidStatusTransitionError extends Error {
  constructor(
    public readonly from: Status,
    public readonly to: Status,
  ) {
    super(
      `invalid status transition: '${from}' -> '${to}'. The only valid transitions are ` +
        `provisional->confirmed and provisional->superseded.`,
    );
    this.name = 'InvalidStatusTransitionError';
  }
}

/**
 * Rejects (throws), never silently allows, any transition outside the valid
 * set. This is the loud-failure enforcement point acceptance criterion 3
 * requires — a caller that wants to no-op on an invalid transition must
 * catch `InvalidStatusTransitionError` explicitly, not rely on this function
 * swallowing it.
 */
export function assertValidStatusTransition(from: Status, to: Status): void {
  if (!isValidStatusTransition(from, to)) {
    throw new InvalidStatusTransitionError(from, to);
  }
}

// ---------------------------------------------------------------------------
// Git-context auto-detection
// ---------------------------------------------------------------------------

export interface GitContextOptions {
  /**
   * Directory to resolve git state from. Defaults to `process.cwd()`.
   * Typed to also accept an explicit `undefined` (not just an omitted key)
   * under `exactOptionalPropertyTypes` — callers that forward an
   * already-optional field from their own options object (e.g.
   * `RememberOptions.cwd`) commonly pass it through as-is rather than
   * conditionally omitting the key.
   */
  cwd?: string | undefined;
  /** `git` executable override, mainly for tests. */
  gitBin?: string | undefined;
  timeoutMs?: number | undefined;
}

export interface AutoDetectOptions extends GitContextOptions {
  /**
   * Branch name considered "the default branch" for status resolution
   * (writes on it default to `confirmed`; everything else defaults to
   * `provisional`). When omitted, resolved from the repo's
   * `refs/remotes/origin/HEAD` symref, falling back to `'main'` if that
   * isn't set (e.g. a fresh/local-only repo with no origin).
   */
  defaultBranch?: string | undefined;
}

/**
 * Raised when git context cannot be resolved unambiguously from `cwd`
 * (detached HEAD, no git repo at all, `git` not on PATH, or the underlying
 * command otherwise fails). Per this story's risk mitigation: fail loudly
 * and require an explicit `source_ref` rather than guessing wrong in an
 * ambiguous repo state (detached HEAD, submodules, worktrees).
 */
export class GitContextDetectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitContextDetectionError';
  }
}

/**
 * Resolves `{ branch, commit_sha, pr_url }` from REAL `git` state at `cwd` —
 * never assumed/guessed. `pr_url` is always `null` here: no local git state
 * can answer "which PR is this" (that's the pluggable trigger adapters'
 * concern in la-06); callers that know the PR URL pass it via an explicit
 * `source_ref` instead of relying on auto-detection.
 */
export async function detectGitContext(options: GitContextOptions = {}): Promise<SourceRef> {
  const cwd = options.cwd ?? process.cwd();
  const gitBin = options.gitBin ?? 'git';
  const timeout = options.timeoutMs ?? 5_000;

  let branch: string;
  try {
    const { stdout } = await execFileAsync(gitBin, ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      timeout,
    });
    branch = stdout.trim();
  } catch (error) {
    throw new GitContextDetectionError(
      `could not resolve the current branch from cwd git state (${cwd}): ${describeExecError(error)}`,
    );
  }

  if (!branch || branch === 'HEAD') {
    // `git rev-parse --abbrev-ref HEAD` prints the literal string "HEAD"
    // when HEAD is detached (no branch to resolve to) — an ambiguous state
    // per this story's risk section, not something to guess at.
    throw new GitContextDetectionError(
      `cwd (${cwd}) is in a detached-HEAD (or otherwise branch-less) git state — pass an ` +
        `explicit source_ref rather than relying on auto-detection here`,
    );
  }

  let commitSha: string;
  try {
    const { stdout } = await execFileAsync(gitBin, ['rev-parse', 'HEAD'], { cwd, timeout });
    commitSha = stdout.trim();
  } catch (error) {
    throw new GitContextDetectionError(
      `could not resolve the current commit sha from cwd git state (${cwd}): ${describeExecError(error)}`,
    );
  }

  return { branch, commit_sha: commitSha, pr_url: null };
}

/**
 * Best-effort resolution of "the default branch" for `cwd`'s repo, via the
 * `refs/remotes/origin/HEAD` symref. Unlike `detectGitContext`, absence here
 * is NOT treated as an ambiguous/error state — plenty of legitimate repos
 * (fresh clones before a first fetch, local-only repos, this function's own
 * test fixtures) have no origin remote at all, so this falls back to the
 * conventional `'main'` rather than failing loudly.
 */
export async function detectDefaultBranchName(options: GitContextOptions = {}): Promise<string> {
  const cwd = options.cwd ?? process.cwd();
  const gitBin = options.gitBin ?? 'git';
  const timeout = options.timeoutMs ?? 5_000;

  try {
    const { stdout } = await execFileAsync(
      gitBin,
      ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
      { cwd, timeout },
    );
    const ref = stdout.trim(); // e.g. "origin/main"
    const short = ref.startsWith('origin/') ? ref.slice('origin/'.length) : ref;
    if (short) return short;
  } catch {
    // No origin remote, or no HEAD symref set — fall through to the
    // conventional default rather than failing this (non-ambiguous) case.
  }
  return 'main';
}

/** Default status for a write resolved against `branch`: `confirmed` on the default branch, `provisional` everywhere else. */
export function resolveDefaultStatus(branch: string, defaultBranch: string): Status {
  return branch === defaultBranch ? 'confirmed' : 'provisional';
}

export interface AutoDetectedWriteContext {
  status: Status;
  source_ref: SourceRef;
}

/**
 * Combines `detectGitContext` + `detectDefaultBranchName` (or the caller's
 * explicit `defaultBranch`) into the full auto-detected write context a
 * `remember()` call needs when the caller didn't pass `status`/`source_ref`
 * explicitly. Propagates `GitContextDetectionError` verbatim on ambiguous
 * git state — callers decide how to surface that (e.g. VectorLayerAdapter
 * turns it into a `RememberFailure` rather than writing with guessed data).
 */
export async function autoDetectWriteContext(
  options: AutoDetectOptions = {},
): Promise<AutoDetectedWriteContext> {
  const source_ref = await detectGitContext(options);
  const defaultBranch = options.defaultBranch ?? (await detectDefaultBranchName(options));
  const status = resolveDefaultStatus(source_ref.branch, defaultBranch);
  return { status, source_ref };
}

function describeExecError(error: unknown): string {
  const err = error as { stderr?: string; message?: string } | undefined;
  const stderr = typeof err?.stderr === 'string' ? err.stderr.trim() : '';
  return stderr || err?.message || String(error);
}
