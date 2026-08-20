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
//        loudly, directing the operator to --create (ro-07) -- and makes
//        ZERO onboarding writes (no CLAUDE.md, no org-tree entry).
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
 */
async function startFakeQdrantServer(collectionNames) {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/collections") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ result: { collections: collectionNames.map((name) => ({ name })) } }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return { server, url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
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

/** Runs the REAL `mnemosyne onboard` CLI as a real subprocess, $HOME pinned to `home` (never this operator's real one). `SWARM_MEMORY_QDRANT_URL` is explicitly deleted so an ambient real env var can never shadow the fake server's config.toml URL. */
async function runCli(args, { home, viaDispatcher = false, cwd = ROOT } = {}) {
  const cmd = viaDispatcher ? DISPATCHER : TSX_BIN;
  const cmdArgs = viaDispatcher ? ["onboard", ...args] : [CLI, ...args];
  const env = { ...process.env, HOME: home };
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
      /--create/i.test(result.stderr) && /ro-07/i.test(result.stderr),
      `onboard's failure message directs the operator to --create (ro-07) instead of silently proceeding -> ${short(result.stderr)}`,
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
