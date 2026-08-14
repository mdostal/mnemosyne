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
//      never reimplemented here), asks the store to persist it.
//   2. NotesDirectoryStatusStore — a MemoryStatusStore over the local notes
//      directory both real write paths (this file's own engine.mjs and the
//      TS VectorLayerAdapter.ts) already write to.
//   3. detectMergePromotion / parseReferenceTransactionLines /
//      deletedLocalBranches / branchDeletionEvents — the git-hooks adapter's
//      detection logic (post-merge -> promote, branch delete via
//      reference-transaction -> supersede).

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
    updated.push({ ...entry, status: to });
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
}

// --- 3. git-hooks adapter detection -----------------------------------------

export const ADAPTER_NAME = "git-hooks";

const NULL_OID_40 = "0".repeat(40);
const NULL_OID_64 = "0".repeat(64);

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

  return {
    transition: "promote",
    matcher: { ...(mergedBranch !== undefined ? { branch: mergedBranch } : {}), commitShas: mergedShas },
    adapter: ADAPTER_NAME,
    detail: `merge to '${defaultBranch}', ${mergedShas.length} new commit(s)${
      mergedBranch ? ` from '${mergedBranch}'` : ""
    }`,
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

export function deletedLocalBranches(state, lines) {
  if (state !== "committed") return [];
  const deleted = [];
  for (const line of lines) {
    if (line.newValue !== NULL_OID_40 && line.newValue !== NULL_OID_64) continue;
    if (!line.refname.startsWith("refs/heads/")) continue;
    deleted.push(line.refname.slice("refs/heads/".length));
  }
  return deleted;
}

export function branchDeletionEvents(branches) {
  return branches.map((branch) => ({
    transition: "supersede",
    matcher: { branch },
    adapter: ADAPTER_NAME,
    detail: `local branch '${branch}' deleted without merging`,
  }));
}
