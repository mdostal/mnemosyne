// persona-layer-stack-shell-integration.mjs — TDD tests for
// pu-11-layer-stack-integration-redesign: re-homing pw-04's
// #persona-layer-stack section into pu-10's new Personas panel shell.
//
// This story adds no new backend route and does not touch
// loadPersonaLayerStack()'s fetch logic at all (GET /layers,
// mnemosyneClientApiBase()) -- it only moves the section's markup so it
// sits inside pu-10's rebuilt #personas shell (horizontal-plan.md H7
// component 2: "pu-11 depends on pu-10 (extends its shell)"), while staying
// a clearly-labeled, visually distinct section from the persona list --
// never merged into #personas-table/#personas-tbody's unified queue
// (research-brief.md §6's already-established boundary).
//
// Matching test/persona-layer-stack.mjs's and test/personas-panel-shell.mjs's
// established convention: this repo has no DOM-rendering/jsdom test harness,
// so this file does static-assertion checks against the real served
// ui/index.html and ui/app.js (spawning src/server.mjs, the UI's own static
// file server).
//
// Usage: node test/persona-layer-stack-shell-integration.mjs
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, "..", "src", "server.mjs");
const PORT = Number(process.env.MNEMOSYNE_TEST_PORT || 8506);
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

  // --- structural re-home: #persona-layer-stack is now NESTED inside
  // #personas (pu-10's shell), not a sibling <section> that follows it -----
  const personasIdx = indexBody.indexOf('<section id="personas"');
  ok(personasIdx !== -1, "GET /ui body has a <section id=\"personas\"> block");
  const afterPersonas = indexBody.slice(personasIdx);

  const layerStackRelIdx = afterPersonas.indexOf('<section id="persona-layer-stack"');
  ok(layerStackRelIdx !== -1, "GET /ui body still has a <section id=\"persona-layer-stack\"> block");

  const closeRe = /<\/section>/g;
  const closeIdxs = [];
  let m;
  while ((m = closeRe.exec(afterPersonas))) closeIdxs.push(m.index);
  ok(closeIdxs.length >= 2,
    `at least two </section> closes found after #personas opens -- one for the nested #persona-layer-stack, one for #personas itself (found ${closeIdxs.length})`);

  const firstClose = closeIdxs[0];
  ok(
    layerStackRelIdx !== -1 && firstClose !== undefined && layerStackRelIdx < firstClose,
    "#persona-layer-stack opens BEFORE the first </section> closes after #personas -- it is nested INSIDE pu-10's #personas shell, not a sibling section placed after it (this is the actual pu-11 re-home, not just a passthrough)",
  );

  // The full, self-contained layer-stack section markup, for the checks below.
  const layerStackSection = firstClose !== undefined
    ? afterPersonas.slice(layerStackRelIdx, firstClose + "</section>".length)
    : "";
  ok(layerStackSection.length > 0, "extracted the nested #persona-layer-stack section's own markup for inspection");

  // --- still a clearly-labeled, visually distinct section -- never merged
  // into #personas-table/#personas-tbody's unified queue list --------------
  // Heading text: ml-05-memory-levels-ui (reconciled during the combined
  // v0.10.0 release merge) renamed this section from "Memory Layer Stack"
  // to "Retrieval Layer Stack", to disambiguate it from the new sibling
  // "Memory Levels (0-4)" section -- this ticket's own actual concern was
  // the section staying structurally distinct (checked below), not the
  // specific wording, so this assertion tracks the real, reconciled text.
  ok(/<h[2-6]>Retrieval Layer Stack<\/h[2-6]>/.test(layerStackSection),
    "the re-homed section keeps its own distinct heading, \"Retrieval Layer Stack\" (renamed post-merge from \"Memory Layer Stack\") -- not folded into the Personas heading/list");
  ok(
    /id="persona-layer-stack-table"/.test(layerStackSection) && /id="persona-layer-stack-tbody"/.test(layerStackSection),
    "the re-homed section renders into its own table/tbody (#persona-layer-stack-table/#persona-layer-stack-tbody)",
  );
  ok(
    !/id="personas-table"|id="personas-tbody"/.test(layerStackSection),
    "the re-homed section's own markup never references #personas-table/#personas-tbody -- not merged into the persona list",
  );
  ok(
    !/<section id="persona-layer-stack"[\s\S]*<section id="persona-layer-stack"/.test(indexBody),
    "#persona-layer-stack appears exactly once (re-homed, not duplicated)",
  );

  // --- no hard-coded 0/1/2/3/4 level-number reference tied to layer
  // semantics anywhere in this ticket's copy/labels (design-discussion.md
  // OQ1) -- "Level 0" is the one carried-forward, explicitly-allowed
  // exception (Epic 1's original recommendation, not relitigated here).
  // Reconciled during the combined v0.10.0 release merge: the sibling
  // mnemosyne-memory-levels epic's "Memory Levels (0-4)" section DID ship
  // for real (ml-05), and this section's own hint text now honestly
  // cross-references it BY NAME ("see the separate 'Memory Levels (0-4)'
  // section below") -- that specific, real cross-reference is intentional
  // and correct, not the "implying not-yet-shipped numbering as already
  // live" problem OQ1 originally guarded against. Stripped out here before
  // scanning so the remaining checks still catch any OTHER, unscoped 0-4
  // claim (e.g. this section's own rows mislabeling themselves as the
  // canonical levels) -----------------------------------------------------
  const scannedForNumbering = layerStackSection
    .replace(/Level 0/g, "")
    .replace(/Memory Levels \(0-4\)/g, "");
  ok(
    !/\bLevel\s*[1234]\b/i.test(scannedForNumbering) && !/\bLayer\s*[1234]\b/i.test(scannedForNumbering),
    "no hard-coded \"Level 1-4\" / \"Layer 1-4\" copy anywhere in the re-homed section outside the honest \"Memory Levels (0-4)\" cross-reference",
  );
  ok(
    !/0[\s-]*(to|-)[\s-]*4/i.test(scannedForNumbering),
    "no \"0-4\" / \"0 to 4\" numbering-range copy anywhere in the re-homed section OTHER than the honest \"Memory Levels (0-4)\" cross-reference to the real, shipped sibling section",
  );
  ok(/<th>#<\/th>/.test(layerStackSection),
    "the cascade-position column stays labeled plain \"#\" (an ordinal, not a semantic level claim) -- never relabeled \"Level\"");
  ok(/<th>Layer<\/th>/.test(layerStackSection) && /<th>Writable<\/th>/.test(layerStackSection),
    "table columns render exactly what GET /layers returns today -- layer name + writable boolean, nothing invented");

  // --- Level 0 pointer stays view-only with zero edit affordance, carried
  // forward unchanged through the re-home (not relitigated by this ticket) -
  ok(/~\/\.mnemosyne\/level0-rules\.md/.test(layerStackSection),
    "the Level 0 path pointer survived the re-home");
  ok(
    !/level0[\s\S]{0,300}?<(form|input|button|textarea)/i.test(layerStackSection) &&
      !/<(form|input|button|textarea)[^>]*level0/i.test(layerStackSection),
    "no edit form/input/button/textarea anywhere near the re-homed Level 0 pointer",
  );
  ok(
    !/edit[^<]{0,40}level0|level0[^<]{0,40}edit/i.test(layerStackSection),
    "no \"edit\" wording paired with the re-homed Level 0 pointer",
  );

  // --- served ui/app.js: loadPersonaLayerStack() reused, not duplicated,
  // not rebuilt -- fetch logic (GET /layers, mnemosyneClientApiBase())
  // completely unchanged; only DOM-target wiring may have moved -----------
  const appJs = await (await fetch(BASE + "/ui/app.js")).text();

  // Strip //-comment lines first so prose mentioning the function name in a
  // doc comment can't inflate this count -- only real code references count.
  const appJsCodeOnly = appJs
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
  const refCount = (appJsCodeOnly.match(/loadPersonaLayerStack\(/g) || []).length;
  ok(refCount === 2,
    `loadPersonaLayerStack referenced exactly twice in ui/app.js's real code -- one definition + one call site, never duplicated or rebuilt (found ${refCount})`);

  const refreshAllMatch = appJs.match(/async function refreshAll\(\)\s*\{[\s\S]*?\n\}\n/);
  const refreshAllBody = refreshAllMatch ? refreshAllMatch[0] : "";
  ok(/loadPersonaLayerStack\(\),/.test(refreshAllBody),
    "refreshAll() still calls loadPersonaLayerStack() exactly as before");

  ok(/fetch\(mnemosyneClientApiBase\(\) \+ ["'`]\/layers["'`]\)/.test(appJs),
    "loadPersonaLayerStack() still fetches GET /layers via mnemosyneClientApiBase() -- fetch logic byte-for-byte unchanged");
  ok(/function mnemosyneClientApiBase\(\)/.test(appJs),
    "mnemosyneClientApiBase() helper is still present, unchanged");
  ok(
    !/\/layer-stack\b|\/persona-layers\b|\/layers\/config\b/.test(appJs),
    "ui/app.js still never invents a new layer-stack-specific route -- only the existing GET /layers",
  );

  // No hard-coded level numbering in ui/app.js either (belt-and-suspenders
  // against the same OQ1 gate, on the JS side).
  const loadFnMatch = appJs.match(/async function loadPersonaLayerStack\(\)\s*\{[\s\S]*?\n\}\n/);
  const loadFnBody = loadFnMatch ? loadFnMatch[0] : "";
  ok(loadFnBody.length > 0, "loadPersonaLayerStack() function body was extracted for inspection");
  ok(!/["'`]Level\s*[1234]["'`]/i.test(loadFnBody) && !/["'`]Layer\s*[1234]["'`]/i.test(loadFnBody),
    "loadPersonaLayerStack() never hard-codes a \"Level/Layer 1-4\" string literal");

  // Direct source-file read too (belt-and-suspenders vs. the served copy
  // above, matching this repo's established convention).
  const appJsOnDisk = await readFile(path.join(__dirname, "..", "ui", "app.js"), "utf8");
  const indexHtmlOnDisk = await readFile(path.join(__dirname, "..", "ui", "index.html"), "utf8");
  ok(appJsOnDisk === appJs, "served ui/app.js matches the on-disk source exactly (no build step in between)");
  ok(indexHtmlOnDisk.includes(indexBody.trim()) || indexBody.includes(indexHtmlOnDisk.trim()),
    "served GET /ui body matches the on-disk ui/index.html source");
} finally {
  if (fails) console.log("\n--- server output (for debugging) ---\n" + serverOutput);
  child.kill();
}

console.log(fails ? `\n${fails} check(s) failed` : "\nall persona-layer-stack-shell-integration checks passed");
process.exit(fails ? 1 : 0);
