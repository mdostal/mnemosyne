// triggers.mjs — zero-dep JS mirror of lib/mnemosyne/triggers/{types,notesStore,gitAdapter}.ts,
// for the actual installable git-hook scripts (hooks/git/post-merge.mjs,
// hooks/git/reference-transaction.mjs) to import at hook-execution time
// (la-06-lifecycle-trigger-system, epic: mnemosyne-layer-architecture-v2).
//
// Same duplicated-not-shared-across-the-TS/JS-boundary rationale as
// flight-status.mjs (see that file's own doc comment): a git hook installed
// into an arbitrary repo's .git/hooks/ must run via plain `node`, with no
// tsx/build step available at hook-fire time, so the TS side stays the
// documented/type-checked contract (lib/mnemosyne/triggers/*.ts) while this
// file is the one that's actually live at runtime.
//
// Three parts, same shape as the TS side:
//   1. applyLifecycleEvent(event, store) — the pluggable engine: looks up
//      provisional entries, validates the transition via
//      assertValidStatusTransition (flight-status.mjs — la-04's logic,
//      never reimplemented here), asks the store to persist it, and
//      (la-08-lifecycle-outcome-feedback) records event.outcome against
//      each flipped entry when both the event and the store support it.
//   2. NotesDirectoryStatusStore — a MemoryStatusStore over the local notes
//      directory both real write paths (this file's own engine.mjs and the
//      TS VectorLayerAdapter.ts) already write to. Also implements
//      recordOutcome (la-08): appends an outcome/lesson section to the note
//      body, never touching the header line.
//   3. detectMergePromotion / parseReferenceTransactionLines /
//      deletedLocalBranches / branchDeletionEvents — the git-hooks adapter's
//      detection logic (post-merge -> promote, branch delete via
//      reference-transaction -> supersede). la-08 adds outcome derivation to
//      both sides: detectMergePromotion now attaches a merge-shape +
//      commit-subjects outcome directly; the supersede side needs
//      resolveBranchSha / stashPendingBranchSha / takePendingBranchSha /
//      deriveAbandonedBranchOutcome / branchDeletionEventsWithOutcome
//      because a real `git branch -D`'s reference-transaction line reports
//      the OLD value as the null OID too (confirmed by direct experiment,
//      not assumed) — see the la-08 section below for the full explanation.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertValidStatusTransition, detectDefaultBranchName } from "./flight-status.mjs";

const execFileAsync = promisify(execFile);

// --- 1. the pluggable engine -------------------------------------------------

export function matchesSourceRef(sourceRef, matcher) {
  if (matcher.branch !== undefined && sourceRef.branch === matcher.branch) return true;
  if (matcher.commitShas !== undefined && matcher.commitShas.includes(sourceRef.commit_sha)) return true;
  return false;
}

function targetStatus(transition) {
  return transition === "promote" ? "confirmed" : "superseded";
}

export async function applyLifecycleEvent(event, store) {
  const provisional = await store.findByStatus("provisional");
  const matched = provisional.filter((entry) => matchesSourceRef(entry.source_ref, event.matcher));
  const to = targetStatus(event.transition);

  const updated = [];
  for (const entry of matched) {
    assertValidStatusTransition(entry.status, to);
    await store.updateStatus(entry, to);
    const updatedEntry = { ...entry, status: to };
    if (event.outcome && store.recordOutcome) {
      try {
        await store.recordOutcome(updatedEntry, event.outcome);
      } catch {
        // Best-effort (la-08) — the status transition already succeeded; an
        // outcome-recording failure must never surface as if it failed.
      }
    }
    updated.push(updatedEntry);
  }

  return { transition: event.transition, matched, updated };
}

// --- 2. NotesDirectoryStatusStore -------------------------------------------

const HEADER_LINE_RE =
  /^<!--.*\bstatus=(provisional|confirmed|superseded)\s+branch=(\S+)\s+commit=([0-9a-fA-F]{7,64})\b.*-->/;

function parseHeader(firstLine) {
  const m = HEADER_LINE_RE.exec(firstLine.trim());
  if (!m) return null;
  const [, status, branch, commit_sha] = m;
  return { status, branch, commit_sha };
}

export class NotesDirectoryStatusStore {
  constructor({ notesDirectory }) {
    this.notesDirectory = notesDirectory;
  }

  async findByStatus(status) {
    let names;
    try {
      names = await readdir(this.notesDirectory);
    } catch (error) {
      if (error && error.code === "ENOENT") return [];
      throw error;
    }

    const entries = [];
    for (const name of names) {
      if (!name.endsWith(".md")) continue;
      const file = path.join(this.notesDirectory, name);
      const content = await readFile(file, "utf8");
      const firstLine = content.split("\n", 1)[0] ?? "";
      const parsed = parseHeader(firstLine);
      if (!parsed) continue;
      if (parsed.status !== status) continue;
      entries.push({
        id: file,
        status: parsed.status,
        source_ref: { branch: parsed.branch, commit_sha: parsed.commit_sha, pr_url: null },
      });
    }
    return entries;
  }

  async updateStatus(entry, to) {
    const content = await readFile(entry.id, "utf8");
    const newlineIndex = content.indexOf("\n");
    const firstLine = newlineIndex === -1 ? content : content.slice(0, newlineIndex);
    const rest = newlineIndex === -1 ? "" : content.slice(newlineIndex);

    if (!parseHeader(firstLine)) {
      throw new Error(
        `${entry.id}: header line does not match the expected Mnemosyne note format, refusing to rewrite it`
      );
    }

    const rewritten = firstLine.replace(/\bstatus=(provisional|confirmed|superseded)\b/, `status=${to}`);
    await writeFile(entry.id, rewritten + rest, "utf8");
  }

  // (la-08-lifecycle-outcome-feedback) Appends outcome.summary to the note
  // body as a new section — never rewrites the header line (updateStatus's
  // job) or any pre-existing body content, only adds to it. See
  // lib/mnemosyne/triggers/notesStore.ts's recordOutcome for the full doc
  // comment this mirrors.
  async recordOutcome(entry, outcome) {
    const content = await readFile(entry.id, "utf8");
    const separator = content.endsWith("\n") ? "\n" : "\n\n";
    const block = `${separator}## Lifecycle outcome\n${outcome.summary}\n`;
    await writeFile(entry.id, content + block, "utf8");
  }
}

// --- 3. git-hooks adapter detection -----------------------------------------

export const ADAPTER_NAME = "git-hooks";

const NULL_OID_40 = "0".repeat(40);
const NULL_OID_64 = "0".repeat(64);

// (la-08-lifecycle-outcome-feedback) Derives the promote side's outcome/
// lesson data — see lib/mnemosyne/triggers/gitAdapter.ts's deriveMergeOutcome
// for the full doc comment this mirrors. Built only from what a git-hook
// adapter can realistically supply: merge shape (fast-forward vs. real
// merge commit, from HEAD's own parent count) + the real commit message(s)
// that landed. Best-effort — never throws past its own try/catches.
async function deriveMergeOutcome(run, info) {
  let mergeShape = "fast-forward";
  try {
    const { stdout } = await run(["rev-list", "--parents", "-n", "1", "HEAD"]);
    const tokens = stdout.trim().split(/\s+/).filter(Boolean);
    if (tokens.length > 2) mergeShape = "merge-commit";
  } catch {
    // leave the fast-forward default — sparser but still real
  }

  let commitSubjects = [];
  try {
    const { stdout } = await run(["log", "--reverse", "--pretty=%s", "ORIG_HEAD..HEAD"]);
    commitSubjects = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    commitSubjects = [];
  }

  const summary =
    `merge to '${info.defaultBranch}' (${mergeShape}), ${info.mergedShas.length} commit(s)` +
    `${info.mergedBranch ? ` from '${info.mergedBranch}'` : ""}` +
    `${commitSubjects.length > 0 ? `: ${commitSubjects.join("; ")}` : ""}`;

  return {
    summary,
    detail: { mergeShape, commitSubjects, branch: info.mergedBranch ?? null, defaultBranch: info.defaultBranch },
  };
}

export async function detectMergePromotion(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const gitBin = options.gitBin ?? "git";
  const timeout = options.timeoutMs ?? 5000;

  const run = (args) => execFileAsync(gitBin, args, { cwd, timeout });

  let currentBranch;
  try {
    currentBranch = (await run(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
  } catch {
    return null;
  }

  const defaultBranch =
    options.defaultBranch ?? (await detectDefaultBranchName({ cwd, gitBin, timeoutMs: timeout }));
  if (currentBranch !== defaultBranch) return null;

  let mergedShas;
  try {
    const { stdout } = await run(["rev-list", "ORIG_HEAD..HEAD"]);
    mergedShas = stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
  if (mergedShas.length === 0) return null;

  let mergedBranch;
  try {
    const subject = (await run(["log", "-1", "--pretty=%s"])).stdout.trim();
    const branchMatch = /Merge branch '([^']+)'/.exec(subject);
    const prMatch = /Merge pull request #\d+ from [^/]+\/(\S+)/.exec(subject);
    mergedBranch = branchMatch?.[1] ?? prMatch?.[1] ?? undefined;
  } catch {
    mergedBranch = undefined;
  }

  const outcome = await deriveMergeOutcome(run, { mergedShas, mergedBranch, defaultBranch });

  return {
    transition: "promote",
    matcher: { ...(mergedBranch !== undefined ? { branch: mergedBranch } : {}), commitShas: mergedShas },
    adapter: ADAPTER_NAME,
    detail: `merge to '${defaultBranch}', ${mergedShas.length} new commit(s)${
      mergedBranch ? ` from '${mergedBranch}'` : ""
    }`,
    outcome,
  };
}

export function parseReferenceTransactionLines(stdin) {
  const lines = [];
  for (const raw of stdin.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length !== 3) continue;
    const [oldValue, newValue, refname] = parts;
    lines.push({ oldValue, newValue, refname });
  }
  return lines;
}

function branchHeadRefsGoingToNull(lines) {
  const names = [];
  for (const line of lines) {
    if (line.newValue !== NULL_OID_40 && line.newValue !== NULL_OID_64) continue;
    if (!line.refname.startsWith("refs/heads/")) continue;
    names.push(line.refname.slice("refs/heads/".length));
  }
  return names;
}

export function deletedLocalBranches(state, lines) {
  if (state !== "committed") return [];
  return branchHeadRefsGoingToNull(lines);
}

// (la-08-lifecycle-outcome-feedback) The 'prepared'-state counterpart: valid
// at ANY state (not gated to 'committed'), used to resolve a candidate
// branch's sha WHILE its ref still exists. See the la-08 section below for
// the full explanation of why this is needed.
export function candidateDeletedBranchNames(lines) {
  return branchHeadRefsGoingToNull(lines);
}

export function branchDeletionEvents(branches) {
  return branches.map((branch) => ({
    transition: "supersede",
    matcher: { branch },
    adapter: ADAPTER_NAME,
    detail: `local branch '${branch}' deleted without merging`,
  }));
}

// --- la-08-lifecycle-outcome-feedback: supersede-side outcome derivation ---
//
// CONFIRMED BY DIRECT EXPERIMENT (temp repo, real `git branch -D`): a forced
// branch delete's own reference-transaction line reports OLD-VALUE as the
// null OID too — at EVERY state (prepared, committed, even aborted) —
// because `branch -D` deletes without a compare-and-swap check, so git's
// own transaction record never carries a real old value to hand the hook.
// (`git update-ref -d <ref> <old-sha>`, which explicitly supplies an old
// value to verify, DOES surface a real one — but that's not the command an
// operator actually runs.) So deletedLocalBranches's reference-transaction
// stdin data alone can NEVER recover an abandoned branch's last commit for
// the realistic `branch -D` case.
//
// The fix, also confirmed by direct experiment: at the 'prepared' state —
// BEFORE the ref is actually removed — `git rev-parse --verify
// refs/heads/<branch>` still resolves. So resolveBranchSha +
// stashPendingBranchSha capture it then; takePendingBranchSha reads it back
// once deletedLocalBranches confirms, at 'committed', that the SAME branch
// name was actually deleted. A small per-repo scratch file inside the real
// git dir (resolved via --git-path, so it follows worktrees the same way
// bin/mnemosyne-install-git-hooks's resolveHooksDir does) bridges the two
// calls — the hook fires as a genuinely separate OS process per state, so
// nothing can be held in memory across them.

const PENDING_BRANCH_SHAS_GIT_RELPATH = "mnemosyne-la08-pending-branch-shas.json";

async function resolveGitPath(relPath, options) {
  const cwd = options.cwd ?? process.cwd();
  const gitBin = options.gitBin ?? "git";
  const timeout = options.timeoutMs ?? 5000;
  const { stdout } = await execFileAsync(gitBin, ["rev-parse", "--git-path", relPath], { cwd, timeout });
  return path.resolve(cwd, stdout.trim());
}

export async function resolveBranchSha(branch, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const gitBin = options.gitBin ?? "git";
  const timeout = options.timeoutMs ?? 5000;
  try {
    const { stdout } = await execFileAsync(gitBin, ["rev-parse", "--verify", `refs/heads/${branch}`], {
      cwd,
      timeout,
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function stashPendingBranchSha(branch, sha, options = {}) {
  try {
    const file = await resolveGitPath(PENDING_BRANCH_SHAS_GIT_RELPATH, options);
    let existing = {};
    try {
      existing = JSON.parse(await readFile(file, "utf8"));
    } catch {
      existing = {};
    }
    existing[branch] = sha;
    await writeFile(file, JSON.stringify(existing), "utf8");
  } catch {
    // best-effort — see la-08 section doc comment above
  }
}

export async function takePendingBranchSha(branch, options = {}) {
  try {
    const file = await resolveGitPath(PENDING_BRANCH_SHAS_GIT_RELPATH, options);
    let existing;
    try {
      existing = JSON.parse(await readFile(file, "utf8"));
    } catch {
      return undefined;
    }
    const sha = existing[branch];
    if (sha === undefined) return undefined;
    delete existing[branch];
    await writeFile(file, JSON.stringify(existing), "utf8");
    return sha;
  } catch {
    return undefined;
  }
}

export async function deriveAbandonedBranchOutcome(branch, sha, options = {}) {
  let lastCommitSubject;
  if (sha) {
    const cwd = options.cwd ?? process.cwd();
    const gitBin = options.gitBin ?? "git";
    const timeout = options.timeoutMs ?? 5000;
    try {
      const { stdout } = await execFileAsync(gitBin, ["log", "-1", "--pretty=%s", sha], { cwd, timeout });
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

export async function branchDeletionEventsWithOutcome(entries, options = {}) {
  const events = [];
  for (const entry of entries) {
    const outcome = await deriveAbandonedBranchOutcome(entry.branch, entry.sha, options);
    events.push({
      transition: "supersede",
      matcher: { branch: entry.branch },
      adapter: ADAPTER_NAME,
      detail: `local branch '${entry.branch}' deleted without merging`,
      outcome,
    });
  }
  return events;
}
