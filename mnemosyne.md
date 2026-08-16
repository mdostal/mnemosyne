# Mnemosyne — Working With Memory In This Repo

This file is Layer 1's canonical, human-editable source (memory Level 1,
per `.pHive/epics/mnemosyne-memory-levels`): harness-agnostic,
tier-agnostic guidance every agent working in a Mnemosyne-adopting repo
should follow, regardless of which harness (Claude Code / Codex / Gemini
CLI / whatever comes next) is driving it, and regardless of which of the
4 orchestration tiers (top orchestrator / company director / project
orchestrator / code architect — see `lib/mnemosyne/layer1/tiers.ts`) that
agent is operating at.

Edit this file directly to change what every agent, on every harness, in
this repo is told about working with memory. Once the Level 1 install
mechanism ships (`ml-03`), this content is spliced into each
harness's own native auto-load file (`CLAUDE.md` / `AGENTS.md` /
`GEMINI.md`) by the same sync pipeline that already splices Level 0 and
tier content — see `lib/mnemosyne/layer1/harness.ts` and
`lib/mnemosyne/layer1/sync.ts`.

**Sourcing note (design-discussion.md §9 risk resolution):** this file is
the canonical source for the memory-lifecycle mandate below.
`lib/mnemosyne/layer1/tiers.ts`'s `MANDATE_SECTIONS` constant is
*generated* from the `## Memory-lifecycle mandate` section of this exact
file at module load (see `tiers.ts`'s `parseMandateSectionsFromMarkdown`)
— it is not a second, independently hand-edited copy. Edit the mandate
text HERE; `tiers.ts` picks up the change automatically.

## Memory-lifecycle mandate

### Recall on entry (mandatory)

Before doing any work -- reading code, answering a question, planning a task -- call recall for this tier's scope first. On Claude Code, this already happens automatically: the installed `hooks/pre-recall.mjs` fires on every `UserPromptSubmit` (including the first prompt of a session, i.e. on entry) and injects prior memory into context -- see hooks/README.md; run `bin/mnemosyne-install-hooks` if this checkout's hooks are not yet wired into your settings.json. Codex and Gemini CLI have no equivalent startup-hook mechanism -- on those harnesses, YOU must call recall explicitly (the Mnemosyne service's `POST /recall`, or the `swarm-memory recall` CLI) before starting; this instruction is the enforcement surface. Skipping recall and re-deriving something already decided is the exact failure this mandate exists to close.

### Remember on exit (mandatory)

Before ending a session or task, call remember with the outcome -- what you did, decided, or learned -- even a short note. On Claude Code this happens automatically via the installed `hooks/post-remember.mjs` on `Stop`/`SubagentStop`. On harnesses without a hook, call remember explicitly (`POST /remember`, or the `swarm-memory` CLI) before finishing. A task that ends without a remember() call leaves no trace for the next agent -- recall on entry only works if someone wrote it down.

### Flight-status awareness (mandatory)

Every remembered entry carries a flight status resolved from real git state: `confirmed` on the default branch, `provisional` on any other branch, or `superseded` once replaced (never deleted). Default recall only surfaces `confirmed` entries plus your OWN current branch's `provisional` entries -- another branch's unmerged `provisional` work is hidden by default and must NOT be treated as settled fact, including if you deliberately surface it via the explicit cross-branch opt-in for review/debugging. If recall surfaces something and you are unsure of its status, treat it as provisional until independently confirmed -- never build on another branch's in-flight memory as if it were merged ground truth.
