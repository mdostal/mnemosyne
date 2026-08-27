#!/usr/bin/env node
// bin/mnemosyne-conversation-pilot.mjs — cm-08-bounded-operator-pilot
// (epic: mnemosyne-conversation-memory).
//
// Orchestrates cm-02 -> cm-03/cm-04 -> cm-05 -> cm-06 -> cm-07 end-to-end
// over a SMALL, REAL, OPERATOR-SELECTED sample -- the first and only point
// in this epic where real personal conversation content is actually
// persisted (docs/design-discussion.md §2.8). This file introduces ZERO
// new discovery/parsing/classification/clustering/persistence logic of its
// own -- every stage's real, already-built function
// (discoverSources/parseClaudeCodeSession/parseChatGptExport/
// triageSession/clusterConversations/distillAndRemember) is imported and
// called UNCHANGED. This file is purely sequencing + the confirmation
// gate.
//
// ---------------------------------------------------------------------------
// The confirmation gate -- no auto-select code path anywhere.
// ---------------------------------------------------------------------------
// `[grill 3.2]` (design-discussion.md §2.8) names TWO valid selection
// mechanics: "a CLI confirm step or an edited manifest file." This story
// implements the second as the primary, interactive mechanic (an
// operator-authored SELECTION FILE, `--selection-file <path>`, no default
// path -- omitting the flag is itself a hard refusal) and the first as a
// SECOND, machine-readable entry point (`--sessions`/`--exports`/
// `--confirm`/`--json`) for round-5's own cm-15 UI trigger to reach
// non-interactively (design-discussion.md §12.2's own named coordination
// point -- cm-15 is not built by this story; this is the dependency it
// will lean on). BOTH entry points build the SAME normalized
// `{ confirmed, claudeCodeSessionPaths, chatgptConversationIds }` shape
// and feed it to the SAME `validateSelection()` function inside the SAME
// `runPilot()` -- a second real entry point into the gate, never a fork,
// never a weaker check. `validateSelection()` runs BEFORE a single stage
// function (`deps.*`) is ever invoked -- verified directly by this file's
// own test suite (a stub deps object asserted to have received zero calls
// in every refusal case).
//
// Selection-file schema (YAML or JSON -- `yaml`'s own parser accepts both):
//   confirmed: true                      # literal boolean, no other value accepted
//   claudeCodeSessions:                  # 0..5 entries
//     - path: /abs/path/to/session.jsonl # cross-checked against a fresh,
//                                         # real discoverSources() manifest
//   chatgptConversations:                # 0..5 entries
//     - conversationId: "<id>"           # cross-checked against the real,
//                                         # parsed ChatGPT export
// At least one of the two lists must be non-empty. Missing file, unparsable
// file, `confirmed !== true`, either list exceeding 5, or an empty combined
// selection all refuse identically, before any stage runs.
//
// Machine-readable mode (design-discussion.md §12.2's own suggested shape):
//   --sessions <path,path,...>     # Claude Code session paths (max 5)
//   --exports <id,id,...>          # ChatGPT conversation ids (max 5) --
//                                   # named `--exports` to match §12.2's own
//                                   # suggested flag verbatim; the VALUES are
//                                   # conversation ids (cm-08's own AC1 caps
//                                   # "no more than 5 ChatGPT conversations",
//                                   # a finer grain than an export-file-level
//                                   # key -- cm-15 is not yet built, so this
//                                   # is this story's own concrete resolution
//                                   # of that coordination point, not a
//                                   # change to §12.2's own text).
//   --confirm                      # required literal boolean flag, mirrors
//                                   # the selection file's `confirmed: true`
//                                   # -- symmetric explicit-confirmation bar
//                                   # for a caller (e.g. cm-15's own future
//                                   # server route) that never writes a
//                                   # selection file at all.
//   --json                         # machine-readable stdout (full result
//                                   # object), for cm-15's own future route
//                                   # to shell out and parse.
//
// ---------------------------------------------------------------------------
// Stage sequencing (this file's own single source of truth for the order).
// ---------------------------------------------------------------------------
//   1. discoverSources({ write: false }) -- real, fresh, read-only (never
//      persists a manifest as a side effect of running a pilot; that is
//      cm-02's own `/conversation-memory/sources/scan` route's job).
//   2. Cross-check the confirmed Claude Code session paths against the
//      manifest's real sessions[]; cross-check the confirmed ChatGPT
//      conversation ids against a real parseChatGptExport() call over the
//      manifest's own chatgpt export path (ONE call, grouped by
//      conversation id -- parseChatGptExport()'s own signature parses the
//      whole export file, it has no per-conversation-id filter of its own).
//      A path/id absent from the real, current data is a per-session
//      'discover'-stage failure -- that session is excluded from every
//      later stage, but the run continues for the rest.
//   3. parseClaudeCodeSession(path) per confirmed, cross-checked Claude
//      Code session.
//   4. triageSession({ turns, sourcePath, sizeBytes }) per session (both
//      source types).
//   5. Trash-verdict sessions are short-circuited HERE -- excluded from
//      the clustering input entirely, not merely filtered from output.
//   6. ONE batched clusterConversations({ entries }) call over every
//      keep/uncertain session together (never per-session).
//   7. distillAndRemember(...) per keep/uncertain session, with cm-06's own
//      real cluster_id/resolved_scope_candidate output threaded through,
//      and the injected IngestClient (`deps.ingestClient` -- a fake in
//      every automated test, the real `MnemosyneClient` in production).
//
// Every stage attempt for every session is recorded as its OWN result
// entry -- `{ sessionId, sourceType, stage, ok, error }` -- never a
// generic, pipeline-wide failure; a single session's failure at any stage
// never aborts the rest of the run.
//
// ---------------------------------------------------------------------------
// Scope correction (round-4, already shipped -- read directly, not
// assumed): cm-08's OWN story YAML (written round-3) describes this
// pipeline as persisting to `scope: 'meta'`. That is STALE.
// `distillAndRemember.ts` was revised in round 4 (design-discussion.md
// §11.2) to persist UNCONDITIONALLY to `scope: 'intake'` -- confirmed by
// reading `lib/mnemosyne/conversation-memory/distillAndRemember.ts`
// directly (`INTAKE_SCOPE = 'intake' as unknown as Scope`, the ONE scope
// value ever passed to `ingestDocument()`). This orchestrator makes no
// scope decision of its own (cm-07's own logic is called unchanged) --
// this comment exists so a reader of THIS file is never misled by the
// story text's now-stale assumption. AC6's own "meta-scope collection" is
// therefore `intake` in practice.
//
// A real recall() spot-check (AC6 -- "at least one real, distilled entry
// from the pilot is retrievable") is this story's own MANUAL verification
// step (`metric.source.kind: manual` in the story YAML), run by the
// operator against real, live Qdrant Cloud AFTER a real pilot run
// completes -- never performed by this file or its own automated test
// suite (which never touches live Qdrant/Gemini, per this story's own
// hard constraint). This file prints a reminder pointing at the real scope
// to query once a real run finishes.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseSelectionDocument } from 'yaml';

import { discoverSources } from '../lib/mnemosyne/conversation-memory/discoverSources.ts';
import { parseClaudeCodeSession } from '../lib/mnemosyne/conversation-memory/parseClaudeCodeSession.ts';
import { parseChatGptExport } from '../lib/mnemosyne/conversation-memory/parseChatGptExport.ts';
import { triageSession } from '../lib/mnemosyne/conversation-memory/triageSession.ts';
import { clusterConversations } from '../lib/mnemosyne/conversation-memory/clusterConversations.ts';
import { distillAndRemember } from '../lib/mnemosyne/conversation-memory/distillAndRemember.ts';
import { MnemosyneClient } from '../lib/mnemosyne/client.ts';

// ---------------------------------------------------------------------------
// Named constants
// ---------------------------------------------------------------------------

/** Hard cap on EACH of the two source lists (cm-08's own AC1 -- "no more than 5 Claude Code sessions and no more than 5 ChatGPT conversations"). Enforced identically by both entry points, inside `validateSelection()`, never re-derived per-mode. */
export const MAX_SESSIONS_PER_SOURCE = 5;

/** The `intake` scope cm-07 actually persists to today (round 4) -- see this file's own module doc comment's "Scope correction" section. Used only in this file's own printed operator guidance, never passed anywhere -- `distillAndRemember()` decides its own scope internally, unchanged. */
export const REAL_PERSIST_SCOPE = 'intake';

// ---------------------------------------------------------------------------
// Real, production dependency wiring -- never constructed at module load
// time (only when actually running for real); every automated test
// supplies its own, fully independent `deps` object instead, so this
// function is never invoked by the test suite.
// ---------------------------------------------------------------------------

export function defaultDeps() {
  return {
    discoverSources,
    parseClaudeCodeSession,
    parseChatGptExport,
    triageSession,
    clusterConversations,
    distillAndRemember,
    ingestClient: new MnemosyneClient({ rootDirectory: process.env.MNEMOSYNE_ROOT_DIR || process.cwd() }),
  };
}

// ---------------------------------------------------------------------------
// validateSelection() -- the ONE confirmation gate, reached identically by
// both entry points via runPilot() below. Pure, synchronous, zero I/O,
// zero calls to any `deps.*` stage function.
// ---------------------------------------------------------------------------

/** `true` for an array whose every element is a non-empty string -- including the empty array itself (vacuously true), since an empty list on ONE side is legitimate (e.g. Claude-Code-only or ChatGPT-only pilot sample). */
function isArrayOfNonEmptyStrings(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.length > 0);
}

/**
 * `rawSelection` is the already-normalized `{ confirmed, claudeCodeSessionPaths,
 * chatgptConversationIds }` shape both entry points below build. Returns
 * `{ ok: true, selection }` or `{ ok: false, error }` -- never throws, never
 * calls anything outside this function.
 */
export function validateSelection(rawSelection) {
  if (!rawSelection || typeof rawSelection !== 'object') {
    return { ok: false, error: 'no selection provided' };
  }
  if (rawSelection.confirmed !== true) {
    return {
      ok: false,
      error: "selection was not explicitly confirmed: 'confirmed' must be exactly boolean true (literal, no other value accepted)",
    };
  }
  const claudeCodeSessionPaths = rawSelection.claudeCodeSessionPaths;
  const chatgptConversationIds = rawSelection.chatgptConversationIds;
  if (!isArrayOfNonEmptyStrings(claudeCodeSessionPaths)) {
    return { ok: false, error: 'claudeCodeSessions must be an array of non-empty session paths (may be an empty array)' };
  }
  if (!isArrayOfNonEmptyStrings(chatgptConversationIds)) {
    return { ok: false, error: 'chatgptConversations must be an array of non-empty conversation ids (may be an empty array)' };
  }
  if (claudeCodeSessionPaths.length > MAX_SESSIONS_PER_SOURCE) {
    return {
      ok: false,
      error: `claudeCodeSessions exceeds the maximum of ${MAX_SESSIONS_PER_SOURCE} (got ${claudeCodeSessionPaths.length}) -- never a larger, auto-expanded set`,
    };
  }
  if (chatgptConversationIds.length > MAX_SESSIONS_PER_SOURCE) {
    return {
      ok: false,
      error: `chatgptConversations exceeds the maximum of ${MAX_SESSIONS_PER_SOURCE} (got ${chatgptConversationIds.length}) -- never a larger, auto-expanded set`,
    };
  }
  if (claudeCodeSessionPaths.length === 0 && chatgptConversationIds.length === 0) {
    return { ok: false, error: 'selection is empty: at least one Claude Code session or one ChatGPT conversation is required' };
  }
  return { ok: true, selection: { claudeCodeSessionPaths, chatgptConversationIds } };
}

// ---------------------------------------------------------------------------
// Entry point 1 -- operator-authored selection file.
// ---------------------------------------------------------------------------

/**
 * Loads and structurally normalizes a selection file. Returns
 * `{ ok: true, rawSelection }` or `{ ok: false, error }`. Never calls
 * `validateSelection()` itself (that happens once, inside `runPilot()`,
 * for both entry points identically) -- this function's own job is only
 * "does a real file exist here, and does it parse," which is a genuinely
 * different failure class from "is the selection itself valid."
 */
export function loadSelectionFromFile(filePath) {
  if (!filePath) {
    return { ok: false, error: 'no --selection-file <path> given -- there is no default path; omitting it is a hard refusal by construction' };
  }
  if (!existsSync(filePath)) {
    return { ok: false, error: `selection file not found: ${filePath}` };
  }
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    return { ok: false, error: `could not read selection file ${filePath}: ${err.message || err}` };
  }
  let parsed;
  try {
    parsed = parseSelectionDocument(raw);
  } catch (err) {
    return { ok: false, error: `selection file ${filePath} did not parse as YAML/JSON: ${err.message || err}` };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: `selection file ${filePath} did not parse to an object` };
  }
  const claudeCodeSessions = Array.isArray(parsed.claudeCodeSessions) ? parsed.claudeCodeSessions : [];
  const chatgptConversations = Array.isArray(parsed.chatgptConversations) ? parsed.chatgptConversations : [];
  const rawSelection = {
    confirmed: parsed.confirmed,
    claudeCodeSessionPaths: claudeCodeSessions.map((entry) => (entry && typeof entry === 'object' ? entry.path : undefined)),
    chatgptConversationIds: chatgptConversations.map((entry) => (entry && typeof entry === 'object' ? entry.conversationId : undefined)),
  };
  return { ok: true, rawSelection };
}

// ---------------------------------------------------------------------------
// Entry point 2 -- machine-readable flags (design-discussion.md §12.2's own
// coordination point for the future cm-15 UI trigger).
// ---------------------------------------------------------------------------

/** Builds the SAME normalized `rawSelection` shape `loadSelectionFromFile()` builds, from already-parsed CLI flags. Never itself calls `validateSelection()` -- see that function's own doc comment. */
export function buildSelectionFromFlags({ sessions = [], exports: exportIds = [], confirm = false }) {
  return {
    ok: true,
    rawSelection: {
      confirmed: confirm === true,
      claudeCodeSessionPaths: sessions,
      chatgptConversationIds: exportIds,
    },
  };
}

// ---------------------------------------------------------------------------
// runPilot() -- the single shared confirmation gate + stage orchestrator.
// Both entry points above feed this ONE function; there is no second
// implementation of the gate or the sequencing anywhere in this file.
// ---------------------------------------------------------------------------

function splitCsv(value) {
  if (!value) return [];
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export async function runPilot({ rawSelection, deps, now = () => new Date() } = {}) {
  const validation = validateSelection(rawSelection);
  if (!validation.ok) {
    // Zero `deps.*` calls above this line, in any code path -- verified
    // directly by this file's own test suite.
    return { ok: false, refused: true, reason: validation.error, results: [] };
  }
  const d = deps ?? defaultDeps();
  const { claudeCodeSessionPaths, chatgptConversationIds } = validation.selection;

  const results = [];
  const record = (sessionId, sourceType, stage, ok, error = null) => {
    results.push({ sessionId, sourceType, stage, ok, error: error === null || error === undefined ? null : String(error) });
  };

  // ---- 1. discoverSources() -- real, fresh, read-only (write: false). ----
  let manifest;
  try {
    manifest = await d.discoverSources({ write: false });
  } catch (err) {
    return { ok: false, refused: true, reason: `discoverSources() failed: ${err.message || err}`, results: [] };
  }

  // ---- 2a. Cross-check Claude Code session paths against the real manifest. ----
  const manifestByPath = new Map((manifest.sessions ?? []).map((s) => [s.path, s]));
  const crossCheckedClaudeSessions = [];
  for (const sessionPath of claudeCodeSessionPaths) {
    const found = manifestByPath.get(sessionPath);
    if (!found) {
      record(sessionPath, 'claude-code', 'discover', false, `session path not present in the real, current discoverSources() manifest: ${sessionPath}`);
      continue;
    }
    record(sessionPath, 'claude-code', 'discover', true);
    crossCheckedClaudeSessions.push(found);
  }

  // ---- 2b. Cross-check ChatGPT conversation ids against the real, parsed export. ----
  const chatgptTurnsByConversationId = new Map();
  if (chatgptConversationIds.length > 0) {
    const chatgptExportPath = manifest.exports?.chatgpt?.path;
    const chatgptExportStatus = manifest.exports?.chatgpt?.status;
    if (!chatgptExportPath || chatgptExportStatus === 'not_found') {
      for (const conversationId of chatgptConversationIds) {
        record(conversationId, 'chatgpt', 'discover', false, 'ChatGPT export file not found per the real discoverSources() manifest');
      }
    } else {
      try {
        const allTurns = await d.parseChatGptExport(chatgptExportPath);
        for (const turn of allTurns) {
          if (!chatgptTurnsByConversationId.has(turn.sessionId)) {
            chatgptTurnsByConversationId.set(turn.sessionId, []);
          }
          chatgptTurnsByConversationId.get(turn.sessionId).push(turn);
        }
        for (const conversationId of chatgptConversationIds) {
          if (!chatgptTurnsByConversationId.has(conversationId)) {
            record(conversationId, 'chatgpt', 'discover', false, `conversation id not present in the real, parsed ChatGPT export: ${conversationId}`);
          } else {
            record(conversationId, 'chatgpt', 'discover', true);
          }
        }
      } catch (err) {
        for (const conversationId of chatgptConversationIds) {
          record(conversationId, 'chatgpt', 'discover', false, `parseChatGptExport() failed: ${err.message || err}`);
        }
      }
    }
  }

  // ---- 3. Parse -- per Claude Code session; ChatGPT sessions are already parsed (step 2b). ----
  const sessions = [];
  for (const s of crossCheckedClaudeSessions) {
    try {
      const turns = await d.parseClaudeCodeSession(s.path);
      const sessionId = turns.find((t) => t.sessionId)?.sessionId || s.path;
      record(sessionId, 'claude-code', 'parse', true);
      sessions.push({ sessionId, sourceType: 'claude-code', turns, projectSlug: s.projectSlug, sourcePath: s.path, sizeBytes: s.sizeBytes });
    } catch (err) {
      record(s.path, 'claude-code', 'parse', false, err.message || String(err));
    }
  }
  for (const conversationId of chatgptConversationIds) {
    const turns = chatgptTurnsByConversationId.get(conversationId);
    if (!turns) continue; // already recorded a 'discover' failure above.
    record(conversationId, 'chatgpt', 'parse', true);
    sessions.push({ sessionId: conversationId, sourceType: 'chatgpt', turns, projectSlug: null, sourcePath: null, sizeBytes: null });
  }

  // ---- 4. Triage -- per session, both source types. ----
  const triaged = [];
  for (const session of sessions) {
    try {
      const result = await d.triageSession({ turns: session.turns, sourcePath: session.sourcePath, sizeBytes: session.sizeBytes });
      record(session.sessionId, session.sourceType, 'triage', true);
      triaged.push({ ...session, verdict: result.verdict, summary: result.summary });
    } catch (err) {
      record(session.sessionId, session.sourceType, 'triage', false, err.message || String(err));
    }
  }

  // ---- 5. Trash-verdict short-circuit -- excluded from cluster/distill entirely. ----
  const clusterable = triaged.filter((t) => t.verdict !== 'trash');

  // ---- 6. ONE batched clusterConversations() call over every keep/uncertain session. ----
  let clusterResult = { clusters: [], assignments: {} };
  if (clusterable.length > 0) {
    try {
      clusterResult = await d.clusterConversations({
        entries: clusterable.map((t) => ({ sessionId: t.sessionId, verdict: t.verdict, summary: t.summary, projectSlug: t.projectSlug })),
      });
      for (const t of clusterable) record(t.sessionId, t.sourceType, 'cluster', true);
    } catch (err) {
      for (const t of clusterable) record(t.sessionId, t.sourceType, 'cluster', false, err.message || String(err));
    }
  }

  // ---- 7. distillAndRemember() -- per keep/uncertain session. ----
  for (const t of clusterable) {
    const clusterId = Object.prototype.hasOwnProperty.call(clusterResult.assignments, t.sessionId)
      ? clusterResult.assignments[t.sessionId]
      : null;
    const cluster = clusterId ? clusterResult.clusters.find((c) => c.cluster_id === clusterId) : null;
    const resolvedScopeCandidate = cluster ? cluster.resolved_scope_candidate : null;
    try {
      const outcome = await d.distillAndRemember({
        sessionId: t.sessionId,
        chatSource: t.sourceType,
        turns: t.turns,
        verdict: t.verdict,
        summary: t.summary,
        projectSlug: t.projectSlug,
        clusterId: clusterId ?? null,
        resolvedScopeCandidate,
        client: d.ingestClient,
      });
      const allOk = outcome.entries.every((entry) => entry.ok || entry.quarantined);
      record(t.sessionId, t.sourceType, 'distill', allOk, allOk ? null : 'one or more distilled entries failed to persist');
    } catch (err) {
      record(t.sessionId, t.sourceType, 'distill', false, err.message || String(err));
    }
  }

  const failedResults = results.filter((r) => !r.ok);
  return {
    ok: true,
    refused: false,
    results,
    sessionCount: sessions.length,
    clusterCount: clusterResult.clusters.length,
    failureCount: failedResults.length,
    recordedAt: now().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// CLI argv parsing + dispatch.
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const args = {
    selectionFile: undefined,
    sessions: [],
    exports: [],
    confirm: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--selection-file') args.selectionFile = argv[++i];
    else if (a === '--sessions') args.sessions = splitCsv(argv[++i]);
    else if (a === '--exports') args.exports = splitCsv(argv[++i]);
    else if (a === '--confirm') args.confirm = true;
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

const USAGE = `Usage:
  mnemosyne-conversation-pilot --selection-file <path> [--json]
  mnemosyne-conversation-pilot --sessions <path,path,...> --exports <id,id,...> --confirm [--json]

Refuses to run without an explicit, valid, non-empty, <= ${MAX_SESSIONS_PER_SOURCE}-per-source confirmed selection -- no default/implicit selection exists.`;

/**
 * The single CLI dispatch function -- resolves which entry point was
 * invoked, then calls `runPilot()` (the one shared gate) with the
 * resulting `rawSelection`. Exported for direct testing without spawning a
 * subprocess.
 */
export async function executeCliInvocation(argv, { deps, log = console.log, warn = console.error, now } = {}) {
  const args = parseArgs(argv);

  if (args.help) {
    log(USAGE);
    return { ok: true, refused: false, help: true, results: [], failureCount: 0 };
  }

  let loadResult;
  if (args.selectionFile) {
    loadResult = loadSelectionFromFile(args.selectionFile);
  } else if (args.sessions.length > 0 || args.exports.length > 0 || args.confirm) {
    loadResult = buildSelectionFromFlags(args);
  } else {
    loadResult = {
      ok: false,
      error: 'no selection provided -- pass --selection-file <path>, or --sessions/--exports with --confirm',
    };
  }

  if (!loadResult.ok) {
    if (args.json) {
      log(JSON.stringify({ ok: false, refused: true, reason: loadResult.error, results: [] }, null, 2));
    } else {
      warn(`mnemosyne-conversation-pilot: refused -- ${loadResult.error}`);
      warn(USAGE);
    }
    return { ok: false, refused: true, reason: loadResult.error, results: [] };
  }

  const result = await runPilot({ rawSelection: loadResult.rawSelection, deps, now });

  if (args.json) {
    log(JSON.stringify(result, null, 2));
  } else if (result.refused) {
    warn(`mnemosyne-conversation-pilot: refused -- ${result.reason}`);
    warn(USAGE);
  } else {
    log(`mnemosyne-conversation-pilot: ran ${result.sessionCount} session(s) across ${result.clusterCount} cluster(s), ${result.failureCount} stage failure(s).`);
    for (const r of result.results) {
      log(`  [${r.sourceType}] ${r.sessionId} :: ${r.stage} -> ${r.ok ? 'ok' : `FAILED (${r.error})`}`);
    }
    if (!result.refused && result.failureCount === 0) {
      log(
        `\nPilot complete. Verify with a real recall() spot-check against scope: '${REAL_PERSIST_SCOPE}' (AC6's own manual verification step -- never automated by this CLI or its test suite).`,
      );
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Direct-run guard -- mirrors bin/mnemosyne-onboard.mjs's own convention.
// ---------------------------------------------------------------------------

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const result = await executeCliInvocation(process.argv.slice(2));
  process.exit(result.ok && !result.refused && result.failureCount === 0 ? 0 : 1);
}
