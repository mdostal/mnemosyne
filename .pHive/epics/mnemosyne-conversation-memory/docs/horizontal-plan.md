# Horizontal Plan — mnemosyne-conversation-memory

Maps every architectural layer this epic touches and the real
cross-layer dependencies between them, before slicing vertically.

## Layers

### L-A. Safety substrate (new)

`scanForSecrets()` (`cm-01`) — a pure, dependency-free detection module.
No I/O, no network, no persistence. Consumed by L-C (parse-time scan) and
L-F (persist-time scan). This is the one module every other new layer in
this epic depends on transitively, mirroring `ro-11`'s SSRF guard being
the one function every fetch call site in that module routes through.

### L-B. Discovery (new)

`discoverConversationSources()` (`cm-02`) — read-only filesystem walk of
`~/.claude/projects/*` + a named list of confirmed export files. Produces
an inventory manifest (JSON/YAML, on disk, operator-reviewable). Zero
dependency on L-A (nothing here reads conversation CONTENT, only
filenames/sizes/mtimes) — genuinely independent of L-A, hence eligible to
run in parallel with it (see vertical plan).

### L-C. Source-specific parsing/normalization (new)

`parseClaudeCodeSession()` (`cm-03`) and `parseChatGptExport()` (`cm-04`)
— each turns one real source's real schema (research-brief §1.1/§1.2)
into a SHARED, source-agnostic `ConversationTurn[]` shape. Depends on
L-A (parse-time secret scan runs here, before any turn reaches L-D) and
consumes L-B's manifest as its real input list. `cm-03`/`cm-04` are
"variation" siblings of the same normalization contract — same output
shape, different input parser — genuinely parallel-eligible with each
other, not with L-A/L-B (both depend on L-A; L-B is upstream input).

### L-D. Triage (new)

`triageSession()` (`cm-05`) — heuristic prefilter (pure, over L-C's
normalized turns' structural signals) + one bounded LLM
summarization+classification call per session. Depends on L-C's output.
Produces the human-review queue (`keep`/`trash`/`uncertain` + summary +
rationale).

### L-E. Clustering (new)

`clusterConversations()` (`cm-06`) — embedding-based similarity over
L-D's `keep`/`uncertain` summaries, faceted by L-B's project-slug
metadata. Depends on L-D's output (summaries + verdicts) directly, and
transitively on L-B (project-slug facet).

### L-F. Distillation + persist (new orchestration, composes shipped L-G)

`distillAndRemember()` (`cm-07`) — the ONLY layer in this epic that
actually calls the shipped persistence primitive (L-G). Consumes L-D's
summary/verdict, L-E's cluster assignment, and L-C's normalized turns;
produces bounded decision/fact/open-question/session-summary entries;
runs L-A's scan one final time immediately before persist; calls
`ingestDocument()` (L-G) unchanged.

### L-G. Shipped persistence cascade (existing, composed unchanged)

`ingestDocument()` (ro-10/ro-13) → `MnemosyneClient.remember()` (client.ts)
→ the configured layer stack, `Scope: 'meta'`. Zero new code in this
layer; this epic is a new CALLER, not a modification.

### L-H. Validation (new)

`cm-08` (pilot orchestration: runs L-B→L-C→L-D→L-E→L-F over a small,
operator-selected real sample — the first and only point in this epic
where real content actually reaches L-G) and `cm-09` (deep-dive report:
reads L-H's own real output, produces the operator-inspectable
validation artifact). `cm-09` depends on `cm-08` directly; both depend
transitively on every layer above.

## Cross-layer dependency graph (horizontal view)

```
L-A (safety substrate) ──┬──────────────► L-C (parsing) ──► L-D (triage) ──► L-E (clustering)
                          │                    │                                    │
L-B (discovery) ──────────┴────────────────────┘                                    │
                                                │                                    │
                                                └──────────────► L-F (distill+persist) ◄─┘
                                                                        │
                                                                        ▼
                                                                 L-G (shipped, unchanged)
                                                                        │
                                                                        ▼
                                                            L-H (pilot cm-08 → deep-dive cm-09)
```

## Real delivery risks visible only from the horizontal view

- **L-D → L-E ordering risk:** if `cm-06` (L-E) were built before `cm-05`
  (L-D) ships a real `keep`/`uncertain`/`trash` verdict, clustering would
  have nothing real to cluster except placeholder data — confirms the
  strict `depends_on` chain in the vertical plan is load-bearing, not
  just tidy sequencing.
- **L-A is the single most-depended-on new layer** — any defect in
  `cm-01`'s detection quality has blast radius across L-C AND L-F. This is
  why `cm-01` is its own standalone story with its own independent test
  suite, not folded into `cm-03`'s implementation as a helper function.
- **L-G is genuinely zero-risk to this epic's own delivery** (already
  shipped, already tested) — the real risk budget is entirely in L-A
  through L-F, which is where review/test effort should concentrate.
