# Vertical plan — mnemosyne-persona-files

Minimum cross-stack increments, each leaving the product in a working state.

## Slice 1 — Agent-side explicit-file crawl + CLI verb (H1 + H2)

Delivers direction 1 end-to-end: `crawlExplicitFiles()` + `draft propose-from-files` CLI verb, producing a real, reviewable draft from explicit files via the unchanged draft store/routes. Independently useful and demoable on its own (an agent or operator can already create file-sourced drafts via CLI before any UI work lands).

Stories: pf-01 (crawlExplicitFiles), pf-02 (CLI verb), pf-03 (regression proof for slice 1).

## Slice 2 — UI-side file attachment (H3)

Delivers direction 2 end-to-end: file input in `#persona-form`, client-side cap-twin, folded into the existing draft-propose POST, `isAgentProposedDraft()`'s label extended. Independent of Slice 1 (different files, no shared runtime dependency), but sequenced second only because Slice 1's `capExcerpt()`/`assembleSourceSummary()` reuse is the reference implementation Slice 2's client-side twin must match — building the twin without the reference already re-verified fresh in this epic would risk drifting from it.

Stories: pf-04 (client-side cap-twin + parity test), pf-05 (file input + submit-handler wiring), pf-06 (isAgentProposedDraft label extension), pf-07 (regression proof for slice 2).

## Slice 3 — Closing full-loop regression (H4)

Both directions' complete real loops (propose-from-files → review → approve → commit; UI-attach → propose → review → approve → commit) in one continuous proof each, plus a full-suite regression pass, version bump, and release note — mirroring `pu-13`/`pu-15`'s own precedent.

Stories: pf-08 (full-loop e2e for both directions + full-suite regression + version bump + release note).

## Deferred (explicitly out of scope, not silently dropped)

- Non-text file formats (PDFs, images) — both directions assume plain-text-readable source files, matching `crawlBoundedContext()`'s own existing assumption (README/manifest/CLAUDE.md/AGENTS.md are all plain text). A future epic can add format conversion if a real need surfaces.
- A dedicated multipart/form-data upload route — Slice 2 deliberately rides the existing JSON-body POST + `readJsonBody()`'s 4MB cap rather than building new upload infrastructure, per design-discussion.md's own "scoped minimally" instruction.
