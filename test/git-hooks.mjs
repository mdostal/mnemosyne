// git-hooks.mjs — the mandatory REAL subprocess-level integration test for
// la-06-lifecycle-trigger-system (epic: mnemosyne-layer-architecture-v2),
// per the epic's decided testing bar (docs/layer-architecture-v2-plan.md
// §6, decision 2): "a real subprocess integration test... same rigor as
// the pl-02 regression test."
//
// This does NOT call the trigger-system's detect/apply functions directly.
// It:
//   1. Creates a real, throwaway temp git repo (git init/checkout -b/commit).
//   2. Runs the REAL installer (bin/mnemosyne-install-git-hooks) against
//      that repo, which writes REAL executable hook shims into that repo's
//      REAL `.git/hooks/` (resolved via `git rev-parse --git-path hooks`,
//      not a hand-picked path) — never the shared mnemosyne repo's own
//      hooks (see this file's bottom comment for why that matters).
//   3. Writes REAL provisional note files via the REAL src/engine.mjs
//      `remember()` write path (against a fake-swarm-memory fixture in
//      place of live Qdrant — same test double write-through.mjs already
//      uses — so this never touches the real Qdrant corpus), with cwd
//      pointed at the temp repo so status/source_ref auto-detection resolves
//      from REAL git state.
//   4. Performs an ACTUAL `git merge` / `git branch -D` subprocess call —
//      git itself invokes the installed hooks, not this test script.
//   5. Reads the note files back off disk and asserts the promotion/
//      supersede actually happened, against real written memory entries.
//
// la-08-lifecycle-outcome-feedback extends both scenarios below (rather
// than adding a separate test file — same real-subprocess rigor, same
// installed hooks, same temp repo) with assertions that the SAME real merge
// / real `git branch -D` also wrote an outcome-tagged "## Lifecycle
// outcome" section into the note, not just flipped its status= token. The
// branch-delete assertion in particular is the meaningful proof: it only
// passes because the installed reference-transaction hook actually resolves
// + stashes the abandoned branch's sha during git's real "prepared" phase
// (a real `git branch -D`'s own reference-transaction data reports no
// usable old value for the delete itself, confirmed by direct experiment —
// see hooks/git/reference-transaction.mjs's doc comment).
//
//   node test/git-hooks.mjs

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { install } from "../bin/mnemosyne-install-git-hooks";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const FIXTURE = fileURLToPath(new URL("./fixtures/fake-swarm-memory", import.meta.url));

let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "  PASS" : "  FAIL"}  ${m}`);
  if (!c) fails++;
};

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function makeRepo(root) {
  await git(root, ["init", "--quiet", "-b", "main"]);
  await git(root, ["config", "user.email", "git-hooks-test@example.com"]);
  await git(root, ["config", "user.name", "Git Hooks Test"]);
  await git(root, ["commit", "--quiet", "--allow-empty", "-m", "initial commit"]);
}

let seq = 0;
async function loadEngine(notesDir) {
  process.env.SWARM_MEMORY_BIN = FIXTURE;
  process.env.FAKE_SWARM_MODE = "success";
  process.env.MNEMOSYNE_NOTES_DIR = notesDir;
  process.env.MNEMO_TEST_NODE = process.execPath;
  seq += 1;
  return import(`../src/engine.mjs?git-hooks-scenario=${seq}`);
}

async function readNote(file) {
  return readFile(file, "utf8");
}

async function main() {
  const workRoot = await mkdtemp(path.join(tmpdir(), "mnemosyne-git-hooks-test-"));
  const repoRoot = path.join(workRoot, "repo");
  const notesDir = path.join(workRoot, "notes");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(repoRoot, { recursive: true });

  try {
    await makeRepo(repoRoot);

    // --- install the REAL git hooks into this throwaway repo --------------
    const installResult = install({ repoPath: repoRoot, mnemosyneRoot: ROOT, log: () => {}, warn: () => {} });
    ok(installResult.installed.length === 2, `install() wrote both hooks (got ${JSON.stringify(installResult.installed)})`);
    const { access } = await import("node:fs/promises");
    const postMergePath = path.join(installResult.hooksDir, "post-merge");
    const refTxPath = path.join(installResult.hooksDir, "reference-transaction");
    await access(postMergePath);
    await access(refTxPath);
    ok(true, `real executable hook files exist on disk at ${installResult.hooksDir}`);

    // =======================================================================
    // Scenario A: real merge to the default branch -> real promotion
    // =======================================================================
    const { remember } = await loadEngine(notesDir);

    await git(repoRoot, ["checkout", "--quiet", "-b", "feat/real-merge"]);
    const write1 = await remember("decision: adopt the pluggable trigger interface", "personal", {
      cwd: repoRoot,
      defaultBranch: "main",
    });
    ok(write1.remembered === true && write1.status === "provisional", "wrote a real provisional note on feat/real-merge");

    await git(repoRoot, ["commit", "--quiet", "--allow-empty", "-m", "feat commit 2"]);
    const write2 = await remember("decision: git hooks are the first adapter", "personal", {
      cwd: repoRoot,
      defaultBranch: "main",
    });
    ok(write2.status === "provisional", "wrote a second real provisional note (second commit on the same branch)");

    // A control note on a DIFFERENT, unrelated branch — must NOT be promoted
    // by merging feat/real-merge, proving matching is real, not "promote
    // everything provisional".
    await git(repoRoot, ["checkout", "--quiet", "main"]);
    await git(repoRoot, ["checkout", "--quiet", "-b", "feat/unrelated"]);
    const writeUnrelated = await remember("decision: unrelated in-flight work", "personal", {
      cwd: repoRoot,
      defaultBranch: "main",
    });
    ok(writeUnrelated.status === "provisional", "wrote a control provisional note on an unrelated branch");

    // The REAL merge — git itself invokes the installed post-merge hook.
    await git(repoRoot, ["checkout", "--quiet", "main"]);
    await git(repoRoot, ["merge", "--quiet", "--no-ff", "-m", "Merge branch 'feat/real-merge'", "feat/real-merge"]);

    const note1After = await readNote(write1.file);
    const note2After = await readNote(write2.file);
    const unrelatedAfter = await readNote(writeUnrelated.file);

    ok(
      note1After.includes("status=confirmed") && note1After.includes("decision: adopt the pluggable trigger interface"),
      "REAL git merge -> installed post-merge hook fired -> note 1 promoted to confirmed on disk (real written entry)"
    );
    ok(
      note2After.includes("status=confirmed"),
      "REAL git merge -> note 2 (second commit on the same branch) also promoted to confirmed"
    );
    ok(
      unrelatedAfter.includes("status=provisional"),
      "the unrelated branch's note was NOT promoted by this merge — matching is real, not blanket"
    );

    // --- la-08-lifecycle-outcome-feedback: the SAME real merge above must
    // also write an outcome-tagged entry, not just flip status=confirmed.
    ok(
      note1After.includes("## Lifecycle outcome") && note1After.includes("feat/real-merge"),
      "la-08: the REAL merge also wrote an outcome/lesson section into note 1, naming the merged branch"
    );
    ok(
      note1After.includes("merge-commit") && note1After.includes("feat commit 2"),
      "la-08: the outcome correctly identifies this as a real (non-fast-forward) merge and includes the real commit message"
    );
    ok(
      unrelatedAfter.includes("## Lifecycle outcome") === false,
      "la-08: the unrelated (non-matching) branch's note got no outcome recorded either — matching is real, not blanket"
    );

    // =======================================================================
    // Scenario B: real branch delete (abandoned, never merged) -> real
    // supersede, never a delete.
    // =======================================================================
    await git(repoRoot, ["checkout", "--quiet", "-b", "feat/abandoned"]);
    await git(repoRoot, ["commit", "--quiet", "--allow-empty", "-m", "work that will be abandoned"]);
    const writeAbandoned = await remember("decision: try approach X (later abandoned)", "personal", {
      cwd: repoRoot,
      defaultBranch: "main",
    });
    ok(writeAbandoned.status === "provisional", "wrote a real provisional note on feat/abandoned");

    await git(repoRoot, ["checkout", "--quiet", "main"]);
    // The REAL branch delete — git itself invokes the installed
    // reference-transaction hook.
    await git(repoRoot, ["branch", "-D", "feat/abandoned"]);

    const abandonedAfter = await readNote(writeAbandoned.file);
    ok(
      abandonedAfter.includes("status=superseded"),
      "REAL `git branch -D` -> installed reference-transaction hook fired -> note superseded on disk"
    );
    ok(
      abandonedAfter.includes("decision: try approach X (later abandoned)"),
      "the superseded note's content is still fully present — NEVER deleted, only its status flipped"
    );

    // --- la-08-lifecycle-outcome-feedback: the SAME real `git branch -D`
    // above must also write an outcome/lesson capturing WHY it didn't land
    // — specifically the abandoned branch's own last commit message, which
    // is only recoverable at all because the installed reference-transaction
    // hook resolved+stashed it during git's "prepared" phase (BEFORE the
    // ref was actually removed) — a real `git branch -D`'s own
    // reference-transaction data reports no usable old value by the time
    // "committed" fires (see hooks/git/reference-transaction.mjs's doc
    // comment). This is the mandated proof that this really works end to
    // end through the INSTALLED hooks, not just the unit-level primitives.
    ok(
      abandonedAfter.includes("## Lifecycle outcome") && abandonedAfter.includes("feat/abandoned"),
      "la-08: the REAL branch delete also wrote an outcome/lesson section into the superseded note, naming the branch"
    );
    ok(
      abandonedAfter.includes("work that will be abandoned"),
      "la-08: the outcome captures the abandoned branch's actual last commit message (recovered via the prepared-state pre-resolution, not the delete's own reference-transaction data)"
    );

    // =======================================================================
    // Scenario C: idempotent re-install does not duplicate/break anything.
    // =======================================================================
    const reinstall = install({ repoPath: repoRoot, mnemosyneRoot: ROOT, log: () => {}, warn: () => {} });
    ok(
      reinstall.installed.length === 0 && reinstall.updated.length === 0,
      "re-running install() against an already-installed repo is a clean no-op"
    );
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }

  console.log(fails ? `\n${fails} check(s) failed` : "\nall git-hooks checks passed");
  process.exit(fails ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

// NOTE ON SCOPE: this test installs hooks into a throwaway temp-dir git repo
// created fresh for this test run — NEVER into the actual mnemosyne repo's
// own shared `.git/hooks` (which, for a linked worktree like this one, is
// the COMMON git dir shared by every worktree, including any other agent
// concurrently working in a sibling worktree of the same repo — confirmed
// via `git rev-parse --git-path hooks` returning the common, not
// per-worktree, path). Installing real hooks into that shared location from
// an automated test run would risk firing on another agent's unrelated git
// operations mid-session. See this story's `note:` field in
// .pHive/epics/mnemosyne-layer-architecture-v2/stories/
// la-06-lifecycle-trigger-system.yaml for the live-dogfooding verification
// this repo instead uses (a real full clone of this repo, not the shared
// working copy).
