// install-script.mjs — real subprocess-level test for docs/install.sh /
// scripts/install.sh (aha-03-install-script-and-readme, epic:
// mnemosyne-agent-harness-install).
//
// Runs the REAL install script as a real subprocess (`bash docs/install.sh`,
// and separately `bash scripts/install.sh`, to prove the wrapper path
// behaves identically) against a genuinely isolated temp target directory --
// NEVER this operator's real Mnemosyne clone(s) or their real
// ~/.local/bin/mnemosyne symlink (if one already points somewhere real).
// Isolation is via the script's own MNEMOSYNE_INSTALL_DIR / MNEMOSYNE_BIN_DIR
// / MNEMOSYNE_REPO_URL overrides (see docs/install.sh's header comment) --
// this test's own tempDirs sweep never touches anything outside a fresh
// mkdtemp() tree.
//
// MNEMOSYNE_REPO_URL is pointed at a `file://` URL for THIS repo's own
// working tree root (ROOT), not the real https://github.com/mdostal/mnemosyne
// -- fast, deterministic, no network flakiness, and (critically) clones
// THIS commit's own bin/mnemosyne-agent.mjs, so the resulting install's
// `mnemosyne agent status` genuinely works end-to-end rather than testing
// against a stale pre-aha-01/02 main. `git clone` reads from HEAD (committed
// objects), not the dirty working tree, so this only proves anything once
// this ticket's own changes are committed -- which they are by the time this
// test runs (see the "review"/"integrate" step ordering in aha-03's own
// ticket YAML).
//
// Covers (per aha-03's acceptance criteria):
//   AC-install        first run clones + npm installs + links; the
//                     resulting `mnemosyne` command is real, reachable via
//                     PATH (not just by absolute path), and runs `agent
//                     status` successfully (exit 0) end to end.
//   AC-idempotent     a second run against the SAME target detects the
//                     existing clone and updates (git pull) rather than
//                     erroring or duplicating -- exactly one clone dir,
//                     exactly one bin symlink, both runs exit 0.
//   AC-next-step-only stdout prints the literal `mnemosyne agent init` line,
//                     but the script never RUNS it -- verified
//                     independently, not just by absence of an error: after
//                     BOTH install runs, `agent status` (run with an
//                     isolated HOME/CODEX_HOME) still reports "NOT
//                     registered", proving no registration side effect
//                     leaked from the install script itself.
//   AC-scripts-wrapper  scripts/install.sh is a real symlink to
//                     docs/install.sh (byte-identical content, verified) AND,
//                     run directly against a SEPARATE isolated target,
//                     produces the same successful install end to end.
//   AC-readme         README.md's Quickstart first line is the real curl
//                     command pointing at the real URL, and the pre-existing
//                     gh-repo-clone/npm-install/npm-test block is still
//                     present, unchanged, directly below it (additive diff,
//                     nothing real removed).
//
// SAFETY (independently checked here, not just claimed): every install run
// below pins MNEMOSYNE_INSTALL_DIR/MNEMOSYNE_BIN_DIR to fresh mkdtemp()
// directories under the OS temp dir and MNEMOSYNE_REPO_URL to a local
// file:// URL -- this test structurally cannot write into this operator's
// real ~/.local/share/mnemosyne/ (confirmed by hand, before writing this
// test, to already be a REAL, in-use directory on this machine -- a running
// Mnemosyne service's own mnemosyne.log + notes/ live there -- which is
// exactly why docs/install.sh's own default nests one level deeper, at
// .../mnemosyne/repo/, rather than using that directory directly) or real
// ~/.local/bin/mnemosyne. The final block below snapshots the REAL
// ~/.local/bin/mnemosyne path (lstat + readlink if present) both before and
// after this entire test run and asserts it is byte-for-byte/state-for-state
// unchanged -- absent stays absent, or an existing real symlink's target
// stays exactly what it was.
//
// Usage: node test/install-script.mjs
import { execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, readlink, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DOCS_INSTALL = path.join(ROOT, "docs", "install.sh");
const SCRIPTS_INSTALL = path.join(ROOT, "scripts", "install.sh");
const REPO_FILE_URL = `file://${ROOT}`;

let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "  PASS" : "  FAIL"}  ${m}`);
  if (!c) fails++;
};

function short(text, max = 300) {
  const s = JSON.stringify(text ?? "");
  return s.length > max ? `${s.slice(0, max)}…[truncated, ${s.length} chars total]` : s;
}

const tempDirs = [];
async function makeTempDir(prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Runs `bash <scriptPath>` as a real subprocess, with MNEMOSYNE_* overrides pinned to isolated locations -- never this operator's real defaults. */
async function runInstallScript(scriptPath, { installDir, binDir, repoUrl = REPO_FILE_URL } = {}) {
  const env = {
    ...process.env,
    MNEMOSYNE_REPO_URL: repoUrl,
    MNEMOSYNE_INSTALL_DIR: installDir,
    MNEMOSYNE_BIN_DIR: binDir,
  };
  try {
    const { stdout, stderr } = await execFileAsync("bash", [scriptPath], { env, cwd: ROOT });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

/** Invokes the freshly-linked `mnemosyne` command genuinely THROUGH PATH (env.PATH = binDir : realPATH, bare command name "mnemosyne") -- not by absolute path -- to literally satisfy "reachable on PATH". HOME/CODEX_HOME are pinned to fresh throwaway dirs so this read-only `agent status` call never touches this operator's real ~/.claude or ~/.codex, matching test/agent-cli.mjs's own isolation discipline. */
async function runInstalledMnemosyne(binDir, args, { home, codexHome } = {}) {
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    HOME: home,
    CODEX_HOME: codexHome,
  };
  try {
    const { stdout, stderr } = await execFileAsync("mnemosyne", args, { env, cwd: binDir });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

async function main() {
  // --- AC-scripts-wrapper (part 1): byte-identical file content --------------
  const docsContent = await readFile(DOCS_INSTALL, "utf8");
  const scriptsContent = await readFile(SCRIPTS_INSTALL, "utf8");
  ok(docsContent === scriptsContent, "scripts/install.sh content is byte-identical to docs/install.sh");

  const scriptsLstat = await lstat(SCRIPTS_INSTALL);
  ok(
    scriptsLstat.isSymbolicLink() || docsContent === scriptsContent,
    "scripts/install.sh is either a real symlink to docs/install.sh, or a wrapper producing byte-identical content"
  );
  if (scriptsLstat.isSymbolicLink()) {
    const target = await readlink(SCRIPTS_INSTALL);
    ok(
      path.resolve(path.dirname(SCRIPTS_INSTALL), target) === DOCS_INSTALL,
      `scripts/install.sh symlink genuinely resolves to docs/install.sh (-> ${target})`
    );
  }

  // --- AC-install + AC-idempotent (docs/install.sh) ---------------------------
  const installDir = path.join(await makeTempDir("mnemosyne-install-script-test-"), "clone");
  const binDir = await makeTempDir("mnemosyne-install-script-bin-");
  const statusHome = await makeTempDir("mnemosyne-install-script-statushome-");
  const statusCodexHome = await makeTempDir("mnemosyne-install-script-statuscodexhome-");

  const run1 = await runInstallScript(DOCS_INSTALL, { installDir, binDir });
  ok(run1.code === 0, `docs/install.sh first run -> exit 0 (got ${run1.code}, stderr=${short(run1.stderr)})`);
  ok(/cloning .* into/.test(run1.stdout), `first run clones (stdout mentions "cloning ... into") -> ${short(run1.stdout, 120)}`);
  ok(existsSync(path.join(installDir, ".git")), `${installDir}/.git exists after first run`);
  ok(existsSync(path.join(installDir, "node_modules")), `${installDir}/node_modules exists after npm install`);
  ok(existsSync(path.join(installDir, "bin", "mnemosyne")), `${installDir}/bin/mnemosyne exists in the clone`);

  const linkPath = path.join(binDir, "mnemosyne");
  const linkStat1 = await lstat(linkPath).catch(() => null);
  ok(linkStat1?.isSymbolicLink() === true, `${linkPath} is a real symlink after first run`);
  const linkTarget1 = linkStat1 ? await readlink(linkPath) : null;
  ok(
    linkTarget1 === path.join(installDir, "bin", "mnemosyne"),
    `${linkPath} points at the real cloned bin/mnemosyne (-> ${linkTarget1})`
  );

  // AC-install: the resulting `mnemosyne` command genuinely works, reached
  // via PATH (bare command name), not an absolute-path workaround.
  const status1 = await runInstalledMnemosyne(binDir, ["agent", "status"], { home: statusHome, codexHome: statusCodexHome });
  ok(status1.code === 0, `mnemosyne agent status (via PATH, fresh install) -> exit 0 (got ${status1.code}, stderr=${short(status1.stderr)})`);
  ok(/binary:/.test(status1.stdout), `mnemosyne agent status produced real per-harness output -> ${short(status1.stdout, 200)}`);

  // AC-next-step-only, part A: the install script prints the literal next step.
  ok(/mnemosyne agent init/.test(run1.stdout), "install script prints the literal `mnemosyne agent init` next-step line");
  ok(!/registered mcp server/.test(run1.stdout), "install script's own output never claims to have registered anything (never ran agent init)");

  // AC-next-step-only, part B: independently confirm no registration happened
  // -- status still reports "NOT registered" against the isolated home used
  // for status1 above, proving install.sh made zero MCP-registration calls.
  ok(
    /mcp server 'mnemosyne': NOT registered/.test(status1.stdout),
    `agent status confirms the install script never ran \`agent init\` (still NOT registered) -> ${short(status1.stdout, 200)}`
  );

  // --- AC-install-paths (ro-12-two-explicit-install-paths): install.sh's step-4
  // print block additively names BOTH the sidecar (Mode B) and full/system
  // (Mode A) install paths -- in addition to (not replacing) the existing
  // `mnemosyne agent init` line already checked above. ------------------------
  ok(/Mode B/.test(run1.stdout) && /Mode A/.test(run1.stdout), `install script's step-4 output names both Mode B and Mode A -> ${short(run1.stdout, 400)}`);
  ok(/agent init --build/.test(run1.stdout), `install script's step-4 output names the sidecar path (agent init --build) -> ${short(run1.stdout, 400)}`);
  ok(
    /mnemosyne onboard <path> --collection <name>/.test(run1.stdout),
    `install script's step-4 output names the full/system path (mnemosyne onboard <path> --collection <name>) -> ${short(run1.stdout, 400)}`
  );
  // Still prints (never runs) the pre-existing `mnemosyne agent init` line --
  // this story is additive-only, not a replacement of the original line.
  ok(/^  mnemosyne agent init$/m.test(run1.stdout), "install script still prints the original standalone `mnemosyne agent init` line, unreplaced");

  // --- AC-idempotent: second run, same target ---------------------------------
  const run2 = await runInstallScript(DOCS_INSTALL, { installDir, binDir });
  ok(run2.code === 0, `docs/install.sh second run (same target) -> exit 0 (got ${run2.code}, stderr=${short(run2.stderr)})`);
  ok(
    /existing clone found .* updating/.test(run2.stdout),
    `second run detects the existing clone and updates instead of re-cloning -> ${short(run2.stdout, 160)}`
  );
  ok(!/^mnemosyne: cloning/m.test(run2.stdout), "second run does not re-clone (no fresh `cloning ... into` line)");

  const linkStat2 = await lstat(linkPath).catch(() => null);
  ok(linkStat2?.isSymbolicLink() === true, `${linkPath} is still a real symlink after second run`);
  const linkTarget2 = linkStat2 ? await readlink(linkPath) : null;
  ok(linkTarget2 === linkTarget1, "the bin symlink target is unchanged/re-linked identically on the second run (no duplication)");

  const status2 = await runInstalledMnemosyne(binDir, ["agent", "status"], { home: statusHome, codexHome: statusCodexHome });
  ok(status2.code === 0, `mnemosyne agent status (after second install run) -> exit 0 (got ${status2.code})`);
  ok(
    /mcp server 'mnemosyne': NOT registered/.test(status2.stdout),
    "agent status still reports NOT registered after the second install run too -- confirms idempotent re-run never auto-runs agent init either"
  );

  // --- AC-scripts-wrapper (part 2): scripts/install.sh works end to end too --
  const wrapperInstallDir = path.join(await makeTempDir("mnemosyne-install-script-wrapper-test-"), "clone");
  const wrapperBinDir = await makeTempDir("mnemosyne-install-script-wrapper-bin-");
  const wrapperRun = await runInstallScript(SCRIPTS_INSTALL, { installDir: wrapperInstallDir, binDir: wrapperBinDir });
  ok(wrapperRun.code === 0, `scripts/install.sh (wrapper path) run -> exit 0 (got ${wrapperRun.code}, stderr=${short(wrapperRun.stderr)})`);
  ok(existsSync(path.join(wrapperInstallDir, ".git")), "scripts/install.sh run produced a real clone too");
  const wrapperLinkStat = await lstat(path.join(wrapperBinDir, "mnemosyne")).catch(() => null);
  ok(wrapperLinkStat?.isSymbolicLink() === true, "scripts/install.sh run produced a real bin symlink too");
  ok(
    /cloning .* into/.test(wrapperRun.stdout) && /mnemosyne agent init/.test(wrapperRun.stdout) && /linked .* ->/.test(wrapperRun.stdout),
    "scripts/install.sh produces the same shape of output as docs/install.sh (clone + link + next-step lines)"
  );

  // --- AC-readme ---------------------------------------------------------------
  const readme = await readFile(path.join(ROOT, "README.md"), "utf8");
  const quickstartIdx = readme.indexOf("## Quickstart");
  ok(quickstartIdx !== -1, "README.md has a Quickstart section");
  const quickstartSlice = readme.slice(quickstartIdx, quickstartIdx + 1200);
  ok(
    /```bash\ncurl -fsSL https:\/\/mdostal\.github\.io\/mnemosyne\/install\.sh \| bash\n```/.test(quickstartSlice),
    "Quickstart's first code block is the real curl command pointing at the real published URL"
  );
  const curlIdx = quickstartSlice.indexOf("curl -fsSL");
  const ghCloneIdx = quickstartSlice.indexOf("gh repo clone mdostal/mnemosyne");
  ok(curlIdx !== -1 && ghCloneIdx !== -1 && curlIdx < ghCloneIdx, "the curl command appears BEFORE the preserved gh-repo-clone block");
  ok(
    /gh repo clone mdostal\/mnemosyne\ncd mnemosyne\nnpm install\nnpm test/.test(quickstartSlice),
    "the existing gh-repo-clone/npm-install/npm-test block is preserved, unmodified, below the curl line"
  );

  // --- AC-install-paths (ro-12-two-explicit-install-paths): README.md's Quickstart,
  // read top to bottom after the curl|bash step, names BOTH "sidecar / embedded"
  // and "full / system" as explicit, labeled paths, each cross-referenced to the
  // SAME Mode A / Mode B vocabulary design-discussion.md already uses. -----------
  const afterCurl = readme.slice(curlIdx === -1 ? quickstartIdx : quickstartIdx + curlIdx);
  ok(/[Ss]idecar/.test(afterCurl) && /Mode B/.test(afterCurl), `README names "sidecar" cross-referenced to Mode B after the curl step -> ${short(afterCurl, 500)}`);
  ok(
    /[Ff]ull ?\/ ?[Ss]ystem/.test(afterCurl) && /Mode A/.test(afterCurl),
    `README names "full/system" cross-referenced to Mode A after the curl step -> ${short(afterCurl, 500)}`
  );
  ok(/mnemosyne agent init --build/.test(afterCurl), `README's install-path fork names the real sidecar command (agent init --build) -> ${short(afterCurl, 500)}`);
  ok(
    /mnemosyne onboard <path> --collection <name>/.test(afterCurl),
    `README's install-path fork names the real full/system command (mnemosyne onboard <path> --collection <name>) -> ${short(afterCurl, 500)}`
  );
}

// --- SAFETY: this operator's real ~/.local/bin/mnemosyne must be genuinely
// untouched by this entire test run, snapshotted before and after. ---------
async function snapshotRealMnemosyneLink() {
  const realLinkPath = path.join(process.env.HOME || "", ".local", "bin", "mnemosyne");
  const st = await lstat(realLinkPath).catch(() => null);
  if (!st) return { exists: false, path: realLinkPath };
  const isSymlink = st.isSymbolicLink();
  const target = isSymlink ? await readlink(realLinkPath).catch(() => null) : null;
  return { exists: true, path: realLinkPath, isSymlink, target, mtimeMs: st.mtimeMs };
}

const before = await snapshotRealMnemosyneLink();

try {
  await main();
} finally {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
}

const after = await snapshotRealMnemosyneLink();
ok(
  JSON.stringify(before) === JSON.stringify(after),
  `SAFETY: this operator's real ${before.path} is genuinely unchanged by this test run (before=${short(before)}, after=${short(after)})`
);

console.log(fails ? `\n${fails} check(s) failed` : "\nall install-script checks passed");
process.exit(fails ? 1 : 0);
