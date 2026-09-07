# Grill Record — mnemosyne-desktop-app

round_number: 1
unresolved_count: 0

Adversarial pass against `docs/design-discussion.md` (draft, before this
round's revisions) and `docs/research-brief.md`. Five categories, each a
genuine finding against the draft, not a quality score — every finding
below ends with a real question, and every question's resolution is now
inline in the revised `design-discussion.md`, marked `[grill N.N]` at the
exact point resolved. This round specifically interrogates the three
things the planning task itself named as the load-bearing risks: whether
the sidecar decision is genuinely justified or hand-waved, whether the
notarization gap is a real named blocker or glossed over, and whether the
auto-updater design has a real mechanism or an invented one.

## 1. Vocabulary mismatches

**Finding 1.1 — "the sidecar" is ambiguous between two real servers this
repo actually runs.** The draft research spoke of "Mnemosyne's Node.js
server" as if there were exactly one. Direct reading confirms two:
`src/server.mjs` (port 8477, the operator's own dashboard/API) and
`lib/mnemosyne/server.ts` (port 3141, the `ingest`/`crawl` client-API
server, with its own, separate, real npm-dependency graph including
`better-sqlite3`). Which one does "package Mnemosyne as a Tauri app"
actually mean, and does the dashboard the tray window opens ever need the
second one?

*Resolution:* `design-discussion.md` §1 now opens with an explicit
`[grill 1.1]` disambiguation: `src/server.mjs` only, confirmed the right
scope by direct grep (`ui/app.js` never touches port 3141, `/ingest`, or
`/crawl`) — the second server is out of scope, named so a future reader
never assumes it's silently included.

## 2. Hidden assumptions

**Finding 2.1 — the sidecar's own runtime `$PATH` was never checked
against what a Finder/Dock-launched process actually inherits.**
`src/engine.mjs` shells out to an external `swarm-memory` binary resolved
via `$PATH`. The draft assumed a spawned sidecar process would find it the
same way a terminal-launched `node src/server.mjs` does — but macOS
GUI-launched processes do not inherit a login shell's `$PATH`, and
`bin/mnemosyne`'s own bash wrapper already carries an explicit `export
PATH=...` line proving this project has hit this exact class of bug
before. Does the sidecar design account for this, or would the packaged
app fail with `ENOENT` on its very first Finder/Dock launch while working
fine under `cargo tauri dev` from a terminal?

*Resolution:* `design-discussion.md` §1.2 (`[grill 2.1]`) now names this
explicitly, confirms the real resolved path (`~/.local/bin/swarm-memory`)
and the exact `bin/mnemosyne` PATH line that already covers it, and makes
reproducing that PATH augmentation on the sidecar `Command`'s own
environment `da-02`'s own acceptance criterion — verified by an actual
Finder/Dock launch, not only a terminal-driven dev run.

**Finding 2.2 — the webview-navigates-to-localhost design never named
what happens if the sidecar's HTTP listener isn't up yet.** Spawning a
process and immediately pointing a webview at its port is a real, common
race condition — the original draft implied the window "just loads the
dashboard" with no readiness mechanism named.

*Resolution:* `design-discussion.md` §3.2 (`[grill 2.2]`) now names the
real port (`8477`, confirmed at `src/server.mjs:86`) and a concrete
readiness mechanism: poll the existing `/healthz` liveness route with a
bounded backoff before creating/navigating the window, rather than
surfacing a connection-refused error on cold launch.

**Finding 2.3 — is "GitHub Releases" a real, Tauri-documented updater
hosting option, or assumed by analogy to a different tool's own
convention (e.g. Electron's `electron-updater`, which also commonly uses
GitHub Releases)?** The task explicitly asked this to be confirmed
directly from Tauri's own docs, not assumed.

*Resolution:* `design-discussion.md` §2.1 (`[grill 2.3]`) now states
directly, from Tauri's own fetched updater docs, that static-JSON-hosted-
on-a-CDN (with GitHub Releases as the named worked example) is one of
exactly three documented hosting paths, combined with the real, confirmed
`gh repo view` result that this repo is public — a real, zero-new-
infrastructure mechanism, not an invented one.

## 3. Unresolved tensions

**Finding 3.1 — does bundling a Node runtime accidentally get described
as making the app "self-contained," when `swarm-memory` (a wholly separate
binary + config + Qdrant credential) is never eliminated as a real
prerequisite?** The original draft's framing risked implying the
packaging work alone makes the app runnable on any machine.

*Resolution:* `design-discussion.md` §1.3 (`[grill 3.1]`) names this
explicitly: bundling Node solves "does the operator need Node installed,"
not "does the operator need `swarm-memory` installed and configured" —
that prerequisite is unchanged from today's manual `node src/server.mjs`
run, and the existing `/health`/`/healthz` degradation reporting is
inherited unchanged, never silently overclaimed as newly solved.

**Finding 3.2 — the task explicitly asks whether an unsigned build's
auto-update mechanism actually lands smoothly given Gatekeeper's
quarantine behavior for downloaded files, or whether this is quietly
assumed to "just work." Neither Tauri's updater docs nor Apple's own
Gatekeeper guide (both fetched directly) state whether an update installed
by the already-running app itself re-triggers the same quarantine flow
Gatekeeper applies to a browser-downloaded file.** Does the design name
this as a real, unresolved risk, or silently assume the operator's own
"long term and auto-update" ask is fully solved by wiring the plugin?

*Resolution:* `design-discussion.md` §2.2 (`[grill 3.2]`) names this
explicitly as a real, empirically-untested residual risk — not claimed to
work, not claimed to break — and ties `da-05`'s own dogfood story to being
the first real observation point, with "observed and reported" (not
"definitely passed") as the story's own bar for completion on this point.
This mirrors `ro-11`'s own R13 residual-risk discipline (name what isn't
known) rather than overclaiming closure.

## 4. Convention violations

**Finding 4.1 — does wrapping `src/server.mjs` in a Tauri sidecar that
itself shells out to `swarm-memory` amount to a second, parallel way of
reaching Mnemosyne's memory backend — a "bespoke god wiring" pattern this
project's own hard rules warn against?**

*Resolution:* `design-discussion.md` §3.4 (`[grill 4.1]`) checks this
directly and resolves it: zero application code in `src/`, `bin/`, or
`ui/` is modified by any story in this decomposition; the sidecar spawns
the exact, unmodified, already-shipped `src/server.mjs`, which already
shells out to `swarm-memory` in production today through the same
`engine.mjs` code path this epic touches zero lines of. Tauri adds a
packaging/window-chrome/process-lifecycle layer only — no new
memory-access mechanism, no parallel API surface.

## 5. Posture mismatches

**Finding 5.1 — the task explicitly asks whether the notarization gap is
named as a real, concrete blocker with a real staged workaround, or
glossed over as a footnote.** Does the design merely mention notarization
in passing, or does it state the real, concrete cost (a paid Apple
Developer Program membership this agent cannot obtain on the operator's
behalf) and a real, concretely-cited staged path that doesn't block
today's dogfooding?

*Resolution:* `design-discussion.md` §2.3 (`[grill 5.1]`) states the real
cost directly from Tauri's own docs ($99/year Apple Developer Program
membership, a real "Developer ID Application" certificate, neither
obtainable by this agent), names it as a real, explicit, operator-owned
blocker for a fully notarized build, and separately names the real,
Apple-documented local workaround (System Settings → Privacy & Security →
"Open Anyway," quoted directly from `support.apple.com`) as the concrete,
already-unblocked staged path for the operator's own machine today.

**Finding 5.2 — the task's own premise (option (b), SEA, carries "more
real risk" specifically because of native-binding compatibility) turned
out to be factually inapplicable to this repo's real dependency graph
once traced by hand (`src/server.mjs` has zero npm dependencies at all).
Does removing that one cited risk from option (b) actually flip the
decision toward it — was (a) chosen only because it matched the task's
own assumed framing, or was the choice re-derived from the real, current
numbers?**

*Resolution:* `design-discussion.md` §1.1 (`[grill 5.2]`) re-runs the
comparison from the real numbers, not the task's original framing: with
the native-binding risk gap closed for BOTH options equally, (a) still
wins on every remaining real axis (no new build-tool dependency, no SEA
"Active development" stability gap, no `useCodeCache`/`import()`
interaction to manage) — the usual "SEA avoids node_modules" size
advantage cited elsewhere for option (b) doesn't apply here either,
because there is no `node_modules` for this specific server to avoid
shipping in the first place. The decision is re-derived, not
rubber-stamped.

## Team review summary (self-conducted, full planning team acting as one)

- **Researcher lens:** every cited file path, line number, byte/version
  fact, and Tauri/Node/Apple doc quote in `research-brief.md` was
  re-verified against the actual `grep`/`WebFetch`/shell output captured
  during this pass before being written into the design discussion — no
  invented URLs, config keys, or CLI commands.
- **TPM lens:** the story sequencing (`da-01` scaffold → `da-02` sidecar →
  `da-03` shell/tray → `da-04` updater → `da-05` dogfood) is a real
  dependency chain grounded in what each story's own acceptance criteria
  actually need to exist first (a real sidecar to point a window at, a
  real skeleton to add a sidecar/updater config to), not an arbitrary
  ordering of the task's own four-bullet list.
- **Architect lens:** the "package `src/server.mjs` only, unmodified"
  boundary (§1.1/§3.4) was checked against this repo's own existing
  service-boundary conventions (the exact separation `bin/mnemosyne`'s own
  `ingest`/`crawl` subcommands already draw between the two servers)
  before being adopted, not assumed by convenience.

All 8 findings (1.1, 2.1, 2.2, 2.3, 3.1, 3.2, 4.1, 5.2) plus the standalone
notarization posture check (5.1) resolved in this round —
`unresolved_count: 0`. No further grill round required; the three
findings the planning task itself explicitly demanded be interrogated
(sidecar-decision genuineness, notarization-gap honesty, auto-updater
mechanism reality) are findings 5.2, 5.1, and 2.3 respectively, each
resolved by re-deriving from real, cited evidence rather than restating
the original draft's own framing back at itself.
