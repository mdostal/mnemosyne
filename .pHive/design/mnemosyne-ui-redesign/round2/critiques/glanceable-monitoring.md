# Round 2 critique — lens: Glanceable Monitoring

**Question asked of every candidate:** while an operator's attention is elsewhere on the
page (or off it), how much real state from Liveliness / Settings / Operations (and, by
extension, the other monitoring surfaces) stays passively visible, versus how much is
fully hidden and requires a click before *any* information is available? Where a
round-1 fix added a status signal specifically to close that gap, does the signal
actually work — correct at rest, correct under collapse, and semantically honest (no
color reused across different severities)?

Read directly from the four current HTML files; no screenshots, no reliance on the
round-1 writeups.

---

## 1. Collapsible Clusters (hardened)
`collapsible-clusters-hardened.html`

**Structure.** Three `<details class="cluster" open>` accordions — System (Liveliness,
Settings, Operations), Memory (Lanes, Search, Graph, Memory Levels), Personas
(Personas) — each with a sticky jump-nav (`#cluster-nav`, lines 59–106) above them.
All three ship `open` in this mockup (lines 533, 610, 719), so in the *default* state
every panel's full detail is on-screen exactly like a flat document.

**Round-1 fix check — "missing status signal on collapse."** Confirmed fixed at the
mechanism level: each `<summary>` now carries a `.cluster-status-dot` (lines 533–534,
610–611, 719–720), e.g.:
```
<summary><span class="cluster-status-dot pass" title="All System panels passing"></span>System …</summary>
```
Because a `<summary>` is the only part of a closed `<details>` that stays rendered, this
dot **does** survive collapse — collapsing "System" no longer blacks out its status the
way round 1 flagged. That gap is genuinely closed.

**But the fix only buys 3 bits of resolution for 8 panels.** The clusters bundle 3, 4,
and 1 panels respectively. A single dot on "Memory" cannot tell you *which* of Lanes /
Search / Graph / Memory Levels is the problem — you still have to expand and
visually re-scan all four. Compare this to a per-panel signal (sidebar-glanceable):
this candidate trades resolution for simplicity of the nav.

**A found inconsistency that undercuts the fix's trustworthiness.** The Personas
cluster dot is styled `review` (amber, "2 persona drafts need review," line 720), but
the panel underneath it uses the `pass` (green) status class with text that undersells
the same fact:
```
<p class="panel-status pass">9 personas (2 pending review)</p>   <!-- line 725 -->
```
An operator who glances at the amber dot, expects a problem, expands the cluster, and
is met with a green "pass" line has just learned the dot oversells severity relative to
the content it summarizes — exactly the kind of mismatch that erodes trust in a passive
glance over time. It's a smaller version of the same "signal says one thing, content
says another" defect round 1 found in sidebar-glanceable's persona badge, just moved to
a different pair of elements.

**Other note.** Operations (bundled inside "System") has no `panel-status` line at all
(lines 566–602) — no candidate models a health signal for it, so this isn't a
differentiator, just a shared blind spot worth flagging once.

---

## 2. Sidebar Glanceable (hardened)
`sidebar-glanceable-hardened.html`

**Structure.** A persistent left `nav#panel-nav` (`role="tablist"`, line 467) lists all
8 panels as buttons, each carrying its own `.status-badge` (lines 471, 475, 479, 483,
487, 491, 495, 499). Only one `section.panel` is `display: block` at a time (`.panel {
display: none }` / `.panel.active { display: block }`, lines 159–168); the rest are
fully hidden from the DOM's rendered output regardless of scroll position.

**Round-1 fix check — ARIA tab semantics.** Confirmed fixed: real `role="tablist"` /
`role="tab"` / `role="tabpanel"`, `aria-selected`, `aria-controls`, `aria-labelledby`,
`tabindex="0"` are all present and correctly paired (lines 467–499 ↔ 506–920). This is
an accessibility fix, not directly a glanceable-monitoring one, but it doesn't
regress anything here.

**Round-1 fix check — no-JS fallback.** Confirmed fixed, and it happens to matter for
this lens: `<noscript><style>.panel { display: block !important; }</style></noscript>`
(line 938) means that *without JS* every panel renders simultaneously, converging on
the same "everything visible" pattern as minimal-jump-chips/hybrid. With JS running
(the expected case), the tab behavior (lines 923–936) is back to single-panel-visible.

**Round-1 fix check — review/fail badge color.** Confirmed fixed at the nav-badge
layer: `.status-badge.review` uses `--accent` (amber) and is visually distinct from
`.status-badge.fail` (red) — see lines 146–148, and the Personas nav badge correctly
reads `<span class="status-badge review">review</span>` (line 495).

**But the fix is incomplete — it wasn't applied to the panel's own status line.**
Inside the Personas panel itself, the equivalent status text still uses the *old*,
unfixed wording and color:
```
<p class="panel-status fail">fail — 2 drafts need review</p>   <!-- line 712 -->
```
So the sidebar badge (glanceable surface) now correctly says "review" in amber, but
clicking into that same panel shows a red "fail" line describing the identical
condition. This is a real, still-live half-fix: the exact color-semantics bug round 1
cited was patched in one component and left in the other. For *this* lens specifically
it matters less than it would for visual-identity-cohesion, because the glanceable
surface (the badge) is the one that got fixed — but it does mean an operator's glance
and their subsequent click tell contradictory stories, which is its own kind of
glanceability failure (you can no longer trust that opening a panel confirms what the
badge implied).

**Structural ceiling for this lens.** Even fully fixed, this is a single-active-panel
pattern: at any moment 7 of 8 panels have zero content rendered — not just collapsed,
literally `display:none` (line 160) — and every one of Liveliness/Settings/Search/
Graph/Operations/Personas/Memory Levels' actual detail (the six-line health checklist,
the config `dl`, the search result table, the graph inspector, the reindex form) is
fully invisible and gated behind a click except for the one active tab. The sidebar
gives you a good one-line-per-panel *status summary* — best resolution of the four
candidates — but it is a summary, not the underlying state. This is the largest amount
of real state rendered click-gated of the four candidates, by construction of the tab
pattern itself; no amount of ARIA/badge-color fixing changes that trade-off.

---

## 3. Minimal Jump Chips (unchanged base)
`minimal-jump-chips-unchanged.html`

**Structure.** No collapsing, no tabs, no `display:none` anywhere for panel content.
`nav#jump-chips` (lines 496–504) is a sticky set of anchor links into one continuous
document; every one of the 8 `<section class="panel">` blocks renders its full content
unconditionally, all the time. Nothing is behind a click — the only "cost" to see any
given panel is scroll position, not an interaction.

**Round 1 assessment holds up on rereading**: this genuinely is maximal glanceability
by construction. Liveliness's full 6-line checklist, Settings' full `dl`, the Search
result table, the Graph node inspector, the persona table with Live/Needs-review/
History rows — all simultaneously present in the DOM with no gating.

**What's still missing (a nav-level gap, not a content-hiding one).** The chips
themselves carry no status information — `<a href="#liveliness"><span
class="chip-dot"></span>Liveliness</a>` (line 497) and identically for all 8 — just a
uniform amber dot. So you cannot tell from the sticky nav alone, without scrolling,
whether anything is currently degraded. This was called out in round 1 as a
nav-wayfinding gap; it's real, but it's a lesser defect for *this specific lens* than
for sidebar/collapsible-clusters, because nothing here requires a click to reveal — a
scroll (not an interaction, no state change) still surfaces it.

**An unfixed color-semantics wrinkle that does bear on this lens.** The Memory Levels
table reuses the "needs review" pill class to also mean "degraded":
```
<tr><td>4</td><td>File doc store</td><td class="mono-col">flat files</td><td><span class="status-pill needs-review">Degraded</span></td></tr>   <!-- line 929 -->
```
`.status-pill.needs-review` is amber (line 434) — the same amber used for a persona
draft awaiting review (lines 799, 824). At a glance, color alone can no longer
distinguish "an actual store outage" from "a routine draft waiting on a human." The
text still says "Degraded" so the information isn't literally hidden, but the
glance-by-color heuristic this whole lens cares about is compromised — an operator
scanning for amber-vs-red severity will misjudge this row every time.

---

## 4. Hybrid (finalist-3 rings + finalist-2 graph colors)
`hybrid-rings-original-graph-colors.html`

**Structure.** This is minimal-jump-chips' base, explicitly preserved unchanged per
its own header comment (lines 1–9): same flat, always-rendered `main`, same
`.panel-status` idiom, same panel order. Nothing added here removes visibility from
Liveliness/Settings/Operations or any other panel — confirmed by inspection: `main >
.panel` has no `display:none` rule anywhere in the stylesheet, and the only
`<details>` in the whole document besides the pre-existing `personas-glossary` is
`#persona-tools` (line 947), which wraps only the *write*-oriented draft-editing form
and the retrieval-stack sub-content — the real, read-oriented persona status table
(Live/Needs-review/History rows, lines 866–936) sits above it, fully visible,
untouched. It also defaults `open` (line 947), so even that one collapse point starts
expanded.

**Round-1-gap fix — nav status rings.** `nav#jump-chips` chips now carry
`chip-pass`/`chip-fail` classes with a colored ring around the dot (lines 186–187):
```
nav#jump-chips a.chip-pass .chip-dot { box-shadow: 0 0 0 3px rgba(79, 209, 122, 0.45); }
nav#jump-chips a.chip-fail .chip-dot { box-shadow: 0 0 0 3px rgba(255, 107, 107, 0.55); }
```
Checked every chip against its panel's real `.panel-status` text for faithfulness
(not fabricated at the nav level, per the file's own comment at lines 181-184):
Liveliness/Settings/Lanes/Personas → `panel-status pass` → `chip-pass` (lines 612, 622,
634, 828 ↔ 601–604, 608); Memory Levels → `panel-status fail` ("1 store degraded," line
1028) → `chip-fail` (line 609); Search/Graph/Operations have no status text at all in
any candidate, and correctly get **no** ring rather than a fabricated one (line
606–608). This closes minimal-jump-chips' one real nav-glance gap without touching the
full-visibility guarantee: you now get real per-panel severity at a glance from the
sticky nav *and* full detail is still one scroll (not a click) away for anything the
ring flags.

**Round-1-gap fix — the amber-ambiguity color bug.** The Memory Levels "Degraded" row
now uses a dedicated, distinct class:
```
.status-pill.degraded { background: rgba(255, 107, 107, 0.15); color: var(--fail); }   <!-- line 499 -->
…
<span class="status-pill degraded">Degraded</span>   <!-- line 1047 -->
```
red, separate from `.status-pill.needs-review` (amber, line 493) used for persona
drafts. This is the exact defect flagged in minimal-jump-chips above, fixed here —
color now reliably tracks severity across both persona-review and store-health states.

**Net effect for this lens.** Same zero-click, fully-flat visibility as
minimal-jump-chips (nothing hidden behind an interaction, ever), plus a working,
verified, panel-sourced ring signal in the nav, plus the one color-semantics bug that
survived in minimal-jump-chips is fixed here. The optional IntersectionObserver
scroll-spy (lines 1058–1084) is explicitly guarded (`if (!('IntersectionObserver' in
window)) return;`) and every chip degrades to a plain anchor if it never runs — so
glanceability doesn't regress even with JS off, unlike sidebar-glanceable where the
base (non-noscript) experience is single-panel.

---

## Ranking for this lens

1. **Hybrid (finalist-3 rings + finalist-2 graph colors)** — strictly dominates
   minimal-jump-chips for this lens: identical zero-click, always-rendered full detail
   for every panel, plus a verified, non-fabricated per-panel status ring in the sticky
   nav, plus the amber-severity-ambiguity bug fixed. No content is ever gated behind a
   click; the one collapse point (`#persona-tools`) never touches monitoring content
   and defaults open.

2. **Minimal Jump Chips (unchanged base)** — still nothing is behind a click; full
   detail for all 8 panels is simultaneously on-page. Loses to Hybrid only on two
   points: no status-at-a-glance in the nav itself (must scroll to learn anything), and
   the unfixed amber/"needs-review"-doubles-as-"degraded" ambiguity in the Memory
   Levels table.

3. **Collapsible Clusters (hardened)** — the round-1 fix genuinely works (the cluster
   summary dot survives collapse, closing the literal "went invisible" bug), so this
   is no longer disqualified the way round 1's critique implied. But it caps out at 3
   status bits for 8 panels (much coarser than sidebar's 8 badges or hybrid's per-panel
   rings), and a real, newly-observed mismatch between the Personas cluster's `review`
   dot and its own panel's `pass`-styled status line undercuts confidence in the signal
   when you act on it.

4. **Sidebar Glanceable (hardened)** — ironically has the *best* per-panel status
   resolution of the four (a dedicated, now-correctly-colored badge for all 8 panels,
   always visible regardless of which tab is active) but the *worst* underlying
   structure for this lens: it is a single-active-panel tab view, so at any given
   moment 7 of 8 panels' full content is not merely collapsed but `display:none` —
   the largest amount of real state made click-gated of any candidate. The round-1
   fixes (ARIA, no-JS fallback, badge color) are all real and confirmed, but they
   patch the summary layer; they don't and can't change the fact that the detail layer
   is hidden by design. Worse, the round-1 review/fail color fix was applied only to
   the nav badge and not to the matching in-panel status line (still reads "fail —2
   drafts need review" in red at line 712), so the one place this candidate is
   supposed to *win* — trustworthy at-a-glance severity — has an internal
   contradiction the moment you act on it.
