#!/usr/bin/env node
// fake-swarm-memory-kw03.mjs — kw-03-keyword-recall-regression-tests
//
// A SEPARATE test double from test/fixtures/fake-swarm-memory.mjs
// (kw-01's own fixture, driven by magic KWTEST_* query substrings). This one
// is keyed by the REAL literal query text a caller would actually type (an
// exact ticket ID, or a plain-English conceptual phrase) against a small,
// hermetic, synthetic corpus imported from test/fixtures/
// keyword-recall-corpus.mjs -- the single source of truth this fixture
// shares with its TS-side counterpart
// (lib/mnemosyne/layers/__tests__/fixtures/fake-swarm-memory-kw03.mjs), so
// both implementations are exercised against byte-identical corpus data.
//
// `recall` (vector layer, simulates the REAL confirmed defect from
// docs/qdrant-hybrid-retrieval-experiment.md's Test 1): a query for the
// exact target ticket ID returns its near-identical NEIGHBORS (wrong, but
// nonzero, plausible-looking hits) -- never the correct entry. A purely
// conceptual query (no literal overlap with any corpus entry) returns the
// real semantic match, proving the keyword-path fix didn't regress plain
// semantic recall.
//
// `grep` (keyword layer): the exact-ID query finds the correct entry
// instantly and exactly. The conceptual query finds nothing (mirrors Test 2:
// keyword search cannot find content sharing none of the query's words).
import {
  CONCEPT_ENTRY,
  CONCEPT_QUERY,
  CONCEPT_SCORE,
  neighborEntries,
  TARGET_TICKET,
  ticketEntry,
  wrongScoreFor,
} from "./keyword-recall-corpus.mjs";

const [, , cmd, ...args] = process.argv;
const query = args[0] || "";

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

if (cmd === "recall") {
  if (query === TARGET_TICKET) {
    const neighbors = neighborEntries();
    process.stdout.write(
      JSON.stringify({
        query,
        total_hits: neighbors.length,
        scopes: [
          {
            scope: "personal",
            collection: "test_collection",
            hits: neighbors.map((entry, i) => ({
              text: entry.text,
              score: wrongScoreFor(i),
              source: entry.source,
              full_path: entry.source,
              chunk_index: 0,
            })),
          },
        ],
      })
    );
    process.exit(0);
  }

  if (query === CONCEPT_QUERY) {
    process.stdout.write(
      JSON.stringify({
        query,
        total_hits: 1,
        scopes: [
          {
            scope: "personal",
            collection: "test_collection",
            hits: [
              {
                text: CONCEPT_ENTRY.text,
                score: CONCEPT_SCORE,
                source: CONCEPT_ENTRY.source,
                full_path: CONCEPT_ENTRY.source,
                chunk_index: 0,
              },
            ],
          },
        ],
      })
    );
    process.exit(0);
  }

  // Deterministic empty fallback for any query outside this fixture's two
  // defined scenarios.
  process.stdout.write(
    JSON.stringify({ query, total_hits: 0, scopes: [{ scope: "personal", collection: "test_collection", hits: [] }] })
  );
  process.exit(0);
}

if (cmd === "grep") {
  if (query === TARGET_TICKET) {
    const entry = ticketEntry(TARGET_TICKET);
    process.stdout.write(
      JSON.stringify([
        {
          scope: "personal",
          collection: "test_collection",
          hits: [
            {
              text: entry.text,
              source: entry.source,
              full_path: entry.source,
              chunk_index: 0,
            },
          ],
        },
      ])
    );
    process.exit(0);
  }

  // CONCEPT_QUERY (and anything else): no literal overlap with any corpus
  // entry -- keyword search genuinely finds nothing, mirroring the source
  // doc's Test 2 finding exactly.
  process.stdout.write(
    JSON.stringify([{ scope: "personal", collection: "test_collection", hits: [] }])
  );
  process.exit(0);
}

// CodeGraphLayer (src/layers/code-graph.mjs) always shells `graph edges
// --json <query>` and `graph deps --json <query>` as part of engine.mjs's
// recall() merge step -- return real, harmless empty arrays rather than
// letting these fall through to the "unknown command" branch below (which
// would make CodeGraphLayer swallow the failure anyway, but an explicit
// empty response is the honest, intentional contract here).
if (cmd === "graph") {
  process.stdout.write(JSON.stringify([]));
  process.exit(0);
}

process.stderr.write(`fake-swarm-memory-kw03: unknown command ${cmd}\n`);
process.exit(2);
