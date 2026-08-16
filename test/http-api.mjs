// http-api.mjs — API tests for the MnemosyneClient HTTP wrapper
// (lib/mnemosyne/server.ts). Spawns the service as a subprocess against a
// throwaway root directory with known content, exercises every route over
// real HTTP, then tears the process down.
//
// Usage: node test/http-api.mjs

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");
const SERVER = path.join(ROOT, "lib", "mnemosyne", "server.ts");
const PORT = 31415;
const BASE = `http://127.0.0.1:${PORT}`;

// pw-02-get-persona-routes-cors: the UI (src/server.mjs, port 8477) and
// this HTTP API (lib/mnemosyne/server.ts, port 3141 by default) are
// DIFFERENT origins -- a browser fetch from the UI to /persona/* is a real
// cross-origin request, silently blocked without CORS. These are the two
// origins the UI is actually served from (src/server.mjs's PORT default).
const UI_ORIGIN_LOOPBACK = "http://127.0.0.1:8477";
const UI_ORIGIN_LOCALHOST = "http://localhost:8477";
const DISALLOWED_ORIGIN = "http://evil.example";

let fails = 0;
const ok = (condition, message) => {
  console.log(`${condition ? "  PASS" : "  FAIL"}  ${message}`);
  if (!condition) fails++;
};

async function j(method, pathname, body) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

async function jRaw(method, pathname, rawBody) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: { "content-type": "application/json" },
    body: rawBody,
  });
  return { status: res.status, body: await res.json() };
}

async function jOrigin(method, pathname, origin) {
  const res = await fetch(BASE + pathname, { method, headers: origin ? { origin } : undefined });
  return { status: res.status, headers: res.headers, body: await res.json() };
}

/**
 * Hand-writes a global persona YAML file directly at
 * `<home>/.mnemosyne/personas/<tier>/<scopeId>.yaml` (persona-store-global.ts's
 * fixed location convention) -- mirrors test/persona-cli.mjs's
 * writeFakeGlobalPersona exactly: this plain-`node`-run test file can't
 * import persona-store-global.ts's writeGlobalPersona in-process (no build
 * step for .ts, see tsconfig.json's noEmit), so the YAML shape is written by
 * hand. JSON.stringify'd scalars are valid YAML flow scalars.
 */
async function writeFakeGlobalPersona(home, tier, scopeId, { displayName, scope, sections }) {
  const dir = path.join(home, ".mnemosyne", "personas", tier);
  await mkdir(dir, { recursive: true });
  const yamlText =
    [
      `tier: ${JSON.stringify(tier)}`,
      `scopeId: ${JSON.stringify(scopeId)}`,
      `displayName: ${JSON.stringify(displayName)}`,
      `scope: ${JSON.stringify(scope)}`,
      `sections:`,
      ...sections.flatMap((s) => [`  - heading: ${JSON.stringify(s.heading)}`, `    body: ${JSON.stringify(s.body)}`]),
    ].join("\n") + "\n";
  await writeFile(path.join(dir, `${scopeId}.yaml`), yamlText, "utf8");
}

/**
 * Same convention as writeFakeGlobalPersona, but for the repo-local store's
 * fixed location: `<repoRoot>/.mnemosyne/personas/<scopeId>.yaml`
 * (persona-store-repo-local.ts) -- tier is always 'code-architect'.
 */
async function writeFakeRepoLocalPersona(repoRoot, scopeId, { displayName, scope, sections }) {
  const dir = path.join(repoRoot, ".mnemosyne", "personas");
  await mkdir(dir, { recursive: true });
  const yamlText =
    [
      `tier: "code-architect"`,
      `scopeId: ${JSON.stringify(scopeId)}`,
      `displayName: ${JSON.stringify(displayName)}`,
      `scope: ${JSON.stringify(scope)}`,
      `sections:`,
      ...sections.flatMap((s) => [`  - heading: ${JSON.stringify(s.heading)}`, `    body: ${JSON.stringify(s.body)}`]),
    ].join("\n") + "\n";
  await writeFile(path.join(dir, `${scopeId}.yaml`), yamlText, "utf8");
}

/**
 * pw-15-post-persona-routes: reads a global persona back directly off disk
 * at persona-store-global.ts's fixed location convention
 * (`<home>/.mnemosyne/personas/<tier>/<scopeId>.yaml`) and parses it with
 * the same `yaml` package's `parse()` that `readGlobalPersona` itself calls
 * internally -- this plain-`node`-run test file can't import
 * persona-store-global.ts's `readGlobalPersona` in-process (no build step
 * for .ts, same constraint `writeFakeGlobalPersona` above documents), so
 * this is the closest equivalent: a real filesystem read + the identical
 * parse call, not just trusting the HTTP response body.
 */
async function readWrittenGlobalPersona(home, tier, scopeId) {
  const filePath = path.join(home, ".mnemosyne", "personas", tier, `${scopeId}.yaml`);
  const raw = await readFile(filePath, "utf8");
  return { filePath, persona: parseYaml(raw) };
}

/** Same as readWrittenGlobalPersona, but for the repo-local store's fixed location. */
async function readWrittenRepoLocalPersona(repoRoot, scopeId) {
  const filePath = path.join(repoRoot, ".mnemosyne", "personas", `${scopeId}.yaml`);
  const raw = await readFile(filePath, "utf8");
  return { filePath, persona: parseYaml(raw) };
}

async function waitForHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE + "/health");
      if (res.status === 200 || res.status === 503) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), "mnemosyne-http-api-"));
  await writeFile(path.join(root, "notes.md"), "alpha\ntarget line\nomega target\n", "utf8");

  // pw-02: a real, throwaway $HOME for this whole child process, so
  // GET /persona (global tiers) never touches the operator's actual
  // ~/.mnemosyne/personas -- mirrors test/persona-cli.mjs's and
  // test/mcp-server-persona.mjs's fake-$HOME convention. DEFAULT_GLOBAL_
  // PERSONA_ROOT (persona-store-global.ts) resolves via os.homedir() at
  // import time, so this must be set before the child process starts.
  const fakeHome = await mkdtemp(path.join(tmpdir(), "mnemosyne-http-api-home-"));

  const child = spawn(TSX, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      MNEMOSYNE_PORT: String(PORT),
      MNEMOSYNE_ROOT_DIR: root,
      HOME: fakeHome,
      SWARM_MEMORY_BIN: "/definitely/missing/swarm-memory",
      SWARM_MEMORY_GRAPH_DB: path.join(root, "missing-graph.sqlite"),
      // cr-01-graphify-default-layer: this suite's whole point below is a
      // deterministic "the graph layer is unavailable, recall floors at
      // file" scenario -- SWARM_MEMORY_BIN/SWARM_MEMORY_GRAPH_DB above
      // already disable 'code-graph' the same way. graphify is now the
      // DEFAULT structural-graph layer and this sandbox has the real
      // binary on PATH, so without this override it would actually run
      // `graphify update` against `root` and find real hits there,
      // breaking this test's "exactly 2 file-layer hits" premise. Breaking
      // GRAPHIFY_BIN too keeps this test's original intent (and its
      // assertions) unchanged -- config.ts's soft default then falls back
      // to 'code-graph' (also broken above), so this is genuinely the
      // "both graph backends unavailable" case, not a graphify-specific one.
      GRAPHIFY_BIN: "/definitely/missing/graphify-binary-xyz",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let serverOutput = "";
  child.stdout.on("data", (c) => (serverOutput += c));
  child.stderr.on("data", (c) => (serverOutput += c));

  try {
    const up = await waitForHealth(15000);
    ok(up, "server started and is reachable");
    if (!up) {
      console.error(serverOutput);
      throw new Error("server never became reachable");
    }

    // GET /health -> layer availability status
    const health = await j("GET", "/health");
    ok(health.status === 200, `GET /health -> 200 (got ${health.status})`);
    ok(health.body.ok === true, "GET /health -> ok:true");
    ok(
      Array.isArray(health.body.layers) && health.body.layers.some((l) => l.layer === "file" && l.available === true),
      "GET /health -> file layer reported available",
    );

    // GET /layers (pl-03-layer-ab-testing) -> the resolved layer stack,
    // introspection only — must never call recall() itself, so it stays
    // safe from the known unrelated better-sqlite3/CodeGraphLayerAdapter
    // crash the POST /recall calls below hit on this machine.
    const layers = await j("GET", "/layers");
    ok(layers.status === 200, `GET /layers -> 200 (got ${layers.status})`);
    ok(
      Array.isArray(layers.body.layers) && layers.body.layers.length === 3,
      `GET /layers -> 3 layers by default (got ${JSON.stringify(layers.body.layers)})`,
    );
    // cr-01-graphify-default-layer: the unconfigured default's first slot
    // is normally 'graphify' (see layers/config.ts), but this subprocess's
    // GRAPHIFY_BIN is deliberately broken above (same reason as
    // SWARM_MEMORY_BIN) so the soft default's PATH-unavailable fallback
    // resolves it back to 'code-graph' here -- still the right assertion
    // for THIS deliberately-degraded environment, not a stale one.
    ok(
      layers.body.layers.map((l) => l.layer).join(",") === "code-graph,vector,file",
      `GET /layers -> default cascade order code-graph,vector,file (got ${layers.body.layers.map((l) => l.layer).join(",")})`,
    );
    ok(
      layers.body.layers.every((l) => typeof l.writable === "boolean"),
      "GET /layers -> every entry has a boolean writable flag",
    );

    // pw-04-layer-stack-visibility: GET /layers is the Personas panel's
    // layer-stack section's only data source, fetched cross-origin from the
    // UI (port 8477) exactly like /persona/* is -- same CORS contract,
    // extended here rather than duplicated (see server.ts's applyPersonaCors
    // reuse). Mirrors the /persona CORS assertions below.
    const layersCorsLoopback = await jOrigin("GET", "/layers", UI_ORIGIN_LOOPBACK);
    ok(
      layersCorsLoopback.headers.get("access-control-allow-origin") === UI_ORIGIN_LOOPBACK,
      `GET /layers from ${UI_ORIGIN_LOOPBACK} -> Access-Control-Allow-Origin: ${UI_ORIGIN_LOOPBACK} (got ${layersCorsLoopback.headers.get("access-control-allow-origin")})`,
    );
    const layersCorsLocalhost = await jOrigin("GET", "/layers", UI_ORIGIN_LOCALHOST);
    ok(
      layersCorsLocalhost.headers.get("access-control-allow-origin") === UI_ORIGIN_LOCALHOST,
      `GET /layers from ${UI_ORIGIN_LOCALHOST} -> Access-Control-Allow-Origin: ${UI_ORIGIN_LOCALHOST} (got ${layersCorsLocalhost.headers.get("access-control-allow-origin")})`,
    );
    const layersCorsDisallowed = await jOrigin("GET", "/layers", DISALLOWED_ORIGIN);
    ok(
      layersCorsDisallowed.headers.get("access-control-allow-origin") !== "*" &&
        layersCorsDisallowed.headers.get("access-control-allow-origin") !== DISALLOWED_ORIGIN,
      `GET /layers from an unknown origin -> Access-Control-Allow-Origin is NOT a wildcard and does NOT reflect the disallowed origin (got ${layersCorsDisallowed.headers.get("access-control-allow-origin")})`,
    );

    // Runs its own separate server subprocess, so it's independent of this
    // block's child/root cleanup — positioned here (before POST /recall
    // below) for the same reason the GET /layers checks above are: POST
    // /recall crashes this process on this machine (known, unrelated
    // better-sqlite3/CodeGraphLayerAdapter native-binding issue), and
    // anything after that crash never runs.
    await testHiveMemoryLayerConfigurable();

    // pw-02-get-persona-routes-cors: GET /persona and GET /persona/:tier/:scopeId,
    // plus the CORS header the UI (a genuinely different origin, port 8477)
    // needs to actually reach these routes from a browser. Positioned here
    // (before POST /recall below), same reasoning as testHiveMemoryLayerConfigurable
    // above -- POST /recall crashes this process on this machine, so anything
    // after it never runs.

    // --- GET /persona (global tiers, no ?repo) -- EMPTY store first -----
    const globalListEmpty = await j("GET", "/persona");
    ok(globalListEmpty.status === 200, `GET /persona (empty global store) -> 200 (got ${globalListEmpty.status})`);
    ok(
      Array.isArray(globalListEmpty.body.personas) && globalListEmpty.body.personas.length === 0,
      `GET /persona (empty global store) -> personas: [] (got ${JSON.stringify(globalListEmpty.body.personas)})`,
    );

    // GET /persona/:tier/:scopeId on an unseeded scope -> 404, not a crash
    const globalReadMissing = await j("GET", "/persona/company-director/no-such-scope");
    ok(
      globalReadMissing.status === 404,
      `GET /persona/company-director/no-such-scope (unseeded) -> 404 (got ${globalReadMissing.status})`,
    );
    ok(!!globalReadMissing.body.error?.message, "GET /persona/:tier/:scopeId (unseeded) -> has error detail");

    // --- now seed a real global persona and re-read: POPULATED store ----
    const globalPersonaFixture = {
      displayName: "Acme Co. Director",
      scope: "Owns Acme's product/business context.",
      sections: [{ heading: "What this tier owns", body: "PW02_GLOBAL_MARKER — hand-written fixture content." }],
    };
    await writeFakeGlobalPersona(fakeHome, "company-director", "acme-director", globalPersonaFixture);

    const globalListPopulated = await j("GET", "/persona");
    ok(globalListPopulated.status === 200, `GET /persona (populated) -> 200 (got ${globalListPopulated.status})`);
    ok(
      Array.isArray(globalListPopulated.body.personas) &&
        globalListPopulated.body.personas.some((p) => p.tier === "company-director" && p.scopeId === "acme-director"),
      `GET /persona (populated) -> includes the seeded {tier, scopeId} (got ${JSON.stringify(globalListPopulated.body.personas)})`,
    );

    const globalRead = await j("GET", "/persona/company-director/acme-director");
    ok(globalRead.status === 200, `GET /persona/company-director/acme-director -> 200 (got ${globalRead.status})`);
    ok(
      globalRead.body.persona?.tier === "company-director" &&
        globalRead.body.persona?.scopeId === "acme-director" &&
        globalRead.body.persona?.displayName === globalPersonaFixture.displayName &&
        globalRead.body.persona?.scope === globalPersonaFixture.scope &&
        JSON.stringify(globalRead.body.persona?.sections) === JSON.stringify(globalPersonaFixture.sections),
      `GET /persona/:tier/:scopeId -> round-trips the hand-written persona byte-for-byte (got ${JSON.stringify(globalRead.body.persona)})`,
    );

    // --- GET /persona?repo=<path> (repo-local, code-architect) -- EMPTY --
    const repoListEmpty = await j("GET", `/persona?repo=${encodeURIComponent(root)}`);
    ok(repoListEmpty.status === 200, `GET /persona?repo=<empty repo> -> 200 (got ${repoListEmpty.status})`);
    ok(
      Array.isArray(repoListEmpty.body.personas) && repoListEmpty.body.personas.length === 0,
      `GET /persona?repo=<empty repo> -> personas: [] (got ${JSON.stringify(repoListEmpty.body.personas)})`,
    );

    const repoReadMissing = await j("GET", `/persona/code-architect/no-such-scope?repo=${encodeURIComponent(root)}`);
    ok(
      repoReadMissing.status === 404,
      `GET /persona/code-architect/no-such-scope?repo=... (unseeded) -> 404 (got ${repoReadMissing.status})`,
    );

    // repo-local read with no ?repo at all -> 400, not a crash or a silent global-store lookup
    const repoReadNoRepoParam = await j("GET", "/persona/code-architect/no-such-scope");
    ok(
      repoReadNoRepoParam.status === 400,
      `GET /persona/code-architect/:scopeId with no ?repo -> 400 (got ${repoReadNoRepoParam.status})`,
    );

    // --- seed a real repo-local persona and re-read: POPULATED ----------
    const repoPersonaFixture = {
      displayName: "notes.md Area Architect",
      scope: "Owns the notes.md area of this repo.",
      sections: [{ heading: "What this tier owns", body: "PW02_REPO_LOCAL_MARKER — hand-written fixture content." }],
    };
    await writeFakeRepoLocalPersona(root, "notes-area", repoPersonaFixture);

    const repoListPopulated = await j("GET", `/persona?repo=${encodeURIComponent(root)}`);
    ok(repoListPopulated.status === 200, `GET /persona?repo=<populated repo> -> 200 (got ${repoListPopulated.status})`);
    ok(
      Array.isArray(repoListPopulated.body.personas) &&
        repoListPopulated.body.personas.some((p) => p.tier === "code-architect" && p.scopeId === "notes-area"),
      `GET /persona?repo=<populated repo> -> includes the seeded code-architect persona (got ${JSON.stringify(repoListPopulated.body.personas)})`,
    );
    ok(
      repoListPopulated.body.personas.every((p) => p.tier === "code-architect") &&
        !repoListPopulated.body.personas.some((p) => p.scopeId === "acme-director"),
      "GET /persona?repo=... -> repo-local list does NOT include global-tier personas (switches, not merges)",
    );

    const repoRead = await j("GET", `/persona/code-architect/notes-area?repo=${encodeURIComponent(root)}`);
    ok(repoRead.status === 200, `GET /persona/code-architect/notes-area?repo=... -> 200 (got ${repoRead.status})`);
    ok(
      repoRead.body.persona?.tier === "code-architect" &&
        repoRead.body.persona?.scopeId === "notes-area" &&
        repoRead.body.persona?.displayName === repoPersonaFixture.displayName &&
        repoRead.body.persona?.scope === repoPersonaFixture.scope &&
        JSON.stringify(repoRead.body.persona?.sections) === JSON.stringify(repoPersonaFixture.sections),
      `GET /persona/code-architect/:scopeId?repo=... -> round-trips the hand-written persona byte-for-byte (got ${JSON.stringify(repoRead.body.persona)})`,
    );

    // --- CORS: Access-Control-Allow-Origin on /persona/*, scoped -- not "*" ---
    const corsLoopback = await jOrigin("GET", "/persona", UI_ORIGIN_LOOPBACK);
    ok(
      corsLoopback.headers.get("access-control-allow-origin") === UI_ORIGIN_LOOPBACK,
      `GET /persona from ${UI_ORIGIN_LOOPBACK} -> Access-Control-Allow-Origin: ${UI_ORIGIN_LOOPBACK} (got ${corsLoopback.headers.get("access-control-allow-origin")})`,
    );

    const corsLocalhost = await jOrigin("GET", "/persona", UI_ORIGIN_LOCALHOST);
    ok(
      corsLocalhost.headers.get("access-control-allow-origin") === UI_ORIGIN_LOCALHOST,
      `GET /persona from ${UI_ORIGIN_LOCALHOST} -> Access-Control-Allow-Origin: ${UI_ORIGIN_LOCALHOST} (got ${corsLocalhost.headers.get("access-control-allow-origin")})`,
    );

    const corsReadRoute = await jOrigin("GET", "/persona/company-director/acme-director", UI_ORIGIN_LOOPBACK);
    ok(
      corsReadRoute.headers.get("access-control-allow-origin") === UI_ORIGIN_LOOPBACK,
      `GET /persona/:tier/:scopeId from ${UI_ORIGIN_LOOPBACK} -> Access-Control-Allow-Origin present and scoped (got ${corsReadRoute.headers.get("access-control-allow-origin")})`,
    );

    const corsDisallowed = await jOrigin("GET", "/persona", DISALLOWED_ORIGIN);
    ok(
      corsDisallowed.headers.get("access-control-allow-origin") !== "*" &&
        corsDisallowed.headers.get("access-control-allow-origin") !== DISALLOWED_ORIGIN,
      `GET /persona from an unknown origin -> Access-Control-Allow-Origin is NOT a wildcard and does NOT reflect the disallowed origin (got ${corsDisallowed.headers.get("access-control-allow-origin")})`,
    );

    const corsNoOrigin = await jOrigin("GET", "/persona", undefined);
    ok(
      corsNoOrigin.headers.get("access-control-allow-origin") !== "*",
      `GET /persona with no Origin header -> Access-Control-Allow-Origin is never a wildcard (got ${corsNoOrigin.headers.get("access-control-allow-origin")})`,
    );

    // --- POST /persona/:tier/:scopeId -- pw-15-post-persona-routes -------
    // The 4th write-capable transport alongside CLI/MCP/skill-harness,
    // wrapping writeGlobalPersona/writeRepoLocalPersona directly. Every
    // "reject" assertion below checks the response body's error.message
    // against the EXACT string the underlying store function itself throws
    // (persona.ts's assertValidPersona / persona-store-global.ts's
    // assertGlobalTier / persona-store-repo-local.ts's assertRepoLocalTier)
    // -- since this plain-`node`-run test file can't import those .ts
    // functions in-process to call them side-by-side (no build step, same
    // constraint documented on writeFakeGlobalPersona above), an exact
    // string match against their known thrown messages is the strongest
    // available proof that the HTTP route surfaces their real error
    // unchanged, with no re-derived/rewritten validation logic in between.

    // --- successful global-tier write -> real on-disk file --------------
    const globalCreateBody = {
      tier: "company-director",
      scopeId: "pw15-global-scope",
      displayName: "PW15 Global Director",
      scope: "Owns PW15's global-write test scope.",
      sections: [{ heading: "What this tier owns", body: "PW15_GLOBAL_CREATE_MARKER" }],
    };
    const globalCreate = await j("POST", "/persona/company-director/pw15-global-scope", globalCreateBody);
    ok(globalCreate.status === 201, `POST /persona/company-director/pw15-global-scope -> 201 (got ${globalCreate.status})`);
    ok(globalCreate.body.created === true, "POST /persona/company-director/pw15-global-scope -> created:true");
    ok(
      typeof globalCreate.body.path === "string" && globalCreate.body.path.length > 0,
      `POST /persona/company-director/pw15-global-scope -> response includes the on-disk path (got ${JSON.stringify(globalCreate.body.path)})`,
    );

    const globalOnDisk = await readWrittenGlobalPersona(fakeHome, "company-director", "pw15-global-scope");
    ok(
      globalOnDisk.persona.tier === "company-director" &&
        globalOnDisk.persona.scopeId === "pw15-global-scope" &&
        globalOnDisk.persona.displayName === globalCreateBody.displayName &&
        globalOnDisk.persona.scope === globalCreateBody.scope &&
        JSON.stringify(globalOnDisk.persona.sections) === JSON.stringify(globalCreateBody.sections),
      `POST /persona/company-director/pw15-global-scope -> a REAL on-disk file matches the posted candidate (read directly off disk, not just the HTTP response) (got ${JSON.stringify(globalOnDisk.persona)})`,
    );
    ok(
      globalOnDisk.filePath === globalCreate.body.path,
      `POST /persona/company-director/pw15-global-scope -> response 'path' matches the real on-disk file path (got response=${globalCreate.body.path} disk=${globalOnDisk.filePath})`,
    );

    // the write is visible through the existing GET route too -- same store, same function family
    const globalReadBackAfterCreate = await j("GET", "/persona/company-director/pw15-global-scope");
    ok(
      globalReadBackAfterCreate.status === 200 &&
        globalReadBackAfterCreate.body.persona?.displayName === globalCreateBody.displayName,
      "POST then GET /persona/company-director/pw15-global-scope -> the POST write is visible via the read route too",
    );

    // --- successful repo-local write -> real on-disk file, ?repo= query -
    const repoCreateBody = {
      tier: "code-architect",
      scopeId: "pw15-repo-scope",
      displayName: "PW15 Repo Architect",
      scope: "Owns PW15's repo-local write test scope.",
      sections: [{ heading: "What this tier owns", body: "PW15_REPO_CREATE_MARKER" }],
    };
    const repoCreate = await j(
      "POST",
      `/persona/code-architect/pw15-repo-scope?repo=${encodeURIComponent(root)}`,
      repoCreateBody,
    );
    ok(
      repoCreate.status === 201,
      `POST /persona/code-architect/pw15-repo-scope?repo=... -> 201 (got ${repoCreate.status})`,
    );
    const repoOnDisk = await readWrittenRepoLocalPersona(root, "pw15-repo-scope");
    ok(
      repoOnDisk.persona.tier === "code-architect" &&
        repoOnDisk.persona.scopeId === "pw15-repo-scope" &&
        repoOnDisk.persona.displayName === repoCreateBody.displayName &&
        repoOnDisk.persona.scope === repoCreateBody.scope &&
        JSON.stringify(repoOnDisk.persona.sections) === JSON.stringify(repoCreateBody.sections),
      `POST /persona/code-architect/pw15-repo-scope?repo=... -> a REAL on-disk file matches the posted candidate (got ${JSON.stringify(repoOnDisk.persona)})`,
    );

    // repo-local write with `repo` given in the request body instead of the query string --
    // design_decisions: "repo-local writes need repo in the request body or query"
    const repoCreateBody2 = { ...repoCreateBody, scopeId: "pw15-repo-scope-body", repo: root };
    const repoCreate2 = await j("POST", "/persona/code-architect/pw15-repo-scope-body", repoCreateBody2);
    ok(
      repoCreate2.status === 201,
      `POST /persona/code-architect/pw15-repo-scope-body (repo in request body) -> 201 (got ${repoCreate2.status})`,
    );
    const repoOnDisk2 = await readWrittenRepoLocalPersona(root, "pw15-repo-scope-body");
    ok(
      repoOnDisk2.persona.scopeId === "pw15-repo-scope-body",
      "POST /persona/... with 'repo' in the request body -> real on-disk file written at the repo-local store",
    );

    // --- rejection: repo-local write with no repo at all -> 400 --------
    const repoCreateNoRepo = await j("POST", "/persona/code-architect/pw15-missing-repo", {
      tier: "code-architect",
      scopeId: "pw15-missing-repo",
      displayName: "x",
      scope: "y",
      sections: [],
    });
    ok(
      repoCreateNoRepo.status === 400,
      `POST /persona/code-architect/:scopeId with no repo (body or query) -> 400, never a 500 (got ${repoCreateNoRepo.status})`,
    );
    ok(
      repoCreateNoRepo.body.error?.code === "missing_repo",
      `POST /persona/code-architect/... with no repo -> error.code === missing_repo (got ${JSON.stringify(repoCreateNoRepo.body.error)})`,
    );

    // --- rejection: mandateSections smuggling -> 400, exact underlying message ---
    const mandateSmuggleBody = {
      tier: "company-director",
      scopeId: "pw15-mandate-smuggle",
      displayName: "x",
      scope: "y",
      sections: [],
      mandateSections: [{ heading: "smuggled", body: "smuggled" }],
    };
    const mandateSmuggle = await j("POST", "/persona/company-director/pw15-mandate-smuggle", mandateSmuggleBody);
    ok(
      mandateSmuggle.status === 400,
      `POST /persona/... (mandateSections smuggling) -> 400, never a 500 (got ${mandateSmuggle.status})`,
    );
    ok(
      mandateSmuggle.body.error?.message ===
        "Invalid persona: 'mandateSections' is never author-storable -- it is a shared, code-owned constant re-injected at render time (design-discussion.md §3a), never per-persona content. Remove it from the candidate before writing.",
      `POST /persona/... (mandateSections smuggling) -> 400 body carries the EXACT error assertValidPersona itself throws, proving no behavioral drift between the HTTP route and the underlying write function (got ${JSON.stringify(mandateSmuggle.body.error)})`,
    );
    // the candidate must never have reached disk
    await readWrittenGlobalPersona(fakeHome, "company-director", "pw15-mandate-smuggle").then(
      () => ok(false, "POST /persona/... (mandateSections smuggling) -> must NOT write a file to disk"),
      () => ok(true, "POST /persona/... (mandateSections smuggling) -> no file was written to disk (rejected before any write)"),
    );

    // --- rejection: tier/target mismatch -> 400, exact underlying message ---
    // a code-architect candidate posted at a global-store URL tier
    const tierMismatchBody = {
      tier: "code-architect",
      scopeId: "pw15-tier-mismatch",
      displayName: "x",
      scope: "y",
      sections: [],
    };
    const tierMismatch = await j("POST", "/persona/top-orchestrator/pw15-tier-mismatch", tierMismatchBody);
    ok(
      tierMismatch.status === 400,
      `POST /persona/top-orchestrator/... (tier/target mismatch) -> 400, never a 500 (got ${tierMismatch.status})`,
    );
    ok(
      tierMismatch.body.error?.message ===
        "The global persona store never holds 'code-architect' personas -- got tier 'code-architect'. code-architect personas belong in the repo-local store (persona-store-repo-local.ts), not this one. Refusing to write.",
      `POST /persona/top-orchestrator/... (tier/target mismatch) -> 400 body carries the EXACT error writeGlobalPersona's own assertGlobalTier throws, proving no behavioral drift (got ${JSON.stringify(tierMismatch.body.error)})`,
    );

    // mirror case: a global-store-tier candidate posted at the repo-local route
    const tierMismatchRepoBody = {
      tier: "company-director",
      scopeId: "pw15-tier-mismatch-repo",
      displayName: "x",
      scope: "y",
      sections: [],
    };
    const tierMismatchRepo = await j(
      "POST",
      `/persona/code-architect/pw15-tier-mismatch-repo?repo=${encodeURIComponent(root)}`,
      tierMismatchRepoBody,
    );
    ok(
      tierMismatchRepo.status === 400,
      `POST /persona/code-architect/...?repo=... (tier/target mismatch, global-store tier at the repo-local route) -> 400, never a 500 (got ${tierMismatchRepo.status})`,
    );
    ok(
      tierMismatchRepo.body.error?.message ===
        "The repo-local persona store only holds 'code-architect' personas -- got tier 'company-director', which belongs in the global store (not this one). Refusing to write.",
      `POST /persona/code-architect/...?repo=... (tier/target mismatch) -> 400 body carries the EXACT error writeRepoLocalPersona's own assertRepoLocalTier throws, proving no behavioral drift (got ${JSON.stringify(tierMismatchRepo.body.error)})`,
    );

    // --- CORS: Access-Control-Allow-Origin on POST /persona/*, scoped -- not "*" ---
    const postCorsBase = { tier: "company-director", displayName: "x", scope: "y", sections: [] };

    const postCorsLoopbackRes = await fetch(BASE + "/persona/company-director/pw15-cors-loopback", {
      method: "POST",
      headers: { "content-type": "application/json", origin: UI_ORIGIN_LOOPBACK },
      body: JSON.stringify({ ...postCorsBase, scopeId: "pw15-cors-loopback" }),
    });
    ok(
      postCorsLoopbackRes.headers.get("access-control-allow-origin") === UI_ORIGIN_LOOPBACK,
      `POST /persona/:tier/:scopeId from ${UI_ORIGIN_LOOPBACK} -> Access-Control-Allow-Origin: ${UI_ORIGIN_LOOPBACK} (got ${postCorsLoopbackRes.headers.get("access-control-allow-origin")})`,
    );

    const postCorsLocalhostRes = await fetch(BASE + "/persona/company-director/pw15-cors-localhost", {
      method: "POST",
      headers: { "content-type": "application/json", origin: UI_ORIGIN_LOCALHOST },
      body: JSON.stringify({ ...postCorsBase, scopeId: "pw15-cors-localhost" }),
    });
    ok(
      postCorsLocalhostRes.headers.get("access-control-allow-origin") === UI_ORIGIN_LOCALHOST,
      `POST /persona/:tier/:scopeId from ${UI_ORIGIN_LOCALHOST} -> Access-Control-Allow-Origin: ${UI_ORIGIN_LOCALHOST} (got ${postCorsLocalhostRes.headers.get("access-control-allow-origin")})`,
    );

    const postCorsDisallowedRes = await fetch(BASE + "/persona/company-director/pw15-cors-disallowed", {
      method: "POST",
      headers: { "content-type": "application/json", origin: DISALLOWED_ORIGIN },
      body: JSON.stringify({ ...postCorsBase, scopeId: "pw15-cors-disallowed" }),
    });
    ok(
      postCorsDisallowedRes.headers.get("access-control-allow-origin") !== "*" &&
        postCorsDisallowedRes.headers.get("access-control-allow-origin") !== DISALLOWED_ORIGIN,
      `POST /persona/:tier/:scopeId from an unknown origin -> Access-Control-Allow-Origin is NOT a wildcard and does NOT reflect the disallowed origin (got ${postCorsDisallowedRes.headers.get("access-control-allow-origin")})`,
    );

    const postCorsNoOriginRes = await fetch(BASE + "/persona/company-director/pw15-cors-noorigin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...postCorsBase, scopeId: "pw15-cors-noorigin" }),
    });
    ok(
      postCorsNoOriginRes.headers.get("access-control-allow-origin") !== "*",
      `POST /persona/:tier/:scopeId with no Origin header -> Access-Control-Allow-Origin is never a wildcard (got ${postCorsNoOriginRes.headers.get("access-control-allow-origin")})`,
    );

    // POST /recall -> 200 with RecallResult JSON
    const recall = await j("POST", "/recall", { query: "target", scope: "project" });
    ok(recall.status === 200, `POST /recall -> 200 (got ${recall.status})`);
    ok(recall.body.ok === true, "POST /recall -> ok:true");
    ok(
      Array.isArray(recall.body.hits) && recall.body.hits.length === 2,
      `POST /recall -> 2 hits (got ${recall.body.hits && recall.body.hits.length})`,
    );
    ok(
      recall.body.hits?.[0]?.provenance?.layer === "file",
      "POST /recall -> hit provenance.layer === file",
    );

    // POST /recall with missing scope -> 400
    const missingScope = await j("POST", "/recall", { query: "target" });
    ok(missingScope.status === 400, `POST /recall (missing scope) -> 400 (got ${missingScope.status})`);
    ok(!!missingScope.body.error?.message, "POST /recall (missing scope) -> has error detail");

    // POST /recall with missing query -> 400
    const missingQuery = await j("POST", "/recall", { scope: "project" });
    ok(missingQuery.status === 400, `POST /recall (missing query) -> 400 (got ${missingQuery.status})`);

    // POST /remember -> 200 with RememberResult JSON
    const remember = await j("POST", "/remember", {
      content: { text: "decision: ship the http api" },
      scope: "project",
    });
    ok(remember.status === 200, `POST /remember -> 200 (got ${remember.status})`);
    ok(remember.body.ok === true, "POST /remember -> ok:true");
    ok(remember.body.layer === "file", "POST /remember -> layer:file (default)");
    ok(!!remember.body.provenance, "POST /remember -> has provenance");

    // POST /remember with missing content -> 400
    const missingContent = await j("POST", "/remember", { scope: "project" });
    ok(missingContent.status === 400, `POST /remember (missing content) -> 400 (got ${missingContent.status})`);

    // Invalid JSON body -> 400
    const invalidJson = await jRaw("POST", "/recall", "{not json");
    ok(invalidJson.status === 400, `POST /recall (invalid JSON) -> 400 (got ${invalidJson.status})`);
    ok(!!invalidJson.body.error?.message, "POST /recall (invalid JSON) -> has error detail");

    // Unknown route -> 404
    const notFound = await j("GET", "/nope");
    ok(notFound.status === 404, `GET /nope -> 404 (got ${notFound.status})`);
  } finally {
    child.kill();
    await rm(root, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  }

  console.log(fails ? `\n${fails} check(s) failed` : "\nall http-api checks passed");
  process.exit(fails ? 1 : 0);
}

// testHiveMemoryLayerConfigurable — regression test for a real bug found
// during independent verification (2026-08-13): HiveMemoryLayerAdapter
// self-registers into defaultRegistry() as a side effect of its own module
// being imported (see HiveMemoryLayerAdapter.ts's bottom), but nothing in
// the real consumer path (client.ts, and therefore this server.ts) imported
// it — only test files and benchmarks/layer-ab-test.ts did, by importing
// the adapter directly. That masked the gap completely: every unit test
// passed, the benchmark worked, and yet a real running server process
// couldn't actually resolve "hive-memory" via MNEMOSYNE_LAYERS — it would
// throw "unknown layer 'hive-memory'" at construction time. Fixed by adding
// a side-effect import in client.ts. This test spawns a REAL separate server
// subprocess (not a direct in-process import) specifically so it can't be
// silently satisfied the same way again.
async function testHiveMemoryLayerConfigurable() {
  const port = PORT + 1;
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(TSX, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      MNEMOSYNE_PORT: String(port),
      MNEMOSYNE_LAYERS: JSON.stringify({ layers: [{ name: "file" }, { name: "hive-memory" }] }),
      SWARM_MEMORY_BIN: "/definitely/missing/swarm-memory",
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
        const res = await fetch(`${base}/health`);
        if (res.status === 200 || res.status === 503) {
          up = true;
          break;
        }
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    ok(up, "MNEMOSYNE_LAYERS=[file,hive-memory] server started and is reachable");
    if (!up) {
      console.error(serverOutput);
      throw new Error(`server never became reachable:\n${serverOutput}`);
    }

    const res = await fetch(`${base}/layers`);
    const body = await res.json();
    ok(res.status === 200, `GET /layers (configured) -> 200 (got ${res.status})`);
    ok(
      Array.isArray(body.layers) && body.layers.map((l) => l.layer).join(",") === "file,hive-memory",
      `GET /layers (configured) -> [file,hive-memory] actually resolved in a real running process (got ${JSON.stringify(body.layers)})`,
    );
  } finally {
    child.kill();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
