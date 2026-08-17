# Research brief — mnemosyne-persona-files

## What already exists (confirmed by direct read, this pass)

**The bounded auto-crawl (pu-07, `skills/mnemosyne-persona-interview/crawl-context.mjs`)** is a FIXED, NAMED, capped source list — never a directory scan or glob:
1. Repo README (`README_CANDIDATES`, first match wins)
2. Package/project manifest (`MANIFEST_CANDIDATES`, first match wins)
3. `CLAUDE.md`, if present
4. `AGENTS.md`, if present
5. The applicable parent persona's own `displayName`/`scope` summary (via a real `mnemosyne persona show` CLI subprocess — never that parent's full `sections` content)

Caps (all enforced in code, not just documented): `MAX_LINES_PER_SOURCE = 40`, `MAX_CHARS_PER_SOURCE = 1200` (per source, applied after the line cap), `MAX_SOURCE_SUMMARY_CHARS = 4000` (on the assembled summary as a whole, applied last). `capExcerpt()` and `assembleSourceSummary()` are the two functions that enforce these — reusable, not to be reimplemented.

`crawlBoundedContext({ repoRoot, parentRef, home })` returns `{ sourceSummary, sourcesRead }`. This is exactly what `skills/mnemosyne-persona-interview/persona-draft-writer.mjs`'s `writeDraftPersonaViaCli()` attaches to a proposed draft as `sourceSummary` (via `mnemosyne persona draft propose`, pu-08's default write path).

**The draft store/routes/review UI (pu-02/pu-03/pu-12), completely unchanged target:**
- `lib/mnemosyne/layer1/persona-draft-store.ts` — home-rooted (`~/.mnemosyne/persona-drafts`), `{tier, scopeId}`-addressed, archive-by-move disposal.
- `lib/mnemosyne/server.ts`'s `/persona/draft/*` routes: `GET /persona/draft` (list), `GET /persona/draft/:tier/:scopeId` (read), `POST /persona/draft/:tier/:scopeId` (propose/overwrite), `POST /persona/draft/:tier/:scopeId/approve`, `DELETE /persona/draft/:tier/:scopeId` (discard). `readJsonBody()` (server.ts:304) already caps request bodies at 4MB (`buf.length > 4 * 1024 * 1024` → `payload_too_large`) — a real, already-enforced ceiling any new JSON-body-carried file content rides on for free, no new size-limit code needed.
- `ui/index.html`'s `#persona-form` (retargeted by pu-12) + `ui/app.js`'s `personaForm.addEventListener("submit", ...)` handler (~line 2051) — POSTs to `POST /persona/draft/:tier/:scopeId`, builds a `candidate` object with `tier/scopeId/displayName/scope/sections/repo?`. This is the exact submit path a UI file-attachment affordance extends.
- `isAgentProposedDraft(draft)` (ui/app.js) — `typeof draft.sourceSummary === "string" && draft.sourceSummary.trim() !== ""`. Any new file-derived sourceSummary content flows through this same honest-provenance gate automatically; no new gating logic needed.

**CLI/skill-harness/MCP draft-propose surfaces (pu-04/pu-05):** `mnemosyne persona draft propose --file <path> [--repo <repo>]` (`bin/mnemosyne-persona.mjs`), plus skill-harness action (`personaDraftProposeAction`) and MCP tool (`persona_draft_propose`) wraps — all pure pass-throughs to the same draft store, no separate write path.

## What's genuinely new here

Nothing above lets an operator or an installing agent point at ARBITRARY, EXPLICITLY-CHOSEN files (not the fixed 5-source auto-crawl list, not a whole-repo scan) and have their content become part of a proposed draft's `sourceSummary`. Two surfaces need this:

1. **Agent-side**: a sibling function to `crawlBoundedContext()` that accepts an explicit list of file paths instead of (or alongside) the fixed auto-crawl sources, reusing `capExcerpt()`/`assembleSourceSummary()` unchanged so the same caps and truncation-marker behavior apply uniformly regardless of which crawl produced the summary.
2. **UI-side**: `#persona-form` has no file input at all today (7 text/select fields only, `ui/index.html` ~line 321-357). Needs a real `<input type="file">` (or multiple), the selected file(s)' content read client-side (`FileReader`/`File.text()`) and folded into the JSON body the existing submit handler already POSTs — no new multipart endpoint, no new backend upload mechanism, riding the existing `readJsonBody()` 4MB cap.

## Constraints confirmed from existing convention

- Never a second write path — every direction here terminates at the SAME `POST /persona/draft/:tier/:scopeId` (or the CLI's `draft propose --file`) call the existing infrastructure already uses.
- `sourceSummary` must stay honest — whichever crawl mechanism produced it (fixed auto-crawl, explicit file list, UI upload), a human reviewer must be able to tell what real material informed the proposal. No fabrication, no silent omission (matches `agent-provenance-trust` guarantee already enforced by `isAgentProposedDraft()`).
- Reuse `capExcerpt()`/`assembleSourceSummary()` for size discipline — a second, divergent truncation implementation would risk disagreeing with the already-tested behavior.
