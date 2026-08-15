#!/usr/bin/env node
// fake-swarm-memory.mjs — test double for the `swarm-memory` CLI, used by
// VectorLayerAdapter (and kw-02's KeywordLayerAdapter) tests to exercise
// recall()/remember()/grep() without a live Qdrant. Behavior is controlled
// by FAKE_SWARM_MEMORY_MODE:
//   hits      -> exit 0, one scope with two hits (default)
//   empty     -> exit 0, zero hits
//   error     -> exit 1, stderr message (e.g. Qdrant unreachable)
//   timeout   -> hang until killed by the caller's exec timeout
//   bad-json  -> exit 0, stdout is not valid JSON
//   graph-hits -> exit 0, code-graph impact hits
//   graph-empty -> exit 0, no code-graph impact hits
//
// `grep` command (kw-02-ts-client-keyword-layer's KeywordLayerAdapter):
//   grep-hits (default) -> exit 0, top-level ARRAY (not an object -- this
//                           differs from `recall`'s {query,total_hits,scopes}
//                           envelope, matching the real `swarm-memory grep
//                           --json` shape confirmed by running it live
//                           against this repo's own corpus) of one scope
//                           with two keyword hits (score: null, match_type:
//                           "keyword", no retrieved_at)
//   grep-empty           -> exit 0, one scope with zero hits
//   error/timeout/bad-json -> shared with recall/graph (same generic modes)
//
// `config` command (remember()'s scope->collection resolution):
//   hits/empty/graph-* (default) -> exit 0, real-shaped config JSON with a
//                                    'project' scope mapped to 'test_collection'
//   config-error -> exit 1, stderr message (config unreachable)
//
// `index` command (remember()'s write step):
//   index-upserted (default)    -> exit 0, "upserted N chunks (N total)" line
//   index-zero                  -> exit 0, but reports 0 chunks upserted
//   index-error                 -> exit 1, stderr message

const [, , cmd, query] = process.argv;
const mode = process.env.FAKE_SWARM_MEMORY_MODE || 'hits';

if (cmd === 'config') {
  if (mode === 'config-error') {
    process.stderr.write('fake swarm-memory: config unreachable\n');
    process.exit(1);
  }
  process.stdout.write(
    JSON.stringify({
      qdrant_url: 'https://fake.qdrant.example:6333',
      embedder: { provider: 'ollama', model: 'nomic-embed-text' },
      scopes: { project: 'test_collection', personal: 'personal_memory' },
      ladder: { project: ['top'] },
      default_scope: 'project',
      fallback_collection: 'test_collection',
    }),
  );
  process.exit(0);
}

if (cmd === 'index') {
  if (mode === 'index-error') {
    process.stderr.write('fake swarm-memory: qdrant upsert connection refused\n');
    process.exit(1);
  }
  if (mode === 'index-zero') {
    process.stdout.write('no changes detected, nothing to index\n');
    process.exit(0);
  }
  process.stdout.write(
    'upserted 1 chunks (1 total)\n✓ test_collection: 1 files indexed, 1 chunks upserted, 0 embed failures → 42 total points\n',
  );
  process.exit(0);
}

if (cmd === 'graph') {
  const [, , , subcommand, node] = process.argv;
  if (subcommand !== 'impact') {
    process.stderr.write(`fake swarm-memory: unknown graph command ${subcommand}\n`);
    process.exit(2);
  }

  if (mode === 'timeout') {
    setInterval(() => {}, 1000);
  } else if (mode === 'error') {
    process.stderr.write('fake swarm-memory: graph unavailable\n');
    process.exit(1);
  } else if (mode === 'bad-json') {
    process.stdout.write('not valid json{{{');
    process.exit(0);
  } else if (mode === 'graph-empty') {
    process.stdout.write(JSON.stringify([]));
    process.exit(0);
  } else {
    process.stdout.write(
      JSON.stringify([
        {
          node: 'src/consumer.ts',
          node_type: 'file',
          depth: 1,
          via: `src/consumer.ts --depends_on--> ${node}`,
        },
        {
          node: 'src/feature.ts',
          node_type: 'file',
          depth: 2,
          via: `src/feature.ts --implements--> src/consumer.ts --depends_on--> ${node}`,
        },
      ]),
    );
    process.exit(0);
  }
}

if (cmd === 'grep') {
  if (mode === 'timeout') {
    setInterval(() => {}, 1000);
  } else if (mode === 'error') {
    process.stderr.write('fake swarm-memory: qdrant unreachable: connection refused\n');
    process.exit(1);
  } else if (mode === 'bad-json') {
    process.stdout.write('not valid json{{{');
    process.exit(0);
  } else if (mode === 'grep-empty') {
    process.stdout.write(
      JSON.stringify([
        {
          scope: 'project',
          collection: 'test_collection',
          hits: [],
        },
      ]),
    );
    process.exit(0);
  } else {
    // grep-hits (default) -- real `swarm-memory grep --json` shape: a
    // top-level ARRAY of {scope, collection, hits[]}, NOT the {query,
    // total_hits, scopes} object `recall` returns. Hits have score: null
    // and match_type: "keyword", and their provenance has no
    // retrieved_at -- confirmed by running the real binary live.
    process.stdout.write(
      JSON.stringify([
        {
          scope: 'project',
          collection: 'test_collection',
          hits: [
            {
              collection: 'test_collection',
              score: null,
              match_type: 'keyword',
              location: '/repo/notes/ticket-one.md',
              full_path: '/repo/notes/ticket-one.md',
              source: 'ticket-one.md',
              repo: '',
              chunk_index: 0,
              chunk_span: null,
              text: `exact keyword match for ${query}`,
              provenance: {
                source: 'ticket-one.md',
                full_path: '/repo/notes/ticket-one.md',
                chunk_index: 0,
                repo: '',
                collection: 'test_collection',
                indexed_at: '2026-08-11T00:00:00+00:00',
                content_sha256: 'keyword1hash',
                embed_model: 'nomic-embed-text',
                keyword_matches: 1,
                keywords_total: 1,
              },
            },
            {
              collection: 'test_collection',
              score: null,
              match_type: 'keyword',
              location: '/repo/notes/ticket-two.md',
              full_path: '/repo/notes/ticket-two.md',
              source: 'ticket-two.md',
              repo: '',
              chunk_index: 2,
              chunk_span: null,
              text: `second exact keyword match for ${query}`,
              provenance: {
                source: 'ticket-two.md',
                full_path: '/repo/notes/ticket-two.md',
                chunk_index: 2,
                repo: '',
                collection: 'test_collection',
                indexed_at: '2026-08-12T00:00:00+00:00',
                content_sha256: 'keyword2hash',
                embed_model: 'nomic-embed-text',
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
  // Every branch above calls process.exit() itself, except 'timeout',
  // which intentionally hangs (setInterval doesn't block the synchronous
  // flow below it) -- the `else if (cmd !== 'recall')` / final `else`
  // below is gated so cmd === 'grep' never falls through into the
  // recall-shaped output past this point, timeout mode included.
} else if (cmd !== 'recall') {
  process.stderr.write(`fake swarm-memory: unknown command ${cmd}\n`);
  process.exit(2);
} else if (mode === 'timeout') {
  setInterval(() => {}, 1000);
} else if (mode === 'error') {
  process.stderr.write('fake swarm-memory: qdrant unreachable: connection refused\n');
  process.exit(1);
} else if (mode === 'bad-json') {
  process.stdout.write('not valid json{{{');
  process.exit(0);
} else if (mode === 'empty') {
  process.stdout.write(
    JSON.stringify({
      query,
      total_hits: 0,
      scopes: [
        {
          scope: 'project',
          collection: 'test_collection',
          fallback_used: false,
          below_floor: 0,
          error: '',
          hits: [],
        },
      ],
    }),
  );
  process.exit(0);
} else {
  process.stdout.write(
    JSON.stringify({
      query,
      total_hits: 2,
      scopes: [
        {
          scope: 'project',
          collection: 'test_collection',
          fallback_used: false,
          below_floor: 0,
          error: '',
          hits: [
            {
              collection: 'test_collection',
              score: 0.87,
              match_type: 'semantic',
              location: '/repo/notes/one.md',
              full_path: '/repo/notes/one.md',
              source: 'one.md',
              repo: '',
              chunk_index: 0,
              chunk_span: [0, 0],
              text: 'first matching chunk',
              provenance: {
                source: 'one.md',
                full_path: '/repo/notes/one.md',
                chunk_index: 0,
                repo: '',
                collection: 'test_collection',
                indexed_at: '2026-08-01T00:00:00+00:00',
                content_sha256: 'deadbeef',
                embed_model: 'nomic-embed-text',
                query,
                embed_model_query: 'nomic-embed-text',
                retrieved_at: '2026-08-09T00:00:00+00:00',
                chunk_span: [0, 0],
                context_radius: 2,
              },
            },
            {
              collection: 'test_collection',
              score: 0.81,
              match_type: 'semantic',
              location: '/repo/notes/two.md',
              full_path: '/repo/notes/two.md',
              source: 'two.md',
              repo: '',
              chunk_index: 3,
              chunk_span: [3, 4],
              text: 'second matching chunk',
              provenance: {
                source: 'two.md',
                full_path: '/repo/notes/two.md',
                chunk_index: 3,
                repo: '',
                collection: 'test_collection',
                indexed_at: '2026-08-02T00:00:00+00:00',
                content_sha256: 'cafebabe',
                embed_model: 'nomic-embed-text',
                query,
                embed_model_query: 'nomic-embed-text',
                retrieved_at: '2026-08-09T00:00:01+00:00',
                chunk_span: [3, 4],
                context_radius: 2,
              },
            },
          ],
        },
      ],
    }),
  );
  process.exit(0);
}
