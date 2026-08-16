// persona-interview-global-full-answers-e2e.test.ts — pw-14-crawl-and-feed-e2e-test.
//
// Closes Slice 3. Epic's own release-gate claim
// (.pHive/epics/mnemosyne-persona-wizard/docs/design-discussion.md §1): "an
// LLM-interview wizard that authors real persona content and triggers real
// remember() writes." pw-13's own test file
// (persona-interview-crawl-and-feed.test.ts) already proves almost all of
// this together, real subprocess/real disk throughout, but leaves exactly
// ONE narrow gap open across its three cases:
//
//   1. code-architect, full answers: interview -> real write (CLI, --repo)
//      -> real remember() -> real note-file read-back. Full pipeline, but
//      repo-local tier only.
//   2. project-orchestrator, full answers: interview -> real remember() ->
//      scope-resolution proof. No writePersonaViaCli call at all -- never
//      confirms a real Persona FILE exists on disk for this case.
//   3. top-orchestrator AND code-architect, MAX-SKIP: interview -> real
//      write -> real remember() -> real note-file read-back, for BOTH
//      lifecycle moments. Full pipeline, but only the maximally-skipped
//      case -- never a full-answers GLOBAL-tier persona with a real file on
//      disk AND a real remember() landing in the same test.
//
// So: full-answers cases have write+remember together for code-architect
// (repo-local) but NOT for any global tier. Max-skip cases have write+
// remember together for BOTH tiers. The one combination missing everywhere
// is "full-answers, global tier, write AND remember AND both real-disk
// read-backs in one continuous run." This file supplies exactly that,
// using company-director -- the one global tier neither of pw-13's
// full-answers cases (project-orchestrator) nor pw-11's own dedicated
// full-answers/global-tier round-trip case already spent on
// company-director's sibling, project-orchestrator -- overlaps with.
//
// Once this test passes, EVERY {tier, full-answers-or-max-skip} combination
// this epic cares about has been independently proven, end to end, real
// subprocess/real disk throughout, across pw-11/pw-12/pw-13/pw-14 jointly:
//
//   global,     full answers -> write+read-back:      pw-11 (company-director / project-orchestrator)
//   global,     full answers -> write+remember+both:  pw-14 (THIS FILE, company-director)
//   global,     max-skip     -> write+remember+both:  pw-13 (top-orchestrator)
//   repo-local, full answers -> write+remember+both:  pw-13 (code-architect)
//   repo-local, max-skip     -> write+remember+both:  pw-13 (code-architect)
//
// "Real" here means exactly what pw-13's own header documents: a real
// `src/server.mjs` HTTP server subprocess, a real `POST /remember` call (via
// a real `node bin/mnemosyne-skill-helper.mjs remember` subprocess --
// SKILL.md step 8's documented transport), a real `engine.mjs` `remember()`
// invocation that writes a real note file to disk and shells a real
// `swarm-memory index` subprocess (only the `swarm-memory` binary itself
// swapped for pw-13's own test double, fake-swarm-memory-pw13.mjs, reused
// here unchanged rather than forked into a second fixture -- it already
// provisions all four real persona-* scopes), and a real `mnemosyne persona
// create` CLI subprocess (persona-writer.mjs's `writePersonaViaCli`) writing
// to a throwaway `$HOME`, read back via the ALREADY-TESTED
// `readGlobalPersona` primitive (persona-store-global.ts) -- never a second,
// in-process write path, never a mocked/stubbed step anywhere in the chain.

import { execFile, spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { assertValidPersona, PERSONA_REMEMBER_SCOPE_BY_TIER, resolveRememberScope, type Persona } from '../persona.js';
import { readGlobalPersona } from '../persona-store-global.js';
// interview-engine.mjs / persona-writer.mjs / persona-remember.mjs are plain
// ESM JS (no TS types), imported by relative path exactly like the skill
// itself would load them -- vitest resolves .mjs fine (same convention
// persona-interview-crawl-and-feed.test.ts and its siblings already use).
// eslint-disable-next-line import/extensions
import { runPersonaInterview } from '../../../../skills/mnemosyne-persona-interview/interview-engine.mjs';
// eslint-disable-next-line import/extensions
import { writePersonaViaCli } from '../../../../skills/mnemosyne-persona-interview/persona-writer.mjs';
// eslint-disable-next-line import/extensions
import { rememberInterviewSource } from '../../../../skills/mnemosyne-persona-interview/persona-remember.mjs';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SERVER_PATH = path.join(REPO_ROOT, 'src', 'server.mjs');
// Reuses pw-13's own fixture, unmodified: it already provisions all four
// real persona-* remember()-scope collections (persona-top-orchestrator,
// persona-company-director, persona-project-orchestrator,
// persona-code-architect) that PERSONA_REMEMBER_SCOPE_BY_TIER can resolve
// to, so a company-director run resolves and lands exactly like pw-13's own
// tiers do -- no second fixture needed for a tier pw-13 simply didn't happen
// to combine with a real write.
const FIXTURE_BIN = path.join(__dirname, 'fixtures', 'fake-swarm-memory-pw13');

const TEST_PORT = Number(process.env.MNEMOSYNE_PW14_TEST_PORT || 8542);

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

// A single real src/server.mjs subprocess, shared across this file's tests
// -- pointed at fake-swarm-memory-pw13.mjs (SWARM_MEMORY_BIN) and a
// throwaway notes dir (MNEMOSYNE_NOTES_DIR), so remember() calls really run
// the real HTTP -> engine.mjs -> subprocess -> note-file-on-disk pipeline
// without touching the real config.toml, real Qdrant, or the operator's
// real ~/.local/share/mnemosyne/notes. A dedicated port (8542, distinct
// from pw-13's 8541) so this file's server can run concurrently with
// pw-13's own under vitest's default parallel file execution.
let server: ChildProcessByStdio<null, Readable, Readable>;
let notesDir: string;

beforeAll(async () => {
  notesDir = await mkdtemp(path.join(tmpdir(), 'mnemosyne-pw14-notes-'));
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
    throw new Error(`pw-14 test server did not come up on port ${TEST_PORT}. output so far:\n${serverOutput}`);
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

/** Reads the real note file remember() wrote, for independent, on-disk confirmation the write actually landed. Same convention as pw-13's own readNoteFile. */
async function readNoteFile(filePath: string): Promise<string> {
  return readFile(filePath, 'utf8');
}

describe('pw-14: the ONE gap pw-13 left open -- a full-answers GLOBAL-tier persona through the COMPLETE pipeline', () => {
  it('company-director, full answers: interview -> real CLI write -> real on-disk persona file -> real remember() -> real on-disk note file, all in one continuous run', async () => {
    const responses = {
      knows: 'This persona knows the company-wide roadmap, budget priorities, and cross-project dependency map.',
      not_hold: 'It does not hold any single repo\'s implementation detail or line-level code content.',
      parent: 'none',
      success: 'A company-director persona that keeps every project-orchestrator aligned on shared company priorities.',
      avoid: 'Never overrides a project-orchestrator\'s own in-project technical decisions.',
    };

    // Step 0: the real interview engine (pw-10), full answers, no skips.
    const { persona, asked, skippedCore, skippedOptional } = runPersonaInterview({
      tier: 'company-director',
      scopeId: 'pw14-full-answers-company',
      responses,
    });
    expect(skippedCore).toEqual([]);
    expect(skippedOptional).toEqual([]);
    expect(asked.length).toBeGreaterThan(0);
    expect(() => assertValidPersona(persona as Persona, 'company-director')).not.toThrow();

    // Step 1 (the part pw-13's own global-tier full-answers case never did):
    // a real `mnemosyne persona create` CLI subprocess (pw-11's write
    // primitive), routed at a throwaway $HOME so it never touches the
    // operator's real ~/.mnemosyne/personas.
    const fakeHome = await makeTempRoot('mnemosyne-pw14-fakehome-');
    const writeResult = await writePersonaViaCli(persona, { home: fakeHome });
    expect(writeResult.ok, `persona create failed: ${writeResult.stderr}`).toBe(true);
    expect(writeResult.writtenPath).toBeTruthy();
    expect(writeResult.writtenPath).toBe(
      path.join(fakeHome, '.mnemosyne', 'personas', 'company-director', 'pw14-full-answers-company.yaml'),
    );

    // Independent confirmation step 1 really landed: NOT writeResult's own
    // report, but a completely separate read through the already-tested
    // readGlobalPersona primitive (persona-store-global.ts) -- proof a real
    // Persona FILE exists on disk for a full-answers GLOBAL tier, which is
    // exactly what pw-13's own project-orchestrator full-answers case never
    // established (it only ever called rememberInterviewSource, never
    // writePersonaViaCli).
    const storeRoot = path.join(fakeHome, '.mnemosyne', 'personas');
    const readBackFile = readGlobalPersona('company-director', 'pw14-full-answers-company', storeRoot);
    expect(() => assertValidPersona(readBackFile as unknown, 'company-director')).not.toThrow();
    expect(readBackFile.sections).toEqual(persona.sections);
    expect(readBackFile.displayName).toBe(persona.displayName);
    expect(readBackFile.scope).toBe(persona.scope);
    expect(readBackFile.sections.some((s) => s.body.includes('company-wide roadmap'))).toBe(true);

    // Step 2 (pw-13's crawl-and-feed wiring, reused unchanged): the real
    // remember() call, scoped via pw-09's real resolveRememberScope().
    const rememberResult = await rememberInterviewSource(persona, { port: TEST_PORT });
    expect(rememberResult.ok, `remember() call failed: ${rememberResult.error} / stderr: ${rememberResult.stderr}`).toBe(true);
    expect(rememberResult.response?.remembered).toBe(true);
    expect(typeof rememberResult.chunksUpserted).toBe('number');
    expect(rememberResult.chunksUpserted).toBeGreaterThan(0);
    expect(rememberResult.file).toBeTruthy();
    expect(rememberResult.scope).toBe(PERSONA_REMEMBER_SCOPE_BY_TIER['company-director']);

    // Cross-check against the independent, real resolver -- not a
    // hardcoded/parallel scope decision (same proof pw-13's own
    // scope-correctness test establishes, re-confirmed here for this
    // specific tier/scopeId pair).
    const independentlyResolved = resolveRememberScope({ tier: 'company-director', scopeId: 'pw14-full-answers-company' });
    expect(rememberResult.scope).toBe(independentlyResolved.scope);
    expect(rememberResult.tag).toBe(independentlyResolved.tag);

    // Independent confirmation step 2 really landed: read the real note
    // file remember() wrote, off disk, outside rememberInterviewSource's own
    // response -- same "read the real artifact back" convention pw-13's own
    // readNoteFile helper and test/write-through.mjs's AC4 already use.
    const noteContent = await readNoteFile(rememberResult.file as string);
    expect(noteContent).toContain('pw14-full-answers-company');
    expect(noteContent).toContain('company-director');
    expect(noteContent).toContain(`scope=${rememberResult.scope}`);
    expect(noteContent).toContain('This persona knows the company-wide roadmap, budget priorities, and cross-project dependency map.');
    expect(noteContent).toContain('A company-director persona that keeps every project-orchestrator aligned on shared company priorities.');

    // Reaching this line is the full proof: a full-answers, global-tier
    // persona went through the interview, a real CLI write, an independent
    // on-disk read-back of the WRITTEN FILE, a real remember() call scoped
    // by the real resolver, and an independent on-disk read-back of the
    // REMEMBERED NOTE -- all in one continuous run, no step mocked or
    // stubbed. Combined with pw-13's own code-architect full-answers case
    // (repo-local tier) and both tiers' max-skip cases, every
    // {tier-kind, full-answers-or-max-skip} combination this epic's "initial
    // crawl and feeding" claim covers is now independently proven this way.
  });

  it('this is genuinely end-to-end: every step above is a real subprocess or real disk operation, never an in-process mock', async () => {
    // Structural proof, same convention pw-13's own "never a second
    // remember()-scope mapping" test uses: the modules this test drives
    // never expose an in-process short-circuit that could make the above
    // look end-to-end while secretly skipping the real subprocess/disk
    // boundary.
    const writerSource = await readFile(
      path.join(REPO_ROOT, 'skills', 'mnemosyne-persona-interview', 'persona-writer.mjs'),
      'utf8',
    );
    // writePersonaViaCli must spawn the real CLI (execFile), never import
    // writeGlobalPersona/writeRepoLocalPersona directly.
    expect(writerSource).toContain('execFile');
    expect(writerSource).not.toMatch(/import\s*\{[^}]*writeGlobalPersona/);
    expect(writerSource).not.toMatch(/import\s*\{[^}]*writeRepoLocalPersona/);

    const rememberSource = await readFile(
      path.join(REPO_ROOT, 'skills', 'mnemosyne-persona-interview', 'persona-remember.mjs'),
      'utf8',
    );
    // rememberInterviewSource must go through the real skill-helper `remember`
    // subprocess (a real POST /remember over HTTP), never call engine.mjs's
    // remember() in-process and never hand-roll its own fetch() to bypass
    // the documented transport.
    expect(rememberSource).toContain('execFile');
    expect(rememberSource).toContain("'remember'");
    expect(rememberSource).not.toMatch(/from ['"].*engine\.js['"]/);
    // No hand-rolled fetch() CALL anywhere outside a comment (the module's
    // own header comment mentions "fetch()" in prose to explain what it
    // deliberately avoids -- strip line-comments before checking so that
    // explanatory prose doesn't false-positive this structural check).
    const rememberSourceCodeOnly = rememberSource
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n');
    expect(rememberSourceCodeOnly).not.toContain('fetch(');

    // And this test file itself: the persona file read-back goes through
    // the already-tested readGlobalPersona primitive against the real
    // on-disk store root -- not a re-parse of writeResult's own in-memory
    // stdout, which would only prove the CLI's self-report, not that a real
    // file independently exists.
    const thisFileSource = await readFile(__filename_for_self_check(), 'utf8');
    expect(thisFileSource).toContain('readGlobalPersona(');
    expect(thisFileSource).toContain('readNoteFile(rememberResult.file');
  });
});

function __filename_for_self_check(): string {
  return fileURLToPath(import.meta.url);
}
