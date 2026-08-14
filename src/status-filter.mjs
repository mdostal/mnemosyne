// status-filter.mjs — zero-dep JS mirror of lib/mnemosyne/status-filter.ts,
// for engine.mjs's recall() read path (la-05-recall-status-filtering, epic:
// mnemosyne-layer-architecture-v2). Same logic, duplicated rather than
// shared across the TS/JS boundary — this repo already duplicates the
// remember()/flight-status write-path logic this same way between
// engine.mjs and the lib/mnemosyne TS client (see flight-status.mjs's own
// doc comment), so this follows the same established precedent.
//
// Consumes la-04's write-path schema on the READ side: default recall is
// confirmed-only across branches — a `provisional` entry written on a
// DIFFERENT branch is excluded — except the caller's own current branch's
// `provisional` writes, which are always included. `superseded` entries are
// excluded from default recall the same way. Neither is ever truly hidden:
// both remain reachable via the explicit `includeCrossBranchProvisional`
// opt-in (review/debugging use cases), never the default.
//
// Entries with NO flight-status header at all (pre-la-04 legacy notes, or
// content from a layer with no git-context concept — file/grep matches,
// code-graph nodes) are never filtered — absence of status means "not
// flight-status-tracked", not "provisional and therefore suspect".
//
// How a hit's status is resolved: remember() writes an HTML-comment header
// as the first line of every note file it creates:
//   <!-- remembered via Mnemosyne @ <ts> scope=<scope> status=<status>
//        branch=<branch> commit=<sha> -->
// swarm-memory's --json recall output has no structured status/branch
// fields, so this module resolves a hit's flight status by reading that
// header line directly off the source file on disk (hit.full_path /
// hit.location / hit.source), the same file remember() wrote. A read
// failure (missing file, no header, unreadable path) is never fatal — it
// resolves to null ("not flight-status-tracked"), same as legacy data.

import { readFile } from "node:fs/promises";

const HEADER_RE = /status=(provisional|confirmed|superseded)\s+branch=(\S+)\s+commit=(\S+)/;

// Parses a single line of text for a flight-status header. Returns null
// (never throws, never guesses) for a line with no recognizable header —
// including a header-shaped line with an unrecognized status word, treated
// identically to "no header".
export function parseFlightHeaderLine(line) {
  const match = HEADER_RE.exec(line || "");
  if (!match) return null;
  return { status: match[1], branch: match[2], commit_sha: match[3] };
}

// Reads the flight-status header from a note file on disk, or null if the
// path is missing, unreadable, or has no header on its first line. Never
// throws — a single hit's unreadable source file must never fail the whole
// recall.
export async function readFlightHeader(filePath) {
  if (!filePath) return null;
  let contents;
  try {
    contents = await readFile(filePath, "utf8");
  } catch {
    return null;
  }
  const firstLine = contents.split("\n", 1)[0] || "";
  return parseFlightHeaderLine(firstLine);
}

// The core filtering decision for one entry — pure, synchronous. See this
// module's doc comment for the full rule table; mirrors
// lib/mnemosyne/status-filter.ts's isEntryVisible exactly.
export function isEntryVisible(header, { callerBranch = null, includeCrossBranchProvisional = false } = {}) {
  if (!header) return true;
  if (header.status === "confirmed") return true;
  if (includeCrossBranchProvisional) return true;
  if (header.status === "provisional") {
    return callerBranch != null && header.branch === callerBranch;
  }
  // status === "superseded" — terminal, never the caller's live work, and
  // never "ground truth" — excluded from default recall like a cross-branch
  // provisional entry, unless opted in above.
  return false;
}

function hitFilePath(hit) {
  return hit.full_path || hit.location || hit.source || null;
}

// Filters a swarm-memory-shaped hits array (engine.mjs's raw
// {text, score, source, full_path, provenance} shape) down to what default
// (or opted-in) recall should surface, resolving each hit's flight-status
// header from its source file. Order-preserving; never mutates the input.
export async function filterHitsByStatus(hits, options = {}) {
  const out = [];
  for (const hit of hits || []) {
    const header = await readFlightHeader(hitFilePath(hit));
    if (isEntryVisible(header, options)) {
      out.push(hit);
    }
  }
  return out;
}
