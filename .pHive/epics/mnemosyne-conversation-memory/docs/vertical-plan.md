# Vertical Plan — mnemosyne-conversation-memory

Minimum cross-stack increments; each slice leaves the product in a real,
working, independently-verifiable state. Slices execute sequentially;
stories WITHIN a slice may run in parallel where marked.

## Slice 1 — Safety + Discovery substrate

**Stories:** `cm-01` (secret scanner), `cm-02` (discovery/enumeration).
**Parallel-eligible:** yes, `cm-01` ‖ `cm-02` — genuinely independent (L-A
touches no filesystem beyond its own unit tests; L-B touches no
conversation content). Both `bounded-slice` (disjoint file sets).
**Working state after this slice:** an operator can run discovery and get
a real, reviewable manifest of 234+ real sessions + the confirmed
ChatGPT export (byte sizes, scratch-confidence flags, project slugs) —
useful on its own even before any parsing exists. `scanForSecrets()` is
independently testable and callable — a real, shippable safety primitive
other Mnemosyne work could adopt even outside this epic.
**No content has been read, parsed, or persisted yet.**

## Slice 2 — Source-specific parsing/normalization

**Stories:** `cm-03` (Claude Code JSONL parser), `cm-04` (ChatGPT export
parser). **Depends on:** Slice 1 (`cm-01`, `cm-02`).
**Parallel-eligible:** yes, `cm-03` ‖ `cm-04` — `variation` siblings, same
normalized `ConversationTurn[]` output contract, different input parsers,
disjoint files.
**Working state after this slice:** a real session (Claude Code or
ChatGPT) can be parsed into normalized turns with the secret scanner
already run over the extracted text — inspectable output (a
`ConversationTurn[]` structure an operator/developer can print and read),
still zero content persisted to Qdrant.

## Slice 3 — Triage

**Story:** `cm-05`. **Depends on:** Slice 2.
**Working state after this slice:** any parsed session produces a real
`keep`/`trash`/`uncertain` verdict + summary + rationale, written to a
real, operator-reviewable queue file. This is independently useful and
demoable — the operator can see real triage output on real sessions
before clustering or persistence exist at all.

## Slice 4 — Clustering

**Story:** `cm-06`. **Depends on:** Slice 3.
**Working state after this slice:** `keep`/`uncertain` sessions across
DIFFERENT real project slugs get real cluster assignments, inspectable
as a grouped report — the operator can see "these 6 sessions across
mnemosyne/consus/heimdall are really the same underlying thread" as real
output, still with zero content persisted to Qdrant yet.

## Slice 5 — Distillation + persist

**Story:** `cm-07`. **Depends on:** Slice 4.
**Working state after this slice:** the full non-pilot pipeline is code-
complete and independently testable against fixture data (never live
personal content in the automated test suite, mirroring `ro-11`'s "real,
local, throwaway test server, never a live external site" discipline,
adapted here to "real fixture transcripts with synthetic content, never
the operator's actual history, in the automated suite"). `remember()` is
called for the first time in this epic's code path, but still not
exercised against real content until Slice 6.

## Slice 6 — Pilot (first real content, small and bounded)

**Story:** `cm-08`. **Depends on:** Slice 5.
**Working state after this slice:** a small, operator-selected, real
sample has gone through the FULL pipeline end-to-end, with real content
actually landing in the `meta`-scope collection for the first time in
this epic. This is the first and ONLY point in this epic's story
decomposition where real personal conversation content is persisted —
by design, gated behind five full slices of already-working,
already-tested infrastructure.

## Slice 7 — Deep-dive validation (the operator's own named requirement)

**Story:** `cm-09`. **Depends on:** Slice 6.
**Working state after this slice:** a real, human-inspectable report
exists over `cm-08`'s real pilot output — the artifact the operator
reviews before ANY decision about full-corpus ingestion is made. This is
the epic's final deliverable; no story past this point exists in this
decomposition (full-corpus ingestion is deliberately not planned here —
design-discussion §2.8, §5 open question #2).

## Deferred items (explicitly, not silently dropped)

- **Full-234-session corpus ingestion** — deliberately not a story in
  this epic. Gated on `cm-09`'s real results and a future, separate
  operator go-ahead (design-discussion §5 #2).
- **Gemini parser** — deferred until a real Gemini export exists
  (design-discussion §5 #5); the `ConversationTurn[]` contract from
  Slice 2 is designed so adding it later is additive.
- **`meta`-scope collection-routing hardening for third-party embedded
  products** (the cross-product isolation tension, design-discussion
  §2 `[grill 3.1]`) — this epic's own collection is scoped safely, but
  the deeper cross-product guarantee is explicitly out of scope here.
