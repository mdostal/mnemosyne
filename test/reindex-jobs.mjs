// reindex-jobs.mjs — PANT-837: observable, deduplicated reindex jobs, the
// POST /events/repo-merged trigger, and the MNEMOSYNE_REINDEX_ROOTS gate.
//
// Every reindex() here is a stub (a deferred promise the test settles by
// hand), so the suite never shells out to swarm-memory or touches Qdrant.
// Two layers:
//   - createReindexJobs() directly: lifecycle, dedup, missing collection,
//     history pruning.
//   - createMnemosyneServer() in-process on an ephemeral port with the same
//     stubs injected: the HTTP contract (202/200/403/404/422 shapes).
//
// Usage: node test/reindex-jobs.mjs
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createReindexJobs,
  normalizeRepo,
  parseReindexRoots,
  parseRepoScopes,
  resolveAllowedDirectory,
} from "../src/reindex-jobs.mjs";
import { createMnemosyneServer } from "../src/server.mjs";

let fails = 0;
// process.stdout directly: quiet() below mutes console.* (the job store's own
// logging), and results must still print.
const ok = (c, m) => {
  process.stdout.write(`${c ? "  PASS" : "  FAIL"}  ${m}\n`);
  if (!c) fails++;
};

// A stub reindex() whose calls stay pending until the test settles them.
function stubReindex() {
  const calls = [];
  const fn = (scope, opts) =>
    new Promise((resolve, reject) => {
      calls.push({ scope, opts, resolve, reject });
    });
  return { fn, calls };
}

const tick = () => new Promise((r) => setImmediate(r));
async function until(pred, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

const quiet = async (fn) => {
  const { log, error } = console;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.error = error;
  }
};

// --- job store: running -> succeeded ------------------------------------------
{
  const stub = stubReindex();
  const jobs = createReindexJobs({ reindex: stub.fn });
  const { job, deduplicated, done } = jobs.start({ scope: "project", collection: "c", directory: "/d" });
  ok(job.status === "running" && !deduplicated, `start -> running, not deduplicated (got ${job.status})`);
  ok(typeof job.job_id === "string" && job.job_id.length > 0, "start assigns a job_id");
  ok(job.started_at && job.finished_at === null, "running job has started_at, no finished_at");
  await tick();
  ok(stub.calls.length === 1 && stub.calls[0].scope === "project" && stub.calls[0].opts.directory === "/d",
    "reindex() called once with the job's scope + directory");
  ok(jobs.get(job.job_id).status === "running", "get() still reports running while reindex() is pending");

  stub.calls[0].resolve({ files_scanned: 4, files_indexed: 3, errors: [{ file: "x.md", error: "boom" }] });
  await quiet(() => done);
  const after = jobs.get(job.job_id);
  ok(after.status === "succeeded", `running -> succeeded (got ${after.status})`);
  ok(after.files_scanned === 4 && after.files_indexed === 3, "counts copied from reindex() result");
  ok(after.errors.length === 1 && after.errors[0].file === "x.md", "per-file errors kept on a succeeded job");
  ok(typeof after.finished_at === "string", "finished_at set");
  ok(!("done" in after), "job view doesn't leak the internal promise");
}

// --- job store: running -> failed, error captured ----------------------------
{
  const stub = stubReindex();
  const jobs = createReindexJobs({ reindex: stub.fn });
  const { job, done } = jobs.start({ scope: "project", collection: "c", directory: "/d" });
  await tick();
  stub.calls[0].reject(new Error("qdrant unreachable"));
  await quiet(() => done);
  const after = jobs.get(job.job_id);
  ok(after.status === "failed", `running -> failed (got ${after.status})`);
  ok(after.error === "qdrant unreachable", `error message captured (got ${after.error})`);
  ok(typeof after.finished_at === "string", "failed job has finished_at");
}

// --- job store: concurrent same-scope dedup ----------------------------------
{
  const stub = stubReindex();
  const jobs = createReindexJobs({ reindex: stub.fn });
  const a = jobs.start({ scope: "project", collection: "c", directory: "/d" });
  const b = jobs.start({ scope: "project", collection: "c", directory: "/other" });
  const other = jobs.start({ scope: "enterprise", collection: "e", directory: "/d" });
  ok(b.deduplicated && b.job.job_id === a.job.job_id, "second start for a running scope returns the existing job_id");
  ok(!other.deduplicated && other.job.job_id !== a.job.job_id, "a different scope gets its own job");
  await tick();
  ok(stub.calls.filter((c) => c.scope === "project").length === 1, "only ONE reindex() run for the deduped scope");

  stub.calls.forEach((c) => c.resolve({ files_scanned: 0, files_indexed: 0, errors: [] }));
  await quiet(() => Promise.all([a.done, other.done]));
  const again = jobs.start({ scope: "project", collection: "c", directory: "/d" });
  ok(!again.deduplicated && again.job.job_id !== a.job.job_id, "after the run finishes, a new start makes a new job");
  await tick();
  stub.calls.at(-1).resolve({ files_scanned: 0, files_indexed: 0, errors: [] });
  await quiet(() => again.done);
}

// --- job store: missing collection fails the job, never creates it ----------
{
  const stub = stubReindex();
  const checked = [];
  const jobs = createReindexJobs({
    reindex: stub.fn,
    collectionExists: async (name) => {
      checked.push(name);
      return false;
    },
  });
  const { job, done } = jobs.start({ scope: "project", collection: "proj_coll", directory: "/d" });
  await quiet(() => done);
  const after = jobs.get(job.job_id);
  ok(checked[0] === "proj_coll", "collectionExists() asked about the scope's collection");
  ok(after.status === "failed", `missing collection -> failed (got ${after.status})`);
  ok(/proj_coll/.test(after.error) && /does not exist/.test(after.error) && /--create/.test(after.error),
    `error names the collection and how to create it (got ${after.error})`);
  ok(stub.calls.length === 0, "reindex() never runs against a missing collection");
}

// --- job store: history keeps the last N, never evicts a running job ---------
{
  const stub = stubReindex();
  const jobs = createReindexJobs({ reindex: stub.fn, maxJobs: 2 });
  const running = jobs.start({ scope: "s0", collection: "c", directory: "/d" });
  const finished = [];
  for (let i = 1; i <= 3; i++) {
    const r = jobs.start({ scope: `s${i}`, collection: "c", directory: "/d" });
    await tick();
    stub.calls.at(-1).resolve({ files_scanned: 0, files_indexed: 0, errors: [] });
    await quiet(() => r.done);
    finished.push(r.job.job_id);
  }
  ok(jobs.get(running.job.job_id)?.status === "running", "running job survives pruning");
  ok(jobs.get(finished[0]) === null, "oldest finished job evicted past maxJobs");
  ok(jobs.get(finished[2]) !== null, "newest finished job kept");
  stub.calls[0].resolve({ files_scanned: 0, files_indexed: 0, errors: [] });
  await quiet(() => running.done);
}

// --- config parsing -------------------------------------------------------------
{
  ok(JSON.stringify(parseReindexRoots("", "/srv/app")) === JSON.stringify(["/srv/app"]),
    "MNEMOSYNE_REINDEX_ROOTS unset -> only the service cwd");
  ok(JSON.stringify(parseReindexRoots(`/a${path.delimiter}/b/`)) === JSON.stringify(["/a", "/b"]),
    "MNEMOSYNE_REINDEX_ROOTS splits on path.delimiter");
  ok(normalizeRepo("https://github.com/MDostal/Mnemosyne.git") === "mdostal/mnemosyne", "normalizeRepo strips URL/.git, lowercases");
  const map = parseRepoScopes('{"mdostal/mnemosyne": {"scope": "project", "directory": "/srv/mnemosyne"}}');
  ok(map.get("mdostal/mnemosyne")?.scope === "project", "parseRepoScopes maps repo -> scope");
  let threw = false;
  try {
    parseRepoScopes('{"x/y": {"scope": "p"}}');
  } catch {
    threw = true;
  }
  ok(threw, "parseRepoScopes rejects an entry with no directory");
}

// --- HTTP contract, in-process with stubs --------------------------------------
const base = await mkdtemp(path.join(tmpdir(), "mnemosyne-reindex-jobs-"));
const root = path.join(base, "allowed");
const repoDir = path.join(root, "mnemosyne");
const outside = path.join(base, "outside");
await mkdir(repoDir, { recursive: true });
await mkdir(outside, { recursive: true });
await symlink(outside, path.join(root, "escape"));

const stub = stubReindex();
const missingCollections = new Set(["missing_coll"]);
const server = createMnemosyneServer({
  reindex: stub.fn,
  scopeMap: async () => ({ scopes: { project: "proj_coll", enterprise: "ent_coll", ghost: "missing_coll" } }),
  collectionExists: async (name) => !missingCollections.has(name),
  reindexRoots: [root],
  repoScopes: parseRepoScopes(JSON.stringify({ "mdostal/mnemosyne": { scope: "enterprise", directory: repoDir } })),
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const post = async (p, body) => {
  const res = await fetch(BASE + p, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};
const get = async (p) => {
  const res = await fetch(BASE + p);
  return { status: res.status, body: await res.json() };
};

try {
  await quiet(async () => {
    // lifecycle: running -> succeeded
    const started = await post("/reindex", { scope: "project", directory: repoDir });
    ok(started.status === 202, `POST /reindex -> 202 (got ${started.status})`);
    ok(started.body.status === "running" && started.body.scope === "project" && started.body.job_id,
      `POST /reindex -> {job_id, scope, status:"running"} (got ${JSON.stringify(started.body)})`);
    const id = started.body.job_id;
    ok((await get(`/reindex/${id}`)).body.status === "running", "GET /reindex/:job_id -> running while pending");

    // dedup: same scope while running returns the same job
    const dup = await post("/reindex", { scope: "project", directory: repoDir });
    ok(dup.status === 202 && dup.body.job_id === id && dup.body.deduplicated === true,
      `concurrent same-scope POST /reindex returns the existing job_id (got ${JSON.stringify(dup.body)})`);
    await until(() => stub.calls.length >= 1);
    ok(stub.calls.length === 1, `only one reindex() run for the deduped scope (got ${stub.calls.length})`);

    stub.calls[0].resolve({ files_scanned: 2, files_indexed: 2, errors: [] });
    ok(await until(async () => (await get(`/reindex/${id}`)).body.status === "succeeded"), "job goes running -> succeeded");
    const done = (await get(`/reindex/${id}`)).body;
    ok(done.files_scanned === 2 && done.files_indexed === 2 && Array.isArray(done.errors),
      `succeeded job reports files_scanned/files_indexed/errors (got ${JSON.stringify(done)})`);
    ok(done.started_at && done.finished_at, "succeeded job reports started_at + finished_at");
    ok(done.trigger?.type === "api", "POST /reindex job is tagged trigger.type=api");

    // lifecycle: running -> failed
    const failing = await post("/reindex", { scope: "project", directory: repoDir });
    await until(() => stub.calls.length >= 2);
    stub.calls[1].reject(new Error("swarm-memory exploded"));
    ok(await until(async () => (await get(`/reindex/${failing.body.job_id}`)).body.status === "failed"),
      "job goes running -> failed");
    ok((await get(`/reindex/${failing.body.job_id}`)).body.error === "swarm-memory exploded", "failed job carries the error");

    // missing collection -> failed job, reindex() never called
    const ghost = await post("/reindex", { scope: "ghost", directory: repoDir });
    ok(ghost.status === 202, "POST /reindex for a scope whose collection is missing still returns 202 (fails as a job)");
    ok(await until(async () => (await get(`/reindex/${ghost.body.job_id}`)).body.status === "failed"),
      "missing-collection job -> failed");
    ok(/missing_coll/.test((await get(`/reindex/${ghost.body.job_id}`)).body.error), "error names the missing collection");
    ok(stub.calls.length === 2, "reindex() not called for the missing collection");

    // unknown job id -> 404
    const unknown = await get("/reindex/does-not-exist");
    ok(unknown.status === 404 && /does-not-exist/.test(unknown.body.error),
      `GET /reindex/<unknown> -> 404 (got ${unknown.status})`);

    // GET /reindex lists jobs newest first
    const list = await get("/reindex");
    ok(list.status === 200 && list.body.jobs[0].job_id === ghost.body.job_id, "GET /reindex lists jobs newest first");

    // roots: outside -> 403, symlink escape -> 403, nothing started
    const callsBefore = stub.calls.length;
    const out = await post("/reindex", { scope: "enterprise", directory: outside });
    ok(out.status === 403 && /outside the allowed reindex roots/.test(out.body.error),
      `directory outside MNEMOSYNE_REINDEX_ROOTS -> 403 (got ${out.status} ${JSON.stringify(out.body)})`);
    const dotdot = await post("/reindex", { scope: "enterprise", directory: path.join(root, "..", "outside") });
    ok(dotdot.status === 403, `'..' escape out of a root -> 403 (got ${dotdot.status})`);
    const esc = await post("/reindex", { scope: "enterprise", directory: path.join(root, "escape") });
    ok(esc.status === 403, `symlink inside a root pointing outside it -> 403 (got ${esc.status})`);
    const noDir = await post("/reindex", { scope: "enterprise" });
    ok(noDir.status === 403, `no directory -> service cwd, which is outside these roots -> 403 (got ${noDir.status})`);
    await tick();
    ok(stub.calls.length === callsBefore, "no reindex() started for a refused directory");

    const gone = await post("/reindex", { scope: "enterprise", directory: path.join(root, "nope") });
    ok(gone.status === 400, `in-root directory that doesn't exist -> 400 (got ${gone.status})`);

    // validation
    ok((await post("/reindex", { directory: repoDir })).status === 400, "missing scope -> 400");
    const badScope = await post("/reindex", { scope: "nope", directory: repoDir });
    ok(badScope.status === 400 && /unknown scope/.test(badScope.body.error), "unknown scope -> 400 before any job starts");

    // repo-merged: unmapped -> 422 naming the repo
    const unmapped = await post("/events/repo-merged", { repo: "firefly-events/flayr", ref: "dev" });
    ok(unmapped.status === 422, `repo-merged for an unmapped repo -> 422 (got ${unmapped.status})`);
    ok(unmapped.body.repo === "firefly-events/flayr" && /firefly-events\/flayr/.test(unmapped.body.error),
      `422 names the repo (got ${JSON.stringify(unmapped.body)})`);
    ok((await post("/events/repo-merged", { ref: "dev" })).status === 400, "repo-merged with no repo -> 400");

    // repo-merged: mapped -> starts a job for the mapped scope + directory
    const merged = await post("/events/repo-merged", { repo: "https://github.com/mdostal/mnemosyne.git", ref: "dev" });
    ok(merged.status === 202 && merged.body.scope === "enterprise" && merged.body.status === "running",
      `repo-merged for a mapped repo -> 202 running job on its scope (got ${JSON.stringify(merged.body)})`);
    await until(() => stub.calls.length > callsBefore);
    const call = stub.calls.at(-1);
    ok(call.scope === "enterprise" && call.opts.directory === repoDir, "repo-merged job reindexes the mapped directory");
    const mergedJob = (await get(`/reindex/${merged.body.job_id}`)).body;
    ok(mergedJob.trigger?.type === "repo-merged" && mergedJob.trigger.ref === "dev",
      `repo-merged job records its trigger (got ${JSON.stringify(mergedJob.trigger)})`);
    const mergedAgain = await post("/events/repo-merged", { repo: "mdostal/mnemosyne", ref: "dev" });
    ok(mergedAgain.body.job_id === merged.body.job_id && mergedAgain.body.deduplicated === true,
      "a second merge event while the scope is running joins the existing job");
    call.resolve({ files_scanned: 1, files_indexed: 1, errors: [] });
    ok(await until(async () => (await get(`/reindex/${merged.body.job_id}`)).body.status === "succeeded"),
      "repo-merged job -> succeeded");
  });

  // resolveAllowedDirectory() directly: a sibling that shares the root's prefix
  let sibling = null;
  try {
    await resolveAllowedDirectory(`${root}-evil`, [root]);
  } catch (e) {
    sibling = e.status;
  }
  ok(sibling === 403, `'<root>-evil' (shares the root's string prefix) -> 403 (got ${sibling})`);
} finally {
  await new Promise((r) => server.close(r));
  await rm(base, { recursive: true, force: true });
}

console.log(fails ? `\n${fails} check(s) failed` : "\nall reindex-jobs checks passed");
process.exit(fails ? 1 : 0);
