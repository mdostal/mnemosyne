// persona-interview-draft-output.test.ts — pu-08-draft-first-interview-flow.
//
// TDD coverage for pu-08's two write-target paths off the interview skill's
// step 7:
//
//   - DEFAULT (draft-first): the skill now calls pu-04's `mnemosyne persona
//     draft propose` (never `persona create`) via this story's new
//     `persona-draft-writer.mjs`, attaching `proposedBy`/`proposedAt`/pu-07's
//     `sourceSummary` as draft-only metadata. Proven here via a DIRECT
//     FILESYSTEM READ (persona-draft-store.ts's own `readDraftPersona`)
//     confirming an ACTIVE DRAFT exists, AND that the real persona store
//     (`writeGlobalPersona`/`writeRepoLocalPersona`'s own on-disk targets)
//     was NOT touched. A structural describe block below additionally proves
//     `persona-draft-writer.mjs` never imports the real write primitives, nor
//     `persona-writer.mjs`'s `writePersonaViaCli` / `persona-remember.mjs`'s
//     `rememberInterviewSource` -- the default path literally cannot call
//     `persona create` or fire `remember()`, by construction.
//
//   - `--commit-directly` (the escape hatch): reproduces the EXACT pre-ticket
//     behavior -- `persona-writer.mjs`'s `writePersonaViaCli` (`persona
//     create`) immediately followed by `persona-remember.mjs`'s
//     `rememberInterviewSource` (unconditional `remember()`), fired together
//     in sequence, exactly as the wizard epic's own
//     persona-interview-output.test.ts / persona-interview-crawl-and-feed.test.ts
//     already prove independently. This file does not modify either of those
//     two test files -- they are re-run unmodified as part of this story's
//     own verification (see the story's acceptance criteria) -- it only adds
//     a NEW combined-flow proof that firing both together, as the flagged
//     path does, still produces the identical outcome.
//
// persona-writer.mjs and persona-remember.mjs themselves have ZERO diff from
// their pre-ticket state (confirmed via `git diff` as part of this story's
// review step, not re-asserted here) -- this file exercises them UNCHANGED.

import { existsSync, readFileSync } from 'node:fs';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { assertValidPersona, type Persona } from '../persona.js';
import { readGlobalPersona } from '../persona-store-global.js';
import { readRepoLocalPersona } from '../persona-store-repo-local.js';
import { readDraftPersona } from '../persona-draft-store.js';
// interview-engine.mjs / persona-writer.mjs / persona-remember.mjs /
// persona-draft-writer.mjs are plain ESM JS (no TS types), imported by
// relative path exactly like the skill itself would load them -- same
// convention persona-interview-output.test.ts and
// persona-interview-crawl-and-feed.test.ts already use.
// eslint-disable-next-line import/extensions
import { runPersonaInterview } from '../../../../skills/mnemosyne-persona-interview/interview-engine.mjs';
// eslint-disable-next-line import/extensions
import { writePersonaViaCli } from '../../../../skills/mnemosyne-persona-interview/persona-writer.mjs';
// eslint-disable-next-line import/extensions
import { rememberInterviewSource } from '../../../../skills/mnemosyne-persona-interview/persona-remember.mjs';
// eslint-disable-next-line import/extensions
import {
  personaToDraftCandidate,
  writeDraftPersonaViaCli,
} from '../../../../skills/mnemosyne-persona-interview/persona-draft-writer.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SERVER_PATH = path.join(REPO_ROOT, 'src', 'server.mjs');
const FIXTURE_BIN = path.join(__dirname, 'fixtures', 'fake-swarm-memory-pw13');
const PERSONA_DRAFT_WRITER_PATH = path.resolve(
  __dirname,
  '../../../../skills/mnemosyne-persona-interview/persona-draft-writer.mjs',
);

// A dedicated port, distinct from pw-13's 8541 and pw-14's 8542, so this
// file's server can run concurrently with both under the full suite
// (vitest.config.ts's own file-parallelism note: fixed-port collisions
// produce spurious failures unrelated to any real regression).
const TEST_PORT = Number(process.env.MNEMOSYNE_PU08_TEST_PORT || 8543);

const tempRoots: string[] = [];
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

describe('pu-08: default (draft-first) path -- writeDraftPersonaViaCli proposes a draft, never touches the real store', () => {
  it('global tier: proposes an active draft with proposedBy/proposedAt/sourceSummary, and the real global persona store is untouched', async () => {
    const fakeHome = await makeTempRoot('mnemosyne-pu08-draft-global-fakehome-');

    const { persona } = runPersonaInterview({
      tier: 'company-director',
      scopeId: 'pu08-draft-global-scope',
      responses: {
        knows: 'PU08_DRAFT_KNOWS_MARKER — the company mission and org chart.',
        not_hold: 'PU08_DRAFT_NOT_HOLD_MARKER — repo-level implementation detail.',
        parent: 'none',
      },
    });

    const sourceSummary = 'PU08_SOURCE_SUMMARY_MARKER — bounded crawl of README + package.json.';
    const proposedAt = '2026-01-01T00:00:00.000Z';

    const result = await writeDraftPersonaViaCli(persona, { home: fakeHome, sourceSummary, proposedAt });
    expect(result.ok, `draft propose failed: ${result.stderr}`).toBe(true);
    expect(result.writtenPath).toBeTruthy();
    expect(result.writtenPath).toContain(path.join('company-director', 'pu08-draft-global-scope.yaml'));
    expect(result.stdout).toMatch(/^proposed draft/);
    expect(result.stdout).not.toMatch(/^created /);

    // Direct filesystem read confirming an ACTIVE DRAFT exists.
    const draftRoot = path.join(fakeHome, '.mnemosyne', 'persona-drafts');
    const draft = readDraftPersona('company-director', 'pu08-draft-global-scope', { draftRoot });
    expect(draft.proposedBy).toBe('agent');
    expect(draft.proposedAt).toBe(proposedAt);
    expect(draft.sourceSummary).toBe(sourceSummary);
    expect(draft.displayName).toBe(persona.displayName);
    expect(draft.sections).toEqual(persona.sections);

    // The real persona store (writeGlobalPersona's own on-disk target) was NOT touched.
    const realStoreRoot = path.join(fakeHome, '.mnemosyne', 'personas');
    expect(existsSync(path.join(realStoreRoot, 'company-director', 'pu08-draft-global-scope.yaml'))).toBe(false);
    expect(() => readGlobalPersona('company-director', 'pu08-draft-global-scope', realStoreRoot)).toThrow();
  });

  it('code-architect (repo-local) tier: proposes an active draft via --repo, and the real repo-local persona store is untouched', async () => {
    const repoRoot = await makeTempRoot('mnemosyne-pu08-draft-repo-');
    const fakeHome = await makeTempRoot('mnemosyne-pu08-draft-repo-fakehome-');

    const { persona } = runPersonaInterview({
      tier: 'code-architect',
      scopeId: 'pu08-draft-repo-scope',
      responses: {
        knows: "PU08_DRAFT_REPO_KNOWS_MARKER — this repo's module boundaries.",
        not_hold: 'PU08_DRAFT_REPO_NOT_HOLD_MARKER — company-wide business context.',
        parent: 'project-orchestrator/pu08-draft-parent',
      },
    });

    const sourceSummary = 'PU08_DRAFT_REPO_SOURCE_SUMMARY_MARKER';
    const result = await writeDraftPersonaViaCli(persona, { repo: repoRoot, home: fakeHome, sourceSummary });
    expect(result.ok, `draft propose failed: ${result.stderr}`).toBe(true);
    expect(result.writtenPath).toBeTruthy();

    const draftRoot = path.join(fakeHome, '.mnemosyne', 'persona-drafts');
    const draft = readDraftPersona('code-architect', 'pu08-draft-repo-scope', { repoRoot, draftRoot });
    expect(draft.proposedBy).toBe('agent');
    expect(typeof draft.proposedAt).toBe('string');
    expect(draft.sourceSummary).toBe(sourceSummary);
    expect(draft.parentRefs).toEqual([{ tier: 'project-orchestrator', scopeId: 'pu08-draft-parent' }]);
    expect(draft.sections).toEqual(persona.sections);

    // The real repo-local persona store was NOT touched.
    expect(existsSync(path.join(repoRoot, '.mnemosyne', 'personas', 'pu08-draft-repo-scope.yaml'))).toBe(false);
    expect(() => readRepoLocalPersona(repoRoot, 'pu08-draft-repo-scope')).toThrow();
  });

  it('proposedBy defaults to "agent" and proposedAt defaults to a real ISO timestamp when not supplied; sourceSummary stays omitted when absent', () => {
    const { persona } = runPersonaInterview({
      tier: 'top-orchestrator',
      scopeId: 'pu08-draft-defaults',
      responses: { knows: 'x', not_hold: 'y', parent: 'none' },
    });

    const before = Date.now();
    const candidate = personaToDraftCandidate(persona);
    const after = Date.now();

    expect(candidate.proposedBy).toBe('agent');
    expect(candidate.sourceSummary).toBeUndefined();
    const parsedTime = Date.parse(candidate.proposedAt);
    expect(parsedTime).toBeGreaterThanOrEqual(before);
    expect(parsedTime).toBeLessThanOrEqual(after);
  });
});

describe('pu-08: the default path never calls persona create or remember() -- structural proof', () => {
  const source = readFileSync(PERSONA_DRAFT_WRITER_PATH, 'utf8');
  // Only the real `import ... from '...'` statements matter -- the module's
  // own doc comments legitimately NAME writeGlobalPersona/writeRepoLocalPersona/
  // writePersonaViaCli/rememberInterviewSource in prose (explaining exactly
  // why it does NOT call them), so a bare substring match over the whole file
  // would false-positive on that prose. Strip to import lines first, same
  // convention persona-interview-output.test.ts's own structural block uses.
  const importLines = source
    .split('\n')
    .filter((line) => /^\s*import\b/.test(line))
    .join('\n');

  it('persona-draft-writer.mjs never imports writeGlobalPersona/writeRepoLocalPersona directly', () => {
    expect(importLines).not.toMatch(/writeGlobalPersona/);
    expect(importLines).not.toMatch(/writeRepoLocalPersona/);
    expect(importLines).not.toMatch(/from ['"].*persona-store-(global|repo-local)/);
  });

  it('persona-draft-writer.mjs never imports persona-writer.mjs\'s writePersonaViaCli or persona-remember.mjs\'s rememberInterviewSource', () => {
    expect(importLines).not.toMatch(/writePersonaViaCli/);
    expect(importLines).not.toMatch(/rememberInterviewSource/);
    expect(importLines).not.toMatch(/from ['"].*persona-writer/);
    expect(importLines).not.toMatch(/from ['"].*persona-remember/);
  });

  it('persona-draft-writer.mjs writes drafts exclusively by spawning the real bin/mnemosyne-persona.mjs CLI\'s draft propose subcommand', () => {
    expect(source).toMatch(/PERSONA_CLI/);
    expect(source).toMatch(/bin\/mnemosyne-persona\.mjs/);
    expect(source).toMatch(/execFile/);
    expect(source).toContain("args = ['draft', 'propose'");
  });

  it('the only writeFile call in persona-draft-writer.mjs targets a scratch tmpdir input file, not a persona-store or draft-store path', () => {
    expect(source).not.toMatch(/globalPersonaPath/);
    expect(source).not.toMatch(/repoLocalPersonaPath/);
    expect(source).not.toMatch(/draftPersonaPath/);
  });
});

describe("pu-08: --commit-directly reproduces the exact pre-ticket behavior -- writePersonaViaCli + rememberInterviewSource fire together, unconditionally", () => {
  // A single real src/server.mjs subprocess, shared across every test below --
  // identical fixture wiring to persona-interview-crawl-and-feed.test.ts's
  // own beforeAll (pointed at fake-swarm-memory-pw13.mjs and a throwaway
  // notes dir), on a different port so the two files' suites never collide
  // when run together.
  let server: ChildProcessByStdio<null, Readable, Readable>;
  let notesDir: string;

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

  beforeAll(async () => {
    notesDir = await mkdtemp(path.join(tmpdir(), 'mnemosyne-pu08-notes-'));
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
      throw new Error(`pu-08 test server did not come up on port ${TEST_PORT}. output so far:\n${serverOutput}`);
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

  it('a full-answers interview: commits via the unchanged CLI create path AND fires remember(), producing an on-disk note -- matching the pre-ticket write+remember contract', async () => {
    const repoRoot = await makeTempRoot('mnemosyne-pu08-commit-directly-');

    const { persona } = runPersonaInterview({
      tier: 'code-architect',
      scopeId: 'pu08-commit-directly-repo',
      responses: {
        knows: "PU08_COMMIT_KNOWS_MARKER — this repo's module boundaries.",
        not_hold: 'PU08_COMMIT_NOT_HOLD_MARKER — company-wide business context.',
        parent: 'project-orchestrator/pu08-commit-parent',
      },
    });
    expect(() => assertValidPersona(persona as Persona, 'code-architect')).not.toThrow();

    // --commit-directly's step 7: the UNCHANGED persona-writer.mjs write primitive (persona create).
    const writeResult = await writePersonaViaCli(persona, { repo: repoRoot });
    expect(writeResult.ok, `persona create failed: ${writeResult.stderr}`).toBe(true);
    expect(writeResult.writtenPath).toBe(
      path.join(repoRoot, '.mnemosyne', 'personas', 'pu08-commit-directly-repo.yaml'),
    );

    const readBack = readRepoLocalPersona(repoRoot, 'pu08-commit-directly-repo');
    expect(() => assertValidPersona(readBack as unknown, 'code-architect')).not.toThrow();
    expect(readBack.sections).toEqual(persona.sections);
    expect(readBack.parentRefs).toEqual([{ tier: 'project-orchestrator', scopeId: 'pu08-commit-parent' }]);

    // --commit-directly's step 8: the UNCHANGED persona-remember.mjs firing,
    // unconditionally, immediately after the commit -- exactly like the
    // pre-ticket skill's own step 8.
    const rememberResult = await rememberInterviewSource(persona, { port: TEST_PORT });
    expect(rememberResult.ok, `remember() call failed: ${rememberResult.error} / ${rememberResult.stderr}`).toBe(true);
    expect(rememberResult.response?.remembered).toBe(true);
    expect(rememberResult.chunksUpserted).toBeGreaterThan(0);
    expect(rememberResult.file).toBeTruthy();

    const noteContent = await readFile(rememberResult.file as string, 'utf8');
    expect(noteContent).toContain('pu08-commit-directly-repo');
    expect(noteContent).toContain('code-architect');
    expect(noteContent).toContain("PU08_COMMIT_KNOWS_MARKER — this repo's module boundaries.");
  });

  it('a MAXIMALLY-SKIPPED interview still fires remember() unconditionally on --commit-directly, same as the pre-ticket skip-all guarantee', async () => {
    const fakeHome = await makeTempRoot('mnemosyne-pu08-commit-directly-max-skip-fakehome-');

    const { persona } = runPersonaInterview({
      tier: 'top-orchestrator',
      scopeId: 'pu08-commit-directly-max-skip',
      responses: {
        knows: 'skip',
        not_hold: 'N/A',
        parent: 'pass',
        success: '',
        avoid: 'NA',
      },
    });
    expect(() => assertValidPersona(persona as Persona, 'top-orchestrator')).not.toThrow();

    const writeResult = await writePersonaViaCli(persona, { home: fakeHome });
    expect(writeResult.ok, `persona create failed: ${writeResult.stderr}`).toBe(true);

    const rememberResult = await rememberInterviewSource(persona, { port: TEST_PORT });
    expect(
      rememberResult.ok,
      `remember() call failed on a max-skip --commit-directly run: ${rememberResult.error} / ${rememberResult.stderr}`,
    ).toBe(true);
    expect(rememberResult.response?.remembered).toBe(true);
    expect(rememberResult.chunksUpserted).toBeGreaterThan(0);
  });
});
