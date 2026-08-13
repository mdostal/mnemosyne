// engine.mjs — thin wrapper around the proven `swarm-memory` CLI (Qdrant SSOT).
//
// Mnemosyne does NOT own a store. It shells out to the already-working
// `swarm-memory` binary (--json) exactly like the Hermes MemoryProvider does,
// so recall/remember run over the live remote Qdrant Cloud corpus. This file is
// the only place that talks to the engine; the HTTP layer stays transport-only.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, mkdir, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

const execFileP = promisify(execFile);

// CLI binary — override with SWARM_MEMORY_BIN; otherwise resolve on PATH.
export const CLI = process.env.SWARM_MEMORY_BIN || "swarm-memory";

// Effective config.toml path — same resolution swarm-memory's own CLI uses
// (SWARM_MEMORY_CONFIG env override, else ~/.config/swarm-memory/config.toml;
// see swarm_memory/config.py's load_config()). Resolved fresh on every call
// (not cached at module load) so tests can point this at a throwaway fixture
// via process.env without ever touching the real file.
function defaultConfigPath() {
  return (
    process.env.SWARM_MEMORY_CONFIG ||
    path.join(homedir(), ".config", "swarm-memory", "config.toml")
  );
}

// Where `remember` writes note files before they are indexed. Append-only;
// the Qdrant collections themselves are never wiped or re-embedded wholesale.
const NOTES_DIR =
  process.env.MNEMOSYNE_NOTES_DIR ||
  path.join(homedir(), ".local", "share", "mnemosyne", "notes");

const CLI_TIMEOUT_MS = Number(process.env.MNEMOSYNE_CLI_TIMEOUT_MS || 90_000);

// A generous env so the child CLI finds uv-installed tools + the qdrant key.
// Built fresh on every call (not cached at module load) — same rationale as
// defaultConfigPath() above: tests set env vars like SWARM_MEMORY_CONFIG /
// SWARM_MEMORY_GRAPH_DB on process.env after this module is imported (via a
// throwaway fixture), and a stale snapshot would silently ignore them.
function childEnv() {
  return {
    ...process.env,
    PATH: `/opt/homebrew/bin:${homedir()}/.local/bin:${process.env.PATH || ""}`,
  };
}

async function run(args, { timeout = CLI_TIMEOUT_MS } = {}) {
  const { stdout, stderr } = await execFileP(CLI, args, {
    timeout,
    maxBuffer: 32 * 1024 * 1024,
    env: childEnv(),
  });
  return { stdout, stderr };
}

// Cache the effective config (from `swarm-memory config`) so `remember` can
// resolve which collection a scope writes to, and GET /config can expose the
// rest (qdrant_url, embedder) read-only without a second shell-out.
let _scopeMap = null;
export async function scopeMap() {
  if (_scopeMap) return _scopeMap;
  const { stdout } = await run(["config"]);
  const cfg = JSON.parse(stdout);
  _scopeMap = {
    qdrant_url: cfg.qdrant_url || null,
    embedder: cfg.embedder || null,
    scopes: cfg.scopes || {},
    ladder: cfg.ladder || {},
    default_scope: cfg.default_scope || "top",
    fallback_collection: cfg.fallback_collection || "claude_knowledge",
  };
  return _scopeMap;
}

// resetScopeMapCache — s-05's "Refresh config cache" action. Clears ONLY the
// in-memory _scopeMap cache above, so the next scopeMap() call (reached via
// GET /scopes, GET /config, or remember()'s scope->collection lookup)
// re-shells out to `swarm-memory config` and reads it fresh instead of
// serving the cached copy. This function itself does not call run() —
// spawns ZERO subprocesses, touches ZERO external state: not Qdrant, not
// config.toml (no read, no write), not graph.sqlite. This is the entire,
// deliberately narrow meaning of "clear"/"refresh" in this codebase — never
// confuse this with deleting or wiping anything. See
// s-05-reindex-controls.yaml and SERVICE.md's hard no-wipe guardrail.
export function resetScopeMapCache() {
  _scopeMap = null;
  return { cache_cleared: true };
}

// health — run the engine self-test (Qdrant + embedder + graph reachability).
export async function health() {
  try {
    const { stdout, stderr } = await run(["check"], { timeout: 30_000 });
    const text = stdout + stderr;
    const ok = /result:\s*PASS/i.test(text);
    return { ok, engine: "swarm-memory", detail: text.trim() };
  } catch (e) {
    return { ok: false, engine: "swarm-memory", error: String(e.message || e) };
  }
}

// scopes — the configured scopes + escalation ladders (the layer map).
export async function scopes() {
  const m = await scopeMap();
  return m;
}

// recall(query, scope, {hits, escalate, minScore}) — semantic recall with
// surrounding context + full provenance, straight from the engine's --json.
export async function recall(query, scope, opts = {}) {
  if (!query || !String(query).trim()) {
    const err = new Error("query is required");
    err.status = 400;
    throw err;
  }
  const args = ["recall", String(query), "--json", "--hits", String(opts.hits || 5)];
  if (scope) args.push("--scope", String(scope));
  if (opts.escalate) args.push("--escalate");
  if (opts.minScore != null) args.push("--min-score", String(opts.minScore));
  if (opts.radius != null) args.push("--radius", String(opts.radius));
  const { stdout } = await run(args);
  return JSON.parse(stdout);
}

// remember(text, scope, {tag}) — write-back. Persists the note to a file, then
// indexes (upserts, --no-prune) it into the scope's collection so it becomes
// immediately recallable. Additive only: never prunes other files' chunks.
export async function remember(text, scope, opts = {}) {
  if (!text || !String(text).trim()) {
    const err = new Error("text is required");
    err.status = 400;
    throw err;
  }
  const m = await scopeMap();
  const useScope = scope || "personal";
  const collection = m.scopes[useScope];
  if (!collection) {
    const err = new Error(
      `unknown scope '${useScope}'. known: ${Object.keys(m.scopes).join(", ")}`
    );
    err.status = 400;
    throw err;
  }
  await mkdir(NOTES_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const tag = (opts.tag || "note").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40);
  const file = path.join(NOTES_DIR, `${stamp}-${tag}.md`);
  const header = `<!-- remembered via Mnemosyne @ ${new Date().toISOString()} scope=${useScope} -->\n`;
  await writeFile(file, header + String(text) + "\n", "utf8");

  // Direct-mapped scope -> collection; index appends this one new file.
  const args = ["index", collection, "--no-prune", file];
  const { stdout, stderr } = await run(args);
  const out = (stdout + stderr).trim();
  const upserted = /upserted\s+(\d+)\s+chunks/i.exec(out);
  return {
    remembered: true,
    scope: useScope,
    collection,
    file,
    chunks_upserted: upserted ? Number(upserted[1]) : null,
    engine_output: out,
  };
}

// reindex(collection, paths) — s-05's general-purpose Reindex action, wrapping
// `swarm-memory index <collection> <paths...>`. This is DELIBERATELY the CLI's
// DEFAULT pruning behavior — --no-prune is NEVER passed here. That flag is
// reserved for remember()'s pure-additive single-note-file writes above (a
// freshly generated file has nothing to prune anyway). Default pruning, per
// swarm_memory/indexer.py's index_paths(): for each indexed path, after
// upserting its chunks, the CLI deletes points matching
// `full_path == <that exact file>` AND `chunk_index >= <its new chunk
// count>` — i.e. only the stale tail chunks of a file that shrank since its
// last index, scoped strictly to that one file's own full_path. It is never
// a collection-wide delete and never touches any file that wasn't passed in
// `paths`. This is refresh/cleanup, not a wipe.
//
// Requires an explicit, operator-selected collection (from the s-02 lanes
// list in the UI) and at least one path — no "reindex everything" / no
// wildcard / no-target mode is supported. Both are validated (400) before
// any subprocess is spawned.
export async function reindex(collection, paths) {
  if (!collection || !String(collection).trim()) {
    const err = new Error("collection is required");
    err.status = 400;
    throw err;
  }
  const pathList = Array.isArray(paths)
    ? paths.map((p) => String(p).trim()).filter(Boolean)
    : [];
  if (pathList.length === 0) {
    const err = new Error("at least one path is required");
    err.status = 400;
    throw err;
  }
  // Reindexing an operator-selected path set (potentially a whole directory)
  // can genuinely take a while against the live embedder + Qdrant Cloud —
  // give it a generous floor well above the default CLI_TIMEOUT_MS, which is
  // sized for single-call recall/remember/grep, not bulk indexing.
  const timeout = Math.max(CLI_TIMEOUT_MS, 10 * 60_000);
  const args = ["index", String(collection), ...pathList];
  const { stdout, stderr } = await run(args, { timeout });
  const out = (stdout + stderr).trim();
  // Matches cmd_index's real summary line (swarm_memory/cli.py):
  //   "✓ <collection>: N files indexed, M chunks upserted, F embed failures → T total points"
  const summary =
    /✓\s+\S+:\s+(\d+)\s+files indexed,\s+(\d+)\s+chunks upserted,\s+(\d+)\s+embed failures\s+→\s+([\d,]+)\s+total points/.exec(
      out
    );
  return {
    reindexed: true,
    collection: String(collection),
    paths: pathList,
    files_indexed: summary ? Number(summary[1]) : null,
    chunks_upserted: summary ? Number(summary[2]) : null,
    embed_failures: summary ? Number(summary[3]) : null,
    total_points: summary ? Number(summary[4].replace(/,/g, "")) : null,
    engine_output: out,
  };
}

// grep(query, scope, {hits, escalate, radius}) — KEYWORD scroll (no embedder).
// Deterministic exact-string matching — the reliable path for identifiers
// (ticket IDs, error codes, tokens) that semantic recall does not encode well.
export async function grep(query, scope, opts = {}) {
  if (!query || !String(query).trim()) {
    const err = new Error("query is required");
    err.status = 400;
    throw err;
  }
  const args = ["grep", String(query), "--json", "--hits", String(opts.hits || 5)];
  if (scope) args.push("--scope", String(scope));
  if (opts.escalate) args.push("--escalate");
  if (opts.radius != null) args.push("--radius", String(opts.radius));
  const { stdout } = await run(args);
  // grep --json returns a top-level array of {scope,collection,hits[]}.
  // Normalize to the recall shape ({total_hits, scopes[]}) so consumers merge cleanly.
  const scopesArr = JSON.parse(stdout);
  const total = scopesArr.reduce((n, s) => n + (s.hits ? s.hits.length : 0), 0);
  return { query: String(query), total_hits: total, scopes: scopesArr, match_mode: "keyword" };
}

// --- graph: READ-ONLY impact-graph exploration ------------------------------
//
// Wraps `swarm-memory graph {stats,edges,impact,deps}` — the graph's own
// query verbs. Deliberately does NOT wrap `graph add`/`graph remove` (the
// graph's mutation verbs): nothing in the design discussion calls for
// editing the graph from the UI, and doing so would be scope creep beyond
// what s-04 asked for. See s-04-graph-view.yaml's acceptance criteria.

// graphStats — graph size + origin breakdown. `graph stats` has no --json
// flag because its output is already bare JSON (confirmed via a live run:
// `{"nodes": 22, "edges": 30, "edges_by_origin": {...}, "db": "..."}`).
export async function graphStats() {
  const { stdout } = await run(["graph", "stats"]);
  return JSON.parse(stdout);
}

// graphEdges(node?) — list edges, or only those touching `node` when given.
// Each edge: {src, predicate, dst, origin, created_at}.
export async function graphEdges(node) {
  const args = ["graph", "edges"];
  if (node) args.push(String(node));
  args.push("--json");
  const { stdout } = await run(args);
  return JSON.parse(stdout);
}

function requireGraphNode(node, who) {
  if (!node || !String(node).trim()) {
    const err = new Error(`${who}: node is required`);
    err.status = 400;
    throw err;
  }
}

// graphImpact(node, {depth}) — reverse closure: what is affected if `node`
// changes. A node with no impact (or an unknown node) returns `[]` with a
// clean exit — confirmed live, not assumed — so this never throws for a
// merely-unknown node, only for a missing/blank one.
export async function graphImpact(node, opts = {}) {
  requireGraphNode(node, "graph impact");
  const args = ["graph", "impact", String(node), "--json"];
  if (opts.depth != null) args.push("--depth", String(opts.depth));
  const { stdout } = await run(args);
  return JSON.parse(stdout);
}

// graphDeps(node, {depth}) — forward closure: what `node` depends on. Same
// unknown-node-returns-[] behavior as graphImpact (confirmed live).
export async function graphDeps(node, opts = {}) {
  requireGraphNode(node, "graph deps");
  const args = ["graph", "deps", String(node), "--json"];
  if (opts.depth != null) args.push("--depth", String(opts.depth));
  const { stdout } = await run(args);
  return JSON.parse(stdout);
}

// --- addLane: the ONLY supported config.toml mutation ----------------------
//
// Adds a new [scopes]/[ladder] entry to swarm-memory's config.toml. Never
// removes or overwrites an existing entry, and never touches Qdrant — this is
// a local text-file edit only. Schema confirmed by reading the real
// ~/.config/swarm-memory/config.toml (read-only) and swarm_memory/config.py:
// [scopes] and [ladder] are flat tables (`name = "collection"` /
// `name = ["parent", ...]`), not `[scopes.<name>]` sub-tables.
//
// Atomic-write sequence (per s-02-lanes-browser):
//   1. Read the current config.toml.
//   2. Back it up to config.toml.bak (single generation — overwrites any
//      prior backup).
//   3. Textually insert the new entry/entries (surgical line insertion right
//      after the relevant table header — never touches existing lines).
//   4. Write the result to a temp file in the same directory.
//   5. Validate: run `swarm-memory --config <tmp> config` (the config
//      subcommand already emits JSON; it does not talk to Qdrant) and
//      confirm the new scope (and ladder, if given) round-trips exactly.
//   6. Only on success: rename the temp file over the original (atomic).
//      On ANY failure: delete the temp file and leave the original
//      byte-identical; throw a clear error.
const SCOPE_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const COLLECTION_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;

function tomlString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// Extracts the existing keys of a flat top-level TOML table by scanning raw
// text between `[tableName]` and the next `[...]` header (or EOF). This is a
// deliberately minimal text scan — not a full TOML parser — matched to the
// same surgical-insertion approach used for the write itself, so both read
// and write agree on where a table's boundaries are.
function tableKeys(text, tableName) {
  const headerRe = new RegExp(`^\\s*\\[${tableName}\\]\\s*$`);
  const anyHeaderRe = /^\s*\[/;
  const keys = [];
  let inTable = false;
  for (const line of text.split("\n")) {
    if (headerRe.test(line)) {
      inTable = true;
      continue;
    }
    if (inTable && anyHeaderRe.test(line)) break;
    if (inTable) {
      const m = /^\s*([A-Za-z0-9_.-]+)\s*=/.exec(line);
      if (m) keys.push(m[1]);
    }
  }
  return keys;
}

// Inserts a new line immediately after `[tableName]`'s header line — i.e.
// inside the table, before any of its existing entries. Existing lines are
// never modified or reordered.
function insertIntoTable(text, tableName, newLine) {
  const headerRe = new RegExp(`^\\s*\\[${tableName}\\]\\s*$`);
  const lines = text.split("\n");
  const idx = lines.findIndex((l) => headerRe.test(l));
  if (idx === -1) {
    const err = new Error(`config.toml has no [${tableName}] table — refusing to guess where to insert`);
    err.status = 500;
    throw err;
  }
  lines.splice(idx + 1, 0, newLine);
  return lines.join("\n");
}

export async function addLane(name, collection, ladder) {
  if (!name || !SCOPE_NAME_RE.test(String(name))) {
    const err = new Error(
      "invalid lane name: must start with a letter and contain only letters, digits, '-' or '_'"
    );
    err.status = 400;
    throw err;
  }
  if (!collection || !COLLECTION_NAME_RE.test(String(collection))) {
    const err = new Error(
      "invalid collection name: must start with a letter and contain only letters, digits, '-' or '_'"
    );
    err.status = 400;
    throw err;
  }
  let ladderArr;
  if (ladder != null) {
    if (!Array.isArray(ladder) || ladder.some((s) => !SCOPE_NAME_RE.test(String(s)))) {
      const err = new Error("ladder must be an array of valid scope names");
      err.status = 400;
      throw err;
    }
    ladderArr = ladder.map(String);
  }

  const configPath = defaultConfigPath();
  const original = await readFile(configPath, "utf8");

  // Duplicate check against the raw file itself (the source of truth for
  // this mutation) — not the in-process scopeMap() cache, which may be stale.
  const existingScopes = tableKeys(original, "scopes");
  if (existingScopes.includes(String(name))) {
    const err = new Error(`lane '${name}' already exists in config.toml — add-only, refusing to overwrite`);
    err.status = 409;
    throw err;
  }

  // Step 2: single-generation backup, overwriting any prior one.
  const backupPath = configPath + ".bak";
  await writeFile(backupPath, original, "utf8");

  // Step 3: surgical insertion.
  let mutated = insertIntoTable(original, "scopes", `${name} = ${tomlString(collection)}`);
  if (ladderArr && ladderArr.length) {
    const arr = `[${ladderArr.map((s) => tomlString(s)).join(", ")}]`;
    mutated = insertIntoTable(mutated, "ladder", `${name} = ${arr}`);
  }

  // Step 4: write to a temp file in the same directory (same filesystem, so
  // the final rename is atomic).
  const tmpPath = path.join(path.dirname(configPath), `.config.toml.tmp-${randomBytes(6).toString("hex")}`);
  await writeFile(tmpPath, mutated, "utf8");

  // Step 5: validate by pointing the real CLI at the temp file. `config`
  // already loads+dumps JSON with no Qdrant/network I/O.
  try {
    const { stdout } = await run(["--config", tmpPath, "config"], { timeout: 30_000 });
    const parsed = JSON.parse(stdout);
    if (!parsed.scopes || parsed.scopes[name] !== String(collection)) {
      throw new Error("new scope did not round-trip through `swarm-memory config`");
    }
    if (ladderArr && ladderArr.length) {
      const got = parsed.ladder && parsed.ladder[name];
      const matches = Array.isArray(got) && got.length === ladderArr.length && got.every((v, i) => v === ladderArr[i]);
      if (!matches) throw new Error("new ladder entry did not round-trip through `swarm-memory config`");
    }
  } catch (e) {
    // ANY validation failure: clean up the temp file, leave the original
    // untouched (it was never written to), surface a clear error.
    await unlink(tmpPath).catch(() => {});
    const detail = e && e.stderr ? String(e.stderr).trim().split("\n").pop() : e && e.message ? e.message : String(e);
    const err = new Error(`add-lane validation failed — config.toml left untouched: ${detail}`);
    err.status = 422;
    throw err;
  }

  // Step 6: atomic rename over the original, only after validation passed.
  await rename(tmpPath, configPath);

  // The new lane won't be visible via the in-process cache until it's
  // invalidated (recall/remember/GET /config/etc. all read through it).
  _scopeMap = null;

  return { added: true, name: String(name), collection: String(collection), ladder: ladderArr || null };
}
