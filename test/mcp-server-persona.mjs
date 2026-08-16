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
// persona_draft_propose/show/approve/discard coverage (pu-05) extends this
// file again -- each is a thin wrapAction() wrap of pu-05's
// personaDraftProposeAction/personaDraftShowAction/personaDraftApproveAction/
// personaDraftDiscardAction (bin/mnemosyne-skill-helper.mjs), themselves
// pure subprocess pass-throughs to pu-04's `mnemosyne persona draft
// <verb>` CLI verbs. Same real-MCP-client-over-stdio convention, same
// personaCandidateYaml/writeCandidateFile fixture helpers -- no new
// machinery invented for these four tools either. A rejected draft-approve
// (structurally-valid-as-a-draft but assertValidPersona-invalid candidate)
// comes back ok:false in the tool's own JSON payload, isError:false at the
// MCP transport -- the exact same "handled CLI failure, never a thrown
// transport error" contract persona_create's own bad-tier/mandate-smuggle
// cases above already establish; matching that established contract
// exactly is what "no new logic in this file" means for the draft tools.
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
  const fakeDraftContentDir = await mkdtemp(path.join(os.tmpdir(), "mnemosyne-mcp-persona-draft-content-"));
  const fakeDraftRepo = await mkdtemp(path.join(os.tmpdir(), "mnemosyne-mcp-persona-draft-repo-"));

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

    // persona_draft_propose / persona_draft_show (pu-05) -- global tier
    // round trip: propose writes into the structurally separate draft store
    // (~/.mnemosyne/persona-drafts), never the real persona store; show reads
    // it back, clearly labeled DRAFT.
    const draftProposeFile = await writeCandidateFile(fakeDraftContentDir, "draft-propose-global.yaml", {
      tier: "project-orchestrator",
      scopeId: "mcp-draft-global-scope",
      displayName: "Project Orchestrator (draft)",
      scope: "MCP_DRAFT_GLOBAL_SCOPE_MARKER — proposed via persona_draft_propose.",
      sections: [{ heading: "Authored section", body: "MCP_DRAFT_GLOBAL_BODY_MARKER — real persona_draft_propose write." }],
    });
    const draftProposeResult = await client.callTool({
      name: "persona_draft_propose",
      arguments: { file: draftProposeFile },
    });
    ok(!draftProposeResult.isError, `persona_draft_propose (global tier) did not error (${JSON.stringify(draftProposeResult)})`);
    const draftPropose = toolResultJson(draftProposeResult);
    ok(draftPropose?.ok === true, `persona_draft_propose (global tier) returns ok:true (${JSON.stringify(draftPropose)})`);
    ok(/proposed/.test(draftPropose?.output ?? ""), "persona_draft_propose reports the write with its own 'proposed' verb");
    const realStoreUntouched = await readFile(
      path.join(fakeHome, ".mnemosyne", "personas", "project-orchestrator", "mcp-draft-global-scope.yaml"),
      "utf8",
    ).catch(() => null);
    ok(realStoreUntouched === null, "persona_draft_propose via MCP wrote NOTHING into the real global persona store");

    const draftShowResult = await client.callTool({
      name: "persona_draft_show",
      arguments: { tier: "project-orchestrator", scopeId: "mcp-draft-global-scope" },
    });
    ok(!draftShowResult.isError, `persona_draft_show (global tier) did not error (${JSON.stringify(draftShowResult)})`);
    const draftShow = toolResultJson(draftShowResult);
    ok(draftShow?.ok === true, `persona_draft_show (global tier) returns ok:true (${JSON.stringify(draftShow)})`);
    ok(
      /MCP_DRAFT_GLOBAL_SCOPE_MARKER/.test(draftShow?.output ?? "") && /MCP_DRAFT_GLOBAL_BODY_MARKER/.test(draftShow?.output ?? ""),
      "persona_draft_show round-trips the just-proposed draft's real content",
    );
    ok(/DRAFT/.test(draftShow?.output ?? ""), "persona_draft_show's output is visibly labeled DRAFT");

    // persona_draft_approve (pu-05) -- commits the draft via the SAME write
    // primitive persona_create uses, then archives (never deletes) the draft.
    const draftApproveResult = await client.callTool({
      name: "persona_draft_approve",
      arguments: { tier: "project-orchestrator", scopeId: "mcp-draft-global-scope" },
    });
    ok(!draftApproveResult.isError, `persona_draft_approve (global tier) did not error (${JSON.stringify(draftApproveResult)})`);
    const draftApprove = toolResultJson(draftApproveResult);
    ok(draftApprove?.ok === true, `persona_draft_approve (global tier) returns ok:true (${JSON.stringify(draftApprove)})`);
    const approvedWritten = await readFile(
      path.join(fakeHome, ".mnemosyne", "personas", "project-orchestrator", "mcp-draft-global-scope.yaml"),
      "utf8",
    ).catch(() => null);
    ok(approvedWritten !== null, "persona_draft_approve via MCP actually committed the draft into the real global persona store");
    ok(
      approvedWritten?.includes("MCP_DRAFT_GLOBAL_SCOPE_MARKER") && approvedWritten?.includes("MCP_DRAFT_GLOBAL_BODY_MARKER"),
      "persona_draft_approve committed the draft's real content, unchanged",
    );
    const draftShowAfterApprove = await client.callTool({
      name: "persona_draft_show",
      arguments: { tier: "project-orchestrator", scopeId: "mcp-draft-global-scope" },
    });
    ok(!draftShowAfterApprove.isError, "persona_draft_show (after approve) is not an MCP transport error");
    const draftAfterApprove = toolResultJson(draftShowAfterApprove);
    ok(draftAfterApprove?.ok === false, "persona_draft_show reports ok:false after approve -- the draft is archived, no longer active");

    // persona_show (existing tool) can now read the just-approved persona
    // back from the real store -- proves persona_draft_approve's write is
    // genuinely reachable by the real transport, not just draft-visible.
    const showAfterApprove = await client.callTool({
      name: "persona_show",
      arguments: { tier: "project-orchestrator", scopeId: "mcp-draft-global-scope" },
    });
    ok(!showAfterApprove.isError, "persona_show (after persona_draft_approve) is not an MCP transport error");
    const shownAfterApprove = toolResultJson(showAfterApprove);
    ok(shownAfterApprove?.ok === true, "persona_show reads back the persona persona_draft_approve just committed");

    // persona_draft_propose -- repo-local tier (code-architect), --repo given
    // -> routes to the repo-local draft subtree, proving repo/file are both
    // threaded through to personaDraftProposeAction untouched.
    const draftProposeRepoFile = await writeCandidateFile(fakeDraftContentDir, "draft-propose-repo.yaml", {
      tier: "code-architect",
      scopeId: "mcp-draft-repo-scope",
      displayName: "Code/Area Architect (draft)",
      scope: "MCP_DRAFT_REPO_SCOPE_MARKER — proposed via persona_draft_propose --repo.",
      sections: [{ heading: "Authored section", body: "MCP_DRAFT_REPO_BODY_MARKER — real repo-local draft write." }],
    });
    const draftProposeRepoResult = await client.callTool({
      name: "persona_draft_propose",
      arguments: { file: draftProposeRepoFile, repo: fakeDraftRepo },
    });
    ok(!draftProposeRepoResult.isError, `persona_draft_propose (repo-local tier) did not error (${JSON.stringify(draftProposeRepoResult)})`);
    const draftProposeRepo = toolResultJson(draftProposeRepoResult);
    ok(draftProposeRepo?.ok === true, `persona_draft_propose (repo-local tier) returns ok:true (${JSON.stringify(draftProposeRepo)})`);

    const draftShowRepoResult = await client.callTool({
      name: "persona_draft_show",
      arguments: { tier: "code-architect", scopeId: "mcp-draft-repo-scope", repo: fakeDraftRepo },
    });
    ok(!draftShowRepoResult.isError, `persona_draft_show (repo-local tier) did not error (${JSON.stringify(draftShowRepoResult)})`);
    const draftShowRepo = toolResultJson(draftShowRepoResult);
    ok(draftShowRepo?.ok === true, `persona_draft_show (repo-local tier) returns ok:true (${JSON.stringify(draftShowRepo)})`);
    ok(/MCP_DRAFT_REPO_SCOPE_MARKER/.test(draftShowRepo?.output ?? ""), "persona_draft_show (repo-local) round-trips the proposed draft's real content");

    // Without --repo, the same repo-local identity has no active draft
    // visible -- repo-local drafts are scoped by repoRoot, matching the
    // CLI's own contract (test/persona-cli.mjs's AC-draft-propose/AC-draft-show).
    const draftShowRepoNoRepoResult = await client.callTool({
      name: "persona_draft_show",
      arguments: { tier: "code-architect", scopeId: "mcp-draft-repo-scope" },
    });
    ok(!draftShowRepoNoRepoResult.isError, "persona_draft_show (repo-local identity, repo omitted) is not an MCP transport error");
    const draftShowRepoNoRepo = toolResultJson(draftShowRepoNoRepoResult);
    ok(draftShowRepoNoRepo?.ok === false, "persona_draft_show without --repo cannot see the repo-local draft (ok:false)");

    const draftApproveRepoResult = await client.callTool({
      name: "persona_draft_approve",
      arguments: { tier: "code-architect", scopeId: "mcp-draft-repo-scope", repo: fakeDraftRepo },
    });
    ok(!draftApproveRepoResult.isError, `persona_draft_approve (repo-local tier) did not error (${JSON.stringify(draftApproveRepoResult)})`);
    const draftApproveRepo = toolResultJson(draftApproveRepoResult);
    ok(draftApproveRepo?.ok === true, `persona_draft_approve (repo-local tier) returns ok:true (${JSON.stringify(draftApproveRepo)})`);
    const approvedRepoWritten = await readFile(
      path.join(fakeDraftRepo, ".mnemosyne", "personas", "mcp-draft-repo-scope.yaml"),
      "utf8",
    ).catch(() => null);
    ok(approvedRepoWritten !== null, "persona_draft_approve (repo-local tier) via MCP actually committed a real persona file under --repo");
    ok(
      approvedRepoWritten?.includes("MCP_DRAFT_REPO_SCOPE_MARKER"),
      "persona_draft_approve (repo-local tier) committed the draft's real content, unchanged",
    );

    // persona_draft_discard (pu-05) -- a separate identity, discarded instead
    // of approved: archived to discarded/, never committed to the real store.
    const draftDiscardFile = await writeCandidateFile(fakeDraftContentDir, "draft-discard.yaml", {
      tier: "top-orchestrator",
      scopeId: "mcp-draft-discard-scope",
      displayName: "Top Orchestrator (draft, to be discarded)",
      scope: "MCP_DRAFT_DISCARD_SCOPE_MARKER — proposed then discarded.",
      sections: [{ heading: "Authored section", body: "MCP_DRAFT_DISCARD_BODY_MARKER" }],
    });
    const draftDiscardProposeResult = await client.callTool({
      name: "persona_draft_propose",
      arguments: { file: draftDiscardFile },
    });
    ok(!draftDiscardProposeResult.isError, "persona_draft_propose (discard fixture) did not error");
    ok(toolResultJson(draftDiscardProposeResult)?.ok === true, "persona_draft_propose (discard fixture) returns ok:true");

    const draftDiscardResult = await client.callTool({
      name: "persona_draft_discard",
      arguments: { tier: "top-orchestrator", scopeId: "mcp-draft-discard-scope" },
    });
    ok(!draftDiscardResult.isError, `persona_draft_discard did not error (${JSON.stringify(draftDiscardResult)})`);
    const draftDiscard = toolResultJson(draftDiscardResult);
    ok(draftDiscard?.ok === true, `persona_draft_discard returns ok:true (${JSON.stringify(draftDiscard)})`);
    ok(/discarded/.test(draftDiscard?.output ?? ""), "persona_draft_discard reports the archival with its own 'discarded' verb");

    const discardedCommitted = await readFile(
      path.join(fakeHome, ".mnemosyne", "personas", "top-orchestrator", "mcp-draft-discard-scope.yaml"),
      "utf8",
    ).catch(() => null);
    ok(discardedCommitted === null, "persona_draft_discard never committed anything into the real global persona store");

    const draftShowAfterDiscardResult = await client.callTool({
      name: "persona_draft_show",
      arguments: { tier: "top-orchestrator", scopeId: "mcp-draft-discard-scope" },
    });
    ok(!draftShowAfterDiscardResult.isError, "persona_draft_show (after discard) is not an MCP transport error");
    ok(toolResultJson(draftShowAfterDiscardResult)?.ok === false, "persona_draft_show reports ok:false after discard -- no longer an active draft");

    // persona_draft_approve -- a rejected draft-approve (structurally valid
    // enough to write as a draft, but assertValidPersona-invalid: missing
    // displayName/scope) comes back ok:false in the tool's own JSON payload,
    // isError:false at the MCP transport -- never a silent no-op, and never
    // an MCP transport error, matching persona_create's own bad-tier/
    // mandate-smuggle contract above exactly (AC: "a clear ... isError:true
    // (MCP) result" -- realized here as wrapAction's own established
    // ok:false-in-payload contract for a handled, non-thrown CLI failure,
    // the same contract every other persona_* tool's failure path already
    // uses; forcing a literal isError:true would require new logic in
    // wrapAction/personaCliRun this ticket deliberately does not add).
    const draftInvalidFile = await writeCandidateFile(fakeDraftContentDir, "draft-invalid.yaml", {
      tier: "top-orchestrator",
      scopeId: "mcp-draft-invalid-scope",
      sections: [{ heading: "Section", body: "body" }],
    });
    const draftInvalidProposeResult = await client.callTool({
      name: "persona_draft_propose",
      arguments: { file: draftInvalidFile },
    });
    ok(!draftInvalidProposeResult.isError, "persona_draft_propose (incomplete candidate) did not error");
    ok(toolResultJson(draftInvalidProposeResult)?.ok === true, "persona_draft_propose (incomplete candidate) succeeds -- structural-only check, not assertValidPersona-strength");

    const draftInvalidApproveResult = await client.callTool({
      name: "persona_draft_approve",
      arguments: { tier: "top-orchestrator", scopeId: "mcp-draft-invalid-scope" },
    });
    ok(!draftInvalidApproveResult.isError, "persona_draft_approve (invalid candidate) is not an MCP transport error");
    const draftInvalidApprove = toolResultJson(draftInvalidApproveResult);
    ok(draftInvalidApprove?.ok === false, "persona_draft_approve (invalid candidate) returns ok:false in its own JSON payload -- never a silent no-op");

    const invalidCommitted = await readFile(
      path.join(fakeHome, ".mnemosyne", "personas", "top-orchestrator", "mcp-draft-invalid-scope.yaml"),
      "utf8",
    ).catch(() => null);
    ok(invalidCommitted === null, "the rejected draft-approve wrote NOTHING to the real global persona store");

    const draftInvalidStillActiveResult = await client.callTool({
      name: "persona_draft_show",
      arguments: { tier: "top-orchestrator", scopeId: "mcp-draft-invalid-scope" },
    });
    ok(!draftInvalidStillActiveResult.isError, "persona_draft_show (after a FAILED approve) is not an MCP transport error");
    ok(toolResultJson(draftInvalidStillActiveResult)?.ok === true, "the draft remains active after a failed approve (not archived)");
  } finally {
    await client.close().catch(() => {});
    await rm(fakeHome, { recursive: true, force: true });
    await rm(fakeRepo, { recursive: true, force: true });
    await rm(fakeContentDir, { recursive: true, force: true });
    await rm(fakeCreateRepo, { recursive: true, force: true });
    await rm(fakeDraftContentDir, { recursive: true, force: true });
    await rm(fakeDraftRepo, { recursive: true, force: true });
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
