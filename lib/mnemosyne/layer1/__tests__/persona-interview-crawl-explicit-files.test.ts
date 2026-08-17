// persona-interview-crawl-explicit-files.test.ts — TDD coverage for
// pf-01-crawl-explicit-files: skills/mnemosyne-persona-interview/'s new
// crawlExplicitFiles() export, a sibling to pu-07's crawlBoundedContext()
// (design-discussion.md §1 Direction 1). Lets an operator or agent supply
// an explicit list of file paths as source material for a proposed persona
// draft, instead of pu-07's fixed 5-source auto-crawl list.
//
// This is a SEPARATE test file from persona-interview-crawl.test.ts on
// purpose (pf-01-crawl-explicit-files.yaml acceptance criterion 5: "Given
// crawlBoundedContext()'s own existing test file, when this story ships,
// then it still passes unmodified") -- crawlExplicitFiles() is additive,
// zero changes to crawlBoundedContext() or its own test file.
//
// Acceptance criteria covered (pf-01-crawl-explicit-files.yaml), each its
// own describe block below:
//   1. A list of 1-10 real file paths returns {sourceSummary, sourcesRead}
//      -- the same shape crawlBoundedContext() returns.
//   2. Per-file truncation matches capExcerpt()'s existing behavior exactly
//      -- reused, not reimplemented -- verified by a direct call-site
//      check (comparing against calling capExcerpt() ourselves on the same
//      raw content), not just "looks truncated."
//   3. More than the configured max file count (default 10) throws a
//      clear, named error (TooManyExplicitFilesError) rather than silently
//      truncating the list or silently processing everything.
//   4. A parentRef reuses the SAME real `mnemosyne persona show`
//      CLI-subprocess mechanism crawlBoundedContext() already uses --
//      never a second, looser parent-read implementation.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertValidPersona, type Persona } from '../persona.js';
// interview-engine.mjs / persona-writer.mjs / crawl-context.mjs are plain
// ESM JS (no TS types) -- imported by relative path exactly like the skill
// itself would load them; vitest resolves .mjs fine (same convention as
// persona-interview-crawl.test.ts and this directory's other
// persona-interview-*.test.ts files).
// eslint-disable-next-line import/extensions
import { runPersonaInterview } from '../../../../skills/mnemosyne-persona-interview/interview-engine.mjs';
// eslint-disable-next-line import/extensions
import { writePersonaViaCli } from '../../../../skills/mnemosyne-persona-interview/persona-writer.mjs';
// eslint-disable-next-line import/extensions
import {
  MAX_CHARS_PER_SOURCE,
  MAX_EXPLICIT_FILES,
  MAX_LINES_PER_SOURCE,
  TooManyExplicitFilesError,
  capExcerpt,
  crawlExplicitFiles,
} from '../../../../skills/mnemosyne-persona-interview/crawl-context.mjs';

const tempRoots: string[] = [];
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

describe('pf-01: crawlExplicitFiles() returns the same shape crawlBoundedContext() returns', () => {
  it('reads 1-10 real, caller-supplied file paths and assembles a sourceSummary', async () => {
    const repoRoot = await makeTempRoot('mnemosyne-pf01-explicit-files-');
    await writeFile(path.join(repoRoot, 'notes.md'), 'EXPLICIT_NOTES_MARKER — scratch notes worth reading.', 'utf8');
    await writeFile(path.join(repoRoot, 'design.md'), 'EXPLICIT_DESIGN_MARKER — design intent.', 'utf8');

    const result = await crawlExplicitFiles({
      filePaths: ['notes.md', 'design.md'],
      repoRoot,
    });

    expect(result).toEqual({
      sourceSummary: expect.any(String),
      sourcesRead: expect.any(Array),
    });
    expect(Object.keys(result).sort()).toEqual(['sourceSummary', 'sourcesRead']);

    expect(result.sourceSummary).toContain('EXPLICIT_NOTES_MARKER');
    expect(result.sourceSummary).toContain('EXPLICIT_DESIGN_MARKER');
    expect(result.sourcesRead).toEqual(['notes.md', 'design.md']);
  });

  it('never reads any file outside the explicit list, even when other files exist alongside it', async () => {
    const repoRoot = await makeTempRoot('mnemosyne-pf01-bounded-to-list-');
    await writeFile(path.join(repoRoot, 'wanted.md'), 'WANTED_MARKER — this one was named explicitly.', 'utf8');
    await writeFile(path.join(repoRoot, 'unwanted.md'), 'UNWANTED_MARKER — this one was NOT named.', 'utf8');
    await writeFile(path.join(repoRoot, 'README.md'), 'README_NOT_NAMED_MARKER — bounded crawl source, not this one.', 'utf8');

    const result = await crawlExplicitFiles({ filePaths: ['wanted.md'], repoRoot });

    expect(result.sourceSummary).toContain('WANTED_MARKER');
    expect(result.sourceSummary).not.toContain('UNWANTED_MARKER');
    expect(result.sourceSummary).not.toContain('README_NOT_NAMED_MARKER');
  });

  it('a file path that does not exist is treated as missing (non-blocking), never a fatal error', async () => {
    const repoRoot = await makeTempRoot('mnemosyne-pf01-missing-file-');
    await writeFile(path.join(repoRoot, 'exists.md'), 'EXISTS_MARKER — this one is real.', 'utf8');

    const result = await crawlExplicitFiles({
      filePaths: ['exists.md', 'does-not-exist.md'],
      repoRoot,
    });

    expect(result.sourceSummary).toContain('EXISTS_MARKER');
    expect(result.sourcesRead).toEqual(['exists.md']);
  });
});

describe('pf-01: per-file truncation matches capExcerpt() exactly -- reused, not reimplemented', () => {
  it('an oversized explicit file is truncated identically to a direct capExcerpt() call on the same raw content', async () => {
    const repoRoot = await makeTempRoot('mnemosyne-pf01-oversized-file-');
    const lines = Array.from({ length: 500 }, (_, i) => `EXPLICIT_LINE_${String(i).padStart(4, '0')}_MARKER content here.`);
    const raw = lines.join('\n');
    await writeFile(path.join(repoRoot, 'big.md'), raw, 'utf8');

    // Direct call-site check: compute the expected excerpt via capExcerpt()
    // itself (the exact same function crawlExplicitFiles() must call), then
    // confirm crawlExplicitFiles()'s assembled sourceSummary contains that
    // EXACT excerpt substring -- not just "looks truncated."
    const expected = capExcerpt(raw);
    expect(expected.truncated).toBe(true);

    const { sourceSummary } = await crawlExplicitFiles({ filePaths: ['big.md'], repoRoot });

    expect(sourceSummary).toContain(expected.excerpt);
    expect(sourceSummary).toContain('EXPLICIT_LINE_0000_MARKER');
    expect(sourceSummary).not.toContain('EXPLICIT_LINE_0499_MARKER');
  });

  it('a single pathologically long line in an explicit file is still capped by MAX_CHARS_PER_SOURCE', async () => {
    const repoRoot = await makeTempRoot('mnemosyne-pf01-long-line-');
    const longLine = 'Y'.repeat(MAX_CHARS_PER_SOURCE * 4);
    await writeFile(path.join(repoRoot, 'long.md'), longLine, 'utf8');

    const { sourceSummary } = await crawlExplicitFiles({ filePaths: ['long.md'], repoRoot });
    const yRun = sourceSummary.match(/Y+/);
    expect(yRun).not.toBeNull();
    expect((yRun as RegExpMatchArray)[0].length).toBeLessThanOrEqual(MAX_CHARS_PER_SOURCE);
  });

  it('a file within the caps is included verbatim (unmarked, untruncated)', async () => {
    const repoRoot = await makeTempRoot('mnemosyne-pf01-small-file-');
    await writeFile(path.join(repoRoot, 'small.md'), 'SMALL_FILE_MARKER — well within caps.', 'utf8');

    const { sourceSummary } = await crawlExplicitFiles({ filePaths: ['small.md'], repoRoot });
    expect(sourceSummary).toContain('SMALL_FILE_MARKER — well within caps.');
  });
});

describe('pf-01: the max-file-count cap is a real, enforced throw', () => {
  it('throws a clear, named TooManyExplicitFilesError when more than MAX_EXPLICIT_FILES paths are supplied', async () => {
    const repoRoot = await makeTempRoot('mnemosyne-pf01-too-many-files-');
    const filePaths = Array.from({ length: MAX_EXPLICIT_FILES + 1 }, (_, i) => `f${i}.md`);
    for (const fp of filePaths) {
      await writeFile(path.join(repoRoot, fp), `content of ${fp}`, 'utf8');
    }

    await expect(crawlExplicitFiles({ filePaths, repoRoot })).rejects.toThrow(TooManyExplicitFilesError);
    await expect(crawlExplicitFiles({ filePaths, repoRoot })).rejects.toMatchObject({
      name: 'TooManyExplicitFilesError',
    });
  });

  it('does NOT silently truncate to the first N files, and does NOT silently process all of them', async () => {
    const repoRoot = await makeTempRoot('mnemosyne-pf01-no-silent-behavior-');
    const filePaths = Array.from({ length: MAX_EXPLICIT_FILES + 3 }, (_, i) => `g${i}.md`);
    for (const fp of filePaths) {
      await writeFile(path.join(repoRoot, fp), `GSILENT_${fp}_MARKER`, 'utf8');
    }

    let caught: unknown;
    try {
      await crawlExplicitFiles({ filePaths, repoRoot });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TooManyExplicitFilesError);
    expect((caught as TooManyExplicitFilesError).count).toBe(MAX_EXPLICIT_FILES + 3);
    expect((caught as TooManyExplicitFilesError).max).toBe(MAX_EXPLICIT_FILES);
  });

  it('exactly MAX_EXPLICIT_FILES paths is allowed (the boundary is inclusive)', async () => {
    const repoRoot = await makeTempRoot('mnemosyne-pf01-exactly-max-');
    const filePaths = Array.from({ length: MAX_EXPLICIT_FILES }, (_, i) => `h${i}.md`);
    for (const fp of filePaths) {
      await writeFile(path.join(repoRoot, fp), `content of ${fp}`, 'utf8');
    }

    await expect(crawlExplicitFiles({ filePaths, repoRoot })).resolves.toBeTruthy();
  });

  it('an explicit maxFiles override raises the ceiling for a caller that has genuinely decided it needs more', async () => {
    const repoRoot = await makeTempRoot('mnemosyne-pf01-maxfiles-override-');
    const filePaths = Array.from({ length: MAX_EXPLICIT_FILES + 2 }, (_, i) => `k${i}.md`);
    for (const fp of filePaths) {
      await writeFile(path.join(repoRoot, fp), `content of ${fp}`, 'utf8');
    }

    await expect(crawlExplicitFiles({ filePaths, repoRoot, maxFiles: MAX_EXPLICIT_FILES + 2 })).resolves.toBeTruthy();
  });
});

describe('pf-01: parentRef reuses the SAME real `mnemosyne persona show` CLI-subprocess mechanism', () => {
  it("includes the parent's displayName/scope but never its sections body verbatim", async () => {
    const fakeHome = await makeTempRoot('mnemosyne-pf01-parent-fakehome-');
    const repoRoot = await makeTempRoot('mnemosyne-pf01-parent-repo-');
    await writeFile(path.join(repoRoot, 'source.md'), 'PF01_SOURCE_FILE_MARKER — explicit source.', 'utf8');

    const { persona: parentPersona } = runPersonaInterview({
      tier: 'project-orchestrator',
      scopeId: 'pf01-parent-project',
      displayName: 'PF01_PARENT_DISPLAYNAME_MARKER — Project Orchestrator',
      scope: 'PF01_PARENT_SCOPE_MARKER — cross-repo coordination only.',
      responses: {
        knows: 'PF01_PARENT_SECRET_SECTION_MARKER — this must never leak into an explicit-file crawl.',
        not_hold: 'PF01_PARENT_NOT_HOLD_SECRET_MARKER — also must never leak.',
        parent: 'none',
      },
    });
    expect(() => assertValidPersona(parentPersona as Persona, 'project-orchestrator')).not.toThrow();

    const writeResult = await writePersonaViaCli(parentPersona, { home: fakeHome });
    expect(writeResult.ok, `CLI create failed: ${writeResult.stderr}`).toBe(true);

    const { sourceSummary, sourcesRead } = await crawlExplicitFiles({
      filePaths: ['source.md'],
      repoRoot,
      parentRef: { tier: 'project-orchestrator', scopeId: 'pf01-parent-project' },
      home: fakeHome,
    });

    expect(sourceSummary).toContain('PF01_SOURCE_FILE_MARKER');
    expect(sourceSummary).toContain('PF01_PARENT_DISPLAYNAME_MARKER');
    expect(sourceSummary).toContain('PF01_PARENT_SCOPE_MARKER');
    expect(sourceSummary).not.toContain('PF01_PARENT_SECRET_SECTION_MARKER');
    expect(sourceSummary).not.toContain('PF01_PARENT_NOT_HOLD_SECRET_MARKER');
    expect(sourcesRead.some((name) => /parent/i.test(name))).toBe(true);
  });

  it('a parentRef naming a persona that does not exist on disk still produces a valid sourceSummary, not an error', async () => {
    const fakeHome = await makeTempRoot('mnemosyne-pf01-missing-parent-fakehome-');
    const repoRoot = await makeTempRoot('mnemosyne-pf01-missing-parent-repo-');
    await writeFile(path.join(repoRoot, 'source.md'), 'PF01_MISSING_PARENT_SOURCE_MARKER', 'utf8');

    const result = await crawlExplicitFiles({
      filePaths: ['source.md'],
      repoRoot,
      parentRef: { tier: 'company-director', scopeId: 'pf01-does-not-exist' },
      home: fakeHome,
    });

    expect(result.sourceSummary.length).toBeGreaterThan(0);
    expect(result.sourceSummary).toContain('PF01_MISSING_PARENT_SOURCE_MARKER');
  });
});

describe('pf-01: required params', () => {
  it('throws when repoRoot is missing', async () => {
    await expect(crawlExplicitFiles({ filePaths: ['a.md'] } as any)).rejects.toThrow(/repoRoot/);
  });

  it('throws when filePaths is not an array', async () => {
    const repoRoot = await makeTempRoot('mnemosyne-pf01-bad-filepaths-');
    await expect(crawlExplicitFiles({ repoRoot } as any)).rejects.toThrow(/filePaths/);
  });
});
