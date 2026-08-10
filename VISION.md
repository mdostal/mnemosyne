# Mnemosyne — Vision

Where the Memory god is, where it's going, and where it grows to. Contributors can pick a rung and jump in.

The one-line trajectory:

> **From a live vector-recall backend → a unified, provenance-tracked memory API → a benchmarked, A/B-tested stack of multiple memory models spanning the full layered hierarchy.**

---

## ① Current — where it is today

**Honest status: scaffold / planning stage.** This repo owns the *contract and the plan*, not yet a running service.

What actually exists in this repo right now:

- **`idea-brief.md`** — the full design brief (the layer stack, the unified recall/write API, memory-over-find, continuous indexing, pluggable backends, the "build on what exists" constraints).
- **A Minerva-planned epic** — `.pHive/epics/mnemosyne-foundation/` with **7 pending stories** (`m-01` … `m-07`), a planning-team roster, and cross-cutting concerns (provenance-completeness, loud-failure, documentation).
- **Hive workflow config** (`hive.config.yaml`) — TDD discipline, feature-scoped commits.

What does **not** exist yet, stated plainly:

- **No source code.** Runtime is undecided (TypeScript *or* Python per `m-01`).
- **No running service, no HTTP endpoint, no port, no `recall`/`remember` binary.**
- No tests, no CI.

What **is** live — and what Mnemosyne will wrap, not replace:

- **Remote Qdrant Cloud** vector memory, driven today by [`swarm-memory`](https://github.com/mdostal/swarm-memory): semantic search, scopes→collections, an escalation ladder, a code/docs impact graph, and provenance. This is in the swarm's live recall path today (with a `grep`/`find` fallback). Credential: `~/.config/swarm-memory/qdrant.key` — **do not wipe.**
- **The hive's Obsidian vault** — Consus's knowledge home, the intended meta / top-level layer, human-editable markdown.

So: the *substrate is real and running*; Mnemosyne is the god that will **unify it behind one contract**. That unification is what the epic below builds.

---

## ② Goals — near-term next steps

Roughly the order of the planned stories:

1. **`m-01` — Core contract.** Nail down `recall(query, scope, intent)` and `remember(content, scope, layer?)`, the mandatory 7-field provenance schema (`layer, source, chunk_span, index_timestamp, content_hash, embedder, retrieval_time`), and the Scope / Intent / Layer enums. Pick the runtime.
2. **`m-02` — File layer + loud failure.** The raw `grep` floor that **fails loud** — an agent never silently runs without memory.
3. **`m-03` — Vector layer.** Wrap `swarm-memory` / Qdrant as the default semantic layer behind the unified API.
4. **`m-04` — Code-graph layer.** Bring the typed impact graph (`depends_on` / `cites` / `implements`) in as a first-class layer.
5. **`m-05` — Project / enterprise / meta layers.** Wire the Obsidian meta vault and the project/enterprise scopes into the stack.
6. **`m-06` — Continuous indexing.** Keep vector + code-graph + vault indexes fresh, **Multica-native** (event- or schedule-driven, no box cron).
7. **`m-07` — First god integration.** Prove it: one other god (Minerva) uses the unified API spanning ≥3 layers, and recall beats `find` on token cost for a representative query set.

Near-term success signals (for Minerva to turn into metric blocks): one recall/write API in use by ≥1 other god spanning ≥3 layers; provenance on every hit; memory browsable in Consus/Janus with layer + freshness visibility.

Two capabilities called out explicitly from the seeded direction:

- **Wire write-back** — `remember()` routing writes to the right layer(s) and keeping the vector + graph indexes coherent (today the live path is read-heavy).
- **Continuous indexing** — the always-fresh guarantee (`m-06`).

---

## ③ Long-term vision — where it grows to

**Multiple memory models, A/B-tested and solidified.** The layer slots are pluggable by design (Qdrant default + swappable vector store; Obsidian default + swappable meta store). The long game is to run **competing memory backends head-to-head** — different vector stores, different embedders, different graph/store strategies behind the *same* `recall`/`remember` contract — measure them on the same query sets (recall quality, token cost, latency, freshness), and **solidify the winners per slot**. Memory stops being a single fixed engine and becomes a benchmarked marketplace of interchangeable models.

**The full layered memory stack, first-class and coherent:**

```
meta → enterprise → project → code-graph → vector → file
```

Every layer continuously indexed, every recall escalating narrow↔broad with merged, ranked, provenance-stamped hits — so "where the hell is X?" has exactly one answer, and "what breaks if I change this?" is a graph query, not a guess.

**Platform-wide direction (why the pluggability matters):** across the whole Pantheon, everything is **swappable** — you can toggle any language, model, plugin, or god on/off and **compare metrics at every step**. Mnemosyne is memory's expression of that principle: the layer slots are ABI-swappable, Vesta owns which backend fills each slot, and Argus/Metis capture the decision + metric records so an A/B swap is a config change with a measured before/after — not a rewrite.

Where it ends up: memory browsable and traceable in Consus/Janus (layers, freshness, provenance, stale-scope detection), continuously indexed, backend-benchmarked, and the obvious default retrieval path for every agent in the swarm.

---

## Good first contributions

Pick a rung — the scaffold stage means groundwork contributions are high-leverage:

- **Sharpen the contract** — review `m-01` and propose the concrete `recall`/`remember` type signatures + provenance JSON schema (a draft `interfaces` + `schema` file is a great first PR).
- **Loud-failure file layer** (`m-02`) — the `grep` floor that returns a `success/failure` discriminator, never a silent `null`.
- **Runtime decision doc** — a short CBA: TypeScript vs. Python for the service, given it wraps `swarm-memory` and is called by other gods.
- **Backend adapter interface** — sketch the pluggable vector-backend interface so Qdrant is *a* driver, not *the* driver (sets up the long-term A/B goal).
- **Provenance viewer stub** — a minimal read-model shape Consus/Janus could render (layers, freshness, per-hit provenance).
- **Docs & diagrams** — extend the architecture diagram, or document the escalation semantics (narrow↔broad merge/rank) as a reference doc.

New here? Read **[`idea-brief.md`](./idea-brief.md)** first (the source of truth), then the epic at `.pHive/epics/mnemosyne-foundation/`. Work follows the Pantheon SDLC via [plugin-hive](https://firefly-events.github.io/plugin-hive/); the host is [pantheon-v2](https://github.com/mdostal/pantheon-v2).
