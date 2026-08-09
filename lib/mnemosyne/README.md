# Mnemosyne Client Library

`MnemosyneClient` is the API surface Pantheon gods import to call
`recall()`/`remember()`. Gods depend on this module, not on Mnemosyne's HTTP
service directly.

```ts
import { MnemosyneClient } from 'mnemosyne/lib/mnemosyne/index.js';

const client = new MnemosyneClient({ rootDirectory: process.cwd() });

const result = await client.recall('provenance', 'project');
if (result.ok) {
  for (const hit of result.hits) {
    console.log(hit.provenance.source, hit.content);
  }
} else {
  console.error(`recall failed: ${result.error.message}`);
}

const written = await client.remember({ text: 'decision: use file layer first' }, 'project');
if (written.ok) {
  console.log('wrote to layer', written.layer);
}
```

## Behavior

- `recall(query, scope, intent?)` queries the vector layer (semantic recall
  via the `swarm-memory` CLI) first, then merges hits from the same source
  into chunk order. If the vector layer is unreachable, that failure is
  recorded in `layers_skipped` and the file layer serves the whole request
  (`degraded: true`). If the vector layer succeeds but finds nothing, the
  file layer is queried too and the result is marked `escalated: true`.
  Code-graph layer is added by a later story. An empty or whitespace-only
  `query` returns `RecallFailure` without touching any layer. Layer failures
  that leave no usable result (e.g. an unreachable file layer root directory)
  are returned as-is — never silently downgraded to an empty `hits: []`.
- `remember(content, scope, layer?)` is a stub for this story: it always
  succeeds and returns provenance for the resolved layer (`layer` if given,
  else `'file'`), but does not persist anything yet. The write path is a
  separate story.

See [`layers/README.md`](./layers/README.md) for the underlying
`FileLayerAdapter` provenance contract, and [`interfaces.ts`](./interfaces.ts)
for the full `RecallResult`/`RememberResult` type contracts.

Non-TypeScript consumers (CLI tools, non-TS agents) that cannot import this
module directly can reach it over HTTP instead — see
[`../../docs/http-api.md`](../../docs/http-api.md) for the `server.ts` wrapper.
