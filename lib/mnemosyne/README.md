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

- `recall(query, scope, intent?)` queries the file layer (the only layer
  wired up as of this story; vector and code-graph layers are added by later
  stories) and merges hits from the same source into chunk order. An empty
  or whitespace-only `query` returns `RecallFailure` without touching any
  layer. Layer failures (e.g. an unreachable root directory) are returned
  as-is — never silently downgraded to an empty `hits: []`.
- `remember(content, scope, layer?)` is a stub for this story: it always
  succeeds and returns provenance for the resolved layer (`layer` if given,
  else `'file'`), but does not persist anything yet. The write path is a
  separate story.

See [`layers/README.md`](./layers/README.md) for the underlying
`FileLayerAdapter` provenance contract, and [`interfaces.ts`](./interfaces.ts)
for the full `RecallResult`/`RememberResult` type contracts.
