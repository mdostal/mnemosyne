// onboard-cli.mjs — real subprocess-level tests for `mnemosyne onboard`
// (ro-05-onboard-cli-verb-existing-collection, epic:
// mnemosyne-repo-onboarding).
//
// Runs the REAL `mnemosyne onboard` CLI as a real subprocess (`tsx
// bin/mnemosyne-onboard.mjs ...`, and separately via `bin/mnemosyne onboard
// ...` to prove the dispatcher wiring) -- mirrors test/agent-cli.mjs's own
// established convention (real-subprocess, real $HOME isolation via
// mkdtemp(), never this operator's real ~/.mnemosyne/).
//
// The one real external dependency `mnemosyne onboard` has -- a live Qdrant
// read to confirm a collection actually exists (acceptance criterion #5) --
// is stubbed per this story's own test-spec instruction ("Use a
// fake/stubbed inventory check (never a live Qdrant call in tests)") by
// pointing HOME-relative `~/.config/swarm-memory/{qdrant.key,config.toml}`
// at a real, local, throwaway HTTP server (startFakeQdrantServer() below)
// speaking Qdrant's own `GET /collections` response shape -- this exercises
// the REAL mnemosyne/inventory/qdrant_inventory.py code path (HttpQdrantClient,
// a real HTTP request) end to end, just never against live Qdrant Cloud.
// `classify_collection` itself is never stubbed -- every scenario below
// shells out to the real, unmodified `mnemosyne.placement_engine.classify_collection`
// (see lib/mnemosyne/onboarding/classify.ts).
//
// Covers (per ro-05's acceptance criteria):
//   AC1  project-scoped collection -> org-tree entry with scope: project and
//        the exact org_tree_path classify_collection would compute
//        (independently verified via a real, separate `python3 -c` call
//        into placement_engine.py itself -- mirrors test/onboard-
//        reachability.mjs's own computeExpectedOrgTreePath).
//   AC2  onboardRepo()'s full effects (Layer-1 sync, persona seed, L4 index,
//        base-level report) are present on disk, identical to calling
//        onboardRepo() directly with mode: 'tree' -- verified by comparing
//        the CLI-onboarded repo's CLAUDE.md managed block + repo-local
//        persona file byte-for-byte against a twin repo onboarded via a
//        DIRECT, in-process onboardRepo() call with the same scopeId/
//        collection (neither's rendered content depends on repoRoot's own
//        absolute path -- see this file's own inline comment at the
//        comparison site for why that equality is expected).
//   AC3  an ambiguous collection name (no scope hint), onboarded WITHOUT
//        --override, completes with needs_override: true recorded in the
//        org-tree entry AND printed clearly to the operator.
//   AC4  the same ambiguous case WITH --override project records
//        scope: project, needs_override: false, and an org_tree_path that
//        reflects the override (not the heuristic's own enterprise
//        default).
//   AC5  a --collection name that does NOT exist in Qdrant (per the real,
//        read-only inventory pre-check against the fake server) fails
//        loudly, directing the operator to --create -- and makes ZERO
//        onboarding writes (no CLAUDE.md, no org-tree entry).
//
// Also covers ro-07-onboard-new-collection-full-mode-a's --create scenarios
// (per ro-07's own acceptance criteria):
//   ro-07 AC1-3  --create against a genuinely new collection name: ro-06's
//        create_collection_and_scope() actually runs (a real PUT
//        /collections/<name> against the fake Qdrant server, a real scope
//        mapping written into config.toml), onboarding proceeds through the
//        full sequence, the base-level report shows level 3 (vector) as
//        configured=true, and onboardRepo()'s real vector-index sub-step
//        (ro-07) issues a real POST /reindex against a fake local
//        Mnemosyne-service stub with {scope: <resolved --scope-id>,
//        directory: <repoRoot>}.
//   ro-07 AC4  --create against a collection that ALREADY exists fails
//        loudly, directing the operator to omit --create -- never a silent
//        no-op, and never issues a PUT /collections/<name>.
//   ro-07 AC5  --create combined with an ambiguous collection name and no
//        --override: the same needs_override: true behavior as AC3 above,
//        unchanged -- --create does not bypass the classification/override
//        contract.
//
// Usage: node test/onboard-cli.mjs (wired into `npm test`).
import { execFile } from "node:child_process";
import http from "node:http";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TSX_BIN = path.join(ROOT, "node_modules", ".bin", "tsx");
const CLI = path.join(ROOT, "bin", "mnemosyne-onboard.mjs");
const DISPATCHER = path.join(ROOT, "bin", "mnemosyne");

// Shared, byte-identical Level 0 fixture content -- used for BOTH the
// in-process "reference" onboardRepo() call's $HOME and every per-scenario
// subprocess $HOME below, so the AC2 byte-for-byte CLAUDE.md comparison
// isn't defeated by two homes carrying deliberately-different Level 0 text.
const LEVEL0_FIXTURE_CONTENT =
  "# Level 0 fixture (ro-05 onboard-cli test)\n\nAlways pull first, never commit to main.\n";

let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "  PASS" : "  FAIL"}  ${m}`);
  if (!c) fails++;
};

function short(text, max = 300) {
  const s = JSON.stringify(text ?? "");
  return s.length > max ? `${s.slice(0, max)}…[truncated, ${s.length} chars total]` : s;
}

const tempDirs = [];
async function makeTempDir(prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** A fresh, throwaway repo root -- never this repo's own working tree. Gives the file layer something real to index. */
async function makeTempRepo(prefix = "mnemosyne-onboard-cli-repo-") {
  const dir = await makeTempDir(prefix);
  await writeFile(path.join(dir, "README.md"), "# hello\n", "utf8");
  return dir;
}

/**
 * A real, local, throwaway HTTP server speaking Qdrant's own `GET
 * /collections` response shape (`{"result": {"collections": [{"name": ...},
 * ...]}}`, per mnemosyne/inventory/qdrant_inventory.py's own
 * HttpQdrantClient.list_collections()) -- the "fake/stubbed inventory
 * check" this story's test-spec step calls for. Never live Qdrant Cloud.
 *
 * ro-07-onboard-new-collection-full-mode-a extension: also answers
 * `PUT /collections/<name>` the exact way `HttpQdrantClient.
 * create_collection()` (ro-06) calls it, so --create's real Python call
 * chain (create_collection_and_scope() -> HttpQdrantClient.
 * create_collection()) can be exercised end-to-end against this fake
 * server too -- `collections` (mutated in place) and `creates` (every real
 * PUT request received, in order) are both exposed for assertions.
 */
async function startFakeQdrantServer(initialCollectionNames) {
  const collections = [...initialCollectionNames];
  const creates = [];
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/collections") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ result: { collections: collections.map((name) => ({ name })) } }));
      return;
    }
    const putMatch = req.method === "PUT" && /^\/collections\/([^/]+)$/.exec(req.url || "");
    if (putMatch) {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        const name = decodeURIComponent(putMatch[1]);
        creates.push({ name, body: raw ? JSON.parse(raw) : null });
        collections.push(name);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ result: true, status: "ok", time: 0 }));
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    collections,
    creates,
    close: () => new Promise((r) => server.close(r)),
  };
}

/**
 * A real, local, throwaway HTTP server speaking `POST /reindex`'s own real
 * `202 {status:'started', scope, directory}` response shape (src/server.mjs,
 * SERVICE.md's "Two reindex paths") -- ro-07's real vector-index sub-step's
 * own target (onboardRepo.ts), mocked here so this suite never makes a live
 * call to a real Mnemosyne service / Qdrant. `requests` records every real
 * POST it receives, in order, for assertions.
 */
async function startFakeMnemosyneServer(status = 202) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      requests.push({ method: req.method, url: req.url, body });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "started", scope: body?.scope, directory: body?.directory }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return { server, url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((r) => server.close(r)) };
}

/**
 * A real, throwaway $HOME, pre-seeded with:
 *   - `.mnemosyne/level0-rules.md` -- required before onboardRepo()'s
 *     Layer-1-sync sub-step will succeed (readLevel0Content hard-fails when
 *     it's missing, layer1/level0.ts).
 *   - `.config/swarm-memory/{qdrant.key,config.toml}` -- pointed at
 *     `qdrantUrl` (the fake server above), the exact HOME-relative paths
 *     mnemosyne/inventory/qdrant_inventory.py's own DEFAULT_KEY_PATH /
 *     DEFAULT_CONFIG_PATH resolve to.
 * Never this operator's real $HOME.
 */
async function makeFakeHome(qdrantUrl) {
  const home = await makeTempDir("mnemosyne-onboard-cli-home-");
  await mkdir(path.join(home, ".mnemosyne"), { recursive: true });
  await writeFile(
    path.join(home, ".mnemosyne", "level0-rules.md"),
    LEVEL0_FIXTURE_CONTENT,
    "utf8",
  );
  await mkdir(path.join(home, ".config", "swarm-memory"), { recursive: true });
  await writeFile(path.join(home, ".config", "swarm-memory", "qdrant.key"), "ro05-fake-qdrant-key\n", "utf8");
  await writeFile(
    path.join(home, ".config", "swarm-memory", "config.toml"),
    `[qdrant]\nurl = "${qdrantUrl}"\n`,
    "utf8",
  );
  return home;
}

/**
 * Runs the REAL `mnemosyne onboard` CLI as a real subprocess, $HOME pinned
 * to `home` (never this operator's real one). `SWARM_MEMORY_QDRANT_URL` is
 * explicitly deleted so an ambient real env var can never shadow the fake
 * server's config.toml URL. `env` merges in additional overrides (ro-07:
 * e.g. a scenario-specific `MNEMOSYNE_URL` pointed at a local fake
 * POST /reindex stub) on top of the process-wide default set in main()
 * below.
 */
async function runCli(args, { home, viaDispatcher = false, cwd = ROOT, env: envOverride = {} } = {}) {
  const cmd = viaDispatcher ? DISPATCHER : TSX_BIN;
  const cmdArgs = viaDispatcher ? ["onboard", ...args] : [CLI, ...args];
  const env = { ...process.env, HOME: home, ...envOverride };
  delete env.SWARM_MEMORY_QDRANT_URL;
  try {
    const { stdout, stderr } = await execFileAsync(cmd, cmdArgs, { cwd, env });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

/** Reads `~/.mnemosyne/org-tree.yaml` back (fresh off disk, never cached) and finds the entry for `repoPath`, or `undefined`. Independent of the CLI's own claims -- a real, separate YAML parse. */
async function readOrgTreeEntry(home, repoPath) {
  const orgTreePath = path.join(home, ".mnemosyne", "org-tree.yaml");
  if (!existsSync(orgTreePath)) return undefined;
  const raw = await readFile(orgTreePath, "utf8");
  const parsed = parseYaml(raw);
  return (parsed?.entries ?? []).find((e) => e.repo_path === repoPath);
}

/**
 * AC1's independent read path -- a REAL, SEPARATE `python3 -c` subprocess
 * call into placement_engine.py's own `classify_collection`, never a JS
 * re-derivation of its heuristic. Mirrors test/onboard-reachability.mjs's
 * own `computeExpectedOrgTreePath` exactly.
 */
async function computeExpectedClassification(name) {
  const script = [
    "import json",
    "from mnemosyne.placement_engine import classify_collection",
    `result = classify_collection(${JSON.stringify(name)})`,
    "print(json.dumps({'org_tree_path': result.org_tree_path, 'scope': result.scope, 'needs_override': result.needs_override}))",
  ].join("\n");
  const { stdout } = await execFileAsync("python3", ["-c", script], { cwd: ROOT });
  return JSON.parse(stdout.trim());
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Extracts the body text following a markdown heading, up to the next heading of a strictly shallower level. Mirrors test/onboard-reachability.mjs's own `extractHeadingBody` exactly. */
function extractHeadingBody(markdown, headingText) {
  const lines = markdown.split("\n");
  const headingRe = new RegExp(`^#{1,6}\\s*${escapeRegExp(headingText)}\\s*$`);
  const idx = lines.findIndex((l) => headingRe.test(l.trim()));
  if (idx === -1) return null;
  const headingLevel = (lines[idx].match(/^#+/) || [""])[0].length;
  let end = lines.length;
  for (let i = idx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+/);
    if (m && m[1].length < headingLevel) {
      end = i;
      break;
    }
  }
  return lines.slice(idx + 1, end).join("\n").trim();
}

async function main() {
  // lib/mnemosyne/layer1/level0.ts's DEFAULT_LEVEL0_PATH (readLevel0Content's
  // default) is computed ONCE, at module-load time, from `homedir()` --
  // reading whatever $HOME happens to be at the moment of this file's FIRST
  // dynamic import of onboardRepo.js and never again. A direct, in-process
  // onboardRepo() call in this test file (the AC2 "reference" call below)
  // would otherwise silently read THIS OPERATOR'S REAL ~/.mnemosyne/level0-
  // rules.md -- never this repo's own fixture content -- since it runs
  // in-process, not as a subprocess with its own injected $HOME the way
  // every `runCli()` call below gets. So $HOME is pinned to a dedicated,
  // throwaway "reference home" BEFORE the dynamic import, mirroring
  // test/onboard-reachability.mjs's own identical ordering requirement (see
  // that file's own header comment on this exact hazard).
  const referenceHome = await makeTempDir("mnemosyne-onboard-cli-reference-home-");
  await mkdir(path.join(referenceHome, ".mnemosyne"), { recursive: true });
  await writeFile(
    path.join(referenceHome, ".mnemosyne", "level0-rules.md"),
    LEVEL0_FIXTURE_CONTENT,
    "utf8",
  );
  process.env.HOME = referenceHome;
  // ro-07-onboard-new-collection-full-mode-a: onboardRepo()'s mode:'tree'
  // vector-index sub-step now makes a real POST /reindex call against
  // $MNEMOSYNE_URL (default http://127.0.0.1:8477 -- a real, live service
  // may well be running there on an operator's own machine). Pinned here,
  // process-wide, to a deliberately unroutable address (TEST-NET-1, RFC
  // 5737, mirrors test/layer1-mandate-hook.mjs's own UNREACHABLE_URL
  // convention) so every onboardRepo() call below -- the in-process
  // "reference" call AND every runCli() subprocess (which inherits
  // process.env) -- stays offline by default. The vector-index sub-step
  // fails soft ({ ran: false, reason }), never throws, so this has no
  // effect on any assertion that doesn't specifically care about it. The
  // one scenario below that DOES care overrides MNEMOSYNE_URL per-call via
  // runCli()'s own `env` option, pointed at a local fake POST /reindex stub
  // instead.
  process.env.MNEMOSYNE_URL = "http://192.0.2.1:1";

  const { onboardRepo } = await import("../lib/mnemosyne/onboarding/onboardRepo.js");
  const { TIER_CONTENT } = await import("../lib/mnemosyne/layer1/tiers.js");
  const { extractManagedBlockBody } = await import("../lib/mnemosyne/layer1/block.js");
  const tierContent = TIER_CONTENT["code-architect"];

  // --- AC1 + AC2: project-scoped collection, full onboardRepo() effects on disk -----------------
  {
    const collection = "project-ro05-atlas";
    const scopeId = "ro05-project-scope";

    const qdrant = await startFakeQdrantServer([collection]);
    const home = await makeFakeHome(qdrant.url);

    // Reference: a DIRECT, in-process onboardRepo() call (running against
    // `referenceHome`'s own level0 fixture, pinned above -- never this
    // operator's real $HOME) over a twin fixture repo with the SAME
    // scopeId/collection -- neither the managed CLAUDE.md block body nor
    // the repo-local persona file's content depends on repoRoot's own
    // absolute path (confirmed by reading layer1/persona.ts's
    // getPersonaContent -- repoRoot is only ever used to LOOK UP an
    // existing persona override, never rendered literally), so these are
    // expected to be byte-for-byte identical to what the CLI produces
    // below (which reads its OWN separate level0 fixture from `home`, with
    // byte-identical fixture content), proving the CLI's onboardRepo() call
    // is genuine, not a divergent reimplementation.
    const referenceRepo = await makeTempRepo();
    const reference = await onboardRepo({ mode: "tree", repoRoot: referenceRepo, scopeId, collection, skipGraph: true });
    ok(reference.personaSeeded.created === true, "sanity: reference direct onboardRepo() call seeded a new persona");

    const repo = await makeTempRepo();
    const result = await runCli([repo, "--collection", collection, "--scope-id", scopeId], { home });
    ok(result.code === 0, `mnemosyne onboard (project-scoped collection) -> exit 0 (got ${result.code}, stderr=${short(result.stderr)})`);

    // AC2: real on-disk artifacts, not mocked.
    for (const fileName of ["CLAUDE.md", "AGENTS.md", "GEMINI.md"]) {
      ok(existsSync(path.join(repo, fileName)), `onboard creates ${fileName} under the target repo (Layer 1 sync)`);
    }
    const personaPath = path.join(repo, ".mnemosyne", "personas", `${scopeId}.yaml`);
    ok(existsSync(personaPath), `onboard seeds a repo-local persona at ${personaPath}`);
    const fileIndexPath = path.join(repo, ".mnemosyne", "file-index.json");
    ok(existsSync(fileIndexPath), `onboard writes the Level 4 file-store index at ${fileIndexPath}`);
    ok(/^base-level report:/m.test(result.stdout), `onboard's output includes a base-level report -> ${short(result.stdout)}`);
    for (const id of [0, 1, 2, 3, 4]) {
      ok(new RegExp(`\\[${id}\\]`).test(result.stdout), `onboard's base-level report names level ${id} -> ${short(result.stdout)}`);
    }

    // AC2, continued: byte-for-byte identical to the direct onboardRepo() reference.
    const cliPersona = await readFile(personaPath, "utf8");
    const referencePersona = await readFile(path.join(referenceRepo, ".mnemosyne", "personas", `${scopeId}.yaml`), "utf8");
    ok(cliPersona === referencePersona, "onboard's seeded persona file is byte-for-byte identical to a direct onboardRepo() call's own seeded persona");

    const cliClaude = await readFile(path.join(repo, "CLAUDE.md"), "utf8");
    const referenceClaude = await readFile(path.join(referenceRepo, "CLAUDE.md"), "utf8");
    const cliBody = extractManagedBlockBody(cliClaude);
    const referenceBody = extractManagedBlockBody(referenceClaude);
    ok(cliBody !== null && referenceBody !== null, "sanity: both CLAUDE.md files have a parseable managed block");
    ok(cliBody === referenceBody, "onboard's CLAUDE.md managed block is byte-for-byte identical to a direct onboardRepo() call's own managed block");
    ok(
      extractHeadingBody(cliBody ?? "", tierContent.displayName) !== null,
      `onboard's managed block has a '${tierContent.displayName}' heading (code-architect persona seed reachable)`,
    );
    ok(
      (extractHeadingBody(cliBody ?? "", "Memory-lifecycle mandate") ?? "").length > 0,
      "onboard's managed block has a non-empty 'Memory-lifecycle mandate' section",
    );

    // AC1: org-tree entry, exact scope + org_tree_path.
    const expected = await computeExpectedClassification(collection);
    ok(expected.scope === "project" && expected.needs_override === false, `sanity: '${collection}' classifies as project-scoped, no override needed`);
    const entry = await readOrgTreeEntry(home, path.resolve(repo));
    ok(entry !== undefined, "org-tree.yaml gains an entry for the onboarded repo");
    ok(entry?.scope === "project", `org-tree entry records scope: project -> got ${short(entry?.scope)}`);
    ok(entry?.collection === collection, `org-tree entry records the exact collection name -> got ${short(entry?.collection)}`);
    ok(
      entry?.org_tree_path === expected.org_tree_path,
      `org-tree entry's org_tree_path exactly matches classify_collection's own independent computation -> got ${short(entry?.org_tree_path)}, expected ${short(expected.org_tree_path)}`,
    );
    ok(entry?.needs_override === false, "org-tree entry records needs_override: false for an unambiguous project-scoped name");

    await rm(referenceRepo, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
    await qdrant.close();
  }

  // --- AC3: ambiguous collection, WITHOUT --override -> completes, needs_override: true, printed clearly ---
  {
    const collection = "ro05-ambiguous-collection";
    const scopeId = "ro05-ambiguous-scope";

    const expected = await computeExpectedClassification(collection);
    ok(expected.needs_override === true, `sanity: '${collection}' has no scope hint, classifies as needs_override: true`);

    const qdrant = await startFakeQdrantServer([collection]);
    const home = await makeFakeHome(qdrant.url);
    const repo = await makeTempRepo();

    const result = await runCli([repo, "--collection", collection, "--scope-id", scopeId], { home });
    ok(result.code === 0, `onboard (ambiguous, no --override) -> exit 0, still COMPLETES (got ${result.code}, stderr=${short(result.stderr)})`);
    ok(/needs_override:\s*true/i.test(result.stdout), `onboard prints needs_override: true clearly to the operator -> ${short(result.stdout)}`);

    const entry = await readOrgTreeEntry(home, path.resolve(repo));
    ok(entry !== undefined, "org-tree.yaml gains an entry even for the ambiguous, non-overridden case");
    ok(entry?.needs_override === true, `org-tree entry records needs_override: true (never silently defaulted without a visible flag) -> got ${short(entry?.needs_override)}`);
    ok(entry?.scope === expected.scope, `org-tree entry's scope matches the heuristic's own (unoverridden) default -> got ${short(entry?.scope)}, expected ${short(expected.scope)}`);
    ok(entry?.org_tree_path === expected.org_tree_path, `org-tree entry's org_tree_path matches the heuristic's own default -> got ${short(entry?.org_tree_path)}, expected ${short(expected.org_tree_path)}`);

    await rm(repo, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
    await qdrant.close();
  }

  // --- AC4: the same ambiguous collection, WITH --override project -> scope/needs_override/org_tree_path reflect the override ---
  {
    const collection = "ro05-ambiguous-collection-override";
    const scopeId = "ro05-override-scope";

    const expected = await computeExpectedClassification(collection);
    ok(expected.needs_override === true, `sanity: '${collection}' has no scope hint, classifies as needs_override: true`);
    ok(expected.scope === "enterprise", "sanity: the heuristic's own unoverridden default for this name is enterprise-scoped");

    const qdrant = await startFakeQdrantServer([collection]);
    const home = await makeFakeHome(qdrant.url);
    const repo = await makeTempRepo();

    const result = await runCli(
      [repo, "--collection", collection, "--scope-id", scopeId, "--override", "project"],
      { home },
    );
    ok(result.code === 0, `onboard --override project -> exit 0 (got ${result.code}, stderr=${short(result.stderr)})`);
    ok(/--override project/.test(result.stdout), `onboard's output names the applied --override explicitly -> ${short(result.stdout)}`);

    const entry = await readOrgTreeEntry(home, path.resolve(repo));
    ok(entry !== undefined, "org-tree.yaml gains an entry for the overridden repo");
    ok(entry?.scope === "project", `org-tree entry records scope: project (the operator's override, not the heuristic default 'enterprise') -> got ${short(entry?.scope)}`);
    ok(entry?.needs_override === false, `org-tree entry records needs_override: false once explicitly overridden -> got ${short(entry?.needs_override)}`);
    ok(
      entry?.org_tree_path !== expected.org_tree_path,
      `org-tree entry's org_tree_path differs from the heuristic's own (unoverridden) default -> got ${short(entry?.org_tree_path)}, heuristic default was ${short(expected.org_tree_path)}`,
    );
    ok(
      entry?.org_tree_path?.startsWith("org/project/"),
      `org-tree entry's org_tree_path reflects the operator's explicit override scope -> got ${short(entry?.org_tree_path)}`,
    );

    await rm(repo, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
    await qdrant.close();
  }

  // --- AC5: --collection names a collection that does NOT exist in Qdrant -> fails loudly, directs to --create, zero writes ---
  {
    const collection = "ro05-does-not-exist-collection";
    const scopeId = "ro05-missing-scope";

    // The fake server reports a DIFFERENT collection only -- `collection` genuinely does not exist.
    const qdrant = await startFakeQdrantServer(["some-other-collection"]);
    const home = await makeFakeHome(qdrant.url);
    const repo = await makeTempRepo();

    const result = await runCli([repo, "--collection", collection, "--scope-id", scopeId], { home });
    ok(result.code !== 0, `onboard against a nonexistent collection -> non-zero exit (got ${result.code})`);
    ok(
      /does not exist in Qdrant/i.test(result.stderr),
      `onboard fails with a clear "does not exist in Qdrant" message -> ${short(result.stderr)}`,
    );
    ok(
      /--create/i.test(result.stderr),
      `onboard's failure message directs the operator to --create instead of silently proceeding -> ${short(result.stderr)}`,
    );

    // Zero onboarding writes -- never silently proceeded against a nonexistent collection.
    ok(!existsSync(path.join(repo, "CLAUDE.md")), "onboard against a nonexistent collection writes no CLAUDE.md (onboardRepo() never ran)");
    ok(!existsSync(path.join(repo, ".mnemosyne")), "onboard against a nonexistent collection writes no .mnemosyne/ under the target repo");
    const entry = await readOrgTreeEntry(home, path.resolve(repo));
    ok(entry === undefined, "onboard against a nonexistent collection writes no org-tree entry");

    await rm(repo, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
    await qdrant.close();
  }

  // === ro-07-onboard-new-collection-full-mode-a: --create scenarios =================================

  // --- ro-07 AC1-3: --create against a genuinely NEW collection name -> ro-06's create_collection_and_scope()
  //     actually runs, full sequence proceeds, level 3 (vector) configured=true, real POST /reindex issued ---
  {
    const collection = "project-ro07-newcollection";
    const scopeId = "ro07-create-scope";

    // The fake Qdrant server does NOT know this collection yet -- genuinely new.
    const qdrant = await startFakeQdrantServer([]);
    const home = await makeFakeHome(qdrant.url);
    const repo = await makeTempRepo();
    const mnemo = await startFakeMnemosyneServer(202);

    const result = await runCli([repo, "--collection", collection, "--scope-id", scopeId, "--create"], {
      home,
      env: { MNEMOSYNE_URL: mnemo.url },
    });
    ok(
      result.code === 0,
      `onboard --create (genuinely new collection) -> exit 0 (got ${result.code}, stderr=${short(result.stderr)})`,
    );
    ok(
      /creating collection/i.test(result.stdout),
      `onboard --create prints that it is creating the collection -> ${short(result.stdout)}`,
    );

    // ro-06's create_collection_and_scope() genuinely ran: a real PUT /collections/<name>.
    ok(
      qdrant.creates.length === 1,
      `--create issues exactly one PUT /collections/<name> -> got ${qdrant.creates.length}`,
    );
    ok(
      qdrant.creates[0]?.name === collection,
      `--create's PUT targets the exact requested collection name -> got ${short(qdrant.creates[0]?.name)}`,
    );

    // The real scope->collection mapping landed in config.toml (the same
    // file/table VectorLayerAdapter.remember() and POST /reindex's own
    // scope lookup (engine.mjs's scopeMap()) both read).
    const configText = await readFile(path.join(home, ".config", "swarm-memory", "config.toml"), "utf8");
    ok(
      configText.includes(`${scopeId} = "${collection}"`),
      `--create writes the scope->collection mapping into config.toml -> ${short(configText)}`,
    );

    // AC1: the full onboarding sequence still ran -- real on-disk artifacts.
    ok(existsSync(path.join(repo, "CLAUDE.md")), "onboard --create still runs Layer 1 sync (CLAUDE.md present)");
    ok(
      existsSync(path.join(repo, ".mnemosyne", "personas", `${scopeId}.yaml`)),
      "onboard --create still seeds a repo-local persona",
    );
    ok(
      existsSync(path.join(repo, ".mnemosyne", "file-index.json")),
      "onboard --create still writes the L4 file-store index",
    );

    // AC2: base-level report shows level 3 (vector) as configured=true --
    // previously structurally impossible for a genuinely new repo (no
    // collection existed to even reach onboardRepo() through the CLI).
    ok(
      /\[3\][^\n]*: configured/i.test(result.stdout),
      `onboard --create's base-level report shows level 3 (vector) as configured -> ${short(result.stdout)}`,
    );

    const entry = await readOrgTreeEntry(home, path.resolve(repo));
    ok(entry !== undefined, "onboard --create writes a real org-tree entry");
    ok(entry?.collection === collection, "org-tree entry records the newly-created collection name");

    // The real vector-index sub-step (onboardRepo.ts, ro-07) actually called
    // POST /reindex against the (fake, stubbed) running Mnemosyne service.
    ok(
      mnemo.requests.length === 1,
      `onboard --create's vector-index sub-step calls POST /reindex exactly once -> got ${mnemo.requests.length}`,
    );
    ok(
      mnemo.requests[0]?.method === "POST" && mnemo.requests[0]?.url === "/reindex",
      `the real POST /reindex call was made -> got ${short(mnemo.requests[0])}`,
    );
    ok(
      mnemo.requests[0]?.body?.scope === scopeId,
      `POST /reindex's scope is the resolved --scope-id (own-scope isolation) -> got ${short(mnemo.requests[0]?.body?.scope)}`,
    );
    ok(
      mnemo.requests[0]?.body?.directory === path.resolve(repo),
      `POST /reindex's directory is the onboarded repoRoot -> got ${short(mnemo.requests[0]?.body?.directory)}`,
    );

    await rm(repo, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
    await qdrant.close();
    await mnemo.close();
  }

  // --- ro-07 AC4: --create against a collection that ALREADY exists -> loud failure, never a silent no-op ---
  {
    const collection = "ro07-already-exists-collection";
    const scopeId = "ro07-already-exists-scope";

    const qdrant = await startFakeQdrantServer([collection]); // already exists
    const home = await makeFakeHome(qdrant.url);
    const repo = await makeTempRepo();

    const result = await runCli([repo, "--collection", collection, "--scope-id", scopeId, "--create"], { home });
    ok(
      result.code !== 0,
      `onboard --create against an already-existing collection -> non-zero exit (got ${result.code})`,
    );
    ok(
      /already exists in Qdrant/i.test(result.stderr),
      `onboard --create against an existing collection fails with a clear "already exists" message -> ${short(result.stderr)}`,
    );
    ok(
      /omit --create/i.test(result.stderr),
      `onboard --create's failure message directs the operator to omit --create -> ${short(result.stderr)}`,
    );
    ok(
      qdrant.creates.length === 0,
      "onboard --create against an existing collection never issues a PUT /collections/<name> (never a silent no-op, never a destructive recreate)",
    );

    // Zero onboarding writes -- never silently proceeded.
    ok(
      !existsSync(path.join(repo, "CLAUDE.md")),
      "onboard --create against an existing collection writes no CLAUDE.md (onboardRepo() never ran)",
    );
    const entry = await readOrgTreeEntry(home, path.resolve(repo));
    ok(entry === undefined, "onboard --create against an existing collection writes no org-tree entry");

    await rm(repo, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
    await qdrant.close();
  }

  // --- ro-07 AC5: --create + ambiguous collection name + no --override -> needs_override:true, unchanged from ro-05 ---
  {
    const collection = "ro07-ambiguous-create-collection";
    const scopeId = "ro07-ambiguous-create-scope";

    const expected = await computeExpectedClassification(collection);
    ok(expected.needs_override === true, `sanity: '${collection}' has no scope hint, classifies as needs_override: true`);

    const qdrant = await startFakeQdrantServer([]); // does not exist yet
    const home = await makeFakeHome(qdrant.url);
    const repo = await makeTempRepo();

    const result = await runCli([repo, "--collection", collection, "--scope-id", scopeId, "--create"], { home });
    ok(
      result.code === 0,
      `onboard --create (ambiguous, no --override) -> exit 0, still COMPLETES (got ${result.code}, stderr=${short(result.stderr)})`,
    );
    ok(
      /needs_override:\s*true/i.test(result.stdout),
      `onboard --create prints needs_override: true clearly -> ${short(result.stdout)}`,
    );

    const entry = await readOrgTreeEntry(home, path.resolve(repo));
    ok(entry !== undefined, "org-tree.yaml gains an entry for the ambiguous --create case too");
    ok(
      entry?.needs_override === true,
      `org-tree entry records needs_override: true -- --create does not bypass the classification/override contract -> got ${short(entry?.needs_override)}`,
    );
    ok(
      entry?.scope === expected.scope,
      `org-tree entry's scope matches the heuristic's own (unoverridden) default -> got ${short(entry?.scope)}, expected ${short(expected.scope)}`,
    );

    await rm(repo, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
    await qdrant.close();
  }

  // --- Required-flag / validation loud failures --------------------------------------------------
  {
    const home = await makeFakeHome("http://127.0.0.1:1"); // unused -- these all fail before any Qdrant read
    const repo = await makeTempRepo();

    const noPath = await runCli([], { home });
    ok(noPath.code !== 0, "onboard with no <path> -> non-zero exit");
    ok(/usage: mnemosyne onboard/i.test(noPath.stderr), `onboard with no <path> -> clear usage message -> ${short(noPath.stderr)}`);

    const noCollection = await runCli([repo], { home });
    ok(noCollection.code !== 0, "onboard with no --collection -> non-zero exit");
    ok(/--collection is required/i.test(noCollection.stderr), `onboard with no --collection -> clear message, no auto-derivation -> ${short(noCollection.stderr)}`);

    const badOverride = await runCli([repo, "--collection", "whatever", "--override", "bogus"], { home });
    ok(badOverride.code !== 0, "onboard --override bogus -> non-zero exit");
    ok(/invalid --override/i.test(badOverride.stderr), `onboard --override bogus -> clear message -> ${short(badOverride.stderr)}`);

    await rm(repo, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }

  // --- Dispatcher wiring: `bin/mnemosyne onboard ...` reaches the same code ------------------------
  {
    const collection = "project-ro05-dispatcher";
    const scopeId = "ro05-dispatcher-scope";

    const qdrant = await startFakeQdrantServer([collection]);
    const home = await makeFakeHome(qdrant.url);
    const repo = await makeTempRepo();

    const result = await runCli([repo, "--collection", collection, "--scope-id", scopeId], { home, viaDispatcher: true });
    ok(result.code === 0, `bin/mnemosyne onboard <path> --collection <name> -> exit 0 (got ${result.code}, stderr=${short(result.stderr)})`);
    ok(existsSync(path.join(repo, "CLAUDE.md")), "bin/mnemosyne onboard (via dispatcher) actually onboarded the repo (real CLAUDE.md write)");
    const entry = await readOrgTreeEntry(home, path.resolve(repo));
    ok(entry !== undefined, "bin/mnemosyne onboard (via dispatcher) wrote a real org-tree entry");

    await rm(repo, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
    await qdrant.close();
  }
}

try {
  await main();
} finally {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
}

console.log(fails ? `\n${fails} check(s) failed` : "\nall onboard-cli checks passed");
process.exit(fails ? 1 : 0);
