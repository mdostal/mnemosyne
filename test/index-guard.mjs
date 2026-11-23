// index-guard.mjs — first-cut-trust t1k (review-4 finding 4).
//
// 1. Every state-changing route needs MNEMOSYNE_ADMIN_TOKEN as a Bearer token:
//    401 without it, 401 with a wrong one, and the handler is never reached.
//    With no token configured, only loopback callers may write (403 otherwise).
//    Reads (/recall, /grep, GETs) need no admin token; since PANT-1398 they
//    need MNEMOSYNE_API_TOKEN instead (test/api-auth.mjs).
// 2. The indexer never reads through a symlink, a dotfile or a hidden
//    directory, and never leaves the indexed root: a `x.json -> ../.env` link
//    is skipped by POST /index and by POST /reindex's directory walk.
//
// Nothing here touches Qdrant, swarm-memory or config.toml: the engine calls
// are stubs and createMnemosyneServer() runs in-process on an ephemeral port.
//
// Usage: node test/index-guard.mjs
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMnemosyneServer } from "../src/server.mjs";
import { resolveIndexTargets, walkIndexable } from "../src/index-guard.mjs";
import { REINDEX_EXTENSIONS, walkReindexable } from "../src/engine.mjs";

let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "  PASS" : "  FAIL"}  ${m}`);
  if (!c) fails++;
};

const TOKEN = "t1k-admin-token";
const SCOPES = { top: "claude_knowledge", client: "client_x" };

// --- fixture tree -------------------------------------------------------------
//   <base>/outside/secret.txt           a file outside the indexed root
//   <base>/root/.env                    the operator's secrets
//   <base>/root/.env.local              another dotfile
//   <base>/root/.secrets/token.yaml     a hidden directory
//   <base>/root/.pHive/story.yaml       allowed hidden directory (tracked content)
//   <base>/root/repo/a.md               a normal file
//   <base>/root/repo/x.json -> ../.env  the review-4 attack
//   <base>/root/repo/y.md -> <base>/outside/secret.txt
//   <base>/root/repo/linkdir -> <base>/outside
//   <base>/root/repo/sub/b.yaml         a normal nested file
const base = await realpath(await mkdtemp(path.join(tmpdir(), "mnemosyne-index-guard-")));
const root = path.join(base, "root");
const repo = path.join(root, "repo");
const outside = path.join(base, "outside");
await mkdir(path.join(repo, "sub"), { recursive: true });
await mkdir(outside, { recursive: true });
await mkdir(path.join(root, ".secrets"), { recursive: true });
await mkdir(path.join(root, ".pHive"), { recursive: true });
await writeFile(path.join(outside, "secret.txt"), "OUTSIDE_SECRET=1\n");
await writeFile(path.join(root, ".env"), "MNEMOSYNE_ADMIN_TOKEN=leak\n");
await writeFile(path.join(root, ".env.local"), "GITHUB_TOKEN=leak\n");
await writeFile(path.join(root, ".secrets", "token.yaml"), "token: leak\n");
await writeFile(path.join(root, ".pHive", "story.yaml"), "id: story\n");
await writeFile(path.join(repo, "a.md"), "# a\n");
await writeFile(path.join(repo, "sub", "b.yaml"), "b: 1\n");
await symlink("../.env", path.join(repo, "x.json"));
await symlink(path.join(outside, "secret.txt"), path.join(repo, "y.md"));
await symlink(outside, path.join(repo, "linkdir"));

try {
  // --- walkIndexable / resolveIndexTargets ------------------------------------
  {
    const skipped = [];
    const files = [];
    for await (const f of walkIndexable(root, { onSkip: (s) => skipped.push(s) })) files.push(f);
    const rel = files.map((f) => path.relative(root, f)).sort();
    ok(
      JSON.stringify(rel) === JSON.stringify([".pHive/story.yaml", "repo/a.md", "repo/sub/b.yaml"]),
      `walk yields only real, non-hidden files under the root (got ${JSON.stringify(rel)})`
    );
    ok(!files.some((f) => /\.env|secret|token\.yaml/.test(f)), "no .env, dotfile, hidden-dir or out-of-root file is yielded");
    const reasons = Object.fromEntries(skipped.map((s) => [path.relative(root, s.path), s.reason]));
    ok(reasons["repo/x.json"] === "symlink", "x.json -> ../.env is skipped as a symlink");
    ok(reasons["repo/y.md"] === "symlink", "y.md -> a file outside the root is skipped as a symlink");
    ok(reasons["repo/linkdir"] === "symlink", "a symlinked directory is never descended into");
    ok(reasons[".env"] === "dotfile" && reasons[".env.local"] === "dotfile", ".env and .env.* are skipped as dotfiles");
    ok(reasons[".secrets"] === "hidden directory", "a hidden directory is skipped");
  }

  {
    const { files, skipped } = await resolveIndexTargets([repo], [root]);
    ok(
      JSON.stringify(files.map((f) => path.relative(root, f)).sort()) === JSON.stringify(["repo/a.md", "repo/sub/b.yaml"]),
      `POST /index's directory expansion passes only real files (got ${JSON.stringify(files)})`
    );
    ok(skipped.some((s) => s.path.endsWith("x.json")), "the x.json symlink is reported as skipped");
  }
  {
    const { files, skipped } = await resolveIndexTargets(
      [path.join(repo, "x.json"), path.join(repo, "y.md"), path.join(root, ".env"), path.join(root, ".secrets", "token.yaml")],
      [root]
    );
    ok(files.length === 0, `explicit symlink / dotfile / hidden-dir paths yield no files (got ${JSON.stringify(files)})`);
    ok(skipped.length === 4, `all four are reported as skipped (got ${JSON.stringify(skipped)})`);
  }
  {
    let err = null;
    try {
      await resolveIndexTargets([outside], [root]);
    } catch (e) {
      err = e;
    }
    ok(err && err.status === 403, `a path outside MNEMOSYNE_REINDEX_ROOTS is a 403 (got ${err && err.status})`);
    err = null;
    try {
      await resolveIndexTargets([path.join(repo, "linkdir", "secret.txt")], [root]);
    } catch (e) {
      err = e;
    }
    ok(err && err.status === 403, `a path that only reaches outside through a symlinked directory is a 403 (got ${err && err.status})`);
  }

  // --- POST /reindex's walker (engine.mjs) ------------------------------------
  {
    const files = [];
    for await (const f of walkReindexable(root)) files.push(path.relative(root, f));
    files.sort();
    ok(
      JSON.stringify(files) === JSON.stringify([".pHive/story.yaml", "repo/a.md", "repo/sub/b.yaml"]),
      `POST /reindex's walk skips symlinks, dotfiles and hidden dirs (got ${JSON.stringify(files)})`
    );
    ok(REINDEX_EXTENSIONS.has(".md") && !REINDEX_EXTENSIONS.has(".json"), "POST /reindex keeps its own extension set");
  }

  // --- HTTP gate -------------------------------------------------------------
  async function withServer(opts, fn) {
    const calls = [];
    const server = createMnemosyneServer({
      adminToken: opts.adminToken,
      openRemember: opts.openRemember || false,
      isLocalPeer: opts.isLocalPeer,
      reindexRoots: [root],
      repoScopes: new Map([["owner/repo", { scope: "client", directory: repo }]]),
      health: async () => ({ ok: true }),
      scopeMap: async () => ({ scopes: SCOPES }),
      listCollections: async () => ({ names: Object.values(SCOPES), points: {} }),
      collectionExists: null,
      resetScopeMapCache: () => {},
      createCollectionAndScope: async (name, scope) => {
        calls.push(["collections", name, scope]);
        return { collection_created: true, scope_mapped: false, ok: true, detail: "created" };
      },
      remember: async (text, scope) => {
        calls.push(["remember", text, scope]);
        return { remembered: true, file: "note.md", chunks_upserted: 1 };
      },
      recall: async (query, scope) => {
        calls.push(["recall", query, scope]);
        return { total_hits: 0, scopes: [] };
      },
      grep: async (query, scope) => {
        calls.push(["grep", query, scope]);
        return { total_hits: 0, scopes: [] };
      },
      addLane: async (name, collection) => {
        calls.push(["lanes", name, collection]);
        return { name, collection };
      },
      reindexPaths: async (collection, files) => {
        calls.push(["index", collection, files]);
        return { reindexed: true, collection, files_indexed: files.length };
      },
      reindex: async (scope) => {
        calls.push(["reindex", scope]);
        return { scope, files_scanned: 0, files_indexed: 0, errors: [] };
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

  const post = (url, route, body, token) =>
    fetch(url + route, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });

  const WRITES = [
    ["/index", { collection: "claude_knowledge", paths: [repo] }],
    ["/reindex", { scope: "client", directory: repo }],
    ["/events/repo-merged", { repo: "owner/repo", ref: "main" }],
    ["/remember", { text: "a finding", scope: "top" }],
    ["/remember", { layer: "code-graph", src: "a", predicate: "calls", dst: "b" }],
    ["/ingest", { scope: "top", docs: [{ path: "a.md", text: "# a\n\nsome text" }] }],
    ["/lanes", { name: "new-lane", collection: "new_collection" }],
    ["/collections", { scope: "top" }],
  ];

  // Token configured: every write needs it, from loopback too.
  await withServer({ adminToken: TOKEN }, async (url, calls) => {
    for (const [route, body] of WRITES) {
      const label = body.layer ? `${route} (layer ${body.layer})` : route;
      const none = await post(url, route, body);
      ok(none.status === 401, `POST ${label} with no Authorization -> 401 (got ${none.status})`);
      const wrong = await post(url, route, body, "not-the-token");
      ok(wrong.status === 401, `POST ${label} with a wrong token -> 401 (got ${wrong.status})`);
      const err = (await wrong.json()).error || "";
      ok(/MNEMOSYNE_ADMIN_TOKEN/.test(err) && !err.includes(TOKEN), `POST ${label}'s 401 names the env var, never the token`);
    }
    ok(calls.length === 0, `no handler ran for an unauthenticated write (calls: ${JSON.stringify(calls)})`);

    const index = await post(url, "/index", { collection: "claude_knowledge", paths: [repo] }, TOKEN);
    const indexBody = await index.json();
    ok(index.status === 200, `POST /index with the token -> 200 (got ${index.status}, ${JSON.stringify(indexBody)})`);
    const indexed = calls.find((c) => c[0] === "index");
    ok(
      indexed && JSON.stringify(indexed[2].map((f) => path.relative(root, f)).sort()) === JSON.stringify(["repo/a.md", "repo/sub/b.yaml"]),
      `the CLI is handed only real files, never x.json -> ../.env (got ${JSON.stringify(indexed && indexed[2])})`
    );
    ok(
      Array.isArray(indexBody.skipped) && indexBody.skipped.some((s) => s.path.endsWith("x.json") && s.reason === "symlink"),
      "the response lists x.json as skipped (symlink)"
    );
    ok(JSON.stringify(indexBody.paths) === JSON.stringify([repo]), "the response echoes the requested paths");

    // A directory that expands to many files is indexed in CLI batches.
    const big = path.join(root, "big");
    await mkdir(big, { recursive: true });
    for (let i = 0; i < 450; i++) await writeFile(path.join(big, `f${String(i).padStart(3, "0")}.md`), `# ${i}\n`);
    const before = calls.filter((c) => c[0] === "index").length;
    const bigRes = await post(url, "/index", { collection: "claude_knowledge", paths: [big] }, TOKEN);
    const bigBody = await bigRes.json();
    const batches = calls.filter((c) => c[0] === "index").slice(before);
    ok(
      bigRes.status === 200 && batches.length === 3 && batches.every((c) => c[2].length <= 200),
      `450 files go to the CLI in 3 batches of <= 200 (got ${batches.map((c) => c[2].length)})`
    );
    ok(bigBody.files_indexed === 450 && bigBody.files === 450, `batch counts are added up (got ${bigBody.files_indexed}/${bigBody.files})`);
    await rm(big, { recursive: true, force: true });

    const outsideIndex = await post(url, "/index", { collection: "claude_knowledge", paths: [outside] }, TOKEN);
    ok(outsideIndex.status === 403, `POST /index outside MNEMOSYNE_REINDEX_ROOTS -> 403 (got ${outsideIndex.status})`);

    const onlyLink = await post(url, "/index", { collection: "claude_knowledge", paths: [path.join(repo, "x.json")] }, TOKEN);
    const onlyLinkBody = await onlyLink.json();
    ok(
      onlyLink.status === 200 && onlyLinkBody.reindexed === false && onlyLinkBody.files_indexed === 0,
      `POST /index of just the symlink indexes nothing (got ${onlyLink.status}, ${JSON.stringify(onlyLinkBody)})`
    );
    ok(calls.filter((c) => c[0] === "index").length === before + 3, "the CLI is not run when nothing is indexable");

    const rem = await post(url, "/remember", { text: "a finding", scope: "top" }, TOKEN);
    ok(rem.status === 200, `POST /remember with the token -> 200 (got ${rem.status})`);
    const lane = await post(url, "/lanes", { name: "new-lane", collection: "new_collection" }, TOKEN);
    ok(lane.status === 200, `POST /lanes with the token -> 200 (got ${lane.status})`);

    // Reads stay open: the runtime hooks' /recall and /grep, and every GET.
    const recall = await post(url, "/recall", { query: "q", scope: "top" });
    ok(recall.status === 200, `POST /recall needs no token (got ${recall.status})`);
    const grep = await post(url, "/grep", { query: "q", scope: "top" });
    ok(grep.status === 200, `POST /grep needs no token (got ${grep.status})`);
    const info = await fetch(url + "/");
    ok(info.status === 200, `GET / needs no token (got ${info.status})`);
    const refresh = await fetch(url + "/cache/refresh", { method: "POST" });
    ok(refresh.status === 200, `POST /cache/refresh (in-memory only) needs no token (got ${refresh.status})`);
  });

  // MNEMOSYNE_OPEN_REMEMBER: plain /remember stays open for agent hooks; the
  // code-graph layer and every other write still need the token.
  await withServer({ adminToken: TOKEN, openRemember: true }, async (url, calls) => {
    const rem = await post(url, "/remember", { text: "hook write-back", scope: "top" });
    ok(rem.status === 200, `with MNEMOSYNE_OPEN_REMEMBER, POST /remember needs no token (got ${rem.status})`);
    const graph = await post(url, "/remember", { layer: "code-graph", src: "a", predicate: "calls", dst: "b" });
    ok(graph.status === 401, `with MNEMOSYNE_OPEN_REMEMBER, the code-graph layer still needs the token (got ${graph.status})`);
    const index = await post(url, "/index", { collection: "claude_knowledge", paths: [repo] });
    ok(index.status === 401, `with MNEMOSYNE_OPEN_REMEMBER, POST /index still needs the token (got ${index.status})`);
    ok(JSON.stringify(calls.map((c) => c[0])) === JSON.stringify(["remember"]), "only the plain remember ran");
  });

  // No token configured: loopback callers (a standalone install) may write,
  // anyone else gets 403 for every write.
  await withServer({ adminToken: "", isLocalPeer: () => false }, async (url, calls) => {
    for (const [route, body] of WRITES) {
      const label = body.layer ? `${route} (layer ${body.layer})` : route;
      const res = await post(url, route, body);
      ok(res.status === 403, `no MNEMOSYNE_ADMIN_TOKEN, non-loopback caller: POST ${label} -> 403 (got ${res.status})`);
    }
    ok(calls.length === 0, "no write handler ran for a non-loopback caller");
    // PANT-1398: with no MNEMOSYNE_API_TOKEN either, reads from a non-loopback
    // caller are refused too (see test/api-auth.mjs).
    const recall = await post(url, "/recall", { query: "q", scope: "top" });
    ok(recall.status === 403, `no tokens, non-loopback caller: POST /recall -> 403 (got ${recall.status})`);
  });
  await withServer({ adminToken: "" }, async (url) => {
    const rem = await post(url, "/remember", { text: "local write", scope: "top" });
    ok(rem.status === 200, `no MNEMOSYNE_ADMIN_TOKEN, loopback caller: POST /remember -> 200 (got ${rem.status})`);
    const coll = await post(url, "/collections", { scope: "top" });
    ok(coll.status === 403, `no MNEMOSYNE_ADMIN_TOKEN: POST /collections stays off, even from loopback (got ${coll.status})`);
  });
} finally {
  await rm(base, { recursive: true, force: true });
}

console.log(fails ? `\n${fails} check(s) failed` : "\nall index-guard checks passed");
process.exit(fails ? 1 : 0);
