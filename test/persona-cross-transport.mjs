// persona-cross-transport.mjs — pw-08-cross-transport-roundtrip, extended by
// pw-16-fourth-transport-roundtrip to add HTTP as a genuine 4th transport.
//
// This story is qualitatively different from pw-05/pw-06/pw-07 individually:
// those each prove "this transport's write works in isolation." This file
// proves the design discussion's explicit risk-table guardrail -- that the
// CLI (bin/mnemosyne-persona.mjs, pw-05), the skill-harness
// (bin/mnemosyne-skill-helper.mjs's personaCreateAction/personaShowAction,
// pw-06), MCP (bin/mnemosyne-mcp.mjs's persona_create/persona_show,
// pw-07), and now HTTP (lib/mnemosyne/server.ts's GET/POST /persona/*,
// pw-02/pw-15) all funnel through the SAME underlying writeGlobalPersona/
// writeRepoLocalPersona + withLock (lib/mnemosyne/layer1/persona-store-
// global.ts, persona-store-repo-local.ts, lock.ts) -- not four
// independently-plausible-looking write paths that have quietly diverged.
//
// pw-16: at pw-08 (Slice 2) time, HTTP had no /persona/* routes yet, so this
// file's round-trip matrix deliberately only covered CLI/skill-harness/MCP.
// pw-15 has since shipped POST /persona/:tier/:scopeId (GET already existed
// from pw-02), so this file now completes the matrix: write via HTTP, read
// back via CLI/skill-harness/MCP (AC 5), and write via each of the original
// three, read back via HTTP's GET (AC 6-8). HTTP's GET /persona/:tier/:scopeId
// returns a structured JSON `{persona: {...}}` body (server.ts), not the
// formatted text CLI `show`/skill-harness/MCP produce -- so "content matches
// exactly" for HTTP round-trips is asserted as exact field-for-field JSON
// equality against the written candidate (displayName/scope/sections),
// rather than the byte-identical-string check used among the three
// text-producing transports (which do stay byte-identical to each other,
// same as AC 1-3).
//
// Two things this file proves that no single-transport test can:
//
//   1. Cross-transport round-trip (AC 1-3): write via transport A, read back
//      via transport B and C, for every meaningful (A, {B, C}) pair. `show`
//      only ever reads the GLOBAL persona store (top-orchestrator/
//      company-director/project-orchestrator -- see bin/mnemosyne-
//      persona.mjs's own USAGE_SHOW), so every round-trip case here uses a
//      global tier. Because skill-harness's personaShowAction and MCP's
//      persona_show are both thin wraps that shell out to the exact same
//      CLI `persona show` subcommand and surface its stdout UNCHANGED (see
//      personaCliRun in bin/mnemosyne-skill-helper.mjs), a correct
//      implementation makes all three read-back strings BYTE-IDENTICAL, not
//      just "similar" -- so this file asserts strict string equality, not a
//      marker-substring check, wherever it can.
//
//   2. A REAL cross-transport concurrency proof (AC 4) -- extends Epic 1's
//      pf-03 (lib/mnemosyne/layer1/__tests__/lock.test.ts), which only ever
//      proved same-transport (two OS processes both running the same
//      lock-worker.ts script) concurrency. Here the two racers are a real
//      `mnemosyne persona create` CLI subprocess and a real MCP
//      `persona_create` tool call (itself, internally, a *different*
//      subprocess boundary -- bin/mnemosyne-mcp.mjs -> personaCreateAction ->
//      execFile(tsx, bin/mnemosyne-persona.mjs) -- see that file's own doc
//      comment) racing a write to the exact same target persona file.
//
//      writeGlobalPersona/writeRepoLocalPersona do a blind full-record
//      overwrite (no read-modify-write), so the pf-03-style "final counter
//      value must be N, no lost increment" assertion does not apply
//      literally here -- the meaningful analogous guarantee for a
//      full-overwrite write is "the final file is always byte-identical to
//      exactly ONE of the racing candidates' full content, never a
//      corrupted/torn mix of both, and the loser's write is never silently
//      dropped without ever having taken effect." Two complementary proofs:
//
//        4a (deterministic): pre-place a live (non-stale) lock file at the
//        target path *before* starting either transport's write, launch both
//        concurrently, and prove BOTH transports' writes stay blocked (the
//        target file never appears) for as long as that external lock is
//        held -- which is only possible if both transports genuinely call
//        withLock against the exact same `<path>.mnemosyne.lock` convention,
//        not something that happens to look corruption-free by luck of OS
//        write() scheduling. Once the external lock is released, both
//        writes complete and the final file is byte-identical to exactly one
//        of the two full candidates.
//
//        4b (organic): repeated real races with NO pre-placed lock and
//        large (unequal-content, same-length) payloads, widening the actual
//        write() window -- corroborating evidence that real, un-staged
//        contention also never produces a torn/mixed file.
//
// Neither MCP nor the skill-harness's persona-* actions touch the network
// (see bin/mnemosyne-skill-helper.mjs's own header) -- but bin/mnemosyne-
// mcp.mjs's main() still calls ensureRunning() unconditionally at startup
// (same as test/mcp-server-persona.mjs), so this file has the same live
// Mnemosyne HTTP service dependency chain and is NOT part of the combined
// `npm test` script for the same reason. Run via `npm run
// test:persona-cross-transport` or `node test/persona-cross-transport.mjs`.
//
// $HOME is overridden to a real, throwaway temp directory for every
// transport (CLI subprocess env, MCP subprocess transport env, the real
// lib/mnemosyne/server.ts HTTP subprocess env, and this process's own
// process.env.HOME for the in-process skill-harness action calls, whose
// execFileAsync inherits it) -- mirrors test/persona-cli.mjs's,
// test/skill-harness.mjs's, test/mcp-server-persona.mjs's, and
// test/http-api.mjs's own fake-$HOME convention. Never touches the
// operator's real ~/.mnemosyne/personas.
//
// Uses PORT 8504 (MCP's swarm-memory ensureRunning target) and PORT_HTTP
// 8505 (this file's own real lib/mnemosyne/server.ts subprocess, spawned
// the same way test/http-api.mjs spawns it) -- both distinct from every
// other test file's port
// (8477/8479/8483/8487/8491/8492/8497/8498/8499/8500/8501/8502/31415).
//
// Usage: node test/persona-cross-transport.mjs

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import { personaCreateAction, personaShowAction } from "../bin/mnemosyne-skill-helper.mjs";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TSX_BIN = path.join(ROOT, "node_modules", ".bin", "tsx");
const PERSONA_CLI = path.join(ROOT, "bin", "mnemosyne-persona.mjs");
const MCP_SERVER_PATH = path.join(ROOT, "bin", "mnemosyne-mcp.mjs");
const HTTP_SERVER_PATH = path.join(ROOT, "lib", "mnemosyne", "server.ts");
const PORT = 8504;
const PORT_HTTP = 8505;
const HTTP_BASE = `http://127.0.0.1:${PORT_HTTP}`;

let fails = 0;
const ok = (condition, message) => {
  console.log(`${condition ? "  PASS" : "  FAIL"}  ${message}`);
  if (!condition) fails++;
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- shared fixtures -------------------------------------------------------

/** Same shape/convention as test/persona-cli.mjs's and test/mcp-server-persona.mjs's own personaCandidateYaml(). */
function personaCandidateYaml(candidate) {
  const lines = [];
  for (const key of ["tier", "scopeId", "displayName", "scope"]) {
    if (candidate[key] !== undefined) lines.push(`${key}: ${JSON.stringify(candidate[key])}`);
  }
  for (const key of ["sections", "mandateSections"]) {
    if (candidate[key] !== undefined) {
      lines.push(`${key}:`);
      for (const s of candidate[key]) {
        lines.push(`  - heading: ${JSON.stringify(s.heading)}`, `    body: ${JSON.stringify(s.body)}`);
      }
    }
  }
  return lines.join("\n") + "\n";
}

async function writeCandidateFile(dir, filename, candidate) {
  const filePath = path.join(dir, filename);
  await writeFile(filePath, personaCandidateYaml(candidate), "utf8");
  return filePath;
}

async function fileExists(p) {
  try {
    await readFile(p);
    return true;
  } catch {
    return false;
  }
}

/** `<root>/<tier>/<scopeId>.yaml` -- mirrors persona-store-global.ts's globalPersonaPath() exactly. */
function globalPersonaPath(homeDir, tier, scopeId) {
  return path.join(homeDir, ".mnemosyne", "personas", tier, `${scopeId}.yaml`);
}

/** `<path>.mnemosyne.lock` -- mirrors lock.ts's own LOCK_SUFFIX/lockPathFor() exactly (see lock.ts). */
function lockPathFor(targetPath) {
  return `${targetPath}.mnemosyne.lock`;
}

// --- transport A: CLI (bin/mnemosyne-persona.mjs, real tsx subprocess) -----

async function cliCreate(filePath, { home, repo, root } = {}) {
  const args = ["create", "--file", filePath];
  if (repo) args.push("--repo", repo);
  if (root) args.push("--root", root);
  const env = { ...process.env };
  if (home) env.HOME = home;
  try {
    const { stdout, stderr } = await execFileAsync(TSX_BIN, [PERSONA_CLI, ...args], { cwd: ROOT, env });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (e) {
    return { ok: false, stdout: (e.stdout ?? "").trim(), stderr: (e.stderr ?? "").trim() };
  }
}

async function cliShow(tier, scopeId, { home } = {}) {
  const env = { ...process.env };
  if (home) env.HOME = home;
  try {
    const { stdout, stderr } = await execFileAsync(TSX_BIN, [PERSONA_CLI, "show", tier, scopeId], { cwd: ROOT, env });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (e) {
    return { ok: false, stdout: (e.stdout ?? "").trim(), stderr: (e.stderr ?? "").trim() };
  }
}

// --- transport B: skill-harness (bin/mnemosyne-skill-helper.mjs, in-process
// function calls whose own execFileAsync shells out to a SEPARATE real
// subprocess -- personaCliRun -- inheriting process.env.HOME) ---------------

async function skillCreate(filePath, opts = {}) {
  return personaCreateAction(PORT, { file: filePath, ...opts });
}

async function skillShow(tier, scopeId) {
  return personaShowAction(PORT, tier, scopeId);
}

// --- transport C: MCP (bin/mnemosyne-mcp.mjs, real MCP client over stdio,
// spawning the real server as its own subprocess) ---------------------------

function toolResultJson(result) {
  const text = result.content?.find((c) => c.type === "text")?.text;
  return text ? JSON.parse(text) : null;
}

async function mcpCreate(client, filePath, opts = {}) {
  const result = await client.callTool({ name: "persona_create", arguments: { file: filePath, ...opts } });
  return { isError: result.isError === true, ...toolResultJson(result) };
}

async function mcpShow(client, tier, scopeId) {
  const result = await client.callTool({ name: "persona_show", arguments: { tier, scopeId } });
  return { isError: result.isError === true, ...toolResultJson(result) };
}

// --- transport D: HTTP (lib/mnemosyne/server.ts, real subprocess spawned
// via tsx exactly like test/http-api.mjs -- POST/GET /persona/:tier/:scopeId,
// pw-02/pw-15) ---------------------------------------------------------------

/** POST /persona/:tier/:scopeId -- the request body IS the bare persona candidate (server.ts). */
async function httpCreate(candidate) {
  const res = await fetch(`${HTTP_BASE}/persona/${candidate.tier}/${candidate.scopeId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(candidate),
  });
  const body = await res.json();
  return { ok: res.status === 201, status: res.status, body };
}

/** GET /persona/:tier/:scopeId -- returns {persona: {...}} as structured JSON, not formatted text. */
async function httpShow(tier, scopeId) {
  const res = await fetch(`${HTTP_BASE}/persona/${tier}/${scopeId}`);
  const body = await res.json();
  return { ok: res.status === 200, status: res.status, persona: body.persona };
}

async function waitForHttpHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${HTTP_BASE}/health`);
      if (res.status === 200 || res.status === 503) return true;
    } catch {
      // not up yet
    }
    await sleep(100);
  }
  return false;
}

// --- main --------------------------------------------------------------

async function main() {
  const fakeHome = await mkdtemp(path.join(tmpdir(), "mnemosyne-xtransport-home-"));
  await mkdir(path.join(fakeHome, ".mnemosyne"), { recursive: true });
  await writeFile(
    path.join(fakeHome, ".mnemosyne", "level0-rules.md"),
    "# Level 0 fixture\n\nXTRANSPORT_LEVEL0_MARKER — pull first, never commit to main.\n",
    "utf8",
  );
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "mnemosyne-xtransport-fixtures-"));

  const savedHome = process.env.HOME;
  process.env.HOME = fakeHome; // skill-harness's personaCliRun() inherits this via execFileAsync

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_SERVER_PATH],
    env: { ...process.env, PORT: String(PORT), HOME: fakeHome },
  });
  const client = new Client({ name: "persona-cross-transport-test", version: "0.1.0" });

  // pw-16: a real lib/mnemosyne/server.ts subprocess for the HTTP transport
  // -- same tsx-spawn convention as test/http-api.mjs, same fake $HOME so
  // its GET/POST /persona/* routes (global tier -- see globalPersonaPath())
  // read/write inside the exact same fakeHome tree every other transport
  // uses here, not a second isolated store.
  const httpChild = spawn(TSX_BIN, [HTTP_SERVER_PATH], {
    cwd: ROOT,
    env: { ...process.env, MNEMOSYNE_PORT: String(PORT_HTTP), HOME: fakeHome },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let httpServerOutput = "";
  httpChild.stdout.on("data", (c) => (httpServerOutput += c));
  httpChild.stderr.on("data", (c) => (httpServerOutput += c));

  try {
    const httpUp = await waitForHttpHealth(15_000);
    ok(httpUp, "real lib/mnemosyne/server.ts HTTP subprocess started and is reachable");
    if (!httpUp) {
      console.error(httpServerOutput);
      throw new Error("HTTP server never became reachable");
    }

    // A generous connect timeout: bin/mnemosyne-mcp.mjs's main() calls
    // ensureRunning() (up to its own 90s startTimeoutMs) BEFORE it ever
    // connects the stdio transport, so a cold start on a not-yet-warm PORT
    // can legitimately take longer than the MCP SDK's 60s default request
    // timeout -- same dependency chain test/mcp-server-persona.mjs has, just
    // usually masked there by an already-warm port from an earlier test run.
    await client.connect(transport, { timeout: 120_000 });
    ok(true, "MCP client connected to the real mnemosyne-mcp server over stdio");

    // =====================================================================
    // AC 1 — write via CLI, read back via skill-harness AND MCP.
    // =====================================================================
    {
      const candidate = {
        tier: "top-orchestrator",
        scopeId: "xt-write-cli",
        displayName: "Top Orchestrator",
        scope: "XT_WRITE_CLI_SCOPE_MARKER — authored via CLI `persona create`.",
        sections: [{ heading: "Mandate", body: "XT_WRITE_CLI_BODY_MARKER — real CLI write." }],
      };
      const file = await writeCandidateFile(fixtureDir, "write-cli.yaml", candidate);

      const writeResult = await cliCreate(file, { home: fakeHome });
      ok(writeResult.ok, `write via CLI succeeded (${JSON.stringify(writeResult)})`);

      const viaSkill = await skillShow(candidate.tier, candidate.scopeId);
      ok(viaSkill.ok === true, `read back via skill-harness persona-show succeeded (${JSON.stringify(viaSkill).slice(0, 200)})`);

      const viaMcp = await mcpShow(client, candidate.tier, candidate.scopeId);
      ok(!viaMcp.isError && viaMcp.ok === true, `read back via MCP persona_show succeeded (${JSON.stringify(viaMcp).slice(0, 200)})`);

      ok(
        viaSkill.output.includes("XT_WRITE_CLI_SCOPE_MARKER") && viaSkill.output.includes("XT_WRITE_CLI_BODY_MARKER"),
        "skill-harness read-back contains the CLI-authored content's real markers",
      );
      ok(
        viaMcp.output.includes("XT_WRITE_CLI_SCOPE_MARKER") && viaMcp.output.includes("XT_WRITE_CLI_BODY_MARKER"),
        "MCP read-back contains the CLI-authored content's real markers",
      );
      ok(
        viaSkill.output === viaMcp.output,
        "write-via-CLI: skill-harness's and MCP's read-back text are BYTE-IDENTICAL (same underlying read path)",
      );
    }

    // =====================================================================
    // AC 2 — write via skill-harness, read back via CLI AND MCP.
    // =====================================================================
    {
      const candidate = {
        tier: "company-director",
        scopeId: "xt-write-skill",
        displayName: "Company Director",
        scope: "XT_WRITE_SKILL_SCOPE_MARKER — authored via personaCreateAction.",
        sections: [{ heading: "Mandate", body: "XT_WRITE_SKILL_BODY_MARKER — real skill-harness write." }],
      };
      const file = await writeCandidateFile(fixtureDir, "write-skill.yaml", candidate);

      const writeResult = await skillCreate(file);
      ok(writeResult.ok === true, `write via skill-harness succeeded (${JSON.stringify(writeResult).slice(0, 200)})`);

      const viaCli = await cliShow(candidate.tier, candidate.scopeId, { home: fakeHome });
      ok(viaCli.ok, `read back via CLI show succeeded (${JSON.stringify(viaCli)})`);

      const viaMcp = await mcpShow(client, candidate.tier, candidate.scopeId);
      ok(!viaMcp.isError && viaMcp.ok === true, `read back via MCP persona_show succeeded (${JSON.stringify(viaMcp).slice(0, 200)})`);

      ok(
        viaCli.stdout.includes("XT_WRITE_SKILL_SCOPE_MARKER") && viaCli.stdout.includes("XT_WRITE_SKILL_BODY_MARKER"),
        "CLI read-back contains the skill-harness-authored content's real markers",
      );
      ok(
        viaMcp.output.includes("XT_WRITE_SKILL_SCOPE_MARKER") && viaMcp.output.includes("XT_WRITE_SKILL_BODY_MARKER"),
        "MCP read-back contains the skill-harness-authored content's real markers",
      );
      ok(
        viaCli.stdout === viaMcp.output,
        "write-via-skill-harness: CLI's and MCP's read-back text are BYTE-IDENTICAL (same underlying read path)",
      );
    }

    // =====================================================================
    // AC 3 — write via MCP, read back via CLI AND skill-harness.
    // =====================================================================
    {
      const candidate = {
        tier: "project-orchestrator",
        scopeId: "xt-write-mcp",
        displayName: "Project Orchestrator",
        scope: "XT_WRITE_MCP_SCOPE_MARKER — authored via persona_create.",
        sections: [{ heading: "Mandate", body: "XT_WRITE_MCP_BODY_MARKER — real MCP write." }],
      };
      const file = await writeCandidateFile(fixtureDir, "write-mcp.yaml", candidate);

      const writeResult = await mcpCreate(client, file);
      ok(!writeResult.isError && writeResult.ok === true, `write via MCP succeeded (${JSON.stringify(writeResult).slice(0, 200)})`);

      const viaCli = await cliShow(candidate.tier, candidate.scopeId, { home: fakeHome });
      ok(viaCli.ok, `read back via CLI show succeeded (${JSON.stringify(viaCli)})`);

      const viaSkill = await skillShow(candidate.tier, candidate.scopeId);
      ok(viaSkill.ok === true, `read back via skill-harness persona-show succeeded (${JSON.stringify(viaSkill).slice(0, 200)})`);

      ok(
        viaCli.stdout.includes("XT_WRITE_MCP_SCOPE_MARKER") && viaCli.stdout.includes("XT_WRITE_MCP_BODY_MARKER"),
        "CLI read-back contains the MCP-authored content's real markers",
      );
      ok(
        viaSkill.output.includes("XT_WRITE_MCP_SCOPE_MARKER") && viaSkill.output.includes("XT_WRITE_MCP_BODY_MARKER"),
        "skill-harness read-back contains the MCP-authored content's real markers",
      );
      ok(
        viaCli.stdout === viaSkill.output,
        "write-via-MCP: CLI's and skill-harness's read-back text are BYTE-IDENTICAL (same underlying read path)",
      );
    }

    // =====================================================================
    // AC 4a — deterministic cross-transport lock-blocking proof.
    //
    // Pre-place a live (fresh mtime, non-stale) lock file at the target
    // path BEFORE either transport attempts to write. Launch a CLI create
    // and an MCP persona_create concurrently against that exact path. Both
    // must stay blocked -- the target file must never appear -- for as long
    // as the external lock is held. This is only possible if BOTH
    // transports' writes genuinely call withLock against the exact same
    // `<path>.mnemosyne.lock` file -- it cannot be explained by lucky OS
    // write() scheduling, since neither transport's write should even have
    // *started* its write() call yet.
    // =====================================================================
    {
      const tier = "top-orchestrator";
      const scopeId = "xt-lock-block";
      const targetPath = globalPersonaPath(fakeHome, tier, scopeId);
      const lockPath = lockPathFor(targetPath);

      await mkdir(path.dirname(targetPath), { recursive: true });
      await writeFile(lockPath, "EXTERNAL_TEST_HELD_LOCK_TOKEN", "utf8");
      ok(existsSync(lockPath), "pre-placed an external, live (non-stale) lock file at the target path");

      const cliCandidate = {
        tier,
        scopeId,
        displayName: "Top Orchestrator",
        scope: "XT_LOCK_BLOCK_CLI_SCOPE_MARKER",
        sections: [{ heading: "Mandate", body: "XT_LOCK_BLOCK_CLI_BODY_MARKER" }],
      };
      const mcpCandidate = {
        tier,
        scopeId,
        displayName: "Top Orchestrator",
        scope: "XT_LOCK_BLOCK_MCP_SCOPE_MARKER",
        sections: [{ heading: "Mandate", body: "XT_LOCK_BLOCK_MCP_BODY_MARKER" }],
      };
      const cliFile = await writeCandidateFile(fixtureDir, "lock-block-cli.yaml", cliCandidate);
      const mcpFile = await writeCandidateFile(fixtureDir, "lock-block-mcp.yaml", mcpCandidate);

      // Launch BOTH real transports' writes concurrently -- neither is awaited yet.
      const cliPromise = cliCreate(cliFile, { home: fakeHome });
      const mcpPromise = mcpCreate(client, mcpFile);

      await sleep(500);
      ok(
        !(await fileExists(targetPath)),
        "500ms after launching both racers, the target file STILL does not exist -- both transports are genuinely blocked on the external lock",
      );
      ok(existsSync(lockPath), "the external lock file is still exactly the one we placed (neither transport stole/overwrote it -- it is non-stale)");

      // Release the external lock -- exactly one of the two real (pid-based
      // token) withLock acquisitions can win the exclusive-create race next;
      // the other must wait for it to finish and release before it can
      // proceed in turn.
      await rm(lockPath, { force: true });

      const [cliResult, mcpResult] = await Promise.all([cliPromise, mcpPromise]);
      ok(cliResult.ok, `after releasing the external lock, the CLI write completed successfully (${JSON.stringify(cliResult)})`);
      ok(!mcpResult.isError && mcpResult.ok === true, `after releasing the external lock, the MCP write completed successfully (${JSON.stringify(mcpResult).slice(0, 200)})`);
      ok(!existsSync(lockPath), "no lock file left behind after both racing writes finished (finally-release held for both)");

      const finalRaw = await readFile(targetPath, "utf8");
      const finalParsed = parseYaml(finalRaw);
      const matchesCli = finalParsed.scope === cliCandidate.scope && finalParsed.sections[0].body === cliCandidate.sections[0].body;
      const matchesMcp = finalParsed.scope === mcpCandidate.scope && finalParsed.sections[0].body === mcpCandidate.sections[0].body;
      ok(
        matchesCli !== matchesMcp,
        `final file content is byte-exact-equivalent to EXACTLY ONE of the two racing candidates (CLI-won=${matchesCli}, MCP-won=${matchesMcp}) -- no corrupted/torn mix`,
      );
      console.log(`  (info)  lock-block race winner: ${matchesCli ? "CLI" : "MCP"}`);
    }

    // =====================================================================
    // AC 4b — organic repeated cross-transport race (no pre-placed lock).
    //
    // Real, un-staged contention: large (unequal-content, same-length)
    // payloads widen the actual write() window; several repetitions
    // increase the odds that a genuine race window is hit. Every repetition
    // must land a byte-exact, uncorrupted single winner -- never a torn mix
    // of both candidates' content.
    // =====================================================================
    {
      const REPETITIONS = 5;
      const PAYLOAD_SIZE = 300_000; // ~300KB body -- large enough that writeFileSync's write() call is not instantaneous
      let cliWins = 0;
      let mcpWins = 0;

      for (let i = 0; i < REPETITIONS; i++) {
        const tier = "company-director";
        const scopeId = `xt-race-organic-${i}`;
        const targetPath = globalPersonaPath(fakeHome, tier, scopeId);

        const cliCandidate = {
          tier,
          scopeId,
          displayName: "Company Director",
          scope: `XT_RACE_ORGANIC_${i}_CLI_SCOPE_MARKER`,
          sections: [{ heading: "Mandate", body: `XT_RACE_ORGANIC_${i}_CLI_BODY_MARKER-` + "A".repeat(PAYLOAD_SIZE) }],
        };
        const mcpCandidate = {
          tier,
          scopeId,
          displayName: "Company Director",
          scope: `XT_RACE_ORGANIC_${i}_MCP_SCOPE_MARKER`,
          sections: [{ heading: "Mandate", body: `XT_RACE_ORGANIC_${i}_MCP_BODY_MARKER-` + "B".repeat(PAYLOAD_SIZE) }],
        };
        const cliFile = await writeCandidateFile(fixtureDir, `race-organic-${i}-cli.yaml`, cliCandidate);
        const mcpFile = await writeCandidateFile(fixtureDir, `race-organic-${i}-mcp.yaml`, mcpCandidate);

        const [cliResult, mcpResult] = await Promise.all([
          cliCreate(cliFile, { home: fakeHome }),
          mcpCreate(client, mcpFile),
        ]);
        ok(cliResult.ok, `[organic race ${i}] CLI write completed successfully (${JSON.stringify(cliResult).slice(0, 200)})`);
        ok(!mcpResult.isError && mcpResult.ok === true, `[organic race ${i}] MCP write completed successfully (${JSON.stringify(mcpResult).slice(0, 200)})`);

        const finalParsed = parseYaml(await readFile(targetPath, "utf8"));
        const matchesCli = finalParsed.scope === cliCandidate.scope && finalParsed.sections[0].body === cliCandidate.sections[0].body;
        const matchesMcp = finalParsed.scope === mcpCandidate.scope && finalParsed.sections[0].body === mcpCandidate.sections[0].body;
        ok(
          matchesCli !== matchesMcp,
          `[organic race ${i}] final file is byte-exact-equivalent to EXACTLY ONE candidate (CLI-won=${matchesCli}, MCP-won=${matchesMcp}) -- no corruption`,
        );
        if (matchesCli) cliWins++;
        if (matchesMcp) mcpWins++;
      }
      console.log(`  (info)  organic race outcome across ${REPETITIONS} repetitions: CLI won ${cliWins}, MCP won ${mcpWins}`);
    }

    // =====================================================================
    // AC 5 (pw-16) — write via HTTP (POST /persona/:tier/:scopeId), read
    // back via CLI's show, MCP's persona_show, AND the skill-harness's
    // persona-show. Mirrors AC 1-3's pattern exactly: the three text-based
    // reads must still be BYTE-IDENTICAL to each other (same underlying CLI
    // `show` text-output path, see file header), regardless of which
    // transport performed the write.
    // =====================================================================
    {
      const candidate = {
        tier: "top-orchestrator",
        scopeId: "xt-write-http",
        displayName: "Top Orchestrator",
        scope: "XT_WRITE_HTTP_SCOPE_MARKER — authored via POST /persona/:tier/:scopeId.",
        sections: [{ heading: "Mandate", body: "XT_WRITE_HTTP_BODY_MARKER — real HTTP write." }],
      };

      const writeResult = await httpCreate(candidate);
      ok(writeResult.ok, `write via HTTP (POST /persona/:tier/:scopeId) succeeded (${JSON.stringify(writeResult).slice(0, 200)})`);

      const viaCli = await cliShow(candidate.tier, candidate.scopeId, { home: fakeHome });
      ok(viaCli.ok, `read back via CLI show succeeded (${JSON.stringify(viaCli)})`);

      const viaSkill = await skillShow(candidate.tier, candidate.scopeId);
      ok(viaSkill.ok === true, `read back via skill-harness persona-show succeeded (${JSON.stringify(viaSkill).slice(0, 200)})`);

      const viaMcp = await mcpShow(client, candidate.tier, candidate.scopeId);
      ok(!viaMcp.isError && viaMcp.ok === true, `read back via MCP persona_show succeeded (${JSON.stringify(viaMcp).slice(0, 200)})`);

      ok(
        viaCli.stdout.includes("XT_WRITE_HTTP_SCOPE_MARKER") && viaCli.stdout.includes("XT_WRITE_HTTP_BODY_MARKER"),
        "CLI read-back contains the HTTP-authored content's real markers",
      );
      ok(
        viaSkill.output.includes("XT_WRITE_HTTP_SCOPE_MARKER") && viaSkill.output.includes("XT_WRITE_HTTP_BODY_MARKER"),
        "skill-harness read-back contains the HTTP-authored content's real markers",
      );
      ok(
        viaMcp.output.includes("XT_WRITE_HTTP_SCOPE_MARKER") && viaMcp.output.includes("XT_WRITE_HTTP_BODY_MARKER"),
        "MCP read-back contains the HTTP-authored content's real markers",
      );
      ok(
        viaCli.stdout === viaSkill.output && viaSkill.output === viaMcp.output,
        "write-via-HTTP: CLI's, skill-harness's, and MCP's read-back text are all BYTE-IDENTICAL (same underlying read path)",
      );
    }

    // =====================================================================
    // AC 6 (pw-16) — write via CLI, read back via HTTP's
    // GET /persona/:tier/:scopeId. HTTP's read returns structured JSON
    // ({persona: {...}}), not formatted text, so "matches exactly" is
    // asserted as exact field equality against the written candidate.
    // =====================================================================
    {
      const candidate = {
        tier: "company-director",
        scopeId: "xt-read-http-via-cli",
        displayName: "Company Director",
        scope: "XT_READ_HTTP_VIA_CLI_SCOPE_MARKER — authored via CLI `persona create`.",
        sections: [{ heading: "Mandate", body: "XT_READ_HTTP_VIA_CLI_BODY_MARKER — real CLI write." }],
      };
      const file = await writeCandidateFile(fixtureDir, "read-http-via-cli.yaml", candidate);

      const writeResult = await cliCreate(file, { home: fakeHome });
      ok(writeResult.ok, `write via CLI succeeded (${JSON.stringify(writeResult)})`);

      const viaHttp = await httpShow(candidate.tier, candidate.scopeId);
      ok(viaHttp.ok, `read back via HTTP GET /persona/:tier/:scopeId succeeded (status ${viaHttp.status})`);
      ok(
        viaHttp.persona?.tier === candidate.tier &&
          viaHttp.persona?.scopeId === candidate.scopeId &&
          viaHttp.persona?.displayName === candidate.displayName &&
          viaHttp.persona?.scope === candidate.scope &&
          JSON.stringify(viaHttp.persona?.sections) === JSON.stringify(candidate.sections),
        `write-via-CLI: HTTP GET read-back matches the CLI-authored candidate field-for-field (got ${JSON.stringify(viaHttp.persona)})`,
      );
    }

    // =====================================================================
    // AC 7 (pw-16) — write via skill-harness, read back via HTTP's
    // GET /persona/:tier/:scopeId.
    // =====================================================================
    {
      const candidate = {
        tier: "project-orchestrator",
        scopeId: "xt-read-http-via-skill",
        displayName: "Project Orchestrator",
        scope: "XT_READ_HTTP_VIA_SKILL_SCOPE_MARKER — authored via personaCreateAction.",
        sections: [{ heading: "Mandate", body: "XT_READ_HTTP_VIA_SKILL_BODY_MARKER — real skill-harness write." }],
      };
      const file = await writeCandidateFile(fixtureDir, "read-http-via-skill.yaml", candidate);

      const writeResult = await skillCreate(file);
      ok(writeResult.ok === true, `write via skill-harness succeeded (${JSON.stringify(writeResult).slice(0, 200)})`);

      const viaHttp = await httpShow(candidate.tier, candidate.scopeId);
      ok(viaHttp.ok, `read back via HTTP GET /persona/:tier/:scopeId succeeded (status ${viaHttp.status})`);
      ok(
        viaHttp.persona?.tier === candidate.tier &&
          viaHttp.persona?.scopeId === candidate.scopeId &&
          viaHttp.persona?.displayName === candidate.displayName &&
          viaHttp.persona?.scope === candidate.scope &&
          JSON.stringify(viaHttp.persona?.sections) === JSON.stringify(candidate.sections),
        `write-via-skill-harness: HTTP GET read-back matches the skill-harness-authored candidate field-for-field (got ${JSON.stringify(viaHttp.persona)})`,
      );
    }

    // =====================================================================
    // AC 8 (pw-16) — write via MCP, read back via HTTP's
    // GET /persona/:tier/:scopeId.
    // =====================================================================
    {
      const candidate = {
        tier: "top-orchestrator",
        scopeId: "xt-read-http-via-mcp",
        displayName: "Top Orchestrator",
        scope: "XT_READ_HTTP_VIA_MCP_SCOPE_MARKER — authored via persona_create.",
        sections: [{ heading: "Mandate", body: "XT_READ_HTTP_VIA_MCP_BODY_MARKER — real MCP write." }],
      };
      const file = await writeCandidateFile(fixtureDir, "read-http-via-mcp.yaml", candidate);

      const writeResult = await mcpCreate(client, file);
      ok(!writeResult.isError && writeResult.ok === true, `write via MCP succeeded (${JSON.stringify(writeResult).slice(0, 200)})`);

      const viaHttp = await httpShow(candidate.tier, candidate.scopeId);
      ok(viaHttp.ok, `read back via HTTP GET /persona/:tier/:scopeId succeeded (status ${viaHttp.status})`);
      ok(
        viaHttp.persona?.tier === candidate.tier &&
          viaHttp.persona?.scopeId === candidate.scopeId &&
          viaHttp.persona?.displayName === candidate.displayName &&
          viaHttp.persona?.scope === candidate.scope &&
          JSON.stringify(viaHttp.persona?.sections) === JSON.stringify(candidate.sections),
        `write-via-MCP: HTTP GET read-back matches the MCP-authored candidate field-for-field (got ${JSON.stringify(viaHttp.persona)})`,
      );
    }
  } finally {
    await client.close().catch(() => {});
    httpChild.kill();
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    await rm(fakeHome, { recursive: true, force: true });
    await rm(fixtureDir, { recursive: true, force: true });
  }

  console.log(`\n${fails === 0 ? "all persona-cross-transport checks passed" : `${fails} FAILURE(S)`}`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
