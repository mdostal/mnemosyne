#!/usr/bin/env node
// mnemosyne-crawl — CLI wrapper around POST /crawl on the running
// MnemosyneClient HTTP API (lib/mnemosyne/server.ts, default port 3141).
//
// ro-11-bounded-website-crawl (epic: mnemosyne-repo-onboarding). Mirrors
// bin/mnemosyne-ingest.mjs's thin-HTTP-client shape (parse argv, fetch,
// print the JSON body, exit non-zero on failure) exactly -- same target
// service/port as ingest.mjs (crawlAndIngest() is built on MnemosyneClient
// via ro-10's ingestDocument(), not the swarm-memory engine reindex.mjs
// talks to). This file does not auto-start that service (same posture as
// ingest.mjs/reindex.mjs toward their own targets) -- an unreachable client
// API fails loudly with a clear "is it running" hint, never a silent no-op.
//
// This CLI is a thin transport wrapper ONLY -- no fetch/SSRF-guard/
// robots.txt/extraction logic lives here; see
// lib/mnemosyne/ingest/crawlAndIngest.ts's own doc comment for the real
// safety-bound contract (firm, default-on SSRF guard with no bypass
// anywhere in that module; robots.txt always checked before any fetch;
// single-page default, never following a link unless --max-pages opts into
// bounded, hard-capped, rate-limited same-domain multi-page crawling).
//
// Invoked as `mnemosyne crawl ...` via bin/mnemosyne.
//
// Usage:
//   mnemosyne crawl <url> [--scope <scope>] [--tag <tag>] [--max-pages <n>] [--timeout-ms <ms>] [--url-api <base-url>]
//
//   <url>              the page to crawl (http/https only)
//   --scope SCOPE      scope to write into (defaults to 'project')
//   --tag TAG          optional tag carried into each chunk's metadata
//   --max-pages N      opts into same-domain multi-page crawling (omit for the single-page default); hard-capped regardless of N
//   --timeout-ms MS    per-request timeout override
//   --url-api URL      MnemosyneClient HTTP API base URL (default: $MNEMOSYNE_CLIENT_API_URL or http://127.0.0.1:3141)

import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_URL = process.env.MNEMOSYNE_CLIENT_API_URL || "http://127.0.0.1:3141";

export function parseArgs(argv) {
  const args = {
    target: undefined,
    scope: undefined,
    tag: undefined,
    maxPages: undefined,
    timeoutMs: undefined,
    url: DEFAULT_URL,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--scope") args.scope = argv[++i];
    else if (a === "--tag") args.tag = argv[++i];
    else if (a === "--max-pages") args.maxPages = Number(argv[++i]);
    else if (a === "--timeout-ms") args.timeoutMs = Number(argv[++i]);
    else if (a === "--url-api") args.url = argv[++i];
    else if (!a.startsWith("--") && args.target === undefined) args.target = a;
  }
  return args;
}

export async function run(argv, { log = console.log, warn = console.error } = {}) {
  const args = parseArgs(argv);

  if (!args.target) {
    warn("mnemosyne crawl: a URL is required");
    warn("usage: mnemosyne crawl <url> [--scope <scope>] [--tag <tag>] [--max-pages <n>] [--timeout-ms <ms>] [--url-api <base-url>]");
    return { ok: false };
  }

  const multiPage = args.maxPages !== undefined ? { maxPages: args.maxPages } : undefined;

  let res;
  try {
    res = await fetch(`${args.url}/crawl`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: args.target,
        scope: args.scope,
        tag: args.tag,
        multiPage,
        timeoutMs: args.timeoutMs,
      }),
    });
  } catch (e) {
    warn(
      `mnemosyne crawl: could not reach ${args.url} (${e.message}). Is the MnemosyneClient HTTP API running (bin/mnemosyne-client-api)?`,
    );
    return { ok: false };
  }

  const body = await res.json();
  if (!res.ok) {
    warn(`mnemosyne crawl: ${res.status} ${(body.error && body.error.message) || JSON.stringify(body)}`);
    return { ok: false, body };
  }

  log(JSON.stringify(body, null, 2));
  // A well-formed request always gets HTTP 200 here (POST /crawl mirrors
  // POST /ingest's convention of carrying its own discriminated ok/error
  // inside a 200 body) -- the CLI's own exit code still reflects
  // crawlAndIngest()'s real ok:false (SSRF-blocked/robots-disallowed/
  // oversized/auth-failed/timeout/etc.), not just the HTTP status.
  return { ok: body.ok !== false, body };
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const { ok } = await run(process.argv.slice(2));
  process.exit(ok ? 0 : 1);
}
