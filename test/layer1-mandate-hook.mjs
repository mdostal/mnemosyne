// layer1-mandate-hook.mjs — la-07-layer1-enforcement-mandate.
//
// The Layer-1 mandate (lib/mnemosyne/layer1/tiers.ts's MANDATE_SECTIONS)
// tells every Claude Code agent that recall-on-entry/remember-on-exit
// "already happens automatically" via the installed hooks/pre-recall.mjs
// (UserPromptSubmit) and hooks/post-remember.mjs (Stop/SubagentStop). This
// suite is the "invoke it and check" proof that claim requires -- per
// la-07's acceptance criteria: "recall is actually invoked automatically
// where technically feasible -- not just described in prose".
//
// Unlike test/hooks.mjs's live-corpus round trip (which SKIPs without a
// running Mnemosyne service on :8477), this suite forces the CLI-FALLBACK
// path (unreachable MNEMOSYNE_URL + SWARM_MEMORY_BIN pointed at the
// fake-swarm-memory test double already used by write-through.mjs/
// reindex.mjs/vector.mjs/recall-status-filtering.mjs) so it runs
// deterministically offline, every time, in the aggregate `npm test` chain.
// It spawns the REAL hooks/pre-recall.mjs and hooks/post-remember.mjs
// scripts as real subprocesses via real stdin/stdout -- exactly the
// invocation shape Claude Code uses -- not an in-process call or a stub of
// the hook itself.
//
//   node test/layer1-mandate-hook.mjs

import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const FAKE_SWARM = path.join(ROOT, "test", "fixtures", "fake-swarm-memory.mjs");
const PRE_RECALL = path.join(ROOT, "hooks", "pre-recall.mjs");
const POST_REMEMBER = path.join(ROOT, "hooks", "post-remember.mjs");
// Deliberately unroutable (TEST-NET-1, RFC 5737) so the HTTP leg of both
// hooks fails fast and consistently falls through to the CLI path, instead
// of racing an actually-closed local port.
const UNREACHABLE_URL = "http://192.0.2.1:1";

let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "  PASS" : "  FAIL"}  ${m}`);
  if (!c) fails++;
};

function runHook(scriptPath, inputObj, env = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [scriptPath], {
      cwd: ROOT,
      env: {
        ...process.env,
        MNEMOSYNE_URL: UNREACHABLE_URL,
        MNEMOSYNE_HTTP_TIMEOUT_MS: "500",
        ...env,
      },
    });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => resolve({ code, out, err }));
    p.stdin.write(JSON.stringify(inputObj));
    p.stdin.end();
  });
}

function parseJson(out) {
  try {
    return JSON.parse(out || "{}");
  } catch (e) {
    return { __parseError: String(e), __raw: out };
  }
}

async function testPreRecallFiresARealRecallCallThroughCliFallback() {
  const result = await runHook(
    PRE_RECALL,
    {
      hook_event_name: "UserPromptSubmit",
      prompt: "What did we already decide about the mandate enforcement mechanism?",
      scope: "personal",
      role: "developer",
      hits: 3,
    },
    { SWARM_MEMORY_BIN: FAKE_SWARM }
  );

  ok(result.code === 0, "hooks/pre-recall.mjs exits 0 when invoked exactly as Claude Code's UserPromptSubmit would");
  const json = parseJson(result.out);
  ok(!json.__parseError, `hooks/pre-recall.mjs emits valid JSON on stdout (${json.__parseError || ""})`);
  ok(json.hookSpecificOutput?.hookEventName === "UserPromptSubmit", "emits the UserPromptSubmit hook event name Claude Code expects");

  const injected = json.hookSpecificOutput?.additionalContext || "";
  ok(injected.length > 0, "additionalContext is non-empty -- something was actually injected, not silently skipped");
  ok(
    injected.includes("test semantic query fixture hit"),
    "additionalContext contains the fake-swarm-memory fixture's hit text -- proves recall() really executed the CLI-fallback subprocess and its real output was threaded through, not a stub of pre-recall.mjs itself"
  );
  ok(json.mnemosyne?.canonical_bundle === injected, "runner-neutral canonical_bundle matches the Claude-shaped additionalContext");
  ok((json.mnemosyne?.stats?.total_hits ?? 0) >= 1, "mnemosyne.stats.total_hits reflects the real recall result");
  ok(
    /\[pre-recall\] injected .*via=cli/.test(result.err),
    `stderr diagnostic confirms the CLI-fallback path actually served this recall (got: ${JSON.stringify(result.err)})`
  );
}

async function testPreRecallStaysSilentWhenMemoryIsTrulyUnreachable() {
  // Sanity check on the negative case, so the positive test above isn't
  // trivially true: with NO CLI fallback available either, pre-recall must
  // still exit 0 (never break the agent loop) but inject nothing.
  const result = await runHook(
    PRE_RECALL,
    { prompt: "some query with nothing behind it", scope: "personal", role: "developer" },
    { SWARM_MEMORY_BIN: "/definitely/does/not/exist/swarm-memory" }
  );
  ok(result.code === 0, "pre-recall.mjs still exits 0 when both service and CLI are unreachable (resilience contract)");
  const json = parseJson(result.out);
  ok(!json.hookSpecificOutput, "no hookSpecificOutput is emitted when memory is genuinely unreachable -- confirms the positive test's injection is real recall output, not a hardcoded emission");
}

async function testPostRememberFiresARealRememberCallThroughCliFallback() {
  const notesDir = await mkdtemp(path.join(tmpdir(), "mnemosyne-mandate-notes-"));
  try {
    const marker = `LA-07-MANDATE-HOOK-PROOF-${Date.now()}`;
    const result = await runHook(
      POST_REMEMBER,
      {
        hook_event_name: "Stop",
        text: `Layer-1 mandate hook proof note. ${marker}`,
        scope: "personal",
        status: "reviewed",
        ticket: "la-07",
        role: "developer",
      },
      { SWARM_MEMORY_BIN: FAKE_SWARM, MNEMOSYNE_NOTES_DIR: notesDir }
    );

    ok(result.code === 0, "hooks/post-remember.mjs exits 0 when invoked exactly as Claude Code's Stop hook would");
    const json = parseJson(result.out);
    ok(!json.__parseError, `hooks/post-remember.mjs emits valid JSON on stdout (${json.__parseError || ""})`);
    ok(json.ok === true, "post-remember reports the write as persisted");
    ok(json.via === "cli", `remember() actually went through the CLI-fallback path (via=${json.via})`);
    ok(json.chunks_upserted === 3, "chunks_upserted reflects fake-swarm-memory's real index output, not a stub");

    const written = await readdir(notesDir);
    ok(written.length === 1, `remember() actually wrote a real note file to disk (found ${written.length})`);
    if (written.length === 1) {
      const contents = await readFile(path.join(notesDir, written[0]), "utf8");
      ok(contents.includes(marker), "the on-disk note file contains this run's unique marker text");
      ok(contents.includes("STATUS: reviewed"), "the on-disk note file carries the status-aware STATUS header post-remember.mjs stamps");
    }
  } finally {
    await rm(notesDir, { recursive: true, force: true });
  }
}

async function testHookWiringDeclaresRecallOnEntryAndRememberOnExit() {
  // The mandate text asserts specific hook -> event wiring; keep that claim
  // honest by checking it against the actual template the installer merges
  // into settings.json (bin/mnemosyne-install-hooks/test/hooks.mjs already
  // prove the merge itself works end-to-end -- this just confirms the
  // template pre-recall.mjs/post-remember.mjs point at hasn't drifted).
  const raw = await readFile(path.join(ROOT, "hooks", "settings.hooks.json"), "utf8");
  const template = JSON.parse(raw);
  const preCommand = template.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command || "";
  const stopCommand = template.hooks?.Stop?.[0]?.hooks?.[0]?.command || "";
  const subagentStopCommand = template.hooks?.SubagentStop?.[0]?.hooks?.[0]?.command || "";
  ok(preCommand.includes("pre-recall.mjs"), "UserPromptSubmit is wired to pre-recall.mjs (recall on entry)");
  ok(stopCommand.includes("post-remember.mjs"), "Stop is wired to post-remember.mjs (remember on exit)");
  ok(subagentStopCommand.includes("post-remember.mjs"), "SubagentStop is wired to post-remember.mjs (remember on exit, subagents too)");
}

await testPreRecallFiresARealRecallCallThroughCliFallback();
await testPreRecallStaysSilentWhenMemoryIsTrulyUnreachable();
await testPostRememberFiresARealRememberCallThroughCliFallback();
await testHookWiringDeclaresRecallOnEntryAndRememberOnExit();

console.log(fails ? `\n${fails} check(s) failed` : "\nall layer1 mandate hook checks passed");
process.exit(fails ? 1 : 0);
