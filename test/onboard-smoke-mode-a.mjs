// onboard-smoke-mode-a.mjs — real, end-to-end smoke test for Mode A
// (tree-integrated onboarding), epic mnemosyne-repo-onboarding, ro-09
// (full-suite regression + release).
//
// This is deliberately NOT a re-test of test/onboard-cli.mjs's own
// thorough, per-acceptance-criterion coverage of `mnemosyne onboard`
// (AC1-5, ro-07's --create AC1-5, etc. -- all run against a real local
// fake-Qdrant HTTP server, see that file's own header comment) -- it is
// the one, real, top-to-bottom "does the whole thing actually work end to
// end against REAL Qdrant infra, from a fresh disposable repo" run this
// story's own design decision asks for.
//
// Mode A's one real external dependency is live Qdrant Cloud access (this
// repo's own CI does not provision a disposable/test-scoped Qdrant target
// -- the same class of environment gap `layers/config.ts`'s own doc
// comment names for graphify). Running this against an operator's REAL,
// shared, production `swarm-memory` Qdrant cluster (the only kind of
// Qdrant config this repo's own `~/.config/swarm-memory/config.toml`
// convention resolves by default) would create real, permanent collection
// state there -- create_collection_and_scope() has no delete/drop path,
// by design (see mnemosyne/onboarding.py's own doc comment). So this smoke
// test NEVER runs against whatever Qdrant config happens to already be on
// this machine: it requires an explicit, deliberate double opt-in naming a
// collection the operator has designated as disposable/test-scoped --
//
//   MNEMOSYNE_SMOKE_MODE_A_COLLECTION=<disposable-test-collection-name>
//
// Absent that env var (the default, and the case in ordinary CI runs),
// this script prints a clear, visible SKIPPED line naming exactly why, and
// exits 0 -- never a silent skip, and never a flaky/nondeterministic
// pass/fail depending on what happens to be configured on the machine that
// runs it (per this story's own risk + mitigation).
//
// Usage: node test/onboard-smoke-mode-a.mjs (or: npm run test:onboard-smoke-mode-a)
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DISPATCHER = path.join(ROOT, "bin", "mnemosyne");

let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "  PASS" : "  FAIL"}  ${m}`);
  if (!c) fails++;
};

const tempDirs = [];
async function makeTempDir(prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function main() {
  console.log("Mode A smoke test: `mnemosyne onboard --create` end to end against a throwaway temp repo\n");

  const collection = process.env.MNEMOSYNE_SMOKE_MODE_A_COLLECTION;
  if (!collection) {
    console.log(
      "  SKIPPED  no disposable/test-scoped Qdrant target configured -- set " +
        "MNEMOSYNE_SMOKE_MODE_A_COLLECTION=<a collection name your Qdrant target treats as " +
        "disposable> to run this for real. This repo's own CI does not provision one (the same " +
        "class of environment gap layers/config.ts's own doc comment names for graphify), and " +
        "this script deliberately never runs `--create` against whatever Qdrant cluster happens " +
        "to already be configured on the machine that runs it -- create_collection_and_scope() " +
        "has no delete/drop path, so an accidental run against real production infra would leave " +
        "permanent state behind. This is a visible, explained skip, never a silent one.",
    );
    console.log("\nMode A smoke test: SKIPPED (see reason above)");
    process.exit(0);
  }

  const repo = await makeTempDir("mnemosyne-smoke-mode-a-repo-");

  let result;
  try {
    const { stdout, stderr } = await execFileAsync(
      DISPATCHER,
      ["onboard", repo, "--collection", collection, "--create", "--scope-id", "smoke-mode-a", "--override", "project"],
      { cwd: ROOT, env: process.env },
    );
    result = { code: 0, stdout, stderr };
  } catch (e) {
    result = { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }

  ok(
    result.code === 0,
    `mnemosyne onboard ${repo} --collection ${collection} --create -> exit 0 (got ${result.code}, stderr=${result.stderr.slice(0, 500)})`,
  );

  const reportLines = result.stdout
    .split("\n")
    .map((l) => l.match(/^\s*\[(\d)\]\s+([^:]+):\s+(configured|NOT configured)$/))
    .filter(Boolean);
  ok(reportLines.length === 5, `base-level report printed all 5 levels (got ${reportLines.length}) -> ${JSON.stringify(result.stdout)}`);
  const byId = Object.fromEntries(reportLines.map((m) => [Number(m[1]), m[3] === "configured"]));
  ok(byId[3] === true, `level 3 (vector) reports configured=true after --create against a real new collection (got ${byId[3]})`);

  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));

  console.log(fails ? `\n${fails} check(s) failed` : "\nMode A smoke test passed (ran for real against the configured disposable Qdrant target)");
  process.exit(fails ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
  process.exit(1);
});
