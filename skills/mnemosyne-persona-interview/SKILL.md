---
name: mnemosyne-persona-interview
description: Multi-turn, adaptive interview that authors a Layer 1 Persona record (tier + scopeId + displayName + scope + sections + optional parentRefs) by conversing with an operator, then writes it and remember()s its source material. Grounded line-by-line in plugin-hive's kickoff-protocol.md "Phase 3b: Discovery Questions" pattern -- the only real, working precedent for this shape anywhere this repo depends on. Use when an operator wants to AUTHOR a new persona (or revise an existing one) for any tier -- top-orchestrator, company-director, project-orchestrator, or code-architect -- at either repo-spinup-lifecycle moment: before any repo exists (global tiers) or once a repo exists (code-architect). Contrast with mnemosyne-standalone, which is stateless/table-driven, one action per call, and never conducts a multi-turn conversation.
---

# Mnemosyne Persona Interview

A multi-turn Claude Code skill that conducts an adaptive interview with an
operator to author a Layer 1 `Persona` record
(`lib/mnemosyne/layer1/persona.ts`), then writes it through the existing
persona-write primitive (pw-06/pw-07's `persona create` / `persona_create`)
and, per the operator's "initial crawl and feeding" requirement
(design-discussion.md §3b), `remember()`s the source material the interview
surfaced.

**This is genuinely new territory for this repo.** No interview/multi-turn
pattern exists here today -- `skills/mnemosyne-standalone/SKILL.md` is
explicitly stateless, table-driven, one action per call (see that file's own
"What this skill is NOT"). This skill deliberately departs from that shape
because authoring a persona is inherently conversational: the content only
the operator knows (what a specific persona instance actually holds, what it
explicitly does not, whether it has a parent) cannot be filled in from a
table lookup.

**It does not invent new interview mechanics.** It is grounded line-by-line
in plugin-hive's `kickoff-protocol.md` **"Phase 3b: Discovery Questions"**
section (`~/.claude/plugins/cache/plugin-hive/plugin-hive/*/hive/references/kickoff-protocol.md`)
-- the only real, working precedent for "adaptive, individually-skippable,
non-blocking interview that still produces a valid structured record" that
this repo already depends on for its own Hive planning. Every mechanic below
cites the corresponding kickoff-protocol.md rule it reproduces. See "Grounded
in kickoff-protocol.md" further down for the full mapping.

**Input:** `$ARGUMENTS` names:
- `tier` (required) -- one of `top-orchestrator`, `company-director`,
  `project-orchestrator`, `code-architect`.
- `scopeId` (required) -- the persona instance's human-assigned identifier
  (company/project/repo name). Identity, not a question -- the operator
  supplies it, this skill never guesses or auto-detects it
  (design-discussion.md's Risks table, "plain label, no auto-detection").
- `repo` (required only for `code-architect`; omit for the 3 global tiers) --
  the repo whose repo-local persona store (`.mnemosyne/personas/`) this
  interview writes into.
- `root` (optional, global tiers only) -- overrides the global persona
  store's root (`~/.mnemosyne/personas`), mirrors `persona-seed`/
  `persona-create`'s own `root` parameter, mainly for test isolation.

## Process

1. **Resolve tier/store and confirm the lifecycle moment.** Look up
   `PERSONA_STORE_BY_TIER[tier]` (`lib/mnemosyne/layer1/persona.ts`) --
   `global` for the 3 orchestrator/director tiers, `repo-local` for
   `code-architect`. This single lookup is what makes the skill "work at
   both repo-spinup-lifecycle moments" (design-discussion.md §3e) with **zero
   new storage-level work**: Epic 1's two-store split already structurally
   supports "ideate at the company/project level before a repo exists, then
   author code-architect content once a repo exists" -- this skill only needs
   to dispatch correctly on `tier`, not build new lifecycle infrastructure.
   - **Before any repo exists** (global tier: `top-orchestrator` /
     `company-director` / `project-orchestrator`): no `repo` argument is
     needed or used; the interview authors straight into the global persona
     store.
   - **Once a repo exists** (`code-architect`): `repo` is required; the
     interview authors into that repo's `.mnemosyne/personas/` store.

2. **Load context BEFORE asking anything** (this is what makes step 3
   adaptive, not a fixed script): read whatever is already known --
   - `TIER_CONTENT[tier]` (`lib/mnemosyne/layer1/tiers.ts`) for this tier's
     canonical `displayName` and one-line `scope` statement. Since the tier's
     canonical responsibility statement already exists in code, default
     `displayName`/`scope` from it and do **not** ask a redundant "what does
     this tier do" question -- ask instead about what THIS persona instance
     (this `scopeId`) specifically knows, which `TIER_CONTENT` cannot answer.
   - An existing persona at this `{tier, scopeId}`, if one is already on
     disk (`persona-show` / `persona show`) -- if re-authoring, treat its
     current `sections` as context so a re-run does not force the operator
     to repeat themselves.
   - Any other already-known material handy in the conversation (e.g. a
     project profile, prior discussion) that plainly answers one of the
     questions below.

3. **Ask the adaptive question set, core first, skipping anything context
   already answered.** Mirrors kickoff-protocol.md Phase 3b's own table
   shape and its explicit instruction: *"Before asking, check what
   current-state discovery already surfaced. Do NOT re-ask items already
   answered."*

   | # | Question | Maps to | Skip if already captured |
   |---|----------|---------|---------------------------|
   | 1 | What does this persona know? (its actual working knowledge for THIS scopeId -- not the tier's canonical responsibility statement, which `TIER_CONTENT[tier]` already answers) | a `sections` entry, heading "What this persona knows" | Context already states this persona's specific knowledge |
   | 2 | What does it explicitly NOT hold? | a `sections` entry, heading "What this persona does NOT hold" | Context already states this |
   | 3 | Does it have a parent to query up to? (a parent `tier` + `scopeId`, or "none") | a `sections` entry, heading "Parent to query up to", plus `parentRefs` when a real parent is named | Context already names (or explicitly rules out) a parent |

   After the 3 core questions, offer 2 optional follow-ups (clearly marked
   optional; skip on empty reply, "skip", "pass", or explicit "no" -- mirrors
   kickoff Phase 3b's own `success`/`avoid` optional pair verbatim):

   | # | Question | Maps to |
   |---|----------|---------|
   | 4 | What does success look like for this persona? *(optional)* | a `sections` entry, heading "Success" |
   | 5 | What should this persona avoid? *(optional)* | a `sections` entry, heading "Avoid" |

4. **Apply the persistence rule** -- kickoff-protocol.md Phase 3b, verbatim
   pattern: *"Answered questions: write the operator's answer verbatim...
   Skipped/deferred questions: write `unknown`... Optional follow-ups
   skipped: omit the field rather than writing `unknown`."* This skill's
   exact reproduction:
   - **Answered** (core or optional): write the operator's answer verbatim
     as that question's `sections` entry body.
   - **Skipped CORE question**: still add a `sections` entry for it, with
     body set to the explicit marker `[not provided — skipped during
     interview]` -- kickoff's convention (an explicit marker, never silent
     omission) reproduced exactly, just with persona-shaped wording instead
     of `unknown`.
   - **Skipped OPTIONAL question**: omit the `sections` entry entirely --
     no marker, no placeholder, matching kickoff's own optional-follow-up
     rule (`success`/`avoid` fields are omitted, not set to `unknown`, when
     skipped).
   - **Parent question answered "none"**: NOT a skip -- it was actually
     answered, just in the negative. Its `sections` entry gets a real,
     explicit "no parent" statement (not the skip marker), and `parentRefs`
     stays absent.

5. **Apply the non-blocking hard-fail rule.** kickoff-protocol.md Phase 3b:
   *"It is non-blocking — every question is individually skippable and
   kickoff MUST NOT hard-fail if all are skipped."* and *"kickoff MUST
   continue normally after Phase 3b regardless of how many questions were
   skipped."* This skill's exact reproduction: continue the interview to
   completion and produce a valid, writable `Persona` record **even if every
   core and optional question is skipped**. `displayName` and `scope`
   default to `TIER_CONTENT[tier]`'s canonical values (step 2) or, failing
   that, a non-empty placeholder -- never left empty, since
   `assertValidPersona` (`lib/mnemosyne/layer1/persona.ts`) rejects an empty
   `displayName`/`scope`. A fully-skipped interview still yields 3
   placeholder `sections` entries (one per core question) and passes
   `assertValidPersona` unchanged -- proven for real, not just asserted, by
   `lib/mnemosyne/layer1/__tests__/persona-interview-skill.test.ts`'s
   "max-skip" case.

6. **Assemble and validate the candidate.** The resulting shape is exactly
   `Persona` (`lib/mnemosyne/layer1/persona.ts`): `{tier, scopeId,
   displayName, scope, sections, parentRefs?}`. Never attach a
   `mandateSections` key -- `assertValidPersona` rejects mere presence of
   that key (it is code-owned, re-injected at render time, never
   author-storable). `skills/mnemosyne-persona-interview/interview-engine.mjs`'s
   `runPersonaInterview()` is the reference implementation of steps 3-6's
   mechanics (adaptive skip resolution, placeholder-vs-omit persistence,
   `parentRefs` construction) -- use it (or reproduce its exact behavior) when
   assembling the candidate programmatically; do not hand-roll a second,
   divergent version of the same logic.

7. **Write the candidate.** Serialize the assembled candidate to a YAML file
   and pass it through the existing write primitive -- never a new one:
   - CLI (**default, real invocation mechanics below** -- pw-11): `mnemosyne
     persona create --file <path> [--repo <repo>] [--root <root>]`
     (`bin/mnemosyne-persona.mjs`, pw-05).
   - MCP: the `persona_create` tool (`bin/mnemosyne-mcp.mjs`, pw-07).
   - Skill-helper (if driving `mnemosyne-standalone` directly): the
     `persona-create` action (`bin/mnemosyne-skill-helper.mjs`'s
     `personaCreateAction`, pw-06).
   All three are thin wraps of the same `writeGlobalPersona`/
   `writeRepoLocalPersona` call, which itself calls `assertValidPersona`
   before ever touching disk -- this is the real enforcement point (persona.ts's
   own doc comment), not this skill's own judgment.

   **Why the CLI, concretely (pw-11's research step):** this skill runs
   INSIDE a live Claude Code (or similar) agent session, which always has a
   direct shell-out primitive available -- unlike the MCP transport (needs a
   running MCP server connection the session may or may not have open) or
   the skill-harness transport (really `mnemosyne-standalone`'s own action
   dispatch, a different skill's surface). The CLI is the one write surface
   guaranteed reachable with zero additional transport setup, the same
   reasoning `resolveRememberScope`'s doc comment (`persona.ts`) already
   applies when picking `remember()`'s real target for this same caller.
   Nothing stops a caller from instead driving `personaCreateAction` or the
   MCP `persona_create` tool with the identical YAML this step produces --
   they accept the same document shape -- but the CLI is this skill's
   default.

   **Real invocation mechanics** --
   [`persona-writer.mjs`](persona-writer.mjs) (pw-11) is the reference
   implementation of this step, used directly by
   `lib/mnemosyne/layer1/__tests__/persona-interview-output.test.ts`'s
   real, disk-round-tripping proof:
   - `personaToYaml(persona)` serializes the candidate with the exact same
     `yaml` package call (`stringify(candidate)`) `persona-store-global.ts`/
     `persona-store-repo-local.ts` themselves use on the write side -- one
     document shape for both directions. `sections` (array of `{heading,
     body}`) and `parentRefs` (array of `{tier, scopeId}`), when present,
     serialize as native YAML sequences of mappings; no manual line-building
     needed for either field.
   - `writePersonaViaCli(persona, {repo, root, home})` writes that YAML to a
     throwaway temp file, then spawns a REAL `tsx`-launched
     `mnemosyne persona create --file <tmp-file> [--repo <repo>] [--root
     <root>]` subprocess (mirrors `test/persona-cross-transport.mjs`'s own
     CLI-subprocess helper). Pass `repo` for a `code-architect` candidate;
     omit it for the 3 global tiers (optionally pass `root` to override the
     global store's root, e.g. for test isolation). Returns
     `{ok, stdout, stderr, writtenPath}` -- `writtenPath` is parsed from the
     CLI's own `created ... -> <path>` stdout line, never independently
     recomputed.
   - `showPersonaViaCli(tier, scopeId, {home})` reads a global-tier persona
     back via the real `mnemosyne persona show <tier> <scope-id>` subprocess
     (pf-13). `code-architect` has no CLI `show` surface -- read that tier's
     persona back with a direct file read instead (e.g.
     `readRepoLocalPersona`, `persona-store-repo-local.ts`).

8. **`remember()` the source material** (design-discussion.md §3b's "initial
   crawl and feeding" requirement). **Now wired for real (pw-13)** --
   [`persona-remember.mjs`](persona-remember.mjs)'s
   `rememberInterviewSource(persona, opts?)` is the reference implementation
   of this step, used directly by
   `lib/mnemosyne/layer1/__tests__/persona-interview-crawl-and-feed.test.ts`'s
   real, HTTP-round-tripping proof. Call it with the completed interview's
   `persona` record right after step 7's write succeeds:
   - It resolves the scope via pw-09's `resolveRememberScope()`
     (`lib/mnemosyne/layer1/persona.ts`) through a REAL `tsx`-launched
     `mnemosyne persona resolve-remember-scope --tier <tier> --scope-id
     <scopeId>` subprocess (`bin/mnemosyne-persona.mjs`'s
     `resolve-remember-scope` subcommand, added by this story) -- never a
     separate, invented scope-mapping scheme, and never a hand-copied
     re-derivation of `PERSONA_REMEMBER_SCOPE_BY_TIER`. `scope` is one of
     the four fixed `persona-<tier>` lanes; `tag` is `scopeId` pre-sanitized
     to `engine.mjs remember()`'s own tag rule.
   - It builds the remembered `text` via `interview-engine.mjs`'s
     `buildRememberText(persona)`, reused unchanged (never a second,
     differently-shaped text string) -- per `resolveRememberScope`'s own doc
     comment, this folds `tier`/`scopeId` into the text itself so it stays
     recall-searchable, not just present in the note's filename.
   - It fires the actual call via a REAL
     `node bin/mnemosyne-skill-helper.mjs remember '{"text":"...","scope":"...","tag":"..."}'`
     subprocess -- the `mnemosyne-standalone` skill's `remember` action,
     which itself does a real `POST /remember` -> `engine.mjs`'s
     `remember()`, the one real target `resolveRememberScope()` was designed
     for (persona.ts's doc comment, design-discussion.md §8). Chosen over
     the MCP transport for the same reason step 7 picks the CLI over MCP for
     the write primitive: a live Claude Code skill session always has a
     direct shell-out primitive, but may not have an open MCP connection.
     Nothing stops a caller from instead driving the MCP `remember` tool
     with the same `{text, scope, tag}` -- both resolve to the same
     `POST /remember` -- but the skill-helper CLI is this step's default.
   - It fires **unconditionally**, even for a maximally-skipped interview:
     `persona.sections` always has at least the 3 skip-placeholder core
     entries (the non-blocking hard-fail rule, pw-10/pw-12), so
     `buildRememberText` always produces real, non-empty text and
     crawl-and-feed never silently no-ops just because most questions were
     skipped (this story's explicit risk mitigation).
   - Returns `{ok, scope, tag, text, file, chunksUpserted, response, error}`
     -- `ok` is true only once the real `remember()` call itself reports
     `remembered:true`; `file` is the real on-disk note path, usable to
     independently confirm the write landed.
   - **Known operational caveat** (design-discussion.md §8, "Known tradeoff,
     accepted"): the four `persona-*` lanes must be provisioned once in
     `swarm-memory`'s `config.toml` before the first real `remember()` call
     at each tier succeeds -- an `unknown scope` 400 the first time a given
     tier is used is expected, loud, and correct, not a bug in this skill.

9. **Report a summary**, mirroring kickoff-protocol.md's own "North-star
   summary" convention: show which questions were answered vs. skipped
   (core, with their placeholder noted; optional, noted as omitted), the
   resolved `{scope, tag}` from `resolveRememberScope()`, and the write
   target (`global` store path or `<repo>/.mnemosyne/personas/<scopeId>.yaml`).

## Structured output schema

The interview's output is exactly `Persona`
(`lib/mnemosyne/layer1/persona.ts`):

```yaml
tier: code-architect            # one of the 4 declared tiers
scopeId: mnemosyne              # human-assigned identity; never auto-detected
displayName: "Code/Area Architect — mnemosyne"
scope: "Deep per-repo implementation detail for the mnemosyne repo only."
sections:
  - heading: "What this persona knows"
    body: "..."                 # verbatim answer, or the skip marker below
  - heading: "What this persona does NOT hold"
    body: "..."
  - heading: "Parent to query up to"
    body: "..."
  # - heading: "Success"        # present ONLY if answered -- omitted if skipped
  #   body: "..."
  # - heading: "Avoid"          # present ONLY if answered -- omitted if skipped
  #   body: "..."
parentRefs:                     # present ONLY when a real parent tier+scopeId was named
  - tier: project-orchestrator
    scopeId: mnemosyne-project
```

Never include `mandateSections` -- `assertValidPersona` rejects the key's
mere presence, regardless of value.

## Skipped-core placeholder marker

Every skipped CORE question's `sections` entry gets this exact body text,
matching kickoff Phase 3b's "explicit marker, never silent omission"
convention:

```
[not provided — skipped during interview]
```

Skipped OPTIONAL questions get no entry at all -- not even this marker.

## Non-blocking hard-fail rule

The interview MUST continue and still produce a valid, writable `Persona`
record regardless of how many questions are skipped (horizontal-plan.md
H6.1-3; kickoff-protocol.md Phase 3b's own hard-fail rule, reproduced
exactly). A fully-skipped interview is a legitimate, supported outcome, not
an error state -- it still passes `assertValidPersona` and is still safe to
write.

## Grounded in kickoff-protocol.md

Every mechanic in this skill is a direct reproduction of
`kickoff-protocol.md`'s **"Phase 3b: Discovery Questions"** section
(`~/.claude/plugins/cache/plugin-hive/plugin-hive/*/hive/references/kickoff-protocol.md`),
narrowed from project-north-star authoring to persona authoring. Line-by-line
mapping:

| kickoff-protocol.md Phase 3b mechanic | This skill's reproduction |
|---|---|
| "Before asking, check what current-state discovery already surfaced. Do NOT re-ask items already answered" (Adaptive question set) | Step 2 loads context (`TIER_CONTENT`, existing persona, conversation) BEFORE step 3 asks anything; `interview-engine.mjs`'s `resolveAnswer()` checks `context` before `responses` |
| 4 core questions + 2 optional follow-ups, "clearly marked optional; skip on empty reply or explicit no" | 3 core questions (knows / not_hold / parent) + 2 optional follow-ups (success / avoid), same skip semantics |
| "Answered questions: write the operator's answer verbatim" | Step 4, `sections` entry body = the verbatim answer |
| "Skipped/deferred questions: write `unknown`" (explicit marker, never silent omission) | Step 4, skipped CORE questions get the explicit `[not provided — skipped during interview]` marker |
| "Optional follow-ups skipped: omit the field rather than writing `unknown`" | Step 4, skipped OPTIONAL questions get no `sections` entry at all |
| "Skip-all case: write the ... block with all four core fields set to `unknown`. Do NOT omit the block" | Step 5, a fully-skipped interview still produces 3 placeholder `sections` entries and a valid `Persona`, never an empty/omitted record |
| "Hard-fail rule: kickoff MUST continue normally ... regardless of how many questions were skipped" | Step 5, non-blocking hard-fail rule, reproduced verbatim in spirit |
| north_star schema table (field / type / required / notes) | "Structured output schema" section above, same table shape, `Persona`'s real fields |

## The two repo-spinup-lifecycle moments (design-discussion.md §3e)

This skill works, unmodified, at both moments Epic 1's two-store split
already supports:

- **Before any repo exists**: authoring a `top-orchestrator` /
  `company-director` / `project-orchestrator` persona. No `repo` argument.
  The interview writes straight into the global persona store
  (`~/.mnemosyne/personas`), which exists independently of any repo.
- **Once a repo exists**: authoring a `code-architect` persona once Hive
  kickoff has built the repo out. `repo` is required. The interview writes
  into that repo's repo-local store (`<repo>/.mnemosyne/personas/`).

Both moments run through the exact same `runPersonaInterview()` engine and
the exact same write primitive (step 7) -- only `tier` (and, for
`code-architect`, `repo`) differ. No new storage-level work was needed for
this story, per design-discussion.md §3e and this story's own acceptance
criteria.

## What this skill is NOT

- **Not stateless.** Unlike `mnemosyne-standalone`, this skill holds a
  multi-turn conversation with the operator -- that is the entire reason it
  exists as a separate skill rather than another `mnemosyne-standalone`
  action.
- **Not a second write path.** It never writes a persona file directly --
  every write goes through `mnemosyne persona create` / `persona_create` /
  `personaCreateAction`, all three thin wraps of the same
  `writeGlobalPersona`/`writeRepoLocalPersona` calls that already validate
  (`assertValidPersona`), lock, and dispatch by tier.
- **Not a second remember()-scope mapping.** It uses pw-09's
  `resolveRememberScope()` exactly as documented, never a parallel scheme.
- **Not new lifecycle infrastructure.** It is parameterized by tier/store
  and works at both repo-spinup-lifecycle moments using storage Epic 1
  already built -- it adds no new store, no new schema field, no new
  lifecycle trigger.

## Helper scripts

[`interview-engine.mjs`](interview-engine.mjs) -- pure, dependency-free ESM
functions implementing the adaptive-skip resolution, placeholder-vs-omit
persistence, and `Persona`-shaped assembly described above:
`CORE_QUESTIONS`, `OPTIONAL_QUESTIONS`, `SKIP_PLACEHOLDER`, `NO_PARENT_TEXT`,
`resolveAnswer()`, `runPersonaInterview()`, `buildRememberText()`. It
deliberately imports nothing from `persona.ts` -- it produces plain data;
`assertValidPersona` and `resolveRememberScope` (both `persona.ts`) remain
the single real enforcement/mapping points, exercised directly against this
engine's output in the test file below.

[`persona-writer.mjs`](persona-writer.mjs) (pw-11) -- step 7's reference
implementation: `personaToYaml()`, `writePersonaViaCli()`,
`showPersonaViaCli()`. Deliberately imports nothing from
`persona-store-global.ts`/`persona-store-repo-local.ts` -- the only way it
ever touches disk is by spawning the real `mnemosyne persona create` (and
`persona show`) CLI subprocess (`bin/mnemosyne-persona.mjs`), never a
second, in-process write path. `persona-writer.d.mts` is its hand-written
type companion (same convention as `interview-engine.d.mts`).

[`persona-remember.mjs`](persona-remember.mjs) (pw-13) -- step 8's reference
implementation: `rememberInterviewSource()`, `resolveRememberScopeViaCli()`,
`fireRememberCall()`. Deliberately imports nothing from `persona.ts`
directly (same TS/JS-boundary constraint `persona-writer.mjs` already works
around) -- the only way it ever resolves a scope is by spawning the real
`mnemosyne persona resolve-remember-scope` CLI subprocess
(`bin/mnemosyne-persona.mjs`'s `resolve-remember-scope` subcommand), and the
only way it ever calls `remember()` is by spawning the real `node
bin/mnemosyne-skill-helper.mjs remember` CLI subprocess -- never a
second, in-process/simulated write path. `persona-remember.d.mts` is its
hand-written type companion (same convention as `interview-engine.d.mts`).

## See also

- `~/.claude/plugins/cache/plugin-hive/plugin-hive/*/hive/references/kickoff-protocol.md`
  -- "Phase 3b: Discovery Questions", the precedent this skill reproduces.
- [`../mnemosyne-standalone/SKILL.md`](../mnemosyne-standalone/SKILL.md) --
  the stateless/table-driven contrast this skill deliberately departs from.
- [`../../lib/mnemosyne/layer1/persona.ts`](../../lib/mnemosyne/layer1/persona.ts)
  -- `assertValidPersona` (the real schema gate), `resolveRememberScope`
  (pw-09's `{tier, scopeId}` -> `remember()` scope/tag mapping),
  `PERSONA_STORE_BY_TIER` (the two-store split this skill dispatches on).
- [`../../lib/mnemosyne/layer1/tiers.ts`](../../lib/mnemosyne/layer1/tiers.ts)
  -- `TIER_CONTENT`, the canonical per-tier `displayName`/`scope` defaults
  step 2 reads before asking anything.
- [`../../.pHive/epics/mnemosyne-persona-wizard/docs/design-discussion.md`](../../.pHive/epics/mnemosyne-persona-wizard/docs/design-discussion.md)
  -- §3b (why this skill is grounded in kickoff-protocol.md), §3e (the two
  repo-spinup-lifecycle moments), §8 (pw-09's `resolveRememberScope`
  resolution, full rationale).
- [`../../lib/mnemosyne/layer1/__tests__/persona-interview-skill.test.ts`](../../lib/mnemosyne/layer1/__tests__/persona-interview-skill.test.ts)
  -- TDD coverage: full-answers run, partially-skipped run, max-skip
  non-blocking-hard-fail proof (against the real `assertValidPersona`),
  adaptive-skip-via-context proof, both lifecycle moments, and a structural
  check that this file states the required rules.
- [`../../lib/mnemosyne/layer1/__tests__/persona-interview-output.test.ts`](../../lib/mnemosyne/layer1/__tests__/persona-interview-output.test.ts)
  (pw-11) -- proves a completed interview's `persona` actually round-trips
  through disk via a REAL `mnemosyne persona create`/`persona show` CLI
  subprocess (full-answers, partially-skipped, code-architect + `parentRefs`
  cases), and a structural check that `persona-writer.mjs` introduces no
  new/parallel write path.
- [`../../lib/mnemosyne/layer1/__tests__/persona-interview-crawl-and-feed.test.ts`](../../lib/mnemosyne/layer1/__tests__/persona-interview-crawl-and-feed.test.ts)
  (pw-13) -- proves step 8's `rememberInterviewSource()` fires a REAL
  `remember()` call (real HTTP -> `engine.mjs` -> note-file-on-disk, against
  a real `src/server.mjs` subprocess with only the `swarm-memory` binary
  itself swapped for a test double), that its scope genuinely comes from
  `resolveRememberScope()` (not a hardcoded/parallel scheme), and that a
  maximally-skipped interview (pw-12's exact skip-all pattern, both the
  global-tier and code-architect cases) still triggers a real call.
