// install-git-hooks.mjs — proves bin/mnemosyne-install-git-hooks writes
// real, correct, idempotent hook shims, and preserves (never clobbers) a
// pre-existing foreign hook. Uses real throwaway temp-dir git repos —
// never the shared mnemosyne repo's own .git/hooks.
//
//   node test/install-git-hooks.mjs

import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { HOOK_NAMES, buildShim, install, resolveHooksDir } from "../bin/mnemosyne-install-git-hooks";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const FAKE_MNEMOSYNE_ROOT = "/fake/mnemosyne/checkout";

let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "  PASS" : "  FAIL"}  ${m}`);
  if (!c) fails++;
};

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function makeRepo() {
  const root = await mkdtemp(path.join(tmpdir(), "mnemosyne-install-git-hooks-"));
  await git(root, ["init", "--quiet", "-b", "main"]);
  await git(root, ["config", "user.email", "t@example.com"]);
  await git(root, ["config", "user.name", "T"]);
  await git(root, ["commit", "--quiet", "--allow-empty", "-m", "init"]);
  return root;
}

// --- buildShim: bakes an absolute path to THIS checkout's hook script -----
{
  const shim = buildShim("post-merge", FAKE_MNEMOSYNE_ROOT);
  ok(shim.startsWith("#!/bin/sh\n"), "buildShim produces a #!/bin/sh script");
  ok(shim.includes("# mnemosyne-git-hook: post-merge"), "buildShim embeds the ownership marker");
  ok(
    shim.includes(`exec node "${path.join(FAKE_MNEMOSYNE_ROOT, "hooks", "git", "post-merge.mjs")}" "$@"`),
    "buildShim execs the absolutized hooks/git/post-merge.mjs path"
  );
}

// --- resolveHooksDir: follows real git, not a hard-coded ".git/hooks" -----
{
  const root = await makeRepo();
  try {
    const dir = resolveHooksDir(root);
    ok(dir === path.join(root, ".git", "hooks"), `resolveHooksDir resolves the real hooks dir (got ${dir})`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// --- install(): fresh install writes both real, executable hook files -----
{
  const root = await makeRepo();
  try {
    const result = install({ repoPath: root, mnemosyneRoot: ROOT, log: () => {}, warn: () => {} });
    ok(
      result.installed.length === HOOK_NAMES.length && result.updated.length === 0,
      `fresh install() installs all ${HOOK_NAMES.length} hooks (got ${JSON.stringify(result.installed)})`
    );
    for (const name of HOOK_NAMES) {
      const target = path.join(result.hooksDir, name);
      ok(existsSync(target), `${name} hook file exists on disk`);
      const content = readFileSync(target, "utf8");
      ok(content.includes(`hooks/git/${name}.mjs`), `${name} shim references the real hooks/git/${name}.mjs script`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// --- install(): idempotent re-run is a clean no-op --------------------------
{
  const root = await makeRepo();
  try {
    install({ repoPath: root, mnemosyneRoot: ROOT, log: () => {}, warn: () => {} });
    const rerun = install({ repoPath: root, mnemosyneRoot: ROOT, log: () => {}, warn: () => {} });
    ok(
      rerun.installed.length === 0 && rerun.updated.length === 0,
      "re-running install() with the same mnemosyneRoot changes nothing"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// --- install(): a moved checkout (different mnemosyneRoot) updates in place
{
  const root = await makeRepo();
  try {
    install({ repoPath: root, mnemosyneRoot: "/old/location/mnemosyne", log: () => {}, warn: () => {} });
    const rerun = install({ repoPath: root, mnemosyneRoot: "/new/location/mnemosyne", log: () => {}, warn: () => {} });
    ok(rerun.updated.includes("post-merge") && rerun.updated.includes("reference-transaction"), "install() updates the shim path in place after a move");
    const content = readFileSync(path.join(rerun.hooksDir, "post-merge"), "utf8");
    ok(content.includes("/new/location/mnemosyne/hooks/git/post-merge.mjs"), "the rewritten shim points at the new location");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// --- install(): a pre-existing FOREIGN hook is preserved, not clobbered ----
{
  const root = await makeRepo();
  try {
    const hooksDir = path.join(root, ".git", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    const foreignPath = path.join(hooksDir, "post-merge");
    writeFileSync(foreignPath, "#!/bin/sh\necho 'some other tool'\n", "utf8");
    chmodSync(foreignPath, 0o755);

    const warnings = [];
    const result = install({ repoPath: root, mnemosyneRoot: ROOT, log: () => {}, warn: (m) => warnings.push(m) });

    ok(result.preserved.includes("post-merge"), "install() reports the foreign post-merge hook as preserved, not overwritten");
    ok(
      readFileSync(foreignPath, "utf8").includes("some other tool"),
      "the foreign hook's own content is left untouched at its original path"
    );
    ok(existsSync(`${foreignPath}.pre-mnemosyne`), "the foreign hook was backed up to <name>.pre-mnemosyne");
    ok(warnings.some((w) => /not a mnemosyne-installed hook/.test(w)), "install() warns about the foreign hook");
    // reference-transaction had no foreign hook — still installed normally.
    ok(result.installed.includes("reference-transaction"), "the OTHER hook (no conflict) still installs normally");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// --- resolveHooksDir throws for a non-git directory (fails loud, no guess) -
{
  const nonGit = await mkdtemp(path.join(tmpdir(), "mnemosyne-install-git-hooks-nongit-"));
  try {
    let threw = false;
    try {
      resolveHooksDir(nonGit);
    } catch {
      threw = true;
    }
    ok(threw, "resolveHooksDir throws (rather than guessing) outside a git working tree");
  } finally {
    await rm(nonGit, { recursive: true, force: true });
  }
}

console.log(fails ? `\n${fails} check(s) failed` : "\nall install-git-hooks checks passed");
process.exit(fails ? 1 : 0);
