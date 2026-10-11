// collections-route.mjs — PANT-983 / mnemosyne#63: POST /collections creates a
// registered scope's Qdrant collection over HTTP, so a scope POST /lanes added
// can be reindexed without a shell in the container.
//
// Nothing here touches Qdrant or config.toml: the scope map, the create call
// and the collections listing are stubs, and createMnemosyneServer() runs
// in-process on an ephemeral port. createCollectionAndScope()'s own argv and
// output handling are checked with an injected exec.
//
// Usage: node test/collections-route.mjs
import { createCollectionAndScope } from "../src/collection-exists.mjs";
import { createMnemosyneServer } from "../src/server.mjs";

let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "  PASS" : "  FAIL"}  ${m}`);
  if (!c) fails++;
};

const TOKEN = "s3cret-admin-token";
const SCOPES = { top: "claude_knowledge", "firefly-events--flayr": "client_firefly_events_flayr" };

// --- createCollectionAndScope(): one subprocess, (name, scope) as argv -------
{
  const seen = [];
  const result = await createCollectionAndScope("client_x", "x", {
    exec: async (cmd, args) => {
      seen.push(args);
      return { stdout: JSON.stringify({ name: "client_x", scope: "x", collection_created: true, scope_mapped: false, ok: true, detail: "created" }) };
    },
  });
  ok(seen.length === 1 && seen[0].slice(2).join(",") === "client_x,x", "runs ONE python subprocess with (collection, scope) as argv");
  ok(/create_collection_and_scope/.test(seen[0][1]) && !/delete|drop/i.test(seen[0][1]), "calls create_collection_and_scope, no delete/drop");
  ok(result.ok === true && result.collection_created === true, "returns the primitive's parsed result");
  let err = null;
  try {
    await createCollectionAndScope("client_x", "x", {
      exec: async () => {
        throw Object.assign(new Error("exit 1"), { stderr: "Qdrant API key file missing" });
      },
    });
  } catch (e) {
    err = e;
  }
  ok(err && /Qdrant API key file missing/.test(err.message), "a failed subprocess fails loudly with its stderr");
}

// --- POST /collections over HTTP ---------------------------------------------
async function withServer(opts, fn) {
  const created = [];
  let resets = 0;
  let listings = 0;
  const server = createMnemosyneServer({
    adminToken: opts.adminToken,
    health: async () => ({ ok: true, engine: "swarm-memory", detail: "result: PASS" }),
    scopeMap: async () => ({ scopes: SCOPES }),
    listCollections: async () => {
      listings++;
      return { names: ["claude_knowledge"], points: {} };
    },
    collectionExists: null,
    resetScopeMapCache: () => {
      resets++;
    },
    createCollectionAndScope: async (name, scope) => {
      created.push([name, scope]);
      return opts.result || { name, scope, collection_created: true, scope_mapped: false, ok: true, detail: `collection '${name}' created` };
    },
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, { created, resets: () => resets, listings: () => listings });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function post(base, body, token) {
  return fetch(`${base}/collections`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

await withServer({ adminToken: "" }, async (base, s) => {
  const res = await post(base, { scope: "firefly-events--flayr" }, TOKEN);
  const body = await res.json();
  ok(res.status === 403 && /MNEMOSYNE_ADMIN_TOKEN/.test(body.error), `no MNEMOSYNE_ADMIN_TOKEN -> 403, route off (got ${res.status})`);
  ok(s.created.length === 0, "disabled route creates nothing");
});

await withServer({ adminToken: TOKEN }, async (base, s) => {
  const none = await post(base, { scope: "firefly-events--flayr" });
  ok(none.status === 401, `no Authorization header -> 401 (got ${none.status})`);
  const wrong = await post(base, { scope: "firefly-events--flayr" }, "nope");
  ok(wrong.status === 401, `wrong token -> 401 (got ${wrong.status})`);
  ok(s.created.length === 0, "an unauthenticated call creates nothing");

  const missing = await post(base, {}, TOKEN);
  ok(missing.status === 400, `no scope -> 400 (got ${missing.status})`);
  const unknown = await post(base, { scope: "never-registered" }, TOKEN);
  const unknownBody = await unknown.json();
  ok(unknown.status === 400 && /POST \/lanes/.test(unknownBody.error), `unregistered scope -> 400 pointing at POST /lanes (got ${unknown.status})`);
  const mismatch = await post(base, { scope: "firefly-events--flayr", collection: "other" }, TOKEN);
  ok(mismatch.status === 409, `collection that isn't the scope's -> 409 (got ${mismatch.status})`);
  ok(s.created.length === 0, "rejected calls create nothing");

  // Prime /health's scope cache, then create: the next /health must refresh.
  await fetch(`${base}/health`);
  await new Promise((r) => setTimeout(r, 10));
  const before = s.listings();
  const res = await post(base, { scope: "firefly-events--flayr" }, TOKEN);
  const body = await res.json();
  ok(res.status === 201 && body.collection_created === true, `new collection -> 201 collection_created:true (got ${res.status})`);
  ok(JSON.stringify(s.created) === '[["client_firefly_events_flayr","firefly-events--flayr"]]', "creates exactly the collection the scope map names");
  ok(body.collection === "client_firefly_events_flayr" && body.scope === "firefly-events--flayr", "response names scope + collection");
  ok(s.resets() === 0, "scope already mapped -> scope cache left alone");
  await fetch(`${base}/health`);
  await new Promise((r) => setTimeout(r, 10));
  ok(s.listings() > before, "a create invalidates /health's cached scope check");
});

await withServer(
  { adminToken: TOKEN, result: { collection_created: false, scope_mapped: true, ok: true, detail: "already existed; mapping written" } },
  async (base, s) => {
    const res = await post(base, { scope: "firefly-events--flayr", collection: "client_firefly_events_flayr" }, TOKEN);
    const body = await res.json();
    ok(res.status === 200 && body.collection_created === false, `existing collection -> 200, idempotent (got ${res.status})`);
    ok(s.resets() === 1, "a mapping write clears the scope-map cache");
  },
);

await withServer(
  { adminToken: TOKEN, result: { collection_created: false, scope_mapped: false, ok: false, detail: "collection creation failed; no scope-mapping write was attempted: boom" } },
  async (base) => {
    const res = await post(base, { scope: "firefly-events--flayr" }, TOKEN);
    const body = await res.json();
    ok(res.status === 502 && /boom/.test(body.error), `primitive reports ok:false -> 502 with its detail (got ${res.status})`);
  },
);

console.log(fails ? `\n${fails} check(s) failed` : "\nall collections route checks passed");
process.exit(fails ? 1 : 0);
