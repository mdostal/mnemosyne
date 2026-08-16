#!/usr/bin/env node
// bin/mnemosyne-skill-helper.mjs — s-06's harness layer: the small helper the
// `skills/mnemosyne-standalone` Claude Code skill invokes so a bare Claude
// Code session (no Pantheon host) can drive a standalone Mnemosyne instance.
//
// Two responsibilities, both deliberately thin:
//
//   1. ensureRunning() — GET /health on the configured PORT with a short
//      timeout; if the service is already healthy, return immediately and
//      spawn NOTHING (no second process, no second port bind attempt). If
//      it's not healthy/not running, spawn `bin/mnemosyne` detached
//      (matching SERVICE.md's documented supervised-run pattern: `nohup env
//      PORT=... node src/server.mjs > <logfile> 2>&1 &` — here achieved via
//      child_process spawn with detached:true + stdio redirected to the same
//      logfile, which is nohup's actual effect, just invoked without a shell
//      one-liner) and poll GET /health until it goes green, throwing a clear
//      error if it never comes up.
//
//   2. Action pass-throughs (recall/remember/grep/reindex/graph-*) — THIN
//      wrappers over Mnemosyne's own HTTP API (src/server.mjs). This file
//      NEVER imports src/engine.mjs and NEVER shells out to `swarm-memory`
//      directly — every action is a plain fetch() against the already
//      (or newly) running Mnemosyne service, so the existing transport/
//      engine split and every guardrail already enforced in engine.mjs
//      (loud failure, provenance, no-wipe) stays fully intact. See
//      SERVICE.md and the epic's design-discussion.md.
//
// CLI usage:
//   node bin/mnemosyne-skill-helper.mjs ensure
//   node bin/mnemosyne-skill-helper.mjs recall '{"query":"...","scope":"..."}'
//   node bin/mnemosyne-skill-helper.mjs remember '{"text":"...","scope":"..."}'
//   node bin/mnemosyne-skill-helper.mjs grep '{"query":"..."}'
//   node bin/mnemosyne-skill-helper.mjs reindex '{"collection":"...","paths":["..."]}'
//   node bin/mnemosyne-skill-helper.mjs graph-stats
//   node bin/mnemosyne-skill-helper.mjs graph-edges '{"node":"..."}'
//   node bin/mnemosyne-skill-helper.mjs graph-impact <node> '{"depth":2}'
//   node bin/mnemosyne-skill-helper.mjs graph-deps <node> '{"depth":2}'
//   node bin/mnemosyne-skill-helper.mjs persona-sync '{"repo":"...","tier":"...","scopeId":"...","dryRun":false}'
//   node bin/mnemosyne-skill-helper.mjs persona-seed '{"root":"...","scopeId":"..."}'
//   node bin/mnemosyne-skill-helper.mjs persona-show <tier> <scopeId>
//   node bin/mnemosyne-skill-helper.mjs persona-create '{"file":"...","repo":"...","root":"..."}'
//
// PORT env (default 8477) — same convention as src/server.mjs / SERVICE.md.
//
// persona-* actions (mnemosyne-persona-mcp-tools, extended by pw-06 for
// persona-create) are a deliberate SECOND exception to this file's "every
// action is a fetch() against the HTTP API" rule (the first being none --
// this is genuinely new). Layer 1 persona sync/seed/show/create
// (bin/mnemosyne-persona.mjs, bin/mnemosyne-persona-seed.mjs) has no HTTP
// route at all -- it operates directly against the filesystem (repo-local/
// global persona stores, harness files) via TS imports, which is why it's
// launched via tsx, not plain node (see bin/mnemosyne's dispatcher and
// bin/mnemosyne-persona.mjs's own doc comment for the noEmit:true/no-
// build-step constraint this works around). These four actions shell out to
// that already-tested CLI as a subprocess instead -- same "wrap an existing,
// separately-tested module, invent no new business logic here" principle
// this file already follows for graph_*, just via a subprocess boundary
// instead of fetch() because there is no HTTP surface to fetch().

import { execFile, spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const BIN_PATH = path.join(REPO_ROOT, "bin", "mnemosyne");
const TSX_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
const PERSONA_CLI_PATH = path.join(REPO_ROOT, "bin", "mnemosyne-persona.mjs");

export const DEFAULT_PORT = Number(process.env.PORT || 8477);
const DEFAULT_LOG_DIR = path.join(homedir(), ".local", "share", "mnemosyne");
const DEFAULT_LOG_FILE = path.join(DEFAULT_LOG_DIR, "mnemosyne.log");

function baseUrl(port) {
  return `http://127.0.0.1:${port}`;
}

export function uiUrl(port = DEFAULT_PORT) {
  return `${baseUrl(port)}/ui`;
}

// checkAlive — GET /healthz, the process-liveness alias: always 200 if the
// process is up, no CLI shell-out (see SERVICE.md). Used for the fast
// "is it already running" pre-spawn decision below — deliberately NOT
// checkHealth(), because /health now runs a live swarm-memory check() PLUS
// drift reconciliation and can legitimately take 30s+ against real
// Qdrant/embedder infra. A liveness probe waiting on that would frequently
// (and wrongly) conclude "not running" and spawn a duplicate instance.
export async function checkAlive(port = DEFAULT_PORT, { timeoutMs = 2000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl(port)}/healthz`, { signal: controller.signal });
    const body = await res.json().catch(() => ({}));
    return { ok: res.status === 200 && body.alive === true, status: res.status, body };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

// checkHealth — GET /health (deep engine check: Qdrant + embedder + graph +
// drift reconciliation). Can legitimately take 30s+ against real infra —
// default timeout sized accordingly. Never throws; resolves {ok:false, ...}
// on any network error/timeout/non-2xx/non-ok-body.
export async function checkHealth(port = DEFAULT_PORT, { timeoutMs = 40_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl(port)}/health`, { signal: controller.signal });
    const body = await res.json().catch(() => ({}));
    return { ok: res.status === 200 && body.ok === true, status: res.status, body };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

// ensureRunning — the story's health-check-before-start logic.
//
// - Already healthy on `port` -> returns immediately, spawns NOTHING
//   (acceptance criterion: "does NOT spawn a second instance").
// - Not healthy -> spawns `bin/mnemosyne` detached (PORT set on its env),
//   stdout/stderr appended to `logFile` (matching SERVICE.md's nohup+logfile
//   supervised-run pattern), unref'd so it survives this helper exiting, then
//   polls GET /health until it goes green or `startTimeoutMs` elapses (in
//   which case it throws a clear, non-swallowed error — see s-06's risk
//   note: a PORT-bind race must surface loudly, never be swallowed).
export async function ensureRunning({
  port = DEFAULT_PORT,
  spawnFn = spawn,
  logFile = DEFAULT_LOG_FILE,
  healthCheckTimeoutMs = 2000, // pre-spawn liveness probe (checkAlive / /healthz) — fast, no CLI shell-out
  deepHealthTimeoutMs = 40_000, // per-attempt deep health probe (checkHealth / /health) during the post-spawn poll
  startTimeoutMs = 90_000, // overall budget for the post-spawn poll loop — must exceed deepHealthTimeoutMs with margin for at least one full attempt plus retry room
  pollIntervalMs = 300,
} = {}) {
  const initial = await checkAlive(port, { timeoutMs: healthCheckTimeoutMs });
  if (initial.ok) {
    return { started: false, alreadyRunning: true, port, ui: uiUrl(port), health: initial };
  }

  await mkdir(path.dirname(logFile), { recursive: true });
  const logHandle = await open(logFile, "a");
  let child;
  try {
    child = spawnFn(BIN_PATH, [], {
      env: { ...process.env, PORT: String(port) },
      detached: true,
      stdio: ["ignore", logHandle.fd, logHandle.fd],
    });
    child.unref?.();
  } finally {
    await logHandle.close();
  }

  const start = Date.now();
  let last = initial;
  while (Date.now() - start < startTimeoutMs) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    last = await checkHealth(port, { timeoutMs: deepHealthTimeoutMs });
    if (last.ok) {
      return { started: true, alreadyRunning: false, port, ui: uiUrl(port), health: last, pid: child.pid };
    }
  }
  const err = new Error(
    `mnemosyne did not become healthy on port ${port} within ${startTimeoutMs}ms ` +
      `(see ${logFile} for the spawned process's own output). last health check: ${JSON.stringify(last)}`
  );
  err.health = last;
  err.pid = child.pid;
  throw err;
}

// --- action pass-throughs ----------------------------------------------
// Every function below does exactly one fetch() against Mnemosyne's own
// HTTP API and returns its JSON body UNCHANGED (same data shape the API
// returns directly) — no reformatting, no field-dropping, no new
// business logic, no CLI shell-out of any kind.

async function apiFetch(port, method, urlPath, body) {
  const res = await fetch(`${baseUrl(port)}${urlPath}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (res.status >= 400) {
    const err = new Error((data && data.error) || `${method} ${urlPath} -> ${res.status}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

// recallAction — thin pass-through to POST /recall.
export const recallAction = (port, { query, scope, hits, escalate, min_score, radius } = {}) =>
  apiFetch(port, "POST", "/recall", { query, scope, hits, escalate, min_score, radius });

// rememberAction — thin pass-through to POST /remember.
export const rememberAction = (port, { text, scope, tag } = {}) =>
  apiFetch(port, "POST", "/remember", { text, scope, tag });

// grepAction — thin pass-through to POST /grep.
export const grepAction = (port, { query, scope, hits, escalate, radius } = {}) =>
  apiFetch(port, "POST", "/grep", { query, scope, hits, escalate, radius });

// reindexAction — thin pass-through to POST /index.
export const reindexAction = (port, { collection, paths } = {}) =>
  apiFetch(port, "POST", "/index", { collection, paths });

// graphStatsAction — thin pass-through to GET /graph/stats.
export const graphStatsAction = (port) => apiFetch(port, "GET", "/graph/stats");

// graphEdgesAction — thin pass-through to GET /graph/edges[?node=].
export const graphEdgesAction = (port, { node } = {}) =>
  apiFetch(port, "GET", `/graph/edges${node ? `?node=${encodeURIComponent(node)}` : ""}`);

// graphImpactAction — thin pass-through to GET /graph/impact/:node[?depth=].
export const graphImpactAction = (port, node, { depth } = {}) =>
  apiFetch(port, "GET", `/graph/impact/${encodeURIComponent(node)}${depth != null ? `?depth=${depth}` : ""}`);

// graphDepsAction — thin pass-through to GET /graph/deps/:node[?depth=].
export const graphDepsAction = (port, node, { depth } = {}) =>
  apiFetch(port, "GET", `/graph/deps/${encodeURIComponent(node)}${depth != null ? `?depth=${depth}` : ""}`);

// --- persona-* actions: subprocess pass-throughs to bin/mnemosyne-persona.mjs
// (tsx-launched, see file header) instead of fetch() -- no HTTP route exists
// for Layer 1 persona sync/seed/show. `port` is accepted (unused) purely to
// keep every action function's call signature uniform for the dispatcher
// below; these three never touch the network.

async function personaCliRun(args) {
  try {
    const { stdout, stderr } = await execFileAsync(TSX_BIN, [PERSONA_CLI_PATH, ...args]);
    return { ok: true, output: stdout.trim(), stderr: stderr.trim() };
  } catch (e) {
    // bin/mnemosyne-persona.mjs's run() exits non-zero on a handled failure
    // (bad args, unknown tier, etc.) after warn()-ing a clear message to
    // stderr -- execFile throws on any non-zero exit, so that's surfaced
    // here as ok:false with the real stderr, not re-thrown as a transport
    // error the way a genuinely unexpected failure (e.g. tsx itself missing)
    // still would be (e.code === "ENOENT" has no e.stdout/e.stderr to read).
    if (e.stdout !== undefined || e.stderr !== undefined) {
      return { ok: false, output: (e.stdout || "").trim(), stderr: (e.stderr || "").trim() };
    }
    throw e;
  }
}

// personaSyncAction — writes resolved persona content into a repo's harness
// files (or, with dryRun, computes the would-be diff with zero writes).
export const personaSyncAction = (port, { repo, tier, scopeId, dryRun } = {}) =>
  personaCliRun([
    "sync",
    ...(repo !== undefined ? ["--repo", repo] : []),
    ...(tier !== undefined ? ["--tier", tier] : []),
    ...(scopeId !== undefined ? ["--scope-id", scopeId] : []),
    ...(dryRun ? ["--dry-run"] : []),
  ]);

// personaSeedAction — idempotently seeds the 3 global tiers from the
// hardcoded TIER_CONTENT into the global persona store.
export const personaSeedAction = (port, { root, scopeId } = {}) =>
  personaCliRun([
    "seed",
    ...(root !== undefined ? ["--root", root] : []),
    ...(scopeId !== undefined ? ["--scope-id", scopeId] : []),
  ]);

// personaShowAction — read-only, live fetch of a global-tier persona's real,
// current content. Positional (tier, scopeId), matching the CLI's own
// `persona show <tier> <scope-id>` shape, not a JSON-args object like the
// other persona actions -- mirrors graphImpactAction/graphDepsAction's
// (port, node, opts) shape for a single non-object positional argument.
export const personaShowAction = (port, tier, scopeId) => personaCliRun(["show", tier, scopeId]);

// personaCreateAction (pw-06) — writes a full persona candidate (parsed from
// --file's YAML) into either the global or repo-local persona store,
// matching pw-05's `persona create --file <path> [--repo <path>]
// [--root <path>]` CLI verb exactly. Pure subprocess pass-through, no new
// logic here -- same shape as personaSyncAction/personaSeedAction above.
export const personaCreateAction = (port, { file, repo, root } = {}) =>
  personaCliRun([
    "create",
    ...(file !== undefined ? ["--file", file] : []),
    ...(repo !== undefined ? ["--repo", repo] : []),
    ...(root !== undefined ? ["--root", root] : []),
  ]);

// --- CLI dispatcher -------------------------------------------------------

const SIMPLE_ACTIONS = {
  recall: (port, argJson) => recallAction(port, JSON.parse(argJson || "{}")),
  remember: (port, argJson) => rememberAction(port, JSON.parse(argJson || "{}")),
  grep: (port, argJson) => grepAction(port, JSON.parse(argJson || "{}")),
  reindex: (port, argJson) => reindexAction(port, JSON.parse(argJson || "{}")),
  "graph-stats": (port) => graphStatsAction(port),
  "graph-edges": (port, argJson) => graphEdgesAction(port, JSON.parse(argJson || "{}")),
  "graph-impact": (port, node, argJson) => graphImpactAction(port, node, JSON.parse(argJson || "{}")),
  "graph-deps": (port, node, argJson) => graphDepsAction(port, node, JSON.parse(argJson || "{}")),
  "persona-sync": (port, argJson) => personaSyncAction(port, JSON.parse(argJson || "{}")),
  "persona-seed": (port, argJson) => personaSeedAction(port, JSON.parse(argJson || "{}")),
  "persona-show": (port, tier, scopeId) => personaShowAction(port, tier, scopeId),
  "persona-create": (port, argJson) => personaCreateAction(port, JSON.parse(argJson || "{}")),
};
const KNOWN_ACTIONS = ["ensure", ...Object.keys(SIMPLE_ACTIONS)];

async function main() {
  const [, , action, ...rest] = process.argv;
  const port = DEFAULT_PORT;

  if (!action || !KNOWN_ACTIONS.includes(action)) {
    console.error(`usage: mnemosyne-skill-helper.mjs <${KNOWN_ACTIONS.join("|")}> [args...]`);
    process.exit(1);
  }

  try {
    // Every invocation ensures the service is up first — health-check,
    // start-if-needed, never a second instance if one is already healthy —
    // so a skill action "just works" from a cold Claude Code session.
    const readiness = await ensureRunning({ port });
    if (readiness.started) {
      console.error(`[mnemosyne-skill] started mnemosyne on port ${port} (pid ${readiness.pid})`);
    }
    console.error(`[mnemosyne-skill] mnemosyne ready — UI: ${readiness.ui}`);

    const result = action === "ensure" ? readiness : await SIMPLE_ACTIONS[action](port, ...rest);
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error(`[mnemosyne-skill] error: ${e.message}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
