# Mnemosyne — the Memory god (idea brief)

> **Status: STAGED FOR MINERVA.** This is a brief, *not* a plan. It states the problem, the
> shape of the thing, the layers, and the constraints. Minerva turns it into an epic + stories.
> Do not hand-file tickets from this document.

## One line

**Mnemosyne is the Pantheon's memory god** — the single, unified layer that *writes and recalls*
across every memory scope the swarm has, so that "memory over find" becomes the default retrieval
path for every agent instead of grep/find. It **wraps and unifies existing memory infrastructure
we already run** (remote Qdrant Cloud vector memory + `swarm-memory`, plus the hive's Obsidian
knowledge vault) rather than reinventing them.

## Why now (the pain)

Memory is already a HUGE problem. We have real memory infrastructure — remote Qdrant Cloud, the
`swarm-memory` CLI, per-scope collections, a code/docs impact graph, an Obsidian knowledge vault
that is Consus's knowledge home, plus flat markdown auto-memory. But they are **separate, manually
wired, and un-unified**: no single god owns the layer stack, no one recall/write API spans them,
and agents fall back to `find`/`grep` because the memory path isn't the obvious one. Mnemosyne is
the god that **unifies the layers behind one contract** so recall is layered, escalating, and
provenance-tracked — and so "where the fuck is X?" has one answer.

## The layer stack (the heart of the brief)

Mnemosyne organizes memory as an **ordered, escalating layer stack**, meta → narrow. A recall
walks the layers (narrow first, or broad-first depending on query intent) and merges/ranks hits
with provenance; a write routes to the correct layer(s). Layers, top (meta) to bottom (raw):

1. **Meta / knowledge top-level — the hive's default Obsidian vault.** The human-curated,
   cross-project knowledge home (Consus's knowledge base ties here). This is the **top-level
   meta layer**: durable decisions, CBAs, approved docs, canonical truth. Markdown-native, the
   layer humans read and edit directly.
2. **Enterprise layer.** Cross-project org-wide knowledge and standards that aren't tied to one
   project (operating models, conventions, shared-truth KB promoted from approved CBAs).
3. **Project layer.** Per-project memory — the working knowledge, decisions, and context scoped
   to a single project/repo.
4. **Code-graph layer.** The code/docs **impact graph** — typed edges (`depends_on`, `cites`,
   `implements`) over files, docs, metrics; answers "what breaks if I change this?". Already
   prototyped in `swarm-memory` (SQLite-backed graph); Mnemosyne brings it in as a first-class
   layer and keeps it continuously indexed.
5. **Vector layer — Qdrant (default backend).** Semantic search over chunked content via **remote
   Qdrant Cloud** (our current vector memory; key at `~/.config/swarm-memory/qdrant.key` — do not
   wipe), embeddings + surrounding-context retrieval, scopes mapped to collections with an
   escalation ladder. This is the existing `swarm-memory` engine, adopted as Mnemosyne's default
   vector layer.
6. **File layer.** Raw file/grep fallback — the loud-failure floor so an agent never silently runs
   without memory; degrades to keyword search when higher layers are unreachable, flagged in output.

> The stack is **pluggable**: Qdrant is the *default* vector backend but the layer is swappable
> (any OpenAI-compatible embeddings / alternate vector store); Obsidian is the default meta store
> but the meta layer is a contract, not a hard dependency.

## What Mnemosyne exposes (capabilities, not a plan)

- **Unified recall API** — one `recall(query, scope, intent)` that walks the layer stack,
  escalates narrow→broad, merges + ranks, and returns hits **with provenance** (layer, source
  file/collection, chunk span, index timestamp, content hash, embedder, retrieval time).
- **Unified write/ingest API** — one `remember(content, scope, layer?)` that routes a write to the
  right layer(s) and keeps the vector + graph indexes coherent.
- **Continuous indexing** — keep Qdrant + the code-graph + the Obsidian vault indexes fresh as
  files/docs/decisions change (event- or schedule-driven; Multica-native scheduling, no box cron).
- **Memory-over-find enforcement** — recall is the obvious, cheap default; `find`/`grep` is the
  explicit fallback, and the file layer fails loud rather than silently returning nothing.
- **Viewable** — memory is inspectable in **Consus** (knowledge center) and **Janus** (portal/UI):
  browse layers, see what's indexed, trace a recall's provenance, spot stale/missing scopes.
- **Pluggable backends** — Qdrant default + swappable vector store; Obsidian default + swappable
  meta store; the layer stack is config, driven by Vesta.

## Build ON what exists (do not reinvent)

- **Qdrant Cloud + `swarm-memory`** (`~/Documents/work/dostal/code/swarm-memory`) — the existing
  vector engine (semantic search, scopes→collections, escalation ladder, code/docs impact graph,
  provenance, loud failure). Mnemosyne **adopts/wraps this as its vector + code-graph layers**,
  not a rewrite. Remote Qdrant Cloud key: `~/.config/swarm-memory/qdrant.key` (**do not wipe**).
- **The hive's default Obsidian vault** — Consus's knowledge home; Mnemosyne treats it as the
  **meta top-level layer** and indexes it into the vector layer for semantic recall while keeping
  it human-editable markdown.
- **Consus / Janus** — the surfaces memory is viewed through; Mnemosyne provides the read model.
- **Vesta** — owns config/paths/defaults for which backend fills each layer slot.

## Fit with the Pantheon (capability-slot model)

Mnemosyne fills the **memory capability slot** — one god per capability, ABI-swappable, owns its
own memory, runs standalone, standard interface. It is a **library/service** other gods call for
recall/write; it is not an orchestrator and does not plan or route. Every recall/write **logs a
decision/metric record** (Argus/Metis) like every other god.

## Constraints / non-goals

- **Not** a new vector DB, **not** a new embedder — it unifies what we run.
- **Do not wipe** existing Qdrant collections or the Obsidian vault; Mnemosyne is additive.
- Multica-native scheduling only for continuous indexing (no localized cron/shell daemon).
- Loud failure is a hard requirement: never silently run without memory.

## Success signals (for Minerva to turn into metric blocks)

- One recall/write API in use by ≥1 other god, spanning ≥3 layers.
- Obsidian meta vault + Qdrant + code-graph all continuously indexed and queryable through one call.
- Provenance on every hit; recall beats `find` on token cost for a representative query set.
- Memory browsable in Consus/Janus with layer + freshness visibility.

## References (existing setup this builds on)

- `swarm-memory` repo — Qdrant-backed semantic memory, code/docs impact graph, scopes + escalation.
- `~/.config/swarm-memory/qdrant.key` — remote Qdrant Cloud credential (do not wipe).
- Hive default Obsidian vault — Consus knowledge home / meta top-level layer.
- Memory-layers architecture (Pantheon memory design): meta → enterprise → project → code-graph →
  qdrant(vector) → file, with a cross-level recall/escalation CBA owed.
