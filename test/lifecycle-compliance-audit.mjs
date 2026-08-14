// lifecycle-compliance-audit.mjs — the mandatory REAL subprocess-level
// integration test for la-11-memory-lifecycle-compliance-audit (epic:
// mnemosyne-layer-architecture-v2), per this story's own testing bar
// ("actually create a real temp git repo, write a real provisional note,
// actually `git merge` it WITHOUT installing la-06's hooks (simulating the
// exact gap this story exists to cover — the hook never fired), then run
// your audit command for real and confirm it (a) detects the
// stale-provisional/actually-merged mismatch via real git commands, and (b)
// either promotes it with logged evidence or flags it"), mirroring
// test/git-hooks.mjs's own rigor.
//
// This does NOT call the audit's detect/apply functions in-process. It:
//   1. Creates a real, throwaway temp git repo (git init/checkout -b/commit).
//   2. Writes a REAL provisional note via the REAL src/engine.mjs
//      `remember()` write path (fake-swarm-memory fixture standing in for
//      live Qdrant only, the same test double write-through.mjs/git-hooks.mjs
//      already use), with cwd pointed at the temp repo so status/source_ref
//      auto-detection resolves from REAL git state.
//   3. Performs an ACTUAL `git merge --no-ff` of that branch into main —
//      deliberately WITHOUT ever running bin/mnemosyne-install-git-hooks
//      against this repo, so no post-merge hook fires. This is exactly
//      la-06's own documented gap the audit exists to backstop.
//   4. Writes a second, real, still-open provisional note (never merged) as
//      a control — the audit must NOT report or touch it.
//   5. Writes a third note directly to the notes dir with a fabricated,
//      never-fetched commit sha and a deleted-branch name, alongside a real
//      merge-commit message on main naming that branch — the "ambiguous,
//      flag but never auto-promote" case.
//   6. Spawns the REAL runnable command
//      (`node node_modules/.bin/tsx lib/mnemosyne/audit/cli.ts`) as a real
//      subprocess, exactly as `bin/mnemosyne-audit-lifecycle` does.
//   7. Reads the note files back off disk afterward and asserts against
//      real written state, not the subprocess's own claims about itself.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const FIXTURE = fileURLToPath(new URL("./fixtures/fake-swarm-memory", import.meta.url));
const TSX_BIN = path.join(ROOT, "node_modules", ".bin", "tsx");
const CLI = path.join(ROOT, "lib", "mnemosyne", "audit", "cli.ts");

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
  await git(root, ["config", "user.email", "lifecycle-compliance-audit-test@example.com"]);
  await git(root, ["config", "user.name", "Lifecycle Compliance Audit Test"]);
  await git(root, ["commit", "--quiet", "--allow-empty", "-m", "initial commit"]);
}

let seq = 0;
async function loadEngine(notesDir) {
  process.env.SWARM_MEMORY_BIN = FIXTURE;
  process.env.FAKE_SWARM_MODE = "success";
  process.env.MNEMOSYNE_NOTES_DIR = notesDir;
  process.env.MNEMO_TEST_NODE = process.execPath;
  seq += 1;
  return import(`../src/engine.mjs?lifecycle-compliance-audit-scenario=${seq}`);
}

function writeNoteDirectly(notesDir, name, status, branch, commit) {
  const file = path.join(notesDir, name);
  const header = `<!-- remembered via Mnemosyne @ 2026-08-13T00:00:00.000Z status=${status} branch=${branch} commit=${commit} -->\n`;
  return writeFile(file, header + "a real ambiguous-case note body\n", "utf8").then(() => file);
}

function runAuditCli(args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [TSX_BIN, CLI, ...args], { cwd: ROOT, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      // A non-zero exit is an expected outcome (unresolved findings), not a
      // subprocess failure -- resolve with the code either way, only reject
      // on a genuine spawn error.
      const code = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

async function main() {
  const workRoot = await mkdtemp(path.join(tmpdir(), "mnemosyne-lifecycle-compliance-audit-test-"));
  const repoRoot = path.join(workRoot, "repo");
  const notesDir = path.join(workRoot, "notes");
  await mkdir(repoRoot, { recursive: true });
  await mkdir(notesDir, { recursive: true });

  try {
    await makeRepo(repoRoot);

    // =======================================================================
    // Scenario A: real merge to the default branch, WITHOUT the la-06 git
    // hooks installed -- the exact gap this story backstops.
    // =======================================================================
    const { remember } = await loadEngine(notesDir);

    await git(repoRoot, ["checkout", "--quiet", "-b", "feat/audit-real-merge"]);
    const write1 = await remember("decision: adopt the compliance-audit backstop", "personal", {
      cwd: repoRoot,
      defaultBranch: "main",
    });
    ok(write1.remembered === true && write1.status === "provisional", "wrote a real provisional note on feat/audit-real-merge");

    // Real merge -- deliberately NO installed post-merge hook (never ran
    // bin/mnemosyne-install-git-hooks against repoRoot).
    await git(repoRoot, ["checkout", "--quiet", "main"]);
    await git(repoRoot, ["merge", "--quiet", "--no-ff", "-m", "Merge branch 'feat/audit-real-merge'", "feat/audit-real-merge"]);

    const beforeAudit1 = await readFile(write1.file, "utf8");
    ok(beforeAudit1.includes("status=provisional"), "confirms the gap is real: still provisional on disk immediately after a real merge, since no hook fired");

    // =======================================================================
    // Scenario B (control): a real, still-open, never-merged branch -- the
    // audit must correctly hold back, not report or touch this at all.
    // =======================================================================
    await git(repoRoot, ["checkout", "--quiet", "-b", "feat/audit-still-open"]);
    // A real new commit ON this branch -- without this, HEAD here would be
    // byte-identical to main's current tip (nothing committed since
    // branching from post-merge main), which would make this commit
    // trivially "already an ancestor of main" and defeat the point of this
    // control scenario.
    await git(repoRoot, ["commit", "--quiet", "--allow-empty", "-m", "still-open work"]);
    const write2 = await remember("decision: unrelated in-flight work", "personal", {
      cwd: repoRoot,
      defaultBranch: "main",
    });
    ok(write2.status === "provisional", "wrote a real control provisional note on a still-open branch");
    await git(repoRoot, ["checkout", "--quiet", "main"]);

    // =======================================================================
    // Scenario C: ambiguous -- a fabricated, never-fetched commit sha and a
    // deleted branch name, but a REAL merge-commit message on main naming
    // it (simulating a squash/rebase merge on another machine whose commit
    // sha never landed in this clone). The audit must flag, never promote.
    // =======================================================================
    const foreignSha = "d".repeat(40);
    await git(repoRoot, ["commit", "--quiet", "--allow-empty", "-m", "Merge branch 'feat/audit-ambiguous'"]);
    const note3File = await writeNoteDirectly(notesDir, "note-ambiguous.md", "provisional", "feat/audit-ambiguous", foreignSha);

    // --- run the REAL runnable command as a REAL subprocess -----------------
    const result = await runAuditCli([
      "--repo", repoRoot,
      "--notes-dir", notesDir,
      "--default-branch", "main",
      "--settings", path.join(workRoot, "does-not-exist-settings.json"),
      "--json",
    ]);

    let report;
    try {
      report = JSON.parse(result.stdout);
    } catch {
      report = null;
    }
    ok(report !== null, `mnemosyne-audit-lifecycle CLI emitted valid JSON on stdout (stderr: ${result.stderr.slice(0, 500)})`);

    if (report) {
      // --- Scenario A assertions: real detection + real promotion ----------
      const remediation1 = report.remediations.find((r) => r.entryId === write1.file);
      ok(!!remediation1, "the real merge WITHOUT installed hooks was detected as drift and auto-remediated by the audit");
      ok(
        remediation1 && remediation1.evidence.some((e) => e.command.includes("merge-base")),
        "the remediation's logged evidence includes the real `git merge-base --is-ancestor` command that justified it"
      );
      ok(
        remediation1 && remediation1.from === "provisional" && remediation1.to === "confirmed",
        "the remediation recorded provisional -> confirmed, applied via la-06's own applyLifecycleEvent"
      );

      const finding1 = report.staleProvisionalFindings.find((f) => f.entry.id === write1.file);
      ok(finding1 && finding1.verification.classification === "verified-merged", "note 1 classified verified-merged");

      // --- Scenario B assertions: correct hold-back -------------------------
      const finding2 = report.staleProvisionalFindings.find((f) => f.entry.id === write2.file);
      ok(!finding2, "the still-open control branch is NOT reported as a finding -- correctly held back, not drift");
      const remediation2 = report.remediations.find((r) => r.entryId === write2.file);
      ok(!remediation2, "the still-open control branch's note was NOT remediated");

      // --- Scenario C assertions: ambiguous -> flagged, never promoted -----
      const finding3 = report.staleProvisionalFindings.find((f) => f.entry.id === note3File);
      ok(
        finding3 && finding3.verification.classification === "ambiguous",
        "the fabricated-commit/deleted-branch/real-merge-message case is classified ambiguous, not verified-merged"
      );
      ok(!!(finding3 && finding3.verification.reason), "the ambiguous finding carries a specific reason, not a vague flag");
      const remediation3 = report.remediations.find((r) => r.entryId === note3File);
      ok(!remediation3, "the audit correctly held back from promoting the ambiguous case -- never guessed");

      // --- mandate-compliance findings (AC1: specific evidence, not vague) -
      ok(
        report.mandateChecks.length > 0 && report.mandateChecks.every((c) => typeof c.evidence === "string" && c.evidence.length > 0),
        "every mandate-compliance check carries specific, non-empty evidence text"
      );
      ok(report.mandateChecks.some((c) => c.compliant === false), "the missing settings.json / uninstalled git hooks are correctly flagged non-compliant");
    }

    // --- real state on disk afterward, read back independently of the CLI's own report ---
    const note1After = await readFile(write1.file, "utf8");
    ok(note1After.includes("status=confirmed") && note1After.includes("adopt the compliance-audit backstop"), "note 1 is REALLY confirmed on disk, content fully intact");

    const note2After = await readFile(write2.file, "utf8");
    ok(note2After.includes("status=provisional"), "note 2 (still-open control) is REALLY untouched on disk, still provisional");

    const note3After = await readFile(note3File, "utf8");
    ok(note3After.includes("status=provisional"), "note 3 (ambiguous) is REALLY untouched on disk, still provisional -- never guessed into confirmed");

    // --- exit code reflects unresolved findings (ambiguous case + non-compliant mandate) ---
    ok(result.code === 1, `CLI exits non-zero when unresolved findings remain (ambiguous case, non-compliant mandate checks) -- got exit ${result.code}`);
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }

  console.log(fails ? `\n${fails} check(s) failed` : "\nall lifecycle-compliance-audit checks passed");
  process.exit(fails ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
