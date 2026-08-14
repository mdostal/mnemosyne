/**
 * Human-readable rendering of a `LifecycleComplianceAuditReport`
 * (la-11-memory-lifecycle-compliance-audit). Pure formatting — no I/O, no
 * git, no fs. `index.ts`'s `runComplianceAudit` produces the report data;
 * `cli.ts` calls this to print it.
 */
import type { LifecycleComplianceAuditReport } from './types.js';

function renderEvidence(evidence: readonly { command: readonly string[]; result: string; stdout?: string }[]): string {
  return evidence
    .map((e) => `      $ ${e.command.join(' ')}\n      -> ${e.result}${e.stdout ? `\n      stdout: ${e.stdout}` : ''}`)
    .join('\n');
}

export function renderReportText(report: LifecycleComplianceAuditReport): string {
  const lines: string[] = [];
  lines.push(`Mnemosyne lifecycle compliance audit — ${report.generatedAt}`);
  lines.push(`repo: ${report.repoPath}`);
  lines.push(`notes directory: ${report.notesDirectory}`);
  lines.push(`default branch: ${report.defaultBranch}`);
  lines.push('');

  lines.push('== Mandate enforcement mechanisms (la-07) ==');
  if (report.mandateChecks.length === 0) {
    lines.push('  (no checks run)');
  }
  for (const check of report.mandateChecks) {
    lines.push(`  [${check.compliant ? 'OK' : 'NON-COMPLIANT'}] ${check.label}`);
    lines.push(`      ${check.evidence}`);
  }
  lines.push('');

  lines.push('== Stale-provisional drift (la-06 gap backstop) ==');
  if (report.staleProvisionalFindings.length === 0) {
    lines.push('  no drift detected');
  }
  for (const finding of report.staleProvisionalFindings) {
    lines.push(
      `  [${finding.verification.classification.toUpperCase()}] ${finding.entry.id} (branch=${finding.entry.source_ref.branch} commit=${finding.entry.source_ref.commit_sha})`,
    );
    if (finding.verification.reason) lines.push(`      reason: ${finding.verification.reason}`);
    lines.push(renderEvidence(finding.verification.evidence));
  }
  if (report.outOfScopeCount > 0) {
    lines.push(`  (${report.outOfScopeCount} additional provisional entr${report.outOfScopeCount === 1 ? 'y' : 'ies'} untraceable/out-of-scope for this repo — not itemized, no evidence to report)`);
  }
  lines.push('');

  lines.push('== Remediations applied ==');
  if (report.remediations.length === 0) {
    lines.push('  none');
  }
  for (const action of report.remediations) {
    lines.push(`  ${action.entryId}: ${action.from} -> ${action.to} (via ${action.adapter}, ${action.appliedAt})`);
    lines.push(`      ${action.detail}`);
    lines.push(renderEvidence(action.evidence));
  }

  return lines.join('\n');
}
