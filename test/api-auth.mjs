// api-auth.mjs (test): PANT-1398. The daemon binds 127.0.0.1 by default and
// every route except GET /health, GET /healthz and the /ui shell needs the API
// token.
//
// 1. Unit: readApiToken (env, file, unreadable/empty file), resolveHost,
//    isPublicRoute.
// 2. In-process gate: with MNEMOSYNE_API_TOKEN set, reads answer 401 without
//    it or with a wrong one, and the handler never runs; the API token or the
//    admin token gets through; writes still need the admin token. With no
//    API token, non-loopback callers get 403 and loopback callers get through.
// 3. Real process: `node src/server.mjs` with no MNEMOSYNE_HOST binds
//    127.0.0.1 only (a non-loopback address of this host is refused), and
//    with MNEMOSYNE_HOST=0.0.0.0 a non-loopback caller is refused without the
//    token (403) and served with it.
//
// No Qdrant, swarm-memory or config.toml: engine calls are stubs, and the
// real-process checks only touch /healthz and GET /reindex (in memory).
//
// Usage: node test/api-auth.mjs
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import net from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMnemosyneServer } from "../src/server.mjs";
import { DEFAULT_HOST, isPublicRoute, readApiToken, resolveHost } from "../src/api-auth.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "  PASS" : "  FAIL"}  ${m}`);
  if (!c) fails++;
};

const API_TOKEN = "pant-1398-api-token";
const ADMIN_TOKEN = "pant-1398-admin-token";
const SCOPES = { top: "claude_knowledge" };

const tmp = await mkdtemp(path.join(tmpdir(), "mnemosyne-api-auth-"));

try {
  // --- 1. unit ----------------------------------------------------------------
  {
    ok(readApiToken({}) === "", "no env: no token");
    ok(readApiToken({ MNEMOSYNE_API_TOKEN: "  abc \n" }) === "abc", "MNEMOSYNE_API_TOKEN is trimmed");
    const file = path.join(tmp, "api-token");
    await writeFile(file, "from-the-vault\n", { mode: 0o600 });
    ok(readApiToken({ MNEMOSYNE_API_TOKEN_FILE: file }) === "from-the-vault", "MNEMOSYNE_API_TOKEN_FILE is read and trimmed");
    ok(
      readApiToken({ MNEMOSYNE_API_TOKEN: "env-wins", MNEMOSYNE_API_TOKEN_FILE: file }) === "env-wins",
      "MNEMOSYNE_API_TOKEN wins over the file"
    );
    let threw = null;
    try {
      readApiToken({ MNEMOSYNE_API_TOKEN_FILE: path.join(tmp, "missing") });
    } catch (e) {
      threw = e;
    }
    ok(threw && /could not be read/.test(threw.message), "an unreadable MNEMOSYNE_API_TOKEN_FILE throws instead of meaning 'no token'");
    const empty = path.join(tmp, "empty");
    await writeFile(empty, "\n");
    threw = null;
    try {
      readApiToken({ MNEMOSYNE_API_TOKEN_FILE: empty });
    } catch (e) {
      threw = e;
    }
    ok(threw && /is empty/.test(threw.message), "an empty MNEMOSYNE_API_TOKEN_FILE throws");

    ok(DEFAULT_HOST === "127.0.0.1" && resolveHost({}) === "127.0.0.1", "default host is 127.0.0.1");
    ok(resolveHost({ MNEMOSYNE_HOST: "0.0.0.0" }) === "0.0.0.0", "MNEMOSYNE_HOST overrides the host");

    ok(isPublicRoute("GET", "/health") && isPublicRoute("GET", "/healthz"), "/health and /healthz are public");
    ok(isPublicRoute("GET", "/ui") && isPublicRoute("GET", "/ui/app.js"), "the static /ui shell is public");
    ok(!isPublicRoute("POST", "/health"), "only GET/HEAD of a public path is public");
    ok(!isPublicRoute("GET", "/") && !isPublicRoute("GET", "/uix") && !isPublicRoute("GET", "/scopes"), "/, /uix and /scopes are not public");
  }

  // --- 2. in-process gate -------------------------------------------------------
  async function withServer(opts, fn) {
    const calls = [];
    const server = createMnemosyneServer({
      apiToken: opts.apiToken,
      adminToken: opts.adminToken || "",
      openRemember: false,
      isLocalPeer: opts.isLocalPeer,
      reindexRoots: [tmp],
      repoScopes: new Map(),
      health: async () => ({ ok: true }),
      scopeMap: async () => ({ scopes: SCOPES }),
      listCollections: async () => ({ names: Object.values(SCOPES), points: {} }),
      collectionExists: null,
      resetScopeMapCache: () => {},
      recall: async (query, scope) => {
        calls.push(["recall", query, scope]);
        return { total_hits: 0, scopes: [] };
      },
      grep: async (query, scope) => {
        calls.push(["grep", query, scope]);
        return { total_hits: 0, scopes: [] };
      },
      remember: async (text, scope) => {
        calls.push(["remember", text, scope]);
        return { remembered: true, file: "note.md", chunks_upserted: 1 };
      },
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
      await fn(url, calls);
    } finally {
      await new Promise((r) => server.close(r));
    }
  }

  const req = (url, method, route, { body, token } = {}) =>
    fetch(url + route, {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

  // Every non-public route the in-repo clients call, plus GET /.
  const GATED = [
    ["GET", "/"],
    ["GET", "/scopes"],
    ["GET", "/config"],
    ["GET", "/metrics"],
    ["GET", "/note?source=x"],
    ["GET", "/notes/x"],
    ["GET", "/search?q=x"],
    ["GET", "/graph/stats"],
    ["GET", "/graph/edges"],
    ["GET", "/graph/impact/x"],
    ["GET", "/graph/deps/x"],
    ["GET", "/reindex"],
    ["GET", "/reindex/job-1"],
    ["POST", "/recall", { query: "q", scope: "top" }],
    ["POST", "/grep", { query: "q", scope: "top" }],
    ["POST", "/remember", { text: "t", scope: "top" }],
    ["POST", "/cache/refresh"],
    ["POST", "/no-such-route"],
  ];

  await withServer({ apiToken: API_TOKEN }, async (url, calls) => {
    for (const [method, route, body] of GATED) {
      const none = await req(url, method, route, { body });
      ok(none.status === 401, `${method} ${route} with no Authorization -> 401 (got ${none.status})`);
      const wrong = await req(url, method, route, { body, token: "not-the-token" });
      const wrongBody = await wrong.json();
      ok(wrong.status === 401 && wrongBody.code === "api_token_required", `${method} ${route} with a wrong token -> 401 api_token_required`);
      ok(!JSON.stringify(wrongBody).includes(API_TOKEN), `${method} ${route}'s 401 never echoes the token`);
    }
    ok(calls.length === 0, `no handler ran without the API token (calls: ${JSON.stringify(calls)})`);

    for (const route of ["/health", "/healthz", "/ui", "/ui/app.js"]) {
      const res = await req(url, "GET", route);
      ok(res.status === 200, `GET ${route} needs no token (got ${res.status})`);
    }

    const recall = await req(url, "POST", "/recall", { body: { query: "q", scope: "top" }, token: API_TOKEN });
    ok(recall.status === 200, `POST /recall with the API token -> 200 (got ${recall.status})`);
    const grep = await req(url, "POST", "/grep", { body: { query: "q", scope: "top" }, token: API_TOKEN });
    ok(grep.status === 200, `POST /grep with the API token -> 200 (got ${grep.status})`);
    const jobs = await req(url, "GET", "/reindex", { token: API_TOKEN });
    ok(jobs.status === 200, `GET /reindex with the API token -> 200 (got ${jobs.status})`);
    const info = await req(url, "GET", "/", { token: API_TOKEN });
    ok(info.status === 200, `GET / with the API token -> 200 (got ${info.status})`);
  });

  // API + admin token: the admin token passes the read gate too, and writes
  // still need the admin token (the API token alone is not enough).
  await withServer({ apiToken: API_TOKEN, adminToken: ADMIN_TOKEN }, async (url, calls) => {
    const recall = await req(url, "POST", "/recall", { body: { query: "q", scope: "top" }, token: ADMIN_TOKEN });
    ok(recall.status === 200, `POST /recall with the admin token -> 200 (got ${recall.status})`);
    const remApi = await req(url, "POST", "/remember", { body: { text: "t", scope: "top" }, token: API_TOKEN });
    const remApiBody = await remApi.json();
    ok(
      remApi.status === 401 && /MNEMOSYNE_ADMIN_TOKEN/.test(remApiBody.error),
      `POST /remember with only the API token -> 401 from the write gate (got ${remApi.status})`
    );
    const remAdmin = await req(url, "POST", "/remember", { body: { text: "t", scope: "top" }, token: ADMIN_TOKEN });
    ok(remAdmin.status === 200, `POST /remember with the admin token -> 200 (got ${remAdmin.status})`);
    ok(
      JSON.stringify(calls.map((c) => c[0])) === JSON.stringify(["recall", "remember"]),
      `only the authorized calls ran (calls: ${JSON.stringify(calls.map((c) => c[0]))})`
    );
  });

  // No API token configured: non-loopback callers are refused everywhere but
  // the public routes; loopback callers (a standalone install) get through.
  await withServer({ apiToken: "", isLocalPeer: () => false }, async (url, calls) => {
    for (const [method, route, body] of GATED) {
      const res = await req(url, method, route, { body });
      const resBody = await res.json();
      ok(
        res.status === 403 && resBody.code === "api_token_not_configured",
        `no API token, non-loopback: ${method} ${route} -> 403 (got ${res.status})`
      );
    }
    ok(calls.length === 0, "no handler ran for a non-loopback caller");
    const health = await req(url, "GET", "/healthz");
    ok(health.status === 200, `no API token, non-loopback: GET /healthz still answers (got ${health.status})`);
  });
  await withServer({ apiToken: "" }, async (url) => {
    const recall = await req(url, "POST", "/recall", { body: { query: "q", scope: "top" } });
    ok(recall.status === 200, `no API token, loopback caller: POST /recall -> 200 (got ${recall.status})`);
  });

  // --- 3. real process: what the daemon binds -----------------------------------
  const external = Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === "IPv4" && !i.internal);

  async function freePort() {
    const s = net.createServer();
    await new Promise((r) => s.listen(0, "127.0.0.1", r));
    const { port } = s.address();
    await new Promise((r) => s.close(r));
    return port;
  }

  async function withDaemon(extraEnv, fn) {
    const port = await freePort();
    const env = { ...process.env, PORT: String(port), MNEMOSYNE_NOTES_DIR: path.join(tmp, "notes"), ...extraEnv };
    for (const k of ["MNEMOSYNE_HOST", "MNEMOSYNE_API_TOKEN", "MNEMOSYNE_API_TOKEN_FILE", "MNEMOSYNE_ADMIN_TOKEN"]) {
      if (!(k in extraEnv)) delete env[k];
    }
    const child = spawn(process.execPath, [path.join(ROOT, "src", "server.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    try {
      const deadline = Date.now() + 15_000;
      while (!/listening on/.test(out)) {
        if (Date.now() > deadline || child.exitCode !== null) throw new Error(`daemon did not start: ${out}`);
        await new Promise((r) => setTimeout(r, 50));
      }
      await fn(port, () => out);
    } finally {
      child.kill("SIGTERM");
      await new Promise((r) => (child.exitCode !== null ? r() : child.once("exit", r)));
    }
  }

  const connects = (host, port) =>
    new Promise((resolve) => {
      const sock = net.connect({ host, port });
      const done = (v) => {
        sock.destroy();
        resolve(v);
      };
      sock.setTimeout(2000, () => done(false));
      sock.once("connect", () => done(true));
      sock.once("error", () => done(false));
    });

  await withDaemon({}, async (port, log) => {
    ok(log().includes(`listening on http://127.0.0.1:${port}`), "default daemon logs 127.0.0.1");
    ok(/MNEMOSYNE_API_TOKEN is not set; only loopback callers are served/.test(log()), "it warns that no API token is set");
    const live = await fetch(`http://127.0.0.1:${port}/healthz`);
    ok(live.status === 200, `default daemon answers on 127.0.0.1 (got ${live.status})`);
    if (external) {
      ok(!(await connects(external.address, port)), `default daemon refuses a connection on ${external.address} (not *:${port})`);
    } else {
      console.log("  SKIP  no non-loopback IPv4 interface on this host; the 'not on all interfaces' check needs one");
    }
  });

  if (external) {
    await withDaemon({ MNEMOSYNE_HOST: "0.0.0.0" }, async (port, log) => {
      ok(/bound to 0\.0\.0\.0 but MNEMOSYNE_API_TOKEN is not set/.test(log()), "binding 0.0.0.0 without a token warns");
      const base = `http://${external.address}:${port}`;
      const jobs = await fetch(`${base}/reindex`);
      ok(jobs.status === 403, `MNEMOSYNE_HOST=0.0.0.0, no token: a non-loopback caller gets 403 (got ${jobs.status})`);
      const live = await fetch(`${base}/healthz`);
      ok(live.status === 200, `MNEMOSYNE_HOST=0.0.0.0: /healthz stays public (got ${live.status})`);
    });

    const tokenFile = path.join(tmp, "daemon-token");
    await writeFile(tokenFile, `${API_TOKEN}\n`, { mode: 0o600 });
    await withDaemon({ MNEMOSYNE_HOST: "0.0.0.0", MNEMOSYNE_API_TOKEN_FILE: tokenFile }, async (port) => {
      const base = `http://${external.address}:${port}`;
      const none = await fetch(`${base}/reindex`);
      ok(none.status === 401, `token from MNEMOSYNE_API_TOKEN_FILE: no Authorization -> 401 (got ${none.status})`);
      const withToken = await fetch(`${base}/reindex`, { headers: { authorization: `Bearer ${API_TOKEN}` } });
      ok(withToken.status === 200, `token from MNEMOSYNE_API_TOKEN_FILE: Bearer token -> 200 (got ${withToken.status})`);
    });
  }
} finally {
  await rm(tmp, { recursive: true, force: true });
}

if (fails) {
  console.error(`\n${fails} check(s) failed`);
  process.exit(1);
}
console.log("\nall api-auth checks passed");
