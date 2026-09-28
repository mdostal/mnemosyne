// note-route.mjs — PANT-838: resolvable recall pointers.
//
// Spawns the real src/server.mjs against a throwaway MNEMOSYNE_NOTES_DIR and
// proves GET /note (and its /notes/:source alias) returns a known note's body
// + provenance, 404s an unknown one, and 400s any path traversal. Also unit-
// checks src/refs.mjs's hitRef() mapping (note path -> mnemosyne://note/,
// repo file -> repo:<scope>:<repo-relative path>). No swarm-memory/Qdrant.
//
// Usage: node test/note-route.mjs
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, "..", "src", "server.mjs");
const PORT = Number(process.env.MNEMOSYNE_TEST_PORT || 8491);
const BASE = `http://127.0.0.1:${PORT}`;

let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "  PASS" : "  FAIL"}  ${m}`);
  if (!c) fails++;
};

async function waitForServer(url, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

async function get(pathname) {
  const res = await fetch(BASE + pathname);
  return { status: res.status, body: await res.json() };
}

const work = await mkdtemp(path.join(tmpdir(), "mnemo-note-route-"));
const notesDir = path.join(work, "mnemosyne", "notes");
await mkdir(notesDir, { recursive: true });
const SOURCE = "2026-09-13T02-53-11-339Z-FFE-1.md";
const NOTE =
  "<!-- remembered via Mnemosyne @ 2026-09-13T02:53:11.339Z scope=top status=confirmed branch=main commit=abc123 -->\n" +
  "FFE-1 root cause: quota check ran before auth.\nsecond line\nthird line\n";
await writeFile(path.join(notesDir, SOURCE), NOTE, "utf8");
// A file OUTSIDE the notes dir that traversal would try to reach.
await writeFile(path.join(work, "secret.md"), "do not serve\n", "utf8");

// A fake repo for repo: ref derivation.
const repo = path.join(work, "some-repo");
await mkdir(path.join(repo, ".git"), { recursive: true });
await mkdir(path.join(repo, "docs"), { recursive: true });
await writeFile(path.join(repo, "docs", "guide.md"), "guide\n", "utf8");

process.env.MNEMOSYNE_NOTES_DIR = notesDir;
const { hitRef, decorateRefs } = await import("../src/refs.mjs");

const child = spawn(process.execPath, [SERVER_PATH], {
  env: { ...process.env, PORT: String(PORT), MNEMOSYNE_NOTES_DIR: notesDir },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverOutput = "";
child.stdout.on("data", (d) => (serverOutput += d.toString()));
child.stderr.on("data", (d) => (serverOutput += d.toString()));

try {
  ok(await waitForServer(BASE + "/healthz"), "test server came up");

  // --- known note ---------------------------------------------------------
  const known = await get(`/note?source=${encodeURIComponent(SOURCE)}&chunk=0`);
  ok(known.status === 200, `GET /note known source -> 200 (got ${known.status})`);
  ok(known.body.text === NOTE, "returns the stored note body verbatim");
  ok(known.body.ref === `mnemosyne://note/${SOURCE}`, "echoes the mnemosyne://note ref");
  ok(known.body.chunk === 0, "echoes the requested chunk");
  ok(
    known.body.provenance?.status === "confirmed" &&
      known.body.provenance?.branch === "main" &&
      known.body.provenance?.commit_sha === "abc123" &&
      known.body.provenance?.scope === "top",
    "returns provenance parsed from the note header"
  );
  ok(!JSON.stringify(known.body).includes(notesDir), "response never leaks the host notes path");

  const byRef = await get(`/note?source=${encodeURIComponent(`mnemosyne://note/${SOURCE}`)}`);
  ok(byRef.status === 200 && byRef.body.text === NOTE, "accepts the full mnemosyne://note/<source> ref");

  const sliced = await get(`/note?source=${encodeURIComponent(SOURCE)}&lines=2-3`);
  ok(
    sliced.status === 200 && sliced.body.text === "FFE-1 root cause: quota check ran before auth.\nsecond line",
    "lines=a-b slices the note (1-based, inclusive)"
  );

  const alias = await get(`/notes/${encodeURIComponent(SOURCE)}`);
  ok(alias.status === 200 && alias.body.text === NOTE, "GET /notes/:source alias returns the same body");

  // --- unknown note -------------------------------------------------------
  const unknown = await get(`/note?source=does-not-exist.md`);
  ok(unknown.status === 404, `unknown source -> 404 (got ${unknown.status})`);

  // --- traversal / invalid ------------------------------------------------
  for (const bad of ["../secret.md", "..", "../../etc/passwd", "sub/../../secret.md", "/etc/passwd", "..%2Fsecret.md", ".hidden"]) {
    const r = await get(`/note?source=${encodeURIComponent(bad)}`);
    ok(r.status === 400, `source=${JSON.stringify(bad)} -> 400 (got ${r.status})`);
  }
  const aliasTraversal = await get(`/notes/..%2Fsecret.md`);
  ok(aliasTraversal.status === 400, `/notes/..%2Fsecret.md -> 400 (got ${aliasTraversal.status})`);
  const missing = await get(`/note`);
  ok(missing.status === 400, `missing source -> 400 (got ${missing.status})`);
  const badLines = await get(`/note?source=${encodeURIComponent(SOURCE)}&lines=abc`);
  ok(badLines.status === 400, `malformed lines -> 400 (got ${badLines.status})`);

  // --- ref derivation (src/refs.mjs) ---------------------------------------
  ok(
    hitRef({ source: SOURCE, full_path: path.join(notesDir, SOURCE) }, "top") === `mnemosyne://note/${SOURCE}`,
    "note hit -> mnemosyne://note/<source>"
  );
  ok(
    hitRef({ full_path: `/root/.local/share/mnemosyne/notes/${SOURCE}` }, "top") === `mnemosyne://note/${SOURCE}`,
    "note hit indexed under another host's notes dir -> still a note ref"
  );
  ok(
    hitRef({ source: "guide.md", full_path: path.join(repo, "docs", "guide.md") }, "mnemosyne") ===
      "repo:mnemosyne:docs/guide.md",
    "absolute repo file -> repo:<scope>:<repo-relative path>"
  );
  ok(hitRef({ location: "src/engine.mjs" }, "mnemosyne") === "repo:mnemosyne:src/engine.mjs", "relative path kept as-is");
  ok(hitRef({ source: "edge", text: "a -> b" }, "code-graph") === null, "code-graph edge label gets no ref");
  const decorated = decorateRefs({
    scopes: [{ scope: "top", hits: [{ full_path: path.join(notesDir, SOURCE) }, { ref: "keep-me" }] }],
  });
  ok(
    decorated.scopes[0].hits[0].ref === `mnemosyne://note/${SOURCE}` && decorated.scopes[0].hits[1].ref === "keep-me",
    "decorateRefs stamps refs in place and keeps an existing ref"
  );
} finally {
  child.kill();
  await rm(work, { recursive: true, force: true });
}

if (fails) console.log(serverOutput);
console.log(fails ? `\n${fails} check(s) failed` : "\nall note-route checks passed");
process.exit(fails ? 1 : 0);
