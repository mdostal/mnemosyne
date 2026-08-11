# Mnemosyne — Vision

Where the Memory god is, where it's going, and where it grows to.

The one-line trajectory:

> **From a live vector-recall backend → a unified, provenance-tracked memory API → a benchmarked, A/B-tested stack of multiple memory models spanning the full layered hierarchy.**

---

## ① Current — where it is today

**Phase 1 v1 is implemented and running.** This is no longer a scaffold — a
real service wraps the layer stack end to end:

- **`MnemosyneClient`** (`lib/mnemosyne/`) — the `recall()`/`remember()`
  library surface other Pantheon gods import, with code-graph, vector, and
  file layer adapters, layer escalation, and full provenance stamping.
- **Two running services** — `src/server.mjs` (`:8477`, wraps `swarm-memory`
  over Qdrant Cloud) and the `MnemosyneClient` HTTP API (`lib/mnemosyne/server.ts`,
  `:3141`, see [`docs/http-api.md`](./http-api.md)).
- **Agent-loop hooks** (`hooks/`) — `pre-recall` / `post-remember`, wired into
  Claude Code today, runner-neutral by design so Codex/Kimi/other runners can
  read the same canonical bundle.
- **Observability** (`src/observability/`) — structured `recall_start` /
  `layer_query` / `layer_degraded` / `recall_end` / `remember_start` /
  `remember_end` events plus `recall_duration_ms`, `remember_duration_ms`,
  and `layer_degraded_total` metrics — see [`docs/observability.md`](./observability.md).
- **Loud-failure + provenance contracts enforced** — a degraded/unavailable
  layer is flagged explicitly, never silently skipped; every hit carries the
  full 7-field provenance record.
- **A real test suite** — `npm test` runs bundle/inject/write-through/health-drift/
  code-graph/reindex/vector/http-api/review-auto-merge coverage plus a vitest
  contract suite; `npm run test:e2e` runs the Minerva-style end-to-end
  integration test.

What is still explicitly deferred (see [`docs/architecture.md`](./architecture.md)
for the current component/flow diagrams):

- The **meta layer** (Obsidian vault) and **enterprise** layer routing are
  contracted but not yet wired end-to-end — recall/remember today primarily
  exercise the code-graph/vector/file layers.
- **Continuous indexing** as a Multica-native scheduled job (indexing today
  runs via explicit `reindex` calls, not an always-on schedule).
- **Consus/Janus read model** — browsing layers and tracing provenance in the
  UI is not built yet.
- **Argus/Metis decision + metric ingestion** — observability emits the
  events and metrics locally; wiring them into Argus/Metis as the receiving
  god is next.

What's live and unifies underneath Mnemosyne, unchanged: remote **Qdrant
Cloud** vector memory via [`swarm-memory`](https://github.com/mdostal/swarm-memory)
(credential at `~/.config/swarm-memory/qdrant.key` — **do not wipe**), and the
hive's **Obsidian** knowledge vault as the intended meta layer.

---

## ② Goals — near-term next steps

1. **Meta + enterprise layer wiring.** Bring the Obsidian vault into the live
   escalation path as the top (meta) layer, and stand up the enterprise
   scope so cross-project standards/CBAs are recallable, not just
   project-local memory.
2. **Continuous indexing.** Move indexing off explicit `reindex` calls onto a
   Multica-native schedule (event- or interval-driven, no localized cron) so
   vector + code-graph + vault indexes stay fresh automatically.
3. **Argus/Metis integration.** Route every `recall`/`remember` decision +
   metric record to Argus/Metis, matching the pattern every other Pantheon
   god follows.
4. **Consus/Janus read model.** A minimal view that lets a human browse
   layers, trace a recall's provenance, and spot stale scopes.
5. **First multi-layer god integration, proven.** ≥1 other god (Minerva is
   the natural first) using the unified API across ≥3 layers, with recall
   shown to beat `find`/`grep` on token cost for a representative query set.

Near-term success signals: one recall/write API in use by ≥1 other god
spanning ≥3 layers; provenance on every hit (already true for the layers
that are wired); memory browsable in Consus/Janus with layer + freshness
visibility.

---

## ③ Long-term vision — where it grows to

**Multiple memory models, A/B-tested and solidified.** The layer slots are
pluggable by design (Qdrant default + swappable vector store; Obsidian
default + swappable meta store). The long game is to run **competing memory
backends head-to-head** — different vector stores, different embedders,
different graph/store strategies behind the *same* `recall`/`remember`
contract — measure them on the same query sets (recall quality, token cost,
latency, freshness), and **solidify the winners per slot**. Memory stops
being a single fixed engine and becomes a benchmarked marketplace of
interchangeable models.

**The full layered memory stack, first-class and coherent:**

```
meta → enterprise → project → code-graph → vector → file
```

Every layer continuously indexed, every recall escalating narrow↔broad with
merged, ranked, provenance-stamped hits — so "where is X?" has exactly one
answer, and "what breaks if I change this?" is a graph query, not a guess.

**Platform-wide direction (why the pluggability matters):** across the whole
Pantheon, everything is **swappable** — you can toggle any language, model,
plugin, or god on/off and **compare metrics at every step**. Mnemosyne is
memory's expression of that principle: the layer slots are ABI-swappable,
Vesta owns which backend fills each slot, and Argus/Metis capture the
decision + metric records so an A/B swap is a config change with a measured
before/after — not a rewrite.

Where it ends up: memory browsable and traceable in Consus/Janus (layers,
freshness, provenance, stale-scope detection), continuously indexed,
backend-benchmarked, and the obvious default retrieval path for every agent
in the swarm.

---

## Good first contributions

- **Meta-layer adapter** — wire the Obsidian vault into the layer router
  behind the existing layer-adapter interface (see `lib/mnemosyne/layers/`).
- **Enterprise-scope routing** — extend scope resolution so `enterprise`
  queries reach the right cross-project collection.
- **Continuous indexing** — replace explicit `reindex` invocation with a
  Multica-native scheduled trigger.
- **Argus/Metis emitter** — forward the existing observability events/metrics
  to Argus/Metis instead of (only) local structured logs.
- **Backend adapter interface** — sketch a second vector-backend driver
  behind the pluggable interface so Qdrant is *a* driver, not *the* driver
  (sets up the long-term A/B goal).
- **Docs & diagrams** — extend `docs/architecture.md`, or document the
  escalation semantics (narrow↔broad merge/rank) in more depth.

New here? Read [`idea-brief.md`](../idea-brief.md) first (the source-of-truth
design brief), then [`docs/architecture.md`](./architecture.md) for the
current component/flow diagrams. Work follows the Pantheon SDLC via
[plugin-hive](https://firefly-events.github.io/plugin-hive/); the host is
[pantheon-v2](https://github.com/mdostal/pantheon-v2).
