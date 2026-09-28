// scratch-git-repo.mjs — a throwaway git repo on a named branch, for tests
// whose remember() calls auto-detect flight status from cwd git state
// (PANT-831). Pointing those writes (or the server subprocess serving them)
// at this repo keeps the result independent of the checkout the suite runs
// in — CI's actions/checkout leaves a detached HEAD, which the auto-detection
// guard correctly rejects with 422.
//
// Synchronous so it can be called at module top level from both the plain
// node suites and the vitest suites.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Creates a git repo with one commit on `branch` under the OS temp dir.
 * Pass `detached: true` to leave it in a detached-HEAD state instead.
 * Returns { dir, cleanup }.
 */
export function makeScratchGitRepo({ prefix = "mnemosyne-scratch-repo-", branch = "scratch-feature", detached = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q", "-b", branch);
  git("config", "user.email", "scratch@test.invalid");
  git("config", "user.name", "scratch repo");
  git("config", "commit.gpgsign", "false");
  writeFileSync(path.join(dir, "README"), "scratch\n");
  git("add", "README");
  git("commit", "-q", "-m", "init");
  if (detached) git("checkout", "-q", "--detach");
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
