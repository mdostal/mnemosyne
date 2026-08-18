# Visual Identity Cohesion — critique

Lens only: does the amber-gold accent (`--accent: #D8A84E`, replacing the old blue `#7aa2f7`)
read well against `--bg` (#0f1115) / `--panel-bg` (#171a21), stay visually distinct from
`--pass` (#4fd17a green) and `--fail` (#ff6b6b red) wherever status and accent sit near each
other, and get applied consistently across every button/link/highlight? All three files define
the same base tokens (`--bg`, `--panel-bg`, `--border`, `--text`, `--muted`, `--pass`, `--fail`,
`--accent: #D8A84E`), so the starting palette is identical in all three — the differences below
are entirely in *how much surface area* each option gives the accent and *where it ends up
sitting next to a status color*.

One colorimetric fact worth keeping in mind throughout: `--accent` (#D8A84E, hue ≈ 40°) sits only
~40° away from `--fail` (#ff6b6b, hue ≈ 0°) on the hue wheel, both in the warm family, and at
roughly the same lightness (~60–70%) as `--pass` and `--fail`. `--pass` (hue ≈ 140°) is the outlier,
~100° away from accent. In practice this means amber-vs-green pairings read as effortlessly
distinct, while amber-vs-red pairings ask a little more of the eye — they're two warm, similarly
bright colors rather than a clean warm/cool split. That makes amber+red adjacency the higher-risk
case to look for in each mockup, more than amber+green.

---

## collapsible-clusters

**Amber-on-dark legibility:** Good. Amber is used for the header Refresh button, the disclosure
triangle (`▸`) on all three cluster `<summary>` headers (permanently amber, not just on
hover/open), summary hover/focus color, every primary `<button>`/`.btn` fill, the
`persona-action-btn` text color (Edit/Remove/Review), the `agent` badge fill on the inline draft
review panel, and the `personas-glossary` disclosure link. Against `#0f1115`/`#171a21` it reads
clean and warm, no muddiness.

**Where it could collide with status color and doesn't:** The Personas table's Status column
(`live`, `needs-review`) is rendered as **plain mono text with no color at all** — not amber, not
green. Only the panel-level summary lines (`panel-status.pass`, e.g. "OK — 6/6 checks passed",
"9 personas (2 pending review)") get the green `--pass` treatment. Because per-row status in this
option carries no color, there is no amber-vs-green-vs-red adjacency risk anywhere in the persona
list, lane table, or Memory Levels table (levels 0–4 "status" column is also plain mono "active"
text, uncolored). This sidesteps the collision question entirely — but it does mean this option
does *not* extend the amber accent into status/badge territory the way the other two do, so the
palette feels a little "flatter" here: accent = chrome/interaction only, never status.

**Best-considered accent-vs-fail pairing in the set:** This is the only one of the three mockups
that renders the inline draft-review affordance (`Why the agent proposed this` → Approve/Discard).
`Approve` uses `persona-action-btn` (amber text, outline button); `Discard` adds
`.destructive { color: var(--fail); }`. Amber-accept vs. red-reject sitting side by side in one
control cluster is a genuinely good, purposeful use of the fail token *as* fail (a real negative
action), distinct from the accent's affirmative/interactive meaning — and the two are easily told
apart (amber outline button vs. red-text button, same shape, different color, clear intent).

**Partial-application note:** the jump nav (`#cluster-nav a`) is NOT amber at rest — links are
`color: var(--text)` (off-white) and only turn `--accent` on `:hover`/`:focus-visible`. In the
screenshot, "Jump to / System / Memory / Personas" reads in neutral grey/white, not gold; amber
only appears once you interact. Compare to minimal-jump-chips, where every chip has a small but
permanently-amber dot even at rest. This is a legitimate, defensible interaction pattern (amber =
"you're touching this"), but it does mean a static view of this option shows amber only in the
triangle markers and the Refresh button — the least amber-forward of the three at first glance.

---

## sidebar-glanceable

**Amber-on-dark legibility:** Good, same base contrast as the other two — the persistent sidebar's
`.nav-item.active` state (left border + tinted background `rgba(216,168,78,0.12)` + amber text +
bold weight) reads clearly against the dark rail, and the hover tint (`rgba(216,168,78,0.08)`) is
subtle enough not to fight with the active state.

**The one real color-semantics problem in the set:** this option is the only one that puts a
`--pass`/`--fail`/`loading` **status badge on every single nav item, permanently visible at once**
in the left rail (`.status-badge.pass/fail/loading`), not just inside the currently-open panel.
That is exactly the "badges near each other" scenario this lens is meant to catch, and it surfaces
a real inconsistency: the Personas nav item's badge is `status-badge fail` (red, text "fail"), and
the Personas panel's own summary line is `panel-status fail — 2 drafts need review` (red) — but a
"draft awaiting review" is not a failure or an outage; it's a normal, expected workflow state.
Inside that same panel, the *per-row* draft status uses `persona-tag.needs-review`, which is
**amber** (`background: rgba(216,168,78,.18); color: var(--accent)`), not red. So the same
underlying condition — "this persona draft needs review" — is painted **red** at the nav-badge and
panel-summary level, and **amber** at the row level, inside one option. Since `--fail` (red) is
used everywhere else in this design purely for real breakage (a liveliness check failing, a
Qdrant/config error), reusing it here for a routine review queue teaches the user the wrong
lesson: a red dot in the persistent sidebar should mean "something is broken," and here it fires
for "two drafts are waiting," which will read as more alarming than the situation warrants and
undercuts the pass/fail palette's meaning everywhere else in the app. It also means that when the
Personas row is the *active* one, the row simultaneously carries the amber "you're here" treatment
(border/tint/text) and a red "fail" pill a few pixels to its right — accent and fail sitting
directly adjacent in a 240px-wide row, for a non-error condition.

**Everywhere else amber is applied consistently:** header Refresh button, every `.btn`/primary
button (Add lane, Search, Save draft, Reindex…, Refresh config cache, graph `go-btn`),
`.btn-secondary:hover` border/text, `.action-btn` (Edit/Remove/Review) text color,
`persona-group-header` row label color, `personas-glossary summary` color, and the graph's default
node fill (`.graph-node circle { fill: var(--accent); }`). Focus-visible outlines are amber
throughout. This is the widest, most systematic amber coverage of the three files by raw
`var(--accent)` occurrence count (18, vs. 16 in minimal-jump-chips and 14 in collapsible-clusters).

**Graph view — accent/pass/fail all in one small diagram:** the inline SVG graph renders default
nodes filled amber (`--accent`), the `.selected` node filled red (`--fail`, radius bumped to 9),
and the `.focus` node with a green stroke ring (`--pass`, 3px). All three status-adjacent colors
appear together in a ~320×220 diagram with only 4 nodes. Visually the shapes/positions make it
readable (fill vs. stroke, size difference), but conceptually it borrows the pass/fail vocabulary
for interaction state (selected/focus) that has nothing to do with system health — a red node here
means "currently selected," not "broken," which is a second instance (after the sidebar badge) of
this option reusing `--fail` for a non-failure meaning.

---

## minimal-jump-chips

**Amber-on-dark legibility:** Good, and the most *considered* implementation of the three at the
token level — this is the only file that defines a paired `--accent-ink: #1a1405` token for
text-on-amber, rather than hard-coding `#10131a` inline on every button rule as the other two do.
Purely cosmetic difference (both inks are near-black and look identical on screen) but it signals
more systematic palette thinking, and the file's own header comment explicitly states the intent:
"accent swapped from blue #7aa2f7 to amber-gold #D8A84E everywhere."

**Amber is genuinely everywhere:** generic `a { color: var(--accent); }` (only file with a global
link rule), the jump-chip bar's small `.chip-dot` (permanently amber on all 8 chips, not just on
hover — the most amber-forward nav treatment of the three at rest), every `.panel > h2 .eyebrow`
index number (01–08), every primary button, `#graph-toolbar .btn-primary`, `persona-action-btn`,
`persona-parent-link` (defined, though unused in the markup — dead CSS, not a visible issue),
`persona-agent-label` (solid amber fill), and the default graph node fill. This is the most
uniform "accent = every clickable/highlighted thing" story of the three.

**Where that thoroughness creates its own status-color problem:** the Memory Levels table (levels
0–4) reuses the exact persona-domain class `status-pill.needs-review` — amber, same visual
treatment used for "a persona draft needs review" — to label a completely different concept: row 4
("File doc store") reads **"Degraded"** in amber, directly under three green "Active" pills in the
same column. Visually amber-vs-green here is easy to tell apart (confirmed by the hue-distance
point above), so it isn't a legibility failure. But it is a semantic overload: by the time a user
reaches this table, amber has already been trained to mean "interactive/accent" (buttons, links,
chip dots) *and* "a draft awaiting human review" (Personas). Now it also means "this store is
unhealthy" — a warning/degraded-health state that, everywhere else in this file and in the other
two mockups' Liveliness panels, is exactly what `--fail` (red) is for. None of the other two
options reach for amber to mean "degraded": collapsible-clusters renders Memory Levels status as
uncolored plain text, and sidebar-glanceable's Memory Levels table has no degraded row at all
(everything is green "active"). minimal-jump-chips is alone in stretching the accent color into
health-status territory, which is the one place this lens says accent should stay out of.

**Same double-amber-in-one-row pattern as sidebar-glanceable's `.persona-tag`:** the two
`agent-proposed` draft rows show a solid-fill amber `persona-agent-label` next to the display name
*and* an amber-tinted `status-pill.needs-review` in the Status column of the same row — two
different amber treatments (solid badge vs. translucent pill) in one row. Read charitably this is
a coherent double-signal ("this whole row is a pending draft"); read less charitably it's a busier,
more repetitive use of the same hue than either of the other two files attempts.

**Graph view:** identical pattern to sidebar-glanceable — default nodes amber, `.selected` node
red (`--fail`), `.focus` node green-ringed (`--pass`) — same finding, same caveat about borrowing
health-status colors for selection state applies equally here.

---

## Ranking (visual-identity-cohesion lens only)

1. **collapsible-clusters** — cleanest amber-to-status separation of the three. By keeping all
   per-row status as plain uncolored text and only coloring panel-level summaries green, it never
   creates an amber/red/green adjacency problem anywhere in the document, and its one deliberate
   accent-vs-fail pairing (Approve/Discard) is the best-judged use of the fail token in the whole
   set. Its cost is that amber coverage is the thinnest of the three (14 occurrences, nav links
   amber only on hover) — a legitimate, defensible restraint rather than an accident, but it means
   less of the surface actually *looks* re-themed at rest.

2. **minimal-jump-chips** — the widest, most uniform "amber on every interactive/highlighted
   element" execution (global `a{}` rule, permanently-lit chip dots, dedicated `--accent-ink`
   token), and the amber-vs-green contrast it introduces (Degraded pill under three Active pills)
   is legible on its own terms. It loses ground for being the only option to let the accent color
   drift into health-status meaning ("Degraded"), a job `--fail` should be doing, which is a direct
   hit against "stays distinct from pass/fail in meaning," even though the color itself stays
   visually distinct in appearance.

3. **sidebar-glanceable** — the broadest raw amber coverage (18 occurrences) and the most
   systematic active-state treatment, but it's the only option with a genuine status-color
   consistency fault: the same "draft needs review" condition is red (`--fail`) at the persistent
   nav-badge/panel-summary level and amber (`--accent`) at the row level, and that red badge sits
   permanently visible, immediately beside the amber "active" highlight, for a non-error condition.
   That's the sharpest, most concrete instance in the whole set of accent and status color meaning
   actually colliding rather than merely sitting near each other.

## Strongest option(s) through this lens alone

**collapsible-clusters** is the strongest single choice purely for cohesion: it introduces the
amber accent without ever letting it (or the pass/fail pair) blur into an ambiguous or
mismatched-meaning situation, and its one status/accent pairing that does exist (Approve/Discard)
is the most intentional use of the full three-color system in any of the three files.

If amber coverage/thoroughness is weighted more heavily than avoiding all status ambiguity,
**minimal-jump-chips** is the runner-up — its accent application is the most complete and
systematic, and its one lapse (amber "Degraded") is a meaning problem, not a legibility one.
**sidebar-glanceable** should be ranked last on this lens specifically because of the red/amber
status-meaning conflict around the Personas draft-review state — that is a fixable bug (recolor
the nav badge and panel-status to amber, matching the row-level treatment, and stop coloring
"needs review" as "fail"), but as shipped it's the one real cohesion defect in the set that isn't
just a stylistic difference in how much surface area amber covers.
