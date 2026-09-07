// tray.rs — da-03-tray-shell-and-dashboard-window: the tray/menu-bar icon,
// the lazily-created dashboard window, and the launch-at-login toggle.
//
// See .pHive/epics/mnemosyne-desktop-app/stories/da-03-tray-shell-and-dashboard-window.yaml
// for the full acceptance criteria this module exists to satisfy. Summary:
//
//   AC1: on tray-icon left-click, when the dashboard window doesn't exist
//        yet, poll GET /healthz with a bounded backoff (never a single
//        immediate attempt, never an unbounded retry) BEFORE creating it.
//   AC2: the window's loaded URL is exactly http://127.0.0.1:<PORT>/ui,
//        never a bare http://127.0.0.1:<PORT>/, PORT sourced from da-02's
//        own sidecar::DEFAULT_PORT (never re-guessed here).
//   AC3: a second left-click while the window already exists shows/focuses
//        THAT window -- never creates a second one.
//   AC4: tauri-plugin-autostart wired with MacosLauncher::LaunchAgent behind
//        a real, visible, operator-toggleable tray-menu checkbox (default
//        on, but never a silent forced-on service with no real off switch).
//
// da-04-auto-updater-wiring adds one more real, visible, operator-toggleable
// checkbox to this SAME menu: "Check for Updates" (updater.rs's own
// `UPDATER_ENABLED_MARKER_FILENAME`-backed setting) -- deliberately the
// OPPOSITE default of AC4's autostart checkbox: unchecked/OFF on a fresh
// install, never on-by-default (the operator's own explicit instruction,
// resolving design-discussion.md §7's open question 1). See updater.rs's
// own doc comment for the full "zero network calls while off" gate this
// checkbox's on_menu_event handler routes through.
//
// Kept free of any actual `tauri::Builder`/`.setup()` wiring itself (that
// lives in lib.rs) so the pieces here are directly unit- and
// integration-testable: `dashboard_url`/`poll_with_backoff` are pure,
// `show_or_create_dashboard_window`/`build_tray` are generic over
// `tauri::Runtime` so tests can drive them against `tauri::test::MockRuntime`
// (see tests/tray_window.rs) -- the REAL production functions, not
// hand-written stand-ins.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::time::{Duration, Instant};

use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::ManagerExt;

use crate::updater;

/// The label of the single dashboard window this story ever creates. Never
/// declared as a static window in tauri.conf.json -- this app launches as a
/// tray-only "background... service, not necessarily a full window a user
/// stares at" (the operator's own words, story description) -- the window
/// is created lazily, exactly once, the first time the tray icon is
/// left-clicked.
pub const WINDOW_LABEL: &str = "dashboard";

const LAUNCH_AT_LOGIN_MENU_ID: &str = "launch_at_login";
const CHECK_FOR_UPDATES_MENU_ID: &str = "check_for_updates";
const QUIT_MENU_ID: &str = "quit";

/// The marker file recording "the autostart default has already been
/// applied once" -- see `should_apply_autostart_default`'s own doc comment
/// for why this exists at all.
const AUTOSTART_DEFAULT_MARKER_FILENAME: &str = ".da-03-autostart-default-applied";

/// Bounded backoff shape for the healthz poll (design-discussion.md §3.2's
/// own "up to ~5s, a handful of retries"): genuinely bounded (never an
/// unbounded retry) and genuinely retried (never a single immediate
/// attempt), with the interval itself growing -- a real backoff, not a bare
/// fixed-interval loop -- up to a cap, so a persistently-slow sidecar
/// doesn't spin the tray-click handler in a hot loop.
const HEALTHZ_POLL_BOUND: Duration = Duration::from_secs(5);
const HEALTHZ_POLL_INITIAL_INTERVAL: Duration = Duration::from_millis(100);
const HEALTHZ_POLL_MAX_INTERVAL: Duration = Duration::from_millis(500);

/// The dashboard URL this story's window navigates to -- exactly
/// `http://127.0.0.1:<port>/ui`, NEVER a bare `http://127.0.0.1:<port>/`
/// (src/server.mjs's own `GET /` content-negotiates that root path
/// differently for non-browser callers -- see server.mjs's own doc comment,
/// lines 1-56). `port` must always be sourced from da-02's own
/// `sidecar::DEFAULT_PORT` / sidecar-spawn Command by this function's
/// caller, never re-guessed as an independent hard-coded literal in here.
pub fn dashboard_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/ui")
}

/// A minimal, dependency-free raw-TCP GET, deliberately mirroring
/// tests/sidecar_path_fix.rs's own `tiny_http_get` (same rationale: avoid
/// pulling in an HTTP-client crate for a handful of GETs). Returns the HTTP
/// status code, or `None` if the connection/request itself failed (the
/// port isn't listening yet -- the exact, expected shape of "sidecar not
/// ready").
fn tiny_http_get_status(port: u16, path: &str) -> Option<u16> {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    stream.set_write_timeout(Some(Duration::from_secs(2))).ok()?;
    let request =
        format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).ok()?;
    let mut raw = String::new();
    stream.read_to_string(&mut raw).ok()?;
    let status_line = raw.lines().next()?;
    status_line.split_whitespace().nth(1)?.parse().ok()
}

/// Bounded, backing-off poll: calls `check` immediately, then retries with a
/// growing (never-unbounded) interval until either `check` returns `true`
/// or `total_bound` elapses. Returns whether it succeeded. Generic over
/// `check` (rather than hard-coding the healthz GET inline) so this shape
/// itself is directly unit-testable against a real, deliberately
/// slow-to-start TCP listener with no Tauri app context required at all
/// (see tests/tray_window.rs).
pub fn poll_with_backoff<F: FnMut() -> bool>(
    mut check: F,
    total_bound: Duration,
    initial_interval: Duration,
    max_interval: Duration,
) -> bool {
    let deadline = Instant::now() + total_bound;
    let mut interval = initial_interval;
    loop {
        if check() {
            return true;
        }
        let now = Instant::now();
        if now >= deadline {
            return false;
        }
        std::thread::sleep(interval.min(deadline - now));
        interval = (interval * 2).min(max_interval);
    }
}

/// Polls `GET http://127.0.0.1:<port>/healthz` with the bounded backoff
/// above -- this story's own closing of the real, previously-unnamed
/// startup race (grill-record.md finding 2.2, design-discussion.md §3.2)
/// between the sidecar's own HTTP listener coming up and the dashboard
/// window navigating to it. A `false` return (bound exceeded) is logged
/// loudly by the caller and is NOT treated as fatal here -- the window is
/// still created/navigated afterward (cross_cutting: loud-failure -- a
/// real, persistent sidecar failure surfaces as a real browser-level
/// connection error rather than an app that hangs the tray forever).
fn wait_for_sidecar_healthz(port: u16) -> bool {
    poll_with_backoff(
        || matches!(tiny_http_get_status(port, "/healthz"), Some(200)),
        HEALTHZ_POLL_BOUND,
        HEALTHZ_POLL_INITIAL_INTERVAL,
        HEALTHZ_POLL_MAX_INTERVAL,
    )
}

/// Shows/focuses the existing dashboard window (acceptance criterion 3:
/// never a second window), or -- on the very first call -- waits for the
/// sidecar's `/healthz` (bounded backoff, acceptance criterion 1) and then
/// creates it, navigated to exactly `dashboard_url(port)` (acceptance
/// criterion 2). Generic over `Runtime` so tests can drive this against
/// `tauri::test::MockRuntime` -- exercising the REAL production function,
/// not a hand-written stand-in (see tests/tray_window.rs).
pub fn show_or_create_dashboard_window<R: Runtime>(
    app: &AppHandle<R>,
    port: u16,
) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        window.show()?;
        window.set_focus()?;
        return Ok(());
    }

    if !wait_for_sidecar_healthz(port) {
        log::warn!(
            "[da-03] GET /healthz never returned 200 within the {HEALTHZ_POLL_BOUND:?} bound -- creating the dashboard window anyway (a bounded, not unbounded, wait)"
        );
    }

    let url = dashboard_url(port);
    let parsed_url = url
        .parse()
        .expect("dashboard_url() must always produce a valid URL");
    let window = WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::External(parsed_url))
        .title("Mnemosyne Desktop")
        .inner_size(800.0, 600.0)
        .build()?;
    window.show()?;
    window.set_focus()?;
    Ok(())
}

/// Whether this launch should apply the "default on" autostart behavior
/// (story description: "default on, matching 'run long term'"). True only
/// if the marker file recording "the default has already been applied" is
/// absent -- so a user who explicitly disables launch-at-login stays
/// disabled on the next launch (never a silent forced-on service with no
/// real off switch, story's own design_decisions), while a genuinely fresh
/// install still gets the intended default. Pure/testable: takes the
/// marker path in, does the one fs check, performs no side effect itself --
/// kept separate from the actual `enable()` call so the "apply the default
/// exactly once, ever" logic is unit-testable without a real launchd
/// registration in tests.
fn should_apply_autostart_default(marker_path: &Path) -> bool {
    !marker_path.exists()
}

/// Builds and shows the tray/menu-bar icon: left-click shows/focuses (or,
/// on first click, creates) the dashboard window (see
/// `show_or_create_dashboard_window`); the attached menu (right-click /
/// platform-secondary-click) carries a real, visible, operator-toggleable
/// "Launch at Login" checkbox item plus Quit.
/// `.show_menu_on_left_click(false)` is what makes left-click reach
/// `on_tray_icon_event` instead of popping the menu.
pub fn build_tray<R: Runtime>(app: &AppHandle<R>, port: u16) -> tauri::Result<()> {
    if let Ok(app_data_dir) = app.path().app_data_dir() {
        let marker_path = app_data_dir.join(AUTOSTART_DEFAULT_MARKER_FILENAME);
        if should_apply_autostart_default(&marker_path) {
            if let Err(e) = app.autolaunch().enable() {
                log::warn!("[da-03] failed to apply the default-on launch-at-login: {e}");
            }
            if let Err(e) = std::fs::create_dir_all(&app_data_dir) {
                log::warn!("[da-03] failed to create app data dir for the autostart-default marker: {e}");
            } else if let Err(e) = std::fs::write(&marker_path, b"1") {
                log::warn!("[da-03] failed to write the autostart-default marker: {e}");
            }
        }
    }
    let launch_at_login_checked = app.autolaunch().is_enabled().unwrap_or(true);

    let launch_at_login_item =
        CheckMenuItemBuilder::with_id(LAUNCH_AT_LOGIN_MENU_ID, "Launch at Login")
            .checked(launch_at_login_checked)
            .build(app)?;

    // da-04-auto-updater-wiring: the operator's own opt-in toggle, default
    // UNCHECKED/OFF (updater::is_updater_enabled reads `false` whenever the
    // marker file is absent, which it always is on a fresh install -- unlike
    // launch-at-login above, there is no default-application step here at
    // all, deliberately: this setting is never turned on except by the
    // operator's own explicit click).
    let updater_marker_path = app
        .path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join(updater::UPDATER_ENABLED_MARKER_FILENAME));
    let updater_enabled = updater_marker_path
        .as_deref()
        .map(updater::is_updater_enabled)
        .unwrap_or(false);

    let check_for_updates_item =
        CheckMenuItemBuilder::with_id(CHECK_FOR_UPDATES_MENU_ID, "Check for Updates")
            .checked(updater_enabled)
            .build(app)?;
    let quit_item = MenuItemBuilder::with_id(QUIT_MENU_ID, "Quit").build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&launch_at_login_item)
        .item(&check_for_updates_item)
        .separator()
        .item(&quit_item)
        .build()?;

    // Cadence (documented, not left implicit -- README.md/SERVICE.md carry
    // the same note): fires the real update-check once per app launch, ONLY
    // if the operator already had this enabled from a previous session. The
    // on_menu_event handler below fires a second, independent trigger point
    // -- immediately, the moment the operator toggles it ON at runtime --
    // so turning it on doesn't silently wait for the next relaunch. Both
    // trigger points route through the exact same
    // `updater::maybe_trigger_update_check` gate that the zero-calls-while-
    // off test in updater.rs proves fires nothing when disabled.
    {
        let app_for_launch_check = app.clone();
        updater::maybe_trigger_update_check(updater_enabled, move || {
            tauri::async_runtime::spawn(async move {
                updater::spawn_update_check(&app_for_launch_check).await;
            });
        });
    }

    TrayIconBuilder::new()
        .icon(
            app.default_window_icon()
                .cloned()
                .expect("bundle.icon must be configured in tauri.conf.json"),
        )
        .tooltip("Mnemosyne Desktop")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            LAUNCH_AT_LOGIN_MENU_ID => {
                let manager = app.autolaunch();
                let currently_enabled = manager.is_enabled().unwrap_or(false);
                let toggle_result = if currently_enabled {
                    manager.disable()
                } else {
                    manager.enable()
                };
                if let Err(e) = toggle_result {
                    log::error!("[da-03] failed to toggle launch-at-login: {e}");
                }
                let now_enabled = manager.is_enabled().unwrap_or(currently_enabled);
                if let Err(e) = launch_at_login_item.set_checked(now_enabled) {
                    log::error!("[da-03] failed to update the launch-at-login menu checkbox: {e}");
                }
            }
            CHECK_FOR_UPDATES_MENU_ID => {
                let Ok(app_data_dir) = app.path().app_data_dir() else {
                    log::error!(
                        "[da-04] failed to resolve app_data_dir -- cannot persist the \
                         Check-for-Updates toggle, leaving it unchanged"
                    );
                    return;
                };
                let marker_path =
                    app_data_dir.join(updater::UPDATER_ENABLED_MARKER_FILENAME);
                let currently_enabled = updater::is_updater_enabled(&marker_path);
                let now_enabled = !currently_enabled;
                if let Err(e) = updater::set_updater_enabled(&marker_path, now_enabled) {
                    log::error!("[da-04] failed to persist the Check-for-Updates toggle: {e}");
                    return;
                }
                if let Err(e) = check_for_updates_item.set_checked(now_enabled) {
                    log::error!("[da-04] failed to update the Check-for-Updates menu checkbox: {e}");
                }
                // Fire the real check immediately on toggle-ON (this
                // module's own documented cadence, alongside the
                // once-per-launch trigger above) -- routes through the
                // exact same zero-calls-while-off gate.
                let app_for_toggle_check = app.clone();
                updater::maybe_trigger_update_check(now_enabled, move || {
                    tauri::async_runtime::spawn(async move {
                        updater::spawn_update_check(&app_for_toggle_check).await;
                    });
                });
            }
            QUIT_MENU_ID => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(move |tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Err(e) = show_or_create_dashboard_window(app, port) {
                    log::error!("[da-03] failed to show/create the dashboard window: {e}");
                }
            }
        })
        .build(app)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    #[test]
    fn dashboard_url_is_exactly_port_slash_ui_never_bare_root() {
        assert_eq!(dashboard_url(8477), "http://127.0.0.1:8477/ui");
        assert_ne!(dashboard_url(8477), "http://127.0.0.1:8477/");
    }

    #[test]
    fn dashboard_url_is_built_from_whatever_port_the_sidecar_actually_used() {
        // Never an independently hard-coded 8477 in dashboard_url() itself
        // -- proven by exercising a different port and getting a different,
        // correctly-shaped URL back.
        assert_eq!(dashboard_url(18590), "http://127.0.0.1:18590/ui");
        assert_eq!(
            dashboard_url(crate::sidecar::DEFAULT_PORT),
            "http://127.0.0.1:8477/ui"
        );
    }

    #[test]
    fn poll_with_backoff_is_not_a_single_immediate_attempt() {
        let attempts = Arc::new(AtomicBool::new(false));
        let mut call_count = 0u32;
        let ok = poll_with_backoff(
            || {
                call_count += 1;
                attempts.store(true, Ordering::SeqCst);
                call_count >= 3
            },
            Duration::from_secs(2),
            Duration::from_millis(10),
            Duration::from_millis(50),
        );
        assert!(ok, "expected the check to eventually succeed");
        assert!(
            call_count >= 3,
            "expected at least 3 checks (a real retry loop), got {call_count}"
        );
    }

    #[test]
    fn poll_with_backoff_gives_up_within_the_bound_never_unbounded() {
        let start = Instant::now();
        let ok = poll_with_backoff(
            || false,
            Duration::from_millis(300),
            Duration::from_millis(20),
            Duration::from_millis(100),
        );
        let elapsed = start.elapsed();
        assert!(!ok, "a check that never succeeds must return false");
        assert!(
            elapsed < Duration::from_secs(2),
            "poll_with_backoff must give up near its bound, not hang -- took {elapsed:?}"
        );
    }

    /// THE core proof of acceptance criterion 1: a real, deliberately
    /// slow-to-start TCP listener (nothing listens on the port for an
    /// initial delay, exactly modeling the sidecar's own real
    /// listen()-not-yet-called startup window) -- `wait_for_sidecar_healthz`
    /// must genuinely wait for it, not report success immediately.
    #[test]
    fn wait_for_sidecar_healthz_genuinely_waits_for_a_slow_to_start_real_server() {
        let port = 18590;
        let startup_delay = Duration::from_millis(600);
        std::thread::spawn(move || {
            std::thread::sleep(startup_delay);
            let listener = TcpListener::bind(("127.0.0.1", port))
                .expect("stand-in server must be able to bind its port");
            for stream in listener.incoming() {
                let mut stream = match stream {
                    Ok(s) => s,
                    Err(_) => continue,
                };
                let body = "ok";
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });

        let start = Instant::now();
        let healthy = wait_for_sidecar_healthz(port);
        let elapsed = start.elapsed();

        assert!(healthy, "the stand-in server does come up -- this must report healthy");
        assert!(
            elapsed >= startup_delay,
            "wait_for_sidecar_healthz returned after {elapsed:?}, before the real {startup_delay:?} startup delay elapsed -- it did not genuinely wait"
        );
        assert!(
            elapsed < HEALTHZ_POLL_BOUND,
            "must succeed comfortably inside the bound once the server is actually up, took {elapsed:?}"
        );
    }

    /// The negative control: a port nothing ever listens on must report
    /// unhealthy, and must do so within (not past) the bounded backoff --
    /// proving the "not an unbounded retry" half of acceptance criterion 1.
    #[test]
    fn wait_for_sidecar_healthz_gives_up_when_nothing_ever_listens() {
        let port = 18591;
        let start = Instant::now();
        let healthy = wait_for_sidecar_healthz(port);
        let elapsed = start.elapsed();

        assert!(!healthy, "nothing is listening on this port; must report unhealthy");
        assert!(
            elapsed < HEALTHZ_POLL_BOUND + Duration::from_secs(1),
            "must give up at/near the bound, not hang -- took {elapsed:?}"
        );
    }

    #[test]
    fn should_apply_autostart_default_is_true_only_when_the_marker_is_absent() {
        let dir = std::env::temp_dir().join(format!(
            "da-03-autostart-marker-test-{}",
            std::process::id()
        ));
        let _ = std::fs::create_dir_all(&dir);
        let marker = dir.join(AUTOSTART_DEFAULT_MARKER_FILENAME);
        let _ = std::fs::remove_file(&marker);

        assert!(
            should_apply_autostart_default(&marker),
            "a fresh install (no marker yet) must apply the default"
        );

        std::fs::write(&marker, b"1").expect("test setup: write marker");
        assert!(
            !should_apply_autostart_default(&marker),
            "once the marker exists, the default must never be re-applied -- \
             otherwise an operator's own explicit 'off' choice would be \
             silently overwritten on the next launch"
        );

        let _ = std::fs::remove_file(&marker);
        let _ = std::fs::remove_dir(&dir);
    }
}
