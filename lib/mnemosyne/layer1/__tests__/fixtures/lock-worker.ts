/**
 * Standalone process fixture for lock.test.ts's concurrency test.
 *
 * Run as its own `node` child process (not a thread, not an in-process
 * callback) via `node --import <tsx-loader> lock-worker.ts <targetPath>
 * <holdMs>` -- so the concurrency test exercises real cross-process
 * advisory locking, which is the actual scenario `withLock` exists for (a
 * wizard write racing a manual CLI run, per pf-03's spec).
 *
 * Performs a deliberately racy read-splice-write while holding the lock:
 * read the current integer count from `targetPath` (0 if absent), block
 * synchronously for `holdMs` (to widen the window an unlocked implementation
 * would expose), then write count+1 back. Prints `{ pid, start, end }` as a
 * single JSON line to stdout so the test can assert the two workers'
 * critical sections never overlapped in wall-clock time.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { withLock } from '../../lock.js';

function sleepSync(ms: number): void {
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, ms);
}

const [, , targetPath, holdMsArg] = process.argv;
if (!targetPath || !holdMsArg) {
  throw new Error('usage: lock-worker.ts <targetPath> <holdMs>');
}
const holdMs = Number(holdMsArg);

withLock(targetPath, () => {
  const start = Date.now();
  const current = existsSync(targetPath) ? Number(readFileSync(targetPath, 'utf8').trim()) : 0;
  sleepSync(holdMs);
  writeFileSync(targetPath, String(current + 1), 'utf8');
  const end = Date.now();
  process.stdout.write(`${JSON.stringify({ pid: process.pid, start, end })}\n`);
});
