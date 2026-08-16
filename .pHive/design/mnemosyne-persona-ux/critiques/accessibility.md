# Accessibility Lens — Critique of the 3 Initial Design Directions

**Lens brief:** the new approve/discard actions are a genuinely new interaction
pattern with real consequences (approving bad agent-authored content that
later syncs into `CLAUDE.md`/`AGENTS.md` and governs future agent behavior).
This critique assesses keyboard operability, focus management, and whether
diffs/provenance are screen-reader-legible — not an afterthought bolt-on —
across all 3 initial option briefs.

---

## Option 1 — Efficiency-First: Unified Table with Inline Draft Actions

### Strengths

- **Status is real text, not pure decoration.** The `Status` column renders
  as "a small glyph + label" (`● live`, `◐ draft`) rather than a bare color
  swatch or icon — the *label* half means a screen reader gets actual words,
  not just a glyph. (The glyph half is a weakness — see below.)
- **The `+ Propose draft` control is native `<details>`-style.** If
  implemented as a real `<details>`/`<summary>` element (as the option
  explicitly analogizes to the existing add-lane-form convention), this is
  keyboard-operable and exposes expand/collapse state to AT for free, with
  zero custom ARIA required — a genuine, low-risk strength.
- **Provenance (`proposedBy`/`proposedAt`) is rendered as always-visible text
  when the drawer is open, never a tooltip.** Tooltips are a common
  screen-reader trap; the option explicitly avoids that pattern here.

### Weaknesses

- **The two most consequential controls in the whole redesign — `[✓ approve]`
  and `[✕ discard]` — are specified as bare glyph buttons**, sitting directly
  in the collapsed table row with no stated `aria-label`. Unicode check/cross
  glyphs are inconsistently or silently announced by different
  screen-reader/browser combinations; without an explicit accessible name
  (e.g. `aria-label="Approve draft code-architect / new-service"`), a screen
  reader user tabbing through this dense table may not reliably know what
  either button does, or which row it belongs to once landmarks are lost in
  a long table.
- **Approve is explicitly *not* confirm-gated, while discard is.** The option
  reasons "approve is the 'safe,' reversible-by-re-proposing direction" —
  but through this lens specifically, that reasoning inverts the real risk:
  approve is the action whose bad outcome is worse (content ships into
  `CLAUDE.md`/`AGENTS.md` and governs future agent behavior), and it's the
  one wired as a single-click, icon-only, no-confirmation control reachable
  *without ever opening the review drawer*. A reviewer triaging with
  assistive tech, mis-tabbing or mis-activating in a dense action column, can
  commit unreviewed agent content with zero friction. This is the most
  concrete, high-severity finding across all three options.
- **The drawer's expand/collapse toggle has no stated `aria-expanded`,
  `aria-controls`, or focus-management behavior.** The option specifies the
  visual mechanism (a second `<tr>`, `hidden`/show class) but never says
  whether focus moves into the drawer on open, returns to the toggle on
  close, or whether the toggle communicates its state to AT at all.
- **Dynamic re-sort after approve/discard is unaddressed for AT users.**
  Drafts "float to the top" and a row "leaves the table on next reload" —
  for a sighted user this reads as an obvious visual change; for a screen
  reader user mid-review of a list that just reordered/shrank underneath
  them, there's no mention of an `aria-live` announcement or any other cue
  that the action succeeded and the list changed shape.

---

## Option 2 — Guided Step-by-Step Review Flow

### Strengths

- **The clearest, most explicit accessibility commitment of any option's own
  text**: "Two large, visually distinct, explicitly-labeled buttons — never
  icon-only, given the consequence (lens 3, 4)." This is a direct design
  rule, not an implied convention, and it's the one place any of the three
  briefs names this lens's concern as the reason for a specific choice.
- **The confirmation copy is genuinely descriptive**, not a generic "are you
  sure?" — `"Approve code-architect / mnemosyne? This writes to the real
  store and cannot be undone from here."` A screen reader user gets full,
  specific context in the confirmation itself, which is strictly better than
  a bare yes/no.
- **Step 1 ("Proposed") is structurally read-only and non-skippable before
  editing.** Forcing exposure to the agent's unedited output before any
  editing control appears is a real, structural safeguard against a reviewer
  rubber-stamping a draft they never actually perceived — valuable
  regardless of input modality, and particularly protective for anyone
  relying on sequential AT navigation who might otherwise land straight on
  action controls.

### Weaknesses

- **The entire thesis of this design — "state is legible at a glance" — is
  delivered through a purely visual stepper** (filled/highlighted current
  node, checkmark on completed, dimmed future nodes). Nowhere does the brief
  mention `aria-current="step"`, a textual "Step 2 of 4: Reviewing"
  equivalent, or any other screen-reader translation of that state. As
  written, the option's own stated value proposition does not reach a
  non-sighted reviewer — a structural gap, not a cosmetic one, given this is
  the option's central mechanism.
- **"Disabled with a tooltip" for gating Approve/Discard on unsaved changes
  is a known accessibility anti-pattern.** A native `disabled` attribute
  removes an element from the tab order entirely, so a keyboard/screen-reader
  user cannot discover the button exists, let alone why it's inert or that a
  tooltip exists to explain it. Without `aria-disabled` + `aria-describedby`
  (not mentioned), this reads as accidentally hiding the gating rationale
  from exactly the users this lens is meant to protect.
- **The pinned provenance strip's interaction with tab order is unaddressed.**
  A visually "pinned" panel that stays alongside the step content through
  three of four steps needs a stated position in the DOM/tab order (does it
  repeat before every step's content, interrupting flow, or sit once,
  off to the side, disconnected from sequential reading order?) — not
  discussed either way.
- **No stated tab/tablist semantics for the Library/Review Queue segmented
  control**, and no stated navigation model between the left rail and the
  step panel (does selecting a rail item move focus into the step panel, or
  leave a keyboard user to tab past the whole rail first?).

---

## Option 3 — Unified Review Queue

### Strengths

- **This is the only option whose own text names the accessibility lens
  directly as the reason for a structural decision**: the status badge is
  "deliberately not a 5th panel or a colored border trick, so screen readers
  get the state as actual cell text, not decoration (accessibility lens)."
  That's a real, verifiable design commitment, not a retrofit.
- **Approve/Discard are plain, text-labeled buttons that only exist inside
  the expanded accordion** — never as bare icon-only controls sitting in the
  scannable collapsed row. Structurally, this means a reviewer cannot trigger
  either consequential action without first landing on the expanded content
  that contains the source summary and current-vs-proposed comparison. This
  directly closes Option 1's worst gap: there is no "approve without ever
  reading anything" path available from the collapsed list.
- **Both Approve and Discard are confirm-gated symmetrically**, both via
  native `window.confirm()` — unlike Option 1 (confirm only on discard).
  Native `confirm()` also has an accessibility advantage the other two
  options' custom confirmation patterns don't automatically get: it's
  browser-native, so focus handling and AT announcement are handled by the
  platform rather than needing to be hand-built and gotten right.
- **"Current vs. proposed" is explicitly plain stacked text, not a diff
  library**, and the option gives its reasoning explicitly in
  accessibility-relevant terms ("a byte-diff of prose sections is less
  legible than reading both in full at this scale"). This avoids a common,
  serious screen-reader trap: color-coded or strikethrough-based diff
  rendering is frequently invisible or unannounced to AT, and two
  clearly-headed (`Current (live)` / `Proposed (draft)`) text blocks are
  categorically more robust for this content.

### Weaknesses

- **The row-expand `▸` affordance has the same unaddressed gap as Option
  1's drawer toggle** — no stated `aria-expanded`/`aria-controls`, no stated
  focus movement into the accordion body on open or back to the toggle on
  close.
- **The parent-ref "scroll to and flash" cross-reference is described in
  purely visual terms.** A sighted user sees the flash; nothing is said
  about moving actual focus to the target row (vs. just scrolling it into
  view) or otherwise giving a screen reader user any signal that the jump
  happened and where they landed.
- **Confirm-dialog copy specificity is left unstated**, unlike Option 2's
  explicit, fully-written confirmation string — the option says a "native
  `confirm()`" fires but doesn't commit to including the specific
  tier/scopeId/consequence text Option 2 spells out verbatim, so this
  strength is implied rather than guaranteed as written.
- **Sticky group headers** are called out as a deliberate feature ("hierarchy
  never disappears just because a row is expanded or the list is scrolled")
  but sticky-positioned elements can distort logical DOM/tab order if not
  implemented carefully; the brief doesn't address keeping visual and DOM
  order in sync.

---

## Verdict

**Option 3 serves this lens best**, though not by a wide margin over Option
2. Three concrete reasons: it is the only brief that names screen-reader
legibility as the actual rationale for a structural choice (status-as-cell-
text) rather than an assumed byproduct; it structurally prevents the
single worst failure mode found in this review — a consequential,
irreversible-feeling approve action reachable via a bare, unlabeled icon
button with no confirmation, which is exactly what Option 1 specifies; and
its plain-text current-vs-proposed comparison sidesteps the diff-legibility
trap more safely than either alternative. Option 2 deserves credit for the
single most explicit accessibility *rule* of the three ("never icon-only,
given the consequence") and the best-written confirmation copy, but its
core mechanism — a purely visual multi-step progress indicator — is, as
written, not translated for screen readers at all, which undercuts the
option's own stated thesis for exactly the users this lens exists to
protect. Option 1 is clearly weakest here: it pairs icon-only quick-action
buttons with an explicit decision to skip confirmation on the higher-stakes
action (approve), which is the precise failure this lens's brief warns
against. None of the three options fully solves focus management on
expand/collapse controls — that gap should be treated as a shared,
mandatory fix regardless of which option is selected or synthesized forward.
