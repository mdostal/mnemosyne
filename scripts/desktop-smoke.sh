#!/usr/bin/env bash
# scripts/desktop-smoke.sh -- Tauri desktop app build-and-launch smoke check
# (da-01-tauri-project-scaffolding, epic: mnemosyne-desktop-app)
#
# This is the concrete, re-runnable proof da-01's own acceptance criteria
# require: a REAL (not mocked) debug `cargo tauri build` that produces a
# REAL .app bundle on disk with a non-zero size. It intentionally does not
# attempt to launch the built .app (no headless-display assumptions) --
# `cargo tauri dev`'s own "does a window open" check is a separate, manual
# verification step documented in this story's own review notes, since a
# GUI window cannot be asserted on from a non-interactive script running in
# a possibly headless/sandboxed environment.
#
# What this script does:
#   1. Confirms `src-tauri/` exists (fails loudly, not silently, if this
#      story's scaffold hasn't been created yet -- this is exactly the
#      "write the test before the implementation" TDD failure this story's
#      own test-spec step requires).
#   2. Runs a debug `cargo tauri build` (via the repo's own devDependency
#      `@tauri-apps/cli`, `npx tauri build --debug`) from the repo root.
#   3. Locates the resulting macOS `.app` bundle under
#      `src-tauri/target/debug/bundle/macos/*.app` and asserts it exists
#      and has non-zero size.
#
# Exit codes: 0 on success (bundle found, non-zero size). Non-zero on any
# failure, with a specific stderr message naming which step failed.
#
# Usage:
#   scripts/desktop-smoke.sh
#
# Overrides (mainly for isolated testing):
#   MNEMOSYNE_SKIP_BUILD=1   skip the actual `cargo tauri build` invocation
#                            and only run the bundle-existence assertion
#                            against whatever build output already exists
#                            (used to re-verify a prior build's output
#                            without re-running a multi-minute Cargo build).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [ ! -d "src-tauri" ]; then
  echo "FAIL: src-tauri/ does not exist yet -- run the Tauri scaffolding step first." >&2
  exit 1
fi

if [ ! -f "src-tauri/Cargo.toml" ] || [ ! -f "src-tauri/tauri.conf.json" ]; then
  echo "FAIL: src-tauri/Cargo.toml and/or src-tauri/tauri.conf.json missing -- scaffold is incomplete." >&2
  exit 1
fi

if [ "${MNEMOSYNE_SKIP_BUILD:-0}" != "1" ]; then
  echo "==> Running debug 'cargo tauri build' via 'npx tauri build --debug' (this can take several minutes on a first build)..."
  START_TS=$(date +%s)
  npx tauri build --debug
  END_TS=$(date +%s)
  echo "==> Build finished in $((END_TS - START_TS))s."
else
  echo "==> MNEMOSYNE_SKIP_BUILD=1 set -- skipping the actual build, checking existing output only."
fi

BUNDLE_GLOB="src-tauri/target/debug/bundle/macos"
if [ ! -d "$BUNDLE_GLOB" ]; then
  echo "FAIL: expected bundle directory '$BUNDLE_GLOB' does not exist -- build did not produce a macOS bundle." >&2
  exit 1
fi

APP_BUNDLE=""
for candidate in "$BUNDLE_GLOB"/*.app; do
  if [ -d "$candidate" ]; then
    APP_BUNDLE="$candidate"
    break
  fi
done

if [ -z "$APP_BUNDLE" ]; then
  echo "FAIL: no .app bundle found under '$BUNDLE_GLOB'." >&2
  exit 1
fi

BUNDLE_SIZE_BYTES=$(du -sk "$APP_BUNDLE" | cut -f1)
if [ -z "$BUNDLE_SIZE_BYTES" ] || [ "$BUNDLE_SIZE_BYTES" -le 0 ]; then
  echo "FAIL: '$APP_BUNDLE' has zero size." >&2
  exit 1
fi

echo "PASS: real .app bundle found at '$APP_BUNDLE' (${BUNDLE_SIZE_BYTES}KB)."
exit 0
