# Selection — pu-01 multi-swarm design pass

**Selected: synthesized option 2** (`synthesized/option-2.md`, "Trust-Gated
Unified Queue").

pu-10, pu-11, and pu-12 build against this option. This selection is made
without an interactive operator available (design-discussion.md §9 judgment
call #2) — the reasoning below is the reviewable, reversible record of the
call, not a coin flip.

---

## How this was decided

I re-derived the comparison from source rather than trusting each synthesized
option's self-reported critique-response table at face value: read all 3
synthesized options in full, all 7 original critiques in full (not just the
excerpts quoted back inside the syntheses), and cross-checked each synthesis's
specific claims — "this closes gap X" — against what the cited critique
actually said. That cross-check surfaced a real, material difference between
option 2 and option 3 that isn't visible from reading the syntheses'
self-description alone (see "The deciding factor," below).

Evaluated against the three axes given for this call: (1) completeness against
the 7 lenses' actual findings, (2) buildability against this repo's real
zero-dependency vanilla-JS/HTML/CSS constraint, (3) service to the primary
real user — a technical operator triaging personas at real multi-tier,
multi-repo scale.

## Where all 3 options already agree (not a differentiator)

All 3 syntheses independently converged on the same base shape, which is
itself informative — it means the 7-lens panel drove real consensus, not
just noise:

- One panel, one merged live+draft table/list, no tabs, no route change, no
  two-pane master-detail (every lens that touched design-language-consistency
  ranked original Option 2's tab bar/inbox layout as this shell's biggest
  "foreign island" risk — none of the 3 syntheses repeat it).
- View/filter and group-by controls built from `.mode-toggle`'s existing
  `role="radiogroup"` idiom or plain `<select>`, never invented chip/tab
  widgets.
- Row expansion via the real `hidden`-attribute toggle idiom
  `#graph-inspector-detail` already uses — never the nonexistent `<details>`
  precedent original Option 1 incorrectly cited (design-language-consistency's
  own catch).
- Status rendered as real cell text, never a bare glyph.
- `{tier, scopeId}` / `{tier, repo, scopeId}` for `code-architect` as the row
  identity, `sourceSummary` shown verbatim under a plain-language "Why the
  agent proposed this" label, a current(live)-vs-proposed(draft) plain-text
  comparison for revision drafts, symmetric confirm-gating with
  identity-specific copy, `aria-expanded`/`aria-controls`/focus-management on
  expand, and a persistent post-approval provenance note.
- One review/approve surface absorbing pw-17's old create/edit form
  (design-discussion §9.4), never a second UI.

None of this favors one synthesis over another — it's shared ground. The
selection turns on where they diverge.

## Where they diverge, and why option 2 wins

**1. The core approve/discard gate — options 2 and 3 both correctly reject
option 1's compromise; option 1 does not.**

The single most severe finding across the whole critique set (named
independently by both `accessibility.md` and `agent-provenance-trust.md`) was
original Option 1's collapsed-row, icon-only, no-confirm approve — reachable
without ever having opened the drawer. `agent-provenance-trust.md`'s own
closing line states the fix explicitly: *"a synthesis that took Option 2's
non-editable first-look gate and grafted it onto Option 3's current-vs-
proposed comparison plus persistent post-approval provenance note would beat
either option standing alone."*

Synthesized options 2 and 3 both implement this literally: Approve/Discard
controls do not exist in the DOM at all until a non-editable "read the raw
proposal first" view has been shown at least once per session for that draft
identity — never a `disabled` attribute (both correctly cite
`accessibility.md`'s specific anti-pattern finding: `disabled` removes a
control from the tab order, hiding both the control and the reason for its
being inert from keyboard/AT users).

Synthesized option 1 instead uses `aria-disabled` + `aria-describedby` on an
always-rendered approve button, permanently un-gated the first time a row is
expanded in-session. This is a real, honestly-reasoned fix (and a better one
than a native `disabled` attribute) — but it is structurally weaker than
options 2/3's approach in a way option 1's own writeup does not fully own: the
gate is keyed to "this row has been expanded once this session," not "this
draft's current content has been read." A human who edits and re-saves a
draft, or an agent that re-proposes a revised draft after a human glanced at
an earlier version, keeps the identity permanently un-gated — approve can fire
on content that was never actually read. Given that lens 4
(agent-provenance/trust-calibration) exists specifically because this
interaction lets a human commit agent-authored content that will govern
future agent behavior, and design-discussion.md frames this as one of only
two deliverables this whole epic exists to build, a design that measurably
weakens that exact gate is the wrong one to build the rest of the epic
against, even though it is the fastest and least structurally invasive of
the three. This also matches the letter of design-discussion.md §4's own
tiebreaker framing for this surface: lenses 3/4 (accessibility,
agent-provenance-trust) are called out as "non-negotiable... not an
afterthought bolt-on" specifically because this interaction is new territory,
where lens 6 (design-language-consistency) is explicitly framed as the
weaker "don't become a foreign island" bar given there's no brand-system.yaml
to hold this UI to a harder standard.

**2. The deciding factor between options 2 and 3 — hierarchy-legibility
completeness.**

Both option 2 and option 3 build on original Option 3's backbone, which
`hierarchy-legibility.md` named the outright winner "by a clear margin." That
same critique named exactly two concrete, unfixed gaps in original Option 3:

- *"When grouped by Repo, the three global tiers collapse into one
  undifferentiated 'global' bucket, which could obscure the [tier]
  hierarchy."*
- *"The design doesn't address what happens when the default filter... hides
  the parent row entirely; the anchor could point at nothing visible without
  the operator realizing why."*

Checking each synthesis against these two specific, named gaps (not against
their own self-description):

- **Synthesized option 2 fixes both, concretely.** Repo-grouping keeps the 3
  global tiers as 3 separate, explicitly labeled sub-groups ("global — not
  repo-scoped") rather than collapsing them (§1). The parent-ref anchor, when
  its target is hidden by the active filter, resets the status filter to
  `All` and announces the reset via the same `aria-live` region rather than
  silently pointing at nothing (§5).
- **Synthesized option 3 does not fix either.** Its own §1 states the
  repo-grouping collapse is *"kept because no critique found fault with the
  toggle-without-refetch mechanic itself"* — which elides that the critique's
  fault was with the collapse, not the toggle mechanic. Its own §2 fixes only
  the *focus-vs-scroll* half of the parent-anchor finding (an
  `accessibility.md` point), not the filtered-out-target half
  (`hierarchy-legibility.md`'s actual finding). Option 3's own §4 claims to
  fix "the two concrete gaps this critique found in initial Option 3," but
  the two things it actually fixes (canonical-tier-order sort, an
  always-visible Repo column) are gaps `hierarchy-legibility.md` raised
  against *original Option 1*, not against original Option 3 — the two real
  Option-3-specific gaps the critique named are the ones listed above, and
  they carry forward into synthesized option 3 unresolved.

This matters more than it might look like on the surface: hierarchy
legibility across tiers/repos/`parentRefs` is not a generic UI-polish lens
here — design-discussion.md §4 frames it as testing "whether the design
scales and orients correctly... not just whether it looks fine for the
3-persona demo case," i.e. it is a direct proxy for whether the redesign
actually serves this tool's real, stated reason for existing (personas that
orchestrate across projects/companies/repos) at real scale, for the
technical operator who is this epic's primary user. Option 2 is the only one
of the three that closes both of that lens's specific findings against the
structure all three descend from.

**3. Secondary point in option 3's favor, weighed and found non-decisive.**

Option 3 is marginally more disciplined about control-surface economy: it
narrows the group-by control to 2 axes (`View`/`Group by`), explicitly
dropping "Status" as a third grouping mode because it overlaps with the
`View` filter — a direct response to `design-language-consistency.md`'s
complaint about original Option 3 stacking three simultaneous view-control
axes. Option 2 keeps a 3-way `group by: Tier/Repo/Status` radiogroup
alongside a separate `status:` filter `<select>`. This is a real, legitimate
economy point for option 3 — but on inspection it's a smaller cost than it
first appears: "group by Status" and "filter by status" are not fully
redundant (grouping shows all 3 status buckets with headers at once; filtering
hides everything but one), and design-language-consistency's own critique of
the original was about a single *row* of three stacked axes, not about the
mere existence of two separate, independently-labeled controls elsewhere in
the panel. Weighed against option 2's concrete completeness advantage on
hierarchy-legibility — a lens this pass's own framing treats as closer to the
core of what this tool is for — this is a real but non-decisive difference in
option 3's favor, not enough to overturn the finding in §2.

## Buildability (all 3 are buildable; option 2 is not the more expensive pick)

All 3 synthesized options are genuinely buildable with this repo's
zero-dependency vanilla JS/HTML/CSS constraint — none introduces a build step,
a framework, or a component library. Concretely for option 2:

- Merged `GET /persona` + `GET /persona/draft` fetch, identical shape to what
  `loadPersonas()` already does (`ui/app.js`).
- `group by` (radiogroup) and `status` (native `<select>`) are both idioms
  already present in this file (`.mode-toggle`, `#reindex-lane`'s selects) —
  zero new CSS component families.
- The accordion reuses the real `hidden`-attribute toggle idiom
  `#graph-inspector-detail` already uses.
- The one genuinely new element, a `<details><summary>` glossary block, is
  small, native, and honestly introduced as new (rather than option 1's
  original mistake of claiming false precedent for a similar mechanism) —
  the design-language-consistency critique's own stated preference between
  those two postures.
- Session-scoped "has this draft been read yet" tracking and the "reviewed,
  ready to commit" batch strip are both plain client-side JS state (a `Set`
  of read identities) — no new persistence, no new route beyond the 4 already
  specified in design-discussion.md §3b/§9.9 (`GET /persona/draft`,
  `GET /persona/draft/:tier/:scopeId`, the existing `POST .../approve`,
  `POST .../discard`).
- Batch approve issues the same approve calls the single-row path already
  uses, then reloads once — no new write path, matching this epic's own
  explicit non-negotiable (design-discussion.md's Risks table: never a
  second, divergent write path).

This is comparable in real implementation cost to option 3 and only modestly
more than option 1 — the marginal cost buys a materially stronger trust gate
and a more complete hierarchy-legibility story, which is a good trade for a
tool whose whole reason to exist is multi-tier/multi-repo persona
orchestration reviewed by a human before it can govern future agent behavior.

## Bottom line

Synthesized option 2 is the most complete answer to the two lenses this
specific epic exists to get right (agent-provenance/trust-calibration,
accessibility) — tied with option 3 there — and is strictly more complete
than option 3 on the lens most tied to this tool's actual reason for
existing (multi-tier/multi-repo hierarchy legibility), a difference verified
by checking its claims against the underlying critique text rather than
taking its own summary at face value. Option 1 is the most buildable and
best serves raw operator click-count, but does so by measurably weakening the
one interaction (human-approves-agent-output) this epic was explicitly
commissioned to get right, which is disqualifying given design-discussion.md's
own framing of that interaction as one of only two deliverables this epic
exists to build. Option 3's control-surface economy is real but smaller than
its own hierarchy-legibility shortfall.

**pu-10, pu-11, and pu-12 build against synthesized option 2
(`synthesized/option-2.md`, "Trust-Gated Unified Queue").**
