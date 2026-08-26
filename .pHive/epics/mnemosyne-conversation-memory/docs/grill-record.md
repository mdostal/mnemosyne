# Grill Record — mnemosyne-conversation-memory

round_number: 1
unresolved_count: 0

Adversarial pass against `docs/design-discussion.md` (draft, before this
round's revisions). Five categories, each a genuine finding against the
draft, not a quality score — every finding below ends with a question,
and every question's resolution is now inline in the revised
design-discussion.md (marked `[grill N.N]` at the exact point resolved).

## 1. Vocabulary mismatches

**Finding 1.1 — "clean up the conversations and context" is ambiguous
between two real readings.** The operator's own quote could mean (a)
"produce new, distilled memory entries" (this epic's actual plan) or (b)
"reorganize/archive the operator's own local `~/.claude/projects/`
session files" (a filesystem-cleanup reading the draft never explicitly
ruled out). Which reading does this design commit to, and is the other
reading explicitly out of scope?

*Resolution:* §2.7 preamble now states explicitly: source transcripts are
read-only input, permanently; "clean up" is defined as producing new
memory entries only; filesystem reorganization is named as explicitly
out of scope, not silently assumed either way.

## 2. Hidden assumptions

**Finding 2.1 — clustering's input set (`cm-06`) was never explicitly
scoped against triage's three-way verdict (`keep`/`trash`/`uncertain`).**
Does clustering run over all sessions regardless of verdict, `keep`-only,
or `keep`+`uncertain`? The original draft implied "distilled summaries"
without saying which verdicts produce a summary to cluster in the first
place.

*Resolution:* §2.6 now states explicitly: `cm-06` clusters `keep` and
`uncertain` sessions; `trash`-verdict sessions never reach `cm-06`'s
input.

## 3. Unresolved tensions

**Finding 3.1 — this epic's `meta`-scope collection sits in tension with
Mnemosyne's own "embeddable in any third-party product" north star**
(`project_state.md`, reframed 2026-08-19). A future Mode B product
embedding Mnemosyne and querying `meta` scope should never surface the
operator's own personal conversation history. The original draft never
named this tension.

*Resolution:* Named explicitly in §2 (new callout ahead of §3 Risks) as a
genuine, not-fully-solved tension — this epic's own collection is scoped
as operator-personal-only and documented as such, but the deeper
guarantee depends on `meta` scope's own future collection-routing design,
flagged as open question #1.

**Finding 3.2 — the pilot's "human-confirmed sample" (`cm-08`) never said
WHO selects the sample or HOW.** Without a concrete selection mechanism,
"operator-reviewed pilot" risks becoming "the agent picks something and
calls it reviewed."

*Resolution:* §2.8 now ties pilot selection directly to `cm-02`'s
discovery manifest — the operator marks entries in a real, reviewable
list; `cm-08` never auto-selects on the operator's behalf.

## 4. Convention violations

**Finding 4.1 — `cm-01` (secret scanner) risked becoming three
independently-implemented copies (one each inside `cm-03`, `cm-04`,
`cm-07`) rather than one shared, reusable module** — a direct violation
of this codebase's own established "one primitive, reused, never
reimplemented" convention (`ingestDocument()`'s own doc comment, research-
brief §2.1/§2.5).

*Resolution:* §2.8 now states the module/export-shape explicitly and ties
`cm-03`/`cm-04`/`cm-07`'s dependency on `cm-01` into the story
decomposition's `depends_on` graph (enforced structurally, not just
documented).

## 5. Posture mismatches

**Finding 5.1 — the deep-dive report (`cm-09`) claimed secret redaction
without naming the residual leakage risk in redacted-but-contextual
output** (e.g. a redacted `AWS_SECRET_ACCESS_KEY=***` line still reveals
the credential's existence/naming convention). `ro-11`'s own precedent
(R13, DNS-rebinding TOCTOU) is to name what ISN'T fully solved, not claim
full closure — the original draft's posture on this point was closer to
"solved" than the real guarantee supports.

*Resolution:* §2.8 now names this residual risk explicitly, mirroring
`ro-11`'s R13 discipline, and treats the report itself as sensitive/
local-only rather than claiming redaction alone makes it safe to share.

## Team review summary (self-conducted, full planning team acting as one)

- **Researcher lens:** all cited file paths, byte counts, and schema
  claims in research-brief.md were re-verified against the actual grep/
  read output above before being written into the design discussion —
  no invented figures.
- **TPM lens:** the sequencing (safety substrate → discovery → parsing →
  triage → clustering → distillation → pilot → deep-dive) is a real
  dependency chain, not an arbitrary list order — each stage's output is
  the next stage's real input.
- **Architect lens:** the Level-3/`meta`-scope placement decision (§2.2/
  §2.3) was checked against `levels.ts`'s own stated definition of what a
  "level" is before concluding no new level was needed, not assumed by
  convenience.

All 5 findings resolved in this round. `unresolved_count: 0` — no further
grill round required.

---

# Round 2 — Amendment (2026-08-25) — Gemini correction

round_number: 2
unresolved_count: 0

Adversarial pass against `design-discussion.md`'s new §9 (the Gemini
correction: round 1's "confirmed absent" finding was wrong, operator-
flagged) — grounded in the real Portunus/GCP/filesystem re-verification
performed for this amendment, not a rewrite of round 1's own findings.
Same five categories, same descriptive-finding-plus-question discipline
as round 1. All findings below resolved by revising §9 (and, in one case,
a story YAML directly); nothing here reopens round 1's own already-
resolved findings.

## 1. Vocabulary mismatches

**Finding 2.1.1 — "Gemini" collides across at least three unrelated real
Google products, two of them already live in this codebase/session, and
the original correction draft only disambiguated two of the three.** The
consumer chat app (`gemini.google.com`) and the Developer API
(`dostal-shared-gemini`) were distinguished (§9.2), but `lib/mnemosyne/
layer1/harness.ts`'s own `HarnessId = 'gemini-cli'` (a completely
unrelated terminal coding agent, part of Layer 1's cross-harness
memory-mandate sync) uses the same word for a third, unrelated thing —
confirmed present in this repo's own code by direct grep, not assumed.
Left unnamed, a future reader of both `harness.ts` and this epic's
stories could reasonably wonder if they're related.

*Resolution:* §9.1 now includes an explicit `[grill 2.1.1]`-tagged
three-way disambiguation (consumer app / Developer API / Gemini CLI),
naming all three and stating plainly that this epic's own usage never
refers to Gemini CLI.

## 2. Hidden assumptions

**Finding 2.2.1 — the correction's first draft assumed `dostal-shared-
gemini` was the right key to use without checking whether
`google_generative_ai_api_key` (found alongside it in the same Portunus
registry) might be the operator's actual intended credential instead.**
Both references are real (§9.1's own table); picking the wrong one
silently would be a real, load-bearing mistake this epic's own
`cm-05`/`cm-07`/`cm-10` build against.

*Resolution:* §9.1 compares both directly via real GCP metadata (labels,
`createTime`, rotation policy) — `dostal-shared-gemini` carries the same
`app: dostal-swarm`/`scope: shared` labels and same creation-day
provenance as the already-proven-working `dostal-shared-qdrant` key;
`google_generative_ai_api_key` carries none of those labels plus an
active 90-day rotation policy tied to a dedicated notification topic,
the shape of a separate production-application secret. Decision stated
explicitly: `dostal-shared-gemini` only, `google_generative_ai_api_key`
named and explicitly excluded, not silently ignored.

## 3. Unresolved tensions

**Finding 2.3.1 — "Gemini should fully exist as a reachable thing" (the
operator's own words) is in tension with `cm-10`'s own gating, which
keeps Gemini conversation ingestion genuinely unbuilt pending a real
precondition.** Does a gated, `pending`-status, precondition-blocked
story actually satisfy "not absent," or does gating just relabel the
same "absent" outcome with better paperwork?

*Resolution:* §9.5/§9.6 and `cm-10`'s own YAML state the distinction
explicitly: "reachable" means a real story exists in the plan, with the
same schema rigor (acceptance criteria, steps, dependencies, risks) as
its shipped siblings `cm-03`/`cm-04`, discoverable and buildable the
moment its precondition is met — not "guaranteed to build in this pass"
(which the task's own explicit "do NOT begin build-out" instruction
forecloses regardless of Gemini's status). The real difference from
round 1's "absent" framing: round 1 treated Gemini as a closed question
with no path forward (§5 open question 5's own "defer" recommendation,
now struck through); this correction gives it a concrete, named,
inspectable path forward (`cm-02`'s manifest → staged export →
`cm-10`'s research step confirms → build) — genuinely reachable, not
merely re-worded absence.

## 4. Convention violations

**Finding 2.4.1 — `cm-07` imports `cm-05`'s new `geminiClient.ts` but the
first draft left `cm-07`'s own `depends_on:` unchanged, relying only on
the transitive path through `cm-06`.** This is exactly the shape of gap
`[grill 4.1]` (round 1) already flagged and fixed for `cm-01` — a shared
module's consumers should have the dependency ENFORCED BY THE GRAPH, not
merely true by transitive accident. (Note: `cm-04` importing `cm-03`'s
`types.ts` without listing `cm-03` in `depends_on` is a real, existing
precedent in this epic for shared TYPE-only contracts — but
`geminiClient.ts` is a real runtime module with actual logic, the same
category `cm-01`'s `scanForSecrets()` is, not a types-only import, so
`[grill 4.1]`'s stricter precedent applies here, not `cm-04`'s looser
one.)

*Resolution:* `cm-07-distillation-and-persist.yaml`'s `depends_on` is
now `[cm-06-cross-session-clustering, cm-05-usefulness-trash-triage]`
(cm-05 added explicitly), and `epic.yaml`'s own `stories:` list entry for
`cm-07` updated to match — the shared-module relationship is now real,
graph-enforced, not merely transitively true.

## 5. Posture mismatches

**Finding 2.5.1 — an earlier draft of §9 risked reading as "Gemini
integration is now solved," when real, load-bearing unknowns (exact
model id, real current rate limits, whether `dostal-shared-gemini`'s
billed tier is cost-appropriate at FULL 234-session scale) remain
genuinely unverified.** Round 1's own posture discipline (`[grill 5.1]`,
"name what isn't fully solved, not claim full closure") applies with
equal force to this correction, not just to round 1's original content.

*Resolution:* §9.8 ("Residual, honestly-named open items") states
explicitly what this correction does and does not resolve: it fixes
WHICH credential and WHAT it's for (a real, load-bearing gap round 1
left completely unnamed), not the exact runtime numbers — those are
deferred to `cm-05`/`cm-07`'s own research steps against the live API,
per the pilot-before-full-corpus posture (§2.8) round 1 already
established and this correction does not loosen.

## Summary (round 2)

5 findings, 5 resolved via `design-discussion.md` §9 revision and one
direct story-YAML fix (`cm-07`'s `depends_on`, mirrored in `epic.yaml`).
No findings carried forward unresolved — `unresolved_count: 0`. Round 1's
own 5 findings are untouched and remain resolved.

---

# Round 3 — Amendment (2026-08-25) — Takeout export, scope-routing, generalization

round_number: 3
unresolved_count: 0

Adversarial pass against `design-discussion.md`'s new §10 (three real,
confirmed-this-pass facts: a real small Gemini Takeout export now staged;
a real, existing `swarm-memory` scope — `arizona` — surfacing a
scope-routing gap in `cm-06`/`cm-07`; two new stories, `cm-11`/`cm-12`,
generalizing this epic's own pipeline) — grounded in the real Portunus-
free filesystem/config re-verification performed for this amendment
(`unzip -l` file-listing-only inspection of the Takeout zip; a direct
read of `~/.config/swarm-memory/config.toml` and confirmation that
`~/.mnemosyne/org-tree.yaml` does not exist; a direct read of
`VectorLayerAdapter.ts`'s real `cfg.scopes?.[scope]` resolution and
`mnemosyne/onboarding.py`'s own research-spike docstring confirming that
same file/table is the live registry `remember()` already resolves
against), not a rewrite of rounds 1-2's own findings. Same five
categories, same descriptive-finding-plus-question discipline. The task's
own explicit instructions for this round were followed as the search
brief: look for contradictions with existing tickets, hand-waved routing
logic, any place a real personal-content leak could still occur, and
whether the generalization ticket quietly implies testing against real
content it should not have access to.

## 1. Vocabulary mismatches

**Finding 3.1 — "scope" collides between two real, distinct concepts this
round's own design leans on, and the original draft of `cm-06`/`cm-07`
used the word without a story-level pointer to the disambiguation.**
Mnemosyne's own `Scope` TYPE (`interfaces.ts`, `'project'|'enterprise'|
'meta'`) is the caller-facing enum `remember()` accepts; `swarm-memory`'s
own `[scopes]` REGISTRY (`config.toml`, real keys like `arizona`) is the
underlying table that TYPE's values resolve against at runtime. §10.2 of
`design-discussion.md` disambiguates this correctly, but `cm-06`'s and
`cm-07`'s own YAML text — the files an implementer actually opens to
build this — used "scope" in both senses without a pointer, risking the
same kind of conflation `[grill 2.1.1]` (round 2) already caught for the
word "Gemini." Does a reader of `cm-06`/`cm-07` in isolation (without
also opening `design-discussion.md`) end up confusing `scope: 'meta'`
with the new `resolved_scope_candidate` concept?

*Resolution:* Both `cm-06`'s and `cm-07`'s own description sections now
open their round-3 addition with an explicit, one-paragraph
disambiguation (TYPE vs. REGISTRY, which field name means which)
pointing to `design-discussion.md` §10.2 for full detail — mirrors
`[grill 2.1.1]`'s own resolution shape exactly, applied to a second real
vocabulary collision this epic has now produced.

## 2. Hidden assumptions

**Finding 3.2 — the original draft of `cm-11` composed `cm-10` in its own
description ("`cm-02` → `cm-03`/`cm-04`/`cm-10` → `cm-05`...") without
ever naming WHY `cm-10` is treated differently from `cm-02` through
`cm-07`.** `cm-10` may never be built at all (its own gating precondition
could stay unmet indefinitely for the Share-link shape, per its own
YAML) — a hidden asymmetry a future implementer could miss, either
wrongly treating `cm-10` as a hard requirement for `cm-11` to function,
or wrongly inferring by analogy that `cm-03`/`cm-04` are similarly
optional (they are not — they are this pipeline's own unconditional core
parsers).

*Resolution:* `cm-11`'s own `design_decisions` now states this asymmetry
explicitly: `cm-02` through `cm-07` are an unconditional, always-composed
core sequence; `cm-10` is composed ONLY IF it exists and the caller's
supplied source list actually contains a staged Gemini export — named
directly so neither misreading is possible.

## 3. Unresolved tensions

**Finding 3.3 — `cm-08`'s own pilot runs `cm-02` through `cm-07`
end-to-end in ONE synchronous pass (unchanged by this correction), but
`cm-06`'s new `resolved_scope_candidate` requires a PRE-EXISTING
operator confirmation before `cm-07` will ever route to it.** A candidate
computed mid-pilot-run cannot possibly already have a confirmation from a
review that hasn't happened yet. Does this mean `cm-08`'s own pilot can
ever actually exercise real scope-routing at all, or will every pilot
entry always land in `meta` regardless of whether a real match exists —
and if so, was that consequence ever stated anywhere, or would an
operator reading `cm-08`'s own results reasonably wonder why "scope-
routing" produced zero routed entries?

*Resolution:* Named explicitly, not silently left for an operator to
puzzle out — `cm-07`'s own description now states this sequencing
consequence directly (a `cm-08` pilot run will, in practice, always
default every entry to `meta`; genuine routing only happens in a SECOND,
later run against a candidate a human has since reviewed), and `cm-08`'s
own description gained a matching round-3 note cross-referencing it —
this is expected, intended behavior given the confirms-before-write
discipline (§10.2), not a defect, and now legible as such from either
story's own YAML.

## 4. Convention violations

**Finding 3.4 — the original draft of `cm-11`'s `depends_on` listed only
`cm-09`, even though its own description composes `cm-02` through `cm-07`
as real, imported runtime modules — every one of them true only by
TRANSITIVE ACCIDENT through `cm-09`'s own dependency chain, not enforced
by `cm-11`'s own graph.** `[grill 4.1]` (round 1) and `[grill 2.4.1]`
(round 2) both already established this epic's own convention for
exactly this shape of gap: a story that imports another story's real
runtime module must list that story in its own `depends_on`, not rely on
a transitive path being true by accident. Does this round's own new
story violate a convention this epic already fixed twice for exactly
this reason?

*Resolution:* `cm-11`'s `depends_on` now explicitly enumerates every
story whose real runtime module it composes unconditionally (`cm-02`,
`cm-03`, `cm-04`, `cm-05`, `cm-06`, `cm-07`) alongside `cm-09` (the
real-data-validation gate, a distinct kind of dependency, named as such
in `cm-11`'s own `design_decisions`) — `epic.yaml`'s own `stories:` list
entry for `cm-11` updated to match. `cm-10` is deliberately excluded, per
finding 3.2's own resolution, since it is conditional/optional
composition, not unconditional.

## 5. Posture mismatches

**Finding 3.5 — flipping `cm-10`'s own `parallel_allowed` from `false` to
`true` is a strong structural signal ("this story is now like `cm-03`/
`cm-04` — ready to build") that could overclaim readiness relative to
what this round's own re-verification actually established.** The
staged Takeout sample is real but TINY (2 conversations), this planning
pass performed NO content-level inspection of it (its own hard privacy
constraint), and the "Gemini in Workspace" vs. standalone-consumer-app
schema question is genuinely unresolved. Round 1's own `[grill 5.1]` and
round 2's own `[grill 2.5.1]` both already established this epic's
posture discipline — "name what isn't fully solved, not claim full
closure" — does the bare `parallel_allowed: true` flip, on its own,
read as closer to "solved" than the real evidence supports?

*Resolution:* `cm-10`'s own `parallel_rationale` now states explicitly,
in its own dedicated paragraph, that "parallel-eligible" here means
research/implementation can genuinely START against real data — NOT that
the parser is proven trivial, low-risk, or de-risked. The 2-conversation
sample size, the unconfirmed real schema, and the "Gemini in Workspace"
open question are all named directly at the point the readiness signal
is given, not left to a separate risk paragraph a reader could miss.

## Real personal-content-leak check (task's own explicit ask, verified
directly, not merely asserted)

Every code path this round's own three changes introduce was checked
against this epic's own no-leak posture:

- **Takeout export (§10.1):** this pass read the zip's file listing only
  (`unzip -l`) — confirmed by re-inspecting this round's own bash-tool
  history, zero `unzip -p`/extraction/`cat` calls against any
  `conversation_*.txt` entry anywhere in this pass's own work. `cm-02`'s
  and `cm-10`'s own updated YAMLs both state this explicitly and defer
  all content-level reading to `cm-10`'s own future build-time research
  step — never claimed as already done here.
- **Scope-routing (§10.2):** the entire mechanism is structurally
  read-only-then-human-gated — `cm-06` never writes a scope value
  anywhere, `cm-07` never routes to a non-`meta` scope without a real,
  on-disk, per-`cluster_id` confirmation record, and the unconfirmed/
  no-candidate/mismatched-confirmation cases (three of `cm-07`'s own new
  acceptance criteria) all default to `meta` unconditionally — no code
  path exists anywhere in this design that could route personal content
  to a client-facing collection without an explicit human act in
  between.
- **Generalization (`cm-11`/`cm-12`, §10.3):** confirmed the task's own
  named concern directly — does packaging this pipeline as a reusable
  component quietly imply testing it against real content it shouldn't
  have access to? No: `cm-11`'s own `design_decisions` states synthetic/
  structural fixtures only, explicitly naming that no real second
  operator's data exists or is available to this repo, and that using
  anyone else's real content without their own explicit involvement
  would violate this epic's own `conversation-privacy-safety` posture —
  the same posture already governing why `cm-10`'s own fixtures may never
  be the operator's real `moving-chaos` content, and why `cm-02`'s own
  test suite never runs against this operator's real
  `~/.claude/projects/` tree either.

## Summary (round 3)

5 findings, 5 resolved — one direct disambiguation addition each to
`cm-06`/`cm-07` (finding 3.1), one `design_decisions` addition to `cm-11`
(finding 3.2), one cross-referenced sequencing note added to both `cm-07`
and `cm-08` (finding 3.3), one `depends_on` graph fix mirrored in
`epic.yaml` (finding 3.4), and one posture-hedging addition to `cm-10`'s
own `parallel_rationale` (finding 3.5). No findings carried forward
unresolved — `unresolved_count: 0`. Rounds 1-2's own 10 findings are
untouched and remain resolved.
