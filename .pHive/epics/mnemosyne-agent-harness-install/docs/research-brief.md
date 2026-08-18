# Research Brief — mnemosyne-agent-harness-install

**Goal:** ground a plan for a Portunus-mirrored `mnemosyne agent init`/`agent status` CLI
(harness detection, MCP registration, skill install) plus a top-and-forefront,
collapsible "connect an agent/harness" UI banner, in what this repo actually has
today. All files below were read in full; none was modified to produce this brief.

## 1. What Portunus actually built (per the operator's own report, this session)

The operator's own words, verbatim, describing Portunus's shipped feature:

> `portunus agent init` — detects Claude Code / Codex CLI on the machine, registers
> the MCP server for each, and installs the 4 usage skills to `~/.claude/skills/`.
> Idempotent. `portunus agent status` reports state without touching anything.
> `--harness claude`/`--harness codex` narrows it. `scripts/install.sh`, published to
> the gh-pages root, now the README's top line:
> `curl -fsSL https://mdostal.github.io/portunus/install.sh | bash`. Renamed the PyPI
> distribution to `pantheon-portunus`... installed command is still plain `portunus`.
> Real bug caught mid-build: the first registration check shelled out to
> `claude mcp list`, which health-checks every registered MCP server — 30+ seconds on
> this machine's 11 configured servers. Switched to `claude mcp get portunus`, a
> targeted lookup.

**Local Portunus checkout does not have this yet** (`/Users/mdostal/Documents/work/pantheon/portunus`,
`main` branch, `v0.25.2`, git log shows no `agent`-subcommand commits, `cli.py` has no
`agent` subcommand — only `mcp`). The build described above is real (the operator
directly reported it, with specifics like the `claude mcp list` vs `claude mcp get`
bug that only come from actually running the commands) but isn't reflected in this
local clone — likely very recent work in a different session/checkout. This brief
therefore mirrors the *pattern* from the operator's own description, not Portunus's
literal source, since that source isn't available here to read.

## 2. What Mnemosyne already has (the real, current pieces this epic builds on)

- **A real MCP stdio server already exists**: `bin/mnemosyne-mcp.mjs`. Its own header
  comment confirms it's already a complete, tested transport ("the MCP harness
  surface... exposes recall/remember/grep/reindex/graph-*/persona-* as MCP tools over
  stdio"). This epic does NOT need to build an MCP server — only automate *registering*
  it with a detected harness, which nothing today does.
- **Two real, already-written Claude Code skills exist as repo-local files**, but
  neither is installed anywhere a harness would find it outside this repo:
  - `skills/mnemosyne-standalone/SKILL.md` — explicitly self-described as "the
    'harness plugin interaction' piece... what makes the standalone instance usable
    on its own." This is the single most directly-relevant existing artifact for this
    epic's own goal.
  - `skills/mnemosyne-persona-interview/SKILL.md` — the persona-authoring interview
    skill.
  - So: **2 skills to install**, not Portunus's 4 — a real, repo-specific number, not
    copied from the report above.
- **A different, existing, NOT-to-be-confused-with mechanism**: `bin/mnemosyne-install-hooks`
  wires `hooks/settings.hooks.json` (pre-recall/post-remember `UserPromptSubmit`/`Stop`
  hooks) into `~/.claude/settings.json`. This is unrelated to MCP registration or skill
  installation — a genuinely separate concern this epic must not duplicate or collide
  with. `skills/mnemosyne-standalone/SKILL.md`'s own text already draws this exact
  distinction ("This is **not** the same thing as `hooks/`...").
- **The main CLI entrypoint** is `bin/mnemosyne` (a bash script, not a `.mjs` file) —
  dispatches to `reindex`, `persona`, or falls through to starting the service
  (`src/server.mjs`). A new `agent` subcommand fits this same dispatch pattern (a new
  `if [ "${1:-}" = "agent" ]; then shift; exec node ... ; fi` branch), consistent with
  how `reindex`/`persona` are already wired — not a new, separate CLI binary.
- **`package.json` has `"private": true`** — Mnemosyne is NOT published to the public
  npm registry. This is the single biggest divergence from Portunus's own PyPI-based
  install story and must shape this epic's install-script design: a `curl | bash`
  script cannot do the equivalent of `pip install pantheon-portunus`. The README's own
  existing Quickstart is git-clone-based (`gh repo clone mdostal/mnemosyne && cd
  mnemosyne && npm install && npm test`) — the realistic install-script equivalent is
  automating that same clone+install sequence, then optionally running the new
  `mnemosyne agent init`, not a package-registry install.
- **A real, already-live docs site exists**: `docs/index.html`, referenced in the
  README as `mdostal.github.io/mnemosyne`. No dedicated GitHub Pages deploy workflow
  exists under `.github/workflows/` — GitHub Pages here is almost certainly configured
  (via repo Settings, not a workflow file) to serve `/docs` directly off `main`. This
  means a new `docs/install.sh`, once merged to `main`, would become fetchable at
  `https://mdostal.github.io/mnemosyne/install.sh` with no new CI/deploy work needed —
  confirmed by the existing site's own live presence with no publish workflow.
- **CI** (`.github/workflows/ci.yml`) is a shared, stack-auto-detecting gate (Node
  detected via `package.json`) — nothing install-script-specific to account for.

## 3. The just-shipped UI shell (real current structure, for the "top and forefront" banner)

`ui/index.html`'s real current top (confirmed live, post the `mnemosyne-ui-redesign`
epic, v0.12.0): `<header>` (icon + `<h1>` + Refresh button) is immediately followed by
`<nav id="jump-chips">` (the 8-panel sticky jump nav), then `<main>` with the 8 panels.
There is no existing banner/callout region anywhere above or below the header today —
this epic's new banner is a genuinely new insertion point, not a repurposing of
anything. "Top and forefront" placement, read literally against this real structure,
means between `</header>` and `<nav id="jump-chips">`, so it is the very first thing
below the title bar and above even the navigation.

`ui/style.css`'s real current tokens (post-redesign): `--accent: #D8A84E` (amber-gold,
`ui-01`), `--bg`/`--panel-bg`/`--border`/`--text`/`--muted`/`--pass`/`--fail`
unchanged from the original 8-token system. No existing "banner" or "callout" class
exists to reuse — a new one is needed, but should derive from the same token set, not
invent a new palette (matching this session's own established "extend, don't
reinvent" discipline from the UI redesign epic).

`ui/app.js` has no existing localStorage usage anywhere in the file (confirmed via
grep — zero hits for `localStorage`) — the "collapse it after the first time"
requirement is a genuinely new persistence mechanism for this codebase's UI, not an
extension of an existing one.

## 4. Codex CLI — what's actually knowable here

Nothing in this repo references Codex CLI, MCP registration for it, or any
Codex-specific config today (confirmed via grep across `bin/`, `skills/`, `README.md`,
`docs/` — zero hits for "codex"). This epic's Codex-harness support is taken on faith
from the operator's own report of Portunus's real, working `--harness codex` flag —
there is no local precedent to verify the exact Codex CLI command shape (e.g. its own
equivalent of `claude mcp get <name>`) against. This is a genuine open question for
the design discussion, not something resolvable by reading this repo alone.

## Open questions for the design discussion

1. **Exact Codex CLI MCP-registration command shape** — cannot be verified locally
   (no Codex CLI reference in this repo, Portunus's real implementation isn't in the
   local checkout to read). Needs either a documented best-effort implementation with
   graceful degradation if the exact command differs, or narrowing v1 scope to
   `--harness claude` only with Codex as an explicitly-flagged follow-up.
2. **Install script's real mechanism given `"private": true`** — resolved above
   (git-clone-based, not registry-based) but the exact script contents (shallow clone?
   target directory? re-run-safe?) is a real design decision, not yet made.
3. **UI banner dismissal semantics** — "collapse it after the first time" could mean
   (a) auto-collapse on next page load after having been seen once, or (b) stays
   expanded until the operator explicitly dismisses/collapses it once, THEN stays
   collapsed on future loads. These are different UX contracts and the operator's
   phrasing doesn't fully disambiguate which.
