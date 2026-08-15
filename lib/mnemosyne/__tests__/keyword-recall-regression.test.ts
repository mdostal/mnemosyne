// kw-03-keyword-recall-regression-tests
//
// Higher-rigor, cross-implementation regression layer on top of kw-02's own
// test-spec-driven tests (KeywordLayerAdapter.test.ts,
// client-keyword-cascade.test.ts). THIS suite exercises the REAL
// `MnemosyneClient.recall()` cascade with REAL `VectorLayerAdapter` +
// `KeywordLayerAdapter` classes (not mocked functions) against a hermetic,
// deterministic `fake-swarm-memory-kw03.mjs` subprocess double, seeded from
// test/fixtures/keyword-recall-corpus.mjs -- the SAME corpus module the
// companion JS-server-side suite (test/keyword-recall-regression.mjs) uses,
// imported directly by both fixture doubles so the two implementations are
// tested against byte-identical corpus text/IDs, not two hand-maintained
// copies that could drift.
//
// Reproduces the EXACT shape of the real defect this epic exists to fix
// (docs/qdrant-hybrid-retrieval-experiment.md's Test 1): three
// near-identical ticket-completion notes (TEST-1001/1002/1003, same
// template, short prefix + sequential numbers -- mirrors the real
// PAN-8968/PAN-7909 near-collision shape) where dense vector search for the
// exact target ID (TEST-1002) returns its wrong-but-plausible NEIGHBORS,
// never the correct entry -- while keyword search finds the correct one
// instantly and exactly. Also proves a purely conceptual query (Test 2's
// paraphrase, zero literal overlap with any corpus entry) still surfaces
// the real semantic match -- no regression to plain semantic recall.
//
// Cross-implementation consistency (this epic's "kept in sync" convention,
// per kw-03's 3rd acceptance criterion): the JS-server suite asserts the
// merged POST /recall response contains the entry for TEST-1002 (via
// engine.mjs's mergeVectorAndKeyword()); this suite asserts
// MnemosyneClient.recall()'s merged hits contain the SAME entry (via
// dedupeParallelHits()) for the SAME query against the SAME corpus data --
// not byte-identical response envelopes (this client's RecallResult shape
// differs from the JS server's raw {query,total_hits,scopes} shape by
// design -- see test/recall-status-filtering.mjs's own doc comment on this
// exact difference), but the same real answer, findable via both.
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MnemosyneClient } from '../client.js';
import { KeywordLayerAdapter } from '../layers/KeywordLayerAdapter.js';
import { LayerRegistry } from '../layers/registry.js';
import { VectorLayerAdapter } from '../layers/VectorLayerAdapter.js';

const FAKE_SWARM_MEMORY_KW03 = fileURLToPath(
  new URL('../layers/__tests__/fixtures/fake-swarm-memory-kw03.mjs', import.meta.url),
);

// Dynamically imported (via a computed, non-literal specifier) rather than a
// static `import` so `tsc` never needs to type-check a plain .mjs data
// module (this repo's tsconfig only type-checks lib/**/*.ts and
// src/**/*.ts) -- this is the REAL, single source of truth
// (test/fixtures/keyword-recall-corpus.mjs), not a hand-duplicated copy.
const CORPUS_URL = pathToFileURL(
  fileURLToPath(new URL('../../../test/fixtures/keyword-recall-corpus.mjs', import.meta.url)),
).href;

interface TicketEntry {
  id: string;
  source: string;
  text: string;
}

interface Corpus {
  TARGET_TICKET: string;
  NEIGHBOR_TICKETS: string[];
  TICKET_ENTRIES: TicketEntry[];
  ticketEntry: (id: string) => TicketEntry | undefined;
  neighborEntries: () => TicketEntry[];
  CONCEPT_QUERY: string;
  CONCEPT_ENTRY: { source: string; text: string };
}

async function loadCorpus(): Promise<Corpus> {
  return (await import(CORPUS_URL)) as unknown as Corpus;
}

function buildClient(): MnemosyneClient {
  const registry = new LayerRegistry();
  registry.register('vector', (options) =>
    new VectorLayerAdapter(options as ConstructorParameters<typeof VectorLayerAdapter>[0]),
  );
  registry.register('keyword', (options) =>
    new KeywordLayerAdapter(options as ConstructorParameters<typeof KeywordLayerAdapter>[0]),
  );

  return new MnemosyneClient({
    registry,
    layerStack: {
      layers: [
        { name: 'vector', options: { command: FAKE_SWARM_MEMORY_KW03 } },
        { name: 'keyword', options: { command: FAKE_SWARM_MEMORY_KW03 } },
      ],
    },
  });
}

describe('MnemosyneClient — keyword-recall cross-implementation regression (kw-03)', () => {
  it('exact-ID query: the real, correct entry is present via the merged vector+keyword cascade, even though vector alone returns its wrong-but-plausible neighbors', async () => {
    const corpus = await loadCorpus();
    const client = buildClient();

    const result = await client.recall(corpus.TARGET_TICKET, 'project');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.layers_queried).toEqual(expect.arrayContaining(['vector', 'keyword']));

    const correctEntry = corpus.ticketEntry(corpus.TARGET_TICKET);
    expect(correctEntry).toBeDefined();
    const correctHit = result.hits.find((h) => h.provenance.source === correctEntry!.source);
    expect(correctHit, 'the real, correct entry is present in the merged hits (the real defect this epic fixes)').toBeDefined();
    expect(correctHit?.content).toBe(correctEntry!.text);
    expect(correctHit?.provenance.layer).toBe('keyword');

    // The wrong, near-identical neighbors are what vector search returns for
    // this query (the real defect) -- they must ALSO be present (merged,
    // not replaced), each still tagged as the vector layer's own guess.
    for (const neighborId of corpus.NEIGHBOR_TICKETS) {
      const neighborEntry = corpus.ticketEntry(neighborId)!;
      const neighborHit = result.hits.find((h) => h.provenance.source === neighborEntry.source);
      expect(neighborHit, `wrong-but-plausible neighbor ${neighborId} is present`).toBeDefined();
      expect(neighborHit?.provenance.layer).toBe('vector');
    }

    expect(result.hits).toHaveLength(1 + corpus.NEIGHBOR_TICKETS.length);
  });

  it('purely conceptual query: the real semantic match is surfaced (zero literal overlap with the corpus entry), and keyword genuinely finds nothing -- no regression to plain semantic recall', async () => {
    const corpus = await loadCorpus();
    const client = buildClient();

    const result = await client.recall(corpus.CONCEPT_QUERY, 'project');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);

    const semanticHit = result.hits.find((h) => h.provenance.source === corpus.CONCEPT_ENTRY.source);
    expect(semanticHit, 'the real conceptual match is present').toBeDefined();
    expect(semanticHit?.content).toBe(corpus.CONCEPT_ENTRY.text);
    expect(semanticHit?.provenance.layer).toBe('vector');

    // Query literally shares zero words with the corpus entry's text -- the
    // keyword layer must genuinely find nothing for it (mirrors the source
    // doc's Test 2: "keyword search cannot find content that doesn't share
    // your words").
    expect(result.hits.some((h) => h.provenance.layer === 'keyword')).toBe(false);
    expect(result.hits).toHaveLength(1);
  });

  it('determinism (kw-03 AC4): the same query against the same fixture returns the same hit set across repeated calls, no ordering/timing flakiness', async () => {
    const corpus = await loadCorpus();
    const client = buildClient();

    const run1 = await client.recall(corpus.TARGET_TICKET, 'project');
    const run2 = await client.recall(corpus.TARGET_TICKET, 'project');
    expect(run1.ok).toBe(true);
    expect(run2.ok).toBe(true);
    if (!run1.ok || !run2.ok) throw new Error('expected both runs to succeed');

    const sources1 = run1.hits.map((h) => h.provenance.source).sort();
    const sources2 = run2.hits.map((h) => h.provenance.source).sort();
    expect(sources1).toEqual(sources2);

    const conceptRun1 = await client.recall(corpus.CONCEPT_QUERY, 'project');
    const conceptRun2 = await client.recall(corpus.CONCEPT_QUERY, 'project');
    expect(conceptRun1.ok).toBe(true);
    expect(conceptRun2.ok).toBe(true);
    if (!conceptRun1.ok || !conceptRun2.ok) throw new Error('expected both concept runs to succeed');
    expect(conceptRun1.hits.map((h) => h.provenance.source)).toEqual(
      conceptRun2.hits.map((h) => h.provenance.source),
    );
  });
});
