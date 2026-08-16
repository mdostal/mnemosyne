# Design-fidelity review — pu-14

**Reviews:** the shipped Personas panel (`ui/index.html`, `ui/app.js`,
`ui/style.css`, as they exist on this branch after pu-10/pu-11/pu-12) against
pu-01's chosen synthesized option: `.pHive/design/mnemosyne-persona-ux/synthesized/option-2.md`
("Trust-Gated Unified Queue"), selected in `.pHive/design/mnemosyne-persona-ux/selection.md`.

**Method:** read `selection.md` and `synthesized/option-2.md` in full, all 7
original critiques (`accessibility.md`, `agent-provenance-trust.md`,
`design-language-consistency.md`, `hierarchy-legibility.md`,
`information-density.md`, `onboarding-clarity.md`, `operator-efficiency.md`)
in full, and `ui/index.html` / `ui/app.js` / `ui/style.css` in full. Every
deviation below was verified against the actual DOM/JS/CSS on disk, not
inferred from the design brief or from ticket completion notes.

**Bottom line:** the shipped shell is substantially faithful to option 2 on
its structural/navigational/accessibility decisions — the single-panel
unified list, the read-before-edit trust gate (never a `disabled`
attribute), symmetric confirm-gating with the brief's exact quoted copy,
real `aria-live` announcements, and real focus management are all genuinely
present in the running code, not just claimed. But four deviations are
significant enough to flag rather than wave through: the panel's default
landing filter, the batch-approve mechanism the synthesis itself calls "the
central bet" for reconciling trust and efficiency, the post-approval
provenance note that was a named reason option 2 beat option 3 on the
trust lens, and the fact that the "deciding factor" hierarchy-legibility fix
(repo-scoped `code-architect` handling) is currently unreachable by any code
path in the shipped UI. See dispositions below.

**Deviation count:** 8 logged, all with an explicit disposition — 4
ACCEPTED, 4 FLAGGED. Zero left ambiguous.

---

## 1. Section-by-section comparison against `synthesized/option-2.md`

### §1 — Overall layout / navigation

| Brief decision | Shipped reality | Verdict |
|---|---|---|
| Single panel, single list, no tabs/route/modal; outer `<section class="panel panel-wide"> → <h2> → panel-status → <table>` shape unchanged | `#personas` is exactly this shape; grouping/detail rendering happens inside `#personas-tbody` (`ui/index.html` L285–297) | CONFIRMED MATCHING |
| `group by: Tier/Repo/Status` as a `.mode-toggle` radiogroup | `#personas-toolbar` uses `role="radiogroup"` with 3 radio `<label>`s, identical idiom to Search's mode toggle (`ui/index.html` L248–252) | CONFIRMED MATCHING |
| `status:` filter as a plain `<select>` (`All`/`Live`/`Needs review`/`History`), **default `Needs review`** | `<select id="personas-status-filter">` has the 4 correct options (`ui/index.html` L255–260), but `<option value="all" selected>` — default is **All**, not **Needs review** | **DEVIATION (D1)** |
| Status always real cell text, never a glyph | `personaStatusLabel()` returns `"live"` / `"needs review"` / `"needs review — updates existing persona"` / `"history"` — no Unicode anywhere (`ui/app.js` L1305–1316) | CONFIRMED MATCHING |
| Sticky group headers; Repo-grouping keeps the 3 global tiers as separate labeled sub-groups, not one collapsed "global" bucket | `.persona-group-header th { position: sticky; ... }` (`ui/style.css` L633–644); `groupPersonaRows()`'s `repo` branch pushes each global tier to its own `"${tier} — global — not repo-scoped"` label (`ui/app.js` L1359–1365) | CONFIRMED MATCHING (correctly coded — see D4 on reachability) |
| Every `code-architect` row shows its repo in every grouping mode (column when not grouped by Repo, header when grouped by Repo) | No `Repo` column exists in `#personas-table`'s `<thead>` at all (Tier / Scope ID / Display name / Parent(s) / Status / Actions); the repo-grouping branch is written but never populated | **DEVIATION (D4)**, see below |
| One-line `sourceSummary` snippet under any agent-proposed collapsed row | `renderPersonas()` appends a `.persona-source-snippet` div under the display-name cell iff `isAgentProposedDraft(row.draft)` (`ui/app.js` L1592–1602) | CONFIRMED MATCHING |
| `+ New draft` opens the same row-level accordion editor, pre-empty | No "+ New draft" control exists anywhere. `#persona-form` is instead a permanent, always-visible below-table form (pw-17's original placement), retargeted to POST the draft route and reused (via `populatePersonaForm()`) for both "propose new" and "edit existing" | **DEVIATION (D5)** |
| `reviewed, ready to commit` bulk-approve strip with checkboxes + `[Approve all]` | Does not exist anywhere in `ui/index.html`, `ui/app.js`, or `ui/style.css` (grepped for "approve all" / "ready to commit" / "batch" — zero hits) | **DEVIATION (D2)** |
| Combined `panel-status`: `"14 persona(s), 3 need review"` | Two separate status elements: `#personas-status` (persona count) and `#personas-drafts-status` (draft count), each independently set | **DEVIATION (D6)** |

### §2 — First-time-viewer onboarding

| Brief decision | Shipped reality | Verdict |
|---|---|---|
| `<details><summary>What do these terms mean?</summary>` glossary, collapsed by default, defining `tier`/`scopeId`/`Parent(s)`/`sourceSummary` | `#personas-glossary` exists verbatim with all 4 definitions, no `open` attribute (`ui/index.html` L225–237) | CONFIRMED MATCHING |
| Literal empty-state copy: *"No drafts pending. Ask an agent to propose one (`mnemosyne persona draft propose ...` or the `mnemosyne-persona-interview` skill), or start one by hand below."* | `renderPersonas()`'s empty-state text matches this exactly, byte-for-byte, with a `"No personas yet. "` prefix retained for an existing test assertion (`ui/app.js` L1552–1555) | CONFIRMED MATCHING |
| Approve/Discard are full-sentence buttons, never icon-only: `"Approve — write to persona store"` / `"Discard — archive without committing"` | Exact strings found in `buildPersonaDraftDetailRow()` (`ui/app.js` L1760, L1766) | CONFIRMED MATCHING |

### §3 — Row shape / two view states

| Brief decision | Shipped reality | Verdict |
|---|---|---|
| Row identity `{tier, scopeId}` / `{tier, repo, scopeId}` for `code-architect` | `personaRowKey()`, `draftDetailRowId()`, `personaDraftServiceUrl()` all key on `{tier, scopeId}` plus an optional `?repo=` param | CONFIRMED MATCHING (as coded; see D4 on reachability) |
| 4 status values (`live` / `needs review` / `needs review — updates existing persona` / `history`), each with the documented action-control shape | `mergedPersonaRows()` produces exactly `live`/`needs-review`/`needs-review-update`; `history` is a defined label with no populating code path (no archive-read route is ever fetched) | CONFIRMED MATCHING for the 3 live states; `history` is present in UI but structurally dead — **DEVIATION (D8)** |
| No row — collapsed or expanded — ever exposes a bare icon-only approve/discard | Confirmed: Approve/Discard only exist inside `.persona-draft-controls`, inside the hidden detail `<tr>`, gated behind the read-once click; never rendered on the collapsed row | CONFIRMED MATCHING |

### §4 — Crawl → propose → review → edit → approve flow

- **4.1 (crawl, unchanged, no in-panel trigger button):** confirmed — no such button anywhere. MATCHING.
- **4.2 (appears in queue with visible reason):** confirmed via the sourceSummary snippet above. MATCHING.
- **4.3 (review — read-only-first gate, focus management):** `buildPersonaDraftDetailRow()` renders Source-summary → Provenance → Current-vs-Proposed (or "New persona — nothing live yet") → full field values, all read-only, followed by a single `"I've read this — enable editing"` button. Edit/Approve/Discard controls are only added to the DOM (via `controls.hidden = !alreadyRead`) after that button is clicked — **never a `disabled` attribute**, matching the brief's explicit deviation-from-Option-2 instruction. `aria-expanded`/`aria-controls` are set and kept in sync on the outer `Review ▸`/`Hide ▾` toggle; focus moves programmatically to the first heading (`h4` "Why the agent proposed this", or the provenance line if not agent-proposed) on expand — `focusTarget.focus()` (`ui/app.js` L1674–1790, L1798–1818). Session-scoped read-tracking is a plain module-level `Set` that resets on reload, exactly as specified. **CONFIRMED MATCHING, verified directly in code, not just plausible from the brief.**
- **4.4 (edit):** same field set as pw-17's original form, reused via `populatePersonaForm()`; re-submission re-POSTs to the same draft identity (overwrite-in-place). The brief's own prose says "sends a `PUT`" but its own citation of design-discussion §3b says "second POST... overwrites the active draft" — the brief is internally inconsistent here, and the shipped code (a POST) matches the *cited rule*, not the *prose's* word choice. **Not counted as a real deviation** — the substantive behavior (overwrite-in-place via re-submission to the same identity) matches.
- **4.5 (approve/discard, confirm copy, aria-live):** `approveDraft()`/`discardDraft()` use native `window.confirm()` with the brief's exact quoted copy for both actions and for both success/failure `aria-live` announcements (verified string-for-string against option-2.md §4.5). **CONFIRMED MATCHING.** One structural nuance: the brief specifies the row "collapses and... flips to `live` in place... never a jarring full-page re-render." The shipped success path instead calls `renderPersonas()`, which clears and rebuilds the *entire* `#personas-tbody`, not just the affected row. **DEVIATION (D7)**, see disposition below.
- **4.6 (provenance survives approval):** the brief calls for a persistent one-line note on a now-live row that originated from an agent proposal (*"Originally proposed by agent, approved `<date>`."*). No such note, and no supporting data field, exist anywhere: the `Persona` interface (`lib/mnemosyne/layer1/persona.ts` L64–84) has no origin/provenance/approvedAt field at all, and a `status: "live"` row's Actions cell renders only a plain `[Edit]` button with no detail/provenance panel (`buildPersonaActionsAndDetail()`, `ui/app.js` L1821–1829). **DEVIATION (D3)**, see disposition below — this is a data-model gap, not just a missing render.

### §5 — Repo/tier hierarchy, parentRefs navigation

`personaParentCell()` renders a real `<button>` (not `href="#"`) for any parent ref present in the currently-loaded set; `jumpToPersonaRow()` moves real DOM focus (`target.focus()`), not just `scrollIntoView`, and — if the target is hidden by the active status filter — resets the filter to `all` and announces the reset via the same `aria-live` region (`ui/app.js` L1406–1433). This is exactly the fix `hierarchy-legibility.md` asked for and the brief documents. **CONFIRMED MATCHING.**

### §6 — Batch efficiency

Absent entirely. See D2.

### §7 — Data shape / routes, no new write path

`approveDraft()`/`discardDraft()` call pu-03's real `POST .../approve` and `DELETE` routes (not a client-side simulation); `approveDraft()` reuses the real, unchanged `loadPersonas()` on success rather than reimplementing it. No new write path exists anywhere in this file. **CONFIRMED MATCHING.**

---

## 2. Deviation log — every one dispositioned

| # | Deviation | Disposition | Reason |
|---|---|---|---|
| D1 | Status-filter default is `All`, not `Needs review` as the brief explicitly specifies (citing `operator-efficiency.md`'s "an operator opening the panel sees *only* actionable rows by default") | **FLAGGED** | No code comment or story documents this as an intentional choice; it is a one-line HTML change (`selected` attribute on the wrong `<option>`) that currently reintroduces the exact "scan past already-live rows" cost the brief's default was chosen specifically to avoid. Cheap, concrete follow-up. |
| D2 | The `reviewed, ready to commit` bulk-approve strip (checkboxes + `[Approve all]`, one reload at the end) is entirely unbuilt | **FLAGGED** | This is not a minor omission — option-2.md's own §6 calls this mechanism "the synthesis's central bet" for answering `operator-efficiency.md`/`information-density.md`'s batch-latency complaint without reopening Option 1's blind-approve failure mode. As shipped, clearing N drafts costs N independent full reloads (`approveDraft()`/`discardDraft()` each trigger their own `loadDrafts()`/`loadPersonas()` call) — exactly the cost `operator-efficiency.md` flagged as unaddressed in the *rejected* option 3, now also true of the *shipped* option 2. Neither pu-12's acceptance criteria nor its `design_decisions`/`risks` sections mention cutting this, so it reads as a silent scope drop, not a documented tradeoff. Needs a follow-up ticket. |
| D3 | Persistent post-approval provenance note ("Originally proposed by agent, approved `<date>`") does not exist; the `Persona` data model has no field to hold it | **FLAGGED** | `agent-provenance-trust.md` named this "a distinctive, concrete strength unique to" the option-3 lineage this synthesis builds on, and `selection.md` itself credits it as one of the two things (alongside the current-vs-proposed comparison) that made this lens's pick defensible. Once a draft is approved, the live persona is now indistinguishable from a hand-typed one — a real, verified regression on the exact lens (`agent-provenance-trust`) this epic was explicitly commissioned to get right. Needs a schema addition (an optional origin field on `Persona`, populated at approve time) plus a render, not just a UI tweak. |
| D4 | The "deciding factor" repo-hierarchy fix (3 separate global-tier sub-groups when grouped by Repo; `Repo` column/header for `code-architect` rows) is correctly *coded* but structurally *unreachable* — `loadPersonas()` and `loadDrafts()` never pass `?repo=`, and no UI control anywhere lets an operator select a repo, so no `code-architect` row can ever render in this panel today | **FLAGGED** | `selection.md`'s own "deciding factor" section names exactly this fix as the reason option 2 beat option 3 — a lens tied to "this tool's actual reason for existing" per its own framing. As shipped, that fix cannot be exercised or verified by an operator at all: the whole `code-architect` tier (the one that "fans out across an open-ended number of repos" per `hierarchy-legibility.md`) is invisible in this panel, identical to the pre-epic behavior. This isn't a UI bug in isolation — it's a gap between the epic's stated rationale for its design choice and what actually shipped. Needs a follow-up to wire a repo selector/filter (or otherwise pass `?repo=`) into `loadPersonas()`/`loadDrafts()`. |
| D5 | `+ New draft` row-level accordion editor (per §1's wireframe) replaced by pw-17's pre-existing standalone below-table `#persona-form`, reused for both create and edit | **ACCEPTED** | The substantive requirement — one editor, reused for both authoring paths, never a second UI (design-discussion.md §9.4) — is met. The chosen mechanism is, if anything, *more* consistent with this shell's existing convention (`#add-lane-form`, `#reindex-form`) than the brief's own row-level-accordion idea; `design-language-consistency.md`'s own critique of the row-accordion-editor approach (quoted inside `selection.md`'s "where all 3 options already agree" section) flagged this exact tension already. No trust/accessibility guarantee is weakened by this substitution. |
| D6 | Combined panel-status line split into two separate status elements (`#personas-status`, `#personas-drafts-status`) instead of one merged string | **ACCEPTED** | Documented in-code (`ui/index.html` L198–204): the two fetches (`GET /persona`, `GET /persona/draft`) can succeed/fail independently, and this mirrors `loadPersonaLayerStack()`'s own precedent of a dedicated status element per independent fetch — a real, reasoned technical justification, not an oversight. |
| D7 | "Flip to live in place" (§4.5) is actually implemented as a full `#personas-tbody` rebuild on every approve/discard, which also collapses any other row's open accordion | **ACCEPTED** | This matches the shell's own universal convention — every other panel (Lanes, Search, Operations) re-fetches and fully re-renders its list on any mutation; there is no existing precedent anywhere in this file for a bespoke single-row DOM patch, and building one only for Personas would itself be a design-language-consistency violation. Real but low-severity cost (loses in-progress accordion state elsewhere in the list after an action) — worth noting, not blocking. |
| D8 | `History` status-filter option exists in the UI but is currently dead — no code path ever assigns `status: "history"` to a merged row, and no archived-draft-listing route is fetched anywhere | **ACCEPTED** | No archive-read route was ever specified in H3/pu-03's route scope (`GET /persona/draft`, `GET /persona/draft/:tier/:scopeId`, `POST .../approve`, `.../discard` only) — this is a backend route-scope boundary predating pu-14, not a UI-layer regression introduced by pu-10/11/12. |

**4 FLAGGED, 4 ACCEPTED. Zero deviations left without an explicit disposition.**

---

## 3. Seven-lens spot-check against the SHIPPED code

Each lens re-checked directly against the real DOM/JS/CSS, not against the design brief's promises.

**1. Onboarding-clarity.** Glossary `<details>` is real, native, collapsed by default, and its 4 definitions were read verbatim from `ui/index.html` — genuinely present, not a placeholder. Empty-state copy matches the brief's quoted sentence exactly. Approve/Discard button text is full-sentence, verified in `ui/app.js`. **Regression found:** D1 (default filter = All) means a first-time viewer's very first view is the full unfiltered inventory again, not the "only actionable rows" view the brief specifically chose to solve part of this lens's original complaint about Option 1.

**2. Agent-provenance-trust.** Read `isAgentProposedDraft()` directly: it gates on `typeof draft.sourceSummary === "string" && draft.sourceSummary.trim() !== ""`. Every place `sourceSummary`, the "agent-proposed" badge, and "Proposed by agent" text render is inside an `if (agentProposed)` branch (`buildPersonaDraftDetailRow()`); the `else` path renders "Manually created" and nothing else. Directly verified: **sourceSummary is genuinely never fabricated for a human-typed draft** — this isn't just claimed in a comment, the branching is real. The read-before-edit gate is enforced by non-rendering, confirmed via `controls.hidden`/`gateBtn.hidden` toggling, never a `disabled` attribute (grepped `ui/app.js`/`ui/style.css` for `.disabled` on any persona-action-btn — none found; the only `disabled` usage anywhere near Personas is `#persona-form`'s submit button during its own async POST, an ordinary loading-state disable unrelated to the trust gate). **Regression found:** D3 — post-approval provenance does not survive, a real, verified gap on this exact lens.

**3. Hierarchy-legibility.** The repo-grouping fix and the real DOM-focus parent-jump (with filter self-heal + `aria-live` announcement) are both correctly implemented, read directly in `groupPersonaRows()` and `jumpToPersonaRow()`. **Regression found:** D4 — the fix that was this lens's decisive argument for choosing option 2 is unreachable in the running app because `code-architect` data is never fetched by any code path (confirmed via `loadPersonas()`/`loadDrafts()`'s hard-coded no-`?repo=` fetch calls, and the comment in `groupPersonaRows()` itself admitting "no code-architect row can appear via this ticket's data").

**4. Accessibility.** Verified directly: real `<button>` elements throughout (never a styled `<div>`/`<span>` with a click handler); `aria-expanded`/`aria-controls` wired and toggled on the Review/Hide toggle; focus moves programmatically into the accordion on expand (`focusTarget.focus()`); native `window.confirm()` used symmetrically for both approve and discard; a real `aria-live="polite"` region exists (`#personas-live-region`) with `.sr-only` implemented as a genuine clip-based visually-hidden pattern (`position:absolute; clip:rect(0,0,0,0)`), not `display:none` — this keeps it in the accessibility tree, a common footgun this repo avoided. Parent-ref jump moves real focus, not just scroll. **One real, verified cost found (folded into D7):** every approve/discard rebuilds the entire tbody, so a screen-reader user with another row's accordion open loses that open state (and any pending read-gate progress on the DOM, though the underlying `readDraftIdentities` Set itself persists correctly) after any single action elsewhere in the list.

**5. Information-density.** Sticky group headers and the one-line `sourceSummary` snippet on collapsed rows are both real and functioning, confirmed in `ui/style.css`/`ui/app.js`. **Regression found:** D2 — the brief's actual answer to this lens's core complaint (batch reload cost) was never built; today, N drafts triaged = N full reload round-trips, exactly the "10 full-table refetches, not 10 cheap local list-splices" cost the brief was written specifically to avoid.

**6. Design-language-consistency.** `.mode-toggle` reuse, native-`<select>` filter, `hidden`-attribute accordion (matching `#graph-inspector-detail`'s existing idiom), and an honestly-new (not falsely-precedented) `<details>` glossary are all confirmed in the actual markup/CSS. D5 (standalone form vs. row-accordion) if anything improves fidelity to this shell's existing conventions relative to the brief's own choice.

**7. Operator-efficiency.** The default-`Needs review`-filter efficiency win (D1) and the batch-approve mechanism (D2) — the two concrete things this lens's own critique asked for and the brief committed to building — are both, as verified in code, currently absent from the shipped panel. This is the lens with the most direct, material regression versus what was designed.

---

## 4. Self-check

- Every logged deviation (D1–D8) has an explicit ACCEPTED or FLAGGED disposition with a one-line reason — none left ambiguous. ✅
- The 7-lens spot-check section above re-examined actual code (function names, line-anchored behavior, grep results) for each lens, not the design brief's stated intentions — genuinely substantive, not a placeholder restating §8's critique-response table. ✅
- FLAGGED items were chosen because they are either (a) simple, concrete, low-risk fixes that were nonetheless never documented as intentional (D1), or (b) load-bearing to the specific lens(es) that justified choosing this design over its alternatives, and currently unverifiable or absent in the running app (D2, D3, D4). ACCEPTED items were chosen because they have a real, either code-documented or directly-inferable technical/consistency rationale that a reasonable reviewer would not ask to be redone. ✅
