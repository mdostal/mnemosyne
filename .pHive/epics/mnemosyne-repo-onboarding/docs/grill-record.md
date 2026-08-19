# Grill Record — mnemosyne-repo-onboarding

round_number: 1
unresolved_count: 0

Adversarial pass against `design-discussion.md` (draft), grounded in
`research-brief.md` and the real repo state. Five categories, descriptive
only — each finding ends with a question the design must answer. All six
findings below were resolved by revising `design-discussion.md`; see the
"Resolution" line under each.

## 1. Vocabulary mismatches

**Finding 1.1 — "onboard" is a new verb this codebase has never used.**
Existing CLI vocabulary: `reindex`, `persona sync/seed/show`, `agent
init/status`. The closest existing *concept* word is "ingest"
(`ingest-a10ab2c1` epic name, its `qdrant-ingest`/`repo-ingest`/etc. story
names). Introducing `mnemosyne onboard` adds a fifth top-level verb whose
relationship to "ingest" is never stated. Does the operator want a new verb,
or should Mode A's entry point be named/aliased to align with the
already-established "ingest" vocabulary?

**Resolution:** Kept `mnemosyne onboard` as the verb (matches the
operator's own words — "onboard it into the memory system" — verbatim,
which outranks internal-codebase-vocabulary consistency), but added an
explicit design decision + story acceptance criterion stating the
relationship to "ingest": `onboard` is the single-repo primitive;
`ingest-a10ab2c1`'s remaining `repo-*` stories are the bulk-loop consumer of
it (§ Open Questions #1, now resolved as a recommendation, not left
ambiguous).

## 2. Hidden assumptions

**Finding 2.1 — "swarm-memory's own collection-create path" was never
verified to exist.** `research-brief.md` §4/`design-discussion.md` §2.1
step 5 assert a new Python function will "create the Qdrant collection via
swarm-memory's own collection-create path" — but `swarm-memory` lives in a
sibling repo (`~/Documents/work/dostal/code/swarm-memory`, per
`m-08`'s own `key_files`), never read by this research pass. This is an
assumption, not a confirmed fact. Does a `swarm-memory` collection-create
CLI verb actually exist, or does the new Python module need to talk to the
Qdrant HTTP API directly (a materially different, higher-blast-radius
design, since `qdrant_inventory.py`'s own `HttpQdrantClient` is read-only
by explicit design)?

**Resolution:** Design discussion revised to make this an explicit,
first-class research spike inside the collection-creation story (not an
assumed implementation detail) — the story's `research` step must read the
real `swarm-memory` CLI surface (`swarm-memory --help` and its real repo)
before any implementation, and the story's acceptance criteria are written
conditionally on what's actually found: prefer a `swarm-memory`-native
create verb if one exists; fall back to a direct, read-write-scoped Qdrant
HTTP client call (mirroring `HttpQdrantClient`'s existing shape but with a
`PUT /collections/{name}` capability) ONLY if confirmed no `swarm-memory`
create path exists, with that fallback called out as a bigger, separate
risk requiring its own explicit no-wipe safety proof.

## 3. Unresolved tensions

**Finding 3.1 — `GET /memory-levels`'s live-check design is single-repo
singleton; Mode A onboarding is inherently multi-repo.** `server.ts`'s
`GET /memory-levels` computes level-configured state against ONE
module-level `client` (`ROOT_DIRECTORY`, one `MnemosyneClient` instance per
running service process). `design-discussion.md`'s original §2.1 step 6
proposed reusing this computation as a shared library function called from
`onboardRepo()` for an arbitrary repo path — but a real reuse requires
constructing a fresh `MnemosyneClient` scoped to the target repo's own
`rootDirectory` (not the running service's), which the current route
handler never does (it always reads the ambient singleton). Is
`onboardRepo()` expected to spin up its own throwaway `MnemosyneClient`
per onboarding call, or does "report base level" only ever apply to the
one repo Mnemosyne's own running service instance is already rooted at?

**Resolution:** Design discussion revised: the shared "report base level"
step is now explicit that it constructs its own scoped `MnemosyneClient`
(`new MnemosyneClient({ rootDirectory: repoRoot })`, the same constructor
option every other consumer of this class already uses) rather than reusing
the server's ambient singleton — this is a real code change (extract
`server.ts`'s per-level `configured` computation into a standalone,
client-parameterized function both the route and `onboardRepo()` call), not
a zero-new-code reuse as originally implied. Story-level acceptance
criteria updated accordingly (see story `ro-06`).

**Finding 3.2 — Mode B's default-on `agent init` build step could
silently start indexing a large host repo the very first time someone runs
`init` on a machine, before they've had a chance to read
`mnemosyne.layers.json` guidance.** Design discussion frames `--no-build`
as an opt-out (build ON by default) "matching the operator's literal ask,"
but `docs/install.sh`'s own stated design principle is the opposite:
mutating/heavy actions stay separate, explicit, operator-confirmed steps
(`install.sh`'s header comment, `design-discussion.md §1.2` of the
harness-install epic — the reason `agent init` itself is never auto-run by
`install.sh`). Defaulting the NEW build step to "on" inside `agent init`
risks the same class of surprise `install.sh` was written specifically to
avoid, one layer up. Should `--no-build` really default to build-ON, or
should the harness-install epic's own established "heavy/mutating steps
stay separate and explicit" convention win here too?

**Resolution:** Reversed the default — `agent init`'s build step is now
opt-IN (`--build`, default OFF), matching the established convention
exactly instead of re-litigating it. `agent init` output prints the same
kind of "next step, not run automatically" guidance `install.sh` already
uses for `agent init` itself, naming `mnemosyne agent init --build` as the
explicit follow-up. Open question #3 in the design discussion is resolved
by this reversal, not left open.

## 4. Convention violations

**Finding 4.1 — cross-cutting concerns were never evaluated against the
draft.** This repo has a real, populated `.pHive/cross-cutting-
concerns.yaml` (documentation, versioning, loud-failure, provenance-
completeness, and more) that the Hive plan process requires evaluating
per-story (`/plan` step 3/14). The original design discussion draft never
mentions it. Given this epic's Mode A collection-creation step is a live-
infra-mutating action and the "never wipe Qdrant" hard rule is this
project's single most safety-critical convention
(`ways_of_working.md`), silently skipping the cross-cutting pass here is
the single worst place in this epic to skip it. Which concerns apply, and
where?

**Resolution:** Cross-cutting concerns now explicitly evaluated at the
story level for every story in this epic (see individual story YAMLs'
`cross_cutting:` blocks) — `loud-failure` and `provenance-completeness`
apply to the first-time-index stories; `documentation` and `versioning`
apply to the CLI-surface stories (`ro-01`, `ro-05`); a **new, explicit,
named safety concern** (no-Qdrant-wipe, mirrored from `ways_of_working.md`
directly, not from the generic `cross-cutting-concerns.yaml` list, which
has no entry for it) is called out by name in every story touching
`ro-06`'s collection-creation path.

## 5. Posture mismatches

**Finding 5.1 — the design discussion asserts total confidence
("Confirmed by real code, not assumed") about `m-06`/`m-07`/`m-08` staying
"unchanged," but never examines whether this epic's Mode B file-index-only
floor and `m-06`'s future continuous-indexing design could conflict once
`m-06` actually lands** (e.g., two independently-scheduled indexing
triggers writing to the same `.mnemosyne/file-index.json` manifest without
coordination). The confident, declarative tone ("this epic does not
re-plan m-06... unchanged") reads as having resolved a forward-compatibility
question that was never actually examined against `m-06`'s own (unbuilt)
design. Should this epic's stories carry an explicit forward-compatibility
note flagging the manifest-write coordination question for whoever
eventually builds `m-06`, rather than asserting silence is safe?

**Resolution:** Added an explicit forward-compatibility risk (not a new
story — `m-06` is still someone else's future work) to the design
discussion's risk section, and a `references:` pointer from the relevant
onboarding story (`ro-04`, first-time L4 index) to `m-06-continuous-
indexing.yaml`, so whoever eventually implements `m-06` inherits the
manifest-write-coordination question explicitly instead of rediscovering
it.

## Summary

6 findings, 6 resolved via design-discussion revision (below). No findings
carried forward unresolved — `unresolved_count: 0`.
