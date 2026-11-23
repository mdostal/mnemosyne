#!/usr/bin/env node
// fake-swarm-memory-lost-writes.mjs — test double for test/no-lost-writes.mjs.
//
//   config                    -> static personal/top scopes (remember()'s scopeMap)
//   --config <path> config    -> parses the [scopes]/[ladder] tables of <path>
//                                and dumps them as JSON, so addLane()'s
//                                round-trip validation works without the real
//                                CLI. Sleeps FAKE_SWARM_CONFIG_DELAY_MS first,
//                                which widens addLane()'s read-modify-write
//                                window so an unlocked race would really lose
//                                a lane.
//   index ...                 -> sleeps FAKE_SWARM_INDEX_DELAY_MS (a "slow
//                                request" for the SIGTERM test), then reports
//                                upserted chunks.
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseTables(text) {
  const out = { scopes: {}, ladder: {} };
  let table = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      table = header[1];
      continue;
    }
    if (table !== "scopes" && table !== "ladder") continue;
    const kv = /^([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(.+)$/.exec(line);
    if (!kv) {
      process.stderr.write(`fake: cannot parse line: ${line}\n`);
      process.exit(1);
    }
    out[table][kv[1]] = JSON.parse(kv[2]);
  }
  return out;
}

if (argv[0] === "--config" && argv[2] === "config") {
  await sleep(Number(process.env.FAKE_SWARM_CONFIG_DELAY_MS || 0));
  process.stdout.write(JSON.stringify(parseTables(readFileSync(argv[1], "utf8"))));
  process.exit(0);
}

const [cmd] = argv;

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
  await sleep(Number(process.env.FAKE_SWARM_INDEX_DELAY_MS || 0));
  process.stdout.write("indexed 1 file(s), upserted 3 chunks into test_collection\n");
  process.exit(0);
}

process.stderr.write(`fake-swarm-memory-lost-writes: unknown command ${argv.join(" ")}\n`);
process.exit(2);
