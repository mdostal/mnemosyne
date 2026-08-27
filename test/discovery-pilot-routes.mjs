// discovery-pilot-routes.mjs — TDD tests for cm-15-discovery-and-pilot-
// trigger-ui's src/discoveryPilotRoutes.mjs (epic: mnemosyne-conversation-
// memory).
//
// Every test below injects a hand-written fake `exec` -- NEVER a real
// subprocess, never live Qdrant/Gemini, never real personal content. This
// is the "stubbed execFile()/CLI-output boundary" the story's own
// test-spec step requires: scanSources()/runPilotRoute() are called
// directly, in-process, with a fake `exec` that returns canned JSON stdout
// (or rejects with a canned error) -- no HTTP server, no CLI subprocess of
// any kind is ever spawned by this file.
//
// Usage: node test/discovery-pilot-routes.mjs

import { scanSources, runPilotRoute, DISCOVER_CLI, PILOT_CLI } from "../src/discoveryPilotRoutes.mjs";

let fails = 0;
const ok = (c, m) => { console.log(`${c ? "  PASS" : "  FAIL"}  ${m}`); if (!c) fails++; };

function makeSpyExec(impl) {
  const calls = [];
  const exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return impl(cmd, args, opts);
  };
  exec.calls = calls;
  return exec;
}

function fakeManifest() {
  return {
    generatedAt: "2026-08-27T00:00:00.000Z",
    sessions: [
      { path: "/fixture/a.jsonl", projectDir: "-fixture-a", projectSlug: "/fixture/a", sizeBytes: 100, mtime: "2026-08-01T00:00:00.000Z", scratchConfidence: "confirmed" },
    ],
    excluded: [],
    exports: {
      chatgpt: { path: "/fixture/chatgpt/conversations.json", status: "present" },
      gemini: { path: "/fixture/gemini/takeout.zip", status: "not_found" },
    },
  };
}

// ============================================================================
// scanSources() -- POST /conversation-memory/sources/scan's real logic.
// ============================================================================

await (async () => {
  const manifest = fakeManifest();
  const exec = makeSpyExec(async () => ({ stdout: JSON.stringify({ ok: true, manifest }), stderr: "" }));
  const result = await scanSources({ exec });
  ok(exec.calls.length === 1, "scanSources() calls exec() exactly once");
  const call = exec.calls[0];
  ok(call.args.includes(DISCOVER_CLI), "scanSources() execs the discover CLI path");
  ok(call.args.includes("--json"), "scanSources() passes --json to the discover CLI");
  ok(JSON.stringify(result) === JSON.stringify(manifest), "scanSources() returns the CLI's real manifest, unmodified");
})();

await (async () => {
  // AC2 / cm-02's own AC7: EVERY call is fresh -- never a cached read.
  // Prove this at the contract level: two separate scanSources() calls
  // produce two separate exec() invocations, never a memoized/cached single
  // call reused across both.
  let callCount = 0;
  const exec = makeSpyExec(async () => {
    callCount++;
    return { stdout: JSON.stringify({ ok: true, manifest: fakeManifest() }), stderr: "" };
  });
  await scanSources({ exec });
  await scanSources({ exec });
  ok(callCount === 2, `scanSources() never caches -- two calls produced ${callCount} exec() invocation(s), expected 2`);
})();

await (async () => {
  const exec = makeSpyExec(async () => ({ stdout: JSON.stringify({ ok: false, error: "boom" }), stderr: "" }));
  let threw = null;
  try {
    await scanSources({ exec });
  } catch (e) {
    threw = e;
  }
  ok(!!threw, "scanSources() throws when the discover CLI itself reports ok:false");
  ok(threw && threw.status === 500, "scanSources()'s thrown error carries a 500 status");
  ok(threw && /boom/.test(threw.message), "scanSources()'s thrown error surfaces the CLI's real error message");
})();

await (async () => {
  const exec = makeSpyExec(async () => ({ stdout: "not json", stderr: "" }));
  let threw = null;
  try {
    await scanSources({ exec });
  } catch (e) {
    threw = e;
  }
  ok(!!threw, "scanSources() throws on unparsable CLI stdout");
  ok(threw && threw.status === 502, "unparsable-stdout error carries a 502 status");
})();

await (async () => {
  const exec = makeSpyExec(async () => {
    throw Object.assign(new Error("spawn ENOENT"), { stderr: "" });
  });
  let threw = null;
  try {
    await scanSources({ exec });
  } catch (e) {
    threw = e;
  }
  ok(!!threw, "scanSources() throws when exec() itself rejects (e.g. CLI missing)");
  ok(threw && threw.status === 500, "exec()-rejection error carries a 500 status");
})();

// ============================================================================
// runPilotRoute() -- POST /conversation-memory/pilot/run's real logic.
// The no-implicit-selection SERVER-SIDE enforcement point (layer 2).
// ============================================================================

await (async () => {
  const exec = makeSpyExec(async () => {
    throw new Error("exec() must never be called for an empty selection");
  });

  for (const body of [
    { sessionPaths: [], exportKeys: [] },
    {},
    { sessionPaths: [], exportKeys: undefined },
    { sessionPaths: ["   "], exportKeys: [""] }, // whitespace-only entries don't count as real marks
  ]) {
    let threw = null;
    try {
      await runPilotRoute(body, { exec });
    } catch (e) {
      threw = e;
    }
    ok(!!threw, `runPilotRoute() refuses an empty/whitespace-only selection: ${JSON.stringify(body)}`);
    ok(threw && threw.status === 400, `refusal carries HTTP 400 (real enforcement point): ${JSON.stringify(body)}`);
  }
  ok(exec.calls.length === 0, "exec() was NEVER called for any empty-selection case -- cm-08's orchestrator is never invoked bare");
})();

await (async () => {
  const cliResult = { ok: true, refused: false, results: [{ sessionId: "s1", sourceType: "claude-code", stage: "distill", ok: true, error: null }], sessionCount: 1, clusterCount: 1, failureCount: 0, recordedAt: "2026-08-27T00:00:00.000Z" };
  const exec = makeSpyExec(async () => ({ stdout: JSON.stringify(cliResult), stderr: "" }));

  const result = await runPilotRoute({ sessionPaths: ["/real/session.jsonl"], exportKeys: [] }, { exec });

  ok(exec.calls.length === 1, "runPilotRoute() calls exec() exactly once for a valid, non-empty selection");
  const call = exec.calls[0];
  ok(call.args.includes(PILOT_CLI), "runPilotRoute() execs cm-08's real pilot CLI path");
  ok(call.args.includes("--confirm"), "runPilotRoute() always passes --confirm (the explicit confirmation gate)");
  ok(call.args.includes("--json"), "runPilotRoute() always passes --json");

  const sessionsIdx = call.args.indexOf("--sessions");
  ok(sessionsIdx !== -1 && call.args[sessionsIdx + 1] === "/real/session.jsonl",
    "--sessions carries EXACTLY the marked subset ('/real/session.jsonl'), never a superset or default");
  const exportsIdx = call.args.indexOf("--exports");
  ok(exportsIdx !== -1 && call.args[exportsIdx + 1] === "",
    "--exports is passed (even empty) when exportKeys is empty but sessionPaths is non-empty");

  ok(JSON.stringify(result) === JSON.stringify(cliResult), "runPilotRoute() returns cm-08's real CLI output, unmodified");
})();

await (async () => {
  // Exactly the marked subset -- multiple sessions AND export ids, never
  // reordered/deduped/expanded.
  const exec = makeSpyExec(async () => ({ stdout: JSON.stringify({ ok: true, refused: false, results: [], sessionCount: 0, clusterCount: 0, failureCount: 0 }), stderr: "" }));
  await runPilotRoute({ sessionPaths: ["/a.jsonl", "/b.jsonl"], exportKeys: ["conv-1", "conv-2", "conv-3"] }, { exec });
  const call = exec.calls[0];
  const sessionsIdx = call.args.indexOf("--sessions");
  const exportsIdx = call.args.indexOf("--exports");
  ok(call.args[sessionsIdx + 1] === "/a.jsonl,/b.jsonl", "multiple sessionPaths join into a single CSV --sessions value, in order");
  ok(call.args[exportsIdx + 1] === "conv-1,conv-2,conv-3", "multiple exportKeys join into a single CSV --exports value, in order");
})();

await (async () => {
  // cm-08's own small-sample cap (its own AC1) is never re-implemented or
  // re-capped here -- an oversized selection (e.g. 6 sessions) is passed
  // straight through to exec(), and the CLI's own refusal is surfaced
  // verbatim, never silently truncated to 5 by this module.
  const oversized = ["/1", "/2", "/3", "/4", "/5", "/6"];
  const cliRefusal = { ok: false, refused: true, reason: "claudeCodeSessions exceeds the maximum of 5 (got 6) -- never a larger, auto-expanded set", results: [] };
  const exec = makeSpyExec(async (cmd, args) => {
    ok(args[args.indexOf("--sessions") + 1] === oversized.join(","), "the FULL oversized selection (6 sessions) is passed to exec(), never pre-truncated");
    // Simulate cm-08's own CLI: exits 1, but still prints its real JSON
    // refusal to stdout first (executeCliInvocation()'s own behavior).
    const err = Object.assign(new Error("Command failed"), { stdout: JSON.stringify(cliRefusal), stderr: "", code: 1 });
    throw err;
  });
  const result = await runPilotRoute({ sessionPaths: oversized, exportKeys: [] }, { exec });
  ok(JSON.stringify(result) === JSON.stringify(cliRefusal),
    "cm-08's own cap-exceeded refusal is surfaced verbatim by runPilotRoute(), never re-capped/re-implemented/silently truncated here");
})();

await (async () => {
  // A genuine per-stage failure (CLI exits 1 with failureCount > 0, not a
  // refusal) is ALSO surfaced verbatim, not converted into an HTTP error --
  // "every stage... appears in the UI with its own real ok/summary".
  const cliPartialFailure = {
    ok: true,
    refused: false,
    results: [
      { sessionId: "s1", sourceType: "claude-code", stage: "discover", ok: true, error: null },
      { sessionId: "s1", sourceType: "claude-code", stage: "parse", ok: true, error: null },
      { sessionId: "s1", sourceType: "claude-code", stage: "triage", ok: false, error: "triageSession() failed: fixture error" },
    ],
    sessionCount: 1,
    clusterCount: 0,
    failureCount: 1,
  };
  const exec = makeSpyExec(async () => {
    const err = Object.assign(new Error("Command failed"), { stdout: JSON.stringify(cliPartialFailure), stderr: "", code: 1 });
    throw err;
  });
  const result = await runPilotRoute({ sessionPaths: ["/real/session.jsonl"], exportKeys: [] }, { exec });
  ok(JSON.stringify(result) === JSON.stringify(cliPartialFailure), "a real per-stage failure result is returned verbatim, not swallowed into a generic error");
  ok(Array.isArray(result.results) && result.results.length === 3, "every stage attempt (discover/parse/triage) is present in the returned results array");
})();

await (async () => {
  // A hard crash with NO stdout at all (e.g. the CLI binary is missing) is
  // a real 500, not a fabricated success.
  const exec = makeSpyExec(async () => {
    throw Object.assign(new Error("spawn ENOENT"), { stderr: "env: node: No such file or directory" });
  });
  let threw = null;
  try {
    await runPilotRoute({ sessionPaths: ["/x.jsonl"], exportKeys: [] }, { exec });
  } catch (e) {
    threw = e;
  }
  ok(!!threw, "a stdout-less exec() crash throws");
  ok(threw && threw.status === 500, "a stdout-less exec() crash carries a 500 status, never silently treated as success");
})();

console.log(fails ? `\n${fails} check(s) failed` : "\nall discovery-pilot-routes checks passed");
process.exit(fails ? 1 : 0);
