// lanes-route.mjs — integration test for the s-02 Lanes panel's server wiring:
// GET /scopes rendering + the POST /lanes add-lane route, end to end through a
// real (subprocess) Mnemosyne server instance.
//
// NEVER touches the real ~/.config/swarm-memory/config.toml: the server
// subprocess is launched with SWARM_MEMORY_CONFIG pointed at a throwaway
// fixture copied into a temp dir, so every engine.mjs call in that subprocess
// (scopeMap/addLane) resolves against the fixture, not the real file.
//
// Usage: node test/lanes-route.mjs
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, "..", "src", "server.mjs");
const PORT = Number(process.env.MNEMOSYNE_TEST_PORT || 8479);
const BASE = `http://127.0.0.1:${PORT}`;

let fails = 0;
const ok = (c, m) => { console.log(`${c ? "  PASS" : "  FAIL"}  ${m}`); if (!c) fails++; };

const FIXTURE = `# fixture config.toml for mnemosyne lanes-route tests — throwaway, never the real file.
[qdrant]
url = "https://example.invalid:6333"
api_key_cmd = ""

[embedder]
provider = "ollama"
url = "http://localhost:11434"
model = "nomic-embed-text"
dim = 768

[general]
default_scope = "top"
fallback_collection = "fixture_fallback"

[scopes]
top = "fixture_top_collection"
personal = "fixture_personal_collection"

[ladder]
personal = ["top"]
`;

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

const dir = await mkdtemp(path.join(tmpdir(), "mnemosyne-lanes-route-"));
const configPath = path.join(dir, "config.toml");
await writeFile(configPath, FIXTURE, "utf8");

const child = spawn(process.execPath, [SERVER_PATH], {
  env: {
    ...process.env,
    PORT: String(PORT),
    SWARM_MEMORY_CONFIG: configPath,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let serverOutput = "";
child.stdout.on("data", (d) => { serverOutput += d.toString(); });
child.stderr.on("data", (d) => { serverOutput += d.toString(); });

try {
  const up = await waitForServer(BASE + "/scopes");
  ok(up, "test server (fixture-backed) came up");

  // --- GET /scopes renders every configured scope -----------------------
  {
    const res = await fetch(BASE + "/scopes");
    const body = await res.json();
    ok(res.status === 200, `GET /scopes -> 200 (got ${res.status})`);
    ok(body.scopes && body.scopes.top === "fixture_top_collection" && body.scopes.personal === "fixture_personal_collection",
      `GET /scopes returns the fixture's scopes (${JSON.stringify(body.scopes)})`);
    ok(body.ladder && Array.isArray(body.ladder.personal) && body.ladder.personal[0] === "top",
      `GET /scopes returns the fixture's ladder (${JSON.stringify(body.ladder)})`);
  }

  // --- POST /lanes: successful add, visible on next GET /scopes ----------
  {
    const res = await fetch(BASE + "/lanes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "research", collection: "fixture_research_collection", ladder: ["top"] }),
    });
    const body = await res.json();
    ok(res.status === 200 && body.added === true,
      `POST /lanes -> 200 added:true (got ${res.status}, ${JSON.stringify(body)})`);

    const after = await (await fetch(BASE + "/scopes")).json();
    ok(after.scopes && after.scopes.research === "fixture_research_collection",
      `new lane 'research' appears in GET /scopes on next load (${JSON.stringify(after.scopes.research)})`);
    ok(after.ladder && Array.isArray(after.ladder.research) && after.ladder.research[0] === "top",
      `new lane's ladder appears in GET /scopes on next load`);
    // pre-existing lanes still present, unchanged
    ok(after.scopes.top === "fixture_top_collection" && after.scopes.personal === "fixture_personal_collection",
      "pre-existing lanes unchanged after the add");
  }

  // --- POST /lanes: duplicate name rejected, config.toml unmodified ------
  {
    const before = await readFile(configPath, "utf8");
    const res = await fetch(BASE + "/lanes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "personal", collection: "some_other_collection" }),
    });
    const body = await res.json();
    ok(res.status >= 400 && res.status < 500,
      `POST /lanes with a duplicate name -> 4xx (got ${res.status}, ${JSON.stringify(body)})`);
    const after = await readFile(configPath, "utf8");
    ok(after === before, "config.toml unmodified after a rejected duplicate POST /lanes");
  }

  // --- GET /ui mentions the Lanes panel + add-lane form -------------------
  {
    const res = await fetch(BASE + "/ui");
    const body = await res.text();
    ok(res.status === 200, `GET /ui -> 200 (got ${res.status})`);
    ok(/lanes/i.test(body), "GET /ui body mentions a Lanes panel");
    ok(/add-lane-form/i.test(body), "GET /ui body has an add-lane form");
  }
} finally {
  child.kill();
  await rm(dir, { recursive: true, force: true });
}

if (fails) {
  console.log("\n--- server output (for debugging) ---");
  console.log(serverOutput);
}

console.log(fails ? `\n${fails} check(s) failed` : "\nall lanes-route checks passed");
process.exit(fails ? 1 : 0);
