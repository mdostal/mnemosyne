// src/discoveryPilotRoutes.mjs — cm-15-discovery-and-pilot-trigger-ui
// (epic: mnemosyne-conversation-memory).
//
// Thin execFile() bridges from src/server.mjs (plain `node`, cannot import
// a `.ts` module directly -- confirmed by bin/mnemosyne's own dispatcher
// launch line and by bin/graphify-bridge.mjs's own doc comment naming the
// identical constraint for its sibling zero-dep bin) to the two
// `tsx`-launched CLIs this story depends on:
//   - bin/mnemosyne-conversation-discover.mjs (cm-02's discoverSources(),
//     wrapped with --json this pass)
//   - bin/mnemosyne-conversation-pilot.mjs (cm-08's already-shipped bounded
//     operator pilot orchestrator, its own real machine-readable
//     --sessions/--exports/--confirm/--json mode)
// Mirrors bin/graphify-bridge.mjs's own execFile + promisify(execFile)
// convention and bin/mnemosyne-onboard.mjs's own `{ exec = execFileAsync }`
// dependency-injection convention for testability -- every exported
// function below accepts an injectable `exec`, so test/discovery-pilot-
// routes.mjs never spawns a real subprocess of either CLI: it passes a
// hand-written fake `exec` that returns canned JSON stdout, the "stubbed
// execFile()/CLI-output boundary" this story's own test-spec step
// requires. Real production wiring (src/server.mjs's route handlers) uses
// the real, default `execFileAsync` -- the SAME "thin HTTP wrapper shells
// out to a CLI" architecture engine.mjs already establishes for every
// existing route in that file, extended to these two new CLIs rather than
// a new architectural pattern.
//
// ---------------------------------------------------------------------------
// No-implicit-selection, layer 2 -- THE REAL ENFORCEMENT POINT.
// ---------------------------------------------------------------------------
// `runPilotRoute()` below rejects (a 400-shaped thrown error) any body
// whose combined `sessionPaths`/`exportKeys` are empty, BEFORE `exec()` is
// ever called -- cm-08's own orchestrator is never invoked bare, never with
// an implicit/default/auto-selected set. Client-side (ui/app.js) refuses
// inline on an empty checked set (layer 1); cm-08's own unchanged
// no-implicit-selection refusal logic (its own AC5, reached via
// `--confirm` + explicit `--sessions`/`--exports`) is layer 3. None of the
// three is trusted alone -- this module's own empty-selection guard, below,
// is verified directly by a test asserting `exec` is never invoked for
// that case.
//
// cm-08's own small-sample cap (its own AC1, max 5 per source) is NEVER
// re-implemented or re-capped here, client-side or server-side -- an
// oversized selection is passed straight through to cm-08's own CLI, whose
// own refusal (`{ ok: false, refused: true, reason: "...exceeds the
// maximum..." }`) is surfaced verbatim in this module's return value, never
// silently truncated.

import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const TSX_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");

// Overridable purely for tests -- mirrors engine.mjs's own SWARM_MEMORY_BIN
// convention (the CLI *identity* is swappable; the tsx-launch wrapper
// around it stays the same real invocation shape). Real production default
// is the real, shipped CLI file.
export const DISCOVER_CLI =
  process.env.MNEMOSYNE_CONVERSATION_DISCOVER_BIN || path.join(REPO_ROOT, "bin", "mnemosyne-conversation-discover.mjs");
export const PILOT_CLI =
  process.env.MNEMOSYNE_CONVERSATION_PILOT_BIN || path.join(REPO_ROOT, "bin", "mnemosyne-conversation-pilot.mjs");

const EXEC_OPTS = { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 };

function parseCliJson(stdout, cliName) {
  try {
    return JSON.parse(stdout);
  } catch {
    throw Object.assign(
      new Error(`${cliName} returned output that could not be parsed as JSON: ${String(stdout ?? "").slice(0, 200)}`),
      { status: 502 },
    );
  }
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * POST /conversation-memory/sources/scan's real implementation. ALWAYS a
 * fresh invocation (never a cached read) -- the discover CLI's own
 * write:true-by-default contract mirrors cm-02's own AC7
 * idempotent-recompute-from-scratch guarantee. `exec` injectable for
 * tests.
 */
export async function scanSources({ exec = execFileAsync } = {}) {
  let stdout;
  try {
    const result = await exec(process.execPath, [TSX_BIN, DISCOVER_CLI, "--json"], EXEC_OPTS);
    stdout = result.stdout;
  } catch (e) {
    const detail = (e && e.stderr && String(e.stderr).trim()) || (e && e.message) || String(e);
    throw Object.assign(new Error(`conversation source scan failed: ${detail}`), { status: 500 });
  }
  const parsed = parseCliJson(stdout, "mnemosyne-conversation-discover");
  if (!parsed.ok) {
    throw Object.assign(new Error(parsed.error || "conversation source scan refused"), { status: 500 });
  }
  return parsed.manifest;
}

/**
 * POST /conversation-memory/pilot/run's real implementation.
 *
 * `body`: `{ sessionPaths: string[], exportKeys: string[] }` -- the
 * operator's EXACT marked subset (cm-15's own AC4), never a superset,
 * never an auto-selected default. `sessionPaths` maps 1:1 to cm-08's own
 * real `--sessions <path,...>` flag (Claude Code session paths).
 * `exportKeys` maps 1:1 to cm-08's own real `--exports <id,...>` flag --
 * note this is cm-08's real, AS-BUILT contract: the VALUES are ChatGPT
 * CONVERSATION IDS, not the `chatgpt`/`gemini` export-file-level keys
 * cm-15's own planning-time story text illustratively sketched (cm-08 has
 * no Gemini support at all in its real, shipped implementation -- verified
 * by direct read of bin/mnemosyne-conversation-pilot.mjs, which never
 * mentions Gemini). `exportKeys` is named to match the story's own route
 * body shape byte-for-byte; ui/app.js is the layer that resolves it to
 * real ChatGPT conversation ids (see that file's own comment).
 *
 * Throws a 400-shaped error (never calling `exec`) on an empty combined
 * selection -- the real, server-side no-implicit-selection enforcement
 * point (layer 2). `exec` injectable for tests.
 */
export async function runPilotRoute(body, { exec = execFileAsync } = {}) {
  const sessionPaths = Array.isArray(body?.sessionPaths) ? body.sessionPaths.filter(isNonEmptyString) : [];
  const exportKeys = Array.isArray(body?.exportKeys) ? body.exportKeys.filter(isNonEmptyString) : [];

  if (sessionPaths.length === 0 && exportKeys.length === 0) {
    throw Object.assign(
      new Error(
        "pilot run refused: at least one sessionPaths or exportKeys entry is required -- no implicit/default selection exists",
      ),
      { status: 400 },
    );
  }

  const args = [
    TSX_BIN,
    PILOT_CLI,
    "--sessions",
    sessionPaths.join(","),
    "--exports",
    exportKeys.join(","),
    "--confirm",
    "--json",
  ];

  let stdout;
  try {
    const result = await exec(process.execPath, args, EXEC_OPTS);
    stdout = result.stdout;
  } catch (e) {
    // cm-08's own CLI exits 1 both on a refusal (e.g. the small-sample cap
    // exceeded) AND on a real per-stage failure -- both cases still print a
    // real JSON body to stdout in --json mode (executeCliInvocation()
    // always logs JSON before returning/exiting); execFile still attaches
    // that captured stdout to the rejected error even on a non-zero exit.
    // Only a genuinely stdout-less failure (crash before any JSON was
    // printed) falls through to a hard 500.
    stdout = e && e.stdout;
    if (!isNonEmptyString(stdout)) {
      const detail = (e && e.stderr && String(e.stderr).trim()) || (e && e.message) || String(e);
      throw Object.assign(new Error(`pilot run failed: ${detail}`), { status: 500 });
    }
  }

  return parseCliJson(stdout, "mnemosyne-conversation-pilot");
}
