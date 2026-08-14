#!/usr/bin/env node
// fake-swarm-memory.mjs — test double for the `swarm-memory` CLI.
//
// Stands in for the real binary so write-through.mjs / reindex.mjs can drive
// engine.mjs's remember()/reindex() through success/failure scenarios
// without a live Qdrant. Behavior for `index` is controlled by
// FAKE_SWARM_MODE:
//   success      -> exit 0, reports "upserted 3 chunks"
//   silent-fail  -> exit 0, but no chunks reported (Qdrant no-op)
//   hard-fail    -> exit 1, stderr error message
//
// Independent of FAKE_SWARM_MODE, `index` fails for any path containing the
// literal substring "REINDEX_FAIL" — lets reindex.mjs simulate a single bad
// file mid-run without needing a whole extra mode.
//
// FAKE_SWARM_INDEX_STORE (la-05-recall-status-filtering): when set, `index`
// records the real file path it was asked to index into this JSON store
// (a plain array of {full_path}, keyed by full_path so re-indexing the same
// file updates rather than duplicates its entry), and `recall` returns a hit
// per stored entry with a REAL `full_path` pointing at the actual note file
// on disk — instead of the static canned hit below. This lets a recall-side
// consumer (status-filter.mjs) read the real flight-status header
// remember() wrote, exercising the actual read-the-note-file-on-disk path
// end-to-end without needing a live Qdrant. Unset (the default): behavior is
// byte-for-byte unchanged from before this option existed, so every
// pre-existing caller of this fixture is unaffected.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const [, , cmd, ...args] = process.argv;
const mode = process.env.FAKE_SWARM_MODE || "success";

function graphStorePath() {
  return process.env.FAKE_SWARM_GRAPH_STORE;
}

function readGraphEdges() {
  const store = graphStorePath();
  if (!store) return [];
  try {
    return JSON.parse(readFileSync(store, "utf8"));
  } catch {
    return [];
  }
}

function writeGraphEdges(edges) {
  const store = graphStorePath();
  if (store) {
    writeFileSync(store, JSON.stringify(edges), "utf8");
  }
}

function indexStorePath() {
  return process.env.FAKE_SWARM_INDEX_STORE;
}

function readIndexStore() {
  const store = indexStorePath();
  if (!store || !existsSync(store)) return [];
  try {
    return JSON.parse(readFileSync(store, "utf8"));
  } catch {
    return [];
  }
}

function writeIndexStore(entries) {
  const store = indexStorePath();
  if (store) {
    writeFileSync(store, JSON.stringify(entries), "utf8");
  }
}

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
  if (mode === "hard-fail" || args.some((arg) => arg.includes("REINDEX_FAIL"))) {
    process.stderr.write("fake swarm-memory: qdrant upsert connection refused\n");
    process.exit(1);
  }
  if (mode === "silent-fail") {
    process.stdout.write("no changes detected, nothing to index\n");
    process.exit(0);
  }
  if (indexStorePath()) {
    // Last positional arg is always the single file remember() indexes
    // (`index <collection> [--no-prune] <file>`).
    const file = args[args.length - 1];
    const entries = readIndexStore().filter((e) => e.full_path !== file);
    entries.push({ full_path: file });
    writeIndexStore(entries);
  }
  process.stdout.write("indexed 1 file(s), upserted 3 chunks into test_collection\n");
  process.exit(0);
}

if (cmd === "recall") {
  const query = args[0] || "";
  const minScoreFlag = args.indexOf("--min-score");
  const minScore = minScoreFlag === -1 ? 0 : Number(args[minScoreFlag + 1] || 0);
  const isEmpty = query.includes("nonexistent_guid_fallback_") || minScore >= 0.999;

  if (indexStorePath()) {
    const entries = readIndexStore();
    const hits = isEmpty
      ? []
      : entries.map((e) => ({
          text: "flight-status-tracked note fixture hit",
          score: 0.91,
          full_path: e.full_path,
          source: e.full_path,
        }));
    process.stdout.write(
      JSON.stringify({
        query,
        total_hits: hits.length,
        scopes: [{ scope: "personal", collection: "test_collection", hits }],
      })
    );
    process.exit(0);
  }

  process.stdout.write(
    JSON.stringify({
      query,
      total_hits: isEmpty ? 0 : 1,
      scopes: [
        {
          scope: "personal",
          collection: "test_collection",
          hits: isEmpty
            ? []
            : [
                {
                  text: "test semantic query fixture hit",
                  score: 0.91,
                  source: "fake-swarm-memory",
                },
              ],
        },
      ],
    })
  );
  process.exit(0);
}

if (cmd === "grep") {
  const query = args[0] || "";
  const isEmpty = query.includes("nonexistent_guid_fallback_");

  process.stdout.write(
    JSON.stringify([
      {
        scope: "personal",
        collection: "test_collection",
        hits: isEmpty
          ? []
          : [
              {
                text: "test keyword fixture hit",
                source: "fake-swarm-memory",
              },
            ],
      },
    ])
  );
  process.exit(0);
}

if (cmd === "graph") {
  const [subcommand, ...graphArgs] = args;
  const query = graphArgs[graphArgs.length - 1] || "";

  if (subcommand === "edges") {
    const fixtureEdges = [
      {
        src: "att:funnel:visitor",
        predicate: "depends_on",
        dst: "att:funnel:session",
        origin: "fixture",
      },
    ];
    const edges = [...fixtureEdges, ...readGraphEdges()].filter((edge) => edge.src === query);
    process.stdout.write(JSON.stringify(edges));
    process.exit(0);
  }

  if (subcommand === "deps") {
    const impact =
      query === "att:funnel:visitor"
        ? [
            {
              node: "src/analytics/funnel.ts",
              via: "att:funnel:session",
            },
          ]
        : [];
    process.stdout.write(JSON.stringify(impact));
    process.exit(0);
  }

  if (subcommand === "add") {
    const [src, predicate, dst] = graphArgs;
    const edges = readGraphEdges();
    edges.push({ src, predicate, dst, origin: "fixture-store" });
    writeGraphEdges(edges);
    process.stdout.write(JSON.stringify({ added: true }));
    process.exit(0);
  }
}

process.stderr.write(`fake swarm-memory: unknown command ${cmd}\n`);
process.exit(2);
