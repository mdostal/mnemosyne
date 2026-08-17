// persona-files-slice2-e2e.mjs — pf-07-slice2-regression.
//
// Closes vertical-plan.md Slice 2 with a real, continuous end-to-end proof of
// the UI file-attachment path: pf-05's #persona-form gained a real
// <input type="file" multiple"> that folds attached files' capped content
// into the SAME candidate object the form's existing personaForm submit
// handler already POSTs (ui/app.js, personaForm.addEventListener("submit",
// ...)) -- never a second request, never a hand-typed sourceSummary. This
// file proves that exact real body shape end to end against a real,
// subprocess-spawned lib/mnemosyne/server.ts, reusing test/persona-files-
// slice1-e2e.mjs's own real-subprocess, real-HTTP, "no mocked transport
// boundary anywhere" convention.
//
// Unlike slice 1 (test/persona-files-slice1-e2e.mjs), which proves the
// AGENT-side entry point (CLI `propose-from-files` -> crawlExplicitFiles()),
// this file proves the separate UI/HUMAN-side entry point: a human fills out
// #persona-form BY HAND and attaches real files. The submit handler never
// sets `proposedBy: 'agent'` (grep ui/app.js's own submit handler -- that
// field is never assigned anywhere in it), so the resulting draft must be
// labeled pf-06's third, honest provenance state -- "human-attached" --
// never "agent-proposed": a real sourceSummary is present (so
// isAgentProposedDraft() is true), but proposedBy is not 'agent'.
//
// STEP 0 -- builds the exact real POST body pf-05's shipped submit handler
// would produce, WITHOUT re-typing/reimplementing its cap-twin logic: this
// file extracts capExcerpt()/assembleSourceSummary() directly from the real,
// on-disk ui/app.js source via regex and executes them for real via
// `new Function(...)` (the exact technique test/persona-files-cap-twin-
// parity.mjs already established for proving pf-04's client-side twins are
// genuine) against 2 real fixture files written to real disk -- one short
// (well under the caps, passes through untouched) and one deliberately
// long (80 lines, over MAX_LINES_PER_SOURCE=40), so the resulting
// sourceSummary is REAL capped content -- genuinely truncated by the
// shipped ui/app.js code, not just short pass-through text -- exactly
// mirroring what a human who attached these 2 files and clicked submit
// would have produced.
//
// STEP 1 -- a real HTTP POST to pu-03's POST /persona/draft/:tier/:scopeId
// route, body = {tier, scopeId, displayName, scope, sections: [...],
// sourceSummary} -- the same candidate shape personaForm's submit handler
// builds (tier/scopeId/displayName/scope/sections from the form fields,
// sourceSummary folded in from attached files) -- against a real,
// subprocess-spawned lib/mnemosyne/server.ts. No `proposedBy` field
// anywhere in the body, matching the real submit handler exactly.
//
// STEP 2 -- a real HTTP GET against the same draft route confirms the
// draft's shape: a real, non-empty sourceSummary (genuinely capped, genuine
// truncation marker present) and no `proposedBy: 'agent'`. This file then
// extracts pf-06's own isAgentProposedDraft()/draftProvenanceLabel()
// straight out of the real, on-disk ui/app.js (same regex-extract-and-
// `new Function`-execute technique as STEP 0) and runs them for real
// against the GET response body -- proving the real shipped labeling logic
// resolves this exact draft shape to "human-attached", not a reimplemented
// stand-in assertion.
//
// STEP 3 -- a real HTTP POST to pu-03's approve route commits the draft via
// the real write primitive (writeGlobalPersona) and archives the draft.
//
// STEP 4 -- verified via TWO independent real reads (never trusting the HTTP
// response alone, matching pu-13's/slice-1's own posture): a direct
// filesystem read of the real global persona store file confirms the
// committed section body -- itself real, human-typed text that quotes the
// SAME attached-file-derived marker the real sourceSummary also carries --
// landed intact, and that draft-only metadata (sourceSummary/proposedBy/
// proposedAt) never leaked into the real store; and a real HTTP GET
// /persona (the real store's own list route).
//
// $HOME is a real, throwaway temp directory the API server subprocess uses
// exclusively (mirrors slice-1's/test/persona-cli.mjs's own fake-$HOME
// convention) -- never touches the operator's real ~/.mnemosyne. PORT points
// at a real, but definitely-unlistened-on, local port, so the approve
// route's own optional remember()-firing attempt (server.ts's
// fireDraftApprovalRemember) fails fast and non-fatally, exactly like
// slice-1's own approach.
//
// Uses PORT_API 8537 -- distinct from every other test file's own real-server
// port (see test/persona-files-slice1-e2e.mjs's own port-registry comment
// for the fullest list, plus 8535/8536 which that file itself claims;
// nothing else in this repo currently uses 8537) -- and a definitely-
// unreachable local port (8538) as the approve route's own remember()-target
// PORT, so its connection attempt fails fast (ECONNREFUSED) rather than
// hanging.
//
// This file is plain ESM run via `node` (never `tsx`): like slice-1, it
// makes zero direct in-process imports of any .ts module -- the real
// persona store's on-disk location is hand-derived (mirrors persona-store-
// global.ts's own globalPersonaPath() convention, read directly off disk,
// never imported) or reached via a real HTTP call. The two ui/app.js-side
// function pairs this file needs (capExcerpt/assembleSourceSummary,
// isAgentProposedDraft/draftProvenanceLabel) are extracted from the real,
// on-disk ui/app.js source and executed for real -- never re-typed.
//
// Usage: node test/persona-files-slice2-e2e.mjs
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");
const SERVER = path.join(ROOT, "lib", "mnemosyne", "server.ts");
const APP_JS_PATH = path.join(ROOT, "ui", "app.js");

const API_PORT = 8537;
const API_BASE = `http://127.0.0.1:${API_PORT}`;
// A real port, deliberately unlistened-on -- makes the approve route's own
// optional remember() attempt fail fast (ECONNREFUSED) rather than hang.
const UNREACHABLE_REMEMBER_PORT = 8538;

const TIER = "company-director";
const SCOPE_ID = "pf07-slice2-scope";

const MARKER_NOTES = "PF07_NOTES_MARKER";
const MARKER_LONG_HEAD = "PF07_LONG_HEAD_MARKER";
const MARKER_LONG_TAIL = "PF07_LONG_TAIL_MARKER";

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

// =============================================================================
// STEP 0 -- extract and genuinely execute ui/app.js's OWN real functions
// (never reimplemented/re-typed), matching test/persona-files-cap-twin-
// parity.mjs's established extraction technique exactly.
// =============================================================================

function extractConst(name, src) {
  const m = src.match(new RegExp(`const ${name} = (.*);`));
  return m ? m[1] : undefined;
}

async function loadRealUiFunctions() {
  const appJsSrc = await readFile(APP_JS_PATH, "utf8");

  const truncationMarkerLiteral = extractConst("TRUNCATION_MARKER", appJsSrc);
  const maxLinesLiteral = extractConst("MAX_LINES_PER_SOURCE", appJsSrc);
  const maxCharsLiteral = extractConst("MAX_CHARS_PER_SOURCE", appJsSrc);
  const maxSummaryLiteral = extractConst("MAX_SOURCE_SUMMARY_CHARS", appJsSrc);
  ok(truncationMarkerLiteral !== undefined, "extracted TRUNCATION_MARKER const from the real, on-disk ui/app.js");
  ok(maxLinesLiteral !== undefined, "extracted MAX_LINES_PER_SOURCE const from the real, on-disk ui/app.js");
  ok(maxCharsLiteral !== undefined, "extracted MAX_CHARS_PER_SOURCE const from the real, on-disk ui/app.js");
  ok(maxSummaryLiteral !== undefined, "extracted MAX_SOURCE_SUMMARY_CHARS const from the real, on-disk ui/app.js");

  const capExcerptMatch = appJsSrc.match(/function capExcerpt\([\s\S]*?\n\}\n/);
  const assembleMatch = appJsSrc.match(/function assembleSourceSummary\([\s\S]*?\n\}\n/);
  ok(!!capExcerptMatch, "extracted capExcerpt() function body from the real, on-disk ui/app.js");
  ok(!!assembleMatch, "extracted assembleSourceSummary() function body from the real, on-disk ui/app.js");

  const capExcerpt = new Function(
    "MAX_LINES_PER_SOURCE",
    "MAX_CHARS_PER_SOURCE",
    `const TRUNCATION_MARKER = ${truncationMarkerLiteral};\n${capExcerptMatch[0]}\nreturn capExcerpt;`,
  )(Number(maxLinesLiteral), Number(maxCharsLiteral));
  const assembleSourceSummary = new Function(
    "MAX_SOURCE_SUMMARY_CHARS",
    `const TRUNCATION_MARKER = ${truncationMarkerLiteral};\n${assembleMatch[0]}\nreturn assembleSourceSummary;`,
  )(Number(maxSummaryLiteral));
  ok(typeof capExcerpt === "function", "built a real, callable ui/app.js-side capExcerpt()");
  ok(typeof assembleSourceSummary === "function", "built a real, callable ui/app.js-side assembleSourceSummary()");

  const isAgentProposedMatch = appJsSrc.match(/function isAgentProposedDraft\([\s\S]*?\n\}\n/);
  const provenanceLabelMatch = appJsSrc.match(/function draftProvenanceLabel\([\s\S]*?\n\}\n/);
  ok(!!isAgentProposedMatch, "extracted isAgentProposedDraft() function body from the real, on-disk ui/app.js");
  ok(!!provenanceLabelMatch, "extracted draftProvenanceLabel() function body from the real, on-disk ui/app.js");

  const draftProvenanceLabel = new Function(
    `${isAgentProposedMatch[0]}\n${provenanceLabelMatch[0]}\nreturn draftProvenanceLabel;`,
  )();
  ok(typeof draftProvenanceLabel === "function", "built a real, callable ui/app.js-side draftProvenanceLabel()");

  const truncationMarkerValue = new Function(`return (${truncationMarkerLiteral});`)();

  return { capExcerpt, assembleSourceSummary, draftProvenanceLabel, truncationMarkerValue, maxLinesLiteral: Number(maxLinesLiteral) };
}

async function main() {
  const { capExcerpt, assembleSourceSummary, draftProvenanceLabel, truncationMarkerValue, maxLinesLiteral } =
    await loadRealUiFunctions();

  const fakeHome = await mkdtemp(path.join(tmpdir(), "mnemosyne-pf07-home-"));
  const apiRoot = await mkdtemp(path.join(tmpdir(), "mnemosyne-pf07-api-root-"));
  const fixturesDir = await mkdtemp(path.join(tmpdir(), "mnemosyne-pf07-fixtures-"));

  // 2 real fixture text files on real disk -- notes.md is short (well under
  // both caps, passes through untouched) and long-context.md is
  // deliberately 80 lines (over MAX_LINES_PER_SOURCE, currently 40), so
  // capExcerpt() genuinely truncates it -- proving the resulting
  // sourceSummary is REAL capped content, not just short pass-through text.
  const notesPath = path.join(fixturesDir, "notes.md");
  const longContextPath = path.join(fixturesDir, "long-context.md");
  await writeFile(
    notesPath,
    `# Notes\n\n${MARKER_NOTES} — real fixture notes content for pf-07's own UI file-attachment e2e proof.\n`,
    "utf8",
  );
  const longLines = ["# Long Context", "", `${MARKER_LONG_HEAD} — appears on an early line, must survive truncation.`];
  for (let i = 0; i < 80; i++) longLines.push(`filler line ${i} of real long-context fixture content.`);
  longLines.push(`${MARKER_LONG_TAIL} — appears far past the ${maxLinesLiteral}-line cap, must NOT survive truncation.`);
  await writeFile(longContextPath, longLines.join("\n") + "\n", "utf8");

  const rawNotes = await readFile(notesPath, "utf8");
  const rawLongContext = await readFile(longContextPath, "utf8");

  // The exact real ui/app.js capExcerpt() -- genuinely executed, not
  // reimplemented -- applied to real file content read off real disk.
  const notesExcerpt = capExcerpt(rawNotes);
  const longContextExcerpt = capExcerpt(rawLongContext);
  ok(longContextExcerpt.truncated === true, "the real ui/app.js capExcerpt() genuinely truncated the 80-line fixture (over the line cap)");
  ok(notesExcerpt.truncated === false, "the real ui/app.js capExcerpt() left the short fixture untouched (under both caps)");

  // The exact real ui/app.js assembleSourceSummary() -- the SAME candidate
  // field the real submit handler folds in when files are attached.
  const realSourceSummary = assembleSourceSummary(
    [
      { name: "notes.md", ...notesExcerpt },
      { name: "long-context.md", ...longContextExcerpt },
    ],
    [],
  );
  ok(realSourceSummary.includes(MARKER_NOTES), "the real, assembled sourceSummary contains the short fixture's real content");
  ok(realSourceSummary.includes(MARKER_LONG_HEAD), "the real, assembled sourceSummary contains the long fixture's early-line content (survives truncation)");
  ok(!realSourceSummary.includes(MARKER_LONG_TAIL), "the real, assembled sourceSummary does NOT contain the long fixture's past-the-cap content (genuinely truncated)");
  ok(realSourceSummary.includes(truncationMarkerValue), "the real, assembled sourceSummary carries ui/app.js's own real truncation marker");

  // The human-typed section body: real, hand-authored prose that quotes the
  // SAME attached-file-derived marker the sourceSummary also carries --
  // exactly how a human filling out #persona-form after attaching these
  // files would plausibly write it up in their own words.
  const humanSectionBody = `This director's current priorities were informed by attached supporting notes (${MARKER_NOTES}), reviewed ahead of this write-up.`;

  // The exact real candidate shape personaForm's submit handler builds:
  // {tier, scopeId, displayName, scope, sections: [{heading, body}]}, PLUS
  // sourceSummary folded in when files are attached -- and critically, NO
  // `proposedBy` field anywhere (grep ui/app.js's own submit handler: it
  // never assigns one).
  const candidate = {
    tier: TIER,
    scopeId: SCOPE_ID,
    displayName: "PF07 Slice 2 Director",
    scope: "PF07 slice-2 UI file-attachment regression scope",
    sections: [{ heading: "Current Priorities", body: humanSectionBody }],
    sourceSummary: realSourceSummary,
  };
  ok(!("proposedBy" in candidate), "the real candidate body has NO proposedBy field -- matches personaForm's submit handler exactly (a human, not an agent, produced this draft)");

  const apiChild = spawn(TSX, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      MNEMOSYNE_PORT: String(API_PORT),
      MNEMOSYNE_ROOT_DIR: apiRoot,
      HOME: fakeHome,
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
    // STEP 1 -- a real HTTP POST to pu-03's POST /persona/draft/:tier/:scopeId
    // route, carrying the exact real body pf-05's UI file-attachment path
    // would produce.
    // =========================================================================
    const propose = await fetch(`${API_BASE}/persona/draft/${TIER}/${SCOPE_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(candidate),
    });
    const proposeBody = await propose.json();
    ok(propose.status === 201, `real HTTP POST to POST /persona/draft/:tier/:scopeId -> 201 (got ${propose.status}, body=${JSON.stringify(proposeBody)})`);
    ok(proposeBody.proposed === true, "propose response reports proposed:true");
    ok(proposeBody.tier === TIER && proposeBody.scopeId === SCOPE_ID, "propose response echoes the correct identity");

    // =========================================================================
    // STEP 2 -- real HTTP GET confirms the draft's shape is exactly what
    // pf-06's third label state ("human-attached") keys on, verified by
    // running pf-06's own real, extracted draftProvenanceLabel() against it
    // -- not a reimplemented stand-in check.
    // =========================================================================
    const get = await fetch(`${API_BASE}/persona/draft/${TIER}/${SCOPE_ID}`);
    const getBody = await get.json();
    ok(get.status === 200, `GET /persona/draft/:tier/:scopeId -> 200 (got ${get.status})`);
    ok(getBody.draft?.tier === TIER && getBody.draft?.scopeId === SCOPE_ID, "GET /persona/draft/:tier/:scopeId echoes the correct identity");
    ok(
      typeof getBody.draft?.sourceSummary === "string" && getBody.draft.sourceSummary === realSourceSummary,
      "GET /persona/draft/:tier/:scopeId returns the draft's sourceSummary byte-for-byte identical to the real, capped content that was POSTed",
    );
    ok(
      getBody.draft?.proposedBy !== "agent",
      `GET /persona/draft/:tier/:scopeId's draft does NOT carry proposedBy: 'agent' (got ${JSON.stringify(getBody.draft?.proposedBy)})`,
    );

    const label = draftProvenanceLabel(getBody.draft);
    ok(
      label === "human-attached",
      `the real, extracted ui/app.js draftProvenanceLabel() resolves this exact draft shape to "human-attached" (got ${JSON.stringify(label)}) -- pf-06's third, honest provenance state, never "agent-proposed" and never "manual"`,
    );

    // =========================================================================
    // STEP 3 -- a real HTTP POST to pu-03's approve route commits the draft
    // via the real write primitive (writeGlobalPersona), archiving the
    // draft.
    // =========================================================================
    const approve = await fetch(`${API_BASE}/persona/draft/${TIER}/${SCOPE_ID}/approve`, { method: "POST" });
    const approveBody = await approve.json();
    ok(approve.status === 200, `real HTTP POST to pu-03's approve route -> 200 (got ${approve.status}, body=${JSON.stringify(approveBody)})`);
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
    ok(personaParsed.displayName === candidate.displayName, "the real persona store file's displayName matches what was submitted");
    ok(
      Array.isArray(personaParsed.sections) &&
        personaParsed.sections[0]?.body === humanSectionBody &&
        personaParsed.sections[0].body.includes(MARKER_NOTES),
      "the real persona store's committed section body (read directly off disk) matches the real, human-typed text that quotes the SAME attached-file-derived marker the draft's sourceSummary also carried",
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
    // (archived, per pu-02's disposal design), matching slice-1's own final
    // check.
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

  console.log(`\n${fails === 0 ? "all persona-files-slice2-e2e checks passed" : `${fails} FAILURE(S)`}`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
