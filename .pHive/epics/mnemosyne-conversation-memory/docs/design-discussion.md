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
