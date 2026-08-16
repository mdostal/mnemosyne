# Option 2 — Guided Step-by-Step Review Flow

**Angle:** the crawl → propose → review → edit → approve loop is its own
dedicated, sequential surface, structurally separate from the flat persona
list. A draft's *lifecycle position* is the primary thing the UI communicates
— never buried as a status column in a dense table.

## 1. Overall layout / navigation

The `Personas` panel keeps its section chrome (`<section id="personas">`,
same panel-wide convention as every other panel) but its body is split by a
single segmented control at the top, directly under the `<h2>Personas</h2>`
heading:

```
[ Library ]   [ Review Queue (3) ]
```

- **Library** is the default tab (no drafts, no lifecycle chrome — see §2).
- **Review Queue** shows a live count badge (pending drafts across all
  tiers/repos) so an operator glancing at the panel — even while parked on
  Library — sees at a glance whether anything needs their attention. The
  badge is the *only* thing about drafts visible from Library; everything
  else about a draft lives behind the tab switch.

Both tabs are plain `<div>`s toggled via `hidden`/`display:none` — no router,
no framework, matching every other panel's convention (`app.js`'s existing
`setStatus`/element-toggling idioms). Switching tabs never re-fetches Library
if it's already loaded; Review Queue lazy-loads on first visit and then
polls (or manually refreshes via the existing panel-status "loading…"
convention) like `loadPersonas()` already does.

A draft is *never* rendered as a row inside the Library table. This is the
single structural decision the whole option hangs on: Library stays exactly
as scannable/dense as it is today (lens 5), and the Review Queue becomes the
one place lifecycle state is shown, so it can afford to spend space on it
without compromising the list.

## 2. Library tab — the persona list

Unchanged in spirit from today's table, extended for hierarchy legibility
(lens 7): grouped by tier (four `<h3>` sub-headings — Top Orchestrator /
Company Director / Project Orchestrator / Code Architect — each with its own
`<tbody>`), Code Architect rows carry a `Repo` column since multiple repos
share that tier. Same four columns otherwise (Scope ID, Display Name,
Parent(s)), still pointer-only for parents — no change to the copy-down
guarantee.

Only **approved, live** personas appear here — this tab answers "what
personas exist," not "what's in flight." Each row gets one small addition: if
that exact `{tier, scopeId}` currently has an active draft (i.e. someone
proposed a revision to an existing persona), the row shows a subtle inline
tag — `↻ draft pending` — that's a link, not a status field to parse; clicking
it jumps straight to that draft's position in the Review Queue tab (see §4's
deep-link note). This is the only lifecycle leakage allowed into Library, and
it's a navigational pointer, not lifecycle detail.

## 3. Review Queue tab — layout

Two-pane layout, mirroring an inbox/detail pattern (the one, deliberate
information-density exception in this design — justified because reviewing
agent-authored content that becomes governing instruction text is a
qualitatively higher-stakes action than scanning a list, lens 4):

```
+-------------------+---------------------------------------------+
| QUEUE (left rail)  |  STEP PANEL (selected draft)                |
|                     |                                              |
| [tier/repo filter   |  ( ● Proposed ) — ( ○ Reviewing ) —          |
|   chips]            |  ( ○ Decision ) — ( ○ Resolved )             |
|                     |                                              |
| ● code-architect    |  [ content for the current step ]           |
|   mnemosyne          |                                              |
|   ● Proposed         |                                              |
|                     |                                              |
| ◐ project-orch.      |                                              |
|   mnemosyne-project  |                                              |
|   ◐ Reviewing        |                                              |
|                     |                                              |
| + New draft          |                                              |
+-------------------+---------------------------------------------+
```

- **Left rail**: every active draft, one row per `{tier, scopeId}` (the
  store's own uniqueness rule — never more than one active draft per
  identity, so the rail can never show duplicates for the same persona).
  Each row shows tier badge, scopeId, a one-glyph step indicator, and sorts
  newest-proposed-first. Filter chips at the top narrow by tier/repo — this
  is the rail's only concession to density, because with drafts spread
  across 4 tiers and N repos it must stay legible at real scale (lens 1, 7).
  A **`+ New draft`** row at the bottom starts a blank, human-authored draft
  (see §4's note on the manual path) and drops the operator straight into
  Reviewing.
- **Step panel**: always shows exactly one draft — whichever the operator
  selected in the rail. Its header is a 4-node horizontal stepper: **Proposed
  → Reviewing → Decision → Resolved**. The current node is filled/highlighted;
  completed nodes show a checkmark; future nodes are dimmed. This stepper is
  the design's whole thesis made visible: at any moment, an operator looking
  at a draft knows exactly where it stands without reading anything else.

## 4. The step-by-step flow itself

**Step 0 — context handoff (outside the browser).** The UI never claims to
*run* the crawl itself — that happens in a live agent session via
`skills/mnemosyne-persona-interview`'s already-shipped crawl-then-propose
loop, invoked from the CLI/agent side (`mnemosyne persona draft propose`).
The Review Queue's empty state, when there are zero drafts, says exactly
this in one line of hint copy: *"No drafts pending. Ask an agent to propose
one (`mnemosyne persona draft propose ...` or the persona-interview skill),
or start one by hand below."* — pointing at the real mechanism instead of
inventing a chat box the vanilla-JS UI has no business building.

**Step 1 — Proposed.** The moment a `POST /persona/draft/...` lands, it
appears in the rail with step = Proposed. Selecting it shows, read-only:
- A pinned **provenance callout** at the top of the step panel — "Proposed by
  agent · `<proposedAt>`" plus the full `sourceSummary` text pu-07's bounded
  crawl produces, in its own bordered block, visually distinct from the
  persona fields below it. This block **never scrolls out of view** for the
  rest of this draft's review — it stays pinned in a slim left-hand strip of
  the step panel through Reviewing and Decision too, so provenance is never
  one click away, it's always on screen (lens 4, directly).
- The candidate fields themselves (displayName, scope, sections, parentRefs,
  repo) rendered read-only, in the same shape pw-17's form already uses.
- One button: **"Begin review →"**, which advances the stepper to Reviewing.
  Nothing is editable yet at this step — Proposed is a pure "here's what the
  agent found" checkpoint, deliberately separated from editing so an operator
  always sees the agent's unedited output at least once before touching it.

**Step 2 — Reviewing.** The same fields, now live-editable — this literally
*is* pw-17's create/edit form, retargeted to `PATCH` the draft instead of
writing directly (judgment call #4: one form, reused, not a second editor).
The provenance strip stays pinned alongside it. Two actions: **"Save
draft"** (persists edits, stays on this step — can be repeated any number of
times, mirrors "second POST to the same identity overwrites in place") and
**"Proceed to decision →"** (advances the stepper; does not itself commit
anything).

**Step 3 — Decision.** A compact, read-only recap of the draft's current
field values (post-edit) plus the still-pinned provenance strip. Two large,
visually distinct, explicitly-labeled buttons — never icon-only, given the
consequence (lens 3, 4):
- **"Approve — write to persona store"** — confirms via a plain
  `window.confirm`-style inline second click ("Approve `code-architect /
  mnemosyne`? This writes to the real store and cannot be undone from here."),
  then calls the approve route. On success, advances to Resolved and shows
  the real write target path.
- **"Discard — archive without committing"** — same confirm pattern, calls
  the discard route, advances to Resolved showing the archive path.

Both buttons are disabled with a tooltip ("save your edits first") if there
are unsaved changes pending from Step 2, so an operator can never approve
something they haven't actually looked at in its final form.

**Step 4 — Resolved.** Terminal card: "Approved into `<tier>/<scopeId>` at
`<timestamp>` — [view in Library →]" (deep-links back to tab 1, scrolled to
that row) or "Discarded — archived at `<timestamp>`". Resolved drafts drop
out of the rail on the Review Queue's next load (they're no longer
*pending*), but the terminal card stays visible for the remainder of the
current session so an approve/discard action never feels like it vanished
into nothing.

**Manual/human-authored drafts** (the `+ New draft` path) skip Step 1
entirely — there's no agent, no `sourceSummary` to show — and the stepper
reflects that structurally: the Proposed node renders dimmed/skipped rather
than lit, and the draft enters directly at Reviewing. The stepper itself is
the provenance signal here: a glance at which node a draft *started* from
tells the operator whether they're reviewing an agent's proposal or their own
draft, with no separate label needed.

## 5. Why this angle fits these users

Technical operators managing personas across tiers and repos are being asked,
for the first time in this tool, to approve content an *agent* produced and
that will go on to govern future agent behavior — that is a meaningfully
different cognitive task than scanning a table, and it deserves a surface
that answers "is this reviewed yet, by whom, based on what" without the
operator having to reconstruct it from a status column. Splitting Library
(fast, flat, unchanged) from Review Queue (slow, sequential, provenance-first)
lets each surface stay honest about what it's optimized for, instead of one
table trying to be both a scannable inventory and a lifecycle tracker at
once.
