/**
 * Orchestrator for the memory-lifecycle compliance audit
 * (la-11-memory-lifecycle-compliance-audit, epic:
 * mnemosyne-layer-architecture-v2) — the "runnable command" this story's
 * `implement` step calls for. Combines:
 *
 *   - `mandateCompliance.ts`: is la-07's automatic enforcement mechanism
 *     actually installed on this machine/repo? (acceptance criterion 1)
 *   - `provisionalDrift.ts`: does real git state show a `provisional` entry
 *     should already have been promoted — la-06's own documented gap
 *     (acceptance criterion 2), with every remediation logged with its
 *     justifying evidence (acceptance criterion 3).
 *
 * On-demand only, by design — scheduling/cron cadence is explicitly out of
 * scope for this story (its own `steps.implement` note: "scheduling/'sleep'
 * cadence is a follow-on decision, not required for this story's
 * completion").
 */
import { homedir } from 'node:os';
import path from 'node:path';
import { detectDefaultBranchName } from '../flight-status.js';
import { NotesDirectoryStatusStore } from '../triggers/notesStore.js';
import { checkClaudeCodeHooksInstalled, checkGitLifecycleHooksInstalled } from './mandateCompliance.js';
import { detectStaleProvisional } from './provisionalDrift.js';
import type { LifecycleComplianceAuditReport } from './types.js';

export const DEFAULT_NOTES_DIRECTORY =
  process.env.MNEMOSYNE_NOTES_DIR || path.join(homedir(), '.local', 'share', 'mnemosyne', 'notes');
export const DEFAULT_CLAUDE_SETTINGS_PATH = path.join(homedir(), '.claude', 'settings.json');

export interface RunComplianceAuditOptions {
  repoPath: string;
  notesDirectory?: string | undefined;
  defaultBranch?: string | undefined;
  claudeSettingsPath?: string | undefined;
  /** Default `true` — see `provisionalDrift.ts`'s `DetectStaleProvisionalOptions`. */
  autoRemediate?: boolean | undefined;
  gitBin?: string | undefined;
  timeoutMs?: number | undefined;
}

export async function runComplianceAudit(
  options: RunComplianceAuditOptions,
): Promise<LifecycleComplianceAuditReport> {
  const notesDirectory = options.notesDirectory ?? DEFAULT_NOTES_DIRECTORY;
  const claudeSettingsPath = options.claudeSettingsPath ?? DEFAULT_CLAUDE_SETTINGS_PATH;
  const gitVerifyOptions = {
    cwd: options.repoPath,
    gitBin: options.gitBin,
    timeoutMs: options.timeoutMs,
  };
  const defaultBranch =
    options.defaultBranch ?? (await detectDefaultBranchName({ cwd: options.repoPath, gitBin: options.gitBin, timeoutMs: options.timeoutMs }));

  const [claudeHookChecks, gitHookChecks] = await Promise.all([
    checkClaudeCodeHooksInstalled(claudeSettingsPath),
    checkGitLifecycleHooksInstalled(options.repoPath),
  ]);

  const store = new NotesDirectoryStatusStore({ notesDirectory });
  const drift = await detectStaleProvisional(store, {
    ...gitVerifyOptions,
    defaultBranch,
    autoRemediate: options.autoRemediate,
  });

  return {
    generatedAt: new Date().toISOString(),
    repoPath: options.repoPath,
    notesDirectory,
    defaultBranch,
    mandateChecks: [...claudeHookChecks, ...gitHookChecks],
    staleProvisionalFindings: drift.findings,
    remediations: drift.remediations,
    outOfScopeCount: drift.outOfScopeCount,
  };
}

export type { LifecycleComplianceAuditReport } from './types.js';
