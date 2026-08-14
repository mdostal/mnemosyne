/**
 * Mandate-enforcement-mechanism compliance checks
 * (la-11-memory-lifecycle-compliance-audit, epic:
 * mnemosyne-layer-architecture-v2).
 *
 * la-07's Layer-1 mandate (`layer1/tiers.ts`'s `MANDATE_SECTIONS`) TELLS
 * every agent that recall-on-entry/remember-on-exit "already happens
 * automatically" via installed hooks. That claim is only true if the hooks
 * are actually installed for a given machine/repo — this module checks THAT,
 * for real, rather than trusting the mandate text's own description of
 * itself. Per this story's first acceptance criterion, a miss here must
 * come with SPECIFIC evidence (the exact file checked, the exact command
 * run), never a vague "not compliant" with no trail.
 *
 * Two real, independently-installed mechanisms, two checks:
 *   - Claude Code lifecycle hooks (`hooks/pre-recall.mjs` on
 *     `UserPromptSubmit`, `hooks/post-remember.mjs` on `Stop`/
 *     `SubagentStop`) — installed by `bin/mnemosyne-install-hooks` into a
 *     settings.json (see `hooks/settings.hooks.json`'s shape). Checked by
 *     reading that real settings.json and looking for a real command string
 *     naming the hook script — the same shape the installer itself writes.
 *   - la-06's git lifecycle hooks (`post-merge`/`reference-transaction`) —
 *     installed by `bin/mnemosyne-install-git-hooks` into a repo's REAL
 *     hooks dir (`git rev-parse --git-path hooks`, so worktrees/a custom
 *     `core.hooksPath` resolve correctly, exactly as that installer does).
 *     Checked by reading the real file and looking for the same
 *     `# mnemosyne-git-hook: <name>` marker that installer writes
 *     (`bin/mnemosyne-install-git-hooks`'s `markerFor`) — never
 *     reimplemented, just matched against.
 *
 * Absence of either mechanism does not by itself prove a session skipped
 * recall/remember (a harness without a hook mechanism, e.g. Codex/Gemini
 * CLI, is expected to rely on the mandate TEXT instead, per la-07's third
 * acceptance criterion) — but it IS the one real, checkable signal that the
 * AUTOMATIC enforcement path la-07's mandate text promises is not actually
 * live on this machine/repo, which is exactly what this story's first
 * acceptance criterion asks the audit to flag.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { MandateComplianceCheck } from './types.js';

const execFileAsync = promisify(execFile);

interface HooksBlock {
  hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
}

function hasHookCommand(block: HooksBlock, event: string, scriptBasename: string): boolean {
  const groups = block.hooks?.[event] ?? [];
  for (const group of groups) {
    for (const hook of group.hooks ?? []) {
      if (typeof hook.command === 'string' && hook.command.includes(scriptBasename)) return true;
    }
  }
  return false;
}

/**
 * Checks a real Claude Code `settings.json` (default
 * `~/.claude/settings.json`, but always an explicit path here — callers
 * resolve the default) for the two hook wirings `bin/mnemosyne-install-hooks`
 * installs. Never throws on a missing/malformed file — that IS the
 * non-compliant finding, with the exact path as evidence.
 */
export async function checkClaudeCodeHooksInstalled(settingsPath: string): Promise<MandateComplianceCheck[]> {
  let block: HooksBlock = {};
  let readError: string | null = null;
  try {
    const raw = await readFile(settingsPath, 'utf8');
    block = JSON.parse(raw) as HooksBlock;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    readError =
      err.code === 'ENOENT'
        ? `settings.json not found at ${settingsPath}`
        : `settings.json at ${settingsPath} could not be read/parsed: ${err.message}`;
  }

  const recallCompliant = readError === null && hasHookCommand(block, 'UserPromptSubmit', 'pre-recall.mjs');
  const rememberStopCompliant = readError === null && hasHookCommand(block, 'Stop', 'post-remember.mjs');
  const rememberSubagentCompliant = readError === null && hasHookCommand(block, 'SubagentStop', 'post-remember.mjs');

  const evidenceFor = (compliant: boolean, description: string) =>
    compliant
      ? `${settingsPath}: ${description} is wired up`
      : (readError ?? `${settingsPath}: hooks.${description} has no entry naming the expected script`);

  return [
    {
      label: 'Claude Code UserPromptSubmit -> hooks/pre-recall.mjs (recall on entry)',
      compliant: recallCompliant,
      evidence: evidenceFor(recallCompliant, 'UserPromptSubmit -> pre-recall.mjs'),
    },
    {
      label: 'Claude Code Stop -> hooks/post-remember.mjs (remember on exit)',
      compliant: rememberStopCompliant,
      evidence: evidenceFor(rememberStopCompliant, 'Stop -> post-remember.mjs'),
    },
    {
      label: 'Claude Code SubagentStop -> hooks/post-remember.mjs (remember on subagent exit)',
      compliant: rememberSubagentCompliant,
      evidence: evidenceFor(rememberSubagentCompliant, 'SubagentStop -> post-remember.mjs'),
    },
  ];
}

/** Mirrors `bin/mnemosyne-install-git-hooks`'s own `HOOK_NAMES`/`markerFor` — never reimplemented logic, just the same two names and the same marker string that installer writes, matched against here read-only. */
const GIT_HOOK_NAMES = ['post-merge', 'reference-transaction'] as const;
function markerFor(hookName: string): string {
  return `# mnemosyne-git-hook: ${hookName}`;
}

/**
 * Resolves `repoPath`'s REAL hooks directory the same way
 * `bin/mnemosyne-install-git-hooks`'s `resolveHooksDir` does (`git
 * rev-parse --git-path hooks`), then checks each of `GIT_HOOK_NAMES` for a
 * real file on disk carrying that installer's marker line.
 */
export async function checkGitLifecycleHooksInstalled(repoPath: string): Promise<MandateComplianceCheck[]> {
  let hooksDir: string;
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--git-path', 'hooks'], { cwd: repoPath });
    hooksDir = path.resolve(repoPath, stdout.trim());
  } catch (error) {
    const err = error as { message?: string };
    return GIT_HOOK_NAMES.map((name) => ({
      label: `git ${name} hook (la-06 lifecycle trigger)`,
      compliant: false,
      evidence: `${repoPath} does not resolve to a real git working tree (git rev-parse --git-path hooks failed: ${err.message ?? String(error)})`,
    }));
  }

  const checks: MandateComplianceCheck[] = [];
  for (const hookName of GIT_HOOK_NAMES) {
    const target = path.join(hooksDir, hookName);
    try {
      const content = await readFile(target, 'utf8');
      const compliant = content.includes(markerFor(hookName));
      checks.push({
        label: `git ${hookName} hook (la-06 lifecycle trigger)`,
        compliant,
        evidence: compliant
          ? `${target} exists and carries the '${markerFor(hookName)}' marker`
          : `${target} exists but was NOT installed by bin/mnemosyne-install-git-hooks (no '${markerFor(hookName)}' marker) — a foreign hook may be shadowing la-06's promotion/supersede mechanism`,
      });
    } catch {
      checks.push({
        label: `git ${hookName} hook (la-06 lifecycle trigger)`,
        compliant: false,
        evidence: `${target} does not exist — run bin/mnemosyne-install-git-hooks against this repo to close la-06's documented machine-coverage gap`,
      });
    }
  }
  return checks;
}
