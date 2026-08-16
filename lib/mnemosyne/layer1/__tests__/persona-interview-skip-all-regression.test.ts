// persona-interview-skip-all-regression.test.ts — pw-12-interview-skill-skip-all-regression.
//
// Closes Slice 3's interview-mechanics work by proving
// horizontal-plan.md H6.3's non-blocking hard-fail rule end-to-end, through
// the REAL write primitive — not just in memory.
//
// What already exists, and the exact gap this file closes:
//   - pw-10 (persona-interview-skill.test.ts)'s "max-skip" describe block
//     already proves the hard-fail rule against the REAL assertValidPersona,
//     but only IN-MEMORY — it never writes anything to disk.
//   - pw-11 (persona-interview-output.test.ts) already proves real-write-
//     primitive round-trips (writePersonaViaCli/showPersonaViaCli, a real
//     `tsx`-spawned `mnemosyne persona create`/`persona show` CLI
//     subprocess — see that file's own header for the full transport
//     rationale), but only for full-answers and PARTIALLY-skipped interview
//     output — never a maximally-skipped one.
//
// This file is the missing intersection: a maximally-skipped interview's
// output, proven not only to pass assertValidPersona in memory, but to
// actually get written to disk via the real CLI subprocess and read back
// correctly — for both a global-store tier (top-orchestrator) and the
// repo-local (code-architect, --repo) tier, since those two go through
// different store/read code paths (persona.ts's PERSONA_STORE_BY_TIER).
//
// "Maximally skipped" here means genuinely all of it, unambiguously:
//   - Every one of the 5 questions (3 core + 2 optional) gets an EXPLICIT
//     skip-token response — not an omitted key. A variety of the skip
//     tokens normalizeSkipToken (interview-engine.mjs) actually recognizes
//     ('', 'skip', 'pass', 'n/a', 'na', case-insensitive, whitespace-only)
//     is used across the two test cases below, so this is not a coincidence
//     of one particular token happening to work.
//   - No `context` is supplied (so nothing is skipped-via-context instead —
//     `skippedByContext` must be empty and `asked` must list all 5 ids,
//     proving every question was genuinely offered and explicitly declined,
//     not silently bypassed).
//   - No `displayName`/`scope` invocation-level override either — the
//     hard-fail rule applies to those invocation parameters too (pw-10's own
//     max-skip case already establishes this; mirrored here so this really
//     is "everything," not "everything except the two easiest fields").

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertValidPersona, type Persona } from '../persona.js';
import { readGlobalPersona } from '../persona-store-global.js';
import { readRepoLocalPersona } from '../persona-store-repo-local.js';
// interview-engine.mjs / persona-writer.mjs are plain ESM JS (no TS types) --
// imported by relative path exactly like the skill itself would load them;
// vitest resolves .mjs fine (same convention as persona-interview-skill.test.ts
// and persona-interview-output.test.ts's own imports).
// eslint-disable-next-line import/extensions
import {
  CORE_QUESTIONS,
  OPTIONAL_QUESTIONS,
  SKIP_PLACEHOLDER,
  runPersonaInterview,
} from '../../../../skills/mnemosyne-persona-interview/interview-engine.mjs';
// eslint-disable-next-line import/extensions
import {
  showPersonaViaCli,
  writePersonaViaCli,
} from '../../../../skills/mnemosyne-persona-interview/persona-writer.mjs';

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

describe('pw-12: maximally-skipped interview -- non-blocking hard-fail rule, through the REAL write primitive', () => {
  it('global tier (top-orchestrator): every question explicitly skipped, still writes and reads back a valid persona via the real CLI', async () => {
    // Every response below is an EXPLICIT skip token -- deliberately varied
    // across the recognized forms (normalizeSkipToken, interview-engine.mjs)
    // so this is not "one token happens to work," and deliberately NOT
    // omitted keys, so this cannot be mistaken for context-driven skipping.
    const responses = {
      knows: 'skip',
      not_hold: 'N/A',
      parent: 'pass',
      success: '',
      avoid: 'NA',
    };

    const { persona, asked, skippedByContext, skippedCore, skippedOptional, answeredOptional } =
      runPersonaInterview({
        tier: 'top-orchestrator',
        scopeId: 'pw12-max-skip-top',
        // No displayName, no scope override, no context -- the hard-fail
        // rule applies to invocation params as much as to the 5 questions
        // themselves (mirrors pw-10's own max-skip case).
        responses,
      });

    // Proof this is a GENUINE maximal skip, not a partial one that happens
    // to still pass: every question was actually offered (asked, not
    // bypassed via context) and every single one was explicitly declined.
    expect(skippedByContext).toEqual([]);
    expect(asked).toEqual(ALL_QUESTION_IDS);
    expect(skippedCore).toEqual(['knows', 'not_hold', 'parent']);
    expect(skippedOptional).toEqual(['success', 'avoid']);
    expect(answeredOptional).toEqual([]);

    // Exact SKIP_PLACEHOLDER marker on every core section -- no optional
    // sections at all (omitted entirely, not even as a placeholder).
    expect(persona.sections).toHaveLength(3);
    expect(persona.sections.map((s) => s.heading)).toEqual(CORE_SECTION_HEADINGS);
    expect(persona.sections.every((s) => s.body === SKIP_PLACEHOLDER)).toBe(true);
    expect(persona.sections.some((s) => s.heading === 'Success')).toBe(false);
    expect(persona.sections.some((s) => s.heading === 'Avoid')).toBe(false);
    expect(persona.parentRefs).toBeUndefined();
    expect(persona.displayName.length).toBeGreaterThan(0);
    expect(persona.scope.length).toBeGreaterThan(0);

    // In-memory precondition -- pw-10 already proves this shape of output
    // passes the real validator; re-confirmed here, not the point of this test.
    expect(() => assertValidPersona(persona as Persona, 'top-orchestrator')).not.toThrow();

    // THE GAP THIS TEST CLOSES: a real `tsx`-spawned `mnemosyne persona
    // create` CLI subprocess, not a simulated/in-process call. Confirms the
    // hard-fail rule holds through the real write primitive, and that this
    // completes successfully end-to-end -- not just "doesn't crash."
    const fakeHome = await makeTempRoot('mnemosyne-pw12-max-skip-fakehome-');
    const writeResult = await writePersonaViaCli(persona, { home: fakeHome });
    expect(writeResult.ok, `CLI create failed (this would BE a hard-fail -- it must not happen): ${writeResult.stderr}`).toBe(
      true,
    );
    expect(writeResult.writtenPath).toBeTruthy();

    // Read-back #1: the real `mnemosyne persona show` CLI subprocess.
    const showResult = await showPersonaViaCli('top-orchestrator', 'pw12-max-skip-top', { home: fakeHome });
    expect(showResult.ok, `CLI show failed: ${showResult.stderr}`).toBe(true);
    expect(showResult.stdout).toContain('tier: top-orchestrator');
    expect(showResult.stdout).toContain('scopeId: pw12-max-skip-top');
    expect(showResult.stdout).toContain(SKIP_PLACEHOLDER);

    // Read-back #2: a direct file read through the already-tested
    // persona-store-global.ts primitive -- full structural round-trip of
    // what's ACTUALLY on disk (not the in-memory object), including a real
    // re-run of assertValidPersona against the on-disk content.
    const storeRoot = path.join(fakeHome, '.mnemosyne', 'personas');
    const readBack = readGlobalPersona('top-orchestrator', 'pw12-max-skip-top', storeRoot);
    expect(() => assertValidPersona(readBack as unknown, 'top-orchestrator')).not.toThrow();
    expect(readBack.sections).toEqual(persona.sections);
    expect(readBack.sections.every((s) => s.body === SKIP_PLACEHOLDER)).toBe(true);
    expect(readBack.parentRefs).toBeUndefined();
    expect(readBack.displayName).toBe(persona.displayName);
    expect(readBack.scope).toBe(persona.scope);

    // Reaching this line at all IS the non-blocking hard-fail proof: the
    // interview, the schema gate, the real CLI write, and both real
    // read-backs all completed successfully -- no halt, no thrown error, no
    // operator escalation, for the maximally-skipped case, through the real
    // write primitive.
  });

  it('code-architect (repo-local store, --repo): every question explicitly skipped, still writes and reads back a valid persona via the real CLI', async () => {
    // A different subset/casing of skip tokens than the global-tier case
    // above, including whitespace-only (trims to '' -- still a skip, not an
    // "answer" of literal whitespace) -- proves this isn't one token's
    // behavior coincidentally matching, and covers the code-architect
    // (repo-local, --repo) path pw-11 never exercised in its max-skip form.
    const responses = {
      knows: 'SKIP',
      not_hold: '   ',
      parent: 'n/a',
      success: 'pass',
      avoid: 'skip',
    };

    const { persona, asked, skippedByContext, skippedCore, skippedOptional, answeredOptional } =
      runPersonaInterview({
        tier: 'code-architect',
        scopeId: 'pw12-max-skip-repo',
        responses,
      });

    expect(skippedByContext).toEqual([]);
    expect(asked).toEqual(ALL_QUESTION_IDS);
    expect(skippedCore).toEqual(['knows', 'not_hold', 'parent']);
    expect(skippedOptional).toEqual(['success', 'avoid']);
    expect(answeredOptional).toEqual([]);

    expect(persona.sections).toHaveLength(3);
    expect(persona.sections.map((s) => s.heading)).toEqual(CORE_SECTION_HEADINGS);
    expect(persona.sections.every((s) => s.body === SKIP_PLACEHOLDER)).toBe(true);
    expect(persona.sections.some((s) => s.heading === 'Success')).toBe(false);
    expect(persona.sections.some((s) => s.heading === 'Avoid')).toBe(false);
    expect(persona.parentRefs).toBeUndefined();

    expect(() => assertValidPersona(persona as Persona, 'code-architect')).not.toThrow();

    // THE GAP THIS TEST CLOSES for the repo-local path: a real CLI
    // subprocess routed at a throwaway --repo root (pw-11's global-tier max
    // is exercised above; code-architect's different store/read path is
    // exercised here).
    const repoRoot = await makeTempRoot('mnemosyne-pw12-max-skip-repo-');
    const writeResult = await writePersonaViaCli(persona, { repo: repoRoot });
    expect(writeResult.ok, `CLI create failed (this would BE a hard-fail -- it must not happen): ${writeResult.stderr}`).toBe(
      true,
    );
    expect(writeResult.writtenPath).toBe(path.join(repoRoot, '.mnemosyne', 'personas', 'pw12-max-skip-repo.yaml'));

    // code-architect has no CLI `show` surface (bin/mnemosyne-persona.mjs's
    // USAGE_SHOW is global-tiers-only, per persona-interview-output.test.ts's
    // own precedent) -- read back via the already-tested repo-local store
    // primitive, per this story's acceptance criteria's "persona-show OR a
    // direct store read" alternative.
    const readBack = readRepoLocalPersona(repoRoot, 'pw12-max-skip-repo');
    expect(() => assertValidPersona(readBack as unknown, 'code-architect')).not.toThrow();
    expect(readBack.sections).toEqual(persona.sections);
    expect(readBack.sections.every((s) => s.body === SKIP_PLACEHOLDER)).toBe(true);
    expect(readBack.parentRefs).toBeUndefined();
    expect(readBack.displayName).toBe(persona.displayName);
    expect(readBack.scope).toBe(persona.scope);

    // As above: reaching this line is the proof. No halt, no error, no
    // operator escalation for the maximally-skipped code-architect case,
    // through the real repo-local write primitive.
  });
});
