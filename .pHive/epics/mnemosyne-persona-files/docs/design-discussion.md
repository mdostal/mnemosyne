# Design discussion — mnemosyne-persona-files

## §0. Goal (verbatim operator ask)

"we need a way to create the personas with files and things as well at some point, so that may just be the agent installing, but we may also want some of that in the UI." Follow-up when asked which direction to build first: "Both, same priority."

Two directions, same priority, both reusing the existing draft store/routes/review-UI (pu-02/pu-03/pu-12) completely unchanged as the write/review surface:

1. **Agent-install-time creation from explicit files** — an agent (installing into a repo, or run on demand) can point at specific files (not just pu-07's fixed 5-source auto-crawl set) and use their content as a proposed draft's source material.
2. **UI-side file attachment** — an operator attaches file(s) directly through the Personas panel's existing create/edit form as part of proposing/editing a draft.

## §1. Proposed approach

### Direction 1 — `crawlExplicitFiles()`, a sibling to `crawlBoundedContext()`

New export in `crawl-context.mjs`: `crawlExplicitFiles({ filePaths, repoRoot, parentRef, home })`. Same return shape as `crawlBoundedContext()` (`{ sourceSummary, sourcesRead }`), same `capExcerpt()`/`assembleSourceSummary()` reuse, same parent-ref handling (the CLI-subprocess-only `displayName`/`scope` read) — the only difference is the source list is caller-supplied file paths instead of the fixed 5-source list. Caps stay identical (`MAX_LINES_PER_SOURCE`/`MAX_CHARS_PER_SOURCE`/`MAX_SOURCE_SUMMARY_CHARS`), applied per-file exactly as today.

New CLI verb: `mnemosyne persona draft propose-from-files --file <path> [--file <path> ...] --tier <tier> --scope-id <id> [--repo <repo>]` on `bin/mnemosyne-persona.mjs`, sibling to the existing `draft propose --file <candidate.yaml>` (note: existing `--file` means "the whole candidate as YAML" — the new verb's `--file` flags mean "a source file to crawl," a real naming collision risk, resolved below in Open Questions). Builds the persona record (`displayName`/`scope`/`sections` — same minimal shape the interview skill produces) plus `crawlExplicitFiles()`'s `sourceSummary`, then calls the SAME `writeDraftPersonaViaCli()`-shaped subprocess spawn already proven in `persona-draft-writer.mjs` — no new write primitive.

Bound on file count: a hard cap (default 10 files, matching pu-07's "without overdoing it" mandate applied to an explicit list instead of an implicit crawl) — resolved in Open Questions below rather than picked silently.

### Direction 2 — UI file attachment

`#persona-form` (ui/index.html) gains a real `<input type="file" multiple>` field. On submit, `ui/app.js`'s existing handler reads each selected file's text content client-side (`File.text()`, no new backend upload route), applies the SAME `capExcerpt()`-equivalent truncation logic (ported to a small client-side JS twin — file caps must be enforced before the content ever leaves the browser, not trusted to a server-side re-check alone, though the server's existing 4MB `readJsonBody()` ceiling remains the hard backstop), and folds the result into the JSON body already POSTed to `POST /persona/draft/:tier/:scopeId` as an addition to (not replacement of) whatever `sourceSummary` the form's existing fields imply. A human-typed draft with attached files therefore CAN carry a real `sourceSummary` for the first time (today, per `isAgentProposedDraft()`, only agent-proposed drafts carry one) — this is a deliberate, positive side effect: attaching files is itself a form of "showing your work," so `isAgentProposedDraft()`'s labeling logic needs a look (see Open Questions) since it currently keys on `proposedBy === 'agent'`-style provenance, not on "does this have a real sourceSummary."

## §2. Risks

- **Second, divergent truncation implementation** (client-side JS twin of `capExcerpt()`) could disagree with the server/CLI-side Node implementation, producing two different size-cap behaviors for what should be one honest guarantee. Mitigation: port the exact same algorithm (line-cap then char-cap), covered by a direct unit-parity test comparing both implementations against the same fixture input.
- **`isAgentProposedDraft()`'s label could become misleading** once human-typed-with-attached-files drafts can also carry a real `sourceSummary` — the label says "agent-proposed," but a human who attached files is not an agent. Needs an explicit decision (Open Questions).
- **File-count/size sprawl** on both directions could quietly turn "bounded, honest crawl" into "silently massive drop-in," defeating the whole `agent-provenance-trust` discipline this epic's own predecessor (`mnemosyne-persona-ux`) was built around. Both directions need hard, enforced (not just documented) caps.

## §3. Dependencies

- pu-02 (draft store), pu-03 (draft routes), pu-07 (`crawl-context.mjs`'s `capExcerpt`/`assembleSourceSummary`), pu-08 (`persona-draft-writer.mjs`), pu-12 (draft review/approve UI) — all already shipped in `mnemosyne-persona-ux` v0.10.0 (main, tagged). This epic extends, never modifies, their existing behavior.

## §4. Open questions (resolved here, not deferred)

**OQ1 — CLI flag naming collision.** `draft propose --file <candidate.yaml>` already uses `--file` for "the whole candidate." Resolution: the new verb is a genuinely separate subcommand (`draft propose-from-files`, not a flag variant of `draft propose`), so its own `--file` (repeatable, meaning "a source file to crawl") does not collide — different subcommands are free to reuse a flag name for a locally-scoped meaning, matching this CLI's existing convention (e.g. `create`'s `--root` vs. `draft propose`'s absence of `--root`, already an established per-subcommand flag-shape precedent in `bin/mnemosyne-persona.mjs`).

**OQ2 — explicit-file-list cap.** Default cap: 10 files per `propose-from-files` call. Rationale: matches order-of-magnitude with pu-07's own 5-source fixed list (roughly 2x, since an explicit list is operator-directed rather than auto-selected, warranting slightly more headroom) while staying a real, enforced ceiling rather than "as many as you want." Configurable only via an explicit `--max-files` override for a script/CI context that has already decided it needs more, never silently unbounded.

**OQ3 — `isAgentProposedDraft()`'s labeling.** Resolution: introduce a new, distinct label state rather than overloading "agent-proposed." A draft's detail view shows one of three states going forward: no `sourceSummary` → "Manually created" (unchanged); `sourceSummary` present AND `proposedBy === 'agent'` → "Agent-proposed" (unchanged); `sourceSummary` present AND `proposedBy` is absent/human → "Includes attached source material" (new). This keeps "agent-proposed" honestly meaning what it already means (an agent proposed this) while still surfacing that real material informed a human-typed draft — never conflating the two.

## §5. Scale assessment

**Medium.** Multi-file (crawl-context.mjs extension, a new CLI subcommand, a new UI file input + client-side cap logic, a labeling change in `isAgentProposedDraft()`'s consumers), multiple layers (agent/CLI layer + UI layer), cross-stack — needs horizontal/vertical planning to slice correctly, same class of work as the persona-ux epic's own pu-07/pu-08 pairing, but does not warrant a full structured-outline (large-scope) pass: no new persistence layer, no new backend write route, no new architectural decision beyond OQ1-3 above.
