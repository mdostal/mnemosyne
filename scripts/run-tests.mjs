#!/usr/bin/env node
// run-tests.mjs — the `npm test` entry point.
//
// Runs EVERY test/*.mjs file (no hand-maintained list to forget a file in),
// one at a time, and keeps going after a failure so one red file never hides
// the rest. Prints a per-file PASS / FAIL / SKIP summary, then runs the
// vitest contract suites, and exits non-zero if anything failed.
//
//   node scripts/run-tests.mjs                 # everything (what `npm test` runs)
//   node scripts/run-tests.mjs --no-vitest     # only the test/*.mjs files
//   node scripts/run-tests.mjs --dir <dir>     # a different directory (runner self-test)
//
// Files that need something the host may not have (the real `swarm-memory`
// binary, a live corpus, a Playwright browser, ...) are listed in
// REQUIREMENTS below. When a requirement is missing the file prints
// `SKIP <file>: <reason>` and counts as skipped: never a failure, never a
// silent pass.
//
// Live tests write into a real Mnemosyne corpus, so they only run with
// MNEMOSYNE_LIVE_TESTS=1. Without it MNEMOSYNE_URL is also stripped from the
// children's environment, so an agent/dev shell that exports MNEMOSYNE_URL for
// its hooks can't leak test writes into the real service.

import { spawn, spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..");
const BIN = path.join(ROOT, "node_modules", ".bin");

// Directories vitest collects the TypeScript contract suites from.
export const VITEST_DIRS = ["lib/mnemosyne", "lib/minerva", "benchmarks", "src/planning", "src/config", "src/runners"];

// Per-file wall-clock cap, so a hung server test fails instead of hanging CI.
const FILE_TIMEOUT_MS = Number(process.env.MNEMOSYNE_TEST_TIMEOUT_MS || 10 * 60 * 1000);

const LIVE = process.env.MNEMOSYNE_LIVE_TESTS === "1";

// Checks return null when satisfied, else a human-readable reason.
const CHECKS = {
  "swarm-memory": () => {
    const bin = process.env.SWARM_MEMORY_BIN || "swarm-memory";
    return spawnSync(bin, ["--help"], { stdio: "ignore" }).error
      ? `real swarm-memory binary not found (${bin}); install it or set SWARM_MEMORY_BIN`
      : null;
  },
  live: () =>
    LIVE ? null : "needs a running Mnemosyne / the live corpus; set MNEMOSYNE_LIVE_TESTS=1 (and MNEMOSYNE_URL) to run",
  chromium: () => {
    const r = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      "import { chromium } from 'playwright'; const b = await chromium.launch(); await b.close();",
    ], { cwd: ROOT, stdio: "ignore", timeout: 60_000 });
    return r.status === 0 ? null : "Playwright chromium not installed; run `npx playwright install chromium`";
  },
  "python-yaml": () => {
    // -s ignores the per-user site-packages: these tests point HOME at a temp
    // dir, so a `pip install --user` PyYAML is invisible to them.
    const r = spawnSync("python3", ["-s", "-c", "import yaml"], { stdio: "ignore" });
    return r.status === 0 ? null : "python3 with a system-wide PyYAML not available (used by mnemosyne/placement_engine.py)";
  },
  // install.sh runs a real `npm install`, and better-sqlite3's install step is
  // `node-gyp rebuild`, which needs make + a C++ compiler.
  toolchain: () => {
    const missing = ["make", "c++"].filter((bin) => spawnSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" }).status !== 0);
    return missing.length ? `no C/C++ build toolchain for node-gyp (missing: ${missing.join(", ")})` : null;
  },
};

// test file -> requirements. Anything not listed needs nothing beyond `npm ci`.
export const REQUIREMENTS = {
  "smoke.mjs": ["live"],
  "ui-shell.mjs": ["live"],
  "search-route.mjs": ["swarm-memory", "live"],
  "reindex-route.mjs": ["swarm-memory", "live"],
  "graph-engine.mjs": ["swarm-memory", "live"],
  "graph-route.mjs": ["swarm-memory", "live"],
  "add-lane.mjs": ["swarm-memory"],
  "lanes-route.mjs": ["swarm-memory"],
  "skill-harness.mjs": ["swarm-memory"],
  "mcp-server.mjs": ["swarm-memory"],
  "mcp-server-persona.mjs": ["swarm-memory"],
  "persona-cross-transport.mjs": ["swarm-memory"],
  "persona-draft-cross-transport.mjs": ["swarm-memory"],
  "connect-banner.mjs": ["chromium"],
  "onboard-cli.mjs": ["python-yaml"],
  "onboard-reachability.mjs": ["python-yaml"],
  "install-script.mjs": ["toolchain"],
};

// Files run elsewhere, not by this runner.
export const EXCLUDED = {
  "e2e.mjs": "run separately via `npm run test:e2e`",
};

export function listTestFiles(dir = path.join(ROOT, "test")) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".mjs"))
    .map((d) => d.name)
    .sort();
}

const checkCache = new Map();
function missingRequirement(file) {
  for (const req of REQUIREMENTS[file] || []) {
    if (!checkCache.has(req)) checkCache.set(req, CHECKS[req]());
    const reason = checkCache.get(req);
    if (reason) return reason;
  }
  return null;
}

// node:test files (`*.test.mjs`) run under `node --test`; everything else runs
// under tsx, which several files need to import lib/**/*.ts directly and which
// is a no-op for plain ESM.
function commandFor(file) {
  if (file.endsWith(".test.mjs")) return [process.execPath, ["--test", file]];
  return [path.join(BIN, "tsx"), [file]];
}

function childEnv() {
  const env = { ...process.env };
  if (!LIVE) delete env.MNEMOSYNE_URL;
  return env;
}

function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, env: childEnv(), stdio: "inherit" });
    const timer = setTimeout(() => {
      console.log(`\n  TIMEOUT after ${FILE_TIMEOUT_MS}ms, killing ${path.basename(args.at(-1))}`);
      child.kill("SIGKILL");
    }, FILE_TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      console.log(`  could not start ${cmd}: ${e.message}`);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve(signal ? 1 : code);
    });
  });
}

export async function main(argv = process.argv.slice(2)) {
  const dirIdx = argv.indexOf("--dir");
  const dir = dirIdx >= 0 ? path.resolve(argv[dirIdx + 1]) : path.join(ROOT, "test");
  const withVitest = !argv.includes("--no-vitest");

  const results = [];
  for (const file of listTestFiles(dir)) {
    const rel = path.relative(ROOT, path.join(dir, file));
    if (EXCLUDED[file]) {
      results.push({ file: rel, status: "EXCLUDED", note: EXCLUDED[file] });
      continue;
    }
    const reason = missingRequirement(file);
    if (reason) {
      console.log(`\nSKIP ${rel}: ${reason}`);
      results.push({ file: rel, status: "SKIP", note: reason });
      continue;
    }
    console.log(`\n=== ${rel}`);
    const started = Date.now();
    const [cmd, args] = commandFor(path.join(dir, file));
    const code = await run(cmd, args);
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    results.push({ file: rel, status: code === 0 ? "PASS" : "FAIL", note: `${secs}s${code ? `, exit ${code}` : ""}` });
  }

  if (withVitest) {
    console.log(`\n=== vitest run ${VITEST_DIRS.join(" ")}`);
    const code = await run(path.join(BIN, "vitest"), ["run", ...VITEST_DIRS]);
    results.push({ file: "vitest", status: code === 0 ? "PASS" : "FAIL", note: code ? `exit ${code}` : "" });
  }

  const count = (s) => results.filter((r) => r.status === s).length;
  console.log("\n=== test summary");
  for (const r of results) console.log(`  ${r.status.padEnd(8)} ${r.file}${r.note ? `  (${r.note})` : ""}`);
  console.log(`\n${count("PASS")} passed, ${count("FAIL")} failed, ${count("SKIP")} skipped, ${count("EXCLUDED")} excluded`);
  return count("FAIL") ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}

