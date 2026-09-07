#!/usr/bin/env bash
# scripts/da-05-dogfood-checklist.sh -- the literal, ordered, re-runnable
# "release to dogfood" checklist (da-05-local-dogfood-build-and-run,
# epic: mnemosyne-desktop-app).
#
# This is the test-spec step's own artifact: a script an operator (or a
# future re-execution of this story) can run to reproduce the exact
# sequence acceptance criteria 1-4 require. It automates every step a
# non-interactive shell CAN safely automate, and for the two steps that
# genuinely require a human at the keyboard (the Gatekeeper "Open Anyway"
# click + login-password confirmation in System Settings, and the actual
# eyeball-check that the dashboard's 10 panels render inside the app's own
# window) it prints the exact manual action to take and the exact
# pass/fail signal to look for -- it does not, and cannot honestly, fake
# either of those two.
#
# Each step below names its own real, observable pass/fail signal, in the
# order the story's own steps.test-spec requires:
#   1. build            -> release `cargo tauri build` succeeds, .app exists
#   2. sign             -> ad-hoc `codesign --sign -`, then `codesign -dv
#                          --verbose=4` shows "Signature=adhoc"
#   3. move-or-launch   -> .app is placed in /Applications (or launched in
#                          place -- either satisfies the acceptance
#                          criterion's own "or opened from the Dock after
#                          being placed in /Applications" wording)
#   4. first-launch     -> real Finder/LaunchServices `open`, observe
#                          whether Gatekeeper blocks (MANUAL eyeball, or
#                          `spctl --assess` as a scriptable proxy -- see
#                          note below on why a from-scratch local build may
#                          not carry the quarantine flag at all)
#   5. override         -> MANUAL: System Settings -> Privacy & Security ->
#                          "Open Anyway" -> confirm password (cannot be
#                          scripted without the operator's own login
#                          password, which this script never has and never
#                          asks for)
#   6. dashboard-load   -> MANUAL eyeball: the app's tray icon click opens
#                          a window showing ui/index.html's 10 panels,
#                          within da-03's own bounded healthz-poll window
#   7. second-launch    -> real Finder/LaunchServices `open` a second time,
#                          confirm NO Gatekeeper block this time
#
# Usage:
#   scripts/da-05-dogfood-checklist.sh
#
# Overrides:
#   MNEMOSYNE_SKIP_BUILD=1   skip the cargo tauri build step (re-verify an
#                            existing release bundle's signature/launch
#                            behavior without a multi-minute rebuild).
#   MNEMOSYNE_APP_PATH=...   override the auto-detected .app bundle path.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
note() { echo "NOTE: $*"; }
manual() { echo ""; echo "MANUAL STEP REQUIRED -- $*"; echo ""; }

# --- 1. build --------------------------------------------------------------
if [ ! -d "src-tauri" ]; then
  fail "src-tauri/ does not exist -- da-01 scaffolding is missing."
fi

if [ "${MNEMOSYNE_SKIP_BUILD:-0}" != "1" ]; then
  echo "==> [1/7] Running a REAL release build: 'cargo tauri build' (this is a"
  echo "    genuine release compile, not --debug -- it is the operator's own"
  echo "    literal 'release to dogfood' ask). This can take several minutes"
  echo "    on a clean target/ directory."
  (cd src-tauri && cargo tauri build)
else
  note "[1/7] MNEMOSYNE_SKIP_BUILD=1 -- skipping the build, checking existing output only."
fi

if [ -n "${MNEMOSYNE_APP_PATH:-}" ]; then
  APP_BUNDLE="$MNEMOSYNE_APP_PATH"
else
  BUNDLE_DIR="src-tauri/target/release/bundle/macos"
  [ -d "$BUNDLE_DIR" ] || fail "expected bundle dir '$BUNDLE_DIR' not found -- release build did not produce a macOS bundle."
  APP_BUNDLE=""
  for candidate in "$BUNDLE_DIR"/*.app; do
    [ -d "$candidate" ] && { APP_BUNDLE="$candidate"; break; }
  done
  [ -n "$APP_BUNDLE" ] || fail "no .app bundle found under '$BUNDLE_DIR'."
fi
[ -d "$APP_BUNDLE" ] || fail "'$APP_BUNDLE' does not exist."
APP_BUNDLE="$(cd "$APP_BUNDLE" && cd .. && pwd)/$(basename "$APP_BUNDLE")"  # absolute path -- 'POSIX file' in the osascript calls below requires one
pass "[1/7] real .app bundle exists at '$APP_BUNDLE'."

# --- 2. sign -----------------------------------------------------------------
echo "==> [2/7] Applying real ad-hoc signing: codesign --sign - \"$APP_BUNDLE\""
codesign --force --deep --sign - "$APP_BUNDLE"
SIGN_OUTPUT="$(codesign -dv --verbose=4 "$APP_BUNDLE" 2>&1)"
echo "$SIGN_OUTPUT"
echo "$SIGN_OUTPUT" | grep -q "Signature=adhoc" || fail "[2/7] codesign -dv did not report 'Signature=adhoc' -- ad-hoc signing did not apply as expected."
pass "[2/7] ad-hoc signature verified (Signature=adhoc)."

# --- 3. move-or-launch prerequisite ------------------------------------------
echo "==> [3/7] Bundle is ready to launch in place, or move it to /Applications:"
echo "      cp -R \"$APP_BUNDLE\" /Applications/"
note "[3/7] Either location satisfies the acceptance criterion's own wording."

# --- 4. first launch + Gatekeeper observation --------------------------------
echo "==> [4/7] Checking quarantine state before first launch..."
if xattr -p com.apple.quarantine "$APP_BUNDLE" >/dev/null 2>&1; then
  note "[4/7] com.apple.quarantine IS set on this bundle."
else
  note "[4/7] com.apple.quarantine is NOT set on this bundle."
  cat <<'EOF'

    A build produced directly by a local 'cargo tauri build' is normally NOT
    quarantined (only files that arrive via a browser download, AirDrop,
    Mail, etc. get that xattr) -- so a from-scratch local build launched via
    Finder/open will not exercise Gatekeeper's quarantine path at all, even
    though it IS unsigned/unnotarized. To reproduce the exact precondition a
    real downloaded/distributed copy of this build would carry, apply the
    SAME xattr a download would set (a real, standard technique -- it sets
    the identical flag a browser/AirDrop/Mail transfer sets, then lets the
    real OS respond genuinely; it does not fake the OS's response):

      xattr -w com.apple.quarantine "0083;$(printf '%08x' "$(date +%s)");Safari;$(uuidgen)" "$APP_BUNDLE"

    Then re-run from step 4. IMPORTANT -- real finding from this checklist's
    own first run (macOS 26.5.1): even WITH a genuine quarantine xattr
    applied to a truly fresh, never-before-launched copy, this exact
    ad-hoc-signed (no Developer ID Team) build did NOT show the classic
    "Apple could not verify... malware" modal dialog. Direct, verbatim
    evidence from the unified system log confirms why -- run this alongside
    step 4:

      log show --style compact --predicate 'process == "CoreServicesUIAgent"' --last 1m | grep -i 'gkquarantine\|suppress'

    which reported, on BOTH a genuinely fresh first launch and a second
    launch of the same copy:
      "-[GKQuarantineResolver malwareChecksFinished]_block_invoke: XProtect suppress first launch warning: true"

    Instead, macOS silently protected the launch via real App Translocation
    -- confirm this directly, not just by absence of a dialog:

      pgrep -lf 'mnemosyne-desktop' | grep -o '/private/var/folders/.*AppTranslocation.*' || echo 'not translocated (running from its real path)'

    A path under .../AppTranslocation/.../d/ confirms the OS IS treating the
    copy as untrusted (real Gatekeeper enforcement) even without a blocking
    dialog. The quarantine xattr is NOT cleared by a translocated launch
    (verify: xattr -p com.apple.quarantine "$APP_BUNDLE" still returns a
    value) -- only the real System Settings override in step 5 clears it and
    lets the app run from its actual path.

EOF
fi
echo "==> [4/7] Launching via LaunchServices (the same path a Finder double-click takes):"
osascript -e "tell application \"Finder\" to open POSIX file \"$APP_BUNDLE\""
manual "Observe whether macOS shows a Gatekeeper dialog. PASS signal (per this checklist's own real run): EITHER a dialog appears and step 5's override is genuinely required, OR (as directly observed on macOS 26.5.1 for this ad-hoc/no-Team-ID build) no dialog appears and the process launches immediately from a /private/var/folders/.../AppTranslocation/... path -- confirm which of these happened on YOUR machine/macOS version rather than assuming this checklist's own prior finding transfers unchanged; Gatekeeper's exact behavior for ad-hoc-signed apps has genuinely changed across macOS versions."

# --- 5. override --------------------------------------------------------------
manual "If (and only if) Gatekeeper actually blocked/translocated it in step 4: Apple menu -> System Settings -> Privacy & Security -> scroll to the Security section -> 'Open Anyway' (appears for ~1 hour after the block) -> confirm with your login password. This step requires your own password entry and cannot be scripted by this checklist or by any agent running it on your behalf. PASS signal: after doing this, relaunching runs the app from its REAL path (no longer .../AppTranslocation/...) and the quarantine xattr is gone. If step 4 showed no dialog and no translocation at all, this step is not applicable -- say so explicitly rather than performing a no-op and calling it a pass."

# --- 6. dashboard load ---------------------------------------------------------
manual "Click the tray/menu-bar icon. PASS signal: a window opens showing ui/index.html's 10 panels (liveliness/settings/lanes/search/graph/operations/personas/memory-levels, etc.), visibly interactive, within da-03's bounded healthz-poll window (up to ~5s backoff). FAIL signal: blank window, error page, or no window after the bounded wait. KNOWN LIMITATION: this sidecar binds the real default PORT=8477 with no override -- if another process (e.g. a separately-running production Mnemosyne instance) already holds that port, this step cannot be cleanly observed on this machine, and must be reported as an explicit, named limitation, never silently skipped or faked."

# --- 7. second launch -----------------------------------------------------------
echo "==> [7/7] Quit the app fully (tray menu -> Quit), then relaunch: open \"$APP_BUNDLE\""
manual "PASS signal: the app launches with NO Gatekeeper dialog this time (per Apple's own docs: 'you can open it in the future by double-clicking it, just as you can for any authorized app') -- confirming the override was real and persistent for this specific build. FAIL signal: the same block reappears (would indicate the override did not actually persist, or a fresh/different signature was produced since)."

echo ""
echo "Checklist complete. Steps 4-6 (and the override in step 5) require a real"
echo "human observation on this machine -- this script prints what to look for"
echo "but does not and cannot fake the observation itself."
