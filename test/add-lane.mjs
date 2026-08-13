// add-lane.mjs — TDD tests for engine.mjs's addLane() atomic config.toml write.
//
// These tests NEVER touch the real ~/.config/swarm-memory/config.toml. Every
// test copies a throwaway fixture into a fresh temp dir and points the
// SWARM_MEMORY_CONFIG env override (the same env var swarm-memory's own CLI
// honors — see swarm_memory/config.py's load_config()) at that temp copy
// before calling addLane(). The real config file is never read or written by
// this suite.
//
// Covers (per s-02-lanes-browser's acceptance criteria):
//   - successful add: new [scopes]/[ladder] entries appear, existing entries
//     untouched, single-generation .bak backup written.
//   - duplicate-name rejection: config.toml is byte-identical afterward.
//   - byte-identical-on-validation-failure: forced via a fixture that fails
//     to parse (so the real `swarm-memory --config <tmp> config` validation
//     step genuinely fails), verified via a sha256 checksum comparison.
//
// Usage: node test/add-lane.mjs
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { addLane } from "../src/engine.mjs";

let fails = 0;
const ok = (c, m) => { console.log(`${c ? "  PASS" : "  FAIL"}  ${m}`); if (!c) fails++; };

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

const FIXTURE = `# fixture config.toml for mnemosyne add-lane tests — throwaway, never the real file.
[qdrant]
url = "https://example.invalid:6333"
api_key_cmd = ""

[embedder]
provider = "ollama"
url = "http://localhost:11434"
model = "nomic-embed-text"
dim = 768
query_prefix = "search_query: "
document_prefix = "search_document: "

[general]
default_scope = "top"
min_score = 0.0
fallback_collection = "fixture_fallback"
fallback_filter_key = "project_scope"

[scopes]
top = "fixture_top_collection"
personal = "fixture_personal_collection"

[ladder]
personal = ["top"]
`;

// A fixture that fails to parse regardless of any surgical edit we make to
// its [scopes]/[ladder] tables — used to force the real round-trip
// validation call to fail, so we can prove the byte-identical-on-failure
// guarantee against an actual `swarm-memory` invocation, not a mock.
const BROKEN_FIXTURE = FIXTURE + "\nnot valid toml [[[\n";

async function withFixture(content, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "mnemosyne-add-lane-"));
  const configPath = path.join(dir, "config.toml");
  await writeFile(configPath, content, "utf8");
  const prevEnv = process.env.SWARM_MEMORY_CONFIG;
  process.env.SWARM_MEMORY_CONFIG = configPath;
  try {
    await fn(configPath, dir);
  } finally {
    if (prevEnv === undefined) delete process.env.SWARM_MEMORY_CONFIG;
    else process.env.SWARM_MEMORY_CONFIG = prevEnv;
    await rm(dir, { recursive: true, force: true });
  }
}

// --- successful add ---------------------------------------------------------
await withFixture(FIXTURE, async (configPath) => {
  const before = await readFile(configPath, "utf8");

  const result = await addLane("testlane", "fixture_testlane_collection", ["top"]);
  ok(result && result.added === true, `addLane() resolves with added:true (${JSON.stringify(result)})`);
  ok(result.name === "testlane" && result.collection === "fixture_testlane_collection",
    "result echoes name + collection");

  const after = await readFile(configPath, "utf8");
  ok(after !== before, "config.toml content changed after a successful add");
  ok(/\[scopes\][\s\S]*?^testlane\s*=\s*"fixture_testlane_collection"/m.test(after),
    "new scope entry present in [scopes] table");
  ok(/^top\s*=\s*"fixture_top_collection"/m.test(after) && /^personal\s*=\s*"fixture_personal_collection"/m.test(after),
    "pre-existing scope entries are untouched");
  ok(/\[ladder\][\s\S]*?^testlane\s*=\s*\["top"\]/m.test(after),
    "new ladder entry present in [ladder] table");
  ok(/^personal\s*=\s*\["top"\]/m.test(after), "pre-existing ladder entry is untouched");

  const backup = await readFile(configPath + ".bak", "utf8");
  ok(backup === before, "config.toml.bak matches the pre-write state (single-generation backup)");

  // no leftover temp files
  const dirFiles = await readdir(path.dirname(configPath));
  const tmpLeftovers = dirFiles.filter((f) => f.includes(".tmp-"));
  ok(tmpLeftovers.length === 0, `no leftover temp files after a successful add (found: ${tmpLeftovers})`);
});

// --- duplicate-name rejection ------------------------------------------------
await withFixture(FIXTURE, async (configPath) => {
  const before = await readFile(configPath, "utf8");
  const beforeHash = sha256(before);

  let threw = null;
  try {
    await addLane("personal", "some_new_collection");
  } catch (e) {
    threw = e;
  }
  ok(threw != null, "addLane() throws for a duplicate scope name");
  ok(threw && threw.status >= 400 && threw.status < 500,
    `duplicate rejection uses a 4xx status (got ${threw && threw.status})`);

  const after = await readFile(configPath, "utf8");
  ok(sha256(after) === beforeHash, "config.toml is byte-identical after a rejected duplicate add (checksum match)");
});

// --- byte-identical on validation failure ------------------------------------
await withFixture(BROKEN_FIXTURE, async (configPath) => {
  const before = await readFile(configPath, "utf8");
  const beforeHash = sha256(before);

  let threw = null;
  try {
    await addLane("willfail", "fixture_willfail_collection");
  } catch (e) {
    threw = e;
  }
  ok(threw != null, "addLane() throws when round-trip validation fails");

  const after = await readFile(configPath, "utf8");
  ok(sha256(after) === beforeHash,
    "config.toml is byte-identical to its pre-write state after a validation failure (checksum match)");

  const dirFiles = await readdir(path.dirname(configPath));
  const tmpLeftovers = dirFiles.filter((f) => f.includes(".tmp-"));
  ok(tmpLeftovers.length === 0, `no leftover temp files after a failed add (found: ${tmpLeftovers})`);
});

// --- input validation: rejects bad names/collections before touching disk ---
await withFixture(FIXTURE, async (configPath) => {
  const before = await readFile(configPath, "utf8");
  const beforeHash = sha256(before);

  let threw = null;
  try {
    await addLane("../etc/passwd", "whatever");
  } catch (e) {
    threw = e;
  }
  ok(threw != null && threw.status === 400, "addLane() rejects an invalid lane name (400)");

  threw = null;
  try {
    await addLane("newlane", "");
  } catch (e) {
    threw = e;
  }
  ok(threw != null && threw.status === 400, "addLane() rejects an empty collection (400)");

  const after = await readFile(configPath, "utf8");
  ok(sha256(after) === beforeHash, "config.toml untouched after input-validation rejections");
});

console.log(fails ? `\n${fails} check(s) failed` : "\nall add-lane checks passed");
process.exit(fails ? 1 : 0);
