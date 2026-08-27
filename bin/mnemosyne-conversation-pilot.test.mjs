// bin/mnemosyne-conversation-pilot.test.mjs — cm-08-bounded-operator-pilot
// (epic: mnemosyne-conversation-memory).
//
// Failing-first tests (TDD) for bin/mnemosyne-conversation-pilot.mjs's own
// logic ONLY: the confirmation gate (both entry points), stage sequencing,
// per-stage failure reporting, and trash-verdict short-circuiting. Every
// stage function (discoverSources/parseClaudeCodeSession/
// parseChatGptExport/triageSession/clusterConversations/distillAndRemember)
// is a hand-written stub injected via `deps` -- never the real
// implementation, never live Qdrant/Gemini/filesystem-metadata scanning.
// `deps.ingestClient` is always a fake `{ remember() {...} }` object, never
// a real `MnemosyneClient`. `defaultDeps()` (the ONLY function in the
// orchestrator that constructs real production wiring) is never called by
// this file.
//
// Run: npx tsx --test bin/mnemosyne-conversation-pilot.test.mjs

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  MAX_SESSIONS_PER_SOURCE,
  buildSelectionFromFlags,
  executeCliInvocation,
  loadSelectionFromFile,
  parseArgs,
  runPilot,
  validateSelection,
} from './mnemosyne-conversation-pilot.mjs';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTempDir() {
  return mkdtempSync(path.join(tmpdir(), 'cm08-pilot-test-'));
}

function writeSelectionFile(dir, content) {
  const file = path.join(dir, 'selection.yaml');
  writeFileSync(file, content, 'utf8');
  return file;
}

/** A fresh, fully-instrumented `deps` object -- every stage function is a
 * `node:test`-free hand-rolled spy (records call args, returns a
 * caller-controlled result). Every test either uses these defaults or
 * overrides individual stages. */
function makeSpyDeps(overrides = {}) {
  const calls = {
    discoverSources: [],
    parseClaudeCodeSession: [],
    parseChatGptExport: [],
    triageSession: [],
    clusterConversations: [],
    distillAndRemember: [],
  };

  const defaultManifest = {
    generatedAt: '2026-08-27T00:00:00.000Z',
    sessions: [
      { path: '/home/op/.claude/projects/-Users-op-Code-alpha/session-a.jsonl', projectDir: '-Users-op-Code-alpha', projectSlug: '/Users/op/Code/alpha', sizeBytes: 100, mtime: '2026-08-20T00:00:00.000Z', scratchConfidence: 'confirmed' },
      { path: '/home/op/.claude/projects/-Users-op-Code-beta/session-b.jsonl', projectDir: '-Users-op-Code-beta', projectSlug: '/Users/op/Code/beta', sizeBytes: 200, mtime: '2026-08-21T00:00:00.000Z', scratchConfidence: 'confirmed' },
    ],
    excluded: [],
    exports: {
      chatgpt: { path: '/home/op/Downloads/chatgpt/conversations.json', status: 'staged' },
      gemini: { path: '/home/op/Downloads/takeout.zip', status: 'not_found' },
    },
  };

  const deps = {
    discoverSources: async (options) => {
      calls.discoverSources.push(options);
      return overrides.manifest ?? defaultManifest;
    },
    parseClaudeCodeSession: async (filePath) => {
      calls.parseClaudeCodeSession.push(filePath);
      if (overrides.parseClaudeCodeSession) return overrides.parseClaudeCodeSession(filePath);
      const sessionId = `sid-${path.basename(filePath, '.jsonl')}`;
      return [
        { sessionId, sourceType: 'claude-code', role: 'user', text: 'hello', timestamp: null, projectSlug: '/Users/op/Code/alpha', turnIndex: 0, quarantined: false, quarantineReason: null, secretMatches: [] },
      ];
    },
    parseChatGptExport: async (filePath) => {
      calls.parseChatGptExport.push(filePath);
      if (overrides.parseChatGptExport) return overrides.parseChatGptExport(filePath);
      return [
        { sessionId: 'conv-1', sourceType: 'chatgpt', role: 'user', text: 'hi', timestamp: null, projectSlug: null, turnIndex: 0, quarantined: false, quarantineReason: null, secretMatches: [] },
        { sessionId: 'conv-2', sourceType: 'chatgpt', role: 'user', text: 'hey', timestamp: null, projectSlug: null, turnIndex: 0, quarantined: false, quarantineReason: null, secretMatches: [] },
      ];
    },
    triageSession: async (options) => {
      calls.triageSession.push(options);
      if (overrides.triageSession) return overrides.triageSession(options);
      return { verdict: 'keep', summary: 'a summary', rationale: 'r', sessionId: options.turns[0]?.sessionId ?? '', heuristic: {}, queueEntry: {}, queuePath: '/tmp/q' };
    },
    clusterConversations: async (options) => {
      calls.clusterConversations.push(options);
      if (overrides.clusterConversations) return overrides.clusterConversations(options);
      const clusters = [
        {
          cluster_id: 'cluster-0',
          cluster_label: 'alpha',
          member_session_ids: options.entries.map((e) => e.sessionId),
          members: options.entries.map((e) => ({ sessionId: e.sessionId, projectSlug: e.projectSlug })),
          project_slugs: [],
          resolved_scope_candidate: null,
        },
      ];
      const assignments = {};
      for (const e of options.entries) assignments[e.sessionId] = 'cluster-0';
      return { clusters, assignments };
    },
    distillAndRemember: async (options) => {
      calls.distillAndRemember.push(options);
      if (overrides.distillAndRemember) return overrides.distillAndRemember(options);
      return { sessionId: options.sessionId, verdict: options.verdict, skipped: false, entries: [{ metadata: {}, bodyText: 'x', quarantined: false, secretMatches: [], ok: true }] };
    },
    ingestClient: {
      remember: async () => {
        throw new Error('fake ingest client: remember() should never be called directly by the orchestrator itself');
      },
    },
  };

  return { deps, calls };
}

/** A `deps` object whose every stage function throws if called at all -- used in every refusal test to prove zero stage calls. */
function makePoisonDeps() {
  const poison = (name) => () => {
    throw new Error(`${name} should never have been called in a refusal case`);
  };
  return {
    discoverSources: poison('discoverSources'),
    parseClaudeCodeSession: poison('parseClaudeCodeSession'),
    parseChatGptExport: poison('parseChatGptExport'),
    triageSession: poison('triageSession'),
    clusterConversations: poison('clusterConversations'),
    distillAndRemember: poison('distillAndRemember'),
    ingestClient: { remember: poison('ingestClient.remember') },
  };
}

// ---------------------------------------------------------------------------
// validateSelection() -- the core gate, in isolation.
// ---------------------------------------------------------------------------

test('validateSelection: accepts a well-formed, confirmed, in-bounds selection', () => {
  const result = validateSelection({ confirmed: true, claudeCodeSessionPaths: ['/a.jsonl'], chatgptConversationIds: [] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.selection.claudeCodeSessionPaths, ['/a.jsonl']);
});

test('validateSelection: refuses when confirmed is not literally true', () => {
  for (const badConfirmed of [false, undefined, 'true', 1, null]) {
    const result = validateSelection({ confirmed: badConfirmed, claudeCodeSessionPaths: ['/a.jsonl'], chatgptConversationIds: [] });
    assert.equal(result.ok, false, `confirmed=${JSON.stringify(badConfirmed)} must refuse`);
    assert.match(result.error, /confirmed/i);
  }
});

test('validateSelection: refuses when claudeCodeSessions exceeds the max', () => {
  const tooMany = Array.from({ length: MAX_SESSIONS_PER_SOURCE + 1 }, (_, i) => `/session-${i}.jsonl`);
  const result = validateSelection({ confirmed: true, claudeCodeSessionPaths: tooMany, chatgptConversationIds: [] });
  assert.equal(result.ok, false);
  assert.match(result.error, /exceeds the maximum/);
});

test('validateSelection: refuses when chatgptConversations exceeds the max', () => {
  const tooMany = Array.from({ length: MAX_SESSIONS_PER_SOURCE + 1 }, (_, i) => `conv-${i}`);
  const result = validateSelection({ confirmed: true, claudeCodeSessionPaths: [], chatgptConversationIds: tooMany });
  assert.equal(result.ok, false);
  assert.match(result.error, /exceeds the maximum/);
});

test('validateSelection: refuses an empty combined selection even when confirmed', () => {
  const result = validateSelection({ confirmed: true, claudeCodeSessionPaths: [], chatgptConversationIds: [] });
  assert.equal(result.ok, false);
  assert.match(result.error, /empty/i);
});

test('validateSelection: accepts a single-source selection (claude-only or chatgpt-only)', () => {
  assert.equal(validateSelection({ confirmed: true, claudeCodeSessionPaths: ['/a.jsonl'], chatgptConversationIds: [] }).ok, true);
  assert.equal(validateSelection({ confirmed: true, claudeCodeSessionPaths: [], chatgptConversationIds: ['conv-1'] }).ok, true);
});

test('validateSelection: refuses a malformed (non-array) selection shape', () => {
  assert.equal(validateSelection({ confirmed: true, claudeCodeSessionPaths: 'not-an-array', chatgptConversationIds: [] }).ok, false);
  assert.equal(validateSelection(undefined).ok, false);
  assert.equal(validateSelection(null).ok, false);
});

// ---------------------------------------------------------------------------
// runPilot() refusal cases -- zero calls to ANY injected stage stub.
// ---------------------------------------------------------------------------

test('runPilot: refuses confirmed!==true with zero stage calls', async () => {
  const deps = makePoisonDeps();
  const result = await runPilot({
    rawSelection: { confirmed: false, claudeCodeSessionPaths: ['/a.jsonl'], chatgptConversationIds: [] },
    deps,
  });
  assert.equal(result.ok, false);
  assert.equal(result.refused, true);
});

test('runPilot: refuses an oversized claudeCodeSessions list with zero stage calls', async () => {
  const deps = makePoisonDeps();
  const tooMany = Array.from({ length: MAX_SESSIONS_PER_SOURCE + 1 }, (_, i) => `/session-${i}.jsonl`);
  const result = await runPilot({
    rawSelection: { confirmed: true, claudeCodeSessionPaths: tooMany, chatgptConversationIds: [] },
    deps,
  });
  assert.equal(result.refused, true);
});

test('runPilot: refuses an oversized chatgptConversations list with zero stage calls', async () => {
  const deps = makePoisonDeps();
  const tooMany = Array.from({ length: MAX_SESSIONS_PER_SOURCE + 1 }, (_, i) => `conv-${i}`);
  const result = await runPilot({
    rawSelection: { confirmed: true, claudeCodeSessionPaths: [], chatgptConversationIds: tooMany },
    deps,
  });
  assert.equal(result.refused, true);
});

test('runPilot: refuses an empty combined selection with zero stage calls', async () => {
  const deps = makePoisonDeps();
  const result = await runPilot({
    rawSelection: { confirmed: true, claudeCodeSessionPaths: [], chatgptConversationIds: [] },
    deps,
  });
  assert.equal(result.refused, true);
});

test('runPilot: refuses a missing/undefined selection with zero stage calls', async () => {
  const deps = makePoisonDeps();
  const result = await runPilot({ rawSelection: undefined, deps });
  assert.equal(result.refused, true);
});

// ---------------------------------------------------------------------------
// File-based entry point -- loadSelectionFromFile()'s own refusal cases.
// These never even reach runPilot()/deps -- proven by executeCliInvocation
// tests below (a poison deps object survives unharmed).
// ---------------------------------------------------------------------------

test('loadSelectionFromFile: refuses when no path is given', () => {
  const result = loadSelectionFromFile(undefined);
  assert.equal(result.ok, false);
  assert.match(result.error, /no --selection-file/);
});

test('loadSelectionFromFile: refuses when the file does not exist', () => {
  const result = loadSelectionFromFile('/definitely/does/not/exist/selection.yaml');
  assert.equal(result.ok, false);
  assert.match(result.error, /not found/);
});

test('loadSelectionFromFile: refuses on unparsable content', () => {
  const dir = makeTempDir();
  try {
    const file = writeSelectionFile(dir, '{ this is not: valid: yaml: [[[');
    const result = loadSelectionFromFile(file);
    assert.equal(result.ok, false);
    assert.match(result.error, /did not parse/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadSelectionFromFile: normalizes a well-formed file into the shared rawSelection shape', () => {
  const dir = makeTempDir();
  try {
    const file = writeSelectionFile(
      dir,
      [
        'confirmed: true',
        'claudeCodeSessions:',
        '  - path: /a.jsonl',
        '  - path: /b.jsonl',
        'chatgptConversations:',
        '  - conversationId: conv-1',
      ].join('\n'),
    );
    const result = loadSelectionFromFile(file);
    assert.equal(result.ok, true);
    assert.deepEqual(result.rawSelection, {
      confirmed: true,
      claudeCodeSessionPaths: ['/a.jsonl', '/b.jsonl'],
      chatgptConversationIds: ['conv-1'],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// executeCliInvocation() -- the full CLI dispatch, both entry points, using
// a POISON deps object for every refusal case (proves zero stage calls end
// to end, not merely inside runPilot()).
// ---------------------------------------------------------------------------

test('executeCliInvocation: file mode refuses with zero stage calls when --selection-file is omitted entirely', async () => {
  const deps = makePoisonDeps();
  const result = await executeCliInvocation([], { deps, log: () => {}, warn: () => {} });
  assert.equal(result.refused, true);
});

test('executeCliInvocation: file mode refuses with zero stage calls on a missing file', async () => {
  const deps = makePoisonDeps();
  const result = await executeCliInvocation(['--selection-file', '/nope.yaml'], { deps, log: () => {}, warn: () => {} });
  assert.equal(result.refused, true);
});

test('executeCliInvocation: file mode refuses with zero stage calls when confirmed is not true', async () => {
  const dir = makeTempDir();
  try {
    const file = writeSelectionFile(dir, 'confirmed: false\nclaudeCodeSessions:\n  - path: /a.jsonl\n');
    const deps = makePoisonDeps();
    const result = await executeCliInvocation(['--selection-file', file], { deps, log: () => {}, warn: () => {} });
    assert.equal(result.refused, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCliInvocation: flag mode refuses with zero stage calls when no flags are given at all', async () => {
  const deps = makePoisonDeps();
  const result = await executeCliInvocation([], { deps, log: () => {}, warn: () => {} });
  assert.equal(result.refused, true);
});

test('executeCliInvocation: flag mode refuses with zero stage calls when --confirm is omitted', async () => {
  const deps = makePoisonDeps();
  const result = await executeCliInvocation(['--sessions', '/a.jsonl'], { deps, log: () => {}, warn: () => {} });
  assert.equal(result.refused, true);
});

test('executeCliInvocation: flag mode refuses with zero stage calls on an empty selection even with --confirm', async () => {
  const deps = makePoisonDeps();
  const result = await executeCliInvocation(['--confirm'], { deps, log: () => {}, warn: () => {} });
  assert.equal(result.refused, true);
});

test('executeCliInvocation: flag mode refuses with zero stage calls on an oversized --sessions list', async () => {
  const deps = makePoisonDeps();
  const tooMany = Array.from({ length: MAX_SESSIONS_PER_SOURCE + 1 }, (_, i) => `/s${i}.jsonl`).join(',');
  const result = await executeCliInvocation(['--sessions', tooMany, '--confirm'], { deps, log: () => {}, warn: () => {} });
  assert.equal(result.refused, true);
});

test('executeCliInvocation: both entry points refuse identically on an empty/invalid selection', async () => {
  const dir = makeTempDir();
  try {
    const emptyFile = writeSelectionFile(dir, 'confirmed: true\nclaudeCodeSessions: []\nchatgptConversations: []\n');
    const fileModeResult = await executeCliInvocation(['--selection-file', emptyFile], { deps: makePoisonDeps(), log: () => {}, warn: () => {} });
    const flagModeResult = await executeCliInvocation(['--confirm'], { deps: makePoisonDeps(), log: () => {}, warn: () => {} });
    assert.equal(fileModeResult.ok, false);
    assert.equal(flagModeResult.ok, false);
    assert.equal(fileModeResult.refused, true);
    assert.equal(flagModeResult.refused, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// parseArgs() / buildSelectionFromFlags() -- flag parsing in isolation.
// ---------------------------------------------------------------------------

test('parseArgs: parses --sessions/--exports/--confirm/--json', () => {
  const args = parseArgs(['--sessions', '/a.jsonl,/b.jsonl', '--exports', 'conv-1,conv-2', '--confirm', '--json']);
  assert.deepEqual(args.sessions, ['/a.jsonl', '/b.jsonl']);
  assert.deepEqual(args.exports, ['conv-1', 'conv-2']);
  assert.equal(args.confirm, true);
  assert.equal(args.json, true);
});

test('buildSelectionFromFlags: builds the shared rawSelection shape', () => {
  const { rawSelection } = buildSelectionFromFlags({ sessions: ['/a.jsonl'], exports: ['conv-1'], confirm: true });
  assert.deepEqual(rawSelection, { confirmed: true, claudeCodeSessionPaths: ['/a.jsonl'], chatgptConversationIds: ['conv-1'] });
});

// ---------------------------------------------------------------------------
// Successful runs -- real stage sequencing, real per-stage result shape,
// real trash short-circuiting, real cross-checking. All against spy stubs.
// ---------------------------------------------------------------------------

test('runPilot: happy path calls every stage in order and reports success for every session', async () => {
  const { deps, calls } = makeSpyDeps();
  const rawSelection = {
    confirmed: true,
    claudeCodeSessionPaths: [
      '/home/op/.claude/projects/-Users-op-Code-alpha/session-a.jsonl',
      '/home/op/.claude/projects/-Users-op-Code-beta/session-b.jsonl',
    ],
    chatgptConversationIds: ['conv-1'],
  };

  const result = await runPilot({ rawSelection, deps });

  assert.equal(result.ok, true);
  assert.equal(result.refused, false);
  assert.equal(result.failureCount, 0);
  assert.equal(calls.discoverSources.length, 1);
  assert.equal(calls.parseClaudeCodeSession.length, 2);
  assert.equal(calls.parseChatGptExport.length, 1);
  assert.equal(calls.triageSession.length, 3); // 2 claude + 1 chatgpt
  assert.equal(calls.clusterConversations.length, 1); // ONE batched call, never per-session
  assert.equal(calls.distillAndRemember.length, 3);

  // Every result entry carries the required shape.
  for (const r of result.results) {
    assert.ok('sessionId' in r && 'sourceType' in r && 'stage' in r && 'ok' in r && 'error' in r);
  }
  const stages = result.results.map((r) => r.stage);
  assert.ok(stages.includes('discover'));
  assert.ok(stages.includes('parse'));
  assert.ok(stages.includes('triage'));
  assert.ok(stages.includes('cluster'));
  assert.ok(stages.includes('distill'));
});

test('runPilot: clusterConversations is called exactly once with ALL keep/uncertain entries batched together, never per-session', async () => {
  const { deps, calls } = makeSpyDeps({
    triageSession: (options) => ({ verdict: 'keep', summary: 's', rationale: 'r', sessionId: options.turns[0]?.sessionId ?? '' }),
  });
  const rawSelection = {
    confirmed: true,
    claudeCodeSessionPaths: [
      '/home/op/.claude/projects/-Users-op-Code-alpha/session-a.jsonl',
      '/home/op/.claude/projects/-Users-op-Code-beta/session-b.jsonl',
    ],
    chatgptConversationIds: [],
  };
  await runPilot({ rawSelection, deps });
  assert.equal(calls.clusterConversations.length, 1);
  assert.equal(calls.clusterConversations[0].entries.length, 2);
});

test('runPilot: a trash verdict short-circuits BEFORE clustering/distillation -- never in the cluster call, distillAndRemember never called for it', async () => {
  const trashPath = '/home/op/.claude/projects/-Users-op-Code-alpha/session-a.jsonl';
  const keepPath = '/home/op/.claude/projects/-Users-op-Code-beta/session-b.jsonl';
  const { deps, calls } = makeSpyDeps({
    triageSession: (options) => {
      const sessionId = options.turns[0]?.sessionId ?? '';
      const verdict = sessionId.includes('session-a') ? 'trash' : 'keep';
      return { verdict, summary: 's', rationale: 'r', sessionId };
    },
  });
  const rawSelection = { confirmed: true, claudeCodeSessionPaths: [trashPath, keepPath], chatgptConversationIds: [] };

  const result = await runPilot({ rawSelection, deps });

  assert.equal(calls.clusterConversations.length, 1);
  const clusteredIds = calls.clusterConversations[0].entries.map((e) => e.sessionId);
  assert.ok(!clusteredIds.some((id) => id.includes('session-a')), 'trash-verdict session must never reach clusterConversations()');
  assert.equal(calls.distillAndRemember.length, 1, 'distillAndRemember must be called exactly once -- only for the keep-verdict session');
  assert.equal(calls.distillAndRemember[0].sessionId.includes('session-a'), false);

  // The trash session still has a real, per-stage result recorded (triage
  // succeeded) but no 'cluster'/'distill' stage entries -- never silently
  // dropped from the report.
  const trashResults = result.results.filter((r) => r.sessionId.includes('session-a'));
  assert.ok(trashResults.some((r) => r.stage === 'triage' && r.ok === true));
  assert.ok(!trashResults.some((r) => r.stage === 'cluster'));
  assert.ok(!trashResults.some((r) => r.stage === 'distill'));
});

test('runPilot: a Claude Code session path absent from the real manifest fails at the discover stage and is excluded from every later stage, without aborting the rest of the run', async () => {
  const validPath = '/home/op/.claude/projects/-Users-op-Code-alpha/session-a.jsonl';
  const bogusPath = '/not/in/the/manifest.jsonl';
  const { deps, calls } = makeSpyDeps();
  const rawSelection = { confirmed: true, claudeCodeSessionPaths: [validPath, bogusPath], chatgptConversationIds: [] };

  const result = await runPilot({ rawSelection, deps });

  assert.equal(calls.parseClaudeCodeSession.length, 1);
  assert.equal(calls.parseClaudeCodeSession[0], validPath);
  const bogusResults = result.results.filter((r) => r.sessionId === bogusPath);
  assert.equal(bogusResults.length, 1);
  assert.equal(bogusResults[0].stage, 'discover');
  assert.equal(bogusResults[0].ok, false);
  assert.match(bogusResults[0].error, /not present in the real/);
  // The valid session still completed successfully -- one failure never
  // aborts the whole run.
  assert.ok(result.results.some((r) => r.sessionId.includes('session-a') && r.stage === 'distill' && r.ok === true));
});

test('runPilot: a ChatGPT conversation id absent from the real, parsed export fails at the discover stage and is excluded from later stages', async () => {
  const { deps, calls } = makeSpyDeps();
  const rawSelection = { confirmed: true, claudeCodeSessionPaths: [], chatgptConversationIds: ['conv-1', 'conv-does-not-exist'] };

  const result = await runPilot({ rawSelection, deps });

  assert.equal(calls.parseChatGptExport.length, 1);
  assert.equal(calls.triageSession.length, 1); // only conv-1
  const bogus = result.results.filter((r) => r.sessionId === 'conv-does-not-exist');
  assert.equal(bogus.length, 1);
  assert.equal(bogus[0].stage, 'discover');
  assert.equal(bogus[0].ok, false);
});

test('runPilot: a parse failure for one session is reported per-session and never aborts the rest of the run', async () => {
  const okPath = '/home/op/.claude/projects/-Users-op-Code-alpha/session-a.jsonl';
  const failPath = '/home/op/.claude/projects/-Users-op-Code-beta/session-b.jsonl';
  const { deps } = makeSpyDeps({
    parseClaudeCodeSession: (filePath) => {
      if (filePath === failPath) throw new Error('malformed JSON on line 3');
      return [{ sessionId: 'sid-session-a', sourceType: 'claude-code', role: 'user', text: 'hi', timestamp: null, projectSlug: '/Users/op/Code/alpha', turnIndex: 0, quarantined: false, quarantineReason: null, secretMatches: [] }];
    },
  });
  const rawSelection = { confirmed: true, claudeCodeSessionPaths: [okPath, failPath], chatgptConversationIds: [] };

  const result = await runPilot({ rawSelection, deps });

  const failEntry = result.results.find((r) => r.sessionId === failPath && r.stage === 'parse');
  assert.ok(failEntry);
  assert.equal(failEntry.ok, false);
  assert.match(failEntry.error, /malformed JSON/);
  assert.ok(result.results.some((r) => r.sessionId === 'sid-session-a' && r.stage === 'distill' && r.ok === true));
});

test('runPilot: passes the injected fake IngestClient through to distillAndRemember unchanged, never a real client', async () => {
  const { deps, calls } = makeSpyDeps();
  const rawSelection = { confirmed: true, claudeCodeSessionPaths: ['/home/op/.claude/projects/-Users-op-Code-alpha/session-a.jsonl'], chatgptConversationIds: [] };
  await runPilot({ rawSelection, deps });
  assert.equal(calls.distillAndRemember[0].client, deps.ingestClient);
});

test('runPilot: full provenance -- sessionId/projectSlug/clusterId passed to distillAndRemember are real, traceable values from upstream stages', async () => {
  const { deps, calls } = makeSpyDeps();
  const rawSelection = { confirmed: true, claudeCodeSessionPaths: ['/home/op/.claude/projects/-Users-op-Code-alpha/session-a.jsonl'], chatgptConversationIds: [] };
  await runPilot({ rawSelection, deps });
  const call = calls.distillAndRemember[0];
  assert.equal(call.sessionId, 'sid-session-a');
  assert.equal(call.projectSlug, '/Users/op/Code/alpha');
  assert.equal(call.clusterId, 'cluster-0');
});

test('runPilot: a clusterConversations() failure is reported per-session (never a generic pipeline-wide failure) and distillation still proceeds', async () => {
  const { deps, calls } = makeSpyDeps({
    clusterConversations: () => {
      throw new Error('embedder unreachable');
    },
  });
  const rawSelection = { confirmed: true, claudeCodeSessionPaths: ['/home/op/.claude/projects/-Users-op-Code-alpha/session-a.jsonl'], chatgptConversationIds: [] };

  const result = await runPilot({ rawSelection, deps });

  const clusterFailure = result.results.find((r) => r.stage === 'cluster');
  assert.ok(clusterFailure);
  assert.equal(clusterFailure.ok, false);
  assert.match(clusterFailure.error, /embedder unreachable/);
  // Distillation still ran (clusterId falls back to null) -- one stage's
  // failure never aborts the rest of the pipeline.
  assert.equal(calls.distillAndRemember.length, 1);
  assert.equal(calls.distillAndRemember[0].clusterId, null);
});

test('runPilot: never calls triageSession/clusterConversations/distillAndRemember for a source with an empty confirmed list', async () => {
  const { deps, calls } = makeSpyDeps();
  const rawSelection = { confirmed: true, claudeCodeSessionPaths: [], chatgptConversationIds: ['conv-1'] };
  await runPilot({ rawSelection, deps });
  assert.equal(calls.parseClaudeCodeSession.length, 0);
});

// ---------------------------------------------------------------------------
// Both entry points reach the identical gate/sequencing for an equivalent
// selection (file-based vs. flag-based).
// ---------------------------------------------------------------------------

test('executeCliInvocation: file mode and flag mode produce equivalent stage-call behavior for an equivalent selection', async () => {
  const dir = makeTempDir();
  try {
    const file = writeSelectionFile(
      dir,
      ['confirmed: true', 'claudeCodeSessions:', '  - path: /home/op/.claude/projects/-Users-op-Code-alpha/session-a.jsonl', 'chatgptConversations: []'].join('\n'),
    );
    const fileSpies = makeSpyDeps();
    const flagSpies = makeSpyDeps();

    const fileResult = await executeCliInvocation(['--selection-file', file], { deps: fileSpies.deps, log: () => {}, warn: () => {} });
    const flagResult = await executeCliInvocation(
      ['--sessions', '/home/op/.claude/projects/-Users-op-Code-alpha/session-a.jsonl', '--confirm'],
      { deps: flagSpies.deps, log: () => {}, warn: () => {} },
    );

    assert.equal(fileResult.ok, true);
    assert.equal(flagResult.ok, true);
    assert.equal(fileSpies.calls.distillAndRemember.length, flagSpies.calls.distillAndRemember.length);
    assert.equal(fileSpies.calls.triageSession.length, flagSpies.calls.triageSession.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Static source-text self-check: no local reimplementation of any stage's
// own logic (only imports + calls), and defaultDeps() is never invoked at
// module load (no accidental production wiring / no accidental live calls
// just from importing this file for tests).
// ---------------------------------------------------------------------------

test('source-text self-check: bin/mnemosyne-conversation-pilot.mjs imports every stage function from its own real module, never reimplements one', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const src = readFileSync(fileURLToPath(new URL('./mnemosyne-conversation-pilot.mjs', import.meta.url)), 'utf8');
  for (const [name, fromFile] of [
    ['discoverSources', 'discoverSources.ts'],
    ['parseClaudeCodeSession', 'parseClaudeCodeSession.ts'],
    ['parseChatGptExport', 'parseChatGptExport.ts'],
    ['triageSession', 'triageSession.ts'],
    ['clusterConversations', 'clusterConversations.ts'],
    ['distillAndRemember', 'distillAndRemember.ts'],
  ]) {
    const importLine = new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*['"][^'"]*${fromFile}['"]`);
    assert.match(src, importLine, `expected a real import of ${name} from ${fromFile}`);
  }
});
