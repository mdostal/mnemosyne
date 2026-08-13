// server.mjs — Mnemosyne HTTP surface (the memory god's API).
//
// Transport-only: parses requests, delegates every memory op to engine.mjs
// (which wraps the swarm-memory CLI over the live Qdrant SSOT), and shapes the
// JSON response. Zero third-party deps — Node's built-in http, so it just runs.
//
//   GET  /                 -> service info JSON (programmatic callers) OR a
//                              302 to /ui (browser navigations — see below)
//   GET  /ui, /ui/*        -> static standalone UI shell (zero-dep, no build step)
//   GET  /health           -> engine self-test (Qdrant/embedder/graph)
//   GET  /scopes           -> configured scopes + escalation ladders
//   GET  /config           -> read-only effective config (qdrant_url, embedder, scopes)
//   POST /recall  {query, scope?, hits?, escalate?, min_score?, radius?}
//   POST /remember {text, scope?, tag?}
//   POST /lanes   {name, collection, ladder?} -> add-only config.toml write
//
// GET / content negotiation: no consumer in this repo (hooks/lib/mnemo-client.mjs,
// test/smoke.mjs) depends on GET /'s bare path today, and Node's fetch() sends
// `Accept: */*` when the caller doesn't set one — so the existing JSON info blob
// stays the default response for any caller that doesn't explicitly say it wants
// HTML. Only an Accept header containing "text/html" (real browsers always send
// this) redirects to /ui. This preserves the JSON contract for every existing
// and future programmatic caller with no route change required on their end.
//
// PORT env (default 8477).

import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { health, scopes, recall, remember, grep, scopeMap, addLane } from "./engine.mjs";

const PORT = Number(process.env.PORT || 8477);
const SERVICE = { god: "mnemosyne", role: "memory", version: "0.1.0" };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.resolve(__dirname, "..", "ui");

const STATIC_CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

// Serves a file from ui/ by request pathname (which is prefixed with /ui).
// "/ui" and "/ui/" both resolve to index.html. Path-traversal safe: the
// resolved path must stay inside UI_DIR.
async function serveUiAsset(res, pathname) {
  const rel = pathname === "/ui" || pathname === "/ui/" ? "index.html" : pathname.slice("/ui/".length);
  const filePath = path.resolve(UI_DIR, rel);
  if (filePath !== UI_DIR && !filePath.startsWith(UI_DIR + path.sep)) {
    return send(res, 403, { error: "forbidden", route: `GET ${pathname}` });
  }
  try {
    const body = await readFile(filePath);
    const ext = path.extname(filePath);
    const contentType = STATIC_CONTENT_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, { "content-type": contentType, "content-length": body.length });
    return res.end(body);
  } catch (e) {
    if (e.code === "ENOENT") {
      return send(res, 404, { error: "not found", route: `GET ${pathname}` });
    }
    throw e;
  }
}

function send(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => {
      buf += c;
      if (buf.length > 4 * 1024 * 1024) reject(new Error("payload too large"));
    });
    req.on("end", () => {
      if (!buf.trim()) return resolve({});
      try {
        resolve(JSON.parse(buf));
      } catch {
        reject(Object.assign(new Error("invalid JSON body"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const route = `${req.method} ${url.pathname}`;
  const t0 = Date.now();
  // Lightweight request log — proves what actually reaches the memory god
  // (which consumers route recall/remember THROUGH Mnemosyne vs shelling direct).
  res.on("finish", () => {
    console.log(`[mnemosyne] ${route} -> ${res.statusCode} ${Date.now() - t0}ms`);
  });
  try {
    if (route === "GET /") {
      // Browser navigation (Accept includes text/html) -> land on the UI shell.
      // Everyone else (curl, fetch() with no/JSON Accept, existing consumers)
      // keeps getting the JSON info blob unchanged.
      const accept = String(req.headers.accept || "");
      if (accept.includes("text/html")) {
        res.writeHead(302, { location: "/ui" });
        return res.end();
      }
      return send(res, 200, {
        ...SERVICE,
        description:
          "Pantheon memory god — thin service wrapping the swarm-memory engine over the Qdrant SSOT.",
        endpoints: {
          "GET /ui": "standalone UI shell (browser)",
          "GET /health": "engine self-test (Qdrant + embedder + graph)",
          "GET /scopes": "configured scopes + escalation ladders",
          "GET /config": "read-only effective config (qdrant_url, embedder, default_scope, fallback_collection)",
          "POST /recall": "{query, scope?, hits?, escalate?, min_score?, radius?} -> ranked hits w/ provenance",
          "POST /remember": "{text, scope?, tag?} -> write-back (index into scope collection)",
          "POST /grep": "{query, scope?, hits?, escalate?, radius?} -> KEYWORD hits (exact-string, no embedder)",
          "POST /lanes": "{name, collection, ladder?} -> add-only atomic write of a new scope to config.toml",
        },
      });
    }

    if (req.method === "GET" && (url.pathname === "/ui" || url.pathname.startsWith("/ui/"))) {
      return await serveUiAsset(res, url.pathname);
    }

    if (route === "GET /health") {
      const h = await health();
      return send(res, h.ok ? 200 : 503, { ...SERVICE, ...h });
    }

    if (route === "GET /scopes") {
      return send(res, 200, { ...SERVICE, ...(await scopes()) });
    }

    if (route === "GET /config") {
      const m = await scopeMap();
      return send(res, 200, {
        ...SERVICE,
        qdrant_url: m.qdrant_url,
        embedder: m.embedder,
        default_scope: m.default_scope,
        fallback_collection: m.fallback_collection,
        scopes: m.scopes,
        ladder: m.ladder,
      });
    }

    if (route === "POST /grep") {
      const b = await readJson(req);
      const result = await grep(b.query, b.scope, {
        hits: b.hits,
        escalate: b.escalate,
        radius: b.radius,
      });
      return send(res, 200, { ...result, took_ms: Date.now() - t0 });
    }

    if (route === "POST /recall") {
      const b = await readJson(req);
      const result = await recall(b.query, b.scope, {
        hits: b.hits,
        escalate: b.escalate,
        minScore: b.min_score,
        radius: b.radius,
      });
      console.log(
        `[mnemosyne] recall q=${JSON.stringify(String(b.query || "").slice(0, 80))} ` +
          `scope=${b.scope || "(default)"} total_hits=${result.total_hits ?? 0}`
      );
      return send(res, 200, { ...result, took_ms: Date.now() - t0 });
    }

    if (route === "POST /remember") {
      const b = await readJson(req);
      const result = await remember(b.text, b.scope, { tag: b.tag });
      return send(res, 200, { ...result, took_ms: Date.now() - t0 });
    }

    if (route === "POST /lanes") {
      const b = await readJson(req);
      const result = await addLane(b.name, b.collection, b.ladder);
      return send(res, 200, { ...result, took_ms: Date.now() - t0 });
    }

    return send(res, 404, { error: "not found", route });
  } catch (e) {
    const status = e.status || 500;
    return send(res, status, { error: String(e.message || e), route });
  }
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[mnemosyne] memory god listening on http://127.0.0.1:${PORT}`);
});
