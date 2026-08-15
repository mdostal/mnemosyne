#!/usr/bin/env node
// fake-swarm-memory-kw03.mjs — kw-03-keyword-recall-regression-tests
//
// A SEPARATE test double from ./fake-swarm-memory.mjs (kw-02's own generic
// hits/empty/error-mode fixture). This one is keyed by the REAL literal
// query text a caller would actually type (an exact ticket ID, or a plain-
// English conceptual phrase) against a small, hermetic, synthetic corpus
// imported DIRECTLY from test/fixtures/keyword-recall-corpus.mjs -- the
// single source of truth this fixture shares with its JS-server-side
// counterpart (test/fixtures/fake-swarm-memory-kw03.mjs), so both
// implementations (this TS client and the zero-dep JS server) are exercised
// against byte-identical corpus data.
//
// `recall` (VectorLayerAdapter, simulates the REAL confirmed defect from
// docs/qdrant-hybrid-retrieval-experiment.md's Test 1): a query for the
// exact target ticket ID returns its near-identical NEIGHBORS (wrong, but
// nonzero, plausible-looking hits) -- never the correct entry.
//
// `grep` (KeywordLayerAdapter): the exact-ID query finds the correct entry
// instantly and exactly, in the real `swarm-memory grep --json` envelope
// (top-level array, distinct from `recall`'s {query,total_hits,scopes}
// object -- see KeywordLayerAdapter.ts's own doc comment on this).
//
// A purely conceptual query (zero literal overlap with any corpus entry)
// returns the real semantic match via `recall`, and NOTHING via `grep` --
// proving the keyword-path fix didn't regress plain semantic recall.
import {
  CONCEPT_ENTRY,
  CONCEPT_QUERY,
  CONCEPT_SCORE,
  neighborEntries,
  TARGET_TICKET,
  ticketEntry,
  wrongScoreFor,
} from "../../../../../test/fixtures/keyword-recall-corpus.mjs";

const [, , cmd, query] = process.argv;

if (cmd === "config") {
  process.stdout.write(
    JSON.stringify({
      qdrant_url: "https://fake.qdrant.example:6333",
      embedder: { provider: "ollama", model: "nomic-embed-text" },
      scopes: { project: "test_collection", personal: "personal_memory" },
      ladder: { project: ["top"] },
      default_scope: "project",
      fallback_collection: "test_collection",
    }),
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
            scope: "project",
            collection: "test_collection",
            hits: neighbors.map((entry, i) => ({
              collection: "test_collection",
              score: wrongScoreFor(i),
              match_type: "semantic",
              location: entry.source,
              full_path: entry.source,
              source: entry.source,
              repo: "",
              chunk_index: 0,
              chunk_span: null,
              text: entry.text,
              provenance: {
                source: entry.source,
                full_path: entry.source,
                chunk_index: 0,
                repo: "",
                collection: "test_collection",
                indexed_at: "2026-08-11T00:00:00+00:00",
                content_sha256: `${entry.id}-hash`,
                embed_model: "nomic-embed-text",
              },
            })),
          },
        ],
      }),
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
            scope: "project",
            collection: "test_collection",
            hits: [
              {
                collection: "test_collection",
                score: CONCEPT_SCORE,
                match_type: "semantic",
                location: CONCEPT_ENTRY.source,
                full_path: CONCEPT_ENTRY.source,
                source: CONCEPT_ENTRY.source,
                repo: "",
                chunk_index: 0,
                chunk_span: null,
                text: CONCEPT_ENTRY.text,
                provenance: {
                  source: CONCEPT_ENTRY.source,
                  full_path: CONCEPT_ENTRY.source,
                  chunk_index: 0,
                  repo: "",
                  collection: "test_collection",
                  indexed_at: "2026-08-11T00:00:00+00:00",
                  content_sha256: "concept-hash",
                  embed_model: "nomic-embed-text",
                },
              },
            ],
          },
        ],
      }),
    );
    process.exit(0);
  }

  process.stdout.write(JSON.stringify({ query, total_hits: 0, scopes: [{ scope: "project", collection: "test_collection", hits: [] }] }));
  process.exit(0);
}

if (cmd === "grep") {
  if (query === TARGET_TICKET) {
    const entry = ticketEntry(TARGET_TICKET);
    process.stdout.write(
      JSON.stringify([
        {
          scope: "project",
          collection: "test_collection",
          hits: [
            {
              collection: "test_collection",
              score: null,
              match_type: "keyword",
              location: entry.source,
              full_path: entry.source,
              source: entry.source,
              repo: "",
              chunk_index: 0,
              chunk_span: null,
              text: entry.text,
              provenance: {
                source: entry.source,
                full_path: entry.source,
                chunk_index: 0,
                repo: "",
                collection: "test_collection",
                indexed_at: "2026-08-11T00:00:00+00:00",
                content_sha256: `${entry.id}-hash`,
                embed_model: "nomic-embed-text",
                keyword_matches: 1,
                keywords_total: 1,
              },
            },
          ],
        },
      ]),
    );
    process.exit(0);
  }

  // CONCEPT_QUERY (and anything else): no literal overlap with any corpus
  // entry -- keyword search genuinely finds nothing, mirroring the source
  // doc's Test 2 finding exactly.
  process.stdout.write(JSON.stringify([{ scope: "project", collection: "test_collection", hits: [] }]));
  process.exit(0);
}

process.stderr.write(`fake-swarm-memory-kw03: unknown command ${cmd}\n`);
process.exit(2);
