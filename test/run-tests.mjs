// run-tests.mjs — tests for scripts/run-tests.mjs, the `npm test` runner.
//
//   - The runner's file list is exactly the test/*.mjs glob, so a new test
//     file can't be added and silently never run.
//   - REQUIREMENTS / EXCLUDED only name files that exist.
//   - A deliberately failing fixture makes the runner exit non-zero while the
//     files after it still run, and node:test files run under `node --test`.
//
// Usage: node test/run-tests.mjs

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXCLUDED, REQUIREMENTS, listTestFiles } from "../scripts/run-tests.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RUNNER = path.join(ROOT, "scripts", "run-tests.mjs");
const FIXTURES = path.join(__dirname, "fixtures", "runner");

let fails = 0;
const ok = (c, m) => { console.log(`${c ? "  PASS" : "  FAIL"}  ${m}`); if (!c) fails++; };

// --- file list equals the glob ---
const glob = readdirSync(__dirname).filter((f) => f.endsWith(".mjs")).sort();
const listed = listTestFiles();
ok(JSON.stringify(listed) === JSON.stringify(glob), `runner file list equals test/*.mjs (${listed.length} files)`);
ok(listed.includes("run-tests.mjs"), "runner file list includes this file");

for (const file of [...Object.keys(REQUIREMENTS), ...Object.keys(EXCLUDED)]) {
  ok(glob.includes(file), `REQUIREMENTS/EXCLUDED entry test/${file} exists`);
}

// --- a failing file fails the run without stopping it ---
const r = spawnSync(process.execPath, [RUNNER, "--dir", FIXTURES, "--no-vitest"], { cwd: ROOT, encoding: "utf8" });
const out = r.stdout + r.stderr;
ok(r.status !== 0, `runner exits non-zero when a file fails (got ${r.status})`);
ok(out.includes("RUNNER-FIXTURE a-pass ran"), "file before the failure ran");
ok(out.includes("RUNNER-FIXTURE b-fail ran"), "failing file ran");
ok(out.includes("RUNNER-FIXTURE c-pass ran"), "file after the failure still ran");
ok(out.includes("RUNNER-FIXTURE d-node ran"), "node:test file ran under node --test");
ok(/FAIL\s+test\/fixtures\/runner\/b-fail\.mjs/.test(out), "summary marks b-fail.mjs FAIL");
ok(/PASS\s+test\/fixtures\/runner\/c-pass\.mjs/.test(out), "summary marks c-pass.mjs PASS");
ok(/PASS\s+test\/fixtures\/runner\/d-node\.test\.mjs/.test(out), "summary marks d-node.test.mjs PASS");
ok(/3 passed, 1 failed/.test(out), "summary counts 3 passed, 1 failed");

console.log(fails ? `\n${fails} check(s) failed` : "\nall checks passed");
process.exit(fails ? 1 : 0);
