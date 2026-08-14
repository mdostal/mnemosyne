// flight-status.mjs — zero-dep JS mirror of lib/mnemosyne/flight-status.ts,
// for engine.mjs's remember() write path (la-04-flight-status-schema, epic:
// mnemosyne-layer-architecture-v2). Same logic, duplicated rather than
// shared across the TS/JS boundary — this repo already duplicates the
// remember() write-through pattern itself between engine.mjs and
// VectorLayerAdapter.ts (see that file's own doc comment), so this follows
// the same established precedent rather than inventing cross-boundary
// imports between the zero-dep JS service and the TS client library.
//
// Scope: write-path/schema only. Recall-side filtering on status is la-05.
// The promote/supersede trigger mechanism (flipping status on merge/PR
// close) is la-06 — this module only validates the schema.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const STATUSES = ["provisional", "confirmed", "superseded"];

export function isStatus(value) {
  return typeof value === "string" && STATUSES.includes(value);
}

// --- status transitions -----------------------------------------------------
// Exactly the two transitions this story's acceptance criteria define as
// valid: provisional->confirmed (promote) and provisional->superseded
// (reject/abandon). confirmed/superseded are terminal here; la-06 owns any
// further evolution of the promote/supersede mechanism.
const VALID_TRANSITIONS = {
  provisional: new Set(["confirmed", "superseded"]),
  confirmed: new Set(),
  superseded: new Set(),
};

export function isValidStatusTransition(from, to) {
  return VALID_TRANSITIONS[from]?.has(to) ?? false;
}

export class InvalidStatusTransitionError extends Error {
  constructor(from, to) {
    super(
      `invalid status transition: '${from}' -> '${to}'. The only valid transitions are ` +
        `provisional->confirmed and provisional->superseded.`
    );
    this.name = "InvalidStatusTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function assertValidStatusTransition(from, to) {
  if (!isValidStatusTransition(from, to)) {
    throw new InvalidStatusTransitionError(from, to);
  }
}

// --- git-context auto-detection ---------------------------------------------

export class GitContextDetectionError extends Error {
  constructor(message) {
    super(message);
    this.name = "GitContextDetectionError";
  }
}

function describeExecError(error) {
  const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
  return stderr || error?.message || String(error);
}

// Resolves {branch, commit_sha, pr_url} from REAL `git` state at cwd — never
// assumed. Fails loudly (GitContextDetectionError) on detached HEAD or any
// other unresolvable state, per this story's risk mitigation.
export async function detectGitContext({ cwd = process.cwd(), gitBin = "git", timeoutMs = 5000 } = {}) {
  let branch;
  try {
    const { stdout } = await execFileAsync(gitBin, ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      timeout: timeoutMs,
    });
    branch = stdout.trim();
  } catch (error) {
    throw new GitContextDetectionError(
      `could not resolve the current branch from cwd git state (${cwd}): ${describeExecError(error)}`
    );
  }

  if (!branch || branch === "HEAD") {
    throw new GitContextDetectionError(
      `cwd (${cwd}) is in a detached-HEAD (or otherwise branch-less) git state — pass an ` +
        `explicit source_ref rather than relying on auto-detection here`
    );
  }

  let commitSha;
  try {
    const { stdout } = await execFileAsync(gitBin, ["rev-parse", "HEAD"], { cwd, timeout: timeoutMs });
    commitSha = stdout.trim();
  } catch (error) {
    throw new GitContextDetectionError(
      `could not resolve the current commit sha from cwd git state (${cwd}): ${describeExecError(error)}`
    );
  }

  return { branch, commit_sha: commitSha, pr_url: null };
}

// Best-effort default-branch resolution via origin/HEAD; falls back to
// 'main' (not an ambiguous-state error — plenty of legitimate repos have no
// origin remote, e.g. local-only or pre-first-fetch).
export async function detectDefaultBranchName({ cwd = process.cwd(), gitBin = "git", timeoutMs = 5000 } = {}) {
  try {
    const { stdout } = await execFileAsync(
      gitBin,
      ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      { cwd, timeout: timeoutMs }
    );
    const ref = stdout.trim();
    const short = ref.startsWith("origin/") ? ref.slice("origin/".length) : ref;
    if (short) return short;
  } catch {
    // no origin remote / no HEAD symref set — fall through
  }
  return "main";
}

export function resolveDefaultStatus(branch, defaultBranch) {
  return branch === defaultBranch ? "confirmed" : "provisional";
}

export async function autoDetectWriteContext(options = {}) {
  const source_ref = await detectGitContext(options);
  const defaultBranch = options.defaultBranch ?? (await detectDefaultBranchName(options));
  const status = resolveDefaultStatus(source_ref.branch, defaultBranch);
  return { status, source_ref };
}
