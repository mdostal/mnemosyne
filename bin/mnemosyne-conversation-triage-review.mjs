#!/usr/bin/env node
// bin/mnemosyne-conversation-triage-review.mjs — cm-16-triage-review-and-
// confirm-ui (epic: mnemosyne-conversation-memory).
//
// A new, small, tsx-launched CLI (mirrors bin/mnemosyne-conversation-
// discover.mjs's/bin/mnemosyne-onboard.mjs's own established "src/server.mjs
// is plain `node` and cannot import a .ts module directly" precedent,
// design-discussion.md §12.1) that gives src/server.mjs's three new HTTP
// routes (src/triageReviewRoutes.mjs) a real, TS-capable place to run:
//
//   - `read-triage-queue --json`  -> GET /conversation-memory/triage-queue
//   - `intake-candidates --json`  -> GET /conversation-memory/intake-candidates
//   - `confirm --cluster-id <id> --scope-key <key> --json`
//                                  -> POST /conversation-memory/scope-route/confirm
//
// This file introduces ZERO new triage-review DECISION logic of its own for
// the highest-stakes pieces -- `runIntakeCandidates()`/`runConfirm()` below
// both call `computeIntakeCandidateStatuses()`
// (lib/mnemosyne/conversation-memory/distributeIntakeEntries.ts, cm-13's own
// module), which reuses that SAME file's own `partitionPoints()`/
// `readScopeRouteConfirmations()` — never a re-derived, independently-
// implemented enumeration (this story's own hard constraint). `runConfirm()`
// reuses that same module's (now-exported) `isScopeRouteConfirmationEntry()`
// for its own pre-write shape validation, never a locally re-implemented
// shape check.
//
// ---------------------------------------------------------------------------
// THE HIGHEST-STAKES REQUIREMENT — exactly one fs write, anywhere.
// ---------------------------------------------------------------------------
// Of the three exported handlers below, `runReadTriageQueue()` and
// `runIntakeCandidates()` are PURE READS: neither one ever calls a
// `node:fs` write-capable function (verified directly by this file's own
// `bin/mnemosyne-conversation-triage-review.test.mjs`, which spies on
// `node:fs` across all three handlers in a single process — the actual TS
// logic runs HERE, in-process under tsx, not inside a further subprocess,
// specifically so that spy can observe the real call). `runConfirm()`
// performs exactly ONE real, OS-level `fs.appendFileSync()` call and
// nothing else — never a delete/edit of an existing line, never a
// read-modify-rewrite. `mkdirSync()` (ensuring `~/.mnemosyne/` exists) is
// called first, mirroring `triageSession.ts`'s/`distillAndRemember.ts`'s own
// identical "exactly one fs WRITE: appendFileSync" claim despite each of
// THOSE modules also calling `mkdirSync()` — the established convention in
// this codebase already treats directory-creation as distinct from a data
// write/truncate/unlink, and this file follows that precedent exactly
// rather than inventing a stricter one.
//
// ---------------------------------------------------------------------------
// Cross-language bridging to the intake Qdrant collection.
// ---------------------------------------------------------------------------
// `runIntakeCandidates()`/`runConfirm()` both require an injectable
// `scrollPoints` (mirrors `distributeIntakeEntries.ts`'s own `ScrollPointsFn`
// — REQUIRED, never a default production implementation constructed by
// this file itself). Real, production wiring (this file's own direct-run
// block, below) supplies `makePythonScrollPointsFn()`, which `execFile()`s
// `mnemosyne/inventory/qdrant_inventory.py`'s new, read-only
// `intake-candidates` CLI verb (`python3 -m
// mnemosyne.inventory.qdrant_inventory intake-candidates --json`) and
// parses its JSON stdout into the real `ScrolledPoint[]` shape —
// the SAME "thin HTTP wrapper shells out to a CLI" pattern cm-15 uses and
// engine.mjs already establishes throughout src/server.mjs, extended one
// hop further (a tsx CLI shelling out to a Python CLI) rather than a third
// architectural pattern. Every test in this file's own `.test.mjs` supplies
// its own hand-written fake `scrollPoints` — never a real subprocess, never
// live Qdrant.

// Imported via the DEFAULT export (the underlying CJS module.exports
// object), NOT named imports -- a named `import { appendFileSync } from
// 'node:fs'` captures its own live binding that a test's `mock.method(fs,
// 'appendFileSync', ...)` on the default-export object cannot intercept
// (confirmed directly this story's own research step). Calling through
// `fs.appendFileSync(...)` here is what makes
// `bin/mnemosyne-conversation-triage-review.test.mjs`'s own fs-spy test
// able to observe the REAL default-parameter code path, not only an
// explicitly-injected override.
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DEFAULT_TRIAGE_QUEUE_PATH } from '../lib/mnemosyne/conversation-memory/triageSession.ts';
import {
  computeIntakeCandidateStatuses,
  isScopeRouteConfirmationEntry,
} from '../lib/mnemosyne/conversation-memory/distributeIntakeEntries.ts';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..');
export const PYTHON_BIN = process.env.MNEMOSYNE_PYTHON_BIN || 'python3';

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

// ---------------------------------------------------------------------------
// GET /conversation-memory/triage-queue — reads + classifies the shared
// JSONL queue file. A missing file returns empty arrays with ok:true, never
// throws (mirrors readScopeRouteConfirmations()'s own established "missing
// file is not an error" contract). Malformed lines are skipped
// defensively, never fail the whole read. cm-05's own keep/trash/uncertain
// triage verdicts (a real, different record kind in the SAME file) are
// deliberately NOT classified into either output array — explicitly out of
// this panel's own scope (story text), silently skipped here, not an error.
// ---------------------------------------------------------------------------

/**
 * A real quarantine record's own discriminator + minimal shape check — no
 * exported validator exists for this shape anywhere (distillAndRemember.ts's
 * own appendIntakeQuarantineEntry() is private, and only the
 * IntakeQuarantineQueueEntry TYPE, not a runtime guard, is exported) —
 * unlike isScopeRouteConfirmationEntry() (reused directly, see below), this
 * is a small, local, first-time guard, not a re-implementation of any
 * existing runtime check.
 */
function isIntakeQuarantineQueueEntry(value) {
  return (
    !!value &&
    typeof value === 'object' &&
    value.quarantine_reason === 'secret_detected' &&
    typeof value.entry_id === 'string' &&
    Array.isArray(value.secretMatches)
  );
}

export function runReadTriageQueue({ queuePath = DEFAULT_TRIAGE_QUEUE_PATH, readFile = fs.readFileSync } = {}) {
  let raw;
  try {
    raw = readFile(queuePath, 'utf8');
  } catch {
    return { ok: true, quarantine: [], confirmations: [] };
  }

  const quarantine = [];
  const confirmations = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (isIntakeQuarantineQueueEntry(parsed)) {
      quarantine.push(parsed);
    } else if (isScopeRouteConfirmationEntry(parsed)) {
      confirmations.push(parsed);
    }
    // else: a cm-05 triage verdict (verdict: keep/trash/uncertain) or any
    // other/malformed record -- explicitly out of this panel's own scope,
    // silently skipped, never surfaced as an error.
  }
  return { ok: true, quarantine, confirmations };
}

// ---------------------------------------------------------------------------
// GET /conversation-memory/intake-candidates — thin wrapper over
// computeIntakeCandidateStatuses() (distributeIntakeEntries.ts, cm-13's own
// module) -- the SAME scroll_points()-based enumeration + partitioning
// logic cm-13's own distribution pass uses, never re-derived here.
// ---------------------------------------------------------------------------

export async function runIntakeCandidates({ scrollPoints, confirmationQueuePath = DEFAULT_TRIAGE_QUEUE_PATH } = {}) {
  if (typeof scrollPoints !== 'function') {
    throw new Error(
      'runIntakeCandidates() requires an injectable scrollPoints function -- never a default production Qdrant client constructed here.',
    );
  }
  const candidates = await computeIntakeCandidateStatuses(scrollPoints, confirmationQueuePath);
  return { ok: true, candidates };
}

// ---------------------------------------------------------------------------
// POST /conversation-memory/scope-route/confirm — the ONE real write action
// in this story's entire route surface. Defense in depth (design-
// discussion.md §12.3), layered on top of (never a replacement for) cm-13's
// own independent re-validation at distribution time: re-reads the SAME
// real candidate statuses GET /conversation-memory/intake-candidates uses
// (never a second, independently-derived read) and refuses (ok:false, no
// write) unless (cluster_id, scope_key) genuinely names a currently-known
// candidate whose status is candidate_unconfirmed OR
// candidate_confirmed_pending_distribution -- the latter is a real,
// explicitly-accepted DUPLICATE confirm (distributeIntakeEntries.ts's own
// "tolerates a duplicate write, never destructive" posture, verbatim);
// candidate_confirmed_pending_distribution is the ONLY OTHER status that can
// ever be a match for a real, previously-confirmed pair, since a
// non-existent/mismatched pair never appears in candidates at all,
// no_candidate never carries a scope_key to match, and once distributed the
// pair no longer needs re-confirming. A `distributed` candidate is
// deliberately NOT accepted -- its lifecycle is complete, and it is no
// longer "a currently-known candidate_unconfirmed row" in any sense this
// route's own refusal message names.
// ---------------------------------------------------------------------------

const ACCEPTABLE_CONFIRM_STATUSES = new Set(['candidate_unconfirmed', 'candidate_confirmed_pending_distribution']);

export async function runConfirm({
  clusterId,
  scopeKey,
  scrollPoints,
  queuePath = DEFAULT_TRIAGE_QUEUE_PATH,
  now = () => new Date(),
  append = fs.appendFileSync,
  mkdir = fs.mkdirSync,
} = {}) {
  if (typeof scrollPoints !== 'function') {
    throw new Error(
      'runConfirm() requires an injectable scrollPoints function -- never a default production Qdrant client constructed here.',
    );
  }
  if (!isNonEmptyString(clusterId) || !isNonEmptyString(scopeKey)) {
    return { ok: false, error: 'cluster_id and scope_key are both required, non-empty strings' };
  }

  const candidates = await computeIntakeCandidateStatuses(scrollPoints, queuePath);
  const match = candidates.find(
    (c) => c.clusterId === clusterId && c.scopeKey === scopeKey && ACCEPTABLE_CONFIRM_STATUSES.has(c.status),
  );
  if (!match) {
    return {
      ok: false,
      error: `refused: no currently-known candidate_unconfirmed row matches cluster_id=${JSON.stringify(clusterId)} scope_key=${JSON.stringify(scopeKey)}`,
    };
  }

  const entry = {
    recordedAt: now().toISOString(),
    confirmation_reason: 'scope_route_confirmed',
    cluster_id: clusterId,
    scope_key: scopeKey,
  };

  // Pre-write shape validation -- reuses cm-13's own (now-exported)
  // isScopeRouteConfirmationEntry() directly, never a locally
  // re-implemented shape check (this story's own hard constraint).
  if (!isScopeRouteConfirmationEntry(entry)) {
    throw new Error('internal error: built confirmation entry failed isScopeRouteConfirmationEntry() -- refusing to write');
  }

  mkdir(path.dirname(queuePath), { recursive: true });
  // The ONLY fs write anywhere in this story's own route surface -- one
  // real, OS-level append, never a read-modify-rewrite, never a delete/edit
  // of an existing line (this story's own highest-stakes requirement).
  append(queuePath, JSON.stringify(entry) + '\n', 'utf8');

  return { ok: true, confirmed: true, entry };
}

// ---------------------------------------------------------------------------
// Real, production scrollPoints() -- execFile()s the new, read-only
// mnemosyne/inventory/qdrant_inventory.py `intake-candidates` CLI verb.
// Never used by bin/mnemosyne-conversation-triage-review.test.mjs -- every
// test there supplies its own hand-written fake.
// ---------------------------------------------------------------------------

export function makePythonScrollPointsFn({ exec = execFileAsync, pythonBin = PYTHON_BIN, cwd = REPO_ROOT } = {}) {
  return async function scrollPoints() {
    let stdout;
    try {
      const result = await exec(pythonBin, ['-m', 'mnemosyne.inventory.qdrant_inventory', 'intake-candidates', '--json'], {
        cwd,
        maxBuffer: 64 * 1024 * 1024,
      });
      stdout = result.stdout;
    } catch (e) {
      const detail = (e && e.stderr && String(e.stderr).trim()) || (e && e.message) || String(e);
      throw new Error(`intake candidate scroll failed: ${detail}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error(`intake-candidates CLI verb returned output that could not be parsed as JSON: ${String(stdout ?? '').slice(0, 200)}`);
    }
    if (!parsed.ok) {
      throw new Error(parsed.error || 'intake-candidates CLI verb reported ok:false');
    }
    return Array.isArray(parsed.points) ? parsed.points : [];
  };
}

// ---------------------------------------------------------------------------
// Direct-run CLI dispatch.
// ---------------------------------------------------------------------------

const USAGE = `Usage:
  mnemosyne-conversation-triage-review read-triage-queue --json
  mnemosyne-conversation-triage-review intake-candidates --json
  mnemosyne-conversation-triage-review confirm --cluster-id <id> --scope-key <key> --json`;

function parseFlagArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') flags.json = true;
    else if (a === '--cluster-id') flags.clusterId = argv[++i];
    else if (a === '--scope-key') flags.scopeKey = argv[++i];
  }
  return flags;
}

async function runCli(argv) {
  const [command, ...rest] = argv;
  const flags = parseFlagArgs(rest);

  if (command === 'read-triage-queue') {
    return runReadTriageQueue();
  }
  if (command === 'intake-candidates') {
    return runIntakeCandidates({ scrollPoints: makePythonScrollPointsFn() });
  }
  if (command === 'confirm') {
    return runConfirm({ clusterId: flags.clusterId, scopeKey: flags.scopeKey, scrollPoints: makePythonScrollPointsFn() });
  }
  console.error(USAGE);
  return { ok: false, error: `unknown command: ${command || '(none)'}` };
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const result = await runCli(process.argv.slice(2));
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
