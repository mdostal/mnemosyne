/**
 * Tests for `index.ts`'s `runComplianceAudit` orchestrator — combines
 * `mandateCompliance.ts`'s checks with `provisionalDrift.ts`'s detection
 * over a real `NotesDirectoryStatusStore` (la-06's own store, reused
 * unmodified) against a real temp git repo + real temp notes directory.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { runComplianceAudit } from '../index.js';

const execFileAsync = promisify(execFile);

const tempRoots: string[] = [];
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

async function makeTempRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mnemosyne-audit-index-repo-'));
  tempRoots.push(root);
  await git(root, ['init', '--quiet', '-b', 'main']);
  await git(root, ['config', 'user.email', 'audit-index-test@example.com']);
  await git(root, ['config', 'user.name', 'Audit Index Test']);
  await git(root, ['commit', '--quiet', '--allow-empty', '-m', 'initial commit']);
  return root;
}

async function makeNotesDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mnemosyne-audit-index-notes-'));
  tempRoots.push(dir);
  return dir;
}

async function writeNote(dir: string, name: string, status: string, branch: string, commit: string): Promise<string> {
  const file = path.join(dir, name);
  const header = `<!-- remembered via Mnemosyne @ 2026-08-13T00:00:00.000Z status=${status} branch=${branch} commit=${commit} -->\n`;
  await writeFile(file, header + 'a real note body\n', 'utf8');
  return file;
}

describe('runComplianceAudit', () => {
  it('promotes a real verified-merged note on disk and reports non-compliant mandate checks with real evidence', async () => {
    const repo = await makeTempRepo();
    const notesDir = await makeNotesDir();

    await git(repo, ['checkout', '--quiet', '-b', 'feat/index-merge']);
    await git(repo, ['commit', '--quiet', '--allow-empty', '-m', 'work']);
    const sha = await git(repo, ['rev-parse', 'HEAD']);
    await git(repo, ['checkout', '--quiet', 'main']);
    await git(repo, ['merge', '--quiet', '--no-ff', '-m', "Merge branch 'feat/index-merge'", 'feat/index-merge']);

    const noteFile = await writeNote(notesDir, 'note-1.md', 'provisional', 'feat/index-merge', sha);

    const missingSettingsPath = path.join(repo, 'does-not-exist-settings.json');
    const report = await runComplianceAudit({
      repoPath: repo,
      notesDirectory: notesDir,
      defaultBranch: 'main',
      claudeSettingsPath: missingSettingsPath,
      autoRemediate: true,
    });

    expect(report.repoPath).toBe(repo);
    expect(report.remediations).toHaveLength(1);
    expect(report.remediations[0]!.entryId).toBe(noteFile);
    expect(report.mandateChecks.some((c) => !c.compliant)).toBe(true);

    const onDisk = await readFile(noteFile, 'utf8');
    expect(onDisk).toContain('status=confirmed');
  });
});
