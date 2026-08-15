# Hybrid retrieval experiment — `experimental_data` collection

**Status:** real hands-on tests + real research complete. No production layer changes made — this
is findings + a recommendation, not an implementation. **Date:** 2026-08-15.
**Prerequisite honored:** a full, verified backup of all 16 live Qdrant collections
(46,932 points, zero mismatches) was taken before any of this — see
`~/Documents/work/personal/qdrant-backup-2026-08-15/README.md`.

## Why

The operator raised mixing an "indexing knowledge base" (keyword/structural) with the existing
"semantic knowledge base" (dense vector search) and asked for real experiments plus deep research
before deciding anything. This document is both.

## Setup

New Qdrant collection `experimental_data` (768-dim, Cosine — matches the live cluster's existing
config exactly) on the same production Qdrant Cloud cluster, seeded with 100 real points copied
from the `work_root_memory` backup (real vectors + real payload text, not synthetic data — reading
already-backed-up data into a disposable test collection touches nothing live). A full-text payload
index was added on `text` and `source` — Qdrant's native keyword/exact-match capability, zero new
infrastructure required.

## Real hands-on results

### Test 1 — exact identifier lookup: keyword vs. semantic

Query: `PAN-8968` (a real ticket ID present in the corpus, alongside many similarly-shaped ticket
IDs like `PAN-7909`).

| Method | Result |
|---|---|
| Keyword (Qdrant full-text filter) | **1 match, the correct one, instant.** |
| Pure semantic (dense vector, same embedder) | **The correct document does not appear in the top 5 at all.** Top 5 are all *other* ticket-completion messages (scores 0.524–0.534) — same template, wrong ticket. |

Dense embeddings genuinely cannot distinguish `PAN-8968` from `PAN-7909` — they're nearly
identical in embedding space despite being unrelated tickets. This is not a tuning problem; it's
what dense embeddings are for (semantic similarity, not lexical identity).

### Test 2 — conceptual/paraphrased query: semantic vs. keyword

Query: *"automatically cleaning up dead or stuck worker processes so the system self-heals"* — a
paraphrase sharing **zero literal words** with the source content (which talks about "reaper",
"kill-mode", "process-death events", "restart policy").

| Method | Result |
|---|---|
| Pure semantic | **All top 5 results genuinely relevant** (scores 0.65–0.72) — real conceptual matches despite no shared vocabulary. |
| Keyword (`"dead worker"`) | **1 weak match** — narrow, incidental, not the real signal. |

The mirror-image failure mode: keyword search cannot find content that doesn't share your words,
no matter how relevant it is.

### Test 3 — combined filter + semantic (already available, zero new infra)

Qdrant natively supports a payload filter and a vector search in the *same* call. Tested: semantic
search for `PAN-8968`, filtered to only `story-done`-sourced documents. Mechanically works
correctly (narrows the candidate set as expected) — but **does not fix the exact-match problem**:
the true match still doesn't surface by semantic rank even within the filtered subset. Filtering is
a different, complementary tool (narrow by category/date/repo) — not a substitute for keyword
matching when the query itself *is* an identifier.

### What this proves

Keyword and semantic search fail in exactly complementary ways, demonstrated on this repo's own
real memory corpus, not a synthetic benchmark. Neither is a superset of the other.

## Research findings (deep dive, primary sources verified where possible)

Full task delegated to a research pass across Qdrant's own docs, Anthropic's published research,
Microsoft's GraphRAG research, and independent (non-vendor) production case studies. Headline,
condensed:

- **Hybrid dense+sparse search: genuinely corpus-dependent, not a safe default.** Qdrant's own
  docs recommend it but publish no benchmark numbers and explicitly say "measure, don't assume." A
  real, primary-sourced counter-example (Hugging Face engineering blog, a 156-query eval on
  scientific PDFs) found hybrid search **lost** to dense-only (63.5% vs. 69.2% hit rate) — added
  keyword noise without semantic grounding. A widely-circulated "91% hybrid vs 78% dense" stat
  traces to a vendor blog with no verifiable methodology — not trustworthy as stated.
- **Contextual retrieval (Anthropic, verified primary source): real, quantified, and directly
  applicable.** Prepending a short context blurb to each chunk before embedding cut retrieval
  failure rate 35% alone, 49% combined with keyword search, 67% combined with reranking. Anthropic's
  own explicit caveat: **skip this entirely if your knowledge base is under ~200K tokens** — just
  put the whole thing in context. Worth checking our actual corpus size per collection against that
  bar before assuming it applies.
- **Chunking strategy: also corpus-dependent.** The same Hugging Face study found naive fixed-size
  chunking *beat* semantic/context-aware chunking on their corpus (70.5% vs. 63.8%) — structural
  section breaks split related content. A different (clinical-decision-support) paper found the
  opposite. No universal answer.
- **GraphRAG (Microsoft, verified primary source): real effect, narrow applicability.** Wins
  decisively on *global* queries requiring synthesis across large portions of a corpus (96/96 wins
  in Microsoft's own benchmark suite, methodology published). Loses to plain vector search — pure
  overhead — for local, single-fact lookups. This maps directly onto this session's own
  already-identified company-director-tier gap (cross-repo/cross-project synthesis questions), not
  onto everyday recall.
- **The strongest, most load-bearing finding across the whole pass**: multiple independently
  sourced results landed on *opposite* sides of the same questions (hybrid vs. dense, semantic vs.
  naive chunking) depending on corpus and domain. The field's own aggregate advice inverts often
  enough that it isn't safe to adopt on faith — which is exactly what Tests 1–3 above did on our
  own real corpus instead of trusting a generic claim.

Full citations: Anthropic (`anthropic.com/engineering/contextual-retrieval`), Hugging Face
(`huggingface.co/blog/charles-azam/rag`), Qdrant (`qdrant.tech/articles/hybrid-search/`), Microsoft
Research BenchmarkQED (`microsoft.com/en-us/research/blog/benchmarkqed-...`).

## Recommendation

1. **Don't adopt hybrid dense+sparse search as a default.** The real counter-evidence is too strong
   and our own Test 3 showed filtering (the cheap, already-available part of "hybrid") doesn't
   solve the exact-match problem anyway.
2. **Do add a real keyword/exact-match path as a first-class recall option**, not a hybrid-fusion
   layer — Test 1 shows this is a completely different, complementary retrieval mode, not a tuning
   knob on semantic search. Qdrant's native full-text payload index already does this with zero new
   infrastructure (same collections, same cluster, just an index). This is the most direct win from
   this whole experiment: ticket IDs, exact filenames, exact error strings, exact node/symbol names
   — anything with a literal-identity query — should route to keyword match, not vector search.
3. **Try contextual retrieval's core mechanism, but only after checking whether it even applies** —
   measure real per-collection token counts against Anthropic's ~200K-token threshold before
   investing in it.
4. **Don't adopt semantic/context-aware chunking over the current approach without a real
   comparison** — same "corpus-dependent" caveat as hybrid search.
5. **GraphRAG-style synthesis stays scoped to the company-director tier** (already-identified gap),
   not a general semantic-search upgrade.
6. **General methodology takeaway for any future retrieval-strategy work**: run the real A/B test
   on our own corpus (as done here) before adopting a technique on the strength of published
   benchmarks from a different domain — this session's own results (Tests 1–3) directly contradicted
   what a naive reading of "hybrid search is better" would have predicted.

## Cleanup

`experimental_data` is a disposable test collection — 100 points copied from an already-backed-up
source, safe to delete once this document is reviewed, or to keep as a sandbox for the keyword-path
prototype in item 2 above.
