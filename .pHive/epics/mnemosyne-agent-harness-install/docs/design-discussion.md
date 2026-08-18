# Design discussion — mnemosyne-agent-harness-install

## §0. Goal (verbatim operator ask)

"every agent, harness, etc that uses this needs a way to install and interact with it
— it should be top and foreward so people can see when installing and working and
what to feed the agent or harness to get interactivity." Mirrors Portunus's own
shipped `agent init`/`agent status` pattern (harness detection, MCP registration,
skill install, a real `install.sh`, README top-line). The UI "needs to display this
top and forefront so that people can get to it, collapse it after the first time."

## §1. Proposed approach

### 1.1 CLI: `mnemosyne agent init` / `mnemosyne agent status`

New `agent` subcommand on the existing `bin/mnemosyne` dispatcher (same pattern as
`reindex`/`persona` — a new `if [ "${1:-}" = "agent" ]; then shift; exec node
"$HERE/bin/mnemosyne-agent.mjs" "$@"; fi` branch), backed by a new
`bin/mnemosyne-agent.mjs`.

- **`mnemosyne agent init [--harness claude|codex]`** — idempotent. For each detected
  harness (or the one named via `--harness`):
  1. Detect the harness binary on `PATH` (`claude`, `codex`).
  2. Register `bin/mnemosyne-mcp.mjs` as an MCP server under the name `mnemosyne`,
     using each harness's own MCP-config command (`claude mcp add mnemosyne -- node
     <abs-path>/bin/mnemosyne-mcp.mjs`, and the Codex CLI equivalent — see the Codex
     open question below).
  3. For Claude Code specifically: copy `skills/mnemosyne-standalone/` and
     `skills/mnemosyne-persona-interview/` into `~/.claude/skills/` (2 skills, the
     real current count — not Portunus's 4, per research-brief.md §2). Codex CLI has
     no analogous skill-file mechanism (confirmed nothing in this repo or the
     operator's own report suggests one) — skill install is Claude-only.
  4. **Registration check must be targeted, not broad** — this is the one concrete,
     named bug the operator already found and fixed in Portunus's real build: use
     `claude mcp get mnemosyne` (single-server lookup), never `claude mcp list`
     (health-checks every registered server on the machine, 30+ seconds observed on
     Portunus's own build). Same principle applies to whatever Codex's own targeted
     lookup command is.
- **`mnemosyne agent status [--harness claude|codex]`** — read-only. Reports, per
  detected harness: binary found (y/n), MCP server registered (y/n, via the same
  targeted lookup), skills installed (y/n per skill, Claude only). Touches nothing.

### 1.2 Install script: `scripts/install.sh`, published to `docs/install.sh`

Given `"private": true` (research-brief.md §2) there is no package-registry install to
wrap. The script clones the repo (shallow, `--depth 1`) into a sensible default
location (respecting an existing clone if already present — re-run-safe, matching
`agent init`'s own idempotency), runs `npm install`, symlinks/links `bin/mnemosyne`
onto `PATH` (e.g. via `npm link` or a direct symlink into `~/.local/bin`, matching
this operator's own machine convention already observed this session —
`~/.local/bin/swarm-memory` exists there), then prints (does not auto-run) the
`mnemosyne agent init` command as the next step — installing and registering are
kept as two explicit, separately-confirmable actions, not one silent chain, since
`agent init` mutates a harness's own MCP/skill config and shouldn't happen without
the operator seeing it happen.

Committed at `docs/install.sh` directly (not `scripts/install.sh` synced to a
separate gh-pages root the way Portunus's build did) — this repo's own GitHub Pages
is already configured to serve `/docs` off `main` with no separate deploy step
(research-brief.md §2), so `docs/install.sh` on `main` is immediately
`https://mdostal.github.io/mnemosyne/install.sh` with zero new CI work. A thin
`scripts/install.sh` symlink (or a one-line wrapper) can point at the same file for
anyone browsing the repo directly, so both paths work.

### 1.3 README top line

Matching Portunus's own placement exactly: `curl -fsSL
https://mdostal.github.io/mnemosyne/install.sh | bash` as the new first line of the
README's Quickstart section — the existing `gh repo clone`/`npm install`/`npm test`
block stays, presented as the manual/dev-clone alternative underneath, not removed.

### 1.4 UI: a top-and-forefront, collapsible "connect an agent/harness" banner

Placement: between `</header>` and `<nav id="jump-chips">` (research-brief.md §3 —
the real first available slot below the title bar, above even navigation, which is
the most literal reading of "top and forefront"). Content: the real `curl -fsSL
...install.sh | bash` command in a copy-pasteable code block, plus the
`mnemosyne agent init` follow-up command, plus one line naming what it does (register
the MCP server + install the 2 skills) — real, working commands, not placeholder
text.

**Dismissal semantics (resolving research-brief.md open question 3):** collapse
persists across page loads once the operator has collapsed it themselves, not an
automatic one-time-then-gone behavior — an operator re-reading "how do I connect an
agent" after having dismissed it once is a real, plausible need (a new teammate's
harness, a second machine), so a manual "×"/collapse control is *always* reachable
(collapsed to a slim one-line reopenable strip, not removed from the DOM), and
localStorage only remembers the collapsed/expanded state, never permanently deletes
the affordance. This is the more conservative, more recoverable reading of "collapse
it after the first time," and matches this session's own repeated design bias toward
"never make information un-reachable" (the same principle that shaped the just-shipped
jump-chip nav's own "never fabricate, never hide behind a dead end" discipline).

## §2. Risks

- **Codex CLI's exact MCP-registration and targeted-lookup command shape is unverified
  locally** (research-brief.md §4). Mitigation: implement Codex support against the
  operator's own reported Portunus pattern (a real, working precedent, even if not
  independently re-verified here), with a loud, explicit failure message (not a silent
  no-op) if the actual installed Codex CLI's command surface differs — matching this
  repo's own SERVICE.md "loud failure is a hard requirement" convention.
- **`agent init` mutates a harness's own real config files** (MCP registration,
  `~/.claude/skills/`) — a real, if low, blast-radius action on the operator's
  machine outside this repo. Mitigation: idempotent by construction (targeted
  check-before-write, matching Portunus's own build), and `agent status` exists
  specifically so an operator can preview state before running `init`.
- **The install script runs on an arbitrary operator's machine via `curl | bash`** —
  inherently trust-sensitive. Mitigation: script is small, readable, does only
  clone+npm-install+link (no `agent init` auto-run, per §1.2), and ships from this
  same reviewed repo, matching the exact trust model the operator already accepted
  for Portunus's real, shipped equivalent.

## §3. Dependencies

None on other in-flight epics. Builds directly on top of the just-shipped
`mnemosyne-ui-redesign` (v0.12.0) — the new banner's placement and token reuse assume
that epic's real shipped shell structure (research-brief.md §3), not the pre-redesign
layout.

## §4. Open questions — resolved inline above, restated for traceability

1. Codex CLI command shape — resolved §1.1/§2 (best-effort against the operator's own
   report, loud failure on mismatch, not silently narrowed to Claude-only for v1,
   since the operator explicitly asked for both harnesses).
2. Install script mechanism given `"private": true` — resolved §1.2 (clone-based).
3. Banner dismissal semantics — resolved §1.4 (persistent collapse, always
   reachable via a reopen control, never fully removed).

## §5. Scale assessment

**Medium.** Touches CLI (`bin/mnemosyne`, new `bin/mnemosyne-agent.mjs`), a new
public-facing install script + docs/README surface, and the UI shell (one new,
real, interactive banner region) — multiple layers, but each is narrow and the
real precedent (Portunus's own shipped pattern, the already-existing MCP server and
skills) removes most of the open-ended design risk a from-scratch feature would
carry. Design discussion is sufficient context — no H/V planning warranted; proceeds
directly to story decomposition.
