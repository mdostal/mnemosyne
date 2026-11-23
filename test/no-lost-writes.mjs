// no-lost-writes.mjs — PANT-835: the :8477 service must not lose writes.
//
// Covers:
//   1. 20 parallel remember() calls with the same tag -> 20 distinct note
//      files (collision-proof names, `wx` flag).
//   2. 2 concurrent addLane() calls with different names -> both lanes land
//      in config.toml (in-process mutex around the read-modify-write).
//   3. A 5 MB body -> 413, not 500 (both a declared Content-Length and a
//      chunked upload with no Content-Length), and an upload that never ends
//      is destroyed after its 413.
//   4. A spawned server that gets SIGTERM during a slow request finishes
//      that request with 200 before exiting 0, and logs one structured
//      shutdown line.
//
// Uses its own test double (test/fixtures/fake-swarm-memory-lost-writes) in
// place of the real swarm-memory binary; never touches Qdrant or the real
// config.toml. engine.mjs resolves its CLI binary once at module load, so the
// env is set before the dynamic import below.
//
// Usage: node test/no-lost-writes.mjs
import { execFileSync, spawn } from "node:child_process";
import http from "node:http";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SERVER = path.join(ROOT, "src", "server.mjs");
const FIXTURE = fileURLToPath(new URL("./fixtures/fake-swarm-memory-lost-writes", import.meta.url));
const PORT = 31490;

let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "  PASS" : "  FAIL"}  ${m}`);
  if (!c) fails++;
};

const scratch = await mkdtemp(path.join(tmpdir(), "mnemosyne-no-lost-writes-"));
const notesDir = path.join(scratch, "notes");
const configPath = path.join(scratch, "config.toml");

// remember() over HTTP auto-detects flight status from the caller's git cwd,
// and a CI checkout may be a detached HEAD (which rightly fails with 422), so
// the server tests point cwd at a throwaway repo on a real branch instead.
const gitCwd = path.join(scratch, "repo");
const git = (...args) =>
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args], { cwd: gitCwd });
execFileSync("git", ["init", "-q", "-b", "dev", gitCwd]);
git("commit", "-q", "--allow-empty", "-m", "init");

process.env.SWARM_MEMORY_BIN = FIXTURE;
process.env.MNEMO_TEST_NODE = process.execPath;
process.env.MNEMOSYNE_NOTES_DIR = notesDir;
process.env.SWARM_MEMORY_CONFIG = configPath;
process.env.FAKE_SWARM_CONFIG_DELAY_MS = "150";
const { remember, addLane } = await import("../src/engine.mjs");

const EXPLICIT = {
  status: "confirmed",
  sourceRef: { branch: "dev", commit_sha: "0000000", pr_url: null },
};

try {
  // --- 1. same-tag parallel remember() -----------------------------------
  {
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        remember(`parallel note ${i}`, "personal", { tag: "same-tag", ...EXPLICIT })
      )
    );
    const rejected = results.filter((r) => r.status === "rejected");
    ok(rejected.length === 0, `20 parallel remember() calls all resolve -> ${rejected.length} rejected ${rejected[0]?.reason?.message || ""}`);
    const files = (await readdir(notesDir)).filter((f) => f.endsWith(".md"));
    ok(files.length === 20, `20 parallel same-tag remember() calls -> 20 note files on disk (got ${files.length})`);
    const bodies = new Set(await Promise.all(files.map((f) => readFile(path.join(notesDir, f), "utf8"))));
    ok(bodies.size === 20, `each note file holds a different note's text (got ${bodies.size} distinct)`);
    const returned = new Set(results.filter((r) => r.status === "fulfilled").map((r) => r.value.file));
    ok(returned.size === 20, `remember() returned 20 distinct file paths (got ${returned.size})`);
  }

  // --- 2. concurrent addLane() -------------------------------------------
  {
    await writeFile(
      configPath,
      `[general]\ndefault_scope = "top"\n\n[scopes]\ntop = "fixture_top"\n\n[ladder]\ntop = ["top"]\n`,
      "utf8"
    );
    const results = await Promise.allSettled([
      addLane("alpha", "alpha_collection", ["top"]),
      addLane("beta", "beta_collection"),
    ]);
    ok(
      results.every((r) => r.status === "fulfilled"),
      `2 concurrent addLane() calls both resolve -> ${results.map((r) => r.status === "fulfilled" ? "ok" : r.reason.message).join(" | ")}`
    );
    const after = await readFile(configPath, "utf8");
    ok(/^alpha = "alpha_collection"$/m.test(after), "config.toml keeps lane 'alpha'");
    ok(/^beta = "beta_collection"$/m.test(after), "config.toml keeps lane 'beta'");
    ok(/^alpha = \["top"\]$/m.test(after), "config.toml keeps alpha's ladder entry");
    ok(/^top = "fixture_top"$/m.test(after), "config.toml keeps the pre-existing lane");

    // The lock must be released after a failure too (duplicate -> 409).
    const dup = await addLane("alpha", "x_collection").catch((e) => e);
    ok(dup?.status === 409, `duplicate add after the race still rejects 409 -> ${dup?.status}`);
    const next = await addLane("gamma", "gamma_collection").catch((e) => e);
    ok(next?.added === true, "an add after a failed add still runs (lock released on error)");
  }
} finally {
  delete process.env.FAKE_SWARM_CONFIG_DELAY_MS;
}

// --- server helpers ---------------------------------------------------------
function startServer(port, extraEnv = {}) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      SWARM_MEMORY_BIN: FIXTURE,
      MNEMO_TEST_NODE: process.execPath,
      MNEMOSYNE_NOTES_DIR: notesDir,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (c) => (output += c));
  child.stderr.on("data", (c) => (output += c));
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  const ready = new Promise((resolve) => {
    const check = () => (output.includes("listening on") ? resolve(true) : setTimeout(check, 25));
    check();
    setTimeout(() => resolve(false), 10_000);
  });
  return { child, exited, ready, output: () => output };
}

// Raw http.request so we control Content-Length vs chunked encoding exactly.
function post(port, pathname, body, { chunked = false } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { "content-type": "application/json" };
    if (!chunked) headers["content-length"] = Buffer.byteLength(body);
    const req = http.request({ host: "127.0.0.1", port, path: pathname, method: "POST", headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    if (chunked) {
      // Stream in 256 KB pieces; the server may cut us off mid-upload.
      const buf = Buffer.from(body);
      let off = 0;
      const pump = () => {
        while (off < buf.length) {
          const piece = buf.subarray(off, off + 256 * 1024);
          off += piece.length;
          if (!req.write(piece)) return req.once("drain", pump);
        }
        req.end();
      };
      req.on("error", () => {});
      pump();
    } else {
      req.end(body);
    }
  });
}

// --- 3. oversized body -> 413 -----------------------------------------------
{
  const srv = startServer(PORT);
  try {
    ok(await srv.ready, "server started for the oversize-body test");
    const big = JSON.stringify({ text: "x".repeat(5 * 1024 * 1024) });
    const declared = await post(PORT, "/remember", big).catch((e) => ({ status: `error ${e.code}` }));
    ok(declared.status === 413, `5 MB body with Content-Length -> 413 (got ${declared.status})`);
    const chunked = await post(PORT, "/remember", big, { chunked: true }).catch((e) => ({ status: `error ${e.code}` }));
    ok(chunked.status === 413, `5 MB chunked body -> 413 (got ${chunked.status})`);
    // An upload that never ends gets its 413 and is then cut off (request
    // destroyed) instead of being read forever.
    const endless = await new Promise((resolve) => {
      const t0 = Date.now();
      let status = null;
      const req = http.request({ host: "127.0.0.1", port: PORT, path: "/remember", method: "POST" }, (res) => {
        status = res.statusCode;
        res.resume();
      });
      const piece = Buffer.alloc(64 * 1024, 120);
      const timer = setInterval(() => req.write(piece), 5);
      const done = () => {
        clearInterval(timer);
        resolve({ status, ms: Date.now() - t0 });
      };
      req.on("error", done);
      req.on("close", done);
      setTimeout(() => {
        req.destroy();
      }, 8000);
    });
    ok(endless.status === 413 && endless.ms < 5000, `endless chunked upload -> 413, then destroyed by the server (status=${endless.status}, ${endless.ms}ms)`);
    const small = await post(PORT, "/lanes", JSON.stringify({ name: "1bad" }));
    ok(small.status === 400, `server still serves normal requests after a 413 (got ${small.status})`);
  } finally {
    srv.child.kill("SIGKILL");
    await srv.exited;
  }
}

// --- 4. SIGTERM drains the in-flight request ---------------------------------
{
  const srv = startServer(PORT + 1, { FAKE_SWARM_INDEX_DELAY_MS: "1500", MNEMOSYNE_SHUTDOWN_GRACE_MS: "10000" });
  try {
    ok(await srv.ready, "server started for the SIGTERM test");
    const inFlight = post(
      PORT + 1,
      "/remember",
      JSON.stringify({ text: "written during shutdown", scope: "personal", tag: "sigterm", cwd: gitCwd })
    );
    // Wait until the request is really inside remember() (its note file is on
    // disk and the slow stubbed index is running), then send SIGTERM.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const files = await readdir(notesDir).catch(() => []);
      if (files.some((f) => f.includes("-sigterm"))) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    srv.child.kill("SIGTERM");
    const res = await inFlight.catch((e) => ({ status: `error ${e.code}`, body: "" }));
    ok(res.status === 200, `in-flight remember finishes with 200 after SIGTERM (got ${res.status} ${res.body.slice(0, 200)})`);
    const { code, signal } = await srv.exited;
    ok(code === 0 && signal === null, `server exits 0 after draining (code=${code} signal=${signal})`);
    const lines = srv
      .output()
      .split("\n")
      .filter((l) => l.includes('"mnemosyne.shutdown"'));
    ok(lines.length === 1, `exactly one structured shutdown line logged (got ${lines.length})`);
    const entry = lines.length ? JSON.parse(lines[0]) : {};
    ok(
      entry.signal === "SIGTERM" && entry.in_flight_at_signal === 1 && entry.in_flight_abandoned === 0 && entry.timed_out === false,
      `shutdown line records the drained request -> ${lines[0]}`
    );
  } finally {
    if (srv.child.exitCode === null) srv.child.kill("SIGKILL");
  }
}

// --- 4b. grace period expires -> still exits 0, reports the abandoned request
{
  const srv = startServer(PORT + 2, { FAKE_SWARM_INDEX_DELAY_MS: "5000", MNEMOSYNE_SHUTDOWN_GRACE_MS: "300" });
  try {
    ok(await srv.ready, "server started for the grace-timeout test");
    const inFlight = post(
      PORT + 2,
      "/remember",
      JSON.stringify({ text: "too slow for the grace period", scope: "personal", tag: "grace", cwd: gitCwd })
    ).catch(() => null);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const files = await readdir(notesDir).catch(() => []);
      if (files.some((f) => f.includes("-grace"))) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const t0 = Date.now();
    srv.child.kill("SIGTERM");
    const { code } = await srv.exited;
    await inFlight;
    ok(code === 0 && Date.now() - t0 < 3000, `server exits 0 once the grace period expires (code=${code}, ${Date.now() - t0}ms)`);
    const line = srv.output().split("\n").find((l) => l.includes('"mnemosyne.shutdown"'));
    const entry = line ? JSON.parse(line) : {};
    ok(entry.timed_out === true && entry.in_flight_abandoned === 1, `shutdown line reports the timeout -> ${line}`);
  } finally {
    if (srv.child.exitCode === null) srv.child.kill("SIGKILL");
  }
}

await rm(scratch, { recursive: true, force: true });

if (fails) {
  console.log(`\n${fails} check(s) failed`);
  process.exit(1);
}
console.log("\nall no-lost-writes checks passed");
