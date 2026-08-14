/**
 * Stale-provisional drift detection + conservative auto-remediation
 * (la-11-memory-lifecycle-compliance-audit, epic:
 * mnemosyne-layer-architecture-v2) — this story's primary deliverable, per
 * its own `design_decisions[0]`: "Detection-and-report first,
 * auto-remediation only on independently-verified real state".
 *
 * This is the backstop for la-06's own documented gap: git hooks only fire
 * on the machine where a merge/branch-delete actually happens, so a merge
 * done elsewhere (hosted PR UI, another machine without the hook installed)
 * silently never promotes a `provisional` entry. This module scans every
 * `provisional` entry a `MemoryStatusStore` knows about and independently
 * re-derives, from REAL git state, whether it should have been promoted
 * already — never trusting/re-deriving la-06's transition logic, only
 * REUSING it (`applyLifecycleEvent`, imported, never reimplemented) once a
 * merge is structurally proven.
 *
 * Classification (`classifyEntry` below) walks three real git checks, in
 * order, stopping at the first one that resolves the question — see
 * `types.ts`'s `DriftClassification` doc comment for the full reasoning
 * behind each of the four outcomes:
 *
 *   1. `isAncestorOf(commit_sha, defaultBranch)` — the ONE structural proof
 *      this module trusts enough to auto-remediate on.
 *   2. `refExists(branch)` — is the entry's branch still legitimately open
 *      (or just not fetched here)? If so, this is not drift at all.
 *   3. `grepMergeCommitMessage(branch, defaultBranch)` — a real, in-repo
 *      textual signal (mirrors `gitAdapter.ts`'s own merge-message parsing,
 *      run retrospectively) that the branch WAS merged here, just not in a
 *      way ancestry can structurally confirm (e.g. squash/rebase merge on
 *      another machine, whose original commit sha this repo never fetched).
 *      Real evidence, but not proof — flagged for human review, never
 *      auto-promoted.
 *
 * No repo-identity field exists in la-04's header schema (branch/commit
 * only) — so an entry this repo's git has no trace of at all (steps 1-3 all
 * come up empty) is `out-of-scope`, not `ambiguous`: this audit cannot tell
 * "belongs to a different repo entirely" apart from "genuinely
 * untraceable here", so it says neither, on purpose (never a false alarm).
 */
import { applyLifecycleEvent, type LifecycleTriggerEvent, type MemoryStatusStore } from '../triggers/types.js';
import { grepMergeCommitMessage, isAncestorOf, refExists, type GitVerifyOptions } from './gitVerify.js';
import type {
  DriftClassification,
  Evidence,
  ProvisionalVerification,
  RemediationAction,
  StaleProvisionalFinding,
} from './types.js';
import type { MemoryEntryRef } from '../triggers/types.js';

export const ADAPTER_NAME = 'lifecycle-compliance-audit';

export interface DetectStaleProvisionalOptions extends GitVerifyOptions {
  defaultBranch: string;
  /** Default `true`. When `false`, detection-only — every finding is still classified and reported, nothing is ever written. */
  autoRemediate?: boolean | undefined;
}

export interface DetectStaleProvisionalResult {
  /** `verified-merged` and `ambiguous` classifications only — `still-open` is not drift (never reported), `out-of-scope` is counted, not itemized (see `outOfScopeCount`). */
  findings: StaleProvisionalFinding[];
  remediations: RemediationAction[];
  outOfScopeCount: number;
}

async function classifyEntry(
  entry: MemoryEntryRef,
  options: DetectStaleProvisionalOptions,
): Promise<ProvisionalVerification> {
  const evidence: Evidence[] = [];
  const { branch, commit_sha } = entry.source_ref;

  const ancestry = await isAncestorOf(commit_sha, options.defaultBranch, options);
  evidence.push(ancestry.evidence);

  if (ancestry.outcome === 'ancestor') {
    return { classification: 'verified-merged', evidence };
  }
  if (ancestry.outcome === 'not-ancestor') {
    // A known commit, structurally proven NOT to be on the default branch
    // yet — legitimately still in-flight. Not drift.
    return { classification: 'still-open', evidence };
  }

  // ancestry.outcome === 'unknown-object': this repo has never seen
  // `commit_sha` at all. Check whether the branch is still live before
  // reaching for the weaker message-based signal.
  const branchCheck = await refExists(branch, options);
  evidence.push(branchCheck.evidence);
  if (branchCheck.exists) {
    // The branch is still real and live in this repo — just not fetched (or
    // rewritten) to the point this commit resolves. Still legitimately
    // open/traceable; not drift.
    return { classification: 'still-open', evidence };
  }

  const messageCheck = await grepMergeCommitMessage(branch, options.defaultBranch, options);
  evidence.push(messageCheck.evidence);
  if (messageCheck.found) {
    return {
      classification: 'ambiguous',
      evidence,
      reason:
        `commit '${commit_sha}' is unknown to this repo's git object database and branch '${branch}' no longer ` +
        `exists (local or remote-tracking), but '${options.defaultBranch}' has a real merge-commit message naming ` +
        `'${branch}' — likely squash/rebase-merged elsewhere (the original commit sha was never fetched here). ` +
        `Not structurally provable via ancestry, so NOT auto-promoted — flagged for manual review.`,
    };
  }

  return {
    classification: 'out-of-scope',
    evidence,
    reason:
      `commit '${commit_sha}' is unknown here, branch '${branch}' does not exist, and no commit on ` +
      `'${options.defaultBranch}' mentions it — la-04's header schema carries no repo-identity field, so this audit ` +
      `cannot tell "belongs to a different repository" apart from "untraceable in this one"; reported only as a ` +
      `count, never as a finding.`,
  };
}

/**
 * The classification -> remediation decision (never the other way around):
 * ONLY `verified-merged` entries are eligible for auto-remediation, and only
 * when `options.autoRemediate` is not explicitly `false`. Remediation itself
 * is a straight call into la-06's `applyLifecycleEvent` with a `promote`
 * event matched by this exact entry's commit sha — the SAME transition
 * mechanism a real installed `post-merge` hook would have driven, just
 * fired retrospectively by this audit instead of by git at merge time.
 */
export async function detectStaleProvisional(
  store: MemoryStatusStore,
  options: DetectStaleProvisionalOptions,
): Promise<DetectStaleProvisionalResult> {
  const autoRemediate = options.autoRemediate ?? true;
  const provisional = await store.findByStatus('provisional');

  const findings: StaleProvisionalFinding[] = [];
  const remediations: RemediationAction[] = [];
  let outOfScopeCount = 0;

  for (const entry of provisional) {
    const verification = await classifyEntry(entry, options);

    if (verification.classification === 'still-open') continue; // not drift — never reported
    if (verification.classification === 'out-of-scope') {
      outOfScopeCount += 1;
      continue; // never a finding, never a false alarm — see classifyEntry's doc comment
    }

    findings.push({ entry, verification });

    if (verification.classification === 'verified-merged' && autoRemediate) {
      const event: LifecycleTriggerEvent = {
        transition: 'promote',
        matcher: { commitShas: [entry.source_ref.commit_sha] },
        adapter: ADAPTER_NAME,
        detail:
          `stale-provisional audit: independently verified '${entry.source_ref.commit_sha}' is an ancestor of ` +
          `'${options.defaultBranch}' (git merge-base --is-ancestor) — the git-hook-driven promotion la-06 expected ` +
          `never fired on whatever machine performed this merge (la-06's own documented risk).`,
      };
      const applied = await applyLifecycleEvent(event, store);
      for (const updated of applied.updated) {
        remediations.push({
          entryId: updated.id,
          from: 'provisional',
          to: updated.status,
          adapter: event.adapter,
          detail: event.detail,
          evidence: verification.evidence,
          appliedAt: new Date().toISOString(),
        });
      }
    }
  }

  return { findings, remediations, outOfScopeCount };
}
