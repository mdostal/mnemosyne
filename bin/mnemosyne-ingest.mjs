#!/usr/bin/env node
// mnemosyne-ingest — CLI wrapper around POST /ingest on the running
// MnemosyneClient HTTP API (lib/mnemosyne/server.ts, default port 3141).
//
// ro-10-document-ingestion-primitive (epic: mnemosyne-repo-onboarding).
// Mirrors bin/mnemosyne-reindex.mjs's thin-HTTP-client shape (parse argv,
// fetch, print the JSON body, exit non-zero on failure) -- but targets a
// DIFFERENT service/port than reindex: ingestDocument()
// (lib/mnemosyne/ingest/ingestDocument.ts) is built on MnemosyneClient
// (client.ts), not the swarm-memory engine reindex.mjs's POST /reindex
// (src/server.mjs, :8477) talks to -- so this verb's default URL/env var
// intentionally differ (MNEMOSYNE_CLIENT_API_URL / :3141, the same port
// bin/mnemosyne-client-api starts). This file does not auto-start that
// service (same posture as reindex.mjs toward its own target) -- an
// unreachable client API fails loudly with a clear "is it running" hint,
// never a silent no-op.
//
// Invoked as `mnemosyne ingest ...` via bin/mnemosyne.
//
// Usage:
//   mnemosyne ingest --file <path> [--scope <scope>] [--tag <tag>] [--url <base-url>]
//   mnemosyne ingest --text <text> [--filename <name>] [--scope <scope>] [--tag <tag>] [--url <base-url>]
//
//   --file PATH      read content from this local .txt/.md file (filename defaults to its basename)
//   --text TEXT      inline content (a free-text description/CV, no file at all)
//   --filename NAME  optional filename hint when using --text (must be .txt/.md if given)
//   --scope SCOPE    scope to write into (defaults to 'project')
//   --tag TAG        optional tag carried into each chunk's metadata
//   --url URL        MnemosyneClient HTTP API base URL (default: $MNEMOSYNE_CLIENT_API_URL or http://127.0.0.1:3141)

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_URL = process.env.MNEMOSYNE_CLIENT_API_URL || "http://127.0.0.1:3141";

export function parseArgs(argv) {
  const args = {
    file: undefined,
    text: undefined,
    filename: undefined,
    scope: undefined,
    tag: undefined,
    url: DEFAULT_URL,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file") args.file = argv[++i];
    else if (a === "--text") args.text = argv[++i];
    else if (a === "--filename") args.filename = argv[++i];
    else if (a === "--scope") args.scope = argv[++i];
    else if (a === "--tag") args.tag = argv[++i];
    else if (a === "--url") args.url = argv[++i];
  }
  return args;
}

export async function run(argv, { log = console.log, warn = console.error } = {}) {
  const args = parseArgs(argv);

  if (!args.file && args.text === undefined) {
    warn("mnemosyne ingest: one of --file <path> or --text <text> is required");
    warn("usage: mnemosyne ingest --file <path> [--scope <scope>] [--tag <tag>] [--url <base-url>]");
    warn("       mnemosyne ingest --text <text> [--filename <name>] [--scope <scope>] [--tag <tag>] [--url <base-url>]");
    return { ok: false };
  }
  if (args.file && args.text !== undefined) {
    warn("mnemosyne ingest: pass only one of --file or --text, not both");
    return { ok: false };
  }

  let content;
  let filename = args.filename;
  if (args.file) {
    try {
      content = await readFile(args.file, "utf8");
    } catch (e) {
      warn(`mnemosyne ingest: could not read ${args.file} (${e.message})`);
      return { ok: false };
    }
    filename = filename || path.basename(args.file);
  } else {
    content = args.text;
  }

  let res;
  try {
    res = await fetch(`${args.url}/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, filename, tag: args.tag, scope: args.scope }),
    });
  } catch (e) {
    warn(
      `mnemosyne ingest: could not reach ${args.url} (${e.message}). Is the MnemosyneClient HTTP API running (bin/mnemosyne-client-api)?`,
    );
    return { ok: false };
  }

  const body = await res.json();
  if (!res.ok) {
    warn(`mnemosyne ingest: ${res.status} ${(body.error && body.error.message) || JSON.stringify(body)}`);
    return { ok: false, body };
  }

  log(JSON.stringify(body, null, 2));
  // A well-formed request always gets HTTP 200 here (POST /ingest mirrors
  // POST /recall and POST /remember's convention of carrying its own
  // discriminated ok/error inside a 200 body) -- the CLI's own exit code
  // still reflects ingestDocument()'s real ok:false (oversized/unsupported-
  // format/partial-failure), not just the HTTP status.
  return { ok: body.ok !== false, body };
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const { ok } = await run(process.argv.slice(2));
  process.exit(ok ? 0 : 1);
}
