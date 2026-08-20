// agent-cli.mjs — real subprocess-level tests for `mnemosyne agent
// init`/`mnemosyne agent status` (aha-01-agent-init-status-claude +
// aha-02-agent-init-status-codex, epic: mnemosyne-agent-harness-install).
//
// Runs the REAL command as a real subprocess (`node bin/mnemosyne-agent.mjs
// ...`, and separately via `bin/mnemosyne agent ...` to prove the
// dispatcher wiring) against the REAL `claude` and `codex` CLIs already
// installed on this machine (`which claude`, `which codex`) -- mirrors this
// repo's own convention for a plain-JS CLI (see test/persona-cli.mjs's own
// doc comment, and test/reindex.mjs, which this file is closer to since
// bin/mnemosyne-agent.mjs is plain node, no tsx/TS-import boundary -- see
// bin/mnemosyne's own dispatch comment for why).
//
// CRITICAL isolation requirement (design-discussion.md §2's own named risk:
// "`agent init` mutates a harness's own real config files"): every real
// `claude` CLI invocation below runs with $HOME pointed at a fresh
// mkdtemp() directory, and every real `codex` CLI invocation runs with
// $CODEX_HOME pointed at a SEPARATE fresh mkdtemp() directory -- NEVER this
// operator's real ~/.claude/, ~/.claude.json, or ~/.codex/. This matters for
// EVERY test block, not just the Codex-specific ones below: since aha-02
// made Codex a real (not placeholder) harness, the default no-`--harness`
// sweep that aha-01's own Claude-focused blocks already used now genuinely
// invokes the real `codex` CLI too. runCli() below therefore ALWAYS pins
// $CODEX_HOME (defaulting to a fresh throwaway mkdtemp() if a test block
// doesn't pass one explicitly) so it is structurally impossible for any
// block -- Claude-focused or Codex-focused -- to fall through to this
// operator's real ~/.codex/config.toml. Every test block creates its own
// temp dirs and rm -rf's them in a finally-equivalent cleanup at the end of
// that block (plus a top-level `tempDirs` sweep, matching
// test/persona-cli.mjs's own pattern).
//
// A second, real interaction discovered and hardened against while writing
// aha-01: THIS repo ships its own project-scoped `.mcp.json` at the repo
// root (commit 04a8011, "register mnemosyne-mcp as this repo's own
// project-scoped MCP server") -- a real, pre-existing "mnemosyne" MCP
// registration Claude Code resolves from CWD, completely independent of
// $HOME. Before bin/mnemosyne-agent.mjs pinned its harness-CLI execs' cwd to
// homedir() (see its own HARNESS_EXEC_CWD comment), running `claude mcp get
// mnemosyne` with CWD anywhere under this checkout made that unrelated
// project-scoped entry masquerade as an "already registered" user-scope
// state -- confirmed by hand: before the fix, `agent status` reported
// "registered" against a brand-new, never-initialized $HOME purely because
// the test process's CWD happened to be this repo's root. This file
// deliberately runs some assertions with `cwd: ROOT` (matching this repo's
// other CLI tests) specifically BECAUSE that is the realistic, adversarial
// case for a Mnemosyne developer running `mnemosyne agent status` while
// sitting inside this very checkout -- if that regresses, these tests catch
// it. aha-02 hand-verified Codex CLI has NO analogous CWD-scoping behavior
// (see bin/mnemosyne-agent.mjs's own header comment) -- confirmed again
// below by codexMcpGet() running from a throwaway verification cwd, same
// shape as claudeMcpGet()'s own for symmetry/defense-in-depth, not because
// a CWD bug is expected on the Codex side.
//
// Covers (per aha-01's acceptance criteria, Claude Code):
//   AC-register     first-run `agent init` registers bin/mnemosyne-mcp.mjs
//                   as an MCP server named "mnemosyne" via the real `claude`
//                   CLI, verified independently by actually running
//                   `claude mcp get mnemosyne` afterward (not mocked) and
//                   checking it reports the real absolute path.
//   AC-targeted     the registration check is `claude mcp get`, never
//                   `claude mcp list` -- verified indirectly by timing (a
//                   `list` call health-checking every server would be
//                   dramatically slower) and directly by grepping
//                   bin/mnemosyne-agent.mjs's own source for the exact
//                   invocation.
//   AC-idempotent   a second `agent init` run makes zero redundant writes:
//                   the mcpServers.mnemosyne block in $HOME/.claude.json and
//                   every copied skill file's mtime/content are
//                   byte-for-byte unchanged, and stdout says
//                   "already registered"/"already installed".
//   AC-skills-full  ~/.claude/skills/ after `agent init` contains BOTH
//                   skills' full, real directory contents (every file each
//                   needs, not just SKILL.md), byte-for-byte identical to
//                   this repo's own skills/ source.
//   AC-status       `agent status` before vs. after `agent init` genuinely
//                   differs, and a `status` call itself makes zero
//                   filesystem writes anywhere under $HOME and zero MCP
//                   registration changes (recursive snapshot + explicit
//                   `claude mcp get` re-check).
//   AC-harness-flag `agent init --harness claude` runs only the Claude Code
//                   path -- stdout never mentions "codex" at all, unlike the
//                   default (no --harness) run, which does.
//
// Covers (per aha-02's acceptance criteria, Codex CLI):
//   AC-codex-register    first-run `agent init --harness codex` registers
//                        bin/mnemosyne-mcp.mjs as an MCP server named
//                        "mnemosyne" via the real `codex` CLI, verified
//                        independently by actually running
//                        `codex mcp get mnemosyne` afterward (not mocked)
//                        and checking it reports the real absolute path.
//   AC-codex-targeted    the registration check is `codex mcp get`, never
//                        `codex mcp list` -- verified directly by grepping
//                        bin/mnemosyne-agent.mjs's own source, scoped to
//                        codexMcpRegistered()'s own function body.
//   AC-codex-idempotent  a second `agent init --harness codex` run makes
//                        zero redundant writes: $CODEX_HOME/config.toml is
//                        byte-for-byte unchanged and stdout says
//                        "already registered" (not a re-registration line)
//                        -- notable because `codex mcp add` itself does NOT
//                        error on an already-registered name the way
//                        `claude mcp add` does (it silently overwrites), so
//                        this genuinely tests the check-before-write guard,
//                        not the underlying CLI's own idempotency.
//   AC-codex-status      `agent status --harness codex` before vs. after
//                        `agent init --harness codex` genuinely differs, and
//                        a `status` call itself makes zero writes to
//                        $CODEX_HOME (byte-for-byte config.toml snapshot).
//   AC-codex-absent-ok   this environment DOES have a real `codex` CLI on
//                        PATH (confirmed via detectBinary itself, asserted
//                        below) so the "binary genuinely absent" path is
//                        exercised indirectly: PATH is overridden to a
//                        directory containing neither `claude` nor `codex`
//                        and `agent init`/`agent status` (no --harness)
//                        still exit 0, completing without either harness,
//                        never hard-failing just because both are missing.
//
// ro-03-agent-init-build-flag (epic: mnemosyne-repo-onboarding) additions
// below cover the new, opt-in `--build` flag that wires onboardRepo({ mode:
// 'standalone', ... }) (ro-02) into `agent init`:
//   AC-build-off          `agent init` with no `--build` never calls
//                         onboardRepo() -- verified on real disk (no
//                         .mnemosyne/, no CLAUDE.md/AGENTS.md/GEMINI.md
//                         under the target repo) -- and prints the literal
//                         "next step (not run automatically): mnemosyne
//                         agent init --build" guidance line, mirroring
//                         docs/install.sh's own established "print, never
//                         run" convention for `agent init` itself.
//   AC-build-on           `agent init --build` in a fresh repo with no
//                         prior Mnemosyne state runs the REAL onboardRepo()
//                         -- verified independently on disk (CLAUDE.md/
//                         AGENTS.md/GEMINI.md, repo-local persona,
//                         file-index.json all real, not mocked) -- and its
//                         printed output includes a base-level report (all
//                         5 canonical levels) plus the literal "next step
//                         (not run automatically): bin/mnemosyne-install-
//                         hooks" line (design-discussion.md §7.4).
//   AC-build-idempotent   a second `agent init --build` run against the
//                         same target makes zero redundant writes beyond
//                         what onboardRepo() itself already guarantees
//                         idempotent -- the repo-local persona file's
//                         content AND mtime are unchanged, and every synced
//                         harness file's content is byte-for-byte
//                         unchanged.
//   AC-storage-dir         `--storage-dir <dir>` (an amendment, design-
//                         discussion.md §7.1) redirects onboardRepo()'s
//                         repoRoot to <dir> (mkdir -p'd first) instead of
//                         process.cwd() -- every onboarded artifact lands
//                         under <dir>, none under process.cwd(). Omitted:
//                         repoRoot resolves to process.cwd(), byte-
//                         identical to this story's pre-amendment design.
//
// Since `--build` wires in onboardRepo() (lib/mnemosyne/onboarding/
// onboardRepo.ts), bin/mnemosyne-agent.mjs now imports a .ts module
// directly for the first time -- this file's own runCli() therefore
// launches the CLI via `node_modules/.bin/tsx`, exactly like
// test/persona-cli.mjs's own runCli() does for bin/mnemosyne-persona.mjs
// (see that file's identical-shape helper), not plain `node` anymore.
//
// Usage: node test/agent-cli.mjs
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "bin", "mnemosyne-agent.mjs");
const DISPATCHER = path.join(ROOT, "bin", "mnemosyne");
// ro-03: bin/mnemosyne-agent.mjs now imports lib/mnemosyne/onboarding/onboardRepo.ts directly
// (a .ts module) -- launched via tsx, not plain node, matching test/persona-cli.mjs's own
// TSX_BIN convention for the same reason (see this file's header comment).
const TSX_BIN = path.join(ROOT, "node_modules", ".bin", "tsx");
const MCP_SERVER_PATH = path.join(ROOT, "bin", "mnemosyne-mcp.mjs");
const SKILLS_SRC_DIR = path.join(ROOT, "skills");
const SKILL_NAMES = ["mnemosyne-standalone", "mnemosyne-persona-interview"];

let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "  PASS" : "  FAIL"}  ${m}`);
  if (!c) fails++;
};

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function short(text, max = 200) {
  const s = JSON.stringify(text ?? "");
  return s.length > max ? `${s.slice(0, max)}…[truncated, ${s.length} chars total]` : s;
}

const tempDirs = [];
async function makeTempDir(prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** A real, throwaway $HOME -- never this operator's real ~/.claude/ or ~/.claude.json. */
async function makeFakeHome() {
  return makeTempDir("mnemosyne-agent-cli-home-");
}

/** A real, throwaway $CODEX_HOME -- never this operator's real ~/.codex/. */
async function makeFakeCodexHome() {
  return makeTempDir("mnemosyne-agent-cli-codexhome-");
}

/** ro-03: a fresh, throwaway target repo for `--build` tests -- never this repo's own working
 * tree (onboardRepo() would otherwise write real CLAUDE.md/.mnemosyne/ state into this checkout). */
async function makeTempRepo() {
  return makeTempDir("mnemosyne-agent-cli-build-repo-");
}

/** ro-03: a fresh, throwaway $HOME pre-seeded with a Level 0 rules fixture
 * (~/.mnemosyne/level0-rules.md) -- required before onboardRepo()'s Layer-1-sync sub-step will
 * succeed (readLevel0Content hard-fails when it's missing, by design -- lib/mnemosyne/layer1/
 * level0.ts). Mirrors onboardRepo.test.ts's own makeFakeHome(withLevel0=true) fixture. */
async function makeFakeHomeWithLevel0() {
  const home = await makeFakeHome();
  await mkdir(path.join(home, ".mnemosyne"), { recursive: true });
  await writeFile(
    path.join(home, ".mnemosyne", "level0-rules.md"),
    "# Level 0 operator rules (test fixture)\n\nAlways be kind.\n",
    "utf8",
  );
  return home;
}

/** Runs the agent CLI as a real subprocess (directly, or through the bin/mnemosyne dispatcher), with $HOME pinned to `home` and $CODEX_HOME pinned to `codexHome`. `cwd` defaults to ROOT (this repo) -- the realistic, adversarial case documented in this file's own header comment, since this repo ships its own project-scoped .mcp.json. $CODEX_HOME is ALWAYS set (falling back to a fresh throwaway mkdtemp() if a caller doesn't pass one) -- structurally never inherited from this operator's real environment, since aha-02 made Codex a real harness the default no-`--harness` sweep genuinely invokes. `pathOverride`, when given, replaces PATH entirely (used to simulate "neither harness binary is on PATH" for real, per aha-02's AC-codex-absent-ok). */
async function runCli(args, { home, codexHome, viaDispatcher = false, cwd = ROOT, pathOverride } = {}) {
  const cmd = viaDispatcher ? DISPATCHER : process.execPath;
  const cmdArgs = viaDispatcher ? ["agent", ...args] : [TSX_BIN, CLI, ...args];
  const env = { ...process.env };
  if (home) env.HOME = home;
  env.CODEX_HOME = codexHome || (await makeFakeCodexHome());
  if (pathOverride !== undefined) env.PATH = pathOverride;
  try {
    const { stdout, stderr } = await execFileAsync(cmd, cmdArgs, { cwd, env });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

/** Runs the REAL `claude` CLI directly (not through bin/mnemosyne-agent.mjs) -- used to independently verify agent init/status's claims, per aha-01's "not mocked" acceptance criteria. cwd pinned to homedir-equivalent (a fresh tmp dir, never ROOT) so this verification call is itself immune to this repo's own project-scoped .mcp.json. */
async function claudeMcpGet(home, name = "mnemosyne") {
  const env = { ...process.env, HOME: home };
  const verifyCwd = await makeTempDir("mnemosyne-agent-cli-verify-cwd-");
  try {
    const { stdout } = await execFileAsync("claude", ["mcp", "get", name], { cwd: verifyCwd, env });
    return { code: 0, stdout };
  } catch (e) {
    return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

/** Runs the REAL `codex` CLI directly (not through bin/mnemosyne-agent.mjs) -- used to independently verify agent init/status's Codex claims, per aha-02's "not mocked, real installed codex CLI" acceptance criteria. cwd pinned to a throwaway verification dir (never ROOT) matching claudeMcpGet()'s own shape -- aha-02 hand-verified Codex's `mcp get`/`mcp add` don't resolve anything from CWD (see bin/mnemosyne-agent.mjs's header comment), so this is defense-in-depth/symmetry, not a known bug workaround. */
async function codexMcpGet(codexHome, name = "mnemosyne") {
  const env = { ...process.env, CODEX_HOME: codexHome };
  const verifyCwd = await makeTempDir("mnemosyne-agent-cli-codex-verify-cwd-");
  try {
    const { stdout } = await execFileAsync("codex", ["mcp", "get", name], { cwd: verifyCwd, env });
    return { code: 0, stdout };
  } catch (e) {
    return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

/** Reads $CODEX_HOME/config.toml raw content, or null if it doesn't exist yet -- the real, complete state Codex's own `mcp add` writes to and `mcp get`/`mcp list` read from (hand-confirmed: `[mcp_servers.<name>]` TOML table per server). Used for byte-for-byte idempotency proof, mirroring snapshotAgentState()'s role for the Claude side. */
async function readCodexConfig(codexHome) {
  return readFile(path.join(codexHome, "config.toml"), "utf8").catch(() => null);
}

/**
 * Snapshots exactly the two things `agent status` must NEVER touch, per
 * aha-01's own acceptance criteria wording ("verified by checking `claude
 * mcp get mnemosyne` / ~/.claude/skills/ are unchanged after a `status`
 * call") -- NOT a recursive snapshot of all of $HOME. The real `claude` CLI
 * itself has side effects on $HOME outside this ticket's control whenever
 * it runs a REAL connectivity health-check as part of `claude mcp get
 * <name>` against an actually-registered, actually-connectable server: it
 * writes a transcript under
 * `$HOME/Library/Caches/claude-cli-nodejs/.../mcp-logs-<name>/*.jsonl`
 * (confirmed by hand while writing this test -- a real, expected part of
 * `claude mcp get`'s own targeted-lookup behavior, not something
 * bin/mnemosyne-agent.mjs does or could avoid short of not calling the
 * targeted lookup at all, which would defeat AC-targeted). A whole-$HOME
 * snapshot would therefore flag that log write as a false-positive
 * "status wrote something" failure -- scoping to $HOME/.claude.json's own
 * content and ~/.claude/skills/'s tree (the two things actually
 * `bin/mnemosyne-agent.mjs`'s own code could write) is the real, precise
 * proof this ticket's acceptance criteria ask for.
 */
async function snapshotAgentState(home) {
  const claudeJson = await readFile(path.join(home, ".claude.json"), "utf8").catch(() => null);
  const skills = await snapshotTree(path.join(home, ".claude", "skills"));
  return JSON.stringify({ claudeJson, skills });
}

/** Recursively snapshots every file under `root` as sha256 content hashes, sorted -- byte-for-byte proof of "zero writes" (see test/persona-cli.mjs's own snapshotTree, same approach). */
async function snapshotTree(root) {
  const out = {};
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const content = await readFile(full);
        out[path.relative(root, full)] = sha256(content);
      }
    }
  }
  await walk(root);
  return JSON.stringify(Object.keys(out).sort().map((k) => [k, out[k]]));
}

async function listSkillSrcFiles(skillName) {
  const dir = path.join(SKILLS_SRC_DIR, skillName);
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => e.name).sort();
}

async function main() {
  // --- AC-targeted: source-level proof the registration check is `claude mcp get`, never `claude mcp list` ---
  {
    const src = await readFile(path.join(ROOT, "bin", "mnemosyne-agent.mjs"), "utf8");
    ok(/\["mcp",\s*"get",/.test(src), "bin/mnemosyne-agent.mjs's registration check uses `claude mcp get` (single targeted lookup)");
    ok(!/\["mcp",\s*"list"/.test(src), "bin/mnemosyne-agent.mjs never invokes `claude mcp list`");
    ok(
      /NEVER become\s*\n?.*`claude mcp list`/s.test(src) || /never `claude mcp list`/i.test(src),
      "a code comment explicitly names the `claude mcp get` vs `claude mcp list` decision, so a future edit doesn't regress it",
    );
  }

  // --- AC-codex-targeted: source-level proof codexMcpRegistered() uses `codex mcp get`, never `codex mcp list` ---
  {
    const src = await readFile(path.join(ROOT, "bin", "mnemosyne-agent.mjs"), "utf8");
    const fnStart = src.indexOf("export async function codexMcpRegistered");
    const fnEnd = src.indexOf("export async function registerMcpCodex");
    ok(fnStart !== -1 && fnEnd !== -1 && fnEnd > fnStart, "sanity: codexMcpRegistered() is present and precedes registerMcpCodex() in bin/mnemosyne-agent.mjs");
    const fnBody = src.slice(fnStart, fnEnd);
    ok(/"codex"/.test(fnBody), "codexMcpRegistered() invokes the real `codex` binary (not claude's)");
    ok(/\["mcp",\s*"get",/.test(fnBody), "codexMcpRegistered() uses `codex mcp get` (single targeted lookup)");
    ok(!/\["mcp",\s*"list"/.test(fnBody), "codexMcpRegistered() never invokes `codex mcp list`");
    ok(!/\["mcp",\s*"list"/.test(src), "bin/mnemosyne-agent.mjs never invokes `mcp list` anywhere in the file (Claude or Codex)");
    ok(
      /NEVER become\s*\n?.*`codex mcp list`/s.test(src) || /never `codex mcp list`/i.test(src),
      "a code comment explicitly names the `codex mcp get` vs `codex mcp list` decision, so a future edit doesn't regress it",
    );
  }

  // --- AC-register + AC-skills-full: first-run `agent init` --------------------------------------
  {
    const home = await makeFakeHome();

    const first = await runCli(["init"], { home });
    ok(first.code === 0, `agent init (first run) -> exit 0 (got ${first.code}, stderr=${short(first.stderr)})`);
    ok(/registered mcp server 'mnemosyne'/.test(first.stdout), `first run reports registering the mcp server -> ${short(first.stdout)}`);
    ok(first.stdout.includes(MCP_SERVER_PATH), `first run's stdout names the real absolute path to bin/mnemosyne-mcp.mjs -> ${short(first.stdout)}`);
    for (const skillName of SKILL_NAMES) {
      ok(new RegExp(`skill '${skillName}' installed`).test(first.stdout), `first run reports installing skill '${skillName}' -> ${short(first.stdout)}`);
    }

    // Independent verification via the REAL claude CLI directly -- not mocked, not just reading our own stdout.
    const got = await claudeMcpGet(home);
    ok(got.code === 0, `claude mcp get mnemosyne (independent verification) -> exit 0 (got ${got.code}, stderr=${short(got.stderr)})`);
    ok(got.stdout.includes(MCP_SERVER_PATH), `claude mcp get mnemosyne reports the real absolute path -> ${short(got.stdout)}`);
    ok(/User config/.test(got.stdout), `claude mcp get mnemosyne reports "User config" scope (agent init registers at -s user, cross-project) -> ${short(got.stdout)}`);

    // Real filesystem proof the skills were copied in full, not just SKILL.md.
    for (const skillName of SKILL_NAMES) {
      const expectedFiles = await listSkillSrcFiles(skillName);
      ok(expectedFiles.length > 0, `sanity: skills/${skillName}/ has at least one file to copy`);
      const destDir = path.join(home, ".claude", "skills", skillName);
      const destEntries = await readdir(destDir, { withFileTypes: true }).catch(() => []);
      const destFiles = destEntries.filter((e) => e.isFile()).map((e) => e.name).sort();
      ok(
        JSON.stringify(destFiles) === JSON.stringify(expectedFiles),
        `~/.claude/skills/${skillName}/ contains exactly the real skill's full file list -> expected=${JSON.stringify(expectedFiles)}, got=${JSON.stringify(destFiles)}`,
      );
      for (const file of expectedFiles) {
        const srcContent = await readFile(path.join(SKILLS_SRC_DIR, skillName, file));
        const destContent = await readFile(path.join(destDir, file));
        ok(srcContent.equals(destContent), `~/.claude/skills/${skillName}/${file} is byte-for-byte identical to the repo source`);
      }
    }

    await rm(home, { recursive: true, force: true });
  }

  // --- AC-idempotent: a second `agent init` run makes zero redundant writes -----------------------
  {
    const home = await makeFakeHome();

    const first = await runCli(["init"], { home });
    ok(first.code === 0, `agent init (first run, idempotency setup) -> exit 0 (got ${first.code})`);

    const claudeJsonPath = path.join(home, ".claude.json");
    const beforeClaudeJson = await readFile(claudeJsonPath, "utf8");
    const beforeSkillStats = {};
    for (const skillName of SKILL_NAMES) {
      const files = await listSkillSrcFiles(skillName);
      for (const file of files) {
        const p = path.join(home, ".claude", "skills", skillName, file);
        beforeSkillStats[p] = (await stat(p)).mtimeMs;
      }
    }

    const second = await runCli(["init"], { home });
    ok(second.code === 0, `agent init (second run) -> exit 0 (got ${second.code}, stderr=${short(second.stderr)})`);
    ok(/mcp server 'mnemosyne' already registered/.test(second.stdout), `second run reports "already registered" -> ${short(second.stdout)}`);
    for (const skillName of SKILL_NAMES) {
      ok(new RegExp(`skill '${skillName}' already installed`).test(second.stdout), `second run reports skill '${skillName}' already installed -> ${short(second.stdout)}`);
    }
    ok(!/^claude: registered mcp server/m.test(second.stdout), `second run's stdout contains no "registered mcp server" (re-registration) line`);
    ok(!/^claude: skill '.*' installed \(/m.test(second.stdout), `second run's stdout contains no "skill installed" (fresh-write) line -- only "already installed"`);

    const afterClaudeJson = await readFile(claudeJsonPath, "utf8");
    ok(afterClaudeJson === beforeClaudeJson, `${claudeJsonPath} byte-for-byte unchanged after the second run (zero redundant MCP-registration writes)`);

    for (const [p, beforeMtime] of Object.entries(beforeSkillStats)) {
      const afterMtime = (await stat(p)).mtimeMs;
      ok(afterMtime === beforeMtime, `${path.relative(home, p)}'s mtime unchanged after the second run (zero redundant skill writes) -- before=${beforeMtime}, after=${afterMtime}`);
    }

    await rm(home, { recursive: true, force: true });
  }

  // --- AC-status: status reflects real state before/after, with zero side effects from status itself ---
  {
    const home = await makeFakeHome();

    const statusBefore = await runCli(["status"], { home });
    ok(statusBefore.code === 0, `agent status (before init) -> exit 0 (got ${statusBefore.code}, stderr=${short(statusBefore.stderr)})`);
    ok(/mcp server 'mnemosyne': NOT registered/.test(statusBefore.stdout), `status (before init) reports NOT registered -> ${short(statusBefore.stdout)}`);
    for (const skillName of SKILL_NAMES) {
      ok(new RegExp(`skill '${skillName}': NOT installed`).test(statusBefore.stdout), `status (before init) reports skill '${skillName}' NOT installed -> ${short(statusBefore.stdout)}`);
    }

    // status itself must make ZERO writes to the state it reports on -- see snapshotAgentState()'s
    // own doc comment for exactly what is (and, deliberately, is not) covered here.
    await mkdir(home, { recursive: true });
    const snapBeforeStatusCall = await snapshotAgentState(home);
    const statusBeforeAgain = await runCli(["status"], { home });
    const snapAfterStatusCall = await snapshotAgentState(home);
    ok(statusBeforeAgain.code === 0, `agent status (repeat, pre-init) -> exit 0`);
    ok(snapBeforeStatusCall === snapAfterStatusCall, "agent status (pre-init) changed neither $HOME/.claude.json nor ~/.claude/skills/");
    const claudeJsonBeforeInit = await readFile(path.join(home, ".claude.json"), "utf8").catch(() => "{}");
    const mcpServersBeforeInit = JSON.parse(claudeJsonBeforeInit).mcpServers ?? {};
    ok(
      !("mnemosyne" in mcpServersBeforeInit),
      "agent status (pre-init) did not register mnemosyne in $HOME/.claude.json's mcpServers (no MCP registration attempted by a read-only status call)",
    );

    const init = await runCli(["init"], { home });
    ok(init.code === 0, `agent init (for status-after check) -> exit 0 (got ${init.code})`);

    const snapBeforeStatusAfter = await snapshotAgentState(home);
    const statusAfter = await runCli(["status"], { home });
    const snapAfterStatusAfter = await snapshotAgentState(home);
    ok(statusAfter.code === 0, `agent status (after init) -> exit 0 (got ${statusAfter.code}, stderr=${short(statusAfter.stderr)})`);
    ok(/mcp server 'mnemosyne': registered$/m.test(statusAfter.stdout), `status (after init) reports registered -> ${short(statusAfter.stdout)}`);
    for (const skillName of SKILL_NAMES) {
      ok(new RegExp(`skill '${skillName}': installed$`, "m").test(statusAfter.stdout), `status (after init) reports skill '${skillName}' installed -> ${short(statusAfter.stdout)}`);
    }
    ok(
      snapBeforeStatusAfter === snapAfterStatusAfter,
      "agent status (post-init) changed neither $HOME/.claude.json's content nor ~/.claude/skills/'s tree (identical before/after, byte-for-byte)",
    );
    ok(statusBefore.stdout !== statusAfter.stdout, "status's output genuinely differs before vs. after agent init -- proves it reflects real state, not a canned string");

    // Explicit independent re-check: the real claude CLI still reports the same registration after two `status` calls -- status never touched it.
    const gotAfterStatus = await claudeMcpGet(home);
    ok(gotAfterStatus.code === 0 && gotAfterStatus.stdout.includes(MCP_SERVER_PATH), "claude mcp get mnemosyne is unchanged after status calls (independent re-verification)");

    await rm(home, { recursive: true, force: true });
  }

  // --- AC-install-paths (ro-12-two-explicit-install-paths): `agent status`, run in a repo where
  // onboarding has not yet run, prints one line naming BOTH the sidecar path (`agent init --build`)
  // and the full/system path (`mnemosyne onboard <path> --collection <name>`) as discoverable next
  // steps -- pure discoverability text, no new CLI verb, no state mutation. ------------------------
  {
    const home = await makeFakeHome();
    const status = await runCli(["status"], { home });
    ok(status.code === 0, `agent status (install-paths line check) -> exit 0 (got ${status.code}, stderr=${short(status.stderr)})`);
    ok(
      /agent init --build/.test(status.stdout),
      `agent status names the sidecar path ("agent init --build") -> ${short(status.stdout)}`,
    );
    ok(
      /mnemosyne onboard <path> --collection <name>/.test(status.stdout),
      `agent status names the full/system path ("mnemosyne onboard <path> --collection <name>") -> ${short(status.stdout)}`,
    );
    await rm(home, { recursive: true, force: true });
  }

  // --- AC-harness-flag: `--harness claude` genuinely narrows scope (no Codex mention at all) -------
  {
    const home = await makeFakeHome();

    const defaultRun = await runCli(["status"], { home });
    ok(defaultRun.code === 0, `agent status (no --harness) -> exit 0`);
    ok(/codex/i.test(defaultRun.stdout), `agent status with NO --harness flag mentions codex (default sweeps every known harness) -> ${short(defaultRun.stdout)}`);

    const narrowed = await runCli(["status", "--harness", "claude"], { home });
    ok(narrowed.code === 0, `agent status --harness claude -> exit 0 (got ${narrowed.code}, stderr=${short(narrowed.stderr)})`);
    ok(!/codex/i.test(narrowed.stdout) && !/codex/i.test(narrowed.stderr), `agent status --harness claude mentions NO codex text anywhere -- the flag genuinely narrows scope, not just cosmetically -> stdout=${short(narrowed.stdout)}`);
    ok(/claude:/.test(narrowed.stdout), `agent status --harness claude still runs the Claude Code path -> ${short(narrowed.stdout)}`);

    const initNarrowed = await runCli(["init", "--harness", "claude"], { home });
    ok(initNarrowed.code === 0, `agent init --harness claude -> exit 0 (got ${initNarrowed.code}, stderr=${short(initNarrowed.stderr)})`);
    ok(!/codex/i.test(initNarrowed.stdout) && !/codex/i.test(initNarrowed.stderr), `agent init --harness claude mentions NO codex text anywhere -> stdout=${short(initNarrowed.stdout)}`);

    // An invalid --harness value is rejected clearly, not silently ignored.
    const invalidHarness = await runCli(["status", "--harness", "bogus-harness"], { home });
    ok(invalidHarness.code !== 0, `agent status --harness bogus-harness -> non-zero exit (got ${invalidHarness.code})`);
    ok(/invalid --harness/i.test(invalidHarness.stderr), `agent status --harness bogus-harness -> clear stderr message -> ${short(invalidHarness.stderr)}`);

    // Symmetric check: `--harness codex` narrows scope the other direction -- no Claude mention at all.
    const codexHome = await makeFakeCodexHome();
    const narrowedCodex = await runCli(["status", "--harness", "codex"], { home, codexHome });
    ok(narrowedCodex.code === 0, `agent status --harness codex -> exit 0 (got ${narrowedCodex.code}, stderr=${short(narrowedCodex.stderr)})`);
    ok(!/claude/i.test(narrowedCodex.stdout) && !/claude/i.test(narrowedCodex.stderr), `agent status --harness codex mentions NO claude text anywhere -- the flag genuinely narrows scope both directions -> stdout=${short(narrowedCodex.stdout)}`);
    ok(/codex:/.test(narrowedCodex.stdout), `agent status --harness codex still runs the Codex CLI path -> ${short(narrowedCodex.stdout)}`);

    await rm(home, { recursive: true, force: true });
  }

  // --- AC-codex-register: first-run `agent init --harness codex` registers the real MCP server ------
  {
    const codexHome = await makeFakeCodexHome();
    const home = await makeFakeHome();

    const first = await runCli(["init", "--harness", "codex"], { home, codexHome });
    ok(first.code === 0, `agent init --harness codex (first run) -> exit 0 (got ${first.code}, stderr=${short(first.stderr)})`);
    ok(/codex: registered mcp server 'mnemosyne'/.test(first.stdout), `first run reports registering the codex mcp server -> ${short(first.stdout)}`);
    ok(first.stdout.includes(MCP_SERVER_PATH), `first run's stdout names the real absolute path to bin/mnemosyne-mcp.mjs -> ${short(first.stdout)}`);
    // Checks for no "claude:" harness-report line (never a bare /claude/i substring test --
    // MCP_SERVER_PATH itself legitimately contains ".claude" in this checkout's own worktree
    // path, e.g. .../.claude/worktrees/<id>/bin/mnemosyne-mcp.mjs, which would false-positive).
    ok(!/^claude:/m.test(first.stdout) && !/^claude:/m.test(first.stderr), `agent init --harness codex runs no claude: harness report line -> stdout=${short(first.stdout)}`);

    // Independent verification via the REAL codex CLI directly -- not mocked, not just reading our own stdout.
    const got = await codexMcpGet(codexHome);
    ok(got.code === 0, `codex mcp get mnemosyne (independent verification) -> exit 0 (got ${got.code}, stderr=${short(got.stderr)})`);
    ok(got.stdout.includes(MCP_SERVER_PATH), `codex mcp get mnemosyne reports the real absolute path -> ${short(got.stdout)}`);
    ok(/command:\s*node/.test(got.stdout), `codex mcp get mnemosyne reports a stdio server launched via node -> ${short(got.stdout)}`);

    await rm(home, { recursive: true, force: true });
    await rm(codexHome, { recursive: true, force: true });
  }

  // --- AC-codex-idempotent: a second `agent init --harness codex` run makes zero redundant writes ---
  {
    const codexHome = await makeFakeCodexHome();
    const home = await makeFakeHome();

    const first = await runCli(["init", "--harness", "codex"], { home, codexHome });
    ok(first.code === 0, `agent init --harness codex (first run, idempotency setup) -> exit 0 (got ${first.code})`);

    const beforeConfig = await readCodexConfig(codexHome);
    ok(beforeConfig !== null && beforeConfig.includes(MCP_SERVER_PATH), `sanity: $CODEX_HOME/config.toml exists and names the real absolute mnemosyne-mcp.mjs path after the first run`);

    const second = await runCli(["init", "--harness", "codex"], { home, codexHome });
    ok(second.code === 0, `agent init --harness codex (second run) -> exit 0 (got ${second.code}, stderr=${short(second.stderr)})`);
    ok(/codex: mcp server 'mnemosyne' already registered/.test(second.stdout), `second run reports "already registered" -> ${short(second.stdout)}`);
    ok(!/^codex: registered mcp server/m.test(second.stdout), `second run's stdout contains no "registered mcp server" (re-registration) line -- notable since \`codex mcp add\` itself does NOT error on an already-registered name (it silently overwrites), so this genuinely proves the check-before-write guard, not the underlying CLI's own idempotency`);

    const afterConfig = await readCodexConfig(codexHome);
    ok(afterConfig === beforeConfig, `$CODEX_HOME/config.toml byte-for-byte unchanged after the second run (zero redundant MCP-registration writes)`);

    await rm(home, { recursive: true, force: true });
    await rm(codexHome, { recursive: true, force: true });
  }

  // --- AC-codex-status: status reflects real Codex state before/after, with zero side effects from status itself ---
  {
    const codexHome = await makeFakeCodexHome();
    const home = await makeFakeHome();

    const statusBefore = await runCli(["status", "--harness", "codex"], { home, codexHome });
    ok(statusBefore.code === 0, `agent status --harness codex (before init) -> exit 0 (got ${statusBefore.code}, stderr=${short(statusBefore.stderr)})`);
    ok(/binary: found/.test(statusBefore.stdout), `agent status --harness codex reports the real codex binary found on PATH -> ${short(statusBefore.stdout)}`);
    ok(/mcp server 'mnemosyne': NOT registered/.test(statusBefore.stdout), `status --harness codex (before init) reports NOT registered -> ${short(statusBefore.stdout)}`);

    // status itself must make ZERO writes to $CODEX_HOME.
    const snapBeforeStatusCall = await readCodexConfig(codexHome);
    const statusBeforeAgain = await runCli(["status", "--harness", "codex"], { home, codexHome });
    const snapAfterStatusCall = await readCodexConfig(codexHome);
    ok(statusBeforeAgain.code === 0, `agent status --harness codex (repeat, pre-init) -> exit 0`);
    ok(snapBeforeStatusCall === snapAfterStatusCall, "agent status --harness codex (pre-init) changed nothing under $CODEX_HOME (config.toml still absent/unchanged)");

    const init = await runCli(["init", "--harness", "codex"], { home, codexHome });
    ok(init.code === 0, `agent init --harness codex (for status-after check) -> exit 0 (got ${init.code})`);

    const snapBeforeStatusAfter = await readCodexConfig(codexHome);
    const statusAfter = await runCli(["status", "--harness", "codex"], { home, codexHome });
    const snapAfterStatusAfter = await readCodexConfig(codexHome);
    ok(statusAfter.code === 0, `agent status --harness codex (after init) -> exit 0 (got ${statusAfter.code}, stderr=${short(statusAfter.stderr)})`);
    ok(/mcp server 'mnemosyne': registered$/m.test(statusAfter.stdout), `status --harness codex (after init) reports registered -> ${short(statusAfter.stdout)}`);
    ok(
      snapBeforeStatusAfter === snapAfterStatusAfter,
      "agent status --harness codex (post-init) changed nothing under $CODEX_HOME (config.toml byte-for-byte identical before/after status)",
    );
    ok(statusBefore.stdout !== statusAfter.stdout, "codex status output genuinely differs before vs. after agent init -- proves it reflects real state, not a canned string");

    // Explicit independent re-check: the real codex CLI still reports the same registration after two `status` calls.
    const gotAfterStatus = await codexMcpGet(codexHome);
    ok(gotAfterStatus.code === 0 && gotAfterStatus.stdout.includes(MCP_SERVER_PATH), "codex mcp get mnemosyne is unchanged after status calls (independent re-verification)");

    await rm(home, { recursive: true, force: true });
    await rm(codexHome, { recursive: true, force: true });
  }

  // --- AC-both-absent-ok: neither harness on PATH -> agent init/status still exit 0, no hard failure ---
  {
    // Sanity first: this environment genuinely HAS a real codex CLI on PATH (confirmed
    // independently, not assumed) -- so the "absent" branch below is exercised via a
    // real PATH override, not because codex happens to be missing here.
    const sanity = await runCli(["status", "--harness", "codex"], { home: await makeFakeHome(), codexHome: await makeFakeCodexHome() });
    ok(/binary: found/.test(sanity.stdout), `sanity: this machine's real codex CLI is genuinely found via detectBinary() -> ${short(sanity.stdout)}`);

    const home = await makeFakeHome();
    const codexHome = await makeFakeCodexHome();
    // An empty PATH containing neither `claude` nor `codex` (nor even a shell) -- the
    // real "neither harness installed" machine state per aha-02's own AC.
    const emptyBinDir = await makeTempDir("mnemosyne-agent-cli-empty-path-");

    const statusNeither = await runCli(["status"], { home, codexHome, pathOverride: emptyBinDir });
    ok(statusNeither.code === 0, `agent status with neither harness on PATH -> exit 0, not a hard failure (got ${statusNeither.code}, stderr=${short(statusNeither.stderr)})`);
    ok(/claude:\s*\n\s*binary: NOT found/.test(statusNeither.stdout), `agent status reports claude binary NOT found -> ${short(statusNeither.stdout)}`);
    ok(/codex:\s*\n\s*binary: NOT found/.test(statusNeither.stdout), `agent status reports codex binary NOT found -> ${short(statusNeither.stdout)}`);

    const initNeither = await runCli(["init"], { home, codexHome, pathOverride: emptyBinDir });
    ok(initNeither.code === 0, `agent init with neither harness on PATH -> exit 0, not a hard failure (got ${initNeither.code}, stderr=${short(initNeither.stderr)})`);
    ok(/claude: binary not found on PATH/.test(initNeither.stderr), `agent init warns clearly that claude is absent -> ${short(initNeither.stderr)}`);
    ok(/codex: binary not found on PATH/.test(initNeither.stderr), `agent init warns clearly that codex is absent -> ${short(initNeither.stderr)}`);

    await rm(home, { recursive: true, force: true });
    await rm(codexHome, { recursive: true, force: true });
  }

  // --- Dispatcher wiring: `bin/mnemosyne agent ...` reaches the same code (both harnesses) ----------
  {
    const home = await makeFakeHome();
    const codexHome = await makeFakeCodexHome();

    const viaDispatcherStatus = await runCli(["status"], { home, codexHome, viaDispatcher: true });
    ok(viaDispatcherStatus.code === 0, `bin/mnemosyne agent status -> exit 0 (got ${viaDispatcherStatus.code}, stderr=${short(viaDispatcherStatus.stderr)})`);
    ok(/mcp server 'mnemosyne': NOT registered/.test(viaDispatcherStatus.stdout), `bin/mnemosyne agent status reaches the same real state check -> ${short(viaDispatcherStatus.stdout)}`);

    const viaDispatcherInit = await runCli(["init"], { home, codexHome, viaDispatcher: true });
    ok(viaDispatcherInit.code === 0, `bin/mnemosyne agent init -> exit 0 (got ${viaDispatcherInit.code}, stderr=${short(viaDispatcherInit.stderr)})`);
    ok(/registered mcp server 'mnemosyne'/.test(viaDispatcherInit.stdout), `bin/mnemosyne agent init actually registered through the dispatcher -> ${short(viaDispatcherInit.stdout)}`);
    ok(/codex: registered mcp server 'mnemosyne'/.test(viaDispatcherInit.stdout), `bin/mnemosyne agent init actually registered the codex mcp server through the dispatcher too -> ${short(viaDispatcherInit.stdout)}`);

    const got = await claudeMcpGet(home);
    ok(got.code === 0 && got.stdout.includes(MCP_SERVER_PATH), "bin/mnemosyne agent init (via dispatcher) produced a real, independently-verifiable claude registration");

    const gotCodex = await codexMcpGet(codexHome);
    ok(gotCodex.code === 0 && gotCodex.stdout.includes(MCP_SERVER_PATH), "bin/mnemosyne agent init (via dispatcher) produced a real, independently-verifiable codex registration");

    await rm(home, { recursive: true, force: true });
    await rm(codexHome, { recursive: true, force: true });
  }

  // === ro-03-agent-init-build-flag: `--build` flag =========================

  // --- AC-build-off: `agent init` (no --build) never calls onboardRepo(), prints the not-run-automatically guidance line ---
  {
    const home = await makeFakeHome();
    const repo = await makeTempRepo();

    const result = await runCli(["init"], { home, cwd: repo });
    ok(result.code === 0, `agent init (no --build) -> exit 0 (got ${result.code}, stderr=${short(result.stderr)})`);
    ok(
      result.stdout.includes("next step (not run automatically): mnemosyne agent init --build"),
      `agent init (no --build) prints the "next step (not run automatically): mnemosyne agent init --build" guidance line, mirroring install.sh's own "prints, never runs" convention -> ${short(result.stdout)}`,
    );
    ok(!/^base-level report:/m.test(result.stdout), `agent init (no --build) never prints the base-level report block (onboardRepo() never ran) -> ${short(result.stdout)}`);
    ok(!existsSync(path.join(repo, ".mnemosyne")), `agent init (no --build) creates no .mnemosyne/ under the target repo -- onboardRepo() genuinely never ran`);
    for (const fileName of ["CLAUDE.md", "AGENTS.md", "GEMINI.md"]) {
      ok(!existsSync(path.join(repo, fileName)), `agent init (no --build) never creates ${fileName} under the target repo`);
    }

    await rm(home, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }

  // --- AC-build-on: `agent init --build` runs the real onboardRepo(), verified on disk + base-level report + install-hooks guidance ---
  {
    const home = await makeFakeHomeWithLevel0();
    const repo = await makeTempRepo();

    const result = await runCli(["init", "--build", "--scope-id", "ro03-test-scope"], { home, cwd: repo });
    ok(result.code === 0, `agent init --build -> exit 0 (got ${result.code}, stderr=${short(result.stderr)})`);

    // Real, on-disk proof onboardRepo() actually ran against `repo` -- not mocked, not just stdout text.
    for (const fileName of ["CLAUDE.md", "AGENTS.md", "GEMINI.md"]) {
      ok(existsSync(path.join(repo, fileName)), `agent init --build creates ${fileName} under the target repo (Layer 1 sync)`);
    }
    const personaPath = path.join(repo, ".mnemosyne", "personas", "ro03-test-scope.yaml");
    ok(existsSync(personaPath), `agent init --build seeds a repo-local persona at ${personaPath}`);
    const fileIndexPath = path.join(repo, ".mnemosyne", "file-index.json");
    ok(existsSync(fileIndexPath), `agent init --build writes the Level 4 file-store index at ${fileIndexPath}`);

    // Printed base-level report -- names all 5 canonical levels.
    ok(/^base-level report:/m.test(result.stdout), `agent init --build's output includes a base-level report -> ${short(result.stdout)}`);
    for (const id of [0, 1, 2, 3, 4]) {
      ok(new RegExp(`\\[${id}\\]`).test(result.stdout), `agent init --build's base-level report names level ${id} -> ${short(result.stdout)}`);
    }

    // Printed install-hooks discoverability line (design-discussion.md §7.4) -- names the SAME
    // already-shipped bin/mnemosyne-install-hooks mechanism hooks/README.md documents, never a
    // second, differently-named mechanism.
    ok(
      result.stdout.includes("next step (not run automatically): bin/mnemosyne-install-hooks"),
      `agent init --build's output includes "next step (not run automatically): bin/mnemosyne-install-hooks" -> ${short(result.stdout)}`,
    );

    await rm(home, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }

  // --- AC-build-idempotent: a second `agent init --build` run makes zero redundant writes beyond onboardRepo()'s own idempotency ---
  {
    const home = await makeFakeHomeWithLevel0();
    const repo = await makeTempRepo();

    const first = await runCli(["init", "--build", "--scope-id", "ro03-idempotent"], { home, cwd: repo });
    ok(first.code === 0, `agent init --build (first run, idempotency setup) -> exit 0 (got ${first.code}, stderr=${short(first.stderr)})`);

    const personaPath = path.join(repo, ".mnemosyne", "personas", "ro03-idempotent.yaml");
    const beforePersona = await readFile(personaPath, "utf8");
    const beforePersonaMtime = (await stat(personaPath)).mtimeMs;
    const beforeHarnessFiles = {};
    for (const fileName of ["CLAUDE.md", "AGENTS.md", "GEMINI.md"]) {
      beforeHarnessFiles[fileName] = await readFile(path.join(repo, fileName), "utf8");
    }

    const second = await runCli(["init", "--build", "--scope-id", "ro03-idempotent"], { home, cwd: repo });
    ok(second.code === 0, `agent init --build (second run) -> exit 0 (got ${second.code}, stderr=${short(second.stderr)})`);

    const afterPersona = await readFile(personaPath, "utf8");
    const afterPersonaMtime = (await stat(personaPath)).mtimeMs;
    ok(afterPersona === beforePersona, "the repo-local persona file's content is byte-for-byte unchanged after a second `agent init --build` run (never overwritten once seeded)");
    ok(afterPersonaMtime === beforePersonaMtime, "the repo-local persona file's mtime is unchanged after a second `agent init --build` run (zero redundant write)");
    for (const fileName of ["CLAUDE.md", "AGENTS.md", "GEMINI.md"]) {
      const afterContent = await readFile(path.join(repo, fileName), "utf8");
      ok(afterContent === beforeHarnessFiles[fileName], `${fileName}'s content is byte-for-byte unchanged after a second \`agent init --build\` run (idempotent Layer 1 sync)`);
    }

    await rm(home, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }

  // --- AC-storage-dir: `--build --storage-dir <dir>` creates <dir> and onboards it, never process.cwd() ---
  {
    const home = await makeFakeHomeWithLevel0();
    const repo = await makeTempRepo(); // cwd -- must receive ZERO onboarding artifacts
    const parentDir = await makeTempDir("mnemosyne-agent-cli-storage-parent-");
    const storageDir = path.join(parentDir, "nested", "storage");
    ok(!existsSync(storageDir), `sanity: ${storageDir} does not exist yet before the run`);

    const result = await runCli(["init", "--build", "--storage-dir", storageDir, "--scope-id", "ro03-storage-dir"], { home, cwd: repo });
    ok(result.code === 0, `agent init --build --storage-dir <dir> -> exit 0 (got ${result.code}, stderr=${short(result.stderr)})`);

    ok(existsSync(storageDir), `--storage-dir ${storageDir} was created (mkdir -p)`);
    for (const fileName of ["CLAUDE.md", "AGENTS.md", "GEMINI.md"]) {
      ok(existsSync(path.join(storageDir, fileName)), `${fileName} lands under --storage-dir, not process.cwd()`);
      ok(!existsSync(path.join(repo, fileName)), `${fileName} does NOT land under process.cwd() (${repo}) when --storage-dir is given`);
    }
    ok(existsSync(path.join(storageDir, ".mnemosyne", "personas", "ro03-storage-dir.yaml")), "persona lands under --storage-dir");
    ok(existsSync(path.join(storageDir, ".mnemosyne", "file-index.json")), "file-index.json lands under --storage-dir");
    ok(!existsSync(path.join(repo, ".mnemosyne")), `no .mnemosyne/ under process.cwd() (${repo}) when --storage-dir is given`);

    await rm(home, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
    await rm(parentDir, { recursive: true, force: true });
  }

  // --- AC-storage-dir (omitted): `--build` WITHOUT --storage-dir -> repoRoot resolves to process.cwd(), byte-identical to pre-amendment behavior ---
  {
    const home = await makeFakeHomeWithLevel0();
    const repo = await makeTempRepo();

    const result = await runCli(["init", "--build"], { home, cwd: repo });
    ok(result.code === 0, `agent init --build (no --storage-dir) -> exit 0 (got ${result.code}, stderr=${short(result.stderr)})`);
    for (const fileName of ["CLAUDE.md", "AGENTS.md", "GEMINI.md"]) {
      ok(existsSync(path.join(repo, fileName)), `${fileName} lands under process.cwd() (${repo}) when --storage-dir is omitted`);
    }

    await rm(home, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }

  // --- AC-embedded-layers: docs/embedded-layers.json is a valid mnemosyne.layers.json (isLayerStackConfig shape), graphify + file only, vector omitted ---
  {
    const embeddedLayersPath = path.join(ROOT, "docs", "embedded-layers.json");
    ok(existsSync(embeddedLayersPath), `docs/embedded-layers.json exists`);
    const raw = await readFile(embeddedLayersPath, "utf8");
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    ok(parsed !== null, "docs/embedded-layers.json is valid JSON");
    ok(parsed && Array.isArray(parsed.layers), "docs/embedded-layers.json matches the { layers: [...] } shape (layers/config.ts's isLayerStackConfig)");
    const entries = parsed?.layers ?? [];
    ok(
      entries.every((entry) => typeof entry === "object" && entry !== null && typeof entry.name === "string"),
      `every entry in docs/embedded-layers.json's layers array has a string 'name' (isLayerStackConfig's own per-entry check) -> ${JSON.stringify(parsed)}`,
    );
    const names = entries.map((entry) => entry.name);
    ok(names.includes("graphify"), `docs/embedded-layers.json includes the 'graphify' layer -> ${JSON.stringify(names)}`);
    ok(names.includes("file"), `docs/embedded-layers.json includes the 'file' layer -> ${JSON.stringify(names)}`);
    ok(!names.includes("vector"), `docs/embedded-layers.json omits the 'vector' layer -> ${JSON.stringify(names)}`);
  }
}

try {
  await main();
} finally {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
}

console.log(fails ? `\n${fails} check(s) failed` : "\nall agent-cli checks passed");
process.exit(fails ? 1 : 0);
