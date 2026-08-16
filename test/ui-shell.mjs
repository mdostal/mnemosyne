// ui-shell.mjs — proves the standalone UI shell (s-01) against a running server.
//
// Covers:
//   - GET /ui renders an HTML page (not raw JSON) with liveliness + settings panels.
//   - GET /config exposes qdrant_url, embedder, default_scope, fallback_collection.
//   - GET /'s existing JSON contract survives for programmatic/JSON-accepting
//     callers (Accept: */* or application/json), while a browser-flavored
//     request (Accept: text/html) lands on the UI instead.
//
// Usage: MNEMOSYNE_URL=http://127.0.0.1:8477 node test/ui-shell.mjs
const BASE = process.env.MNEMOSYNE_URL || "http://127.0.0.1:8477";

let fails = 0;
const ok = (c, m) => { console.log(`${c ? "  PASS" : "  FAIL"}  ${m}`); if (!c) fails++; };

// --- GET /ui: renders HTML, not JSON --------------------------------------
{
  const res = await fetch(BASE + "/ui");
  const contentType = res.headers.get("content-type") || "";
  const body = await res.text();
  ok(res.status === 200, `GET /ui -> 200 (got ${res.status})`);
  ok(contentType.includes("text/html"), `GET /ui content-type is text/html (got ${contentType})`);
  ok(/<html/i.test(body), `GET /ui body looks like HTML`);
  let parsedAsJson = true;
  try { JSON.parse(body); } catch { parsedAsJson = false; }
  ok(!parsedAsJson, `GET /ui body is not raw JSON`);
  ok(/liveliness/i.test(body), `GET /ui body mentions a liveliness panel`);
  ok(/settings/i.test(body), `GET /ui body mentions a settings panel`);
  ok(/refresh/i.test(body), `GET /ui body has a manual refresh control`);
  ok(/lanes/i.test(body), `GET /ui body mentions a lanes panel (s-02)`);
  ok(/add-lane-form/i.test(body), `GET /ui body has an add-lane form (s-02)`);
  // pw-03-personas-panel-view: the Personas panel follows the exact same
  // panel-status/table convention as every other panel (e.g. Lanes above).
  ok(/id="personas"/i.test(body), `GET /ui body has a personas panel (pw-03)`);
  ok(/id="personas-status"/i.test(body), `GET /ui body has a personas-status element (pw-03)`);
  ok(/id="personas-table"/i.test(body), `GET /ui body has a personas-table (pw-03)`);
  ok(/id="personas-tbody"/i.test(body), `GET /ui body has a personas-tbody (pw-03)`);
}

// --- GET /ui/ (trailing slash) also serves the shell ------------------------
{
  const res = await fetch(BASE + "/ui/");
  ok(res.status === 200, `GET /ui/ -> 200 (got ${res.status})`);
}

// --- GET /config: read-only settings shape ----------------------------------
{
  const res = await fetch(BASE + "/config");
  const body = await res.json();
  ok(res.status === 200, `GET /config -> 200 (got ${res.status})`);
  ok(typeof body.qdrant_url === "string" && body.qdrant_url.length > 0,
    `GET /config has qdrant_url (${body.qdrant_url})`);
  ok(body.embedder && typeof body.embedder.provider === "string" && typeof body.embedder.model === "string",
    `GET /config has embedder {provider, model} (${JSON.stringify(body.embedder)})`);
  ok(typeof body.default_scope === "string" && body.default_scope.length > 0,
    `GET /config has default_scope (${body.default_scope})`);
  ok(typeof body.fallback_collection === "string" && body.fallback_collection.length > 0,
    `GET /config has fallback_collection (${body.fallback_collection})`);
}

// --- GET /: existing JSON contract preserved for programmatic callers -------
{
  // Default fetch() behavior (no explicit Accept header) — this is exactly how
  // hooks/lib/mnemo-client.mjs and test/smoke.mjs call the service today.
  const res = await fetch(BASE + "/");
  const contentType = res.headers.get("content-type") || "";
  const body = await res.json();
  ok(res.status === 200, `GET / (default Accept) -> 200 (got ${res.status})`);
  ok(contentType.includes("application/json"), `GET / (default Accept) content-type is JSON`);
  ok(body.god === "mnemosyne" && body.role === "memory",
    `GET / (default Accept) returns the service info blob (god=${body.god}, role=${body.role})`);
  ok(body.endpoints && typeof body.endpoints === "object",
    `GET / (default Accept) still lists endpoints`);
}

// --- GET / with an explicit JSON Accept header also gets JSON ---------------
{
  const res = await fetch(BASE + "/", { headers: { accept: "application/json" } });
  const body = await res.json();
  ok(res.status === 200 && body.god === "mnemosyne",
    `GET / (Accept: application/json) -> JSON info blob`);
}

// --- GET / with a browser Accept header lands on the UI ----------------------
{
  const res = await fetch(BASE + "/", { headers: { accept: "text/html,application/xhtml+xml" } });
  const contentType = res.headers.get("content-type") || "";
  const body = await res.text();
  ok(res.status === 200, `GET / (Accept: text/html) -> 200 after following redirect (got ${res.status})`);
  ok(contentType.includes("text/html"), `GET / (Accept: text/html) lands on HTML (got ${contentType})`);
  ok(/liveliness/i.test(body), `GET / (Accept: text/html) renders the liveliness panel`);
}

console.log(fails ? `\n${fails} check(s) failed` : "\nall ui-shell checks passed");
process.exit(fails ? 1 : 0);
