/**
 * Contract tests for `applyLifecycleEvent` (la-06-lifecycle-trigger-system).
 *
 * Deliberately uses ONLY an in-memory fake `MemoryStatusStore` and
 * hand-rolled `LifecycleTriggerEvent`s here — no `NotesDirectoryStatusStore`,
 * no git — to prove the interface itself is the integration point, per this
 * story's third acceptance criterion: "when a new adapter type is
 * implemented against it, then no changes to la-04/la-05's schema or recall
 * filtering are required." The `describe('a hypothetical second adapter...')`
 * block below IS that proof: it defines a fake ticket-queue-shaped adapter
 * inline and shows it drives `applyLifecycleEvent` identically to the git
 * adapter, without importing anything from `gitAdapter.ts`.
 */
import { describe, expect, it } from 'vitest';
import { InvalidStatusTransitionError } from '../../flight-status.js';
import type { SourceRef, Status } from '../../interfaces.js';
import {
  applyLifecycleEvent,
  matchesSourceRef,
  type LifecycleOutcome,
  type LifecycleTriggerEvent,
  type MemoryEntryRef,
  type MemoryStatusStore,
} from '../types.js';

function ref(branch: string, commit_sha: string): SourceRef {
  return { branch, commit_sha, pr_url: null };
}

/** A trivial in-memory `MemoryStatusStore` — array of entries, mutated in place by `updateStatus`. Never touches disk, git, or Qdrant; exists purely to exercise the interface contract. */
class FakeStore implements MemoryStatusStore {
  constructor(public entries: MemoryEntryRef[]) {}

  async findByStatus(status: Status): Promise<MemoryEntryRef[]> {
    return this.entries.filter((e) => e.status === status);
  }

  async updateStatus(entry: MemoryEntryRef, to: Status): Promise<void> {
    const found = this.entries.find((e) => e.id === entry.id);
    if (!found) throw new Error(`FakeStore: no entry with id ${entry.id}`);
    found.status = to;
  }
}

/**
 * (la-08-lifecycle-outcome-feedback) A `FakeStore` that also implements
 * `recordOutcome`, recording every call it receives (entry id + outcome) so
 * tests can assert outcome-tagged writes actually reach the store — without
 * ever touching disk/git.
 */
class FakeOutcomeStore extends FakeStore {
  recordedOutcomes: { id: string; status: Status; outcome: LifecycleOutcome }[] = [];

  async recordOutcome(entry: MemoryEntryRef, outcome: LifecycleOutcome): Promise<void> {
    this.recordedOutcomes.push({ id: entry.id, status: entry.status, outcome });
  }
}

describe('matchesSourceRef', () => {
  it('matches on branch alone', () => {
    expect(matchesSourceRef(ref('feat/x', 'aaa'), { branch: 'feat/x' })).toBe(true);
    expect(matchesSourceRef(ref('feat/y', 'aaa'), { branch: 'feat/x' })).toBe(false);
  });

  it('matches on commit sha alone', () => {
    expect(matchesSourceRef(ref('feat/x', 'aaa'), { commitShas: ['aaa', 'bbb'] })).toBe(true);
    expect(matchesSourceRef(ref('feat/x', 'ccc'), { commitShas: ['aaa', 'bbb'] })).toBe(false);
  });

  it('is an OR, not an AND — matching commit sha with a non-matching branch still matches (the rebase-fallback case)', () => {
    expect(matchesSourceRef(ref('feat/x', 'aaa'), { branch: 'renamed-branch', commitShas: ['aaa'] })).toBe(true);
  });

  it('matches neither when the matcher specifies nothing that overlaps', () => {
    expect(matchesSourceRef(ref('feat/x', 'aaa'), {})).toBe(false);
  });
});

describe('applyLifecycleEvent — promote', () => {
  it('flips only matching provisional entries to confirmed, leaves non-matching provisional entries untouched', async () => {
    const store = new FakeStore([
      { id: 'a', status: 'provisional', source_ref: ref('feat/x', 'sha-a') },
      { id: 'b', status: 'provisional', source_ref: ref('feat/other', 'sha-b') },
      { id: 'c', status: 'confirmed', source_ref: ref('main', 'sha-c') },
    ]);
    const event: LifecycleTriggerEvent = {
      transition: 'promote',
      matcher: { branch: 'feat/x' },
      adapter: 'test-adapter',
      detail: 'test',
    };

    const result = await applyLifecycleEvent(event, store);

    expect(result.matched.map((e) => e.id)).toEqual(['a']);
    expect(result.updated.map((e) => e.id)).toEqual(['a']);
    expect(store.entries.find((e) => e.id === 'a')!.status).toBe('confirmed');
    expect(store.entries.find((e) => e.id === 'b')!.status).toBe('provisional'); // untouched
    expect(store.entries.find((e) => e.id === 'c')!.status).toBe('confirmed'); // untouched (was already confirmed)
  });

  it('matches on commit sha too, not just branch', async () => {
    const store = new FakeStore([{ id: 'a', status: 'provisional', source_ref: ref('feat/x', 'sha-a') }]);
    const event: LifecycleTriggerEvent = {
      transition: 'promote',
      matcher: { commitShas: ['sha-a', 'sha-zzz'] },
      adapter: 'test-adapter',
      detail: 'test',
    };

    const result = await applyLifecycleEvent(event, store);
    expect(result.updated).toHaveLength(1);
    expect(store.entries[0]!.status).toBe('confirmed');
  });

  it('a matcher that matches nothing is a real no-op — returns empty matched/updated, does not throw', async () => {
    const store = new FakeStore([{ id: 'a', status: 'provisional', source_ref: ref('feat/x', 'sha-a') }]);
    const result = await applyLifecycleEvent(
      { transition: 'promote', matcher: { branch: 'no-such-branch' }, adapter: 'test-adapter', detail: 'test' },
      store,
    );
    expect(result.matched).toEqual([]);
    expect(result.updated).toEqual([]);
    expect(store.entries[0]!.status).toBe('provisional');
  });
});

describe('applyLifecycleEvent — supersede', () => {
  it('flips matching provisional entries to superseded, never removes them from the store', async () => {
    const store = new FakeStore([{ id: 'a', status: 'provisional', source_ref: ref('feat/abandoned', 'sha-a') }]);
    const result = await applyLifecycleEvent(
      { transition: 'supersede', matcher: { branch: 'feat/abandoned' }, adapter: 'test-adapter', detail: 'test' },
      store,
    );
    expect(result.updated.map((e) => e.id)).toEqual(['a']);
    expect(store.entries).toHaveLength(1); // still present — never deleted
    expect(store.entries[0]!.status).toBe('superseded');
  });
});

describe('applyLifecycleEvent — delegates transition validity to la-04, does not reinvent it', () => {
  it('a store that lies about an entry being provisional when findByStatus(\'provisional\') is called still gets caught by assertValidStatusTransition', async () => {
    class LyingStore implements MemoryStatusStore {
      async findByStatus(): Promise<MemoryEntryRef[]> {
        // Lies: claims this entry is provisional (so applyLifecycleEvent treats
        // it as a promote candidate) but its real status is already terminal.
        return [{ id: 'x', status: 'confirmed', source_ref: ref('feat/x', 'sha-a') }];
      }
      async updateStatus(): Promise<void> {
        throw new Error('updateStatus should never be reached — assertValidStatusTransition must throw first');
      }
    }

    await expect(
      applyLifecycleEvent(
        { transition: 'promote', matcher: { branch: 'feat/x' }, adapter: 'test-adapter', detail: 'test' },
        new LyingStore(),
      ),
    ).rejects.toBeInstanceOf(InvalidStatusTransitionError);
  });
});

describe('a hypothetical second adapter — proves the interface is genuinely pluggable (AC3)', () => {
  // A stand-in for a future, entirely different trigger source (e.g. a
  // ticket-queue transition webhook) that this story explicitly does NOT
  // build (plan §6, decision 4). It produces the exact same
  // `LifecycleTriggerEvent` shape as `gitAdapter.ts` does, from a completely
  // different detection mechanism (a fake ticket payload, not git at all),
  // and drives the same `applyLifecycleEvent` engine against the same
  // `MemoryStatusStore` interface. No changes to `types.ts`, `notesStore.ts`,
  // or la-04/la-05 were needed to add this — which is the point.
  interface FakeTicketClosedPayload {
    ticketId: string;
    resolution: 'merged' | 'wont-fix';
    branch: string;
  }

  function ticketQueueAdapter(payload: FakeTicketClosedPayload): LifecycleTriggerEvent {
    return {
      transition: payload.resolution === 'merged' ? 'promote' : 'supersede',
      matcher: { branch: payload.branch },
      adapter: 'fake-ticket-queue',
      detail: `ticket ${payload.ticketId} closed (${payload.resolution})`,
    };
  }

  it('a merged-resolution ticket event promotes matching provisional entries', async () => {
    const store = new FakeStore([{ id: 'a', status: 'provisional', source_ref: ref('feat/PAN-123', 'sha-a') }]);
    const event = ticketQueueAdapter({ ticketId: 'PAN-123', resolution: 'merged', branch: 'feat/PAN-123' });

    const result = await applyLifecycleEvent(event, store);

    expect(event.adapter).toBe('fake-ticket-queue');
    expect(result.updated.map((e) => e.id)).toEqual(['a']);
    expect(store.entries[0]!.status).toBe('confirmed');
  });

  it("a won't-fix-resolution ticket event supersedes matching provisional entries, never deletes", async () => {
    const store = new FakeStore([{ id: 'b', status: 'provisional', source_ref: ref('feat/PAN-999', 'sha-b') }]);
    const event = ticketQueueAdapter({ ticketId: 'PAN-999', resolution: 'wont-fix', branch: 'feat/PAN-999' });

    const result = await applyLifecycleEvent(event, store);

    expect(result.updated.map((e) => e.id)).toEqual(['b']);
    expect(store.entries).toHaveLength(1);
    expect(store.entries[0]!.status).toBe('superseded');
  });
});

/**
 * la-08-lifecycle-outcome-feedback — outcome-tagged writes on the SAME
 * `applyLifecycleEvent` firing path la-06 already ships, not a separate
 * mechanism. Uses `FakeOutcomeStore` (in-memory, no disk/git) to prove the
 * engine-level wiring in isolation; `notesStore.test.ts` and `gitAdapter.
 * test.ts` cover the real-disk/real-git halves, and `test/git-hooks.mjs`
 * covers the full real-subprocess path end to end.
 */
describe('applyLifecycleEvent — outcome-tagged writes (la-08)', () => {
  it('promote: records the outcome against every entry it confirms, at the moment it flips them', async () => {
    const store = new FakeOutcomeStore([
      { id: 'a', status: 'provisional', source_ref: ref('feat/x', 'sha-a') },
      { id: 'b', status: 'provisional', source_ref: ref('feat/other', 'sha-b') },
    ]);
    const outcome: LifecycleOutcome = {
      summary: "merge to 'main' (fast-forward), 1 commit(s) from 'feat/x': fix the flaky retry loop",
      detail: { mergeShape: 'fast-forward', commitSubjects: ['fix the flaky retry loop'] },
    };
    const event: LifecycleTriggerEvent = {
      transition: 'promote',
      matcher: { branch: 'feat/x' },
      adapter: 'test-adapter',
      detail: 'test',
      outcome,
    };

    const result = await applyLifecycleEvent(event, store);

    expect(result.updated.map((e) => e.id)).toEqual(['a']);
    expect(store.recordedOutcomes).toHaveLength(1);
    expect(store.recordedOutcomes[0]).toEqual({ id: 'a', status: 'confirmed', outcome });
    // The non-matching entry was never touched, and never got an outcome recorded either.
    expect(store.recordedOutcomes.some((r) => r.id === 'b')).toBe(false);
  });

  it('supersede: records the outcome against every entry it supersedes, capturing why it did not land', async () => {
    const store = new FakeOutcomeStore([
      { id: 'a', status: 'provisional', source_ref: ref('feat/abandoned', 'sha-a') },
    ]);
    const outcome: LifecycleOutcome = {
      summary: "branch 'feat/abandoned' deleted without merging — last commit: \"try approach X\"",
      detail: { branch: 'feat/abandoned', lastCommitSubject: 'try approach X' },
    };
    const event: LifecycleTriggerEvent = {
      transition: 'supersede',
      matcher: { branch: 'feat/abandoned' },
      adapter: 'test-adapter',
      detail: 'test',
      outcome,
    };

    const result = await applyLifecycleEvent(event, store);

    expect(result.updated.map((e) => e.id)).toEqual(['a']);
    expect(store.recordedOutcomes).toEqual([{ id: 'a', status: 'superseded', outcome }]);
  });

  it('an event with no outcome records nothing, even against a store that supports recordOutcome', async () => {
    const store = new FakeOutcomeStore([{ id: 'a', status: 'provisional', source_ref: ref('feat/x', 'sha-a') }]);
    const event: LifecycleTriggerEvent = {
      transition: 'promote',
      matcher: { branch: 'feat/x' },
      adapter: 'test-adapter',
      detail: 'test',
      // no outcome
    };

    const result = await applyLifecycleEvent(event, store);

    expect(result.updated).toHaveLength(1);
    expect(store.recordedOutcomes).toEqual([]);
  });

  it('an outcome present but a store with no recordOutcome capability is a silent no-op, not an error', async () => {
    const store = new FakeStore([{ id: 'a', status: 'provisional', source_ref: ref('feat/x', 'sha-a') }]);
    const event: LifecycleTriggerEvent = {
      transition: 'promote',
      matcher: { branch: 'feat/x' },
      adapter: 'test-adapter',
      detail: 'test',
      outcome: { summary: 'some outcome' },
    };

    await expect(applyLifecycleEvent(event, store)).resolves.toBeTruthy();
    expect(store.entries[0]!.status).toBe('confirmed'); // status transition still happened
  });

  it('a recordOutcome that throws never undoes or blocks the status transition that already succeeded', async () => {
    class ThrowingOutcomeStore extends FakeStore {
      async recordOutcome(): Promise<void> {
        throw new Error('boom — outcome store is unavailable');
      }
    }
    const store = new ThrowingOutcomeStore([{ id: 'a', status: 'provisional', source_ref: ref('feat/x', 'sha-a') }]);
    const event: LifecycleTriggerEvent = {
      transition: 'promote',
      matcher: { branch: 'feat/x' },
      adapter: 'test-adapter',
      detail: 'test',
      outcome: { summary: 'some outcome' },
    };

    const result = await applyLifecycleEvent(event, store);

    expect(result.updated.map((e) => e.id)).toEqual(['a']);
    expect(store.entries[0]!.status).toBe('confirmed'); // transition survived the recordOutcome failure
  });
});
