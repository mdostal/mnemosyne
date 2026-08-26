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
