// remember-provenance.mjs — PANT-977 (mnemosyne#47): POST /remember and the
// MCP remember tool accept explicit `status` + `source_ref`, so a caller with
// no git checkout (a client-level note) can still write.
//
// Spawns the real src/server.mjs with its cwd in a NON-git temp dir and the
// fake swarm-memory binary (no Qdrant), then proves:
//   - without status/source_ref, auto-detection still runs and fails (422)
//   - with them, the write succeeds and the note header carries them
//   - `sourceRef` is accepted as an alias; commit_sha is optional
//   - bad / half-supplied values answer 400 and write nothing
//   - with a git cwd and no explicit fields, behaviour is unchanged
//   - the MCP remember tool passes both fields through to the same route
//
// Usage: node test/remember-provenance.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeScratchGitRepo } from "./fixtures/scratch-git-repo.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SERVER_PATH = path.join(ROOT, "src", "server.mjs");
const MCP_SERVER_PATH = path.join(ROOT, "bin", "mnemosyne-mcp.mjs");
const FIXTURE = path.join(__dirname, "fixtures", "fake-swarm-memory");
const PORT = Number(process.env.MNEMOSYNE_TEST_PORT || 8513);
const BASE = `http://127.0.0.1:${PORT}`;
const SHA = "55b2b0e1234567890abcdef1234567890abcdef";

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

async function post(body) {
  const res = await fetch(BASE + "/remember", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const firstLine = async (file) => (await readFile(file, "utf8")).split("\n", 1)[0];

const work = await mkdtemp(path.join(tmpdir(), "mnemo-remember-provenance-"));
const notesDir = path.join(work, "notes");
const noGitCwd = await mkdtemp(path.join(tmpdir(), "mnemo-remember-nogit-"));
const { dir: repoDir, cleanup: cleanupRepo } = makeScratchGitRepo({ prefix: "mnemo-remember-provenance-repo-" });

const childEnv = {
  ...process.env,
  PORT: String(PORT),
  MNEMOSYNE_NOTES_DIR: notesDir,
  SWARM_MEMORY_BIN: FIXTURE,
  FAKE_SWARM_MODE: "success",
  MNEMO_TEST_NODE: process.execPath,
};
const child = spawn(process.execPath, [SERVER_PATH], {
  cwd: noGitCwd,
  env: childEnv,
  stdio: ["ignore", "pipe", "pipe"],
});
let serverOutput = "";
child.stdout.on("data", (d) => (serverOutput += d.toString()));
child.stderr.on("data", (d) => (serverOutput += d.toString()));

try {
  ok(await waitForServer(BASE + "/healthz"), "test server came up (cwd has no git state)");

  // --- unchanged: no explicit fields -> auto-detect from cwd -----------------
  const auto = await post({ text: "auto-detect note", scope: "personal", tag: "pv-auto" });
  ok(auto.status === 422, `no status/source_ref from a non-git cwd -> 422 (got ${auto.status})`);
  ok(
    /auto-detection failed/.test(auto.body.error || "") && /source_ref/.test(auto.body.error || ""),
    `422 names the HTTP fields to pass -> ${JSON.stringify(auto.body.error)}`
  );

  const autoGit = await post({ text: "git cwd note", scope: "personal", tag: "pv-git", cwd: repoDir });
  ok(autoGit.status === 200, `no explicit fields + git cwd -> 200 (got ${autoGit.status} ${JSON.stringify(autoGit.body)})`);
  ok(
    autoGit.body.status === "provisional" && autoGit.body.source_ref?.branch === "scratch-feature",
    `auto-detected provenance unchanged -> ${JSON.stringify(autoGit.body.source_ref)}`
  );

  // --- explicit status + source_ref ------------------------------------------
  const sourceRef = { branch: "main", commit_sha: SHA, pr_url: "https://github.com/mdostal/mnemosyne/pull/1" };
  const explicit = await post({
    text: "firefly-events prefers X across its repos",
    scope: "personal",
    tag: "pv-explicit",
    status: "confirmed",
    source_ref: sourceRef,
  });
  ok(explicit.status === 200, `status + source_ref from a non-git cwd -> 200 (got ${explicit.status} ${JSON.stringify(explicit.body)})`);
  ok(
    explicit.body.status === "confirmed" && JSON.stringify(explicit.body.source_ref) === JSON.stringify(sourceRef),
    `response echoes the explicit provenance -> ${JSON.stringify(explicit.body.source_ref)}`
  );
  const header = explicit.body.file ? await firstLine(explicit.body.file) : "";
  ok(
    / scope=personal status=confirmed branch=main commit=55b2b0e1234567890abcdef1234567890abcdef -->$/.test(header),
    `stored note header carries the explicit values -> ${header}`
  );

  const alias = await post({
    text: "camelCase alias, no commit",
    scope: "personal",
    tag: "pv-alias",
    status: "provisional",
    sourceRef: { branch: "feat/x" },
  });
  ok(alias.status === 200, `sourceRef alias without commit_sha -> 200 (got ${alias.status} ${JSON.stringify(alias.body)})`);
  ok(
    alias.body.source_ref?.commit_sha === null && alias.body.source_ref?.pr_url === null,
    `missing commit_sha / pr_url normalize to null -> ${JSON.stringify(alias.body.source_ref)}`
  );
  const aliasHeader = alias.body.file ? await firstLine(alias.body.file) : "";
  ok(/status=provisional branch=feat\/x commit=none -->$/.test(aliasHeader), `no-commit header reads commit=none -> ${aliasHeader}`);

  const note = await fetch(`${BASE}/note?source=${encodeURIComponent(path.basename(alias.body.file || "x"))}`);
  const noteBody = await note.json();
  ok(
    note.status === 200 && noteBody.provenance?.commit_sha === null && noteBody.provenance?.branch === "feat/x",
    `GET /note reports commit_sha: null for a commit=none header -> ${JSON.stringify(noteBody.provenance)}`
  );

  // --- bad values -> 400, nothing written ------------------------------------
  const before = (await readdir(notesDir)).length;
  const bad = [
    ["status without source_ref", { status: "confirmed" }],
    ["source_ref without status", { source_ref: { branch: "main" } }],
    ["unknown status", { status: "final", source_ref: { branch: "main" } }],
    ["source_ref not an object", { status: "confirmed", source_ref: "main" }],
    ["missing branch", { status: "confirmed", source_ref: { commit_sha: SHA } }],
    ["branch with whitespace", { status: "confirmed", source_ref: { branch: "main x" } }],
    ["non-hex commit_sha", { status: "confirmed", source_ref: { branch: "main", commit_sha: "not-a-sha" } }],
    ["non-string pr_url", { status: "confirmed", source_ref: { branch: "main", pr_url: 42 } }],
  ];
  for (const [label, fields] of bad) {
    const r = await post({ text: "bad provenance", scope: "personal", tag: "pv-bad", ...fields });
    ok(r.status === 400, `${label} -> 400 (got ${r.status} ${JSON.stringify(r.body.error)})`);
  }
  ok((await readdir(notesDir)).length === before, "rejected writes leave no note file behind");

  // --- MCP remember tool -----------------------------------------------------
  // mnemosyne-mcp reuses the HTTP service already healthy on PORT.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_SERVER_PATH],
    env: childEnv,
    cwd: noGitCwd,
  });
  const client = new Client({ name: "remember-provenance-test", version: "0.1.0" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const props = tools.find((t) => t.name === "remember")?.inputSchema?.properties || {};
    ok(!!props.status && !!props.source_ref, `MCP remember schema exposes status + source_ref (got ${Object.keys(props).join(",")})`);

    const res = await client.callTool({
      name: "remember",
      arguments: { text: "mcp client-level note", scope: "personal", tag: "pv-mcp", status: "confirmed", source_ref: { branch: "main", commit_sha: SHA } },
    });
    const text = res.content?.find((c) => c.type === "text")?.text;
    const data = text ? JSON.parse(text) : null;
    ok(!res.isError && data?.status === "confirmed", `MCP remember with explicit provenance succeeds -> ${text}`);
    const mcpHeader = data?.file ? await firstLine(data.file) : "";
    ok(/status=confirmed branch=main commit=55b2b0e/.test(mcpHeader), `MCP write's header carries the values -> ${mcpHeader}`);

    const mcpAuto = await client.callTool({ name: "remember", arguments: { text: "mcp no provenance", scope: "personal", tag: "pv-mcp-auto" } });
    ok(mcpAuto.isError === true, "MCP remember without provenance from a non-git cwd still fails (auto-detect unchanged)");
  } finally {
    await client.close().catch(() => {});
  }
} finally {
  child.kill();
  await rm(work, { recursive: true, force: true });
  await rm(noGitCwd, { recursive: true, force: true });
  cleanupRepo();
}

if (fails) console.log(serverOutput);
console.log(fails ? `\n${fails} check(s) failed` : "\nall remember-provenance checks passed");
process.exit(fails ? 1 : 0);
