// recall-status-filtering.mjs — REAL subprocess-level integration test for
// la-05-recall-status-filtering.
//
// This is the mandatory-not-optional testing-bar item the story's `risks`
// section calls out: "a filtering bug that leaks provisional/unmerged
// content across branches as if confirmed defeats the entire point of this
// feature" — so this suite does not mock git state or fake the branch
// context. It:
//
//   1. Creates a REAL git repo on disk (`git init`), with a REAL second
//      worktree checked out to a REAL non-default branch (`git worktree
//      add ... -b`) — two genuinely distinct working directories, each on
//      its own real branch, exactly like two agents working on two
//      different feature branches of the same repo.
//   2. Spawns ONE real `src/server.mjs` subprocess (the actual live-service
//      entrypoint this repo dogfoods via its hooks — see hooks/lib/mnemo-
//      client.mjs) — a genuine separate process over real HTTP, same rigor
//      as test/http-api.mjs's `testHiveMemoryLayerConfigurable()` and the
//      pl-02 regression test it's modeled on. Uses the fake-swarm-memory
//      test double (same fixture as write-through.mjs/reindex.mjs/
//      vector.mjs) in place of a live Qdrant, extended with
//      FAKE_SWARM_INDEX_STORE (la-05) so `recall` returns hits pointing at
//      the REAL note files remember() wrote on disk — so this test exercises
//      status-filter.mjs's actual read-the-header-off-disk code path, not a
//      stubbed-out shortcut.
//   3. POSTs /remember from the feature-branch worktree's real `cwd`
//      (auto-detecting status=provisional + the real branch name from real
//      git state — la-04's own contract, unmodified here) and from the
//      main-branch worktree's `cwd` (status=confirmed).
//   4. POSTs /recall from each worktree's `cwd` and asserts:
//        AC1 - the feature branch's provisional entry is EXCLUDED when
//              recalling from the (different) main-branch worktree, by default
//        AC2 - that SAME provisional entry IS included when recalling from
//              the feature-branch worktree itself (the caller's own branch)
//        AC3 - the explicit `cross_branch_provisional` opt-in makes it visible
//              from the main-branch worktree too
//        (bonus) - the confirmed entry (written on main) is visible from
//              EVERY branch by default, including the feature branch —
//              status=confirmed is never filtered regardless of caller branch
//
// Usage: node test/recall-status-filtering.mjs
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SERVER = path.join(ROOT, "src", "server.mjs");
const FIXTURE = fileURLToPath(new URL("./fixtures/fake-swarm-memory", import.meta.url));
const PORT = 31418;
const BASE = `http://127.0.0.1:${PORT}`;

let fails = 0;
const ok = (condition, message) => {
  console.log(`${condition ? "  PASS" : "  FAIL"}  ${message}`);
  if (!condition) fails++;
};

async function git(args, cwd) {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function j(method, pathname, body) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// src/server.mjs's POST /recall wraps engine.mjs's raw recall() output
// verbatim ({query, total_hits, scopes: [{hits: [...]}]} — no top-level
// `ok`/`hits` fields, unlike the lib/mnemosyne TS client's RecallResult
// shape). Flattens every scope's hits into one array for assertions below.
function allHits(recallBody) {
  return (recallBody.scopes ?? []).flatMap((s) => s.hits ?? []);
}

async function main() {
  // --- 1. Real git repo + real second worktree on a real non-default branch ---
  const mainRoot = await mkdtemp(path.join(tmpdir(), "mnemosyne-la05-main-"));
  await git(["init", "--quiet", "-b", "main"], mainRoot);
  await git(["config", "user.email", "test@example.com"], mainRoot);
  await git(["config", "user.name", "la-05 integration test"], mainRoot);
  await git(["commit", "--quiet", "--allow-empty", "-m", "initial commit"], mainRoot);

  const featureBranch = "feat/la-05-integration-test";
  const featureRoot = await mkdtemp(path.join(tmpdir(), "mnemosyne-la05-feature-"));
  // `git worktree add` needs the target directory to not already exist as a
  // non-empty dir it doesn't control — remove the mkdtemp scaffold dir first
  // and let worktree add create it fresh, matching real `git worktree`
  // usage (a fresh checkout directory, not a pre-existing one).
  await rm(featureRoot, { recursive: true, force: true });
  await git(["worktree", "add", "--quiet", "-b", featureBranch, featureRoot, "main"], mainRoot);

  const realMainBranch = await git(["rev-parse", "--abbrev-ref", "HEAD"], mainRoot);
  const realFeatureBranch = await git(["rev-parse", "--abbrev-ref", "HEAD"], featureRoot);
  ok(realMainBranch === "main", `sanity: main worktree is really on branch 'main' (got '${realMainBranch}')`);
  ok(
    realFeatureBranch === featureBranch,
    `sanity: second worktree is really on branch '${featureBranch}' (got '${realFeatureBranch}')`,
  );
  ok(mainRoot !== featureRoot, "sanity: the two worktrees are genuinely different directories");

  // --- 2. Spawn ONE real server subprocess ------------------------------
  const notesDir = await mkdtemp(path.join(tmpdir(), "mnemosyne-la05-notes-"));
  const indexStore = path.join(await mkdtemp(path.join(tmpdir(), "mnemosyne-la05-store-")), "index-store.json");

  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      SWARM_MEMORY_BIN: FIXTURE,
      FAKE_SWARM_MODE: "success",
      FAKE_SWARM_INDEX_STORE: indexStore,
      MNEMOSYNE_NOTES_DIR: notesDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let serverOutput = "";
  child.stdout.on("data", (c) => (serverOutput += c));
  child.stderr.on("data", (c) => (serverOutput += c));

  try {
    const deadline = Date.now() + 15000;
    let up = false;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${BASE}/healthz`);
        if (res.ok) {
          up = true;
          break;
        }
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    ok(up, "real src/server.mjs subprocess started and is reachable");
    if (!up) {
      console.error(serverOutput);
      throw new Error(`server never became reachable:\n${serverOutput}`);
    }

    // --- 3. Real writes, each auto-detecting real git context from a real cwd ---
    const provisionalWrite = await j("POST", "/remember", {
      text: "la-05 integration test: provisional note written on the feature branch",
      scope: "personal",
      tag: "la05-provisional",
      cwd: featureRoot,
    });
    ok(provisionalWrite.status === 200, `provisional write -> 200 (got ${provisionalWrite.status})`);
    ok(
      provisionalWrite.body.status === "provisional",
      `provisional write -> status:provisional, auto-detected from real git state (got ${provisionalWrite.body.status})`,
    );
    ok(
      provisionalWrite.body.source_ref?.branch === featureBranch,
      `provisional write -> source_ref.branch is the REAL feature branch name (got ${provisionalWrite.body.source_ref?.branch})`,
    );

    const confirmedWrite = await j("POST", "/remember", {
      text: "la-05 integration test: confirmed note written on the main branch",
      scope: "personal",
      tag: "la05-confirmed",
      cwd: mainRoot,
    });
    ok(confirmedWrite.status === 200, `confirmed write -> 200 (got ${confirmedWrite.status})`);
    ok(
      confirmedWrite.body.status === "confirmed",
      `confirmed write -> status:confirmed, auto-detected from real git state on the default branch (got ${confirmedWrite.body.status})`,
    );

    // --- 4. Real recalls from each worktree's real cwd ---------------------

    // AC1: recalling from a DIFFERENT branch (main) excludes the feature
    // branch's provisional entry by default. The confirmed entry (also
    // present) stays visible, so we assert on which entries came back, not
    // just a bare count.
    const fromMain = await j("POST", "/recall", { query: "la-05 integration test", scope: "personal", cwd: mainRoot });
    ok(fromMain.status === 200 && Array.isArray(fromMain.body.scopes), "recall from main worktree -> 200 w/ scopes[]");
    const fromMainSources = allHits(fromMain.body).map((h) => h.provenance?.source ?? h.full_path ?? h.source ?? "");
    ok(
      !fromMainSources.some((s) => s.includes("la05-provisional")),
      `AC1: recall from a DIFFERENT branch (main) excludes the feature branch's provisional entry by default (got sources: ${JSON.stringify(fromMainSources)})`,
    );
    ok(
      fromMainSources.some((s) => s.includes("la05-confirmed")),
      `bonus: the confirmed entry (written on main) IS visible from the main worktree (got sources: ${JSON.stringify(fromMainSources)})`,
    );

    // AC2: recalling from the feature branch itself (the caller's OWN
    // current branch) includes its own provisional write by default.
    const fromFeature = await j("POST", "/recall", {
      query: "la-05 integration test",
      scope: "personal",
      cwd: featureRoot,
    });
    ok(
      fromFeature.status === 200 && Array.isArray(fromFeature.body.scopes),
      "recall from feature worktree -> 200 w/ scopes[]",
    );
    const fromFeatureSources = allHits(fromFeature.body).map(
      (h) => h.provenance?.source ?? h.full_path ?? h.source ?? "",
    );
    ok(
      fromFeatureSources.some((s) => s.includes("la05-provisional")),
      `AC2: recall from the caller's OWN branch (feature) INCLUDES its own provisional entry by default (got sources: ${JSON.stringify(fromFeatureSources)})`,
    );
    ok(
      fromFeatureSources.some((s) => s.includes("la05-confirmed")),
      `bonus: the confirmed entry is ALSO visible from the feature branch (status=confirmed is never branch-filtered) (got sources: ${JSON.stringify(fromFeatureSources)})`,
    );

    // AC3: the explicit opt-in makes the cross-branch provisional entry
    // visible from main too.
    const fromMainOptIn = await j("POST", "/recall", {
      query: "la-05 integration test",
      scope: "personal",
      cwd: mainRoot,
      cross_branch_provisional: true,
    });
    ok(
      fromMainOptIn.status === 200 && Array.isArray(fromMainOptIn.body.scopes),
      "recall from main worktree (opt-in) -> 200 w/ scopes[]",
    );
    const fromMainOptInSources = allHits(fromMainOptIn.body).map(
      (h) => h.provenance?.source ?? h.full_path ?? h.source ?? "",
    );
    ok(
      fromMainOptInSources.some((s) => s.includes("la05-provisional")),
      `AC3: the explicit cross_branch_provisional opt-in surfaces the cross-branch provisional entry on demand (got sources: ${JSON.stringify(fromMainOptInSources)})`,
    );
  } finally {
    child.kill();
    await rm(mainRoot, { recursive: true, force: true });
    // The feature worktree directory is managed by git worktree; `git
    // worktree remove` is the correct teardown, but the mainRoot .git
    // metadata is already gone by the time we'd run it, so a plain
    // recursive rm is sufficient cleanup here (this is a throwaway temp
    // dir, not a real repo anyone reuses).
    await rm(featureRoot, { recursive: true, force: true });
    await rm(notesDir, { recursive: true, force: true });
  }

  console.log(fails ? `\n${fails} check(s) failed` : "\nall recall-status-filtering checks passed");
  process.exit(fails ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
