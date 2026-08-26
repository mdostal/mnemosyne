/**
 * cm-02-conversation-source-discovery (epic: mnemosyne-conversation-memory).
 *
 * Enumerates real conversation sources without the operator manually
 * pointing at each one (docs/design-discussion.md §2.4, research-brief.md
 * §1). Two source kinds, both confirmed real during this epic's planning
 * pass, never assumed:
 *
 *  1. `~/.claude/projects/<slug>/<session-id>.jsonl` — walked and filtered
 *     using the SAME scratch heuristic already used during this epic's own
 *     research (`grep -vE '^-private-tmp|^-private-var-folders|scratchpad'`),
 *     refined with one additional real signal: a project-slug that decodes
 *     to a path outside any operator-confirmed project root (`Code/`,
 *     `Documents/work/`) is a WEAK signal, surfaced for confirmation, never
 *     a hard silent exclude.
 *  2. A fixed, named list of confirmed export files — the ChatGPT export
 *     (`~/Downloads/ChatGPT Data Export Feb 5 2026/conversations.json`) and
 *     the Gemini Takeout export (`~/Downloads/Google Takeout Aug 26
 *     2026.zip`, design-discussion.md §10.1) — NEVER a generic
 *     Downloads-directory scan (research confirmed the same directory also
 *     holds an OpenAI Export.zip, LinkedIn export, Drive export, and Photos
 *     export bundles; a generic scan would false-positive on all of them).
 *
 * ---------------------------------------------------------------------------
 * HARD CONSTRAINT — read-only over filesystem METADATA only, no exceptions.
 * ---------------------------------------------------------------------------
 * This module never opens or reads the CONTENT of any `.jsonl` session file
 * or any export file. Only `readdirSync` (directory listings), `statSync`
 * (size/mtime), and `existsSync` (presence checks) are used to inspect
 * source files — never `readFileSync`, `createReadStream`, `readFile`, or
 * `open`/`openSync` against a source path. The only content-bearing write
 * this module performs is the MANIFEST file itself (a NEW file this module
 * owns, not a source it is reading). This is the first line of defense the
 * rest of this epic's own privacy/safety discipline builds on (docs/
 * design-discussion.md §5, cross_cutting: conversation-privacy-safety) —
 * enforced structurally here, verified by `discoverSources.test.ts`'s own
 * fs-spy assertions, never merely asserted in prose.
 *
 * The Gemini export's `staged (takeout, 2 conversations)` status string is
 * a FIXED, hard-coded fact confirmed during this epic's planning research
 * (design-discussion.md §10.1, via a file-listing-only `unzip -l`
 * inspection performed during planning, not by this module at runtime) —
 * this module never opens the zip to compute it, preserving the same
 * metadata-only discipline even though listing zip *entries* would still
 * technically not be "content."
 *
 * Directory-name-to-path decoding is inherently lossy (Claude Code
 * slugifies `/` AND `.` in an absolute path to `-`, so a directory name
 * that already contains a literal `-` cannot be told apart from an encoded
 * separator). `decodeProjectSlug` is a best-effort heuristic on top of an
 * already-heuristic scratch filter — never treated as ground truth, per
 * the story's own design_decisions.
 *
 * Story: cm-02-conversation-source-discovery (epic: mnemosyne-conversation-memory).
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { stringify } from 'yaml';

// ---------------------------------------------------------------------------
// Defaults — real, operator-global locations. Every one is overridable via
// `DiscoverSourcesOptions` so tests run against a synthetic fixture tree and
// NEVER touch the operator's real `~/.claude/projects/` tree or real export
// files (the story's own hard constraint).
// ---------------------------------------------------------------------------

/** `~/.claude/projects` — real Claude Code session transcript root. */
export const DEFAULT_CLAUDE_PROJECTS_ROOT = path.join(homedir(), '.claude', 'projects');

/** The one, fixed, named ChatGPT export path confirmed real this epic's planning pass (research-brief.md §1.2). */
export const DEFAULT_CHATGPT_EXPORT_PATH = path.join(
  homedir(),
  'Downloads',
  'ChatGPT Data Export Feb 5 2026',
  'conversations.json',
);

/** The one, fixed, named Gemini Takeout export path confirmed real this epic's planning pass (design-discussion.md §10.1). */
export const DEFAULT_GEMINI_TAKEOUT_PATH = path.join(homedir(), 'Downloads', 'Google Takeout Aug 26 2026.zip');

/** `~/.mnemosyne/conversation-sources.yaml` -- mirrors orgTree.ts's `DEFAULT_ORG_TREE_PATH` convention exactly. */
export const DEFAULT_MANIFEST_PATH = path.join(homedir(), '.mnemosyne', 'conversation-sources.yaml');

/**
 * Operator-confirmed project roots (relative to home dir) the weak-signal
 * check compares a decoded slug against (design-discussion.md §2.4:
 * "Code/, Documents/work/, or another operator-confirmed project root").
 * Only these two are confirmed this planning pass (research-brief.md §1.1
 * cross-checked against the real 234-dir sample) -- callers may pass a
 * longer list explicitly; this module never invents additional roots.
 */
export const DEFAULT_CONFIRMED_ROOT_SUFFIXES = ['Code', 'Documents/work'];

/** The scratch-filter exclude pattern, verbatim from research-brief.md §1.1 / design-discussion.md §2.4. */
const SCRATCH_EXCLUDE_RE = /^-private-tmp|^-private-var-folders|scratchpad/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScratchConfidence = 'confirmed' | 'weak';

export interface DiscoveredSession {
  /** Absolute path to the real `.jsonl` session file. */
  path: string;
  /** Raw, undecoded project directory name (the slug as it sits on disk). */
  projectDir: string;
  /** Best-effort decoded absolute path this project directory's slug represents -- a heuristic, never ground truth. */
  projectSlug: string;
  /** Real byte size (`stat().size`) -- metadata only, content never read. */
  sizeBytes: number;
  /** Real last-modified time (`stat().mtime`), ISO 8601. */
  mtime: string;
  /** `'confirmed'` -- decoded slug falls under an operator-confirmed root. `'weak'` -- included, but flagged, never silently dropped or silently promoted. */
  scratchConfidence: ScratchConfidence;
}

export interface ExcludedDir {
  /** Raw project directory name that matched the scratch-filter exclude pattern. */
  dir: string;
  /** Which specific sub-pattern matched, named explicitly (never a generic "excluded" with no trace). */
  reason: string;
}

export interface ExportEntry {
  /** The fixed, named path this entry checks (never a scanned/discovered path). */
  path: string;
  /** Human-readable status. Computed from presence (`existsSync`) only -- content never read. */
  status: string;
}

export interface ConversationSourceManifest {
  /** ISO 8601 timestamp of this discovery run. */
  generatedAt: string;
  /** Every real session file found under an included (confirmed or weak) project directory. */
  sessions: DiscoveredSession[];
  /** Every project directory excluded by the scratch filter, with the reason recorded (AC2: never silently omitted). */
  excluded: ExcludedDir[];
  /** The fixed, named export-file list -- never a generic directory scan (AC4). */
  exports: {
    chatgpt: ExportEntry;
    gemini: ExportEntry;
  };
}

export interface DiscoverSourcesOptions {
  /** Root to walk for Claude Code project directories. Default `~/.claude/projects`. Override with a synthetic fixture tree in tests. */
  claudeProjectsRoot?: string;
  /** Home directory used to build absolute confirmed-root paths and to resolve `confirmedRootSuffixes` against. Default `os.homedir()`. */
  homeDir?: string;
  /** Operator-confirmed project root suffixes (relative to `homeDir`). Default `DEFAULT_CONFIRMED_ROOT_SUFFIXES`. */
  confirmedRootSuffixes?: string[];
  /** Fixed ChatGPT export path to check. Default `DEFAULT_CHATGPT_EXPORT_PATH`. */
  chatgptExportPath?: string;
  /** Fixed Gemini Takeout export path to check. Default `DEFAULT_GEMINI_TAKEOUT_PATH`. */
  geminiTakeoutPath?: string;
  /** Where the manifest is written. Default `DEFAULT_MANIFEST_PATH`. */
  manifestPath?: string;
  /** Whether to write the manifest to disk. Default `true`. Set `false` to only compute in-memory (e.g. a dry-run preview). */
  write?: boolean;
}

// ---------------------------------------------------------------------------
// Decoding / classification
// ---------------------------------------------------------------------------

/**
 * Best-effort decode of a Claude Code project directory name back to the
 * absolute path it represents. Confirmed against real, known-good samples
 * this epic's research step (leading `/` -> `-`, every internal `/` -> `-`,
 * and `.` -> `-` too -- e.g. `-Users-mdostal-Code-delphi` decodes to
 * `/Users/mdostal/Code/delphi`; `-Users-mdostal-Documents-work-pantheon-
 * mnemosyne--claude-worktrees-wf-...` decodes back through a `.claude`
 * segment). This is LOSSY when the real directory name contains a literal
 * `-` (indistinguishable from an encoded separator) -- a heuristic on top
 * of a heuristic, per the story's own design_decisions; never treated as
 * ground truth by any caller.
 */
export function decodeProjectSlug(dirName: string): string {
  if (!dirName.startsWith('-')) {
    // Not a real absolute-path-derived slug (shouldn't normally happen for
    // a real `~/.claude/projects/` entry) -- return as-is rather than
    // guessing.
    return dirName;
  }
  return '/' + dirName.slice(1).replace(/-/g, '/');
}

export interface ScratchClassification {
  excluded: boolean;
  reason?: string;
  scratchConfidence: ScratchConfidence;
}

/**
 * Classifies a single project directory name per the scratch-filter +
 * weak-signal heuristic (design-discussion.md §2.4):
 *  - Matches `SCRATCH_EXCLUDE_RE` -> `excluded: true`, reason named.
 *  - Otherwise: decodes the slug; if it falls under one of
 *    `confirmedRoots` (absolute paths) -> `'confirmed'`; anything else
 *    (including paths outside `homeDir` entirely) -> `'weak'`, included
 *    but flagged, never silently dropped or silently promoted (AC3).
 */
export function classifyScratchDir(dirName: string, confirmedRoots: string[]): ScratchClassification {
  const excludeMatch = SCRATCH_EXCLUDE_RE.exec(dirName);
  if (excludeMatch) {
    return {
      excluded: true,
      reason: `matched scratch-filter exclude pattern: /${excludeMatch[0]}/ (source: research-brief.md §1.1)`,
      scratchConfidence: 'confirmed',
    };
  }

  const slug = decodeProjectSlug(dirName);
  const underConfirmedRoot = confirmedRoots.some((root) => slug === root || slug.startsWith(root + '/'));

  return {
    excluded: false,
    scratchConfidence: underConfirmedRoot ? 'confirmed' : 'weak',
  };
}

// ---------------------------------------------------------------------------
// Claude Code session discovery
// ---------------------------------------------------------------------------

function discoverClaudeCodeSessions(
  claudeProjectsRoot: string,
  confirmedRoots: string[],
): { sessions: DiscoveredSession[]; excluded: ExcludedDir[] } {
  const sessions: DiscoveredSession[] = [];
  const excluded: ExcludedDir[] = [];

  if (!existsSync(claudeProjectsRoot)) {
    return { sessions, excluded };
  }

  const entries = readdirSync(claudeProjectsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirName = entry.name;
    const classification = classifyScratchDir(dirName, confirmedRoots);

    if (classification.excluded) {
      excluded.push({ dir: dirName, reason: classification.reason! });
      continue;
    }

    const projectDirPath = path.join(claudeProjectsRoot, dirName);
    const projectSlug = decodeProjectSlug(dirName);
    let sessionFiles: string[];
    try {
      sessionFiles = readdirSync(projectDirPath).filter((f) => f.endsWith('.jsonl'));
    } catch {
      // Directory vanished or unreadable between the outer readdir and here
      // (real TOCTOU on a live filesystem) -- skip, never throw discovery
      // off a single unlucky entry.
      continue;
    }

    for (const file of sessionFiles) {
      const sessionPath = path.join(projectDirPath, file);
      let stat;
      try {
        stat = statSync(sessionPath);
      } catch {
        continue;
      }
      sessions.push({
        path: sessionPath,
        projectDir: dirName,
        projectSlug,
        sizeBytes: stat.size,
        mtime: stat.mtime.toISOString(),
        scratchConfidence: classification.scratchConfidence,
      });
    }
  }

  return { sessions, excluded };
}

// ---------------------------------------------------------------------------
// Fixed, named export-file list
// ---------------------------------------------------------------------------

/**
 * The Gemini Takeout export's known conversation count, confirmed via a
 * file-listing-only inspection during this epic's own planning research
 * (design-discussion.md §10.1) -- a fixed fact folded into the manifest's
 * wording, never recomputed by opening the zip at runtime.
 */
const GEMINI_TAKEOUT_KNOWN_CONVERSATION_COUNT = 2;

function discoverExportFiles(chatgptExportPath: string, geminiTakeoutPath: string): ConversationSourceManifest['exports'] {
  return {
    chatgpt: {
      path: chatgptExportPath,
      status: existsSync(chatgptExportPath) ? 'staged' : 'not_found',
    },
    gemini: {
      path: geminiTakeoutPath,
      status: existsSync(geminiTakeoutPath)
        ? `staged (takeout, ${GEMINI_TAKEOUT_KNOWN_CONVERSATION_COUNT} conversations)`
        : 'not_found',
    },
  };
}

// ---------------------------------------------------------------------------
// Manifest write
// ---------------------------------------------------------------------------

function writeManifest(manifest: ConversationSourceManifest, manifestPath: string): void {
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, stringify(manifest), 'utf8');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Enumerates real conversation sources: Claude Code session transcripts
 * under `claudeProjectsRoot` (scratch-filtered + weak-signal-flagged) and
 * the fixed, named export-file list (ChatGPT + Gemini Takeout). Read-only
 * over filesystem METADATA only -- see module doc comment for the full
 * no-content-read discipline.
 *
 * Always recomputed fresh from the real, current filesystem state on every
 * call (AC7) -- never reads or merges a previous manifest; a fresh call
 * always fully reflects current reality, never a stale cache silently
 * trusted. Writes the result to `manifestPath` (default
 * `DEFAULT_MANIFEST_PATH`) unless `write: false` is passed, and returns
 * the same manifest object either way.
 */
export function discoverSources(options: DiscoverSourcesOptions = {}): ConversationSourceManifest {
  const homeDir = options.homeDir ?? homedir();
  const claudeProjectsRoot = options.claudeProjectsRoot ?? DEFAULT_CLAUDE_PROJECTS_ROOT;
  const confirmedRootSuffixes = options.confirmedRootSuffixes ?? DEFAULT_CONFIRMED_ROOT_SUFFIXES;
  const confirmedRoots = confirmedRootSuffixes.map((suffix) => path.posix.join(homeDir.split(path.sep).join('/'), suffix));
  const chatgptExportPath = options.chatgptExportPath ?? DEFAULT_CHATGPT_EXPORT_PATH;
  const geminiTakeoutPath = options.geminiTakeoutPath ?? DEFAULT_GEMINI_TAKEOUT_PATH;
  const manifestPath = options.manifestPath ?? DEFAULT_MANIFEST_PATH;
  const write = options.write ?? true;

  const { sessions, excluded } = discoverClaudeCodeSessions(claudeProjectsRoot, confirmedRoots);
  const exports = discoverExportFiles(chatgptExportPath, geminiTakeoutPath);

  const manifest: ConversationSourceManifest = {
    generatedAt: new Date().toISOString(),
    sessions,
    excluded,
    exports,
  };

  if (write) {
    writeManifest(manifest, manifestPath);
  }

  return manifest;
}
