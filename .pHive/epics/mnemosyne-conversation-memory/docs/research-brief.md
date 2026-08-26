# Research Brief — mnemosyne-conversation-memory

Planned 2026-08-25, branch `feat/mnemosyne-conversation-memory` off `origin/dev`
(tip `b1a2a81`, v0.15.0, `mnemosyne-repo-onboarding` epic shipped). Full,
real reconnaissance — every claim below is either a direct file read, a
direct shell command output, or a direct code citation. No format was
assumed before being confirmed.

## 0. Operator's own words (verbatim, the ground truth for this epic)

> "at some point we need a way to filter through ALL of the things
> discussed, get it into memories, and figure out usefulness and trash and
> stuff... ideally then we are able to correctly cluster items and index
> and deal with it to break out and clean up the conversations and context
> as well -- i have chatted across 30 plus sessions and different things
> and different overall mixes of which ones are helping with what... so,
> ideally we can solidify and fix that into mnemosyne memory at some point
> as well -- and that will need a DEEP DIVE test"

Six distinct asks embedded in this quote, each mapped to a required-coverage
area in the design discussion: (1) filter through everything discussed →
discovery, (2) get it into memories → transcript-aware ingestion, (3)
usefulness vs. trash → triage, (4) correctly cluster → clustering/indexing,
(5) break out and clean up → distillation, (6) "DEEP DIVE test" → a named,
distinct validation story.

## 1. Real data source reconnaissance

### 1.1 Claude Code local session transcripts

`~/.claude/projects/<project-slug>/<session-id>.jsonl`.

- **1404** total directories under `~/.claude/projects/` (`ls | wc -l`).
- **234** look like real project work after excluding scratch/test/temp
  dirs, using the pattern already established this session:
  `grep -vE '^-private-tmp|^-private-var-folders|scratchpad'`
  (`ls ~/.claude/projects/ | grep -vE '...' | wc -l` → `234`).
- Total size of `~/.claude/projects/` (all 1404 dirs, unfiltered): **4.0G**
  (`du -sh`).
- This repo's own project dir alone: **241M**
  (`~/.claude/projects/-Users-mdostal-Documents-work-pantheon-mnemosyne/`),
  containing **260** separate `.jsonl` session files
  (`find ... -name "*.jsonl" | wc -l`).
- THIS session's own transcript file:
  `c93f4c3b-2822-47c0-a072-c4629021d01d.jsonl`, **53,166,373 bytes**
  (~50.7MB) — confirms the operator's "52MB" estimate almost exactly
  (`ls -laS`).
- A second real project (`~/.claude/projects/-Users-mdostal-Code-delphi/`)
  sampled to confirm the schema isn't an artifact of one unusually large
  session: its own session file is **6.0M** — real sessions vary by
  orders of magnitude (6MB to 50MB+ observed directly), which is itself a
  scale-planning input (see design-discussion §6).

**Real JSONL schema, confirmed by reading actual lines (not assumed):**

- Line 1-3 of a session: harness bookkeeping records —
  `{"type":"mode",...}`, `{"type":"permission-mode",...}`,
  `{"type":"file-history-snapshot",...}`.
- Every conversational line has a stable envelope: `parentUuid` (linked-list
  threading, `null` for the first turn), `isSidechain`, `type`
  (`"user"` | `"assistant"`), `uuid`, `timestamp`, `sessionId`, `cwd`,
  `gitBranch`, `version`, `userType`, `entrypoint`.
- `message.role` + `message.content`. `content` is either a plain string
  (simple user turns) or an array of typed blocks: observed block types
  `text`, `thinking` (carries an opaque, large base64 `signature` field —
  real, load-bearing noise for any token/storage budget, confirmed
  directly in a real assistant turn), `tool_use` (`id`, `name`, `input` —
  e.g. a real `Bash` call with a multi-command shell string), and (by
  symmetry, not yet directly greped but implied by the harness's own tool
  loop) `tool_result`.
- Assistant turns additionally carry `usage` (token counts, cache
  read/creation, `service_tier`), `model`, `attributionSkill`/
  `attributionPlugin` (which slash-command/skill produced this turn — a
  real, already-present signal for triage/clustering, see design-
  discussion §4), and `effort`.
- **This structure is turn-by-turn, role-tagged, with heavy tool-call and
  thinking-signature noise** — structurally distinct from
  `ingestDocument.ts`'s plain-text/Markdown/PDF assumption (see §2 below).

### 1.2 ChatGPT export (real, confirmed on this machine)

`~/Downloads/ChatGPT Data Export Feb 5 2026.zip` (101,623,722 bytes) with a
matching extracted folder alongside it (confirmed via `ls -la`). Also
present, not yet opened: `~/Downloads/OpenAI Export.zip` (351,195,030
bytes) — likely a larger/different-dated OpenAI export; noted as a second
possible ChatGPT-family source, not investigated further this pass (see
Open Questions).

Extracted folder contents (`ls -la`): `conversations.json` (**47,884,497
bytes**, the real conversational corpus), `chat.html` (a static, human-
readable export — not a structured source), `user.json`, plus ~70 exported
image attachments (`file-*-sanitized.*`) and near-empty stub files
(`group_chats.json`, `message_feedback.json`, `shopping.json`, `sora.json`
— each 2-13 bytes, confirmed empty/near-empty, not real conversational
data).

**Real `conversations.json` shape (confirmed via `python3 -c "json.load(...)"`,
not assumed):**

- Top-level: a JSON array, **258** conversation objects
  (`len(data)` → `258`).
- Each conversation object's keys (`list(data[0].keys())`): `title`,
  `create_time`, `update_time`, `mapping` (the real message content — a
  **tree, not a flat list**: a dict keyed by node id, each node carrying
  `id`, `message` (nullable — root/system scaffold nodes have `message:
  null`), `parent`, `children[]`), plus `moderation_results`,
  `current_node`, `plugin_ids`, `conversation_id`,
  `conversation_template_id`, `gizmo_id`/`gizmo_type` (custom-GPT
  metadata), `is_archived`, `is_starred`, `safe_urls`/`blocked_urls`,
  `default_model_slug`, `conversation_origin`, `voice`, `is_study_mode`,
  `owner`, `id`.
- Each `mapping` node's `message.author.role` (`system` | `user` |
  `assistant`, confirmed directly), `message.content.content_type` +
  `content.parts[]` (the actual text), `message.status`,
  `message.metadata` (carries `is_visually_hidden_from_conversation` for
  synthetic scaffold nodes that must be filtered, not treated as real
  turns).
- **This is a structurally different shape from Claude Code's linear
  JSONL** — a DAG walk from `current_node` back through `parent` pointers
  (or forward from the root) is required to linearize a conversation, and
  synthetic/hidden system nodes must be filtered before any turn is
  treated as real content.

### 1.3 Gemini export — searched for, NOT found (documented, not assumed)

m-09's original framing named "Gemini chat export" as a primary target.
Real search performed this pass, not inherited from m-09 unverified:

- `find ~/Downloads -iname "*gemini*"` → only two PNG files
  (`Gemini Generated Image.png`, `Gemini Generated Image (1).png`) —
  AI-generated images, not chat exports.
- `find ~/Downloads -iname "*takeout*"` → no results.
- `find ~/Desktop ~/Documents -maxdepth 3 -iname "*gemini*" -o -iname
  "*takeout*"` → one hit, `~/Documents/work/compound-content/takeout`,
  inspected directly (`ls`) and confirmed to contain only
  `index-schema.md` + `README.md` — an unrelated content-indexing doc, not
  a Google Takeout Gemini archive.
- `~/Downloads/Drive Data Export/` (a real Google Takeout Drive export,
  4.4MB) inspected directly — contains only scanned PDF documents
  (`Epson_*.pdf`), no Gemini conversation data.

**Conclusion, stated plainly for the design discussion to act on:** no real
Gemini chat export exists anywhere discoverable on this machine today.
m-09's "Gemini" framing is stale/unconfirmed — this epic's real, confirmed
sources are (1) Claude Code's own local session JSONL transcripts and (2)
the ChatGPT export. A Gemini parser is designed as a documented future
extension point (same normalized shape, see design-discussion §2), never
built against invented sample data.

## 2. Shipped ingestion primitives this plan must compose (read in full)

### 2.1 `lib/mnemosyne/ingest/ingestDocument.ts` (ro-10, 546 lines, amended by ro-13)

The single existing "chunk → `remember()`" primitive. Confirmed directly
from the file:

- Named, code-enforced caps: `MAX_INGEST_BYTES = 200_000` (post-extraction
  text), `CHUNK_SIZE_BYTES = 4_000` (per-chunk, UTF-8-boundary-safe
  splitting via `chunkContent()`), `MAX_PDF_SOURCE_BYTES = 20_000_000`
  (raw PDF bytes, checked before any parse attempt).
- `SUPPORTED_EXTENSIONS = {'.txt', '.md', '.pdf'}` — plain text, Markdown,
  PDF only. **No transcript/JSON format is supported today** — confirmed
  by reading the full `SUPPORTED_EXTENSIONS` set and the branch logic in
  `ingestDocument()` (only a `.pdf`-vs-everything-else branch exists).
  This is a real, structural gap this epic must close, not an oversight to
  quietly work around.
- Sequential, never-parallel `remember()` calls (`rememberSequentially()`,
  one `await`ed `client.remember()` per chunk) — a deliberate,
  documented convention with no precedent anywhere in this codebase for
  concurrent `remember()` calls.
- Partial-failure reporting: a mid-sequence chunk failure does not abort
  the remaining chunks; the result reports exactly which chunks
  succeeded/failed (`finalizeChunkOutcomes()`), never a generic
  all-or-nothing error.
- Every chunk's `Content.metadata` carries `filename`, `chunk_index`,
  `chunk_count`, optional `tag`, and (PDF path only) `page`/`page_count` —
  the provenance-completeness discipline this epic's transcript path must
  extend with turn/role/speaker/session-id metadata, not abandon.
- `IngestClient` is a minimal structural interface (`remember()` only),
  deliberately not importing the concrete `MnemosyneClient` class — tests
  pass a fake, never a live Qdrant call. This epic's own ingestion module
  should mirror this testability discipline.

### 2.2 `lib/mnemosyne/ingest/crawlAndIngest.ts` (ro-11, 629 lines)

The safety-bound discipline this epic's own new risk surface (real
personal chat content, at real scale) should mirror, confirmed directly
from the file's own extensive doc comments and code:

- **Named caps enforced in code, never merely documented** — every bound
  (SSRF blocked-range list, `MAX_CRAWL_PAGES`, per-request timeout,
  rate-limit delay, `MAX_INGEST_BYTES` reuse) is a real constant checked
  by real code, independently re-verifiable by a reviewer reading the
  diff.
- **Loud, distinguishable failure per bound** — never a generic catch-all;
  every rejection names the specific matched condition (e.g. "target
  resolves to 169.254.169.254, inside the link-local/cloud-metadata range
  169.254.0.0/16").
- **A new, explicitly named cross-cutting concern** (`external-fetch-
  safety`) added to the story YAML because the generic
  `.pHive/cross-cutting-concerns.yaml` list had no entry for outbound
  network risk. This epic's own new risk category — real personal
  conversation content at scale — needs the same treatment: a new named
  concern (`conversation-privacy-safety`, see design-discussion §5),
  never silently folded into the generic list.
- **No bypass flag, anywhere, for any target, under any circumstance** —
  the SSRF guard's "firm, default-on, no escape hatch" posture is the
  direct precedent for this epic's own secret-scan-before-persist gate
  (design-discussion §5): reject/quarantine, never a flag that skips the
  scan.
- **Independent reviewer re-verification** as its own review step (not
  trusting the implementer's description) — re-used by this epic's most
  safety-critical stories.
- **A residual-risk section that names what is NOT solved** (R13, the
  DNS-rebinding TOCTOU gap) rather than silently claiming full closure —
  this epic's own design discussion follows the same discipline for its
  own residual risks (e.g. LLM-based classification's inherent
  imperfection, see design-discussion §5).

### 2.3 `lib/mnemosyne/memory-levels/levels.ts` (ro-01) — the 5-level taxonomy

Confirmed directly: `MEMORY_LEVELS` is a static, pure-data array of 5
canonical levels (0-4), each a distinct **memory-STORE-TYPE**, explicitly
NOT an orchestration-tier or retrieval-cascade axis (the module's own doc
comment disambiguates all three "layer" meanings used elsewhere in this
codebase). Level 3 = vector store (`'vector'`/`'keyword'` adapters, run in
parallel when both configured). Levels 0/1 never participate in
`recall()`. **Real finding for this epic's own design decision (§2 below):
conversation memory is not a new memory-STORE-TYPE — it is vector-embedded
chunks with provenance, i.e. it belongs inside the EXISTING Level 3, not a
new Level 5.** Confirmed by re-reading the module's own framing ("Each
MEMORY STORE TYPE is a level") before concluding this, not assumed.

### 2.4 `lib/mnemosyne/onboarding/` (ro-02, ro-04) — org-tree + scope model

`orgTree.ts` confirms `~/.mnemosyne/org-tree.yaml` maps `repo_path` →
`collection` → `scope` (`project`/`enterprise`). `interfaces.ts` confirms
`Scope = 'project' | 'enterprise' | 'meta'` — a third scope value, `meta`,
already exists in the type system (`schema.ts`'s enum, `server.ts`'s
`SCOPES` set, multiple test files) but is thinly implemented — no org-tree
node, no dedicated collection-routing logic beyond the type/schema level
(confirmed via repo-wide grep for `'meta'` usage; it appears in type
definitions, schema enums, and tests, never in a concrete routing
decision). **Real finding: `meta` is the closest existing fit for
cross-project, cross-repo conversation memory** (it isn't any one repo's
`project` scope, and `enterprise` in this codebase's own convention means
"this Qdrant collection wasn't confidently placeable to one repo" per
`placement_engine.py`'s heuristic — a different concept). This epic is the
first real consumer to give `meta` scope concrete meaning, a design
decision surfaced explicitly (design-discussion §2), not silently assumed.

### 2.5 `MnemosyneClient.recall()`/`remember()` (`client.ts`)

Confirmed (via `interfaces.ts`'s `MnemosyneClient` interface and
`ingestDocument.ts`'s own doc comment citing `client.ts:447-531`):
`remember()` cascades a single write through every WRITABLE configured
layer in stack order. This epic's ingestion path (§2 above) must feed this
SAME cascade, never a parallel storage mechanism — mirrors `ro-10`'s own
explicit framing ("This module does not reimplement that cascade; it
feeds it, one bounded chunk at a time").

## 3. `m-09-external-chat-ingestion` (mnemosyne-foundation) — full read

Full story read (`.pHive/epics/mnemosyne-foundation/stories/
m-09-external-chat-ingestion.yaml`). Status `pending`, its own `note`
field already confirms zero code exists for it ("No chat-parsers, dedup,
or external-chat ingestion code found anywhere in the repo"). Scope: parse
Gemini + Claude Workbench exports, chunk-embed-store, dedup by SHA256
content hash, source metadata (`chat_source`, `export_date`,
`participants`, `original_url`). Depends on `m-03-vector-layer-
integration` (already shipped, since `remember()`/vector layer exist
today).

**What m-09 did NOT cover** (confirmed by reading its full acceptance
criteria, steps, and design_decisions — no mention anywhere): usefulness
vs. trash triage, cross-session clustering, a conversation
cleanup/breakout mechanism, or any human-review gate before persisting
personal conversation content. Its `references:` section points at
`~/Documents/work/dostal/code/swarm-memory` — a sibling codebase, not this
one — for "existing embedding + Qdrant write patterns," which this epic's
own composition of the ALREADY-SHIPPED `ingestDocument()`/`remember()`
cascade (§2.1/§2.5) makes moot; that external reference is now stale.

**Relationship decision (see design-discussion §7 for the full reasoning,
not silently resolved here):** m-09's exact deliverable — chat parsers +
dedup + an ingestion pipeline — is fully re-scoped and superseded by this
epic's `cm-03`/`cm-04` stories, which are broader (cover the two REAL
confirmed sources, Claude Code sessions + ChatGPT export, not the
unconfirmed Gemini/Claude-Workbench pairing) and more accurate (built
against real, read file structures, not assumed export formats). m-09's
own good design decisions — dedup by content hash before embedding,
source-metadata completeness (`chat_source`, timestamps, participants) —
are explicitly CARRIED FORWARD into `cm-03`/`cm-04`'s design, not
reinvented or silently dropped.

## 4. Cross-cutting concerns (`.pHive/cross-cutting-concerns.yaml`)

Five concerns registered: `documentation`, `versioning`, `loud-failure`,
`provenance-completeness`, `existing-infrastructure`. Confirmed: **no
existing concern covers ingesting a third party's/the operator's own
personal, potentially secret-bearing conversation content at scale** — the
same gap `ro-11` found for outbound network fetches (closed there with a
new, named `external-fetch-safety` concern). This epic adds an equivalent
new, named concern: `conversation-privacy-safety` (design-discussion §5).

## 5. Precedent for documenting an epic-to-epic relationship

`mnemosyne-repo-onboarding`'s own `epic.yaml`/`design-discussion.md` §2.4
and Open Questions establish the convention this epic follows: state the
relationship explicitly (never silently duplicate), name the specific
overlapping stories, and leave the final "re-scope or not" call to the
operator as an open question when it crosses epic boundaries. Applied here
in design-discussion §7 for the `m-09` relationship.

## 6. Validation note

No external library/SDK/API is newly introduced by this research (no
context7 lookup triggered) — every primitive cited above (`ingestDocument`,
`crawlAndIngest`, `MnemosyneClient`, the memory-levels taxonomy, org-tree)
is first-party code in this repository, read directly. The only
third-party libraries touched by this epic's future implementation
(`unpdf`, already a dependency per `ingestDocument.ts`'s own import; a
future embedding/clustering approach, TBD in design-discussion §4) are
flagged as an open question for the implementation stories to validate
against context7/web research at build time, not assumed here.
