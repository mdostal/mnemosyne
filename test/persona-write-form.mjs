// persona-write-form.mjs — TDD tests for pw-17-personas-panel-write-form:
// the Personas panel's create/edit form. This closes the
// mnemosyne-persona-wizard epic (Slice 4).
//
// This story adds no new backend route -- it wires a form to the
// ALREADY-SHIPPED POST /persona/:tier/:scopeId route (pw-15) on
// lib/mnemosyne/server.ts. This file's job is the UI side: prove the served
// ui/index.html renders the form with the fields the route's persona
// candidate shape needs (tier, scopeId, displayName, scope, a section
// heading+body, optional repo), prove ui/app.js's submit handler POSTs to
// the right route with the right method and body shape, calls loadPersonas()
// (pw-03's existing function, not a second rendering path) on success, and
// calls setStatus() on both the pass and fail paths -- matching
// test/persona-layer-stack.mjs's and test/graph-route.mjs's established
// convention of static-assertion checks against the real served UI files
// (this repo has no DOM-rendering/jsdom test harness, so this is the
// established convention to follow, not a gap in this file).
//
// Usage: node test/persona-write-form.mjs
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, "..", "src", "server.mjs");
const PORT = Number(process.env.MNEMOSYNE_TEST_PORT || 8503);
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

  // Fields the route's persona-candidate shape needs (persona.ts's
  // assertValidPersona / server.ts's POST /persona/:tier/:scopeId):
  // tier, scopeId, displayName, scope, a section (heading+body), repo.
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

  // --- served ui/app.js: the submit handler ---------------------------------
  const appJs = await (await fetch(BASE + "/ui/app.js")).text();

  ok(/getElementById\(\s*["'`]persona-form["'`]\s*\)/.test(appJs),
    "ui/app.js grabs #persona-form");
  ok(/getElementById\(\s*["'`]persona-form-status["'`]\s*\)/.test(appJs),
    "ui/app.js grabs #persona-form-status");

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

  // POSTs to pw-15's route with the exact expected method + URL shape:
  // `${origin}/persona/${tier}/${scopeId}`, using personaServiceOrigin()'s
  // cross-origin pattern (same one loadPersonas() already uses).
  ok(/personaServiceOrigin\(\)/.test(handler),
    "submit handler uses personaServiceOrigin() -- same cross-origin pattern as loadPersonas()");
  ok(/\/persona\/\$\{encodeURIComponent\(tier\)\}\/\$\{encodeURIComponent\(scopeId\)\}/.test(handler),
    "submit handler builds the URL as /persona/:tier/:scopeId (encoded)");
  ok(/method:\s*["'`]POST["'`]/.test(handler),
    "submit handler POSTs (method: \"POST\")");
  ok(/["'`]content-type["'`]:\s*["'`]application\/json["'`]/.test(handler),
    "submit handler sends content-type: application/json");

  // Body shape: bare persona candidate {tier, scopeId, displayName, scope,
  // sections: [{heading, body}], repo?} -- never mandateSections.
  ok(/sections:\s*\[\s*\{\s*heading:\s*sectionHeading,\s*body:\s*sectionBody\s*\}\s*\]/.test(handler),
    "submit handler's body includes sections: [{heading, body}] (single section, v1 minimum)");
  ok(!/mandateSections/.test(handler),
    "submit handler never sends mandateSections (server-side assertValidPersona rejects mere presence)");
  ok(/JSON\.stringify\(candidate\)/.test(handler),
    "submit handler sends the candidate as the JSON body");

  // On success: loadPersonas() again (pw-03's function, not a rebuilt
  // rendering path) + setStatus() pass.
  ok(/await loadPersonas\(\)/.test(handler),
    "submit handler calls loadPersonas() again on success (pw-03's existing function)");
  ok(/setStatus\(personaFormStatusEl,\s*["'`]pass["'`]/.test(handler),
    "submit handler calls setStatus(..., \"pass\", ...) on success");

  // On failure: setStatus() fail, matching every other form's convention;
  // no second/duplicate persona-rendering path is introduced by this file.
  ok(/setStatus\(personaFormStatusEl,\s*["'`]fail["'`]/.test(handler),
    "submit handler calls setStatus(..., \"fail\", ...) on failure");
  ok((handler.match(/setStatus\(personaFormStatusEl,\s*["'`]fail["'`]/g) || []).length >= 2,
    "submit handler surfaces failure via setStatus() on both the !res.ok path and the catch path");

  // Reuses pw-03's loadPersonas() -- the whole file has exactly one
  // function that appends rows into personasTbodyEl, not two.
  const rowBuilders = (appJs.match(/personasTbodyEl\.appendChild/g) || []).length;
  ok(rowBuilders === 1,
    `exactly one place appends rows to personasTbodyEl (found ${rowBuilders}) -- no second persona-rendering path`);
  // pu-10-personas-panel-redesign-shell deliberately separates loadPersonas()'s
  // FETCH logic (unchanged) from a new renderPersonas() DOM-render function --
  // the exact "reuse the fetch, change only how the result is
  // rendered/organized" split that ticket's own spec requires. A
  // renderPersonas() existing is therefore no longer evidence of a
  // duplicated persona-list loader; loadPersonas2/loadPersonaForm still
  // would be.
  ok(!/function\s+loadPersonas2|function\s+loadPersonaForm\b/.test(appJs),
    "no rebuilt second persona-list loader function exists");

  // Direct source-file read too (belt-and-suspenders vs. the served copy
  // above, same double-check convention as test/persona-layer-stack.mjs).
  const appJsOnDisk = await readFile(path.join(__dirname, "..", "ui", "app.js"), "utf8");
  const indexHtmlOnDisk = await readFile(path.join(__dirname, "..", "ui", "index.html"), "utf8");
  ok(appJsOnDisk === appJs, "served ui/app.js matches the on-disk source exactly (no build step in between)");
  ok(indexHtmlOnDisk.includes(indexBody.trim()) || indexBody.includes(indexHtmlOnDisk.trim()),
    "served GET /ui body matches the on-disk ui/index.html source");
} finally {
  if (fails) console.log("\n--- server output (for debugging) ---\n" + serverOutput);
  child.kill();
}

console.log(fails ? `\n${fails} check(s) failed` : "\nall persona-write-form checks passed");
process.exit(fails ? 1 : 0);
