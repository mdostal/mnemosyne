import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "review-auto-merge.sh");

let fails = 0;
const ok = (condition, message) => {
  console.log(`${condition ? "  PASS" : "  FAIL"}  ${message}`);
  if (!condition) fails++;
};

async function installFakeGh(dir) {
  const bin = path.join(dir, "bin");
  await mkdir(bin, { recursive: true });
  const ghPath = path.join(bin, "gh");
  await writeFile(
    ghPath,
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
const state = JSON.parse(process.env.GH_FAKE_STATE || "{}");
appendFileSync(process.env.GH_FAKE_LOG, args.join(" ") + "\\n");

if (args[0] !== "pr") {
  console.error("unsupported gh command");
  process.exit(99);
}

const action = args[1];
const jsonField = args[args.indexOf("--json") + 1];

if (action === "view" && jsonField === "isDraft") {
  process.stdout.write(String(!!state.isDraft) + "\\n");
  process.exit(0);
}

if (action === "view" && jsonField === "labels") {
  process.stdout.write((state.labels || []).join("\\n"));
  if ((state.labels || []).length > 0) process.stdout.write("\\n");
  process.exit(0);
}

if (action === "view" && jsonField === "statusCheckRollup") {
  process.stdout.write((state.ciStatus || "PENDING") + "\\n");
  process.exit(0);
}

if (action === "ready") {
  if (state.readyFails) process.exit(8);
  process.exit(0);
}

if (action === "merge") {
  process.exit(0);
}

console.error("unsupported gh pr action: " + action);
process.exit(99);
`,
    "utf8"
  );
  await chmod(ghPath, 0o755);
  return bin;
}

async function runScenario(name, state) {
  const dir = await mkdtemp(path.join(tmpdir(), `review-auto-merge-${name}-`));
  const logPath = path.join(dir, "gh.log");
  await writeFile(logPath, "", "utf8");
  const bin = await installFakeGh(dir);
  const env = {
    ...process.env,
    GH_FAKE_STATE: JSON.stringify(state),
    GH_FAKE_LOG: logPath,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  };

  const result = await new Promise((resolve, reject) => {
    const child = spawn(SCRIPT, ["123"], { cwd: ROOT, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  const log = await readFile(logPath, "utf8");
  await rm(dir, { recursive: true, force: true });
  return { ...result, log };
}

{
  const result = await runScenario("draft-passing", {
    isDraft: true,
    labels: [],
    ciStatus: "SUCCESS",
  });
  ok(result.code === 0, "draft + passing CI exits 0");
  ok(result.stdout.includes("Converting draft PR #123 to ready"), "draft + passing CI logs conversion");
  ok(result.log.includes("pr ready 123"), "draft + passing CI runs gh pr ready");
  ok(result.log.indexOf("pr ready 123") < result.log.indexOf("pr merge 123 --auto --squash"), "auto-merge runs after ready conversion");
}

{
  const result = await runScenario("draft-failing", {
    isDraft: true,
    labels: [],
    ciStatus: "FAILURE",
  });
  ok(result.code === 0, "draft + failing CI exits 0 without hard failure");
  ok(result.stdout.includes("Skipping: CI not passing (status: FAILURE)"), "draft + failing CI logs skip reason");
  ok(!result.log.includes("pr ready 123"), "draft + failing CI does not run gh pr ready");
  ok(!result.log.includes("pr merge 123"), "draft + failing CI does not continue to auto-merge");
}

{
  const result = await runScenario("draft-hold", {
    isDraft: true,
    labels: ["bug", "draft:hold"],
    ciStatus: "SUCCESS",
  });
  ok(result.code === 0, "draft:hold exits 0 without hard failure");
  ok(result.stdout.includes("Skipping: draft:hold label present"), "draft:hold logs skip reason");
  ok(!result.log.includes("statusCheckRollup"), "draft:hold skips CI query");
  ok(!result.log.includes("pr ready 123"), "draft:hold does not run gh pr ready");
  ok(!result.log.includes("pr merge 123"), "draft:hold does not continue to auto-merge");
}

{
  const result = await runScenario("ready", {
    isDraft: false,
    labels: [],
    ciStatus: "SUCCESS",
  });
  ok(result.code === 0, "ready PR exits 0");
  ok(!result.log.includes("pr ready 123"), "ready PR does not run gh pr ready");
  ok(result.log.includes("pr merge 123 --auto --squash"), "ready PR proceeds to auto-merge normally");
}

console.log(fails ? `\n${fails} check(s) failed` : "\nall review-auto-merge checks passed");
process.exit(fails ? 1 : 0);
