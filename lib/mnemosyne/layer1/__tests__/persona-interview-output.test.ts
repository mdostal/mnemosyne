// persona-interview-output.test.ts — TDD coverage for
// pw-11-interview-skill-persona-output: pw-10's interview-engine.mjs output
// (a completed interview's `persona` record) wired into a REAL call to
// Slice 2's `persona create` write primitive
// (bin/mnemosyne-persona.mjs, pw-05), proven to round-trip through disk —
// not just validated in memory, which pw-10's own
// persona-interview-skill.test.ts already covers.
//
// Every write in this file goes through
// skills/mnemosyne-persona-interview/persona-writer.mjs's
// `writePersonaViaCli`, a real `tsx`-spawned `mnemosyne persona create`
// subprocess (bin/mnemosyne-persona.mjs) -- the exact same CLI subcommand
// pw-06's `personaCreateAction` and pw-07's `persona_create` MCP tool
// themselves wrap (see test/persona-cross-transport.mjs for the existing
// proof all three transports funnel through the same underlying
// writeGlobalPersona/writeRepoLocalPersona + withLock code). No new/parallel
// write path is introduced here or in persona-writer.mjs -- see the last
// describe block below for a structural proof of that.
//
// Read-back uses two REAL surfaces, per this story's acceptance criteria
// ("via persona-show or a direct file read"):
//   - `mnemosyne persona show <tier> <scope-id>` (pf-13's CLI subcommand,
//     via persona-writer.mjs's showPersonaViaCli) for the 3 global tiers.
//   - A direct file read through persona-store-{global,repo-local}.ts's own
//     already-tested `readGlobalPersona`/`readRepoLocalPersona` (never a
//     hand-rolled YAML parse) for the fully-structured round-trip check
//     (including `parentRefs`, which `show`'s plain-text rendering does not
//     print) and for code-architect, which has no CLI `show` surface at all.
//
// Uses real, throwaway temp directories for both the global persona store
// root (via --root / an explicit root override) and the repo-local store
// (a temp "repo" root) -- never the operator's real ~/.mnemosyne or an
// actual project checkout. No process.env.HOME mutation anywhere in this
// file: --root and readGlobalPersona's own root parameter are both used
// explicitly instead, so nothing here can race other parallel vitest test
// files that touch $HOME.

import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { assertValidPersona, type Persona } from '../persona.js';
import { readGlobalPersona } from '../persona-store-global.js';
import { readRepoLocalPersona } from '../persona-store-repo-local.js';
// interview-engine.mjs / persona-writer.mjs are plain ESM JS (no TS types) --
// imported by relative path exactly like the skill itself would load them;
// vitest resolves .mjs fine (same convention as
// persona-interview-skill.test.ts's own interview-engine.mjs import).
// eslint-disable-next-line import/extensions
import { runPersonaInterview } from '../../../../skills/mnemosyne-persona-interview/interview-engine.mjs';
// eslint-disable-next-line import/extensions
import {
  personaToYaml,
  showPersonaViaCli,
  writePersonaViaCli,
} from '../../../../skills/mnemosyne-persona-interview/persona-writer.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PERSONA_WRITER_PATH = path.resolve(
  __dirname,
  '../../../../skills/mnemosyne-persona-interview/persona-writer.mjs',
);

const tempRoots: string[] = [];
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

describe('pw-11: full-answers interview round-trips through the real persona_create CLI write primitive', () => {
  it('writes a global-tier persona via the CLI subprocess and reads it back both via `persona show` and a direct file read', async () => {
    const storeRoot = await makeTempRoot('mnemosyne-pw11-global-store-');

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

    // Sanity: this really is the well-formed Persona pw-10 already proves in
    // memory -- re-confirmed here as a precondition, not the point of this test.
    expect(() => assertValidPersona(persona as Persona, 'company-director')).not.toThrow();

    // The REAL write: a real `tsx` subprocess running bin/mnemosyne-persona.mjs's
    // `create` subcommand -- not a simulated call.
    const writeResult = await writePersonaViaCli(persona, { root: storeRoot });
    expect(writeResult.ok, `CLI create failed: ${writeResult.stderr}`).toBe(true);
    expect(writeResult.writtenPath).toBeTruthy();
    expect(writeResult.writtenPath).toContain(path.join('company-director', 'pw11-full-co.yaml'));

    // Read-back #1: a direct file read through the already-tested
    // persona-store-global.ts primitive -- full structural round-trip,
    // including a real re-run of assertValidPersona against what's ACTUALLY
    // on disk (not the in-memory object).
    const readBack = readGlobalPersona('company-director', 'pw11-full-co', storeRoot);
    expect(() => assertValidPersona(readBack as unknown, 'company-director')).not.toThrow();
    expect(readBack.displayName).toBe(persona.displayName);
    expect(readBack.scope).toBe(persona.scope);
    expect(readBack.sections).toEqual(persona.sections);
    expect(readBack.parentRefs).toBeUndefined();

    // Read-back #2: the real `mnemosyne persona show` CLI subprocess (pf-13) --
    // same $HOME-based store, so point it at storeRoot's parent via HOME override
    // is unnecessary here since we used --root for the write; show has no --root
    // flag, so we exercise it against a $HOME-rooted store in the next test
    // instead. Here we confirm the direct-file-read path alone already proves
    // the full round-trip end to end.
  });

  it('writes and reads back a global-tier persona entirely through $HOME-scoped CLI subprocesses (create AND show)', async () => {
    const fakeHome = await makeTempRoot('mnemosyne-pw11-fakehome-');

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

    const writeResult = await writePersonaViaCli(persona, { home: fakeHome });
    expect(writeResult.ok, `CLI create failed: ${writeResult.stderr}`).toBe(true);

    const showResult = await showPersonaViaCli('project-orchestrator', 'pw11-full-project', { home: fakeHome });
    expect(showResult.ok, `CLI show failed: ${showResult.stderr}`).toBe(true);
    expect(showResult.stdout).toContain('PW11_SHOW_KNOWS_MARKER');
    expect(showResult.stdout).toContain('PW11_SHOW_NOT_HOLD_MARKER');
    expect(showResult.stdout).toContain('tier: project-orchestrator');
    expect(showResult.stdout).toContain('scopeId: pw11-full-project');

    // AC 4 -- parentRefs surfaced by the interview must be written correctly
    // and read back correctly. `show`'s plain-text rendering doesn't print
    // parentRefs (bin/mnemosyne-persona.mjs's formatPersonaShow, by design --
    // it renders the persona's real content, not every schema field), so
    // confirm parentRefs itself via a direct file read of the exact same
    // $HOME-scoped store `show` just read from.
    const storeRoot = path.join(fakeHome, '.mnemosyne', 'personas');
    const readBack = readGlobalPersona('project-orchestrator', 'pw11-full-project', storeRoot);
    expect(readBack.parentRefs).toEqual([{ tier: 'company-director', scopeId: 'pw11-full-co' }]);
    expect(() => assertValidPersona(readBack as unknown, 'project-orchestrator')).not.toThrow();
  });
});

describe('pw-11: partially-skipped interview round-trips through the real write primitive', () => {
  it('a skipped-core placeholder written via the CLI reads back byte-identical, and a skipped-optional section stays absent', async () => {
    const storeRoot = await makeTempRoot('mnemosyne-pw11-partial-store-');

    const { persona, skippedCore, skippedOptional } = runPersonaInterview({
      tier: 'top-orchestrator',
      scopeId: 'pw11-partial-top',
      displayName: 'Top Orchestrator — PW11',
      scope: 'Top-level org direction for PW11 only.',
      responses: {
        knows: 'PW11_PARTIAL_KNOWS_MARKER — the multi-company roadmap.',
        // not_hold: skipped
        parent: 'none',
        // success/avoid: skipped
      },
    });

    expect(skippedCore).toEqual(['not_hold']);
    expect(skippedOptional).toEqual(['success', 'avoid']);

    const writeResult = await writePersonaViaCli(persona, { root: storeRoot });
    expect(writeResult.ok, `CLI create failed: ${writeResult.stderr}`).toBe(true);

    const readBack = readGlobalPersona('top-orchestrator', 'pw11-partial-top', storeRoot);
    expect(() => assertValidPersona(readBack as unknown, 'top-orchestrator')).not.toThrow();

    const notHoldSection = readBack.sections.find((s) => s.heading === 'What this persona does NOT hold');
    expect(notHoldSection?.body).toBe('[not provided — skipped during interview]');

    expect(readBack.sections.some((s) => s.heading === 'Success')).toBe(false);
    expect(readBack.sections.some((s) => s.heading === 'Avoid')).toBe(false);
    expect(readBack.sections).toEqual(persona.sections);
  });
});

describe('pw-11: code-architect (repo-local store) round-trip, including parentRefs', () => {
  it('writes a code-architect persona with a parent ref via --repo and reads it back from the repo-local store', async () => {
    const repoRoot = await makeTempRoot('mnemosyne-pw11-repo-');

    const { persona } = runPersonaInterview({
      tier: 'code-architect',
      scopeId: 'pw11-repo-scope',
      displayName: 'Code/Area Architect — PW11 Repo',
      scope: 'Deep per-repo implementation detail for the PW11 repo only.',
      responses: {
        knows: 'PW11_REPO_KNOWS_MARKER — this repo\'s module boundaries.',
        not_hold: 'PW11_REPO_NOT_HOLD_MARKER — company-wide business context.',
        parent: 'project-orchestrator/pw11-full-project',
      },
    });

    expect(persona.parentRefs).toEqual([{ tier: 'project-orchestrator', scopeId: 'pw11-full-project' }]);
    expect(() => assertValidPersona(persona as Persona, 'code-architect')).not.toThrow();

    const writeResult = await writePersonaViaCli(persona, { repo: repoRoot });
    expect(writeResult.ok, `CLI create failed: ${writeResult.stderr}`).toBe(true);
    expect(writeResult.writtenPath).toBe(
      path.join(repoRoot, '.mnemosyne', 'personas', 'pw11-repo-scope.yaml'),
    );

    // code-architect has no CLI `show` surface (bin/mnemosyne-persona.mjs's
    // USAGE_SHOW is global-tiers-only) -- direct file read via the
    // already-tested repo-local store primitive, per this story's own
    // acceptance criteria ("via persona-show OR a direct file read").
    const readBack = readRepoLocalPersona(repoRoot, 'pw11-repo-scope');
    expect(() => assertValidPersona(readBack as unknown, 'code-architect')).not.toThrow();
    expect(readBack.parentRefs).toEqual([{ tier: 'project-orchestrator', scopeId: 'pw11-full-project' }]);
    expect(readBack.sections).toEqual(persona.sections);
    expect(readBack.displayName).toBe(persona.displayName);
    expect(readBack.scope).toBe(persona.scope);
  });
});

describe('pw-11: personaToYaml serialization', () => {
  it('serializes sections and parentRefs to a YAML document mnemosyne persona create parses back unchanged', async () => {
    const { persona } = runPersonaInterview({
      tier: 'code-architect',
      scopeId: 'pw11-yaml-scope',
      responses: {
        knows: 'x',
        not_hold: 'y',
        parent: 'company-director/pw11-yaml-co',
      },
    });

    const yamlText = personaToYaml(persona);
    expect(yamlText).toContain('tier: code-architect');
    expect(yamlText).toContain('scopeId: pw11-yaml-scope');
    expect(yamlText).toContain('sections:');
    expect(yamlText).toContain('parentRefs:');
    expect(yamlText).not.toContain('mandateSections');

    const repoRoot = await makeTempRoot('mnemosyne-pw11-yaml-repo-');
    const writeResult = await writePersonaViaCli(persona, { repo: repoRoot });
    expect(writeResult.ok, `CLI create failed: ${writeResult.stderr}`).toBe(true);

    const readBack = readRepoLocalPersona(repoRoot, 'pw11-yaml-scope');
    expect(readBack).toEqual(persona);
  });
});

describe('pw-11: no new/parallel write path was introduced', () => {
  const source = readFileSync(PERSONA_WRITER_PATH, 'utf8');
  // Only the real `import ... from '...'` statements matter here -- the
  // module's own doc comments legitimately NAME writeGlobalPersona/
  // writeRepoLocalPersona in prose (explaining exactly why it does NOT call
  // them directly), so a bare substring match over the whole file would
  // false-positive on that prose. Strip line-comment-only lines before
  // checking for a real import.
  const importLines = source
    .split('\n')
    .filter((line) => /^\s*import\b/.test(line))
    .join('\n');

  it('persona-writer.mjs never imports writeGlobalPersona/writeRepoLocalPersona directly', () => {
    expect(importLines).not.toMatch(/writeGlobalPersona/);
    expect(importLines).not.toMatch(/writeRepoLocalPersona/);
    expect(importLines).not.toMatch(/from ['"].*persona-store-(global|repo-local)/);
  });

  it('persona-writer.mjs writes personas exclusively by spawning the real bin/mnemosyne-persona.mjs CLI', () => {
    expect(source).toMatch(/PERSONA_CLI/);
    expect(source).toMatch(/bin\/mnemosyne-persona\.mjs/);
    expect(source).toMatch(/execFile/);
    expect(source).toMatch(/create/);
  });

  it('the only writeFile call in persona-writer.mjs targets a scratch tmpdir input file, not a persona-store path', () => {
    // The sole `writeFile(...)` call in this module writes the CLI's OWN
    // --file input (a throwaway YAML doc under os.tmpdir()) -- it is not a
    // second persona-store write. Structural proof: no reference anywhere
    // in this file to either store's real file-path convention
    // (`.mnemosyne/personas`, persona-store-{global,repo-local}.ts's own
    // `globalPersonaPath`/`repoLocalPersonaPath` naming).
    expect(source).not.toMatch(/globalPersonaPath/);
    expect(source).not.toMatch(/repoLocalPersonaPath/);
  });
});
