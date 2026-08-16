# Synthesized Option 2 — Trust-Gated Unified Queue

**Angle:** one continuous list holds every persona identity — live and
drafted — organized by tier/repo/status like Option 3, because that base
structure won every hierarchy and consistency argument across the 7
critiques. But its single biggest weakness (nothing stops a reviewer from
committing agent-authored content without ever having read it) is treated as
disqualifying, not a tradeoff to accept, per this pass's own priority:
agent-provenance/trust-calibration and accessibility are the tiebreaker.
So the review/approve mechanism grafts in Option 2's strongest idea — a
structurally non-skippable, non-editable first look at the agent's raw
output before any commit control even exists — and answers the resulting
efficiency cost not with a blind fast path (which every trust- and
accessibility-focused critique independently condemned in Option 1) but with
a **reviewed-queue bulk-approve** mechanism: once a draft has been opened and
read at least once, it becomes eligible for a single batched commit alongside
other already-read drafts. Read-once-per-draft is non-negotiable; approving
many read drafts in one action is not.

---

## 1. Overall layout / navigation

Single panel, single list, no tabs, no route, no modal — the structural
choice every critique that touched design-language consistency ranked
highest for fidelity to this shell's existing one-panel-one-table idiom
(`design-language-consistency.md`, Option 3 "preserves the single-panel,
single-list shape... matches the existing shell's dominant pattern more
closely than Option 2's tab split"). `#personas` keeps its existing
`<section class="panel panel-wide">` → `<h2>` → `panel-status` → `<table>`
shape unchanged at the outer level.

```
┌─ Personas ──────────────────────────────────────────────────────────────────┐
│ panel-status: "14 persona(s), 3 need review"                                │
│ panel-hint: existing jargon-dense copy, unchanged, PLUS ▸ What do these     │
│   terms mean? (native <details>, collapsed by default — see §5)             │
│                                                                              │
│ group by: ( Tier ● Repo  Status )      status: [ Needs review ▾ ]          │
│                                                          [ + New draft ]    │
│ ┌─ reviewed, ready to commit (2) ───────────────────────────[Approve all]─┐ │
│ │ ☑ code-architect / new-service   ☑ project-orchestrator / mnemosyne-proj │ │
│ └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│ ▾ top-orchestrator (1)                                                      │
│   needs review    mnemosyne-co        Mnemosyne Top Orchestrator        ▸  │
│     ↳ "why: read package.json, CLAUDE.md, no prior top-orch persona…"      │
│ ▾ project-orchestrator (2)                                                  │
│   live             mnemosyne-project   Mnemosyne Project                 ▸  │
│   needs review — updates existing persona   mnemosyne-proj  (edited)    ▸  │
│ ▾ code-architect (3)                                                        │
│   live   /repo/mnemosyne    mnemosyne        Code Architect — mnemosyne ▸  │
│   needs review   /repo/new-service   new-service   (new)                ▸  │
│   ...                                                                       │
└──────────────────────────────────────────────────────────────────────────── ┘
```

- **`group by: Tier / Repo / Status`** — a native `role="radiogroup"` of
  `<label><input type="radio">` pairs, the *exact* existing `.mode-toggle`
  widget the Search panel already uses (`design-language-consistency.md`
  flags this as the closest real precedent for a view-switcher in this
  shell). Toggling re-buckets already-fetched rows client-side — no re-fetch
  — same "cheap client-side re-view" property Options 1 and 3 both have.
- **`status:` filter** is a plain `<select>` (`All` / `Live` / `Needs review`
  / `History`), reusing the existing native-`<select>`-as-filter idiom
  already established elsewhere in this file (`#reindex-lane`), rather than
  inventing a clickable-chip widget with no precedent
  (`design-language-consistency.md` flags status chips as new interaction
  vocabulary in both Options 1 and 3). Default value on first panel load is
  **`Needs review`**, matching Option 3's default-landing-filter win over
  Option 1 (`operator-efficiency.md`: "an operator opening the panel sees
  *only* actionable rows by default").
- **Status is always real cell text**, never a lone glyph: `live`,
  `needs review`, `needs review — updates existing persona`, `history`. No
  Unicode status glyphs anywhere. This directly answers both
  `accessibility.md`'s finding that Option 1's `●`/`◐` glyphs were
  undocumented for AT and `onboarding-clarity.md`'s finding that a
  first-time viewer "must reverse-engineer four symbols from context alone."
  The `— updates existing persona` suffix (see §4.4) is written as a full
  phrase, never the ambiguous `— revision` shorthand `onboarding-clarity.md`
  flagged as unexplained in Option 3 as written.
- **Grouping headers are `sticky`** and, when grouped by `Repo`, the three
  global tiers are **not** collapsed into one undifferentiated "global"
  bucket — they render as three separate sub-groups (`top-orchestrator` /
  `company-director` / `project-orchestrator`, each labeled "global — not
  repo-scoped") nested above the per-repo groups. This directly fixes the one
  concrete weakness `hierarchy-legibility.md` found in Option 3's grouping:
  "when grouped by `Repo`, the three global tiers collapse into one
  undifferentiated 'global' bucket, which could obscure the [tier] hierarchy
  precisely when an operator is thinking in repo terms."
- **Every `code-architect` row shows its repo**, regardless of the active
  grouping mode — as a `Repo` column value when grouped by Tier or Status,
  and as the group header itself when grouped by Repo. This merges Option
  2's explicit `Repo` column (`hierarchy-legibility.md`: "a direct, named fix
  for the exact gap Option 1 has") with Option 3's repo-qualified group
  headers, so the fix survives every grouping mode, not just one.
- **A one-line `sourceSummary` snippet renders directly under any
  agent-proposed row**, truncated to roughly one sentence, in muted text —
  visible without expanding anything. This is new relative to all three
  original options and exists specifically to blunt the efficiency cost of
  removing Option 1's blind one-click approve (§4.2, §6): an operator
  deciding *which* drafts to open first gets a real signal, not just a
  scopeId, from the collapsed view — closing part of the gap
  `information-density.md` flagged in Option 2's rail ("no display name, no
  parent... less information per row than either Option 1's or Option 3's
  row before committing to a click") without reopening Option 1's blind-
  approve failure mode.
- **`+ New draft`** opens the same row-level accordion editor described in
  §4, pre-empty, with no `sourceSummary` block and provenance line "Manually
  created" — one editor for both authoring paths, per design-discussion.md
  §9.4, exactly as Options 1 and 3 both already committed to.
- **`reviewed, ready to commit` strip** — new, appears only when at least one
  draft has been opened and read this session (§4.3, §6) — a compact bar
  above the grouped list, listing each reviewed-but-not-yet-committed draft
  by identity with a checkbox (all pre-checked) and one `[Approve all]`
  button. This is the synthesis's answer to the batch-triage need
  `operator-efficiency.md` and `information-density.md` both raised, without
  reintroducing an unread-approval path (§6).

## 2. What a first-time viewer gets that none of the 3 originals provided

`onboarding-clarity.md`'s single most important finding applies to all three
original options equally: *"none of the three options actually solves the
jargon problem this lens exists to test... no option proposes so much as a
tooltip, glossary, or one-line definition for `tier`, `scopeId`,
`parentRefs`, or 'query up, never copy down' anywhere in its brief."* This
synthesis treats that as a mandatory fix, not an option-specific nicety:

- A single new `<details><summary>What do these terms mean?</summary>...
  </details>` block sits directly under the existing `panel-hint` paragraph
  (unchanged), collapsed by default so it costs zero space for a returning
  operator who already knows the domain. Expanded, it gives one line each for
  `tier` (the four fixed levels this persona sits at), `scopeId` (a
  human-assigned identity, never auto-detected), `Parent(s)` / "query up,
  never copy down" (a pointer to where this persona's own content stops and
  a parent's begins — the parent's real content is never fetched here), and
  `sourceSummary` ("what an agent read before proposing this draft — see
  §4.2"). `<details>`/`<summary>` has no precedent in this codebase
  (confirmed absent by `design-language-consistency.md`'s own grep) — this
  synthesis introduces it honestly as new, minimal, native-HTML vocabulary
  addressing a documented gap, rather than (as Option 1 did) claiming a
  precedent that `design-language-consistency.md` found didn't actually
  exist.
- **A literal, quoted empty state**, adapting the strongest single sentence
  `onboarding-clarity.md` identified across all three options (Option 2's):
  when `GET /persona/draft` returns zero pending drafts, the panel-status
  line and an inline hint read exactly: *"No drafts pending. Ask an agent to
  propose one (`mnemosyne persona draft propose ...` or the
  `mnemosyne-persona-interview` skill), or start one by hand below."* — the
  same literal copy `onboarding-clarity.md` singled out as "concrete,
  verifiable onboarding text," reused rather than re-invented.
- **Approve/Discard are full-text, sentence-length buttons, never
  icon-only** — `"Approve — write to persona store"` /
  `"Discard — archive without committing"` — reproducing Option 2's own
  explicit design rule verbatim (`onboarding-clarity.md` and
  `accessibility.md` both single this out as the clearest, most concrete
  design commitment of any of the three originals).

## 3. Row shape and the two view states

Each row is one **identity** — `{tier, scopeId}`, or `{tier, repo, scopeId}`
for `code-architect` (`hierarchy-legibility.md`: Option 3 is "the only
option to say so explicitly" that scopeId alone isn't unique across repos at
that tier — reused unchanged here). `GET /persona` (live) and `GET
/persona/draft` (new list route) are fetched in parallel and merged by
identity, exactly as Option 3 specified, giving three possible collapsed
states:

| Cell text | Meaning | Row also gets |
|---|---|---|
| `live` | committed, no pending draft | `[Edit]` link only |
| `needs review` | new identity, pending draft, no live record yet | `▸` expand only — no direct action control |
| `needs review — updates existing persona` | pending draft revising an identity that already has a live record | `▸` expand only, plus the one-line snippet (§1) |
| `history` (under the `History` filter only) | archived — approved-and-superseded or discarded | plain text, muted, no controls |

**No row — collapsed or expanded-once-reviewed — ever exposes a bare,
icon-only approve/discard control.** This is a direct, structural response
to the single most severe finding across the whole critique set: both
`accessibility.md` ("the two most consequential controls in the whole
redesign... are specified as bare glyph buttons... without an explicit
accessible name") and `agent-provenance-trust.md` ("step 5 explicitly allows
Approve/Discard to fire from the *collapsed* row, with no requirement to have
ever opened the drawer... a structural invitation to approve agent-authored
governing content without having seen the `sourceSummary`... at all") named
this as Option 1's most serious defect, and this pass's own tiebreaker
(trust-calibration + accessibility) makes it disqualifying rather than an
acceptable efficiency trade. See §6 for how the resulting efficiency cost is
actually paid down instead of just eaten.

## 4. The crawl → propose → review → edit → approve flow, in full

### 4.1 Crawl + propose (agent side, outside the browser — unchanged)

An operator runs `skills/mnemosyne-persona-interview`'s already-shipped
crawl-then-propose loop (or a future bounded-crawl variant) in a live agent
session with high-level context (tier, scopeId, repo). Per its draft-first
default, step 7 calls `mnemosyne persona draft propose --file <path> [--repo
<repo>]`, carrying the bounded crawl's `sourceSummary` string
(design-discussion.md §3c). This synthesis does not add a "start a crawl"
button anywhere in the panel — all three originals agree the trigger belongs
in the agent session, not a fabricated chat box a zero-dep vanilla-JS shell
has no business building, and the empty-state copy in §2 points there
explicitly instead of implying a button exists.

### 4.2 Appears in the queue, with a visible reason attached

The next load/refresh of the merged `GET /persona` + `GET /persona/draft`
fetch surfaces the new draft as `needs review` (or `needs review — updates
existing persona` if `{tier, scopeId}` already has a live record), sorted
under its tier/repo group, under the default `Needs review` status filter —
and, per §1, with its one-line `sourceSummary` snippet already visible
without any click.

### 4.3 Review — expand in place, read-only first, always

Clicking `▸` expands an accordion directly under the row (table stays in
view — same in-place mechanism Options 1 and 3 both used, grounded in this
file's real existing `hidden`-attribute toggle idiom, e.g.
`#graph-inspector-detail`). On expand, focus moves programmatically to the
accordion's first heading (the Source Summary block below) — not left
floating — and the toggle carries `aria-expanded`/`aria-controls`, closing
the one gap `accessibility.md` found unaddressed in **every one** of the
three original options ("None of the three options fully solves focus
management on expand/collapse controls — that gap should be treated as a
shared, mandatory fix regardless of which option is selected").

**The accordion always opens in a non-editable, read-only mode first** —
even on a second or third visit to the same draft — showing, top to bottom:

1. **Source summary** — labeled *"Why the agent proposed this"* (the exact
   plain-language phrasing `onboarding-clarity.md` called "arguably the
   single clearest label of any option for the concept the whole
   lens-4/provenance mechanism exists to support"), the bounded crawl's full
   `sourceSummary` text verbatim.
2. **Provenance line** — `"Proposed by agent · <proposedAt>"` or `"Manually
   created · <timestamp>"`, always visible text, never inferred or
   tooltip-only (all three originals agreed on this baseline; kept
   unchanged).
3. **Current (live) vs. Proposed (draft)**, shown only when a live record
   already exists at this identity — two labeled, plain stacked-text blocks
   (`displayName`, `scope`, each `sections` entry), not a diff library. For a
   brand-new identity, only `Proposed` renders, headed "New persona — nothing
   live yet." Reused directly from Option 3, which every lens that discussed
   it (`agent-provenance-trust.md`, `accessibility.md`,
   `operator-efficiency.md`) rated as the strongest single review affordance
   of the three originals — `agent-provenance-trust.md`: "the most direct
   answer of the three options" to what actually changed; `accessibility.md`:
   plain stacked text "avoids a common, serious screen-reader trap" that
   color/strikethrough diffs create.
4. The candidate's full field values, still read-only at this stage.

A single control sits at the bottom of this read-only view:
**`"I've read this — enable editing"`**. Nothing resembling an edit field,
and *no* Approve/Discard control, exists anywhere on screen until this is
clicked. This reproduces Option 2's own structural safeguard almost exactly
— `agent-provenance-trust.md` on Option 2: "Proposed is a pure 'here's what
the agent found' checkpoint, deliberately separated from editing so an
operator always sees the agent's unedited output at least once before
touching it... a genuine structural gate against the failure mode this lens
cares about most" — grafted onto Option 3's richer read-only content (the
current-vs-proposed stacks Option 2 never had). Once clicked within a
session, this specific draft's identity is marked read for the remainder of
the session (client-side only — re-opening the same draft later in the same
session skips straight to the editable view; a fresh page load resets it,
so a genuinely new review context always re-shows the raw proposal once).

**Design deviation from Option 2, deliberately:** Option 2 additionally
*disabled* the Approve/Discard buttons (with a tooltip) until edits were
saved. `accessibility.md` flagged this exact pattern as a known
anti-pattern: *"A native `disabled` attribute removes an element from the
tab order entirely, so a keyboard/screen-reader user cannot discover the
button exists, let alone why it's inert."* This synthesis reproduces the
*intent* (never let approval fire before the content has actually been
looked at) structurally instead — by simply not rendering the
Approve/Discard controls into the DOM at all until the read-only gate is
passed — rather than rendering them disabled. A control that doesn't exist
yet has no discoverability problem a `disabled` attribute does.

### 4.4 Edit

Once "I've read this — enable editing" is clicked, the same fields render
editable in place — displayName, scope, repeatable heading/body section
rows, parentRefs, repo — the identical field set `pw-17`'s existing form
already collects (design-discussion.md §9.4: one editor, reused, not a
second one). `Save edits` sends a `PUT` to the same draft identity
(overwrite-in-place, per design-discussion §3b's "second POST to the same
identity overwrites the active draft" rule). The row's status text updates
to include `(edited)` next to the identity in the reviewed-queue strip once
this draft is also marked read (§4.3) and has unsaved-then-saved edits, so
an approver glancing at the batch strip in §6 can tell an edited draft from
an as-proposed one without re-opening it.

Saving does **not** advance or unlock anything new — Approve/Discard are
already available at this point (per §4.3's gate having already passed), so
an operator can save-then-immediately-approve in the same accordion without
a forced extra step, unlike Option 2's fully sequential stepper (whose
mandatory five-click minimum path `operator-efficiency.md` named as "the
weakest option through this lens, and it's not close").

### 4.5 Approve or discard — from the now-open accordion, or batched (§6)

Two full-text buttons render at the bottom of the (now unlocked) accordion:

- **`"Approve — write to persona store"`**
- **`"Discard — archive without committing"`**

Both fire a native `window.confirm()` — kept as native, not a custom dialog,
because `accessibility.md` specifically credited Option 3's use of native
`confirm()` over Option 2's custom pattern: *"Native `confirm()` also has an
accessibility advantage the other two options' custom confirmation patterns
don't automatically get: it's browser-native, so focus handling and AT
announcement are handled by the platform."* But the confirm **copy** is
Option 2's, verbatim in shape, not Option 3's under-specified generic text —
`agent-provenance-trust.md` flagged Option 3's confirm as only "a native
`confirm()`... no described copy content... could be as unspecific as a bare
'Are you sure?'" This synthesis commits to the specific string:
*"Approve `code-architect / new-service`? This writes to the real persona
store and cannot be undone from here."* (Discard's mirrors it: *"Discard
this draft? It will be archived, not deleted, but removed from the review
queue."*) — symmetric confirm-gating on both actions (matching Option 3's
symmetry, which `accessibility.md` preferred over Option 1's approve-gets-
no-confirm asymmetry, which both `accessibility.md` and
`agent-provenance-trust.md` called backwards).

On confirm:
- `POST /persona/draft/:tier/:scopeId/approve` runs the (possibly edited)
  candidate through the real `assertValidPersona` gate for the first time,
  writes via the unchanged `writeGlobalPersona`/`writeRepoLocalPersona`
  primitive, fires `remember()` against the `sourceSummary` for
  agent-authored drafts only (design-discussion §9.9 — human-typed drafts
  with no `sourceSummary` skip this silently, nothing invented), and
  archive-moves the draft file.
- `POST /persona/draft/:tier/:scopeId/discard` archive-moves to `discarded/`
  without touching the real store.
- Either way, an `aria-live="polite"` region (new — none of the three
  originals addressed this; `accessibility.md`: "for a screen reader user
  mid-review of a list that just reordered/shrank underneath them, there's
  no mention of an `aria-live` announcement") announces the result in plain
  text: `"Approved code-architect / new-service — now live."` or `"Discarded
  code-architect / new-service — archived."` The row collapses and, per
  disposition, either flips to `live` in place or drops to the `History`
  filter — never a jarring full-page re-render.

### 4.6 After approval — provenance survives

A now-`live` row that originated from an agent proposal keeps a persistent,
one-line provenance note visible in its own (now read-only) accordion:
*"Originally proposed by agent, approved `<date>`."* This is reused directly
from Option 3, which `agent-provenance-trust.md` singled out as unique among
the three originals: *"trust calibration for this interaction doesn't end at
the moment of the approve click — a design that forgets a persona's
agent-authored origin the instant it goes live is incomplete."* The full
`sourceSummary` and the current-vs-proposed comparison are **not** kept
verbatim past approval (matching Option 3's own scope, and avoiding
unbounded storage growth) — only the one-line forensic note persists, same
tradeoff Option 3 made and no critique flagged as insufficient beyond noting
it as a known limit.

## 5. Repo/tier hierarchy — parentRefs as real navigation

`Parent(s)` stays pointer-only text (tier + scopeId; the parent's real
content is never fetched, preserving the "query up, never copy down"
guarantee exactly as pf-12 already enforces) — but where the named parent
also currently has a row in the loaded set, it renders as an in-page anchor
that scrolls to and moves **actual DOM focus** to that row (not merely
scrolls it into view — `accessibility.md` flagged Option 3's original
"scroll to and flash" as purely visual with "nothing said about moving
actual focus... or otherwise giving a screen reader user any signal that the
jump happened"). If the anchor target is currently hidden by the active
status/tier/repo filter, clicking it does not silently fail — it first
resets the status filter to `All` (never repo/tier group, to avoid
disorienting the operator further) and announces via the same `aria-live`
region: *"Filter cleared to show parent `<tier> / <scopeId>`."* This
directly closes the gap `hierarchy-legibility.md` found in Option 3: "the
design doesn't address what happens when the default `Needs review` filter…
hides the parent row entirely; the anchor could point at nothing visible
without the operator realizing why."

## 6. How batch efficiency is actually recovered, without a blind fast path

`operator-efficiency.md` and `information-density.md` both, independently,
rated Option 3 as costing real throughput at batch scale because *every*
approve/discard requires an expand step first — and both explicitly ranked
Option 1's collapsed-row one-click controls as the efficient alternative.
This synthesis does not adopt that alternative (§3, §4.3) because the
accessibility and agent-provenance lenses named the exact same mechanism as
the single most severe defect across all three originals, and this pass's
own tiebreaker is trust-calibration and accessibility. Instead, the batch
cost is paid down a different way:

- Any draft that has passed its one-time read-only gate (§4.3) — whether or
  not it was subsequently edited — becomes eligible for the **`reviewed,
  ready to commit`** strip at the top of the panel (§1). This strip lists
  every such draft by identity, pre-checked, with one **`[Approve all]`**
  button.
- `[Approve all]` fires one native `confirm()` listing every identity about
  to be committed (not a silent bulk action — the same descriptive-copy
  principle from §4.5 applies at batch scale: *"Approve 3 drafts:
  code-architect / new-service, project-orchestrator / mnemosyne-proj,
  top-orchestrator / mnemosyne-co? This writes to the real persona store and
  cannot be undone from here."*), then issues the approve calls sequentially
  and reloads the merged list **once**, at the end — directly answering
  `operator-efficiency.md`'s concrete latency finding about Option 1's
  ("clearing a batch of 10 drafts means 10 full-table refetches... not 10
  cheap local list-splices") and Option 3's identical unaddressed cost
  ("same unaddressed batch-of-N latency concern noted for Option 1, with no
  bulk-action mitigation either").
- An operator can uncheck any row in the strip before committing, or discard
  individual rows from their own accordion as before — the batch mechanism
  never removes the per-identity accordion path, it only adds a second,
  faster on-ramp for drafts that have already cleared the one non-negotiable
  gate (having been opened and read at least once, this session).

This is the synthesis's central bet: the efficiency lenses' real complaint
was never "approving takes one click instead of zero," it was "approving N
drafts costs N full round-trips through a UI ceremony." Solving the *batch*
cost while keeping the *per-draft* read-before-approve gate intact serves
both the efficiency critiques and the trust/accessibility tiebreaker, rather
than trading one for the other.

## 7. Data shape, routes, no new write path

Unchanged from design-discussion.md §3b/§3c and all three originals: the
draft store stays the home-rooted `~/.mnemosyne/persona-drafts/` tree,
addressed by `{tier, scopeId}` (or the sanitized `repoSlug` for
`code-architect`), one active draft per identity, disposition by
archive-move. `GET /persona/draft` (list) and `GET
/persona/draft/:tier/:scopeId` (single, full record incl. `sourceSummary`)
are the two new read routes this UI needs; `POST
/persona/draft/:tier/:scopeId/approve` and `.../discard` are the two write
routes, both already specified in design-discussion.md §3b/§9.9 and reused
unchanged — `assertValidPersona` remains the one real enforcement point,
exercised only at approval, exactly as every original option already
committed to.

---

## 8. Critique responses — decision-by-decision

| Decision | Driven by | Critique / lens |
|---|---|---|
| Single-panel, single-table, no tabs, no two-pane master/detail | Option 2's tab bar and inbox-style layout have "no real precedent anywhere in this six-panel shell" and are "the most visually foreign island outcome of the three" | `design-language-consistency.md` |
| Approve/Discard NEVER render as bare icon-only controls, and never render at all on a collapsed row | Icon-only, unlabeled approve/discard in Option 1 was called "the most concrete, high-severity finding across all three options" | `accessibility.md` |
| Approve/Discard are unreachable until the draft has been opened and its read-only view acknowledged | Option 1's collapsed-row fast path was "a structural invitation to approve agent-authored governing content without having seen the `sourceSummary`... at all" and "in direct tension with the lens's goal" | `agent-provenance-trust.md` |
| The read-before-edit gate is enforced by *not rendering* the edit/approve controls yet, not by a `disabled` attribute | `disabled`-with-tooltip "removes an element from the tab order entirely, so a keyboard/screen-reader user cannot discover the button exists" | `accessibility.md` |
| Approve and Discard are symmetrically confirm-gated | Option 1's approve-gets-no-confirm-while-discard-does was called out as "inverted... approving unread agent content into a store that governs future agent behavior is the action that most needs a pause, not the one that gets none" | `accessibility.md`, `agent-provenance-trust.md` |
| Confirm copy is specific and descriptive, not a generic "Are you sure?" | Option 3's confirm was "only... no described copy content... could be as unspecific as a bare 'Are you sure?'"; Option 2's specific copy was "the most explicit consequence-framing of any option" | `agent-provenance-trust.md`, `onboarding-clarity.md` |
| Native `confirm()` kept as the confirmation mechanism (not a custom dialog) | Native `confirm()` "has an accessibility advantage... focus handling and AT announcement are handled by the platform" | `accessibility.md` |
| Current (live) vs. Proposed (draft) plain-stacked-text comparison, not a diff library | "A byte-diff of prose sections is less legible than reading both in full"; plain text "avoids a common, serious screen-reader trap" of color/strikethrough diffs | `agent-provenance-trust.md`, `accessibility.md` |
| Provenance survives approval as a persistent one-line note on live rows | "Trust calibration for this interaction doesn't end at the moment of the approve click — a design that forgets a persona's agent-authored origin the instant it goes live is incomplete" | `agent-provenance-trust.md` |
| Status is always real cell text (`live` / `needs review` / `needs review — updates existing persona` / `history`), never a bare glyph | Status "as actual cell text, not decoration" was named directly as the reason for a structural choice; unlabeled glyphs force a newcomer to "reverse-engineer four symbols from context alone" | `accessibility.md`, `onboarding-clarity.md` |
| `— updates existing persona` spelled out in full, not a terse `— revision` suffix | The `— revision` suffix "is never explained in the text — a newcomer encountering that exact string has no way to know it differs in meaning" | `onboarding-clarity.md` |
| Expand toggle carries `aria-expanded`/`aria-controls` and moves focus into the accordion on open | "None of the three options fully solves focus management on expand/collapse controls — that gap should be treated as a shared, mandatory fix regardless of which option is selected" | `accessibility.md` |
| Parent-ref anchor moves real DOM focus, and self-heals when the target is filtered out of view | "Nothing is said about moving actual focus"; "the anchor could point at nothing visible without the operator realizing why" | `accessibility.md`, `hierarchy-legibility.md` |
| `aria-live` region announces approve/discard outcomes and list changes | "There's no mention of an `aria-live` announcement or any other cue that the action succeeded and the list changed shape" | `accessibility.md` |
| New `<details>` glossary block for `tier`/`scopeId`/`Parent(s)`/`sourceSummary`, collapsed by default | "None of the three options actually solves the jargon problem this lens exists to test... no option proposes so much as a tooltip, glossary, or one-line definition" | `onboarding-clarity.md` |
| Literal quoted empty-state copy pointing at the CLI/skill trigger | Option 2's quoted empty-state sentence was "concrete, verifiable onboarding text" contrasted against the other two options' abstract description | `onboarding-clarity.md` |
| Approve/Discard rendered as full-sentence buttons, never icon-only | Reproduces Option 2's own explicit rule, "the single most explicit accessibility rule of the three" and clearest onboarding win | `accessibility.md`, `onboarding-clarity.md` |
| `<details>` introduced honestly as new vocabulary, not claimed as reusing an existing pattern | Option 1 cited a nonexistent `<details>`-style precedent ("`#add-lane-form` is a permanently-visible `<form>`, not a collapsible toggle... zero hits for `details`/`summary`") | `design-language-consistency.md` |
| `group by` control implemented as the existing `.mode-toggle` radiogroup widget; status filter as a plain `<select>`, not clickable chips | "`.mode-toggle`... the closest real precedent for a view-switcher"; status chips are "a new interaction... nothing in this shell currently narrows a rendered table via clickable chips" | `design-language-consistency.md` |
| Default landing filter is `Needs review`, not just a sort | Option 1's "sort-only approach" costs "slightly more visual scanning past already-live rows" than a real default filter | `operator-efficiency.md` |
| Reviewed-queue bulk-approve strip, single reload after a batch commit | "Clearing a batch of 10 drafts means 10 full-table refetches... not 10 cheap local list-splices" — flagged as unaddressed in both Option 1 and Option 3 | `operator-efficiency.md` |
| One-line `sourceSummary` snippet visible on the collapsed row for agent-proposed drafts | Option 2's rail "under-displays per row... no display name, no parent... less information per row... before committing to a click" | `information-density.md` |
| Grouping stays a single already-loaded dataset re-bucketed client-side (Tier/Repo/Status), no per-mode refetch | Preserves "the strongest of the three for 'scan a lot of real data organized by the axis I currently care about'" without Option 2's admitted density trade | `information-density.md`, `operator-efficiency.md` |
| `Repo` shown for every `code-architect` row in every grouping mode (column when not grouped by Repo, header when grouped by Repo) | "There is a *filter* for repo, but nothing in the row shows which repo a `code-architect` persona belongs to... this is exactly the place hierarchy legibility breaks first" (Option 1's gap); Option 2 "explicitly named" the same fix but only inside its Library tab | `hierarchy-legibility.md` |
| Repo-grouped view still separates the three global tiers into their own labeled sub-groups instead of one flat "global" bucket | "The three global tiers collapse into one undifferentiated 'global' bucket, which could obscure the [tier] hierarchy" | `hierarchy-legibility.md` |
| Row identity is `{tier, scopeId}` or `{tier, repo, scopeId}` for `code-architect`, stated explicitly | "The design acknowledges `scopeId` alone is not unique across repos at this tier, which is the correct compound key" | `hierarchy-legibility.md` |
| Hierarchy/grouping state persists through the entire review — the accordion opens in place under its sticky group header, not in a separate tab | Reviewing on Option 2's Review Queue tab "largely drops hierarchy context the moment a draft is actually being reviewed... the highest-stakes moment for this lens" | `hierarchy-legibility.md` |

Every one of the 7 lenses' applicable findings is addressed above; where a
lens's preferred mechanism (Option 1's blind one-click approve, most
directly) was deliberately **not** adopted, §6 states the reasoning
explicitly rather than silently dropping the concern, and offers a
different concrete mechanism (batched approval of already-read drafts) aimed
at the same underlying need (fast triage at real multi-repo scale) without
reintroducing the failure mode the trust and accessibility lenses both
named as most severe.
