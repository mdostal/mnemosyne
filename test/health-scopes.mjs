// health-scopes.mjs — PANT-833: GET /health reports per-scope collection
// existence (status "degraded" + missing_scopes when one is missing) and the
// real package.json version.
//
// Nothing here shells out to swarm-memory or touches Qdrant: the engine
// self-test, the scope map and the collections listing are all stubs, and
// createMnemosyneServer() runs in-process on an ephemeral port.
//
// Usage: node test/health-scopes.mjs
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listCollections } from "../src/collection-exists.mjs";
import { createScopeHealthCheck, healthStatus, summarizeScopeCollections } from "../src/scope-health.mjs";
import { createMnemosyneServer } from "../src/server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(await readFile(path.join(__dirname, "..", "package.json"), "utf8"));

let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "  PASS" : "  FAIL"}  ${m}`);
  if (!c) fails++;
};

const SCOPES = { top: "claude_knowledge", mnemosyne: "repo_mnemosyne", pantheon: "repo_pantheon" };

// --- pure summary ------------------------------------------------------------
{
  const s = summarizeScopeCollections(SCOPES, {
    names: ["claude_knowledge", "repo_pantheon", "unrelated"],
    points: { claude_knowledge: 120, repo_pantheon: 7 },
  });
  ok(s.scopes.top.exists === true && s.scopes.top.points === 120, "existing scope -> exists:true with its point count");
  ok(s.scopes.mnemosyne.exists === false && s.scopes.mnemosyne.collection === "repo_mnemosyne",
    "missing scope -> exists:false, names its collection");
  ok(JSON.stringify(s.missing_scopes) === '["mnemosyne"]', `missing_scopes lists only the missing scope (got ${JSON.stringify(s.missing_scopes)})`);
}

// --- listCollections(): one subprocess, wanted names passed as argv --------
{
  const seen = [];
  const listing = await listCollections(["repo_a", "repo_b"], {
    exec: async (cmd, args) => {
      seen.push(args);
      return { stdout: JSON.stringify({ names: ["repo_a"], points: { repo_a: 3 } }) };
    },
  });
  ok(seen.length === 1 && seen[0].slice(2).join(",") === "repo_a,repo_b", "listCollections() runs ONE inventory subprocess for all wanted collections");
  ok(listing.names[0] === "repo_a" && listing.points.repo_a === 3, "listCollections() returns {names, points}");
  let err = null;
  try {
    await listCollections(["repo_a"], {
      exec: async () => {
        throw Object.assign(new Error("exit 1"), { stderr: "Qdrant API key file missing" });
      },
    });
  } catch (e) {
    err = e;
  }
  ok(err && /Qdrant API key file missing/.test(err.message), "listCollections() fails loudly, never reports nothing-exists");
}

// --- check(): one listing per refresh, cached, errors stay loud -------------
{
  const calls = [];
  const check = createScopeHealthCheck({
    scopeMap: async () => ({ scopes: SCOPES }),
    listCollections: async (wanted) => {
      calls.push(wanted);
      return { names: ["claude_knowledge", "repo_mnemosyne", "repo_pantheon"], points: {} };
    },
  });
  const cold = await check();
  ok(cold.scopes_checking === true && cold.scopes === null, "cold start never blocks: scopes_checking:true");
  await tick();
  const warm = await check();
  ok(warm.scopes_checking === false && warm.missing_scopes.length === 0, "after the first refresh: all scopes present");
  await check();
  ok(calls.length === 1, `one collections listing for all scopes, then cached (got ${calls.length} listing calls)`);
  ok(calls[0].length === 3 && calls[0].includes("repo_mnemosyne"), "the listing is asked about every configured collection at once");

  const broken = createScopeHealthCheck({
    scopeMap: async () => ({ scopes: SCOPES }),
    listCollections: async () => {
      throw new Error("Qdrant unreachable");
    },
  });
  await broken();
  await tick();
  const failed = await broken();
  ok(/Qdrant unreachable/.test(failed.scope_check_error || ""), "a failed listing surfaces scope_check_error");
  ok(healthStatus(true, failed) === "degraded", "a failed scope check is degraded, never ok");
  ok(healthStatus(false, warm) === "degraded", "engine down is degraded");
}

// --- GET /health over HTTP ---------------------------------------------------
async function withServer(listing, fn) {
  const server = createMnemosyneServer({
    health: async () => ({ ok: true, engine: "swarm-memory", detail: "result: PASS" }),
    scopeMap: async () => ({ scopes: SCOPES }),
    listCollections: async () => listing,
    collectionExists: null,
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

async function getHealth(base) {
  // The first call kicks off the background refresh; poll until it settles.
  for (let i = 0; i < 50; i++) {
    const res = await fetch(`${base}/health`);
    const body = await res.json();
    if (body.scopes_checking !== true) return { status: res.status, body };
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("scope check never settled");
}

await withServer({ names: ["claude_knowledge", "repo_pantheon"], points: { claude_knowledge: 5, repo_pantheon: 2 } }, async (base) => {
  const { status, body } = await getHealth(base);
  ok(status === 200 && body.ok === true, "missing collection: HTTP 200 and ok:true (ok is engine liveness only)");
  ok(body.status === "degraded", `missing collection -> status:"degraded" (got ${body.status})`);
  ok(JSON.stringify(body.missing_scopes) === '["mnemosyne"]', `missing_scopes:["mnemosyne"] (got ${JSON.stringify(body.missing_scopes)})`);
  ok(body.scopes.mnemosyne.exists === false && body.scopes.pantheon.points === 2, "scopes map carries {collection, exists, points}");
  ok(body.version === PKG.version, `/health version == package.json version (${body.version} vs ${PKG.version})`);

  const root = await (await fetch(`${base}/`)).json();
  ok(root.version === PKG.version, `/ version == package.json version (got ${root.version})`);
  const hz = await fetch(`${base}/healthz`);
  ok(hz.status === 200, "/healthz stays 200 while /health is degraded");
});

await withServer({ names: ["claude_knowledge", "repo_mnemosyne", "repo_pantheon"], points: {} }, async (base) => {
  const { status, body } = await getHealth(base);
  ok(status === 200 && body.status === "ok", `all collections exist -> status:"ok" (got ${body.status})`);
  ok(Array.isArray(body.missing_scopes) && body.missing_scopes.length === 0, "all collections exist -> missing_scopes:[]");
});

function tick() {
  return new Promise((r) => setTimeout(r, 0));
}

console.log(fails ? `\n${fails} check(s) failed` : "\nall health scope checks passed");
process.exit(fails ? 1 : 0);
