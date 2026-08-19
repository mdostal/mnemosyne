/**
 * Standalone process fixture for orgTree.test.ts's concurrency test.
 *
 * Run as its own `node` child process (not a thread, not an in-process
 * callback) via `node --import <tsx-loader> orgtree-worker.ts <orgTreePath>
 * <repoPath> <barrierPath>` -- so the concurrency test exercises real
 * cross-process advisory locking around `appendOrgTreeEntry`'s own
 * read-modify-write, which is the actual scenario `withLock` exists for
 * (mirrors layer1/__tests__/fixtures/lock-worker.ts's rationale, applied to
 * this registry's own call site rather than `withLock` in isolation --
 * proving the lock is genuinely wired into `appendOrgTreeEntry`, not just
 * present in the file unused).
 *
 * Signals readiness by writing `<barrierPath>.<pid>.ready`, then busy-waits
 * for the shared `barrierPath` file the test process creates only once
 * every worker has confirmed it's up and polling -- maximizes the workers'
 * actual `appendOrgTreeEntry` call-time overlap, rather than relying on
 * `Promise.all`'s own much looser process-spawn timing.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { appendOrgTreeEntry } from '../orgTree.js';

function sleepSync(ms: number): void {
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, ms);
}

const [, , orgTreePath, repoPath, barrierPath] = process.argv;
if (!orgTreePath || !repoPath || !barrierPath) {
  throw new Error('usage: orgtree-worker.ts <orgTreePath> <repoPath> <barrierPath>');
}

writeFileSync(`${barrierPath}.${process.pid}.ready`, '', 'utf8');
while (!existsSync(barrierPath)) {
  sleepSync(5);
}

appendOrgTreeEntry(
  {
    repo_path: repoPath,
    collection: `project-${repoPath}`,
    scope: 'project',
    org_tree_path: `org/project/${repoPath}`,
    needs_override: false,
    onboarded_at: new Date().toISOString(),
  },
  orgTreePath,
);

process.stdout.write('ok\n');
