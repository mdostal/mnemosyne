// jump-chip-nav-status-wiring.mjs — TDD tests for
// ui-03-jump-chip-nav-and-status-wiring: the sticky <nav id="jump-chips">
// bar (ui/index.html) + its live status-propagation wiring (ui/app.js).
//
// Matching test/personas-panel-shell.mjs's and test/persona-write-form.mjs's
// established convention: this repo has no DOM-rendering/jsdom test
// harness. Structural claims (chip markup, panel markup, no-JS-dependency)
// are static-assertion checks against the real served ui/index.html and
// ui/style.css (spawning src/server.mjs). The behavioral claim (a panel's
// real status change propagates to its chip, and a panel with no real
// status line never gets a fabricated ring) is proven by extracting the
// REAL setStatus()/syncJumpChips() function source out of the real,
// on-disk ui/app.js via regex and executing it for real via `new
// Function(...)` against a small hand-built fake DOM -- the exact technique
// test/persona-write-form.mjs already established for this repo.
//
// Usage: node test/jump-chip-nav-status-wiring.mjs
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, "..", "src", "server.mjs");
const PORT = Number(process.env.MNEMOSYNE_TEST_PORT || 8508);
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

// The 9 real top-level panels, in real document order (research-brief.md §1;
// cm-15-discovery-and-pilot-trigger-ui adds discovery-pilot, the newest
// panel, last).
const REAL_PANELS = [
  "liveliness", "settings", "lanes", "search",
  "graph", "operations", "personas", "memory-levels", "discovery-pilot",
];

// Panels whose chip IS expected to be ring-eligible after a real refreshAll()
// -- see ui/app.js's CHIP_STATUS_SOURCE comment for exactly why each of
// these, and only these, qualifies (a real, unconditional, refresh-time
// .panel-status element) and why search/operations/discovery-pilot are
// excluded.
const EXPECTED_RING_ELIGIBLE = ["liveliness", "settings", "lanes", "graph", "personas", "memory-levels"];
const EXPECTED_NEVER_RING = ["search", "operations", "discovery-pilot"];

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

  // ======================================================================
  // 1. #jump-chips exists, directly under <header>, with exactly 9 real
  //    anchor links, one per real panel, in document order.
  // ======================================================================
  const navMatch = indexBody.match(/<nav id="jump-chips"[\s\S]*?<\/nav>/);
  ok(!!navMatch, "GET /ui body has a <nav id=\"jump-chips\"> element");
  const navHtml = navMatch ? navMatch[0] : "";

  const headerCloseIdx = indexBody.indexOf("</header>");
  const navIdx = indexBody.indexOf('<nav id="jump-chips"');
  ok(headerCloseIdx > -1 && navIdx > headerCloseIdx, "#jump-chips comes directly after </header> in document order");
  const mainOpenIdx = indexBody.indexOf("<main>");
  ok(mainOpenIdx > -1 && navIdx < mainOpenIdx, "#jump-chips comes before <main> (it's a nav bar, not inside the panel grid)");

  const chipMatches = [...navHtml.matchAll(/<a href="#([a-z-]+)">/g)].map((m) => m[1]);
  ok(chipMatches.length === 9, `#jump-chips has exactly 9 <a href="#..."> chips (found ${chipMatches.length})`);
  ok(
    JSON.stringify(chipMatches) === JSON.stringify(REAL_PANELS),
    `#jump-chips chips are the 9 real panels in real document order (got ${JSON.stringify(chipMatches)})`,
  );

  // Every chip's target id is a real <section id="..."> in the document.
  for (const panelId of REAL_PANELS) {
    const hasSection = new RegExp(`<section id="${panelId}"[^>]*class="panel`).test(indexBody);
    ok(hasSection, `chip target #${panelId} is a real <section id="${panelId}" class="panel..."> in the document`);
  }

  // No fabricated chip-pass/chip-fail baked into the static HTML itself --
  // those are only ever added at runtime by syncJumpChips(), from real
  // rendered status, never hardcoded server-side.
  ok(!/class="chip-(pass|fail)"/.test(navHtml), "no chip-pass/chip-fail class is hardcoded in the static served markup");

  // ======================================================================
  // 2. No-JS-dependency: literally strip the <script src="/ui/app.js">
  //    tag out of the served HTML and confirm every panel and every chip
  //    is still fully present and functional as plain markup.
  // ======================================================================
  const scriptTagMatch = indexBody.match(/<script src="\/ui\/app\.js"[^>]*><\/script>/);
  ok(!!scriptTagMatch, "GET /ui body has the app.js <script> tag (so stripping it below is a real test, not a no-op)");
  const htmlWithScriptStripped = scriptTagMatch ? indexBody.replace(scriptTagMatch[0], "") : indexBody;

  for (const panelId of REAL_PANELS) {
    const hasSection = new RegExp(`<section id="${panelId}"[^>]*class="panel`).test(htmlWithScriptStripped);
    ok(hasSection, `with <script> stripped, <section id="${panelId}"> is still present and visible (no JS created/unhid it)`);
  }
  const chipsAfterStrip = htmlWithScriptStripped.match(/<nav id="jump-chips"[\s\S]*?<\/nav>/)[0];
  const chipHrefsAfterStrip = [...chipsAfterStrip.matchAll(/<a href="#([a-z-]+)">/g)].map((m) => m[1]);
  ok(
    JSON.stringify(chipHrefsAfterStrip) === JSON.stringify(REAL_PANELS),
    "with <script> stripped, all 9 chips are still plain, working #anchor links",
  );
  // None of the chips rely on an onclick/JS handler to function as a link.
  ok(!/onclick=/.test(navHtml), "chips have no onclick attribute -- navigation is plain <a href> only");

  // No CSS anywhere hides .panel by default (which would make visibility
  // JS-load-bearing, exactly the sidebar-glanceable anti-pattern round 2
  // rejected -- horizontal-plan.md's cross-cutting "no panel visibility may
  // depend on JavaScript" rule).
  const styleCss = await (await fetch(BASE + "/ui/style.css")).text();
  ok(
    !/\.panel\s*\{[^}]*display:\s*none/s.test(styleCss) && !/\.panel\s*\{[^}]*visibility:\s*hidden/s.test(styleCss),
    "ui/style.css never sets display:none or visibility:hidden on .panel -- every panel is visible from static markup alone",
  );

  // ======================================================================
  // 3. Real, served ui/app.js: status-propagation logic.
  // ======================================================================
  const appJs = await (await fetch(BASE + "/ui/app.js")).text();
  const appJsOnDisk = await readFile(path.join(__dirname, "..", "ui", "app.js"), "utf8");
  ok(appJsOnDisk === appJs, "served ui/app.js matches the on-disk source exactly (no build step in between)");

  const indexHtmlOnDisk = await readFile(path.join(__dirname, "..", "ui", "index.html"), "utf8");
  ok(indexHtmlOnDisk.includes(navHtml), "served #jump-chips markup matches the on-disk ui/index.html source");

  // CHIP_STATUS_SOURCE exists exactly once, and maps exactly the 6 panels
  // with a real, refresh-time .panel-status -- never Search or Operations.
  const mapDefCount = (appJs.match(/const CHIP_STATUS_SOURCE = \{/g) || []).length;
  ok(mapDefCount === 1, `exactly one CHIP_STATUS_SOURCE definition (found ${mapDefCount})`);
  const mapMatch = appJs.match(/const CHIP_STATUS_SOURCE = \{([\s\S]*?)\};/);
  const mapBody = mapMatch ? mapMatch[1] : "";
  for (const panelId of EXPECTED_RING_ELIGIBLE) {
    ok(new RegExp(`["']?${panelId}["']?:\\s*"${panelId}-status"`).test(mapBody),
      `CHIP_STATUS_SOURCE maps ${panelId} -> ${panelId}-status`);
  }
  for (const panelId of EXPECTED_NEVER_RING) {
    ok(!new RegExp(`["']?${panelId}["']?:`).test(mapBody),
      `CHIP_STATUS_SOURCE does NOT map ${panelId} (it has no real, unconditional refresh-time .panel-status -- never fabricate)`);
  }

  // syncJumpChips() is called from refreshAll()'s completion path, after
  // the Promise.all(...) of every load*() resolves (H3's own required
  // ordering: mirror only AFTER each panel has rendered its real status).
  const refreshAllMatch = appJs.match(/async function refreshAll\(\)\s*\{[\s\S]*?\n\}\n/);
  const refreshAllBody = refreshAllMatch ? refreshAllMatch[0] : "";
  ok(refreshAllBody.length > 0, "refreshAll() function body was extracted for inspection");
  const promiseAllIdx = refreshAllBody.indexOf("Promise.all(");
  const promiseAllEndIdx = refreshAllBody.indexOf(");", promiseAllIdx);
  const syncCallIdx = refreshAllBody.indexOf("syncJumpChips();");
  ok(
    promiseAllIdx > -1 && syncCallIdx > promiseAllEndIdx,
    "refreshAll() calls syncJumpChips() AFTER its Promise.all(...) of every load*() resolves",
  );

  // The optional scroll-spy is correctly guarded as its OWN, very first
  // executable statement, and never gates syncJumpChips()/core chip
  // wiring behind IntersectionObserver support.
  const spyMatch = appJs.match(/\(function initJumpChipScrollSpy\(\)\s*\{([\s\S]*?)\n\}\)\(\);/);
  ok(!!spyMatch, "initJumpChipScrollSpy() IIFE was extracted for inspection");
  const spyBody = spyMatch ? spyMatch[1] : "";
  const firstStatement = spyBody.trim().split("\n")[0].trim();
  ok(
    firstStatement === 'if (!("IntersectionObserver" in window)) return;',
    `IntersectionObserver guard is the literal first line of the scroll-spy IIFE (got: ${JSON.stringify(firstStatement)})`,
  );
  ok(!/syncJumpChips/.test(spyBody), "the scroll-spy IIFE never calls syncJumpChips() -- core status wiring never depends on IntersectionObserver support");

  // ======================================================================
  // 4. Behavioral proof: extract the REAL setStatus()/syncJumpChips() from
  //    the real on-disk source and execute them for real (new Function
  //    technique, matching test/persona-write-form.mjs's own convention)
  //    against a small fake DOM, to prove real propagation + the
  //    never-fabricate rule under direct, controlled state changes.
  // ======================================================================
  function extractFn(name, src) {
    const re = new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}\\n`);
    const m = src.match(re);
    if (!m) throw new Error(`ui-03 test harness: could not extract function ${name}() from source`);
    return m[0];
  }

  const setStatusSrc = extractFn("setStatus", appJsOnDisk);
  const syncJumpChipsSrc = extractFn("syncJumpChips", appJsOnDisk);
  const chipMapSrc = (appJsOnDisk.match(/const CHIP_STATUS_SOURCE = \{[\s\S]*?\};/) || [""])[0];

  // --- minimal fake DOM ----------------------------------------------------
  class FakeClassList {
    constructor(initial) { this._set = new Set((initial || "").split(/\s+/).filter(Boolean)); }
    add(c) { this._set.add(c); }
    remove(c) { this._set.delete(c); }
    contains(c) { return this._set.has(c); }
    toggle(c, on) { if (on) this._set.add(c); else this._set.delete(c); }
    toString() { return [...this._set].join(" "); }
  }
  class FakeStatusEl {
    constructor() { this._className = ""; this.textContent = ""; }
    get className() { return this._className; }
    set className(v) { this._className = v; this.classList = new FakeClassList(v); }
  }
  class FakeChip {
    constructor(href) { this._href = href; this.classList = new FakeClassList(""); }
    getAttribute(name) { return name === "href" ? this._href : null; }
  }

  const statusEls = {};
  for (const panelId of EXPECTED_RING_ELIGIBLE) {
    const el = new FakeStatusEl();
    el.className = "panel-status"; // fresh/never-loaded state to start
    statusEls[`${panelId}-status`] = el;
  }
  // Real elements that exist in the real DOM but are deliberately NOT in
  // CHIP_STATUS_SOURCE -- included here specifically to prove they're
  // ignored even when populated (the never-fabricate guarantee).
  statusEls["search-status"] = new FakeStatusEl();
  statusEls["reindex-status"] = new FakeStatusEl();
  statusEls["refresh-cache-status"] = new FakeStatusEl();

  const chips = REAL_PANELS.map((id) => new FakeChip(`#${id}`));

  const fakeDocument = {
    getElementById: (id) => statusEls[id] || null,
    querySelectorAll: (sel) => {
      if (sel === "#jump-chips a") return chips;
      return [];
    },
  };

  const buildFns = new Function(
    "document",
    `${setStatusSrc}\n${chipMapSrc}\n${syncJumpChipsSrc}\nreturn { setStatus, syncJumpChips, CHIP_STATUS_SOURCE };`,
  );
  const { setStatus: fakeSetStatus, syncJumpChips: fakeSyncJumpChips, CHIP_STATUS_SOURCE: extractedMap } =
    buildFns(fakeDocument);

  ok(typeof fakeSetStatus === "function" && typeof fakeSyncJumpChips === "function",
    "real setStatus() and syncJumpChips() were extracted and are callable");
  ok(
    JSON.stringify(Object.keys(extractedMap).sort()) === JSON.stringify([...EXPECTED_RING_ELIGIBLE].sort()),
    `extracted CHIP_STATUS_SOURCE has exactly the expected 6 keys (got ${JSON.stringify(Object.keys(extractedMap))})`,
  );

  // --- drive it like a real refreshAll() would: liveliness/settings/lanes
  // pass, graph fails, personas/memory-levels stay mid-"loading" -----------
  fakeSetStatus(statusEls["liveliness-status"], "pass", "PASS — engine reachable");
  fakeSetStatus(statusEls["settings-status"], "pass", "loaded");
  fakeSetStatus(statusEls["lanes-status"], "pass", "3 lane(s)");
  fakeSetStatus(statusEls["graph-status"], "fail", "FAIL — could not reach GET /graph/stats");
  fakeSetStatus(statusEls["personas-status"], "loading", "loading…");
  fakeSetStatus(statusEls["memory-levels-status"], "fail", "FAIL — 1 store degraded");
  // Search/Operations sub-statuses ARE populated here (as they would be if
  // a user had already run a search / reindex earlier in the session) --
  // this is the crux of the never-fabricate proof: chip wiring must ignore
  // them entirely because they aren't in CHIP_STATUS_SOURCE.
  fakeSetStatus(statusEls["search-status"], "pass", "12 hit(s) — hybrid mode");
  fakeSetStatus(statusEls["reindex-status"], "fail", "FAIL — select a lane first");

  fakeSyncJumpChips();

  const chipByHref = Object.fromEntries(chips.map((c) => [c._href.slice(1), c]));

  ok(chipByHref.liveliness.classList.contains("chip-pass") && !chipByHref.liveliness.classList.contains("chip-fail"),
    "liveliness-status=pass -> #liveliness chip gets chip-pass, not chip-fail");
  ok(chipByHref.settings.classList.contains("chip-pass"), "settings-status=pass -> #settings chip gets chip-pass");
  ok(chipByHref.lanes.classList.contains("chip-pass"), "lanes-status=pass -> #lanes chip gets chip-pass");
  ok(chipByHref.graph.classList.contains("chip-fail") && !chipByHref.graph.classList.contains("chip-pass"),
    "graph-status=fail -> #graph chip gets chip-fail (Graph DOES have a real, refresh-time panel-status in this repo's real app.js -- see CHIP_STATUS_SOURCE's comment)");
  ok(!chipByHref.personas.classList.contains("chip-pass") && !chipByHref.personas.classList.contains("chip-fail"),
    "personas-status still \"loading\" (neither pass nor fail class) -> #personas chip gets NEITHER class -- never fabricated");
  ok(chipByHref["memory-levels"].classList.contains("chip-fail"), "memory-levels-status=fail -> #memory-levels chip gets chip-fail");

  // --- the never-fabricate rule, under direct pressure: Search/Operations
  // stay classless even though their OWN sub-status elements are populated,
  // because those elements are never wired into CHIP_STATUS_SOURCE --------
  ok(!chipByHref.search.classList.contains("chip-pass") && !chipByHref.search.classList.contains("chip-fail"),
    "search-status=pass exists in the real DOM but #search is not in CHIP_STATUS_SOURCE -> #search chip gets NEITHER class (never fabricated)");
  ok(!chipByHref.operations.classList.contains("chip-pass") && !chipByHref.operations.classList.contains("chip-fail"),
    "reindex-status=fail exists in the real DOM but #operations is not in CHIP_STATUS_SOURCE -> #operations chip gets NEITHER class (never fabricated)");
  ok(!chipByHref["discovery-pilot"].classList.contains("chip-pass") && !chipByHref["discovery-pilot"].classList.contains("chip-fail"),
    "discovery-status is only ever set by a user action (never refreshAll()) -> #discovery-pilot chip gets NEITHER class (never fabricated)");

  // --- propagation: a real status CHANGE (not just the initial state)
  // propagates to the chip on the next syncJumpChips() call -------------
  fakeSetStatus(statusEls["lanes-status"], "fail", "FAIL — could not reach GET /scopes");
  fakeSyncJumpChips();
  ok(chipByHref.lanes.classList.contains("chip-fail") && !chipByHref.lanes.classList.contains("chip-pass"),
    "a real status change (lanes pass -> fail) propagates: #lanes chip flips from chip-pass to chip-fail");

  fakeSetStatus(statusEls["graph-status"], "pass", "42 node(s), 61 edge(s)");
  fakeSyncJumpChips();
  ok(chipByHref.graph.classList.contains("chip-pass") && !chipByHref.graph.classList.contains("chip-fail"),
    "a real status change (graph fail -> pass) propagates: #graph chip flips from chip-fail to chip-pass");
} finally {
  if (fails) console.log("\n--- server output (for debugging) ---\n" + serverOutput);
  child.kill();
}

console.log(fails ? `\n${fails} check(s) failed` : "\nall jump-chip-nav-status-wiring checks passed");
process.exit(fails ? 1 : 0);
