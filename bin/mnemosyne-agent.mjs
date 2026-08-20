#!/usr/bin/env node
// bin/mnemosyne-agent.mjs — `mnemosyne agent init` / `mnemosyne agent status`
// (aha-01-agent-init-status-claude + aha-02-agent-init-status-codex, epic:
// mnemosyne-agent-harness-install).
//
// Mirrors Portunus's own shipped `agent init`/`agent status` pattern
// (design-discussion.md §1.1): detects a harness on PATH, registers
// bin/mnemosyne-mcp.mjs (already exists, already tested — this file only
// REGISTERS it, never modifies it) as an MCP server named "mnemosyne", and
// (Claude Code only) copies this repo's skills/ into ~/.claude/skills/ so a
// freshly-cloned checkout is immediately usable from inside a harness, not
// just via this CLI.
//
// aha-01 implemented the Claude Code harness only — the "certain,
// locally-verifiable half" per research-brief.md §1/§4. aha-02 (this
// extension) adds the Codex CLI harness: MCP registration only, no skill
// install (research-brief.md §4 / design-discussion.md §1.1 step 3 — Codex
// CLI has no analogous skill-file mechanism, confirmed). Unlike aha-01's own
// planning-time uncertainty, aha-02 was implemented AFTER directly,
// hand-verifying the real, installed `codex` CLI (codex-cli 0.143.0) on this
// machine — not guessed from the operator's Portunus report alone:
//   - `codex mcp add <NAME> -- <COMMAND>...` registers a stdio server (same
//     `--` separator shape as `claude mcp add`). Note: unlike `claude mcp
//     add` (which errors non-zero on an already-registered name), a second
//     `codex mcp add <NAME> ...` call SILENTLY OVERWRITES the existing
//     entry with the new args instead of erroring — hand-verified by
//     calling it twice with different command paths and reading back
//     `codex mcp get`. This makes the check-before-write idempotency
//     pattern (see codexMcpRegistered()) load-bearing for Codex too, for a
//     different reason than Claude's: not to avoid an error, but to avoid a
//     real, silent, redundant re-write of already-correct config on every
//     `init` run.
//   - `codex mcp get <NAME>` is the real, single-server targeted lookup
//     (exit 0 + prints the registered command/args when found, exit 1 +
//     "No MCP server named '<NAME>' found." when not) — the Codex
//     equivalent of `claude mcp get`.
//   - `codex mcp list` exists (and is fast here, unlike Portunus's
//     `claude mcp list` health-check story) but per this ticket's own
//     acceptance criteria is never used for the registration check — only
//     `get`, for the same targeted-lookup discipline as the Claude side.
//   - Codex resolves ALL of its config via `$CODEX_HOME` (default `~/.codex`
//     if unset) — confirmed via `codex --help`'s own text ("Layer
//     $CODEX_HOME/<name>.config.toml on top of the base user config") and by
//     hand: pointing `$CODEX_HOME` at a fresh, empty directory produces a
//     brand-new `config.toml` there with zero interaction with the real
//     `~/.codex/`. Unlike Claude Code's project-scoped `.mcp.json` bug (see
//     HARNESS_EXEC_CWD's comment), Codex's `mcp add`/`mcp get` do NOT
//     resolve anything from CWD — hand-verified by running `codex mcp get`
//     from both a throwaway tmp dir and this repo's own root against the
//     same `$CODEX_HOME` and getting byte-identical output. HARNESS_EXEC_CWD
//     is still applied to Codex's execs below purely for consistency/hygiene
//     with the Claude side, not because Codex needs it.
//
// `harnessesToRun()` below is the shared extension point both harnesses use:
// initClaude/statusClaude and initCodex/statusCodex are parallel, independent
// branches in runInit/runStatus, so one harness being absent, unsupported, or
// erroring never blocks the other.
//
// Usage:
//   bin/mnemosyne-agent.mjs init   [--harness claude|codex]
//   bin/mnemosyne-agent.mjs status [--harness claude|codex]
//
//   --harness claude|codex   narrow to exactly one harness. Omitted =
//                             attempt every known harness (today: both
//                             claude and codex, for real). A harness binary
//                             genuinely absent from PATH is never a hard
//                             failure (for either harness, with or without
//                             --harness naming it) — it's an honest,
//                             clearly-logged skip, since "one of two
//                             possible harnesses isn't installed here" is a
//                             completely normal, expected machine state, not
//                             an error condition.
//
// Loud failure, never silent (design-discussion.md §2's named Codex risk):
// if a harness IS present on PATH but its MCP-registration command fails in
// a way that doesn't mean "not registered yet" (e.g. its real command shape
// has diverged from what's implemented here), that error propagates up
// uncaught — never swallowed into a generic skip — surfacing the exact
// command and the real subprocess stderr via main()'s own top-level catch
// (non-zero exit). See registerMcp()/registerMcpCodex()'s own doc comments.
//
// Idempotency (both init and status), matching bin/mnemosyne-install-hooks's
// and bin/mnemosyne-install-git-hooks's own established conventions:
//   - MCP registration: check-before-write via a targeted, single-server
//     lookup (see the `claude mcp get` vs `claude mcp list` comment on
//     mcpRegistered(), and the `codex mcp get` vs `codex mcp list` comment
//     on codexMcpRegistered(), below) — `claude mcp add`/`codex mcp add` are
//     only ever invoked when that harness's own check reports "not
//     registered", so a second `init` run makes zero MCP-registration
//     writes for either harness.
//   - Skill copy (Claude Code only): byte-for-byte compare before write (see
//     copySkill()) — a file whose destination content already matches is
//     left completely untouched (no write syscall, no mtime bump), so a
//     second `init` run makes zero skill-file writes either.
//   - `status` never calls `claude mcp add`/`codex mcp add` or writes any
//     skill file — it only ever calls the same read-only targeted lookup /
//     fs.existsSync checks `init` uses to decide whether to act.

// ro-03-agent-init-build-flag (epic: mnemosyne-repo-onboarding): Mode B's
// real entry point. Adds a new, OPT-IN `--build` flag (default OFF,
// design-discussion.md section 2.3, grill 3.2) that, once MCP registration
// + skill copy above complete, wires `onboardRepo({ mode: 'standalone',
// repoRoot, scopeId })` (ro-02, lib/mnemosyne/onboarding/onboardRepo.ts) --
// Layer 1 sync, persona seed, first-time file/graph index, and a
// base-level report of which of the 5 canonical memory levels are now
// configured. Absent --build, `agent init` behaves byte-identically to
// before this story (MCP registration + skill copy only, onboardRepo()
// never called) and instead prints a "next step (not run automatically):
// mnemosyne agent init --build" line, mirroring docs/install.sh's own
// established "print, never auto-run a heavy/mutating step" convention one
// level up the stack (the exact reason install.sh itself prints but never
// runs `agent init`).
//
// `--storage-dir <dir>` (design-discussion.md section 7.1 amendment): when
// given, onboardRepo()'s repoRoot becomes <dir> (created via `mkdir -p`
// first if it doesn't exist) instead of process.cwd() -- so a product
// packaging Mnemosyne as its own sidecar memory agent can pin ALL of its
// memory state under one directory it controls, from install tooling that
// isn't coupled to a specific invocation cwd. Omitted: byte-identical to
// this story's pre-amendment repoRoot: process.cwd() design.
//
// --build's completion output also names bin/mnemosyne-install-hooks as a
// next step (design-discussion.md section 7.4) -- the SAME already-shipped
// pre-recall/post-remember hook loop (hooks/README.md) syncAllHarnesses()
// (called inside onboardRepo()) already splices mandate text about into
// every synced repo's harness files (la-07/tiers.ts) -- never a second,
// bespoke mechanism, only discoverability at the moment a Mode B operator
// most needs it. This, like --build itself, is printed, never run.
//
// Because --build imports lib/mnemosyne/onboarding/onboardRepo.ts (a .ts
// module) directly, this file is now launched via tsx, not plain node (see
// bin/mnemosyne's own updated comment on its `agent` dispatch branch) --
// noEmit:true means there is no build step to import a .ts module any
// other way (mirrors bin/mnemosyne-persona.mjs's identical situation).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { onboardRepo } from "../lib/mnemosyne/onboarding/onboardRepo.ts";

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
// entirely, in this checkout or anyone else's. Codex CLI has no analogous
// CWD-scoping bug (hand-verified: `codex mcp get`/`codex mcp add` resolve
// purely from `$CODEX_HOME`, identical output regardless of CWD) — Codex's
// execs still pin CWD here too, purely to keep every harness-CLI exec in
// this file on one consistent, reviewable convention.
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

// --- MCP registration (Codex CLI) -------------------------------------------
// aha-02's own acceptance criteria, mirroring aha-01's Claude-side rule: the
// registration CHECK must be a single, targeted lookup of exactly the
// "mnemosyne" server — `codex mcp get mnemosyne` — and must NEVER become
// `codex mcp list`, which lists EVERY MCP server configured for this
// $CODEX_HOME (the same class of broad, non-targeted check aha-01's own
// Claude-side fix exists to avoid — see mcpRegistered()'s comment above). Do
// not "simplify" this back to `list` in a future edit.
export async function codexMcpRegistered(name = MCP_SERVER_NAME, { exec = execFileAsync } = {}) {
  try {
    await exec("codex", ["mcp", "get", name], { timeout: EXEC_TIMEOUT_MS, cwd: HARNESS_EXEC_CWD() });
    return true;
  } catch {
    return false;
  }
}

/** Registers `serverPath` under `name` with the Codex CLI via stdio transport — the shape `codex mcp add --help` itself documents (`codex mcp add <NAME> -- <COMMAND>...`). Caller must have already confirmed via codexMcpRegistered() that this is not a redundant call: unlike `claude mcp add`, `codex mcp add` does NOT error on an already-registered name — it silently overwrites (hand-verified, see this file's header comment) — so skipping this call when already-registered isn't just about avoiding an error, it's the only thing making `init` genuinely idempotent (zero redundant writes) for Codex. On any OTHER failure (a real command-shape mismatch, not "already registered"), this throws a loud, specific error naming the exact command and the real subprocess stderr — see the module doc comment's "Loud failure, never silent" section — rather than letting a diverged Codex CLI surface look like a normal registration. */
export async function registerMcpCodex({ name = MCP_SERVER_NAME, serverPath = MCP_SERVER_PATH, exec = execFileAsync } = {}) {
  try {
    await exec("codex", ["mcp", "add", name, "--", "node", serverPath], {
      timeout: EXEC_TIMEOUT_MS,
      cwd: HARNESS_EXEC_CWD(),
    });
  } catch (e) {
    const reason = (e && e.stderr && String(e.stderr).trim()) || (e && e.message) || String(e);
    throw new Error(
      `codex mcp add ${name} -- node ${serverPath} failed -- Codex's real command shape may have diverged from what aha-02 hand-verified: ${reason}`,
    );
  }
}

// --- Codex CLI harness: init / status (no skill install — research-brief.md
// §4: Codex CLI has no analogous skill-file mechanism, confirmed) -----------
export async function initCodex({ log = console.log, warn = console.error, exec = execFileAsync } = {}) {
  const report = { harness: "codex", binaryFound: false, mcp: null };

  report.binaryFound = await detectBinary("codex", { exec });
  if (!report.binaryFound) {
    warn("codex: binary not found on PATH -- skipping Codex CLI harness registration");
    return report;
  }

  if (await codexMcpRegistered(MCP_SERVER_NAME, { exec })) {
    log(`codex: mcp server '${MCP_SERVER_NAME}' already registered (codex mcp get ${MCP_SERVER_NAME}) -- skipped`);
    report.mcp = { action: "already-registered" };
  } else {
    await registerMcpCodex({ exec });
    log(`codex: registered mcp server '${MCP_SERVER_NAME}' -> node ${MCP_SERVER_PATH}`);
    report.mcp = { action: "registered" };
  }

  return report;
}

/** Read-only: same targeted `codex mcp get` lookup init uses, but init() never calls registerMcpCodex() here — see the module doc comment's idempotency section. */
export async function statusCodex({ exec = execFileAsync } = {}) {
  const binaryFound = await detectBinary("codex", { exec });
  const registered = binaryFound ? await codexMcpRegistered(MCP_SERVER_NAME, { exec }) : false;
  return { harness: "codex", binaryFound, mcpRegistered: registered };
}

function printCodexStatus(report, log) {
  log("codex:");
  log(`  binary: ${report.binaryFound ? "found" : "NOT found on PATH"}`);
  log(`  mcp server '${MCP_SERVER_NAME}': ${report.mcpRegistered ? "registered" : "NOT registered"}`);
}

// --- CLI ---------------------------------------------------------------
const KNOWN_HARNESSES = ["claude", "codex"];

export function parseArgs(argv) {
  const args = { harness: null, build: false, storageDir: null, scopeId: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--harness") args.harness = argv[++i];
    // ro-03: OPT-IN, default false -- see this file's own header comment
    // for the grill-3.2 rationale (mirrors install.sh's own "heavy/mutating
    // steps stay separate, explicit, operator-confirmed" convention).
    else if (argv[i] === "--build") args.build = true;
    // ro-03 amendment (design-discussion.md §7.1): redirects onboardRepo()'s
    // repoRoot away from process.cwd(). No effect unless --build is also set.
    else if (argv[i] === "--storage-dir") args.storageDir = argv[++i];
    // ro-03: overrides the derived scopeId (target directory's own
    // basename) onboardRepo() is called with. No effect unless --build is
    // also set.
    else if (argv[i] === "--scope-id") args.scopeId = argv[++i];
  }
  return args;
}

/** Resolves the harness list to attempt: exactly `[requested]` when --harness narrows scope, else every known harness (today: both claude and codex, for real). */
function harnessesToRun(requested) {
  if (requested) {
    if (!KNOWN_HARNESSES.includes(requested)) {
      throw new Error(`invalid --harness '${requested}' -- must be one of: ${KNOWN_HARNESSES.join(", ")}`);
    }
    return [requested];
  }
  return KNOWN_HARNESSES;
}

// --- ro-03: `--build` (Mode B's real entry point) --------------------------

// The exact "not run automatically" guidance line text — the literal
// contract this story's own acceptance criteria quote verbatim, mirroring
// docs/install.sh's identical convention for `agent init` itself.
const BUILD_NEXT_STEP_LINE = "next step (not run automatically): mnemosyne agent init --build";
const INSTALL_HOOKS_NEXT_STEP_LINE = "next step (not run automatically): bin/mnemosyne-install-hooks";

// ro-12-two-explicit-install-paths: one discoverability line, always printed
// by `agent status` (a read-only call — this never runs either command),
// naming BOTH already-shipped install paths together so a reader who only
// ever runs `agent status` still finds both choices — mirrors
// docs/install.sh's step-4 print block and README.md's Quickstart fork,
// which use this exact same sidecar/full-system <-> Mode B/Mode A vocabulary
// mapping (design-discussion.md §7.5).
const INSTALL_PATHS_LINE =
  "install paths: sidecar (Mode B) = agent init --build | full/system (Mode A) = mnemosyne onboard <path> --collection <name>";

/** Printed when `--build` is absent -- never runs onboardRepo(), only names it as the next, explicit, operator-confirmed step. */
function printBuildGuidance(log) {
  log("");
  log(BUILD_NEXT_STEP_LINE);
  log("  runs onboardRepo() (mode: standalone) against this repo -- Layer 1 sync, persona seed,");
  log("  first-time file/graph index, and a base-level report of which of the 5 memory levels are");
  log("  configured. Opt-in, off by default (this repo's own convention for heavy/mutating steps).");
}

/** `<repoRoot>`'s own basename -- the default scopeId when --scope-id isn't given, mirroring layer1/persona-store-repo-local.ts's own scopeId convention (a stable, human-readable identifier for "this repo"), never a random/opaque id. */
function defaultScopeId(repoRoot) {
  return path.basename(repoRoot);
}

/** ml-04/ro-01's canonical 5-level base-level report, printed after a real `--build` run. */
function printBaseLevelReport(result, log) {
  log("");
  log("base-level report:");
  for (const level of result.baseLevel) {
    log(`  [${level.id}] ${level.label}: ${level.configured ? "configured" : "NOT configured"}`);
  }
}

/** design-discussion.md §7.4 -- names, never runs, the already-shipped hooks/README.md install verb. */
function printInstallHooksGuidance(log) {
  log("");
  log(INSTALL_HOOKS_NEXT_STEP_LINE);
  log("  installs the already-shipped pre-recall/post-remember hook loop (hooks/README.md) into");
  log("  your harness's settings.json -- the same mechanism the Layer 1 mandate text this run just");
  log("  spliced into this repo's CLAUDE.md/AGENTS.md/GEMINI.md already names explicitly.");
}

/**
 * `agent init --build`'s own step -- runs the real onboardRepo({ mode:
 * 'standalone', ... }) (ro-02) against either process.cwd() or
 * --storage-dir (mkdir -p'd first if it doesn't exist yet), scoped to
 * --scope-id or, absent that, the target directory's own basename. Called
 * from runInit() ONLY when --build is set (grill 3.2's opt-in-only design)
 * -- never a second, inconsistent default.
 */
export async function runBuild({ storageDir, scopeId, log = console.log } = {}) {
  const repoRoot = storageDir ? path.resolve(storageDir) : process.cwd();
  if (storageDir) {
    // §7.1 amendment: mkdir -p the target before onboarding it -- a
    // product's install tooling shouldn't have to pre-create its own
    // storage directory just to point --storage-dir at it.
    mkdirSync(repoRoot, { recursive: true });
  }
  const resolvedScopeId = scopeId || defaultScopeId(repoRoot);

  log("");
  log(`agent init --build: onboarding ${repoRoot} (scopeId: ${resolvedScopeId})...`);
  const result = await onboardRepo({ mode: "standalone", repoRoot, scopeId: resolvedScopeId });
  printBaseLevelReport(result, log);
  printInstallHooksGuidance(log);
  return result;
}

export async function runInit(argv, { log = console.log, warn = console.error } = {}) {
  const { harness, build, storageDir, scopeId } = parseArgs(argv);
  const harnesses = harnessesToRun(harness);
  for (const h of harnesses) {
    if (h === "claude") {
      await initClaude({ log, warn });
    } else if (h === "codex") {
      // A harness genuinely absent from PATH is handled inside initCodex()
      // itself (a clear, non-fatal warn+skip) — symmetric with initClaude's
      // own absent-binary handling, regardless of whether --harness named it
      // explicitly or it was reached via the default multi-harness sweep. A
      // real command-shape failure (harness present, registration itself
      // fails unexpectedly) is NOT caught here — it propagates uncaught to
      // main()'s own top-level catch, which is the loud, non-zero-exit,
      // specific-message failure design-discussion.md §2 requires.
      await initCodex({ log, warn });
    }
  }

  // ro-03: MCP registration + skill copy above are byte-identical to
  // before this story regardless of --build. onboardRepo() is called ONLY
  // when --build is explicitly passed -- absent it, this branch only ever
  // prints guidance, never mutates anything.
  if (build) {
    await runBuild({ storageDir, scopeId, log });
  } else {
    printBuildGuidance(log);
  }

  return true;
}

export async function runStatus(argv, { log = console.log, warn = console.error } = {}) {
  const { harness } = parseArgs(argv);
  const harnesses = harnessesToRun(harness);
  for (const h of harnesses) {
    if (h === "claude") {
      const report = await statusClaude({});
      printClaudeStatus(report, log);
    } else if (h === "codex") {
      const report = await statusCodex({});
      printCodexStatus(report, log);
    }
  }
  log("");
  log(INSTALL_PATHS_LINE);
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
