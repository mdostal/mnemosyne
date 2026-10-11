// Runner self-test fixture (test/run-tests.mjs): a node:test file, which the
// runner must run under `node --test` (vitest can't collect it).
import test from "node:test";
test("RUNNER-FIXTURE d-node ran", () => {});
