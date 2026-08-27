// src/triageReviewRoutes.mjs — cm-16-triage-review-and-confirm-ui (epic:
// mnemosyne-conversation-memory).
//
// Thin execFile() bridge from src/server.mjs (plain `node`, cannot import a
// `.ts` module directly -- the SAME constraint cm-15's own
// src/discoveryPilotRoutes.mjs documents, confirmed by bin/mnemosyne's own
// dispatcher launch line and bin/graphify-bridge.mjs's own doc comment for
// its sibling zero-dep bin) to the new, small, tsx-launched
// bin/mnemosyne-conversation-triage-review.mjs, which is where this
// story's REAL route logic actually runs (its own exported
// runReadTriageQueue()/runIntakeCandidates()/runConfirm() functions --
// this file is transport-only, mirrors src/discoveryPilotRoutes.mjs's own
// exec + promisify(execFile) convention and bin/mnemosyne-onboard.mjs's own
// `{ exec = execFileAsync }` dependency-injection convention for
// testability). Every test in test/triage-review-routes.mjs injects a
// hand-written fake `exec` -- never a real subprocess, never live Qdrant,
// never real personal content (the "stubbed execFile()/CLI-output
// boundary" this story's own test-spec step requires).

import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const TSX_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");

// Overridable purely for tests -- mirrors src/discoveryPilotRoutes.mjs's own
// DISCOVER_CLI/PILOT_CLI convention.
export const TRIAGE_REVIEW_CLI =
  process.env.MNEMOSYNE_CONVERSATION_TRIAGE_REVIEW_BIN ||
  path.join(REPO_ROOT, "bin", "mnemosyne-conversation-triage-review.mjs");

const EXEC_OPTS = { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 };

function parseCliJson(stdout, verb) {
  try {
    return JSON.parse(stdout);
  } catch {
    throw Object.assign(
      new Error(`mnemosyne-conversation-triage-review ${verb} returned output that could not be parsed as JSON: ${String(stdout ?? "").slice(0, 200)}`),
      { status: 502 },
    );
  }
}

async function execCli(args, { exec = execFileAsync } = {}) {
  let stdout;
  try {
    const result = await exec(process.execPath, [TSX_BIN, TRIAGE_REVIEW_CLI, ...args], EXEC_OPTS);
    stdout = result.stdout;
  } catch (e) {
    // Mirrors src/discoveryPilotRoutes.mjs's own "a non-zero exit can still
    // carry a real, printed JSON body" tolerance -- the CLI always prints
    // its result object (ok:true or ok:false) before process.exit(), even
    // on a refusal. Only a genuinely stdout-less crash falls through to a
    // hard 500 below.
    stdout = e && e.stdout;
    if (typeof stdout !== "string" || stdout.trim().length === 0) {
      const detail = (e && e.stderr && String(e.stderr).trim()) || (e && e.message) || String(e);
      throw Object.assign(new Error(`triage review CLI failed: ${detail}`), { status: 500 });
    }
  }
  return parseCliJson(stdout, args[0]);
}

/** GET /conversation-memory/triage-queue's real implementation. */
export async function readTriageQueue({ exec = execFileAsync } = {}) {
  const result = await execCli(["read-triage-queue"], { exec });
  if (!result.ok) {
    throw Object.assign(new Error(result.error || "triage queue read failed"), { status: 500 });
  }
  return result;
}

/** GET /conversation-memory/intake-candidates's real implementation. */
export async function readIntakeCandidates({ exec = execFileAsync } = {}) {
  const result = await execCli(["intake-candidates"], { exec });
  if (!result.ok) {
    throw Object.assign(new Error(result.error || "intake candidates read failed"), { status: 500 });
  }
  return result;
}

/**
 * POST /conversation-memory/scope-route/confirm's real implementation.
 * `clusterId`/`scopeKey` refused (400, before the CLI is ever invoked) when
 * either is missing/blank -- the SAME server-side no-implicit-input
 * enforcement point every other write route in this codebase (`POST
 * /reindex`, `runPilotRoute()`) already establishes. Every OTHER refusal
 * (no matching candidate_unconfirmed row) is the CLI's own real
 * `{ok:false, error}` result, surfaced here as a 400 -- never silently
 * downgraded to a no-op success (loud-failure, this story's own
 * cross-cutting concern).
 */
export async function confirmScopeRoute(body, { exec = execFileAsync } = {}) {
  const clusterId = typeof body?.cluster_id === "string" ? body.cluster_id.trim() : "";
  const scopeKey = typeof body?.scope_key === "string" ? body.scope_key.trim() : "";
  if (!clusterId || !scopeKey) {
    throw Object.assign(new Error("cluster_id and scope_key are both required"), { status: 400 });
  }

  const result = await execCli(["confirm", "--cluster-id", clusterId, "--scope-key", scopeKey], { exec });
  if (!result.ok) {
    throw Object.assign(new Error(result.error || "scope-route confirm refused"), { status: 400 });
  }
  return result;
}
