# Mnemosyne Domain Glossary

> **Status:** Scaffold — populate as the project's vocabulary stabilizes.
> See `hive/references/context-md-schema.md` for content rules.

## Terminology

- **Layer stack**: The ordered memory hierarchy (meta → enterprise → project → code-graph → vector → file)
- **Recall**: Query operation that walks the layer stack and returns hits with provenance
- **Provenance**: Metadata tracking the source layer, file, chunk, timestamp, and retrieval path
- **Escalation**: Walking from narrow to broad layers when initial layer returns no hits
- **Qdrant**: Vector database backend (remote Qdrant Cloud) for semantic search
- **swarm-memory**: Existing CLI/library wrapping Qdrant and code-graph operations
- **Obsidian vault**: Markdown-native knowledge base serving as meta top-level layer
- **Code-graph**: Impact graph with typed edges (depends_on, cites, implements)
- **Loud failure**: Hard requirement — never silently run without memory; flag degraded state

## Key Paths

- `~/.config/swarm-memory/qdrant.key` — Remote Qdrant Cloud credential (do not wipe)
- `~/Documents/work/dostal/code/swarm-memory` — Existing vector engine repo
- `~/.claude/hive/kg.sqlite` — Knowledge graph SQLite database
- `.pHive/` — Project-local Hive state directory

## Conventions

- **Pantheon capability-slot model**: One god per capability, ABI-swappable, standard interface
- **Multica-native scheduling**: Use Multica for continuous indexing, not localized cron
- **Unified API surface**: Single `recall()` and `remember()` entry points for all layers
- **Provenance-first**: Every hit includes layer, source, hash, embedder, timestamp

## Canonical References

- Idea brief: Command args provided during kickoff
- Memory-layers architecture: Meta → enterprise → project → code-graph → qdrant(vector) → file
- swarm-memory repo: Existing implementation to adopt, not rewrite
