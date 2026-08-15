// persona-cli.mjs — real subprocess-level tests for `mnemosyne persona sync`
// (pf-04-cli-persona-sync-dry-run, epic: mnemosyne-persona-foundation).
//
// This CLI is the FIRST real production invocation path for
// syncHarnessFile/syncAllHarnesses (lib/mnemosyne/layer1/sync.ts) --
// previously only exercised by the Vitest suite
// (lib/mnemosyne/layer1/__tests__/sync.test.ts). No CLI verb, no hook, no
// HTTP route called it for real before bin/mnemosyne-persona.mjs.
//
// Runs the REAL command as a real subprocess (`node node_modules/.bin/tsx
// bin/mnemosyne-persona.mjs ...`, and separately via `bin/mnemosyne persona
// ...` to prove the dispatcher wiring) -- mirrors this repo's own convention
// for a TypeScript-backed CLI (see test/lifecycle-compliance-audit.mjs
// spawning `tsx lib/mnemosyne/audit/cli.ts`). bin/mnemosyne-persona.mjs
// imports lib/mnemosyne/layer1/*.ts directly, so unlike test/reindex.mjs
// (which can `import` bin/mnemosyne-reindex.mjs's plain-JS parseArgs/run
// straight into this plain-`node`-run test file), this file cannot import
// it in-process -- see bin/mnemosyne-persona.mjs's own doc comment for why
// (tsconfig.json's `noEmit: true`, no build step for any bin/ script).
//
// Covers (per pf-04's acceptance criteria):
//   AC-parse  argument parsing: missing/invalid --repo/--tier/--scope-id,
//             missing/unknown subcommand.
//   AC-sync   `sync`'s success path: produces correct managed-block content
//             in all three harness files, idempotently, and the dispatcher
//             (`bin/mnemosyne persona sync ...`) reaches the same code.
//   AC-dry    `--dry-run`'s zero-write guarantee: sha256 checksum AND mtime
//             of a pre-existing target file are byte-identical after a
//             --dry-run run, and files that would be newly created are
//             NOT created on disk.
//
// Extended by pf-09-cli-persona-seed-and-global-sync (epic: same) to also
// cover:
//   AC-seed        `persona seed` wires in pf-08's
//                  bin/mnemosyne-persona-seed.mjs and reports which of the
//                  3 global tiers (top-orchestrator/company-director/
//                  project-orchestrator) were newly seeded vs. already
//                  present, idempotently across repeat runs.
//   AC-global-sync `persona sync` also works for the 3 global tiers:
//                  --repo is still required (it's the write target for the
//                  harness files) even though content resolution for a
//                  global tier comes from the global persona store
//                  (~/.mnemosyne/personas), never from inside --repo.
//                  Covers both the no-persona-seeded-yet fallback path and
//                  the real dispatch-to-global-store path (a distinctive
//                  marker in a hand-written global persona file must show
//                  up in the synced harness content).
//
// Usage: node test/persona-cli.mjs
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TSX_BIN = path.join(ROOT, "node_modules", ".bin", "tsx");
const CLI = path.join(ROOT, "bin", "mnemosyne-persona.mjs");
const DISPATCHER = path.join(ROOT, "bin", "mnemosyne");

let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "  PASS" : "  FAIL"}  ${m}`);
  if (!c) fails++;
};

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** Truncates long CLI output for readable PASS/FAIL log lines (assertions still check the full string). */
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

/** A real, throwaway Level 0 rules file + $HOME pointing at it -- never the real ~/.mnemosyne/level0-rules.md. */
async function makeFakeHome() {
  const home = await makeTempDir("mnemosyne-persona-cli-home-");
  await mkdir(path.join(home, ".mnemosyne"), { recursive: true });
  await writeFile(
    path.join(home, ".mnemosyne", "level0-rules.md"),
    "# Level 0 fixture\n\nFIXTURE_LEVEL0_MARKER_TEXT — pull first, never commit to main.\n",
    "utf8",
  );
  return home;
}

/**
 * Hand-writes a global persona YAML file directly at
 * `<home>/.mnemosyne/personas/<tier>/<scopeId>.yaml` (persona-store-global.ts's
 * fixed location convention) -- this test file can't import
 * persona-store-global.ts's writeGlobalPersona in-process (same constraint
 * as the CLI itself, see doc comment above), so it writes the YAML shape by
 * hand instead. JSON.stringify'd scalars are valid YAML flow scalars, so
 * this is safe for arbitrary marker text without a YAML-escaping dependency.
 */
async function writeFakeGlobalPersona(home, tier, scopeId, { displayName, scope, sections }) {
  const dir = path.join(home, ".mnemosyne", "personas", tier);
  await mkdir(dir, { recursive: true });
  const yamlText =
    [
      `tier: ${JSON.stringify(tier)}`,
      `scopeId: ${JSON.stringify(scopeId)}`,
      `displayName: ${JSON.stringify(displayName)}`,
      `scope: ${JSON.stringify(scope)}`,
      `sections:`,
      ...sections.flatMap((s) => [`  - heading: ${JSON.stringify(s.heading)}`, `    body: ${JSON.stringify(s.body)}`]),
    ].join("\n") + "\n";
  await writeFile(path.join(dir, `${scopeId}.yaml`), yamlText, "utf8");
}

/** Runs the CLI as a real subprocess via tsx (directly, or through the bin/mnemosyne dispatcher). */
async function runCli(args, { home, viaDispatcher = false } = {}) {
  const cmd = viaDispatcher ? DISPATCHER : process.execPath;
  const cmdArgs = viaDispatcher ? ["persona", ...args] : [TSX_BIN, CLI, ...args];
  const env = { ...process.env };
  if (home) env.HOME = home;
  try {
    const { stdout, stderr } = await execFileAsync(cmd, cmdArgs, { cwd: ROOT, env });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

async function main() {
  // --- AC-parse: argument parsing ------------------------------------------
  {
    const home = await makeFakeHome();

    const noArgs = await runCli([], { home });
    ok(noArgs.code !== 0, `no subcommand -> non-zero exit (got ${noArgs.code})`);
    ok(/usage/i.test(noArgs.stderr), `no subcommand -> usage printed to stderr -> ${short(noArgs.stderr)}`);

    const unknownSub = await runCli(["bogus"], { home });
    ok(unknownSub.code !== 0, `unknown subcommand -> non-zero exit (got ${unknownSub.code})`);
    ok(/unknown or missing subcommand/i.test(unknownSub.stderr), `unknown subcommand -> clear stderr message -> ${short(unknownSub.stderr)}`);

    const missingRepo = await runCli(["sync", "--tier", "code-architect", "--scope-id", "x"], { home });
    ok(missingRepo.code !== 0, `sync missing --repo -> non-zero exit (got ${missingRepo.code})`);
    ok(/--repo.*--tier.*--scope-id.*required/i.test(missingRepo.stderr), `sync missing --repo -> clear stderr message -> ${short(missingRepo.stderr)}`);

    const missingTier = await runCli(["sync", "--repo", "/tmp/whatever", "--scope-id", "x"], { home });
    ok(missingTier.code !== 0, `sync missing --tier -> non-zero exit (got ${missingTier.code})`);

    const missingScope = await runCli(["sync", "--repo", "/tmp/whatever", "--tier", "code-architect"], { home });
    ok(missingScope.code !== 0, `sync missing --scope-id -> non-zero exit (got ${missingScope.code})`);

    const invalidTier = await runCli(["sync", "--repo", "/tmp/whatever", "--tier", "not-a-real-tier", "--scope-id", "x"], { home });
    ok(invalidTier.code !== 0, `sync invalid --tier -> non-zero exit (got ${invalidTier.code})`);
    ok(/invalid --tier/i.test(invalidTier.stderr), `sync invalid --tier -> clear stderr message -> ${short(invalidTier.stderr)}`);

    await rm(home, { recursive: true, force: true });
  }

  // --- AC-sync: sync subcommand's success path ------------------------------
  {
    const home = await makeFakeHome();
    const repo = await makeTempDir("mnemosyne-persona-cli-repo-");

    const first = await runCli(["sync", "--repo", repo, "--tier", "code-architect", "--scope-id", "test-scope"], { home });
    ok(first.code === 0, `sync success path -> exit 0 (got ${first.code}, stderr=${short(first.stderr)})`);
    ok(/created .*CLAUDE\.md/.test(first.stdout), `sync reports CLAUDE.md created -> ${short(first.stdout)}`);
    ok(/created .*AGENTS\.md/.test(first.stdout), `sync reports AGENTS.md created -> ${short(first.stdout)}`);
    ok(/created .*GEMINI\.md/.test(first.stdout), `sync reports GEMINI.md created -> ${short(first.stdout)}`);

    const claude = await readFile(path.join(repo, "CLAUDE.md"), "utf8");
    const agents = await readFile(path.join(repo, "AGENTS.md"), "utf8");
    const gemini = await readFile(path.join(repo, "GEMINI.md"), "utf8");
    for (const [name, content] of [["CLAUDE.md", claude], ["AGENTS.md", agents], ["GEMINI.md", gemini]]) {
      ok(content.includes("FIXTURE_LEVEL0_MARKER_TEXT"), `${name} contains Level 0 fixture content`);
      ok(content.includes("Code/Area Architect"), `${name} contains code-architect tier content (no persona seeded -> fallback)`);
      ok(content.includes("Memory-lifecycle mandate"), `${name} contains the memory-lifecycle mandate`);
      ok(content.includes("mnemosyne:layer1:begin"), `${name} carries the managed-block start marker exactly once -> count=${content.split("mnemosyne:layer1:begin").length - 1}`);
    }

    // Idempotency: second run updates only the managed block, no duplicated markers.
    const second = await runCli(["sync", "--repo", repo, "--tier", "code-architect", "--scope-id", "test-scope"], { home });
    ok(second.code === 0, `second sync run -> exit 0 (got ${second.code})`);
    ok(/updated .*CLAUDE\.md/.test(second.stdout), `second run reports "updated" not "created" -> ${short(second.stdout)}`);
    const claudeAfterSecond = await readFile(path.join(repo, "CLAUDE.md"), "utf8");
    ok(
      claudeAfterSecond.split("mnemosyne:layer1:begin").length - 1 === 1,
      `CLAUDE.md still carries exactly one managed-block start marker after a second run (idempotent)`,
    );

    // Dispatcher wiring: `bin/mnemosyne persona sync ...` reaches the same code.
    const repoViaDispatcher = await makeTempDir("mnemosyne-persona-cli-dispatcher-repo-");
    const viaDispatcher = await runCli(
      ["sync", "--repo", repoViaDispatcher, "--tier", "code-architect", "--scope-id", "dispatcher-scope"],
      { home, viaDispatcher: true },
    );
    ok(viaDispatcher.code === 0, `bin/mnemosyne persona sync ... -> exit 0 (got ${viaDispatcher.code}, stderr=${short(viaDispatcher.stderr)})`);
    const claudeViaDispatcher = await readFile(path.join(repoViaDispatcher, "CLAUDE.md"), "utf8").catch(() => null);
    ok(claudeViaDispatcher !== null, "bin/mnemosyne persona sync ... actually wrote CLAUDE.md through the dispatcher");

    await rm(home, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
    await rm(repoViaDispatcher, { recursive: true, force: true });
  }

  // --- AC-dry: --dry-run's zero-write guarantee -----------------------------
  {
    const home = await makeFakeHome();
    const repo = await makeTempDir("mnemosyne-persona-cli-dryrun-repo-");

    const preexistingClaude = "# My Repo\n\nHuman-authored setup notes that must never be touched.\n";
    await writeFile(path.join(repo, "CLAUDE.md"), preexistingClaude, "utf8");

    const beforeStat = await stat(path.join(repo, "CLAUDE.md"));
    const beforeHash = sha256(preexistingClaude);

    const dryRun = await runCli(
      ["sync", "--repo", repo, "--tier", "code-architect", "--scope-id", "test-scope", "--dry-run"],
      { home },
    );
    ok(dryRun.code === 0, `--dry-run -> exit 0 (got ${dryRun.code}, stderr=${short(dryRun.stderr)})`);
    ok(/zero filesystem writes/i.test(dryRun.stdout), `--dry-run stdout states zero filesystem writes -> ${short(dryRun.stdout)}`);
    ok(/\[would update\]/.test(dryRun.stdout), `--dry-run previews CLAUDE.md as [would update] -> ${short(dryRun.stdout)}`);
    ok(/\[would create\]/.test(dryRun.stdout), `--dry-run previews AGENTS.md/GEMINI.md as [would create] -> ${short(dryRun.stdout)}`);
    ok(dryRun.stdout.includes("FIXTURE_LEVEL0_MARKER_TEXT"), `--dry-run preview includes the would-be Level 0 content`);

    const afterContent = await readFile(path.join(repo, "CLAUDE.md"), "utf8");
    const afterStat = await stat(path.join(repo, "CLAUDE.md"));
    ok(afterContent === preexistingClaude, "CLAUDE.md content byte-identical after --dry-run");
    ok(sha256(afterContent) === beforeHash, "CLAUDE.md sha256 checksum unchanged after --dry-run");
    ok(afterStat.mtimeMs === beforeStat.mtimeMs, `CLAUDE.md mtime unchanged after --dry-run (before=${beforeStat.mtimeMs}, after=${afterStat.mtimeMs})`);

    const agentsExists = await stat(path.join(repo, "AGENTS.md")).then(() => true).catch(() => false);
    const geminiExists = await stat(path.join(repo, "GEMINI.md")).then(() => true).catch(() => false);
    ok(agentsExists === false, "--dry-run did NOT create AGENTS.md on disk");
    ok(geminiExists === false, "--dry-run did NOT create GEMINI.md on disk");

    // A second --dry-run against a repo with NOTHING on disk yet: nothing gets created either.
    const emptyRepo = await makeTempDir("mnemosyne-persona-cli-dryrun-empty-");
    const dryRunEmpty = await runCli(
      ["sync", "--repo", emptyRepo, "--tier", "code-architect", "--scope-id", "test-scope", "--dry-run"],
      { home },
    );
    ok(dryRunEmpty.code === 0, `--dry-run against an empty repo -> exit 0 (got ${dryRunEmpty.code})`);
    const claudeExistsAfterEmptyDryRun = await stat(path.join(emptyRepo, "CLAUDE.md")).then(() => true).catch(() => false);
    ok(claudeExistsAfterEmptyDryRun === false, "--dry-run against an empty repo created nothing at all");

    await rm(home, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
    await rm(emptyRepo, { recursive: true, force: true });
  }

  // --- AC-seed: `persona seed` subcommand (pf-09) ---------------------------
  {
    const home = await makeFakeHome();

    const first = await runCli(["seed"], { home });
    ok(first.code === 0, `seed (first run) -> exit 0 (got ${first.code}, stderr=${short(first.stderr)})`);
    ok(/seed\s+top-orchestrator\/default/.test(first.stdout), `seed reports top-orchestrator newly seeded -> ${short(first.stdout)}`);
    ok(/seed\s+company-director\/default/.test(first.stdout), `seed reports company-director newly seeded -> ${short(first.stdout)}`);
    ok(/seed\s+project-orchestrator\/default/.test(first.stdout), `seed reports project-orchestrator newly seeded -> ${short(first.stdout)}`);
    ok(!/code-architect/.test(first.stdout), `seed never mentions code-architect (repo-local tier, out of scope) -> ${short(first.stdout)}`);
    ok(/3 seeded, 0 skipped \(already existed\), 3 total/.test(first.stdout), `seed reports 3 seeded / 0 skipped on first run -> ${short(first.stdout)}`);

    for (const tier of ["top-orchestrator", "company-director", "project-orchestrator"]) {
      const exists = await stat(path.join(home, ".mnemosyne", "personas", tier, "default.yaml")).then(() => true).catch(() => false);
      ok(exists, `seed actually wrote ${tier}/default.yaml to the global persona store`);
    }

    // Idempotency: second run reports the same 3 tiers as already present, not re-seeded.
    const second = await runCli(["seed"], { home });
    ok(second.code === 0, `seed (second run) -> exit 0 (got ${second.code})`);
    ok(/skip\s+top-orchestrator\/default/.test(second.stdout), `seed (second run) reports top-orchestrator already present -> ${short(second.stdout)}`);
    ok(/skip\s+company-director\/default/.test(second.stdout), `seed (second run) reports company-director already present -> ${short(second.stdout)}`);
    ok(/skip\s+project-orchestrator\/default/.test(second.stdout), `seed (second run) reports project-orchestrator already present -> ${short(second.stdout)}`);
    ok(/0 seeded, 3 skipped \(already existed\), 3 total/.test(second.stdout), `seed (second run) reports 0 seeded / 3 skipped -> ${short(second.stdout)}`);

    // Dispatcher wiring: `bin/mnemosyne persona seed` reaches the same code.
    const viaDispatcher = await runCli(["seed"], { home, viaDispatcher: true });
    ok(viaDispatcher.code === 0, `bin/mnemosyne persona seed -> exit 0 (got ${viaDispatcher.code}, stderr=${short(viaDispatcher.stderr)})`);
    ok(/skip\s+top-orchestrator\/default/.test(viaDispatcher.stdout), `bin/mnemosyne persona seed reaches the seed script (reports already-present tiers) -> ${short(viaDispatcher.stdout)}`);

    await rm(home, { recursive: true, force: true });
  }

  // --- AC-global-sync: `persona sync` for the 3 global tiers (pf-09) --------
  {
    // --repo is still required for a global tier -- it's the write target, not the content source.
    const home = await makeFakeHome();
    const missingRepoGlobal = await runCli(["sync", "--tier", "company-director", "--scope-id", "default"], { home });
    ok(missingRepoGlobal.code !== 0, `global-tier sync missing --repo -> non-zero exit (got ${missingRepoGlobal.code})`);
    ok(/--repo.*--tier.*--scope-id.*required/i.test(missingRepoGlobal.stderr), `global-tier sync missing --repo -> same clear stderr message as any other tier -> ${short(missingRepoGlobal.stderr)}`);
    await rm(home, { recursive: true, force: true });
  }
  {
    // No persona seeded yet for this scope -- falls back to the hardcoded TIER_CONTENT, same
    // fallback contract as code-architect, and the CLI still writes the harness files using --repo
    // purely as the write target.
    const home = await makeFakeHome();
    const repo = await makeTempDir("mnemosyne-persona-cli-global-fallback-repo-");

    const result = await runCli(["sync", "--repo", repo, "--tier", "company-director", "--scope-id", "unseeded-scope"], { home });
    ok(result.code === 0, `global-tier sync (unseeded scope) -> exit 0 (got ${result.code}, stderr=${short(result.stderr)})`);
    ok(/created .*CLAUDE\.md/.test(result.stdout), `global-tier sync reports CLAUDE.md created -> ${short(result.stdout)}`);
    ok(
      /global persona store/i.test(result.stdout) && /--repo/.test(result.stdout),
      `global-tier sync stdout explicitly notes content comes from the global persona store, not --repo -> ${short(result.stdout)}`,
    );

    const claude = await readFile(path.join(repo, "CLAUDE.md"), "utf8");
    ok(claude.includes("Company Director"), "CLAUDE.md contains company-director tier content (no persona seeded -> fallback)");
    ok(claude.includes("Memory-lifecycle mandate"), "CLAUDE.md contains the memory-lifecycle mandate for a global tier too");

    await rm(home, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
  {
    // A real global persona on disk (hand-written, distinctive marker text) -- content resolution
    // must dispatch to the global store, not the --repo directory, and not the hardcoded fallback.
    const home = await makeFakeHome();
    const repo = await makeTempDir("mnemosyne-persona-cli-global-real-repo-");

    await writeFakeGlobalPersona(home, "company-director", "acme-corp", {
      displayName: "Company Director",
      scope: "GLOBAL_PERSONA_SCOPE_MARKER — Acme Corp's own authored scope statement.",
      sections: [{ heading: "Authored section", body: "GLOBAL_PERSONA_BODY_MARKER — real seeded content, not the hardcoded fallback." }],
    });

    const result = await runCli(["sync", "--repo", repo, "--tier", "company-director", "--scope-id", "acme-corp"], { home });
    ok(result.code === 0, `global-tier sync (seeded scope) -> exit 0 (got ${result.code}, stderr=${short(result.stderr)})`);
    ok(!/falling back/i.test(result.stderr), `global-tier sync (seeded scope) does NOT print the fallback warning -> ${short(result.stderr)}`);

    const claude = await readFile(path.join(repo, "CLAUDE.md"), "utf8");
    ok(claude.includes("GLOBAL_PERSONA_SCOPE_MARKER"), "CLAUDE.md contains the hand-authored global persona's scope text, proving dispatch to the global store");
    ok(claude.includes("GLOBAL_PERSONA_BODY_MARKER"), "CLAUDE.md contains the hand-authored global persona's section body");
    ok(
      !claude.includes("Owns one company's product/business context"),
      "CLAUDE.md does NOT contain the hardcoded TIER_CONTENT fallback text (real persona took precedence)",
    );

    await rm(home, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }

  // --- AC-help: --help output distinguishes write-target from content-source (pf-09) ------------
  {
    const help = await runCli(["--help"]);
    ok(help.code === 0, `persona --help -> exit 0 (got ${help.code})`);
    const helpText = help.stdout + help.stderr;
    ok(/seed/.test(helpText), `persona --help mentions the seed subcommand -> ${short(helpText)}`);
    ok(
      /global persona store/i.test(helpText) && /code-architect/.test(helpText),
      `persona --help explicitly distinguishes global-tier content (global store) from code-architect (--repo) -> ${short(helpText)}`,
    );
  }
}

try {
  await main();
} finally {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
}

console.log(fails ? `\n${fails} check(s) failed` : "\nall persona-cli checks passed");
process.exit(fails ? 1 : 0);
