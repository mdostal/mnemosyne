/**
 * Standalone process fixture for sync.integration.test.ts's concurrency
 * test -- the pf-05 analogue of lock-worker.ts (lock.test.ts), racing the
 * real read-splice-write sequence `syncHarnessFile` (sync.ts) itself
 * performs against a COPY of a real-world fixture, instead of
 * lock-worker.ts's synthetic counter file.
 *
 * `syncHarnessFile` doesn't expose a hook to widen the window between its
 * internal read and write (there's no reason for one in production), so
 * this worker reconstructs its exact locked read-splice-write body by
 * calling the SAME exported production functions `syncHarnessFile` calls
 * internally (`buildManagedBody` from sync.ts, `spliceManagedBlock` from
 * block.ts, `withLock` from lock.ts -- no reimplemented business logic),
 * with one addition: an artificial `holdMs` sleep between the read and the
 * write, inside the lock. This mirrors lock-worker.ts's own technique for
 * the same reason -- two real syncs of a small file are fast enough that
 * without deliberately widening the window, they might never actually
 * overlap in wall-clock time, which would make a "no overlap observed"
 * assertion vacuous (it would pass trivially whether or not withLock
 * actually serializes anything) rather than a real proof.
 *
 * Run as `node --import <tsx-loader> sync-race-worker.ts <targetPath>
 * <level0Path> <tier> <scopeId> <repoRoot> <holdMs>`. Prints
 * `{ pid, start, end }` as a single JSON line to stdout -- `start`/`end`
 * bracket the locked read-splice-write critical section only (mirrors
 * lock-worker.ts), not the whole process lifetime.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { buildManagedBody } from '../../sync.js';
import { spliceManagedBlock } from '../../block.js';
import { readLevel0Content } from '../../level0.js';
import { withLock } from '../../lock.js';
import type { Tier } from '../../tiers.js';

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, ms);
}

const [, , targetPath, level0Path, tierArg, scopeId, repoRoot, holdMsArg] = process.argv;
if (!targetPath || !level0Path || !tierArg || !scopeId || !repoRoot || !holdMsArg) {
  throw new Error(
    'usage: sync-race-worker.ts <targetPath> <level0Path> <tier> <scopeId> <repoRoot> <holdMs>',
  );
}
const holdMs = Number(holdMsArg);
const tier = tierArg as Tier;

// Computed once up front, exactly as syncHarnessFile does (sync.ts) -- the
// managed-body assembly itself is not part of the locked section in
// production, so it isn't here either.
const level0Content = readLevel0Content(level0Path);
const managedBody = buildManagedBody(tier, scopeId, repoRoot, level0Content);

withLock(targetPath, () => {
  const start = Date.now();
  const existingContent = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : null;
  sleepSync(holdMs);
  const nextContent = spliceManagedBlock(existingContent, managedBody);
  writeFileSync(targetPath, nextContent, 'utf8');
  const end = Date.now();
  process.stdout.write(`${JSON.stringify({ pid: process.pid, start, end })}\n`);
});
