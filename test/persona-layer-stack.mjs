// persona-layer-stack.mjs — TDD tests for pw-04-layer-stack-visibility:
// the Personas panel's layer-stack visibility sub-section.
//
// This story adds no new backend route -- it's a second loadX()-style call
// against the ALREADY-SHIPPED GET /layers route on lib/mnemosyne/server.ts
// (pl-03-layer-ab-testing), extended by this story only to carry the same
// CORS header pw-02-get-persona-routes-cors already applies to /persona/*
// (see test/http-api.mjs's "GET /layers from <origin>" CORS assertions,
// which cover that piece). This file's job is the UI side: prove the
// served ui/index.html renders a layer-stack section distinct from any
// persona list, prove ui/app.js's loader calls GET /layers (not a new
// route) as a real cross-origin fetch, and prove the static Level 0
// pointer carries no edit affordance anywhere in the served output --
// matching test/graph-route.mjs's and test/reindex-route.mjs's existing
// convention of static-assertion checks against the real served UI files
// (this repo has no DOM-rendering/jsdom test harness, so this is the
// established convention to follow, not a gap in this file).
//
// ml-05-memory-levels-ui (epic mnemosyne-memory-levels) extends this same
// file with two more things, since it's the exact section this story
// touches: (1) the "Memory Layer Stack" heading above is RENAMED to
// "Retrieval Layer Stack" with revised hint copy -- GET /layers and
// loadPersonaLayerStack() stay byte-for-byte unchanged, only the label
// copy moves; and (2) a NEW, structurally separate "Memory Levels (0-4)"
// section is added, fetching ml-04's GET /memory-levels route via a new
// loadMemoryLevels() function. Both sections must carry an explicit
// sentence disambiguating themselves from the team/orchestration tier
// hierarchy (top-orchestrator/company-director/project-orchestrator/
// code-architect) -- design-discussion.md §5.
//
// Usage: node test/persona-layer-stack.mjs
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, "..", "src", "server.mjs");
const PORT = Number(process.env.MNEMOSYNE_TEST_PORT || 8502);
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

  // --- served ui/index.html: layer-stack section exists, distinct from
  // any persona list, plus a static Level 0 pointer ------------------------
  const indexRes = await fetch(BASE + "/ui");
  const indexBody = await indexRes.text();
  ok(indexRes.status === 200, `GET /ui -> 200 (got ${indexRes.status})`);

  ok(
    /id="persona-layer-stack"/.test(indexBody),
    "GET /ui body has a dedicated layer-stack section (id=\"persona-layer-stack\")",
  );

  // ml-05-memory-levels-ui: renamed heading + revised hint copy -- the
  // section's id/data-source/fetch logic are otherwise untouched (checked
  // further below). pu-11-layer-stack-integration-redesign (reconciled
  // during the combined v0.10.0 release merge) later re-homed this section
  // inside #personas, demoting its heading from <h2> to <h3> to keep a
  // correct heading hierarchy as a subsection -- the heading TEXT is
  // unchanged, only its level, so this assertion tracks that real, intended
  // shape rather than the pre-merge standalone-section markup.
  const layerStackSectionMatch = indexBody.match(/<section id="persona-layer-stack"[\s\S]*?<\/section>/);
  const layerStackSection = layerStackSectionMatch ? layerStackSectionMatch[0] : "";
  ok(
    /<h3>Retrieval Layer Stack<\/h3>/.test(layerStackSection),
    "GET /ui body's layer-stack section heading is 'Retrieval Layer Stack' (renamed from 'Memory Layer Stack', now an <h3> since pu-11 re-homed it inside #personas)",
  );
  ok(
    !/Memory Layer Stack/.test(indexBody),
    "GET /ui body no longer contains the old 'Memory Layer Stack' heading text anywhere",
  );
  ok(
    /recall\(\)/.test(layerStackSection) && /remember\(\)/.test(layerStackSection) && /cascade/i.test(layerStackSection),
    "Retrieval Layer Stack section's hint text states this is the runtime recall()/remember() cascade order",
  );
  ok(
    /not the canonical|5-level|memory-level/i.test(layerStackSection),
    "Retrieval Layer Stack section's hint text explicitly contrasts itself with the canonical 5-level memory-store-type model",
  );
  ok(
    /top-orchestrator/.test(layerStackSection) &&
      /company-director/.test(layerStackSection) &&
      /project-orchestrator/.test(layerStackSection) &&
      /code-architect/.test(layerStackSection),
    "Retrieval Layer Stack section's hint text names the team/orchestration tier hierarchy it is NOT (top-orchestrator/company-director/project-orchestrator/code-architect)",
  );
  ok(
    /not[^<.]{0,80}(team\/orchestration|orchestration\/team|team.{0,20}orchestration)/i.test(layerStackSection),
    "Retrieval Layer Stack section's hint text explicitly states it is NOT the team/orchestration tier hierarchy",
  );

  // Structurally distinct from a persona list: the layer-stack section's
  // table has its own id/columns (#, Layer, Writable) -- never a
  // "personas"/"persona-list" id, and its own tbody, not a shared one.
  ok(
    /id="persona-layer-stack-table"/.test(indexBody) && /id="persona-layer-stack-tbody"/.test(indexBody),
    "layer-stack section renders into its own table/tbody, not a shared persona-list element",
  );
  ok(
    !/id="persona-layer-stack"[\s\S]{0,4000}?<\/section>/.test(indexBody) ||
      !/id="persona-list"|class="persona-list"/.test(
        indexBody.match(/id="persona-layer-stack"[\s\S]{0,4000}?<\/section>/)?.[0] ?? "",
      ),
    "layer-stack section's own markup never contains a persona-list id/class -- it's not merged into one list",
  );

  // --- ml-05-memory-levels-ui: new, structurally separate Memory Levels
  // (0-4) section ------------------------------------------------------------
  ok(
    /id="memory-levels"/.test(indexBody),
    "GET /ui body has a dedicated Memory Levels section (id=\"memory-levels\")",
  );
  const memoryLevelsSectionMatch = indexBody.match(/<section id="memory-levels"[\s\S]*?<\/section>/);
  const memoryLevelsSection = memoryLevelsSectionMatch ? memoryLevelsSectionMatch[0] : "";
  ok(
    /<h2>Memory Levels \(0-4\)<\/h2>/.test(memoryLevelsSection),
    "Memory Levels section heading reads 'Memory Levels (0-4)'",
  );
  ok(
    /top-orchestrator/.test(memoryLevelsSection) &&
      /company-director/.test(memoryLevelsSection) &&
      /project-orchestrator/.test(memoryLevelsSection) &&
      /code-architect/.test(memoryLevelsSection),
    "Memory Levels section's hint text names the team/orchestration tier hierarchy it is NOT",
  );
  ok(
    /not[^<.]{0,80}(team\/orchestration|orchestration\/team|team.{0,20}orchestration)/i.test(memoryLevelsSection),
    "Memory Levels section's hint text explicitly states it is NOT the team/orchestration tier hierarchy",
  );
  ok(
    /id="memory-levels-status"/.test(memoryLevelsSection),
    "Memory Levels section has its own status element (id=\"memory-levels-status\")",
  );
  ok(
    /id="memory-levels-table"/.test(memoryLevelsSection) && /id="memory-levels-tbody"/.test(memoryLevelsSection),
    "Memory Levels section has its own table/tbody, never sharing persona-layer-stack's",
  );
  ok(
    memoryLevelsSection.length > 0 && !/id="persona-layer-stack"/.test(memoryLevelsSection),
    "Memory Levels section is a structurally distinct <section>, not folded into persona-layer-stack",
  );
  ok(
    layerStackSection.length > 0 && !/id="memory-levels"/.test(layerStackSection),
    "Retrieval Layer Stack section does not contain the Memory Levels section either -- two separate siblings",
  );
  // Level 0 stays view-only in the new section too: no edit affordance
  // anywhere inside it.
  ok(
    !/<(form|input|button|textarea)/i.test(memoryLevelsSection),
    "Memory Levels section renders no form/input/button/textarea anywhere -- Level 0 (and every level) stays view-only",
  );

  // --- static Level 0 pointer: path shown, NO edit form/affordance --------
  ok(
    /~\/\.mnemosyne\/level0-rules\.md/.test(indexBody),
    "GET /ui body shows the Level 0 path pointer (~/.mnemosyne/level0-rules.md)",
  );
  ok(
    !/id="[^"]*level0[^"]*edit/i.test(indexBody) &&
      !/level0[\s\S]{0,300}?<(form|input|button|textarea)/i.test(indexBody) &&
      !/<(form|input|button|textarea)[^>]*level0/i.test(indexBody),
    "GET /ui body has no edit form/input/button/textarea anywhere near the Level 0 pointer",
  );
  ok(
    !/edit[^<]{0,40}level0|level0[^<]{0,40}edit/i.test(indexBody),
    "GET /ui body never pairs \"edit\" wording with the Level 0 pointer",
  );

  // --- served ui/app.js: calls the ALREADY-SHIPPED GET /layers route,
  // never a new one; no edit-Level-0 fetch anywhere -------------------------
  const appJs = await (await fetch(BASE + "/ui/app.js")).text();

  ok(
    /fetch\([\s\S]{0,160}?["'`]\/layers["'`]\)/.test(appJs),
    "ui/app.js's loader fetches GET /layers (the already-shipped route), not a re-implemented endpoint",
  );
  ok(
    /:3141/.test(appJs),
    "ui/app.js's layer-stack loader targets the client API's real port (3141, MNEMOSYNE_PORT default) as a genuine cross-origin fetch",
  );
  ok(
    !/\/layer-stack\b|\/persona-layers\b|\/layers\/config\b/.test(appJs),
    "ui/app.js never invents a new layer-stack-specific route -- only the existing GET /layers",
  );

  // No edit-Level-0 affordance anywhere in the JS: no PUT/POST/PATCH/DELETE
  // request whose URL or body mentions level0, and no writable form wiring.
  ok(
    !/level0[\s\S]{0,200}?method:\s*["'`](POST|PUT|PATCH|DELETE)["'`]/i.test(appJs) &&
      !/method:\s*["'`](POST|PUT|PATCH|DELETE)["'`][\s\S]{0,200}?level0/i.test(appJs),
    "ui/app.js never issues a POST/PUT/PATCH/DELETE request anywhere near \"level0\" -- Level 0 stays view-only",
  );
  ok(
    !/addEventListener\(\s*["'`]submit["'`][\s\S]{0,300}?level0/i.test(appJs),
    "ui/app.js wires no submit-event handler near \"level0\" -- no edit form exists to wire one to",
  );

  // ml-05-memory-levels-ui: loadPersonaLayerStack()'s body itself -- byte
  // for byte -- is genuinely unmodified by this story. Pinning the exact,
  // known-good function body (as shipped by pw-04) rather than a loose
  // regex, so any change at all to its logic fails this check.
  const loadPersonaLayerStackBody = [
    "async function loadPersonaLayerStack() {",
    "  // Guards against running against an older served index.html that predates",
    "  // this section (e.g. a stale cached page) -- never throws either way.",
    "  if (!personaLayerStackStatusEl || !personaLayerStackTableEl || !personaLayerStackTbodyEl) return;",
    "",
    "  setStatus(personaLayerStackStatusEl, \"loading\", \"loading…\");",
    "  personaLayerStackTbodyEl.textContent = \"\";",
    "  personaLayerStackTableEl.hidden = true;",
    "  if (personaLayerStackEmptyEl) personaLayerStackEmptyEl.hidden = true;",
    "",
    "  try {",
    "    const res = await fetch(mnemosyneClientApiBase() + \"/layers\");",
    "    if (!res.ok) {",
    "      const body = await res.json().catch(() => ({}));",
    "      setStatus(",
    "        personaLayerStackStatusEl,",
    "        \"fail\",",
    "        `FAIL — GET /layers returned ${res.status}${body.error ? `: ${body.error.message || body.error}` : \"\"}`,",
    "      );",
    "      return;",
    "    }",
    "    const body = await res.json();",
    "    const layers = Array.isArray(body.layers) ? body.layers : [];",
    "    if (!layers.length) {",
    "      setStatus(personaLayerStackStatusEl, \"pass\", \"no layers configured\");",
    "      if (personaLayerStackEmptyEl) personaLayerStackEmptyEl.hidden = false;",
    "      return;",
    "    }",
    "    layers.forEach((l, i) => {",
    "      const tr = document.createElement(\"tr\");",
    "      tr.appendChild(personaLayerStackCell(String(i + 1)));",
    "      tr.appendChild(personaLayerStackCell(l && l.layer != null ? String(l.layer) : \"?\"));",
    "      tr.appendChild(personaLayerStackCell(l && l.writable ? \"yes\" : \"no\"));",
    "      personaLayerStackTbodyEl.appendChild(tr);",
    "    });",
    "    personaLayerStackTableEl.hidden = false;",
    "    setStatus(personaLayerStackStatusEl, \"pass\", `${layers.length} layer(s), cascade order`);",
    "  } catch (err) {",
    "    setStatus(personaLayerStackStatusEl, \"fail\", \"FAIL — could not reach GET /layers\");",
    "  }",
    "}",
  ].join("\n");
  ok(
    appJs.includes(loadPersonaLayerStackBody),
    "ui/app.js's loadPersonaLayerStack() function body is byte-for-byte unchanged from pw-04's shipped version",
  );

  // --- ml-05-memory-levels-ui: new loadMemoryLevels() function + wiring ----
  ok(
    /async function loadMemoryLevels\s*\(\s*\)\s*\{/.test(appJs),
    "ui/app.js defines a new loadMemoryLevels() function",
  );
  ok(
    /fetch\([\s\S]{0,160}?["'`]\/memory-levels["'`]\)/.test(appJs),
    "loadMemoryLevels() fetches GET /memory-levels (ml-04's route)",
  );
  ok(
    /function refreshAll[\s\S]*?loadPersonaLayerStack\(\)[\s\S]*?\}/.test(appJs) &&
      /function refreshAll[\s\S]{0,600}loadMemoryLevels\(\)/.test(appJs),
    "refreshAll() calls loadMemoryLevels() alongside the existing loadPersonaLayerStack() call",
  );
  // No auto-polling: loadMemoryLevels itself is only ever called from
  // refreshAll()/initial load, never from a setInterval/setTimeout loop.
  ok(
    !/setInterval\([\s\S]{0,200}?loadMemoryLevels/.test(appJs) && !/setTimeout\([\s\S]{0,200}?loadMemoryLevels/.test(appJs),
    "loadMemoryLevels() is never wired to setInterval/setTimeout -- no auto-polling, matching this file's existing convention",
  );
  // No edit-Level-0 affordance anywhere near the new function either.
  const loadMemoryLevelsMatch = appJs.match(/async function loadMemoryLevels\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);
  const loadMemoryLevelsBody = loadMemoryLevelsMatch ? loadMemoryLevelsMatch[0] : "";
  ok(
    loadMemoryLevelsBody.length > 0 &&
      !/method:\s*["'`](POST|PUT|PATCH|DELETE)["'`]/i.test(loadMemoryLevelsBody),
    "loadMemoryLevels() issues no POST/PUT/PATCH/DELETE request -- read-only, Level 0 stays view-only",
  );

  // Direct source-file read too (belt-and-suspenders vs. the served copy
  // above, same double-check convention as test/graph-route.mjs).
  const appJsOnDisk = await readFile(path.join(__dirname, "..", "ui", "app.js"), "utf8");
  const indexHtmlOnDisk = await readFile(path.join(__dirname, "..", "ui", "index.html"), "utf8");
  ok(appJsOnDisk === appJs, "served ui/app.js matches the on-disk source exactly (no build step in between)");
  ok(indexHtmlOnDisk.includes(indexBody.trim()) || indexBody.includes(indexHtmlOnDisk.trim()),
    "served GET /ui body matches the on-disk ui/index.html source");
} finally {
  if (fails) console.log("\n--- server output (for debugging) ---\n" + serverOutput);
  child.kill();
}

console.log(fails ? `\n${fails} check(s) failed` : "\nall persona-layer-stack checks passed");
process.exit(fails ? 1 : 0);
