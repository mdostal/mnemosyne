# Option 3 — Unified Review Queue

**Angle:** one continuous structure holds every persona identity — committed
and drafted — differentiated by a status badge, not by which panel you're
looking at. Hierarchy (tier → repo → scopeId → parentRefs) and review state
(live / needs-review / history) are two axes of the *same* list, not two
different UIs a human has to reconcile in their head.

## 1. Overall layout / navigation

The existing two-block layout (a read-only table, then a separate "Create /
edit persona" form below it) is replaced by **one panel, one list, one
detail surface** — no second scroll-down section, no modal, no route change.

```
┌─ Personas ──────────────────────────────────────────────────────────────┐
│ status: [ Needs review (2) ● ] [ Live ] [ All ] [ History ]             │
│ group by: ( Tier ●  Repo  Status )                    [ + New draft ]  │
├───────────────────────────────────────────────────────────────────────┤
│ ▾ top-orchestrator (1)                                                  │
│   ◐ NEEDS REVIEW   mnemosyne-co        Mnemosyne Top Orchestrator   ▸  │
│ ▾ company-director (1)                                                  │
│   ● live            pantheon           Pantheon Company Director    ▸  │
│ ▾ project-orchestrator (2)                                              │
│   ● live            mnemosyne-project  Mnemosyne Project             ▸  │
│   ◐ NEEDS REVIEW   swarm-memory-proj   Swarm-Memory Project (new)    ▸  │
│ ▾ code-architect — /repo/mnemosyne (3)                                  │
│   ● live            mnemosyne          Code Architect — mnemosyne    ▸  │
│   ...                                                                   │
├───────────────────────────────────────────────────────────────────────┤
│ ▸ [row expanded in place — see §2/§3 below]                             │
└───────────────────────────────────────────────────────────────────────┘
```

- **Grouping** (`Tier` / `Repo` / `Status`) is a toggle over the *same*
  underlying rows, not a different fetch or a different page — switching
  it just re-buckets what's already loaded. `Tier` is the default (matches
  the domain model everywhere else in this UI); `Repo` regroups
  `code-architect` rows by their `repo` field with the 3 global tiers
  collapsed into a single "global" bucket; `Status` flattens all grouping
  and sorts purely by badge (Needs review → Live → History), for a
  triage-first scan.
- **Status filter chips** narrow the same list rather than navigating away.
  `Needs review` is the default landing filter with a live count badge —
  an operator opening this panel sees pending work first, not a wall of
  already-settled personas they have to scroll past.
- **Sticky group headers** keep tier/repo context visible even when a row
  is expanded or the list is scrolled — hierarchy never disappears just
  because you're mid-review of one row.
- `History` (approved/discarded drafts) is collapsed out of every other
  filter by default — archived-by-move per §3b's disposition model, so it
  still exists and is one click away, it just doesn't compete for
  attention with active state.
- **No separate create/edit form section.** `+ New draft` and every
  existing row's expand arrow open the *same* accordion editor described
  in §3 — one editor, reached two ways, per judgment call #4.

## 2. How the list represents both committed personas and pending drafts

Each row is one **identity** (`{tier, scopeId}`, or `{tier, repo, scopeId}`
for `code-architect`), never one *record*. The UI fetches `GET /persona`
(live) and the new `GET /persona/draft` (list) and merges them by identity
before rendering, so a single row can carry either or both:

| Badge | Meaning | Underlying state |
|---|---|---|
| `● live` | Committed, no pending draft | real store only |
| `◐ needs review` | A pending draft exists | draft store only, or draft store overwriting an existing live record (badge text becomes "◐ needs review — revision") |
| `○ history` | Archived (approved-and-superseded-by-nothing-new, or discarded) | `approved/` or `discarded/` subtree, filter-only, muted styling |

Columns stay the same 4 the current table already has (Tier, Scope ID,
Display name, Parent(s)) plus the new Status badge as the leftmost column —
deliberately not a 5th panel or a colored border trick, so screen readers
get the state as actual cell text, not decoration (accessibility lens).
`Parent(s)` stays pointer-only text exactly as today (tier + scopeId, never
fetched content) — but where the named parent also has a row in this same
queue, it renders as an in-page anchor that scrolls to and flashes that row,
reinforcing hierarchy without a second fetch or a new page.

## 3. Interaction flow: crawl → propose → review → edit → approve

1. **Crawl + propose (agent-side, unchanged mechanics).** An operator runs
   the already-shipped `mnemosyne-persona-interview` skill from a live agent
   session. Its bounded crawl (§3c: README, manifest, CLAUDE.md/AGENTS.md,
   parent summary via query-up) produces a candidate persona plus a short
   `sourceSummary`. Per the draft-first default, it calls
   `mnemosyne persona draft propose` instead of committing directly — this
   UI does not add a "start a crawl" button; that trigger stays where the
   repo's own design already puts it (an agent session with shell-out), and
   the panel's hint text says so explicitly rather than implying a button
   exists.
2. **Appears in the queue.** The next `GET /persona/draft` poll/load surfaces
   the new draft as a `◐ needs review` row, sorted to the top of its tier
   group under the default `Needs review` filter — an operator opening the
   panel sees it without hunting.
3. **Review — expand in place.** Clicking the row's `▸` expands an accordion
   directly under it (table stays in view, no navigation, no modal):
   - **Source summary block**, labeled *"Why the agent proposed this"* —
     the bounded crawl's `sourceSummary`, rendered verbatim in a quoted
     block. This is the one piece of UI that exists nowhere else in the
     app and is the concrete answer to the agent-provenance/trust lens.
   - **Provenance line**: `Proposed by agent · <timestamp>` for an
     agent-authored draft, or `Manually created · <timestamp>` for one
     started via `+ New draft` — always visible, never inferred.
   - **Current vs. proposed**, only when a live record already exists at
     this identity: two labeled stacks (`Current (live)` / `Proposed
     (draft)`) rendering `displayName`, `scope`, and each `sections`
     entry — plain stacked text, not a diff library, since a byte-diff of
     prose sections is less legible than reading both in full at this
     scale. For a brand-new identity (no live record), only `Proposed` is
     shown, headed *"New persona — nothing live yet."*
   - **Editable fields**, pre-filled from the draft: displayName, scope,
     repeatable heading/body section rows (add/remove row), parentRefs,
     repo — the same field set pw-17's form already collects, just living
     inside the expanded row instead of a separate section.
4. **Edit.** Operator changes any field inline, clicks `Save edits` — a
   `PUT` to the same draft identity (overwrite-in-place, §3b). Row stays
   `◐ needs review`; a `panel-status` pass/fail line inside the accordion
   confirms the save, matching every other form in this UI. Nothing is
   committed yet — `assertValidPersona` is still not invoked.
5. **Approve.** Operator clicks `Approve` (native `confirm()` — no new
   dialog component needed for a zero-dep UI). `POST
   /persona/draft/:tier/:scopeId/approve` runs the edited candidate through
   the real `assertValidPersona` gate for the first time, writes it via the
   unchanged `writeGlobalPersona`/`writeRepoLocalPersona` primitive, fires
   `remember()` on the `sourceSummary` (agent-authored drafts only, per
   OQ3's resolution), and archive-moves the draft file. The queue reloads;
   the row flips to `● live`, collapses, and keeps a one-line "originally
   proposed by agent, approved <date>" provenance note even after landing —
   provenance doesn't vanish just because review finished.
6. **Discard (alternative to 5).** `Discard` archive-moves the draft to
   `discarded/` without touching the real store. The row drops out of
   `Needs review` and `Live`, reappearing only under the `History` filter —
   never hard-deleted, matching this codebase's flight-status posture.
7. **Manual authoring, same surface.** `+ New draft` (for a fresh identity)
   or `Edit` on an existing `● live` row (which pre-fills the same
   accordion editor from the live record and creates a draft revision on
   first save) both land in the identical accordion editor as step 3, minus
   the source-summary block and with `Manually created` as the provenance
   line. One editor, one review/approve control pair, for both authoring
   paths — judgment call #4, not two UIs to keep in sync.

## 4. Why this angle fits these users

The people using this panel are technical operators managing a persona
hierarchy across four tiers and multiple repos at real (not toy-demo) scale,
where the actual daily task is triage — "what needs my attention right now,
and where does it sit in the tree" — not admiring a document. Collapsing
review-state and hierarchy into one sortable, filterable structure means an
operator can answer both "what's pending" and "where does this fit" from a
single scan instead of cross-referencing a drafts panel against a separate
persona-tree panel, and it scales honestly: as the store grows past today's
handful of personas, the same list keeps working by re-filtering and
re-grouping rather than needing a new view per axis.
