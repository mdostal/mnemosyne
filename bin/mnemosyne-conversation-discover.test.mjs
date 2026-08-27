// bin/mnemosyne-conversation-discover.test.mjs — cm-15-discovery-and-pilot-
// trigger-ui (epic: mnemosyne-conversation-memory).
//
// Failing-first tests (TDD) for bin/mnemosyne-conversation-discover.mjs's
// own logic ONLY: argv parsing, the write:true-by-default contract (cm-02's
// own AC7 idempotent-recompute-from-scratch guarantee), --json output
// shape, --no-write, --help, and loud (non-silent) error surfacing.
// `discoverSources()` itself is ALWAYS a hand-written stub injected via
// `discover` -- never the real implementation, never this operator's real
// ~/.claude/projects/ tree or real export files. Mirrors bin/mnemosyne-
// conversation-pilot.test.mjs's own "every stage function is a spy, deps
// object" convention.
//
// Run: npx tsx --test bin/mnemosyne-conversation-discover.test.mjs

import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs, runDiscover } from "./mnemosyne-conversation-discover.mjs";

function fakeManifest(overrides = {}) {
  return {
    generatedAt: "2026-08-27T00:00:00.000Z",
    sessions: [
      { path: "/fixture/a.jsonl", projectDir: "-fixture-a", projectSlug: "/fixture/a", sizeBytes: 100, mtime: "2026-08-01T00:00:00.000Z", scratchConfidence: "confirmed" },
    ],
    excluded: [{ dir: "-private-tmp-x", reason: "matched scratch-filter exclude pattern" }],
    exports: {
      chatgpt: { path: "/fixture/chatgpt/conversations.json", status: "present" },
      gemini: { path: "/fixture/gemini/takeout.zip", status: "not_found" },
    },
    ...overrides,
  };
}

function makeSpyDiscover(manifest = fakeManifest(), { throwError = null } = {}) {
  const calls = [];
  const discover = (opts) => {
    calls.push(opts);
    if (throwError) throw throwError;
    return manifest;
  };
  discover.calls = calls;
  return discover;
}

function captureLog() {
  const lines = [];
  return { log: (s) => lines.push(s), lines };
}

// ---------------------------------------------------------------------------
// parseArgs()
// ---------------------------------------------------------------------------

test("parseArgs: defaults to json:false, write:true, help:false with no flags", () => {
  const args = parseArgs([]);
  assert.equal(args.json, false);
  assert.equal(args.write, true);
  assert.equal(args.help, false);
});

test("parseArgs: --json sets json:true", () => {
  assert.equal(parseArgs(["--json"]).json, true);
});

test("parseArgs: --no-write sets write:false", () => {
  assert.equal(parseArgs(["--no-write"]).write, false);
});

test("parseArgs: --help / -h sets help:true", () => {
  assert.equal(parseArgs(["--help"]).help, true);
  assert.equal(parseArgs(["-h"]).help, true);
});

// ---------------------------------------------------------------------------
// runDiscover() -- the write:true-by-default contract (cm-02's own AC7).
// ---------------------------------------------------------------------------

test("runDiscover: calls discover({ write: true }) by default -- fresh, never a stale cached read", () => {
  const discover = makeSpyDiscover();
  const { log } = captureLog();
  const result = runDiscover([], { discover, log });
  assert.equal(discover.calls.length, 1);
  assert.deepEqual(discover.calls[0], { write: true });
  assert.equal(result.ok, true);
});

test("runDiscover: --no-write calls discover({ write: false })", () => {
  const discover = makeSpyDiscover();
  const { log } = captureLog();
  runDiscover(["--no-write"], { discover, log });
  assert.deepEqual(discover.calls[0], { write: false });
});

test("runDiscover: every invocation calls discover() exactly once -- never a cached/skipped call", () => {
  const discover = makeSpyDiscover();
  const { log } = captureLog();
  runDiscover([], { discover, log });
  runDiscover([], { discover, log });
  assert.equal(discover.calls.length, 2, "two separate runDiscover() calls -> two separate discover() calls");
});

// ---------------------------------------------------------------------------
// --json output shape -- the machine-readable contract src/
// discoveryPilotRoutes.mjs (server-side) parses.
// ---------------------------------------------------------------------------

test("runDiscover: --json prints { ok: true, manifest } with the real manifest, unmodified", () => {
  const manifest = fakeManifest();
  const discover = makeSpyDiscover(manifest);
  const { log, lines } = captureLog();
  const result = runDiscover(["--json"], { discover, log });
  assert.equal(lines.length, 1, "exactly one JSON line printed");
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.manifest, manifest);
  assert.deepEqual(result.manifest, manifest);
});

test("runDiscover: without --json, prints a human-readable summary, not raw JSON", () => {
  const discover = makeSpyDiscover();
  const { log, lines } = captureLog();
  runDiscover([], { discover, log });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /session\(s\)/);
  assert.throws(() => JSON.parse(lines[0]), "human-readable line is not valid JSON");
});

// ---------------------------------------------------------------------------
// --help: never calls discover() at all.
// ---------------------------------------------------------------------------

test("runDiscover: --help prints usage and never calls discover()", () => {
  const discover = makeSpyDiscover();
  const { log, lines } = captureLog();
  const result = runDiscover(["--help"], { discover, log });
  assert.equal(discover.calls.length, 0, "discover() must never be called for --help");
  assert.equal(result.ok, true);
  assert.equal(result.help, true);
  assert.match(lines[0], /Usage:/);
});

// ---------------------------------------------------------------------------
// Loud failure: discover() throwing is surfaced, never silently swallowed.
// ---------------------------------------------------------------------------

test("runDiscover: a discover() throw is surfaced as ok:false with the real error message (non-JSON mode)", () => {
  const discover = makeSpyDiscover(undefined, { throwError: new Error("boom: fixture root unreadable") });
  const { log, lines } = captureLog();
  const result = runDiscover([], { discover, log });
  assert.equal(result.ok, false);
  assert.match(result.error, /boom: fixture root unreadable/);
  // Human-readable mode logs the error via console.error, not `log` -- the
  // injected `log` should have recorded nothing in this branch.
  assert.equal(lines.length, 0);
});

test("runDiscover: a discover() throw in --json mode prints { ok: false, error } to stdout, never a fabricated manifest", () => {
  const discover = makeSpyDiscover(undefined, { throwError: new Error("boom: fixture root unreadable") });
  const { log, lines } = captureLog();
  const result = runDiscover(["--json"], { discover, log });
  assert.equal(result.ok, false);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /boom: fixture root unreadable/);
  assert.equal("manifest" in parsed, false, "never a fabricated manifest alongside a real error");
});
