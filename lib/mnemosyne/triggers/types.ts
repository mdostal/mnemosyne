/**
 * Pluggable lifecycle-trigger adapter interface (la-06-lifecycle-trigger-system,
 * epic: mnemosyne-layer-architecture-v2).
 *
 * Background (docs/layer-architecture-v2-plan.md §2/§6): a memory write on a
 * non-default branch is `provisional` until something confirms it landed
 * (merge to the default branch -> `confirmed`) or confirms it didn't
 * (branch abandoned/deleted, PR closed without merging -> `superseded`,
 * NEVER deleted). `la-04` (`../flight-status.ts`) defined the schema and the
 * only two valid transitions (`assertValidStatusTransition`); THIS module
 * does not re-validate or re-derive that logic — it calls it.
 *
 * The operator's explicit decision (plan §6, decision 1): the mechanism that
 * detects "a merge/abandon happened" must be pluggable, not hardcoded to
 * git. This file is the seam: a `TriggerAdapter` only has to produce a
 * `LifecycleTriggerEvent` (transition + a matcher describing which
 * provisional entries it applies to); `applyLifecycleEvent` is the one place
 * that (a) looks up matching provisional entries via a `MemoryStatusStore`,
 * (b) validates the transition through la-04's `assertValidStatusTransition`,
 * and (c) asks the store to persist it. Neither half knows about the other's
 * concrete shape — a git-hook adapter and a hypothetical future ticket-queue
 * adapter both terminate in the same `LifecycleTriggerEvent` shape, and any
 * future `MemoryStatusStore` (a different backing store than the local notes
 * directory `../../src/triggers.mjs`'s `NotesDirectoryStatusStore`
 * implements) plugs in without either adapter needing to change.
 *
 * This story ships exactly one concrete adapter (git hooks, `gitAdapter.ts`)
 * and one concrete store (`notesStore.ts`, over the local notes directory
 * `remember()` already writes to — see `../layers/VectorLayerAdapter.ts` and
 * `../../src/engine.mjs`). A ticket-queue adapter or any CI-based adapter is
 * explicitly out of scope for this story (plan §6, decision 4) — evaluated
 * later only when a concrete need exists.
 */
import type { SourceRef, Status } from '../interfaces.js';
import { assertValidStatusTransition } from '../flight-status.js';

/** The only two lifecycle outcomes a trigger adapter can report — mirrors la-04's two valid `provisional`-origin transitions. */
export type LifecycleTransition = 'promote' | 'supersede';

/**
 * Describes which provisional entries a `LifecycleTriggerEvent` applies to.
 * At least one of `branch`/`commitShas` should normally be set; an entry
 * matches if EITHER matches (an OR, not an AND) — this is deliberate: a
 * rebase changes commit shas but not the branch name, so branch-name
 * matching is the fallback that still finds entries whose exact recorded
 * commit sha no longer exists after history was rewritten.
 */
export interface SourceRefMatcher {
  branch?: string;
  commitShas?: readonly string[];
}

/** True iff `entry`'s `source_ref` matches `matcher` on branch OR any of `commitShas`. */
export function matchesSourceRef(sourceRef: SourceRef, matcher: SourceRefMatcher): boolean {
  if (matcher.branch !== undefined && sourceRef.branch === matcher.branch) return true;
  if (matcher.commitShas !== undefined && matcher.commitShas.includes(sourceRef.commit_sha)) return true;
  return false;
}

/**
 * What a `TriggerAdapter` produces once it has detected a real lifecycle
 * event (a merge happened, a branch was abandoned, a ticket transitioned,
 * ...). This is the ENTIRE contract between "something happened" and
 * "flip matching provisional entries" — an adapter never touches a
 * `MemoryStatusStore` or la-04's transition logic directly.
 */
export interface LifecycleTriggerEvent {
  transition: LifecycleTransition;
  matcher: SourceRefMatcher;
  /** Name of the adapter that produced this event (e.g. `'git-hooks'`), for audit/logging — never used for matching logic. */
  adapter: string;
  /** Human-readable detail (e.g. "merge to main, 3 new commit(s)" / "local branch 'feat/x' deleted"), for logs/audit trails. */
  detail: string;
}

/** A memory entry as far as the trigger system is concerned — just enough to match and flip. */
export interface MemoryEntryRef {
  /** Opaque identifier the owning `MemoryStatusStore` understands (e.g. a file path). Never interpreted by `applyLifecycleEvent` itself. */
  id: string;
  status: Status;
  source_ref: SourceRef;
}

/**
 * The storage-side half of the interface. `applyLifecycleEvent` only ever
 * calls these two methods — a future store backing a different persistence
 * mechanism (e.g. a real DB-backed memory layer) only has to implement this,
 * never touch adapter code or la-04's transition logic.
 */
export interface MemoryStatusStore {
  findByStatus(status: Status): Promise<MemoryEntryRef[]>;
  /** Persist `entry`'s status as `to`. Called only after `applyLifecycleEvent` has already validated the transition via la-04's `assertValidStatusTransition`. */
  updateStatus(entry: MemoryEntryRef, to: Status): Promise<void>;
}

/** Marker interface for a trigger adapter. Deliberately minimal — an adapter's real detection method (e.g. `detectMergePromotion`) is adapter-specific and lives on the concrete adapter, not this interface; this file only fixes the shared OUTPUT shape (`LifecycleTriggerEvent`) every adapter must produce. */
export interface TriggerAdapter {
  readonly name: string;
}

function targetStatus(transition: LifecycleTransition): Status {
  return transition === 'promote' ? 'confirmed' : 'superseded';
}

export interface ApplyLifecycleEventResult {
  transition: LifecycleTransition;
  /** Provisional entries whose source_ref matched the event's matcher. */
  matched: MemoryEntryRef[];
  /** The subset of `matched` that was actually flipped (== `matched` unless a per-entry update fails and the caller chose to continue past it — this implementation is all-or-throw, so today `updated.length === matched.length` on success). */
  updated: MemoryEntryRef[];
}

/**
 * The one place a `LifecycleTriggerEvent` (from ANY adapter) meets a
 * `MemoryStatusStore` (ANY implementation). Looks up currently-`provisional`
 * entries, filters to ones matching `event.matcher`, validates each
 * transition through la-04's `assertValidStatusTransition` (defensive here —
 * every candidate is already `provisional`, so this can only throw if a
 * store's `findByStatus('provisional')` lied about an entry's own status),
 * then asks the store to persist it. Never deletes anything — `supersede`
 * flips status the same way `promote` does; the caller's `MemoryStatusStore`
 * is what enforces "never delete" (see `notesStore.ts`'s doc comment).
 */
export async function applyLifecycleEvent(
  event: LifecycleTriggerEvent,
  store: MemoryStatusStore,
): Promise<ApplyLifecycleEventResult> {
  const provisional = await store.findByStatus('provisional');
  const matched = provisional.filter((entry) => matchesSourceRef(entry.source_ref, event.matcher));
  const to = targetStatus(event.transition);

  const updated: MemoryEntryRef[] = [];
  for (const entry of matched) {
    assertValidStatusTransition(entry.status, to);
    await store.updateStatus(entry, to);
    updated.push({ ...entry, status: to });
  }

  return { transition: event.transition, matched, updated };
}
