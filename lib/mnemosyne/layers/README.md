# Mnemosyne Layer Adapters

Layer adapters implement the concrete backends behind Mnemosyne's recall
contract. Every adapter returns the shared `RecallResult` shape from
`lib/mnemosyne/interfaces.ts`, including loud failures and complete
provenance on every hit.

## File Layer

`FileLayerAdapter` is the raw filesystem search floor. It scans a target
directory directly with Node.js file I/O, so there is no indexing step, no
embedder, and no cached hash store.

For each matching line it returns:

- `provenance.layer = "file"`
- `provenance.source = <absolute file path>`
- `provenance.chunk_span.index = <1-based line number>`
- `provenance.index_timestamp = null`
- `provenance.content_hash = sha256(<line content>)`
- `provenance.embedder = null`
- `provenance.retrieval_time = <ISO 8601 search timestamp>`

If the target directory is missing, not a directory, or cannot be traversed, the
adapter returns `RecallFailure` instead of pretending there were zero hits.

## Vector Layer

`VectorLayerAdapter` wraps the `swarm-memory` CLI for semantic recall over
the Qdrant Cloud-backed corpus. It shells out to
`swarm-memory recall <query> --json` (never imports swarm-memory as a
library — the CLI is the stable contract between the two projects) and maps
each hit to Mnemosyne provenance:

- `provenance.layer = "vector"`
- `provenance.source = <swarm-memory full_path, falling back to location/source>`
- `provenance.chunk_span.index = <swarm-memory chunk_index>`, with
  `start`/`end` from swarm-memory's `chunk_span` tuple when present
- `provenance.index_timestamp = <swarm-memory provenance.indexed_at>`
- `provenance.content_hash = <swarm-memory provenance.content_sha256>`
- `provenance.embedder = <swarm-memory provenance.embed_model>`
- `provenance.retrieval_time = <swarm-memory provenance.retrieved_at>`

The shell exec has a 5-second timeout (Qdrant Cloud can be slow). If
swarm-memory is not installed, times out, exits non-zero, or returns output
that cannot be parsed as JSON, the adapter returns `RecallFailure` — never a
silent empty-hits result. The binary to invoke defaults to `swarm-memory`
resolved from `PATH`, overridable via the `SWARM_MEMORY_BIN` environment
variable or the adapter's `command` constructor option (the latter is what
tests use to point at a fixture double instead of a live Qdrant).

## Code-Graph Layer

`CodeGraphLayerAdapter` answers "what breaks if I change this?" with
swarm-memory's typed impact graph. It shells out to:

```text
swarm-memory graph impact <node> --json
```

The graph command walks reverse impact edges, so a query for `src/core.ts`
returns files/modules that depend on it through edges such as `depends_on`,
`cites`, and `implements`. Each hit is unranked structural provenance:

- `provenance.layer = "code-graph"`
- `provenance.source = <affected graph node/file>`
- `provenance.chunk_span = null`
- `provenance.index_timestamp = null` for CLI hits, or the edge `created_at`
  timestamp for SQLite fallback hits
- `provenance.content_hash = null`
- `provenance.embedder = null`
- `provenance.retrieval_time = <ISO 8601 search timestamp>`

If the graph CLI is unavailable, times out, exits non-zero, or returns
malformed JSON, the adapter opens the swarm-memory SQLite graph read-only and
walks `edges.dst -> edges.src` directly. The SQLite path defaults to
`SWARM_MEMORY_GRAPH_DB`, `~/.local/share/swarm-memory/graph.sqlite`, then the
older `~/.config/swarm-memory/graph.*` paths; tests can pass `dbPath`
explicitly.

`MnemosyneClient` queries the code-graph layer first. If it returns hits,
those structural impact hits serve the request. If code-graph has zero hits,
the client falls through to vector recall and then the file layer. A layer
failure is recorded as a skipped layer and the eventual result is marked
`degraded: true`; a vector success with zero hits still escalates to the file
layer (`escalated: true`).
