// keyword-recall-corpus.mjs — kw-03-keyword-recall-regression-tests
//
// Single source of truth for the synthetic corpus BOTH cross-implementation
// regression suites are built against:
//   - test/keyword-recall-regression.mjs (JS zero-dep server, kw-01)
//   - lib/mnemosyne/__tests__/keyword-recall-regression.test.ts (TS client, kw-02)
//
// Plain data + a couple of pure helpers, imported DIRECTLY (real ESM import,
// not copy-pasted) by both implementations' fake-swarm-memory-kw03 CLI
// doubles (test/fixtures/fake-swarm-memory-kw03.mjs and
// lib/mnemosyne/layers/__tests__/fixtures/fake-swarm-memory-kw03.mjs), so
// "both implementations find the same real answer" is proven against
// byte-identical corpus text/IDs, not two hand-maintained copies that could
// silently drift apart.
//
// Reproduces the EXACT shape of the real, confirmed defect documented in
// docs/qdrant-hybrid-retrieval-experiment.md's Test 1: a real ticket ID
// (PAN-8968) alongside other similarly-shaped ticket IDs (PAN-7909) sharing
// one template ("ticket completion" notes) -- dense embeddings cannot
// reliably tell them apart (the wrong-but-confident neighbors score
// 0.524-0.534, the correct one doesn't even appear in the top 5), while
// keyword/exact-match finds the correct one instantly. This fixture mirrors
// that shape with synthetic, deliberately non-real IDs (short prefix +
// sequential numbers, same surrounding template text) per the story's own
// risk mitigation -- NOT obviously-distinct IDs a naive implementation would
// already get right.

// --- Scenario 1: exact-ID near-collision (Test 1 in the source doc) --------

export const TICKET_TEMPLATE = (id) => `COMPLETED: ticket ${id} merged to dev`;

// The query every "exact ID" assertion below issues. TEST-1001/1003 are its
// near-identical neighbors -- same template, sequential-looking numbers,
// genuinely confusable in embedding space, exactly like real PAN-8968 vs
// PAN-7909.
export const TARGET_TICKET = "TEST-1002";
export const NEIGHBOR_TICKETS = ["TEST-1001", "TEST-1003"];

export const TICKET_ENTRIES = [TARGET_TICKET, ...NEIGHBOR_TICKETS].map((id) => ({
  id,
  source: `ticket-${id.toLowerCase()}.md`,
  text: TICKET_TEMPLATE(id),
}));

export function ticketEntry(id) {
  return TICKET_ENTRIES.find((e) => e.id === id);
}

export function neighborEntries() {
  return NEIGHBOR_TICKETS.map((id) => ticketEntry(id));
}

// Real dense-embedding "wrong but confident" score band observed in the
// source experiment (0.524-0.534) -- both fixtures use this for the WRONG
// neighbor hits vector search returns for the exact-ID query, so the
// simulated defect isn't just "vector returns nothing" (which the old,
// already-fixed zero-hit escalation would have caught) but the REAL failure
// mode: nonzero, plausible-looking, wrong hits.
const WRONG_SCORE_LO = 0.524;
const WRONG_SCORE_HI = 0.534;
export function wrongScoreFor(index) {
  if (NEIGHBOR_TICKETS.length <= 1) return WRONG_SCORE_LO;
  return WRONG_SCORE_LO + ((WRONG_SCORE_HI - WRONG_SCORE_LO) * index) / (NEIGHBOR_TICKETS.length - 1);
}

// --- Scenario 2: purely conceptual query (Test 2 in the source doc) --------
//
// Mirrors the source doc's Test 2 exactly: a paraphrase sharing ZERO literal
// words with the source note (which uses "reaper"/"kill-mode"/
// "process-death"/"restart policy"). Proves the keyword-path fix did not
// regress plain semantic recall -- keyword search must find NOTHING for this
// query (no literal overlap), while vector/semantic search still finds the
// real conceptual match.

export const CONCEPT_QUERY =
  "automatically cleaning up dead or stuck worker processes so the system self-heals";

export const CONCEPT_ENTRY = {
  source: "reaper-notes.md",
  text: "reaper: kill-mode triggers on process-death events, restart policy engages automatically",
};

export const CONCEPT_SCORE = 0.71;
