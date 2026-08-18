// crawl-context.mjs — pu-07-bounded-crawl-context.
//
// Replaces SKILL.md's old step 2 prose ("load whatever's already known --
// TIER_CONTENT, an existing persona, any other already-known material handy
// in the conversation") with an explicit, NAMED, CAPPED crawl step
// (design-discussion.md §3c; horizontal-plan.md H6.1). Direct operator
// mandate, quoted verbatim in design-discussion.md §0 ask 2: "give it a way
// to crawl and help build a short, reasonable context on there without
// overdoing it." The named list + the caps below are what makes "without
// overdoing it" a real, testable constraint rather than a per-run judgment
// call.
//
// Mirrors interview-engine.mjs's pure-function, dependency-light style as
// closely as a step that necessarily does real I/O can: no import from
// lib/mnemosyne/layer1/persona.ts, no import from
// persona-store-global.ts/persona-store-repo-local.ts. The only way this
// module ever learns anything about a parent persona is by spawning the
// real `mnemosyne persona show <tier> <scopeId>` CLI subprocess (the same
// precedent persona-writer.mjs's `showPersonaViaCli` already established)
// and reading ONLY the two summary lines that subprocess's own
// `formatPersonaShow` (bin/mnemosyne-persona.mjs) always prints first
// (`displayName:` / `scope:`) -- never the `## <heading>` sections content
// that follows. This is the crawl step's own "query up, never copy down"
// boundary, deliberately matching persona.ts's `buildParentContextSections`
// guarantee rather than introducing a second, looser copy-down path.
//
// THE NAMED SOURCE LIST (fixed -- never grows implicitly, never a directory
// scan/glob/"whatever seems relevant" judgment call):
//   1. Repo README        -- README_CANDIDATES, first match wins.
//   2. Package/project manifest -- MANIFEST_CANDIDATES, first match wins.
//   3. CLAUDE.md, if present.
//   4. AGENTS.md, if present.
//   5. The applicable parent persona's own summary (displayName + scope
//      ONLY), when the caller supplies a `parentRef` -- via a real
//      `mnemosyne persona show` CLI subprocess, never that parent's full
//      `sections` content.
// Nothing outside this fixed list is ever read.
//
// THE CAPS (design-discussion.md §3c, "without overdoing it"):
//   - MAX_LINES_PER_SOURCE: at most this many lines are read from the TOP of
//     any one file source.
//   - MAX_CHARS_PER_SOURCE: a hard character ceiling applied to each
//     source's excerpt AFTER the line cap -- guards against a handful of
//     pathologically long lines defeating the line cap.
//   - MAX_SOURCE_SUMMARY_CHARS: a hard ceiling on the assembled
//     `sourceSummary` string as a whole, applied last.
// Every cap is enforced in code below (capExcerpt / assembleSourceSummary),
// not merely documented -- see this module's paired test file's
// oversized-README case for the real, running proof.

import { existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const PERSONA_CLI = path.join(REPO_ROOT, 'bin', 'mnemosyne-persona.mjs');

/** Cap 1/3 — at most this many lines are read from the top of any one file source. */
export const MAX_LINES_PER_SOURCE = 40;
/** Cap 2/3 — a hard character ceiling per source's excerpt, applied after the line cap. */
export const MAX_CHARS_PER_SOURCE = 1200;
/** Cap 3/3 — a hard ceiling on the assembled sourceSummary string as a whole. */
export const MAX_SOURCE_SUMMARY_CHARS = 4000;

/** Named source #1 — repo README. First match wins; the rest are never checked. */
export const README_CANDIDATES = ['README.md', 'README', 'readme.md'];
/** Named source #2 — package/project manifest. First match wins; the rest are never checked. */
export const MANIFEST_CANDIDATES = ['package.json', 'pyproject.toml', 'Cargo.toml'];
/** Named sources #3 and #4 — both checked independently ("if present" each, not first-match). */
export const AGENT_FILE_CANDIDATES = ['CLAUDE.md', 'AGENTS.md'];

const TRUNCATION_MARKER = ' …[capped]';

/**
 * Applies both file-level caps (MAX_LINES_PER_SOURCE, then
 * MAX_CHARS_PER_SOURCE) to one source's raw text. Deterministic and pure —
 * no I/O — so it is independently testable from the file-reading/CLI-calling
 * code around it.
 */
export function capExcerpt(raw) {
  const lines = String(raw).split(/\r?\n/);
  const truncatedByLines = lines.length > MAX_LINES_PER_SOURCE;
  let excerpt = lines.slice(0, MAX_LINES_PER_SOURCE).join('\n');

  const truncatedByChars = excerpt.length > MAX_CHARS_PER_SOURCE;
  if (truncatedByChars) {
    excerpt = excerpt.slice(0, MAX_CHARS_PER_SOURCE);
  }

  const truncated = truncatedByLines || truncatedByChars;
  return { excerpt: truncated ? excerpt + TRUNCATION_MARKER : excerpt, truncated };
}

/** Reads the first candidate filename that exists under `repoRoot` — never any other file. */
function readNamedSource(repoRoot, name) {
  const p = path.join(repoRoot, name);
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, 'utf8');
    return { name, path: p, ...capExcerpt(raw) };
  } catch {
    return null;
  }
}

/** Tries each candidate in order under `repoRoot`; returns the first hit, or null if none exist. */
function readFirstMatch(repoRoot, candidates) {
  for (const name of candidates) {
    const found = readNamedSource(repoRoot, name);
    if (found) return found;
  }
  return null;
}

/**
 * Reads the parent persona's own high-level summary ONLY — `displayName` +
 * `scope` — via a real `mnemosyne persona show <tier> <scopeId>` CLI
 * subprocess (persona-writer.mjs's `showPersonaViaCli` precedent). Never the
 * parent's `sections` content: `mnemosyne persona show`'s own plain-text
 * rendering (`formatPersonaShow`, bin/mnemosyne-persona.mjs) always prints
 * `displayName:`/`scope:` first, then a blank line, then `## <heading>`
 * sections — this function parses only the two summary lines and discards
 * everything from the blank line onward, so there is no code path here
 * through which the parent's real section bodies could leak in. Matches
 * persona.ts's `buildParentContextSections` "query up, never copy down"
 * boundary exactly, without importing persona-store-global.ts/
 * persona-store-repo-local.ts or persona.ts itself.
 *
 * Non-blocking: returns null (never throws) when the parent tier/scopeId is
 * missing, malformed, or the CLI reports no such persona on disk yet.
 */
export async function readParentPersonaSummary(parentRef, { home } = {}) {
  if (!parentRef || typeof parentRef.tier !== 'string' || typeof parentRef.scopeId !== 'string') {
    return null;
  }
  const { tier, scopeId } = parentRef;
  if (tier.trim() === '' || scopeId.trim() === '') return null;

  const env = { ...process.env };
  if (home) env.HOME = home;

  let stdout;
  try {
    const result = await execFileAsync(process.execPath, [TSX_BIN, PERSONA_CLI, 'show', tier, scopeId], {
      cwd: REPO_ROOT,
      env,
    });
    stdout = result.stdout;
  } catch {
    return null; // non-blocking hard-fail: no such parent persona yet, or CLI unavailable
  }

  const displayNameMatch = stdout.match(/^displayName:\s*(.*)$/m);
  const scopeMatch = stdout.match(/^scope:\s*(.*)$/m);
  if (!displayNameMatch && !scopeMatch) return null;

  const summaryText =
    `Parent persona (${tier}/${scopeId}) — displayName: ` +
    `${displayNameMatch ? displayNameMatch[1].trim() : '(unknown)'}; scope: ` +
    `${scopeMatch ? scopeMatch[1].trim() : '(unknown)'}.`;

  return { name: `parent persona summary (${tier}/${scopeId})`, ...capExcerpt(summaryText) };
}

/**
 * Assembles the final `sourceSummary` string from whatever sources were
 * actually read, applying MAX_SOURCE_SUMMARY_CHARS as a last, whole-string
 * cap. Always returns a valid, non-empty string — even with zero sources —
 * matching this skill's existing non-blocking hard-fail philosophy
 * (pw-10/pw-12), extended here to the crawl step.
 */
function assembleSourceSummary(sourcesRead, sourcesMissing) {
  if (sourcesRead.length === 0) {
    return (
      'Bounded crawl found none of the named sources present ' +
      `(checked: ${sourcesMissing.join(', ')}). No repo/manifest/agent-file/parent-persona context available ` +
      'for this interview — proceeding with questions alone.'
    );
  }

  const parts = sourcesRead.map((s) => `## ${s.name}\n${s.excerpt}`);
  let summary = parts.join('\n\n');
  if (summary.length > MAX_SOURCE_SUMMARY_CHARS) {
    summary = summary.slice(0, MAX_SOURCE_SUMMARY_CHARS) + TRUNCATION_MARKER;
  }
  return summary;
}

/**
 * The bounded crawl itself (design-discussion.md §3c; pu-07). Reads AT MOST
 * the fixed named source list above, in order, and never reads anything
 * outside it — no directory scan, no glob, no "whatever seems relevant"
 * judgment call. `repoRoot` is required (the crawl always has a concrete
 * repo to look at, even for a global-tier interview run ahead of any
 * project-specific repo — callers pass whatever repo context is applicable,
 * e.g. the mnemosyne repo itself, or omit sources by pointing at an empty
 * scratch directory). `parentRef` (optional) — `{tier, scopeId}` — is the
 * applicable parent persona to query up to, i.e. the same shape
 * interview-engine.mjs's `runPersonaInterview()` derives from an answered
 * "parent" question; omit when the persona being interviewed has no parent.
 * `home` (optional) — `$HOME` override for the parent-summary CLI
 * subprocess, mirrors persona-writer.mjs's own `home` option (test
 * isolation, or an operator whose global persona store isn't under the real
 * `~/.mnemosyne`).
 *
 * Returns `{ sourceSummary, sourcesRead, sourcesMissing }`:
 *   - `sourceSummary` — always a valid, capped, non-empty string.
 *   - `sourcesRead` — names of the sources actually found and included.
 *   - `sourcesMissing` — names of named sources that were checked but not
 *     found (or, for the parent, not named / not resolvable) — useful for
 *     the skill's own step-9 summary report, never itself an error.
 */
/**
 * Default ceiling on how many explicit file paths a single
 * crawlExplicitFiles() call will process (design-discussion.md OQ2 —
 * roughly 2x pu-07's own 5-source fixed list, since an explicit list is
 * operator/agent-directed rather than auto-selected, warranting some
 * headroom, but never silently unbounded). Callers that genuinely need more
 * pass an explicit `maxFiles` override; the cap is always real and enforced
 * — see TooManyExplicitFilesError below.
 */
export const MAX_EXPLICIT_FILES = 10;

/**
 * Thrown by crawlExplicitFiles() when more than `maxFiles` (default
 * MAX_EXPLICIT_FILES) file paths are supplied — a real, enforced ceiling,
 * never a silent first-N truncation and never silent unbounded processing
 * (pf-01-crawl-explicit-files.yaml acceptance criteria).
 */
export class TooManyExplicitFilesError extends Error {
  constructor(count, max) {
    super(
      `crawlExplicitFiles: ${count} file path(s) were supplied, exceeding the maximum of ${max}. ` +
        'Reduce the list, or pass an explicit maxFiles override if this call genuinely needs more.',
    );
    this.name = 'TooManyExplicitFilesError';
    this.count = count;
    this.max = max;
  }
}

/**
 * Reads one explicit, caller-supplied file path — resolved against
 * `repoRoot` unless already absolute. Never throws: returns null (added to
 * `sourcesMissing` by the caller) when the path does not exist or cannot be
 * read, matching crawlBoundedContext()'s own non-blocking hard-fail
 * philosophy for its named sources, extended here to an explicit list.
 */
function readExplicitSource(repoRoot, filePath) {
  const resolved = path.isAbsolute(filePath) ? filePath : path.join(repoRoot, filePath);
  if (!existsSync(resolved)) return null;
  try {
    const raw = readFileSync(resolved, 'utf8');
    return { name: filePath, path: resolved, ...capExcerpt(raw) };
  } catch {
    return null;
  }
}

/**
 * crawlExplicitFiles() — pf-01-crawl-explicit-files. A genuinely separate
 * sibling to crawlBoundedContext() (design-discussion.md §1 Direction 1),
 * not a parameterized rewrite of it: crawlBoundedContext() itself gets zero
 * changes. Lets an operator or agent supply an explicit list of file paths
 * as source material for a proposed persona draft, instead of pu-07's fixed
 * 5-source auto-crawl list.
 *
 * Reuses capExcerpt() (per-file line/char caps), assembleSourceSummary()
 * (whole-summary cap + assembly), and readParentPersonaSummary() (the SAME
 * real `mnemosyne persona show` CLI-subprocess mechanism
 * crawlBoundedContext() already uses for parent summaries — never a second,
 * looser parent-read implementation) completely unchanged, directly from
 * this module's own scope. Same caps apply uniformly regardless of which
 * crawl function produced the sourceSummary.
 *
 * `filePaths` — an array of caller-supplied paths (relative to `repoRoot`,
 * or absolute). More than `maxFiles` (default MAX_EXPLICIT_FILES) throws
 * TooManyExplicitFilesError — a real, enforced ceiling, never a silent
 * first-N truncation and never silent unbounded processing. A path that
 * does not exist or cannot be read is treated as missing (non-blocking),
 * matching crawlBoundedContext()'s own philosophy for its named sources —
 * it never blocks the whole crawl.
 *
 * `repoRoot`, `parentRef`, `home` — same meaning as crawlBoundedContext().
 *
 * Returns `{ sourceSummary, sourcesRead }` — the same shape
 * crawlBoundedContext() returns (design-discussion.md §1 Direction 1).
 */
export async function crawlExplicitFiles({ filePaths, repoRoot, parentRef, home, maxFiles = MAX_EXPLICIT_FILES } = {}) {
  if (!Array.isArray(filePaths)) {
    throw new Error("crawlExplicitFiles: 'filePaths' is required — an array of caller-supplied file paths to crawl.");
  }
  if (typeof repoRoot !== 'string' || repoRoot.trim() === '') {
    throw new Error("crawlExplicitFiles: 'repoRoot' is required — explicit relative file paths are resolved against it.");
  }
  if (filePaths.length > maxFiles) {
    throw new TooManyExplicitFilesError(filePaths.length, maxFiles);
  }

  const sourcesRead = [];
  const sourcesMissing = [];

  for (const filePath of filePaths) {
    const found = readExplicitSource(repoRoot, filePath);
    if (found) sourcesRead.push(found);
    else sourcesMissing.push(filePath);
  }

  if (parentRef && typeof parentRef.tier === 'string' && typeof parentRef.scopeId === 'string') {
    const parentSummary = await readParentPersonaSummary(parentRef, { home });
    if (parentSummary) {
      sourcesRead.push(parentSummary);
    } else {
      sourcesMissing.push(`parent persona summary (${parentRef.tier}/${parentRef.scopeId})`);
    }
  } else {
    sourcesMissing.push('parent persona summary (none named)');
  }

  const sourceSummary = assembleSourceSummary(sourcesRead, sourcesMissing);
  return {
    sourceSummary,
    sourcesRead: sourcesRead.map((s) => s.name),
  };
}

export async function crawlBoundedContext({ repoRoot, parentRef, home } = {}) {
  if (typeof repoRoot !== 'string' || repoRoot.trim() === '') {
    throw new Error("crawlBoundedContext: 'repoRoot' is required — the repo this bounded crawl reads against.");
  }

  const sourcesRead = [];
  const sourcesMissing = [];

  const readme = readFirstMatch(repoRoot, README_CANDIDATES);
  if (readme) sourcesRead.push(readme);
  else sourcesMissing.push('README');

  const manifest = readFirstMatch(repoRoot, MANIFEST_CANDIDATES);
  if (manifest) sourcesRead.push(manifest);
  else sourcesMissing.push('package/project manifest');

  for (const name of AGENT_FILE_CANDIDATES) {
    const found = readNamedSource(repoRoot, name);
    if (found) sourcesRead.push(found);
    else sourcesMissing.push(name);
  }

  if (parentRef && typeof parentRef.tier === 'string' && typeof parentRef.scopeId === 'string') {
    const parentSummary = await readParentPersonaSummary(parentRef, { home });
    if (parentSummary) {
      sourcesRead.push(parentSummary);
    } else {
      sourcesMissing.push(`parent persona summary (${parentRef.tier}/${parentRef.scopeId})`);
    }
  } else {
    sourcesMissing.push('parent persona summary (none named)');
  }

  const sourceSummary = assembleSourceSummary(sourcesRead, sourcesMissing);
  return {
    sourceSummary,
    sourcesRead: sourcesRead.map((s) => s.name),
    sourcesMissing,
  };
}
