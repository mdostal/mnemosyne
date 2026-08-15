/**
 * Layer 1 — advisory file locking.
 *
 * Zero-third-party-dependency exclusive advisory lock, built on
 * `fs.writeFileSync(lockPath, token, { flag: 'wx' })` (POSIX O_CREAT|O_EXCL
 * semantics: the call fails if the lock file already exists, so exactly one
 * concurrent caller can ever win the create). Guards read-splice-write
 * sequences that otherwise have zero coordination between the read and the
 * final write -- design-discussion.md's TOCTOU finding on
 * `syncHarnessFile` (sync.ts), horizontal-plan.md H4.
 *
 * The project is zero-third-party-dependency by convention (see
 * package.json's `dependencies`) -- this deliberately does not reach for a
 * lockfile-style package.
 *
 * Story: pf-03-file-locking (epic: mnemosyne-persona-foundation)
 */

import { readFileSync, unlinkSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/** Suffix appended to the guarded path to derive its lock file's path. */
const LOCK_SUFFIX = '.mnemosyne.lock';

/** A lock file older than this (by mtime) is treated as abandoned by a crashed process and stolen. */
const DEFAULT_STALE_MS = 30_000;

/** Poll interval while waiting for a live (non-stale) lock to be released. */
const DEFAULT_RETRY_INTERVAL_MS = 20;

/** Hard ceiling on total wait time -- a last-resort "fail loudly" escape hatch against a wedged retry loop. */
const DEFAULT_MAX_WAIT_MS = 60_000;

export interface WithLockOptions {
  /** Lock mtime age (ms) beyond which it's considered abandoned and stolen. Default 30s. */
  staleMs?: number;
  /** Delay (ms) between acquisition retries while waiting on a live lock. Default 20ms. */
  retryIntervalMs?: number;
  /** Total time (ms) to wait before giving up and throwing. Default 60s. */
  maxWaitMs?: number;
}

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

/** `<targetPath>.mnemosyne.lock` -- co-located with what it protects, not a separate lock registry. */
export function lockPathFor(targetPath: string): string {
  return `${targetPath}${LOCK_SUFFIX}`;
}

/**
 * Synchronous blocking sleep via `Atomics.wait` on a throwaway
 * `SharedArrayBuffer`. Used instead of `setTimeout` so `withLock` can stay a
 * plain synchronous function -- it mirrors the rest of layer1 (sync.ts,
 * persona-store-repo-local.ts), which is synchronous fs top to bottom.
 */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, ms);
}

/** True if `lockPath` currently exists and its mtime is older than `staleMs`. */
function isStale(lockPath: string, staleMs: number): boolean {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(lockPath).mtimeMs;
  } catch (err) {
    if (errCode(err) === 'ENOENT') return false; // already released -- nothing to steal
    throw err;
  }
  return Date.now() - mtimeMs > staleMs;
}

/**
 * Attempts to create the lock file exclusively, writing `token` as its
 * content (so a later release can confirm it still owns the lock before
 * deleting it). Returns true on success, false if the lock already exists
 * (EEXIST) -- any other error propagates.
 */
function tryAcquire(lockPath: string, token: string): boolean {
  try {
    writeFileSync(lockPath, token, { flag: 'wx' });
    return true;
  } catch (err) {
    if (errCode(err) === 'EEXIST') return false;
    throw err;
  }
}

/**
 * Removes `lockPath` only if it still contains `token` -- i.e. only if this
 * call is still the lock's owner. If the lock was stolen out from under a
 * long-running `fn` (stale-timeout elapsed mid-call) and re-acquired by
 * someone else, the token mismatches and release is a no-op, so we never
 * delete another owner's live lock. Re-checks staleness is a best-effort
 * mitigation for the same class of race, not a full guarantee -- POSIX has
 * no atomic "delete-if-content-matches" primitive to close the window
 * completely.
 */
function releaseIfOwned(lockPath: string, token: string): void {
  let current: string;
  try {
    current = readFileSync(lockPath, 'utf8');
  } catch (err) {
    if (errCode(err) === 'ENOENT') return; // already gone
    throw err;
  }
  if (current !== token) return; // not ours anymore -- someone else stole and re-acquired it

  try {
    unlinkSync(lockPath);
  } catch (err) {
    if (errCode(err) !== 'ENOENT') throw err;
  }
}

/**
 * Attempts to steal a stale lock: re-confirms staleness immediately before
 * unlinking (narrows, though cannot fully close, the TOCTOU window between
 * the staleness check and the delete), then removes it unconditionally so
 * the next `tryAcquire` in the caller's retry loop can win it.
 */
function stealIfStale(lockPath: string, staleMs: number): void {
  if (!isStale(lockPath, staleMs)) return;
  try {
    unlinkSync(lockPath);
  } catch (err) {
    if (errCode(err) !== 'ENOENT') throw err;
    // Already gone (released normally, or stolen by another racer) -- fine, retry loop decides the winner.
  }
}

/**
 * Acquires an exclusive advisory lock on `<targetPath>.mnemosyne.lock`, runs
 * `fn`, and releases the lock -- even if `fn` throws (`finally` semantics: a
 * failed write must never leave a permanent lock).
 *
 * `fn` must be synchronous. `withLock` itself is synchronous throughout
 * (including its wait/retry loop, via a blocking `Atomics.wait` sleep) so it
 * composes directly with layer1's synchronous fs read-splice-write
 * functions without forcing them (or their callers) to become async.
 *
 * Acquisition is exclusive-create (`wx`): the first caller to successfully
 * create the lock file wins; every other concurrent caller sees EEXIST and
 * either waits (polling every `retryIntervalMs`) or, once the existing
 * lock's mtime exceeds `staleMs` (default 30s), treats it as abandoned by a
 * crashed process and steals it rather than blocking forever. If no
 * acquisition succeeds within `maxWaitMs`, throws loudly instead of hanging.
 */
export function withLock<T>(targetPath: string, fn: () => T, options: WithLockOptions = {}): T {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const retryIntervalMs = options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const lockPath = lockPathFor(targetPath);
  const token = `${process.pid}-${randomUUID()}`;

  const start = Date.now();
  while (!tryAcquire(lockPath, token)) {
    // Not ours yet -- if the existing lock looks abandoned, steal it (removes it so the
    // next loop iteration's tryAcquire can win it); otherwise wait and retry.
    stealIfStale(lockPath, staleMs);

    if (Date.now() - start > maxWaitMs) {
      throw new Error(
        `withLock: timed out after ${maxWaitMs}ms waiting for the lock on ${JSON.stringify(targetPath)} ` +
          `(${lockPath} is held and not yet stale).`,
      );
    }
    sleepSync(retryIntervalMs);
  }

  try {
    return fn();
  } finally {
    releaseIfOwned(lockPath, token);
  }
}
