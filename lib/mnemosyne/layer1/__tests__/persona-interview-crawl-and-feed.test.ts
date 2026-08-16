// persona-interview-crawl-and-feed.test.ts — pw-13-crawl-and-feed-wiring.
//
// The convergence point of pw-09 (resolveRememberScope, persona.ts) and
// pw-10/11/12 (interview-engine.mjs / persona-writer.mjs) -- this file
// proves skills/mnemosyne-persona-interview/persona-remember.mjs's
// `rememberInterviewSource()` actually fires a REAL `remember()` call
// through the real HTTP -> engine.mjs pipeline, scoped by pw-09's real
// resolver, and that a maximally-skipped interview (pw-12) still triggers
// one.
//
// "Real" here means: a real `src/server.mjs` HTTP server subprocess, a real
// `POST /remember` call (via a real `node bin/mnemosyne-skill-helper.mjs
// remember` subprocess -- SKILL.md step 8's documented transport), a real
// `engine.mjs` `remember()` invocation that writes a real note file to disk
// and shells a real `swarm-memory index` subprocess -- with ONLY the
// `swarm-memory` binary itself swapped for a test double
// (fixtures/fake-swarm-memory-pw13.mjs), via the exact same SWARM_MEMORY_BIN
// env-override seam test/write-through.mjs, test/reindex.mjs, and most of
// this repo's own test suite already use to avoid depending on live
// Qdrant/network infra. The real production config.toml has no `persona-*`
// scope lanes provisioned yet (design-discussion.md §8's documented, accepted
// "known operational caveat") -- this fixture's own `config` command
// provisions them for this suite only, never touching the real file.

import { execFile, spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { assertValidPersona, PERSONA_REMEMBER_SCOPE_BY_TIER, resolveRememberScope, type Persona } from '../persona.js';
// interview-engine.mjs / persona-writer.mjs / persona-remember.mjs are plain
// ESM JS (no TS types), imported by relative path exactly like the skill
// itself would load them -- vitest resolves .mjs fine (same convention as
// persona-interview-skill.test.ts / persona-interview-output.test.ts /
// persona-interview-skip-all-regression.test.ts's own imports).
// eslint-disable-next-line import/extensions
import { CORE_QUESTIONS, OPTIONAL_QUESTIONS, SKIP_PLACEHOLDER, runPersonaInterview } from '../../../../skills/mnemosyne-persona-interview/interview-engine.mjs';
// eslint-disable-next-line import/extensions
import { writePersonaViaCli } from '../../../../skills/mnemosyne-persona-interview/persona-writer.mjs';
// eslint-disable-next-line import/extensions
import { rememberInterviewSource, resolveRememberScopeViaCli } from '../../../../skills/mnemosyne-persona-interview/persona-remember.mjs';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SERVER_PATH = path.join(REPO_ROOT, 'src', 'server.mjs');
const FIXTURE_BIN = path.join(__dirname, 'fixtures', 'fake-swarm-memory-pw13');

const TEST_PORT = Number(process.env.MNEMOSYNE_PW13_TEST_PORT || 8541);
const ALL_QUESTION_IDS = [...CORE_QUESTIONS, ...OPTIONAL_QUESTIONS].map((q) => q.id);
const CORE_SECTION_HEADINGS = CORE_QUESTIONS.map((q) => q.sectionHeading);

const tempRoots: string[] = [];
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function waitForServer(url: string, timeoutMs = 15_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

// A single real src/server.mjs subprocess, shared across every test below --
// pointed at fake-swarm-memory-pw13.mjs (SWARM_MEMORY_BIN) and a throwaway
// notes dir (MNEMOSYNE_NOTES_DIR), so remember() calls really run the real
// HTTP -> engine.mjs -> subprocess -> note-file-on-disk pipeline without
// touching the real config.toml, real Qdrant, or the operator's real
// ~/.local/share/mnemosyne/notes.
let server: ChildProcessByStdio<null, Readable, Readable>;
let notesDir: string;

beforeAll(async () => {
  notesDir = await mkdtemp(path.join(tmpdir(), 'mnemosyne-pw13-notes-'));
  server = spawn(process.execPath, [SERVER_PATH], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      SWARM_MEMORY_BIN: FIXTURE_BIN,
      MNEMOSYNE_NOTES_DIR: notesDir,
      MNEMO_TEST_NODE: process.execPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOutput = '';
  server.stdout.on('data', (d: Buffer) => {
    serverOutput += d.toString();
  });
  server.stderr.on('data', (d: Buffer) => {
    serverOutput += d.toString();
  });
  const up = await waitForServer(`http://127.0.0.1:${TEST_PORT}/healthz`);
  if (!up) {
    throw new Error(`pw-13 test server did not come up on port ${TEST_PORT}. output so far:\n${serverOutput}`);
  }
}, 30_000);

afterAll(async () => {
  if (server && server.pid) {
    try {
      process.kill(server.pid);
    } catch {
      // already gone
    }
  }
  await rm(notesDir, { recursive: true, force: true }).catch(() => {});
});

/** Reads the real note file remember() wrote, for independent, on-disk confirmation the write actually landed. */
async function readNoteFile(filePath: string): Promise<string> {
  return readFile(filePath, 'utf8');
}

describe('pw-13: crawl-and-feed -- rememberInterviewSource() fires a REAL remember() call', () => {
  it('a completed interview, after being written via pw-11\'s writePersonaViaCli, triggers a real remember() call whose landing is independently confirmable on disk', async () => {
    const responses = {
      knows: 'This persona knows the mnemosyne repo\'s Layer 1 persona subsystem in depth.',
      not_hold: 'It does not hold company-wide financial or HR data.',
      parent: 'project-orchestrator/pw13-project',
      success: 'A code-architect persona that answers repo-specific questions accurately.',
      avoid: 'Never invents facts about other repos it has no visibility into.',
    };

    const { persona } = runPersonaInterview({
      tier: 'code-architect',
      scopeId: 'pw13-full-answers-repo',
      responses,
    });
    expect(() => assertValidPersona(persona as Persona, 'code-architect')).not.toThrow();

    // Step 1 (pw-11's real write primitive): a real `mnemosyne persona create` CLI subprocess.
    const repoRoot = await makeTempRoot('mnemosyne-pw13-write-');
    const writeResult = await writePersonaViaCli(persona, { repo: repoRoot });
    expect(writeResult.ok, `persona create failed: ${writeResult.stderr}`).toBe(true);
    expect(writeResult.writtenPath).toBeTruthy();

    // Step 2 (THE GAP THIS STORY CLOSES): the real crawl-and-feed remember() call.
    const rememberResult = await rememberInterviewSource(persona, { port: TEST_PORT });
    expect(rememberResult.ok, `remember() call failed: ${rememberResult.error} / stderr: ${rememberResult.stderr}`).toBe(true);
    expect(rememberResult.response?.remembered).toBe(true);
    expect(typeof rememberResult.chunksUpserted).toBe('number');
    expect(rememberResult.chunksUpserted).toBeGreaterThan(0);
    expect(rememberResult.file).toBeTruthy();

    // Independent confirmation it really landed: read the real note file
    // remember() wrote, off disk, outside rememberInterviewSource's own
    // response -- same "read the real artifact back" convention
    // test/write-through.mjs's AC4 and pw-12's read-back proofs already use.
    const noteContent = await readNoteFile(rememberResult.file as string);
    expect(noteContent).toContain('pw13-full-answers-repo');
    expect(noteContent).toContain('code-architect');
    expect(noteContent).toContain(`scope=${rememberResult.scope}`);
    expect(noteContent).toContain('This persona knows the mnemosyne repo\'s Layer 1 persona subsystem in depth.');
  });

  it("the remember() call's scope comes from resolveRememberScope() -- not a hardcoded/parallel scope decision", async () => {
    const { persona } = runPersonaInterview({
      tier: 'project-orchestrator',
      scopeId: 'pw13-scope-proof',
      responses: {
        knows: 'Coordinates the pw13-scope-proof project.',
        not_hold: 'Does not hold individual repo implementation detail.',
        parent: 'none',
      },
    });

    // The REAL, independent resolver -- imported straight from persona.ts,
    // not through this story's own helper -- computed for the SAME
    // {tier, scopeId} this interview used.
    const independentlyResolved = resolveRememberScope({ tier: persona.tier as Persona['tier'], scopeId: persona.scopeId });
    expect(independentlyResolved.scope).toBe(PERSONA_REMEMBER_SCOPE_BY_TIER['project-orchestrator']);

    // persona-remember.mjs's own resolver call (the real tsx subprocess --
    // proven separately below to be a genuine crossing into persona.ts, not
    // a parallel scheme).
    const viaHelper = await resolveRememberScopeViaCli(persona);
    expect(viaHelper.ok).toBe(true);
    expect(viaHelper.scope).toBe(independentlyResolved.scope);
    expect(viaHelper.tag).toBe(independentlyResolved.tag);

    // And the actual remember() call this story wires up uses THAT exact
    // scope value -- not a second, inline decision.
    const rememberResult = await rememberInterviewSource(persona, { port: TEST_PORT });
    expect(rememberResult.ok, `remember() call failed: ${rememberResult.error}`).toBe(true);
    expect(rememberResult.scope).toBe(independentlyResolved.scope);
    expect(rememberResult.tag).toBe(independentlyResolved.tag);
    expect(rememberResult.response?.scope).toBe(independentlyResolved.scope);
  });

  describe('a MAXIMALLY-SKIPPED interview still triggers a real remember() call (pw-12\'s exact skip-all pattern)', () => {
    it('global tier (top-orchestrator): every question explicitly skipped, still fires a real remember() call', async () => {
      // Identical skip-token pattern to pw-12's own top-orchestrator case
      // (persona-interview-skip-all-regression.test.ts) -- deliberately
      // varied tokens, no context, no displayName/scope override.
      const responses = {
        knows: 'skip',
        not_hold: 'N/A',
        parent: 'pass',
        success: '',
        avoid: 'NA',
      };

      const { persona, asked, skippedByContext, skippedCore, skippedOptional } = runPersonaInterview({
        tier: 'top-orchestrator',
        scopeId: 'pw13-max-skip-top',
        responses,
      });

      // Confirm this is genuinely max-skip, exactly like pw-12.
      expect(skippedByContext).toEqual([]);
      expect(asked).toEqual(ALL_QUESTION_IDS);
      expect(skippedCore).toEqual(['knows', 'not_hold', 'parent']);
      expect(skippedOptional).toEqual(['success', 'avoid']);
      expect(persona.sections).toHaveLength(3);
      expect(persona.sections.map((s) => s.heading)).toEqual(CORE_SECTION_HEADINGS);
      expect(persona.sections.every((s) => s.body === SKIP_PLACEHOLDER)).toBe(true);
      expect(() => assertValidPersona(persona as Persona, 'top-orchestrator')).not.toThrow();

      const fakeHome = await makeTempRoot('mnemosyne-pw13-max-skip-fakehome-');
      const writeResult = await writePersonaViaCli(persona, { home: fakeHome });
      expect(writeResult.ok, `persona create failed: ${writeResult.stderr}`).toBe(true);

      // THE RISK THIS STORY CALLS OUT: crawl-and-feed must NOT silently
      // no-op just because the interview was heavily skipped.
      const rememberResult = await rememberInterviewSource(persona, { port: TEST_PORT });
      expect(rememberResult.ok, `remember() call failed on a max-skip interview: ${rememberResult.error} / ${rememberResult.stderr}`).toBe(true);
      expect(rememberResult.response?.remembered).toBe(true);
      expect(rememberResult.scope).toBe(PERSONA_REMEMBER_SCOPE_BY_TIER['top-orchestrator']);
      expect(rememberResult.chunksUpserted).toBeGreaterThan(0);

      const noteContent = await readNoteFile(rememberResult.file as string);
      expect(noteContent).toContain('pw13-max-skip-top');
      expect(noteContent).toContain(SKIP_PLACEHOLDER);
    });

    it('code-architect (repo-local, --repo): every question explicitly skipped, still fires a real remember() call', async () => {
      // Identical skip-token pattern to pw-12's own code-architect case.
      const responses = {
        knows: 'SKIP',
        not_hold: '   ',
        parent: 'n/a',
        success: 'pass',
        avoid: 'skip',
      };

      const { persona, asked, skippedByContext, skippedCore, skippedOptional } = runPersonaInterview({
        tier: 'code-architect',
        scopeId: 'pw13-max-skip-repo',
        responses,
      });

      expect(skippedByContext).toEqual([]);
      expect(asked).toEqual(ALL_QUESTION_IDS);
      expect(skippedCore).toEqual(['knows', 'not_hold', 'parent']);
      expect(skippedOptional).toEqual(['success', 'avoid']);
      expect(persona.sections).toHaveLength(3);
      expect(persona.sections.every((s) => s.body === SKIP_PLACEHOLDER)).toBe(true);
      expect(() => assertValidPersona(persona as Persona, 'code-architect')).not.toThrow();

      const repoRoot = await makeTempRoot('mnemosyne-pw13-max-skip-repo-');
      const writeResult = await writePersonaViaCli(persona, { repo: repoRoot });
      expect(writeResult.ok, `persona create failed: ${writeResult.stderr}`).toBe(true);

      const rememberResult = await rememberInterviewSource(persona, { port: TEST_PORT });
      expect(rememberResult.ok, `remember() call failed on a max-skip interview: ${rememberResult.error} / ${rememberResult.stderr}`).toBe(true);
      expect(rememberResult.response?.remembered).toBe(true);
      expect(rememberResult.scope).toBe(PERSONA_REMEMBER_SCOPE_BY_TIER['code-architect']);
      expect(rememberResult.chunksUpserted).toBeGreaterThan(0);

      const noteContent = await readNoteFile(rememberResult.file as string);
      expect(noteContent).toContain('pw13-max-skip-repo');
      expect(noteContent).toContain(SKIP_PLACEHOLDER);
    });
  });

  it('persona-remember.mjs never invents a second remember()-scope mapping -- resolveRememberScopeViaCli genuinely crosses into persona.ts, not a hand-copied table', async () => {
    // Structural check, same convention as persona-interview-output.test.ts's
    // "never a second write path" checks: the module's own source must
    // reference the real resolver by name, not a locally re-derived map.
    const source = await readFile(
      path.join(REPO_ROOT, 'skills', 'mnemosyne-persona-interview', 'persona-remember.mjs'),
      'utf8',
    );
    expect(source).toContain('resolve-remember-scope');
    expect(source).not.toMatch(/PERSONA_REMEMBER_SCOPE_BY_TIER\s*=/);
    expect(source).not.toMatch(/'persona-top-orchestrator'\s*:/);
  });
});
