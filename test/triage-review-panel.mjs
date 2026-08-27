// triage-review-panel.mjs — TDD tests for cm-16-triage-review-and-confirm-ui's
// UI panel (ui/index.html / ui/app.js).
//
// Matching test/personas-panel-shell.mjs's/test/jump-chip-nav-status-
// wiring.mjs's established convention: this repo has no DOM-rendering/jsdom
// test harness. Structural claims (panel markup, jump-chip, no `disabled`
// attribute) are static-assertion checks against the real served
// ui/index.html (spawning src/server.mjs). The behavioral claim this
// story's own acceptance criteria requires -- "a quarantine entry's
// rendered row contains no confirm/dismiss/delete/re-triage control
// element of any kind" -- is proven by extracting the REAL
// renderTriageQueue()/renderTriageCandidates() function source out of the
// real, on-disk ui/app.js via regex and executing it for real via `new
// Function(...)` against a small hand-built fake DOM (test/jump-chip-nav-
// status-wiring.mjs's own established technique), then walking the
// resulting fake DOM tree and asserting every quarantine row's children are
// all plain <td> cells -- never a <button>/<input>/<a> of any kind.
//
// Usage: node test/triage-review-panel.mjs
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, "..", "src", "server.mjs");
const PORT = Number(process.env.MNEMOSYNE_TEST_PORT || 8509);
const BASE = `http://127.0.0.1:${PORT}`;

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

try {
  const up = await waitForServer(BASE + "/scopes");
  ok(up, "test server came up");

  const indexRes = await fetch(BASE + "/ui");
  const indexBody = await indexRes.text();
  ok(indexRes.status === 200, `GET /ui -> 200 (got ${indexRes.status})`);

  // ==========================================================================
  // 1. Static markup: the panel exists, matches the Personas panel's own
  //    shell exactly, and carries NO `disabled` attribute anywhere (this
  //    codebase's established batch-action-strip convention).
  // ==========================================================================
  const sectionMatch = indexBody.match(/<section id="triage-review"[\s\S]*?<\/section>\s*\n\s*<!-- =+ end cm-16/);
  ok(!!sectionMatch, "GET /ui body has a <section id=\"triage-review\"> block");
  const section = sectionMatch ? sectionMatch[0] : "";

  ok(/<h2>Triage Review<\/h2>/.test(section), "panel has an <h2>Triage Review</h2> heading");
  ok(/<p class="panel-status" id="triage-candidates-status">/.test(section), "panel has a triage-candidates-status element");
  ok(/<p class="panel-status" id="triage-queue-status">/.test(section), "panel has a triage-queue-status element");
  ok(/<p id="triage-review-live-region" class="sr-only" aria-live="polite">/.test(section), "panel has its own scoped aria-live region");
  ok(/id="triage-confirm-checkboxes"[^>]*role="group"/.test(section), "confirm strip is a real role=\"group\" of checkboxes (Personas' own batch-approve-strip idiom)");
  ok(/<button type="button" id="triage-confirm-btn"/.test(section), "confirm strip has exactly one real <button type=\"button\">");
  ok(!/disabled/.test(section), "no `disabled` attribute exists anywhere in the panel's static markup (established convention)");
  ok(/href="#triage-review"/.test(indexBody), "GET /ui body has a #triage-review jump-chip");

  // ==========================================================================
  // 2. Real, served ui/app.js: extract the real render functions and drive
  //    them against a fake DOM.
  // ==========================================================================
  const appJs = await (await fetch(BASE + "/ui/app.js")).text();
  const appJsOnDisk = await readFile(path.join(__dirname, "..", "ui", "app.js"), "utf8");
  ok(appJsOnDisk === appJs, "served ui/app.js matches the on-disk source exactly (no build step in between)");

  const blockMatch = appJsOnDisk.match(
    /\/\/ =+ cm-16-triage-review-and-confirm-ui =+\n([\s\S]*?)\n\/\/ =+ end cm-16-triage-review-and-confirm-ui =+/,
  );
  ok(!!blockMatch, "cm-16's own ui/app.js block was extracted for inspection");
  const block = blockMatch ? blockMatch[1] : "";
  ok(/function setStatus\(/.test(block) === false, "extracted block does not itself redefine setStatus() (reused from earlier in the file)");

  // --- minimal fake DOM, matching test/jump-chip-nav-status-wiring.mjs's own
  // established FakeClassList/FakeChip technique, extended with a real
  // createElement()/appendChild() tree so quarantine/candidate rows can be
  // walked structurally after rendering. ---------------------------------
  class FakeClassList {
    constructor() { this._set = new Set(); }
    add(c) { this._set.add(c); }
    contains(c) { return this._set.has(c); }
  }
  class FakeNode {
    constructor(tagName) {
      this.tagName = String(tagName || "").toUpperCase();
      this.children = [];
      this._textContent = "";
      this.hidden = false;
      this.className = "";
      this.classList = new FakeClassList();
      this._listeners = {};
    }
    appendChild(child) { this.children.push(child); return child; }
    addEventListener(evt, fn) { (this._listeners[evt] ||= []).push(fn); }
    get textContent() { return this._textContent; }
    set textContent(v) {
      this._textContent = v;
      if (v === "") this.children = []; // mirrors real DOM: el.textContent = "" clears children
    }
  }
  const fakeCreateElement = (tag) => new FakeNode(tag);
  const fakeCreateTextNode = (text) => ({ nodeType: 3, textContent: text });

  const elementsById = {};
  for (const id of [
    "triage-candidates-status", "triage-queue-status", "triage-review-live-region",
    "triage-confirm-strip", "triage-confirm-status", "triage-confirm-checkboxes", "triage-confirm-btn",
    "triage-candidates-tbody", "triage-candidates-empty",
    "triage-quarantine-tbody", "triage-quarantine-empty",
    "triage-confirmations-tbody", "triage-confirmations-empty",
  ]) {
    elementsById[id] = new FakeNode(id.endsWith("-tbody") ? "tbody" : id.endsWith("-btn") ? "button" : "div");
  }

  const fakeDocument = {
    createElement: fakeCreateElement,
    createTextNode: fakeCreateTextNode,
    getElementById: (id) => elementsById[id] || null,
  };

  // setStatus() is called by loadTriageCandidates()/loadTriageQueue() (not
  // exercised here -- pure fetch wrappers) but NOT by the pure render
  // functions under test; still stub it defensively in case that changes.
  const buildFns = new Function(
    "document",
    "setStatus",
    `${block}\nreturn { renderTriageCandidates, renderTriageQueue, triageCell };`,
  );
  const { renderTriageCandidates, renderTriageQueue } = buildFns(fakeDocument, () => {});

  ok(typeof renderTriageQueue === "function" && typeof renderTriageCandidates === "function",
    "real renderTriageQueue()/renderTriageCandidates() were extracted and are callable");

  // ==========================================================================
  // 3. THE ACCEPTANCE CRITERION: a quarantine entry's rendered row contains
  //    NO confirm/dismiss/delete/re-triage control element of any kind.
  // ==========================================================================
  const quarantineFixture = [
    {
      recordedAt: "2026-08-27T00:00:00.000Z",
      quarantine_reason: "secret_detected",
      entry_id: "q1",
      entry_type: "decision",
      session_id: "s1",
      chat_source: "claude-code",
      project_slug: null,
      cluster_id: "cluster-9",
      secretMatches: [{ category: "aws", pattern: "aws-access-key-id", line: 3, index: 10, length: 20, preview: "[REDACTED]" }],
    },
    {
      recordedAt: "2026-08-27T00:00:01.000Z",
      quarantine_reason: "secret_detected",
      entry_id: "q2",
      entry_type: "open_question",
      session_id: "s2",
      chat_source: "chatgpt",
      project_slug: "/repo",
      cluster_id: null,
      secretMatches: [],
    },
  ];
  renderTriageQueue({ quarantine: quarantineFixture, confirmations: [] });

  const quarantineTbody = elementsById["triage-quarantine-tbody"];
  ok(quarantineTbody.children.length === 2, `quarantine tbody has exactly 2 rows (got ${quarantineTbody.children.length})`);
  const ACTIONABLE_TAGS = new Set(["BUTTON", "INPUT", "A", "SELECT", "TEXTAREA"]);
  let anyActionableControlFound = false;
  for (const row of quarantineTbody.children) {
    ok(row.tagName === "TR", "each rendered quarantine row is a real <tr>");
    for (const cell of row.children) {
      if (ACTIONABLE_TAGS.has(cell.tagName)) anyActionableControlFound = true;
      ok(cell.tagName === "TD", `every child of a quarantine row is a plain <td> (found <${cell.tagName.toLowerCase()}>)`);
      // Even nested inside a <td>, no actionable control may ever exist.
      const nested = (cell.children || []).some((c) => ACTIONABLE_TAGS.has(c.tagName));
      if (nested) anyActionableControlFound = true;
    }
  }
  ok(!anyActionableControlFound, "NO confirm/dismiss/delete/re-triage control element (button/input/a/select/textarea) exists anywhere in any rendered quarantine row -- visibility only");

  // Real, redaction-safe secret metadata IS shown (visibility, not a blank
  // row) -- category/pattern/line, never a raw value.
  const firstRowText = quarantineTbody.children[0].children.map((c) => c.textContent).join(" | ");
  ok(firstRowText.includes("q1") && firstRowText.includes("claude-code") && firstRowText.includes("cluster-9"),
    "a quarantine row shows its own real, redaction-safe identifiers");
  ok(firstRowText.includes("aws/aws-access-key-id"), "a quarantine row shows its own real, redaction-safe match summary (category/pattern), never a raw secret value");

  // ==========================================================================
  // 4. Confirmed scope-route rows are ALSO visibility-only (no revoke/undo
  //    control of any kind -- this story's own route surface has no such
  //    action at all).
  // ==========================================================================
  const confirmationsFixture = [{ recordedAt: "2026-08-27T00:00:00.000Z", confirmation_reason: "scope_route_confirmed", cluster_id: "cluster-1", scope_key: "arizona" }];
  renderTriageQueue({ quarantine: [], confirmations: confirmationsFixture });
  const confirmationsTbody = elementsById["triage-confirmations-tbody"];
  ok(confirmationsTbody.children.length === 1, "confirmations tbody has exactly 1 row");
  for (const cell of confirmationsTbody.children[0].children) {
    ok(cell.tagName === "TD", "every child of a confirmations row is a plain <td> -- no action control");
  }

  // ==========================================================================
  // 5. Candidate rows: the confirm action is a BATCH checkbox strip, keyed
  //    by (cluster_id, scope_key) -- never a per-row button, and only
  //    candidate_unconfirmed rows ever get a checkbox.
  // ==========================================================================
  const candidatesFixture = [
    { entryId: "e1", clusterId: "cluster-1", scopeKey: "arizona", status: "candidate_unconfirmed", distributedToScope: null },
    { entryId: "e2", clusterId: "cluster-1", scopeKey: "arizona", status: "candidate_unconfirmed", distributedToScope: null }, // SAME pair as e1
    { entryId: "e3", clusterId: "cluster-2", scopeKey: "texas", status: "candidate_confirmed_pending_distribution", distributedToScope: null },
    { entryId: "e4", clusterId: "cluster-3", scopeKey: "meta-ish", status: "distributed", distributedToScope: "meta" },
    { entryId: "e5", clusterId: null, scopeKey: null, status: "no_candidate", distributedToScope: null },
  ];
  renderTriageCandidates(candidatesFixture);

  const candidatesTbody = elementsById["triage-candidates-tbody"];
  ok(candidatesTbody.children.length === 5, `candidates tbody has exactly 5 rows (got ${candidatesTbody.children.length})`);
  for (const row of candidatesTbody.children) {
    for (const cell of row.children) {
      ok(cell.tagName === "TD", "every candidate row's own cells are plain <td> -- no per-row button anywhere");
    }
  }

  const confirmCheckboxesEl = elementsById["triage-confirm-checkboxes"];
  ok(confirmCheckboxesEl.children.length === 1,
    `exactly ONE checkbox for the two candidate_unconfirmed rows sharing the SAME (cluster_id, scope_key) pair (got ${confirmCheckboxesEl.children.length})`);
  const label = confirmCheckboxesEl.children[0];
  ok(label.tagName === "LABEL", "the batch strip's own row is a real <label> wrapping a checkbox (Personas' own idiom)");
  const checkbox = label.children.find((c) => c.tagName === "INPUT");
  ok(!!checkbox, "the batch strip row contains a real <input> checkbox");
  ok(checkbox && checkbox.type === "checkbox", "the batch strip's own input is type=\"checkbox\"");
  ok(checkbox && checkbox.disabled !== true, "the checkbox carries no disabled state (established no-disabled-attribute convention)");

  const confirmStripEl = elementsById["triage-confirm-strip"];
  ok(confirmStripEl.hidden === false, "the confirm strip is visible when at least one candidate_unconfirmed row exists");

  // No candidates at all -> confirm strip disappears entirely (mirrors
  // Personas' own puf-02-batch-approve-strip "disappears, not just empties"
  // convention).
  renderTriageCandidates([
    { entryId: "e3", clusterId: "cluster-2", scopeKey: "texas", status: "candidate_confirmed_pending_distribution", distributedToScope: null },
  ]);
  ok(confirmStripEl.hidden === true, "the confirm strip is hidden entirely when zero candidate_unconfirmed rows exist");
  ok(confirmCheckboxesEl.children.length === 0, "zero checkboxes render when zero candidate_unconfirmed rows exist");
} finally {
  if (fails) console.log("\n--- server output (for debugging) ---\n" + serverOutput);
  child.kill();
}

console.log(fails ? `\n${fails} check(s) failed` : "\nall triage-review-panel checks passed");
process.exit(fails ? 1 : 0);
