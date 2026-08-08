#!/usr/bin/env node
// fake-swarm-memory.mjs — test double for the `swarm-memory` CLI.
//
// Stands in for the real binary so write-through.mjs can drive engine.mjs's
// remember() through file-write-succeeds / upsert-fails scenarios without a
// live Qdrant. Behavior for `index` is controlled by FAKE_SWARM_MODE:
//   success      -> exit 0, reports "upserted 3 chunks"
//   silent-fail  -> exit 0, but no chunks reported (Qdrant no-op)
//   hard-fail    -> exit 1, stderr error message
const [, , cmd] = process.argv;
const mode = process.env.FAKE_SWARM_MODE || "success";

if (cmd === "config") {
  process.stdout.write(
    JSON.stringify({
      scopes: { personal: "test_collection", top: "test_collection" },
      ladder: {},
      default_scope: "personal",
      fallback_collection: "test_collection",
    })
  );
  process.exit(0);
}

if (cmd === "index") {
  if (mode === "hard-fail") {
    process.stderr.write("fake swarm-memory: qdrant upsert connection refused\n");
    process.exit(1);
  }
  if (mode === "silent-fail") {
    process.stdout.write("no changes detected, nothing to index\n");
    process.exit(0);
  }
  process.stdout.write("indexed 1 file(s), upserted 3 chunks into test_collection\n");
  process.exit(0);
}

process.stderr.write(`fake swarm-memory: unknown command ${cmd}\n`);
process.exit(2);
