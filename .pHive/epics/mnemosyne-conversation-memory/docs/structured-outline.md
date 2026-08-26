# Structured Outline — mnemosyne-conversation-memory

Large-scope planning artifact. Builds directly on `horizontal-plan.md` and
`vertical-plan.md` — each phase below maps 1:1 to a vertical slice.

## 1. Summary

Nine stories, seven sequential vertical slices (two slices carry an
internal parallel pair), delivering: a reusable secret-scanning primitive,
real-source discovery, two source-specific parsers into a shared
normalized shape, LLM+heuristic usefulness triage with a mandatory human
gate, embedding-based cross-session clustering, a bounded distillation
mechanism that composes the already-shipped `ingestDocument()`/
`remember()` cascade, a small real pilot, and a distinct deep-dive
validation story producing the operator's own explicitly-requested
inspectable report. Zero full-corpus ingestion story exists in this
decomposition, by design.

## 2. Detailed approach per phase

### Phase 1 (Slice 1) — Safety + Discovery

`cm-01` ships `lib/mnemosyne/conversation-memory/scanForSecrets.ts`: a
pure function taking a text string and returning `{ matches: Array<{
category, redactedPreview, offset }> }` — categories cover API-key-shaped
tokens (common prefixes: `sk-`, `AKIA`, `ghp_`, `xox[bp]-`, generic
32+-char high-entropy strings adjacent to `key`/`token`/`secret`/
`password`-like variable names), PEM private-key blocks
(`-----BEGIN...PRIVATE KEY-----`), and connection strings with embedded
credentials (`://user:pass@host`). Zero I/O, zero network — a pure
detector, unit-tested against a real, checked-in fixture corpus of
known-shaped secrets (never real operator secrets) plus a real
false-positive corpus (legitimate-looking-but-not-secret strings, e.g.
UUIDs, git commit hashes) to bound both false-negative and false-positive
rates as real, measured numbers, not assumed.

`cm-02` ships `lib/mnemosyne/conversation-memory/discoverSources.ts`:
walks `~/.claude/projects/*`, applies the scratch-filter heuristic
(research-brief §1.1, design-discussion §2.4), and appends the two
confirmed export files as fixed, named entries (never a generic
Downloads-directory scan). Output: a manifest file (YAML, matching this
codebase's own `~/.mnemosyne/org-tree.yaml`-style convention) at
`~/.mnemosyne/conversation-sources.yaml`.

### Phase 2 (Slice 2) — Parsing/normalization

Shared output contract, defined once and imported by both parsers:

```ts
interface ConversationTurn {
  sessionId: string;
  sourceType: 'claude-code' | 'chatgpt';
  role: 'user' | 'assistant' | 'system';
  text: string;              // extracted text only — no thinking signatures, no raw tool payloads beyond a bounded excerpt
  timestamp: string | null;  // ISO 8601
  projectSlug: string | null;
  turnIndex: number;
}
```

`cm-03` (`parseClaudeCodeSession.ts`) reads a session JSONL file
line-by-line (never loads a 50MB file fully into memory as a single
string — streams/line-reads it, a real, testable memory bound), extracts
`text` blocks, DROPS `thinking` blocks' opaque `signature` field
entirely, and reduces each `tool_use`/`tool_result` block to a single
bounded excerpt line (tool name + a short truncated summary of
input/output — never the full raw payload) rather than dropping tool
activity entirely (tool calls are often the real signal of WHAT was
built, even if their full payload is noise).

`cm-04` (`parseChatGptExport.ts`) walks `conversations.json`'s `mapping`
tree from `current_node` back through `parent` pointers to linearize each
conversation (research-brief §1.2's real DAG-walk requirement), filtering
`is_visually_hidden_from_conversation` scaffold nodes.

Both run `cm-01`'s scanner over every extracted `text` field before
returning; a match produces a quarantined turn (never silently dropped,
never silently passed through — flagged in the returned structure).

### Phase 3 (Slice 3) — Triage

`cm-05` (`triageSession.ts`): heuristic prefilter first (pure function
over `ConversationTurn[]`'s structural properties — turn count, elapsed
wall-clock span, tool-to-text ratio), producing a priority score. One
bounded LLM call per session (capped input — the heuristic step's own
extracted text-only turns, itself bounded to a real max character count
named as a constant, mirroring `MAX_INGEST_BYTES`'s own discipline)
returns `{ verdict: 'keep' | 'trash' | 'uncertain', summary: string,
rationale: string }`. Output appended to a real, on-disk review queue
(`~/.mnemosyne/conversation-triage-queue.yaml`) — never acted on further
without an explicit operator review pass.

### Phase 4 (Slice 4) — Clustering

`cm-06` (`clusterConversations.ts`): embeds each `keep`/`uncertain`
session's summary via the same embedder the vector layer already uses
(confirmed by the implementation's own research step, not assumed to be
a specific model name here), runs a real similarity-clustering pass
(algorithm choice — e.g. a simple threshold/agglomerative approach vs. a
library — is this story's own research-step decision, validated against
context7 at build time since it may introduce a new dependency),
faceted/labeled by `projectSlug`.

### Phase 5 (Slice 5) — Distillation + persist

`cm-07` (`distillAndRemember.ts`): for each triaged, clustered session,
produces a bounded set of entries (decision/fact, open-question, one
session-summary — design-discussion §2.7), runs `cm-01`'s scanner one
final time over the final distilled text, then calls `ingestDocument()`
(ro-10, unchanged) with `scope: 'meta'` and
`metadata.source: 'external_conversation'`,
`metadata.chat_source: 'claude-code' | 'chatgpt'`,
`metadata.session_id`, `metadata.project_slug`, `metadata.cluster_id`.

### Phase 6 (Slice 6) — Pilot

`cm-08`: orchestrates Phases 1-5 over an operator-selected real sample
(design-discussion §2.8 `[grill 3.2]` — selection via the Phase 1
manifest). First and only point in this epic where real content reaches
Qdrant.

### Phase 7 (Slice 7) — Deep-dive validation

`cm-09`: reads `cm-08`'s real output and produces
`.pHive/epics/mnemosyne-conversation-memory/docs/deep-dive-report.md`
(or an equivalent operator-facing artifact) covering per-session
before/after, every triage verdict + rationale, every cluster
assignment, every quarantine hit (category + location, never the secret
value), and real `recall()` spot-checks.

## 3. File manifest (new files this epic introduces)

| File | Story |
|---|---|
| `lib/mnemosyne/conversation-memory/scanForSecrets.ts` (+ `.test.ts`) | cm-01 |
| `lib/mnemosyne/conversation-memory/discoverSources.ts` (+ `.test.ts`) | cm-02 |
| `lib/mnemosyne/conversation-memory/types.ts` (`ConversationTurn` contract) | cm-03 |
| `lib/mnemosyne/conversation-memory/parseClaudeCodeSession.ts` (+ `.test.ts`) | cm-03 |
| `lib/mnemosyne/conversation-memory/parseChatGptExport.ts` (+ `.test.ts`) | cm-04 |
| `lib/mnemosyne/conversation-memory/triageSession.ts` (+ `.test.ts`) | cm-05 |
| `lib/mnemosyne/conversation-memory/clusterConversations.ts` (+ `.test.ts`) | cm-06 |
| `lib/mnemosyne/conversation-memory/distillAndRemember.ts` (+ `.test.ts`) | cm-07 |
| `bin/mnemosyne-conversation-pilot.mjs` (CLI orchestrator) | cm-08 |
| `.pHive/epics/mnemosyne-conversation-memory/docs/deep-dive-report.md` (generated output, not source) | cm-09 |

## 4. Risk registry

| ID | Risk | Severity | Likelihood | Mitigation | Owning story |
|---|---|---|---|---|---|
| R1 | Secret/credential leakage into persisted, searchable store | Critical | Low (with cm-01) / High (without) | Firm, no-bypass, twice-checked scanner (parse-time + persist-time) | cm-01, cm-03, cm-04, cm-07 |
| R2 | Silent, automated loss of real conversation history (auto-delete) | Critical | Low (structural guarantee: no delete path exists anywhere in this epic's code) | Read-only source transcripts; no delete path in any story; human-gated triage | cm-05 |
| R3 | Cost/scale blowup from naive full-transcript LLM classification | High | Medium | Heuristic prefilter before any LLM call; bounded per-call input; pilot-scale cost measurement before full-corpus decision | cm-05, cm-08 |
| R4 | `MAX_INGEST_BYTES` incompatibility with raw transcripts | High | Certain if not addressed | Distillation (cm-07) is the fix; cap is never raised | cm-07 |
| R5 | `meta` scope thinly implemented; real gaps surface only at build time | Medium | Medium | cm-03's research step re-confirms live `meta`-scope behavior before building on it | cm-03 |
| R6 | ChatGPT tree-DAG mis-linearization (branched/edited conversations) | Medium | Medium | Explicit DAG-walk-from-`current_node` design, tested against real multi-branch conversations from the real export | cm-04 |
| R7 | Cross-product `meta`-scope leakage into a future embedded third-party product's recall | Medium | Low (this epic's own collection is scoped safely) but High future impact if `meta` routing hardening never happens | Named explicitly as an open, deferred tension (design-discussion `[grill 3.1]`); this epic's own collection documented as operator-personal-only | cm-03 (collection naming), open question #1 |
| R8 | Quarantine-report residual context leakage (redacted-but-contextual output) | Medium | Low | Report treated as sensitive/local-only; redaction covers value, not existence/category, by design, named explicitly | cm-09 |
| R9 | Discovery scratch-filter heuristic false-negatives/positives at real 234-dir scale | Low | Medium | Weak-signal entries surfaced for operator confirmation, never silently auto-excluded/included | cm-02 |
| R10 | Embedding-based clustering produces clusters that don't map to anything the operator recognizes | Low | Medium | Project-slug facet anchors clusters to a real, recognizable signal alongside pure similarity | cm-06 |

## 5. Elicitation — the team's own stress test

**Q1. Is a single bounded LLM call per session (cm-05) actually cheap
enough at 234+ sessions, or does this still risk real cost blowup?**
A: Real cost is unknown until measured — this is exactly why `cm-08`'s
pilot exists: measure real per-session LLM cost on a small, real sample
before any full-corpus commitment is even proposed. The design
deliberately does not claim a specific dollar figure here; it claims the
STRUCTURE (heuristic-prefilter-first, bounded-input LLM call, pilot
before scale-out) that makes the real number knowable and boundable.

**Q2. Why not build the full-corpus ingestion story now, given the
operator clearly wants their whole history eventually?**
A: `ways_of_working.md`'s own hard rule ("don't build ahead of an
explicit CBA... a hard stop on implementation and concrete planning") and
this task's own explicit instruction both point the same direction: plan
the pilot and validation, let the operator decide on full-corpus AFTER
seeing real, inspectable pilot results. Building a full-corpus story now
would be planning ahead of evidence this epic's own later stories haven't
produced yet.

**Q3. Does the two-parser design (cm-03/cm-04) actually generalize, or is
it two one-off scripts?**
A: The shared `ConversationTurn[]` contract (Phase 2) is the
generalization boundary — every downstream story (triage, clustering,
distillation) depends only on that shape, never on source-specific
fields. A third parser (Gemini, or any future source) is additive at the
parser layer only.

**Q4. What happens if the operator disagrees with a `trash` verdict after
the fact — is there a way to recover?**
A: Yes, structurally: a `trash` verdict never deletes the source
transcript (read-only input, permanently) and never deletes anything
already persisted. Re-running triage on the same session with a
corrected verdict is always possible because the source data was never
touched. This is a real, load-bearing property of the design, not
incidental.

**Q5. Is `cm-09`'s deep-dive report itself going to become another
52MB unmanageable artifact, defeating its own purpose?**
A: No — by construction, it reports over `cm-08`'s SMALL, bounded pilot
sample (a handful of sessions, design-discussion §2.8), not the full
corpus. Its size scales with the pilot's own deliberately small scope.

**Q6. Does this epic's scope assessment (Large) hold up against a
"could this actually be Medium" challenge?**
A: No — re-checked directly against the Medium/Large criteria: this
touches 6+ new modules across a genuinely new risk category
(personal-data privacy, unprecedented in this codebase's existing
concern list), composes but meaningfully extends 4 already-shipped
subsystems, and is explicitly staged across 7 sequential slices with a
mandatory human-gated pilot before any scale-out. That is squarely
long-horizon, multi-system — Large, confirmed, not downgraded.

## 6. Decision points for operator sign-off

1. Approve the m-09 supersession decision (design-discussion §7) and its
   docs-only `note:`-field edit on `m-09`'s own story YAML.
2. Approve the `meta`-scope-as-Level-3, not-a-new-Level-5 placement
   decision (design-discussion §2.2/§2.3).
3. Answer open questions #1-#5 (design-discussion §5) — collection
   naming, full-corpus follow-on epic timing, `OpenAI Export.zip`
   investigation, quarantine retention policy, Gemini parser deferral.
4. Confirm the explicit non-goal: no full-corpus ingestion story exists
   in this decomposition by design — approve or request one be added
   now (recommendation: do not, per Q2 above).
