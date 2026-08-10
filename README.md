# mnemosyne

**Mnemosyne** — the Pantheon's **Memory god** (Greek titaness of memory).

The single, unified layer that **writes and recalls across every memory scope the swarm has** —
so *memory over find* is the default retrieval path, not grep. It **unifies memory infrastructure
we already run** (remote Qdrant Cloud vector memory + [`swarm-memory`](https://github.com/mdostal/swarm-memory),
plus the hive's Obsidian knowledge vault) behind one contract — it does not reinvent them.

## The layer stack

```
meta (hive Obsidian vault — Consus knowledge home / top-level)
  → enterprise (org-wide knowledge + standards)
    → project (per-project working memory)
      → code-graph (typed impact graph: depends_on / cites / implements)
        → vector (Qdrant Cloud — default backend, semantic recall)
          → file (raw grep — loud-failure floor)
```

A recall walks the stack (narrow→broad, escalating) and returns ranked hits **with provenance**.
A write routes to the right layer(s) and keeps the indexes coherent. Backends are **pluggable**
(Qdrant default + swappable; Obsidian default meta store + swappable).

## Status

**Phase 1 v1 is implemented.** The service wraps the existing `swarm-memory`
engine, and `hooks/` contains the runner-agnostic pre-recall/post-remember loop:
small per-repo + shared memory bundles before a ticket, status-aware write-back
after a run, and a cache-safe prompt layout that keeps the stable prefix
separate from the variable ticket memory delta.

## Install hooks

`bin/mnemosyne-install-hooks` auto-wires `hooks/settings.hooks.json` into a
Claude Code `settings.json` — see [`hooks/README.md`](./hooks/README.md#install-the-hooks)
for usage.

## Tests

Run the Minerva-style end-to-end integration test with:

```bash
npm run test:e2e
```

The test imports `MnemosyneClient`, recalls `authentication flow` from the
project scope, verifies vector provenance, forces vector degradation to confirm
file-layer fallback, starts the client HTTP API, and checks that `POST /recall`
matches the library result. It uses a temporary fake `swarm-memory` executable,
so it does not require live Qdrant access.

## Read next

- **[`idea-brief.md`](./idea-brief.md)** — the full brief: the layer stack, the unified recall/write
  API, memory-over-find, continuous indexing, viewable in Consus/Janus, pluggable backends, and how
  it builds on the existing Qdrant + Obsidian setup.
- **[`hooks/README.md`](./hooks/README.md)** — the v1 hook contract, prompt-cache layout, runner-neutral
  bundle shape, env knobs, and proof commands.
- `hive.config.yaml` — Hive workflow config for headless planning.
