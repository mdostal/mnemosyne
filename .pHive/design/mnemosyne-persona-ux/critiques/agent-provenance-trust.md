# Critique — Lens 4: Agent-Provenance and Trust Calibration

**Lens brief:** a human is being asked to approve content an AGENT wrote that
will become governing instruction content for future agent sessions. Does the
design make it trivially obvious, at every point, what the agent proposed vs.
what a human has actually verified, and what source material (the bounded
crawl's `sourceSummary`) the proposal was based on?

This critique evaluates all 3 initial options against that question only.

---

## Option 1 — Efficiency-First: Unified Table with Inline Draft Actions

**Strengths**

- The provenance line (`proposedBy` + `proposedAt`) is explicitly named as
  satisfying this lens and is "always visible whenever the row is expanded,
  never buried in a tooltip" (§3, step 3) — a correct, direct answer to half
  the lens brief.
- `sourceSummary` is rendered "verbatim, in a monospace block" in the drawer
  — the source material is present, not summarized-again or paraphrased away.
- The drawer is populated from data the list fetch already returned (no extra
  round-trip), so there's no latency excuse for a reviewer to skip opening it.

**Weaknesses**

- This is the option's most serious problem through this lens: **step 5
  explicitly allows Approve/Discard to fire from the *collapsed* row, with no
  requirement to have ever opened the drawer** — "no drawer expansion required
  for the fast path... a reviewer... shouldn't be forced to expand first." That
  is a structural invitation to approve agent-authored governing content
  without having seen the `sourceSummary` or the proposed sections at all. The
  design's own stated goal (fewer clicks for triage) is in direct tension with
  the lens's goal (never let approval happen blind).
- The friction asymmetry is backwards for this lens: only **Discard** gets a
  `confirm()` gate; **Approve** is treated as "the safe, reversible-by-re-
  proposing direction" and fires with a single click. From a trust-calibration
  standpoint this is inverted — approving unread agent content into a store
  that governs future agent behavior is the action that most needs a pause,
  not the one that gets none.
- Once `[Edit]` is used, nothing in the design distinguishes which fields are
  still the agent's original proposal versus which the human subsequently
  changed — the provenance line records who proposed the draft, not what
  survived unedited into the version being approved.
- The only in-list signal that a row is agent-authored vs. a first-class
  status is the `◐ draft` glyph plus a `(proposed)` display-name placeholder;
  there's no glance-level distinction between an agent-proposed draft and a
  human-started one at the table level (both show as `◐ draft` until opened).

## Option 2 — Guided Step-by-Step Review Flow

**Strengths**

- The provenance/`sourceSummary` block is **pinned** and persists on-screen
  through Reviewing and Decision, not just available-on-demand — "never
  scrolls out of view... always on screen (lens 4, directly)." This is the
  most sustained treatment of provenance visibility of the three options: it
  doesn't require a click to reveal and can't be scrolled away mid-edit.
- **Step 1 (Proposed) is deliberately non-editable.** The design states this
  outright: "Proposed is a pure 'here's what the agent found' checkpoint,
  deliberately separated from editing so an operator always sees the agent's
  unedited output at least once before touching it." This is a genuine
  structural gate against the failure mode this lens cares about most —
  jumping straight to editing/approving without ever registering what the
  agent actually produced.
- Approve/Discard are **disabled with an explanatory tooltip** if edits from
  Step 2 haven't been saved — "an operator can never approve something they
  haven't actually looked at in its final form." This closes a gap Option 1
  leaves open (approving a state you haven't actually seen).
- The manual-draft path is distinguished **structurally**, not just by a text
  label: the stepper itself renders the Proposed node dimmed/skipped for
  human-authored drafts, so agent-vs-human origin is legible from the
  stepper's shape alone, at a glance, without reading anything.
- The confirm-to-approve copy is scoped to the specific persona identity
  ("Approve `code-architect / mnemosyne`? This writes to the real store and
  cannot be undone from here.") rather than a generic confirm — a small but
  real improvement in making the consequence concrete at the moment of
  commitment.

**Weaknesses**

- At Decision, the recap shown is explicitly "the draft's current field values
  (post-edit)" — the design does not describe showing the *original*
  agent-proposed values alongside the edited ones at this final checkpoint.
  So while the operator was forced to see the raw proposal once (Step 1), by
  the time they're actually approving, there's no diff between what the agent
  said and what a human changed — an operator has to remember Step 1's
  content from memory rather than compare it directly against what they're
  about to commit.
- Provenance for *revision* drafts (an existing live persona with a pending
  draft) is thin outside the Review Queue: Library only shows a small
  `↻ draft pending` link, and nothing in the option describes a current-vs-
  proposed comparison anywhere in the Review Queue flow either — a reviewer
  revising an existing persona has no described way to see what's actually
  changing relative to the live version, only the agent's fresh proposal in
  isolation.
- The forced sequential ritual (Proposed → Reviewing → Decision → Resolved)
  is a strong first-use safeguard, but the design doesn't address what happens
  to genuine engagement with the provenance block once an operator has
  clicked through the same stepper dozens of times — the mechanism guarantees
  the content was *displayed*, not that it was *read*, and repetition is a
  known solvent for exactly that kind of gate.

## Option 3 — Unified Review Queue

**Strengths**

- This is the only option that specifies a **Current (live) vs. Proposed
  (draft) side-by-side comparison** when a draft revises an existing live
  persona — "two labeled stacks... plain stacked text, not a diff library...
  since a byte-diff of prose sections is less legible than reading both in
  full." For the lens's core concern (what did the agent actually change,
  relative to what a human already trusted), this is the most direct answer
  of the three options — neither Option 1 nor Option 2 describes this
  comparison at all.
- Provenance **survives approval**: "keeps a one-line 'originally proposed by
  agent, approved `<date>`' provenance note even after landing — provenance
  doesn't vanish just because review finished." This is a distinctive,
  concrete strength unique to this option — trust calibration doesn't stop
  mattering the moment a draft becomes live; being able to later see that a
  now-live persona originated from an agent proposal (and when it was
  approved) is exactly the kind of forensic trail this lens is asking for,
  and it's the only option that commits to keeping it.
- Approve/Discard live **inside the expanded accordion**, not on the
  collapsed row (contrast Option 1) — a reviewer cannot fire either action
  without first triggering the expand that surfaces the `sourceSummary`,
  provenance line, and (when applicable) the current-vs-proposed stacks in
  the same view.
- The badge distinguishes a brand-new-identity draft ("◐ needs review") from
  a draft revising an existing live persona ("◐ needs review — revision") at
  the list level, before any row is even expanded — giving the operator an
  up-front signal of stakes (new content vs. changing something already
  trusted) that neither other option surfaces this early.
- Provenance line explicitly distinguishes "Proposed by agent" vs "Manually
  created," described as "always visible, never inferred" — same baseline
  guarantee as Options 1 and 2, stated with the same directness.

**Weaknesses**

- Unlike Option 2's Step 1, there's no non-editable "see the agent's raw
  output first" gate — the accordion opens directly into a view where the
  source summary, the current-vs-proposed stacks, *and* the editable fields
  are all present simultaneously. Nothing in the design stops an operator
  from scrolling past the source summary straight to the editable fields and
  the Approve button; the comparison is available, but not enforced as a
  read-before-edit checkpoint the way Option 2's stepper structurally
  requires.
- The approve/discard confirmation is specified only as a generic "native
  `confirm()` — no new dialog component needed," with no described copy
  content — unlike Option 2's confirm, which restates the specific persona
  identity and consequence ("writes to the real store and cannot be
  undone"). As written, Option 3's confirm could be as unspecific as a bare
  "Are you sure?", which would waste some of the trust-calibration value the
  rest of the option earns elsewhere.
- The current-vs-proposed comparison appears to be a review-time-only
  artifact — once a draft is approved and archived, the option does not
  describe that comparison surviving anywhere (only the one-line "originally
  proposed by agent, approved `<date>`" note persists). So while Option 3
  uniquely keeps *that a proposal happened*, it does not appear to keep
  *what the proposal actually changed* for later audit, once the draft file
  itself has moved to `approved/`.

---

## Which option serves this lens best

**Option 3 is the strongest of the three, with Option 2 a close and
genuinely competitive second; Option 1 is clearly the weakest.**

Option 1's design explicitly optimizes the collapsed-row fast path to let an
operator approve without ever opening the drawer, and it puts its one
friction gate on Discard rather than Approve — both choices point away from
this lens's central concern rather than toward it. It should not be the pick
if this lens is weighted heavily.

Between Options 2 and 3, the honest tradeoff is: Option 2 has the stronger
*forced-exposure mechanic* (a genuinely non-editable "see the raw proposal
first" step, plus a hard block on approving unsaved edits) and the stronger
*persistent-during-review* provenance treatment (pinned strip that survives
every step). Option 3 has the stronger *comparative* mechanic (current-vs-
proposed stacks, letting a reviewer see the actual delta rather than the
proposal in isolation) and is the only option that keeps any provenance trail
*after* approval, when the content is already governing agent behavior and an
operator later asking "where did this come from" still deserves an answer.
Option 3 edges ahead specifically because trust calibration for this
interaction doesn't end at the moment of the approve click — a design that
forgets a persona's agent-authored origin the instant it goes live is
incomplete for exactly the failure mode this lens exists to catch. A
synthesis that took Option 2's non-editable first-look gate and grafted it
onto Option 3's current-vs-proposed comparison plus persistent post-approval
provenance note would beat either option standing alone.
