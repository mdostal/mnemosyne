# Design Discussion — mnemosyne-conversation-memory

## 1. Goal

Turn the operator's own scattered, real conversation history — 234+ real
Claude Code project session transcripts (up to ~50MB+ each) plus a real
258-conversation ChatGPT export — into a filtered, triaged, clustered, and
distilled slice of Mnemosyne memory, without ever silently deleting or
exposing anything sensitive, and without ever pretending "ingest
everything" is a safe first build step.

Operator's own words (full quote in research-brief.md §0) name six
sub-asks: filter through everything discussed; get it into memories;
figure out usefulness vs. trash; cluster/index correctly; break out and
clean up conversations/context; and a **DEEP DIVE test** before the
operator trusts it with the rest of their history. Every sub-ask maps to
one of the six required-coverage areas below, and every area maps to at
least one story (full traceability table in §8).

## 2. Proposed approach — architecture decisions first

### 2.1 Composition, not duplication

This epic composes the SAME shipped primitives `mnemosyne-repo-onboarding`
already proved out, never a parallel storage/ingestion mechanism:

- `ingestDocument()`'s chunk→`remember()` cascade (ro-10/ro-13) — reused
  for the FINAL "write a distilled memory entry" step of every story.
- `MnemosyneClient.remember()`'s multi-layer cascade (client.ts) — the one
  and only write path.
- `ro-04`'s org-tree/scope model — extended, not replaced (see §2.3).

**New, not reused (because nothing existing covers it):** a
transcript-aware PARSING layer upstream of `ingestDocument()`. Real
research (research-brief §1.1/§1.2, §2.1) confirms both real sources
(Claude Code JSONL, ChatGPT `conversations.json`) are turn-by-turn,
role-tagged, tool-call-and-thinking-signature-laden, and in the ChatGPT
case a tree-DAG, not a flat file — structurally incompatible with
`ingestDocument()`'s plain-text/Markdown/PDF assumption (`SUPPORTED_
EXTENSIONS = {.txt, .md, .pdf}`). Decision, explicit: build a NEW,
format-specific parsing/normalization stage (`cm-03` for Claude Code
JSONL, `cm-04` for ChatGPT export) that turns each source's real schema
into a shared, normalized `ConversationTurn[]` shape, then hands
DISTILLED text (never raw multi-megabyte transcripts) to
`ingestDocument()`'s existing chunk/remember() cascade unchanged. This
mirrors `ro-11`'s own precedent exactly: `crawlAndIngest()` is new code
for a new input shape (a live URL), but the actual persistence step is
`ingestDocument()`, untouched.

**Why "hand DISTILLED text, not raw transcripts" matters as an
architecture decision, not just a nice-to-have:** a raw 50MB session
transcript run through `ingestDocument()` unmodified would either be
rejected outright (`MAX_INGEST_BYTES = 200_000` — 50MB is ~250x over) or
would require raising that cap by two orders of magnitude, defeating the
cap's own purpose. The correct fix is not "raise the cap" — it's "don't
feed the raw transcript to the primitive that was built for CVs and
READMEs." `cm-07`'s distillation step is what makes a transcript
ingestable at all, not an optional cleanup nicety.

### 2.2 Where this plugs into the 5-level taxonomy — explicit decision

**Decision: conversation memory is NOT a new Level 5. It lives inside the
existing Level 3 (vector store).** Reasoning (research-brief §2.3):
`levels.ts`'s own framing is "each MEMORY STORE TYPE is a level" — a
distilled conversation memory entry is structurally identical to any other
vector-embedded chunk with provenance (the same shape `ingestDocument()`
already produces for a CV or crawled page). Introducing a sixth level
would conflate "memory store type" with "content source," which is
exactly the confusion `levels.ts`'s own doc comment warns against
(distinguishing memory levels from orchestration tiers). What IS new: a
`source: 'external_conversation'` provenance tag (mirroring `ro-11`'s
`source: 'external_chat'` precedent from `m-09`, carried forward) and a
new `Scope` value's first real consumer.

### 2.3 Scope — `meta`, given real, concrete meaning for the first time

**Decision:** conversation memory writes use `Scope: 'meta'`. Research
(research-brief §2.4) confirms `meta` already exists in the type system
(`interfaces.ts`, `schema.ts`, `server.ts`'s `SCOPES` set) but has no real
consumer today — it's thinly implemented, appearing only in types/schema/
tests. Cross-session conversation memory is definitionally NOT any one
repo's `project` scope (a session about `mnemosyne` and a session about
`consus` both belong in the same cross-project corpus) and is a different
concept from `enterprise` (which in this codebase's own convention means
"a Qdrant collection that couldn't be confidently placed to one repo" per
`placement_engine.py`'s heuristic, not "spans many repos by design"). This
epic is the first real consumer to give `meta` scope concrete behavior: a
dedicated collection (naming convention TBD by `cm-03`'s implementation
step, following `ro-06`'s own collection-creation discipline) that
`recall(query, 'meta')` can query independent of which repo the caller is
currently in.

### 2.4 Discovery (required-coverage #1)

`cm-02` enumerates real sources without the operator manually pointing at
each one:

- **Claude Code sessions:** walk `~/.claude/projects/*/`, apply the SAME
  scratch-filter heuristic already used for this session's own research
  (`grep -vE '^-private-tmp|^-private-var-folders|scratchpad'`), refined
  with one more real signal found during this pass: a directory whose
  slug decodes to a path under the user's own home directory but outside
  any of `Code/`, `Documents/work/`, or another operator-confirmed
  project root is a WEAK scratch signal (not a hard exclude — surfaced to
  the operator in the discovery manifest for confirmation, never silently
  dropped or silently included). The manifest also records each session's
  real byte size and its `cwd`/`gitBranch` fields (both present on every
  line, research-brief §1.1) so triage (`cm-05`) can prioritize by real
  recency/repo-relevance signals already present in the data, not new
  ones invented for this purpose.
- **Confirmed export files:** the ChatGPT export
  (`~/Downloads/ChatGPT Data Export Feb 5 2026/conversations.json`),
  named explicitly, never a generic "scan Downloads for zip files"
  behavior (a generic Downloads-scanner would sweep up the OpenAI Export,
  LinkedIn export, Photos export, and Drive export bundles as
  false-positive candidates — research-brief §1.2 confirms all of these
  are real, present files in the same directory).
- **Gemini:** documented as a real, confirmed-absent source (research-
  brief §1.3) — `cm-02`'s discovery manifest includes an explicit
  `gemini: not_found` line so the gap is visible to the operator, not
  silently omitted. The parser design (`cm-04`'s normalized shape) is
  built so a future Gemini parser is a same-shape addition, not a
  redesign, WITHOUT building it against invented sample data now.
- Discovery is **read-only** — it produces an inventory manifest
  (session path, byte size, mtime, `cwd`, scratch-confidence flag) and
  ingests nothing. This is the `read-only` parallel-eligible story in the
  decomposition (§9).

### 2.5 Usefulness vs. trash triage (required-coverage #2)

**Mechanism, named explicitly: a hybrid heuristic-prefilter +
LLM-classification pass, never LLM-only from byte 1.** Real cost/scale
reasoning, not hand-waved: at 234+ real sessions, several 50MB+, running
every session through an LLM classifier at full transcript length is both
expensive and pointless — most of a 50MB transcript is tool-call
input/output noise and `thinking` block signatures (research-brief §1.1),
not judgment-relevant content. The pipeline:

1. **Heuristic prefilter (cheap, deterministic, runs on every session):**
   real signals already present in the data — turn count, real elapsed
   wall-clock time (first timestamp to last), ratio of `tool_use`/
   `tool_result` blocks to `text` blocks, presence/absence of an
   `attributionSkill` (a session that only ever ran a one-line slash
   command and produced no further turns is a strong low-signal
   candidate). This prefilter NEVER deletes — it only produces a
   provisional priority score used to order what the next stage spends
   LLM budget on.
2. **LLM-based summarization+classification (bounded, budget-aware):**
   for each session, ONE bounded call (never re-summarizing raw
   megabytes — fed the heuristic-prefilter's extracted text-only turns,
   itself capped) produces: a one-paragraph summary, a
   `keep`/`trash`/`uncertain` recommendation, and a one-line rationale.
   `uncertain` is a real, distinct third bucket — the pipeline does NOT
   force a binary choice when the classifier itself isn't confident.
3. **Human review/confirm gate — never fully automatic, never silent
   deletion, no exceptions.** Every `trash` and `uncertain` recommendation
   is written to a real, operator-reviewable queue file (never acted on
   directly). Nothing is ever deleted from the source transcripts
   (`~/.claude/projects/` is read-only input, never written to by this
   epic — a structural guarantee, not a policy note) and nothing already
   written to Mnemosyne's own store is auto-deleted by a `trash`
   verdict — a `trash` verdict controls whether a session's content is
   EVER PROPOSED for distillation/ingestion in the first place, not
   whether existing memory is pruned. This mirrors `ways_of_working.md`'s
   own hard rule, "never wipe Qdrant collections... additive/upsert only,
   everywhere, no exceptions" — extended here to "never wipe SOURCE
   transcripts or auto-delete already-stored memory based on an
   automated verdict."

### 2.6 Clustering/indexing (required-coverage #3)

**Mechanism, named explicitly: embedding-based similarity over each
session's distilled summary (not the raw transcript), seeded/labeled by
the real project-slug signal already present in the directory structure.**
Reasoning: the operator's own quote says "different overall mixes of
which ones are helping with what" — mixing happens WITHIN a project slug
just as often as across them (e.g. many `mnemosyne` sessions cover
distinct sub-epics), so project-slug alone is too coarse as the sole
grouping key, and pure embedding similarity with no anchor risks drifting
clusters that don't map to anything the operator recognizes. The design:
project-slug becomes a first-class metadata facet (`Content.metadata.
project_slug`, decoded from the directory name) available as a filter/
facet on top of embedding-similarity clustering, not a replacement for it.
Clustering itself runs over `cm-05`'s per-session summaries (small,
bounded input) via the SAME embedder Mnemosyne's vector layer already
uses — no new embedding infrastructure. Cluster assignments are written
as `Content.metadata.cluster_id`/`cluster_label` on the eventual distilled
memory entries (`cm-06`), queryable via `recall()`'s existing
`meta`-scope path, never a parallel index.

**`[grill 2.1]` Which triage verdicts feed clustering — resolved
explicitly:** `cm-06` clusters `keep` AND `uncertain` sessions (both are
real candidates for eventual distillation — `uncertain` is deliberately
not "trash-adjacent," it's "the classifier wasn't confident," §2.5).
`trash`-verdict sessions are excluded from clustering entirely — they
never reach `cm-06`'s input at all, not merely excluded from its output.
This was an unstated assumption in the original draft; stated here so
`cm-06`'s story YAML can encode it as a real acceptance criterion rather
than an implementation-time guess.

**`[grill 1.1]` "Clean up the conversations" — scope clarified, not left
ambiguous:** this epic NEVER modifies, deletes, moves, or reorganizes
source transcript files (`~/.claude/projects/*.jsonl`, the ChatGPT export
files) — those are read-only INPUT, permanently, a structural guarantee
(no story in this decomposition opens any of those paths for writing).
"Clean up the conversations and context" is defined purely as: producing
NEW, distilled memory entries in Mnemosyne's own store. If the operator's
intent also included reorganizing/archiving the operator's own local
`~/.claude/projects/` directory itself, that is explicitly OUT OF SCOPE
for this epic and would need its own, separate, operator-confirmed ask —
named here rather than silently assumed either way.

### 2.7 Breakout/cleanup (required-coverage #4) — the real transformation, named

**Concrete transformation, not left abstract:** a raw session (up to
50MB+) is distilled into a BOUNDED, small number of high-signal memory
entries per session — never a 1:1 chunk-per-4KB re-embedding of the raw
transcript (which `ingestDocument()`'s own `CHUNK_SIZE_BYTES = 4_000`
would otherwise imply — ~12,500 chunks for a 50MB session, an absurd
result this epic explicitly rejects). The distillation step (`cm-07`)
produces, per session: (a) a small number of **decision/fact entries**
(concrete, durable claims the session established — the kind of thing
that belongs in memory), (b) a small number of **open-question entries**
(unresolved threads, explicitly tagged as such, not presented as settled
fact), and (c) ONE **session-summary entry** (the one-paragraph summary
from triage, carried forward, tagged with the full source session path/
id for provenance). Each entry is itself plain text handed to
`ingestDocument()` unchanged (§2.1) — this is the literal mechanism by
which "clean up the conversations and context" becomes a real, bounded,
inspectable artifact instead of a vague aspiration.

### 2.8 Privacy and safety (required-coverage #5) — first-class, named

New cross-cutting concern, **`conversation-privacy-safety`**, added
alongside `external-fetch-safety`'s precedent (research-brief §2.2/§4) —
not folded into the generic five-concern list, because this epic's risk
surface (real, sensitive personal conversation history at real scale) has
no existing analog there.

**Secret/credential scanning — firm, default-on, no bypass, checked BEFORE
any embed/persist call, mirroring `ro-11`'s SSRF-guard posture exactly:**
`cm-01` is a standalone, reusable scanner module (regex/entropy-based
detection for API-key-shaped strings, bearer tokens, private-key PEM
blocks, connection strings with embedded credentials — the same class of
"real API keys/tokens" `ways_of_working.md`'s own established discipline
this whole session has enforced) run TWICE, at two distinct points, never once-and-trusted-forever: (1) at
parse/normalize time (`cm-03`/`cm-04`), over every extracted turn, BEFORE
any of that text is ever handed to `cm-05`'s LLM classification call —
secrets never reach a model call, not just never reach storage; and (2)
immediately before `cm-07`'s actual `remember()` call, over the final
distilled text — the firm, no-skip persist-time gate, mirroring `ro-11`'s
"re-checked before every fetch" discipline exactly (never checked once
upstream and trusted for a later step). A match at either point
**quarantines that chunk** (never silently strips-and-continues,
never silently drops-and-continues either — both would hide information
from the operator about what was found) and surfaces it in the same
human-review queue triage already produces (§2.5), tagged distinctly
(`quarantine_reason: 'secret_detected'`) so the operator sees exactly what
was caught and can decide per-item. No flag, option, or environment
variable exists anywhere in `cm-01`'s design to bypass the scan for any
content, mirroring `crawlAndIngest.ts`'s own "no escape hatch... this is
intentional and load-bearing, not an oversight to fix later."

**`[grill 4.1]` One shared module, not three independent copies —
convention stated explicitly:** `cm-01` ships as exactly one importable
module (`lib/mnemosyne/ingest/scanForSecrets.ts` or equivalent, named in
the story's own `files_to_modify`) with a single exported function every
other story's `remember()` call site imports and calls, mirroring
`ingestDocument()`'s own "one primitive, reused, never reimplemented"
convention (§2.1). `cm-03`, `cm-04`, and `cm-07` each depend on `cm-01`
in their `depends_on:` list specifically so this is enforced by the
dependency graph, not merely by a documentation note a later
implementer could miss.

**`[grill 5.1]` Residual risk named, not silently assumed closed —
quarantine-report leakage:** `cm-09`'s deep-dive report (§2.9) redacts
secret VALUES, but the surrounding context (variable name, file/line-ish
provenance, a few characters of prefix/suffix commonly used for
truncated-value display) could itself be reconstructable or sensitive in
some cases (e.g. a redacted `AWS_SECRET_ACCESS_KEY=***` line still
reveals that credential's EXISTENCE and naming convention in a real
session). Named explicitly as a residual risk (mirrors `ro-11`'s R13
discipline) rather than claimed fully solved: `cm-09`'s report is treated
as itself sensitive (local-only, never an artifact this planning
convention would publish/share) and `cm-01`'s own quarantine record
(open question #4) governs the real retention/access policy for the
underlying flagged content, not the report.

**Bounded, operator-reviewed PILOT phase before any full-corpus story is
ever proposed:** `cm-08` is a small, real, human-confirmed sample (a
handful of real sessions across at least two different real project slugs
plus a small slice of the real ChatGPT export — exact counts are the
story's own acceptance criteria, kept deliberately small) run end-to-end
through discovery→scan→triage→cluster→distill. **`[grill 3.2]` Selection
mechanism named concretely, not left implicit:** `cm-02`'s discovery
manifest (§2.4) is presented to the operator as a real, reviewable list
(session paths + sizes + project slugs); the operator explicitly selects
which sessions/export-slice populate the pilot sample by marking entries
in that manifest (a CLI confirm step or an edited manifest file — `cm-08`'s
own implementation step picks the concrete mechanic) — `cm-08` never
auto-selects "the first N sessions found" on the operator's behalf. **This epic's story
decomposition deliberately contains NO "ingest the full 234-session,
multi-gigabyte corpus" story** — that is out of scope for this planning
pass by design (`ways_of_working.md`'s "don't build ahead of an explicit
CBA" rule, and the task's own explicit instruction), named as an open,
future decision gated on `cm-08`'s and `cm-09`'s results (§6, §8).

### 2.9 The operator's own "DEEP DIVE test" (required-coverage #6) — a distinct story, not folded into generic testing

`cm-09` is its own story, not a step inside another story's generic
`test` phase. It runs against `cm-08`'s REAL pilot output (never synthetic
fixtures) and produces a real, human-inspectable report: per-session
before/after (raw byte size vs. number of distilled entries produced),
every triage verdict with its rationale, every cluster assignment, every
secret-scan quarantine hit (content redacted in the report itself — the
report names WHERE a secret was found and its category, never reproduces
the secret value), and a handful of real `recall()` spot-checks proving
distilled memory is actually retrievable and relevant. This is the
artifact the operator reviews before any full-corpus decision is made —
exactly the operator's own words, "that will need a DEEP DIVE test,"
taken as a structural requirement, not a suggestion.

**`[grill 3.1]` Unresolved tension, named explicitly — cross-product
recall isolation:** Mnemosyne's own current north star (`project_state.md`,
"Roll Your Own RAG," reframed 2026-08-19) is to be embeddable, as a
memory layer, into third-party products the operator builds or pairs with
(Mode B/standalone onboarding, `ro-02`/`ro-12`). A `meta`-scope
collection holding the operator's own personal conversation history
(ChatGPT chats about arbitrary personal topics, Claude Code sessions
across unrelated client work) sitting in the SAME Qdrant instance/account
a third-party product's embedded Mnemosyne might eventually query creates
a real leakage risk if scope isolation isn't airtight — a third-party
product's `recall(query, 'meta')` call should never surface the
operator's own unrelated personal conversation content. This is NOT
solved by this design discussion (it depends on isolation guarantees
`meta` scope's own future collection-routing design provides, which is
itself an open question, §5 #1) — named here as a real, load-bearing
tension rather than silently assumed away by "it's just `meta` scope."
**Concrete mitigation adopted for THIS epic's own scope:** the `meta`
collection this epic creates is named and documented as
operator-personal-only (never the default `meta` collection an embedded
Mode B product would be pointed at without explicit operator
configuration) — real collection isolation is `cm-03`'s implementation
concern, held to `ro-06`'s own collection-creation rigor.

## 3. Risks

- **Secret/credential leakage into a persisted, embedded store** — the
  single highest-blast-radius risk in this epic, held to the same rigor
  `ro-06` gave Qdrant-wipe safety and `ro-11` gave SSRF safety. Mitigation:
  `cm-01`'s firm, no-bypass, checked-before-every-persist-call scan
  (§2.8), independently re-verified by a reviewer step on every story that
  calls `remember()`.
- **Silent, automated loss of the operator's own real conversation
  history** — a `trash`/classification mechanism that ever deletes source
  data or already-stored memory without a human confirm step. Mitigation:
  structural, not policy-only — discovery/triage never write to source
  transcripts, and no story in this decomposition includes a delete path
  against already-stored memory (mirrors `ro-11`'s "no delete path exists
  in the module at all" discipline).
- **Cost/scale blowup from naive LLM-classification-per-raw-transcript** —
  234+ sessions x up to 50MB+ each, run through an LLM at full length,
  is both expensive and low-signal (most bytes are tool-call/thinking
  noise). Mitigation: the heuristic-prefilter → bounded-LLM-call pipeline
  (§2.5), plus the pilot-before-full-corpus sequencing (§2.8) so real cost
  is measured on a small sample before any full-corpus commitment.
- **`ingestDocument()`'s `MAX_INGEST_BYTES` cap is fundamentally
  incompatible with raw transcript ingestion** — a 50MB session is ~250x
  the 200KB cap. Mitigation: never raise the cap; distillation (`cm-07`)
  is the fix, feeding the existing primitive small, bounded, high-signal
  text, exactly as designed.
- **`meta` scope is thinly implemented today** — this epic is its first
  real consumer, so gaps in `meta`-scope routing (collection creation,
  org-tree representation) may surface during `cm-03`'s implementation
  that aren't yet visible from a read-only code review. Named explicitly,
  not assumed solved; `cm-03`'s own research step re-confirms
  `meta`-scope's real behavior against the live code before building on
  it.
- **ChatGPT export's tree-DAG structure is more complex to linearize than
  Claude Code's linear JSONL** — a naive `mapping`-dict walk could
  mis-thread branched/edited conversations (ChatGPT supports message
  editing, which creates sibling branches in the tree). Mitigation:
  `cm-04`'s research step explicitly designs the DAG-walk-from-
  `current_node` algorithm and tests it against real multi-branch
  conversations sampled from the real export (never a synthetic single-
  branch fixture only).
- **Cross-cutting concerns** — this epic's `.pHive/cross-cutting-
  concerns.yaml` five generic concerns (documentation, versioning,
  loud-failure, provenance-completeness, existing-infrastructure) apply
  per-story, evaluated individually (see each story's `cross_cutting:`
  block), alongside the new `conversation-privacy-safety` concern (§2.8),
  which is the highest-priority one in this epic specifically.

## 4. Dependencies

- `lib/mnemosyne/ingest/ingestDocument.ts` (ro-10/ro-13, shipped) — reused
  unchanged for every persist step (§2.1).
- `lib/mnemosyne/ingest/crawlAndIngest.ts` (ro-11, shipped) — reused as a
  PATTERN (safety-bound discipline, §2.8), not imported directly (no
  network-fetch surface in this epic).
- `MnemosyneClient.remember()`/`recall()` (client.ts, shipped) — the one
  write/read cascade.
- `lib/mnemosyne/memory-levels/levels.ts` (ro-01, shipped) — Level 3
  placement decision (§2.2) is read from, not modified by, this epic.
- `lib/mnemosyne/onboarding/orgTree.ts` (ro-04, shipped) — `meta` scope's
  first real usage (§2.3) may need a small, additive extension (an
  `org/meta/*` node shape) — flagged as an open question (§6), not
  assumed in scope for this epic without operator confirmation.
- Blocked on nothing outside this repo for `cm-01`/`cm-02`/`cm-03`/`cm-04`
  (pure parsing/heuristics against already-local files). `cm-05`
  (LLM classification) and `cm-06` (embedding-based clustering) require
  live model/embedder access — the same access `remember()`'s vector
  layer already requires in production, no new credential surface.

## 5. Open questions

**Genuinely open — need the operator's explicit answer before execution:**

1. **`meta`-scope collection naming/creation:** should conversation memory
   live in one single new Qdrant collection (e.g. `meta-conversations`),
   or should it be partitioned per real project-slug root the way `project`
   scope already is? Recommendation: one shared `meta` collection (matches
   the "cross-project by design" nature of this content), but the operator
   owns the call — this directly shapes `cm-03`'s collection-creation
   sub-step.
2. **Full-corpus follow-on epic:** after `cm-08`/`cm-09` deliver real
   pilot results, does the operator want a SEPARATE, later-planned epic
   for full-234-session ingestion, or should this epic be reopened/
   extended? Not decided here by design (§2.8) — deferred to a real,
   future decision gated on pilot results, never pre-committed.
3. **`OpenAI Export.zip` (351MB, research-brief §1.2):** is this a
   superset/different-dated duplicate of the smaller ChatGPT Data Export
   already used for research, or a genuinely distinct additional source
   (e.g. covering a different account/date range)? Not opened this pass
   (would require extracting and reading a 351MB archive, out of scope
   for a planning-only pass) — `cm-02`'s discovery step should resolve
   this at build time, not this planning pass.
4. **Retention policy for quarantined (secret-detected) content:** `cm-01`
   quarantines rather than silently drops — but where does quarantined
   content ultimately live (a local-only, gitignored review file? deleted
   entirely after operator review?) and for how long? Not fully specified
   here — `cm-01`'s implementation step should propose a concrete answer
   and get explicit operator sign-off before `cm-08`'s pilot runs against
   real content.
5. **Gemini parser:** ~~confirmed absent as a real source today
   (research-brief §1.3). Should a Gemini parser be built speculatively
   now (against no real sample data) to close m-09's original framing, or
   deferred until/unless a real Gemini export becomes available?
   Recommendation: defer — building a parser against invented sample data
   violates this session's own "real data, not assumed" discipline; the
   normalized `ConversationTurn[]` shape (§2.1) is designed so adding it
   later is additive, not a redesign.~~ **RESOLVED (2026-08-25) — see §9.**
   The round-1 framing above ("confirmed absent") was itself wrong: Gemini
   API access is a real, reachable thing today via Portunus, and a real
   (if single, unrelated-project) Gemini conversation export was found on
   this machine once the search was widened. §9 documents the corrected,
   evidence-grounded finding and the concrete story changes it drove
   (`cm-05`/`cm-07` revised, new `cm-10` added). Left struck through rather
   than deleted so the correction's own before/after is visible in the
   document, not silently rewritten.

## 6. Scale assessment

**Large.** Confirmed by real code/data reading, not assumed from the
operator's own hint alone:

- Real data volume: 234+ real sessions, up to 50MB+ each, 4.0GB across all
  (including scratch) `~/.claude/projects/` dirs, plus a real 47.9MB/258-
  conversation ChatGPT export.
- Multi-system: new parsing layer (2 source-specific parsers) + new
  privacy/safety primitive + new triage mechanism (heuristic + LLM) + new
  clustering mechanism (embedding-based) + new distillation mechanism,
  composing but genuinely extending 4 already-shipped subsystems
  (`ingestDocument`, `remember()` cascade, memory-levels taxonomy,
  org-tree/scope model).
- Long-horizon, staged by design: discovery → safety substrate → parsing
  → triage → clustering → distillation → pilot → deep-dive validation,
  explicitly NOT a single "ingest everything" cut.
- Highest-stakes privacy surface this repository has planned to date —
  higher blast radius than `ro-11`'s SSRF surface (a wrong URL fetch is
  recoverable; a leaked credential embedded into a persisted, searchable
  store is not, cheaply).

Routes to H/V planning + a full structured outline with risk registry and
elicitation (§9-§11 of this planning pass), per the Large-scope path.

## 7. Relationship to `m-09-external-chat-ingestion` (mnemosyne-foundation) — explicit, not silently resolved

Following this session's own established convention
(`mnemosyne-repo-onboarding`'s design-discussion §2.4/Open Questions,
research-brief §5): the relationship is stated explicitly here, with a
concrete recommendation, and the final call is the operator's.

**Decision: this epic SUPERSEDES `m-09`'s exact deliverable.** Not
"extends" (m-09's own scope — Gemini/Claude-export parsers + dedup +
ingestion pipeline — is fully re-covered, not added to) and not "coexists
as a separate concern" (there is no remaining slice of m-09's original
scope this epic leaves untouched — every AC in m-09's YAML is either
directly superseded by a `cm-03`/`cm-04` AC, or was built on an unconfirmed
assumption this epic's own research has now corrected). Concretely:

| m-09's own AC/design decision | This epic's disposition |
|---|---|
| "Gemini chat export... chunked, embedded, stored" | Superseded — no real Gemini export exists (research-brief §1.3); replaced by a documented future extension point, not built speculatively. |
| "Claude chat export... parsed and indexed" | Superseded and CORRECTED — m-09 assumed "Anthropic Workbench export"; the real, confirmed source is Claude Code's own local session JSONL (research-brief §1.1), a different and more useful thing the operator actually has 234+ of. `cm-03` covers this for real. |
| "Duplicate chat entries... deduped by content hash (SHA256)" | CARRIED FORWARD, not reinvented — `cm-03`/`cm-04`'s design explicitly reuses this exact mechanism. |
| "Recall results include source metadata (chat_source, timestamp, participants)" | CARRIED FORWARD as the provenance-completeness bar `cm-03`/`cm-04`/`cm-07` are held to, extended with `session_id`/`project_slug`/`cluster_id` fields m-09 never anticipated. |
| Everything about triage, clustering, breakout/cleanup, a human-review gate, or a distinct deep-dive validation story | Never covered by m-09 at all — wholly new to this epic. |

**Action taken this pass (docs-only, not a status-enum change):** `m-09`'s
own `note:` field in `.pHive/epics/mnemosyne-foundation/stories/
m-09-external-chat-ingestion.yaml` is updated to point here (see the
story's edit for the exact wording) — mirroring this codebase's own
existing convention of using `note:` for exactly this kind of
supersession annotation (the field already existed on `m-09` for a
different purpose: recording that no code existed yet). `m-09`'s `status:`
field is left as `pending` (this repo's story-status enum, confirmed via
`grep`, is `pending`/`in_progress`/`complete` only — no `superseded`
literal exists as a convention to reuse, so inventing one here would be a
new, undocumented convention rather than following the established one).
The operator owns the final call on whether to formally close `m-09` in
`mnemosyne-foundation`'s own epic tracking — not silently done by this
planning pass for an epic this pass does not own.

## 8. Requirements traceability (preview — full pass in §12 of the structured outline)

| Operator's phrase | Story |
|---|---|
| "filter through ALL of the things discussed" | `cm-02` (discovery) |
| "get it into memories" | `cm-03`, `cm-04` (source-specific parsing) + `cm-07` (the actual `remember()` write) |
| "figure out usefulness and trash" | `cm-05` |
| "correctly cluster items and index" | `cm-06` |
| "break out and clean up the conversations and context" | `cm-07` |
| "30 plus sessions... different overall mixes of which ones are helping with what" | `cm-02`'s project-slug/`cwd` signal capture + `cm-06`'s clustering |
| "solidify and fix that into mnemosyne memory" | `cm-07` (persists via the real `remember()` cascade, §2.1) |
| "that will need a DEEP DIVE test" | `cm-09` |
| (implicit) never do this unsafely at the operator's real personal-data scale | `cm-01` (secret scan) + `cm-08` (bounded pilot gate) |

## 9. Amendment (2026-08-25) — Gemini correction: real and reachable, not absent

Round-1's own conclusion (§2.4, §5 open question 5, §7's supersession
table, `epic.yaml`'s description) — "no real Gemini export exists
anywhere discoverable on this machine today... Gemini parser deferred" —
was flagged by the operator as WRONG, before any story's build started.
Everything in §§1-8 above stands as the historical record of round 1's
own (incomplete) research; this section is additive and corrects it,
mirroring `mnemosyne-repo-onboarding`'s own §7/§7.9 amendment convention
exactly (grounded in fresh, real re-verification, not a rewrite of the
earlier text).

**Operator's own words, verbatim:** "gemini should not be absent, it
should fully exist as a reachable thing use portunus for the key."

### 9.1 Portunus/GCP re-verification (metadata only, no value resolved)

Two distinct Portunus references exist, both real, both re-confirmed this
pass via `portunus reg show` / `portunus reg json` (metadata only — no
`resolve`/`inject` call was made, per Portunus's own "never print/persist
a raw secret value" discipline, unchanged this session):

| | `personalsites-487021-dostal-shared-gemini` | `personalsites-487021-google_generative_ai_api_key` |
|---|---|---|
| Portunus `sm_name` | `dostal-shared-gemini` | `GOOGLE_GENERATIVE_AI_API_KEY` |
| Portunus `state` | `requested` | `enabled` |
| GCP secret labels (`gcloud secrets describe`) | `app: dostal-swarm`, `environment: shared`, `kind: gemini`, `scope: shared` | none |
| GCP `createTime` | 2026-07-06 | 2026-03-07 |
| Rotation policy | none | `rotationPeriod: 7776000s` (90d) + a `secret-rotation-notifications` Pub/Sub topic |
| Version state | 1 version, `enabled` | 1 version, `enabled` |

For direct comparison, `dostal-shared-qdrant` — the key this same
worktree's `mnemosyne-repo-onboarding` epic (ro-06/ro-07) already resolves
successfully all session via `gcloud secrets versions access latest
--secret=dostal-shared-qdrant --project=personalsites-487021` — carries
the IDENTICAL Portunus `state: requested` and the IDENTICAL GCP label set
(`app: dostal-swarm, environment: shared, scope: shared, kind: qdrant`),
created the same day (2026-07-06) as `dostal-shared-gemini`. This is
conclusive: `state: requested` in Portunus's registry does NOT mean
unreachable — `dostal-shared-qdrant` is real, live proof of the opposite,
observed directly this session, not inherited secondhand. `dostal-shared-
gemini` is part of the SAME operator-provisioned "shared swarm credential"
batch as the already-proven-working Qdrant key: same day, same app label,
same scope label, same access pattern
(`gcloud secrets versions access latest --secret=dostal-shared-gemini
--project=personalsites-487021` — NOT executed this pass, metadata-only
per the task's explicit instruction; existence and accessibility path
confirmed via `gcloud secrets describe`/`versions list` instead, which
return real, non-value metadata only).

**`GOOGLE_GENERATIVE_AI_API_KEY` is a DIFFERENT, unrelated credential —
named explicitly so a future implementer doesn't conflate the two:** no
`dostal-swarm`/`shared` labels, an active 90-day rotation policy tied to a
dedicated Pub/Sub notification topic, and a `createTime` four months
earlier than the shared-swarm batch. This is the shape of a
production-application secret (rotation + notification wiring exists
specifically so a deployed service can react to a credential change),
almost certainly the `personalsites-487021` web app's OWN runtime Gemini
key for some in-app feature — not an operator-swarm/agent-tooling
credential at all. **Decision: this epic uses `dostal-shared-gemini`
exclusively, never `GOOGLE_GENERATIVE_AI_API_KEY`** — mirrors `ro-06`'s
own "the right credential, not just A credential" discipline.

**`[grill 2.1.1]` "Gemini" disambiguated — three real, unrelated Google
products share the name in this codebase/session, named explicitly so a
future implementer never conflates them:** (1) the CONSUMER chat app
(`gemini.google.com`) — §9.2's chat-history subject; (2) the DEVELOPER
API / AI Studio (`generativelanguage.googleapis.com`, `dostal-shared-
gemini`) — this correction's actual subject, the LLM provider `cm-05`/
`cm-07`/`cm-10` use or parse against; (3) **Gemini CLI** — a completely
unrelated Google product, a terminal coding agent (like Claude Code
itself), already referenced elsewhere in THIS repo's own code
(`lib/mnemosyne/layer1/harness.ts`'s `HarnessId = 'gemini-cli'`, the
`GEMINI.md` auto-load file convention) for a wholly different purpose
(Layer 1's cross-harness memory-mandate sync). This epic's own use of
"Gemini" never refers to (3) — named here once, explicitly, so a reader
of `harness.ts` and a reader of this epic's stories never wonder if
they're the same subsystem.

### 9.2 What a Gemini API key structurally enables — and does not

Real, current-knowledge grounding (Gemini Developer API / Google AI
Studio, `generativelanguage.googleapis.com`), stated plainly because
round 1 never checked this at all — it inherited m-09's "Gemini chat
export" framing without asking what kind of Gemini access was even being
discussed:

- An AI-Studio-issued Gemini API key authenticates PROGRAMMATIC
  model-inference calls only — send a prompt, get a completion
  (`generateContent`-shape calls). This is the same class of access an
  OpenAI API key gives to GPT models: pure inference, no account-history
  surface.
- The CONSUMER Gemini chat app (`gemini.google.com`, the thing a human
  types into) stores conversation history in the operator's Google
  Account, exposed to the operator through exactly three channels, NONE
  of which is the Developer API: (1) the app's own UI, (2) a per-
  conversation "Share" public link
  (`gemini.google.com/share/<id>`) the operator can generate and later
  fetch, or (3) a full-account bulk export via Google Takeout's "Gemini
  Apps Activity" category. This is structurally the same split OpenAI has
  between its Developer API and ChatGPT.com's own "Export data" feature
  under Settings → Data controls — two unrelated surfaces, same
  provider, confirmed as the correct mental model rather than assumed.
- **Consequence, stated directly: `dostal-shared-gemini` cannot, on its
  own, retrieve the operator's past Gemini CHAT HISTORY under any
  circumstance** — no scope, permission, or API surface exists on the
  Developer API for that. Round 1's implicit assumption ("a Gemini
  parser" ⇒ "something that reads a Gemini export the way `cm-04` reads a
  ChatGPT export") was never going to be unlocked by a key at all; that
  was never the blocker research needed to check.

### 9.3 Real, on-machine evidence corroborating the split — a real Gemini export DOES exist, just not via Takeout, and not where round 1 looked

Round 1's search (research-brief §1.3) was `~/Downloads`, `~/Desktop`,
and `~/Documents` at **maxdepth 3**, filtered to filenames containing
"gemini"/"takeout"/"bard". Re-run this pass with one more level of depth
and a plain "gemini" filename match (no "takeout"/"chat"/"export"
qualifier required):

```
find ~/Documents -maxdepth 4 -iname "*gemini*"
  → .../moving-chaos/source_index/gemini_share_raw.html   (798,688 bytes)
  → .../moving-chaos/source_index/gemini_conversation.txt (2,596,266 bytes)
  → .../moving-chaos/source_index/gemini_conversation_INDEX.md (85,556 bytes)
  → .../moving-chaos/source_index/gemini_err.txt (0 bytes)
```

Inspected directly (not assumed from filenames):

- `gemini_share_raw.html` is a real, saved copy of a
  `gemini.google.com/share/<id>` public share page (`<base href="https://
  gemini.google.com/">`, `og:site_name: Gemini`, three
  `AF_initDataCallback` inline data-hydration blobs — Google's standard
  SPA state-hydration pattern, the same family of mechanism ChatGPT's own
  `__NEXT_DATA__` blob is, structurally, per `cm-04`'s own research).
- `gemini_conversation.txt` is the operator's OWN post-processed,
  linearized plain-text rendering of that share page (571 user turns,
  "You said" turn markers, "Created with 3.1 Pro June 8, 2026" /
  "Published July 1, 2026" metadata lines visible in the text itself) —
  proof the operator has, at least once, already produced exactly the
  kind of artifact `cm-04` designed a parser around for ChatGPT.
- `gemini_conversation_INDEX.md` is a hand/script-built table of contents
  (user prompt → line number) over that transcript.

**What this does and does not prove, stated precisely, not overclaimed:**
this is ONE real, single-conversation capture, produced via Gemini's own
public Share-link feature (never Takeout, never the Developer API), sitting
inside an unrelated personal project (`moving-chaos`, relocation
planning) for that project's own purposes — not a comprehensive,
account-wide Gemini history export the way the ChatGPT export is. It does
NOT change §9.4's "no full Gemini Takeout export exists" finding (re-run
this pass — see below). It DOES conclusively prove: (a) the operator can
and does produce real Gemini conversation exports, refuting "confirmed
absent" as a claim about the underlying capability; (b) the mechanism is
Share-link capture, not an API key, refuting the implicit "the key would
unlock this" framing directly; (c) round 1's search depth/breadth was
itself the actual gap — not a missing source, a missing search radius.

### 9.4 Full-account Gemini Takeout export — re-confirmed still absent (wider search than round 1)

Re-run this pass, one level deeper and with an iCloud/broader check round
1 didn't do:

- `find ~/Downloads -iname "*gemini*"` → unchanged, the same two
  AI-generated PNGs round 1 found, no export.
- `find ~/Downloads -iname "*takeout*"` / `*bard*` → no results.
- `find ~/Desktop -maxdepth 3 -iname "*gemini*"` / `*takeout*` → no
  results.
- `find ~/Documents -maxdepth 4 -iname "*takeout*"` → the same single
  `compound-content/takeout` hit round 1 already inspected and ruled out
  (unrelated content-indexing docs).
- `~/Library/Mobile Documents` (iCloud Drive, not checked in round 1) —
  spot-checked to maxdepth 4 for `gemini`/`takeout`, no results.

**Conclusion, stated as precisely as round 1's own: no full-account
Google Takeout "Gemini Apps Activity" export exists anywhere discoverable
on this machine today.** This part of round 1's finding stands, re-
verified with a wider net, not merely re-asserted.

**Correction (2026-08-25, round 3) — see §10.1.** The conclusion above was
accurate as of this round's own re-verification. A real Google Takeout
export has since arrived on this machine (operator-initiated, outside
this epic's own research activity, surfaced to this planning pass as a
confirmed-this-pass fact rather than discovered by a new search). §10.1
documents the precise, evidence-grounded update: real, but small (2
conversations under one Takeout category, not the comprehensive
account-wide archive this section's own heading describes) — left in
place rather than rewritten, mirroring §5's own struck-through-not-deleted
convention for exactly this kind of dated finding.

### 9.5 Determination — (c), both real and separable

Per the task's own framing, both readings are true and distinct, not one
correcting the other:

**(b) Gemini API access, via Portunus's `dostal-shared-gemini` reference,
is real, reachable NOW, and its correct role in this epic is as the LLM
performing bounded classification/extraction work — never as a chat-
history source.** Concretely, two of this epic's stories have a genuinely
LLM-shaped step that round 1 left the provider unnamed for:

- `cm-05`'s triage classification call (already designed, provider never
  named — round 1's own gap, not something this correction invents).
- `cm-07`'s decision/fact/open-question entry extraction (round 1 named
  WHAT this step produces but never named HOW — no mechanism was
  specified at all; re-reading `cm-07`'s own story YAML this pass
  confirms this was a real, pre-existing gap, not a documented heuristic
  choice this correction is overriding).

`cm-06` does **NOT** need Gemini or any new LLM/API surface — re-reading
`cm-06`'s own story YAML this pass confirms it clusters over embeddings
from "the SAME embedder Mnemosyne's vector layer already uses," already
correctly scoped in round 1. (The task's own prompt named `cm-06` as a
candidate Gemini-consumer alongside `cm-05`; real re-reading of the story
it already planned corrects that example rather than accepting it
uncritically.)

**(a) A comprehensive Gemini chat-history source (Takeout) remains
genuinely absent (§9.4) — but "absent" must not mean "dropped."** The
real Share-link artifact found in §9.3 proves the mechanism is real and
operator-reachable today, just not staged anywhere `cm-02`'s discovery
convention would find it, and not yet a corpus. A new story, `cm-10-
gemini-conversation-ingestion`, makes this a first-class, real, reachable
part of the plan — gated on an explicit, named precondition (the operator
staging a real export where `cm-02` can find it), never built
speculatively against invented sample data, and never silently absent
from the epic's own story list either. See §9.6 and the story's own YAML.

### 9.6 Concrete story changes made by this correction

- **`cm-05-usefulness-trash-triage`** — revised: names `dostal-shared-
  gemini` (resolved via Portunus at call time, never inlined/hardcoded)
  as the concrete LLM provider for its already-designed bounded
  classification call. Introduces the shared low-level primitive
  `lib/mnemosyne/conversation-memory/geminiClient.ts` (bounded-input
  enforcement, structured-response parsing, rate-limit-aware retry/
  backoff — this story's own new `files_to_modify` entry) that `cm-07`
  also imports (mirrors `cm-04` importing `cm-03`'s `types.ts` unchanged,
  §2.1 — a shared, reused module, never a second independent
  implementation, per `[grill 4.1]`'s already-established convention for
  this epic).
- **`cm-07-distillation-and-persist`** — revised: names its own,
  SEPARATE bounded Gemini call (via the shared `geminiClient.ts` `cm-05`
  introduces) as the concrete mechanism producing decision/fact/open-
  question entries — previously unspecified. Deliberately kept a
  SEPARATE call from `cm-05`'s, not merged into one: `cm-05`'s triage call
  must run for every discovered session (including ones that end up
  `trash`), while `cm-07`'s extraction call only ever runs for the
  strict subset that already passed triage as `keep`/`uncertain` AND were
  selected/clustered (`[grill 2.1]`'s already-established input-set
  scoping). Merging them would make EVERY session pay extraction-shaped
  LLM cost even when immediately discarded — the exact opposite of the
  heuristic-prefilter's own cost-bounding purpose (§2.5). Kept separate,
  `cm-07`'s real Gemini call volume is already bounded to a strict subset
  of `cm-05`'s, for free, by the pipeline's own existing shape.
- **`cm-02-conversation-source-discovery`** — revised: its `gemini:
  not_found` manifest entry/acceptance-criterion is corrected to `gemini:
  not_staged` — accurate to what's actually true (no export sits in
  `cm-02`'s fixed, named discovery list the way the ChatGPT export does;
  real Gemini export capability is not in question, §9.2/§9.3) rather
  than implying the underlying capability doesn't exist.
- **New `cm-10-gemini-conversation-ingestion`** — a real, reachable,
  `depends_on: [cm-01-secret-credential-scanner, cm-02-conversation-
  source-discovery]` sibling of `cm-03`/`cm-04` (same normalized
  `ConversationTurn[]` output contract, §2.1), gated on an explicit,
  named precondition rather than built against invented data: the
  operator must first stage a real Gemini export (one or more Share-link
  captures, or a future Takeout "Gemini Apps Activity" export) into
  `cm-02`'s fixed discovery list, mirroring exactly how the ChatGPT
  export got there. Full detail in the story's own YAML.
- **`m-09-external-chat-ingestion`** (`mnemosyne-foundation`) — its
  `note:` field is corrected to remove the false "confirmed ABSENT"
  claim; see the story's own edit for exact wording.
- **`epic.yaml`** — `description`/`notes` corrected to match; `cm-10`
  added to the `stories:` list with its real `depends_on`.

### 9.7 Real cost/rate-limit considerations (named, not hand-waved)

- **Billing is enabled** on `personalsites-487021` (`gcloud billing
  projects describe personalsites-487021` → `billingEnabled: true`,
  confirmed this pass) — `dostal-shared-gemini` is not a free-tier-only
  AI-Studio key; it sits under a billed project's higher pay-as-you-go
  rate limits, not the more restrictive unbilled free tier. This is real,
  positive evidence against the "cost/scale blowup" risk already named in
  §3 for the LLM-classification pipeline generally, but it is evidence,
  not a number — this pass does NOT hard-pin an exact RPM/TPM quota or a
  specific model id, both of which drift over time and are only
  meaningful read live against the current API catalog.
- **`cm-05`'s own research step gains a new, concrete sub-task:** confirm
  the real, current rate limits and model catalog for `dostal-shared-
  gemini`'s billed tier directly against the live API before
  implementation proceeds — mirroring `cm-07`'s own existing "confirm
  `meta` scope's real live behavior... not assumed from the type system
  alone" discipline (§ research step), applied here to an external
  API's own current state instead of this repo's own code.
  `cm-07`'s research step gains the identical sub-task for its own,
  separate call.
- **Real per-session call count, stated plainly:** at most 2 Gemini calls
  per session that survives triage as `keep`/`uncertain` (1 from `cm-05`,
  1 from `cm-07`), and exactly 1 for any session triaged `trash` (only
  `cm-05`'s). At 234+ real sessions, this is a small, real, boundable
  number the `cm-08` pilot measures directly before any full-corpus
  decision — unchanged from round 1's own "measure real cost on a small
  sample first" posture (§2.8), now with a real provider so that
  measurement is actually possible.

### 9.8 Residual, honestly-named open items (not claimed solved by this correction)

- The exact Gemini model id/tier and its real current rate limits are
  NOT resolved here — deferred to `cm-05`/`cm-07`'s own research steps
  against the live API, per §9.7. This correction fixes WHICH credential
  and WHAT it's for, not the exact runtime numbers.
- `cm-10` remains genuinely gated — this correction does not stage a
  real export into `cm-02`'s discovery list, and does not pull the
  `moving-chaos` Share-link artifact into this epic's own fixtures or
  pilot sample (it belongs to an unrelated personal project; using it
  here without the operator's explicit, separate opt-in would be exactly
  the kind of silent scope-widening this epic's own privacy-safety
  posture, §2.8, exists to prevent). `cm-10` stays unbuilt until the
  operator explicitly stages a real export for THIS epic's purposes.
- Whether `dostal-shared-gemini`'s billed tier is cost-appropriate at
  FULL 234-session scale (as opposed to `cm-08`'s small pilot) is still
  an open, future, pilot-gated decision — unchanged from round 1's own
  "no full-corpus story in this decomposition" posture (§2.8), not
  reopened or loosened by this correction.

Grilled at the same rigor as round 1 — see `docs/grill-record.md` round 2
(5 findings, all resolved).

## 10. Amendment (2026-08-25) — round 3: Takeout export, scope-routing, and pipeline generalization

Three new, real, confirmed-this-pass facts, each folded in per the
operator's own explicit go-ahead for a targeted amendment pass
(planning-only, same discipline as round 2: additive, not a rewrite of
rounds 1-2's own text). Grilled in `docs/grill-record.md` round 3.

### 10.1 A real, small Gemini Takeout export now exists — §9.4 corrected precisely

A real Google Takeout export zip now exists at
`/Users/mdostal/Downloads/Google Takeout Aug 26 2026.zip` (2,964 bytes).
Confirmed this pass via a file-listing-only inspection (`unzip -l` —
names and sizes, no extraction, no content read, per this pass's own hard
privacy constraint, honored identically to this branch's own established
discipline for the `moving-chaos` Share-link file, §9.3):

```
Takeout/Gemini in Workspace/Conversation History/conversation_1776360476.txt  (4,300 bytes)
Takeout/Gemini in Workspace/Conversation History/conversation_1780973211.txt  (1,083 bytes)
Takeout/Gemini/gemini_scheduled_actions_data.html                            (11 bytes, empty)
Takeout/Gemini/gemini_gems_data.html                                         (11 bytes, empty)
```

**What this does and does not prove, stated precisely, not overclaimed
(mirrors §9.3's own discipline exactly):** this is REAL — the first
export in this epic's own history to actually satisfy `cm-10`'s named
gating precondition (a real export staged into `cm-02`'s fixed, named
discovery list, §9.6) — but it is SMALL: exactly 2 conversations, not a
comprehensive account-wide history the way the 258-conversation ChatGPT
export is comprehensive. It does NOT retroactively make §9.4's own
"no full-account Takeout export exists" conclusion wrong as a statement
about *that* re-verification's own moment in time — it supersedes it
going forward. Two further precise observations, not assumed away:

- The plain **`Gemini`** Takeout category itself is present in this
  export but **empty** (both files 11 bytes — no scheduled-actions or
  custom-Gems data). Only the **`Gemini in Workspace`** category carries
  real content.
- **`Gemini in Workspace` is a real, previously-unconsidered product
  surface, named explicitly so a future implementer never assumes it's
  the same thing as the consumer `gemini.google.com` app §9.2/§9.3
  already disambiguated:** Google Workspace's Gemini side-panel
  (Gmail/Docs/Sheets in-app assistant) is a structurally distinct
  integration point from the standalone consumer chat app the
  `moving-chaos` Share-link capture came from. Nothing in this pass
  confirms whether `Gemini in Workspace`'s Takeout schema matches the
  standalone consumer Gemini Takeout schema `cm-10`'s own story
  originally anticipated researching (§`cm-10`'s own "Takeout 'Gemini
  Apps Activity'" framing) — this is a real, open schema question for
  `cm-10`'s own research step to resolve at build time against the real
  staged file, never assumed identical to either the Share-link shape or
  a generic "Gemini Takeout" shape invented from this planning pass's
  own file-listing-only inspection. Added as a fourth real Gemini-related
  product surface alongside `[grill 2.1.1]`'s existing three-way
  disambiguation (consumer app / Developer API / Gemini CLI) — this is a
  variant OF the consumer-app surface (a different Google product
  integrating the same underlying assistant), not a fifth wholly separate
  product, but distinct enough at the export-schema level to name
  explicitly.

**Concrete disposition:**

- **`cm-02`'s discovery manifest** — the fixed, named export-file list
  gains this real path as a second named entry (alongside the ChatGPT
  export), and the manifest's own Gemini entry is corrected from
  `gemini: not_staged` to `gemini: staged (takeout, 2 conversations)` —
  see the story's own YAML for the exact acceptance-criterion wording.
- **`cm-10`'s gating precondition is now MET, for the Takeout path
  specifically** — not the Share-link path, which remains separately
  unstaged (the `moving-chaos` artifact stays proven-as-mechanism-only,
  never opted into this epic without the operator's own separate,
  explicit consent, §9.8, unchanged by this correction). `cm-10`'s own
  YAML is updated to reflect this precisely: the story is no longer
  purely speculative for the Takeout shape, though its own research step
  must still re-confirm this directly at build time (never trust this
  planning pass's own finding as still-current — the same
  "re-checked before every operation" discipline `cm-10` already commits
  to for its own precondition-status check, §`cm-10`'s own YAML).
- **This planning pass performed NO content-level research into the
  export's real schema** — confirming the file listing is the full
  extent of what this pass read, per its own explicit hard constraint.
  Schema confirmation (opening and reading `conversation_*.txt`, which
  is real, legitimate build-time research once `cm-10` actually starts)
  is deliberately left to `cm-10`'s own research step, not performed
  speculatively here.

### 10.2 Scope-routing — an existing, real, named client scope a cluster could legitimately belong to

**Real, confirmed-this-pass finding:** `swarm-memory`'s own config at
`~/.config/swarm-memory/config.toml` — the SAME file
`VectorLayerAdapter.remember()` already reads via its `swarm-memory
config` shell-out (`VectorLayerAdapter.ts:213-226`, confirmed by direct
read this pass, and independently confirmed as the real, live location by
`ro-06`'s own research spike, `mnemosyne/onboarding.py`'s docstring) — has
a real, existing `[scopes]` entry: `arizona =
"clients_arizona_compound_memory"`, backing a real project directory at
`~/Documents/work/personal/arizona-compound` (confirmed to exist on disk
this pass). `interfaces.ts`'s own `Scope` type doc comment already
anticipates this: `'project'|'enterprise'|'meta'` is explicitly named as
"at minimum" — "additional scope values may be added by later stories
without breaking this contract" (`interfaces.ts` lines 87-90) — so
`arizona` is not an invented concept; it is a real, already-registered,
already-load-bearing scope key the exact same `remember()` write path
`cm-07` already calls could resolve TODAY, for a different repo's own
onboarding.

**`[grill-anticipated]` "Scope" vocabulary, disambiguated once, explicitly
— named here so `cm-06`/`cm-07`'s own story text never conflates the two
things a reader could reasonably call "scope":** (1) **Mnemosyne's own
`Scope` type** (`interfaces.ts`, `'project'|'enterprise'|'meta'` "at
minimum") — the caller-facing enum `remember()`/`recall()` accept as a
parameter; (2) **`swarm-memory`'s own `[scopes]` registry**
(`config.toml`, keys like `top`/`clients`/`arizona`/`personal`) — the
underlying scope-key-to-collection-name MAP `VectorLayerAdapter`
resolves (1)'s values against at runtime. They are not two competing
systems — (2) is the real, live resolution table (1)'s values are looked
up in (§9.1-style direct code confirmation, not assumed): `cfg.scopes?.
[scope]`. `arizona` is a real key in (2) already; using it as a (1)-typed
value is additive to an already-extensible contract, not a new concept
this epic invents.

**The gap named, concretely:** `cm-06` (clustering) and `cm-07`
(distillation/persist), as currently designed, only ever target this
epic's own `meta`-scope collection (§2.3) — there is no design today for
a cluster whose project-slug signal clearly matches an EXISTING, real,
already-registered scope like `arizona` to route into THAT scope's own
collection instead. A cluster of conversation-memory sessions genuinely
about the Arizona compound project belongs, arguably, in
`clients_arizona_compound_memory` — the same real collection
`arizona-compound`'s own future onboarding (`ro-05`/`ro-06`'s own
pipeline, a different, already-shipped epic) would resolve to — not
buried in this epic's own cross-project `meta` collection where the
operator's `recall(query, 'meta')` sweep would still surface it, but
mixed in with everything else rather than living where a future
`arizona-compound`-scoped query would find it directly.

**Design, read-only, additive to `cm-06`/`cm-07` (not a new ticket — the
schema fits both existing stories cleanly: `cm-06` already computes the
per-cluster project-slug facet this decision consumes; `cm-07` is the
epic's ONLY story that ever calls `remember()`, so it is the only correct
place the actual scope value gets chosen):**

1. **`cm-06` gains a read-only scope-resolution sub-step.** For each
   cluster, given its member sessions' real project-slug facet(s)
   (already computed, §2.6), check for a match against REAL, ALREADY-
   EXISTING scope registries — never invented, never auto-created:
   - `swarm-memory`'s own `[scopes]` table, read via the exact SAME
     `swarm-memory config` shell-out `VectorLayerAdapter.remember()`
     already performs (never a second, independently-implemented
     TOML/JSON parse of `config.toml` — mirrors `[grill 4.1]`'s own "one
     primitive, reused, never reimplemented" convention, applied here to
     an already-shipped OTHER story's own shell-out, not a new shared
     module this epic introduces).
   - `~/.mnemosyne/org-tree.yaml`, if it exists — confirmed THIS pass: it
     does **not** exist on this machine today (only
     `~/.mnemosyne/level0-rules.md` is present). The check is included in
     the design anyway, read defensively (`ro-04`'s own established
     "missing file is not an error, returns empty" contract, never
     assumed present), so this design isn't stale the moment that
     registry appears from a different, already-shipped epic's own future
     work.
   - Match is a **plain, conservative string/slug comparison against
     REAL, PRE-EXISTING scope keys only** — never fuzzy, never
     inferred from content, never a NEW scope name proposed. A match is
     only proposed when the cluster's member sessions' project-slug
     facet(s) are UNAMBIGUOUS (all members agree, or the matching slug is
     the overwhelming majority) — a cluster spanning genuinely mixed
     slugs with no single dominant match produces no scope-route
     candidate at all, falls through to the default below.
   - **Zero side effects, structurally:** this sub-step never creates a
     scope, a collection, or an org-tree entry — a pure read against
     already-existing registries, mirroring `ro-06`'s own explicit
     "Additive-only, by design: no delete/drop code path exists anywhere
     in this module" discipline (`mnemosyne/onboarding.py`'s own
     docstring), extended here to "no CREATE path exists either" — this
     step only ever reads, never writes, a registry.
   - Output: `Content.metadata.resolved_scope_candidate` (nullable) on
     the cluster, alongside the existing `cluster_id`/`cluster_label`
     facets — a CANDIDATE, not a decision.

2. **A scope-route candidate is surfaced into the SAME human-review queue
   `cm-05`/`cm-01` already produce** (§2.5, §2.8's own established
   pattern — never a new, parallel review surface), tagged distinctly:
   `review_reason: 'scope_route_candidate'`, naming the matched real
   scope key and its real collection name, requiring the operator's own
   EXPLICIT, per-cluster confirmation before it is ever acted on —
   mirrors `cm-01`'s own `quarantine_reason: 'secret_detected'` tagging
   convention exactly, same queue file, same non-automatic posture.

3. **`cm-07` consumes ONLY confirmed candidates.** At persist time, for
   any given cluster: if the operator has explicitly confirmed a
   `scope_route_candidate` for that specific `cluster_id` in the review
   queue, `cm-07` writes that cluster's entries with the CONFIRMED real
   scope value instead of `'meta'` (full existing provenance-metadata
   contract unchanged otherwise — `chat_source`/`session_id`/
   `project_slug`/`cluster_id` all still present). **For every other
   cluster — no match found, a match found but not yet confirmed, or an
   ambiguous cluster that never produced a candidate at all — `cm-07`'s
   existing, unchanged behavior applies: `scope: 'meta'`, no exceptions.**
   This is the safe default, not an opt-out: absence of an explicit
   confirmation is never treated as an implicit yes.

**Residual risk, named explicitly, not silently assumed closed (the
task's own required framing) — the highest-severity failure mode this
design point could introduce:** a project-slug match is a HEURISTIC, not
a guarantee. Two real, concrete ways it could be wrong: (a) an
operator-personal conversation session merely MENTIONS or is tangentially
related to a client project without actually belonging to that client's
own confidential work; (b) a coincidental slug collision (e.g. an
operator project literally named `clients` or `personal` colliding with a
generic-sounding, already-registered scope key in `config.toml`'s own
`[scopes]` table — both real, existing keys today). A wrong-scope route
would put the operator's own personal conversation content into a
client-facing collection — a real, cross-boundary content leak, the
single highest-severity outcome this specific design point could ever
introduce, categorically worse than this epic's existing worst-case
(personal content ending up in the operator's OWN `meta` collection,
still fully under the operator's own control). **The concrete
confirms-before-write control that prevents it, stated precisely, not
hand-waved:** step 3 above is unconditional — no code path in `cm-07`
routes to a non-`meta` scope without a real, on-disk, operator-authored
confirmation record tied to that exact `cluster_id`; the resolution
sub-step (step 1) NEVER writes a scope value directly to any
`remember()` call, it only ever proposes a candidate into a queue a human
must act on. This mirrors `cm-08`'s own "no implicit/default sample
selection exists anywhere in this story's code" discipline (`[grill
3.2]`), applied here to scope selection rather than pilot-sample
selection — the same category of control for the same reason.

**A real cross-epic coordination point, named rather than silently
assumed frictionless:** `remember()`'s own `RememberOptions.scope` is
TypeScript-typed as the literal union `Scope = 'project' | 'enterprise' |
'meta'` (`interfaces.ts`, owned by the already-shipped
`mnemosyne-foundation` epic, outside this epic's own `files_to_modify`
scope). Passing a real registry key like `'arizona'` through that
parameter is anticipated by `interfaces.ts`'s OWN doc comment (quoted
above) but is not YET type-safe without either a local widening
mechanism `cm-07`'s own implementation must choose, or a small, additive
change to `Scope`'s own declaration coordinated with whoever owns that
file today. Named explicitly as a real, small, cross-epic dependency
`cm-07`'s own research step must surface and resolve BEFORE
implementation (not a blocker to this planning-only pass, which changes
no code) — never silently assumed to be a non-issue just because the
runtime behavior (the `cfg.scopes?.[scope]` lookup) already works for
arbitrary string keys today.

### 10.3 Generalizing the pipeline — a real, repeatable component, not a one-operator script

The operator explicitly asked that this be added to THIS epic, not
deferred to a future one. Precedent followed exactly: `.pHive/epics/
mnemosyne-repo-onboarding/` (shipped, merged to `main`, v0.15.0) —
`onboardRepo()` (`lib/mnemosyne/onboarding/onboardRepo.ts`, `ro-02`) is
the one shared orchestrator BOTH its deployment modes compose; `mnemosyne
onboard` (`bin/mnemosyne-onboard.mjs`, wired into `bin/mnemosyne`'s
existing `if [ "${1:-}" = "<verb>" ]` dispatch pattern, `ro-05`/`ro-07`)
is its real CLI entry point.

**Two new stories, `cm-11`/`cm-12`, mirroring that exact split** (shared
orchestrator vs. CLI-verb wiring, the same division `ro-02` vs. `ro-05`
already establishes as this repo's own real convention for "package a
pipeline as a repeatable component"):

- **`cm-11-generalized-pipeline-orchestrator`** — a new,
  parameterized `harvestConversationHistory()` orchestrator
  (`lib/mnemosyne/conversation-memory/harvestConversationHistory.ts`)
  that composes `cm-02` → `cm-03`/`cm-04`/`cm-10` → `cm-05` → `cm-06` →
  `cm-07` exactly as `cm-08`'s own pilot orchestrator already sequences
  them (§2.8), but against OPERATOR-SUPPLIED inputs — a sessions-root
  directory and a caller-provided list of named export files — instead
  of `cm-02`'s own hardcoded constants (this operator's own
  `~/.claude/projects/`, this operator's own specifically-named ChatGPT
  and Gemini export paths). `cm-02`'s own "fixed, named list, never a
  generic scan" discipline (§2.4) is explicitly PRESERVED, not loosened,
  by parameterization — it becomes a caller-supplied fixed list, never a
  caller-supplied directory-sweep pattern.
- **`cm-12-harvest-cli-verb`** — the new `mnemosyne harvest` CLI verb
  (`bin/mnemosyne-harvest.mjs`), wired into `bin/mnemosyne`'s existing
  dispatch pattern exactly the way `onboard` already is, exposing
  `cm-11`'s orchestrator with operator-supplied path/source flags plus
  `cm-08`'s own confirmation-gate discipline preserved as CLI flags (no
  implicit default sample/source selection, ever).

**Verb name, decided explicitly, not left arbitrary:** `harvest` — never
`onboard` (already means "bring a REPO online": Layer-1 sync, persona
seed, file index, base-level report — a structurally different real
action against a structurally different input). Reusing `onboard` for a
conversation-history pipeline would conflate two unrelated real actions
the same way `[grill 2.1.1]` (round 2) named for the word "Gemini" —
disambiguated once, explicitly, the same discipline applied to a verb
name this time. Confirmed unused anywhere in this repo's own `bin/`
directory, `package.json`'s own `bin` map, or as a term elsewhere in this
codebase (grepped this pass) before selecting it.

**`[design decision, stated explicitly per the task's own instruction]`
Proof posture — synthetic/structural correctness only, never a real
second operator's real conversation history:** `cm-11`/`cm-12`'s own
test suites (and their own acceptance criteria) are held to fixtures and
structural correctness ONLY. There is no real second operator's data
available to this repo, and using anyone else's real conversation content
without their own explicit involvement would violate this epic's own
`conversation-privacy-safety` posture (§2.8) — the exact same posture that
already governs why `cm-10`'s own fixtures may never be the operator's
real `moving-chaos` content (§9.8) and why `cm-02`'s own test suite never
runs against this operator's real `~/.claude/projects/` tree either
(`cm-02`'s own YAML). **The ONLY real-data proof this epic ever produces
remains `cm-08`'s pilot and `cm-09`'s deep-dive test, both scoped to THIS
operator's own data, exactly as already planned — `cm-11`/`cm-12` do not
add, extend, widen, or substitute for that real-data proof in any way.**
A genuinely different second operator's own first real run against their
own machine remains the actual validation event for cross-operator
correctness, explicitly named as unverified BY THIS EPIC — not
overclaimed as solved by a synthetic fixture suite alone (mirrors `[grill
5.1]`'s "name what isn't fully solved" discipline).

**Dependency, stated explicitly per the task's own instruction:** `cm-11`
`depends_on: [cm-09-deep-dive-validation-test]` (not merely the more
obvious `cm-07`/`cm-08`, both already transitively required via `cm-09`'s
own dependency chain) — the generalized component is not packaged as
"ready to use" until the operator's own deep-dive test has actually
validated the real pipeline against real data. Generalizing an
as-yet-unvalidated pipeline would risk packaging a mechanism whose
real-world correctness is still only fixture-proven at the moment of
packaging. `cm-12` `depends_on: [cm-11-generalized-pipeline-
orchestrator]`. `epic.yaml`'s own `stories:` list is updated to match.

**Explicitly out of scope for `cm-11`/`cm-12`, named rather than silently
assumed covered:** multi-operator LLM/credential provisioning. `cm-05`/
`cm-07`'s own `geminiClient.ts` resolves ONE specific Portunus reference
(`dostal-shared-gemini`, §9.1) — a different operator running this
generalized component on their own machine would need their OWN LLM
credential, a genuinely separate, unplanned concern this correction does
not solve. `cm-11` parameterizes INPUT PATHS only, never the LLM
provider — named explicitly so a future reader never assumes
"generalized" means "credential-portable" too.

### 10.4 Residual, honestly-named open items (not claimed solved by this correction)

- **Whether `cm-08`/`cm-09` should now ALSO exercise a small Gemini
  Takeout slice**, now that `cm-10`'s Takeout precondition is met, is a
  real, live question this correction does NOT resolve — `cm-08`'s own
  YAML still names only Claude Code sessions and a ChatGPT slice as its
  pilot sample composition. Left open, not silently decided either way:
  the operator may want `cm-10` built and folded into a future pilot
  iteration, or may prefer keeping the 2-conversation Gemini sample out
  of the pilot entirely given its small size. Not opened this pass —
  would require modifying `cm-08`/`cm-09`, outside this amendment's own
  three named changes.
- **The `Gemini in Workspace` vs. standalone-consumer-Gemini schema
  question (§10.1)** is NOT resolved here — genuinely deferred to
  `cm-10`'s own research step at build time, against the real staged
  file, never assumed identical to the Share-link shape this epic already
  researched.
- **The `Scope`-type cross-epic coordination point (§10.2)** is named,
  not resolved — `cm-07`'s own research step gains the concrete sub-task
  of confirming the real, safe implementation approach (local widening vs.
  a coordinated `interfaces.ts` change) before implementation proceeds.
- **Whether ANY cluster in a REAL future pilot/deep-dive run will ever
  actually produce a confirmed scope-route candidate** is unverified by
  this planning pass — `cm-08`'s own pilot sample (per its existing
  acceptance criteria) spans at least 2 real project slugs, but whether
  any of them happens to match a real, already-registered `swarm-memory`
  scope key is a real-data question this design enables answering, not
  one this pass answers itself.

Grilled at the same rigor as rounds 1-2 — see `docs/grill-record.md`
round 3.

## 11. Amendment (2026-08-26) — round 4: intake/distribution/decommission split

Real design change, driven by the operator's own explicit framing this
pass, planning-only (no application code touched — `.pHive/epics/
mnemosyne-conversation-memory/**` only), additive to §§1-10 exactly as
rounds 2 and 3 were: nothing above is rewritten or deleted.

**Operator's own words, verbatim:** "it should have an intake and then a
way to get into the others as we distribute... we then shutdown the
intake as it distributes across, so meta is separate from intake." And,
confirming the exact shape when asked directly: "intake is a separate,
temporary landing collection distinct from meta. cm-07 always writes
there first; a later distribution step reads intake, resolves the real
destination (meta for general cross-project content, or a confirmed
specific scope like arizona), writes there, then intake shuts down for
that entry." And, on what "shuts down" means concretely: "mark and
distribute -- keep an audit trail, then allow for a way to decommission
it and optionally back it up or just full wipe."

This is THREE real, distinct pieces — a landing zone (`cm-07`, revised),
a distribution step (`cm-13`, new), and a decommission step (`cm-14`,
new) — not one story doing all three. §11.1 grounds the design in this
pass's own real code re-verification; §11.2-§11.4 cover each piece;
§11.5 names what's still genuinely open.

### 11.1 Real code re-verification this pass (grounding, mirrors §10's own discipline — nothing below assumed from memory alone)

- **`MnemosyneClient.remember()` (`client.ts:447`) and `VectorLayerAdapter.
  remember()` (`VectorLayerAdapter.ts:205`), read directly this pass:**
  every call writes a BRAND-NEW timestamped note file
  (`${stamp}-${tag}.md`) and shells out to `swarm-memory index <collection>
  --no-prune <file>`, which reports an "upserted N chunks" count. There is
  no exposed "update an existing point by id" capability anywhere in this
  path — a second `remember()` call with different metadata for
  "the same" logical entry produces a NEW file and a NEW indexed point,
  never an in-place mutation of the first. This is the real, concrete
  reason the "marking" mechanism below (§11.3) is an ADDITIVE marker
  entry, not an in-place field update — no in-place update primitive
  exists to name, and inventing one now would be exactly the kind of
  "bespoke new write path" the task's own instruction warns against.
- **`mnemosyne/inventory/qdrant_inventory.py`'s `HttpQdrantClient`, read
  directly this pass:** its own module docstring states plainly — "no
  delete/drop method exists anywhere in this module" — and a full read of
  every method (`list_collections`, `collection_info`, `create_collection`)
  confirms this: `create_collection()` (ro-06's own one deliberate,
  narrow, additive exception) is the only non-read method, and its own
  docstring names the absence of any delete/drop method as the concrete
  implementation of `ways_of_working.md`'s hard "never wipe Qdrant" rule.
  This is real, load-bearing precedent other stories' own risk mitigations
  already cite (ro-06's own risk register: "Additive-only module (no
  delete path exists)") — §11.4 below treats it as a contract to PRESERVE,
  never to extend.
- **`swarm-memory --help`, run directly this pass:** the real CLI surface
  is `recall|search|grep|check|scopes|index|graph|config|install-hermes`
  — no delete/remove/decommission verb exists anywhere in the real,
  installed CLI either. Confirms the same finding from the TS/Python
  layers above holds at the swarm-memory-binary layer too — there is
  genuinely no existing delete-capable primitive anywhere in this epic's
  own dependency surface, at any layer. `cm-14` is therefore correctly
  named as the epic's first, not merely nominally, delete-capable
  operation.
- **`~/.config/swarm-memory/config.toml`'s real `[scopes]` table, read
  directly this pass (same file §10.2 already read):**
  `top|clients|ffe|knowledge|claude|ffe-knowledge|learnings|personal|att|
  cadex|cadexlegacy|arizona|social-engine|monitoring` — confirmed: no
  `meta` key exists yet (consistent with §2.3's own original "naming
  convention TBD" posture, still genuinely open) and no `intake` key
  exists either. §11.2 below makes a real, concrete naming recommendation
  for `intake` — not yet applied to the live config, exactly the same
  "recommendation now, real application at build time" posture §2.3 #1
  already established for `meta`.

### 11.2 Piece 1 — `cm-07` revised: unconditional, single-destination write to `intake`

**What changes:** `cm-07` no longer contains ANY confirmed-vs-unconfirmed
scope-selection logic — that entire mechanism (§10.2's steps 2-3) moves,
verbatim in substance, to `cm-13` (§11.3). `cm-07` becomes strictly
simpler: every successful distillation writes with
`scope: 'intake'` (a NEW `Scope`-type value, additive to the existing
`'project'|'enterprise'|'meta'` union exactly as `interfaces.ts`'s own
doc comment already anticipates — the same additive-widening
coordination point §10.2 already named for `'arizona'`, now shared by
two new values, `'meta'` and `'intake'`, both real, both TBD-named at the
type level until `cm-07`'s own research step resolves the concrete
mechanism). `cm-07` NEVER writes `scope: 'meta'` directly and NEVER
writes a confirmed non-meta scope directly, in any code path, for any
entry — no exceptions.

**What carries forward unchanged, verbatim, from §2.1/§2.7/§2.8/§9.6:**
the persist-time `cm-01` secret-scan checkpoint (immediately before every
`remember()` call, no bypass); the bounded-distillation design (decision/
fact/open-question/summary entries, never a raw re-chunk); the shared
`geminiClient.ts` primitive (`cm-05`'s module, imported unchanged) for
the decision/fact/open-question extraction call; `ingestDocument()`/
`remember()` called unchanged, the one and only persist path. None of
this required any change — the operator's own framing this pass changes
WHERE the write lands, not HOW distillation or the scan checkpoint work.

**The `intake` collection-naming/scope-mechanism decision — real,
concrete, not left abstract (mirrors the rigor §10.2 already gave the
`arizona` finding):** recommend a new `swarm-memory` `[scopes]` entry,
`intake = "conversation_memory_intake"` — following the exact same
`<domain>_<memory-type>` naming convention already real and live in the
same table (`clients_arizona_compound_memory`, `personal_memory`,
`work_root_memory`, `ffe_social_engine_memory`), resolved through the
IDENTICAL `cfg.scopes?.[scope]` mechanism (`VectorLayerAdapter.ts:213-226`)
`'meta'` and `'arizona'` already resolve through — no new resolution
mechanism, no parallel collection-routing path. This is a
RECOMMENDATION for `cm-07`'s own research step to apply at build time
(the same "recommend now, apply for real at build time" posture §2.3
open question #1 already established for `meta` — neither key exists in
the live `config.toml` today, confirmed §11.1). **Why a genuinely
separate collection, not a metadata flag on the `meta` collection
itself:** the operator's own words are explicit — "so meta is separate
from intake" — a flag-based design would keep every not-yet-distributed
entry physically co-located with already-distributed cross-project
memory, meaning `recall(query, 'meta')` could surface a not-yet-reviewed,
not-yet-scope-routed entry as if it were settled cross-project memory —
exactly the kind of silent scope-conflation §10.2's own residual-risk
reasoning already rejects for a different reason (client-scope leakage).
A physically separate collection makes "has this been distributed yet"
a structural fact (which collection the point lives in), not a
metadata field a caller could forget to filter on.

**`resolved_scope_candidate` carried forward, unchanged in origin, inert
here:** `cm-06` already computes this (real, shipped code,
`clusterConversations.ts`) — `cm-07` continues to accept it as
pass-through metadata on every persisted intake entry (nullable,
identical shape to §10.2's original design) but performs ZERO logic
against it — it is neither read nor branched on anywhere in `cm-07`'s own
code, purely carried so `cm-13` (§11.3) has what it needs without
re-deriving it from `cm-06`'s output a second time. This is a real
simplification: `cm-07`'s own highest-severity residual risk from round 3
(§10.2's "a wrong-scope route would put personal content in a
client-facing collection") no longer exists as a risk IN `cm-07` at all
— `cm-07` cannot route anywhere but `intake`, structurally, so that
failure mode is now entirely `cm-13`'s own risk surface to own (§11.3).

**A new, real, stable per-entry identifier — a genuinely new requirement,
named explicitly:** every entry `cm-07` persists into `intake` now
carries `metadata.entry_id` (a UUID generated at persist time, distinct
from `content_hash` — a UUID rather than the hash so a later same-text
retry, however unlikely, never collides with an already-marked entry's
identity). This did not exist before this round because nothing
previously needed to reference a specific intake entry from a LATER,
SEPARATE story's own write — `cm-13`'s marker mechanism (§11.3) is the
first thing in this epic that does.

### 11.3 Piece 2 — `cm-13-intake-distribution` (new): reads intake, resolves the real destination, writes there, marks the original

**Reads intake entries — mechanism, named concretely, not hand-waved:**
neither `recall()` (semantic, top-K, requires a query — cannot enumerate
"every entry," §11.1) nor `swarm-memory grep` (keyword-scroll, but still
query-shaped, confirmed via `--help` this pass, §11.1) is a full
collection enumeration primitive. The real, concrete mechanism: a new,
narrowly-scoped, READ-ONLY extension of `HttpQdrantClient`
(`mnemosyne/inventory/qdrant_inventory.py`) — a `scroll_points(name,
payload_filter=None)` method wrapping Qdrant's own native `POST
/collections/{name}/points/scroll` endpoint. This is squarely in the same
risk category as the class's own already-existing `list_collections()`/
`collection_info()` methods (pure reads), NOT the same category as
`create_collection()` (ro-06's one deliberate additive-write exception) —
adding a second read-only method to this class does not touch, weaken, or
extend its own "no delete/drop method exists anywhere" contract in any
way. `cm-13` uses this to read every point in the `intake` collection
(never any other collection), partitioned locally into two sets: entries
carrying `metadata.entry_type != 'distribution_marker'` (candidates to
process) and entries carrying `metadata.entry_type ==
'distribution_marker'` (already-distributed markers, read to compute
which `entry_id`s to skip).

**Resolves the real destination — the CONFIRMED-candidate-consumption
logic §10.2 originally designed for `cm-07`, moved here verbatim, not
reinvented:** for a given intake entry's carried-forward
`resolved_scope_candidate` (§11.2): if the operator has explicitly
confirmed that exact `cluster_id`'s candidate in the same human-review
queue `cm-01`/`cm-05`/`cm-06` already produce (`review_reason:
'scope_route_candidate'`), `cm-13` writes that entry's content to the
CONFIRMED real scope. **For every other entry — no candidate, an
unconfirmed candidate, or a mismatched/stale confirmation naming a
`cluster_id` this entry doesn't belong to — `cm-13` writes to `scope:
'meta'`, unconditionally, no exceptions.** This is the exact same safe
default §10.2 already established, now living in the story that actually
has a destination-write responsibility (`cm-07` no longer does).

**Writes via the SAME `ingestDocument()`/`remember()` primitive,
unchanged:** identical discipline to `cm-07`'s own existing "one
persist primitive, reused, never reimplemented" convention (`[grill
4.1]`) — `cm-13` is the second, not a competing, caller of that same
primitive.

**Marks the original intake entry as distributed — the real, concrete
mechanism, grounded in §11.1's own finding, not invented:** because no
in-place update-by-id primitive exists anywhere in this epic's real
dependency surface (§11.1), "marking" is implemented as calling
`remember()` AGAIN — the same, unchanged, remember()-adjacent primitive,
never a bespoke new write path — with a NEW, small entry written into the
SAME `intake` collection: `metadata.entry_type: 'distribution_marker'`,
`metadata.marks_entry_id: <the original entry's entry_id>`,
`metadata.distributed_to_scope: <'meta' or the confirmed real scope>`,
`metadata.distributed_at: <ISO timestamp>`. **This is deliberately
ADDITIVE, not a mutation — the original intake entry's own point is never
touched, only a new, linked marker point is written alongside it.** This
is not merely the closest available mechanism — it is the RIGHT one,
independently: `ways_of_working.md`'s own hard rule ("never wipe Qdrant
collections... additive/upsert only, everywhere, no exceptions") governs
`intake` exactly as it governs every other collection this epic touches;
an additive marker satisfies "mark and distribute, keep an audit trail"
(the operator's own words) more literally than an in-place mutation ever
could, since the original entry's own content remains byte-for-byte
inspectable after marking, not overwritten.

**Idempotency, named explicitly:** an intake entry whose `entry_id`
already has a matching `distribution_marker` (from a prior `cm-13` run)
is skipped — never re-resolved, never re-written to a destination, never
given a second marker. Re-running `cm-13` any number of times over the
same intake state produces no duplicate destination writes and no
duplicate markers.

**A real sequencing note, mirroring `[grill 3.3]`'s own precedent
(§10.4's "a `cm-08` pilot run will, in practice, always default every
entry to `meta`" finding) — named here too, not left for an operator to
rediscover:** `cm-13` runs as its OWN, separate, later pass — never
inline inside `cm-07`'s own synchronous distillation run, structurally
enforced by `cm-13`'s own `depends_on: [cm-07]` rather than `cm-07`
composing it directly. A confirmed-candidate route can only ever be
exercised in a `cm-13` run that happens AFTER a human has reviewed and
confirmed a candidate `cm-06`/`cm-07` surfaced in an earlier pass — the
same "genuine routing only happens in a second, later run" shape §10.2/
`[grill 3.3]` already established, now correctly homed in the story that
actually performs the routing write.

`depends_on: [cm-07-distillation-and-persist]`.

### 11.4 Piece 3 — `cm-14-intake-decommission` (new): the epic's one deliberate exception to "no delete path exists" — held to the highest safety bar in this epic or this session

**Scope, stated precisely first, so nothing below is read as broader than
it is:** removes an intake entry that has ALREADY been successfully
marked distributed, from the `intake` collection ONLY. Never touches the
real destination copy (`meta` or a confirmed scope's own collection —
`cm-13`'s write there is permanent and unaffected by anything `cm-14`
does). Never touches a source transcript (`~/.claude/projects/*.jsonl`,
the ChatGPT/Gemini export files — unchanged, permanent, read-only input
per §2.6's own structural guarantee). Never touches any entry not marked
distributed.

**(a) Never automatic — explicit, individually-confirmed operator action
only, no batch-wipe-by-default anywhere:** `cm-14`'s own callable surface
accepts exactly ONE `entry_id` per invocation — no `--all`, no
wildcard/pattern match, no "delete every distributed entry" mode exists
anywhere in this story's own design. Every invocation names the specific
entry being removed; the operator is the one naming it.

**(b) `cm-14` verifies the distributed state itself — never trusts a
stale/wrong flag, re-checked immediately before deleting, mirroring
`crawlAndIngest.ts`'s/`cm-01`'s own "re-checked before every operation,
never checked once and trusted" discipline exactly, applied here to a
delete-time guard instead of a fetch-time or persist-time one:**
immediately before issuing any delete call, `cm-14` (1) re-reads the
`intake` collection LIVE (via `cm-13`'s own `scroll_points()` primitive,
§11.3 — reused, not reimplemented) to confirm a `distribution_marker`
entry naming this exact `entry_id` genuinely exists right now, not from
a cached report or an earlier `cm-13` run's own self-report; (2)
independently confirms the real destination actually holds the
corresponding content (a real read against the marker's own
`distributed_to_scope`, matching by `entry_id`/`content_hash` in
metadata — e.g. via `recall()`/`grep` against that scope) before
proceeding. Either check failing — no marker found, or the destination
copy can't be independently confirmed — refuses to delete and reports
the precondition as unmet, loudly, exactly like `cm-01`'s own "match
found, refuse to persist" posture.

**(c) Optional real backup step before removal — the operator's own
words, "optionally back it up or just full wipe," a real, concrete
mechanism, not left abstract:** mirrors this session's own established
Qdrant-backup precedent
(`~/Documents/work/personal/qdrant-backup-2026-08-15/` — NDJSON export
per collection plus docs/config.json, point-counts independently verified
to match live before being trusted as a real backup, `project_state.md`'s
own record of that work) — scaled down to a single entry (or the small,
explicit set the operator named) rather than a whole collection.
Concrete design: before the delete call, write a timestamped NDJSON file
(the entry's full `text` + `metadata`, byte-for-byte what's about to be
removed) to `~/.mnemosyne/intake-decommission-backups/
<timestamp>-<entry_id>.ndjson` — the same already-established local
config-directory family `~/.mnemosyne/org-tree.yaml`/`~/.mnemosyne/
level0-rules.md` already live in (§10.2), not a new, bespoke location.
**Default is backup-ON — an explicit opt-out flag is required to skip
it, never the reverse:** mirrors this epic's own consistent "safe default,
not an opt-out" posture (§10.2's confirms-before-write default, `[grill
3.2]`'s no-implicit-selection default) — "full wipe" (the operator's own
second option) is real and offered, but only ever reachable via an
explicit, named flag, never the default behavior of a bare invocation.

**(d) Named explicitly, in its own dedicated risk section here, as the
epic's one deliberate exception to "no delete path exists" — why this
case is categorically different, and what specifically prevents the
exception from ever being reachable for anything else:**

This epic (§3) and `ro-06` before it (`mnemosyne/onboarding.py`'s own
docstring) both hold "no delete/drop code path exists anywhere in this
module" as a structural guarantee, not a policy note — and `cm-14`
deliberately breaks that pattern once, here, on purpose. The reasoning
this is safe, stated precisely rather than asserted: removing the epic's
OWN already-redundant `intake` copy, after `cm-14` has itself
independently re-verified (not merely trusted) that the same content is
confirmed to exist at its real, permanent destination, is categorically
different from deleting a source transcript (irreplaceable, the
operator's own only copy of raw history) or deleting an only-copy of
persisted memory (the exact failure mode `ways_of_working.md`'s "never
wipe Qdrant" rule exists to prevent). `intake` is, by this round's own
design (§11.2), never the durable home of any entry — it is explicitly a
"separate, temporary landing collection" (the operator's own words) whose
entries are meant to eventually not need to exist there once distributed.
Removing a temporary, already-superseded, independently-re-confirmed copy
is a different KIND of operation from removing the only copy of
something — not a looser reading of the same rule, a genuinely different
case the rule was never written to cover in the first place.

Five concrete, structural guarantees prevent this exception from ever
being reachable for anything else, named directly (not asserted as a
feeling):

1. **A new, freestanding module, never imported by any other story's
   code.** `cm-01` through `cm-13`'s own code never calls into `cm-14`'s
   delete primitive — there is no code path FROM the rest of this epic
   INTO this capability at all, only an explicit, separate,
   operator-invoked entry point.
2. **Hardcoded/pinned to the `intake` collection's own resolved name
   only.** The module never accepts a caller-supplied arbitrary
   collection or scope parameter — it cannot be redirected against
   `meta` or any confirmed real scope's own collection, structurally, not
   merely by convention.
3. **Never merged into `HttpQdrantClient`.** `mnemosyne/inventory/
   qdrant_inventory.py`'s own class stays exactly as ro-06 left it — its
   "no delete/drop method exists anywhere in this module" contract
   remains true for every OTHER caller, forever; `cm-14`'s delete
   primitive lives in its own, separate file specifically so this
   contract is never weakened for anyone else who imports that class.
4. **Single-entry-only, no batch capability, ever** — (a) above,
   structural, not a default that could be overridden by a flag some
   future caller adds.
5. **Never wired into `cm-11`'s orchestrator or `cm-12`'s CLI verb's
   default/automatic flow.** `cm-11`/`cm-12` (§10.3) compose `cm-02`
   through `cm-07` unconditionally — `cm-14` is never composed by
   either, named here explicitly so a future reader of `cm-11`'s own
   `depends_on` list never assumes decommissioning is part of the
   generalized pipeline's own automatic behavior.

**This ticket does NOT get built or run as part of this planning pass, or
as part of `cm-08`'s pilot** — named explicitly, gated behind its own
future, separate operator go-ahead, mirroring §2.8's own "no full-234-
session-corpus story exists by design" precedent, applied here to
decommissioning scale/timing instead of ingestion scale.

`depends_on: [cm-13-intake-distribution]`.

### 11.5 Residual, honestly-named open items (not claimed solved by this amendment)

- **The exact real Qdrant REST delete-call shape** (`POST /collections/
  {name}/points/delete`, filter-by-payload vs. delete-by-id-list) is named
  as the real mechanism class but not pinned to an exact request body here
  — `cm-14`'s own research step confirms the real, current Qdrant API
  shape directly against the live cluster before implementation, mirroring
  every other story's own "confirm against the live system, not assumed"
  discipline in this epic.
- **Whether `swarm-memory index`'s own `index` CLI command performs any
  content-hash-based dedup/upsert internally** (as opposed to the TS
  `remember()` wrapper's own confirmed "always a new file, always a new
  point" behavior, §11.1) is NOT resolved by this pass — that would
  require reading the installed `swarm-memory` Python package's own
  internals, out of scope for a planning-only pass touching only this
  epic's own files. Named as a real, open question `cm-13`'s own research
  step should re-confirm before relying on the additive-marker design as
  the ONLY way "marking" could ever work, though the additive-marker
  design (§11.3) is independently correct on `ways_of_working.md`'s own
  "additive/upsert only" grounds regardless of the answer.
- **Whether `cm-08`'s pilot or `cm-09`'s deep-dive report should be
  extended to exercise `cm-13` (distribution) for real** is a genuinely
  open, future question this amendment does not resolve — `cm-08`'s own
  YAML is unchanged by this pass; extending it is explicitly out of this
  amendment's own three named changes, mirroring §10.4's own restraint
  for the Gemini-in-pilot question.
- **`cm-14`'s own real CLI/operator-invocation surface** (a new
  `mnemosyne harvest --decommission-intake <entry_id>` flag, a fully
  separate verb, or an interactive confirm prompt) is named as a future
  design choice for `cm-14`'s own implementation step, not decided here —
  this amendment fixes the safety PROPERTIES that surface must have
  (§11.4 (a)-(d)), not its exact UX.

Grilled at the same rigor as rounds 1-3, plus a dedicated leak/safety
check — see `docs/grill-record.md` round 4.

## 12. Amendment (2026-08-27) — round 5: an operator-facing UI trigger and review surface (dogfood pass)

Real design change, planning-only (no application code touched —
`.pHive/epics/mnemosyne-conversation-memory/**` only), additive to §§1-11
exactly as rounds 2-4 were: nothing above is rewritten or deleted.

**Operator's own words, verbatim:** "we need a ui button that allows us to
crawl and index the new incoming data and conversations and then a way to
help us see and parse it apart to the areas, so we should build that,
then dogfood it."

Two real, distinct asks, mapped to two real, distinct new stories —
`cm-15` (a trigger surface: crawl for new sources, mark a subset, run the
pipeline) and `cm-16` (a review surface: see queue/intake state, confirm a
scope-route candidate into a real area) — not one story doing both,
mirroring round 4's own "three real, distinct pieces, not one story doing
all three" precedent. §12.1 grounds the design in this pass's own real
code re-verification; §12.2-§12.3 cover each piece; §12.4 names shared
coordination points between the two; §12.5 names what's still genuinely
open.

### 12.1 Real code re-verification this pass (grounding, mirrors §11.1's own discipline — nothing below assumed from memory or from the task brief's own framing alone)

- **The hosting server, confirmed by reading BOTH servers' own real route
  tables directly, not assumed from the task brief's own "port 8578 by
  convention" framing — which is WRONG and corrected here:** `src/
  server.mjs` is the memory god's HTTP surface, and its real, current
  default port is **8477** (`const PORT = Number(process.env.PORT ||
  8477);`, `src/server.mjs:86`; confirmed independently by `SERVICE.md:95`
  — `PORT=8477 bin/mnemosyne`; a full-repo grep for `8578` returns ZERO
  matches anywhere in this codebase). It already serves `GET /ui`/`GET
  /ui/*` (a static file server rooted at `ui/`, `src/server.mjs:105-123`)
  and hosts every existing UI-facing route (`/search`, `/graph/*`,
  `/index`, `/reindex`, `/cache/refresh`). `lib/mnemosyne/server.ts`, by
  contrast, is a SEPARATE service on port **3141** (`MNEMOSYNE_PORT`,
  `lib/mnemosyne/server.ts:167`) — its own module doc comment states
  plainly it "does not share routes or process" with `src/server.mjs`, and
  its real route table (`/health`, `/layers`, `/memory-levels`,
  `/persona*`) serves ZERO UI assets and has no `/ui` handler anywhere.
  `src/server.mjs` (8477) is confirmed the right, and only sensible, host
  for both new pieces below — the task brief's own "8578" framing was a
  stale/incorrect assumption this pass corrects rather than propagates.
- **`cm-02` and `cm-08` are both still `status: pending` — checked for
  real, not assumed from the task brief's own "cm-08 may or may not have
  landed" hedge:** `bin/mnemosyne-conversation-pilot.mjs` does not exist
  on disk (confirmed by `ls`); `~/.mnemosyne/conversation-sources.yaml`
  (cm-02's own manifest) is not yet a real, generated artifact of any
  shipped code. Both new stories below are therefore designed against
  cm-02's/cm-08's own already-written story YAML contracts (real,
  reviewed, unchanged by this pass), not against running code — the same
  "plan the mechanism, apply for real at build time" posture this epic has
  used for every not-yet-built dependency since round 1.
- **The existing panel/jump-chip/status convention, read directly from
  `ui/index.html`/`ui/app.js` as the concrete pattern to match, per the
  task's own instruction — the Personas panel (`ui/index.html:268-268+`)
  is the closest, most-recently-built precedent:** every panel is a
  `<section id="..." class="panel">` (or `panel-wide` for a data-dense
  one), immediately followed by an `<h2>`, one or more `<p class=
  "panel-status">` elements (one per independent fetch, e.g. Personas' own
  `personas-status`/`personas-drafts-status` split), a `<p class=
  "panel-hint">` explaining real behavior/boundaries in plain language, an
  optional `<details>` glossary, a toolbar (`role="radiogroup"` for a
  mode-toggle, a native `<select>` for a status filter — never a novel
  widget where these two idioms already agree), a `<p ... aria-live=
  "polite">` scoped per-panel (Personas' own `personas-live-region`, never
  shared across panels) for announcing action outcomes, and a matching
  `<a href="#panel-id">` jump-chip near the top of the file
  (`#jump-chips`, `ui/index.html:77-85`). Batch/gated actions (Personas'
  own `puf-02-batch-approve-strip`) use a real `<div role="group">` of
  checkboxes plus one real `<button type="button">` — and its own comment
  states the established convention explicitly: "no `disabled` attribute
  anywhere," native keyboard operability instead. Both new panels below
  follow this exact shell, never inventing a new visual idiom.
- **No polling/SSE/streaming precedent exists anywhere in this codebase —
  checked directly (`grep -in "poll|interval|EventSource" ui/app.js`
  returns zero matches), not assumed absent:** the one and only existing
  UI-triggered, live-Qdrant-writing, genuinely-long-running action is the
  Operations panel's targeted reindex (`#reindex-form` → `POST /index`,
  `ui/app.js:1195-1224`) — a plain synchronous `fetch()`, gated by a
  `window.confirm()` naming exactly what will happen ("This shells out to
  swarm-memory against the LIVE Qdrant Cloud store and can take real
  time..."), a single `setStatus(..., "loading", "reindexing… (this can
  take a while against the live store)")` while in flight, and the full
  result rendered from the response body once it resolves. `POST
  /reindex` (the OTHER, bulk/async/202 reindex path) has no UI wiring at
  all — it is reachable only by direct API call, never from a button. This
  is the real, concrete precedent §12.2's own progress-reporting decision
  follows, rather than inventing SSE/WebSocket infrastructure with zero
  prior art in this repo.
- **`src/server.mjs` cannot import a `.ts` module directly today —
  confirmed twice, independently, not assumed:** `bin/mnemosyne`'s own
  dispatcher launches it as plain `exec node "$HERE/src/server.mjs"` (no
  `tsx`), and `bin/graphify-bridge.mjs`'s own module doc comment states
  the identical constraint explicitly for its sibling zero-dep bin,
  `mnemosyne-mcp.mjs`: "a plain `node bin/mnemosyne-mcp.mjs` process
  cannot import a `.ts` module directly — no build step/loader is
  configured for this bin, see `tsconfig.json`'s `noEmit: true`." Three
  OTHER bins (`mnemosyne-persona.mjs`, `mnemosyne-agent.mjs`,
  `mnemosyne-onboard.mjs`) DO import `.ts` modules directly, and are each
  individually `tsx`-launched in `bin/mnemosyne`'s own dispatcher for
  exactly that reason (`exec node "$HERE/node_modules/.bin/tsx" ...`) —
  the real, established pattern for "this specific script needs real TS
  logic" is a new, small, `tsx`-launched entry point, never relaunching
  the whole HTTP service under `tsx`. §12.2/§12.3 below apply this exact
  pattern rather than proposing to change how `src/server.mjs` itself is
  started (named as a real design win in §12.4).
- **`distributeIntakeEntries.ts`'s real, exact `ScopeRouteConfirmationEntry`
  shape, read directly, not invented fresh (per the task's own explicit
  instruction):**
  ```
  export interface ScopeRouteConfirmationEntry {
    recordedAt: string;
    confirmation_reason: 'scope_route_confirmed';
    cluster_id: string;
    scope_key: string;
  }
  ```
  appended as one JSON line via the SAME `fs.appendFileSync` convention
  `triageSession.ts`'s `appendQueueEntry()`/`distillAndRemember.ts`'s
  `appendIntakeQuarantineEntry()` already establish, to the SAME shared
  queue file, `DEFAULT_TRIAGE_QUEUE_PATH`
  (`~/.mnemosyne/conversation-triage-queue.jsonl`). `cm-13`'s own
  `readScopeRouteConfirmations()` only ever READS this shape today — the
  task's own research finding ("no existing write mechanism for it
  anywhere in the codebase") is confirmed correct by this pass's own
  direct read of every file in `lib/mnemosyne/conversation-memory/`.
- **The real secret-redaction-safety contract, re-verified end-to-end
  through JSON serialization to the browser, not merely assumed to
  survive unchanged (per the task's own explicit instruction):**
  `scanForSecrets.ts`'s `SecretMatch` shape (`category`, `pattern`,
  `line`, `index`, `length`, `preview`) is confirmed, by direct read of
  its own module doc comment and pattern-building code, to carry zero raw
  matched characters in ANY field — `preview` is built from static
  strings/counts only, and for the one category that reproduces part of
  the real input (`connection-string`), the credential portion is always
  replaced with the fixed literal `[REDACTED]`. `distillAndRemember.ts`'s
  `IntakeQuarantineQueueEntry` (the real, on-disk quarantine record) wraps
  this in `secretMatches: SecretMatch[]` alongside `recordedAt`,
  `quarantine_reason`, `entry_id`, `entry_type`, `session_id`,
  `chat_source`, `project_slug`, `cluster_id` — every other field is an
  identifier or fixed literal, never free-text content. A plain
  `JSON.stringify()`/`JSON.parse()` round-trip (exactly what `GET
  /conversation-memory/triage-queue`, §12.3, does) changes none of this —
  confirmed by reading the real interface, not merely asserted safe
  because the on-disk write side was already reviewed once for a
  different purpose (cm-01's own persist-time gate).

### 12.2 Piece 1 — `cm-15` (new): discovery + pilot trigger UI

**The central question, resolved explicitly, not hand-waved (the task's
own framing):** does a UI trigger button conflict with `cm-08`'s own
explicit-confirmation-gate design ("no auto-select," AC5 — "invoked
WITHOUT an explicit operator confirmation step... refuses to run")? **No —
by construction, not merely by intent**, verified against `cm-08`'s own
already-written story text: `cm-08`'s own description names TWO valid
selection mechanics explicitly, "a CLI confirm step OR an edited manifest
file." The UI's checkbox-and-submit flow is a real, HTTP-delivered
instance of the FIRST mechanic (a one-shot, explicit, non-persisted
confirmation of a specific subset), never the second — the operator's
marks are never written back into `cm-02`'s own manifest file
(`~/.mnemosyne/conversation-sources.yaml`), which would silently conflict
with `cm-02`'s own AC7 ("idempotent and re-computable from scratch — a
fresh manifest always reflects real, current filesystem state, never a
stale cache silently trusted"): a later re-scan would blow away any marks
persisted there. Instead, the UI's submit action passes the marked subset
as an explicit argument to the SAME confirmation-gated invocation `cm-08`'s
own CLI already requires — reached by a browser click instead of a typed
flag, never bypassing or duplicating the gate itself. Three independent,
real layers enforce this (no single layer is trusted alone, mirroring
this epic's own "structural, not merely conventional" discipline,
`§11.4`'s five-guarantee precedent):

1. **Client-side:** the "Run pilot on selected" button is always
   reachable (no `disabled` attribute, per the established Personas
   convention, §12.1) but clicking with zero checked boxes shows an
   inline `setStatus(..., "fail", "select at least one source before
   running the pilot")` and never fires a request — mirrors `#reindex-
   paths`'s own identical empty-input refusal (`ui/app.js:1180`).
2. **Server-side, the real enforcement point (never trust client-side
   alone):** the new `POST /conversation-memory/pilot/run` route rejects
   (400) any body whose combined `sessionPaths`/`exportKeys` arrays are
   empty — mirrors `POST /reindex`'s own existing `if (!b.scope...) throw
   400` pattern (`src/server.mjs:336-340`) exactly.
3. **CLI-level (cm-08's own, unchanged):** the route never invokes `cm-08`'s
   own orchestrator bare — it always passes the operator-marked subset as
   an explicit argument. `cm-08`'s own no-implicit-selection refusal logic
   (its own AC5) is the SAME code path whether a human types the flag by
   hand or the server passes it programmatically after an HTTP request —
   reached, never bypassed or reimplemented, by either caller.

**A real, additive requirement this places on `cm-08`'s own future
implementation, named explicitly as a coordination point (not a change
this pass makes to `cm-08`'s own already-reviewed YAML):** for
`bin/mnemosyne-conversation-pilot.mjs` to be invocable both interactively
AND from this route, its own implementation step should expose a
machine-readable invocation mode (e.g. `--sessions <path,path,...>
--exports <key,key,...> --json`) alongside whatever interactive/manifest-
edit mechanic it builds — the SAME confirmation-gate logic, a second real
entry point into it, not a fork. `cm-08`'s own story is left byte-for-byte
unchanged by this pass (mirrors round 4's own restraint toward `cm-08`'s
YAML, §11.5's third bullet) — this requirement lives in `cm-15`'s own
story text (below) as the dependency it genuinely is.

**Routes (hosted on `src/server.mjs`, port 8477):**
- `POST /conversation-memory/sources/scan` — runs `cm-02`'s
  `discoverSources({ write: true })` fresh (never a stale cached read —
  mirrors cm-02's own AC7) and returns the manifest
  (`sessions[]`/`excluded[]`/`exports`). This IS the operator's own "crawl"
  button.
- `POST /conversation-memory/pilot/run` — body `{ sessionPaths: string[],
  exportKeys: string[] }` (the operator's exact marked subset, keyed by
  `DiscoveredSession.path` and by the fixed `chatgpt`/`gemini` export
  keys). Refuses (400) an empty combined selection (layer 2 above).
  Invokes `cm-08`'s own orchestrator over exactly that subset (never a
  larger, auto-expanded set — `cm-08`'s own AC1 wording, now also true of
  this route's own contract). `cm-08`'s own small-sample cap (its own
  AC1, "no more than 5... no more than 5") is enforced by `cm-08`'s own
  orchestrator, never re-implemented or re-capped client-side — a
  selection exceeding the cap is a real, loud, per-stage failure surfaced
  in the response, never a silent client-side truncation.

**Progress-reporting mechanism, resolved by direct research (§12.1), not
invented fresh:** a plain synchronous `POST`, gated by the SAME
`window.confirm()` pattern `#reindex-form` already uses (naming that this
shells out against live Gemini + live Qdrant Cloud and can take real
time), a single loading-status message while in flight, and the full
per-stage result array (`cm-08`'s own AC6, "reports real per-stage
results") rendered as a table from the response body once it resolves —
matching the ONE real precedent this codebase has for a comparable
operation, rather than adding polling/SSE machinery with zero prior art
here. Named honestly as a real, accepted residual risk in §12.5: the HTTP
connection stays open for the full run (potentially minutes against a
5+5-session real sample) — bounded by `cm-08`'s own small-sample cap, not
solved structurally.

**Cross-language bridging, resolved by direct research (§12.1), not
invented fresh:** `src/server.mjs` cannot import `cm-02`'s
`discoverSources.ts` (or `cm-08`'s future orchestrator) directly under its
current plain-`node` launch. Rather than relaunching the whole HTTP
service under `tsx` (a broader, riskier surface change than this UI
feature needs), this story follows `bin/mnemosyne-onboard.mjs`'s own
established precedent exactly: a new, small, `tsx`-launched CLI entry
point (`bin/mnemosyne-conversation-discover.mjs`, wrapping
`discoverSources()` with a `--json` output flag; and, once built,
`cm-08`'s own `bin/mnemosyne-conversation-pilot.mjs` with its own
`--json`/`--sessions`/`--exports` mode above), added to `bin/mnemosyne`'s
own dispatcher with the SAME three-line `tsx`-launch pattern already used
for `mnemosyne-persona.mjs`/`mnemosyne-agent.mjs`/`mnemosyne-onboard.mjs`.
`src/server.mjs`'s two new routes `execFile()` these CLIs and shape their
JSON stdout into the HTTP response — the SAME "thin HTTP wrapper shells
out to a CLI" architecture `engine.mjs` already uses for every existing
route in this file (its own header comment: "delegates every memory op to
engine.mjs, which wraps the swarm-memory CLI"), extended to two new CLIs
rather than a new architectural pattern.

`depends_on: [cm-08-bounded-operator-pilot, cm-02-conversation-source-discovery]`.

### 12.3 Piece 2 — `cm-16` (new): triage review + scope-route confirmation UI

**The operator's own words, mapped directly:** "a way to help us see and
parse it apart to the areas" = a panel showing the real, current review
queue AND intake state, plus the one real write action `cm-13`'s own
already-shipped read side already expects to exist — confirming a
scope-route candidate into its real destination area (`meta`, or a
confirmed client scope).

**Two real, distinct data sources, named explicitly rather than
conflated (a real finding of this pass's own research, §12.1's leak-check
groundwork):** scope-route CANDIDATES (`cm-06`'s own
`ResolvedScopeCandidate`, `cluster_id` + `scope_key`) are NOT written to
the on-disk triage queue file anywhere in this epic's real, shipped
code — `clusterConversations.ts`'s own module doc comment states this
plainly ("this module returns the candidate as in-memory cluster metadata
only"). They ride forward embedded in each intake entry's own persisted
provenance header (`cm-07`'s `EntryProvenanceMetadata.resolved_scope_
candidate`, `distributeIntakeEntries.ts`'s `parseProvenanceHeader()`
already reads it back out). So this panel reads from BOTH real sources,
never assuming one covers the other:
- **The triage queue JSONL** (`DEFAULT_TRIAGE_QUEUE_PATH`) — quarantine
  hits (`quarantine_reason: 'secret_detected'`) and existing scope-route
  confirmation records (`confirmation_reason: 'scope_route_confirmed'`),
  classified by their own real discriminator field (neither `TriageQueueEntry`
  nor these two other kinds share a common tag today — a real, honestly-
  named implementation nuance for `cm-16`'s own research step, not
  papered over here).
- **The `intake` Qdrant collection itself** (`INTAKE_COLLECTION_NAME =
  'conversation_memory_intake'`, `cm-13`'s own scroll-based enumeration)
  — every candidate's `entry_id`/`cluster_id`/`resolved_scope_candidate`,
  and every existing `distribution_marker` (so an already-distributed
  entry shows as distributed, per the task's own explicit ask), computed
  the SAME way `cm-13`'s own `partitionPoints()` already does.

**Routes (hosted on `src/server.mjs`, port 8477, same as `cm-15`):**
- `GET /conversation-memory/triage-queue` — reads and classifies every
  line of the shared JSONL queue file; a missing file returns empty
  arrays with `200`, never `404`/`500` (mirrors `readScopeRouteConfirmations()`'s
  own established "missing file is not an error" contract).
- `GET /conversation-memory/intake-candidates` — scrolls the real intake
  collection (below) and returns each candidate tagged with a computed
  status: `no_candidate` / `candidate_unconfirmed` /
  `candidate_confirmed_pending_distribution` (a real, on-disk confirmation
  exists but no `distribution_marker` yet — `cm-13` hasn't run since) /
  `distributed` (a real `distribution_marker` references this `entry_id`,
  `distributed_to_scope` shown). The confirm action (below) is only ever
  offered for `candidate_unconfirmed` rows.
- `POST /conversation-memory/scope-route/confirm` — body `{ cluster_id,
  scope_key }`. **The ONLY filesystem write this story's entire route
  surface performs, anywhere:** one `fs.appendFileSync()` call writing
  exactly one `ScopeRouteConfirmationEntry` line (§12.1's exact shape,
  `recordedAt` generated server-side) to `DEFAULT_TRIAGE_QUEUE_PATH` —
  the SAME queue file, the SAME append convention, never a
  read-modify-rewrite, matching `cm-01`/`cm-05`/`cm-07`/`cm-13`'s own
  identical discipline exactly, per the task's own explicit instruction.
  **Defense in depth, layered on top of `cm-13`'s own independent
  re-validation at distribution time (never a replacement for it):**
  before appending, the route re-reads the real intake candidates (the
  SAME read path `GET /conversation-memory/intake-candidates` uses) and
  refuses (400) unless `cluster_id` genuinely names a currently-known
  `candidate_unconfirmed` row AND `scope_key` matches THAT candidate's own
  exact `scope_key` — mirroring `resolveDestinationScope()`'s own "a
  confirmation naming the right cluster but the WRONG scope key is also
  never trusted" discipline, applied one step earlier, at write time, not
  only at `cm-13`'s own read time. A duplicate confirm of an
  already-confirmed `(cluster_id, scope_key)` pair is allowed, not
  refused — harmless by construction (`readScopeRouteConfirmations()`
  reads into a `Set`, naturally deduplicating), mirroring
  `distributeIntakeEntries.ts`'s own explicitly-accepted "tolerates a
  duplicate write (it is never destructive)" posture verbatim.

**Never a delete or edit of an existing line — verified structurally, not
merely by convention (per the task's own explicit instruction):** two of
this story's three routes are pure reads (no `fs` write call anywhere in
either handler); the third performs exactly one `appendFileSync()` call
and nothing else. No route in this story's own surface ever opens the
queue file for writing in any mode other than append, and no route ever
issues a Qdrant delete/update call of any kind (`GET /conversation-memory/
intake-candidates`'s own Qdrant access is the SAME read-only `scroll_points()`
primitive `cm-13` already uses, never a write-capable one).

**Quarantine entries — visibility only, no action, named explicitly
rather than silently decided (per the task's own explicit instruction):**
this panel renders quarantine hits (`IntakeQuarantineQueueEntry`, real
fields confirmed redaction-safe end-to-end in §12.1) for the operator to
SEE, and offers no action of any kind against them — no confirm, no
dismiss, no delete, no re-triage trigger. `cm-01`'s own quarantine-
retention-policy question remains listed as open question #4 in this
document (§5) — this pass does not silently resolve it as a side effect
of making quarantine entries visible in a UI; a future story, not this
one, would need to design any actual disposition action.

**`cm-05`'s own keep/trash/uncertain triage verdicts are explicitly OUT of
this panel's scope**, named here so the boundary isn't discovered by
surprise: the task's own brief names exactly three real surfaces for this
panel (quarantine, scope-route candidates, confirmation/distribution
markers) — triage verdicts are a real, different record kind in the SAME
queue file, but reviewing/acting on THEM is a genuinely separate future
scope this pass does not expand into.

**Cross-language bridging, resolved by direct research (§12.1), not
invented fresh — the harder-to-get-right half is reused, not
duplicated:** the choice is between reusing the ALREADY-REAL, ALREADY-
LIVE-CONFIRMED Qdrant scroll HTTP client (`HttpQdrantClient.scroll_points()`,
Python, `cm-13`'s own shipped code) and re-implementing only the small,
stable, well-documented provenance-header comment-marker JSON extraction
(`<!-- mnemosyne-intake-provenance ... -->`) a second time in Python —
versus writing a brand-new, untested, production Qdrant-scroll HTTP
client directly in this Node service (`cm-13`'s own module doc comment
names this as explicitly out of ITS OWN scope, required-but-uninstantiated
by design). This story reuses the harder, riskier-to-get-wrong piece: a
new, small, read-only CLI verb on `mnemosyne/inventory/qdrant_inventory.py`
(additive to its own existing `argparse` surface, alongside — never
replacing — its existing inventory verbs) calls `scroll_points('conversation_
memory_intake')` directly, re-implements the small comment-marker
extraction locally (~10 lines, low risk, mirrors `bin/graphify-bridge.mjs`'s
own already-accepted "small, deliberately separate implementation of the
same shape" precedent for a genuinely low-risk piece), and prints
structured JSON to stdout. `src/server.mjs`'s new route `execFile()`s this
verb — the SAME "thin HTTP wrapper shells out to a CLI" pattern `cm-15`
uses and `engine.mjs` already establishes throughout this file, never a
third architectural pattern. `HttpQdrantClient`'s own "no delete/drop
method exists anywhere in this module" contract (§11.1/§11.4) is
untouched — this is a second READ-only method, the same risk category as
`scroll_points()` itself and `list_collections()`/`collection_info()`
before it, never the same category as `create_collection()`'s one write
exception.

`depends_on: [cm-06-cross-session-clustering, cm-13-intake-distribution]`.

### 12.4 Shared coordination points between `cm-15` and `cm-16`

- **Neither new story requires changing how `src/server.mjs` itself is
  launched** — a real, named design win: both route sets shell out to
  small, targeted, `tsx`-launched or Python CLI helpers via the SAME
  `execFile()` pattern `engine.mjs` already established for every
  existing route, rather than relaunching the whole HTTP service under
  `tsx` (§12.1's own "cannot import `.ts` directly" finding is resolved
  the same way in both stories, independently, never by touching
  `src/server.mjs`'s own launch mechanism).
- **`distributeIntakeEntries.ts`'s currently-private `isScopeRouteConfirmationEntry()`
  should be exported** (a small, additive, no-behavior-change export) so
  `cm-16`'s own write-side pre-validation (§12.3) reuses the SAME shape
  check `cm-13`'s own read side already trusts, rather than risking two
  independently-maintained copies drifting apart — the exact shape of
  gap `[grill 4.4]` (round 4) already named this epic's own convention
  against, applied here to a new story pair instead of `cm-13`/`cm-14`.
  Named as a real `files_to_modify` entry on `cm-16` below (§12.3's own
  concrete requirement), not applied by this planning-only pass.
- **Landing order is genuinely independent, named explicitly so a future
  scheduler doesn't invent a false dependency between them:** `cm-15`
  depends on `cm-08`/`cm-02`; `cm-16` depends on `cm-06`/`cm-13`; neither
  depends on the other, and both can land in either order or in parallel.
- **Both panels share the same `ui/index.html`/`ui/app.js` files** (a
  real, structural fact of this repo's single-file-per-concern UI, not a
  coordination risk unique to this pass) — implemented as two separate,
  independently addable `<section>`/jump-chip pairs, following the exact
  same pattern every prior panel addition to this file has already used
  (Search, Graph, Operations, Personas, Memory Levels each landed this
  way, independently, over this codebase's own real history).

### 12.5 Residual, honestly-named open items (not claimed solved by this amendment)

- **The pilot-run HTTP connection stays open for the full run's real
  wall-clock duration** (§12.2) — bounded by `cm-08`'s own small-sample
  cap, not solved structurally; a future iteration could revisit
  polling/SSE if sample sizes ever grow beyond what a synchronous request
  comfortably tolerates, but no such need exists at this epic's own
  pilot scale, and inventing that infrastructure now would be building
  ahead of a real need this codebase has never yet had.
- **The exact real Qdrant scroll-endpoint request/response shape for the
  new Python CLI verb** (`cm-16`, §12.3) is named as reusing `cm-13`'s
  own already-live-confirmed `scroll_points()` method directly — genuinely
  lower-risk than `cm-14`'s still-open delete-shape question (§11.5), but
  the new CLI verb's own JSON stdout contract (field names, error
  reporting on a scroll failure) is not pinned to an exact shape here,
  left to `cm-16`'s own research step.
- **Whether `cm-15`'s discovery-scan route should also expose the
  weak-scratch-confidence flag (`cm-02`'s own AC3) to the operator as a
  visibly distinct marking state** (e.g. a dimmed/warned checkbox row) is
  a real UX-polish question this pass names but does not resolve — the
  route's own contract (§12.2) passes the manifest's real fields through
  unchanged either way, so this is purely a rendering decision deferred
  to `cm-15`'s own implementation step.
- **`cm-08`'s own `--json`/`--sessions`/`--exports` machine-readable
  invocation mode** (§12.2's own real, additive requirement on `cm-08`'s
  future implementation) is named as a coordination point, not applied to
  `cm-08`'s own YAML by this pass — mirroring round 4's own restraint
  toward `cm-08` (§11.5's third bullet) exactly.

Grilled at the same rigor as rounds 1-4, plus the task's own three named
leak/safety questions — see `docs/grill-record.md` round 5.
