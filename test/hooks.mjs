// hooks.mjs — end-to-end proof of the v1 memory hook integration.
//
// Proves the auto-loading path through installed hook commands:
//   - bin/mnemosyne-install-hooks wires UserPromptSubmit -> pre-recall and
//     Stop -> post-remember into a scratch settings.json.
//   - UserPromptSubmit receives hookSpecificOutput.additionalContext.
//   - Stop persists a reviewed learning, and a later UserPromptSubmit recalls it
//     from the live Qdrant-backed corpus.
//   - High-level hits are injected before lower-level hits through the actual
//     pre-recall hook boundary.
//   - Scratch note files created by write-through are removed after the test.
//
//   node test/hooks.mjs
//
// Live round-trip coverage requires the Mnemosyne service on :8477. If /healthz
// is unreachable, the live corpus portion is skipped instead of failing a local
// checkout that has not started the service.

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const INSTALL = path.join(ROOT, "bin", "mnemosyne-install-hooks");
const LIVE_BASE = process.env.MNEMOSYNE_URL || "http://127.0.0.1:8477";

let fails = 0;
const cleanupFiles = new Set();
const cleanupDirs = new Set();
const ok = (c, m) => {
  console.log(`${c ? "  PASS" : "  FAIL"}  ${m}`);
  if (!c) fails++;
};

function runNode(args, inputObj, env = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
    });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => resolve({ code, out, err }));
    if (inputObj) p.stdin.write(JSON.stringify(inputObj));
    p.stdin.end();
  });
}

function runInstalled(command, inputObj, env = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(command, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      shell: true,
    });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => resolve({ code, out, err }));
    p.stdin.write(JSON.stringify(inputObj));
    p.stdin.end();
  });
}

async function serviceAlive(base) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await fetch(`${base}/healthz`, { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

async function installIntoScratch(serviceUrl) {
  const dir = await mkdtemp(path.join(tmpdir(), "mnemosyne-hooks-"));
  cleanupDirs.add(dir);
  const settingsPath = path.join(dir, "settings.json");
  const install = await runNode(
    [INSTALL, "--settings", settingsPath, "--yes", "--service-url", serviceUrl],
    null
  );
  ok(install.code === 0, `mnemosyne-install-hooks exits 0 (${settingsPath})`);
  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  const preCommand = settings.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command || "";
  const stopCommand = settings.hooks?.Stop?.[0]?.hooks?.[0]?.command || "";
  ok(preCommand.includes(path.join(ROOT, "hooks", "pre-recall.mjs")), "installer wires UserPromptSubmit to this checkout's pre-recall hook");
  ok(stopCommand.includes(path.join(ROOT, "hooks", "post-remember.mjs")), "installer wires Stop to this checkout's post-remember hook");
  return { preCommand, stopCommand };
}

function parseJson(out, fallback = {}) {
  try {
    return JSON.parse(out || "{}");
  } catch {
    return fallback;
  }
}

function startHighLevelMemoryStub() {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const input = body ? JSON.parse(body) : {};
      requests.push({ method: req.method, url: req.url, input });
      res.setHeader("content-type", "application/json");

      if (req.method === "GET" && req.url === "/healthz") {
        res.end(JSON.stringify({ alive: true }));
        return;
      }

      if (req.method === "POST" && req.url === "/grep") {
        res.end(JSON.stringify({ total_hits: 0, scopes: [] }));
        return;
      }

      if (req.method === "POST" && req.url === "/recall") {
        const scope = input.scope || "vector";
        const hit =
          scope === "meta"
            ? {
                source: "meta/auto-loading.md",
                full_path: "/memory/meta/auto-loading.md",
                chunk_span: [1, 3],
                score: 0.1,
                text: "High-level memory exists for hook auto-loading and must be injected first.",
              }
            : {
                source: "vector/hook-detail.md",
                full_path: "/memory/vector/hook-detail.md",
                chunk_span: [10, 14],
                score: 0.99,
                text: "Lower-level vector detail scores higher but must appear after meta.",
              };
        res.end(JSON.stringify({ total_hits: 1, scopes: [{ scope, hits: [hit] }] }));
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    });
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, requests, base: `http://127.0.0.1:${port}` });
    });
  });
}

async function testHighLevelFirstThroughHook() {
  const stub = await startHighLevelMemoryStub();
  try {
    const { preCommand } = await installIntoScratch(stub.base);
    const recalled = await runInstalled(
      preCommand,
      {
        hook_event_name: "UserPromptSubmit",
        prompt: "Validate high-level hook memory order",
        scope: "vector",
        shared_scope: "meta",
        role: "developer",
        hits: 1,
        shared_hits: 1,
      },
      {
        MNEMOSYNE_URL: stub.base,
        SWARM_MEMORY_BIN: "/definitely/missing/swarm-memory",
      }
    );
    ok(recalled.code === 0, "pre-recall exits 0 for UserPromptSubmit");
    const json = parseJson(recalled.out);
    const injected = json.hookSpecificOutput?.additionalContext || "";
    ok(json.hookSpecificOutput?.hookEventName === "UserPromptSubmit", "pre-recall emits the UserPromptSubmit hook event name");
    ok(injected.length > 0, "pre-recall injects additionalContext");
    ok(json.mnemosyne?.canonical_bundle === injected, "canonical bundle matches additionalContext");
    ok(injected.indexOf("[meta") >= 0, "high-level meta hit appears in injected bundle");
    ok(injected.indexOf("[meta") < injected.indexOf("[vector"), "high-level hit is injected before lower-level vector hit");
    ok(
      stub.requests.some((r) => r.url === "/recall" && r.input.scope === "meta"),
      "pre-recall queries the high-level shared scope"
    );
  } finally {
    await new Promise((resolve) => stub.server.close(resolve));
  }
}

async function testLiveStopToUserPromptRoundTrip() {
  if (!(await serviceAlive(LIVE_BASE))) {
    console.log(`  SKIP  live hook round-trip (${LIVE_BASE}/healthz unreachable)`);
    return;
  }

  const { preCommand, stopCommand } = await installIntoScratch(LIVE_BASE);
  const token = `MNEMO-HOOK-E2E-${Date.now()}`;
  const markerText =
    `Mnemosyne hook integration checkpoint for Stop/UserPromptSubmit. Unique token ${token}. ` +
    "This verifies the installed hook commands persist and recall memory through the live corpus.";

  const stored = await runInstalled(stopCommand, {
    hook_event_name: "Stop",
    text: markerText,
    scope: "personal",
    status: "reviewed",
    ticket: token,
    role: "developer",
  });
  ok(stored.code === 0, "post-remember exits 0 for Stop");
  const storedJson = parseJson(stored.out);
  ok(storedJson.ok === true, `post-remember persisted via=${storedJson.via} scope=${storedJson.scope} status=${storedJson.status}`);
  if (storedJson.file) cleanupFiles.add(storedJson.file);

  await new Promise((r) => setTimeout(r, 3000));

  const recalled = await runInstalled(preCommand, {
    hook_event_name: "UserPromptSubmit",
    prompt: `Find the hook integration checkpoint ${token}`,
    ticket: token,
    scope: "personal",
    role: "developer",
    hits: 5,
  });
  ok(recalled.code === 0, "pre-recall exits 0 for UserPromptSubmit live recall");
  const recalledJson = parseJson(recalled.out);
  const injected = recalledJson.hookSpecificOutput?.additionalContext || "";
  ok(injected.includes(token), "pre-recall recalls the Stop learning into additionalContext");
  ok(recalledJson.mnemosyne?.canonical_bundle === injected, "live recall canonical bundle matches additionalContext");
  ok(injected.includes("mnemosyne-cache-breakpoint"), "injected context includes the cache breakpoint marker");
  ok(/keyword-exact/.test(injected), "token surfaced via deterministic keyword-exact match");
  ok(/lines\s+\d+–\d+|chunk\s+\d+/.test(injected), "injected context carries line-range/chunk provenance");
  ok(/Prior Memory/.test(injected), "injected context is a Prior Memory section");

  if (storedJson.file) {
    try {
      await unlink(storedJson.file);
      cleanupFiles.delete(storedJson.file);
      ok(true, `cleaned up scratch note file -> ${storedJson.file}`);
    } catch (e) {
      ok(false, `failed to clean up scratch note file -> ${e.message}`);
    }
  } else {
    ok(false, "post-remember exposed the scratch note file for cleanup");
  }
}

try {
  await testHighLevelFirstThroughHook();
  await testLiveStopToUserPromptRoundTrip();
} finally {
  for (const file of cleanupFiles) {
    try {
      await unlink(file);
    } catch {
      // Already reported above when cleanup was part of a checked assertion.
    }
  }
  for (const dir of cleanupDirs) {
    await rm(dir, { recursive: true, force: true });
  }
}

console.log(fails ? `\n${fails} check(s) failed` : "\nall hook integration checks passed");
process.exit(fails ? 1 : 0);
