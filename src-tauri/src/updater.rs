// updater.rs — da-04-auto-updater-wiring: the OPERATOR'S OWN OPT-IN toggle
// for tauri-plugin-updater (design-discussion.md §7's open question 1,
// resolved this session by the operator's own explicit instruction: default
// OFF, never on-by-default -- the deliberate OPPOSITE of da-03's own
// autostart default).
//
// This module owns exactly two things, kept pure/testable the same way
// sidecar.rs keeps da-02's own env/arg construction pure and tray.rs keeps
// `should_apply_autostart_default`/`poll_with_backoff` pure:
//
//   1. Persisting the operator's own toggle choice (`is_updater_enabled`/
//      `set_updater_enabled`) -- a marker file under the app's own
//      `app_data_dir`, mirroring da-03's own
//      `AUTOSTART_DEFAULT_MARKER_FILENAME` presence/absence mechanism.
//      Absence (a fresh install) means DISABLED -- never enabled-by-default.
//   2. Gating every possible real update-check call site through ONE
//      function (`maybe_trigger_update_check`) that fires an injected
//      closure if and only if the setting is on. Every real call site that
//      could ever ask tauri-plugin-updater to check (app-launch, a future
//      periodic timer, the menu toggle itself) MUST route through this
//      function -- never call `tauri_plugin_updater::UpdaterExt::updater()`
//      directly anywhere else. This is what makes "zero network calls while
//      off" a provable property of the CODE (see the tests below, which
//      assert on a real call-counting closure) rather than a policy
//      statement resting on the implementer's own self-report.
//
// The actual `app.updater()?.check().await?` call (`spawn_update_check`,
// bottom of this file) is deliberately the ONE non-pure, non-unit-tested
// piece here -- it needs a real Tauri AppHandle and would make a real
// network request if exercised, so no test calls it directly. Its only
// caller is tray.rs's `build_tray`, and only ever from inside the
// `maybe_trigger_update_check` gate.

use std::path::Path;

/// The marker file recording the operator's own current opt-in choice.
/// PRESENCE = enabled, ABSENCE = disabled. A fresh install has no file, so
/// it starts DISABLED -- the required, safe default (opposite of da-03's
/// own `AUTOSTART_DEFAULT_MARKER_FILENAME`, which records "the default was
/// already applied" for a setting that itself defaults ON).
pub const UPDATER_ENABLED_MARKER_FILENAME: &str = ".da-04-updater-enabled";

/// Reads the current opt-in state directly from the marker file's presence
/// -- pure/testable: one fs check, no side effect, no Tauri context
/// required. Never defaults to `true` on any error path (a missing file, a
/// permissions error, anything else all read as "disabled") -- the fail-safe
/// direction for a setting that must never be on without the operator's own
/// explicit toggle.
pub fn is_updater_enabled(marker_path: &Path) -> bool {
    marker_path.exists()
}

/// Persists the operator's own toggle choice: creates the marker file to
/// turn checks on, removes it to turn them off (removing an
/// already-absent file is not an error -- toggling "off" twice in a row is
/// a legitimate, idempotent no-op, not a failure).
pub fn set_updater_enabled(marker_path: &Path, enabled: bool) -> std::io::Result<()> {
    if enabled {
        if let Some(parent) = marker_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(marker_path, b"1")
    } else {
        match std::fs::remove_file(marker_path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        }
    }
}

/// THE single gate between "the operator's own persisted setting" and "a
/// real update-check fires": calls `trigger()` if and only if `enabled` is
/// true, otherwise does nothing at all. Generic over `trigger` (rather than
/// hard-coding the real `tauri_plugin_updater` call inline) specifically so
/// this guarantee -- zero calls while disabled -- is provable with a plain
/// call-counting closure and zero Tauri/network machinery, per the
/// operator's own explicit instruction this session to prove it, not just
/// assert it.
pub fn maybe_trigger_update_check<F: FnOnce()>(enabled: bool, trigger: F) {
    if enabled {
        trigger();
    }
}

/// The real, non-pure production trigger: fires tauri-plugin-updater's own
/// `check()` call exactly once, logging (never panicking on, never
/// silently swallowing -- cross_cutting: loud-failure) whatever it finds or
/// fails with. Deliberately NOT unit-tested here (it needs a real
/// AppHandle with the updater plugin registered, and calling it for real
/// makes a real network request) -- its only caller is tray.rs's
/// `build_tray`, and ALWAYS from behind `maybe_trigger_update_check`'s own
/// `enabled` gate, never on its own.
///
/// Scope, named explicitly: this checks for an update and logs the
/// result. It does not download/install one automatically -- the
/// operator's own instruction this session asked for the CHECK to be wired
/// on toggle-on, not for unattended auto-install; a future decision, not
/// silently assumed here.
pub async fn spawn_update_check<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri_plugin_updater::UpdaterExt;
    match app.updater() {
        Ok(updater) => match updater.check().await {
            Ok(Some(update)) => {
                log::info!(
                    "[da-04] update available: {} (current: {})",
                    update.version,
                    update.current_version
                );
            }
            Ok(None) => log::info!("[da-04] update check ran: already up to date"),
            Err(e) => log::warn!("[da-04] update check failed: {e}"),
        },
        Err(e) => log::warn!("[da-04] updater plugin unavailable: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_marker_path(test_name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "da-04-updater-marker-test-{test_name}-{}",
            std::process::id()
        ));
        let _ = std::fs::create_dir_all(&dir);
        dir.join(UPDATER_ENABLED_MARKER_FILENAME)
    }

    #[test]
    fn is_updater_enabled_defaults_to_false_on_a_fresh_install_no_marker_file() {
        let marker = temp_marker_path("fresh-install");
        let _ = std::fs::remove_file(&marker);

        assert!(
            !is_updater_enabled(&marker),
            "a fresh install (no marker file yet) must default the updater to DISABLED -- \
             never on-by-default, the opposite of da-03's own autostart default"
        );
    }

    #[test]
    fn set_updater_enabled_true_then_false_round_trips_through_real_fs_state() {
        let marker = temp_marker_path("round-trip");
        let _ = std::fs::remove_file(&marker);

        assert!(!is_updater_enabled(&marker), "precondition: starts disabled");

        set_updater_enabled(&marker, true).expect("enabling must succeed");
        assert!(
            is_updater_enabled(&marker),
            "after set_updater_enabled(true), the marker must exist and read as enabled"
        );

        set_updater_enabled(&marker, false).expect("disabling must succeed");
        assert!(
            !is_updater_enabled(&marker),
            "after set_updater_enabled(false), the marker must be gone and read as disabled"
        );

        let _ = std::fs::remove_file(&marker);
    }

    #[test]
    fn set_updater_enabled_false_when_already_disabled_is_an_idempotent_no_op() {
        let marker = temp_marker_path("idempotent-off");
        let _ = std::fs::remove_file(&marker);

        set_updater_enabled(&marker, false).expect(
            "disabling an already-disabled (never-enabled) setting must not error -- \
             it's a legitimate idempotent no-op, not a failure",
        );
        assert!(!is_updater_enabled(&marker));
    }

    /// THE core proof this story's additional requirement demands: with the
    /// setting OFF, the real gate function must invoke the trigger ZERO
    /// times -- not "usually zero," not "zero unless something races,"
    /// exactly zero, every time, deterministically.
    #[test]
    fn maybe_trigger_update_check_fires_zero_times_when_disabled() {
        let mut call_count = 0u32;
        maybe_trigger_update_check(false, || call_count += 1);
        assert_eq!(
            call_count, 0,
            "the update-check trigger must NEVER fire while the setting is off -- this is the \
             concrete proof that no real network request can occur while disabled"
        );
    }

    #[test]
    fn maybe_trigger_update_check_fires_exactly_once_when_enabled() {
        let mut call_count = 0u32;
        maybe_trigger_update_check(true, || call_count += 1);
        assert_eq!(
            call_count, 1,
            "the update-check trigger must fire exactly once per gated call when enabled"
        );
    }

    /// A real, end-to-end proof combining both halves of this module: read
    /// the real persisted marker state, then gate the trigger off it --
    /// exactly the sequence `build_tray`'s own production wiring performs,
    /// just with a call-counting stub in place of the real network call.
    #[test]
    fn full_off_path_from_persisted_marker_to_trigger_fires_zero_calls() {
        let marker = temp_marker_path("full-off-path");
        let _ = std::fs::remove_file(&marker);

        let mut call_count = 0u32;
        let enabled = is_updater_enabled(&marker);
        maybe_trigger_update_check(enabled, || call_count += 1);

        assert!(!enabled, "precondition: fresh marker reads as disabled");
        assert_eq!(
            call_count, 0,
            "the full read-marker-then-gate path must fire zero real-trigger calls while off"
        );
    }

    #[test]
    fn full_on_path_from_persisted_marker_to_trigger_fires_exactly_once() {
        let marker = temp_marker_path("full-on-path");
        let _ = std::fs::remove_file(&marker);
        set_updater_enabled(&marker, true).expect("test setup: enable");

        let mut call_count = 0u32;
        let enabled = is_updater_enabled(&marker);
        maybe_trigger_update_check(enabled, || call_count += 1);

        assert!(enabled, "precondition: marker reads as enabled after set_updater_enabled(true)");
        assert_eq!(call_count, 1);

        let _ = std::fs::remove_file(&marker);
    }
}
