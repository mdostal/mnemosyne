# Design Discussion — mnemosyne-desktop-app

## 1. Research question 1 — sidecar architecture (the single highest-risk decision)

**`[grill 1.1]` Which server is actually "the sidecar" — disambiguated
explicitly, not left to assumption:** this repo runs two independent Node
servers (research-brief.md §2.1) — `src/server.mjs` (port 8477, the
operator's own dashboard) and `lib/mnemosyne/server.ts` (port 3141, the
`ingest`/`crawl` client-API server). This epic packages **`src/server.mjs`
only** — confirmed the right scope directly by grep (`ui/app.js` never
references port 3141, `/ingest`, or `/crawl`), so the dashboard the tray
window opens never needs the second server at all.

### 1.1 The real choice, weighed against real numbers, not hand-waved

Two real options (task's own framing):

- **(a) Bundle a full Node runtime binary plus the app's own JS as the
  sidecar executable.**
- **(b) Compile `src/server.mjs` + dependencies into one standalone binary
  via Node's own Single-Executable-Application (SEA) feature (or a
  pkg/nexe-equivalent) and ship that as the sidecar.**

The task's own framing assumed (b) carries "more real risk" specifically
because of native-binding compatibility (naming `better-sqlite3` as the
example). Research-brief.md §2.2 confirms this premise is **factually
inapplicable**: `src/server.mjs`'s own real, hand-traced transitive import
graph has zero npm packages and zero native addons — `better-sqlite3`
backs a completely different server (`lib/mnemosyne/server.ts`, out of
scope per §2.1). Re-litigating the decision on the REAL remaining
differences, not the assumed one:

| Dimension | (a) Full Node runtime + JS resources | (b) Node SEA single binary |
|---|---|---|
| Native-addon/pkg-compat risk | None (zero native addons in this server's graph) | None either — the task's premised risk doesn't apply here |
| Download size | Node binary (~70-110MB depending on platform) + a few KB of `.mjs`/`.html`/`.css` | Node binary (SEA embeds the blob INTO a copy of the `node` binary — same base size) + a small blob. **No node_modules to strip on either side — the usual "SEA avoids shipping node_modules" size argument does not apply here**, because there is no node_modules for this server in the first place. Real size delta between (a) and (b): negligible. |
| Extra build tooling required | None — copy the real `node` executable, rename it per Tauri's `-$TARGET_TRIPLE` convention, ship `src/*.mjs`+`ui/*` as Tauri `resources` | A new bundling step (e.g. `esbuild`) to fold multi-file relative ESM imports into one `main` script before `--build-sea` can embed it — a build tool this repo does not use anywhere today |
| API maturity | Spawning an ordinary `node` binary is completely ordinary — zero SEA-specific edge cases | Node's own docs mark SEA stability as **"1.1 - Active development"** — not yet a stabilized contract |
| Interaction with `src/server.mjs`'s own 3 dynamic `await import()` sites | None — dynamic import works normally under a real Node runtime | SEA's `useCodeCache: true` documented to break `import()` — solvable (`useCodeCache: false`), but a real, extra constraint (a) simply doesn't have |
| Porting effort | Zero — `src/server.mjs` runs completely unmodified | Zero application-code changes either, but the packaging pipeline itself is new/untested in this repo |

**Decision: (a).** With the native-binding risk gap closed by real research
(not by convenient assumption), the two options are size-equivalent, and
(a) wins outright on every remaining axis: no new build tool, no
SEA-specific maturity/edge-case surface, and no interaction with this
server's own dynamic-import call sites to reason about.

**`[grill 5.2]` Adversarial check, run explicitly: does "zero native deps"
actually flip the decision TOWARD (b) instead, since it removes the one
risk the task itself cited against it?** No — checked directly against
the real numbers in the table above, not assumed either way. Removing the
native-binding risk from (b)'s side doesn't add any NEW advantage to (b);
it only removes what was previously its one clear disadvantage, leaving
(b)'s remaining real costs (a new build-tool dependency, SEA's own
"Active development" stability level, the `useCodeCache`/`import()`
interaction) unmatched by any compensating benefit — the commonly-cited
"SEA avoids shipping node_modules" size win is unavailable here because
there is no node_modules for this server to strip in the first place. The
decision is genuinely, not just conveniently, (a).

**Concrete mechanics of (a):**

1. `src-tauri/binaries/mnemosyne-node-<TARGET_TRIPLE>` — a real, unmodified
   platform `node` executable (the SAME binary family already installed
   on this operator's own machine, `v24.18.1`, satisfying
   `package.json`'s `engines.node: ">=22"`), renamed per Tauri's own
   `externalBin` naming convention (`rustc --print host-tuple` gives the
   real triple; on this operator's own machine, `aarch64-apple-darwin`).
   Declared in `tauri.conf.json`'s `bundle.externalBin`.
2. `src/*.mjs`, `bin/graphify-bridge.mjs`, and `ui/*` — bundled via
   `tauri.conf.json`'s `bundle.resources` (object-syntax, preserving the
   exact existing relative layout those files' own relative imports and
   `serveUiAsset()`'s `UI_DIR` computation depend on), resolved at runtime
   via `app.path().resolve(..., BaseDirectory::Resource)`.
3. Rust spawns it: `app.shell().sidecar("mnemosyne-node")?.args([
   resolved_path_to("mnemosyne/src/server.mjs")]).env("PORT",
   "8477")...spawn()`.
4. **No application code in `src/`, `bin/`, or `ui/` is modified by this
   epic** — the sidecar spawns the exact, already-shipped, already-tested
   `src/server.mjs` unchanged. This is the epic's own "compose, don't
   duplicate" discipline, matching `ro-11`'s/`cm`'s own established
   precedent of extending around shipped primitives rather than forking
   them.

### 1.2 `[grill 2.1]` The PATH gotcha — real, confirmed, and now a first-class design decision

Research-brief.md §2.4 confirms `bin/mnemosyne`'s bash wrapper already
carries an explicit `export PATH="/opt/homebrew/bin:$HOME/.local/bin:$PATH"`
line — a real, already-solved fix for the documented macOS fact that
GUI-launched processes (Finder/Dock/`launchd`, unlike an interactive login
shell) do not inherit the user's shell-profile `$PATH`. Confirmed directly
on this machine: `swarm-memory` resolves to `~/.local/bin/swarm-memory`
(a pipx-venv symlink) — exactly the directory that PATH line adds. A
Tauri sidecar bypasses `bin/mnemosyne`'s bash wrapper entirely (it spawns
`node`/`server.mjs` directly), so **this same PATH augmentation must be
reproduced on the sidecar `Command`'s own environment** (Rust's
`Command::env("PATH", ...)`, prepending `/opt/homebrew/bin:$HOME/.local/bin`
ahead of whatever minimal PATH `launchd` provides), or `engine.mjs`'s
`execFileP("swarm-memory", ...)` call fails with `ENOENT` the first time
the packaged app is launched from Finder/Dock/a login item — a failure
mode that would NOT reproduce when testing via `cargo tauri dev` from an
interactive terminal, making it exactly the kind of gap a build-and-test
pass could miss without deliberately testing a Finder/Dock launch. Named
explicitly as `da-02`'s own acceptance criterion, not left to be
discovered the hard way during dogfooding.

### 1.3 `[grill 3.1]` `swarm-memory` remains a real, un-eliminated prerequisite

Bundling a Node runtime solves "does the operator need Node installed to
run this" — it does **not** solve "does the operator need `swarm-memory`
(and its own `~/.config/swarm-memory/config.toml` + Qdrant Cloud
credential) installed and configured." That is a real, separate
prerequisite that already exists today (`node src/server.mjs` has the
exact same requirement) and is **not removed, reduced, or newly
introduced by this epic** — named explicitly here so "the desktop app is
self-contained" is never silently overclaimed. `/health` and `/healthz`
already report this degradation loudly if `swarm-memory` is unreachable
(existing `loud-failure` cross-cutting discipline, unmodified) — the
packaged app inherits that same loud-failure behavior unchanged.

## 2. Research question 2 — auto-update

### 2.1 Real, concrete mechanism (not invented)

`tauri-plugin-updater`, Tauri's own first-party plugin
(research-brief.md §3.4), used exactly as documented:

1. **Signing keypair, generated once, locally, never committed:**
   `npm run tauri signer generate -- -w ~/.tauri/mnemosyne-desktop.key`.
   Public half → `tauri.conf.json`'s `plugins.updater.pubkey` (safe to
   commit — it only lets the app VERIFY a signature, never produce one).
   Private half → stays at `~/.tauri/mnemosyne-desktop.key` on the
   operator's own machine, supplied to a build via the
   `TAURI_SIGNING_PRIVATE_KEY` env var, **never read, printed, or
   persisted by this epic's planning or any story's own implementation
   step** (this repo's own hard "never resolve/print/persist a secret"
   discipline, and Tauri's own docs' explicit warning that losing this
   key permanently strands every already-installed copy of the app from
   ever updating again).
2. **Update manifest** (static JSON, the CDN-hosting shape):
   `{"version", "notes", "pub_date", "platforms": {"darwin-aarch64":
   {"signature", "url"}}}` — generated by Tauri's own build tooling
   (`tauri build`'s bundler produces the `.sig` file alongside each
   built artifact when `bundle.createUpdaterArtifacts: true` is set).
3. **Hosting: GitHub Releases**, confirmed the right real choice for this
   repo specifically because `gh repo view` confirms
   `mdostal/mnemosyne` is **public** (research-brief.md §1) — a public
   GitHub Release's assets (including a `latest.json` manifest file) are
   fetchable by an unauthenticated `GET`, exactly the shape
   `plugins.updater.endpoints` needs
   (`https://github.com/mdostal/mnemosyne/releases/latest/download/latest.json`,
   or an explicit versioned URL using the endpoint template's
   `{{current_version}}`/`{{target}}`/`{{arch}}` substitution). No new
   hosting infrastructure is required — this is Tauri's own
   first-documented, free hosting path, used as documented, not invented.
4. **`tauri.conf.json` wiring:** `bundle.createUpdaterArtifacts: true`,
   `plugins.updater.pubkey` (the committed public key),
   `plugins.updater.endpoints` (the GitHub Releases URL template above).

**`[grill 2.3]` Is "GitHub Releases" a real, Tauri-documented hosting
option, or an invented mechanism borrowed from a different tool by
analogy?** Checked directly, not assumed: Tauri's own updater docs
(research-brief.md §3.4) name static-JSON-on-a-CDN (with GitHub Releases
as the explicit worked example shape) as one of exactly three documented
hosting options, alongside a dynamic update server and CrabNebula Cloud.
Combined with the real, confirmed `gh repo view` result that
`mdostal/mnemosyne` is public, this is a real, directly-usable, real
zero-new-infrastructure mechanism — not invented, not borrowed from
Electron's `electron-updater` or any other tool's own conventions.

### 2.2 `[grill 3.2]` The residual, real, undocumented interaction: does an unsigned auto-update even land smoothly?

A genuine, not-glossed-over tension the task explicitly asked this design
to interrogate: **auto-update replaces the app bundle with a freshly
downloaded artifact.** macOS attaches a quarantine extended attribute
(`com.apple.quarantine`) to files downloaded from the network — which is
exactly what Gatekeeper's "unidentified developer" block (§2.3, §3.7) acts
on for the FIRST launch of a fresh download. Neither Tauri's own updater
docs nor Apple's own Gatekeeper guide (both fetched directly this pass,
research-brief.md §3.4/§3.8) state whether an update **installed by the
already-running, already-approved app itself** (rather than downloaded
fresh by Safari/a browser) re-triggers the same quarantine flow on the
replaced bundle. **This is named here as a real, unresolved, and
empirically-untested residual risk** — not assumed to work smoothly, and
not assumed to break. `da-05`'s own dogfood story is the first real place
this gets to be observed on a real machine (its own acceptance criteria
name this explicitly as something to watch for and report, not silently
assume passes). This is precisely the class of gap `ro-11`'s own R13
residual-risk discipline models: name what genuinely isn't known, rather
than claim full closure the research doesn't support.

### 2.3 `[grill 5.1]` The notarization gap — named explicitly, a real operator-owned prerequisite, not silently assumed solved

Research-brief.md §3.7 confirms directly from Tauri's own docs: real
notarization requires a **paid Apple Developer Program membership
($99/year)** plus a real "Developer ID Application" signing certificate —
neither of which this agent can create, purchase, or access on the
operator's behalf. **Named here as a real, explicit, operator-owned
blocker for shipping a fully notarized, Gatekeeper-silent build** — not
silently assumed away, not deferred as an implementation detail some
future story will "just handle."

**The real, staged path that does NOT require waiting on that
prerequisite — dogfooding is not blocked on it:** an unsigned (or
ad-hoc-signed, `codesign --sign -`) build can be built and run TODAY on
the operator's own machine. The real, Apple-documented workaround
(research-brief.md §3.8, quoted from `support.apple.com` directly): System
Settings → Privacy & Security → Security section → "Open Anyway" →
confirm with the login password, after which — Apple's own words —"you
can open it in the future by double-clicking it, just as you can for any
authorized app." This is a real, one-time-per-build override, not a
system-wide Gatekeeper disable, and Apple's own docs recommend against
using it as general practice — named here as a deliberate, narrow,
operator's-own-machine-only workaround, exactly the same posture `cm-14`'s
epic gave its own one deliberate, narrowly-scoped exception to a general
rule. `da-05`'s dogfood story uses exactly this mechanism, explicitly.

## 3. Research question 3 — what the Tauri shell actually shows

### 3.1 Menu-bar/tray icon + on-click dashboard window (not a new UI)

Per the operator's own framing ("a background, long-running,
auto-updating service, not necessarily a full window a user stares at")
and the task's own explicit instruction, this epic builds **zero new UI**.
`TrayIconBuilder` (research-brief.md §3.5) creates a native tray/menu-bar
icon; `on_tray_icon_event`'s left-click handler shows/focuses an existing
`get_webview_window("main")` window whose webview is pointed at the
sidecar's own real localhost dashboard — the SAME, already fully-built
10-panel `ui/index.html` (§2.5 of research-brief.md), unchanged.

### 3.2 `[grill 2.2]` What URL, exactly, and the startup race condition named explicitly

**Real port, confirmed directly from `src/server.mjs:86`:**
`process.env.PORT || 8477`. The window's webview navigates to
`http://127.0.0.1:8477/ui` (loopback only — never `0.0.0.0`, matching this
codebase's own existing loopback-only posture for every one of its
servers). The Tauri config passes the SAME port via the sidecar
`Command`'s own `PORT` env var (§1.1 step 3), so the two never drift
independently.

**A real hidden assumption, surfaced rather than left implicit:**
naively creating the window and navigating to that URL immediately after
spawning the sidecar races the sidecar's own Node process startup — the
HTTP listener is not guaranteed to be accepting connections yet
(`server.listen(PORT, ...)`'s own callback logs "listening" only once
bound, real startup work — module loads, `engine.mjs`'s own scope-map
resolution — happens before that). **Resolution, concrete, not left to
"the webview will just retry":** the Rust setup step polls
`GET http://127.0.0.1:8477/healthz` (the existing liveness-only route,
already documented as "always 200 if the process is up," §2.1 of
research-brief.md — the correct, cheapest real endpoint for this,
distinct from `/health`'s heavier Qdrant/embedder self-test) with a short
bounded backoff (e.g. up to ~5s, a handful of retries) before creating or
navigating the window, and shows a native "starting up…" state (or simply
delays window creation) rather than surfacing a browser-style
connection-refused error to the operator on every cold launch. This is
`da-03`'s own acceptance criterion, not an implementation-time guess.

### 3.3 Launch-at-login

`tauri-plugin-autostart` (research-brief.md §3.6),
`MacosLauncher::LaunchAgent` — a real, first-party, documented mechanism
(a `launchd` LaunchAgent under the hood), never a bespoke login-item
script. Wired as an operator-toggleable setting (default: on, matching
"run long term" — the operator's own words — but a real,
visible-in-the-tray-menu toggle, never a silently-forced background
service with no visible off-switch).

### 3.4 `[grill 4.1]` Does spawning a Node sidecar that shells out to `swarm-memory` violate this repo's "no bespoke god wiring" rule?

No — checked explicitly, not assumed. The Tauri shell adds exactly one new
layer: an app-shell process that spawns the SAME, unmodified
`src/server.mjs`, which already shells out to `swarm-memory` in
production today, through the exact same `engine.mjs` code path this
epic touches zero lines of. No new memory-access mechanism, no parallel
API surface, no second way to reach Qdrant/`swarm-memory` is introduced —
Tauri is purely a packaging/process-lifecycle/window-chrome layer around
an already-existing, already-proven service boundary. This mirrors
`ro-11`'s own "new code for a new input shape, but the actual
persistence/access step is the existing, unmodified primitive" discipline
exactly.

## 4. Research question 4 — real story decomposition

Five stories, `da-01`..`da-05` — decided for real against the actual
scope surfaced by research questions 1-3 above, not a mechanical copy of
the task's own four-bullet minimum list. The task's (a)/(b)/(c)/(d) map
onto this decomposition as: (a) → `da-01`+`da-02`; (b) → `da-03`; (c) →
`da-04`; (d) → `da-05`. Autostart (§3.3) is folded into `da-03` rather
than split into its own story — it's a small, single-plugin addition to
the same "what does the shell do on launch" concern `da-03` already owns,
and splitting it would add a dependency-graph node with no real
independent risk of its own to justify one (unlike, say, the
sidecar-packaging decision, which genuinely warranted its own isolated,
`ro-06`-style story given its blast radius).

- **`da-01` — Tauri v2 project scaffolding.** `src-tauri/` skeleton
  (`Cargo.toml`, `tauri.conf.json`, `src-tauri/src/lib.rs`/`main.rs`), a
  placeholder webview window (no sidecar yet), confirms `cargo tauri dev`
  and a debug `cargo tauri build` actually run on this real machine
  (Rust/Cargo already present per research-brief.md §1; Tauri CLI
  install is this story's own first real step). No dependency — the true
  root of the graph.
- **`da-02` — Node-runtime sidecar packaging.** The §1 decision made real:
  `externalBin`/`resources` wiring, the real target-triple Node binary,
  the PATH-augmentation fix (§1.2), and a real, direct proof the sidecar
  process can actually reach `swarm-memory` and serve `/healthz` when
  launched exactly as a packaged macOS app would launch it (not merely
  from an interactive dev shell). The epic's single highest-risk story,
  held to `ro-06`'s own review-independently-re-verify discipline.
  Depends on `da-01`.
- **`da-03` — Tray/menu-bar shell + dashboard window + launch-at-login.**
  `TrayIconBuilder`, the health-poll-before-navigate startup sequence
  (§3.2), the window pointed at `http://127.0.0.1:<PORT>/ui`, and
  `tauri-plugin-autostart` wired with a real, visible toggle. Depends on
  `da-02` (needs a real sidecar to point the window at and to poll).
- **`da-04` — Auto-updater wiring.** Signing keypair generation
  (private key never committed/printed/persisted — this epic's own
  cross-cutting proof point), `tauri.conf.json`'s updater config, and the
  GitHub-Releases-hosted manifest mechanism (§2.1) — explicitly EXCLUDING
  macOS notarization (§2.3, a named, deferred, operator-owned
  prerequisite, never a story to build around). Depends on `da-01` only
  (the updater's own config/signing mechanism doesn't require the sidecar
  or tray to exist first, so it can build in parallel with `da-02`/`da-03`
  once `da-01`'s skeleton exists).
- **`da-05` — Local dogfood build + run.** The operator's own explicit
  "release to dogfood" ask, as its own distinct, concrete, verifiable
  story: a real `cargo tauri build` (debug or ad-hoc-signed release) on
  this operator's own machine, the real Gatekeeper "Open Anyway" workaround
  applied (§2.3), the app actually launched from Finder/Dock (not a
  terminal — the exact scenario that would have hidden the §1.2 PATH gap
  had it not been caught by research), and the real dashboard visibly
  reachable by clicking the tray icon. Also the first real, empirical
  observation point for §2.2's named residual auto-update/Gatekeeper
  question (observed and reported, not required to "pass" for this story
  to be considered complete — an open question either way is a legitimate,
  named outcome). Depends on `da-02`, `da-03`, and `da-04` (the full,
  real, "release to dogfood" moment needs the sidecar, the shell, AND the
  updater wiring all present, even though exercising a live update cycle
  end-to-end requires a second, later real release and is out of scope
  for this first dogfood build's own acceptance criteria).

## 5. Cross-cutting concerns

This repo's five registered concerns (`.pHive/cross-cutting-concerns.yaml`:
`documentation`, `versioning`, `loud-failure`, `provenance-completeness`,
`existing-infrastructure`) apply as follows:

- **`documentation`** — `README.md`/`SERVICE.md` need a new section
  describing the desktop-app build/run path once implemented (`da-05`).
- **`versioning`** — `minor` bump (research-brief.md §2.6): additive
  packaging surface, zero existing-contract changes.
- **`loud-failure`** — inherited unchanged from `src/server.mjs`'s own
  existing `/health`/`/healthz` degradation reporting (§1.3); no new
  silent-fallback path is introduced by any story in this decomposition.
- **`provenance-completeness`** — not applicable; no story in this
  decomposition touches `recall()`/provenance shape.
- **`existing-infrastructure`** — every story wraps `src/server.mjs`
  unmodified (§1.1 point 4); no story forks, duplicates, or reimplements
  any existing route, CLI verb, or the `swarm-memory` integration.

**New, named concern (not in the generic list, mirroring `ro-11`'s
`external-fetch-safety` and `cm-01`'s `conversation-privacy-safety`
precedent for a genuinely new risk category the existing five don't
cover): `desktop-signing-and-secret-custody`.** This epic is the first in
this repo to handle a real, long-lived signing keypair (the updater's
private key) whose loss or leakage has real, permanent consequences
(Tauri's own docs: a lost key permanently strands every installed copy
from ever updating again; a leaked key lets an attacker sign a malicious
update every existing installation would silently trust). `da-04`'s own
acceptance criteria are this concern's concrete implementation checklist:
the private key is generated locally, referenced only by an env var at
build time, never committed, never printed to any log/story-output/
commit message, and never handled by this epic's own planning-pass
research or design work in any form beyond naming the mechanism that
generates it.

## 6. Risks

- **The §1.2 PATH gap (Finder/Dock-launched processes not inheriting a
  login shell's PATH) is real and previously invisible to anyone testing
  only via an interactive terminal (`cargo tauri dev`).** Mitigation:
  named as `da-02`'s own explicit acceptance criterion, verified by
  actually launching the packaged app from Finder/Dock (never only from a
  dev shell) before that story is considered complete.
- **The notarization gap is a real, operator-owned, unresolved
  prerequisite for any fully Gatekeeper-silent distribution.** Mitigation:
  named explicitly (§2.3), never silently assumed solved; the staged
  local-dogfood path (Apple's own documented "Open Anyway" override) is
  real and unblocked today regardless.
- **The auto-update/Gatekeeper quarantine interaction (§2.2) is
  genuinely untested and undocumented by either Tauri's or Apple's own
  fetched docs.** Mitigation: named as a residual risk, not claimed
  solved; `da-05` is the first real, empirical observation point, and its
  own acceptance criteria treat "the operator observed and reported what
  actually happened" as sufficient completion, not "a live update cycle
  definitely worked."
- **Losing or leaking the updater's signing private key has permanent,
  irreversible consequences** (Tauri's own docs, quoted directly, §2.1).
  Mitigation: the new `desktop-signing-and-secret-custody` cross-cutting
  concern (§5) and this repo's own existing hard "never resolve/print/
  persist a secret" discipline, applied to this new secret category for
  the first time.
- **`swarm-memory` remains a real, un-eliminated external prerequisite**
  (§1.3) — a packaged app on a machine without `swarm-memory` installed
  and configured fails exactly as loudly as `node src/server.mjs` does
  today (existing `/health` degradation reporting, unchanged), but this
  is named explicitly here so "the desktop app is self-contained" is
  never overclaimed to the operator or a future reader.
- **Cross-platform packaging (Windows/Linux) is out of scope for this
  epic's own story decomposition** — every story's real target is this
  operator's own machine (macOS/`arm64`, confirmed §1 of
  research-brief.md). A future epic would need its own real research pass
  (different target triples, different code-signing regimes entirely) —
  named here as an explicit non-goal, not silently implied to be covered.

## 7. Open questions (genuinely left to the operator, not silently resolved)

1. **Does the operator want auto-update ON by default from the very first
   dogfood build, or opted-in only after `da-05`'s own empirical
   Gatekeeper-interaction observation (§2.2) comes back clean?** This
   design doesn't force either answer — `da-04` wires the mechanism;
   whether it's enabled by default in the shipped `tauri.conf.json` is a
   real, small decision the operator should make once `da-05`'s real
   findings exist, not preemptively decided here.
2. **Is the operator comfortable publishing built binaries via public
   GitHub Releases on `mdostal/mnemosyne`** (confirmed public, §1 of
   research-brief.md), or would they prefer a private-repo-plus-
   authenticated-fetch updater endpoint instead (a real, different Tauri
   updater configuration, not researched in depth this pass since the
   repo's current public visibility made the free/simple path directly
   usable)? Named as a real, unresolved preference, not assumed.
3. **When (and whether) to pursue the Apple Developer Program membership
   and real notarization** (§2.3) is entirely the operator's own future
   decision and timeline — this plan neither assumes it happens soon nor
   blocks any of its own five stories on it happening at all.
