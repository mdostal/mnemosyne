// server.mjs — Mnemosyne HTTP surface (the memory god's API).
//
// Transport-only: parses requests, delegates every memory op to engine.mjs
// (which wraps the swarm-memory CLI over the live Qdrant SSOT), and shapes the
// JSON response. Zero third-party deps — Node's built-in http, so it just runs.
//
//   GET  /                 -> service info + endpoint list
//   GET  /health           -> engine self-test (Qdrant/embedder/graph)
//   GET  /healthz          -> liveness alias (always 200 if the process is up)
//   GET  /scopes           -> configured scopes + escalation ladders
//   POST /recall  {query, scope?, hits?, escalate?, min_score?, radius?}
//   POST /remember {text, scope?, tag?}
//
// PORT env (default 8477).

import http from "node:http";
import { health, scopes, recall, remember, grep } from "./engine.mjs";

const PORT = Number(process.env.PORT || 8477);
const SERVICE = { god: "mnemosyne", role: "memory", version: "0.1.0" };

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
      return send(res, 200, {
        ...SERVICE,
        description:
          "Pantheon memory god — thin service wrapping the swarm-memory engine over the Qdrant SSOT.",
        endpoints: {
          "GET /health": "engine self-test (Qdrant + embedder + graph)",
          "GET /healthz": "liveness alias (always 200) for external checkers",
          "GET /scopes": "configured scopes + escalation ladders",
          "POST /recall": "{query, scope?, hits?, escalate?, min_score?, radius?} -> ranked hits w/ provenance",
          "POST /remember": "{text, scope?, tag?} -> write-back (index into scope collection)",
          "POST /grep": "{query, scope?, hits?, escalate?, radius?} -> KEYWORD hits (exact-string, no embedder)",
        },
      });
    }

    if (route === "GET /health") {
      const h = await health();
      return send(res, h.ok ? 200 : 503, { ...SERVICE, ...h });
    }

    // Liveness alias: process-up check only, no CLI shell-out. Deliberately
    // always 200 (never mirrors /health's 503) so external checkers (Salus,
    // Argus) never 404 or page on a transient engine hiccup — deep engine
    // health stays on /health.
    if (route === "GET /healthz") {
      return send(res, 200, { ...SERVICE, alive: true });
    }

    if (route === "GET /scopes") {
      return send(res, 200, { ...SERVICE, ...(await scopes()) });
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
      if (b.layer === "code-graph") {
        const { CodeGraphLayer } = await import("./layers/code-graph.mjs");
        const graph = new CodeGraphLayer();
        const result = await graph.remember(b.src, b.predicate, b.dst);
        return send(res, 200, { ...result, took_ms: Date.now() - t0 });
      }
      const result = await remember(b.text, b.scope, { tag: b.tag });
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
