// search-route.mjs — TDD tests for s-03's GET /search convenience endpoint.
//
// GET /search is a THIN dispatcher: it reuses engine.mjs's recall()/grep()
// verbatim (see SERVICE.md + s-03-collections-search.yaml) — no new query
// logic. These tests run against a REAL (subprocess) Mnemosyne server talking
// to the REAL ~/.config/swarm-memory/config.toml over the LIVE Qdrant Cloud
// SSOT (same posture as test/smoke.mjs) — never a fixture/mock — because the
// story's own acceptance criteria require proving mode-dispatch (semantic vs
// keyword) against real corpus content, not fabricated data.
//
// Nothing here is destructive: every request is a GET. No collection is ever
// wiped or modified by this suite.
//
// Distinguishing example (keyword-mode dispatch is genuinely different from
// semantic recall, not a silent alias):
//   query "ruflo" against the real `top` scope (work_root_memory, ~430 pts)
//   literally appears in dos-1117-ruflo-cba.md (confirmed via a live
//   swarm-memory grep run during story research). We assert:
//     - mode=grep: every hit has match_type "keyword" / score null (pure
//       exact-string scroll, no embedder call — see engine.grep()'s
//       `match_mode: "keyword"` normalization).
//     - mode=recall with an unreachable relevance floor (min_score=0.99):
//       every hit STILL comes back with match_type "keyword" / score null —
//       i.e. the engine's own admission that NO semantic (scored) match
//       cleared the bar for this query; the only reason anything is returned
//       at all is the literal/keyword fallback baked into `swarm-memory
//       recall` itself. This is the live, honest form of "matches literally,
//       not semantically" for this embedder/corpus (nomic-embed-text tends to
//       score literal token overlap fairly high, so a hard floor is the
//       reliable way to force pure-semantic scoring to fail while keyword
//       matching still succeeds).
//     - mode=recall's response has NO top-level `match_mode` field (that's
//       grep()'s own normalization marker) — a second, code-level proof that
//       GET /search truly reaches two different engine.mjs functions.
//
// Usage: node test/search-route.mjs
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, "..", "src", "server.mjs");
const PORT = Number(process.env.MNEMOSYNE_TEST_PORT || 8483);
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

// Real config — same file the running production instance uses. Never
// written to by this suite (GET-only).
const child = spawn(process.execPath, [SERVER_PATH], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});

let serverOutput = "";
child.stdout.on("data", (d) => { serverOutput += d.toString(); });
child.stderr.on("data", (d) => { serverOutput += d.toString(); });

const allHitsFlat = (body) =>
  (body.scopes || []).flatMap((s) => s.hits || []);

try {
  const up = await waitForServer(BASE + "/scopes");
  ok(up, "test server (real config, live Qdrant) came up");

  const cfg = await (await fetch(BASE + "/config")).json();

  // --- missing query -> 400 (delegated straight to recall()/grep()'s own
  // "query is required" validation, not duplicated) --------------------------
  {
    const res = await fetch(BASE + "/search?scope=personal");
    ok(res.status === 400, `GET /search with no q -> 400 (got ${res.status})`);
  }

  // --- invalid mode -> 400, not a silent fallback ---------------------------
  {
    const res = await fetch(BASE + "/search?q=whatever&mode=bogus");
    const body = await res.json();
    ok(res.status === 400, `GET /search?mode=bogus -> 400 (got ${res.status})`);
    ok(/mode/i.test(body.error || ""), `error mentions 'mode' (${body.error})`);
  }

  // --- semantic mode: full provenance columns --------------------------------
  {
    const res = await fetch(
      BASE + "/search?" + new URLSearchParams({
        q: "ATT client offer model retainer pricing",
        scope: "att",
        mode: "recall",
        hits: "2",
      })
    );
    const body = await res.json();
    ok(res.status === 200, `GET /search (semantic, att) -> 200 (got ${res.status})`);
    ok(body.mode === "recall", `response echoes mode=recall (${body.mode})`);
    ok(body.match_mode === undefined,
      "recall-mode response has no top-level match_mode field (grep()'s own marker, proves distinct code path)");
    ok(body.total_hits >= 1, `total_hits >= 1 (${body.total_hits})`);
    const hits = allHitsFlat(body);
    ok(hits.length >= 1, "at least one hit returned");
    const h = hits[0];
    ok(h.collection && typeof h.collection === "string", `hit has collection/layer (${h.collection})`);
    ok(h.location || h.full_path || h.source, "hit has a file/location field");
    ok(Array.isArray(h.chunk_span) || h.chunk_span === null, "hit has a chunk_span field (array or explicit null)");
    ok(h.provenance && typeof h.provenance === "object", "hit has a provenance object");
    ok(h.provenance.embed_model, `provenance has embedder (${h.provenance.embed_model})`);
    ok(h.provenance.retrieved_at, `provenance has retrieved_at (${h.provenance.retrieved_at})`);
    ok(h.provenance.chunk_index !== undefined || h.chunk_index !== undefined, "hit/provenance has chunk_index");
  }

  // --- scope param passthrough -----------------------------------------------
  {
    const resAtt = await fetch(BASE + "/search?" + new URLSearchParams({ q: "pricing", scope: "att", mode: "recall", hits: "1" }));
    const bodyAtt = await resAtt.json();
    const resPersonal = await fetch(BASE + "/search?" + new URLSearchParams({ q: "pricing", scope: "personal", mode: "recall", hits: "1" }));
    const bodyPersonal = await resPersonal.json();
    ok(resAtt.status === 200 && resPersonal.status === 200, "both scoped requests -> 200");
    ok(bodyAtt.scopes && bodyAtt.scopes[0] && bodyAtt.scopes[0].scope === "att" && bodyAtt.scopes[0].collection === cfg.scopes.att,
      `scope=att request resolves to the att collection (${JSON.stringify(bodyAtt.scopes && bodyAtt.scopes[0])})`);
    ok(bodyPersonal.scopes && bodyPersonal.scopes[0] && bodyPersonal.scopes[0].scope === "personal" && bodyPersonal.scopes[0].collection === cfg.scopes.personal,
      `scope=personal request resolves to the personal collection (${JSON.stringify(bodyPersonal.scopes && bodyPersonal.scopes[0])})`);
  }

  // --- zero hits -> explicit empty shape, not blank/missing -------------------
  {
    const nonsense = "zzqxvbbbb12399nonsensemnemosynesearchtest";
    const res = await fetch(BASE + "/search?" + new URLSearchParams({ q: nonsense, scope: "personal", mode: "grep", hits: "5" }));
    const body = await res.json();
    ok(res.status === 200, `GET /search (grep, no matches anywhere) -> 200 (got ${res.status})`);
    ok(body.total_hits === 0, `total_hits === 0 (${body.total_hits})`);
    ok(Array.isArray(body.scopes) && body.scopes.length >= 1,
      "scopes[] is still present (not omitted) so the UI can render an explicit empty-state per scope");
    ok(Array.isArray(body.scopes[0].hits) && body.scopes[0].hits.length === 0,
      "scopes[0].hits is an explicit empty array, not missing/null");
  }

  // --- keyword vs semantic mode-dispatch, verified against live corpus --------
  {
    // grep: pure exact-string scroll. "ruflo" is a real, pre-existing token in
    // the live top/work_root_memory corpus (dos-1117-ruflo-cba.md).
    const grepRes = await fetch(BASE + "/search?" + new URLSearchParams({ q: "ruflo", scope: "top", mode: "grep", hits: "5" }));
    const grepBody = await grepRes.json();
    ok(grepRes.status === 200, `GET /search (grep, ruflo) -> 200 (got ${grepRes.status})`);
    ok(grepBody.match_mode === "keyword", `grep-mode response has match_mode: "keyword" (${grepBody.match_mode})`);
    const grepHits = allHitsFlat(grepBody);
    ok(grepHits.length >= 1, `grep found >=1 real literal hit for 'ruflo' (${grepHits.length})`);
    ok(grepHits.every((h) => h.match_type === "keyword" && h.score === null),
      "every grep hit is match_type:keyword, score:null (pure exact-string, no embedder)");
    ok(grepHits.every((h) => String(h.text || "").toLowerCase().includes("ruflo")),
      "every grep hit's text literally contains the query substring");

    // recall with an unreachable relevance floor: forces the CLI's own
    // semantic scoring to fail for every candidate. Anything still returned
    // can ONLY have come from the literal/keyword fallback baked into
    // `swarm-memory recall` itself — i.e. matched literally, not
    // semantically, for this query.
    const recallRes = await fetch(BASE + "/search?" + new URLSearchParams({ q: "ruflo", scope: "top", mode: "recall", hits: "5", min_score: "0.99" }));
    const recallBody = await recallRes.json();
    ok(recallRes.status === 200, `GET /search (recall, ruflo, min_score=0.99) -> 200 (got ${recallRes.status})`);
    ok(recallBody.mode === "recall", "response echoes mode=recall");
    const recallHits = allHitsFlat(recallBody);
    ok(recallHits.length >= 1,
      `recall at an unreachable floor still returns hits (${recallHits.length}) — only via its own keyword fallback`);
    ok(recallHits.every((h) => h.score === null && h.match_type === "keyword"),
      "every hit at this floor is score:null/match_type:keyword — NO hit cleared the semantic bar (matched literally, not semantically)");
  }

  // --- GET /ui mentions the Search panel --------------------------------------
  {
    const res = await fetch(BASE + "/ui");
    const body = await res.text();
    ok(res.status === 200, `GET /ui -> 200 (got ${res.status})`);
    ok(/search/i.test(body), "GET /ui body mentions a Search panel");
    ok(/search-form/i.test(body), "GET /ui body has a search form");
  }
} finally {
  child.kill();
}

if (fails) {
  console.log("\n--- server output (for debugging) ---");
  console.log(serverOutput);
}

console.log(fails ? `\n${fails} check(s) failed` : "\nall search-route checks passed");
process.exit(fails ? 1 : 0);
