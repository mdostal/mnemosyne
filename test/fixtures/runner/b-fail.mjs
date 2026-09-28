// Runner self-test fixture (test/run-tests.mjs): deliberately fails, so the
// runner must exit non-zero AND still run c-pass.mjs after it.
console.log("RUNNER-FIXTURE b-fail ran");
process.exit(1);
