import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { syncAllHarnesses, syncHarnessFile } from '../sync.js';
import { HARNESS_TARGETS } from '../harness.js';
import { BLOCK_END, BLOCK_START } from '../block.js';

const tempRoots: string[] = [];
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mnemosyne-layer1-'));
  tempRoots.push(root);
  return root;
}

async function makeLevel0(root: string, content: string): Promise<string> {
  const level0Path = path.join(root, 'level0-rules.md');
  await writeFile(level0Path, content, 'utf8');
  return level0Path;
}

describe('syncHarnessFile', () => {
  it('throws a clear error and writes nothing if Level 0 rules file is missing', async () => {
    const root = await makeTempRoot();
    const targetPath = path.join(root, 'CLAUDE.md');
    expect(() =>
      syncHarnessFile(targetPath, 'code-architect', 'claude-code', {
        level0Path: path.join(root, 'does-not-exist.md'),
      }),
    ).toThrow(/level 0/i);
    expect(existsSync(targetPath)).toBe(false);
  });

  it('creates the target file if it does not already exist', async () => {
    const root = await makeTempRoot();
    const level0Path = await makeLevel0(root, '# Level 0\n\nPull first. Never commit to main.\n');
    const targetPath = path.join(root, 'CLAUDE.md');

    expect(existsSync(targetPath)).toBe(false);
    const result = syncHarnessFile(targetPath, 'code-architect', 'claude-code', { level0Path });
    expect(result.created).toBe(true);
    expect(existsSync(targetPath)).toBe(true);
  });

  it('Level 0 content is verbatim and appears first in the managed block, ahead of tier content', async () => {
    const root = await makeTempRoot();
    const level0Body = 'Pull first. Never commit to main or dev directly. Feature branch off dev.';
    const level0Path = await makeLevel0(root, `# Level 0 — Operator Global Rules\n\n${level0Body}\n`);
    const targetPath = path.join(root, 'CLAUDE.md');

    syncHarnessFile(targetPath, 'project-orchestrator', 'claude-code', { level0Path });
    const written = await readFile(targetPath, 'utf8');

    expect(written).toContain(level0Body);
    const blockStart = written.indexOf(BLOCK_START);
    const level0Idx = written.indexOf(level0Body);
    const blockEnd = written.indexOf(BLOCK_END);
    expect(level0Idx).toBeGreaterThan(blockStart);
    expect(level0Idx).toBeLessThan(blockEnd);

    // Level 0 must be first -- i.e. no tier-specific heading appears before it.
    const tierHeadingIdx = written.indexOf('Project Orchestrator');
    expect(level0Idx).toBeLessThan(tierHeadingIdx);
  });

  it('reads Level 0 fresh on every call -- no stale caching across two syncs', async () => {
    const root = await makeTempRoot();
    const level0Path = await makeLevel0(root, 'Original level 0 rule text.');
    const targetPath = path.join(root, 'CLAUDE.md');

    syncHarnessFile(targetPath, 'code-architect', 'claude-code', { level0Path });
    let written = await readFile(targetPath, 'utf8');
    expect(written).toContain('Original level 0 rule text.');

    await writeFile(level0Path, 'Updated level 0 rule text.', 'utf8');
    syncHarnessFile(targetPath, 'code-architect', 'claude-code', { level0Path });
    written = await readFile(targetPath, 'utf8');

    expect(written).toContain('Updated level 0 rule text.');
    expect(written).not.toContain('Original level 0 rule text.');
  });

  it('is idempotent: second run updates only the managed block, human content outside it survives untouched', async () => {
    const root = await makeTempRoot();
    const level0Path = await makeLevel0(root, 'Level 0 rules v1.');
    const targetPath = path.join(root, 'CLAUDE.md');

    await writeFile(
      targetPath,
      '# My Repo\n\nHuman-authored setup notes that must never be touched.\n',
      'utf8',
    );

    const first = syncHarnessFile(targetPath, 'code-architect', 'claude-code', { level0Path });
    expect(first.created).toBe(false);
    const afterFirst = await readFile(targetPath, 'utf8');
    expect(afterFirst).toContain('Human-authored setup notes that must never be touched.');
    expect(afterFirst).toContain('Level 0 rules v1.');

    // Human edits the file outside the managed block between syncs.
    const withHumanAddition = `${afterFirst}\n## Extra human section\n\nAdded by a person.\n`;
    await writeFile(targetPath, withHumanAddition, 'utf8');

    await writeFile(level0Path, 'Level 0 rules v2.', 'utf8');
    const second = syncHarnessFile(targetPath, 'code-architect', 'claude-code', { level0Path });
    expect(second.created).toBe(false);

    const afterSecond = await readFile(targetPath, 'utf8');
    expect(afterSecond).toContain('Human-authored setup notes that must never be touched.');
    expect(afterSecond).toContain('## Extra human section');
    expect(afterSecond).toContain('Added by a person.');
    expect(afterSecond).toContain('Level 0 rules v2.');
    expect(afterSecond).not.toContain('Level 0 rules v1.');

    // No duplicated markers.
    expect(afterSecond.split(BLOCK_START)).toHaveLength(2);
    expect(afterSecond.split(BLOCK_END)).toHaveLength(2);
  });
});

describe('syncAllHarnesses', () => {
  it('writes all three native harness files with equivalent tier information', async () => {
    const root = await makeTempRoot();
    const level0Path = await makeLevel0(root, 'Shared level 0 rule.');
    const repoRoot = path.join(root, 'repo');
    await rm(repoRoot, { recursive: true, force: true });
    await (await import('node:fs/promises')).mkdir(repoRoot, { recursive: true });

    const results = syncAllHarnesses(repoRoot, 'company-director', { level0Path });
    expect(results).toHaveLength(3);

    const fileNames = HARNESS_TARGETS.map((t) => t.fileName);
    expect(fileNames.sort()).toEqual(['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'].sort());

    const contents = await Promise.all(
      fileNames.map((name) => readFile(path.join(repoRoot, name), 'utf8')),
    );

    for (const content of contents) {
      expect(content).toContain('Shared level 0 rule.');
      expect(content).toContain('Company Director');
    }

    // No harness-specific divergence in the informational content -- strip
    // the file-format wrapper (markers only) and compare the rest verbatim.
    const bodies = contents.map((c) => c.replace(BLOCK_START, '').replace(BLOCK_END, '').trim());
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[1]).toEqual(bodies[2]);
  });

  it('la-07: every generated harness file carries the memory-lifecycle mandate (recall-on-entry/remember-on-exit/flight-status)', async () => {
    const root = await makeTempRoot();
    const level0Path = await makeLevel0(root, 'Shared level 0 rule.');
    const repoRoot = path.join(root, 'repo-mandate');
    await (await import('node:fs/promises')).mkdir(repoRoot, { recursive: true });

    syncAllHarnesses(repoRoot, 'code-architect', { level0Path });

    const fileNames = HARNESS_TARGETS.map((t) => t.fileName);
    const contents = await Promise.all(
      fileNames.map((name) => readFile(path.join(repoRoot, name), 'utf8')),
    );

    for (const content of contents) {
      expect(content).toContain('Memory-lifecycle mandate');
      const lower = content.toLowerCase();
      expect(lower).toContain('recall');
      expect(lower).toContain('remember');
      expect(lower).toContain('provisional');
      expect(lower).toContain('confirmed');
      expect(lower).toContain('superseded');
    }
  });

  it('each sync run creates the file fresh when absent, per harness', async () => {
    const root = await makeTempRoot();
    const level0Path = await makeLevel0(root, 'Rule.');
    const repoRoot = path.join(root, 'repo2');
    await (await import('node:fs/promises')).mkdir(repoRoot, { recursive: true });

    const results = syncAllHarnesses(repoRoot, 'top-orchestrator', { level0Path });
    expect(results.every((r) => r.created)).toBe(true);
    for (const target of HARNESS_TARGETS) {
      expect(existsSync(path.join(repoRoot, target.fileName))).toBe(true);
    }
  });
});
