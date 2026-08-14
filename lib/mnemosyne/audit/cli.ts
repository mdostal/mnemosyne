#!/usr/bin/env -S npx tsx
/**
 * CLI entry point for the memory-lifecycle compliance audit
 * (la-11-memory-lifecycle-compliance-audit, epic:
 * mnemosyne-layer-architecture-v2) — "a runnable command (on-demand first)"
 * per this story's `steps.implement`. Invoked via `bin/mnemosyne-audit-lifecycle`
 * (a bash shim exec'ing this through `node_modules/.bin/tsx`, the same
 * pattern `bin/mnemosyne-client-api` uses for `lib/mnemosyne/server.ts`).
 *
 * Usage:
 *   bin/mnemosyne-audit-lifecycle [--repo <path>] [--notes-dir <path>]
 *     [--default-branch <name>] [--settings <path>] [--report-only] [--json]
 *
 *   --repo PATH           repo to verify git state against (default: cwd)
 *   --notes-dir PATH      notes directory to scan (default: $MNEMOSYNE_NOTES_DIR
 *                          or ~/.local/share/mnemosyne/notes)
 *   --default-branch NAME overrides auto-detection (../flight-status.js's
 *                          detectDefaultBranchName)
 *   --settings PATH       Claude Code settings.json to check (default:
 *                          ~/.claude/settings.json)
 *   --report-only         detection-and-report only, never auto-remediate
 *                          (default: conservative auto-remediation IS on —
 *                          see provisionalDrift.ts's own scoping: it only
 *                          ever acts on the structurally-proven
 *                          verified-merged case)
 *   --json                emit the raw report as JSON instead of text
 *
 * Exit code: 0 if no drift/non-compliance was found or everything drift-worthy
 * was successfully auto-remediated; 1 if unresolved findings remain (ambiguous
 * cases needing human review, or non-compliant mandate checks) — so this is
 * safe to wire into a CI/pre-flight gate later without extra plumbing, even
 * though scheduling itself is explicitly out of scope for this story.
 */
import { runComplianceAudit } from './index.js';
import { renderReportText } from './report.js';

function parseArgs(argv: string[]) {
  const args: {
    repoPath: string;
    notesDirectory?: string | undefined;
    defaultBranch?: string | undefined;
    claudeSettingsPath?: string | undefined;
    reportOnly: boolean;
    json: boolean;
  } = { repoPath: process.cwd(), reportOnly: false, json: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--repo') args.repoPath = argv[++i] ?? args.repoPath;
    else if (arg === '--notes-dir') args.notesDirectory = argv[++i];
    else if (arg === '--default-branch') args.defaultBranch = argv[++i];
    else if (arg === '--settings') args.claudeSettingsPath = argv[++i];
    else if (arg === '--report-only') args.reportOnly = true;
    else if (arg === '--json') args.json = true;
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const report = await runComplianceAudit({
    repoPath: args.repoPath,
    notesDirectory: args.notesDirectory,
    defaultBranch: args.defaultBranch,
    claudeSettingsPath: args.claudeSettingsPath,
    autoRemediate: !args.reportOnly,
  });

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderReportText(report));
  }

  const unresolvedMandateGaps = report.mandateChecks.some((c) => !c.compliant);
  const unresolvedDrift = report.staleProvisionalFindings.some(
    (f) => f.verification.classification === 'ambiguous',
  );
  const hasUnpromotedVerifiedMerge = report.staleProvisionalFindings.some(
    (f) => f.verification.classification === 'verified-merged' && !report.remediations.some((r) => r.entryId === f.entry.id),
  );

  // Deliberately `process.exitCode`, never `process.exit()` here: this
  // command's own `--json` output can be large, and calling `process.exit()`
  // immediately after a big `console.log` to a piped stdout can truncate the
  // write before the pipe flushes (a real Node.js gotcha, reproduced by this
  // story's own `test/lifecycle-compliance-audit.mjs` before this fix — the
  // JSON came back cut off mid-string when read from a real subprocess).
  // Setting `exitCode` and letting the event loop drain naturally guarantees
  // the report is fully written before the process exits.
  process.exitCode = unresolvedMandateGaps || unresolvedDrift || hasUnpromotedVerifiedMerge ? 1 : 0;
}

main().catch((error) => {
  console.error(`mnemosyne-audit-lifecycle: ${(error as Error).message ?? error}`);
  process.exitCode = 2;
});
