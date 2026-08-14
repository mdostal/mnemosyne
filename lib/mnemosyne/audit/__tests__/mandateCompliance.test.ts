/**
 * Tests for `mandateCompliance.ts` — checks whether la-07's mandate
 * enforcement mechanisms are ACTUALLY wired up (not just described in
 * prose/tier content): the Claude Code lifecycle hooks
 * (`hooks/pre-recall.mjs`/`hooks/post-remember.mjs`, installed via
 * `bin/mnemosyne-install-hooks` into a settings.json) and la-06's git
 * lifecycle hooks (`hooks/git/*.mjs`, installed via
 * `bin/mnemosyne-install-git-hooks` into a repo's real `.git/hooks`).
 *
 * Real filesystem + real git subprocess state throughout — a real temp
 * settings.json, a real temp git repo's real hooks dir (resolved via
 * `git rev-parse --git-path hooks`, exactly as the real installer does).
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { checkClaudeCodeHooksInstalled, checkGitLifecycleHooksInstalled } from '../mandateCompliance.js';

const execFileAsync = promisify(execFile);

const tempRoots: string[] = [];
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

async function makeTempRepo(): Promise<string> {
  const root = await makeTempDir('mnemosyne-audit-mandate-repo-');
  await git(root, ['init', '--quiet', '-b', 'main']);
  await git(root, ['config', 'user.email', 'audit-mandate-test@example.com']);
  await git(root, ['config', 'user.name', 'Audit Mandate Test']);
  await git(root, ['commit', '--quiet', '--allow-empty', '-m', 'initial commit']);
  return root;
}

describe('checkClaudeCodeHooksInstalled', () => {
  it('reports non-compliant with specific evidence when settings.json does not exist at all', async () => {
    const dir = await makeTempDir('mnemosyne-audit-settings-');
    const settingsPath = path.join(dir, 'settings.json');

    const checks = await checkClaudeCodeHooksInstalled(settingsPath);
    expect(checks.length).toBeGreaterThan(0);
    for (const check of checks) {
      expect(check.compliant).toBe(false);
      expect(check.evidence).toContain(settingsPath);
    }
  });

  it('reports non-compliant with specific evidence when settings.json exists but has no mnemosyne hook entries', async () => {
    const dir = await makeTempDir('mnemosyne-audit-settings-');
    const settingsPath = path.join(dir, 'settings.json');
    await writeFile(settingsPath, JSON.stringify({ hooks: { UserPromptSubmit: [] } }), 'utf8');

    const checks = await checkClaudeCodeHooksInstalled(settingsPath);
    const recallCheck = checks.find((c) => c.label.toLowerCase().includes('recall'));
    expect(recallCheck?.compliant).toBe(false);
    expect(recallCheck?.evidence).toContain(settingsPath);
  });

  it('reports compliant when settings.json has real pre-recall.mjs / post-remember.mjs entries', async () => {
    const dir = await makeTempDir('mnemosyne-audit-settings-');
    const settingsPath = path.join(dir, 'settings.json');
    await writeFile(
      settingsPath,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node /abs/path/hooks/pre-recall.mjs' }] }],
          Stop: [{ hooks: [{ type: 'command', command: 'node /abs/path/hooks/post-remember.mjs' }] }],
          SubagentStop: [{ hooks: [{ type: 'command', command: 'node /abs/path/hooks/post-remember.mjs' }] }],
        },
      }),
      'utf8',
    );

    const checks = await checkClaudeCodeHooksInstalled(settingsPath);
    expect(checks.every((c) => c.compliant)).toBe(true);
  });
});

describe('checkGitLifecycleHooksInstalled', () => {
  it('reports non-compliant with specific evidence when la-06 git hooks are not installed', async () => {
    const repo = await makeTempRepo();
    const checks = await checkGitLifecycleHooksInstalled(repo);
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every((c) => c.compliant === false)).toBe(true);
    expect(checks.every((c) => c.evidence.includes(repo) || c.evidence.length > 0)).toBe(true);
  });

  it('reports compliant when a real mnemosyne-marked post-merge hook is installed', async () => {
    const repo = await makeTempRepo();
    const { stdout } = await execFileAsync('git', ['rev-parse', '--git-path', 'hooks'], { cwd: repo });
    const hooksDir = path.resolve(repo, stdout.trim());
    await mkdir(hooksDir, { recursive: true });
    await writeFile(
      path.join(hooksDir, 'post-merge'),
      '#!/bin/sh\n# mnemosyne-git-hook: post-merge (auto-installed)\nexec node "/abs/hooks/git/post-merge.mjs" "$@"\n',
      'utf8',
    );
    await writeFile(
      path.join(hooksDir, 'reference-transaction'),
      '#!/bin/sh\n# mnemosyne-git-hook: reference-transaction (auto-installed)\nexec node "/abs/hooks/git/reference-transaction.mjs" "$@"\n',
      'utf8',
    );

    const checks = await checkGitLifecycleHooksInstalled(repo);
    expect(checks.every((c) => c.compliant)).toBe(true);
  });
});
