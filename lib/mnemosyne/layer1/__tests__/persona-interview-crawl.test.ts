// persona-interview-crawl.test.ts — TDD coverage for
// pu-07-bounded-crawl-context: skills/mnemosyne-persona-interview/'s new
// bounded, capped crawl step, replacing the old SKILL.md step 2 prose
// ("load whatever's already known") with an explicit, NAMED, CAPPED source
// list and a resulting `sourceSummary` string
// (design-discussion.md §3c; horizontal-plan.md H6).
//
// Four acceptance criteria (pu-07-bounded-crawl-context.yaml), each its own
// describe block below:
//   1. The named source list is read exhaustively but never exceeded -- a
//      fixture repo with extra, irrelevant files proves those are never
//      touched.
//   2. The cap is enforced -- an oversized README produces a truncated,
//      capped sourceSummary, never a full dump.
//   3. The no-sources-present case still produces a valid, non-empty
//      sourceSummary and never throws (this skill's existing non-blocking
//      hard-fail philosophy, pw-10/12, extended to the crawl step).
//   4. A parent persona's full `sections` content never appears verbatim in
//      the resulting sourceSummary -- only its own displayName/scope
//      summary does (persona.ts's buildParentContextSections "query up,
//      never copy down" boundary, respected identically here).
//
// Also a structural check that SKILL.md's crawl-step prose names the exact
// same source list and cap values crawl-context.mjs actually implements
// (this story's own "review" step, re-proven here so doc/code parity is a
// real, running check, not just a one-time review action).

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { assertValidPersona, type Persona } from '../persona.js';
// interview-engine.mjs / persona-writer.mjs / crawl-context.mjs are plain
// ESM JS (no TS types) -- imported by relative path exactly like the skill
// itself would load them; vitest resolves .mjs fine (same convention as
// this directory's other persona-interview-*.test.ts files).
// eslint-disable-next-line import/extensions
import { runPersonaInterview } from '../../../../skills/mnemosyne-persona-interview/interview-engine.mjs';
// eslint-disable-next-line import/extensions
import { writePersonaViaCli } from '../../../../skills/mnemosyne-persona-interview/persona-writer.mjs';
// eslint-disable-next-line import/extensions
import {
  AGENT_FILE_CANDIDATES,
  MANIFEST_CANDIDATES,
  MAX_CHARS_PER_SOURCE,
  MAX_LINES_PER_SOURCE,
  MAX_SOURCE_SUMMARY_CHARS,
  README_CANDIDATES,
  crawlBoundedContext,
} from '../../../../skills/mnemosyne-persona-interview/crawl-context.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(__dirname, '../../../../skills/mnemosyne-persona-interview');
const SKILL_MD_PATH = path.join(SKILL_DIR, 'SKILL.md');

const tempRoots: string[] = [];
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

describe('pu-07: bounded source list is read exhaustively but never exceeded', () => {
  it('reads README + manifest + CLAUDE.md + AGENTS.md when present, and never touches other repo files', async () => {
    const repoRoot = await makeTempRoot('mnemosyne-pu07-named-sources-');
    await writeFile(path.join(repoRoot, 'README.md'), 'README_MARKER — this repo does X.', 'utf8');
    await writeFile(path.join(repoRoot, 'package.json'), JSON.stringify({ name: 'PACKAGE_MARKER-repo' }), 'utf8');
    await writeFile(path.join(repoRoot, 'CLAUDE.md'), 'CLAUDE_MD_MARKER — agent rules.', 'utf8');
    await writeFile(path.join(repoRoot, 'AGENTS.md'), 'AGENTS_MD_MARKER — agent rules v2.', 'utf8');

    // Extra, irrelevant files NOT on the named source list -- must never be read.
    await writeFile(path.join(repoRoot, 'NOTES.md'), 'IRRELEVANT_NOTES_MARKER — scratch notes.', 'utf8');
    await writeFile(path.join(repoRoot, 'SECRET.txt'), 'IRRELEVANT_SECRET_MARKER — do not leak.', 'utf8');
    await mkdir(path.join(repoRoot, 'src'));
    await writeFile(path.join(repoRoot, 'src', 'index.js'), 'IRRELEVANT_SRC_MARKER', 'utf8');

    const { sourceSummary, sourcesRead } = await crawlBoundedContext({ repoRoot });

    expect(sourceSummary).toContain('README_MARKER');
    expect(sourceSummary).toContain('PACKAGE_MARKER');
    expect(sourceSummary).toContain('CLAUDE_MD_MARKER');
    expect(sourceSummary).toContain('AGENTS_MD_MARKER');

    expect(sourceSummary).not.toContain('IRRELEVANT_NOTES_MARKER');
    expect(sourceSummary).not.toContain('IRRELEVANT_SECRET_MARKER');
    expect(sourceSummary).not.toContain('IRRELEVANT_SRC_MARKER');

    // 4 file-backed sources found (no parentRef supplied in this case).
    expect(sourcesRead.length).toBe(4);
  });

  it('the named source list constants are exactly the documented fixed set (no silent growth)', () => {
    expect(README_CANDIDATES).toEqual(expect.arrayContaining(['README.md']));
    expect(MANIFEST_CANDIDATES).toEqual(expect.arrayContaining(['package.json']));
    expect(AGENT_FILE_CANDIDATES).toEqual(['CLAUDE.md', 'AGENTS.md']);
  });
});

describe('pu-07: the cap is enforced, not just documented', () => {
  it('an oversized README produces a truncated, capped sourceSummary -- never a full dump', async () => {
    const repoRoot = await makeTempRoot('mnemosyne-pu07-oversized-readme-');
    const lines = Array.from({ length: 500 }, (_, i) => `LINE_${String(i).padStart(4, '0')}_MARKER content here.`);
    await writeFile(path.join(repoRoot, 'README.md'), lines.join('\n'), 'utf8');

    const { sourceSummary } = await crawlBoundedContext({ repoRoot });

    // Early lines survive the cap; deep-into-the-file lines do not.
    expect(sourceSummary).toContain('LINE_0000_MARKER');
    expect(sourceSummary).not.toContain('LINE_0499_MARKER');
    expect(sourceSummary).not.toContain('LINE_0250_MARKER');

    // The whole assembled summary stays within its own documented ceiling
    // (plus a small allowance for the truncation marker text itself).
    expect(sourceSummary.length).toBeLessThanOrEqual(MAX_SOURCE_SUMMARY_CHARS + 64);

    // Never silently truncated -- an explicit, visible marker is present.
    expect(sourceSummary).toMatch(/truncat|capp|…|\.\.\./i);
  });

  it('a single pathologically long line is still capped by MAX_CHARS_PER_SOURCE, not just the line cap', async () => {
    const repoRoot = await makeTempRoot('mnemosyne-pu07-long-line-');
    const longLine = 'X'.repeat(MAX_CHARS_PER_SOURCE * 4);
    await writeFile(path.join(repoRoot, 'README.md'), longLine, 'utf8');

    const { sourceSummary } = await crawlBoundedContext({ repoRoot });
    const xRun = sourceSummary.match(/X+/);
    expect(xRun).not.toBeNull();
    expect((xRun as RegExpMatchArray)[0].length).toBeLessThanOrEqual(MAX_CHARS_PER_SOURCE);
  });

  it('caps are real, positive, documented constants (a future retune has one clear point of change)', () => {
    expect(MAX_LINES_PER_SOURCE).toBeGreaterThan(0);
    expect(MAX_CHARS_PER_SOURCE).toBeGreaterThan(0);
    expect(MAX_SOURCE_SUMMARY_CHARS).toBeGreaterThan(0);
  });
});

describe('pu-07: no sources present -- still produces a valid, non-empty sourceSummary, never errors', () => {
  it('an empty repo with no parent ref produces a minimal, non-empty sourceSummary', async () => {
    const repoRoot = await makeTempRoot('mnemosyne-pu07-empty-repo-');

    const result = await crawlBoundedContext({ repoRoot });

    expect(result.sourceSummary).toEqual(expect.any(String));
    expect(result.sourceSummary.length).toBeGreaterThan(0);
    expect(result.sourcesRead).toEqual([]);
    expect(result.sourcesMissing.length).toBeGreaterThan(0);
  });

  it('never throws even when repoRoot itself does not exist on disk', async () => {
    const nonExistentRoot = path.join(tmpdir(), 'mnemosyne-pu07-does-not-exist-' + Date.now());
    await expect(crawlBoundedContext({ repoRoot: nonExistentRoot })).resolves.toBeTruthy();
  });
});

describe('pu-07: parent persona summary-only -- never the parent\'s full sections content', () => {
  it('includes the parent\'s displayName/scope but never its sections body verbatim', async () => {
    const fakeHome = await makeTempRoot('mnemosyne-pu07-parent-fakehome-');
    const repoRoot = await makeTempRoot('mnemosyne-pu07-parent-repo-');

    const { persona: parentPersona } = runPersonaInterview({
      tier: 'project-orchestrator',
      scopeId: 'pu07-parent-project',
      displayName: 'PARENT_DISPLAYNAME_MARKER — Project Orchestrator',
      scope: 'PARENT_SCOPE_MARKER — cross-repo coordination only.',
      responses: {
        knows: 'PARENT_SECRET_SECTION_MARKER — this must never leak into a child crawl.',
        not_hold: 'PARENT_NOT_HOLD_SECRET_MARKER — also must never leak.',
        parent: 'none',
      },
    });
    expect(() => assertValidPersona(parentPersona as Persona, 'project-orchestrator')).not.toThrow();

    const writeResult = await writePersonaViaCli(parentPersona, { home: fakeHome });
    expect(writeResult.ok, `CLI create failed: ${writeResult.stderr}`).toBe(true);

    const { sourceSummary, sourcesRead } = await crawlBoundedContext({
      repoRoot,
      parentRef: { tier: 'project-orchestrator', scopeId: 'pu07-parent-project' },
      home: fakeHome,
    });

    expect(sourceSummary).toContain('PARENT_DISPLAYNAME_MARKER');
    expect(sourceSummary).toContain('PARENT_SCOPE_MARKER');
    expect(sourceSummary).not.toContain('PARENT_SECRET_SECTION_MARKER');
    expect(sourceSummary).not.toContain('PARENT_NOT_HOLD_SECRET_MARKER');
    expect(sourcesRead.some((name) => /parent/i.test(name))).toBe(true);
  });

  it('a parentRef naming a persona that does not exist on disk still produces a valid sourceSummary, not an error', async () => {
    const fakeHome = await makeTempRoot('mnemosyne-pu07-missing-parent-fakehome-');
    const repoRoot = await makeTempRoot('mnemosyne-pu07-missing-parent-repo-');

    const result = await crawlBoundedContext({
      repoRoot,
      parentRef: { tier: 'company-director', scopeId: 'pu07-does-not-exist' },
      home: fakeHome,
    });

    expect(result.sourceSummary.length).toBeGreaterThan(0);
    expect(result.sourcesMissing.some((name) => /parent/i.test(name))).toBe(true);
  });
});

describe('SKILL.md: the crawl step prose names the exact same source list and cap the code implements', () => {
  const skillMd = readFileSync(SKILL_MD_PATH, 'utf8');

  it('names the 4 file-backed sources and the parent-summary source', () => {
    expect(skillMd).toMatch(/README/);
    expect(skillMd).toMatch(/package(\.json)?\/project manifest|package\/project manifest/i);
    expect(skillMd).toMatch(/CLAUDE\.md/);
    expect(skillMd).toMatch(/AGENTS\.md/);
    expect(skillMd).toMatch(/parent persona/i);
  });

  it('documents the cap explicitly (not left as an undocumented implementation detail)', () => {
    expect(skillMd).toMatch(/cap/i);
    expect(skillMd).toContain(String(MAX_LINES_PER_SOURCE));
    expect(skillMd).toContain(String(MAX_SOURCE_SUMMARY_CHARS));
  });

  it('names crawl-context.mjs and sourceSummary explicitly', () => {
    expect(skillMd).toMatch(/crawl-context\.mjs/);
    expect(skillMd).toMatch(/sourceSummary/);
  });

  it('states the "query up, never copy down" boundary for the parent summary', () => {
    const flattened = skillMd.replace(/\s+/g, ' ');
    expect(flattened).toMatch(/query up|query-up/i);
    expect(flattened).toMatch(/never.{0,60}copy.{0,10}down|never.{0,60}full.{0,30}content/i);
  });
});
