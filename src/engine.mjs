// engine.mjs — thin wrapper around the proven `swarm-memory` CLI (Qdrant SSOT).
//
// Mnemosyne does NOT own a store. It shells out to the already-working
// `swarm-memory` binary (--json) exactly like the Hermes MemoryProvider does,
// so recall/remember run over the live remote Qdrant Cloud corpus. This file is
// the only place that talks to the engine; the HTTP layer stays transport-only.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const execFileP = promisify(execFile);

// CLI binary — override with SWARM_MEMORY_BIN; otherwise resolve on PATH.
export const CLI = process.env.SWARM_MEMORY_BIN || "swarm-memory";

// Where `remember` writes note files before they are indexed. Append-only;
// the Qdrant collections themselves are never wiped or re-embedded wholesale.
const NOTES_DIR =
  process.env.MNEMOSYNE_NOTES_DIR ||
  path.join(homedir(), ".local", "share", "mnemosyne", "notes");

const CLI_TIMEOUT_MS = Number(process.env.MNEMOSYNE_CLI_TIMEOUT_MS || 90_000);

// A generous env so the child CLI finds uv-installed tools + the qdrant key.
const CHILD_ENV = {
  ...process.env,
  PATH: `/opt/homebrew/bin:${homedir()}/.local/bin:${process.env.PATH || ""}`,
};

async function run(args, { timeout = CLI_TIMEOUT_MS } = {}) {
  const { stdout, stderr } = await execFileP(CLI, args, {
    timeout,
    maxBuffer: 32 * 1024 * 1024,
    env: CHILD_ENV,
  });
  return { stdout, stderr };
}

// Cache the scope -> collection map (from `swarm-memory config`) so `remember`
// can resolve which collection a scope writes to.
let _scopeMap = null;
export async function scopeMap() {
  if (_scopeMap) return _scopeMap;
  const { stdout } = await run(["config"]);
  const cfg = JSON.parse(stdout);
  _scopeMap = {
    scopes: cfg.scopes || {},
    ladder: cfg.ladder || {},
    default_scope: cfg.default_scope || "top",
    fallback_collection: cfg.fallback_collection || "claude_knowledge",
  };
  return _scopeMap;
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
  
  let vectorResult;
  let vectorError = null;
  try {
    const { stdout } = await run(args);
    vectorResult = JSON.parse(stdout);
    
    // Decorate provenance
    if (vectorResult.scopes) {
      for (const s of vectorResult.scopes) {
        if (s.hits) {
          for (const h of s.hits) {
            h.provenance = h.provenance || {};
            h.provenance.layer = "vector";
          }
        }
      }
    }
  } catch (e) {
    vectorError = e;
    console.error(`[mnemosyne] ERROR recall: vector layer unavailable: ${e.message}`);
    vectorResult = { total_hits: 0, scopes: [] };
  }

  // Escalation: vector -> file fallback on zero hits or error
  if (vectorResult.total_hits === 0 || vectorError) {
    if (!vectorError) {
      console.log(`[mnemosyne] vector layer returned 0 hits for "${query}", falling back to file layer (grep)...`);
    } else {
      console.log(`[mnemosyne] escalating to file layer due to vector layer failure...`);
    }
    
    try {
      const fileResult = await grep(query, scope, opts);
      fileResult.layers_attempted = ["vector", "file"];
      
      // Degraded marker if vector failed completely
      if (vectorError) {
        if (fileResult.scopes) {
          for (const s of fileResult.scopes) {
            if (s.hits) {
              for (const h of s.hits) {
                h.provenance = h.provenance || {};
                h.provenance.degraded = true;
              }
            }
          }
        }
      }
      return fileResult;
    } catch (fallbackErr) {
      console.error(`[mnemosyne] ERROR recall: file layer fallback also failed: ${fallbackErr.message}`);
      if (vectorError) throw vectorError; // throw original if both failed
    }
  }

  vectorResult.layers_attempted = ["vector"];
  return vectorResult;
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

  // Direct-mapped scope -> collection; index appends this one new file. The
  // file above is already on disk and is kept regardless of what happens
  // next — it is the recovery artifact for manual reconciliation if the
  // Qdrant upsert below diverges from it.
  const args = ["index", collection, "--no-prune", file];
  let out;
  try {
    const { stdout, stderr } = await run(args);
    out = (stdout + stderr).trim();
  } catch (e) {
    const detail = `${e.stdout || ""}${e.stderr || ""}`.trim() || e.message;
    console.error(
      `[mnemosyne] ERROR remember: swarm-memory index failed for scope=${useScope} file=${file}: ${detail}`
    );
    const err = new Error(
      `write-through failed: index command errored, file kept at ${file} for recovery: ${detail}`
    );
    err.status = 500;
    err.file = file;
    throw err;
  }

  const upserted = /upserted\s+(\d+)\s+chunks/i.exec(out);
  const chunksUpserted = upserted ? Number(upserted[1]) : 0;
  if (!(chunksUpserted > 0)) {
    console.error(
      `[mnemosyne] ERROR remember: swarm-memory index reported no upserted chunks for scope=${useScope} file=${file}: ${out || "(empty output)"}`
    );
    const err = new Error(
      `write-through failed: Qdrant upsert did not confirm chunks_upserted, file kept at ${file} for recovery: ${out || "(empty output)"}`
    );
    err.status = 500;
    err.file = file;
    throw err;
  }

  return {
    remembered: true,
    scope: useScope,
    collection,
    file,
    chunks_upserted: chunksUpserted,
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
  
  // Decorate provenance
  for (const s of scopesArr) {
    if (s.hits) {
      for (const h of s.hits) {
        h.provenance = h.provenance || {};
        h.provenance.layer = "file";
      }
    }
  }
  
  const total = scopesArr.reduce((n, s) => n + (s.hits ? s.hits.length : 0), 0);
  return { query: String(query), total_hits: total, scopes: scopesArr, match_mode: "keyword" };
}

// reindex — bulk (re)index files into Qdrant, for initial index builds or
// recovering a stale index. Extensions + ignored directories to scan.
const REINDEX_EXTENSIONS = new Set([".ts", ".md", ".yaml", ".yml"]);
const REINDEX_IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", "coverage"]);

async function* walkReindexable(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!REINDEX_IGNORED_DIRECTORIES.has(entry.name)) {
        yield* walkReindexable(entryPath);
      }
      continue;
    }
    if (entry.isFile() && REINDEX_EXTENSIONS.has(path.extname(entry.name))) {
      yield entryPath;
    }
  }
}

// reindex(scope, {directory}) — scans `directory` (default cwd) for
// .ts/.md/.yaml(.yml) files and indexes each one into the scope's Qdrant
// collection, one file at a time (mirrors `remember`'s file-by-file
// contract) so a single bad file does not abort the whole run. Indexing is
// append-only and idempotent (swarm-memory upserts/dedupes by content), so a
// reindex is always safe to retry in full after a partial failure — no
// resume bookkeeping needed. Per-file failures are collected and returned,
// never silently dropped.
export async function reindex(scope, opts = {}) {
  const m = await scopeMap();
  const useScope = scope || m.default_scope;
  const collection = m.scopes[useScope];
  if (!collection) {
    const err = new Error(
      `unknown scope '${useScope}'. known: ${Object.keys(m.scopes).join(", ")}`
    );
    err.status = 400;
    throw err;
  }

  const directory = opts.directory || process.cwd();
  const files = [];
  for await (const file of walkReindexable(directory)) {
    files.push(file);
  }

  const errors = [];
  let filesIndexed = 0;
  for (const file of files) {
    try {
      await run(["index", collection, file]);
      filesIndexed += 1;
    } catch (e) {
      const detail = `${e.stdout || ""}${e.stderr || ""}`.trim() || e.message;
      console.error(
        `[mnemosyne] ERROR reindex: swarm-memory index failed for scope=${useScope} file=${file}: ${detail}`
      );
      errors.push({ file, error: detail });
    }
  }

  return {
    scope: useScope,
    collection,
    directory,
    files_scanned: files.length,
    files_indexed: filesIndexed,
    errors,
  };
}
