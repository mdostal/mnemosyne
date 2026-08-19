// personas-panel-shell.mjs — TDD tests for pu-10-personas-panel-redesign-shell:
// the Personas panel's structural shell rebuild, per pu-01's chosen synthesized
// option (.pHive/design/mnemosyne-persona-ux/selection.md ->
// synthesized/option-2.md, "Trust-Gated Unified Queue").
//
// This ticket is a pure view-layer rebuild: it reuses loadPersonas()'s
// existing fetch logic (GET /persona + one GET /persona/:tier/:scopeId per
// entry, personaServiceOrigin()'s cross-origin pattern) completely unchanged,
// and only changes how the result is rendered/organized (group-by
// Tier/Repo/Status, a status filter, sticky group headers, real cell-text
// status, an interactive-but-still-pointer-only parentRefs anchor, and a
// glossary block) -- no new backend route, no draft fetch (that's
// pu-12-draft-review-approve-ui's job).
//
// Matching test/persona-write-form.mjs's and test/persona-layer-stack.mjs's
// established convention: this repo has no DOM-rendering/jsdom test harness,
// so this file does static-assertion checks against the real served
// ui/index.html and ui/app.js (spawning src/server.mjs, the UI's own static
// file server) rather than executing app.js in a browser-like environment.
//
// Usage: node test/personas-panel-shell.mjs
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, "..", "src", "server.mjs");
const PORT = Number(process.env.MNEMOSYNE_TEST_PORT || 8504);
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

  const personasSectionMatch = indexBody.match(/<section id="personas"[\s\S]*?<\/section>\s*\n\s*<!--[\s\S]*?pw-04|<section id="personas"[\s\S]*?<\/section>/);
  ok(!!personasSectionMatch, "GET /ui body has a <section id=\"personas\"> block");
  const personasSection = personasSectionMatch ? personasSectionMatch[0] : "";

  // --- outer shape unchanged: section -> h2 -> panel-status -> table
  // (selection.md/synthesized option-2.md §1: "#personas keeps its existing
  // ... shape unchanged at the outer level") -----------------------------
  ok(/<h2>Personas<\/h2>/.test(personasSection), "panel keeps its <h2>Personas</h2> heading");
  ok(/<p class="panel-status" id="personas-status">/.test(personasSection),
    "panel keeps its existing personas-status element");
  ok(/<table id="personas-table">/.test(personasSection) && /<tbody id="personas-tbody">/.test(personasSection),
    "panel keeps ONE #personas-table/#personas-tbody -- grouping happens inside it, not via a second table per group");

  // --- new toolbar: group-by radiogroup (the existing .mode-toggle idiom,
  // never an invented chip/tab widget) + status <select> (the existing
  // native-select-as-filter idiom) -----------------------------------------
  ok(/role="radiogroup"[^>]*aria-label="group personas by"/.test(personasSection),
    "toolbar has a role=\"radiogroup\" group-by control (mode-toggle idiom), not an invented chip widget");
  ok(
    /<input type="radio" name="personas-group-by" value="tier" checked/.test(personasSection) &&
      /<input type="radio" name="personas-group-by" value="repo"/.test(personasSection) &&
      /<input type="radio" name="personas-group-by" value="status"/.test(personasSection),
    "group-by radiogroup offers Tier (default), Repo, Status",
  );
  ok(/<select id="personas-status-filter">/.test(personasSection),
    "toolbar has a native <select id=\"personas-status-filter\"> -- not a clickable-chip widget");
  ok(
    /<option value="all">All<\/option>/.test(personasSection) &&
      /<option value="live">Live<\/option>/.test(personasSection) &&
      /<option value="needs-review" selected>Needs review<\/option>/.test(personasSection) &&
      /<option value="history">History<\/option>/.test(personasSection),
    "status filter offers All/Live/Needs review/History, defaulting to Needs review (puf-01)",
  );

  // --- table columns: Tier/Scope ID/Display name/Parent(s)/Status, status
  // as real cell text (never a bare glyph) ---------------------------------
  ok(
    /<th>Tier<\/th>/.test(personasSection) &&
      /<th>Scope ID<\/th>/.test(personasSection) &&
      /<th>Display name<\/th>/.test(personasSection) &&
      /<th>Parent\(s\)<\/th>/.test(personasSection) &&
      /<th>Status<\/th>/.test(personasSection),
    "table header offers Tier/Scope ID/Display name/Parent(s)/Status columns",
  );

  // --- glossary: addresses onboarding-clarity.md's jargon-problem finding,
  // collapsed by default (native <details>, honestly introduced as new
  // rather than a false claimed precedent) ---------------------------------
  ok(/<details id="personas-glossary">/.test(personasSection),
    "panel has a <details id=\"personas-glossary\"> block");
  ok(/<summary>What do these terms mean\?<\/summary>/.test(personasSection),
    "glossary <summary> asks \"What do these terms mean?\"");
  ok(
    /<dt>tier<\/dt>/.test(personasSection) &&
      /<dt>scopeId<\/dt>/.test(personasSection) &&
      /<dt>Parent\(s\)<\/dt>/.test(personasSection) &&
      /<dt>sourceSummary<\/dt>/.test(personasSection),
    "glossary defines tier/scopeId/Parent(s)/sourceSummary",
  );

  // --- aria-live region for the parent-ref filter self-heal announcement --
  ok(/<p id="personas-live-region" class="sr-only" aria-live="polite">/.test(personasSection),
    "panel has an aria-live=\"polite\" region for parent-ref filter-reset announcements");

  // --- empty-state element (populated vs. empty GET /persona) -------------
  ok(/<p class="panel-status" id="personas-empty" hidden>/.test(personasSection),
    "panel has a dedicated empty-state element (id=\"personas-empty\")");

  // --- the old #persona-form (pw-17) stays intact: this ticket rebuilds the
  // LIST above, and deliberately does not remove or partially rewire the
  // create/edit form ahead of pu-12's explicit job of retargeting it into
  // the new draft-propose accordion (horizontal-plan.md H7 component 3) --
  ok(/<form id="persona-form">/.test(personasSection),
    "the pre-existing #persona-form is left intact (pu-12's explicit job to retarget, not this ticket's)");

  // --- served ui/app.js: rendering logic --------------------------------
  const appJs = await (await fetch(BASE + "/ui/app.js")).text();

  // loadPersonas() is REUSED, not duplicated: exactly one function of that
  // name, still doing the same two fetches (GET /persona, then GET
  // /persona/:tier/:scopeId per listed entry) via personaServiceOrigin().
  //
  // puf-04-repo-scoped-personas-reachable: the per-entry fetch's URL is now
  // built as a plain `?repo=`-less template for an entry with no `repo`
  // (byte-identical to every entry before this ticket, since GET /persona's
  // list response never carries a `repo` field -- see persona-store-
  // global.ts's listGlobalPersonas) OR the same template plus `?repo=` for
  // an entry this ticket's own repo-scoped fetch tagged with one -- this
  // regex (loosened from pu-10's original exact-fetch-call check, which
  // predates ?repo= existing at all) still asserts the untagged branch's
  // URL template is exactly unchanged, just no longer requires it be the
  // literal sole argument to fetch().
  const loadPersonasDefCount = (appJs.match(/async function loadPersonas\(\)/g) || []).length;
  ok(loadPersonasDefCount === 1,
    `exactly one loadPersonas() function definition (found ${loadPersonasDefCount})`);
  ok(/fetch\(`\$\{origin\}\/persona`\)/.test(appJs),
    "loadPersonas() still fetches GET /persona (unchanged)");
  ok(/:\s*`\$\{origin\}\/persona\/\$\{encodeURIComponent\(entry\.tier\)\}\/\$\{encodeURIComponent\(entry\.scopeId\)\}`\s*;[\s\S]{0,120}?fetch\(url\)/.test(appJs),
    "loadPersonas() still fetches GET /persona/:tier/:scopeId per listed entry (?repo=-less URL unchanged for a non-repo-scoped entry)");
  ok(/const origin = personaServiceOrigin\(\);/.test(appJs),
    "loadPersonas() still uses personaServiceOrigin()'s cross-origin pattern");

  // Exactly one function builds rows into personasTbodyEl (grep-checkable,
  // matching persona-write-form.mjs's own established convention for this
  // exact guard) -- proves grouping/rendering didn't fork into a second,
  // divergent row-building path.
  const rowBuilders = (appJs.match(/personasTbodyEl\.appendChild/g) || []).length;
  ok(rowBuilders === 1,
    `exactly one place appends rows to personasTbodyEl (found ${rowBuilders})`);
  ok(!/function\s+loadPersonas2\b|function\s+loadPersonaForm\b/.test(appJs),
    "no rebuilt second persona-list loader function exists");

  // renderPersonas() exists exactly once, and is a PURE render (no fetch
  // inside it) -- group-by/status-filter changes re-bucket already-fetched
  // rows client-side, never re-fetching (selection.md §1).
  const renderDefCount = (appJs.match(/function renderPersonas\(\)\s*\{/g) || []).length;
  ok(renderDefCount === 1, `exactly one renderPersonas() function definition (found ${renderDefCount})`);
  const renderBodyMatch = appJs.match(/function renderPersonas\(\)\s*\{[\s\S]*?\n\}\n/);
  const renderBody = renderBodyMatch ? renderBodyMatch[0] : "";
  ok(renderBody.length > 0, "renderPersonas() function body was extracted for inspection");
  ok(!/fetch\(/.test(renderBody), "renderPersonas() never calls fetch() -- pure client-side re-render");

  // loadPersonas() calls renderPersonas() once it has data (the fetch/render
  // split this ticket's spec requires) --------------------------------------
  const loadBodyMatch = appJs.match(/async function loadPersonas\(\)\s*\{[\s\S]*?\n\}\n/);
  const loadBody = loadBodyMatch ? loadBodyMatch[0] : "";
  ok(/renderPersonas\(\);/.test(loadBody), "loadPersonas() calls renderPersonas() after a successful fetch");

  // group-by/status-filter controls re-render only, never re-fetch --------
  ok(/personasStatusFilterEl\.addEventListener\(\s*["'`]change["'`]\s*,\s*renderPersonas\s*\)/.test(appJs),
    "status-filter <select> change listener calls renderPersonas() directly (no re-fetch)");
  ok(/name="personas-group-by"\][^)]*\)\.forEach\([\s\S]{0,120}addEventListener\(\s*["'`]change["'`]\s*,\s*renderPersonas\s*\)/.test(appJs),
    "group-by radiogroup's change listener calls renderPersonas() directly (no re-fetch)");

  // populated vs. empty rendering: renderPersonas() has distinct branches
  // for zero total personas vs. zero personas matching the active filter
  // (this repo's static-assertion convention's equivalent of "renders
  // correctly against a populated GET /persona response and an empty one") -
  ok(/No personas yet\./.test(renderBody), "renderPersonas() has a distinct zero-personas-total empty state");
  ok(/No personas match the current filter\./.test(renderBody),
    "renderPersonas() has a distinct zero-after-filter empty state, not conflated with the zero-total case");

  // status is always real cell text, never a bare glyph --------------------
  ok(
    /case "needs-review":\s*\n\s*return "needs review";/.test(appJs) &&
      /case "needs-review-update":\s*\n\s*return "needs review — updates existing persona";/.test(appJs) &&
      /case "history":\s*\n\s*return "history";/.test(appJs),
    "status label function returns full-word text, never a Unicode glyph",
  );
  ok(!/[●◐]/.test(appJs), "no status glyph characters (●/◐) anywhere in ui/app.js");

  // parentRefs pointer-only guarantee, ported forward carefully: never a
  // fetch anywhere near parentRefs, and the new interactive pointer never
  // fetches either ----------------------------------------------------------
  ok(/function parentRefsText\(parentRefs\)/.test(appJs), "parentRefsText() is still present (ported forward, not rewritten from scratch)");
  ok(!/fetch\([^)]*parentRefs/i.test(appJs),
    "no fetch() call anywhere references parentRefs -- pointer-only guarantee holds");
  const parentCellMatch = appJs.match(/function personaParentCell\([\s\S]*?\n\}\n/);
  const parentCellBody = parentCellMatch ? parentCellMatch[0] : "";
  ok(parentCellBody.length > 0, "personaParentCell() function body was extracted for inspection");
  ok(!/fetch\(/.test(parentCellBody), "personaParentCell() never calls fetch() -- still pointer-only, just an interactive pointer");
  const jumpMatch = appJs.match(/function jumpToPersonaRow\([\s\S]*?\n\}\n/);
  const jumpBody = jumpMatch ? jumpMatch[0] : "";
  ok(jumpBody.length > 0, "jumpToPersonaRow() function body was extracted for inspection");
  ok(!/fetch\(/.test(jumpBody), "jumpToPersonaRow() never calls fetch() -- moves focus among already-loaded rows only");

  // --- keyboard reachability of every new interactive element: real,
  // natively-focusable elements, never a div/span+onclick, never gated by a
  // `disabled` attribute (accessibility.md's named anti-pattern) -----------
  ok(!/<input type="radio" name="personas-group-by"[^>]*disabled/.test(personasSection),
    "group-by radios are never disabled");
  ok(!/<select id="personas-status-filter">[\s\S]*?<\/select>[\s\S]{0,0}/.test(personasSection) || !/id="personas-status-filter"\s+disabled/.test(personasSection),
    "status filter <select> is never disabled");
  ok(/document\.createElement\("button"\)/.test(appJs) && /btn\.type = "button";/.test(appJs),
    "parent-ref pointer is a real <button type=\"button\">, not a div/span with a click handler");
  ok(/btn\.className = "persona-parent-link";/.test(appJs) && !/persona-parent-link[\s\S]{0,80}disabled/.test(appJs),
    "parent-ref pointer button is never disabled -- reachable in the normal tab order");
  ok(!/class="persona-parent-link"[^>]*href="#"/.test(appJs),
    "parent-ref pointer is never an href=\"#\" anchor (nothing to navigate to, only focus to move)");

  // --- shell participates in refreshAll()'s existing manual-refresh-only
  // convention: still called from refreshAll(), no new setInterval/
  // setTimeout polling introduced anywhere in the persona rendering code ---
  const refreshAllMatch = appJs.match(/async function refreshAll\(\)\s*\{[\s\S]*?\n\}\n/);
  const refreshAllBody = refreshAllMatch ? refreshAllMatch[0] : "";
  ok(/loadPersonas\(\),/.test(refreshAllBody), "refreshAll() still calls loadPersonas()");
  const personasSectionOfJs = appJs.slice(
    appJs.indexOf("// --- pu-10-personas-panel-redesign-shell"),
    appJs.indexOf("async function loadPersonaLayerStack()"),
  );
  ok(personasSectionOfJs.length > 0, "pu-10's own section of ui/app.js was located for inspection");
  ok(!/setInterval\(|setTimeout\(/.test(personasSectionOfJs),
    "no setInterval/setTimeout (auto-polling) introduced anywhere in pu-10's rendering code");

  // Direct source-file read too (belt-and-suspenders vs. the served copy
  // above, same double-check convention as test/persona-write-form.mjs).
  const appJsOnDisk = await readFile(path.join(__dirname, "..", "ui", "app.js"), "utf8");
  const indexHtmlOnDisk = await readFile(path.join(__dirname, "..", "ui", "index.html"), "utf8");
  ok(appJsOnDisk === appJs, "served ui/app.js matches the on-disk source exactly (no build step in between)");
  ok(indexHtmlOnDisk.includes(indexBody.trim()) || indexBody.includes(indexHtmlOnDisk.trim()),
    "served GET /ui body matches the on-disk ui/index.html source");
} finally {
  if (fails) console.log("\n--- server output (for debugging) ---\n" + serverOutput);
  child.kill();
}

console.log(fails ? `\n${fails} check(s) failed` : "\nall personas-panel-shell checks passed");
process.exit(fails ? 1 : 0);
