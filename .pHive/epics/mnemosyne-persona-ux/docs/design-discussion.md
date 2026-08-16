# Design Discussion — mnemosyne-persona-ux (Epic 3 of 3, personas line of work)

*Planned solo (no interactive operator available for a live planning gate this
session). Every genuinely-reversible implementation detail below is decided
and logged in §9 "Resolved judgment calls," mirroring
`mnemosyne-persona-wizard`'s own design-discussion.md §"Resolved Ambiguities"
convention. Anything that isn't reversible, or that this session has no real
visibility into, is left as an explicit open question in §8 rather than
guessed at.*

## 0. Prelude

PRIOR DECISIONS this epic inherits and does not relitigate: everything Epic 1
(`mnemosyne-persona-foundation`, v0.6.0/v0.7.0) and Epic 2
(`mnemosyne-persona-wizard`, pw-01..pw-17, closed) shipped — the two-store
persona split, `assertValidPersona`, the write primitive at all 3 pre-existing
transports + HTTP, the adaptive interview skill, and the current view+write
Personas panel. This epic builds a new layer on top of that foundation; it
does not touch Epic 1/2's already-shipped, already-tested mechanics.

This epic exists because of two explicit operator asks made in this session
(quoted in full in research-brief.md §0) — a heavy multi-swarm UI/UX design
pass, and an agent-assisted persona build-and-approve interaction to replace
the single free-text form. It is planned in parallel with a sibling body of
work, `mnemosyne-memory-levels` (different branch, not yet built), which is
correcting Mnemosyne's memory-store model to 5 distinct levels (0 = mnemosyne
injection rules, 1 = repo agent-overlay files, 2 = graph, 3 = vector, 4 =
file doc store). This epic treats that corrected model as a documented
dependency/input where relevant (the layer-stack UI section) — it does not
redesign the level model itself, and does not block on the sibling epic's
code landing.

## 1. Goal

Two deliverables, both operator-mandated, both genuinely large:

1. A heavily redesigned Personas panel UI, produced through a real
   multi-agent design-exploration pass (option generation → 7-lens review
   panel → synthesis into 3 new refined options), not a single ui-designer
   pass.
2. A new agent-assisted persona build-and-approve interaction: an operator
   gives an agent high-level context (project/repo scope, a brief summary);
   the agent does a bounded crawl and proposes a draft persona (top-level
   understanding + orchestration-relevant metadata, deliberately not an
   exhaustive drill-down); a human reviews, edits if needed, and explicitly
   approves before anything is committed via the existing `persona_create`
   write primitive. This builds on `skills/mnemosyne-persona-interview`'s
   already-shipped adaptive-interview mechanics — it does not reinvent
   interview mechanics — but that skill has no draft/approval concept and no
   UI path today (research-brief.md §2); both are new.

Explicitly OUT of scope: the corrected 5-level memory model itself (sibling
epic's job — this epic references it as an input where the layer-stack UI
section is concerned, §6), and any change to Epic 1/2's already-shipped
storage/write/interview mechanics beyond the specific extension points named
below (the interview skill's step 7 write target, and the Personas panel's
existing view+form code).

## 2. What exists today

See research-brief.md for full detail. Summary of the load-bearing gaps:

- The Personas panel is one flat table + one flat 7-field form that writes
  directly and immediately — no draft state, no multi-view, no hierarchy
  awareness beyond a pointer-only parent column (research-brief.md §1).
- The interview skill is real, shipped, and TDD-verified, but commits on
  completion with zero review gate, and is reachable only from inside a live
  agent terminal session — never from the browser (research-brief.md §2).
- No draft/staging concept exists anywhere in the persistence layer — the
  only write path anywhere is `writeGlobalPersona`/`writeRepoLocalPersona`,
  and the repo-local store is explicitly git-committed by design
  (research-brief.md §3).
- `lib/mnemosyne/server.ts`'s route table and CORS handling (`applyPersonaCors`)
  are the one, already-proven convention any new route in this epic should
  reuse exactly (research-brief.md §4).
- No pre-existing "N options → multi-lens panel → synthesize" workflow exists
  in this repo's Hive tooling to just invoke — `/design` is a single-dispatch
  wireframe skill; the closest real precedent is `design-review.workflow.yaml`'s
  step-graph *shape*, not a callable multi-lens-review workflow itself
  (research-brief.md §5).
- The corrected 5-level model is documented ground truth for this session,
  not yet shipped code anywhere in this repo (research-brief.md §6).

## 3. Proposed approach

### 3a. Ask 1 — multi-swarm design-exploration pass (must land early; build-out depends on its output)

A new, EARLY ticket (`pu-01`) that is a genuine 3-phase fan-out-then-synthesize
pass, not `/design`'s default single dispatch:

1. **Option generation** — multiple independent agents each produce one
   initial design direction for the redesigned Personas panel + the new
   agent-assisted build/approve interaction (layout, navigation, interaction
   flow — wireframe-level, following `/design`'s own wireframe-protocol
   conventions where they apply). **3 initial directions** (§9 judgment call
   #1 for why 3, not more or fewer).
2. **7-lens review panel** — 7 distinct, independently-dispatched
   persona/stakeholder-lens agents each review **all 3** initial directions
   and produce a critique. The 7 lenses are named concretely in §4 below —
   chosen for *this* surface specifically (a dense, jargon-heavy, ops-tool UI
   gaining a brand-new human-approval-of-agent-output interaction), not
   copied from a generic list.
3. **Synthesis** — synthesis agents read all 3 directions and all 7 critiques
   and produce **3 NEW refined options** — genuinely re-synthesized from the
   combined feedback, not a pick-one-of-the-original-3.

Executed via this session's own multi-agent dispatch, structured in the same
`id`/`agent`/`depends_on`/`inputs`/`outputs` step shape
`design-review.workflow.yaml` and `ui-design.workflow.yaml` already establish
(research-brief.md §5) — there is no pre-existing repo-local workflow
registration mechanism to hook into, so this ticket's own step sequence *is*
the workflow, documented explicitly rather than assumed to exist elsewhere.

Real design artifacts get written to disk, following `/design`'s own
directory convention: `.pHive/design/mnemosyne-persona-ux/` — 3 initial
option briefs, 7 lens critiques (one per lens, referencing all 3 initial
options), and 3 final synthesized option briefs (wireframe descriptions,
layout decisions, interaction-flow diagrams for both the panel redesign and
the crawl→propose→approve flow). All later UI tickets in this epic (pu-10,
pu-11, pu-12) build against whichever ONE of the 3 synthesized options gets
selected (§9 judgment call #2: selection mechanism, since there is no
interactive operator to run `/design`'s own `AskUserQuestion` touchpoint
against in an unattended planning pass).

### 3b. Ask 2 — the staging/draft-persona/approval mechanism (the real architectural decision)

This is the one piece of this epic the operator explicitly flagged as a real
architectural decision needing a reasoned call, not a hand-wave. Decision,
in full, with rationale:

**A new, structurally separate draft persona store, home-rooted (never inside
a consuming repo's git-tracked tree), addressed by the same `{tier, scopeId}`
identity the real store already uses, with disposition tracked by file
location rather than a status field, and approval performed by calling the
EXISTING real write primitive unchanged — never a second write path.**

Concretely:

- **Location:** `~/.mnemosyne/persona-drafts/<tier>/<scopeId>.yaml` for the
  3 global tiers (mirrors `globalPersonaPath`'s own convention exactly);
  `~/.mnemosyne/persona-drafts/repo-local/<repoSlug>/<scopeId>.yaml` for
  `code-architect`, where `repoSlug` is `path.resolve(repoRoot)` sanitized
  with the exact same rule `resolveRememberScope()` already applies to a
  persona's `scopeId` (`.replace(/[^a-zA-Z0-9_-]/g, '-')`, `persona.ts`) —
  reusing an existing sanitization rule rather than inventing a third one.
  **Never** `<repoRoot>/.mnemosyne/persona-drafts/`: `persona-store-repo-local.ts`'s
  own doc comment states the real store is deliberately not gitignored
  ("git-committed alongside the code it describes... not gitignored");
  putting ephemeral, possibly-rejected draft content in the same repo tree
  would either force Mnemosyne to mutate every consuming repo's `.gitignore`
  (an operational burden it takes on nowhere else) or risk an in-progress
  draft landing in that repo's git history by accident. Keeping ALL drafts
  home-rooted, mirroring where Mnemosyne already keeps its own operational
  state (`~/.mnemosyne/personas`, `~/.config/swarm-memory/config.toml`),
  avoids both.
- **One active draft per `{tier, scopeId}`:** a second `POST` to the same
  draft identity overwrites the active draft in place — mirrors the real
  store's own "same POST route handles create-or-edit" convention (pw-17),
  and matches ask 2's own framing (an agent proposes, a human iterates on
  *that* proposal, not a growing pile of competing drafts for the same
  identity).
- **Disposition by location, never a hard delete:** approving or discarding a
  draft **moves** its file to a timestamped path under `approved/` or
  `discarded/` (same root) rather than unlinking it. This mirrors this
  codebase's own already-shipped flight-status philosophy exactly
  (`docs/layer-architecture-v2-plan.md`'s provisional/confirmed/superseded
  model: *"never deleted — a rejected approach stays queryable as 'we tried
  this, it didn't land'"*) — a discarded agent proposal has the same forensic
  value a superseded memory write does, and the operator's own stated hard
  rule (never wipe state carelessly) argues for the same posture here.
- **Approval never re-implements validation:** `POST /persona/draft/:tier/:scopeId/approve`
  reads the active draft, strips draft-only metadata (`proposedBy`,
  `sourceSummary`, `proposedAt`), and passes the remaining candidate straight
  into the SAME `writeGlobalPersona`/`writeRepoLocalPersona` calls every
  other transport already uses — `assertValidPersona` is still the one real
  enforcement point, exercised for the first time only at approval, never at
  propose/edit time (a draft-in-progress is explicitly allowed to be
  incomplete while a human is still editing it). This satisfies the
  operator's own framing precisely: *"reviewed/edited before being committed
  via the existing persona_create write primitive, not written directly."*
- **A draft is proposed by an agent via the CLI first** (`mnemosyne persona
  draft propose --file <path> [--repo <repo>]`), mirroring the interview
  skill's own established reasoning for why the CLI is its default write
  surface (a live agent session always has shell-out, may not have an open
  MCP connection) — then reviewed/edited/approved by a human via the browser
  UI's new draft routes on `lib/mnemosyne/server.ts` (same CORS convention,
  §4 of research-brief.md). skill-harness + MCP wraps around the same CLI
  verb ship as a parity follow-on (mirroring the wizard epic's own
  CLI→skill-harness→MCP chain for the real write primitive), not blocking
  the core propose→review→approve loop.
- **Route ordering gotcha, confirmed by reading `server.ts` directly:** the
  existing `GET`/`POST /persona/:tier/:scopeId` handlers dispatch on
  `url.pathname.startsWith('/persona/')`, with a `segments.length !== 2`
  guard. `/persona/draft/:tier/:scopeId` has 3 segments after `/persona/`,
  so it would already 404 out of the *existing* handlers harmlessly if
  reached — but the new draft-route branches must still be checked BEFORE
  those generic handlers in source order, or a stray future change to that
  guard could silently swallow draft requests. Called out explicitly in
  pu-03's own acceptance criteria, not left as an implicit assumption.
- **The `OPTIONS /persona/*` preflight handler already covers `/persona/draft/*`
  for free** — its own prefix check (`url.pathname.startsWith('/persona/')`)
  structurally includes the new routes; no new preflight branch needed.

This mechanism is deliberately the SAME shape for both authoring paths ask 2
describes — an agent-proposed draft (crawl → propose) and a human directly
typing into the (now draft-targeted) create/edit form — so there is exactly
one review/approve UI, not two. See §9 judgment call #4.

### 3c. The bounded crawl ("without overdoing it")

The interview skill's step 2 ("load context before asking") becomes an
explicit, named, capped crawl rather than "whatever's already in the
conversation": a fixed, small source list (repo README, package/project
manifest, existing `CLAUDE.md`/`AGENTS.md` if present, the applicable parent
persona's own summary via query-up — never its full content, preserving the
already-established "query up, never copy down" guarantee) with an explicit
file/line cap, producing a short `sourceSummary` string that travels with the
draft record and is shown to the human reviewer — this is the concrete
mechanism by which the reviewer can see *why* the agent proposed what it
proposed, without the agent (or the reviewer) having to read an exhaustive
dump. See pu-07.

### 3d. UI build-out (depends on 3a's chosen synthesized option)

The Personas panel gets rebuilt against whichever of the 3 synthesized
design.pu-01 options is selected (§9 judgment call #2): a new structural
shell (pu-10), the existing layer-stack section carried forward and
re-integrated into that shell with copy that degrades gracefully against
today's `GET /layers` shape rather than assuming the sibling epic's
not-yet-shipped 0-4 numbering (pu-11), and a new draft review/approve surface
that also absorbs pw-17's existing create/edit form — retargeted to propose
a draft instead of writing directly (pu-12, §9 judgment call #4). A final
design-fidelity pass (pu-14) checks the shipped UI against pu-01's chosen
option, closing the loop on the "heavy UI/UX lift" ask concretely rather than
just asserting it was done.

## 4. The 7 review lenses — named concretely, with rationale for THIS surface

Chosen for the actual surface this epic redesigns (a dense, jargon-heavy,
zero-dep, dark-only ops-tool UI, gaining a brand-new human-approves-agent-
output interaction) — not a generic reuse of any example list:

1. **Operator/power-user efficiency** — the primary real user is a technical
   operator managing personas across tiers/repos; the redesign must make
   scanning, triaging, and approving/discarding fast, not just prettier.
2. **New-user onboarding clarity** — the domain model is genuinely
   jargon-dense (`tier`, `scopeId`, `parentRefs`, "query up, never copy
   down," mandate sections) — confirmed directly in `ui/index.html`'s own
   panel-hint copy (research-brief.md §1). A first-time viewer must be able
   to orient without reading the source.
3. **Accessibility** — the new approve/discard actions are a genuinely new
   interaction pattern with real consequences (approving bad agent-authored
   content that later syncs into `CLAUDE.md`/`AGENTS.md` and governs future
   agent behavior); keyboard operability, focus management, and
   screen-reader-legible diffs/provenance are a distinct, non-negotiable lens
   here, not an afterthought bolt-on.
4. **Agent-provenance and trust calibration** — specific to ask 2: a human is
   being asked to approve content an AGENT wrote that will become governing
   instruction content for future agent sessions. The design must make it
   trivially obvious, at every point, what the agent proposed vs. what a
   human has actually verified, and what source material (the bounded
   crawl's `sourceSummary`) the proposal was based on. No other panel in this
   UI has this concern; it is unique to the new interaction this epic builds.
5. **Information density / scannability** — every existing panel in this UI
   (Lanes, Search, Graph, Operations) is a dense, structured-data,
   table/monospace surface, and this system already operates at
   multi-tier/multi-repo scale, not toy-demo scale. The redesign must not
   regress "scan a lot of real data fast" in service of looking cleaner.
6. **Existing-shell design-language consistency** — this repo has no
   `brand-system.yaml` (confirmed absent; `/design`'s own doc says brand
   context is "preferred but not required," falling back to general
   heuristics when absent) — so the real consistency bar is not a generic
   brand check but fidelity to THIS codebase's own already-established
   zero-dep-vanilla-JS/dark-theme/table conventions across its other 6
   panels, so the Personas panel doesn't become a visually foreign island.
7. **Multi-tier/multi-repo hierarchy legibility** — this whole system exists
   to author personas that orchestrate across projects/companies/repos; a
   lens reviewing specifically whether the design scales and orients
   correctly as personas grow across 4 tiers, multiple repos, `parentRefs`
   chains, and (now) pending drafts — not just whether it looks fine for the
   3-persona demo case research confirmed is the current real state of this
   repo's own store.

## 5. Risks

| Risk | Mitigation |
|---|---|
| The multi-swarm design pass (pu-01) is treated as decorative and the UI tickets get built against ad-hoc judgment instead of its actual synthesized output. | pu-01 is sequenced early with pu-10/pu-11/pu-12 explicitly `depends_on` it in the dependency graph below, and pu-14's design-fidelity pass checks the shipped UI against pu-01's chosen option after the fact — not just at kickoff. |
| The new draft/staging mechanism becomes a SECOND, divergent write path instead of a thin pre-stage in front of the existing one — the exact class of risk the wizard epic's own risk table flagged repeatedly for its 4 transports. | Approval calls `writeGlobalPersona`/`writeRepoLocalPersona` unchanged (§3b) — `assertValidPersona` remains the single real enforcement point; draft-store code never re-implements schema validation. Verified explicitly in pu-06's transport tests. |
| A draft leaks into a live-render path (`getPersonaContent`, `CLAUDE.md`/`AGENTS.md` sync) before being approved, because the draft store lives too close to the real one. | Structural separation, not a runtime filter: drafts live under a completely different root (`~/.mnemosyne/persona-drafts/`, never `~/.mnemosyne/personas/` or `<repoRoot>/.mnemosyne/personas/`) that `getPersonaContent`/`sync.ts` never read from at all — the same "structurally unable to" guardrail pf-12 already uses for parent-content copy-down, applied to a new boundary. |
| A repo-local draft accidentally gets git-committed into a consuming repo's history. | Drafts are never written inside any repo's working tree at all (home-rooted, §3b) — there is no `.gitignore` entry to forget, because there is no in-tree file to ignore. |
| The interview skill's default behavior change (draft-first instead of direct-write) silently breaks the wizard epic's own already-shipped, already-passing tests (`persona-interview-skill.test.ts`, `persona-interview-output.test.ts`, `persona-interview-crawl-and-feed.test.ts`). | A `--commit-directly` escape hatch (§9 judgment call #3) reproduces the OLD exact behavior byte-for-byte; pu-09's regression suite proves this explicitly rather than assuming it. |
| The layer-stack UI section (pu-11) hard-codes assumptions about the sibling `mnemosyne-memory-levels` epic's not-yet-shipped 0-4 numbering, breaking the moment that epic ships. | pu-11's acceptance criteria explicitly require rendering whatever `GET /layers` actually returns today (names, not a hard-coded 0-4 scheme) — flagged as OQ1 (§8) rather than guessed at. |
| 7 independent review-lens dispatches + 3-direction option generation + synthesis is a genuinely large number of agent calls for one ticket (pu-01) — real risk of runaway cost/time if not scoped tightly. | pu-01's acceptance criteria cap scope explicitly: 3 initial directions (not more), 7 named lenses (not "as many as seem useful"), 3 final options (not N) — matching the operator's own stated numbers exactly, not expanded. |
| Discard-by-archive (never hard-delete) lets `~/.mnemosyne/persona-drafts/{approved,discarded}/` grow unbounded over the life of a Mnemosyne install. | Explicitly accepted, matching this codebase's existing "never delete, mark disposition" posture for flight-status memory — flagged as a known, accepted tradeoff (§9), not a bug; a future cleanup/retention ticket is out of this epic's scope. |

## 6. Dependencies

- Existing, unchanged: everything Epic 1/2 shipped — `persona.ts`, both real
  stores, `withLock`, `assertValidPersona`, all 4 existing write transports,
  the interview skill's question-sequencing mechanics
  (`interview-engine.mjs`), `lib/mnemosyne/server.ts`'s existing route table
  and `applyPersonaCors`.
- New, this epic: a draft persona store (pu-02), draft HTTP routes (pu-03),
  draft CLI verbs (pu-04), draft skill-harness/MCP wraps (pu-05), draft
  cross-transport tests (pu-06), a bounded-crawl step for the interview skill
  (pu-07), a draft-first default for the interview skill's write step + a
  `--commit-directly` escape hatch (pu-08), regression coverage proving the
  escape hatch reproduces old behavior exactly (pu-09), the redesigned
  Personas panel shell (pu-10, depends on pu-01's chosen synthesized option),
  the re-integrated layer-stack section (pu-11), the unified draft
  review/approve UI absorbing the old create/edit form (pu-12, depends on
  pu-01 and pu-03), a full agent-propose → human-approve → real-commit
  end-to-end regression (pu-13), and a design-fidelity review against pu-01's
  chosen option (pu-14).
- Documented input, not owned by this epic: the corrected 5-level memory
  model (sibling `mnemosyne-memory-levels` epic, different branch, not yet
  built) — referenced only in pu-11's UI copy/labeling, never in structural
  logic that assumes its not-yet-shipped schema.

## 7. Scale assessment

**Confirmed: large — comparable to or larger than the wizard epic's own
17-story scope**, per the operator's own framing ("genuinely new multi-agent
design workflow, a new interaction paradigm, real backend staging/approval
wiring, plus the UI build-out itself"). 14 stories across 2 tracks (draft/
staging backend + interview-skill extension: pu-02..pu-09, 8 stories; design
exploration + UI build-out: pu-01, pu-10..pu-14, 6 stories) — proceeding to
full horizontal/vertical delivery planning below.

## 8. Open questions — NOT resolved here, flagged rather than guessed at

**OQ1 (layer-stack UI section vs. the sibling epic's unshipped schema).**
This session has zero visibility into `mnemosyne-memory-levels`' actual
shipped route/field shape. pu-11 is built defensively against today's
`GET /layers` response (names in cascade order, `writable` boolean) and
explicitly avoids hard-coding the corrected 0-4 numbering into any logic —
but once that sibling epic ships, a follow-up ticket to this epic (or a new
one) will likely be needed to actually surface the corrected numbering
structurally, not just in prose. Not blocking this epic; flagged so it isn't
silently forgotten.

**OQ2 (authentication/access posture for the new approve action).**
`lib/mnemosyne/server.ts`'s own doc comment states "No authentication —
localhost-only for this slice; auth is future work" — a posture Epic 1/2
already accepted and this epic inherits unchanged for read/propose/edit
routes. Approval is a meaningfully more consequential action (it is the
literal human-in-the-loop gate ask 2 exists to create) than a plain read, and
this session is not confident making a unilateral call that "no additional
guard beyond what POST /persona already has" is correct for this specific
route without operator sign-off, given how central "a human approves" is to
the whole feature's stated purpose. Flagged for explicit operator
confirmation before pu-03 ships; the default assumption carried into planning
is "same posture as every other route in this file, no new auth," but this
is named as an assumption, not asserted as a decision.

**OQ3 (where does `remember()`'s "initial crawl and feeding" step fire once
the default flow is draft-first?).** Discovered while decomposing pu-08: the
already-shipped interview skill fires `remember()` unconditionally,
immediately after every commit (step 8). Once the default write target
becomes a draft (pu-08), firing `remember()` at that same moment would
index unreviewed, not-yet-human-approved source material into searchable
memory — plausibly worse than the problem ask 2 exists to fix. The natural
new firing point is post-approval, but that could reasonably live in the
generic approve route/CLI verb (H3/H4 — except a human-typed draft has no
`sourceSummary`/source material to remember at all, so a generic hook would
need to special-case draft provenance) or as a separate, explicit step the
interview-skill's own documentation still owns. This session is not
confident which shape is correct without operator input, so pu-08 defers
`remember()` firing to the `--commit-directly` escape-hatch path only
(matching pre-epic behavior exactly for that path) and explicitly does NOT
wire a default-path equivalent — flagged here, and in pu-08's own risk table,
rather than guessed at silently. Whoever executes pu-13 (the full-loop e2e
regression) should decide at that point whether closing this gap is in pu-13's
own scope or needs a 15th ticket; this planning pass deliberately does not
pre-decide that either way.

## 9. Resolved judgment calls (orchestrator judgment call, not re-escalated — reversible implementation details, decided with reasoning rather than blocking)

1. **3 initial design directions in pu-01, not more or fewer.** The operator
   said "come up with options" (plural, uncounted) and "make 3 new options"
   (explicitly counted) for the synthesis step. 3 initial directions gives
   the 7-lens panel genuine variety to critique without tripling the review
   burden past what 7 already-large independent dispatches can reasonably
   absorb, and keeps the initial-option count from outnumbering (and
   therefore overshadowing) the 3 final synthesized options the operator
   explicitly asked for.
2. **Selection among pu-01's 3 synthesized options happens via a documented,
   reasoned pick inside pu-01 itself (recorded in its own output), not a
   blocking operator touchpoint.** `/design`'s own `wireframe-protocol`
   touchpoints (`AskUserQuestion`) assume an interactive operator; this
   planning pass and the epic's later execution are explicitly framed as
   able to proceed without one. pu-01's acceptance criteria require the
   selection rationale to be written down in the same artifact directory as
   the 3 options themselves, so it is reviewable and reversible by a human
   at execution time, not silently baked in.
3. **The interview skill's default write target becomes the new draft store;
   a `--commit-directly` flag reproduces the exact old (pre-epic) behavior.**
   This is the concrete mechanism by which ask 2's "a human to approve it,
   rather than expecting a full drill down in one text body" actually takes
   effect for the agent-assisted path, while pu-09's regression suite keeps
   the wizard epic's own already-shipped tests meaningful (they exercise the
   flag explicitly, proving the old behavior didn't silently regress rather
   than being deleted to make the new default pass).
4. **The redesigned Personas panel gets exactly ONE review/approve surface,
   which pw-17's existing create/edit form is retargeted into** (pu-12),
   rather than building a second, parallel "manual create" path alongside a
   separate "agent-proposed draft review" path. Both a human typing a persona
   by hand and an agent proposing one via the bounded crawl produce the same
   shape of thing (an active draft at `{tier, scopeId}`) and should be
   reviewed/approved through the same UI, not two UIs a future maintainer
   has to keep in sync.
5. **Draft disposition (approve/discard) is archive-by-move, never a hard
   delete**, mirroring this codebase's own already-shipped flight-status
   philosophy (provisional/confirmed/superseded, never deleted) rather than
   inventing a different retention posture for this one new store.
6. **Repo-local drafts are keyed by a sanitized absolute-path slug under a
   home-rooted `repo-local/` subtree, not stored inside the target repo at
   all** — reuses `resolveRememberScope()`'s exact existing sanitization
   rule (`persona.ts`) rather than a new one, and avoids ever mutating a
   consuming repo's `.gitignore` or working tree for ephemeral review state.
7. **Draft-route dispatch in `server.ts` is added as new branches checked
   BEFORE the existing generic `/persona/:tier/:scopeId` handlers**, not
   folded into them — the existing handlers' own `segments.length !== 2`
   guard already happens to reject a 3-segment `/persona/draft/:tier/:scopeId`
   path harmlessly today, but relying on that as the ONLY protection against
   collision would be fragile; explicit ordering is the real guarantee.
