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
//   GET  /search  ?q=&scope=&mode=recall|grep&hits=&escalate=&min_score=&radius=
//                    -> thin dispatcher to recall()/grep() for the UI's Search panel
//   GET  /graph/stats            -> graph size + origin breakdown (swarm-memory graph stats)
//   GET  /graph/edges  ?node=    -> list edges, optionally touching `node` (graph edges)
//   GET  /graph/impact/:node ?depth= -> reverse closure: what's affected if :node changes
//   GET  /graph/deps/:node   ?depth= -> forward closure: what :node depends on
//                    -> READ-ONLY graph exploration. `graph add`/`graph remove` (the
//                       graph's mutation verbs) are never wrapped or reachable here.
//   POST /index   {collection, paths[]} -> `swarm-memory index <collection> <paths...>`,
//                     CLI's DEFAULT pruning (never --no-prune). Requires an explicit
//                     operator-selected collection + >=1 path; no reindex-everything mode.
//   POST /cache/refresh -> LOCAL-ONLY: clears engine.mjs's in-memory scopeMap cache.
//                     Touches zero external state (not Qdrant, not config.toml, not
//                     graph.sqlite) and spawns zero subprocesses. See "Refresh config
//                     cache" in SERVICE.md — never confuse this with data deletion.
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
import {
  health,
  scopes,
  recall,
  remember,
  grep,
  scopeMap,
  addLane,
  graphStats,
  graphEdges,
  graphImpact,
  graphDeps,
  reindex,
  resetScopeMapCache,
} from "./engine.mjs";

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
          "GET /search": "?q=&scope=&mode=recall|grep&hits=&escalate=&min_score=&radius= -> dispatches to recall()/grep()",
          "GET /graph/stats": "graph size + origin breakdown (swarm-memory graph stats)",
          "GET /graph/edges": "?node= -> list edges, optionally touching `node` (READ-ONLY)",
          "GET /graph/impact/:node": "?depth= -> reverse closure: what's affected if :node changes",
          "GET /graph/deps/:node": "?depth= -> forward closure: what :node depends on",
          "POST /index": "{collection, paths[]} -> swarm-memory index <collection> <paths...> (default pruning, never --no-prune)",
          "POST /cache/refresh": "clears ONLY the in-memory config cache (local, zero subprocesses, zero external state)",
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

    if (route === "GET /search") {
      // Thin GET-based dispatcher for the UI's Search panel: reuses
      // recall()/grep() verbatim (no new query-building logic here) so the
      // UI has one uniform GET fetch surface across a semantic/keyword
      // toggle rather than mixing GET/POST conventions across panels.
      const q = url.searchParams.get("q");
      const scope = url.searchParams.get("scope") || undefined;
      const modeParam = url.searchParams.get("mode");
      const mode = modeParam == null || modeParam === "" ? "recall" : modeParam;
      if (mode !== "recall" && mode !== "grep") {
        const err = new Error(`invalid mode '${mode}' — mode must be 'recall' (semantic) or 'grep' (keyword)`);
        err.status = 400;
        throw err;
      }
      const hitsParam = url.searchParams.get("hits");
      const radiusParam = url.searchParams.get("radius");
      const escalateParam = url.searchParams.get("escalate");
      const minScoreParam = url.searchParams.get("min_score");
      const opts = {
        hits: hitsParam != null ? Number(hitsParam) : undefined,
        escalate: escalateParam === "true" || escalateParam === "1",
        radius: radiusParam != null ? Number(radiusParam) : undefined,
      };
      const result =
        mode === "recall"
          ? await recall(q, scope, { ...opts, minScore: minScoreParam != null ? Number(minScoreParam) : undefined })
          : await grep(q, scope, opts);
      return send(res, 200, { ...result, mode, took_ms: Date.now() - t0 });
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

    // --- Operations (s-05): Reindex + Refresh config cache ------------------
    // TWO DISTINCT actions that must never be conflated:
    //   POST /index         -> shells out to `swarm-memory index` (default
    //                           pruning; live Qdrant Cloud write). Requires an
    //                           explicit collection + >=1 path from the operator.
    //   POST /cache/refresh -> purely local: clears engine.mjs's in-memory
    //                           scopeMap cache only. No subprocess, no Qdrant,
    //                           no config.toml, no graph.sqlite. NOT a data
    //                           deletion of any kind.
    // Neither route, nor any function either calls, ever wraps a Qdrant
    // collection delete/wipe/drop — no such verb exists in the swarm-memory
    // CLI and none is invented here. See SERVICE.md's hard guardrail.

    if (route === "POST /index") {
      const b = await readJson(req);
      const result = await reindex(b.collection, b.paths);
      return send(res, 200, { ...result, took_ms: Date.now() - t0 });
    }

    if (route === "POST /cache/refresh") {
      // Synchronous, local-only — never awaits anything, spawns nothing.
      const result = resetScopeMapCache();
      return send(res, 200, { ...SERVICE, ...result, took_ms: Date.now() - t0 });
    }

    // --- Graph (s-04): READ-ONLY impact-graph exploration ------------------
    // Wraps only swarm-memory's graph QUERY verbs (stats/edges/impact/deps).
    // `graph add`/`graph remove` (the graph's mutation verbs) are never
    // wrapped by engine.mjs and no route below reaches them — graph mutation
    // is out of scope for this story (see s-04-graph-view.yaml).

    if (route === "GET /graph/stats") {
      const stats = await graphStats();
      return send(res, 200, { ...stats, took_ms: Date.now() - t0 });
    }

    if (req.method === "GET" && url.pathname === "/graph/edges") {
      const node = url.searchParams.get("node") || undefined;
      const edges = await graphEdges(node);
      return send(res, 200, { node: node || null, count: edges.length, edges, took_ms: Date.now() - t0 });
    }

    if (req.method === "GET" && url.pathname.startsWith("/graph/impact/")) {
      const node = decodeURIComponent(url.pathname.slice("/graph/impact/".length));
      const depthParam = url.searchParams.get("depth");
      const impact = await graphImpact(node, { depth: depthParam != null ? Number(depthParam) : undefined });
      return send(res, 200, { node, count: impact.length, impact, took_ms: Date.now() - t0 });
    }

    if (req.method === "GET" && url.pathname.startsWith("/graph/deps/")) {
      const node = decodeURIComponent(url.pathname.slice("/graph/deps/".length));
      const depthParam = url.searchParams.get("depth");
      const deps = await graphDeps(node, { depth: depthParam != null ? Number(depthParam) : undefined });
      return send(res, 200, { node, count: deps.length, deps, took_ms: Date.now() - t0 });
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
