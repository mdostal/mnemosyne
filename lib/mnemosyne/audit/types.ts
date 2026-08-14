/**
 * Shared types for the memory-lifecycle compliance audit
 * (la-11-memory-lifecycle-compliance-audit, epic: mnemosyne-layer-architecture-v2).
 *
 * This is the explicitly-designed backstop for la-06's own documented risk:
 * "git hooks only fire on the machine where the merge/branch-delete happens —
 * a merge or branch delete on a machine without the hook installed (or done
 * entirely through a GitHub/hosted-PR UI merge with no local git operation on
 * any hooked machine) silently never promotes/supersedes"
 * (la-06-lifecycle-trigger-system.yaml's `risks[0]`, `note`'s "KNOWN GAP"
 * paragraph). This module only defines the shapes; `gitVerify.ts` runs the
 * real git commands, `provisionalDrift.ts` classifies entries and drives
 * conservative auto-remediation through la-06's own `applyLifecycleEvent`
 * (never reimplemented), `mandateCompliance.ts` checks whether la-07's
 * enforcement mechanisms are actually wired up, `report.ts` renders it all.
 *
 * Every design decision here follows this story's own stated bar
 * (`design_decisions[0]`): "Detection-and-report first, auto-remediation
 * only on independently-verified state" — never guessed, never silent.
 */
import type { Status } from '../interfaces.js';
import type { MemoryEntryRef } from '../triggers/types.js';

/**
 * One real git (or filesystem) command run as evidence for a classification
 * or compliance decision — never summarized away. `command` is the exact
 * argv (so a log line can be copy-pasted and re-run by a human), `result` is
 * a human-readable one-line verdict, `stdout` is the raw (trimmed) output
 * when there was any worth keeping.
 */
export interface Evidence {
  command: readonly string[];
  cwd: string;
  result: string;
  stdout?: string;
}

/**
 * The four possible outcomes of independently verifying one `provisional`
 * entry's `source_ref` against a repo's real git state — see
 * `provisionalDrift.ts`'s `classifyEntry` for exactly how each is reached.
 *
 *   - `verified-merged`: the entry's commit is a real, structurally-provable
 *     ancestor of the default branch (`git merge-base --is-ancestor`).
 *     Exactly la-06's documented gap — auto-remediation-eligible.
 *   - `still-open`: real git state shows this is legitimately still
 *     in-flight (commit known but not merged, or the branch still exists
 *     locally/remotely). Not drift — never reported, never remediated.
 *   - `ambiguous`: the commit is unknown to this repo's object database and
 *     the branch no longer exists, but the default branch's own history
 *     contains a merge-commit message naming this branch (a real,
 *     git-log-verifiable positive signal — likely squash/rebase-merged on a
 *     machine whose original commit sha was never fetched here). Not
 *     structurally provable via ancestry, so never auto-promoted — flagged
 *     for human review with the evidence that raised the flag.
 *   - `out-of-scope`: neither the commit nor the branch nor any trace of the
 *     branch name in default-branch history was found. The header schema
 *     (la-04) carries no repo-identity field, so this audit cannot tell
 *     "genuinely untraceable in this repo" apart from "belongs to a
 *     different repo entirely" — reported only as a low-noise skipped count,
 *     never as a finding, never remediated.
 */
export type DriftClassification = 'verified-merged' | 'still-open' | 'ambiguous' | 'out-of-scope';

export interface ProvisionalVerification {
  classification: DriftClassification;
  evidence: Evidence[];
  /** Present only for `ambiguous`/`out-of-scope` — the specific reason a stronger classification wasn't reached. */
  reason?: string;
}

export interface StaleProvisionalFinding {
  entry: MemoryEntryRef;
  verification: ProvisionalVerification;
}

/**
 * One conservative auto-remediation action actually taken. Per this story's
 * key risk/requirement: "every remediation action must be logged with the
 * exact evidence that justified it — no silent fixes." `evidence` is never
 * empty for a real remediation.
 */
export interface RemediationAction {
  entryId: string;
  from: Status;
  to: Status;
  adapter: string;
  detail: string;
  evidence: Evidence[];
  appliedAt: string;
}

/** One la-07 mandate-enforcement-mechanism check — "is the thing that's supposed to make recall/remember automatic actually installed", with the exact evidence either way. */
export interface MandateComplianceCheck {
  label: string;
  compliant: boolean;
  evidence: string;
}

export interface LifecycleComplianceAuditReport {
  generatedAt: string;
  repoPath: string;
  notesDirectory: string;
  defaultBranch: string;
  mandateChecks: MandateComplianceCheck[];
  staleProvisionalFindings: StaleProvisionalFinding[];
  remediations: RemediationAction[];
  outOfScopeCount: number;
}
