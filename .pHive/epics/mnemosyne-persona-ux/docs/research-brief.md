# Research Brief — mnemosyne-persona-ux (Epic 3 of 3, personas line of work)

All research done on `feat/mnemosyne-persona-ux` (branched from `main`), against
the shipped state of Epic 1 (`mnemosyne-persona-foundation`, v0.6.0/v0.7.0) and
Epic 2 (`mnemosyne-persona-wizard`, closed pw-01..pw-17, write primitive +
interview skill + Personas panel view+write form all shipped).

## 0. Operator asks, verbatim (ground truth for this whole epic)

This epic exists because of two explicit operator asks made in this session,
quoted verbatim since both are load-bearing for every downstream decision
below:

**Ask 1 (multi-swarm design pass):** *"take this through a real multi swarm
design phase, come up with options, have 7 personas review and give feedback
and then make 3 new options from all of the feedback -- use the frontend
design skill and other plugins to nail that out because it needs some heavy
UI/UX lift."*

**Ask 2 (agent-assisted build-and-approve interaction):** *"the personas need
more than a single entry form, we have to be able to work with an agent to
develop and deploy those personas, give it a way to crawl and help build a
short, reasonable context on there without overdoing it -- so we want to nail
that across where we work with an agent to say -- your context is high level
over these projects, here is a brief summary, here are the repos, help me do
the topmost understanding and metadata for this so you can orchestrate ....
etc etc -- we need an interaction to build that and then a human to approve
it, rather than expecting a full drill down in one text body."*

## 1. The Personas panel today — exact

`ui/index.html` (`<section id="personas" class="panel panel-wide">`,
lines 195-266) is a single flat table (`personas-table`/`personas-tbody`:
tier, scope ID, display name, parent(s) — pointer-only) plus ONE
create/edit `<form id="persona-form">` (lines 227-265) with 7 flat fields
(tier select, scopeId, displayName, scope, one section heading, one section
body, optional repo). `ui/app.js`'s `loadPersonas()` (lines 1229-1277) fetches
`GET /persona` + one `GET /persona/:tier/:scopeId` per row (cross-origin to
`lib/mnemosyne/server.ts`, port 3141, via `personaServiceOrigin()`), renders
the table, and the form's submit handler (lines 1297-1344) `POST`s the same
bare candidate shape straight to `POST /persona/:tier/:scopeId` — the real
write primitive, no intermediate state, no review step. `personasStatusEl`/
`personasTbodyEl` (module-level DOM refs, lines 15-16) are the only state this
panel tracks; there is no client-side model of "draft" vs. "committed," no
diffing, no multi-section editing (the form's `sections` array is always
exactly one `{heading, body}` entry — pw-17's own comment calls this "the v1
minimum viable write path, not a full multi-section editor").

A second, visually and structurally separate section, `#persona-layer-stack`
(lines 276-307, pw-04), shows the currently configured layer stack via the
already-shipped `GET /layers` plus a static, view-only Level 0 pointer. It
never merges with the persona list (research-brief.md §6 of the wizard epic
established this boundary; nothing here proposes changing it).

**Implication:** every part of this panel assumes "operator fills in a flat
form, submits, it's live" — there is no concept anywhere in the UI (or the
backend it talks to) of a persona that exists but hasn't been approved yet.
Ask 2 requires inventing that concept from scratch, not extending an existing
one.

## 2. `skills/mnemosyne-persona-interview` — exact, already shipped, no UI path

Read in full (`SKILL.md`, `interview-engine.mjs`, `persona-writer.mjs`,
`persona-remember.mjs`). This is a real, working, TDD-verified skill
(pw-10/11/12/13) that:

- Loads context BEFORE asking anything (step 2: `TIER_CONTENT[tier]`, an
  existing persona at this `{tier, scopeId}` if re-authoring, "any other
  already-known material handy in the conversation") — this is the one place
  today's system does anything resembling "crawl for context first," but it
  is scoped to whatever the live conversation already contains, not a
  described, bounded, file-system/repo crawl.
- Asks 3 core + 2 optional adaptive-skip questions (`interview-engine.mjs`'s
  `CORE_QUESTIONS`/`OPTIONAL_QUESTIONS`), grounded line-by-line in
  plugin-hive's `kickoff-protocol.md` Phase 3b pattern.
- **Writes immediately and directly** (SKILL.md step 7): `persona-writer.mjs`'s
  `writePersonaViaCli()` spawns a real `mnemosyne persona create --file
  <tmp-file>` subprocess — the exact same real write primitive
  `POST /persona/:tier/:scopeId` also calls. There is no gap between "the
  interview finishes" and "the persona is live" — no draft, no review, no
  approval, no undo.
- Fires a real `remember()` call unconditionally right after (step 8,
  `persona-remember.mjs`'s `rememberInterviewSource()`), scoped via pw-09's
  `resolveRememberScope()`.
- **Runs only inside a live Claude Code (or similar) agent session** — SKILL.md
  is explicit about this: the CLI is chosen over MCP/skill-harness precisely
  because "a live Claude Code skill session always has a direct shell-out
  primitive available." There is no browser entry point into this flow at
  all today — an operator who wants the agent-assisted authoring experience
  has to already be inside a terminal-based agent session; the standalone UI
  (`ui/`) has zero awareness this skill exists.

**Implication:** ask 2's "crawl and help build a short, reasonable context...
without overdoing it" has no analog today — step 2's context-loading is
opportunistic, not a deliberate, bounded crawl with a named source list and
an explicit cap. And ask 2's "a human to approve it, rather than expecting a
full drill down in one text body" is flatly contradicted by the current
shipped behavior: the skill commits on completion, full stop. Building the
approval gate is genuinely new work, not a UI wrapper around something that
already pauses for review.

## 3. Persona write/read primitives — no staging/draft concept anywhere

Confirmed by reading `lib/mnemosyne/layer1/persona.ts`,
`persona-store-global.ts`, `persona-store-repo-local.ts`, and grepping the
whole tree (`lib/`, `bin/`, `skills/`, `ui/`, `src/`) for "draft" — the only
hits are an unrelated schema comment, an unrelated fixture filename, and
`interview-engine.mjs`'s own doc comments describing itself (not a draft
storage concept). `writeGlobalPersona`/`writeRepoLocalPersona` are the
**only** write path anywhere in this codebase, at every transport (CLI, MCP,
skill-harness, HTTP `POST /persona/:tier/:scopeId`) — all four are thin
wraps of the same two functions, which call `assertValidPersona` (full-schema
validation, rejects `mandateSections`) and `withLock` before ever touching
disk. There is no partial-write, no staging area, no "proposed but not yet
real" state anywhere in the persistence layer.

`persona-store-repo-local.ts`'s own doc comment is explicit and load-bearing
for this epic's staging design: *"git-committed alongside the code it
describes (not gitignored — see .gitignore, which deliberately has no
`.mnemosyne/personas` exclusion)."* Any new draft/staging location that lives
inside a consuming repo's `.mnemosyne/` tree would either need to mutate that
repo's `.gitignore` (an operational burden Mnemosyne does not otherwise take
on for any consuming repo) or risk an in-progress/rejected draft getting
git-committed by accident.

**Implication:** ask 2's "a human to approve it" needs a genuinely new
storage concept — not a schema field bolted onto `Persona` (that would let a
draft leak into `getPersonaContent`'s live-render path, and by extension into
`CLAUDE.md`/`AGENTS.md` sync, unless every one of those call sites is also
taught to filter on a new status field — a far larger, riskier surface than a
structurally separate location) — and that location should not live inside a
consuming repo's git-tracked tree.

## 4. `lib/mnemosyne/server.ts` route table — exact

Confirmed by reading the file in full (`GET /health`, `GET /layers`,
`GET /persona`, `GET /persona/:tier/:scopeId`, `POST /persona/:tier/:scopeId`,
`OPTIONS /persona/*` preflight, `POST /recall`, `POST /remember`). CORS is
handled by one reusable helper, `applyPersonaCors()` (lines 118-124),
scoped to an explicit allow-list (`UI_ORIGINS`: `127.0.0.1:8477`/
`localhost:8477`, never a wildcard) — every route above calls it, and every
new route this epic adds should too, per the wizard epic's own explicit
"no second CORS implementation" convention (already proven out the hard way:
pw-17's own note-on-completion describes a real preflight bug caught and
fixed after the write form shipped).

The write route (`POST /persona/:tier/:scopeId`, lines 308-386) treats the
request body as the bare persona candidate itself (no envelope), with `repo`
stripped out as routing metadata before the rest passes through unchanged to
`writeGlobalPersona`/`writeRepoLocalPersona` — validation happens exactly
once, inside those functions, never re-implemented at the route layer.

**Implication:** new draft-related routes should follow this file's already-
proven shape exactly (same CORS helper, same bare-candidate-body convention,
same "the write functions are the only place validation happens" principle)
rather than inventing a new response/error shape.

## 5. plugin-hive's `/design` skill and `.workflow.yaml` format — exact

Read `skills/design/SKILL.md` (plugin-hive 2.15.0) in full. `/design`'s
default shape is a **single** ui-designer dispatch (optionally preceded by an
accessibility-specialist + animations-specialist *constraint* pass under
`--include-constraints`, never a critique-after-the-fact pass) — it produces
exactly one set of wireframes per topic under `.pHive/design/<topic>/`
(`v1.png`, `wireframe.f0`/`.txt`, `brief.md`, `selected.txt`, optional
`accessibility-constraints.md`/`animations-constraints.md`), registered in
`.pHive/design/index.yaml`. **This is explicitly NOT what ask 1 wants.**
`/design`'s own "What /design is NOT" section confirms it: "Not a
design-review" — critique happens downstream, one artifact set at a time,
never fan-out-many-options → multi-lens-review-all → synthesize-new-ones.

The genuinely-comparable real precedent this repo's Hive tooling already has
is the `.workflow.yaml` format itself (`hive/workflows/design-review.workflow.yaml`,
`hive/workflows/ui-design.workflow.yaml`): a declarative step graph
(`id`/`agent`/`task`/`depends_on`/`inputs`/`outputs`, each step a real
subagent dispatch), already used for exactly the "N specialist critiques →
one synthesis" shape `design-review.workflow.yaml` implements (accessibility-
critique + animations-critique + design-critique, all fed into one
`synthesis` step). Confirmed by grepping this repo: there is **no**
repo-local custom-workflow directory or `hive.config.yaml` hook for
registering a new first-class `.workflow.yaml` (the only `workflows/` tree
found lives inside the plugin cache, `~/.claude/plugins/cache/plugin-hive/...`,
not this repo). A genuinely new, repo-specific 3-phase fan-out (options →
7-lens panel → synthesis) is therefore not a call to some pre-existing
7-persona review workflow — none exists — but a new step sequence this
epic's own first ticket must define and execute directly (via this session's
own multi-agent dispatch mechanism), in the same `id`/`agent`/`depends_on`
step shape `design-review.workflow.yaml` and `ui-design.workflow.yaml`
already establish, so it reads as consistent with this repo's Hive
conventions rather than a bespoke one-off.

**Implication:** ask 1's "use the frontend design skill and other plugins"
means grounding the new fan-out-then-synthesize pass in `/design`'s
artifact-directory convention (`.pHive/design/<topic>/`) and in
`design-review.workflow.yaml`'s step-graph shape for the *structure* of the
pass, while building genuinely new orchestration (option-generation → 7-lens
panel → synthesis) that does not exist as a callable skill today.

## 6. The corrected 5-level memory model — documented ground truth, sibling body of work, not yet shipped

Per this session's explicit operator framing (not independently re-derived
here — a parallel body of work, `mnemosyne-memory-levels`, is planned on a
different branch to correct the store model): **5 distinct levels — 0 =
mnemosyne injection rules, 1 = repo agent-overlay files, 2 = graph, 3 =
vector, 4 = file doc store.**

What is actually shipped and confirmed in this repo today (`docs/
layer-architecture-v2-plan.md`, v0.3.0, `~/.claude/projects/.../memory/
project_layer_architecture_v2.md`) is a *different*, already-superseded
numbering: Level 0 (`~/.mnemosyne/level0-rules.md`, global rules) + Layer 1
(tier-scoped, synced into `CLAUDE.md`/`AGENTS.md`/`GEMINI.md`) + a 3-tier
"Layer 2/3" collapse (memory framework + graph tool) that does not cleanly
match the corrected 0-4 numbering above. The existing UI's own layer-stack
section (`GET /layers`, `client.getConfiguredLayers()`) renders whatever
`MnemosyneClient`'s layer registry currently resolves to (`meta`,
`enterprise`, `project`, `code-graph`, `vector`, `file`, `hive-memory`,
`graphify`, `crossref-linker`, `keyword` — confirmed against `server.ts`'s
own `LAYERS` set) — a config-driven *name* list, not the corrected numeric
0-4 model at all.

**Implication:** this epic's UI redesign must treat the corrected 0-4 model
as a **documented input to design against**, not something to build or
enforce in code here — the sibling epic owns the schema/registry change. Any
UI copy or labeling that references "levels" should be written so it degrades
gracefully against whatever `GET /layers` actually returns today (names, not
numbers) and does not hard-code an assumption the sibling epic's still-
unshipped schema change would immediately break. This is called out as an
explicit risk in the design discussion below, not silently assumed away.

## 7. Existing epics' conventions — confirmed exactly (governs this epic's own file shapes)

Read `mnemosyne-persona-foundation` and `mnemosyne-persona-wizard` epics in
full: `epic.yaml` (flat `name`/`title`/`target_codebase`/`methodology`/
`version_bump` + a `stories[]` list of `{id, title, complexity, depends_on}`),
per-ticket YAML at `.pHive/epics/<epic>/stories/<id>.yaml` (not `tickets/` —
confirmed the exact subdirectory name both prior epics use), and
`docs/{research-brief,design-discussion,horizontal-plan,vertical-plan}.md`.
Ticket YAML schema confirmed field-by-field: `id`, `epic`, `title`, `status`,
`complexity`, `methodology`, `depends_on`, `description`,
`acceptance_criteria` (Given/When/Then-shaped bullets), `steps[]`
(`id`/`description`/`agent`/`depends_on`), `context.codebase` +
`context.key_files[]` (`path`+`purpose`), `files_to_modify[]`
(`file`+`change`), `design_decisions[]` (`decision`+`rationale`),
`cross_cutting[]`, `risks[]` (`severity`/`description`/`mitigation`),
`references[]` (`path`+`relevant_excerpt`). This epic's own ticket files
follow this shape exactly (see `.pHive/epics/mnemosyne-persona-ux/stories/`).
