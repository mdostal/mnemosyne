// test/parallel-keyword.mjs — kw-01-js-server-parallel-keyword
//
// Proves the real, confirmed defect in src/engine.mjs's recall(): escalation
// to grep() (keyword) only fired on ZERO vector hits or a vector error. A
// ticket-ID-shaped query that returns nonzero but WRONG vector hits never
// escalated at all, so the correct keyword hit was silently dropped even
// though grep() itself works correctly. See docs/qdrant-hybrid-retrieval-
// experiment.md for the real experiment behind this fix.
//
// Also proves the fixed behavior: grep() runs in PARALLEL with vector on
// every call (not conditionally), results are merged with honest
// per-hit provenance (match_type: semantic/keyword/both), duplicates (same
// source+chunk found by both paths) are deduped without dropping the dual-
// match signal, layers_attempted honestly reflects both were attempted, and
// the pre-existing vector-error degraded-marker behavior is preserved.
import { fileURLToPath } from "node:url";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-swarm-memory", import.meta.url));
process.env.SWARM_MEMORY_BIN = FIXTURE;
process.env.FAKE_SWARM_MODE = "success";
process.env.MNEMO_TEST_NODE = process.execPath;

const { recall } = await import("../src/engine.mjs?parallel-keyword-test");

function allHits(result) {
  return (result.scopes || []).flatMap((s) => s.hits || []);
}

async function runTests() {
  console.log("Running parallel-keyword recall tests...");
  let fails = 0;
  const ok = (c, m) => {
    console.log(`${c ? "  PASS" : "  FAIL"}  ${m}`);
    if (!c) fails++;
  };

  // --- The real confirmed defect / fixed behavior ---------------------------
  // Vector alone returns 1 (WRONG) hit for a ticket-ID-shaped query; grep()
  // has the correct exact-match hit. Before the fix, grep() was never
  // attempted (vector "succeeded" by returning something nonzero) so the
  // correct hit never appeared. After the fix, both hits must be present.
  {
    const result = await recall("KWTEST_TICKET-PAN-8968", "personal", { hits: 5 });
    const hits = allHits(result);
    const correctHit = hits.find((h) => h.source === "correct-ticket.md");
    const wrongHit = hits.find((h) => h.source === "other-ticket.md");

    ok(!!correctHit, "ticket-ID query: correct keyword hit is present in merged results (the real defect)");
    ok(!!wrongHit, "ticket-ID query: wrong-but-nonzero vector hit is still present alongside it");
    ok(
      correctHit && correctHit.provenance && correctHit.provenance.layer === "file",
      "correct hit's provenance.layer === 'file' (keyword path)",
    );
    ok(correctHit && correctHit.match_type === "keyword", "correct hit's match_type === 'keyword'");
    ok(
      wrongHit && wrongHit.provenance && wrongHit.provenance.layer === "vector",
      "wrong hit's provenance.layer === 'vector' (unchanged field name/value)",
    );
    ok(wrongHit && wrongHit.match_type === "semantic", "wrong (vector) hit's match_type === 'semantic'");
    ok(
      Array.isArray(result.layers_attempted) &&
        result.layers_attempted.includes("vector") &&
        result.layers_attempted.includes("file"),
      `layers_attempted honestly includes both vector and file (got ${JSON.stringify(result.layers_attempted)})`,
    );
  }

  // --- Purely semantic query still ranks/surfaces correctly ------------------
  // Parallel keyword addition must not crowd out or degrade real semantic
  // hits for a query with no special keyword-layer signal.
  {
    const result = await recall("a purely conceptual paraphrased query", "personal", { hits: 5 });
    const hits = allHits(result);
    ok(hits.length > 0, "purely semantic query still returns hits");
    const semanticHit = hits.find((h) => h.match_type === "semantic");
    ok(!!semanticHit, "semantic hit is present and correctly tagged");
    ok(
      hits[0] && hits[0].provenance && hits[0].provenance.layer === "vector",
      "vector hit is ranked/ordered ahead of a keyword-only hit for a semantic query",
    );
  }

  // --- Dedupe: same source+chunk_index found by both paths -------------------
  {
    const result = await recall("KWTEST_DUP", "personal", { hits: 5 });
    const hits = allHits(result);
    const dupHits = hits.filter((h) => h.source === "dup.md" && h.chunk_index === 2);
    ok(dupHits.length === 1, `same source+chunk from both layers appears exactly once (got ${dupHits.length})`);
    ok(dupHits[0] && dupHits[0].match_type === "both", "deduped hit's match_type === 'both'");
    ok(
      dupHits[0] && dupHits[0].provenance && dupHits[0].provenance.matched_both === true,
      "deduped hit's provenance notes it matched both ways (signal not silently dropped)",
    );
  }

  // --- Vector-error degradation-marker behavior is preserved -----------------
  // When vector genuinely errors, the pre-existing degraded-marker behavior
  // (provenance.degraded = true) must still apply -- this is a distinct
  // concern from "also try keyword" and must not be lost.
  {
    const result = await recall("KWTEST_VECTOR_ERROR", "personal", { hits: 5 });
    const hits = allHits(result);
    ok(hits.length > 0, "vector-error case still returns the keyword layer's hits");
    ok(
      hits.every((h) => h.provenance && h.provenance.degraded === true),
      "every hit is marked provenance.degraded=true when vector genuinely errored",
    );
    ok(
      hits.every((h) => h.provenance && h.provenance.layer === "file"),
      "every hit in the vector-error case came from the file (keyword) layer",
    );
    ok(
      Array.isArray(result.layers_attempted) &&
        result.layers_attempted.includes("vector") &&
        result.layers_attempted.includes("file"),
      "layers_attempted still honestly includes both, even though vector failed",
    );
  }

  // --- opts.escalate keeps working for existing callers -----------------------
  {
    const result = await recall("KWTEST_TICKET-escalate-check", "personal", { hits: 5, escalate: true });
    ok(result.total_hits > 0, "opts.escalate does not break the parallel-keyword call path");
  }

  // --- Zero-hit / obscure query: unaffected by parallel keyword --------------
  {
    const randomQuery = "nonexistent_guid_fallback_" + Date.now();
    const result = await recall(randomQuery, "personal", { hits: 1, minScore: 0.999 });
    ok(result.total_hits === 0, "obscure query with no hits on either layer still returns 0 total_hits");
    ok(
      Array.isArray(result.layers_attempted) &&
        result.layers_attempted.includes("vector") &&
        result.layers_attempted.includes("file"),
      "layers_attempted includes both even on a genuinely empty result",
    );
  }

  console.log(fails ? `\n${fails} check(s) failed` : "\nall parallel-keyword checks passed");
  process.exit(fails ? 1 : 0);
}

runTests();
