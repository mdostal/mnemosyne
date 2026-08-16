// mcp-server-persona.mjs — mnemosyne-persona-mcp-tools: real end-to-end
// verification that persona_sync/persona_seed/persona_show/persona_create
// work as real MCP tools when the real bin/mnemosyne-mcp.mjs process is
// launched.
//
// persona_create coverage (pw-07-mcp-persona-create) extends this file --
// persona_create is a thin wrapAction() wrap of pw-06's personaCreateAction
// (bin/mnemosyne-skill-helper.mjs), itself a pass-through to pw-05's
// `persona create --file <path> [--repo <path>] [--root <path>]` CLI verb.
// No new logic here either -- just the same real-MCP-client-over-stdio
// convention this file already uses for the other 3 persona tools, extended
// with a candidate-YAML-fixture writer mirroring test/persona-cli.mjs's own
// personaCandidateYaml/writeCandidateFile helpers.
//
// Real end-to-end, same posture as test/mcp-server.mjs and
// test/mcp-server-graphify.mjs: a real MCP Client (StdioClientTransport)
// spawns the real bin/mnemosyne-mcp.mjs child process, talks real MCP
// JSON-RPC over stdio -- no mocked transport, no in-process import of the
// tool handlers.
//
// Unlike every other MCP tool, persona_* never touches the network at all
// (no /recall, /remember, etc.) -- but bin/mnemosyne-mcp.mjs's main() still
// calls ensureRunning() unconditionally at startup (see that file's own
// header), so this test still depends on a live Mnemosyne HTTP service
// dependency chain, same as test/mcp-server.mjs -- not part of the `npm
// test` combined script for the same reason. Run via
// `npm run test:mcp-server-persona`.
//
// $HOME is overridden to a real, throwaway temp directory for the whole
// child process (transport `env`) so persona_seed/persona_show never touch
// the operator's actual ~/.mnemosyne/personas -- mirrors test/persona-cli.mjs's
// and test/skill-harness.mjs's own fake-$HOME convention.
//
// Uses PORT 8501 -- distinct from every other test file's port
// (8477/8487/8491/8492/8497/8498/8499/8500).
//
// Usage: node test/mcp-server-persona.mjs

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const MCP_SERVER_PATH = path.join(ROOT, "bin", "mnemosyne-mcp.mjs");
const PORT = 8501;

let fails = 0;
const ok = (condition, message) => {
  console.log(`${condition ? "  PASS" : "  FAIL"}  ${message}`);
  if (!condition) fails++;
};

function toolResultText(result) {
  return result.content?.find((c) => c.type === "text")?.text ?? "";
}

/** Same shape as personaCliRun()'s ok:true/false object, JSON-stringified by wrapAction/textResult. */
function toolResultJson(result) {
  const text = toolResultText(result);
  return text ? JSON.parse(text) : null;
}

async function makeFakeHome() {
  const home = await mkdtemp(path.join(os.tmpdir(), "mnemosyne-mcp-persona-home-"));
  await mkdir(path.join(home, ".mnemosyne"), { recursive: true });
  await writeFile(
    path.join(home, ".mnemosyne", "level0-rules.md"),
    "# Level 0 fixture\n\nMCP_PERSONA_TEST_LEVEL0_MARKER — pull first, never commit to main.\n",
    "utf8",
  );
  return home;
}

/**
 * Serializes an arbitrary persona-shaped candidate object to the same YAML
 * shape persona-store-{global,repo-local}.ts round-trip via `stringify` --
 * used as `persona create --file <path>`'s input fixture. Mirrors
 * test/persona-cli.mjs's own personaCandidateYaml() -- deliberately
 * serializes WHATEVER keys the candidate object has, including a smuggled
 * `mandateSections` key, so nothing gets silently dropped before the CLI
 * (and, in turn, personaCreateAction/persona_create) even sees it.
 */
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

/** Writes a `persona create --file <path>` fixture under `dir`, returning the file path written. */
async function writeCandidateFile(dir, filename, candidate) {
  const filePath = path.join(dir, filename);
  await writeFile(filePath, personaCandidateYaml(candidate), "utf8");
  return filePath;
}

async function main() {
  const fakeHome = await makeFakeHome();
  const fakeRepo = await mkdtemp(path.join(os.tmpdir(), "mnemosyne-mcp-persona-repo-"));
  const fakeContentDir = await mkdtemp(path.join(os.tmpdir(), "mnemosyne-mcp-persona-create-content-"));
  const fakeCreateRepo = await mkdtemp(path.join(os.tmpdir(), "mnemosyne-mcp-persona-create-repo-"));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_SERVER_PATH],
    env: { ...process.env, PORT: String(PORT), HOME: fakeHome },
  });
  const client = new Client({ name: "mcp-server-persona-test", version: "0.1.0" });

  try {
    await client.connect(transport);
    ok(true, "client connected to the real mnemosyne-mcp server over stdio");

    // persona_sync (dry-run, code-architect) -- zero filesystem writes,
    // content resolved under fakeRepo, not $HOME.
    const syncResult = await client.callTool({
      name: "persona_sync",
      arguments: { repo: fakeRepo, tier: "code-architect", scopeId: "mcp-test-scope", dryRun: true },
    });
    ok(!syncResult.isError, `persona_sync (dry-run) did not error (${JSON.stringify(syncResult)})`);
    const sync = toolResultJson(syncResult);
    ok(sync?.ok === true, `persona_sync (dry-run) returns ok:true (${JSON.stringify(sync)})`);
    ok(/would create|would update/.test(sync?.output ?? ""), "persona_sync (dry-run) output describes a preview, not a real write");
    ok(!(await fileExists(path.join(fakeRepo, "CLAUDE.md"))), "persona_sync (dry-run) via MCP created NO real CLAUDE.md on disk");

    // persona_seed -- global tiers into the fake $HOME's global store.
    const seedResult = await client.callTool({ name: "persona_seed", arguments: {} });
    ok(!seedResult.isError, `persona_seed did not error (${JSON.stringify(seedResult)})`);
    const seed = toolResultJson(seedResult);
    ok(seed?.ok === true, `persona_seed returns ok:true (${JSON.stringify(seed)})`);
    ok(
      await fileExists(path.join(fakeHome, ".mnemosyne", "personas", "company-director", "default.yaml")),
      "persona_seed via MCP actually wrote a real global persona file under the fake $HOME",
    );

    // persona_show -- reads back what persona_seed just wrote, proving the
    // MCP tool and the seed tool share the same $HOME-resolved global store.
    const showResult = await client.callTool({
      name: "persona_show",
      arguments: { tier: "company-director", scopeId: "default" },
    });
    ok(!showResult.isError, `persona_show did not error (${JSON.stringify(showResult)})`);
    const show = toolResultJson(showResult);
    ok(show?.ok === true, `persona_show returns ok:true (${JSON.stringify(show)})`);
    ok(
      /tier: company-director/.test(show?.output ?? "") && /scopeId: default/.test(show?.output ?? ""),
      "persona_show via MCP round-trips the just-seeded persona's real tier/scopeId",
    );

    // A genuinely unseeded scope comes back as a tool result with ok:false
    // inside the JSON payload (not isError:true) -- matching wrapAction's
    // contract of only setting isError on a THROWN exception, and
    // personaCliRun's contract of returning ok:false (not throwing) for the
    // CLI's own handled, non-zero-exit failures.
    const missingResult = await client.callTool({
      name: "persona_show",
      arguments: { tier: "top-orchestrator", scopeId: "no-such-scope-ever" },
    });
    ok(!missingResult.isError, "persona_show on an unseeded scope is not an MCP transport error");
    const missing = toolResultJson(missingResult);
    ok(missing?.ok === false, "persona_show on an unseeded scope returns ok:false in its own JSON payload");

    // persona_create (pw-07) -- global tier, no repo -> writes into the fake
    // $HOME's global store, matching pw-05/pw-06's own CLI/action behavior
    // byte-for-byte (this tool is a thin wrapAction() wrap, no new logic).
    const createGlobalFile = await writeCandidateFile(fakeContentDir, "create-global.yaml", {
      tier: "top-orchestrator",
      scopeId: "mcp-create-global-scope",
      displayName: "Top Orchestrator",
      scope: "MCP_CREATE_GLOBAL_SCOPE_MARKER — authored via persona_create.",
      sections: [{ heading: "Authored section", body: "MCP_CREATE_GLOBAL_BODY_MARKER — real persona_create write." }],
    });
    const createGlobalResult = await client.callTool({
      name: "persona_create",
      arguments: { file: createGlobalFile },
    });
    ok(!createGlobalResult.isError, `persona_create (global tier) did not error (${JSON.stringify(createGlobalResult)})`);
    const createGlobal = toolResultJson(createGlobalResult);
    ok(createGlobal?.ok === true, `persona_create (global tier) returns ok:true (${JSON.stringify(createGlobal)})`);
    const writtenGlobal = await readFile(
      path.join(fakeHome, ".mnemosyne", "personas", "top-orchestrator", "mcp-create-global-scope.yaml"),
      "utf8",
    ).catch(() => null);
    ok(writtenGlobal !== null, "persona_create (global tier) via MCP actually wrote a real global persona file under the fake $HOME");
    ok(
      writtenGlobal?.includes("MCP_CREATE_GLOBAL_SCOPE_MARKER") && writtenGlobal?.includes("MCP_CREATE_GLOBAL_BODY_MARKER"),
      "persona_create (global tier) via MCP wrote the candidate's real content, unchanged",
    );

    // persona_create -- repo-local tier (code-architect), --repo given ->
    // writes into the repo-local store, proving `repo`/`file`/`root` are all
    // threaded through to personaCreateAction untouched.
    const createRepoFile = await writeCandidateFile(fakeContentDir, "create-repo.yaml", {
      tier: "code-architect",
      scopeId: "mcp-create-repo-scope",
      displayName: "Code/Area Architect",
      scope: "MCP_CREATE_REPO_SCOPE_MARKER — authored via persona_create.",
      sections: [{ heading: "Authored section", body: "MCP_CREATE_REPO_BODY_MARKER — real persona_create write." }],
    });
    const createRepoResult = await client.callTool({
      name: "persona_create",
      arguments: { file: createRepoFile, repo: fakeCreateRepo },
    });
    ok(!createRepoResult.isError, `persona_create (repo-local tier) did not error (${JSON.stringify(createRepoResult)})`);
    const createRepo = toolResultJson(createRepoResult);
    ok(createRepo?.ok === true, `persona_create (repo-local tier) returns ok:true (${JSON.stringify(createRepo)})`);
    const writtenRepo = await readFile(
      path.join(fakeCreateRepo, ".mnemosyne", "personas", "mcp-create-repo-scope.yaml"),
      "utf8",
    ).catch(() => null);
    ok(writtenRepo !== null, "persona_create (repo-local tier) via MCP actually wrote a real persona file under --repo");
    ok(
      writtenRepo?.includes("MCP_CREATE_REPO_SCOPE_MARKER") && writtenRepo?.includes("MCP_CREATE_REPO_BODY_MARKER"),
      "persona_create (repo-local tier) via MCP wrote the candidate's real content, unchanged",
    );

    // persona_create -- a candidate with a bad (unknown) tier value comes
    // back as ok:false in the tool's own JSON payload, matching wrapAction's
    // contract: a handled CLI failure (non-zero exit, not a thrown/rejected
    // fetch) is never surfaced as an MCP transport error. `tier` lives inside
    // --file's YAML content, not a schema-checked top-level MCP argument, so
    // this exercises personaCliRun's own error path, same as
    // AC-create-mandate-reject below.
    const createBadTierFile = await writeCandidateFile(fakeContentDir, "create-bad-tier.yaml", {
      tier: "not-a-real-tier",
      scopeId: "mcp-create-bad-tier-scope",
      displayName: "Not A Real Tier",
      scope: "A candidate with an unknown tier.",
      sections: [{ heading: "Section", body: "body" }],
    });
    const createBadTierResult = await client.callTool({
      name: "persona_create",
      arguments: { file: createBadTierFile },
    });
    ok(!createBadTierResult.isError, "persona_create with a bad tier is not an MCP transport error");
    const createBadTier = toolResultJson(createBadTierResult);
    ok(createBadTier?.ok === false, "persona_create with a bad tier returns ok:false in its own JSON payload");

    // persona_create -- a candidate smuggling a `mandateSections` key is
    // rejected by assertValidPersona's own guard (persona.ts), surfaced the
    // same ok:false way, and never reaches disk.
    const createMandateFile = await writeCandidateFile(fakeContentDir, "create-mandate-smuggle.yaml", {
      tier: "company-director",
      scopeId: "mcp-create-mandate-scope",
      displayName: "Company Director",
      scope: "Attempted mandateSections smuggling via persona_create.",
      sections: [{ heading: "Section", body: "body" }],
      mandateSections: [{ heading: "Fake mandate", body: "should never be author-storable" }],
    });
    const createMandateResult = await client.callTool({
      name: "persona_create",
      arguments: { file: createMandateFile },
    });
    ok(!createMandateResult.isError, "persona_create with a smuggled mandateSections is not an MCP transport error");
    const createMandate = toolResultJson(createMandateResult);
    ok(createMandate?.ok === false, "persona_create with a smuggled mandateSections returns ok:false in its own JSON payload");
    const mandateWritten = await readFile(
      path.join(fakeHome, ".mnemosyne", "personas", "company-director", "mcp-create-mandate-scope.yaml"),
      "utf8",
    ).catch(() => null);
    ok(mandateWritten === null, "persona_create rejected the mandateSections smuggling BEFORE any disk write");
  } finally {
    await client.close().catch(() => {});
    await rm(fakeHome, { recursive: true, force: true });
    await rm(fakeRepo, { recursive: true, force: true });
    await rm(fakeContentDir, { recursive: true, force: true });
    await rm(fakeCreateRepo, { recursive: true, force: true });
  }

  console.log(`\n${fails === 0 ? "all mcp-server-persona checks passed" : `${fails} FAILURE(S)`}`);
  process.exit(fails === 0 ? 0 : 1);
}

async function fileExists(p) {
  try {
    await readFile(p);
    return true;
  } catch {
    return false;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
