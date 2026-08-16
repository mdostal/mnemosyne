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
// Extended by pf-13-cli-persona-show (epic: same) to also cover:
//   AC-show-parse    `persona show` argument parsing: missing tier/scope-id,
//                     invalid tier, and a code-architect tier (repo-local,
//                     out of scope for this global-store-only verb).
//   AC-show-read     `persona show` prints a hand-authored global persona's
//                     real content (distinctive marker text), and errors
//                     clearly (non-zero exit) when no persona exists yet for
//                     that scope -- no silent TIER_CONTENT fallback the way
//                     `sync` has.
//   AC-show-readonly zero filesystem writes anywhere under $HOME (recursive
//                     directory snapshot, byte-for-byte, before vs. after) --
//                     no harness file, no lock file, no persona file touched.
//   AC-show-live     the on-demand, live-read contract: write a persona,
//                     `show` it, edit the persona file DIRECTLY on disk (no
//                     CLI/store call), `show` it again -- the second run's
//                     output must reflect the edit, proving this is a live
//                     read off disk on every invocation, not a cached or
//                     synced copy.
//
// Extended by pw-05-cli-persona-create (epic: mnemosyne-persona-wizard) to
// also cover the one deliberately-deferred gap from Epic 1:
// writeGlobalPersona/writeRepoLocalPersona had zero CLI wrapper before this.
//   AC-create-parse         `persona create` argument parsing: missing
//                            --file, a --file that does not exist.
//   AC-create-write         `create`'s success path for BOTH stores: a
//                            global-tier candidate with no --repo dispatches
//                            to writeGlobalPersona (readable back via `show`
//                            immediately after); a code-architect candidate
//                            with --repo dispatches to writeRepoLocalPersona
//                            (including parentRefs passing through
//                            untouched), and the dispatcher
//                            (`bin/mnemosyne persona create ...`) reaches the
//                            same code.
//   AC-create-mandate-reject a candidate smuggling a `mandateSections` key is
//                            rejected with assertValidPersona's own clear
//                            error, BEFORE any disk write -- not silently
//                            stripped, not silently accepted.
//   AC-create-tier-mismatch a tier/store mismatch in either direction (a
//                            code-architect candidate routed at the global
//                            store by omitting --repo; a global-tier
//                            candidate routed at the repo-local store by
//                            passing --repo) is rejected by
//                            writeGlobalPersona's/writeRepoLocalPersona's own
//                            tier guard, BEFORE any disk write.
//
// Usage: node test/persona-cli.mjs
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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

/**
 * Serializes an arbitrary persona-shaped candidate object to the same YAML
 * shape persona-store-{global,repo-local}.ts round-trip via `stringify` --
 * used as `pw-05`'s `persona create --file <path>` input fixture. Reuses
 * `writeFakeGlobalPersona`'s hand-rolled approach (JSON.stringify'd scalars
 * are valid YAML flow scalars) rather than adding a "yaml" import to this
 * test file, and deliberately serializes WHATEVER keys the candidate object
 * has -- including a smuggled `mandateSections` key, for AC-create-mandate-
 * reject -- so nothing gets silently dropped before the CLI even sees it.
 */
function personaCandidateYaml(candidate) {
  const lines = [];
  for (const key of ["tier", "scopeId", "displayName", "scope"]) {
    if (candidate[key] !== undefined) lines.push(`${key}: ${JSON.stringify(candidate[key])}`);
  }
  for (const key of ["sections", "mandateSections"]) {
    if (candidate[key] !== undefined) {
      lines.push(`${key}:`);
      for (const s of candidate[key]) {
        lines.push(`  - heading: ${JSON.stringify(s.heading)}`, `    body: ${JSON.stringify(s.body)}`);
      }
    }
  }
  if (candidate.parentRefs !== undefined) {
    lines.push("parentRefs:");
    for (const r of candidate.parentRefs) {
      lines.push(`  - tier: ${JSON.stringify(r.tier)}`, `    scopeId: ${JSON.stringify(r.scopeId)}`);
    }
  }
  return lines.join("\n") + "\n";
}

/** Writes a `persona create --file <path>` fixture under `dir`, returning the file path written. */
async function writeCandidateFile(dir, filename, candidate) {
  const filePath = path.join(dir, filename);
  await writeFile(filePath, personaCandidateYaml(candidate), "utf8");
  return filePath;
}

/**
 * Recursively snapshots every file under `root` as `{relativePath: sha256}}`
 * -- pf-13's AC-show-readonly proof that `persona show` writes NOTHING
 * anywhere reachable ($HOME in these tests), not just "the one file we
 * thought to check." Sorted keys so two snapshots compare byte-for-byte via
 * JSON.stringify regardless of directory-read ordering.
 */
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
        out[path.relative(root, full)] = sha256(content.toString("binary"));
      }
    }
  }
  await walk(root);
  return JSON.stringify(Object.keys(out).sort().map((k) => [k, out[k]]));
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

  // --- AC-show-parse: `persona show` argument parsing (pf-13) --------------
  {
    const home = await makeFakeHome();

    const noArgs = await runCli(["show"], { home });
    ok(noArgs.code !== 0, `show with no args -> non-zero exit (got ${noArgs.code})`);
    ok(/tier.*scope-id.*required/i.test(noArgs.stderr), `show with no args -> clear stderr message -> ${short(noArgs.stderr)}`);

    const missingScope = await runCli(["show", "project-orchestrator"], { home });
    ok(missingScope.code !== 0, `show missing scope-id -> non-zero exit (got ${missingScope.code})`);

    const invalidTier = await runCli(["show", "not-a-real-tier", "default"], { home });
    ok(invalidTier.code !== 0, `show invalid tier -> non-zero exit (got ${invalidTier.code})`);
    ok(/invalid tier/i.test(invalidTier.stderr), `show invalid tier -> clear stderr message -> ${short(invalidTier.stderr)}`);

    const codeArchitect = await runCli(["show", "code-architect", "test-scope"], { home });
    ok(codeArchitect.code !== 0, `show code-architect (repo-local, out of scope) -> non-zero exit (got ${codeArchitect.code})`);
    ok(
      /not a global tier/i.test(codeArchitect.stderr),
      `show code-architect -> clear stderr message explaining it's repo-local, not this verb -> ${short(codeArchitect.stderr)}`,
    );

    await rm(home, { recursive: true, force: true });
  }

  // --- AC-show-read: `persona show` reads real content, errors when absent (pf-13) --------------
  {
    const home = await makeFakeHome();

    const notFound = await runCli(["show", "project-orchestrator", "no-such-scope"], { home });
    ok(notFound.code !== 0, `show unseeded scope -> non-zero exit (got ${notFound.code})`);
    ok(/no global persona found/i.test(notFound.stderr), `show unseeded scope -> clear stderr message, no silent fallback -> ${short(notFound.stderr)}`);

    await writeFakeGlobalPersona(home, "project-orchestrator", "acme-project", {
      displayName: "Project Orchestrator",
      scope: "SHOW_SCOPE_MARKER — Acme's own authored scope statement.",
      sections: [{ heading: "Authored section", body: "SHOW_BODY_MARKER — real seeded content." }],
    });

    const result = await runCli(["show", "project-orchestrator", "acme-project"], { home });
    ok(result.code === 0, `show seeded scope -> exit 0 (got ${result.code}, stderr=${short(result.stderr)})`);
    ok(result.stdout.includes("SHOW_SCOPE_MARKER"), `show prints the persona's real scope text -> ${short(result.stdout)}`);
    ok(result.stdout.includes("SHOW_BODY_MARKER"), `show prints the persona's real section body -> ${short(result.stdout)}`);
    ok(result.stdout.includes("Authored section"), `show prints the persona's section heading -> ${short(result.stdout)}`);
    ok(result.stdout.includes("tier: project-orchestrator"), `show prints the tier -> ${short(result.stdout)}`);
    ok(result.stdout.includes("scopeId: acme-project"), `show prints the scopeId -> ${short(result.stdout)}`);

    // Dispatcher wiring: `bin/mnemosyne persona show ...` reaches the same code.
    const viaDispatcher = await runCli(["show", "project-orchestrator", "acme-project"], { home, viaDispatcher: true });
    ok(viaDispatcher.code === 0, `bin/mnemosyne persona show ... -> exit 0 (got ${viaDispatcher.code}, stderr=${short(viaDispatcher.stderr)})`);
    ok(viaDispatcher.stdout.includes("SHOW_SCOPE_MARKER"), `bin/mnemosyne persona show reaches the same real content -> ${short(viaDispatcher.stdout)}`);

    await rm(home, { recursive: true, force: true });
  }

  // --- AC-show-readonly: zero filesystem writes anywhere (pf-13) -----------------------------
  {
    const home = await makeFakeHome();
    await writeFakeGlobalPersona(home, "top-orchestrator", "readonly-scope", {
      displayName: "Top Orchestrator",
      scope: "Read-only proof scope.",
      sections: [{ heading: "Section", body: "Body." }],
    });

    const before = await snapshotTree(home);
    const result = await runCli(["show", "top-orchestrator", "readonly-scope"], { home });
    ok(result.code === 0, `show (readonly proof) -> exit 0 (got ${result.code}, stderr=${short(result.stderr)})`);
    const after = await snapshotTree(home);

    ok(before === after, "show wrote ZERO files anywhere under $HOME (recursive snapshot identical before/after)");

    const lockExists = await stat(
      path.join(home, ".mnemosyne", "personas", "top-orchestrator", "readonly-scope.yaml.mnemosyne.lock"),
    )
      .then(() => true)
      .catch(() => false);
    ok(lockExists === false, "show did not create a lock file (read-only -- no withLock call in this path)");

    await rm(home, { recursive: true, force: true });
  }

  // --- AC-show-live: live read reflects an edit made directly on disk (pf-13) ----------------
  {
    const home = await makeFakeHome();
    await writeFakeGlobalPersona(home, "company-director", "live-scope", {
      displayName: "Company Director",
      scope: "LIVE_READ_ORIGINAL_MARKER — before the edit.",
      sections: [{ heading: "Section", body: "original body text" }],
    });

    const first = await runCli(["show", "company-director", "live-scope"], { home });
    ok(first.code === 0, `show (before edit) -> exit 0 (got ${first.code}, stderr=${short(first.stderr)})`);
    ok(first.stdout.includes("LIVE_READ_ORIGINAL_MARKER"), `show (before edit) reflects the original content -> ${short(first.stdout)}`);
    ok(!first.stdout.includes("LIVE_READ_EDITED_MARKER"), `show (before edit) does not yet contain the post-edit marker`);

    // Edit the persona file DIRECTLY on disk -- no CLI call, no store function, no sync of any kind.
    await writeFakeGlobalPersona(home, "company-director", "live-scope", {
      displayName: "Company Director",
      scope: "LIVE_READ_EDITED_MARKER — after a direct on-disk edit.",
      sections: [{ heading: "Section", body: "edited body text" }],
    });

    const second = await runCli(["show", "company-director", "live-scope"], { home });
    ok(second.code === 0, `show (after edit) -> exit 0 (got ${second.code}, stderr=${short(second.stderr)})`);
    ok(second.stdout.includes("LIVE_READ_EDITED_MARKER"), `show (after edit) reflects the new content -> ${short(second.stdout)}`);
    ok(!second.stdout.includes("LIVE_READ_ORIGINAL_MARKER"), `show (after edit) no longer contains the pre-edit content`);
    ok(first.stdout !== second.stdout, "show's output actually changed between the two runs -- proves a live read, not a cached/synced copy");

    await rm(home, { recursive: true, force: true });
  }

  // --- AC-create-parse: `persona create` argument parsing (pw-05) ----------
  {
    const home = await makeFakeHome();

    const noArgs = await runCli(["create"], { home });
    ok(noArgs.code !== 0, `create with no args -> non-zero exit (got ${noArgs.code})`);
    ok(/--file.*required/i.test(noArgs.stderr), `create with no args -> clear stderr message -> ${short(noArgs.stderr)}`);

    const missingFile = await runCli(["create", "--file", "/no/such/file.yaml"], { home });
    ok(missingFile.code !== 0, `create with a --file that does not exist -> non-zero exit (got ${missingFile.code})`);
    ok(/no such file/i.test(missingFile.stderr), `create with a missing --file -> clear stderr message -> ${short(missingFile.stderr)}`);

    await rm(home, { recursive: true, force: true });
  }

  // --- AC-create-write: `persona create`'s success path, both stores (pw-05) -----------------
  {
    // Global tier, no --repo -> writeGlobalPersona, PERSONA_STORE_BY_TIER dispatch.
    const home = await makeFakeHome();
    const contentDir = await makeTempDir("mnemosyne-persona-cli-create-content-");

    const candidateFile = await writeCandidateFile(contentDir, "candidate.yaml", {
      tier: "project-orchestrator",
      scopeId: "create-global-scope",
      displayName: "Project Orchestrator",
      scope: "CREATE_GLOBAL_SCOPE_MARKER — authored via `persona create`.",
      sections: [{ heading: "Authored section", body: "CREATE_GLOBAL_BODY_MARKER — real create() write." }],
    });

    const result = await runCli(["create", "--file", candidateFile], { home });
    ok(result.code === 0, `create (global tier, no --repo) -> exit 0 (got ${result.code}, stderr=${short(result.stderr)})`);
    ok(/created/.test(result.stdout), `create reports the write -> ${short(result.stdout)}`);

    const written = await readFile(
      path.join(home, ".mnemosyne", "personas", "project-orchestrator", "create-global-scope.yaml"),
      "utf8",
    );
    ok(written.includes("CREATE_GLOBAL_SCOPE_MARKER"), "create actually wrote the persona's scope text to the global store");
    ok(written.includes("CREATE_GLOBAL_BODY_MARKER"), "create actually wrote the persona's section body to the global store");

    // Confirm it round-trips through `persona show` (the read path already tested by pf-13).
    const shown = await runCli(["show", "project-orchestrator", "create-global-scope"], { home });
    ok(shown.code === 0, `show after create -> exit 0 (got ${shown.code})`);
    ok(shown.stdout.includes("CREATE_GLOBAL_SCOPE_MARKER"), "show after create reflects the just-created persona");

    await rm(home, { recursive: true, force: true });
    await rm(contentDir, { recursive: true, force: true });
  }
  {
    // Repo-local tier, --repo given -> writeRepoLocalPersona, PERSONA_STORE_BY_TIER dispatch.
    const home = await makeFakeHome();
    const repo = await makeTempDir("mnemosyne-persona-cli-create-repo-");
    const contentDir = await makeTempDir("mnemosyne-persona-cli-create-content-");

    const candidateFile = await writeCandidateFile(contentDir, "candidate.yaml", {
      tier: "code-architect",
      scopeId: "create-repo-scope",
      displayName: "Code/Area Architect",
      scope: "CREATE_REPO_SCOPE_MARKER — authored via `persona create`.",
      sections: [{ heading: "Authored section", body: "CREATE_REPO_BODY_MARKER — real create() write." }],
      parentRefs: [{ tier: "project-orchestrator", scopeId: "create-global-scope" }],
    });

    const result = await runCli(["create", "--file", candidateFile, "--repo", repo], { home });
    ok(result.code === 0, `create (repo-local tier, --repo given) -> exit 0 (got ${result.code}, stderr=${short(result.stderr)})`);

    const written = await readFile(path.join(repo, ".mnemosyne", "personas", "create-repo-scope.yaml"), "utf8");
    ok(written.includes("CREATE_REPO_SCOPE_MARKER"), "create actually wrote the persona's scope text to the repo-local store");
    ok(written.includes("CREATE_REPO_BODY_MARKER"), "create actually wrote the persona's section body to the repo-local store");
    ok(written.includes("project-orchestrator"), "create wrote the persona's parentRefs through untouched");

    // Dispatcher wiring: `bin/mnemosyne persona create ...` reaches the same code.
    const repoViaDispatcher = await makeTempDir("mnemosyne-persona-cli-create-dispatcher-repo-");
    const candidateFileDispatcher = await writeCandidateFile(contentDir, "candidate-dispatcher.yaml", {
      tier: "code-architect",
      scopeId: "create-dispatcher-scope",
      displayName: "Code/Area Architect",
      scope: "CREATE_DISPATCHER_SCOPE_MARKER",
      sections: [{ heading: "Section", body: "body" }],
    });
    const viaDispatcher = await runCli(
      ["create", "--file", candidateFileDispatcher, "--repo", repoViaDispatcher],
      { home, viaDispatcher: true },
    );
    ok(viaDispatcher.code === 0, `bin/mnemosyne persona create ... -> exit 0 (got ${viaDispatcher.code}, stderr=${short(viaDispatcher.stderr)})`);
    const writtenViaDispatcher = await readFile(
      path.join(repoViaDispatcher, ".mnemosyne", "personas", "create-dispatcher-scope.yaml"),
      "utf8",
    ).catch(() => null);
    ok(writtenViaDispatcher !== null, "bin/mnemosyne persona create ... actually wrote the persona through the dispatcher");

    await rm(home, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
    await rm(repoViaDispatcher, { recursive: true, force: true });
    await rm(contentDir, { recursive: true, force: true });
  }

  // --- AC-create-mandate-reject: mandateSections smuggling is rejected (pw-05) ----------------
  {
    const home = await makeFakeHome();
    const contentDir = await makeTempDir("mnemosyne-persona-cli-create-mandate-");

    const candidateFile = await writeCandidateFile(contentDir, "candidate.yaml", {
      tier: "top-orchestrator",
      scopeId: "mandate-smuggle-scope",
      displayName: "Top Orchestrator",
      scope: "Attempted mandateSections smuggling.",
      sections: [{ heading: "Section", body: "body" }],
      mandateSections: [{ heading: "Fake mandate", body: "should never be author-storable" }],
    });

    const result = await runCli(["create", "--file", candidateFile], { home });
    ok(result.code !== 0, `create with a smuggled mandateSections -> non-zero exit (got ${result.code})`);
    ok(
      /mandateSections.*never author-storable/i.test(result.stderr),
      `create with a smuggled mandateSections -> clear stderr message, assertValidPersona's own guard -> ${short(result.stderr)}`,
    );

    const wasWritten = await stat(
      path.join(home, ".mnemosyne", "personas", "top-orchestrator", "mandate-smuggle-scope.yaml"),
    )
      .then(() => true)
      .catch(() => false);
    ok(wasWritten === false, "create rejected the mandateSections smuggling BEFORE any disk write -- no file created");

    await rm(home, { recursive: true, force: true });
    await rm(contentDir, { recursive: true, force: true });
  }

  // --- AC-create-tier-mismatch: tier/store mismatch is rejected before any disk write (pw-05) --
  {
    // A code-architect candidate, but no --repo given -> routed at the GLOBAL store -> rejected.
    const home = await makeFakeHome();
    const contentDir = await makeTempDir("mnemosyne-persona-cli-create-mismatch-");

    const candidateFile = await writeCandidateFile(contentDir, "candidate.yaml", {
      tier: "code-architect",
      scopeId: "mismatch-scope",
      displayName: "Code/Area Architect",
      scope: "A code-architect persona wrongly routed at the global store.",
      sections: [{ heading: "Section", body: "body" }],
    });

    const result = await runCli(["create", "--file", candidateFile], { home });
    ok(result.code !== 0, `create (code-architect candidate, no --repo -> global store) -> non-zero exit (got ${result.code})`);
    ok(
      /global persona store never holds 'code-architect'/i.test(result.stderr),
      `create tier/store mismatch -> clear stderr message, writeGlobalPersona's own tier guard -> ${short(result.stderr)}`,
    );

    const wasWritten = await stat(
      path.join(home, ".mnemosyne", "personas", "code-architect", "mismatch-scope.yaml"),
    )
      .then(() => true)
      .catch(() => false);
    ok(wasWritten === false, "create rejected the tier/store mismatch BEFORE any disk write -- no file created under the global store either");

    await rm(home, { recursive: true, force: true });
    await rm(contentDir, { recursive: true, force: true });
  }
  {
    // A global-tier candidate, but --repo given -> routed at the REPO-LOCAL store -> rejected.
    const home = await makeFakeHome();
    const repo = await makeTempDir("mnemosyne-persona-cli-create-mismatch2-repo-");
    const contentDir = await makeTempDir("mnemosyne-persona-cli-create-mismatch2-");

    const candidateFile = await writeCandidateFile(contentDir, "candidate.yaml", {
      tier: "company-director",
      scopeId: "mismatch-scope-2",
      displayName: "Company Director",
      scope: "A company-director persona wrongly routed at the repo-local store.",
      sections: [{ heading: "Section", body: "body" }],
    });

    const result = await runCli(["create", "--file", candidateFile, "--repo", repo], { home });
    ok(result.code !== 0, `create (global-tier candidate, --repo given -> repo-local store) -> non-zero exit (got ${result.code})`);
    ok(
      /repo-local persona store only holds 'code-architect'/i.test(result.stderr),
      `create tier/store mismatch (reverse direction) -> clear stderr message, writeRepoLocalPersona's own tier guard -> ${short(result.stderr)}`,
    );

    const wasWritten = await stat(path.join(repo, ".mnemosyne", "personas", "mismatch-scope-2.yaml"))
      .then(() => true)
      .catch(() => false);
    ok(wasWritten === false, "create rejected the reverse tier/store mismatch BEFORE any disk write -- no file created under the repo-local store either");

    await rm(home, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
    await rm(contentDir, { recursive: true, force: true });
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
    ok(/show <tier> <scope-id>/.test(helpText), `persona --help mentions the show subcommand -> ${short(helpText)}`);
    ok(/create --file/.test(helpText), `persona --help mentions the create subcommand -> ${short(helpText)}`);
  }
}

try {
  await main();
} finally {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
}

console.log(fails ? `\n${fails} check(s) failed` : "\nall persona-cli checks passed");
process.exit(fails ? 1 : 0);
