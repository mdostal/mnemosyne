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
  ok(
    /Memory Layer Stack/i.test(indexBody),
    "GET /ui body's layer-stack section has its own distinct heading, not a persona-list label",
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
