// persona-files-slice1-e2e.mjs — pf-03-slice1-regression.
//
// Closes vertical-plan.md Slice 1 with a real, continuous end-to-end proof,
// mirroring pu-13's own precedent (test/persona-full-loop-e2e.mjs): the
// explicit-file draft-propose path this file proves is a genuinely SEPARATE
// entry point from pu-13's own interview-driven, bounded-crawl path --
// pf-01's crawlExplicitFiles() (skills/mnemosyne-persona-interview/
// crawl-context.mjs) and pf-02's `mnemosyne persona draft propose-from-files`
// CLI subcommand (bin/mnemosyne-persona.mjs) -- but reuses pu-13's exact
// real-subprocess, real-HTTP, "no mocked transport boundary anywhere"
// convention end to end.
//
// STEP 1 -- a real `mnemosyne persona draft propose-from-files` OS subprocess
// (via node_modules/.bin/tsx, the same tsx-boundary constraint
// bin/mnemosyne-persona.mjs's own doc comment describes) is run against 3
// real, small fixture text files written to a real temp dir on disk. The
// subprocess builds the persona record via interview-engine.mjs's own
// minimal-shape `runPersonaInterview({tier, scopeId})` (pf-02's own
// documented behavior) and crawls all 3 fixture files for real via
// crawlExplicitFiles() -- never a hand-typed sourceSummary string.
//
// STEP 2 -- a real HTTP GET against a SEPARATELY spawned lib/mnemosyne/
// server.ts subprocess (pu-03's draft routes), $HOME-aligned with the CLI
// subprocess above so both see the SAME draft store, confirms the
// CLI-originated draft is genuinely visible, including a sourceSummary that
// contains the real fixture files' own content (not a placeholder).
//
// STEP 3 -- a real HTTP POST to pu-03's approve route commits the draft via
// the real write primitive (writeGlobalPersona) and archives the draft.
//
// STEP 4 -- verified via TWO independent real reads, matching pu-13's own
// "never trust the HTTP response alone" posture: a direct filesystem read of
// the real global persona store file (hand-derived location, never imported
// -- mirrors pu-13's own globalPersonaPath() helper and
// persona-store-global.ts's own fixed-location convention), and a real HTTP
// GET /persona (the real store's own list route).
//
// $HOME is a real, throwaway temp directory the CLI-propose subprocess and
// the API server subprocess both share -- never touches the operator's real
// ~/.mnemosyne (mirrors pu-13's/test/persona-cli.mjs's own fake-$HOME
// convention). This file has NO swarm-memory-backed service dependency
// (unlike pu-13): PORT points at a real, but definitely-unlistened-on, local
// port, so the approve route's own optional remember()-firing attempt
// (server.ts's fireDraftApprovalRemember) fails fast and non-fatally --
// exactly like a draft approved with no swarm-memory service reachable would
// in production -- without this story's own acceptance criteria (which only
// covers propose -> visible-with-sourceSummary -> approve -> real committed
// content) needing a second real subprocess double to prove.
//
// Uses PORT_API 8535 -- distinct from every other test file's own real-server
// port (see test/persona-full-loop-e2e.mjs's own port-registry comment for
// the fullest list: 8477/8479/8483/8487/8491/8497/8499/8500/8501/8502/8503/
// 8504/8505/8506/8507/8510/8511/8520/8521/8541/8542/8543/8547; nothing else
// in this repo currently uses 8535) -- and a definitely-unreachable local
// port (8536) as the approve route's own remember()-target PORT, so its
// connection attempt fails fast (ECONNREFUSED) rather than hanging.
//
// This file is plain ESM run via `node` (never `tsx`): like
// test/persona-full-loop-e2e.mjs, it makes zero direct in-process imports of
// any .ts module -- the real persona store's on-disk location is
// hand-derived (mirrors persona-store-global.ts's own globalPersonaPath()
// convention, read directly off disk, never imported) or reached via a real
// HTTP call.
//
// Usage: node test/persona-files-slice1-e2e.mjs
import { spawn, execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");
const SERVER = path.join(ROOT, "lib", "mnemosyne", "server.ts");
const PERSONA_CLI = path.join(ROOT, "bin", "mnemosyne-persona.mjs");

const API_PORT = 8535;
const API_BASE = `http://127.0.0.1:${API_PORT}`;
// A real port, deliberately unlistened-on -- makes the approve route's own
// optional remember() attempt fail fast (ECONNREFUSED) rather than hang.
const UNREACHABLE_REMEMBER_PORT = 8536;

const TIER = "company-director";
const SCOPE_ID = "pf03-slice1-scope";

const MARKER_NOTES = "PF03_NOTES_MARKER";
const MARKER_DESIGN = "PF03_DESIGN_MARKER";
const MARKER_EXTRA = "PF03_EXTRA_MARKER";

let fails = 0;
const ok = (condition, message) => {
  console.log(`${condition ? "  PASS" : "  FAIL"}  ${message}`);
  if (!condition) fails++;
};

async function waitForApiHealth(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${API_BASE}/health`);
      if (res.status === 200 || res.status === 503) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** `<home>/.mnemosyne/personas/<tier>/<scopeId>.yaml` -- mirrors persona-store-global.ts's globalPersonaPath() exactly (hand-derived, never imported -- see this file's header). */
function globalPersonaPath(homeDir, tier, scopeId) {
  return path.join(homeDir, ".mnemosyne", "personas", tier, `${scopeId}.yaml`);
}

/** Runs `mnemosyne persona <args...>` as a real tsx subprocess (bin/mnemosyne-persona.mjs cannot be run via plain `node` -- see that file's own doc comment). */
async function runCli(args, { home }) {
  const env = { ...process.env, HOME: home };
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [TSX, PERSONA_CLI, ...args], {
      cwd: ROOT,
      env,
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

async function main() {
  const fakeHome = await mkdtemp(path.join(tmpdir(), "mnemosyne-pf03-home-"));
  const apiRoot = await mkdtemp(path.join(tmpdir(), "mnemosyne-pf03-api-root-"));
  const fixturesDir = await mkdtemp(path.join(tmpdir(), "mnemosyne-pf03-fixtures-"));

  // 3 real, small fixture text files on real disk -- crawlExplicitFiles()
  // reads them for real; the draft's sourceSummary is never hand-typed.
  const notesPath = path.join(fixturesDir, "notes.md");
  const designPath = path.join(fixturesDir, "design.md");
  const extraPath = path.join(fixturesDir, "additional-context.md");
  await writeFile(
    notesPath,
    `# Notes\n\n${MARKER_NOTES} — real fixture notes content for pf-03's own explicit-file e2e proof.\n`,
    "utf8",
  );
  await writeFile(
    designPath,
    `# Design\n\n${MARKER_DESIGN} — real fixture design content for pf-03's own explicit-file e2e proof.\n`,
    "utf8",
  );
  await writeFile(
    extraPath,
    `# Additional Context\n\n${MARKER_EXTRA} — real fixture additional-context content for pf-03's own explicit-file e2e proof.\n`,
    "utf8",
  );

  const apiChild = spawn(TSX, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      MNEMOSYNE_PORT: String(API_PORT),
      MNEMOSYNE_ROOT_DIR: apiRoot,
      HOME: fakeHome, // shared with the CLI propose subprocess below -- same draft/persona store
      PORT: String(UNREACHABLE_REMEMBER_PORT), // fireDraftApprovalRemember's own REMEMBER_SERVICE_PORT target -- nothing listens here
      SWARM_MEMORY_BIN: "/definitely/missing/swarm-memory",
      SWARM_MEMORY_GRAPH_DB: path.join(apiRoot, "missing-graph.sqlite"),
      GRAPHIFY_BIN: "/definitely/missing/graphify-binary-xyz",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let apiOutput = "";
  apiChild.stdout.on("data", (c) => (apiOutput += c));
  apiChild.stderr.on("data", (c) => (apiOutput += c));

  try {
    const apiUp = await waitForApiHealth();
    ok(apiUp, "real lib/mnemosyne/server.ts subprocess (pu-03's draft routes) started and is reachable");
    if (!apiUp) {
      console.error(apiOutput);
      throw new Error("lib/mnemosyne/server.ts API service never became reachable");
    }

    // =========================================================================
    // STEP 1 -- a real `mnemosyne persona draft propose-from-files` CLI
    // subprocess, run against the 3 real fixture files above, HOME-pointed at
    // the same fakeHome the API server above already uses.
    // =========================================================================
    const propose = await runCli(
      [
        "draft",
        "propose-from-files",
        "--tier",
        TIER,
        "--scope-id",
        SCOPE_ID,
        "--file",
        notesPath,
        "--file",
        designPath,
        "--file",
        extraPath,
      ],
      { home: fakeHome },
    );
    ok(
      propose.code === 0,
      `real \`mnemosyne persona draft propose-from-files\` CLI subprocess against 3 real fixture files -> exit 0 (got ${propose.code}, stderr=${propose.stderr})`,
    );
    ok(/proposed/.test(propose.stdout), `CLI subprocess reports the proposed draft -> ${JSON.stringify(propose.stdout)}`);
    ok(
      /notes\.md/.test(propose.stdout) && /design\.md/.test(propose.stdout) && /additional-context\.md/.test(propose.stdout),
      `CLI subprocess reports all 3 real crawled fixture sources -> ${JSON.stringify(propose.stdout)}`,
    );

    // =========================================================================
    // STEP 2 -- real HTTP GET against pu-03's draft routes confirms the
    // CLI-originated draft is genuinely visible, including a sourceSummary
    // that contains the real fixture files' own content.
    // =========================================================================
    const list = await fetch(`${API_BASE}/persona/draft`);
    const listBody = await list.json();
    ok(list.status === 200, `GET /persona/draft (list) -> 200 (got ${list.status})`);
    ok(
      listBody.drafts?.some((d) => d.tier === TIER && d.scopeId === SCOPE_ID),
      `GET /persona/draft (list) shows the CLI-originated draft's {tier, scopeId} as active (got ${JSON.stringify(listBody.drafts)})`,
    );

    const get = await fetch(`${API_BASE}/persona/draft/${TIER}/${SCOPE_ID}`);
    const getBody = await get.json();
    ok(get.status === 200, `GET /persona/draft/:tier/:scopeId -> 200 (got ${get.status})`);
    ok(
      typeof getBody.draft?.sourceSummary === "string" && getBody.draft.sourceSummary.includes(MARKER_NOTES),
      `GET /persona/draft/:tier/:scopeId returns a sourceSummary containing the real notes.md fixture content (got ${JSON.stringify(getBody.draft?.sourceSummary)})`,
    );
    ok(
      getBody.draft?.sourceSummary?.includes(MARKER_DESIGN),
      "GET /persona/draft/:tier/:scopeId's sourceSummary also contains the real design.md fixture content",
    );
    ok(
      getBody.draft?.sourceSummary?.includes(MARKER_EXTRA),
      "GET /persona/draft/:tier/:scopeId's sourceSummary also contains the real additional-context.md fixture content",
    );
    ok(getBody.draft?.tier === TIER && getBody.draft?.scopeId === SCOPE_ID, "GET /persona/draft/:tier/:scopeId echoes the correct identity");

    // =========================================================================
    // STEP 3 -- a real HTTP POST to pu-03's approve route commits the draft
    // via the real write primitive (writeGlobalPersona), archiving the draft.
    // =========================================================================
    const approve = await fetch(`${API_BASE}/persona/draft/${TIER}/${SCOPE_ID}/approve`, { method: "POST" });
    const approveBody = await approve.json();
    ok(approve.status === 200, `real HTTP POST to pu-03's approve route -> 200 (got ${approve.status})`);
    ok(approveBody.approved === true, "approve response reports approved:true");
    ok(approveBody.store === "global", `approve response reports the correct store (got ${approveBody.store})`);

    // =========================================================================
    // STEP 4 -- verified via TWO independent real reads, never trusting the
    // HTTP response alone: a direct filesystem read of the real persona
    // store, and a real HTTP GET /persona (the store's own list route).
    // =========================================================================
    const personaPath = globalPersonaPath(fakeHome, TIER, SCOPE_ID);
    const personaRaw = await readFile(personaPath, "utf8");
    const personaParsed = parseYaml(personaRaw);
    ok(
      personaParsed.tier === TIER && personaParsed.scopeId === SCOPE_ID,
      `the real persona store file (read directly off disk) has the correct tier/scopeId (got ${JSON.stringify({ tier: personaParsed.tier, scopeId: personaParsed.scopeId })})`,
    );
    ok(
      typeof personaParsed.displayName === "string" && personaParsed.displayName.length > 0,
      `the real persona store file has a real, non-empty displayName (got ${JSON.stringify(personaParsed.displayName)})`,
    );
    ok(
      personaParsed.sourceSummary === undefined && personaParsed.proposedBy === undefined && personaParsed.proposedAt === undefined,
      "the committed real persona file has draft-only metadata (sourceSummary/proposedBy/proposedAt) stripped -- never leaks into the real store",
    );

    const personaList = await fetch(`${API_BASE}/persona`);
    const personaListBody = await personaList.json();
    ok(personaList.status === 200, `GET /persona (real store list) -> 200 (got ${personaList.status})`);
    ok(
      personaListBody.personas?.some((p) => p.tier === TIER && p.scopeId === SCOPE_ID),
      `GET /persona (real store list) includes the newly-committed persona (got ${JSON.stringify(personaListBody.personas)})`,
    );

    // Final check -- the approved draft no longer appears in the active list
    // (archived, per pu-02's disposal design), matching pu-13's own STEP 6.
    const listAfterApprove = await fetch(`${API_BASE}/persona/draft`);
    const listAfterApproveBody = await listAfterApprove.json();
    ok(
      !listAfterApproveBody.drafts?.some((d) => d.tier === TIER && d.scopeId === SCOPE_ID),
      `GET /persona/draft (list) no longer shows the approved draft as active -- archived, not deleted (got ${JSON.stringify(listAfterApproveBody.drafts)})`,
    );
  } finally {
    apiChild.kill();
    await rm(fakeHome, { recursive: true, force: true });
    await rm(apiRoot, { recursive: true, force: true });
    await rm(fixturesDir, { recursive: true, force: true });
  }

  console.log(`\n${fails === 0 ? "all persona-files-slice1-e2e checks passed" : `${fails} FAILURE(S)`}`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
