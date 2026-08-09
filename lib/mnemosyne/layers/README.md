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
