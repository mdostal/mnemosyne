// mcp-server-persona.mjs — mnemosyne-persona-mcp-tools: real end-to-end
// verification that persona_sync/persona_seed/persona_show work as real MCP
// tools when the real bin/mnemosyne-mcp.mjs process is launched.
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

async function main() {
  const fakeHome = await makeFakeHome();
  const fakeRepo = await mkdtemp(path.join(os.tmpdir(), "mnemosyne-mcp-persona-repo-"));

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
  } finally {
    await client.close().catch(() => {});
    await rm(fakeHome, { recursive: true, force: true });
    await rm(fakeRepo, { recursive: true, force: true });
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
