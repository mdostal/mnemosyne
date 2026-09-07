# Research Brief — mnemosyne-desktop-app

Planned 2026-09-06, branch `feat/mnemosyne-desktop-app` off `origin/dev`
(real, fetched tip `b1a2a81`, v0.15.0, `mnemosyne-repo-onboarding` epic
shipped — confirmed via `git fetch origin && git rev-parse origin/dev` this
pass, not assumed from a stale local ref). Full, real reconnaissance —
every claim below is either a direct file read, a direct shell command
output, or a direct web-fetch of Tauri's/Node's/Apple's own current docs.
No format, version, or config shape is assumed before being confirmed.

## 0. Operator's own words (verbatim, the ground truth for this epic)

> "we need to have it release to dogfood and i need it to run long term
> and auto-update"

Asked directly to choose between Tauri, Electron, and a bare background
service, the operator chose **Tauri**. Three real asks embedded: (1) a
real, runnable local build the operator can dogfood today, (2) long-term
unattended running (not a foreground terminal the operator must keep
open), (3) auto-update without manual re-installation.

## 1. Real environment facts (re-confirmed this pass, not inherited stale)

- `~/.cargo/bin/cargo` and `~/.cargo/bin/rustc` both exist — Rust/Cargo
  IS installed (`ls` confirmed directly).
- Tauri CLI is NOT installed (`which tauri` → not found; `npm ls -g` has
  no `tauri` entry).
- No `src-tauri/` directory and no Electron/Tauri scaffolding anywhere in
  this repo (`ls` at repo root — confirmed clean).
- Node **v24.18.1** available (`node --version`), resolved via
  `~/.nvm/versions/node/v24.18.1/bin` on `$PATH` on this machine.
- Platform: macOS, `Darwin 25.5.0`, `arm64` (Apple Silicon) — confirmed via
  `uname -a`.
- `package.json`'s own `engines.node` requirement: `>=22`.
- GitHub remote: `origin` → `https://github.com/mdostal/mnemosyne`,
  confirmed **PUBLIC** (`gh repo view --json visibility` → `"PUBLIC"`) —
  load-bearing for the auto-updater's hosting decision (§4).

## 2. Real repo structure this epic must wrap (read directly, not assumed)

### 2.1 Two separate Node HTTP servers exist in this repo — disambiguated explicitly

This repo runs **two independent servers**, confirmed by reading both
files directly, not assumed from naming alone:

1. **`src/server.mjs`** (started via `bin/mnemosyne` / `npm start` /
   `node src/server.mjs`), **default port 8477** (`PORT` env override,
   confirmed at `src/server.mjs:86`, `Number(process.env.PORT || 8477)`).
   This is the operator's own "it" — the dashboard/API service whose doc
   comment (lines 1-56) lists every route: `/`, `/ui`, `/health`,
   `/healthz`, `/scopes`, `/config`, `/recall`, `/remember`, `/lanes`,
   `/search`, `/graph/*`, `/index`, `/cache/refresh`, `/reindex`. Serves
   the static dashboard from `ui/` at `/ui`, `/ui/*` (`serveUiAsset()`,
   `src/server.mjs:102-121`), and does a **content-negotiated redirect**:
   `GET /` returns JSON for programmatic callers, or a 302 to `/ui` for a
   browser (`Accept: text/html`) — real, load-bearing detail for what URL
   a Tauri webview should navigate to (§3 of design-discussion.md).
2. **`lib/mnemosyne/server.ts`** (started via `npm run start:client-api`,
   i.e. `tsx lib/mnemosyne/server.ts`), a **separate** "client API" server
   (default port 3141, per its own doc/comment trail cited in
   `bin/mnemosyne`'s `ingest`/`crawl` subcommand comments) that backs the
   `mnemosyne ingest`/`mnemosyne crawl` CLI verbs via
   `lib/mnemosyne/ingest/ingestDocument.ts`/`crawlAndIngest.ts` and the
   full TS layer-stack (`MnemosyneClient`).

**Confirmed by direct grep: `ui/app.js` never references port 3141, `/ingest`,
or `/crawl`.** The operator's own dashboard (`ui/index.html`) is entirely
self-contained against `src/server.mjs`'s own route table. This epic
packages **`src/server.mjs` only** — the second server is out of scope,
named explicitly so a future reader doesn't assume "the sidecar" silently
covers both.

### 2.2 `src/server.mjs`'s real transitive dependency graph has ZERO npm packages

Traced by hand, one import at a time, not assumed:

- `src/server.mjs` imports only `node:http`, `node:fs/promises`,
  `node:path`, `node:url`, plus two local files: `./engine.mjs` and
  `../bin/graphify-bridge.mjs`.
- `src/engine.mjs` (917 lines) imports only Node builtins
  (`node:child_process`, `node:util`, `node:fs/promises`, `node:os`,
  `node:path`, `node:crypto`) plus local `./flight-status.mjs` and
  `./status-filter.mjs`, and two **dynamic** `await import()` calls to
  local files: `./layers/code-graph.mjs` and `./merge.mjs`.
- `bin/graphify-bridge.mjs`, `src/flight-status.mjs`,
  `src/status-filter.mjs`, `src/layers/code-graph.mjs`,
  `src/layers/{meta,enterprise,project}.mjs`, `src/merge.mjs` — every one
  of these imports only Node builtins and other local `.mjs` files
  (confirmed by grep across the whole set: zero bare-specifier imports
  found anywhere in this transitive graph).
- `src/server.mjs`'s own doc comment states this explicitly too: "Zero
  third-party deps — Node's built-in http, so it just runs."

**This directly contradicts the task's own initial premise that
`better-sqlite3`'s native bindings are a real risk for this specific
server.** `better-sqlite3` (a real dependency in `package.json`, confirmed
used by `lib/mnemosyne/layers/HiveMemoryLayerAdapter.ts` and
`CodeGraphLayerAdapter.ts` via grep) backs the **other** server
(`lib/mnemosyne/server.ts`'s TS layer-stack, §2.1) — never
`src/server.mjs`'s route table. This is a real, load-bearing finding for
the sidecar-packaging decision (design-discussion.md §1).

### 2.3 The real external dependency `src/server.mjs` DOES have: `swarm-memory`

`src/engine.mjs` is its own doc comment's "thin wrapper around the proven
`swarm-memory` CLI" — `export const CLI = process.env.SWARM_MEMORY_BIN ||
"swarm-memory"`, invoked via `execFileP(CLI, args, ...)`
(`src/engine.mjs:8,18,22,69`). This is a **real subprocess dependency on
an external binary resolved via `$PATH` at runtime**, confirmed present on
this machine at `~/.local/bin/swarm-memory` (a pipx-venv symlink,
`readlink` confirmed), which is **not** on macOS's default GUI-launched
`$PATH` (see §3 below) — never eliminated by bundling Node, since it's a
wholly separate binary/config/credential surface
(`~/.config/swarm-memory/config.toml`, a Qdrant Cloud API key) that must
already exist on the operator's machine today to run `node
src/server.mjs` manually, and continues to be a real prerequisite after
packaging.

### 2.4 A real, already-solved PATH gotcha this epic must replicate, not silently drop

`bin/mnemosyne`'s own first executable line: `export
PATH="/opt/homebrew/bin:$HOME/.local/bin:$PATH"` — a real, already-present
fix in this codebase for the well-known macOS fact that GUI-launched
processes (Finder/Dock/`launchd`, as opposed to an interactive login
shell) do not inherit `~/.zshrc`/`~/.bash_profile`'s `$PATH` additions.
Confirmed directly on this machine: `which swarm-memory` →
`/Users/mdostal/.local/bin/swarm-memory`, and `~/.local/bin` is exactly
the directory `bin/mnemosyne`'s own `export PATH=...` line adds. **A
Tauri sidecar spawns `src/server.mjs` directly (never through
`bin/mnemosyne`'s bash wrapper)** — so this PATH augmentation must be
reproduced explicitly on the sidecar `Command`'s own environment, or
`engine.mjs`'s `execFileP(CLI, ...)` call will fail with `ENOENT` the
first time the packaged app runs from Finder/Dock/login-item, even though
`node src/server.mjs` run from a terminal works fine. A real, concrete,
previously-invisible risk this research pass surfaces explicitly (see
design-discussion.md §1.4 and story `da-02`'s acceptance criteria).

### 2.5 `ui/index.html`'s real 10 panels (confirmed via direct grep of `<section id=`)

`connect-banner`, `liveliness`, `settings`, `lanes`, `search`, `graph`,
`operations`, `personas` (with a nested `persona-layer-stack`
sub-section), `memory-levels` — matches the task's own "10 real panels"
framing. This is the existing, fully-built dashboard the Tauri window
points its webview at; this epic builds **zero** new UI.

### 2.6 `package.json` — versioning surface this epic must extend correctly

Current version `0.15.0` (`private: true`). `bin` entries already list six
CLI-launched entry points; this epic adds no new `bin` entry (the desktop
app is a separate `src-tauri/` Rust/Tauri project, not an npm `bin`
script). `version_bump: minor` is the right call (§5) — an additive new
distribution surface, no existing API/CLI/config contract changes.

## 3. Tauri's own current documentation (web-fetched directly this pass, cited by URL)

### 3.1 Current major version

`https://github.com/tauri-apps/tauri/releases` — latest stable tag
observed this pass: **v2.11.5**. v2 is confirmed the current, actively
maintained major version (the v2.11.x line shows continuous recent
releases). `src-tauri/Cargo.toml`'s own tray-icon doc snippet
(`https://v2.tauri.app/learn/system-tray/`) pins `tauri = { version =
"2.0.0", features = ["tray-icon"] }` as the baseline dependency
declaration this epic's scaffolding story should follow (a future
implementation pass re-confirms the exact patch version available at
build time via `cargo add`/`npm view`, not hard-pinned by this planning
pass).

### 3.2 Sidecar mechanism (`https://v2.tauri.app/develop/sidecar/`)

- Configured via `bundle.externalBin` in `tauri.conf.json`, an array of
  paths (e.g. `"binaries/mnemosyne-node"`).
- **Each binary must ship one file per target triple**, suffixed
  `-$TARGET_TRIPLE` (e.g. `binaries/mnemosyne-node-aarch64-apple-darwin`
  for this operator's own machine). Real target-triple lookup command
  documented: `rustc --print host-tuple`.
- Rust side: `app.shell().sidecar("mnemosyne-node")?.spawn()` (via the
  `tauri-plugin-shell` crate/`ShellExt` trait) — called with the sidecar's
  bare name, not its `externalBin`-declared path.
- JS side (if ever needed): `Command.sidecar('binaries/mnemosyne-node')`
  via `@tauri-apps/plugin-shell`, gated by explicit
  `shell:allow-execute`/`shell:allow-spawn` capability permissions.
- Arguments are passed as an array and must match capability-declared
  patterns (static values or regex validators) — no unrestricted
  arbitrary-arg passthrough.

### 3.3 Resource bundling (`https://v2.tauri.app/develop/resources/`)

- `bundle.resources` in `tauri.conf.json` bundles arbitrary
  non-executable files/directories (array syntax preserves directory
  structure; object syntax gives fine-grained source→dest control).
- Runtime resolution: Rust's `app.path().resolve("some/file",
  BaseDirectory::Resource)`; JS's `resolveResource()` from
  `@tauri-apps/api/path`. This is the real, documented mechanism for
  shipping `src/*.mjs`, `bin/graphify-bridge.mjs`, and `ui/*` alongside
  the sidecar binary (§ design-discussion.md §1.3).

### 3.4 Updater plugin (`https://v2.tauri.app/plugin/updater/`)

- Signing keypair: `npm run tauri signer generate -- -w
  ~/.tauri/myapp.key` — produces a public key (goes into
  `tauri.conf.json`'s `plugins.updater.pubkey`) and a private key (kept
  out of the repo entirely, supplied at build time via the
  `TAURI_SIGNING_PRIVATE_KEY` env var). Docs' own explicit warning quoted
  directly: "if you lose this key you will NOT be able to publish new
  updates to the users that have the app already installed."
- Update manifest (static JSON, the documented shape for CDN/GitHub
  Releases hosting): `{"version", "notes", "pub_date",
  "platforms": {"<target>": {"signature", "url"}}}`.
- `tauri.conf.json` config: `bundle.createUpdaterArtifacts: true`, plus
  `plugins.updater.pubkey` and `plugins.updater.endpoints` (an array of
  URL templates supporting `{{current_version}}`, `{{target}}`,
  `{{arch}}` substitution).
- **Hosting options named directly by Tauri's own docs:** static JSON on
  GitHub Releases, a dynamic update server, or CrabNebula Cloud (an
  official managed partner offering). GitHub Releases is real, free, and
  directly usable here since this repo is confirmed **public** (§1).

### 3.5 Tray/menu-bar (`https://v2.tauri.app/learn/system-tray/`)

- `TrayIconBuilder::new().menu(&menu).show_menu_on_left_click(true).build(app)?`
  — a native tray icon with an attached `Menu`/`MenuItem` set.
- `on_tray_icon_event` handles clicks (e.g. `TrayIconEvent::Click {
  button: MouseButton::Left, .. }`) to show/focus an existing
  `get_webview_window("main")` window — the exact mechanic this epic's
  "click tray icon → dashboard window" behavior uses.

### 3.6 Launch-at-login (`https://v2.tauri.app/plugin/autostart/`)

- `tauri-plugin-autostart`, installed via `npm run tauri add autostart`.
- Rust setup: `tauri_plugin_autostart::init(MacosLauncher::LaunchAgent,
  Some(vec![...]))` — `MacosLauncher::LaunchAgent` is the macOS-specific
  mechanism (a real, documented, non-bespoke launch-at-login
  implementation — a `launchd` LaunchAgent, not a hand-rolled login-item
  script).
- JS API: `enable()`/`disable()`/`isEnabled()`; requires
  `autostart:allow-enable`/`allow-disable`/`allow-is-enabled` capability
  permissions. Documented minimum Rust version: 1.77.2+.

### 3.7 macOS signing/notarization
(`https://v2.tauri.app/distribute/sign/macos/`)

- Notarization **requires a paid Apple Developer Program membership**
  ($99/year) — the docs state a free-tier account "cannot notarize."
- Requires a **"Developer ID Application" certificate** (for
  outside-the-App-Store distribution, which this dogfood build is), via a
  real CSR-generation-and-upload flow through Apple's own developer
  portal.
- Notarization itself: `notarytool`, authenticated via either an App
  Store Connect API key (Tauri docs' documented recommendation) or an
  Apple ID + app-specific password + Team ID.
- **Consequence of skipping this, quoted directly from Tauri's own docs:**
  an unsigned/unnotarized app downloaded from a browser triggers "a
  warning that your application is broken and can not be started." On
  Apple Silicon specifically, code-signing (at least ad-hoc) is mandatory
  for apps quarantined as downloaded from the internet, and even an
  ad-hoc signature does not exempt the app from Gatekeeper's manual
  allow-listing requirement.
- **No documented production-distribution workaround exists** — Tauri's
  own docs name local/development-machine use as the one case that
  remains possible without this.

### 3.8 Real, Apple-documented local Gatekeeper override

(`https://support.apple.com/guide/mac-help/mh40616/mac`, fetched
directly): Apple menu → System Settings → Privacy & Security → Security
section → "Open Anyway" (appears for ~1 hour after the first blocked
launch attempt) → confirm with the login password. Apple's own docs:
"you can open it in the future by double-clicking it, just as you can for
any authorized app" — i.e. this is a real, one-time-per-build override for
the SAME app bundle, not a permanent system-wide Gatekeeper disable. This
is the real, named staged workaround for the operator's own local
dogfooding (design-discussion.md §2.3) — Apple explicitly recommends
against it as general practice but it is a real, working, documented
mechanism for the operator's own machine.

## 4. Node.js's own Single-Executable-Application (SEA) feature
(`https://nodejs.org/api/single-executable-applications.html`, fetched
directly — the concrete alternative packaging option 1(b) named in the
task)

- Available since Node v19.7.0/v18.16.0; built-in `--build-sea` CLI flag
  as of the newest docs fetched (v25.5.0-line docs); stability level
  **"1.1 - Active development"** (i.e. not yet a fully stabilized API
  contract) — a real, citable maturity gap relative to simply spawning an
  ordinary `node` binary (a fully mature, ordinary Tauri sidecar pattern
  with no SEA-specific edge cases).
- Building one requires a `sea-config.json` naming a single `main` script,
  then `node --build-sea sea-config.json` (or the older
  `--experimental-sea-config` + `postject` two-step injection flow on
  pre-v25.5 Node).
- **By default the injected main script can only load Node builtins** —
  loading filesystem/npm modules from a SEA requires
  `require = createRequire(__filename)`. Since `src/server.mjs`'s own
  module graph is **multiple separate `.mjs` files with plain relative
  ESM imports** (§2.2), a real, additional bundling step (e.g. `esbuild`
  producing one self-contained output file) would be required before
  `--build-sea` could embed it — a new build-tool dependency this repo
  does not use anywhere today.
- **Two of `src/server.mjs`'s own dynamic `await import()` call sites**
  (`src/engine.mjs`'s `./layers/code-graph.mjs`/`./merge.mjs`,
  `src/server.mjs`'s own `./layers/code-graph.mjs`, confirmed by direct
  grep) collide with SEA's documented `useCodeCache: true` restriction
  ("`import()` does not work with code cache enabled") — solvable
  (`useCodeCache: false`, the non-default/off setting), but a real,
  additional constraint (a) doesn't have at all.
- **Native-addon caveat, explicitly documented, and explicitly
  INAPPLICABLE here:** the docs describe a real, documented workaround
  path for bundling a native `.node` addon (e.g. `better-sqlite3`) as an
  embedded asset, extracted to a temp file and `process.dlopen()`'d at
  runtime — real, but moot for this epic, since `src/server.mjs`'s own
  transitive graph has **zero** native addons or npm packages at all
  (§2.2). The task's own original premise ("confirm whether this repo's
  own real dependencies, e.g. `better-sqlite3`'s native bindings, are
  actually SEA/pkg-compatible") is answered directly: `better-sqlite3` is
  not in this specific server's dependency graph at all, so this concern
  does not gate the sidecar decision the way the task assumed going in —
  a real finding, not a rubber-stamp (see design-discussion.md §1 for the
  full weighing this unlocks).
- Platform support: tested and supported on macOS (arm64; x64 explicitly
  noted as skipped in Node's own CI), Windows, and most Linux
  distributions/architectures.

## 5. Validation note

No context7/library lookup was triggered by this research — every claim
above is either (a) a direct file read/grep/shell command against this
real repository, or (b) a direct `WebFetch` of Tauri's own
`v2.tauri.app` documentation, Node.js's own `nodejs.org` API docs, or
Apple's own `support.apple.com` guide, each cited by exact URL above so a
reviewer can re-fetch and re-verify independently. `version_bump: minor`
is chosen because this epic adds a new, additive desktop-packaging
surface with zero changes to any existing HTTP route, CLI verb, or config
schema (confirmed by design — no story in this decomposition modifies
`src/server.mjs`, `src/engine.mjs`, or any other existing file; see
epic.yaml's own `files_to_modify` unions across stories).
