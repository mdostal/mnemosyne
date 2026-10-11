import { defineConfig } from 'vitest/config';

// `.claude/worktrees/**` holds ephemeral git worktrees created for isolated
// agent work (see docs/layer-architecture-v2-plan.md's execution model).
// Each is a full nested checkout of this repo — without this exclude,
// vitest's default file discovery walks into them too, running every test
// file N times in parallel and colliding on the fixed ports several
// integration tests bind (e.g. test/reconcile.test.mjs), producing spurious
// failures unrelated to any real regression. Excluded here rather than via
// .gitignore alone, since gitignore doesn't affect vitest's own glob.
//
// `test/**` is excluded too: those are standalone node scripts run one by one
// by scripts/run-tests.mjs (including test/reconcile.test.mjs, a node:test
// file vitest would otherwise collect and fail with "No test suite found").
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/**', 'test/**'],
  },
});
