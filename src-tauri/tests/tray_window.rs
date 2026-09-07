// tests/tray_window.rs — da-03-tray-shell-and-dashboard-window's own
// integration proof of acceptance criteria 1-3: the healthz-poll-then-load
// sequence, the exact `/ui` URL, and never-a-second-window.
//
// Mirrors da-02's own tests/sidecar_path_fix.rs's posture: real network I/O
// (a real, deliberately slow-to-start TCP listener standing in for the
// sidecar), no mocked HTTP layer -- combined with Tauri's own first-party
// `tauri::test` module (MockRuntime), the officially-supported way to
// exercise REAL window-manager code (window creation, get_webview_window,
// show/set_focus, url()) without a real display/GUI event loop, which this
// sandboxed environment cannot drive interactively. This is NOT a hand-written
// stand-in for tauri's window manager -- `tauri::test` is Tauri's own,
// first-party testing harness for exactly this purpose (see its own module
// docs: "Utilities for unit testing on Tauri applications").
//
// Uses stand-in ports (18590-18599 range, disjoint from da-02's own
// 18581-18583) per this story's own environment instructions -- never the
// real production default 8477, which a real, independently-running
// production Mnemosyne instance already holds on this machine.

use std::io::Write;
use std::net::TcpListener;
use std::time::{Duration, Instant};

use tauri::Manager;

use mnemosyne_desktop_lib::tray;

fn spawn_slow_standin_server(port: u16, startup_delay: Duration) {
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
}

/// Acceptance criteria 1 + 2, exercised against the REAL production
/// `show_or_create_dashboard_window` function (generic over `Runtime`,
/// driven here with `tauri::test::MockRuntime`) and a REAL, deliberately
/// slow-to-start TCP stand-in for the sidecar: the window is not created
/// until the stand-in's real startup delay has genuinely elapsed, and once
/// created its URL is exactly `http://127.0.0.1:<port>/ui`.
#[test]
fn first_click_waits_for_healthz_then_creates_the_window_at_exactly_slash_ui() {
    let port = 18595;
    let startup_delay = Duration::from_millis(600);
    spawn_slow_standin_server(port, startup_delay);

    let app = tauri::test::mock_app();
    let handle = app.handle();

    assert!(
        handle.get_webview_window(tray::WINDOW_LABEL).is_none(),
        "precondition: no dashboard window should exist yet"
    );

    let start = Instant::now();
    tray::show_or_create_dashboard_window(handle, port)
        .expect("show_or_create_dashboard_window must succeed once the stand-in is up");
    let elapsed = start.elapsed();

    assert!(
        elapsed >= startup_delay,
        "the window was created after only {elapsed:?}, before the real {startup_delay:?} \
         stand-in startup delay elapsed -- it did not genuinely wait for /healthz"
    );

    let window = handle
        .get_webview_window(tray::WINDOW_LABEL)
        .expect("the dashboard window must exist after show_or_create_dashboard_window");
    let loaded_url = window.url().expect("window must report its loaded URL");
    assert_eq!(
        loaded_url.as_str(),
        format!("http://127.0.0.1:{port}/ui"),
        "the window's loaded URL must be exactly <PORT>/ui, never a bare <PORT>/"
    );
    assert_ne!(
        loaded_url.as_str(),
        format!("http://127.0.0.1:{port}/"),
        "must never be the bare root path -- server.mjs content-negotiates that differently"
    );
}

/// Acceptance criterion 3: a second call while the window already exists
/// shows/focuses THAT window rather than creating a second one -- and,
/// since the window already exists, does NOT re-poll healthz at all (the
/// call returns near-instantly even though nothing is listening on this
/// test's port).
#[test]
fn second_click_shows_and_focuses_the_existing_window_never_creates_a_second_one() {
    // A port nothing listens on -- if this call incorrectly re-entered the
    // create-and-poll path, it would block for the full HEALTHZ poll bound;
    // asserting a fast return proves the show/focus branch was taken.
    let never_listening_port = 18596;

    let app = tauri::test::mock_app();
    let handle = app.handle();

    // Simulate "the window was already created by an earlier click" by
    // building it directly, exactly as show_or_create_dashboard_window's
    // own create path does.
    let existing_url = format!("http://127.0.0.1:{never_listening_port}/ui")
        .parse()
        .unwrap();
    tauri::WebviewWindowBuilder::new(
        handle,
        tray::WINDOW_LABEL,
        tauri::WebviewUrl::External(existing_url),
    )
    .build()
    .expect("test setup: build the pre-existing dashboard window");

    assert_eq!(handle.webview_windows().len(), 1, "precondition: exactly one window exists");

    let start = Instant::now();
    tray::show_or_create_dashboard_window(handle, never_listening_port)
        .expect("show/focus of an already-existing window must succeed");
    let elapsed = start.elapsed();

    assert_eq!(
        handle.webview_windows().len(),
        1,
        "a second left-click must show/focus the EXISTING window, never create a second one"
    );
    assert!(
        elapsed < Duration::from_millis(500),
        "the show/focus-existing-window path must not re-poll healthz at all -- took {elapsed:?}"
    );
}

/// dashboard_url() itself: exactly <PORT>/ui, sourced from whatever PORT is
/// passed in (never an independently hard-coded literal) -- acceptance
/// criterion 2, isolated from the window-creation machinery above.
#[test]
fn dashboard_url_matches_the_real_sidecar_default_port() {
    assert_eq!(
        tray::dashboard_url(mnemosyne_desktop_lib::sidecar::DEFAULT_PORT),
        "http://127.0.0.1:8477/ui"
    );
}
