// persona-write-form.mjs — TDD tests for pw-17-personas-panel-write-form,
// RETARGETED by pu-12-draft-review-approve-ui, EXTENDED by
// pf-05-ui-file-attachment.
//
// pw-17 originally wired #persona-form to POST directly to pw-15's
// POST /persona/:tier/:scopeId route (an immediate, uncommitted write).
// pu-12 retargets that exact submit handler to POST to pu-03's
// POST /persona/draft/:tier/:scopeId route instead -- a human typing a
// persona by hand now produces an active DRAFT, reviewed/approved through
// the same queue as an agent-proposed draft (design-discussion.md §9
// judgment call #4), never an immediate commit. This file replaces
// pw-17's original assertions (which pinned the OLD direct-write behavior)
// with assertions for the NEW retargeted behavior -- the form's field
// markup/conventions carry forward unchanged, only the submit target and
// post-success refresh call change.
//
// pf-05-ui-file-attachment (this file's newest section, below the original
// pw-17/pu-12 assertions) adds: (1) static assertions that #persona-form
// gained a real <input type="file" multiple"> field, keyboard-reachable,
// and that the SAME submit handler (never a second one) now reads attached
// files' text and folds pf-04's capped sourceSummary into the SAME
// candidate object; and (2) a genuinely dynamic proof -- the real submit
// handler function is extracted from the on-disk ui/app.js (same
// extract-real-source-then-`new Function`-execute technique
// test/persona-files-cap-twin-parity.mjs already established for
// capExcerpt()/assembleSourceSummary()) and actually run against a real,
// subprocess-spawned lib/mnemosyne/server.ts, with real attached File
// objects (Node's global File, real .text()) -- so the resulting POST
// /persona/draft/:tier/:scopeId body inspected below is the real body the
// shipped code produces and the real server actually received (read back
// via a real GET), not a client-side-only/regex-only assertion. The
// no-attachment case is compared BYTE-FOR-BYTE against the same extraction
// technique applied to ui/app.js as it stood at PRE_PF05_BASELINE_COMMIT
// (pu-12's own shipped behavior, pinned to a real commit rather than
// "whatever HEAD happens to be") -- a real diff between two real
// executions, not an assumption.
//
// Matching test/persona-layer-stack.mjs's and test/personas-panel-shell.mjs's
// established convention: this repo has no DOM-rendering/jsdom test harness,
// so this file does static-assertion checks against the real served
// ui/index.html and ui/app.js (spawning src/server.mjs, the UI's own static
// file server) rather than executing app.js in a browser-like environment --
// pf-05's dynamic section (below) does not change that: it extracts and
// executes only the specific, real functions it needs (same technique
// test/persona-files-cap-twin-parity.mjs already uses), never a full
// browser/jsdom load of the whole file.
//
// Usage: node test/persona-write-form.mjs
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { capExcerpt as nodeCapExcerpt } from "../skills/mnemosyne-persona-interview/crawl-context.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SERVER_PATH = path.join(__dirname, "..", "src", "server.mjs");
const PORT = Number(process.env.MNEMOSYNE_TEST_PORT || 8503);
const BASE = `http://127.0.0.1:${PORT}`;

const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");
const PERSONA_SERVER_PATH = path.join(ROOT, "lib", "mnemosyne", "server.ts");
const PERSONA_PORT = Number(process.env.MNEMOSYNE_TEST_PERSONA_PORT || 31417);
const PERSONA_BASE = `http://127.0.0.1:${PERSONA_PORT}`;

// pf-05: the tip of feat/mnemosyne-persona-files as this story begins work
// (chore(pf-02): mark story complete -- AFTER pf-04's cap-twin merge, BEFORE
// this story's own changes) -- pu-12's own shipped submit-handler behavior,
// pinned to a real, stable commit rather than "whatever HEAD happens to be"
// (which would silently drift once this story's own commit lands on top).
const PRE_PF05_BASELINE_COMMIT = "7a3c5a5";

let fails = 0;
const ok = (c, m) => { console.log(`${c ? "  PASS" : "  FAIL"}  ${m}`); if (!c) fails++; };

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

const child = spawn(process.execPath, [SERVER_PATH], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});

let serverOutput = "";
child.stdout.on("data", (d) => { serverOutput += d.toString(); });
child.stderr.on("data", (d) => { serverOutput += d.toString(); });

// pf-05: a second real subprocess -- the actual persona service
// (lib/mnemosyne/server.ts, the same one personaServiceOrigin() in
// ui/app.js targets) -- against a throwaway $HOME/root, matching
// test/http-api.mjs's own established spawn convention exactly, so the
// dynamic section below can POST through the real submit handler and read
// back what the real server actually persisted.
const personaFakeHome = await mkdtemp(path.join(tmpdir(), "mnemosyne-pf05-home-"));
const personaRoot = await mkdtemp(path.join(tmpdir(), "mnemosyne-pf05-root-"));

const personaChild = spawn(TSX, [PERSONA_SERVER_PATH], {
  cwd: ROOT,
  env: {
    ...process.env,
    MNEMOSYNE_PORT: String(PERSONA_PORT),
    MNEMOSYNE_ROOT_DIR: personaRoot,
    HOME: personaFakeHome,
    SWARM_MEMORY_BIN: "/definitely/missing/swarm-memory",
    SWARM_MEMORY_GRAPH_DB: path.join(personaRoot, "missing-graph.sqlite"),
    GRAPHIFY_BIN: "/definitely/missing/graphify-binary-xyz",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let personaServerOutput = "";
personaChild.stdout.on("data", (d) => { personaServerOutput += d.toString(); });
personaChild.stderr.on("data", (d) => { personaServerOutput += d.toString(); });

async function waitForHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${PERSONA_BASE}/health`);
      if (res.status === 200 || res.status === 503) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

try {
  const up = await waitForServer(BASE + "/scopes");
  ok(up, "test server came up");

  const personaUp = await waitForHealth(15000);
  ok(personaUp, "pf-05: real persona service (lib/mnemosyne/server.ts) came up");
  if (!personaUp) console.error(personaServerOutput);

  // --- served ui/index.html: the create/edit form exists inside the
  // Personas panel, follows add-lane-form's exact form-row convention ------
  const indexRes = await fetch(BASE + "/ui");
  const indexBody = await indexRes.text();
  ok(indexRes.status === 200, `GET /ui -> 200 (got ${indexRes.status})`);

  // The form must be a descendant of <section id="personas">, not a
  // free-floating form elsewhere in the page.
  const personasSectionMatch = indexBody.match(/<section id="personas"[\s\S]*?<\/section>/);
  ok(!!personasSectionMatch, "GET /ui body has a <section id=\"personas\"> block");
  const personasSection = personasSectionMatch ? personasSectionMatch[0] : "";

  ok(/<form id="persona-form"/.test(personasSection),
    "the Personas <section> contains <form id=\"persona-form\">");

  // Fields the draft route's persona-candidate shape needs (same shape as
  // before -- pu-03's writeDraftPersona is deliberately looser than
  // assertValidPersona, but this form still collects the full candidate so
  // it's ready for approval): tier, scopeId, displayName, scope, a section
  // (heading+body), repo.
  ok(/<select id="persona-tier" name="tier"/.test(personasSection),
    "form has a tier <select> (name=\"tier\")");
  ok(
    /<option value="top-orchestrator">/.test(personasSection) &&
      /<option value="company-director">/.test(personasSection) &&
      /<option value="project-orchestrator">/.test(personasSection) &&
      /<option value="code-architect">/.test(personasSection),
    "tier <select> offers all 4 tiers",
  );
  ok(/<input id="persona-scope-id" name="scopeId"/.test(personasSection),
    "form has a scopeId input (name=\"scopeId\")");
  ok(/<input id="persona-display-name" name="displayName"/.test(personasSection),
    "form has a displayName input (name=\"displayName\")");
  ok(/<input id="persona-scope" name="scope"/.test(personasSection),
    "form has a scope input (name=\"scope\")");
  ok(/<input id="persona-section-heading" name="sectionHeading"/.test(personasSection),
    "form has a section-heading input (name=\"sectionHeading\") -- single 'knows' section, v1 minimum");
  ok(/<textarea id="persona-section-body" name="sectionBody"/.test(personasSection),
    "form has a section-body textarea (name=\"sectionBody\")");
  ok(/<input id="persona-repo" name="repo"/.test(personasSection),
    "form has an (optional) repo input (name=\"repo\") -- required only for code-architect");

  // add-lane-form's exact structure: form-row divs, single submit button,
  // a dedicated panel-status element.
  ok((personasSection.match(/class="form-row"/g) || []).length >= 6,
    "form uses form-row divs (add-lane-form's convention), one per field");
  ok(/<button type="submit">/.test(personasSection),
    "form has a submit button");
  ok(/<p class="panel-status" id="persona-form-status">/.test(personasSection),
    "form has its own dedicated panel-status element (id=\"persona-form-status\")");

  // --- pf-05-ui-file-attachment: a real, keyboard-reachable file input -----
  const fileInputMatch = personasSection.match(/<input\b[^>]*id="persona-file-input"[^>]*>/);
  ok(!!fileInputMatch, "the Personas <section> contains <input id=\"persona-file-input\">");
  const fileInputTag = fileInputMatch ? fileInputMatch[0] : "";
  ok(/type="file"/.test(fileInputTag), "persona-file-input is type=\"file\"");
  ok(/multiple/.test(fileInputTag), "persona-file-input allows multiple files (multiple attribute)");
  ok(!/\btabindex="-1"/.test(fileInputTag), "persona-file-input is NOT removed from the tab order (no tabindex=\"-1\")");
  ok(!/\bdisabled\b/.test(fileInputTag), "persona-file-input is not disabled");
  ok(!/\bhidden\b/.test(fileInputTag), "persona-file-input is not hidden");
  ok(/<label for="persona-file-input">/.test(personasSection),
    "persona-file-input has an associated <label for=\"persona-file-input\">, aiding keyboard/AT reachability");
  // Not gated behind any other control -- a plain sibling form-row inside
  // #persona-form, same as every other field, never inside a <details>/
  // conditionally-rendered wrapper.
  const formRowsBeforeFileInput = personasSection.slice(0, personasSection.indexOf(fileInputTag));
  ok(!/<details/.test(formRowsBeforeFileInput.slice(formRowsBeforeFileInput.lastIndexOf("<form"))),
    "persona-file-input is not nested inside a <details>/collapsed wrapper ahead of it");

  // --- served ui/app.js: the submit handler ---------------------------------
  const appJs = await (await fetch(BASE + "/ui/app.js")).text();

  ok(/getElementById\(\s*["'`]persona-form["'`]\s*\)/.test(appJs),
    "ui/app.js grabs #persona-form");
  ok(/getElementById\(\s*["'`]persona-form-status["'`]\s*\)/.test(appJs),
    "ui/app.js grabs #persona-form-status");
  ok(/getElementById\(\s*["'`]persona-file-input["'`]\s*\)/.test(appJs),
    "pf-05: ui/app.js grabs #persona-file-input");

  // EXACTLY ONE personaForm.addEventListener("submit", ...) wiring anywhere
  // in the file -- pf-05 extends the existing handler, never adds a second.
  const submitWiringCount = (appJs.match(/personaForm\.addEventListener\(\s*["'`]submit["'`]/g) || []).length;
  ok(submitWiringCount === 1,
    `exactly one personaForm.addEventListener("submit", ...) wiring in ui/app.js (found ${submitWiringCount}) -- pf-05 extends it, never adds a second`);

  // Submit handler shape: addEventListener("submit", ...) on personaForm,
  // matching addLaneForm's exact convention.
  const submitHandlerMatch = appJs.match(
    /personaForm\.addEventListener\(\s*["'`]submit["'`][\s\S]*?\n\}\);/,
  );
  ok(!!submitHandlerMatch, "ui/app.js wires a personaForm.addEventListener(\"submit\", ...) handler");
  const handler = submitHandlerMatch ? submitHandlerMatch[0] : "";

  ok(/evt\.preventDefault\(\)/.test(handler),
    "submit handler calls evt.preventDefault()");
  ok(/new FormData\(personaForm\)/.test(handler),
    "submit handler reads the form via FormData(personaForm)");

  // --- THE RETARGETING ITSELF: POSTs to pu-03's draft route, NEVER pw-15's
  // real POST /persona/:tier/:scopeId route ---------------------------------
  ok(/personaServiceOrigin\(\)/.test(handler),
    "submit handler uses personaServiceOrigin() -- same cross-origin pattern as loadPersonas()");
  ok(/\/persona\/draft\/\$\{encodeURIComponent\(tier\)\}\/\$\{encodeURIComponent\(scopeId\)\}/.test(handler),
    "submit handler builds the URL as /persona/draft/:tier/:scopeId (encoded) -- the DRAFT route");
  ok(!/`\$\{origin\}\/persona\/\$\{encodeURIComponent\(tier\)\}\/\$\{encodeURIComponent\(scopeId\)\}`/.test(handler),
    "submit handler's fetch target is NEVER the bare /persona/:tier/:scopeId direct-write URL");
  ok(/method:\s*["'`]POST["'`]/.test(handler),
    "submit handler POSTs (method: \"POST\")");
  ok(/["'`]content-type["'`]:\s*["'`]application\/json["'`]/.test(handler),
    "submit handler sends content-type: application/json");

  // Body shape unchanged: bare persona candidate {tier, scopeId, displayName,
  // scope, sections: [{heading, body}], repo?} -- never mandateSections.
  ok(/sections:\s*\[\s*\{\s*heading:\s*sectionHeading,\s*body:\s*sectionBody\s*\}\s*\]/.test(handler),
    "submit handler's body includes sections: [{heading, body}] (single section, v1 minimum)");
  ok(!/mandateSections/.test(handler),
    "submit handler never sends mandateSections");
  ok(/JSON\.stringify\(candidate\)/.test(handler),
    "submit handler sends the candidate as the JSON body");

  // --- pf-05: the SAME single JSON body, extended with attached files' ------
  // capped content, never a second fetch() call ------------------------------
  ok(/candidate\.sourceSummary\s*=/.test(handler),
    "pf-05: submit handler folds sourceSummary into the SAME candidate object");
  ok(/\.text\(\)/.test(handler),
    "pf-05: submit handler reads attached files via File.text()");
  ok(/capExcerpt\(/.test(handler) && /assembleSourceSummary\(/.test(handler),
    "pf-05: submit handler applies pf-04's capExcerpt()/assembleSourceSummary() cap-twin");
  // Strip comments first -- this handler's own doc comment legitimately
  // mentions "fetch()" in prose, which is not a second call site. Line
  // comments MUST be stripped before block comments (see
  // test/persona-files-cap-twin-parity.mjs's own stripJsComments for why:
  // a "//" comment whose prose contains a literal "/*" substring would
  // otherwise make the block-comment regex swallow real code past it).
  const handlerCodeOnly = handler
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const fetchCallCount = (handlerCodeOnly.match(/\bfetch\(/g) || []).length;
  ok(fetchCallCount === 1,
    `pf-05: exactly one fetch( call in the submit handler (found ${fetchCallCount}) -- attached files never trigger a second request`);

  // On success: loadDrafts() (pu-12's new function) -- NEVER loadPersonas()
  // directly from THIS handler, since proposing/editing a draft never
  // touches the real persona store (only Approve does that, tested
  // separately in test/persona-draft-review-approve-ui.mjs).
  ok(/await loadDrafts\(\)/.test(handler),
    "submit handler calls loadDrafts() on success (pu-12's new function)");
  ok(!/await loadPersonas\(\)/.test(handler),
    "submit handler never calls loadPersonas() directly -- proposing a draft never writes to the real persona store");
  ok(/setStatus\(personaFormStatusEl,\s*["'`]pass["'`]/.test(handler),
    "submit handler calls setStatus(..., \"pass\", ...) on success");

  // On failure: setStatus() fail, matching every other form's convention;
  // no second/duplicate persona-rendering path is introduced by this file.
  ok(/setStatus\(personaFormStatusEl,\s*["'`]fail["'`]/.test(handler),
    "submit handler surfaces failure via setStatus() on both the !res.ok path and the catch path");
  ok((handler.match(/setStatus\(personaFormStatusEl,\s*["'`]fail["'`]/g) || []).length >= 2,
    "submit handler surfaces failure via setStatus() on both the !res.ok path and the catch path");

  // --- the review step's own explicit gate: no remaining POST to
  // /persona/:tier/:scopeId (the real, direct-write route) ANYWHERE in
  // ui/app.js's form-submit code paths. This is a whole-file grep, not
  // scoped to `handler`, so it also catches a stray second wiring elsewhere.
  ok(
    !/fetch\(\s*`\$\{origin\}\/persona\/\$\{encodeURIComponent\(tier\)\}\/\$\{encodeURIComponent\(scopeId\)\}`/.test(appJs),
    "no remaining fetch() to the real, direct-write /persona/:tier/:scopeId route anywhere in ui/app.js",
  );

  // Reuses pw-03's loadPersonas() -- the whole file has exactly one
  // function that appends rows into personasTbodyEl, not two.
  const rowBuilders = (appJs.match(/personasTbodyEl\.appendChild/g) || []).length;
  ok(rowBuilders === 1,
    `exactly one place appends rows to personasTbodyEl (found ${rowBuilders}) -- no second persona-rendering path`);
  ok(!/function\s+loadPersonas2|function\s+loadPersonaForm\b/.test(appJs),
    "no rebuilt second persona-list loader function exists");

  // Direct source-file read too (belt-and-suspenders vs. the served copy
  // above, same double-check convention as test/persona-layer-stack.mjs).
  const appJsOnDisk = await readFile(path.join(__dirname, "..", "ui", "app.js"), "utf8");
  const indexHtmlOnDisk = await readFile(path.join(__dirname, "..", "ui", "index.html"), "utf8");
  ok(appJsOnDisk === appJs, "served ui/app.js matches the on-disk source exactly (no build step in between)");
  ok(indexHtmlOnDisk.includes(indexBody.trim()) || indexBody.includes(indexHtmlOnDisk.trim()),
    "served GET /ui body matches the on-disk ui/index.html source");

  // ===========================================================================
  // pf-05-ui-file-attachment: DYNAMIC proof -- the real submit handler,
  // extracted from ui/app.js and genuinely executed (never re-typed/
  // reimplemented), run against a real, subprocess-spawned persona service.
  // ===========================================================================

  function extractFn(name, src) {
    const re = new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}\\n`);
    const m = src.match(re);
    if (!m) throw new Error(`pf-05 test harness: could not extract function ${name}() from source`);
    return m[0];
  }
  function extractConst(name, src) {
    const m = src.match(new RegExp(`const ${name} = (.*);`));
    if (!m) throw new Error(`pf-05 test harness: could not extract const ${name} from source`);
    return m[1];
  }

  // Builds real, callable {buildHandler, capExcerpt, assembleSourceSummary,
  // setStatus} from a given ui/app.js source blob -- works identically for
  // the CURRENT on-disk source and for the PRE_PF05_BASELINE_COMMIT source,
  // so both can be exercised through the exact same harness.
  function buildAppFunctions(appSrc) {
    const truncationMarkerLiteral = extractConst("TRUNCATION_MARKER", appSrc);
    const maxLines = Number(extractConst("MAX_LINES_PER_SOURCE", appSrc));
    const maxChars = Number(extractConst("MAX_CHARS_PER_SOURCE", appSrc));
    const maxSummary = Number(extractConst("MAX_SOURCE_SUMMARY_CHARS", appSrc));

    const capExcerptSrc = extractFn("capExcerpt", appSrc);
    const assembleSrc = extractFn("assembleSourceSummary", appSrc);
    const setStatusSrc = extractFn("setStatus", appSrc);

    const capExcerptFn = new Function(
      "MAX_LINES_PER_SOURCE", "MAX_CHARS_PER_SOURCE",
      `const TRUNCATION_MARKER = ${truncationMarkerLiteral};\n${capExcerptSrc}\nreturn capExcerpt;`,
    )(maxLines, maxChars);

    const assembleSourceSummaryFn = new Function(
      "MAX_SOURCE_SUMMARY_CHARS",
      `const TRUNCATION_MARKER = ${truncationMarkerLiteral};\n${assembleSrc}\nreturn assembleSourceSummary;`,
    )(maxSummary);

    const setStatusFn = new Function(`${setStatusSrc}\nreturn setStatus;`)();

    // Extract the submit handler's own function EXPRESSION (never
    // re-typed) by slicing the known addEventListener(...) wrapper off the
    // full, already-verified statement match from earlier in this file.
    const prefixMatch = appSrc.match(/personaForm\.addEventListener\(\s*["'`]submit["'`],\s*/);
    const stmtMatch = appSrc.match(/personaForm\.addEventListener\(\s*["'`]submit["'`][\s\S]*?\n\}\);/);
    if (!prefixMatch || !stmtMatch) {
      throw new Error("pf-05 test harness: could not extract personaForm submit handler from source");
    }
    let fnSrc = stmtMatch[0].slice(prefixMatch[0].length);
    fnSrc = fnSrc.replace(/\);\s*$/, ""); // strip the addEventListener(...) call's trailing ");"

    const buildHandler = new Function(
      "personaForm", "personaFormStatusEl", "personaFileInputEl",
      "setStatus", "personaServiceOrigin", "loadDrafts",
      "capExcerpt", "assembleSourceSummary", "fetch", "FormData",
      `return (${fnSrc});`,
    );

    return { buildHandler, capExcerpt: capExcerptFn, assembleSourceSummary: assembleSourceSummaryFn, setStatus: setStatusFn };
  }

  class FakeFormData {
    constructor(form) {
      this._values = (form && form._formDataValues) || {};
    }
    get(key) {
      return Object.prototype.hasOwnProperty.call(this._values, key) ? this._values[key] : null;
    }
  }

  function makeFetchSpy(realFetch) {
    const calls = [];
    const spy = async (url, init) => {
      calls.push({ url, init });
      return realFetch(url, init);
    };
    spy.calls = calls;
    return spy;
  }

  function makeFakePersonaForm(fields) {
    return {
      _formDataValues: fields,
      querySelector(sel) {
        if (sel === "button[type=submit]") return { disabled: false };
        return null;
      },
      reset() {},
    };
  }

  // Runs the REAL, extracted submit handler from `appSrc`, against real
  // fields/files, through a real fetch() pointed at the real spawned
  // persona service on PERSONA_PORT. Returns the fetch spy (for call-count
  // and actual-body assertions) plus the status element (for pass/fail UX
  // assertions).
  async function runHandler(appSrc, { fields, files }) {
    const { buildHandler, capExcerpt, assembleSourceSummary, setStatus } = buildAppFunctions(appSrc);
    const fetchSpy = makeFetchSpy(fetch);
    const form = makeFakePersonaForm(fields);
    const statusEl = { textContent: "", className: "" };
    const fileInputEl = { files: files || [] };
    const handler = buildHandler(
      form,
      statusEl,
      fileInputEl,
      setStatus,
      () => PERSONA_BASE,
      async () => {}, // loadDrafts stub -- not this story's concern
      capExcerpt,
      assembleSourceSummary,
      fetchSpy,
      FakeFormData,
    );
    await handler({ preventDefault() {} });
    return { fetchSpy, statusEl };
  }

  const baselineAppSrc = execFileSync("git", ["show", `${PRE_PF05_BASELINE_COMMIT}:ui/app.js`], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });

  // --- Case 1: NO files attached -- byte-for-byte unchanged ----------------
  const noAttachFields = {
    tier: "company-director",
    scopeId: "pf05-noattach",
    displayName: "PF-05 No-Attachment Fixture",
    scope: "a fixture persona used to prove the no-attachment case is unchanged",
    sectionHeading: "What this persona knows",
    sectionBody: "Fixture section body, no files attached.",
    repo: "",
  };

  const baselineRun = await runHandler(baselineAppSrc, { fields: { ...noAttachFields, scopeId: "pf05-noattach-baseline" }, files: [] });
  ok(baselineRun.fetchSpy.calls.length === 1,
    `baseline (pre-pf-05) handler makes exactly one fetch() call with no files attached (got ${baselineRun.fetchSpy.calls.length})`);

  const currentNoAttachRun = await runHandler(appJsOnDisk, { fields: { ...noAttachFields, scopeId: "pf05-noattach-current" }, files: [] });
  ok(currentNoAttachRun.fetchSpy.calls.length === 1,
    `pf-05: current handler makes exactly one fetch() call with no files attached (got ${currentNoAttachRun.fetchSpy.calls.length})`);

  const baselineBody = baselineRun.fetchSpy.calls[0]?.init?.body;
  const currentNoAttachBody = currentNoAttachRun.fetchSpy.calls[0]?.init?.body;
  ok(typeof baselineBody === "string" && typeof currentNoAttachBody === "string",
    "both baseline and current no-attachment runs captured a real, real request body string");

  // Compare with the SAME scopeId substituted back in, since the two runs
  // deliberately used different scopeIds (to land at distinct draft
  // identities on the real server) -- everything else must be identical.
  const normalize = (raw) => raw.replace(/"scopeId":"pf05-noattach-(?:baseline|current)"/, '"scopeId":"pf05-noattach"');
  ok(
    normalize(currentNoAttachBody) === normalize(baselineBody),
    "pf-05: with no files attached, the request body is BYTE-FOR-BYTE IDENTICAL to pu-12's own shipped (pre-pf-05) behavior -- a real diff between two real executions, not an assumption",
  );
  // And, independently, no sourceSummary key snuck in either way.
  ok(!/sourceSummary/.test(currentNoAttachBody), "pf-05: no-attachment request body has no sourceSummary key");
  ok(!/sourceSummary/.test(baselineBody), "baseline request body has no sourceSummary key (sanity check on the baseline itself)");

  // Real round trip: GET the no-attachment draft back from the REAL
  // spawned persona server and confirm what was actually persisted matches
  // -- "reading the actual request body", not trusting the client-side
  // capture alone.
  const noAttachReadBack = await fetch(`${PERSONA_BASE}/persona/draft/company-director/pf05-noattach-current`);
  const noAttachReadBackBody = await noAttachReadBack.json();
  ok(noAttachReadBack.status === 200, `pf-05: GET /persona/draft/company-director/pf05-noattach-current -> 200 (got ${noAttachReadBack.status})`);
  ok(!Object.prototype.hasOwnProperty.call(noAttachReadBackBody.draft || {}, "sourceSummary"),
    "pf-05: the REAL persisted draft (read back from the real server) has no sourceSummary key when no files were attached");
  ok(noAttachReadBackBody.draft && noAttachReadBackBody.draft.displayName === noAttachFields.displayName,
    "pf-05: the REAL persisted draft's displayName matches what the real handler actually sent");

  // --- Case 2: files attached -- real content, really capped, folded into
  // the SAME single POST ------------------------------------------------------
  const shortContent = "Alpha short fixture note.\nSecond line of the short fixture.\n";
  const manyLinesContent = Array.from({ length: 60 }, (_, i) => `pf05 fixture line ${i}`).join("\n");
  const longCharsContent = "PF05_LONGCHARS_" + "x".repeat(3000);

  const fileShort = new File([shortContent], "pf05-short.txt", { type: "text/plain" });
  const fileManyLines = new File([manyLinesContent], "pf05-manylines.txt", { type: "text/plain" });
  const fileLongChars = new File([longCharsContent], "pf05-longchars.txt", { type: "text/plain" });

  const attachFields = {
    tier: "company-director",
    scopeId: "pf05-attach",
    displayName: "PF-05 Attachment Fixture",
    scope: "a fixture persona used to prove attached files fold into the same POST",
    sectionHeading: "What this persona knows",
    sectionBody: "Fixture section body, files attached.",
    repo: "",
  };

  const attachRun = await runHandler(appJsOnDisk, { fields: attachFields, files: [fileShort, fileManyLines, fileLongChars] });
  ok(attachRun.fetchSpy.calls.length === 1,
    `pf-05: exactly ONE fetch() call fires with 3 files attached (got ${attachRun.fetchSpy.calls.length}) -- never a second request per file`);

  const attachBody = attachRun.fetchSpy.calls[0]?.init?.body;
  ok(typeof attachBody === "string", "pf-05: attachment-case run captured a real request body string");
  const parsedAttachBody = JSON.parse(attachBody);

  // Independently-derived expected sourceSummary: the REAL Node originals
  // (capExcerpt imported directly from crawl-context.mjs; assembleSourceSummary
  // extracted from that same real source, mirroring
  // test/persona-files-cap-twin-parity.mjs's own established technique) --
  // never the ui/app.js twin used to derive its own expected value.
  const crawlContextSrc = await readFile(path.join(ROOT, "skills", "mnemosyne-persona-interview", "crawl-context.mjs"), "utf8");
  const nodeTruncationMarkerLiteral = crawlContextSrc.match(/const TRUNCATION_MARKER = (.*);/)[1];
  const nodeAssembleFnSrc = crawlContextSrc.match(/function assembleSourceSummary\([\s\S]*?\n\}\n/)[0];
  const nodeAssembleSourceSummary = new Function(
    "MAX_SOURCE_SUMMARY_CHARS",
    `const TRUNCATION_MARKER = ${nodeTruncationMarkerLiteral};\n${nodeAssembleFnSrc}\nreturn assembleSourceSummary;`,
  )(4000);

  const expectedSourcesRead = [
    { name: "pf05-short.txt", ...nodeCapExcerpt(shortContent) },
    { name: "pf05-manylines.txt", ...nodeCapExcerpt(manyLinesContent) },
    { name: "pf05-longchars.txt", ...nodeCapExcerpt(longCharsContent) },
  ];
  const expectedSourceSummary = nodeAssembleSourceSummary(expectedSourcesRead, []);

  ok(expectedSourcesRead[1].truncated === true, "sanity: the 60-line fixture file is actually capped by MAX_LINES_PER_SOURCE");
  ok(expectedSourcesRead[2].truncated === true, "sanity: the long-chars fixture file is actually capped by MAX_CHARS_PER_SOURCE");

  ok(parsedAttachBody.sourceSummary === expectedSourceSummary,
    "pf-05: the real POST body's sourceSummary is BYTE-FOR-BYTE IDENTICAL to the independently-computed, real-capped expected value (Node's own capExcerpt/assembleSourceSummary, not the UI twin)");

  ok(
    parsedAttachBody.tier === attachFields.tier &&
      parsedAttachBody.scopeId === attachFields.scopeId &&
      parsedAttachBody.displayName === attachFields.displayName &&
      parsedAttachBody.scope === attachFields.scope,
    "pf-05: the other candidate fields (tier/scopeId/displayName/scope) are unaffected by the attached-files addition",
  );
  ok(
    Array.isArray(parsedAttachBody.sections) &&
      parsedAttachBody.sections.length === 1 &&
      parsedAttachBody.sections[0].heading === attachFields.sectionHeading &&
      parsedAttachBody.sections[0].body === attachFields.sectionBody,
    "pf-05: sections: [{heading, body}] is unaffected by the attached-files addition",
  );
  ok(
    JSON.stringify(Object.keys(parsedAttachBody).sort()) === JSON.stringify(["displayName", "scope", "scopeId", "sections", "sourceSummary", "tier"].sort()),
    `pf-05: attached-files POST body has exactly the expected key set, nothing extra (got ${JSON.stringify(Object.keys(parsedAttachBody).sort())})`,
  );

  // Real round trip again: GET the attachment-case draft back from the REAL
  // spawned persona server and confirm the persisted sourceSummary matches
  // too -- the actual server actually received and stored these bytes.
  const attachReadBack = await fetch(`${PERSONA_BASE}/persona/draft/company-director/pf05-attach`);
  const attachReadBackBody = await attachReadBack.json();
  ok(attachReadBack.status === 200, `pf-05: GET /persona/draft/company-director/pf05-attach -> 200 (got ${attachReadBack.status})`);
  ok(attachReadBackBody.draft && attachReadBackBody.draft.sourceSummary === expectedSourceSummary,
    "pf-05: the REAL persisted draft (read back from the real server) carries the real, capped sourceSummary");
} finally {
  if (fails) {
    console.log("\n--- ui server output (for debugging) ---\n" + serverOutput);
    console.log("\n--- persona server output (for debugging) ---\n" + personaServerOutput);
  }
  child.kill();
  personaChild.kill();
  await rm(personaFakeHome, { recursive: true, force: true });
  await rm(personaRoot, { recursive: true, force: true });
}

console.log(fails ? `\n${fails} check(s) failed` : "\nall persona-write-form checks passed");
process.exit(fails ? 1 : 0);
