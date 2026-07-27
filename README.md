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

**Concept — staged for Minerva planning.** The design lives in **[`idea-brief.md`](./idea-brief.md)**.
Minerva turns that brief into an epic + stories (`kickoff` + `plan`); execution follows via Auriga
+ the swarm. Do **not** hand-file tickets from the brief — Minerva plans it.

## Read next

- **[`idea-brief.md`](./idea-brief.md)** — the full brief: the layer stack, the unified recall/write
  API, memory-over-find, continuous indexing, viewable in Consus/Janus, pluggable backends, and how
  it builds on the existing Qdrant + Obsidian setup.
- `hive.config.yaml` — Hive workflow config for headless planning.
