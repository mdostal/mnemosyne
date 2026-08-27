#!/usr/bin/env node
// bin/mnemosyne-conversation-discover.mjs — cm-15-discovery-and-pilot-
// trigger-ui (epic: mnemosyne-conversation-memory).
//
// A new, small, tsx-launched CLI wrapping cm-02's real, unmodified
// discoverSources() (lib/mnemosyne/conversation-memory/discoverSources.ts)
// with a --json output flag. This file introduces ZERO new discovery
// logic of its own -- it is purely an argv/stdout adapter, mirroring
// bin/mnemosyne-onboard.mjs's own established "small tsx-launched wrapper
// around otherwise-TS-only logic" precedent, because src/server.mjs (plain
// `node`, no tsx) cannot import discoverSources.ts directly (bin/mnemosyne's
// own dispatcher launches it as plain `exec node "$HERE/src/server.mjs"`;
// bin/graphify-bridge.mjs's own doc comment names the identical constraint
// for its sibling zero-dep bin).
//
// Exists so src/server.mjs's new POST /conversation-memory/sources/scan
// route (src/discoveryPilotRoutes.mjs) can execFile() this CLI and shape
// its JSON stdout into an HTTP response -- the SAME "thin HTTP wrapper
// shells out to a CLI" architecture engine.mjs already establishes for
// every existing route in that file.
//
// Usage:
//   mnemosyne-conversation-discover [--json] [--no-write]
//
// Default behavior (no flags) calls discoverSources({ write: true }) --
// this IS cm-02's own AC7 idempotent-recompute-from-scratch contract: a
// FRESH scan every invocation, never a stale cached read, persisting
// ~/.mnemosyne/conversation-sources.yaml as a real side effect (this is
// the operator's own "crawl" button, design-discussion.md §12.2). --json
// prints a machine-readable `{ ok, manifest }` object instead of a
// human-readable summary line -- the mode src/discoveryPilotRoutes.mjs
// always uses. --no-write computes the manifest in-memory only (a dry-run
// preview), never persisting -- provided for completeness/manual use, not
// used by src/server.mjs's own route.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverSources } from "../lib/mnemosyne/conversation-memory/discoverSources.ts";

export function parseArgs(argv) {
  const args = { json: false, write: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--no-write") args.write = false;
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

const USAGE = `Usage:
  mnemosyne-conversation-discover [--json] [--no-write]

Runs cm-02's discoverSources() fresh every invocation (write: true by
default -- persists ~/.mnemosyne/conversation-sources.yaml, matching cm-02's
own AC7 idempotent-recompute-from-scratch contract) and prints the
resulting manifest (sessions[]/excluded[]/exports). --no-write computes the
manifest in-memory only (dry-run preview), never persisting. --json prints
a machine-readable { ok, manifest } object.`;

/**
 * `discover` is injectable purely for testability (mirrors bin/mnemosyne-
 * onboard.mjs's own `{ exec = execFileAsync }` DI convention) -- tests pass
 * a hand-written fake instead of the real discoverSources(), so they never
 * touch this operator's real ~/.claude/projects/ tree or real export files.
 */
export function runDiscover(argv, { discover = discoverSources, log = console.log } = {}) {
  const args = parseArgs(argv);

  if (args.help) {
    log(USAGE);
    return { ok: true, help: true };
  }

  let manifest;
  try {
    manifest = discover({ write: args.write });
  } catch (err) {
    const message = (err && err.message) || String(err);
    if (args.json) {
      log(JSON.stringify({ ok: false, error: message }, null, 2));
    } else {
      console.error(`mnemosyne-conversation-discover: ${message}`);
    }
    return { ok: false, error: message };
  }

  if (args.json) {
    log(JSON.stringify({ ok: true, manifest }, null, 2));
  } else {
    log(
      `mnemosyne-conversation-discover: ${manifest.sessions.length} session(s), ` +
        `${manifest.excluded.length} excluded dir(s), chatgpt: ${manifest.exports.chatgpt.status}, ` +
        `gemini: ${manifest.exports.gemini.status}`,
    );
  }
  return { ok: true, manifest };
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const result = runDiscover(process.argv.slice(2));
  process.exit(result.ok ? 0 : 1);
}
