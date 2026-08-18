# Horizontal plan — mnemosyne-persona-files

Maps every architectural layer this epic touches and the cross-layer dependencies between them.

## H1 — Agent-crawl layer (`skills/mnemosyne-persona-interview/crawl-context.mjs`)

New export `crawlExplicitFiles({ filePaths, repoRoot, parentRef, home })`, reusing `capExcerpt()`/`assembleSourceSummary()` unchanged. A hard file-count cap (default 10, `--max-files` overridable). Zero changes to `crawlBoundedContext()` itself — a genuinely separate, sibling function, not a parameterized rewrite (matches this repo's own established "structurally separate sibling, not a parameterized wrapper" convention, e.g. `persona-draft-writer.mjs` vs. `persona-writer.mjs`).

## H2 — CLI layer (`bin/mnemosyne-persona.mjs`)

New subcommand `draft propose-from-files --tier <t> --scope-id <id> [--repo <r>] --file <path> [--file <path> ...] [--max-files <n>]`. Builds the persona record + calls `crawlExplicitFiles()`, then spawns the SAME draft-propose write primitive `persona-draft-writer.mjs`'s `writeDraftPersonaViaCli()` already uses (or a direct equivalent inside `bin/mnemosyne-persona.mjs` matching its own existing `draft propose`'s internal call shape) — no new write path.

## H3 — HTTP/UI layer

- `ui/index.html`: `#persona-form` gains a real `<input type="file" multiple id="persona-attached-files">` field.
- `ui/app.js`: submit handler reads attached file(s) via `File.text()`, applies a client-side twin of `capExcerpt()`/`assembleSourceSummary()` (ported, unit-tested for parity against the Node original), folds the result into the existing JSON body POSTed to `POST /persona/draft/:tier/:scopeId` — zero new backend routes, riding the existing 4MB `readJsonBody()` cap.
- `isAgentProposedDraft()` and its 2 call sites (list-row snippet, detail-view provenance line): gains the third "includes attached source material" state per design-discussion.md OQ3.

## H4 — Regression/proof layer

A closing full-loop proof mirroring `pu-13`'s own precedent: agent-side `propose-from-files` → real draft visible via `GET /persona/draft` → real approve → real commit, AND a UI-side attach-file → propose → approve → real commit, both exercising the unchanged draft store/routes.

## Cross-cutting concerns

- **No new write path**: every direction terminates at the existing `POST /persona/draft/:tier/:scopeId` (HTTP) or the existing `draft propose`-shaped subprocess call (CLI) — enforced as an explicit acceptance criterion on every story below, not an assumption.
- **Cap parity**: the UI's client-side truncation twin must be provably identical to `capExcerpt()`/`assembleSourceSummary()`'s behavior for the same input — a direct parity test, not "looks about right."
