/**
 * Recall-side flight-status filtering (la-05-recall-status-filtering, epic:
 * mnemosyne-layer-architecture-v2).
 *
 * Consumes la-04's write-path schema (`flight-status.ts`'s `status` +
 * `source_ref`) on the READ side: default recall must be confirmed-only
 * across repos/branches/agents, so an agent on a different branch never
 * inherits another branch's unmerged (`provisional`) memory as if it were
 * confirmed ground truth (docs/layer-architecture-v2-plan.md §2). The one
 * exception is the caller's OWN current branch: an agent should still see
 * its own in-flight provisional work. A `superseded` entry ("we tried this,
 * it didn't land" — never deleted, see `flight-status.ts`) is excluded from
 * default recall the same way, but neither status is ever truly hidden —
 * both remain reachable via the explicit `includeCrossBranchProvisional`
 * opt-in (review/debugging use cases).
 *
 * Entries with NO flight-status header at all — pre-la-04 legacy notes, or
 * content from a layer that never had a git-context concept (file/grep
 * matches, code-graph nodes) — are never filtered. This is a deliberate,
 * explicit design decision (not a gap): absence of status means "not
 * flight-status-tracked", not "provisional and therefore suspect".
 *
 * How a hit's status is resolved: `remember()` (both `src/engine.mjs` and
 * `VectorLayerAdapter.remember()`) writes an HTML-comment header as the
 * first line of every note file it creates, e.g.
 *   `<!-- remembered via Mnemosyne @ <ts> scope=<scope> status=<status>
 *      branch=<branch> commit=<sha> -->`
 * There is no separate structured metadata channel for this today (the
 * `swarm-memory` CLI's `--json` recall output has no status/branch fields —
 * see VectorLayerAdapter.ts's `SwarmMemoryHit`), so this module resolves a
 * hit's flight status by reading that header line directly off the source
 * file on disk (`hit.provenance.source`), the same file `remember()` wrote.
 * A read failure (missing file, no header line, unreadable path) is never
 * fatal here — it resolves to `null`, i.e. "not flight-status-tracked",
 * consistent with the legacy-data handling above.
 */
import { readFile } from 'node:fs/promises';
import type { Hit, Status } from './interfaces.js';

/** The parsed flight-status header of a note file, or what a hit's status resolves to. */
export interface FlightHeader {
  status: Status;
  branch: string;
  commit_sha: string;
}

// Matches the exact header suffix both write paths emit (see this file's
// top-of-module doc comment). Deliberately anchored on the literal
// `status=`/`branch=`/`commit=` key names rather than parsing the whole
// header generically — this is a fixed, internally-controlled format, not
// user input to be parsed loosely.
const HEADER_RE = /status=(provisional|confirmed|superseded)\s+branch=(\S+)\s+commit=(\S+)/;

/**
 * Parses a single line of text for a flight-status header. Returns `null`
 * (never throws, never guesses) when the line has no recognizable header —
 * including a header-shaped line with an unrecognized status word, which is
 * treated identically to "no header" rather than assumed to mean anything.
 */
export function parseFlightHeaderLine(line: string): FlightHeader | null {
  const match = HEADER_RE.exec(line);
  if (!match) return null;
  return { status: match[1] as Status, branch: match[2]!, commit_sha: match[3]! };
}

/**
 * Reads the flight-status header from a note file on disk, or `null` if the
 * path is missing, unreadable, or has no header on its first line. Never
 * throws — a recall-time filtering concern must never fail the recall
 * itself over a single hit's unreadable source file.
 */
export async function readFlightHeader(filePath: string | null | undefined): Promise<FlightHeader | null> {
  if (!filePath) return null;
  let contents: string;
  try {
    contents = await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  const firstLine = contents.split('\n', 1)[0] ?? '';
  return parseFlightHeaderLine(firstLine);
}

export interface StatusFilterOptions {
  /** The recalling caller's own current git branch, if known. `null`/omitted when it could not be resolved. */
  callerBranch?: string | null;
  /** Explicit opt-in (off by default): surface cross-branch `provisional`/`superseded` entries too, for review/debugging use cases. */
  includeCrossBranchProvisional?: boolean;
}

/**
 * The core filtering decision for one entry. Pure, synchronous, and the
 * primary unit-tested surface of this module — `filterHitsByStatus` below is
 * a thin fs-integration wrapper around this.
 *
 *   - no header (legacy/non-tracked)      -> always visible
 *   - status=confirmed                    -> always visible
 *   - includeCrossBranchProvisional: true -> always visible (explicit opt-in wins)
 *   - status=provisional, same branch     -> visible (the caller's own in-flight work)
 *   - status=provisional, different/unknown branch -> hidden
 *   - status=superseded                   -> hidden by default (only the opt-in above surfaces it)
 */
export function isEntryVisible(header: FlightHeader | null, options: StatusFilterOptions = {}): boolean {
  if (!header) return true;
  if (header.status === 'confirmed') return true;
  if (options.includeCrossBranchProvisional) return true;
  if (header.status === 'provisional') {
    return options.callerBranch != null && header.branch === options.callerBranch;
  }
  // status === 'superseded' — never "ground truth" and never the caller's
  // live work (it's terminal), so it's excluded from default recall the
  // same as a cross-branch provisional entry, unless opted in above.
  return false;
}

/**
 * Filters a `Hit[]` array down to what default (or opted-in) recall should
 * actually surface, resolving each hit's flight-status header from its
 * `provenance.source` file. Order-preserving; never mutates the input hits.
 */
export async function filterHitsByStatus<T extends Pick<Hit, 'provenance'>>(
  hits: readonly T[],
  options: StatusFilterOptions = {},
): Promise<T[]> {
  const out: T[] = [];
  for (const hit of hits) {
    const header = await readFlightHeader(hit.provenance?.source);
    if (isEntryVisible(header, options)) {
      out.push(hit);
    }
  }
  return out;
}
