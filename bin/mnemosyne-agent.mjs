#!/usr/bin/env node
// bin/mnemosyne-agent.mjs — `mnemosyne agent init` / `mnemosyne agent status`
// (aha-01-agent-init-status-claude, epic: mnemosyne-agent-harness-install).
//
// Mirrors Portunus's own shipped `agent init`/`agent status` pattern
// (design-discussion.md §1.1): detects a harness on PATH, registers
// bin/mnemosyne-mcp.mjs (already exists, already tested — this file only
// REGISTERS it, never modifies it) as an MCP server named "mnemosyne", and
// (Claude Code only) copies this repo's skills/ into ~/.claude/skills/ so a
// freshly-cloned checkout is immediately usable from inside a harness, not
// just via this CLI.
//
// This ticket (aha-01) implements the Claude Code harness only — the
// "certain, locally-verifiable half" per research-brief.md §1/§4. The Codex
// CLI harness is aha-02-agent-init-status-codex, a separate, dependent
// ticket, since its exact MCP-registration command shape is unverified
// locally (no Codex CLI reference anywhere in this repo). `harnessesToRun()`
// below is the intended extension point: add a `codex` branch to
// runInit/runStatus alongside `initClaude`/`statusClaude` rather than
// duplicating the CLI/arg-parsing shell.
//
// Usage:
//   bin/mnemosyne-agent.mjs init   [--harness claude|codex]
//   bin/mnemosyne-agent.mjs status [--harness claude|codex]
//
//   --harness claude|codex   narrow to exactly one harness. Omitted =
//                             attempt every known harness (today: just
//                             "claude" for real; "codex" prints an honest
//                             "not yet implemented" note and is otherwise a
//                             no-op — never a hard failure, matching
//                             aha-02's own "one harness missing/unsupported
//                             must not fail the other" contract).
//                             `--harness codex` on its own (this ticket, pre
//                             aha-02) is a LOUD, non-zero-exit failure —
//                             asked-for-and-not-done must never look like
//                             success.
//
// Idempotency (both init and status), matching bin/mnemosyne-install-hooks's
// and bin/mnemosyne-install-git-hooks's own established conventions:
//   - MCP registration: check-before-write via a targeted, single-server
//     lookup (see the `claude mcp get` vs `claude mcp list` comment on
//     mcpRegistered() below) — `claude mcp add` is only ever invoked when
//     that check reports "not registered", so a second `init` run makes
//     zero MCP-registration writes.
//   - Skill copy: byte-for-byte compare before write (see copySkill()) — a
//     file whose destination content already matches is left completely
//     untouched (no write syscall, no mtime bump), so a second `init` run
//     makes zero skill-file writes either.
//   - `status` never calls `claude mcp add` or writes any skill file — it
//     only ever calls the same read-only targeted lookup / fs.existsSync
//     checks `init` uses to decide whether to act.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");

export const MCP_SERVER_NAME = "mnemosyne";
export const MCP_SERVER_PATH = path.join(REPO_ROOT, "bin", "mnemosyne-mcp.mjs");

// research-brief.md §2: exactly 2 real, current Claude Code skills exist in
// this repo today (not Portunus's 4) — mnemosyne-standalone (the "harness
// plugin interaction" piece) and mnemosyne-persona-interview.
export const SKILLS_SRC_DIR = path.join(REPO_ROOT, "skills");
export const SKILL_NAMES = ["mnemosyne-standalone", "mnemosyne-persona-interview"];

export function skillsDestDir(home = homedir()) {
  return path.join(home, ".claude", "skills");
}

// A harness command hanging (network stall, unexpected prompt, etc.) must
// never turn `agent status` into the same kind of multi-second-plus stall
// this ticket exists to avoid (see mcpRegistered()'s doc comment) — every
// exec below carries this same bounded timeout.
const EXEC_TIMEOUT_MS = 30_000;

// This repo ships its OWN project-scoped `.mcp.json` at REPO_ROOT (04a8011,
// "register mnemosyne-mcp as this repo's own project-scoped MCP server") —
// a real, separate, pre-existing "mnemosyne" registration Claude Code uses
// while working ON this repo. `claude mcp get <name>`/`claude mcp add`
// resolve project scope from CWD, so running them with CWD anywhere under
// this checkout (which is exactly where a Mnemosyne developer would most
// often invoke `mnemosyne agent status`) would let that unrelated
// project-scoped entry stand in for the "user"-scope registration agent
// init/status actually cares about — confirmed by hand during this ticket's
// own testing (see test/agent-cli.mjs's doc comment for the exact
// before/after). `agent init`/`agent status` are about the OPERATOR's
// global, cross-project Claude Code config, not "does THIS cwd happen to
// have a same-named server" — so every harness-CLI exec below pins CWD to
// homedir() (never process.cwd()), sidestepping any ambient project .mcp.json
// entirely, in this checkout or anyone else's.
const HARNESS_EXEC_CWD = () => homedir();

// --- harness binary detection ---------------------------------------------
/** True if `name` resolves on PATH at all (regardless of its own exit code for `--version`) — false only on a genuine "no such command" (ENOENT). */
export async function detectBinary(name, { exec = execFileAsync } = {}) {
  try {
    await exec(name, ["--version"], { timeout: EXEC_TIMEOUT_MS, cwd: HARNESS_EXEC_CWD() });
    return true;
  } catch (e) {
    return e && e.code !== "ENOENT";
  }
}

// --- MCP registration (Claude Code) ---------------------------------------
// design-discussion.md §1.1 / aha-01's own acceptance criteria: the
// registration CHECK must be a single, targeted lookup of exactly the
// "mnemosyne" server — `claude mcp get mnemosyne` — and must NEVER become
// `claude mcp list`. `list` health-checks EVERY MCP server configured on
// the machine (not just this one), which is the exact, named, already-fixed
// bug from Portunus's real build (30+ seconds observed there). Do not
// "simplify" this back to `list` in a future edit — it would turn `agent
// status` (meant to be instant and read-only) into a slow, network-touching
// call, and would defeat the entire point of this comment existing.
export async function mcpRegistered(name = MCP_SERVER_NAME, { exec = execFileAsync } = {}) {
  try {
    await exec("claude", ["mcp", "get", name], { timeout: EXEC_TIMEOUT_MS, cwd: HARNESS_EXEC_CWD() });
    return true;
  } catch {
    return false;
  }
}

/** Registers `serverPath` under `name` at Claude Code's "user" scope (available in every project, not just the invoking cwd's) via stdio transport — the shape `claude mcp add --help` itself documents for a locally-launched stdio server. Caller must have already confirmed via mcpRegistered() that this is not a redundant call — `claude mcp add` itself errors (non-zero exit) on an already-registered name rather than being idempotent on its own. */
export async function registerMcp({ name = MCP_SERVER_NAME, serverPath = MCP_SERVER_PATH, exec = execFileAsync } = {}) {
  await exec("claude", ["mcp", "add", "-s", "user", name, "--", "node", serverPath], {
    timeout: EXEC_TIMEOUT_MS,
    cwd: HARNESS_EXEC_CWD(),
  });
}

// --- skill install (Claude Code only — research-brief.md §2/§4: Codex CLI
// has no analogous skill-file mechanism) ------------------------------------
function listSkillFiles(skillDir) {
  return readdirSync(skillDir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();
}

/**
 * Copies skillName's full directory contents (every file it needs to
 * function — SKILL.md plus any .mjs/.d.mts, per aha-01's own acceptance
 * criteria) from srcDir/<skillName>/ into destDir/<skillName>/.
 * Idempotent by content, not just by presence: a destination file whose
 * bytes already match the source is left completely untouched (no write,
 * no mtime bump) — only a missing or genuinely-changed file is written, so
 * re-running after this repo's skill files change updates them in place
 * rather than silently staying stale, while a true no-op second run makes
 * zero writes at all. Mirrors bin/mnemosyne-install-hooks's own
 * check-before-write idempotency convention.
 */
export function copySkill(skillName, { srcDir = SKILLS_SRC_DIR, destDir = skillsDestDir() } = {}) {
  const src = path.join(srcDir, skillName);
  const dest = path.join(destDir, skillName);
  mkdirSync(dest, { recursive: true });
  const files = listSkillFiles(src);
  const written = [];
  const unchanged = [];
  for (const file of files) {
    const content = readFileSync(path.join(src, file));
    const destPath = path.join(dest, file);
    if (existsSync(destPath) && readFileSync(destPath).equals(content)) {
      unchanged.push(file);
      continue;
    }
    writeFileSync(destPath, content);
    written.push(file);
  }
  return { files, written, unchanged };
}

export function skillInstalled(skillName, { destDir = skillsDestDir() } = {}) {
  return existsSync(path.join(destDir, skillName, "SKILL.md"));
}

// --- Claude Code harness: init / status -------------------------------------
export async function initClaude({ home = homedir(), log = console.log, warn = console.error, exec = execFileAsync } = {}) {
  const report = { harness: "claude", binaryFound: false, mcp: null, skills: [] };

  report.binaryFound = await detectBinary("claude", { exec });
  if (!report.binaryFound) {
    warn("claude: binary not found on PATH -- skipping Claude Code harness registration");
    return report;
  }

  if (await mcpRegistered(MCP_SERVER_NAME, { exec })) {
    log(`claude: mcp server '${MCP_SERVER_NAME}' already registered (claude mcp get ${MCP_SERVER_NAME}) -- skipped`);
    report.mcp = { action: "already-registered" };
  } else {
    await registerMcp({ exec });
    log(`claude: registered mcp server '${MCP_SERVER_NAME}' -> node ${MCP_SERVER_PATH}`);
    report.mcp = { action: "registered" };
  }

  const destDir = skillsDestDir(home);
  for (const skillName of SKILL_NAMES) {
    const { written, unchanged } = copySkill(skillName, { destDir });
    if (written.length === 0) {
      log(`claude: skill '${skillName}' already installed -- skipped (${unchanged.length} file(s) unchanged)`);
      report.skills.push({ skillName, action: "already-installed", written, unchanged });
    } else {
      log(
        `claude: skill '${skillName}' installed (${written.length} file(s) written${
          unchanged.length ? `, ${unchanged.length} already up to date` : ""
        })`
      );
      report.skills.push({ skillName, action: "installed", written, unchanged });
    }
  }

  return report;
}

/** Read-only: same targeted `claude mcp get` lookup and fs.existsSync checks init uses, but init() never calls registerMcp()/copySkill() here — see the module doc comment's idempotency section. */
export async function statusClaude({ home = homedir(), exec = execFileAsync } = {}) {
  const binaryFound = await detectBinary("claude", { exec });
  const registered = binaryFound ? await mcpRegistered(MCP_SERVER_NAME, { exec }) : false;
  const destDir = skillsDestDir(home);
  const skills = SKILL_NAMES.map((skillName) => ({ skillName, installed: skillInstalled(skillName, { destDir }) }));
  return { harness: "claude", binaryFound, mcpRegistered: registered, skills };
}

function printClaudeStatus(report, log) {
  log("claude:");
  log(`  binary: ${report.binaryFound ? "found" : "NOT found on PATH"}`);
  log(`  mcp server '${MCP_SERVER_NAME}': ${report.mcpRegistered ? "registered" : "NOT registered"}`);
  for (const s of report.skills) {
    log(`  skill '${s.skillName}': ${s.installed ? "installed" : "NOT installed"}`);
  }
}

// --- Codex CLI harness placeholder (aha-02) ---------------------------------
// Deliberately NOT implemented here — see the module doc comment. Kept as a
// named, honest branch (never silently dropped from --harness's accepted
// values) so `agent init`/`agent status` with no --harness flag still
// completes the Claude Code half normally and says plainly that Codex isn't
// available yet, rather than pretending only one harness ever existed.
function codexNotYetImplementedMessage() {
  return "codex: not yet implemented in this build -- see aha-02-agent-init-status-codex";
}

// --- CLI ---------------------------------------------------------------
const KNOWN_HARNESSES = ["claude", "codex"];

export function parseArgs(argv) {
  const args = { harness: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--harness") args.harness = argv[++i];
  }
  return args;
}

/** Resolves the harness list to attempt: exactly `[requested]` when --harness narrows scope, else every known harness (today: claude for real, codex as an honest no-op — see codexNotYetImplementedMessage()). */
function harnessesToRun(requested) {
  if (requested) {
    if (!KNOWN_HARNESSES.includes(requested)) {
      throw new Error(`invalid --harness '${requested}' -- must be one of: ${KNOWN_HARNESSES.join(", ")}`);
    }
    return [requested];
  }
  return KNOWN_HARNESSES;
}

export async function runInit(argv, { log = console.log, warn = console.error } = {}) {
  const { harness } = parseArgs(argv);
  const harnesses = harnessesToRun(harness);
  let ok = true;
  for (const h of harnesses) {
    if (h === "claude") {
      await initClaude({ log, warn });
    } else if (h === "codex") {
      // Explicitly asked for (`--harness codex`) and not implemented -> a
      // loud, non-zero-exit failure, never a silent "success". Reached as
      // part of the default multi-harness sweep (no --harness at all) ->
      // an honest, non-fatal note instead, matching aha-02's own "one
      // harness missing must not fail the other" contract.
      if (harness === "codex") {
        warn(codexNotYetImplementedMessage());
        ok = false;
      } else {
        log(codexNotYetImplementedMessage());
      }
    }
  }
  return ok;
}

export async function runStatus(argv, { log = console.log, warn = console.error } = {}) {
  const { harness } = parseArgs(argv);
  const harnesses = harnessesToRun(harness);
  for (const h of harnesses) {
    if (h === "claude") {
      const report = await statusClaude({});
      printClaudeStatus(report, log);
    } else if (h === "codex") {
      if (harness === "codex") {
        warn(codexNotYetImplementedMessage());
      } else {
        log(codexNotYetImplementedMessage());
      }
    }
  }
  return true;
}

async function main() {
  const [sub, ...rest] = process.argv.slice(2);
  try {
    if (sub === "init") {
      const ok = await runInit(rest);
      process.exit(ok ? 0 : 1);
    } else if (sub === "status") {
      await runStatus(rest);
      process.exit(0);
    } else {
      console.error("usage: mnemosyne agent <init|status> [--harness claude|codex]");
      process.exit(1);
    }
  } catch (e) {
    console.error(`mnemosyne-agent: ${e.message || e}`);
    process.exit(1);
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main();
}
