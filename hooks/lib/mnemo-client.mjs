// mnemo-client.mjs — how the hooks talk to the memory god.
//
// Primary path: the Mnemosyne HTTP service (src/server.mjs, default :8477),
// which wraps the swarm-memory engine over the remote Qdrant SSOT.
// Fallback path: if the service is unreachable, shell out to the same
// `swarm-memory` CLI directly — same engine, same corpus. This keeps the
// agent loop resilient: a memory miss or a down service NEVER breaks a ticket.
//
// Zero third-party deps (Node built-ins only), matching the repo philosophy.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const execFileP = promisify(execFile);

export const MNEMOSYNE_URL =
  process.env.MNEMOSYNE_URL || "http://127.0.0.1:8477";
const CLI = process.env.SWARM_MEMORY_BIN || "swarm-memory";
const HTTP_TIMEOUT_MS = Number(process.env.MNEMOSYNE_HTTP_TIMEOUT_MS || 20_000);
const CLI_TIMEOUT_MS = Number(process.env.MNEMOSYNE_CLI_TIMEOUT_MS || 90_000);
const NOTES_DIR =
  process.env.MNEMOSYNE_NOTES_DIR ||
  path.join(homedir(), ".local", "share", "mnemosyne", "notes");

const CHILD_ENV = {
  ...process.env,
  PATH: `/opt/homebrew/bin:${homedir()}/.local/bin:${process.env.PATH || ""}`,
};

async function httpJson(method, route, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(MNEMOSYNE_URL + route, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const json = await res.json();
    if (!res.ok) {
      const e = new Error(json.error || `HTTP ${res.status}`);
      e.status = res.status;
      throw e;
    }
    return json;
  } finally {
    clearTimeout(t);
  }
}

async function cli(args, { timeout = CLI_TIMEOUT_MS } = {}) {
  const { stdout, stderr } = await execFileP(CLI, args, {
    timeout,
    maxBuffer: 32 * 1024 * 1024,
    env: CHILD_ENV,
  });
  return { stdout, stderr };
}

// --- recall ------------------------------------------------------------------
// Returns the engine's native --json recall shape (total_hits, scopes[].hits[]).
// `via` tells the caller which path served it (service|cli|none).
export async function recall(query, scope, opts = {}) {
  const payload = {
    query,
    scope,
    hits: opts.hits || 5,
    escalate: !!opts.escalate,
  };
  if (opts.minScore != null) payload.min_score = opts.minScore;
  if (opts.radius != null) payload.radius = opts.radius;

  // 1) service
  try {
    const r = await httpJson("POST", "/recall", payload);
    return { ...r, via: "service" };
  } catch (serviceErr) {
    // 2) direct CLI fallback (same engine)
    try {
      const args = ["recall", String(query), "--json", "--hits", String(payload.hits)];
      if (scope) args.push("--scope", String(scope));
      if (opts.escalate) args.push("--escalate");
      if (opts.minScore != null) args.push("--min-score", String(opts.minScore));
      if (opts.radius != null) args.push("--radius", String(opts.radius));
      const { stdout } = await cli(args);
      return { ...JSON.parse(stdout), via: "cli", service_error: String(serviceErr.message || serviceErr) };
    } catch (cliErr) {
      return {
        total_hits: 0,
        scopes: [],
        via: "none",
        service_error: String(serviceErr.message || serviceErr),
        cli_error: String(cliErr.message || cliErr),
      };
    }
  }
}

// --- remember ----------------------------------------------------------------
// Write-back. Service path is preferred (POST /remember). CLI fallback writes a
// note file then indexes it (--no-prune, additive) — never wipes the corpus.
export async function remember(text, scope, opts = {}) {
  const tag = opts.tag || "note";
  // 1) service
  try {
    const r = await httpJson("POST", "/remember", { text, scope, tag });
    return { ...r, via: "service" };
  } catch (serviceErr) {
    // 2) direct CLI fallback
    try {
      const cfgRaw = (await cli(["config"])).stdout;
      const cfg = JSON.parse(cfgRaw);
      const useScope = scope || "personal";
      const collection = (cfg.scopes || {})[useScope];
      if (!collection) throw new Error(`unknown scope '${useScope}'`);
      await mkdir(NOTES_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const safeTag = String(tag).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40);
      const file = path.join(NOTES_DIR, `${stamp}-${safeTag}.md`);
      const header = `<!-- remembered via Mnemosyne hook @ ${new Date().toISOString()} scope=${useScope} -->\n`;
      await writeFile(file, header + String(text) + "\n", "utf8");
      const { stdout, stderr } = await cli(["index", collection, "--no-prune", file]);
      const out = (stdout + stderr).trim();
      const upserted = /upserted\s+(\d+)\s+chunks/i.exec(out);
      return {
        remembered: true,
        scope: useScope,
        collection,
        file,
        chunks_upserted: upserted ? Number(upserted[1]) : null,
        via: "cli",
        service_error: String(serviceErr.message || serviceErr),
      };
    } catch (cliErr) {
      return {
        remembered: false,
        via: "none",
        service_error: String(serviceErr.message || serviceErr),
        cli_error: String(cliErr.message || cliErr),
      };
    }
  }
}
