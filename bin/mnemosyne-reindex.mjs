#!/usr/bin/env node
// mnemosyne-reindex — CLI wrapper around POST /reindex on a running
// Mnemosyne service. Invoked as `mnemosyne reindex <scope>` via bin/mnemosyne.
//
// Usage: mnemosyne reindex <scope> [--dir <path>] [--url <base-url>]
//
//   <scope>      required — which scope's collection to bulk-index
//   --dir PATH   directory to scan (default: service's cwd)
//   --url URL    Mnemosyne base URL (default: $MNEMOSYNE_URL or http://127.0.0.1:8477)

import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_URL = process.env.MNEMOSYNE_URL || "http://127.0.0.1:8477";

export function parseArgs(argv) {
  const args = { scope: undefined, directory: undefined, url: DEFAULT_URL };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir") args.directory = argv[++i];
    else if (a === "--url") args.url = argv[++i];
    else positional.push(a);
  }
  args.scope = positional[0];
  return args;
}

export async function run(argv, { log = console.log, warn = console.error } = {}) {
  const args = parseArgs(argv);
  if (!args.scope) {
    warn("mnemosyne reindex: missing <scope> argument");
    warn("usage: mnemosyne reindex <scope> [--dir <path>] [--url <base-url>]");
    return { ok: false };
  }

  let res;
  try {
    res = await fetch(`${args.url}/reindex`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: args.scope, directory: args.directory }),
    });
  } catch (e) {
    warn(`mnemosyne reindex: could not reach ${args.url} (${e.message}). Is the service running?`);
    return { ok: false };
  }

  const body = await res.json();
  if (!res.ok) {
    warn(`mnemosyne reindex: ${res.status} ${body.error || JSON.stringify(body)}`);
    return { ok: false, body };
  }

  log(JSON.stringify(body, null, 2));
  return { ok: true, body };
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const { ok } = await run(process.argv.slice(2));
  process.exit(ok ? 0 : 1);
}
