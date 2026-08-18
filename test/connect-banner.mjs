// connect-banner.mjs — real tests for aha-04-ui-connect-banner (epic:
// mnemosyne-agent-harness-install): the top-and-forefront, collapsible
// "connect an agent/harness" banner (ui/index.html between </header> and
// <nav id="jump-chips">).
//
// Two halves, matching this repo's own established convention
// (test/jump-chip-nav-status-wiring.mjs): a fetch-based static-assertion
// half (structure, placement, token reuse, no-JS content, and — the part
// unique to THIS ticket — byte-for-byte cross-checks of the banner's
// embedded commands against the REAL README.md/docs/install.sh/bin/mnemosyne
// source, never a hardcoded copy of the string this file itself wrote), and
// a real-browser half via the `playwright` package (real page reload,
// real localStorage, real elementFromPoint reachability, and a real
// localStorage-throws fail-open simulation) — this ticket's own acceptance
// criteria explicitly require a REAL reload in a REAL browser, which no
// amount of fetch()/regex/new Function() static assertion can prove on its
// own for a localStorage-persistence claim.
//
// Usage: node test/connect-banner.mjs
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SERVER_PATH = path.join(ROOT, "src", "server.mjs");
const PORT = Number(process.env.MNEMOSYNE_TEST_PORT || 8512);
const BASE = `http://127.0.0.1:${PORT}`;
const STORAGE_KEY = "mnemosyne-connect-banner-collapsed";

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

// ============================================================================
// 0. Derive the EXPECTED command strings from the real, on-disk source files
//    this ticket's commands are supposed to mirror — never a copy pasted
//    into this test file by hand, so this test can't pass against a
//    silently-drifted/placeholder banner just because it agrees with
//    itself.
// ============================================================================
const readmeMd = await readFile(path.join(ROOT, "README.md"), "utf8");
const installSh = await readFile(path.join(ROOT, "docs", "install.sh"), "utf8");
const mnemosyneBinSrc = await readFile(path.join(ROOT, "bin", "mnemosyne"), "utf8");
const agentMjsSrc = await readFile(path.join(ROOT, "bin", "mnemosyne-agent.mjs"), "utf8");

// README.md's real Quickstart fenced code block (aha-03).
const quickstartMatch = readmeMd.match(/## Quickstart\s*\n\s*```bash\n([\s\S]*?)\n```/);
if (!quickstartMatch) throw new Error("connect-banner test harness: could not find README.md's Quickstart fenced code block");
const EXPECTED_CURL_CMD = quickstartMatch[1].trim();
ok(EXPECTED_CURL_CMD.startsWith("curl -fsSL") && EXPECTED_CURL_CMD.includes("install.sh | bash"),
  `README.md's real Quickstart curl command was extracted (got: ${JSON.stringify(EXPECTED_CURL_CMD)})`);

// docs/install.sh's own header comment carries the identical command —
// cross-checking BOTH real sources agree with each other independently of
// what the banner says.
const installShCurlMatch = installSh.match(/^#\s*(curl -fsSL \S+install\.sh \| bash)\s*$/m);
ok(!!installShCurlMatch, "docs/install.sh's header comment carries its own real curl command line");
if (installShCurlMatch) {
  ok(installShCurlMatch[1] === EXPECTED_CURL_CMD,
    `docs/install.sh's own documented curl command agrees byte-for-byte with README.md's (${installShCurlMatch[1]} === ${EXPECTED_CURL_CMD})`);
}

// The exact `mnemosyne agent init` invocation string — real usage text
// appears in bin/mnemosyne's usage comment AND is literally what
// docs/install.sh prints as the next step.
const EXPECTED_AGENT_INIT_CMD = "mnemosyne agent init";
ok(mnemosyneBinSrc.includes("bin/mnemosyne agent init"),
  "bin/mnemosyne's own usage comment documents 'agent init' as a real subcommand");
ok(installSh.includes(`log "  ${EXPECTED_AGENT_INIT_CMD}"`),
  "docs/install.sh literally prints 'mnemosyne agent init' as its real next-step instruction");
ok(agentMjsSrc.includes("`mnemosyne agent init`") || agentMjsSrc.includes("mnemosyne agent init"),
  "bin/mnemosyne-agent.mjs's own header references the real 'mnemosyne agent init' invocation");

// What `agent init` really does, per docs/install.sh's own real printed
// description (the source of truth for the banner's one-line explainer,
// not a paraphrase invented independently by this ticket).
ok(installSh.includes("registers Mnemosyne as an") && installSh.includes("MCP server") && installSh.includes("skills"),
  "docs/install.sh's real printed description names both 'MCP server' registration and 'skills' install");

// ============================================================================
// 1. Static assertions against the real served ui/index.html / ui/app.js /
//    ui/style.css (spawning src/server.mjs, matching test/
//    jump-chip-nav-status-wiring.mjs's established convention).
// ============================================================================
const child = spawn(process.execPath, [SERVER_PATH], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverOutput = "";
child.stdout.on("data", (d) => { serverOutput += d.toString(); });
child.stderr.on("data", (d) => { serverOutput += d.toString(); });

let browser = null;

try {
  const up = await waitForServer(BASE + "/scopes");
  ok(up, "test server came up");

  const indexRes = await fetch(BASE + "/ui");
  const indexBody = await indexRes.text();
  ok(indexRes.status === 200, `GET /ui -> 200 (got ${indexRes.status})`);

  // --- placement: genuinely between </header> and <nav id="jump-chips">,
  // in real DOM/document order, not merely CSS-reordered -----------------
  const headerCloseIdx = indexBody.indexOf("</header>");
  const bannerIdx = indexBody.indexOf('<section id="connect-banner"');
  const navIdx = indexBody.indexOf('<nav id="jump-chips"');
  ok(headerCloseIdx > -1 && bannerIdx > -1 && navIdx > -1, "all three anchor points (</header>, #connect-banner, #jump-chips) exist in the served markup");
  ok(headerCloseIdx < bannerIdx, "#connect-banner appears AFTER </header> in raw document order");
  ok(bannerIdx < navIdx, "#connect-banner appears BEFORE <nav id=\"jump-chips\"> in raw document order — the real first slot below the title bar, above even navigation");
  const mainOpenIdx = indexBody.indexOf("<main>");
  ok(navIdx < mainOpenIdx, "#jump-chips (and therefore #connect-banner, which precedes it) is still before <main> — sanity check on document order");

  // --- real, copy-pasteable <pre>/<code> blocks, byte-identical to the
  // real README/install.sh/bin/mnemosyne source (section 0 above) --------
  const bannerHtml = indexBody.slice(bannerIdx, navIdx);
  const installCodeMatch = bannerHtml.match(/<code id="connect-banner-cmd-install">([^<]*)<\/code>/);
  const agentInitCodeMatch = bannerHtml.match(/<code id="connect-banner-cmd-agent-init">([^<]*)<\/code>/);
  ok(!!installCodeMatch, "banner has a <code id=\"connect-banner-cmd-install\"> element");
  ok(!!agentInitCodeMatch, "banner has a <code id=\"connect-banner-cmd-agent-init\"> element");
  const bannerInstallCmd = installCodeMatch ? installCodeMatch[1] : "";
  const bannerAgentInitCmd = agentInitCodeMatch ? agentInitCodeMatch[1] : "";
  ok(bannerInstallCmd === EXPECTED_CURL_CMD,
    `banner's embedded curl command is byte-identical to README.md's real Quickstart command (banner: ${JSON.stringify(bannerInstallCmd)})`);
  ok(bannerAgentInitCmd === EXPECTED_AGENT_INIT_CMD,
    `banner's embedded agent-init command is byte-identical to the real 'mnemosyne agent init' invocation (banner: ${JSON.stringify(bannerAgentInitCmd)})`);
  // Both live inside real <pre> blocks (copy-pasteable, not inline prose).
  ok(/<pre><code id="connect-banner-cmd-install">/.test(bannerHtml), "the install command sits inside a real <pre><code> block");
  ok(/<pre><code id="connect-banner-cmd-agent-init">/.test(bannerHtml), "the agent-init command sits inside a real <pre><code> block");

  // --- one line naming what agent init does (registers the MCP server,
  // installs skills for Claude Code) --------------------------------------
  ok(/MCP server/.test(bannerHtml) && /skills/.test(bannerHtml) && /Claude Code/.test(bannerHtml),
    "banner names what `mnemosyne agent init` does: registers the MCP server and installs skills for Claude Code");

  // --- a visible collapse control, and an always-present (never removed)
  // reopen control -----------------------------------------------------
  ok(/<button id="connect-banner-collapse"/.test(bannerHtml), "banner has a real #connect-banner-collapse <button>");
  ok(/<button id="connect-banner-reopen"/.test(bannerHtml), "banner has a real #connect-banner-reopen <button>, present in the DOM even before any JS runs");
  ok(/id="connect-banner-reopen"[^>]*\bhidden\b/.test(bannerHtml), "on first paint (static markup), #connect-banner-reopen starts `hidden` (expanded is the default)");
  ok(!/id="connect-banner-main"[^>]*\bhidden\b/.test(bannerHtml), "on first paint (static markup), #connect-banner-main has NO `hidden` attribute — genuinely visible with zero JS");

  // ======================================================================
  // 2. Fail-open / no-JS-dependency: strip the <script src="/ui/app.js">
  //    tag out of the served HTML entirely and confirm the banner's CORE
  //    content (both real commands + the one-line explainer) is still
  //    fully present, matching ui-03/ui-05's own established discipline.
  // ======================================================================
  const scriptTagMatch = indexBody.match(/<script src="\/ui\/app\.js"[^>]*><\/script>/);
  ok(!!scriptTagMatch, "GET /ui body has the app.js <script> tag (so stripping it below is a real test, not a no-op)");
  const htmlWithScriptStripped = scriptTagMatch ? indexBody.replace(scriptTagMatch[0], "") : indexBody;
  const strippedBannerHtml = htmlWithScriptStripped.slice(
    htmlWithScriptStripped.indexOf('<section id="connect-banner"'),
    htmlWithScriptStripped.indexOf('<nav id="jump-chips"'),
  );
  ok(strippedBannerHtml.includes(EXPECTED_CURL_CMD), "with <script> stripped entirely, the real curl command is still present in the markup");
  ok(strippedBannerHtml.includes(EXPECTED_AGENT_INIT_CMD), "with <script> stripped entirely, the real 'mnemosyne agent init' command is still present in the markup");
  ok(!/id="connect-banner-main"[^>]*\bhidden\b/.test(strippedBannerHtml), "with <script> stripped, #connect-banner-main is still NOT hidden -- content renders with zero JS");

  // No CSS anywhere hides #connect-banner-main by default (visibility must
  // never be JS-load-bearing).
  const styleCss = await (await fetch(BASE + "/ui/style.css")).text();
  ok(
    !/#connect-banner-main\s*\{[^}]*display:\s*none/s.test(styleCss) &&
      !/#connect-banner-main\s*\{[^}]*visibility:\s*hidden/s.test(styleCss),
    "ui/style.css never sets display:none/visibility:hidden on #connect-banner-main by default",
  );

  // ======================================================================
  // 3. Token reuse: the new banner CSS block uses ONLY the existing
  //    --accent/--bg/--panel-bg/--border/--text/--muted tokens.
  // ======================================================================
  const cssBlockMatch = styleCss.match(/\/\* aha-04-ui-connect-banner[\s\S]*?(?=\n\/\* ui-03-jump-chip-nav-and-status-wiring: sticky jump-chip nav,)/);
  ok(!!cssBlockMatch, "the new aha-04-ui-connect-banner CSS block was found in ui/style.css");
  const cssBlock = cssBlockMatch ? cssBlockMatch[0] : "";
  const ALLOWED_TOKENS = new Set(["--accent", "--bg", "--panel-bg", "--border", "--text", "--muted"]);
  const usedTokens = [...cssBlock.matchAll(/var\((--[a-z-]+)\)/g)].map((m) => m[1]);
  ok(usedTokens.length > 0, `the new CSS block references at least one design token (found ${usedTokens.length})`);
  const disallowed = usedTokens.filter((t) => !ALLOWED_TOKENS.has(t));
  ok(disallowed.length === 0, `the new CSS block uses ONLY existing tokens (found disallowed: ${JSON.stringify(disallowed)}; used: ${JSON.stringify([...new Set(usedTokens)])})`);
  // No new hardcoded hex/rgb colors introduced either.
  const hardcodedColors = [...cssBlock.matchAll(/#[0-9a-fA-F]{3,6}\b/g)].map((m) => m[0]).filter((c) => c !== "#10131a");
  ok(hardcodedColors.length === 0, `the new CSS block introduces no new hardcoded color literals beyond the existing #10131a accent-contrast text color (found: ${JSON.stringify(hardcodedColors)})`);

  // ======================================================================
  // 4. Served source matches on-disk source exactly (no build step).
  // ======================================================================
  const appJs = await (await fetch(BASE + "/ui/app.js")).text();
  const appJsOnDisk = await readFile(path.join(ROOT, "ui", "app.js"), "utf8");
  ok(appJsOnDisk === appJs, "served ui/app.js matches the on-disk source exactly");
  ok(appJsOnDisk.includes("CONNECT_BANNER_STORAGE_KEY"), "ui/app.js defines the connect-banner's localStorage key");
  ok(appJsOnDisk.includes('window.localStorage.getItem(CONNECT_BANNER_STORAGE_KEY) === "1"'), "ui/app.js only ever collapses from a real, exact-match stored value");

  // ======================================================================
  // 5. Real browser half (playwright): first-load expanded, real reload
  //    persistence, reopen reachability, and real fail-open under a
  //    throwing localStorage.
  // ======================================================================
  browser = await chromium.launch();

  // --- 5a. First-time load: no stored state anywhere -> expanded --------
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(BASE + "/ui");
    const state = await page.evaluate(() => ({
      mainHidden: document.getElementById("connect-banner-main").hidden,
      reopenHidden: document.getElementById("connect-banner-reopen").hidden,
      stored: (() => { try { return window.localStorage.getItem("mnemosyne-connect-banner-collapsed"); } catch { return "THREW"; } })(),
      installText: document.getElementById("connect-banner-cmd-install").textContent,
      agentInitText: document.getElementById("connect-banner-cmd-agent-init").textContent,
    }));
    ok(state.stored === null, "real browser, fresh context: no localStorage state exists before first load");
    ok(state.mainHidden === false, "real browser, first-time load (no stored state): banner body is expanded/visible");
    ok(state.reopenHidden === true, "real browser, first-time load: reopen strip is hidden (not shown while already expanded)");
    ok(state.installText === EXPECTED_CURL_CMD, "real browser: rendered install command text is byte-identical to the real README command");
    ok(state.agentInitText === EXPECTED_AGENT_INIT_CMD, "real browser: rendered agent-init command text is byte-identical to the real CLI invocation");

    // --- positioning proof: banner sits directly below the header and
    // directly above the jump-chip nav, using real rendered rects (not a
    // structural-only claim) — matching this ticket's own measurement
    // warning: cross-check via a real sibling element's position, not a
    // single element's isolated rect.
    const rects = await page.evaluate(() => {
      const header = document.querySelector("header");
      const banner = document.getElementById("connect-banner");
      const nav = document.getElementById("jump-chips");
      return {
        header: header.getBoundingClientRect().toJSON(),
        banner: banner.getBoundingClientRect().toJSON(),
        nav: nav.getBoundingClientRect().toJSON(),
      };
    });
    ok(rects.banner.top >= rects.header.bottom - 1, "real rendered rect: banner's top sits at/after the header's bottom");
    ok(rects.nav.top >= rects.banner.bottom - 1, "real rendered rect: nav's top sits at/after the banner's bottom (banner is genuinely above nav on screen, not just in the DOM)");

    await context.close();
  }

  // --- 5b. Collapse -> real reload -> stays collapsed -> reopen is
  // reachable and functional ---------------------------------------------
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(BASE + "/ui");
    await page.click("#connect-banner-collapse");
    const afterClick = await page.evaluate(() => ({
      mainHidden: document.getElementById("connect-banner-main").hidden,
      reopenHidden: document.getElementById("connect-banner-reopen").hidden,
      stored: window.localStorage.getItem("mnemosyne-connect-banner-collapsed"),
    }));
    ok(afterClick.mainHidden === true, "real browser: clicking collapse hides the banner body");
    ok(afterClick.reopenHidden === false, "real browser: clicking collapse reveals the reopen strip");
    ok(afterClick.stored === "1", "real browser: clicking collapse persists '1' to real localStorage");

    // The actual, real page reload this ticket's acceptance criteria call for.
    await page.reload();
    const afterReload = await page.evaluate(() => ({
      mainHidden: document.getElementById("connect-banner-main").hidden,
      reopenHidden: document.getElementById("connect-banner-reopen").hidden,
    }));
    ok(afterReload.mainHidden === true, "real browser, AFTER a real page.reload(): banner starts collapsed (state persisted via localStorage)");
    ok(afterReload.reopenHidden === false, "real browser, AFTER a real page.reload(): reopen strip is visible");

    // Reachability proof via the container's own rect + elementFromPoint
    // (per this ticket's own measurement-artifact warning — never trust a
    // bare getComputedStyle()/getBoundingClientRect() on a possibly-stale
    // child alone).
    const reachable = await page.evaluate(() => {
      const reopen = document.getElementById("connect-banner-reopen");
      const rect = reopen.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const atPoint = document.elementFromPoint(cx, cy);
      return {
        rectHasArea: rect.width > 0 && rect.height > 0,
        elementAtCenterIsReopenOrChild: atPoint === reopen || (atPoint != null && reopen.contains(atPoint)),
      };
    });
    ok(reachable.rectHasArea, "real browser: collapsed reopen strip has a real, non-zero rendered rect");
    ok(reachable.elementAtCenterIsReopenOrChild, "real browser: document.elementFromPoint at the reopen strip's own center resolves to the reopen control itself (genuinely on top, genuinely clickable, not covered/occluded)");

    // Click it for real -> re-expands, updates localStorage.
    await page.click("#connect-banner-reopen");
    const afterReopen = await page.evaluate(() => ({
      mainHidden: document.getElementById("connect-banner-main").hidden,
      reopenHidden: document.getElementById("connect-banner-reopen").hidden,
      stored: window.localStorage.getItem("mnemosyne-connect-banner-collapsed"),
    }));
    ok(afterReopen.mainHidden === false, "real browser: clicking the reopen control re-expands the banner body");
    ok(afterReopen.reopenHidden === true, "real browser: clicking reopen hides the reopen strip again");
    ok(afterReopen.stored === "0", "real browser: clicking reopen persists '0' to real localStorage");

    // And a SECOND real reload confirms the re-expanded state also persists.
    await page.reload();
    const afterSecondReload = await page.evaluate(() => document.getElementById("connect-banner-main").hidden);
    ok(afterSecondReload === false, "real browser, second real reload: re-expanded state also persists (not one-directional)");

    await context.close();
  }

  // --- 5c. Fail-open: a real page where window.localStorage THROWS on
  // every access (simulating Safari private-browsing's real documented
  // behavior) still renders fully expanded, and the collapse control
  // (though it can't persist) does not crash the page. -------------------
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    // Installed BEFORE any page script runs, via a real init script — this
    // is the closest a Chromium-based real browser test can get to
    // reproducing Safari private browsing's real "accessing
    // window.localStorage throws" behavior, without actually needing
    // Safari installed in this environment.
    await page.addInitScript(() => {
      Object.defineProperty(window, "localStorage", {
        get() { throw new DOMException("The operation is insecure.", "SecurityError"); },
      });
    });
    const pageErrors = [];
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    await page.goto(BASE + "/ui");
    const state = await page.evaluate(() => ({
      mainHidden: document.getElementById("connect-banner-main").hidden,
      reopenHidden: document.getElementById("connect-banner-reopen").hidden,
      installText: document.getElementById("connect-banner-cmd-install").textContent,
    }));
    ok(state.mainHidden === false, "real browser, localStorage THROWS on access (private-browsing simulation): banner still renders fully EXPANDED (fail-open)");
    ok(state.reopenHidden === true, "real browser, localStorage throws: reopen strip stays hidden (never wrongly shown as if collapsed)");
    ok(state.installText === EXPECTED_CURL_CMD, "real browser, localStorage throws: the real command content still renders correctly");
    ok(pageErrors.length === 0, `real browser, localStorage throws: no uncaught page error propagated (the try/catch genuinely swallowed it) — got: ${JSON.stringify(pageErrors)}`);

    // The collapse control itself must not crash the page even though it
    // can't actually persist anything in this simulated environment.
    await page.click("#connect-banner-collapse");
    const afterClickState = await page.evaluate(() => document.getElementById("connect-banner-main").hidden);
    ok(afterClickState === true, "real browser, localStorage throws: the in-memory collapse toggle still works for THIS page view even though persistence is impossible");
    ok(pageErrors.length === 0, "real browser, localStorage throws: clicking collapse still doesn't throw an uncaught page error");

    await context.close();
  }

  // --- 5d. Fail-open with the collapse script request itself aborted
  // entirely (closest real-browser equivalent of "JS fails to load") -----
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route("**/ui/app.js", (route) => route.abort());
    await page.goto(BASE + "/ui");
    const state = await page.evaluate(() => ({
      mainHidden: document.getElementById("connect-banner-main").hidden,
      reopenHidden: document.getElementById("connect-banner-reopen").hidden,
      installText: document.getElementById("connect-banner-cmd-install").textContent,
      agentInitText: document.getElementById("connect-banner-cmd-agent-init").textContent,
    }));
    ok(state.mainHidden === false, "real browser, /ui/app.js request aborted entirely (script fails to load): banner renders fully EXPANDED from static markup alone");
    ok(state.reopenHidden === true, "real browser, script fails to load: reopen strip stays correctly hidden");
    ok(state.installText === EXPECTED_CURL_CMD, "real browser, script fails to load: the real curl command is still fully rendered and present");
    ok(state.agentInitText === EXPECTED_AGENT_INIT_CMD, "real browser, script fails to load: the real agent-init command is still fully rendered and present");
    await context.close();
  }
} finally {
  if (browser) await browser.close();
  if (fails) console.log("\n--- server output (for debugging) ---\n" + serverOutput);
  child.kill();
}

console.log(fails ? `\n${fails} check(s) failed` : "\nall connect-banner checks passed");
process.exit(fails ? 1 : 0);
