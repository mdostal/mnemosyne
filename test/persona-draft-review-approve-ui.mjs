// persona-draft-review-approve-ui.mjs — TDD tests for
// pu-12-draft-review-approve-ui: the draft review/approve UI, per pu-01's
// chosen synthesized option (.pHive/design/mnemosyne-persona-ux/selection.md
// -> synthesized/option-2.md, "Trust-Gated Unified Queue").
//
// Covers this story's own acceptance criteria not already covered by
// test/persona-write-form.mjs's retargeting checks:
//   - a unified drafts list (loadDrafts(), following loadPersonas()'s own
//     "fetch, setStatus, render" conventions) renders BOTH agent-proposed
//     and human-typed drafts, distinguishably, in ONE list (mergedPersonaRows())
//   - sourceSummary is rendered and labeled ONLY for a real agent-proposed
//     draft, never fabricated for a human-typed one
//   - approve success calls BOTH a drafts-refresh (loadDrafts()) AND
//     loadPersonas() (pw-03's existing, unchanged function) -- no page reload
//   - discard requires an explicit confirm() before firing, and calls the
//     real DELETE route, never a client-side simulation
//   - every new interactive element is a real, natively-focusable element
//     (button), never gated by a `disabled` attribute
//
// Matching this repo's established convention (test/persona-write-form.mjs,
// test/personas-panel-shell.mjs): no DOM-rendering/jsdom harness here, so
// this file does static-assertion checks against the real served
// ui/index.html and ui/app.js (spawning src/server.mjs, the UI's own static
// file server).
//
// Usage: node test/persona-draft-review-approve-ui.mjs
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, "..", "src", "server.mjs");
const PORT = Number(process.env.MNEMOSYNE_TEST_PORT || 8507);
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

  const personasSectionMatch = indexBody.match(/<section id="personas"[\s\S]*?<\/section>/);
  ok(!!personasSectionMatch, "GET /ui body has a <section id=\"personas\"> block");
  const personasSection = personasSectionMatch ? personasSectionMatch[0] : "";

  // --- the table gains an Actions column (Review/Edit toggle), still ONE
  // #personas-table/#personas-tbody -- drafts are rendered INTO it, not a
  // second table/list --------------------------------------------------------
  ok(/<th>Actions<\/th>/.test(personasSection), "table header gains an Actions column");
  ok(
    (personasSection.match(/<table id="personas-table">/g) || []).length === 1,
    "still exactly one #personas-table -- drafts render into it, not a second table",
  );
  ok(
    (indexBody.match(/id="personas-tbody"/g) || []).length === 1,
    "still exactly one #personas-tbody in the whole page -- one unified list, not two",
  );

  // --- loadDrafts() has its own status element, following loadPersonas()'s
  // "fetch, setStatus, render" convention -------------------------------------
  ok(/<p class="panel-status" id="personas-drafts-status">/.test(personasSection),
    "panel has its own dedicated drafts-status element (id=\"personas-drafts-status\")");

  // --- served ui/app.js --------------------------------------------------
  const appJs = await (await fetch(BASE + "/ui/app.js")).text();

  // loadDrafts() exists exactly once, fetches GET /persona/draft (list),
  // then GET /persona/draft/:tier/:scopeId per entry (mirroring
  // loadPersonas()'s own "list route doesn't carry displayName" shape).
  //
  // puf-04-repo-scoped-personas-reachable: both URLs are now built as a
  // plain `?repo=`-less template when no repo is selected (byte-identical
  // to before this ticket) OR the same template plus `?repo=` when one is
  // -- these regexes (loosened from this ticket's original exact-fetch-
  // call checks, which predate ?repo= existing at all) still assert the
  // unscoped template itself is exactly unchanged, just no longer require
  // it be the literal sole argument to fetch().
  const loadDraftsDefCount = (appJs.match(/async function loadDrafts\(\)/g) || []).length;
  ok(loadDraftsDefCount === 1, `exactly one loadDrafts() function definition (found ${loadDraftsDefCount})`);
  ok(/:\s*`\$\{origin\}\/persona\/draft`\s*;[\s\S]{0,120}?fetch\(listUrl\)/.test(appJs),
    "loadDrafts() fetches GET /persona/draft (the list route, ?repo=-less URL unchanged when no repo is selected)");
  ok(
    /:\s*`\$\{origin\}\/persona\/draft\/\$\{encodeURIComponent\(entry\.tier\)\}\/\$\{encodeURIComponent\(entry\.scopeId\)\}`\s*;[\s\S]{0,120}?fetch\(url\)/.test(appJs),
    "loadDrafts() fetches GET /persona/draft/:tier/:scopeId per listed entry (?repo=-less URL unchanged for a non-repo-scoped entry)",
  );
  const loadDraftsBodyMatch = appJs.match(/async function loadDrafts\(\)\s*\{[\s\S]*?\n\}\n/);
  const loadDraftsBody = loadDraftsBodyMatch ? loadDraftsBodyMatch[0] : "";
  ok(loadDraftsBody.length > 0, "loadDrafts() function body was extracted for inspection");
  ok(/setStatus\(personasDraftsStatusEl,/.test(loadDraftsBody),
    "loadDrafts() calls setStatus() on its own dedicated status element");
  ok(/renderPersonas\(\);/.test(loadDraftsBody),
    "loadDrafts() calls renderPersonas() -- the SAME render function loadPersonas() calls, not a second one");

  // --- unified list: exactly one merge point combining live + draft rows,
  // and renderPersonas() builds its rows from THAT, not from loadedPersonas
  // directly -- so live and draft identities render in one list, not two ---
  const mergeDefCount = (appJs.match(/function mergedPersonaRows\(\)/g) || []).length;
  ok(mergeDefCount === 1, `exactly one mergedPersonaRows() function definition (found ${mergeDefCount})`);
  const renderBodyMatch = appJs.match(/function renderPersonas\(\)\s*\{[\s\S]*?\n\}\n/);
  const renderBody = renderBodyMatch ? renderBodyMatch[0] : "";
  ok(renderBody.length > 0, "renderPersonas() function body was extracted for inspection");
  ok(/mergedPersonaRows\(\)/.test(renderBody),
    "renderPersonas() builds its rows from mergedPersonaRows() -- live+draft combined, one list");
  ok(!/fetch\(/.test(renderBody), "renderPersonas() never calls fetch() -- pure client-side re-render, even with drafts merged in");

  // mergedPersonaRows() itself: three-way status derivation (live-only /
  // draft-only / live+draft), not two separate arrays rendered separately.
  const mergeBodyMatch = appJs.match(/function mergedPersonaRows\(\)\s*\{[\s\S]*?\n\}\n/);
  const mergeBody = mergeBodyMatch ? mergeBodyMatch[0] : "";
  ok(mergeBody.length > 0, "mergedPersonaRows() function body was extracted for inspection");
  ok(/needs-review-update/.test(mergeBody) && /needs-review["'`,)]/.test(mergeBody),
    "mergedPersonaRows() derives needs-review vs. needs-review-update from whether a live record already exists at that identity");

  // --- sourceSummary: rendered/labeled ONLY for a real, non-empty
  // sourceSummary -- the ONE signal this file uses for "agent-proposed" ------
  const isAgentProposedMatch = appJs.match(/function isAgentProposedDraft\([\s\S]*?\n\}\n/);
  const isAgentProposedBody = isAgentProposedMatch ? isAgentProposedMatch[0] : "";
  ok(isAgentProposedBody.length > 0, "isAgentProposedDraft() function body was extracted for inspection");
  ok(/sourceSummary/.test(isAgentProposedBody) && /trim\(\)\s*!==\s*["'`]["'`]/.test(isAgentProposedBody),
    "isAgentProposedDraft() checks for a real, non-empty sourceSummary -- not mere key presence");

  const detailRowMatch = appJs.match(/function buildPersonaDraftDetailRow\([\s\S]*?\n\}\n/);
  const detailRowBody = detailRowMatch ? detailRowMatch[0] : "";
  ok(detailRowBody.length > 0, "buildPersonaDraftDetailRow() function body was extracted for inspection");
  ok(/Why the agent proposed this/.test(detailRowBody),
    "detail panel labels the source summary \"Why the agent proposed this\" when present");
  ok(/agent-proposed/.test(detailRowBody), "detail panel visibly labels an agent-proposed draft");
  ok(/Manually created/.test(detailRowBody),
    "detail panel's provenance line says \"Manually created\" for a draft with no sourceSummary");
  ok(/if\s*\(agentProposed\)\s*\{/.test(detailRowBody),
    "source-summary block is gated behind the SAME isAgentProposedDraft() check, not rendered unconditionally");

  // --- pf-06 (design-discussion.md OQ3): a THIRD, honest label state for a
  // draft with a real, non-empty sourceSummary but proposedBy absent/not
  // 'agent' (a human attached files via pf-05, already merged) -- never
  // mislabeled as agent-proposed, never silently falling back to the
  // no-sourceSummary "Manually created" label either. isAgentProposedDraft()
  // itself must stay unchanged (asserted above, unmodified), so this is
  // asserted via a new sibling function. -------------------------------------
  const provenanceLabelMatch = appJs.match(/function draftProvenanceLabel\([\s\S]*?\n\}\n/);
  const provenanceLabelBody = provenanceLabelMatch ? provenanceLabelMatch[0] : "";
  ok(provenanceLabelBody.length > 0, "draftProvenanceLabel() function body was extracted for inspection");
  ok(/isAgentProposedDraft\(draft\)/.test(provenanceLabelBody),
    "draftProvenanceLabel() reuses isAgentProposedDraft()'s existing sourceSummary signal for whether real source material is present at all, rather than re-deriving it");
  ok(/proposedBy\s*===\s*["'`]agent["'`]/.test(provenanceLabelBody),
    "draftProvenanceLabel() checks proposedBy === 'agent' to distinguish an agent-authored draft from a human-attached one");
  ok(/return\s*["'`]manual["'`]/.test(provenanceLabelBody),
    "draftProvenanceLabel() returns 'manual' when there is no real sourceSummary");
  ok(/return[\s\S]*?["'`]agent-proposed["'`]/.test(provenanceLabelBody),
    "draftProvenanceLabel() returns 'agent-proposed' only when sourceSummary is real AND proposedBy === 'agent'");
  ok(/["'`]human-attached["'`]/.test(provenanceLabelBody),
    "draftProvenanceLabel() has a distinct 'human-attached' state for a real sourceSummary whose proposedBy is absent/not 'agent'");

  // buildPersonaDraftDetailRow() must derive its agentProposed gate THROUGH
  // the 3-way decision, not directly from isAgentProposedDraft()'s raw
  // sourceSummary-only signal -- otherwise a human who attached files would
  // still be mislabeled "agent-proposed" just because a real sourceSummary
  // happens to exist.
  ok(/const provenance = draftProvenanceLabel\(draft\);/.test(detailRowBody),
    "buildPersonaDraftDetailRow() computes the 3-way provenance label via draftProvenanceLabel(draft)");
  ok(/const agentProposed = provenance === ["'`]agent-proposed["'`];/.test(detailRowBody),
    "agentProposed is derived FROM the 3-way provenance decision (true only when proposedBy === 'agent'), not directly from isAgentProposedDraft()'s raw sourceSummary-only check");

  // The third state's own distinct, honest label, in its own additive
  // branch -- never a rewrite of the existing if (agentProposed) branch.
  ok(/Includes attached source material/.test(detailRowBody),
    "detail panel's provenance line says \"Includes attached source material\" for a real sourceSummary whose proposedBy is absent/not 'agent'");
  ok(
    /else if\s*\(\s*provenance\s*===\s*["'`]human-attached["'`]\s*\)\s*\{/.test(detailRowBody),
    "the third label state's DOM branch is its own additive else-if branch, gated on provenance === 'human-attached' -- structurally additive, not a rewrite of the existing if (agentProposed) branch",
  );
  ok(/badge\.textContent = ["'`]human-attached["'`]/.test(detailRowBody),
    "the human-attached state gets its own distinct badge text, never the \"agent-proposed\" badge text");
  ok((detailRowBody.match(/badge\.textContent = ["'`]agent-proposed["'`]/g) || []).length === 1,
    "the \"agent-proposed\" badge text is still assigned exactly once -- never applied to the new human-attached state");

  // --- Re-assert the two PRE-EXISTING states are genuinely unchanged: the
  // actual literal runtime OUTPUT strings (not comment mentions, which are
  // free to reword) still appear exactly once each, so a rewrite that
  // duplicates or shuffles the existing runtime text would be caught here --
  ok((detailRowBody.match(/: `Manually created · \$\{proposedAt\}`;/g) || []).length === 1,
    "the actual \"Manually created\" ternary branch/output string still appears exactly once, unmodified");
  ok((detailRowBody.match(/\? `Proposed by agent · \$\{proposedAt\}`/g) || []).length === 1,
    "the actual \"Proposed by agent\" ternary branch/output string still appears exactly once, unmodified");
  ok((detailRowBody.match(/h4\.textContent = "Why the agent proposed this";/g) || []).length === 1,
    "the actual \"Why the agent proposed this\" heading-assignment line still appears exactly once -- the agent-proposed state's summary block is unmodified");

  // --- call site 1 (list-row snippet, in renderPersonas()/mergedPersonaRows
  // territory): also uses the SAME shared draftProvenanceLabel() decision,
  // so the same 3-way provenance signal is used everywhere it's surfaced,
  // never a second, divergent definition of "agent-proposed" ---------------
  ok(/draftProvenanceLabel\(row\.draft\)/.test(renderBody),
    "renderPersonas()'s list-row snippet call site also derives provenance via the shared draftProvenanceLabel() helper");

  // --- Approve/Discard call the REAL pu-03 routes, never a client-side
  // simulation -------------------------------------------------------------
  const approveDefMatch = appJs.match(/async function approveDraft\([\s\S]*?\n\}\n/);
  const approveBody = approveDefMatch ? approveDefMatch[0] : "";
  ok(approveBody.length > 0, "approveDraft() function body was extracted for inspection");
  ok(/\/persona\/draft\/\$\{encodeURIComponent\(tier\)\}\/\$\{encodeURIComponent\(scopeId\)\}\$\{pathSuffix/.test(appJs) || /personaDraftServiceUrl/.test(approveBody),
    "approveDraft() builds its URL via the shared draft-service URL helper (pu-03's route, not invented)");
  ok(/method:\s*["'`]POST["'`]/.test(approveBody), "approveDraft() POSTs (method: \"POST\")");
  ok(/["'`]\/approve["'`]/.test(appJs), "the approve route's /approve suffix appears in ui/app.js");
  ok(/window\.confirm\(/.test(approveBody), "approveDraft() requires window.confirm() before firing");
  ok(/cannot be undone from here/.test(approveBody),
    "approve confirm copy is specific and descriptive, not a bare \"Are you sure?\"");

  const discardDefMatch = appJs.match(/async function discardDraft\([\s\S]*?\n\}\n/);
  const discardBody = discardDefMatch ? discardDefMatch[0] : "";
  ok(discardBody.length > 0, "discardDraft() function body was extracted for inspection");
  ok(/method:\s*["'`]DELETE["'`]/.test(discardBody), "discardDraft() DELETEs (method: \"DELETE\")");
  ok(/window\.confirm\(/.test(discardBody), "discardDraft() requires window.confirm() before firing");
  ok(/archived, not deleted/.test(discardBody),
    "discard confirm copy is specific and descriptive, not a bare \"Are you sure?\"");

  // No client-side simulation anywhere in either function -- both really
  // fetch(), never just mutate local state and pretend.
  ok(/await fetch\(/.test(approveBody), "approveDraft() really calls fetch() -- not a client-side simulation");
  ok(/await fetch\(/.test(discardBody), "discardDraft() really calls fetch() -- not a client-side simulation");

  // --- approve success calls BOTH loadDrafts() AND loadPersonas() (pw-03's
  // existing, UNCHANGED function) -- no reimplementation, no page reload ---
  ok(/loadDrafts\(\),\s*loadPersonas\(\)/.test(approveBody) || (/loadDrafts\(\)/.test(approveBody) && /loadPersonas\(\)/.test(approveBody)),
    "approveDraft() success path calls BOTH loadDrafts() and loadPersonas()");
  ok(!/location\.reload/.test(approveBody), "approveDraft() never triggers a manual page reload");
  // loadPersonas() itself is referenced, never redefined -- exactly one
  // definition in the whole file (pw-03's function, reused unchanged).
  const loadPersonasDefCount = (appJs.match(/async function loadPersonas\(\)/g) || []).length;
  ok(loadPersonasDefCount === 1,
    `exactly one loadPersonas() function definition (found ${loadPersonasDefCount}) -- approveDraft() calls it, never reimplements it`);

  // --- discard removes the draft from the active list on success (via
  // loadDrafts(), which re-renders through the SAME renderPersonas() -- a
  // discarded draft is simply absent from the next GET /persona/draft
  // response, so it drops out of mergedPersonaRows() automatically) --------
  ok(/loadDrafts\(\)/.test(discardBody), "discardDraft() success path calls loadDrafts() to refresh the active list");
  ok(!/location\.reload/.test(discardBody), "discardDraft() never triggers a manual page reload");

  // --- aria-live announcements for approve/discard outcomes ----------------
  ok(/personasLiveRegionEl\.textContent = `Approved/.test(approveBody),
    "approveDraft() announces success via the aria-live region");
  ok(/personasLiveRegionEl\.textContent = `Discarded/.test(discardBody),
    "discardDraft() announces success via the aria-live region");

  // --- keyboard operability: every new interactive element is a real
  // <button type="button">, never a div/span+onclick, never `disabled` -----
  const actionsDefMatch = appJs.match(/function buildPersonaActionsAndDetail\([\s\S]*?\n\}\n/);
  const actionsBody = actionsDefMatch ? actionsDefMatch[0] : "";
  ok(actionsBody.length > 0, "buildPersonaActionsAndDetail() function body was extracted for inspection");
  const newDraftUiCode = [actionsBody, detailRowBody].join("\n");
  const newButtonCount = (newDraftUiCode.match(/document\.createElement\(["'`]button["'`]\)/g) || []).length;
  ok(newButtonCount >= 5,
    `pu-12's new draft UI creates at least 5 real <button> elements (Review/Edit toggle, gate, edit, approve, discard) -- found ${newButtonCount}`);
  ok((newDraftUiCode.match(/\.type = ["'`]button["'`]/g) || []).length === newButtonCount,
    "every button pu-12 creates is explicitly type=\"button\" (never a bare <button> defaulting to submit inside the form)");
  ok(!/\.disabled\s*=\s*true/.test(newDraftUiCode),
    "no new draft-UI control is ever gated by a `disabled` attribute (accessibility.md's named anti-pattern) -- gating is structural (not rendered) instead");

  // aria-expanded/aria-controls on the Review toggle, and focus moves to the
  // detail panel's first heading on expand (accessibility.md: "None of the
  // three options fully solves focus management on expand/collapse").
  ok(/aria-expanded/.test(actionsBody) && /aria-controls/.test(actionsBody),
    "the Review/Hide toggle button carries aria-expanded/aria-controls");
  ok(/focusTarget\.focus\(\)/.test(actionsBody),
    "expanding a draft's detail panel moves real DOM focus to it (not left floating)");

  // The one-time read-before-edit gate is enforced structurally (controls
  // simply aren't in the DOM/aren't revealed until read), never via a
  // `disabled` attribute on an always-rendered Approve/Discard pair.
  ok(/gateBtn\.hidden = alreadyRead/.test(detailRowBody) && /controls\.hidden = !alreadyRead/.test(detailRowBody),
    "Approve/Discard controls stay hidden until the read-only gate (\"I've read this — enable editing\") has been passed this session");
  ok(/readDraftIdentities/.test(detailRowBody),
    "the read gate is tracked via the session-scoped readDraftIdentities Set, not a per-render-reset flag");

  // --- Discard's confirm-then-DELETE never fires the DELETE without the
  // confirm returning true first (structural check: window.confirm(...) is
  // the guard for the whole rest of the function body, i.e. an early
  // `if (!confirmed) return;` precedes the fetch call) -----------------------
  const discardConfirmGuard = /const confirmed = window\.confirm\([\s\S]*?\);\s*\n\s*if \(!confirmed\) return;/.test(discardBody);
  ok(discardConfirmGuard, "discardDraft() has an explicit early return when window.confirm() is declined -- DELETE never fires without confirmation");
  const approveConfirmGuard = /const confirmed = window\.confirm\([\s\S]*?\);\s*\n\s*if \(!confirmed\) return;/.test(approveBody);
  ok(approveConfirmGuard, "approveDraft() has an explicit early return when window.confirm() is declined -- POST never fires without confirmation");

  // --- refreshAll() picks up loadDrafts() too (manual-refresh-only
  // convention, matching loadPersonas()/loadPersonaLayerStack()) -----------
  const refreshAllMatch = appJs.match(/async function refreshAll\(\)\s*\{[\s\S]*?\n\}\n/);
  const refreshAllBody = refreshAllMatch ? refreshAllMatch[0] : "";
  ok(/loadDrafts\(\),/.test(refreshAllBody), "refreshAll() calls loadDrafts()");
  ok(/loadPersonas\(\),/.test(refreshAllBody), "refreshAll() still calls loadPersonas()");

  // --- Direct source-file read too (belt-and-suspenders vs. the served
  // copy above, matching this repo's established convention) --------------
  const appJsOnDisk = await readFile(path.join(__dirname, "..", "ui", "app.js"), "utf8");
  const indexHtmlOnDisk = await readFile(path.join(__dirname, "..", "ui", "index.html"), "utf8");
  ok(appJsOnDisk === appJs, "served ui/app.js matches the on-disk source exactly (no build step in between)");
  ok(indexHtmlOnDisk.includes(indexBody.trim()) || indexBody.includes(indexHtmlOnDisk.trim()),
    "served GET /ui body matches the on-disk ui/index.html source");
} finally {
  if (fails) console.log("\n--- server output (for debugging) ---\n" + serverOutput);
  child.kill();
}

console.log(fails ? `\n${fails} check(s) failed` : "\nall persona-draft-review-approve-ui checks passed");
process.exit(fails ? 1 : 0);
