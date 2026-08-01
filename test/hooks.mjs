// hooks.mjs — end-to-end proof of the v1 memory loop over REAL Qdrant.
//
// Proves the whole ask: post-remember STORES, pre-recall LOADS it back on a
// later run. No mocks — writes a unique token to the live corpus via the
// post-hook, then recalls it via the pre-hook and asserts the token is in the
// injected context. Also asserts line-range provenance is present.
//
//   node test/hooks.mjs           # runs the two hooks as child processes
//
// Requires either the Mnemosyne service (:8477) OR swarm-memory on PATH — the
// client falls back to the CLI, so this passes in both modes.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PRE = path.join(ROOT, "hooks", "pre-recall.mjs");
const POST = path.join(ROOT, "hooks", "post-remember.mjs");

function runHook(file, inputObj) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [file], { cwd: ROOT });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => resolve({ code, out, err }));
    p.stdin.write(JSON.stringify(inputObj));
    p.stdin.end();
  });
}

let fails = 0;
const ok = (c, m) => { console.log(`${c ? "  PASS" : "  FAIL"}  ${m}`); if (!c) fails++; };

const token = `MNEMO-HOOK-E2E-${Date.now()}`;

// 1) POST-HOOK: store a status-aware note carrying the unique token.
const stored = await runHook(POST, {
  text: `Hook end-to-end proof note. Unique token ${token}. The Mnemosyne v1 pre/post memory hooks are wired into the agent loop.`,
  scope: "personal",
  status: "reviewed",
  ticket: "MNEMO-E2E",
});
let storedJson = {};
try { storedJson = JSON.parse(stored.out || "{}"); } catch { /* */ }
ok(stored.code === 0, `post-remember exits 0 (non-blocking)`);
ok(storedJson.ok === true, `post-remember stored via=${storedJson.via} scope=${storedJson.scope} status=${storedJson.status}`);

// give the index a moment to settle before recall
await new Promise((r) => setTimeout(r, 2000));

// 2) PRE-HOOK: recall the token back and assert it lands in injected context.
const recalled = await runHook(PRE, {
  query: token,
  scope: "personal",
  role: "developer",
  hits: 5,
});
ok(recalled.code === 0, `pre-recall exits 0 (non-blocking)`);
let injected = "";
try {
  const j = JSON.parse(recalled.out || "{}");
  injected = j.hookSpecificOutput?.additionalContext || "";
} catch { /* */ }
ok(injected.includes(token), `pre-recall injects the stored token back into context`);
ok(/lines\s+\d+–\d+|chunk\s+\d+/.test(injected), `injected block carries line-range provenance (pointers, not whole files)`);
ok(/Prior Memory/.test(injected), `injected block is a Prior Memory section`);

// 3) resilience: empty query -> no crash, no injection
const empty = await runHook(PRE, { query: "" });
ok(empty.code === 0 && empty.out.trim() === "", `pre-recall on empty query is silent + exits 0`);

console.log(fails ? `\n${fails} check(s) failed` : "\nall hook e2e checks passed");
if (injected) {
  console.log("\n--- injected context sample ---\n" + injected.slice(0, 700));
}
process.exit(fails ? 1 : 0);
