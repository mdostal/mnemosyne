// refs.mjs — resolvable recall pointers (PANT-838).
//
// A recall hit's `full_path` is a path on the Mnemosyne host (e.g.
// /root/.local/share/mnemosyne/notes/<stamp>-<tag>.md inside the service
// container). An agent running in a different container can't open it, which
// breaks the "open the file for full detail" pointer contract. Every hit
// therefore gets a host-independent `ref`:
//
//   mnemosyne://note/<source>          -> a note remember() wrote; fetch the
//                                          body via GET /note?source=<source>
//   repo:<scope>:<repo-relative-path>  -> a repo-indexed file; open the path
//                                          relative to your own checkout
//
// Hits with no file identity at all (code-graph edges) get no ref.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parseFlightHeaderLine } from "./status-filter.mjs";

export const NOTE_REF_PREFIX = "mnemosyne://note/";

// Resolved per call (not at module load) so tests can point it at a fixture.
export function notesDir() {
  return path.resolve(
    process.env.MNEMOSYNE_NOTES_DIR || path.join(homedir(), ".local", "share", "mnemosyne", "notes")
  );
}

// A note source is a bare file name remember() could have written: no
// directory separators, no "..", no NUL, no leading dot.
const NOTE_SOURCE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Returns the validated bare source name, or throws a 400. Accepts either the
// bare name or the full `mnemosyne://note/<source>` ref.
export function validateNoteSource(raw) {
  let source = String(raw ?? "").trim();
  if (source.startsWith(NOTE_REF_PREFIX)) source = source.slice(NOTE_REF_PREFIX.length);
  if (!source) throw httpError(400, "source is required");
  if (!NOTE_SOURCE_RE.test(source) || source.includes("..")) {
    throw httpError(400, `invalid note source '${raw}': must be a bare note file name (no path segments)`);
  }
  return source;
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// readNote(source, {chunk?, lines?}) -> the stored note text + provenance.
// Notes are small and swarm-memory owns chunking, so the whole note is
// returned; `lines=a-b` (1-based, inclusive — a hit's chunk_span) slices it,
// and `chunk` is echoed back so a caller can correlate it with the hit.
export async function readNote(rawSource, opts = {}) {
  const source = validateNoteSource(rawSource);
  const dir = notesDir();
  const file = path.resolve(dir, source);
  if (path.dirname(file) !== dir) {
    throw httpError(400, `invalid note source '${rawSource}': resolves outside the notes directory`);
  }
  let contents;
  try {
    contents = await readFile(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "EISDIR") throw httpError(404, `note '${source}' not found`);
    throw e;
  }

  const allLines = contents.split("\n");
  const header = parseFlightHeaderLine(allLines[0]);
  const headerMeta = /remembered via Mnemosyne @ (\S+) scope=(\S+)/.exec(allLines[0] || "");

  let text = contents;
  let lineSpan = null;
  if (opts.lines != null && opts.lines !== "") {
    const m = /^(\d+)-(\d+)$/.exec(String(opts.lines));
    if (!m) throw httpError(400, `invalid lines '${opts.lines}': expected <start>-<end>`);
    const start = Math.max(Number(m[1]), 1);
    const end = Math.max(Number(m[2]), start);
    text = allLines.slice(start - 1, end).join("\n");
    lineSpan = [start, end];
  }

  let chunk = null;
  if (opts.chunk != null && opts.chunk !== "") {
    chunk = Number(opts.chunk);
    if (!Number.isInteger(chunk) || chunk < 0) throw httpError(400, `invalid chunk '${opts.chunk}'`);
  }

  return {
    source,
    ref: NOTE_REF_PREFIX + source,
    chunk,
    lines: lineSpan,
    text,
    provenance: {
      remembered_at: headerMeta ? headerMeta[1] : null,
      scope: headerMeta ? headerMeta[2] : null,
      status: header ? header.status : null,
      branch: header ? header.branch : null,
      commit_sha: header ? header.commit_sha : null,
    },
  };
}

// --- ref derivation ---------------------------------------------------------

const repoRootCache = new Map();

// Nearest ancestor directory containing .git (dir or worktree file), or null.
function findRepoRoot(filePath) {
  let dir = path.dirname(filePath);
  const visited = [];
  while (true) {
    if (repoRootCache.has(dir)) {
      const root = repoRootCache.get(dir);
      for (const v of visited) repoRootCache.set(v, root);
      return root;
    }
    visited.push(dir);
    let found = false;
    try {
      found = existsSync(path.join(dir, ".git"));
    } catch {
      found = false;
    }
    if (found) {
      for (const v of visited) repoRootCache.set(v, dir);
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      for (const v of visited) repoRootCache.set(v, null);
      return null;
    }
    dir = parent;
  }
}

function isNotePath(p) {
  if (!p || !path.isAbsolute(p)) return false;
  const resolved = path.resolve(p);
  if (path.dirname(resolved) === notesDir()) return true;
  // The note may have been indexed on a host whose notes dir differs from
  // this process's (e.g. a moved MNEMOSYNE_NOTES_DIR); the default layout
  // still identifies it unambiguously.
  return /[\\/]mnemosyne[\\/]notes[\\/][^\\/]+$/.test(resolved);
}

function toPosix(p) {
  return p.split(path.sep).join("/");
}

// hitRef(hit, scope) -> ref string or null. Pure w.r.t. the hit (no mutation).
export function hitRef(hit, scope) {
  if (!hit) return null;
  const candidates = [hit.full_path, hit.location, hit.source].filter(
    (v) => typeof v === "string" && v.trim()
  );
  if (candidates.length === 0) return null;

  for (const c of candidates) {
    if (isNotePath(c)) return NOTE_REF_PREFIX + path.basename(c);
  }

  const useScope = scope || hit.scope || hit.layer || "unknown";
  // A relative path is already repo-relative.
  const relative = candidates.find((c) => !path.isAbsolute(c));
  const absolute = candidates.find((c) => path.isAbsolute(c));
  if (absolute) {
    const root = findRepoRoot(absolute);
    if (root) return `repo:${useScope}:${toPosix(path.relative(root, absolute))}`;
  }
  if (relative) {
    // Only file-ish values: code-graph hits carry labels like "edge".
    if (!/[./]/.test(relative)) return null;
    return `repo:${useScope}:${toPosix(path.normalize(relative)).replace(/^\.\//, "")}`;
  }
  // Absolute path outside any repo visible here: fall back to its base name,
  // which is still host-independent (never the absolute container path).
  return `repo:${useScope}:${path.basename(absolute)}`;
}

// Stamps `ref` onto every hit of a {scopes[].hits[]} result, in place.
// Idempotent: an existing ref is kept.
export function decorateRefs(result) {
  for (const s of Array.isArray(result?.scopes) ? result.scopes : []) {
    for (const h of Array.isArray(s.hits) ? s.hits : []) {
      if (h.ref) continue;
      const ref = hitRef(h, s.scope);
      if (ref) h.ref = ref;
    }
  }
  return result;
}

// Exposed for tests.
export function _resetRepoRootCache() {
  repoRootCache.clear();
}
