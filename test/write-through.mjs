// write-through.mjs — write-through consistency contract for engine.remember().
//
// Verifies (mc-01-write-through-consistency):
//   AC1  file write succeeds, Qdrant upsert fails -> remember() rejects with
//        status 500 + error detail, and the note file is kept (not deleted)
//   AC2  file write succeeds, Qdrant upsert succeeds -> remember() resolves
//        with chunks_upserted > 0
//   AC3  on upsert failure, an ERROR-prefixed line is written to stderr
//   AC4  on success, the note file exists on disk at the returned path
//
// Uses a test double (test/fixtures/fake-swarm-memory.mjs) in place of the
// real swarm-memory binary, so this suite never touches Qdrant or the
// filesystem outside a scratch notes dir. engine.mjs resolves its CLI binary
// and child env once at module load, so each scenario re-imports engine.mjs
// fresh (via a cache-busting query string) after setting env vars for that
// scenario.
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-swarm-memory", import.meta.url));

let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "  PASS" : "  FAIL"}  ${m}`);
  if (!c) fails++;
};

let seq = 0;
async function loadEngine(mode, notesDir) {
  process.env.SWARM_MEMORY_BIN = FIXTURE;
  process.env.FAKE_SWARM_MODE = mode;
  process.env.MNEMOSYNE_NOTES_DIR = notesDir;
  process.env.MNEMO_TEST_NODE = process.execPath;
  seq += 1;
  const mod = await import(`../src/engine.mjs?write-through-scenario=${mode}-${seq}`);
  return mod;
}

const notesDir = await mkdtemp(path.join(tmpdir(), "mnemosyne-write-through-"));

async function fileExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function withCapturedStderr(fn) {
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return lines;
}

// --- AC1 + AC3: hard CLI failure (non-zero exit) ---------------------------
{
  const { remember } = await loadEngine("hard-fail", notesDir);
  let error = null;
  let file = null;
  const stderrLines = await withCapturedStderr(async () => {
    try {
      await remember("hard-fail scenario note", "personal", { tag: "wt-hard-fail" });
    } catch (e) {
      error = e;
      file = e.file || null;
    }
  });

  ok(!!error, "hard-fail: remember() rejects when swarm-memory index exits non-zero");
  ok(error?.status === 500, `hard-fail: rejection carries status 500 -> got ${error?.status}`);
  ok(
    !!error?.message && /index/i.test(error.message),
    `hard-fail: error detail describes the failure -> "${error?.message}"`
  );
  ok(
    stderrLines.some((l) => l.includes("ERROR")),
    `hard-fail: stderr logs an ERROR-prefixed line -> ${JSON.stringify(stderrLines)}`
  );
}

// --- AC1 + AC3: silent CLI failure (exit 0, no chunks upserted) ------------
{
  const { remember } = await loadEngine("silent-fail", notesDir);
  let error = null;
  const stderrLines = await withCapturedStderr(async () => {
    try {
      await remember("silent-fail scenario note", "personal", { tag: "wt-silent-fail" });
    } catch (e) {
      error = e;
    }
  });

  ok(
    !!error,
    "silent-fail: remember() rejects when swarm-memory exits 0 but reports no upserted chunks"
  );
  ok(error?.status === 500, `silent-fail: rejection carries status 500 -> got ${error?.status}`);
  ok(
    stderrLines.some((l) => l.includes("ERROR")),
    `silent-fail: stderr logs an ERROR-prefixed line -> ${JSON.stringify(stderrLines)}`
  );
}

// --- Divergence check: the note file survives both failure scenarios ------
{
  const fs = await import("node:fs/promises");
  const files = await fs.readdir(notesDir);
  const kept = files.filter((f) => f.includes("wt-hard-fail") || f.includes("wt-silent-fail"));
  ok(
    kept.length === 2,
    `failed writes keep the note file as a recovery artifact -> found ${kept.length}/2`
  );
}

// --- AC2 + AC4: successful write-through -----------------------------------
{
  const { remember } = await loadEngine("success", notesDir);
  const result = await remember("success scenario note", "personal", { tag: "wt-success" });

  ok(
    result.chunks_upserted > 0,
    `success: response confirms chunks_upserted > 0 -> got ${result.chunks_upserted}`
  );
  ok(await fileExists(result.file), `success: note file exists at the returned path -> ${result.file}`);
}

await rm(notesDir, { recursive: true, force: true });

console.log(fails ? `\n${fails} check(s) failed` : "\nall write-through checks passed");
process.exit(fails ? 1 : 0);
