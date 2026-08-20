# Mnemosyne

[![CI](https://github.com/mdostal/mnemosyne/actions/workflows/ci.yml/badge.svg)](https://github.com/mdostal/mnemosyne/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-e0a72e.svg)](./LICENSE)
[![Pantheon](https://img.shields.io/badge/pantheon-memory%20god-1c1814.svg)](https://github.com/mdostal/pantheon-v2)
[![Docs](https://img.shields.io/badge/docs-mdostal.github.io%2Fmnemosyne-e0a72e.svg)](https://mdostal.github.io/mnemosyne/)

**The Pantheon's Memory god** — one unified layer that *writes and recalls* across every memory scope the swarm has, so **"memory over find"** becomes the default retrieval path for every agent instead of `grep`/`find`.

Named for the Greek titaness of memory. Site + diagrams: **[mdostal.github.io/mnemosyne](https://mdostal.github.io/mnemosyne/)**.

## What & why

The swarm already runs real memory infrastructure — remote **Qdrant Cloud** vector memory (via [`swarm-memory`](https://github.com/mdostal/swarm-memory)), a code/docs impact graph, and the hive's **Obsidian** knowledge vault (Consus's knowledge home). The problem is that these are **separate, manually wired, and un-unified**: no single service owns the layer stack, no one `recall`/`remember` API spans them, and so agents fall back to `find`/`grep` because the memory path isn't the obvious one.

Mnemosyne exists as its own god so that **one service owns the memory contract** for the whole Pantheon. It **unifies infrastructure we already run** behind a single, escalating, provenance-tracked API — it does **not** reinvent the vector DB, the embedder, or the vault. Every other god calls Mnemosyne to remember and recall; Mnemosyne routes writes to the right layer and walks the stack on reads.

## The layer stack

Memory is organized as an ordered, escalating stack — meta (broad) to file (raw). A recall walks the layers and merges/ranks hits **with provenance**; a write routes to the correct layer(s) and keeps indexes coherent.

```
meta        (hive Obsidian vault — Consus knowledge home / canonical truth)
  → enterprise   (org-wide knowledge + standards, promoted from approved CBAs)
    → project    (per-project working memory, decisions, context)
      → graphify     (typed impact graph: depends_on / cites / implements — default; see below)
        → vector     (Qdrant Cloud — default backend, semantic recall)
          → file     (raw grep — loud-failure floor)
```

Backends are **pluggable**: Qdrant is the *default* vector backend but the slot is swappable (any OpenAI-compatible embeddings / alternate vector store); Obsidian is the default meta store but the meta layer is a contract, not a hard dependency. Slot config is owned by **Vesta**.

**Graph layer: [Graphify](https://github.com/Graphify-Labs/graphify) by
default, `code-graph` as a soft, automatic fallback.** A real A/B benchmark
against this repo found the older in-house `code-graph` layer's backing
store had **zero** nodes from this repo (it has no per-repo scoping), while
Graphify indexed 1470+ real nodes from this repo's own source, faster —
see `docs/layer-architecture-v2-plan.md` §7. `uv tool install graphifyy` is
**recommended, not required**: an unconfigured install with no `graphify`
binary on PATH automatically falls back to `code-graph` (with a logged
warning, never a hard failure), so a bare `npm install` still works. Both
layers stay registered and explicitly selectable via `MNEMOSYNE_LAYERS` —
this only changes the *unconfigured* default, never how configuration
itself works (see `SERVICE.md`'s "Graph" section for the full gating
rules).

## Architecture

```mermaid
flowchart TB
  subgraph pantheon["Pantheon gods (callers)"]
    minerva["Minerva<br/>planner"]
    argus["Argus<br/>metrics"]
    swarm["swarm agents"]
  end

  subgraph mnemosyne["Mnemosyne — memory god"]
    api["recall(query, scope, intent)<br/>remember(content, scope, layer?)"]
    router["layer router + escalation<br/>(narrow↔broad, merge + rank)"]
    prov["provenance stamping<br/>(7 fields per hit)"]
    idx["continuous indexing<br/>(Multica-native schedule)"]
    api --> router --> prov
  end

  subgraph layers["Layer stack (pluggable slots)"]
    meta["meta — Obsidian vault"]
    ent["enterprise"]
    proj["project"]
    cg["graphify (default)<br/>code-graph (soft fallback)"]
    vec["vector — Qdrant Cloud"]
    file["file — grep (loud floor)"]
  end

  minerva --> api
  argus --> api
  swarm --> api

  router --> meta
  router --> ent
  router --> proj
  router --> cg
  router --> vec
  router --> file

  idx -.keeps fresh.-> vec
  idx -.keeps fresh.-> cg
  idx -.keeps fresh.-> meta

  vec -->|wraps| sm[("swarm-memory<br/>+ Qdrant Cloud")]
  cg -->|wraps, if graphify unavailable| sm
  cg -->|or reads| gj[("graphify's own<br/>graph.json")]

  api -.decision + metric record.-> argus

  consus["Consus / Janus<br/>(read model: browse layers,<br/>trace provenance, spot stale scopes)"] --> api
```

Mnemosyne fills the **memory capability slot** in Pantheon: one god per capability, ABI-swappable, owns its own memory, runs standalone, standard interface. It is a **library/service** other gods call — it does not plan, orchestrate, or route work. Every recall/write logs a decision + metric record (to Argus/Metis) like every other god.

## How it fits

- **Host / framework:** [pantheon-v2](https://github.com/mdostal/pantheon-v2) — the core host that assembles gods behind shared contracts.
- **Substrate:** work is planned and executed on [Multica](https://github.com/firefly-events/multica) with the [plugin-hive](https://firefly-events.github.io/plugin-hive/) SDLC (kickoff → plan → execute → review → test → ship). Continuous indexing schedules are **Multica-native** (no localized cron).
- **Sibling gods it talks to:** **Minerva** (planner) and swarm agents are the primary recall callers; **Consus** / **Janus** provide the human read model (browse layers, trace a recall's provenance, spot stale scopes); **Vesta** owns which backend fills each layer slot; **Argus** / **Metis** receive the decision + metric records.
- **Builds on:** [`swarm-memory`](https://github.com/mdostal/swarm-memory) (Qdrant-backed semantic memory + code/docs impact graph) — adopted/wrapped as the vector layer, and (as a soft fallback) the `code-graph` layer, **not** rewritten. [`Graphify`](https://github.com/Graphify-Labs/graphify) is the default graph layer (see "The layer stack" above).

## Quickstart

```bash
curl -fsSL https://mdostal.github.io/mnemosyne/install.sh | bash
```

Clones this repo, `npm install`s it, and links `bin/mnemosyne` onto your
`PATH`. Prints (does not run) `mnemosyne agent init` as a separate next
step, which registers Mnemosyne as an MCP server with Claude Code / Codex
CLI and installs its usage skills — see `mnemosyne agent status` to preview
state first. Safe to re-run (updates the existing clone instead of
re-cloning).

Manual / dev-clone alternative:

```bash
gh repo clone mdostal/mnemosyne
cd mnemosyne
npm install
npm test
```

Embedding Mnemosyne as a product's own memory agent (not a Mnemosyne
developer's own harness)? `mnemosyne agent init --build` runs a first-time
index of your codebase (Layer 1 sync, persona seed, file/graph index) as
part of the same step — opt-in, off by default, like `agent init` itself;
add `--storage-dir <dir>` to pin all of its memory state under a directory
your own install tooling controls. See `docs/embedded-layers.json` for a
recommended `mnemosyne.layers.json` for a bare embedded install with no
`swarm-memory` credential configured.

Optional but recommended: `uv tool install graphifyy` — installs the
`graphify` CLI that backs the graph layer by default (see "The layer stack"
above). Not required: without it, the service and library both fall back to
the `code-graph` layer automatically, with a logged warning, never a hard
failure.

See `npm run` in `package.json` for the service entrypoint, and [`hooks/README.md`](./hooks/README.md) to wire the pre-recall/post-remember hooks into an agent runner.

To **ingest a document into memory** — plain text/Markdown, or a free-text description/CV pasted with no file at all — bounded, chunked, and fed through the same `remember()` cascade above: `bin/mnemosyne ingest --file <path.txt|.md>` (or `--text "..."`) from the CLI, the `ingest_document` MCP tool, or `POST /ingest` against the MnemosyneClient HTTP API (`bin/mnemosyne-client-api`, default port 3141). Oversized content or an unsupported format (anything outside `.txt`/`.md`) is rejected loudly before any write.

The underlying vector memory Mnemosyne wraps is **already live** — it runs today through `swarm-memory` against remote Qdrant Cloud (credential at `~/.config/swarm-memory/qdrant.key`; **do not wipe** existing collections or the Obsidian vault — Mnemosyne is additive).

## Onboard a repo into the tree (Mode A)

`bin/mnemosyne onboard <path> --collection <name> [--scope-id <id>] [--override project|enterprise]`
brings a repo online against an **already-existing** Qdrant collection and
places it in the operator-global org tree (`~/.mnemosyne/org-tree.yaml`):
a real, read-only Qdrant check confirms `<name>` actually exists (fails
loudly, naming `--create`/ro-07, if it doesn't — collection *creation* isn't
supported by this verb yet), the collection is classified project- vs.
enterprise-scoped via `mnemosyne.placement_engine.classify_collection`, and
the same `onboardRepo()` pipeline `agent init --build` uses (Layer 1 sync,
persona seed, file/graph index, base-level report) runs against `<path>`.
An ambiguous/unmarked collection name still completes the run — flagged
`needs_override: true` in the org-tree entry and printed clearly — pass
`--override project|enterprise` to set the scope explicitly instead of
accepting the heuristic's own default.

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

- **[`docs/architecture.md`](./docs/architecture.md)** — component + request-flow diagrams, the layer
  stack, and the two running services.
- **[`docs/vision.md`](./docs/vision.md)** — current state, near-term goals, and the long-term
  pluggable-backend / A-B-tested / metrics-driven vision.
- **[`idea-brief.md`](./idea-brief.md)** — the full brief: the layer stack, the unified recall/write
  API, memory-over-find, continuous indexing, viewable in Consus/Janus, pluggable backends, and how
  it builds on the existing Qdrant + Obsidian setup.
- **[`hooks/README.md`](./hooks/README.md)** — the v1 hook contract, prompt-cache layout, runner-neutral
  bundle shape, env knobs, and proof commands.
- `hive.config.yaml` — Hive workflow config for headless planning.

## Support

Mnemosyne is free and open source (MIT). If it saves your swarm tokens,
consider [sponsoring the work](https://github.com/sponsors/mdostal) or
contributing — see **[CONTRIBUTING.md](./CONTRIBUTING.md)**.
