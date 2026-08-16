# Synthesized Option 3 — Oriented Unified Queue

**Angle:** one continuous list holds every persona identity — live, needs
review, and history — the same structural backbone as initial Option 3,
because that backbone won 3 of the 7 lenses outright (accessibility,
agent-provenance-trust, hierarchy-legibility) and placed second in three more
(operator-efficiency, information-density, design-language-consistency). But
this synthesis does not carry initial Option 3 forward unmodified: it narrows
its control surface (design-language-consistency's "three simultaneous
axes" finding), closes its blind-approve gap using initial Option 2's
non-editable first-look gate (agent-provenance-trust's explicit synthesis
recommendation), fixes every accessibility gap named against all three
originals, and — because this pass is tie-broken toward onboarding clarity
and hierarchy legibility — adds the one thing **none of the three original
options did**: a first-time viewer can learn what `tier`, `scopeId`, and
`parentRefs` actually mean without leaving the panel, using a mechanism this
shell already has, not a new one.

---

## 1. Overall layout / navigation

Same section shape as every other panel and as today's own Personas panel —
no new page, no tab bar, no route:

```
┌─ Personas ────────────────────────────────────────────────────────────────┐
│ status: "14 persona(s) · 2 need review"                                    │
│                                                                             │
│ Every persona this Mnemosyne install knows about, across all 4 tiers and   │
│ every repo that has one — plus anything an agent has proposed but a human  │
│ hasn't approved yet. A "tier" is which level of the org a persona speaks   │
│ for (top-orchestrator = company-wide, company-director, project-           │
│ orchestrator, or code-architect = one specific repo). A "scope ID" is a    │
│ human-assigned name for one instance of a tier (never auto-detected). A    │
│ persona's parent is queried fresh each time it's used, never copied into   │
│ this persona's own file — see the (?) next to "Parent(s)" below.           │
│                                                                             │
│ View:  ( Needs review ● )  ( Live )  ( All )  ( History )                  │
│ Group by:  [ Tier ▾ ]                                    [ + New draft ]  │
├───────────┬──────┬──────────────┬────────────────┬───────────────┬───────┤
│ Status    │ Tier │ Repo         │ Scope ID        │ Display name  │Parent⑦│
├───────────┴──────┴──────────────┴────────────────┴───────────────┴───────┤
│ ▾ top-orchestrator (1)                                                     │
│   Needs review — new    top-orch   —          mnemosyne-co   (proposed) ▸ │
│ ▾ company-director (1)                                                    │
│   Live                  company-d  —          pantheon       Pantheon…  ▸ │
│ ▾ project-orchestrator (2)                                                │
│   Live                  project-o  —          mnemosyne-proj Mnemosyne… ▸ │
│   Needs review — revising  project-o —        swarm-mem-proj Swarm-Mem… ▸ │
│ ▾ code-architect — /repo/mnemosyne (3)                                    │
│   Live                  code-arch  /repo/mnem  mnemosyne      Code Arch.▸ │
│   ...                                                                     │
└────────────────────────────────────────────────────────────────────────── ┘
```

- **Panel-hint text is expanded, not new chrome.** This shell's own
  established convention is a `panel-hint` that "explains jargon inline"
  (design-language-consistency lens brief, describing the pattern this
  file's other panels already use). The current Personas panel-hint explains
  only the *fetch mechanics* (port 3141, cross-origin); this synthesis keeps
  that sentence and prepends three short plain-English sentences defining
  `tier`, `scope ID`, and the query-up/never-copy-down parent guarantee — the
  exact three concepts every onboarding critique flagged as **unexplained in
  all three original options, in every option's design, without exception**.
  No new widget, no tooltip system: the existing `<p class="panel-hint">`
  element just says more.
- **Two controls only, both built from idioms that already exist in this
  file:** a `View` radiogroup (`Needs review` / `Live` / `All` / `History`)
  built from the exact `.mode-toggle` `role="radiogroup"` native-radio-pill
  component the Search panel already ships (not an invented "chip" widget),
  and a `Group by` native `<select>` (`Tier` / `Repo`) matching the existing
  `#reindex-lane`-style select convention. Initial Option 3 stacked *three*
  simultaneous view-control axes (status chips + a 3-way group toggle +
  implicit sort) in one row — flagged by design-language-consistency as more
  compound control surface than anything else in this shell. This synthesis
  drops `Status` as a third grouping mode (it was redundant with the `View`
  filter's own `All` state, which already flattens by clicking it) and drops
  the sort-order concern entirely by keeping the default sort simple: group
  order follows canonical tier order top-orchestrator → company-director →
  project-orchestrator → code-architect, never reshuffled by draft status —
  see §3 (hierarchy-legibility response) for why.
- **`Needs review` is the default `View`, with a live count in the existing
  `panel-status` line** ("14 persona(s) · 2 need review") — reusing
  `setStatus()` verbatim, no new badge widget. This is initial Option 3's
  own strongest operator-efficiency finding (default-filtered-to-actionable
  beats Option 1's sort-only approach) carried forward unchanged.
- **Repo is now an always-visible column**, not filter-only — closing the
  single gap hierarchy-legibility's critique named as Option 1's worst
  failure ("no Repo column in the table itself... 15 code-architect personas
  across 6 repos are visually indistinguishable"). It reads `—` for the 3
  global tiers and the resolved repo path for `code-architect` rows, whether
  or not `Group by: Repo` is currently selected.
- **`Group by: Repo`** re-buckets the same already-loaded rows client-side
  (no re-fetch) with the 3 global tiers collapsed into one `global` group and
  each `code-architect` repo getting its own group header — same mechanic
  initial Option 3 specified, kept because no critique found fault with the
  toggle-without-refetch mechanic itself.
- **Sticky group headers** are kept from initial Option 3 and are explicitly
  the hierarchy-legibility response (§3): tier/repo context stays visible
  even while a row below it is expanded into full review detail.
- **Status column is plain cell text**, never a bare glyph — `Live`,
  `Needs review — new`, `Needs review — revising existing`, `History —
  approved`, `History — discarded`. Initial Option 3's compound `"— revision"`
  suffix was flagged by onboarding-clarity as unexplained shorthand; this
  synthesis spells it out in full words instead of a dash-suffix abbreviation,
  so the cell text alone (no legend needed) tells a first-time reader whether
  a draft is a brand-new identity or a proposed change to something that
  already exists.
- **`+ New draft`** opens the same accordion editor described in §2 below,
  for a fresh identity — not a separate form section. This is the one
  authoring surface for both a human typing a persona by hand and an agent's
  proposal landing via the crawl (design-discussion §9.4 — exactly one
  review/approve surface).
- **No tabs, no `<details>`, no modal.** The whole panel is one continuous
  top-to-bottom read, matching every other panel in this shell and today's
  own Personas panel — see §4 for why this was a hard requirement, not a
  preference.

## 2. Row and accordion mechanics (shared plumbing for both flows below)

Each row is one **identity** — `{tier, scopeId}`, or `{tier, repo, scopeId}`
for `code-architect`, called out explicitly as the real compound key (initial
Option 3's own finding, the only original option to state this). The panel
fetches `GET /persona` and `GET /persona/draft` in parallel and merges by
identity, so one row can carry a live record, a pending draft, or both.

- The row's trailing `▸` toggle is a real, accessible disclosure control: a
  `<button aria-expanded="false" aria-controls="row-detail-<id>">`, not a bare
  chevron. On activation it sets `aria-expanded="true"`, un-hides a second
  `<tr>` below it via the same plain `hidden`-attribute idiom
  `#graph-inspector-detail` already uses elsewhere in this file (never a new
  `<details>` element — confirmed absent from this codebase today), and moves
  focus into the first interactive element of the expanded content. Closing
  it (a `Close` button at the bottom of the expanded content, plus `Escape`)
  returns focus to the `▸` toggle. This closes the one gap the accessibility
  critique found **shared by every original option**: none of the three
  specified `aria-expanded`, `aria-controls`, or focus movement on their
  expand affordance.
- After any action that changes the row set (approve, discard, save edit), a
  visually-hidden `aria-live="polite"` region announces the change in plain
  language ("Approved code-architect / new-service — now live." /
  "3 drafts approved.") before the table re-renders. This directly answers
  accessibility's finding that dynamic re-sort/reload after an action was
  "unaddressed for AT users" in every original option.
- Parent(s) cells render pointer-only text exactly as today
  (`parentRefsText()`, unchanged — the copy-down guarantee is not touched),
  but where the named parent has a row in the *currently loaded* result set,
  the text becomes a real link that moves focus (not just scroll) to that
  row and briefly highlights it — kept from initial Option 3, since no
  critique found fault with the underlying idea, only its focus-handling
  specificity (now fixed: focus moves, not just a visual scroll).

## 3. The crawl → propose → review → edit → approve flow, in full

**Step 0 — crawl + propose (agent-side, unchanged mechanics, outside this
UI).** An operator gives an agent high-level context (tier, scopeId, repo)
and runs the already-shipped `mnemosyne-persona-interview` skill (or its
bounded-crawl extension, pu-07) from a live agent session. Its crawl reads a
fixed, capped source list (README, manifest, `CLAUDE.md`/`AGENTS.md`, the
parent persona's summary via query-up — never full content) and produces a
candidate persona plus a short `sourceSummary` string. Per the draft-first
default (design-discussion §9 judgment call #3), it calls `mnemosyne persona
draft propose` instead of writing directly. This panel does not add a
"start a crawl" button or invent a chat box — its hint text (the same
expanded panel-hint from §1) states the real mechanism in plain language,
matching onboarding-clarity's top-rated finding about initial Option 2's
quoted empty-state copy (reproduced here verbatim, adapted):

> *No drafts pending. Ask an agent to propose one
> (`mnemosyne persona draft propose ...`, or the persona-interview skill), or
> start one yourself with "+ New draft" above.*

This exact sentence is what renders in the table body whenever `View: Needs
review` has zero rows — not just described in prose, but the literal copy
shown, per onboarding-clarity's explicit callout that a *quoted*, concrete
empty state was measurably stronger evidence of onboarding-friendliness than
initial Option 3's abstract description of "hint text."

**Step 1 — the draft appears.** The next load or manual refresh of the panel
surfaces the new draft as a `Needs review — new` (or `— revising existing`)
row, sorted into its correct tier/repo group in canonical tier order — never
floated out of hierarchical position to the top of the list. This is a
deliberate departure from initial Option 1's "drafts float to the top,
breaking tier order" behavior, which hierarchy-legibility named as the
single biggest structural weakness of any original option — actionability is
still front-and-center via the `Needs review` default `View` filter, so
nothing about triage speed is lost; only the *ordering-breaks-hierarchy*
failure mode is removed.

**Step 2 — expand to review.** Clicking `▸` expands the accordion in place
(§2's mechanics). The expanded content opens in a **non-editable "Proposed"
sub-state first** — reproducing initial Option 2's structural safeguard,
explicitly named by agent-provenance-trust as the strongest single mechanic
across all three originals for preventing a reviewer from touching or
approving content they never actually registered:

- **Provenance line**, always real text, never inferred: `Proposed by agent ·
  <proposedAt>` or `Manually created · <timestamp>`.
- **"Why the agent proposed this"** — onboarding-clarity's own top-rated
  label wording, reused verbatim from initial Option 3 rather than a
  field-name label — followed by the `sourceSummary` text in full, verbatim,
  in a plain bordered block (not a monospace-only rendering, so it reads as
  prose, not a code dump).
- **Current vs. proposed**, shown only when a live record already exists at
  this identity: two labeled, plainly-headed text stacks, `Current (live)`
  and `Proposed (draft)`, each showing displayName / scope / every `sections`
  entry in full. Kept unchanged from initial Option 3 — accessibility
  explicitly praised this as *avoiding* a real screen-reader trap ("a
  byte-diff... is less legible than reading both in full... color-coded or
  strikethrough diff rendering is frequently invisible or unannounced to
  AT"), and no critique found fault with the mechanic itself. For a
  brand-new identity, only `Proposed` renders, headed plainly: *"New persona
  — nothing is live at this identity yet."*
- One button at this sub-state: **`Continue to edit / approve →`**. Nothing
  is editable and no approve/discard control exists yet at this sub-state —
  reproducing the exact non-blocking-but-mandatory read step
  agent-provenance-trust asked to see grafted onto initial Option 3's
  comparison mechanic.

**Step 3 — edit (optional).** Clicking through reveals the same field set
pw-17's existing create/edit form already collects (displayName, scope,
repeatable heading/body section rows, `parentRefs`, repo) — following that
form's own established `.form-row` markup convention exactly, just living
inside the accordion instead of a separate below-table section. The
provenance line and source-summary block from Step 2 stay visible above the
fields, not scrolled away — this is initial Option 2's "pinned provenance"
finding (agent-provenance-trust's second-strongest mechanic), applied here
without needing a permanently-reserved side rail the way Option 2's two-pane
layout did (which design-language-consistency and information-density both
flagged as this shell's biggest structural foreign-island risk). A **`Save
edits`** button issues the same "second POST to the same identity overwrites
in place" call the draft store already defines (design-discussion §3b) — the
row stays `Needs review`, a `panel-status`-style pass/fail line inside the
accordion confirms the save, and nothing is committed (`assertValidPersona`
is still not invoked). An operator with no edits to make can skip this
sub-state entirely.

**Step 4 — decide.** Two full-text, never-icon-only buttons, matching both
accessibility's explicit rule and onboarding-clarity's top finding about
consequence-stating copy:

- **`Approve — write to persona store`** — a real confirm step with specific,
  non-generic copy (initial Option 2's exact pattern, which accessibility
  named as the strongest confirmation text of any original option): *"Approve
  `code-architect / new-service`? This writes to the real persona store and
  cannot be undone from here."* Confirming calls `POST
  /persona/draft/:tier/:scopeId/approve`, which — unchanged from
  design-discussion §3b — strips draft-only metadata and passes the
  candidate through the existing `writeGlobalPersona`/`writeRepoLocalPersona`
  calls, the one real `assertValidPersona` enforcement point. On success the
  row flips to `Live`, the accordion collapses, the `aria-live` region
  announces it, and — unique to this synthesis's provenance treatment
  (carried from initial Option 3, the only original to specify it) — the row
  keeps a permanent one-line note even after landing: *"Originally proposed
  by agent, approved `<date>`."* Trust calibration does not end at the
  approve click; a later reviewer asking "where did this come from" gets an
  answer without leaving the row.
- **`Discard — archive without committing`** — same specific-copy confirm
  pattern, calls the discard route, archive-moves the draft file (never a
  hard delete, per this codebase's flight-status posture), and the row drops
  to the `History` view only.
- Both buttons only exist once Step 2's non-editable proposal view has been
  shown at least once this session for this identity (tracked client-side,
  reset on reload) — the concrete mechanism that makes "review before
  approve" structurally true rather than merely encouraged. Neither button
  is a bare row-level icon reachable without ever opening the accordion —
  closing accessibility's and agent-provenance-trust's single worst finding
  against initial Option 1 (an unlabeled, non-confirmed, collapsed-row
  approve control).
- `remember()` fires server-side on approval only, for agent-authored drafts
  only (design-discussion §9.9/OQ3) — invisible to this UI beyond the
  approve call's own response, no separate "indexing…" state invented.

**Batch triage, without reopening the blind-approve gap.** This is the
concrete answer to operator-efficiency's real, correctly-identified
complaint against every step-gated design: reviewing ten drafts one at a
time, each through a multi-click sequential flow, is a real throughput cost
at the scale this tool is built for. The fix is not a bare inline approve
button on the collapsed row (that is the exact mechanism accessibility and
agent-provenance-trust identified as the worst failure mode in the option
that had it) — it is a **persistent selection toolbar**:

- Once a row's non-editable Step 2 proposal view has been opened at least
  once in the current session, a checkbox becomes available on that row
  (disabled, with an explained reason via `aria-describedby`, until then —
  never a silently-inert control, closing the exact anti-pattern
  accessibility flagged against initial Option 2's disabled-button
  handling).
- Checking one or more reviewed rows reveals a toolbar pinned to the top of
  the table body (`Approve selected (3)` / `Discard selected (3)`), a plain
  `<div>` sibling in the same "op-block"-style stacking every other
  multi-control area of this shell already uses — not a floating overlay,
  not a new positioning system.
- Confirming a batch action fires the individual approve/discard calls in
  parallel (`Promise.all`, same pattern `loadPersonas()` already uses for its
  per-entry detail fetches) and reloads the list **once**, after the whole
  batch settles — not once per row. This directly answers
  operator-efficiency's concrete latency finding against both Option 1 and
  Option 3 as originally written ("clearing a batch of 10 drafts means 10
  full-table refetches").
- The toolbar is genuinely optional plumbing on top of the single-row flow
  above, not a second review path — every row that reaches a checkbox has
  already been through the identical non-editable-first-look gate described
  in Step 2. Confident batch triage gets fast; blind approval remains
  structurally impossible either way.

## 4. Critique responses — which lens drove which decision

**Operator efficiency** (`operator-efficiency.md`): its own explicit
synthesis suggestion — "Option 1's row-level one-click approve/discard,
combined with Option 3's default needs-review filter and diff" — could not
be taken literally without reopening the accessibility/provenance failure
that same document's sibling critiques found in Option 1's inline icon
buttons. Instead: kept Option 3's default `Needs review` filter and diff
view (§1, §2) unchanged, and answered the "no bulk/multi-select" and
"10 full-table refetches" findings directly with the persistent selection
toolbar (§3) — batch speed for rows that have genuinely been seen, a single
reload per batch instead of one per row, without ever exposing an approve
control that fires before a row has been opened.

**Onboarding clarity** (`onboarding-clarity.md`): its single most important
finding — *"none of the three options actually solves the jargon problem...
no option proposes so much as a tooltip, glossary, or one-line definition for
tier, scopeId, parentRefs, or 'query up, never copy down'"* — is the one gap
this synthesis treats as a hard requirement, not an optional polish item,
per this pass's tiebreaker. §1's expanded `panel-hint` closes it directly,
using this shell's own already-established "hint text explains jargon
inline" convention (confirmed as existing precedent by
design-language-consistency's lens brief) rather than inventing a tooltip or
glossary widget. The Status column's full-English wording (`Needs review —
revising existing` instead of Option 3's unexplained `"— revision"` suffix)
directly answers this critique's specific complaint about that exact string.
The quoted empty-state copy (§3, Step 0) is lifted, per this critique's own
explicit preference, from initial Option 2's literal text rather than
initial Option 3's abstractly-described hint.

**Accessibility** (`accessibility.md`): every named gap is closed explicitly.
The shared finding ("none of the three options fully solves focus management
on expand/collapse controls") is fixed in §2 with real
`aria-expanded`/`aria-controls` and stated focus movement. The single
highest-severity finding across all three originals — Option 1's bare,
unlabeled, non-confirmed `[✓]` approve reachable without opening the
drawer — is structurally impossible here: §3's decide-step buttons are
full-text, live only inside the accordion, and are gated behind having
opened the non-editable proposal view. Both approve and discard are
symmetrically confirm-gated with specific, non-generic copy (this critique's
explicit praise for initial Option 2's confirm text, reused verbatim in
§3). The "disabled with a tooltip" anti-pattern this critique named against
initial Option 2 is avoided in the batch toolbar (§3) by using
`aria-describedby` on a genuinely reachable control instead of a bare
`disabled` attribute with no explanation path. Dynamic list changes after an
action get an `aria-live` announcement (§2), closing the "unaddressed for AT
users" gap named against every original option.

**Agent-provenance and trust calibration** (`agent-provenance-trust.md`):
its own explicit closing recommendation — *"a synthesis that took Option 2's
non-editable first-look gate and grafted it onto Option 3's current-vs-
proposed comparison plus persistent post-approval provenance note would beat
either option standing alone"* — is implemented as written in §3, Step 2
(non-editable first look, reproduced structurally, not just encouraged) and
Step 4 (the post-approval "originally proposed by agent, approved `<date>`"
note, kept from initial Option 3 unchanged). The friction asymmetry this
critique flagged as "backwards" in Option 1 (confirm only on discard, not
approve) is corrected: both actions are symmetrically confirm-gated.

**Information density / scannability** (`information-density.md`): the
persistent selection toolbar (§3) is additive chrome that appears only once
rows are checked, not permanent screen real estate — avoiding the
"permanently-reserved pane" cost this critique named as initial Option 2's
worst failure. Narrowing initial Option 3's three view-control axes down to
two (§1) directly reduces the "compound view-control row" surface area this
critique implicitly weighed against Option 3 relative to Option 1's leaner
footprint, without giving up the default-filtered landing view this critique
also credited as a genuine win.

**Existing-shell design-language consistency**
(`design-language-consistency.md`): every new control is traced to a
mechanism that provably already exists in this file, not merely asserted to.
The `View` filter reuses the Search panel's real `.mode-toggle` radiogroup
component (§1) instead of inventing a "chip" widget (this critique's
specific complaint about initial Option 3's status chips). The accordion
reuses the real `hidden`-attribute toggle idiom `#graph-inspector-detail`
already uses (§2), never the nonexistent `<details>`/`<summary>` element
initial Option 1 incorrectly cited as precedent (this critique caught that
citation as false — this synthesis does not repeat the mistake). The batch
toolbar is a plain `op-block`-style `<div>`, the exact convention
`#operations-body` already uses for its Reindex/Refresh side-by-side blocks,
not a new floating-overlay pattern. No tab bar, no two-pane master-detail
layout — this critique's clearest, sharpest finding was that Option 2's tab
switcher and inbox-style Review Queue had "no real precedent anywhere in
this six-panel shell," and this synthesis does not include either.

**Multi-tier/multi-repo hierarchy legibility** (`hierarchy-legibility.md`):
the lens this pass's tiebreaker weights most heavily alongside onboarding,
and the one lens where an original option (initial Option 3) already won
"by a clear margin" — so its structure is kept almost entirely intact:
`{tier, repo, scopeId}` as the explicit compound identity, repo-qualified
group headers, sticky headers that persist through review, and
`parentRefs` as a real in-page navigation affordance (§1, §2). The two
concrete gaps this critique did find in initial Option 3 are fixed here:
grouping is no longer single-axis-only in a way that could hide a parent row
out of view — the default `View` and `Group by` combination always keeps
canonical tier order as the tie-breaking sort (§3, Step 1), so a
`code-architect` persona's ancestry chain stays orientable even while
triaging by status; and the "no Repo column" weakness this critique named
against initial Option 1 specifically is fixed by making Repo an
always-visible column (§1) rather than reintroducing that gap into this
synthesis by omission.
