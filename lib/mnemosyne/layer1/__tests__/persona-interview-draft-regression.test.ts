// persona-interview-draft-regression.test.ts — pu-09-draft-first-regression.
//
// The epic's own backstop against silently regressing already-shipped
// wizard-epic behavior while pu-08 changed the interview skill's DEFAULT
// write target from `persona create` to `persona draft propose`. This file
// is deliberately NOT a re-test of pu-08's own mechanics (that's
// persona-interview-draft-output.test.ts's job, already merged) -- it is an
// INDEPENDENT regression proof, reusing the wizard epic's own real fixtures
// verbatim wherever a direct comparison is required, per this story's own
// design-decision ("a comparison against a fresh, superficially-similar
// fixture risks passing even if --commit-directly has subtly drifted from
// true byte-for-byte pre-epic behavior").
//
// Five cases, one per this story's acceptance criteria:
//   1. NO flag, full-answers: an ACTIVE DRAFT exists at the correct
//      home-rooted path; the real persona store (global AND repo-local) is
//      untouched.
//   2. --commit-directly, using persona-interview-output.test.ts's OWN
//      full-answers company-director ("pw11-full-co") fixture verbatim: the
//      committed file is byte-for-byte identical (modulo timestamps) to what
//      that pre-existing test already proves for those inputs.
//   3. NO flag, pw-12's exact max-skip token pattern
//      (persona-interview-skip-all-regression.test.ts): still produces a
//      valid, reviewable ACTIVE DRAFT -- the non-blocking hard-fail rule
//      extended to the draft-propose path.
//   4. --commit-directly, the SAME pw-12 max-skip fixtures: reproduces
//      pw-12's own already-proven max-skip-still-valid behavior exactly,
//      unchanged.
//   5. (Not a describe block below -- a real, separately-run vitest
//      invocation covering this file plus the wizard epic's three files plus
//      pu-02/pu-07/pu-08's own vitest files. See this story's verification
//      notes for the actual command and pass counts; a single test file
//      cannot assert "another file, run together, passes" from inside
//      itself.)

import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertValidPersona, type Persona } from '../persona.js';
import { readGlobalPersona } from '../persona-store-global.js';
import { readRepoLocalPersona } from '../persona-store-repo-local.js';
import { draftPersonaPath, readDraftPersona } from '../persona-draft-store.js';
// interview-engine.mjs / persona-writer.mjs / persona-draft-writer.mjs are
// plain ESM JS (no TS types), imported by relative path exactly like the
// skill itself would load them -- same convention every other
// persona-interview-*.test.ts file in this directory already uses.
// eslint-disable-next-line import/extensions
import {
  CORE_QUESTIONS,
  OPTIONAL_QUESTIONS,
  SKIP_PLACEHOLDER,
  runPersonaInterview,
} from '../../../../skills/mnemosyne-persona-interview/interview-engine.mjs';
// eslint-disable-next-line import/extensions
import {
  personaToYaml,
  showPersonaViaCli,
  writePersonaViaCli,
} from '../../../../skills/mnemosyne-persona-interview/persona-writer.mjs';
// eslint-disable-next-line import/extensions
import { writeDraftPersonaViaCli } from '../../../../skills/mnemosyne-persona-interview/persona-draft-writer.mjs';

const ALL_QUESTION_IDS = [...CORE_QUESTIONS, ...OPTIONAL_QUESTIONS].map((q: { id: string }) => q.id);

const tempRoots: string[] = [];
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

/** "modulo timestamps" -- no timestamp field exists in this schema today (confirmed by grep across the write path), but this keeps the byte comparison load-bearing even if one is ever added, rather than silently starting to fail on an unrelated future change. */
function stripTimestamps(s: string): string {
  return s.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<TIMESTAMP>');
}

describe('pu-09 case 1: default path (NO flag) -- full-answers interview produces an ACTIVE DRAFT, real persona store untouched', () => {
  it('global tier (project-orchestrator, pw-11\'s own "pw11-full-project" fixture): draft exists at the correct home-rooted path; the real global store is untouched', async () => {
    const fakeHome = await makeTempRoot('mnemosyne-pu09-draft-fullanswers-global-fakehome-');

    // Identical fixture to persona-interview-output.test.ts's
    // "writes and reads back a global-tier persona entirely through
    // $HOME-scoped CLI subprocesses" test -- reused for a different purpose
    // here (the draft-propose path), not reinvented.
    const { persona } = runPersonaInterview({
      tier: 'project-orchestrator',
      scopeId: 'pw11-full-project',
      displayName: 'Project Orchestrator — PW11 Project',
      scope: 'Cross-repo coordination for the PW11 project only.',
      responses: {
        knows: 'PW11_SHOW_KNOWS_MARKER — the active repo roster.',
        not_hold: 'PW11_SHOW_NOT_HOLD_MARKER — per-repo implementation detail.',
        parent: { tier: 'company-director', scopeId: 'pw11-full-co' },
      },
    });
    expect(() => assertValidPersona(persona as Persona, 'project-orchestrator')).not.toThrow();

    // NO --commit-directly flag: writeDraftPersonaViaCli is this path's own
    // write primitive (pu-08's default), never writePersonaViaCli.
    const result = await writeDraftPersonaViaCli(persona, { home: fakeHome });
    expect(result.ok, `draft propose failed: ${result.stderr}`).toBe(true);

    // A REAL filesystem check (existsSync against the draft store's own
    // path-resolution function), not just a successful subprocess exit code.
    const draftRoot = path.join(fakeHome, '.mnemosyne', 'persona-drafts');
    const expectedDraftPath = draftPersonaPath('project-orchestrator', 'pw11-full-project', { draftRoot });
    expect(existsSync(expectedDraftPath)).toBe(true);
    expect(expectedDraftPath.startsWith(fakeHome)).toBe(true); // home-rooted

    const draft = readDraftPersona('project-orchestrator', 'pw11-full-project', { draftRoot });
    expect(draft.displayName).toBe(persona.displayName);
    expect(draft.sections).toEqual(persona.sections);
    expect(draft.parentRefs).toEqual([{ tier: 'company-director', scopeId: 'pw11-full-co' }]);

    // NO side-effect write to the real persona store -- neither the global
    // store (the tier under test) nor the repo-local store (not applicable
    // to this tier, checked anyway per this AC's explicit "global or
    // repo-local" wording).
    const realGlobalStoreRoot = path.join(fakeHome, '.mnemosyne', 'personas');
    expect(existsSync(path.join(realGlobalStoreRoot, 'project-orchestrator', 'pw11-full-project.yaml'))).toBe(false);
    expect(() => readGlobalPersona('project-orchestrator', 'pw11-full-project', realGlobalStoreRoot)).toThrow();
    expect(existsSync(realGlobalStoreRoot)).toBe(false);
  });

  it('code-architect (repo-local, pw-10\'s own "mnemosyne" full-answers fixture): draft exists at the correct home-rooted path (never inside the repo); the real repo-local store is untouched', async () => {
    const repoRoot = await makeTempRoot('mnemosyne-pu09-draft-fullanswers-repo-');
    const fakeHome = await makeTempRoot('mnemosyne-pu09-draft-fullanswers-repo-fakehome-');

    // Identical fixture to persona-interview-skill.test.ts's "full-answers
    // run" describe block.
    const { persona } = runPersonaInterview({
      tier: 'code-architect',
      scopeId: 'mnemosyne',
      displayName: 'Code/Area Architect — mnemosyne',
      scope: 'Deep per-repo implementation detail for the mnemosyne repo only.',
      responses: {
        knows: 'The Layer 1 persona schema, the two-store split, and the interview skill mechanics.',
        not_hold: 'Company-wide business context or other repos\' implementation detail.',
        parent: 'project-orchestrator/mnemosyne-project',
        success: 'The interview produces a valid, writable persona every time.',
        avoid: 'Guessing at answers the operator never gave.',
      },
    });
    expect(() => assertValidPersona(persona as Persona, 'code-architect')).not.toThrow();

    const result = await writeDraftPersonaViaCli(persona, { repo: repoRoot, home: fakeHome });
    expect(result.ok, `draft propose failed: ${result.stderr}`).toBe(true);

    const draftRoot = path.join(fakeHome, '.mnemosyne', 'persona-drafts');
    const expectedDraftPath = draftPersonaPath('code-architect', 'mnemosyne', { repoRoot, draftRoot });
    expect(existsSync(expectedDraftPath)).toBe(true);
    // Home-rooted -- NEVER inside the consuming repo's own working tree
    // (persona-draft-store.ts's own design-discussion.md §3b rationale).
    expect(expectedDraftPath.startsWith(fakeHome)).toBe(true);
    expect(expectedDraftPath.startsWith(repoRoot)).toBe(false);

    const draft = readDraftPersona('code-architect', 'mnemosyne', { repoRoot, draftRoot });
    expect(draft.displayName).toBe(persona.displayName);
    expect(draft.sections).toEqual(persona.sections);
    expect(draft.parentRefs).toEqual([{ tier: 'project-orchestrator', scopeId: 'mnemosyne-project' }]);

    // NO side-effect write to the real repo-local persona store, nor the real
    // global store (this AC's "global or repo-local" -- both checked).
    expect(existsSync(path.join(repoRoot, '.mnemosyne', 'personas', 'mnemosyne.yaml'))).toBe(false);
    expect(() => readRepoLocalPersona(repoRoot, 'mnemosyne')).toThrow();
    expect(existsSync(path.join(fakeHome, '.mnemosyne', 'personas'))).toBe(false);
  });
});

describe('pu-09 case 2: --commit-directly reproduces persona-interview-output.test.ts\'s OWN full-answers fixture byte-for-byte', () => {
  it('the committed file is byte-for-byte identical (modulo timestamps) to what pw-11\'s own "pw11-full-co" test already proves for these exact inputs', async () => {
    const storeRoot = await makeTempRoot('mnemosyne-pu09-commit-directly-byte-for-byte-');

    // VERBATIM fixture from persona-interview-output.test.ts's first `it`
    // block ("writes a global-tier persona via the CLI subprocess and reads
    // it back both via `persona show` and a direct file read") -- reused
    // exactly, not a fresh fixture that merely looks similar (this story's
    // own design-decision rationale).
    const { persona } = runPersonaInterview({
      tier: 'company-director',
      scopeId: 'pw11-full-co',
      displayName: 'Company Director — PW11 Co',
      scope: 'Company-wide business context for PW11 Co only.',
      responses: {
        knows: 'PW11_KNOWS_MARKER — the company mission and org chart.',
        not_hold: 'PW11_NOT_HOLD_MARKER — repo-level implementation detail.',
        parent: 'none',
        success: 'PW11_SUCCESS_MARKER — every project aligns to the mission.',
        avoid: 'PW11_AVOID_MARKER — dictating implementation details.',
      },
    });
    expect(() => assertValidPersona(persona as Persona, 'company-director')).not.toThrow();

    // The GROUND TRUTH: the real production serializer --commit-directly's
    // own write primitive (persona-writer.mjs's writePersonaViaCli) uses
    // internally to build its `--file` input -- not a hand-rolled/re-derived
    // YAML string. Computed independently, before the write, from the same
    // fixture.
    const expectedYaml = personaToYaml(persona);

    // --commit-directly IS persona-writer.mjs's writePersonaViaCli -- the
    // exact same function/CLI invocation persona-interview-output.test.ts's
    // own test makes, called here with the identical fixture.
    const writeResult = await writePersonaViaCli(persona, { root: storeRoot });
    expect(writeResult.ok, `CLI create failed: ${writeResult.stderr}`).toBe(true);
    expect(writeResult.writtenPath).toBeTruthy();
    expect(writeResult.writtenPath).toContain(path.join('company-director', 'pw11-full-co.yaml'));

    // The real bytes on disk -- a direct file read, not a re-derived assertion.
    const actualYaml = readFileSync(writeResult.writtenPath as string, 'utf8');
    expect(stripTimestamps(actualYaml)).toBe(stripTimestamps(expectedYaml));

    // Re-confirm this really is pw-11's own already-proven outcome for this
    // fixture (same read-back assertions that test itself makes), not just
    // two freshly-computed strings that happen to match each other.
    const readBack = readGlobalPersona('company-director', 'pw11-full-co', storeRoot);
    expect(() => assertValidPersona(readBack as unknown as Persona, 'company-director')).not.toThrow();
    expect(readBack.displayName).toBe(persona.displayName);
    expect(readBack.scope).toBe(persona.scope);
    expect(readBack.sections).toEqual(persona.sections);
    expect(readBack.parentRefs).toBeUndefined();
  });
});

describe('pu-09 case 3: default path (NO flag) -- pw-12\'s exact max-skip pattern still produces a valid, reviewable ACTIVE DRAFT', () => {
  it('global tier (top-orchestrator): pw-12\'s exact skip-token pattern, no flag -- a valid, reviewable draft, never an error, never empty/omitted', async () => {
    const fakeHome = await makeTempRoot('mnemosyne-pu09-draft-max-skip-top-fakehome-');

    // IDENTICAL skip-token pattern to pw-12's own top-orchestrator case
    // (persona-interview-skip-all-regression.test.ts) -- deliberately varied
    // tokens across the recognized forms, no context, no displayName/scope
    // override, exactly as that test uses.
    const responses = {
      knows: 'skip',
      not_hold: 'N/A',
      parent: 'pass',
      success: '',
      avoid: 'NA',
    };

    const { persona, asked, skippedByContext, skippedCore, skippedOptional } = runPersonaInterview({
      tier: 'top-orchestrator',
      scopeId: 'pu09-draft-max-skip-top',
      responses,
    });

    // Confirm this is genuinely max-skip, mirroring pw-12's own proof: every
    // question was actually offered and explicitly declined, none bypassed
    // via context.
    expect(skippedByContext).toEqual([]);
    expect(asked).toEqual(ALL_QUESTION_IDS);
    expect(skippedCore).toEqual(['knows', 'not_hold', 'parent']);
    expect(skippedOptional).toEqual(['success', 'avoid']);
    expect(persona.sections).toHaveLength(3);
    expect(persona.sections.every((s: { body: string }) => s.body === SKIP_PLACEHOLDER)).toBe(true);
    expect(() => assertValidPersona(persona as Persona, 'top-orchestrator')).not.toThrow();

    // THE NON-BLOCKING HARD-FAIL RULE, EXTENDED TO THE DRAFT-PROPOSE PATH: no
    // flag at all -- writeDraftPersonaViaCli must still complete
    // successfully for a maximally-skipped interview. Failing here would BE
    // a hard-fail regression, not a benign no-op.
    const result = await writeDraftPersonaViaCli(persona, { home: fakeHome });
    expect(
      result.ok,
      `draft propose failed on a max-skip interview (this would BE a hard-fail -- it must not happen): ${result.stderr}`,
    ).toBe(true);
    expect(result.writtenPath).toBeTruthy();

    const draftRoot = path.join(fakeHome, '.mnemosyne', 'persona-drafts');
    expect(existsSync(draftPersonaPath('top-orchestrator', 'pu09-draft-max-skip-top', { draftRoot }))).toBe(true);

    const draft = readDraftPersona('top-orchestrator', 'pu09-draft-max-skip-top', { draftRoot });
    // A valid, REVIEWABLE draft -- never empty, never omitted: real content
    // on every core section (the SKIP_PLACEHOLDER marker, exactly as
    // pw-10/pw-12 already establish for the max-skip case), a real
    // displayName/scope, and it still passes the real schema gate
    // (assertValidPersona doesn't reject the extra draft-only
    // proposedBy/proposedAt/sourceSummary keys -- it only ever rejects
    // `mandateSections`).
    const draftSections = draft.sections as { heading: string; body: string }[];
    expect(draftSections).toHaveLength(3);
    expect(draftSections.every((s) => s.body === SKIP_PLACEHOLDER)).toBe(true);
    expect(draft.displayName).toBeTruthy();
    expect(draft.scope).toBeTruthy();
    expect(draft.proposedBy).toBe('agent');
    expect(typeof draft.proposedAt).toBe('string');
    expect(() => assertValidPersona(draft as unknown as Persona, 'top-orchestrator')).not.toThrow();
  });

  it('code-architect (repo-local, --repo): pw-12\'s exact skip-token pattern, no flag -- a valid, reviewable draft, never an error, never empty/omitted', async () => {
    const repoRoot = await makeTempRoot('mnemosyne-pu09-draft-max-skip-repo-');
    const fakeHome = await makeTempRoot('mnemosyne-pu09-draft-max-skip-repo-fakehome-');

    // IDENTICAL skip-token pattern to pw-12's own code-architect case --
    // a different subset/casing of tokens than the global-tier case above,
    // including whitespace-only, exactly as that test uses.
    const responses = {
      knows: 'SKIP',
      not_hold: '   ',
      parent: 'n/a',
      success: 'pass',
      avoid: 'skip',
    };

    const { persona, asked, skippedByContext, skippedCore, skippedOptional } = runPersonaInterview({
      tier: 'code-architect',
      scopeId: 'pu09-draft-max-skip-repo',
      responses,
    });

    expect(skippedByContext).toEqual([]);
    expect(asked).toEqual(ALL_QUESTION_IDS);
    expect(skippedCore).toEqual(['knows', 'not_hold', 'parent']);
    expect(skippedOptional).toEqual(['success', 'avoid']);
    expect(persona.sections).toHaveLength(3);
    expect(persona.sections.every((s: { body: string }) => s.body === SKIP_PLACEHOLDER)).toBe(true);
    expect(() => assertValidPersona(persona as Persona, 'code-architect')).not.toThrow();

    const result = await writeDraftPersonaViaCli(persona, { repo: repoRoot, home: fakeHome });
    expect(
      result.ok,
      `draft propose failed on a max-skip interview (this would BE a hard-fail -- it must not happen): ${result.stderr}`,
    ).toBe(true);
    expect(result.writtenPath).toBeTruthy();

    const draftRoot = path.join(fakeHome, '.mnemosyne', 'persona-drafts');
    const draft = readDraftPersona('code-architect', 'pu09-draft-max-skip-repo', { repoRoot, draftRoot });
    const draftSections = draft.sections as { heading: string; body: string }[];
    expect(draftSections).toHaveLength(3);
    expect(draftSections.every((s) => s.body === SKIP_PLACEHOLDER)).toBe(true);
    expect(draft.displayName).toBeTruthy();
    expect(draft.scope).toBeTruthy();
    expect(() => assertValidPersona(draft as unknown as Persona, 'code-architect')).not.toThrow();
  });
});

describe('pu-09 case 4: --commit-directly reproduces pw-12\'s own max-skip-still-valid behavior exactly, unchanged', () => {
  it('global tier (top-orchestrator): pw-12\'s exact max-skip fixture and scopeId, through --commit-directly -- identical outcome to pw-12\'s own proof', async () => {
    const fakeHome = await makeTempRoot('mnemosyne-pu09-commit-directly-max-skip-top-fakehome-');

    // VERBATIM fixture (tokens AND scopeId) from
    // persona-interview-skip-all-regression.test.ts's own top-orchestrator
    // case -- run again here, independently, through --commit-directly's
    // write primitive.
    const responses = {
      knows: 'skip',
      not_hold: 'N/A',
      parent: 'pass',
      success: '',
      avoid: 'NA',
    };

    const { persona, skippedCore, skippedOptional } = runPersonaInterview({
      tier: 'top-orchestrator',
      scopeId: 'pw12-max-skip-top',
      responses,
    });
    expect(skippedCore).toEqual(['knows', 'not_hold', 'parent']);
    expect(skippedOptional).toEqual(['success', 'avoid']);
    expect(() => assertValidPersona(persona as Persona, 'top-orchestrator')).not.toThrow();

    const expectedYaml = personaToYaml(persona);

    // --commit-directly's own write primitive -- the SAME function pw-12's
    // own test calls, unchanged.
    const writeResult = await writePersonaViaCli(persona, { home: fakeHome });
    expect(
      writeResult.ok,
      `CLI create failed (this would BE a hard-fail -- it must not happen): ${writeResult.stderr}`,
    ).toBe(true);
    expect(writeResult.writtenPath).toBeTruthy();

    const actualYaml = readFileSync(writeResult.writtenPath as string, 'utf8');
    expect(stripTimestamps(actualYaml)).toBe(stripTimestamps(expectedYaml));

    // Read-back #1: the real `mnemosyne persona show` CLI subprocess --
    // identical to pw-12's own read-back proof.
    const showResult = await showPersonaViaCli('top-orchestrator', 'pw12-max-skip-top', { home: fakeHome });
    expect(showResult.ok, `CLI show failed: ${showResult.stderr}`).toBe(true);
    expect(showResult.stdout).toContain('tier: top-orchestrator');
    expect(showResult.stdout).toContain('scopeId: pw12-max-skip-top');
    expect(showResult.stdout).toContain(SKIP_PLACEHOLDER);

    // Read-back #2: a direct file read through the already-tested
    // persona-store-global.ts primitive -- identical to pw-12's own proof.
    const storeRoot = path.join(fakeHome, '.mnemosyne', 'personas');
    const readBack = readGlobalPersona('top-orchestrator', 'pw12-max-skip-top', storeRoot);
    expect(() => assertValidPersona(readBack as unknown as Persona, 'top-orchestrator')).not.toThrow();
    expect(readBack.sections).toEqual(persona.sections);
    expect(readBack.sections.every((s) => s.body === SKIP_PLACEHOLDER)).toBe(true);
    expect(readBack.parentRefs).toBeUndefined();
  });

  it('code-architect (repo-local, --repo): pw-12\'s exact max-skip fixture and scopeId, through --commit-directly -- identical outcome to pw-12\'s own proof', async () => {
    const repoRoot = await makeTempRoot('mnemosyne-pu09-commit-directly-max-skip-repo-');

    // VERBATIM fixture (tokens AND scopeId) from pw-12's own code-architect case.
    const responses = {
      knows: 'SKIP',
      not_hold: '   ',
      parent: 'n/a',
      success: 'pass',
      avoid: 'skip',
    };

    const { persona, skippedCore, skippedOptional } = runPersonaInterview({
      tier: 'code-architect',
      scopeId: 'pw12-max-skip-repo',
      responses,
    });
    expect(skippedCore).toEqual(['knows', 'not_hold', 'parent']);
    expect(skippedOptional).toEqual(['success', 'avoid']);
    expect(() => assertValidPersona(persona as Persona, 'code-architect')).not.toThrow();

    const expectedYaml = personaToYaml(persona);

    const writeResult = await writePersonaViaCli(persona, { repo: repoRoot });
    expect(
      writeResult.ok,
      `CLI create failed (this would BE a hard-fail -- it must not happen): ${writeResult.stderr}`,
    ).toBe(true);
    expect(writeResult.writtenPath).toBe(path.join(repoRoot, '.mnemosyne', 'personas', 'pw12-max-skip-repo.yaml'));

    const actualYaml = readFileSync(writeResult.writtenPath as string, 'utf8');
    expect(stripTimestamps(actualYaml)).toBe(stripTimestamps(expectedYaml));

    // code-architect has no CLI `show` surface -- direct file read via the
    // already-tested repo-local store primitive, identical to pw-12's own proof.
    const readBack = readRepoLocalPersona(repoRoot, 'pw12-max-skip-repo');
    expect(() => assertValidPersona(readBack as unknown as Persona, 'code-architect')).not.toThrow();
    expect(readBack.sections).toEqual(persona.sections);
    expect(readBack.sections.every((s) => s.body === SKIP_PLACEHOLDER)).toBe(true);
    expect(readBack.parentRefs).toBeUndefined();
  });
});
