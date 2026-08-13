#!/usr/bin/env node
// fake-swarm-memory.mjs — test double for the `swarm-memory` CLI, used by
// VectorLayerAdapter tests to exercise recall()/remember() without a live
// Qdrant. Behavior is controlled by FAKE_SWARM_MEMORY_MODE:
//   hits      -> exit 0, one scope with two hits (default)
//   empty     -> exit 0, zero hits
//   error     -> exit 1, stderr message (e.g. Qdrant unreachable)
//   timeout   -> hang until killed by the caller's exec timeout
//   bad-json  -> exit 0, stdout is not valid JSON
//   graph-hits -> exit 0, code-graph impact hits
//   graph-empty -> exit 0, no code-graph impact hits
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

if (cmd !== 'recall') {
  process.stderr.write(`fake swarm-memory: unknown command ${cmd}\n`);
  process.exit(2);
}

if (mode === 'timeout') {
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
