// triage-review-routes.mjs — TDD tests for cm-16-triage-review-and-confirm-
// ui's src/triageReviewRoutes.mjs (epic: mnemosyne-conversation-memory).
//
// Every test below injects a hand-written fake `exec` -- NEVER a real
// subprocess, never live Qdrant, never real personal content. This is the
// "stubbed execFile()/CLI-output boundary" this story's own test-spec step
// requires: readTriageQueue()/readIntakeCandidates()/confirmScopeRoute()
// are called directly, in-process, with a fake `exec` that returns canned
// JSON stdout (or rejects with a canned error) -- no HTTP server, no CLI
// subprocess of any kind is ever spawned by this file. (The REAL
// route-logic behavior -- fs writes, candidate-status computation -- is
// verified separately, in-process, by
// bin/mnemosyne-conversation-triage-review.test.mjs, where the actual TS
// logic runs directly under tsx.)
//
// Usage: node test/triage-review-routes.mjs

import { readTriageQueue, readIntakeCandidates, confirmScopeRoute, TRIAGE_REVIEW_CLI } from "../src/triageReviewRoutes.mjs";

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

// ============================================================================
// readTriageQueue() -- GET /conversation-memory/triage-queue's real logic.
// ============================================================================

await (async () => {
  const body = { ok: true, quarantine: [{ entry_id: "q1" }], confirmations: [{ cluster_id: "c1", scope_key: "arizona" }] };
  const exec = makeSpyExec(async () => ({ stdout: JSON.stringify(body), stderr: "" }));
  const result = await readTriageQueue({ exec });
  ok(exec.calls.length === 1, "readTriageQueue() calls exec() exactly once");
  ok(exec.calls[0].args.includes(TRIAGE_REVIEW_CLI), "readTriageQueue() execs the triage-review CLI path");
  ok(exec.calls[0].args.includes("read-triage-queue"), "readTriageQueue() passes the read-triage-queue subcommand");
  ok(JSON.stringify(result) === JSON.stringify(body), "readTriageQueue() returns the CLI's real result, unmodified");
})();

await (async () => {
  const exec = makeSpyExec(async () => ({ stdout: JSON.stringify({ ok: false, error: "boom" }), stderr: "" }));
  let threw = null;
  try {
    await readTriageQueue({ exec });
  } catch (e) {
    threw = e;
  }
  ok(!!threw, "readTriageQueue() throws when the CLI itself reports ok:false");
  ok(threw && threw.status === 500, "readTriageQueue()'s thrown error carries a 500 status");
})();

await (async () => {
  const exec = makeSpyExec(async () => ({ stdout: "not json", stderr: "" }));
  let threw = null;
  try {
    await readTriageQueue({ exec });
  } catch (e) {
    threw = e;
  }
  ok(!!threw, "readTriageQueue() throws on unparsable CLI stdout");
  ok(threw && threw.status === 502, "unparsable-stdout error carries a 502 status");
})();

// ============================================================================
// readIntakeCandidates() -- GET /conversation-memory/intake-candidates's
// real logic.
// ============================================================================

await (async () => {
  const body = { ok: true, candidates: [{ entryId: "e1", clusterId: "c1", scopeKey: "arizona", status: "candidate_unconfirmed", distributedToScope: null }] };
  const exec = makeSpyExec(async () => ({ stdout: JSON.stringify(body), stderr: "" }));
  const result = await readIntakeCandidates({ exec });
  ok(exec.calls.length === 1, "readIntakeCandidates() calls exec() exactly once");
  ok(exec.calls[0].args.includes("intake-candidates"), "readIntakeCandidates() passes the intake-candidates subcommand");
  ok(JSON.stringify(result) === JSON.stringify(body), "readIntakeCandidates() returns the CLI's real result, unmodified");
})();

await (async () => {
  const exec = makeSpyExec(async () => {
    throw Object.assign(new Error("spawn ENOENT"), { stderr: "" });
  });
  let threw = null;
  try {
    await readIntakeCandidates({ exec });
  } catch (e) {
    threw = e;
  }
  ok(!!threw, "readIntakeCandidates() throws when exec() itself rejects with no stdout");
  ok(threw && threw.status === 500, "exec()-rejection error carries a 500 status");
})();

// ============================================================================
// confirmScopeRoute() -- POST /conversation-memory/scope-route/confirm's
// real logic. Server-side no-implicit-input enforcement (never calls
// exec() for a missing/blank cluster_id or scope_key).
// ============================================================================

await (async () => {
  const exec = makeSpyExec(async () => {
    throw new Error("exec() must never be called for a missing cluster_id/scope_key");
  });

  for (const body of [{}, { cluster_id: "" }, { cluster_id: "c1" }, { cluster_id: "  ", scope_key: "arizona" }, { cluster_id: "c1", scope_key: "   " }]) {
    let threw = null;
    try {
      await confirmScopeRoute(body, { exec });
    } catch (e) {
      threw = e;
    }
    ok(!!threw, `confirmScopeRoute() refuses a missing/blank cluster_id or scope_key: ${JSON.stringify(body)}`);
    ok(threw && threw.status === 400, `refusal carries HTTP 400: ${JSON.stringify(body)}`);
  }
  ok(exec.calls.length === 0, "exec() was NEVER called for any missing/blank-field case");
})();

await (async () => {
  const cliResult = { ok: true, confirmed: true, entry: { recordedAt: "2026-08-27T00:00:00.000Z", confirmation_reason: "scope_route_confirmed", cluster_id: "cluster-1", scope_key: "arizona" } };
  const exec = makeSpyExec(async () => ({ stdout: JSON.stringify(cliResult), stderr: "" }));

  const result = await confirmScopeRoute({ cluster_id: "cluster-1", scope_key: "arizona" }, { exec });

  ok(exec.calls.length === 1, "confirmScopeRoute() calls exec() exactly once for a valid body");
  const call = exec.calls[0];
  ok(call.args.includes("confirm"), "confirmScopeRoute() passes the confirm subcommand");
  const clusterIdx = call.args.indexOf("--cluster-id");
  ok(clusterIdx !== -1 && call.args[clusterIdx + 1] === "cluster-1", "--cluster-id carries the exact given cluster_id");
  const scopeIdx = call.args.indexOf("--scope-key");
  ok(scopeIdx !== -1 && call.args[scopeIdx + 1] === "arizona", "--scope-key carries the exact given scope_key");
  ok(JSON.stringify(result) === JSON.stringify(cliResult), "confirmScopeRoute() returns the CLI's real result, unmodified");
})();

await (async () => {
  // The CLI's own real refusal (no matching candidate_unconfirmed row) --
  // surfaced as a 400, never silently downgraded to a success.
  const cliRefusal = { ok: false, error: "refused: no currently-known candidate_unconfirmed row matches cluster_id=\"c1\" scope_key=\"arizona\"" };
  const exec = makeSpyExec(async () => ({ stdout: JSON.stringify(cliRefusal), stderr: "" }));

  let threw = null;
  try {
    await confirmScopeRoute({ cluster_id: "c1", scope_key: "arizona" }, { exec });
  } catch (e) {
    threw = e;
  }
  ok(!!threw, "confirmScopeRoute() throws when the CLI itself refuses (ok:false)");
  ok(threw && threw.status === 400, "the CLI's own refusal is surfaced as a 400, never silently downgraded");
  ok(threw && /no currently-known candidate_unconfirmed/.test(threw.message), "the CLI's own real refusal reason is surfaced verbatim");
})();

await (async () => {
  // A non-zero exit that still prints a real JSON body first (mirrors
  // src/discoveryPilotRoutes.mjs's own identical tolerance) is parsed, not
  // treated as a hard crash.
  const cliRefusal = { ok: false, error: "refused: stale pair" };
  const exec = makeSpyExec(async () => {
    throw Object.assign(new Error("Command failed"), { stdout: JSON.stringify(cliRefusal), stderr: "", code: 1 });
  });
  let threw = null;
  try {
    await confirmScopeRoute({ cluster_id: "c1", scope_key: "arizona" }, { exec });
  } catch (e) {
    threw = e;
  }
  ok(!!threw && threw.status === 400, "a non-zero exit with a real printed refusal JSON body still surfaces as a 400");
})();

await (async () => {
  const exec = makeSpyExec(async () => {
    throw Object.assign(new Error("spawn ENOENT"), { stderr: "env: node: No such file or directory" });
  });
  let threw = null;
  try {
    await confirmScopeRoute({ cluster_id: "c1", scope_key: "arizona" }, { exec });
  } catch (e) {
    threw = e;
  }
  ok(!!threw, "a stdout-less exec() crash throws");
  ok(threw && threw.status === 500, "a stdout-less exec() crash carries a 500 status, never silently treated as success");
})();

console.log(fails ? `\n${fails} check(s) failed` : "\nall triage-review-routes checks passed");
process.exit(fails ? 1 : 0);
