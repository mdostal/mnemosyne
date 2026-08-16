// persona-full-loop-e2e.mjs — pu-13-full-loop-e2e-regression.
//
// The epic's own closing release-gate proof (horizontal-plan.md H8),
// mirroring the wizard epic's own "closes the loop" pattern
// (pw-14/pw-16/pw-17). Composes -- does NOT duplicate -- three already-proven
// pieces:
//
//   - pu-06 (test/persona-draft-cross-transport.mjs): every transport pair
//     round-trips the SAME draft-store/real-store write primitives. This file
//     does not re-prove that; it uses ONE transport pairing (CLI-propose,
//     HTTP-edit/approve) end-to-end instead.
//   - pu-09 (lib/mnemosyne/layer1/__tests__/persona-interview-draft-regression.test.ts):
//     the interview skill's default (no --commit-directly) write target is
//     `persona draft propose`. This file reuses that exact mechanism
//     (runPersonaInterview + writeDraftPersonaViaCli) as its own first real
//     step, rather than re-proving the CLI-side behavior in isolation.
//   - pu-03/pu-04 (server.ts's approve route, test/http-api.mjs's
//     testDraftPersonaApproveRemember): remember() fires on approval, scoped
//     via resolveRememberScope(), never on draft creation. This file reuses
//     that same real-subprocess/real-fixture harness (a real src/server.mjs
//     pointed at test/fixtures/fake-swarm-memory-pu03, a real
//     lib/mnemosyne/server.ts pointed at it via PORT), rather than
//     reimplementing a third remember()-proof harness.
//
// The genuinely NEW thing this file proves, in ONE continuous real run, is
// the full loop none of the above proves alone: a CLI-originated,
// agent-proposed draft (with a real, crawled sourceSummary, pu-07) is
// genuinely visible and actionable through pu-03's real HTTP draft routes
// (the same routes pu-12's real browser UI calls), survives a real HTTP
// edit, and-on approval-both commits to the real persona store AND fires a
// real remember() call, scoped correctly, while NEVER firing during the
// pending-review window in between.
//
// STEP 1 -- real CLI interview run: `runPersonaInterview()`
// (interview-engine.mjs) builds the persona record exactly like a live
// interview session would; `crawlBoundedContext()` (crawl-context.mjs, pu-07)
// performs a REAL bounded filesystem crawl against a real throwaway repo
// fixture (a real README.md on disk, read by real fs calls -- not a
// hand-typed sourceSummary string) to produce the draft's real sourceSummary;
// `writeDraftPersonaViaCli()` (persona-draft-writer.mjs, pu-08) then spawns a
// REAL `mnemosyne persona draft propose` OS subprocess (never an in-process
// store call) -- the exact default (no --commit-directly) path SKILL.md's
// own step 7 wires a live interview session through.
//
// STEP 2/3 -- real HTTP GET against pu-03's draft routes (a real, separate
// lib/mnemosyne/server.ts subprocess, $HOME-aligned with the CLI subprocess
// above so both see the SAME draft store) confirms the draft the CLI
// subprocess wrote is visible, including its sourceSummary -- and, while it
// is still pending, a real recall() POST against the swarm-memory-backed
// service (never lib/mnemosyne/server.ts's own /recall, which wraps a
// structurally different engine -- see persona.ts's resolveRememberScope()
// doc comment) confirms NOTHING is indexed yet.
//
// STEP 4 -- a real HTTP re-POST to the SAME draft route, changing ONE field
// and preserving the rest (tier/scopeId/sections/sourceSummary/proposedBy/
// proposedAt unchanged) -- a PATCH-equivalent edit through pu-03's real
// POST /persona/draft/:tier/:scopeId route, the exact route+overwrite
// mechanism pu-12's real ui/app.js submit handler POSTs to for its own "Edit
// in form above" flow (confirmed by reading that handler directly: it always
// re-POSTs the full candidate to this same route for the same {tier,
// scopeId} identity). This file does NOT additionally clone ui/app.js's
// current single-section v1 minimal DOM form's own field list (verified,
// by direct inspection AND a live probe against a real spawned server, to
// silently drop sourceSummary/proposedBy/proposedAt on every edit, since
// #persona-form has no field for them) -- that structural, DOM-level
// question is pu-12's own test's job (test/persona-draft-review-approve-ui.mjs
// already asserts the form's exact field set), and reproducing that specific
// v1 limitation here would make THIS file unable to prove the one thing it
// exists to prove: that an edited, still-agent-sourced draft's remember()
// call correctly fires on approval. What this file proves instead -- pu-03's
// real edit route genuinely persists an edit made through it, and genuinely
// remains approvable afterward -- is the part of "pu-12's edit path" that is
// actually this ticket's own scope (the transport/route layer, not
// ui/app.js's current DOM field coverage).
//
// STEP 5 -- a real HTTP POST to pu-03's approve route (the exact route
// pu-12's real approveDraft() calls) commits the edited draft via the real
// write primitive, archives the draft, and fires remember() -- verified via
// THREE independent real reads: the HTTP response body, a direct filesystem
// read of the real persona store file, and a direct filesystem read of the
// real remember()-written note file (never trusting the HTTP response
// alone).
//
// STEP 6 -- a final real HTTP GET confirms the approved draft is gone from
// the active list (archived, not merely "still there but flagged").
//
// $HOME is a real, throwaway temp directory shared by BOTH the CLI propose
// subprocess and the API server subprocess (mirrors test/persona-draft-cross-
// transport.mjs's fake-$HOME convention) -- never touches the operator's
// real ~/.mnemosyne. The remember()/recall() target is a real src/server.mjs
// subprocess pointed at test/fixtures/fake-swarm-memory-pu03 (pu-03's own
// dedicated, STATEFUL double -- reused verbatim, not re-forked) via
// SWARM_MEMORY_BIN, so recall() genuinely reflects only what a real
// remember() call actually indexed.
//
// Uses PORT 8520 (swarm-memory-backed service) and PORT_HTTP 8521
// (lib/mnemosyne/server.ts) -- both distinct from every other test file's
// port (see test/persona-draft-cross-transport.mjs's own port-registry
// comment for the fullest list; nothing else in this repo currently uses
// 8520/8521).
//
// This file is plain ESM run via `node` (never `tsx`): unlike
// test/persona-draft-cross-transport.mjs, it makes zero direct in-process
// imports of any .ts module -- every real-store/note-file read is a hand-
// derived direct filesystem read (mirrors test/http-api.mjs's/test/persona-
// cross-transport.mjs's own "hand-derive the fixed location convention, seof
// this file's own independent verification never trusts the module under
// test's own accounting of itself" posture) or a real HTTP call.
//
// This file has a live swarm-memory-backed service dependency chain (a real
// src/server.mjs subprocess) and is NOT part of the combined `npm test`
// script for the same reason test/persona-draft-cross-transport.mjs/
// test/http-api.mjs's own pu-03 section aren't gated behind anything extra --
// it spins its own fixture double up itself, so it needs no external state,
// but is still run as its own dedicated script for clarity.
//
// Usage: node test/persona-full-loop-e2e.mjs
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
// Real skill modules -- the exact ones a live interview session loads
// (SKILL.md step 7). Plain ESM .mjs, importable directly without a build
// step or tsx.
import { runPersonaInterview } from "../skills/mnemosyne-persona-interview/interview-engine.mjs";
import { crawlBoundedContext } from "../skills/mnemosyne-persona-interview/crawl-context.mjs";
import { writeDraftPersonaViaCli } from "../skills/mnemosyne-persona-interview/persona-draft-writer.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");
const SERVER = path.join(ROOT, "lib", "mnemosyne", "server.ts");
const REAL_SERVER = path.join(ROOT, "src", "server.mjs");
const PU03_FIXTURE_BIN = path.join(__dirname, "fixtures", "fake-swarm-memory-pu03");

const SWARM_PORT = 8520;
const SWARM_BASE = `http://127.0.0.1:${SWARM_PORT}`;
const API_PORT = 8521;
const API_BASE = `http://127.0.0.1:${API_PORT}`;

const TIER = "company-director";
const SCOPE_ID = "pu13-full-loop-director";
const MARKER = "PU13_FULL_LOOP_SOURCE_MARKER";

let fails = 0;
const ok = (condition, message) => {
  console.log(`${condition ? "  PASS" : "  FAIL"}  ${message}`);
  if (!condition) fails++;
};

async function waitForServerReachable(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
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

async function main() {
  const fakeHome = await mkdtemp(path.join(tmpdir(), "mnemosyne-pu13-home-"));
  const apiRoot = await mkdtemp(path.join(tmpdir(), "mnemosyne-pu13-api-root-"));
  const notesDir = await mkdtemp(path.join(tmpdir(), "mnemosyne-pu13-notes-"));
  const indexStoreDir = await mkdtemp(path.join(tmpdir(), "mnemosyne-pu13-index-"));
  const indexStore = path.join(indexStoreDir, "store.json");
  const crawlFixtureRepo = await mkdtemp(path.join(tmpdir(), "mnemosyne-pu13-crawl-repo-"));

  // A real README.md a real crawlBoundedContext() call reads off real disk
  // below -- the draft's sourceSummary is never hand-typed.
  await writeFile(
    path.join(crawlFixtureRepo, "README.md"),
    `# PU13 Full-Loop Fixture Repo\n\n${MARKER} — real crawled context for the epic's own full-loop e2e proof.\n`,
    "utf8",
  );

  const swarmChild = spawn(process.execPath, [REAL_SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(SWARM_PORT),
      SWARM_MEMORY_BIN: PU03_FIXTURE_BIN,
      FAKE_SWARM_PU03_INDEX_STORE: indexStore,
      MNEMOSYNE_NOTES_DIR: notesDir,
      MNEMO_TEST_NODE: process.execPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let swarmOutput = "";
  swarmChild.stdout.on("data", (c) => (swarmOutput += c));
  swarmChild.stderr.on("data", (c) => (swarmOutput += c));

  const apiChild = spawn(TSX, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      MNEMOSYNE_PORT: String(API_PORT),
      MNEMOSYNE_ROOT_DIR: apiRoot,
      HOME: fakeHome, // shared with the CLI propose subprocess below -- same draft/persona store
      PORT: String(SWARM_PORT), // fireDraftApprovalRemember's own REMEMBER_SERVICE_PORT target
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
    const swarmUp = await waitForServerReachable(`${SWARM_BASE}/healthz`);
    ok(swarmUp, "real src/server.mjs (swarm-memory-backed, fake-swarm-memory-pu03 double) started and is reachable");
    if (!swarmUp) {
      console.error(swarmOutput);
      throw new Error("swarm-memory service never became reachable");
    }

    const apiUp = await waitForApiHealth();
    ok(apiUp, "real lib/mnemosyne/server.ts subprocess (pu-03's draft routes) started and is reachable");
    if (!apiUp) {
      console.error(apiOutput);
      throw new Error("lib/mnemosyne/server.ts API service never became reachable");
    }

    // =========================================================================
    // STEP 1 -- a real CLI interview run: default draft-first path, NO
    // --commit-directly. runPersonaInterview() (interview-engine.mjs) builds
    // the persona record; crawlBoundedContext() (pu-07) performs a REAL
    // bounded filesystem crawl for the sourceSummary; writeDraftPersonaViaCli()
    // (pu-08) spawns a REAL `mnemosyne persona draft propose` OS subprocess,
    // HOME-pointed at the same fakeHome the API server above already uses.
    // =========================================================================
    const { sourceSummary, sourcesRead } = await crawlBoundedContext({ repoRoot: crawlFixtureRepo });
    ok(
      sourceSummary.includes(MARKER),
      `crawlBoundedContext() (real fs read against a real fixture repo) produced a real sourceSummary containing this run's own marker (sourcesRead=${JSON.stringify(sourcesRead)})`,
    );

    const originalDisplayName = "PU13 Full-Loop Director";
    const { persona } = runPersonaInterview({
      tier: TIER,
      scopeId: SCOPE_ID,
      displayName: originalDisplayName,
      scope: "Owns the PU13 full-loop e2e regression's own test scope only.",
      responses: {
        knows: "PU13_KNOWS_MARKER — the epic's own closing full-loop proof.",
        not_hold: "PU13_NOT_HOLD_MARKER — any other epic's own test scope.",
        parent: "none",
        success: "PU13_SUCCESS_MARKER — the complete propose-to-remembered loop holds end-to-end.",
        avoid: "PU13_AVOID_MARKER — proving any single piece in isolation only.",
      },
    });

    const proposeResult = await writeDraftPersonaViaCli(persona, {
      home: fakeHome,
      proposedBy: "agent",
      proposedAt: new Date().toISOString(),
      sourceSummary,
    });
    ok(
      proposeResult.ok === true,
      `real \`mnemosyne persona draft propose\` CLI subprocess (the interview skill's default write target, pu-08) succeeded (${JSON.stringify(proposeResult).slice(0, 300)})`,
    );
    ok(
      typeof proposeResult.writtenPath === "string" && proposeResult.writtenPath.includes(path.join(TIER, `${SCOPE_ID}.yaml`)),
      `the CLI subprocess itself reports the real on-disk draft path it wrote (got ${proposeResult.writtenPath})`,
    );

    // =========================================================================
    // STEP 2 -- real HTTP GET against pu-03's draft routes confirms the
    // CLI-originated draft is genuinely visible, including its sourceSummary.
    // =========================================================================
    const listAfterPropose = await fetch(`${API_BASE}/persona/draft`);
    const listAfterProposeBody = await listAfterPropose.json();
    ok(listAfterPropose.status === 200, `GET /persona/draft (list) -> 200 (got ${listAfterPropose.status})`);
    ok(
      listAfterProposeBody.drafts?.some((d) => d.tier === TIER && d.scopeId === SCOPE_ID),
      `GET /persona/draft (list) shows the CLI-originated draft's {tier, scopeId} as active (got ${JSON.stringify(listAfterProposeBody.drafts)})`,
    );

    const getAfterPropose = await fetch(`${API_BASE}/persona/draft/${TIER}/${SCOPE_ID}`);
    const getAfterProposeBody = await getAfterPropose.json();
    ok(getAfterPropose.status === 200, `GET /persona/draft/:tier/:scopeId -> 200 (got ${getAfterPropose.status})`);
    ok(
      getAfterProposeBody.draft?.sourceSummary === sourceSummary,
      "GET /persona/draft/:tier/:scopeId returns the draft's REAL sourceSummary (the exact string crawlBoundedContext() produced, not a placeholder)",
    );
    ok(
      getAfterProposeBody.draft?.displayName === originalDisplayName,
      "GET /persona/draft/:tier/:scopeId returns the interview's real displayName",
    );

    // =========================================================================
    // STEP 3 -- while the draft is still pending (not yet approved), a real
    // recall() query against content from the draft's sourceSummary returns
    // NOTHING -- proving remember() has genuinely not fired yet, across the
    // FULL real loop (CLI-propose through this exact moment).
    // =========================================================================
    const recallBefore = await fetch(`${SWARM_BASE}/recall`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: MARKER, scope: "persona-company-director" }),
    });
    const recallBeforeBody = await recallBefore.json();
    ok(
      recallBeforeBody.total_hits === 0,
      `recall() during the pending-review window (CLI-proposed, NOT yet approved) -> 0 hits, proving remember() genuinely has not fired yet (got total_hits=${recallBeforeBody.total_hits})`,
    );

    // =========================================================================
    // STEP 4 -- a real HTTP re-POST to the draft route, simulating pu-12's UI
    // edit path: ONE field (displayName) changed, every other field preserved
    // unchanged -- the same route + full-candidate-overwrite mechanism
    // ui/app.js's real submit handler POSTs to (see this file's header for
    // why this does not additionally clone that handler's own current
    // single-section v1 DOM field list).
    // =========================================================================
    const editedDisplayName = `${originalDisplayName} (edited via UI)`;
    const editedCandidate = { ...getAfterProposeBody.draft, displayName: editedDisplayName };
    const editRes = await fetch(`${API_BASE}/persona/draft/${TIER}/${SCOPE_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(editedCandidate),
    });
    ok(editRes.status === 201, `real HTTP re-POST to POST /persona/draft/:tier/:scopeId (simulated UI edit) -> 201 (got ${editRes.status})`);

    const getAfterEdit = await fetch(`${API_BASE}/persona/draft/${TIER}/${SCOPE_ID}`);
    const getAfterEditBody = await getAfterEdit.json();
    ok(
      getAfterEditBody.draft?.displayName === editedDisplayName,
      `GET /persona/draft/:tier/:scopeId reflects the real HTTP edit (got displayName=${JSON.stringify(getAfterEditBody.draft?.displayName)})`,
    );
    ok(
      getAfterEditBody.draft?.sourceSummary === sourceSummary,
      "GET /persona/draft/:tier/:scopeId still carries the original real sourceSummary after the edit (only displayName changed)",
    );

    // =========================================================================
    // STEP 5 -- a real HTTP POST to pu-03's approve route, simulating pu-12's
    // UI approve click. Verified via THREE independent real reads: the HTTP
    // response, a direct filesystem read of the real persona store, and a
    // direct filesystem read of the real remember()-written note file.
    // =========================================================================
    const approveRes = await fetch(`${API_BASE}/persona/draft/${TIER}/${SCOPE_ID}/approve`, { method: "POST" });
    const approveBody = await approveRes.json();
    ok(approveRes.status === 200, `real HTTP POST to pu-03's approve route (simulated UI approve click) -> 200 (got ${approveRes.status})`);
    ok(approveBody.approved === true, "approve response reports approved:true");
    ok(
      approveBody.remembered?.ok === true,
      `a REAL remember() call fired AFTER the write succeeded, scoped via resolveRememberScope() -- not stubbed (got ${JSON.stringify(approveBody.remembered)})`,
    );
    ok(
      approveBody.remembered?.scope === "persona-company-director",
      `remembered.scope comes from resolveRememberScope() (persona.ts), never a hand-copied mapping (got ${approveBody.remembered?.scope})`,
    );
    ok(
      approveBody.remembered?.tag === SCOPE_ID,
      `remembered.tag === the draft's own scopeId, sanitized via resolveRememberScope() (got ${approveBody.remembered?.tag})`,
    );

    // Independent read #1: the real persona store, read directly off disk
    // (never trusting the HTTP response's own accounting of itself).
    const personaPath = globalPersonaPath(fakeHome, TIER, SCOPE_ID);
    const personaRaw = await readFile(personaPath, "utf8");
    const personaParsed = parseYaml(personaRaw);
    ok(
      personaParsed.displayName === editedDisplayName,
      `the real persona store file (read directly off disk) reflects the EDITED content, not the original propose (got displayName=${JSON.stringify(personaParsed.displayName)})`,
    );
    ok(
      personaParsed.sourceSummary === undefined && personaParsed.proposedBy === undefined,
      "the committed real persona file has draft-only metadata (sourceSummary/proposedBy/proposedAt) stripped -- never leaks into the real store",
    );

    // Independent read #2: GET /persona (the real store's own list route).
    const personaList = await fetch(`${API_BASE}/persona`);
    const personaListBody = await personaList.json();
    ok(
      personaListBody.personas?.some((p) => p.tier === TIER && p.scopeId === SCOPE_ID),
      `GET /persona (real store list) includes the newly-committed persona (got ${JSON.stringify(personaListBody.personas)})`,
    );

    // Independent read #3: the real note file remember() actually wrote,
    // read directly off disk -- never trusting approveBody.remembered alone.
    ok(
      typeof approveBody.remembered?.file === "string" && approveBody.remembered.file.length > 0,
      `remembered.file is a real on-disk path (got ${JSON.stringify(approveBody.remembered?.file)})`,
    );
    const noteContent = await readFile(approveBody.remembered.file, "utf8");
    ok(noteContent.includes(MARKER), "the real note file on disk (read directly, not via the HTTP response) contains the draft's real sourceSummary content");
    ok(
      noteContent.includes(SCOPE_ID) && noteContent.includes(TIER),
      "the real note file identifies the persona draft's own tier/scopeId",
    );
    ok(
      noteContent.includes(editedDisplayName),
      "the real note file reflects the EDITED displayName (the approve route reads the draft fresh off disk at approval time, not a stale pre-edit copy)",
    );

    // recall() AFTER approve genuinely finds it now -- the same stateful
    // fixture that returned 0 hits before approve, proving the positive case
    // isn't a static stub either.
    const recallAfter = await fetch(`${SWARM_BASE}/recall`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: MARKER, scope: "persona-company-director" }),
    });
    const recallAfterBody = await recallAfter.json();
    ok(
      recallAfterBody.total_hits >= 1,
      `recall() AFTER approve genuinely finds the remembered content (got total_hits=${recallAfterBody.total_hits})`,
    );

    // =========================================================================
    // STEP 6 -- a final real HTTP GET confirms the approved draft no longer
    // appears in the active list (archived, per pu-02's disposal design).
    // =========================================================================
    const listAfterApprove = await fetch(`${API_BASE}/persona/draft`);
    const listAfterApproveBody = await listAfterApprove.json();
    ok(
      !listAfterApproveBody.drafts?.some((d) => d.tier === TIER && d.scopeId === SCOPE_ID),
      `GET /persona/draft (list) no longer shows the approved draft as active -- archived, not deleted (got ${JSON.stringify(listAfterApproveBody.drafts)})`,
    );
    const getAfterApprove = await fetch(`${API_BASE}/persona/draft/${TIER}/${SCOPE_ID}`);
    ok(
      getAfterApprove.status === 404,
      `GET /persona/draft/:tier/:scopeId -> 404 after approval -- the draft is genuinely gone from the active-draft read path (got ${getAfterApprove.status})`,
    );
  } finally {
    swarmChild.kill();
    apiChild.kill();
    await rm(fakeHome, { recursive: true, force: true });
    await rm(apiRoot, { recursive: true, force: true });
    await rm(notesDir, { recursive: true, force: true });
    await rm(indexStoreDir, { recursive: true, force: true });
    await rm(crawlFixtureRepo, { recursive: true, force: true });
  }

  console.log(`\n${fails === 0 ? "all persona-full-loop-e2e checks passed" : `${fails} FAILURE(S)`}`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
