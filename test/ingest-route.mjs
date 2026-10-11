// ingest-route.mjs — PANT-1046: POST /ingest on src/server.mjs (:8477).
//
// Nothing here touches Qdrant or swarm-memory: scopeMap/remember/grep are
// stubs backed by an in-memory "collection", and createMnemosyneServer()
// runs in-process on an ephemeral port.
//
// Usage: node test/ingest-route.mjs
import { createMnemosyneServer } from "../src/server.mjs";
import { CHUNK_SIZE_BYTES, INGEST_MARKER, MAX_INGEST_BYTES, chunkContent, sha256 } from "../src/ingest.mjs";

let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "  PASS" : "  FAIL"}  ${m}`);
  if (!c) fails++;
};

const SCOPES = {
  top: "top",
  "firefly-events--flayr": "client_firefly_events_flayr",
  "pantheon-v2": "repo_pantheon_v2",
};

// --- chunkContent(): byte-bounded, never splits a UTF-8 sequence -------------
{
  const text = "é".repeat(CHUNK_SIZE_BYTES); // 2 bytes each
  const parts = chunkContent(text);
  ok(parts.every((p) => Buffer.byteLength(p, "utf8") <= CHUNK_SIZE_BYTES), "every chunk is within CHUNK_SIZE_BYTES");
  ok(parts.join("") === text, "chunks rejoin to the original text (no split multi-byte char)");
  ok(chunkContent("").length === 0, "empty text gives zero chunks");
}

// In-memory collection: remember() appends, grep() does substring search.
function makeEngine({ failRemember = () => false, failGrep = false } = {}) {
  const store = []; // {scope, collection, text, opts}
  let n = 0;
  return {
    store,
    grepCalls: () => n,
    scopeMap: async () => ({ scopes: SCOPES }),
    remember: async (text, scope, opts) => {
      if (failRemember(text)) throw Object.assign(new Error("write-through failed: boom"), { status: 500 });
      store.push({ scope, collection: SCOPES[scope], text, opts });
      return { remembered: true, scope, collection: SCOPES[scope], file: `/notes/${store.length}.md`, chunks_upserted: 1 };
    },
    grep: async (query, scope) => {
      n++;
      if (failGrep) throw new Error("grep exploded");
      const hits = store.filter((e) => e.scope === scope && e.text.includes(query)).map((e) => ({ text: e.text }));
      return { total_hits: hits.length, scopes: [{ scope, collection: SCOPES[scope], hits }] };
    },
  };
}

async function withServer(engine, fn) {
  const server = createMnemosyneServer({
    scopeMap: engine.scopeMap,
    remember: engine.remember,
    grep: engine.grep,
    collectionExists: null,
    listCollections: async () => ({ names: Object.values(SCOPES), points: {} }),
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

async function post(base, body) {
  const r = await fetch(`${base}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

// --- happy path: two docs into a repo scope, chunked, with provenance ---------
{
  const engine = makeEngine();
  await withServer(engine, async (base) => {
    const big = "line of text\n".repeat(Math.ceil((CHUNK_SIZE_BYTES * 2.5) / 13));
    const r = await post(base, {
      scope: "firefly-events--flayr",
      docs: [
        { path: "docs/ARCH.md", text: big, metadata: { repo: "firefly-events/flayr", ref: "development" } },
        { path: "notes/readme.txt", text: "short doc" },
      ],
    });
    ok(r.status === 200 && r.body.ok === true, "200 ok for a valid two-doc ingest");
    ok(r.body.collection === "client_firefly_events_flayr", "resolves a repo scope (firefly-events--flayr) to its collection");
    const expectChunks = chunkContent(big).length;
    ok(expectChunks >= 3 && r.body.docs[0].chunk_count === expectChunks, `large doc split into ${expectChunks} chunks`);
    ok(r.body.totals.ingested === expectChunks + 1 && engine.store.length === expectChunks + 1, "one remember() per chunk");
    const first = engine.store[0];
    ok(first.text.startsWith("[ingested document] source: docs/ARCH.md (chunk 1/"), "chunk text names its source path + position");
    ok(first.text.includes('"repo":"firefly-events/flayr"') && first.text.includes(`"doc_sha256":"${sha256(big)}"`), "per-doc metadata + doc hash carried into the chunk");
    ok(first.text.includes(`${INGEST_MARKER}${sha256(chunkContent(big)[0])}`), "chunk carries its content-hash marker");
    ok(first.opts.tag === "ingest" && first.opts.status === "confirmed" && first.opts.sourceRef.branch === "ingest", "default provenance: tag=ingest, status=confirmed, branch=ingest");

    // Re-ingest the same docs: everything is a duplicate, nothing written.
    const again = await post(base, { scope: "firefly-events--flayr", docs: [{ path: "notes/readme.txt", text: "short doc" }] });
    ok(again.body.docs[0].status === "duplicate" && engine.store.length === expectChunks + 1, "re-ingest of identical content is deduped (no write)");
  });
}

// --- dedupe survives a restart: the grep check finds the marker -------------
{
  const engine = makeEngine();
  await withServer(engine, async (base) => {
    await post(base, { scope: "top", docs: [{ path: "a.md", text: "hello world" }] });
  });
  const before = engine.grepCalls();
  await withServer(engine, async (base) => {
    const r = await post(base, { scope: "top", docs: [{ path: "renamed.md", text: "hello world" }] });
    ok(r.body.docs[0].status === "duplicate" && engine.store.length === 1, "a fresh server process dedupes via the collection (grep), not memory");
    ok(engine.grepCalls() > before, "the grep check ran");
  });
  // Same text in a different scope is NOT a duplicate.
  await withServer(engine, async (base) => {
    const r = await post(base, { scope: "pantheon-v2", docs: [{ path: "a.md", text: "hello world" }] });
    ok(r.body.docs[0].status === "ingested" && engine.store.length === 2, "dedupe is per scope");
  });
}

// --- duplicate docs inside one request ---------------------------------------
{
  const engine = makeEngine();
  await withServer(engine, async (base) => {
    const r = await post(base, { scope: "top", docs: [{ path: "x.md", text: "same" }, { path: "y.md", text: "same" }] });
    ok(r.body.docs[0].status === "ingested" && r.body.docs[1].status === "duplicate" && engine.store.length === 1, "identical docs in one request are written once");
  });
}

// --- request-level validation -> 400, nothing written -------------------------
{
  const engine = makeEngine();
  await withServer(engine, async (base) => {
    const cases = [
      [{ docs: [{ path: "a.md", text: "x" }] }, /scope is required/, "missing scope"],
      [{ scope: "top" }, /docs must be a non-empty array/, "missing docs"],
      [{ scope: "top", docs: [] }, /docs must be a non-empty array/, "empty docs"],
      [{ scope: "nope", docs: [{ path: "a.md", text: "x" }] }, /unknown scope 'nope'/, "unknown scope"],
      [{ scope: "top", docs: Array.from({ length: 51 }, (_, i) => ({ path: `${i}.md`, text: "x" })) }, /at most 50 docs/, "too many docs"],
      [{ scope: "top", status: "bogus", docs: [{ path: "a.md", text: "x" }] }, /invalid status/, "bad status"],
      [{ scope: "top", source_ref: { branch: "has space" }, docs: [{ path: "a.md", text: "x" }] }, /invalid source_ref/, "bad source_ref"],
    ];
    for (const [body, re, name] of cases) {
      const r = await post(base, body);
      ok(r.status === 400 && re.test(r.body.error), `400 on ${name}`);
    }
    ok(engine.store.length === 0, "no write on any rejected request");
  });
}

// --- per-doc rejection doesn't block the other docs ---------------------------
{
  const engine = makeEngine();
  await withServer(engine, async (base) => {
    const r = await post(base, {
      scope: "top",
      docs: [
        { path: "image.png", text: "binary?" },
        { path: "huge.md", text: "x".repeat(MAX_INGEST_BYTES + 1) },
        { path: "empty.md", text: "   " },
        { path: "meta.md", text: "x", metadata: ["not", "an", "object"] },
        { path: "good.md", text: "fine" },
      ],
    });
    const st = r.body.docs.map((d) => d.status);
    ok(r.status === 200 && r.body.ok === false, "200 with ok:false when some docs are rejected");
    ok(st.slice(0, 4).every((s) => s === "rejected") && st[4] === "ingested", "bad docs rejected, good doc still ingested");
    ok(/unsupported format '\.png'/.test(r.body.docs[0].error) && /over the 200000-byte limit/.test(r.body.docs[1].error), "rejections say why");
    ok(engine.store.length === 1 && r.body.totals.rejected_docs === 4, "only the good doc was written");
  });
}

// --- caller-supplied provenance is passed through -----------------------------
{
  const engine = makeEngine();
  await withServer(engine, async (base) => {
    await post(base, {
      scope: "pantheon-v2",
      status: "provisional",
      source_ref: { branch: "feat/x", commit_sha: "abcdef1" },
      docs: [{ path: "a.md", text: "x" }],
    });
    const o = engine.store[0].opts;
    ok(o.status === "provisional" && o.sourceRef.branch === "feat/x" && o.sourceRef.commit_sha === "abcdef1", "status + source_ref reach remember()");
  });
}

// --- partial chunk failure + failed dedupe check -------------------------------
{
  const engine = makeEngine({ failRemember: (t) => t.includes("BAD") });
  await withServer(engine, async (base) => {
    const r = await post(base, { scope: "top", docs: [{ path: "a.md", text: "GOOD".padEnd(CHUNK_SIZE_BYTES, ".") + "BAD" }] });
    ok(r.body.ok === false && r.body.docs[0].status === "partial", "a mid-doc write failure marks the doc partial");
    ok(r.body.docs[0].chunks[0].status === "ingested" && r.body.docs[0].chunks[1].status === "failed", "chunks[] says which landed");
  });
  const noGrep = makeEngine({ failGrep: true });
  await withServer(noGrep, async (base) => {
    const r = await post(base, { scope: "top", docs: [{ path: "a.md", text: "x" }] });
    ok(r.body.docs[0].status === "ingested" && r.body.warnings.length === 1, "a failed dedupe check writes anyway and warns");
  });
}

// --- GET / advertises the route -------------------------------------------------
{
  const engine = makeEngine();
  await withServer(engine, async (base) => {
    const info = await (await fetch(base)).json();
    ok(typeof info.endpoints["POST /ingest"] === "string", "GET / lists POST /ingest");
  });
}

if (fails) {
  console.log(`\n${fails} failure(s)`);
  process.exit(1);
}
console.log("\nall ingest-route checks passed");
