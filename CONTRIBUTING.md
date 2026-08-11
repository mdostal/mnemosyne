# Contributing to Mnemosyne

Mnemosyne is the Pantheon's memory god — thanks for considering a contribution.
This doc covers setup, the test loop, and how a PR gets reviewed.

## Setup

```bash
gh repo clone mdostal/mnemosyne
cd mnemosyne
npm install
```

Node `>=20` is required (`engines` in `package.json`). No other runtime
dependencies to install — Mnemosyne wraps the existing `swarm-memory` /
Qdrant Cloud engine rather than standing up its own store.

## Tests

```bash
npm test              # full suite: bundle, inject, write-through, health-drift,
                       # code-graph, reindex, vector, http-api, + vitest contracts
npm run test:e2e       # Minerva-style end-to-end integration test
npm run typecheck      # tsc --noEmit
```

Most of the suite runs against a temporary fake `swarm-memory` executable, so
it does not require live Qdrant access. See [`README.md`](./README.md#tests)
and [`docs/architecture.md`](./docs/architecture.md) for what each layer/test
exercises.

## Making a change

1. Open an issue or pick up an existing one before starting non-trivial work —
   it avoids duplicated effort and lines up the change with the layer-stack
   contract (see [`docs/architecture.md`](./docs/architecture.md)).
2. Branch off `dev` (build lanes integrate into `dev`, not `main`).
3. Keep commits feature-scoped (see `hive.config.yaml` — `commit_granularity:
   feature-scoped`) and follow TDD where the change touches `recall`/`remember`
   behavior.
4. Respect the cross-cutting contracts in `.pHive/cross-cutting-concerns.yaml`:
   - **Loud failure** — a degraded/unavailable layer must be flagged explicitly
     in the response and provenance, never silently skipped.
   - **Provenance completeness** — every recall hit carries the full 7-field
     provenance record.
   - **Build on what exists** — never wipe or reorganize the live Qdrant
     collections, `swarm-memory` state, or the Obsidian vault.
5. Update docs alongside behavior changes (README, `docs/`, and any affected
   `docs/*.md` reference).
6. Open a PR against `dev`. CI (`.github/workflows/ci.yml`) runs install,
   build, and the full test suite on every PR.

## Reporting bugs / requesting features

Open a GitHub issue with repro steps (for bugs) or the problem you're trying
to solve (for features). If you're unsure whether something fits Mnemosyne's
scope, check [`docs/vision.md`](./docs/vision.md) — it lays out what's in
scope now, next, and long-term.

## Code of conduct

Be respectful and constructive. Assume good faith, keep discussion focused on
the technical merits of a change, and give reviewers the context they need to
evaluate it quickly.
