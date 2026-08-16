// persona-draft-cross-transport.mjs — pu-06-draft-persona-transport-tests.
//
// The draft mechanism (pu-01..pu-05) added a genuinely new, structurally
// separate persistence layer (persona-draft-store.ts) plus FOUR independent
// transport wrappers around it (CLI's `persona draft propose|show|approve|
// discard`, the skill-harness's personaDraftProposeAction/.../
// personaDraftDiscardAction, MCP's persona_draft_propose/.../
// persona_draft_discard, and HTTP's POST/GET/DELETE /persona/draft/*) --
// exactly the risk class the wizard epic's own H5 already named for the
// non-draft persona mechanism (pw-08/pw-16, test/persona-cross-transport.mjs):
// "adds ... independent, never-before-exercised transport wrappers ... none
// of which [the unit tests] cover, since those exercised the TS store
// functions directly, not through a transport."
//
// This file is the draft mechanism's own version of that proof, extending
// test/persona-cross-transport.mjs's exact convention (real subprocesses,
// fake $HOME, multi-transport pairing -- see that file's own header for the
// full rationale) rather than reinventing it, plus test/http-api.mjs's own
// "spawn lib/mnemosyne/server.ts, hit it over real HTTP" convention for the
// HTTP leg. It proves THREE things no single-transport draft test (pu-04's
// test/persona-cli.mjs, pu-05's test/skill-harness-persona-draft.mjs /
// test/mcp-server-persona.mjs) can prove on its own:
//
//   1. CROSS-TRANSPORT ROUND TRIP (Section A) -- every meaningful
//      (propose-transport, approve-transport) pair among {CLI,
//      skill-harness, MCP, HTTP} commits BYTE-FOR-BYTE IDENTICAL content
//      (modulo scopeId), proving all four funnel through the SAME
//      writeDraftPersona (pu-02) at propose time and the SAME
//      writeGlobalPersona/writeRepoLocalPersona (pf-01/pf-06) at approve
//      time -- the epic's own explicit "no second write path" risk.
//
//      The skill-harness's and MCP's draft actions are themselves pure
//      subprocess pass-throughs to the exact same CLI `persona draft <verb>`
//      command (see bin/mnemosyne-skill-helper.mjs's own doc comment on
//      personaDraftProposeAction et al.) -- so, mirroring
//      test/persona-cross-transport.mjs's own dedup of "symmetric" CLI-
//      family combinations, this file does NOT exhaustively test all 4x4=16
//      pairs (nor same-transport diagonals -- CLI-CLI/skill-skill/MCP-MCP/
//      HTTP-HTTP round trips are each already covered by that transport's
//      own dedicated test file). Instead it hits every transport at least
//      twice as proposer and twice as approver, in a derangement that always
//      crosses a real subprocess boundary, plus one repo-local
//      (code-architect) pair -- "every meaningful pair," not literally every
//      permutation (this story's own risk-mitigation note).
//
//   2. GENUINE CONCURRENCY (Section B) -- two DIFFERENT real transports
//      racing a `draft propose` against the exact same {tier, scopeId}
//      identity, dispatched before either completes (never a sequential
//      await pair), never produce a corrupted/torn file or two active
//      drafts -- extending test/persona-cross-transport.mjs's own AC4a/4b
//      lock-blocking + organic-race proof to the NEW draft store's own
//      withLock usage (persona-draft-store.ts's writeDraftPersona), not
//      assuming by analogy that the same guarantee holds there too.
//
//   3. LEAK-PROOF (Section C) -- a discarded/never-approved draft is NOT
//      reachable through any of the three real-store read paths this
//      codebase exposes (GET /persona, `mnemosyne persona show`,
//      getPersonaContent), while a legitimately approved draft AT THE SAME
//      {tier, scopeId} identity immediately afterward correctly IS visible
//      through all three -- the concrete verification of design-
//      discussion.md's "a draft leaks into a live-render path" risk, not
//      just an assertion that it doesn't. getPersonaContent (persona.ts) is
//      called DIRECTLY, in-process (this file is launched via `tsx`, not
//      plain `node`, precisely so it can import a .ts module the way
//      test/e2e.mjs already does for lib/mnemosyne/client.ts) -- a real,
//      unmocked call to the exact function sync.ts/the CLI's `show`
//      ultimately both dispatch through, not a third re-derived read.
//
// No stub/mock of persona-draft-store.ts or the real write functions
// anywhere in this file: every propose/approve/discard goes through a real
// CLI subprocess, a real skill-harness action (itself shelling out to a
// real CLI subprocess), a real MCP tool call over stdio to a real
// bin/mnemosyne-mcp.mjs subprocess, or a real HTTP request to a real
// lib/mnemosyne/server.ts subprocess. getPersonaContent (Section C's third
// read path) is the ONE direct in-process function call this file makes --
// a pure, real, unmocked READ function (persona.ts: only existsSync/
// readFileSync reachable from it, see that file's own doc comment) that
// imports nothing from persona-draft-store.ts, so calling it directly is
// exercising the real render path, not bypassing a transport under test.
//
// $HOME is overridden to a real, throwaway temp directory for every
// transport (mirrors test/persona-cross-transport.mjs's own fake-$HOME
// convention exactly) -- never touches the operator's real
// ~/.mnemosyne/persona-drafts or ~/.mnemosyne/personas.
//
// Uses PORT 8510 (MCP's swarm-memory ensureRunning target) and PORT_HTTP
// 8511 (this file's own real lib/mnemosyne/server.ts subprocess) -- both
// distinct from every other test file's port (see
// test/persona-cross-transport.mjs's own port-registry comment:
// 8477/8479/8483/8487/8491/8492/8497/8498/8499/8500/8501/8502/8503/8504/
// 8505, plus lib/mnemosyne/layer1/__tests__'s 8541/8542/8543 and
// test/persona-cli.mjs's 8547).
//
// bin/mnemosyne-mcp.mjs's main() calls ensureRunning() unconditionally at
// startup (bin/mnemosyne-skill-helper.mjs), which health-checks PORT via a
// REAL `swarm-memory check` (src/engine.mjs's health()) -- a genuine
// Qdrant-reachability self-test that can never pass under a FAKE $HOME (no
// real ~/.config/swarm-memory/config.toml there). So this file calls the
// exact same production ensureRunning() itself, ONCE, up front in main(),
// BEFORE process.env.HOME is ever overridden to the fake, throwaway home --
// at that point ensureRunning()'s own spawn (if PORT isn't already warm)
// inherits this process's REAL, unmodified environment, so its swarm-memory
// self-test can genuinely succeed. By the time bin/mnemosyne-mcp.mjs's own
// subprocess later calls ensureRunning() again (now with HOME=fakeHome in
// its env), PORT is already healthy -- ensureRunning()'s own fast path
// ("already healthy -> spawn nothing") skips spawning a second instance
// entirely, so the fake $HOME is never asked to make that health check pass.
// Neither this file's persona/draft actions nor persona_draft_*'s own tool
// implementations ever send traffic to that daemon's REST surface
// (recall/remember) -- it exists solely so ensureRunning() has something
// live to health-check.
//
// Like test/persona-cross-transport.mjs/test/mcp-server-persona.mjs, this
// depends on a live Mnemosyne HTTP service dependency chain (MCP's
// ensureRunning()) and is NOT part of the combined `npm test` script for the
// same reason. Run via `npm run test:persona-draft-cross-transport` or
// `node_modules/.bin/tsx test/persona-draft-cross-transport.mjs`.
//
// Usage: tsx test/persona-draft-cross-transport.mjs

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import {
  ensureRunning,
  personaDraftApproveAction,
  personaDraftDiscardAction,
  personaDraftProposeAction,
} from "../bin/mnemosyne-skill-helper.mjs";
// The ONE direct in-process import in this file -- a real, unmocked READ
// function (see this file's own header). Resolvable only because this file
// is launched via `tsx`, not plain `node` (mirrors test/e2e.mjs's own
// "../lib/mnemosyne/client.js" import for the same reason).
import { getPersonaContent } from "../lib/mnemosyne/layer1/persona.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TSX_BIN = path.join(ROOT, "node_modules", ".bin", "tsx");
const PERSONA_CLI = path.join(ROOT, "bin", "mnemosyne-persona.mjs");
const MCP_SERVER_PATH = path.join(ROOT, "bin", "mnemosyne-mcp.mjs");
const HTTP_SERVER_PATH = path.join(ROOT, "lib", "mnemosyne", "server.ts");
const PORT = 8510;
const PORT_HTTP = 8511;
const HTTP_BASE = `http://127.0.0.1:${PORT_HTTP}`;

let fails = 0;
const ok = (condition, message) => {
  console.log(`${condition ? "  PASS" : "  FAIL"}  ${message}`);
  if (!condition) fails++;
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- shared path/fixture helpers -------------------------------------------
// Hand-implemented (not imported from persona-draft-store.ts/persona-store-
// global.ts/persona-store-repo-local.ts) so this file's own independent
// verification never trusts those modules' own accounting of themselves --
// same "hand-derive the fixed location convention" posture
// test/persona-cross-transport.mjs's globalPersonaPath/lockPathFor and
// test/http-api.mjs's readWrittenGlobalPersona/readWrittenDraftPersona
// already establish.

/** Same shape/convention as test/persona-cli.mjs's/test/mcp-server-persona.mjs's own personaCandidateYaml(). */
function personaCandidateYaml(candidate) {
  const lines = [];
  for (const key of ["tier", "scopeId", "displayName", "scope"]) {
    if (candidate[key] !== undefined) lines.push(`${key}: ${JSON.stringify(candidate[key])}`);
  }
  for (const key of ["sections"]) {
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

/** `<repoRoot>/.mnemosyne/personas/<scopeId>.yaml` -- mirrors persona-store-repo-local.ts's own fixed location (tier is always code-architect, not part of the path). */
function repoLocalPersonaPath(repoRoot, scopeId) {
  return path.join(repoRoot, ".mnemosyne", "personas", `${scopeId}.yaml`);
}

/** Same sanitization rule persona-draft-store.ts's own sanitizeForPath()/persona.ts's resolveRememberScope() apply. */
function sanitizeForPath(value) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

/**
 * `<home>/.mnemosyne/persona-drafts/<tier>/<scopeId>.yaml` (global tiers) or
 * `<home>/.mnemosyne/persona-drafts/repo-local/<repoSlug>/<scopeId>.yaml`
 * (code-architect) -- mirrors persona-draft-store.ts's own draftPersonaPath()
 * exactly.
 */
function draftPersonaPath(homeDir, tier, scopeId, repoRoot) {
  const root = path.join(homeDir, ".mnemosyne", "persona-drafts");
  if (tier === "code-architect") {
    return path.join(root, "repo-local", sanitizeForPath(path.resolve(repoRoot)), `${scopeId}.yaml`);
  }
  return path.join(root, tier, `${scopeId}.yaml`);
}

/** `<path>.mnemosyne.lock` -- mirrors lock.ts's own LOCK_SUFFIX/lockPathFor() exactly. */
function lockPathFor(targetPath) {
  return `${targetPath}.mnemosyne.lock`;
}

/** Normalizes away a known scopeId substring so two records differing ONLY by scopeId can be compared byte-for-byte -- mirrors test/http-api.mjs's own normalizeScopeId(). */
function normalizeScopeId(raw, scopeId) {
  return raw.split(scopeId).join("SCOPE_ID_PLACEHOLDER");
}

/**
 * A persona candidate builder for Section A's matrix: by default EVERY case
 * uses the exact same `markerPrefix` ("PU06_MATRIX"), so content is IDENTICAL
 * across every propose/approve pair -- only `tier`/`scopeId` differ -- making
 * the "byte-for-byte identical modulo scopeId" comparison meaningful. Section
 * B's concurrency races pass a DIFFERENT `markerPrefix` per racer instead, so
 * the two candidates racing for the same identity are deliberately unequal
 * (needed to detect a torn/mixed write).
 */
function matrixCandidate(tier, scopeId, markerPrefix = "PU06_MATRIX") {
  return {
    tier,
    scopeId,
    displayName: `${markerPrefix} Director`,
    scope: `${markerPrefix}_SCOPE_MARKER — identical content proposed/approved via a real cross-transport pair.`,
    sections: [{ heading: "Mandate", body: `${markerPrefix}_BODY_MARKER — identical content proposed/approved via a real cross-transport pair.` }],
  };
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

function toolResultJson(result) {
  const text = result.content?.find((c) => c.type === "text")?.text;
  return text ? JSON.parse(text) : null;
}

// =============================================================================
// main
// =============================================================================

async function main() {
  const fakeHome = await mkdtemp(path.join(tmpdir(), "mnemosyne-draft-xtransport-home-"));
  await mkdir(path.join(fakeHome, ".mnemosyne"), { recursive: true });
  await writeFile(
    path.join(fakeHome, ".mnemosyne", "level0-rules.md"),
    "# Level 0 fixture\n\nPU06_DRAFT_XTRANSPORT_LEVEL0_MARKER — pull first, never commit to main.\n",
    "utf8",
  );
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "mnemosyne-draft-xtransport-fixtures-"));
  const fakeRepo = await mkdtemp(path.join(tmpdir(), "mnemosyne-draft-xtransport-repo-"));

  // Warm PORT under this process's REAL, unmodified environment BEFORE
  // process.env.HOME is overridden below -- see the doc comment on PORT
  // above for why this must happen first. If PORT is already healthy
  // (another real daemon already warm there), this is a fast no-op.
  const warmup = await ensureRunning({ port: PORT });
  ok(
    warmup?.health?.ok === true || warmup?.alreadyRunning === true,
    `real swarm-memory-backed daemon on PORT ${PORT} is healthy before this file ever touches $HOME (${JSON.stringify({ started: warmup?.started, alreadyRunning: warmup?.alreadyRunning })})`,
  );

  const savedHome = process.env.HOME;
  process.env.HOME = fakeHome; // skill-harness's personaCliRun() inherits this via execFileAsync

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_SERVER_PATH],
    env: { ...process.env, PORT: String(PORT), HOME: fakeHome },
  });
  const client = new Client({ name: "persona-draft-cross-transport-test", version: "0.1.0" });

  const httpChild = spawn(TSX_BIN, [HTTP_SERVER_PATH], {
    cwd: ROOT,
    env: { ...process.env, MNEMOSYNE_PORT: String(PORT_HTTP), HOME: fakeHome },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let httpServerOutput = "";
  httpChild.stdout.on("data", (c) => (httpServerOutput += c));
  httpChild.stderr.on("data", (c) => (httpServerOutput += c));

  // --- transport adapters ----------------------------------------------------
  // Uniform (candidate, {repo}) -> {ok, ...} for propose/create, and
  // (tier, scopeId, {repo}) -> {ok, ...} for approve/discard -- one shape per
  // verb regardless of which real transport is underneath.

  async function proposeCli(candidate, { repo } = {}) {
    const filePath = await writeCandidateFile(fixtureDir, `propose-cli-${candidate.scopeId}.yaml`, candidate);
    const args = ["draft", "propose", "--file", filePath, ...(repo ? ["--repo", repo] : [])];
    const env = { ...process.env, HOME: fakeHome };
    try {
      const { stdout, stderr } = await execFileAsync(TSX_BIN, [PERSONA_CLI, ...args], { cwd: ROOT, env });
      return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
    } catch (e) {
      return { ok: false, stdout: (e.stdout ?? "").trim(), stderr: (e.stderr ?? "").trim() };
    }
  }

  async function approveCli(tier, scopeId, { repo } = {}) {
    const args = ["draft", "approve", tier, scopeId, ...(repo ? ["--repo", repo] : [])];
    const env = { ...process.env, HOME: fakeHome };
    try {
      const { stdout, stderr } = await execFileAsync(TSX_BIN, [PERSONA_CLI, ...args], { cwd: ROOT, env });
      return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
    } catch (e) {
      return { ok: false, stdout: (e.stdout ?? "").trim(), stderr: (e.stderr ?? "").trim() };
    }
  }

  async function discardCli(tier, scopeId, { repo } = {}) {
    const args = ["draft", "discard", tier, scopeId, ...(repo ? ["--repo", repo] : [])];
    const env = { ...process.env, HOME: fakeHome };
    try {
      const { stdout, stderr } = await execFileAsync(TSX_BIN, [PERSONA_CLI, ...args], { cwd: ROOT, env });
      return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
    } catch (e) {
      return { ok: false, stdout: (e.stdout ?? "").trim(), stderr: (e.stderr ?? "").trim() };
    }
  }

  /** `persona show <tier> <scope-id>` -- the real-store CLI read path (read-only path Section C checks; never `draft show`). */
  async function cliShow(tier, scopeId) {
    const env = { ...process.env, HOME: fakeHome };
    try {
      const { stdout, stderr } = await execFileAsync(TSX_BIN, [PERSONA_CLI, "show", tier, scopeId], { cwd: ROOT, env });
      return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
    } catch (e) {
      return { ok: false, stdout: (e.stdout ?? "").trim(), stderr: (e.stderr ?? "").trim() };
    }
  }

  /** `persona create --file <path> [--repo <repo>]` -- the direct, non-draft write baseline Section A compares the draft-approve pathway's own output against. */
  async function cliCreate(candidate, { repo } = {}) {
    const filePath = await writeCandidateFile(fixtureDir, `create-baseline-${candidate.scopeId}.yaml`, candidate);
    const args = ["create", "--file", filePath, ...(repo ? ["--repo", repo] : [])];
    const env = { ...process.env, HOME: fakeHome };
    try {
      const { stdout, stderr } = await execFileAsync(TSX_BIN, [PERSONA_CLI, ...args], { cwd: ROOT, env });
      return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
    } catch (e) {
      return { ok: false, stdout: (e.stdout ?? "").trim(), stderr: (e.stderr ?? "").trim() };
    }
  }

  async function proposeSkill(candidate, { repo } = {}) {
    const filePath = await writeCandidateFile(fixtureDir, `propose-skill-${candidate.scopeId}.yaml`, candidate);
    return personaDraftProposeAction(PORT, { file: filePath, repo });
  }

  async function approveSkill(tier, scopeId, { repo } = {}) {
    return personaDraftApproveAction(PORT, tier, scopeId, { repo });
  }

  async function discardSkill(tier, scopeId, { repo } = {}) {
    return personaDraftDiscardAction(PORT, tier, scopeId, { repo });
  }

  async function proposeMcp(candidate, { repo } = {}) {
    const filePath = await writeCandidateFile(fixtureDir, `propose-mcp-${candidate.scopeId}.yaml`, candidate);
    const result = await client.callTool({
      name: "persona_draft_propose",
      arguments: { file: filePath, ...(repo ? { repo } : {}) },
    });
    return { isError: result.isError === true, ...toolResultJson(result) };
  }

  async function approveMcp(tier, scopeId, { repo } = {}) {
    const result = await client.callTool({
      name: "persona_draft_approve",
      arguments: { tier, scopeId, ...(repo ? { repo } : {}) },
    });
    return { isError: result.isError === true, ...toolResultJson(result) };
  }

  async function proposeHttp(candidate, { repo } = {}) {
    const qs = repo ? `?repo=${encodeURIComponent(repo)}` : "";
    const res = await fetch(`${HTTP_BASE}/persona/draft/${candidate.tier}/${candidate.scopeId}${qs}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(candidate),
    });
    const body = await res.json();
    return { ok: res.status === 201, status: res.status, ...body };
  }

  async function approveHttp(tier, scopeId, { repo } = {}) {
    const qs = repo ? `?repo=${encodeURIComponent(repo)}` : "";
    const res = await fetch(`${HTTP_BASE}/persona/draft/${tier}/${scopeId}/approve${qs}`, { method: "POST" });
    const body = await res.json();
    return { ok: res.status === 200, status: res.status, ...body };
  }

  async function httpList() {
    const res = await fetch(`${HTTP_BASE}/persona`);
    return { status: res.status, body: await res.json() };
  }

  async function httpShow(tier, scopeId) {
    const res = await fetch(`${HTTP_BASE}/persona/${tier}/${scopeId}`);
    return { status: res.status, body: await res.json() };
  }

  /** Runs one Section A matrix case: propose via `proposeFn`, approve via `approveFn`, returns the committed file's raw text (independently read off disk). */
  async function runMatrixCase(label, proposeFn, approveFn, { tier, scopeId, repo, markerPrefix } = {}) {
    const candidate = matrixCandidate(tier, scopeId, markerPrefix);
    const proposeResult = await proposeFn(candidate, { repo });
    ok(
      proposeResult.ok === true && proposeResult.isError !== true,
      `[matrix: ${label}] propose succeeded (${JSON.stringify(proposeResult).slice(0, 200)})`,
    );
    const approveResult = await approveFn(tier, scopeId, { repo });
    ok(
      approveResult.ok === true && approveResult.isError !== true,
      `[matrix: ${label}] approve succeeded (${JSON.stringify(approveResult).slice(0, 200)})`,
    );

    const raw =
      tier === "code-architect"
        ? await readFile(repoLocalPersonaPath(repo, scopeId), "utf8")
        : await readFile(globalPersonaPath(fakeHome, tier, scopeId), "utf8");
    // Parsed comparison, not a raw substring check -- the `yaml` package's
    // stringify() line-wraps long plain scalars at ~80 columns (a space
    // becomes a newline+indent), so a long marker string's raw bytes on disk
    // are not literally contiguous even though it round-trips losslessly.
    const parsed = parseYaml(raw);
    ok(
      parsed.scope === candidate.scope && parsed.sections?.[0]?.body === candidate.sections[0].body,
      `[matrix: ${label}] the committed file (read directly off disk and YAML-parsed, not just the transport's own response) contains the matrix candidate's real content (got ${JSON.stringify({ scope: parsed.scope, body: parsed.sections?.[0]?.body })})`,
    );
    return raw;
  }

  try {
    const httpUp = await waitForHttpHealth(15_000);
    ok(httpUp, "real lib/mnemosyne/server.ts HTTP subprocess started and is reachable");
    if (!httpUp) {
      console.error(httpServerOutput);
      throw new Error("HTTP server never became reachable");
    }

    // Generous connect timeout: bin/mnemosyne-mcp.mjs's main() calls
    // ensureRunning() (up to its own 90s startTimeoutMs) BEFORE it ever
    // connects the stdio transport -- same dependency chain
    // test/persona-cross-transport.mjs/test/mcp-server-persona.mjs have.
    await client.connect(transport, { timeout: 120_000 });
    ok(true, "MCP client connected to the real mnemosyne-mcp server over stdio");

    // =========================================================================
    // SECTION A -- cross-transport propose/approve matrix.
    //
    // Every case crosses a REAL subprocess/transport boundary between propose
    // and approve (no same-transport diagonal -- see this file's own header
    // for why those are out of scope here). 5 cases share IDENTICAL content
    // (global tier, company-director) so their committed files can be
    // compared byte-for-byte (modulo scopeId); a 6th case covers the
    // repo-local (code-architect) store separately, compared against its own
    // direct-create baseline. A 7th comparison proves the WHOLE matrix's
    // content matches a `persona create` direct-write baseline too -- not
    // just matching itself across transports, but matching the exact same
    // primitive `create` uses (persona-cli.mjs's own AC-draft-approve parity
    // proof, extended here across every transport pair, not just CLI-CLI).
    // =========================================================================

    const case1Raw = await runMatrixCase("CLI propose -> skill-harness approve", proposeCli, approveSkill, {
      tier: "company-director",
      scopeId: "pu06-matrix-cli-skill",
    });
    const case2Raw = await runMatrixCase("skill-harness propose -> MCP approve", proposeSkill, approveMcp, {
      tier: "company-director",
      scopeId: "pu06-matrix-skill-mcp",
    });
    const case3Raw = await runMatrixCase("MCP propose -> CLI approve", proposeMcp, approveCli, {
      tier: "company-director",
      scopeId: "pu06-matrix-mcp-cli",
    });
    const case4Raw = await runMatrixCase("HTTP propose -> CLI approve", proposeHttp, approveCli, {
      tier: "company-director",
      scopeId: "pu06-matrix-http-cli",
    });
    const case5Raw = await runMatrixCase("skill-harness propose -> HTTP approve", proposeSkill, approveHttp, {
      tier: "company-director",
      scopeId: "pu06-matrix-skill-http",
    });

    const normalizedCases = [
      ["CLI->skill-harness", case1Raw, "pu06-matrix-cli-skill"],
      ["skill-harness->MCP", case2Raw, "pu06-matrix-skill-mcp"],
      ["MCP->CLI", case3Raw, "pu06-matrix-mcp-cli"],
      ["HTTP->CLI", case4Raw, "pu06-matrix-http-cli"],
      ["skill-harness->HTTP", case5Raw, "pu06-matrix-skill-http"],
    ].map(([label, raw, scopeId]) => [label, normalizeScopeId(raw, scopeId)]);

    const [, baselineNormalized] = normalizedCases[0];
    for (const [label, normalized] of normalizedCases.slice(1)) {
      ok(
        normalized === baselineNormalized,
        `[matrix parity] "${label}"'s committed file is byte-for-byte identical (modulo scopeId) to "${normalizedCases[0][0]}"'s -- same underlying write primitive regardless of which (propose, approve) transport pair was used`,
      );
    }

    // Repo-local (code-architect) pair, compared against its OWN direct-create baseline.
    const case6Raw = await runMatrixCase("MCP propose -> HTTP approve (repo-local)", proposeMcp, approveHttp, {
      tier: "code-architect",
      scopeId: "pu06-matrix-repo-mcp-http",
      repo: fakeRepo,
    });
    const directRepoCandidate = matrixCandidate("code-architect", "pu06-matrix-repo-direct-baseline");
    const directRepoCreate = await cliCreate(directRepoCandidate, { repo: fakeRepo });
    ok(directRepoCreate.ok === true, `[matrix parity, repo-local] direct \`persona create --repo\` baseline write succeeded (${JSON.stringify(directRepoCreate).slice(0, 200)})`);
    const directRepoRaw = await readFile(repoLocalPersonaPath(fakeRepo, directRepoCandidate.scopeId), "utf8");
    ok(
      normalizeScopeId(case6Raw, "pu06-matrix-repo-mcp-http") === normalizeScopeId(directRepoRaw, "pu06-matrix-repo-direct-baseline"),
      "[matrix parity, repo-local] MCP-propose/HTTP-approve's committed file is byte-for-byte identical (modulo scopeId) to a direct `persona create --repo` write of the same candidate",
    );

    // Whole-matrix vs. a direct `persona create` (non-draft) baseline -- proves the
    // draft-approve pathway is genuinely the SAME write primitive `create` uses,
    // not just internally consistent with itself across transports.
    const directGlobalCandidate = matrixCandidate("company-director", "pu06-matrix-global-direct-baseline");
    const directGlobalCreate = await cliCreate(directGlobalCandidate, {});
    ok(directGlobalCreate.ok === true, `[matrix parity, global] direct \`persona create\` baseline write succeeded (${JSON.stringify(directGlobalCreate).slice(0, 200)})`);
    const directGlobalRaw = await readFile(globalPersonaPath(fakeHome, "company-director", directGlobalCandidate.scopeId), "utf8");
    ok(
      baselineNormalized === normalizeScopeId(directGlobalRaw, "pu06-matrix-global-direct-baseline"),
      "[matrix parity, global] the cross-transport matrix's committed content is byte-for-byte identical (modulo scopeId) to a direct `persona create` write of the same candidate -- the draft-approve pathway commits via the exact same write primitive `create` uses, not a second one",
    );

    // =========================================================================
    // SECTION B -- genuine concurrency: two DIFFERENT real transports racing
    // a `draft propose` against the SAME {tier, scopeId} identity, dispatched
    // BEFORE either completes.
    // =========================================================================

    // --- B1 (deterministic): CLI vs HTTP, external pre-placed lock ----------
    // Same technique as test/persona-cross-transport.mjs's own AC4a: a live
    // (non-stale) lock file is placed at the draft's target path BEFORE
    // either transport's propose call is even issued. Both promises are
    // created (and therefore already running, up to their own first await)
    // WITHOUT being awaited, proving this is a genuine race, not a
    // sequential pair of awaits -- the mid-flight assertion below (the
    // target file still does not exist 500ms in) is only possible if both
    // writes are genuinely still blocked at that point.
    {
      const tier = "project-orchestrator";
      const scopeId = "pu06-concurrency-lock-block";
      const targetPath = draftPersonaPath(fakeHome, tier, scopeId);
      const lockPath = lockPathFor(targetPath);

      await mkdir(path.dirname(targetPath), { recursive: true });
      await writeFile(lockPath, "PU06_EXTERNAL_TEST_HELD_LOCK_TOKEN", "utf8");
      ok(existsSync(lockPath), "[concurrency B1] pre-placed an external, live (non-stale) lock file at the draft target path");

      const cliCandidate = matrixCandidate(tier, scopeId, "PU06_LOCK_BLOCK_CLI");
      const httpCandidate = matrixCandidate(tier, scopeId, "PU06_LOCK_BLOCK_HTTP");

      // Neither promise is awaited here -- both real transports' propose calls
      // are already in flight by the time control reaches the sleep() below.
      const cliPromise = proposeCli(cliCandidate);
      const httpPromise = proposeHttp(httpCandidate);

      await sleep(500);
      ok(
        !(await fileExists(targetPath)),
        "[concurrency B1] 500ms after launching both racers, the draft target file STILL does not exist -- both transports are genuinely blocked on the external lock, not accidentally sequential",
      );
      ok(existsSync(lockPath), "[concurrency B1] the external lock file is still exactly the one we placed (neither transport stole/overwrote it)");

      await rm(lockPath, { force: true });

      const [cliResult, httpResult] = await Promise.all([cliPromise, httpPromise]);
      ok(cliResult.ok === true, `[concurrency B1] after releasing the external lock, the CLI draft propose completed successfully (${JSON.stringify(cliResult).slice(0, 200)})`);
      ok(httpResult.ok === true, `[concurrency B1] after releasing the external lock, the HTTP draft propose completed successfully (${JSON.stringify(httpResult).slice(0, 200)})`);
      ok(!existsSync(lockPath), "[concurrency B1] no lock file left behind after both racing writes finished");

      const finalRaw = await readFile(targetPath, "utf8");
      const finalParsed = parseYaml(finalRaw);
      const matchesCli = finalParsed.scope === cliCandidate.scope && finalParsed.sections[0].body === cliCandidate.sections[0].body;
      const matchesHttp = finalParsed.scope === httpCandidate.scope && finalParsed.sections[0].body === httpCandidate.sections[0].body;
      ok(
        matchesCli !== matchesHttp,
        `[concurrency B1] final draft file content is byte-exact-equivalent to EXACTLY ONE of the two racing candidates (CLI-won=${matchesCli}, HTTP-won=${matchesHttp}) -- never a corrupted/torn mix`,
      );
      console.log(`  (info)  concurrency B1 lock-block race winner: ${matchesCli ? "CLI" : "HTTP"}`);

      const tierDir = path.dirname(targetPath);
      const filesAtIdentity = (await readdir(tierDir)).filter((f) => f === `${scopeId}.yaml`);
      ok(
        filesAtIdentity.length === 1,
        `[concurrency B1] exactly ONE active draft file exists for {tier, scopeId} after the race -- never two active drafts for one identity (got ${JSON.stringify(filesAtIdentity)})`,
      );
    }

    // --- B2 (organic): skill-harness vs MCP, no pre-placed lock -------------
    // Real, un-staged contention: both propose calls are dispatched via a
    // single Promise.all([...]) whose array elements (both async calls) are
    // evaluated -- and therefore already executing -- before Promise.all
    // itself is invoked, same organic-race convention as
    // test/persona-cross-transport.mjs's own AC4b. Large, unequal, same-length
    // payloads widen the real write() window; several repetitions raise the
    // odds of genuinely hitting the race window.
    {
      const REPETITIONS = 3;
      const PAYLOAD_SIZE = 300_000;
      let skillWins = 0;
      let mcpWins = 0;

      for (let i = 0; i < REPETITIONS; i++) {
        const tier = "top-orchestrator";
        const scopeId = `pu06-concurrency-organic-${i}`;
        const skillCandidate = {
          tier,
          scopeId,
          displayName: "PU06 Organic Race",
          scope: `PU06_ORGANIC_${i}_SKILL_SCOPE_MARKER`,
          sections: [{ heading: "Mandate", body: `PU06_ORGANIC_${i}_SKILL_BODY_MARKER-` + "A".repeat(PAYLOAD_SIZE) }],
        };
        const mcpCandidate = {
          tier,
          scopeId,
          displayName: "PU06 Organic Race",
          scope: `PU06_ORGANIC_${i}_MCP_SCOPE_MARKER`,
          sections: [{ heading: "Mandate", body: `PU06_ORGANIC_${i}_MCP_BODY_MARKER-` + "B".repeat(PAYLOAD_SIZE) }],
        };

        const [skillResult, mcpResult] = await Promise.all([proposeSkill(skillCandidate), proposeMcp(mcpCandidate)]);
        ok(skillResult.ok === true, `[concurrency B2, race ${i}] skill-harness draft propose completed successfully (${JSON.stringify(skillResult).slice(0, 200)})`);
        ok(
          mcpResult.ok === true && mcpResult.isError !== true,
          `[concurrency B2, race ${i}] MCP draft propose completed successfully (${JSON.stringify(mcpResult).slice(0, 200)})`,
        );

        const targetPath = draftPersonaPath(fakeHome, tier, scopeId);
        const finalParsed = parseYaml(await readFile(targetPath, "utf8"));
        const matchesSkill = finalParsed.scope === skillCandidate.scope && finalParsed.sections[0].body === skillCandidate.sections[0].body;
        const matchesMcp = finalParsed.scope === mcpCandidate.scope && finalParsed.sections[0].body === mcpCandidate.sections[0].body;
        ok(
          matchesSkill !== matchesMcp,
          `[concurrency B2, race ${i}] final draft file is byte-exact-equivalent to EXACTLY ONE candidate (skill-won=${matchesSkill}, MCP-won=${matchesMcp}) -- no corruption`,
        );
        if (matchesSkill) skillWins++;
        if (matchesMcp) mcpWins++;

        const tierDir = path.dirname(targetPath);
        const filesAtIdentity = (await readdir(tierDir)).filter((f) => f === `${scopeId}.yaml`);
        ok(filesAtIdentity.length === 1, `[concurrency B2, race ${i}] exactly ONE active draft file exists for {tier, scopeId} (got ${JSON.stringify(filesAtIdentity)})`);
      }
      console.log(`  (info)  concurrency B2 organic race outcome across ${REPETITIONS} repetitions: skill-harness won ${skillWins}, MCP won ${mcpWins}`);
    }

    // =========================================================================
    // SECTION C -- leak-proof: a discarded draft is NOT reachable through any
    // of the three real-store read paths; a legitimately approved draft AT
    // THE SAME {tier, scopeId} identity immediately afterward correctly IS.
    // Using the SAME identity for both halves is deliberate -- it rules out
    // the read paths merely reporting "not present" because that identity
    // was always empty, and directly proves the discarded content in
    // particular never surfaces even once a real persona later occupies the
    // same slot.
    // =========================================================================
    {
      const tier = "top-orchestrator";
      const scopeId = "pu06-leak-scope";
      const ctx = { repoRoot: fixtureDir, globalPersonaRoot: path.join(fakeHome, ".mnemosyne", "personas") };

      // --- C1: propose (skill-harness) then discard (skill-harness) -- must NEVER leak ---
      const discardedCandidate = {
        tier,
        scopeId,
        displayName: "PU06 Leak Draft (never approved)",
        scope: "PU06_LEAK_DISCARDED_SCOPE_MARKER — this must never become visible through any real-store read path.",
        sections: [{ heading: "Mandate", body: "PU06_LEAK_DISCARDED_BODY_MARKER — this must never become visible through any real-store read path." }],
      };
      const discardedFile = await writeCandidateFile(fixtureDir, "leak-discarded.yaml", discardedCandidate);
      const discardedPropose = await personaDraftProposeAction(PORT, { file: discardedFile });
      ok(discardedPropose.ok === true, `[leak-proof C1] propose (skill-harness) succeeded (${JSON.stringify(discardedPropose).slice(0, 200)})`);

      const discardResult = await discardSkill(tier, scopeId);
      ok(discardResult.ok === true, `[leak-proof C1] discard (skill-harness) succeeded (${JSON.stringify(discardResult).slice(0, 200)})`);

      // Read path 1: GET /persona (real store list) + GET /persona/:tier/:scopeId (direct read).
      const listAfterDiscard = await httpList();
      ok(
        !listAfterDiscard.body.personas?.some((p) => p.tier === tier && p.scopeId === scopeId),
        `[leak-proof C1] GET /persona (real store list) does NOT report the discarded draft's {tier, scopeId} as present (got ${JSON.stringify(listAfterDiscard.body.personas)})`,
      );
      const readAfterDiscard = await httpShow(tier, scopeId);
      ok(
        readAfterDiscard.status === 404,
        `[leak-proof C1] GET /persona/:tier/:scopeId -> 404, the discarded draft is NOT reachable via a direct real-store read (got ${readAfterDiscard.status})`,
      );

      // Read path 2: `mnemosyne persona show` (real store CLI).
      const showAfterDiscard = await cliShow(tier, scopeId);
      ok(
        showAfterDiscard.ok === false,
        `[leak-proof C1] \`mnemosyne persona show\` fails (no such real persona) -- the discarded draft is NOT reachable via the real-store CLI read path (got ${JSON.stringify(showAfterDiscard)})`,
      );
      ok(
        !showAfterDiscard.stdout.includes("PU06_LEAK_DISCARDED_SCOPE_MARKER"),
        "[leak-proof C1] `mnemosyne persona show`'s output never contains the discarded draft's marker text",
      );

      // Read path 3: getPersonaContent (in-process, direct unit call) --
      // falls back to the hardcoded TIER_CONTENT (persona.ts's
      // fallbackToTierContentWithWarning) since no real persona exists yet;
      // the discarded draft's markers must not appear anywhere in that result.
      const contentAfterDiscard = getPersonaContent(tier, scopeId, ctx);
      const contentAfterDiscardText = JSON.stringify(contentAfterDiscard);
      ok(
        !contentAfterDiscardText.includes("PU06_LEAK_DISCARDED_SCOPE_MARKER") && !contentAfterDiscardText.includes("PU06_LEAK_DISCARDED_BODY_MARKER"),
        "[leak-proof C1] getPersonaContent() (direct in-process call) does NOT reflect the discarded draft's content anywhere in its result",
      );

      // --- C2: propose (MCP) then approve (MCP), SAME identity -- must now correctly be visible ---
      const approvedCandidate = {
        tier,
        scopeId,
        displayName: "PU06 Leak Draft (approved)",
        scope: "PU06_LEAK_APPROVED_SCOPE_MARKER — this must become visible through every real-store read path.",
        sections: [{ heading: "Mandate", body: "PU06_LEAK_APPROVED_BODY_MARKER — this must become visible through every real-store read path." }],
      };
      const approvedFile = await writeCandidateFile(fixtureDir, "leak-approved.yaml", approvedCandidate);
      const approvedProposeResult = await client.callTool({ name: "persona_draft_propose", arguments: { file: approvedFile } });
      const approvedPropose = { isError: approvedProposeResult.isError === true, ...toolResultJson(approvedProposeResult) };
      ok(
        !approvedPropose.isError && approvedPropose.ok === true,
        `[leak-proof C2] propose (MCP) succeeded (${JSON.stringify(approvedPropose).slice(0, 200)})`,
      );

      const approveResult = await approveMcp(tier, scopeId);
      ok(
        approveResult.ok === true && approveResult.isError !== true,
        `[leak-proof C2] approve (MCP) succeeded (${JSON.stringify(approveResult).slice(0, 200)})`,
      );

      // Read path 1 again: GET /persona (list) + direct read -- now present, with the APPROVED content.
      const listAfterApprove = await httpList();
      ok(
        listAfterApprove.body.personas?.some((p) => p.tier === tier && p.scopeId === scopeId),
        `[leak-proof C2] GET /persona (real store list) NOW reports the approved persona's {tier, scopeId} as present (got ${JSON.stringify(listAfterApprove.body.personas)})`,
      );
      const readAfterApprove = await httpShow(tier, scopeId);
      ok(readAfterApprove.status === 200, `[leak-proof C2] GET /persona/:tier/:scopeId -> 200, the approved persona is directly reachable (got ${readAfterApprove.status})`);
      ok(
        readAfterApprove.body.persona?.scope === approvedCandidate.scope,
        `[leak-proof C2] GET /persona/:tier/:scopeId returns the APPROVED content, not the discarded draft's (got ${JSON.stringify(readAfterApprove.body.persona)})`,
      );

      // Read path 2 again: `mnemosyne persona show` -- now succeeds, with the approved content only.
      const showAfterApprove = await cliShow(tier, scopeId);
      ok(showAfterApprove.ok === true, `[leak-proof C2] \`mnemosyne persona show\` succeeds NOW (got ${JSON.stringify(showAfterApprove).slice(0, 200)})`);
      ok(
        showAfterApprove.stdout.includes("PU06_LEAK_APPROVED_SCOPE_MARKER") && showAfterApprove.stdout.includes("PU06_LEAK_APPROVED_BODY_MARKER"),
        "[leak-proof C2] `mnemosyne persona show`'s output contains the APPROVED draft's real content",
      );
      ok(
        !showAfterApprove.stdout.includes("PU06_LEAK_DISCARDED_SCOPE_MARKER") && !showAfterApprove.stdout.includes("PU06_LEAK_DISCARDED_BODY_MARKER"),
        "[leak-proof C2] `mnemosyne persona show`'s output never contains the EARLIER discarded draft's markers -- no cross-contamination between the two drafts that shared this identity",
      );

      // Read path 3 again: getPersonaContent (in-process) -- now reflects the
      // real, committed persona, not the fallback and not the discarded draft.
      const contentAfterApprove = getPersonaContent(tier, scopeId, ctx);
      ok(
        contentAfterApprove.displayName === approvedCandidate.displayName && contentAfterApprove.scope === approvedCandidate.scope,
        `[leak-proof C2] getPersonaContent() (direct in-process call) NOW returns the approved persona's real content (got ${JSON.stringify({ displayName: contentAfterApprove.displayName, scope: contentAfterApprove.scope })})`,
      );
      const contentAfterApproveText = JSON.stringify(contentAfterApprove);
      ok(
        !contentAfterApproveText.includes("PU06_LEAK_DISCARDED_SCOPE_MARKER") && !contentAfterApproveText.includes("PU06_LEAK_DISCARDED_BODY_MARKER"),
        "[leak-proof C2] getPersonaContent()'s result never contains the earlier discarded draft's markers",
      );
    }
  } finally {
    await client.close().catch(() => {});
    httpChild.kill();
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    await rm(fakeHome, { recursive: true, force: true });
    await rm(fixtureDir, { recursive: true, force: true });
    await rm(fakeRepo, { recursive: true, force: true });
  }

  console.log(`\n${fails === 0 ? "all persona-draft-cross-transport checks passed" : `${fails} FAILURE(S)`}`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
