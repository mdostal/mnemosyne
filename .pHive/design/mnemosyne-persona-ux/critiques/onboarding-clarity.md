# Critique — New-user onboarding clarity

**Lens:** The domain model is genuinely jargon-dense (`tier`, `scopeId`,
`parentRefs`, "query up, never copy down," mandate sections — confirmed
directly in `ui/index.html`'s own current panel-hint copy). Can a first-time
viewer orient without reading the source code? Where does each option assume
prior knowledge it should not?

This critique reviews all 3 initial option briefs (`option-1.md`,
`option-2.md`, `option-3.md`) against that question only — efficiency,
accessibility mechanics, and hierarchy legibility are noted only where they
directly bear on a first-time viewer's ability to orient.

---

## Option 1 — Efficiency-First: Unified Table with Inline Draft Actions

### Strengths
- The status vocabulary is minimal by design — only two real states in
  steady operation (`● live` / `◐ draft`), which is the smallest possible
  concept surface for a newcomer to absorb before they can tell "is this
  thing real or not."
- The drawer's "Source summary" label, shown "verbatim, in a monospace
  block," gives a first-time viewer a plain, findable place to read *why* a
  proposal exists, in the agent's own words rather than in domain jargon.
- Filter labels (`All` / `Tier: All` / `Repo: All`) are plain English, not
  invented status vocabulary a newcomer has to learn from scratch.

### Weaknesses
- The option inherits the existing table's raw jargon columns (`Tier`,
  `Scope ID`, `Parent(s)`) completely unchanged and proposes **zero**
  explanatory scaffolding — no legend, no tooltip, no inline definition
  anywhere in the brief — for `tier`, `scopeId`, or what a `Parent(s)`
  pointer actually means ("query up, never copy down" is never surfaced to
  the reader at all, even though the option explicitly discusses the
  mechanic in its own commentary). A first-time viewer sees `project-orc…`
  truncated in a cell with no way to learn what that relationship *does*.
- The `●` / `◐` / `✓` / `✕` glyphs are introduced with no key/legend in the
  design — a newcomer must reverse-engineer four symbols from context alone,
  which is a worse starting point than plain-text status words.
- There is no described empty state or first-run guidance at all. The brief
  states the crawl/propose step happens "entirely outside this UI's control
  flow" and that "the panel's job starts at step 2" — but never describes
  what a first-time viewer sees when the table is mostly `● live` rows and
  they have no idea a draft-proposal mechanism even exists. Contrast Option
  2's explicit empty-state copy.
- Consequence framing is asymmetric and thin: only `discard` gets a
  `confirm()`; `approve` — the action that commits agent-authored content
  into a governing store — fires with no inline explanation of what
  "approve" actually does. A newcomer has no textual cue, at the moment of
  clicking, that this is a real, consequential write.
- The table is dense from the very first render (six columns including a
  compressed Action column with three icon-only controls `[▾][✓✕]`) — there
  is no "simple view first, detail on demand" on-ramp; a first-time viewer
  is shown the full-density operator surface immediately.

## Option 2 — Guided Step-by-Step Review Flow

### Strengths
- The four-node stepper (**Proposed → Reviewing → Decision → Resolved**) is
  the single strongest onboarding device across all three options: it is
  plain English, self-describing, and tells a first-time viewer exactly
  where a draft stands in its lifecycle without requiring any prior
  knowledge of the domain's status vocabulary.
- The empty state is the only one of the three briefs that quotes its own
  literal copy: *"No drafts pending. Ask an agent to propose one
  (`mnemosyne persona draft propose ...` or the persona-interview skill), or
  start one by hand below."* This is concrete, verifiable onboarding text —
  it tells a first-time viewer both *that* the crawl mechanism exists and
  *how* to invoke it, in one sentence, rather than assuming they already
  know.
- Buttons are explicitly required to be "never icon-only, given the
  consequence" — `"Approve — write to persona store"` and `"Discard —
  archive without committing"` spell out in plain language exactly what
  pressing each button does, which is a direct, concrete answer to "can a
  first-time viewer orient without reading source."
- The Decision-step confirm text is quoted in full and names the actual
  consequence in plain language: *"Approve `code-architect / mnemosyne`?
  This writes to the real store and cannot be undone from here."* This is
  the most explicit consequence-framing of any option reviewed.
- The provenance strip pinned throughout Reviewing/Decision, and the
  structural (dimmed-node) signal for manually-authored vs. agent-proposed
  drafts, let a newcomer infer provenance from a visual pattern rather than
  needing to already know what `proposedBy`/`sourceSummary` mean as fields.

### Weaknesses
- The Library tab's four tier sub-headings (`Top Orchestrator`, `Company
  Director`, `Project Orchestrator`, `Code Architect`) are presented as bare
  group headers with no definition anywhere in the brief — a first-time
  viewer still cannot tell what distinguishes these four tiers or which one
  they should be looking at.
- `Parent(s)` is carried forward "pointer-only... no change to the
  copy-down guarantee," but the guarantee itself (why parents are
  pointer-only, what "query up" means) is never explained to the reader
  anywhere in the UI this brief describes.
- The option introduces its own new pair of navigation concepts a newcomer
  must learn before the stepper even helps them — `Library` vs. `Review
  Queue` as tab names, on top of the four stepper states — which is a wider
  total vocabulary surface than Option 1's simple live/draft split, even
  though each individual piece is well-labeled.
- No tooltip or inline definition is proposed anywhere for `scopeId`
  specifically (e.g., that it's a human-assigned identifier, not derived) —
  the brief assumes the reader already knows what a "scope ID" is the
  moment they land on the rail.

## Option 3 — Unified Review Queue

### Strengths
- Status badges render as actual cell text (`NEEDS REVIEW`, `live`,
  `history`) rather than glyph-only, explicitly justified in the brief for
  accessibility — but this also directly helps onboarding, since a
  first-time reader can read the state in English rather than decode a
  symbol.
- The source-summary block is labeled with a full plain-language sentence,
  *"Why the agent proposed this,"* — arguably the single clearest label of
  any option for the concept the whole lens-4/provenance mechanism exists
  to support, phrased as a question a newcomer would actually ask rather
  than as a field name.
- The `Current (live)` / `Proposed (draft)` side-by-side stacks, shown only
  when a live record already exists at that identity, give a first-time
  viewer a concrete, readable comparison instead of requiring them to
  understand the draft/live distinction abstractly. The "New persona —
  nothing live yet" heading for the no-live-record case is similarly
  explicit, plain-language framing rather than an inferred badge state.
- The `Status` grouping mode lets a first-time viewer triage purely by
  "what needs my attention" without first having to understand the tier
  hierarchy at all — a genuine escape hatch from the jargon-heavy default.

### Weaknesses
- `Tier` is still the *default* grouping, so the very first thing a
  first-time viewer sees on opening the panel is raw tier-name group
  headers (`top-orchestrator`, `company-director`, `project-orchestrator`,
  `code-architect`) with no definitions attached anywhere in the brief —
  the same unexplained-jargon problem as the other two options, and it is
  front-and-center by default rather than opt-in.
- The total vocabulary a first-time viewer must absorb is arguably the
  widest of the three: four status filter chips (`Needs review`/`Live`/
  `All`/`History`), three group-by modes (`Tier`/`Repo`/`Status`), and three
  badge variants including a compound one (`◐ needs review — revision`)
  whose "— revision" suffix is never explained in the text — a newcomer
  encountering that exact string has no way to know it differs in meaning
  from a plain "needs review" badge.
- Unlike Option 2, the empty-state/first-run guidance is only described in
  the abstract ("the panel's hint text says so explicitly rather than
  implying a button exists") — no literal copy is quoted anywhere in the
  brief, so it is weaker, on the page as written, as actual evidence of
  onboarding-friendliness than Option 2's quoted sentence.
- `Parent(s)` and the "query up, never copy down" guarantee remain entirely
  unaddressed for a first-time reader, exactly as in the other two options
  — the in-page anchor/scroll-to-parent behavior is a nice hierarchy aid
  for someone who already understands parents, but does nothing to teach a
  newcomer what a parent relationship means in the first place.

---

## Which option serves this lens best

**Option 2 serves new-user onboarding clarity best of the three**, and it
is not a close call on the specific mechanics that matter for this lens: it
is the only option that (a) names the review lifecycle in plain, sequential
English rather than a status column or badge vocabulary, (b) quotes literal
empty-state copy that tells a first-time viewer both that the crawl
mechanism exists and how to invoke it, and (c) requires text-labeled,
consequence-stating buttons and confirm copy at the exact moment of the
highest-stakes action. Option 3 is the closest runner-up — its "Why the
agent proposed this" label and current-vs-proposed comparison are genuinely
strong, plain-language moves — but its default Tier-grouped view puts raw
domain jargon front-and-center on first load, and its badge vocabulary
(including the unexplained "— revision" suffix) is the widest of the three.
Option 1 is weakest on this lens specifically: it introduces the least new
explanatory scaffolding of the three (no legend for its glyphs, no quoted
empty-state copy, asymmetric/absent consequence framing on approve) and
presents its full operator-density table immediately with no on-ramp.

That said, **none of the three options actually solves the jargon problem
this lens exists to test.** All three carry forward `tier` names,
`scopeId`, and pointer-only `Parent(s)` rendering into their new designs
completely unexplained — no option proposes so much as a tooltip, glossary,
or one-line definition for `tier`, `scopeId`, `parentRefs`, or "query up,
never copy down" anywhere in its brief. A first-time viewer under any of
the three designs can learn *what state a draft is in* (Option 2 best,
Option 3 second) but still cannot learn *what the underlying domain
concepts mean* without reading the source — that gap is the most important
finding of this critique and should carry into synthesis regardless of
which option's structure is chosen.
