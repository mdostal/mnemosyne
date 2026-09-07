// tests/sidecar_path_fix.rs — da-02-node-sidecar-packaging's own
// highest-load-bearing proof (acceptance criterion 4): a REAL, non-mocked
// spawn of the REAL vendored node binary running the REAL, unmodified
// src/server.mjs, from a child process whose OWN inherited environment has
// been deliberately stripped down to a genuinely minimal
// Finder/Dock/launchd-style PATH (never this test-runner's own rich
// interactive-shell PATH) -- exactly the shape of test the story's own risk
// section calls out as the only kind that can actually catch this bug.
//
// Uses the SAME `sidecar::sidecar_args`/`sidecar::sidecar_env_vars`
// functions lib.rs's own real `app.shell().sidecar("mnemosyne-node")`
// spawn path calls -- so this test exercises byte-identical args/env
// values, not a hand-copied approximation that could silently drift from
// the real production code.
//
// Deliberately avoids adding an HTTP-client crate dependency for a handful
// of test-only GET requests: `tiny_http_get` below is a ~15-line raw
// TcpStream GET, kept inline rather than pulling in reqwest/ureq.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use mnemosyne_desktop_lib::sidecar;

/// This repo's root (src-tauri/'s own parent) -- CARGO_MANIFEST_DIR is
/// always `<repo>/src-tauri` for this crate.
fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri must have a parent directory (the repo root)")
        .to_path_buf()
}

/// The real, vendored, unmodified platform node binary this story ships
/// under src-tauri/binaries/, named per Tauri's own externalBin convention.
/// Spawned directly here (bypassing tauri_plugin_shell's own resolution,
/// which requires a full Tauri app context this offline test doesn't
/// construct) -- see this file's own doc comment for why that's still a
/// faithful proof of the args/env-construction logic under test.
fn vendored_node_binary() -> PathBuf {
    repo_root()
        .join("src-tauri")
        .join("binaries")
        .join(format!("mnemosyne-node-{}", sidecar::host_target_triple()))
}

/// The real, unmodified src/server.mjs this story's sidecar spawns
/// unchanged -- pre-packaging, this IS the exact file `cargo tauri build`
/// later copies verbatim into the bundle's own resource dir (see
/// tauri.conf.json's `bundle.resources` mapping `../src/*.mjs` -> `src/`).
fn real_server_mjs_path() -> String {
    repo_root()
        .join("src")
        .join("server.mjs")
        .to_str()
        .expect("repo path must be valid UTF-8")
        .to_string()
}

/// A genuinely minimal, Finder/Dock/launchd-style PATH: the OS-standard
/// directories only, deliberately excluding BOTH `/opt/homebrew/bin` and
/// `$HOME/.local/bin` -- i.e. exactly what a GUI-launched process gets
/// before any fix is applied, never this test runner's own rich
/// interactive-shell PATH (which would silently make the bug unreachable).
const MINIMAL_LAUNCHD_PATH: &str = "/usr/bin:/bin:/usr/sbin:/sbin";

/// Minimal raw HTTP/1.1 GET over a TcpStream -- no crate dependency, no
/// keep-alive, no redirects; returns (status_code, body).
fn tiny_http_get(port: u16, path: &str) -> std::io::Result<(u16, String)> {
    let mut stream = TcpStream::connect(("127.0.0.1", port))?;
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes())?;
    let mut raw = String::new();
    stream.read_to_string(&mut raw)?;
    let mut parts = raw.splitn(2, "\r\n\r\n");
    let head = parts.next().unwrap_or("");
    let body = parts.next().unwrap_or("").to_string();
    let status_line = head.lines().next().unwrap_or("");
    let status_code: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    Ok((status_code, body))
}

/// Polls GET /healthz until it returns 200 or the bounded wait expires.
fn wait_for_healthz(port: u16, bound: Duration) -> bool {
    let deadline = Instant::now() + bound;
    while Instant::now() < deadline {
        if let Ok((200, _)) = tiny_http_get(port, "/healthz") {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

struct SidecarGuard(Child);
impl Drop for SidecarGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Spawns the real vendored node binary against the real server.mjs, with
/// the child's inherited environment fully cleared and replaced by
/// `base_env` (the deliberately-scrubbed baseline) plus, on top of that,
/// `fix_env` (typically `sidecar::sidecar_env_vars(...)`'s own output, or
/// an empty Vec to test the genuinely-unfixed case).
fn spawn_with_env(base_env: &[(&str, &str)], fix_env: Vec<(String, String)>) -> SidecarGuard {
    let mut cmd = Command::new(vendored_node_binary());
    cmd.args(sidecar::sidecar_args(&real_server_mjs_path()));
    cmd.env_clear();
    for (k, v) in base_env {
        cmd.env(k, v);
    }
    for (k, v) in fix_env {
        cmd.env(k, v);
    }
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    let child = cmd.spawn().expect(
        "failed to spawn the real vendored node binary -- did the research/vendoring step run?",
    );
    SidecarGuard(child)
}

fn real_home() -> String {
    std::env::var("HOME").expect("this real machine's own $HOME must be set")
}

/// THE core acceptance-criterion-4 proof: realistic deployment shape --
/// real $HOME, genuinely minimal launchd-style PATH (no ~/.local/bin, no
/// /opt/homebrew/bin), da-02's own real sidecar_env_vars() fix applied on
/// top, exactly as lib.rs's real spawn_sidecar() will. GET /healthz must
/// reach 200, and GET /health must NOT report an ENOENT/subprocess-not-found
/// degradation (an actual, different-shaped downstream degradation --
/// e.g. this operator's own gcloud/Qdrant reachability, entirely out of
/// this story's scope -- is fine and expected; see this story's own
/// cross_cutting "loud-failure" note. What matters here is that
/// `swarm-memory` itself was FOUND, not silently ENOENT'd.)
#[test]
fn healthz_and_health_reachable_with_real_fix_under_minimal_launchd_path() {
    let port = 18581;
    let home = real_home();
    let user = std::env::var("USER").unwrap_or_default();
    let base_env = [
        ("HOME", home.as_str()),
        ("USER", user.as_str()),
        ("PATH", MINIMAL_LAUNCHD_PATH),
    ];
    let fix_env = sidecar::sidecar_env_vars(&home, Some(MINIMAL_LAUNCHD_PATH), port);
    let _guard = spawn_with_env(&base_env, fix_env);

    assert!(
        wait_for_healthz(port, Duration::from_secs(10)),
        "GET /healthz never returned 200 within the bounded wait -- the sidecar never reached a servable state"
    );

    // NOTE: 200 vs 503 here is NOT the assertion this test makes -- /health's
    // `ok` field also folds in real Qdrant/gcloud connectivity (this
    // operator's own `gcloud` lives at ~/google-cloud-sdk/bin, outside BOTH
    // bin/mnemosyne's own PATH augmentation and this story's own PATH fix,
    // and swarm-memory's OWN internal `qdrant.api_key_cmd` shells out to it)
    // -- entirely out of da-02's scope (cross_cutting: loud-failure --
    // real failures surface, they are never this story's job to fix). What
    // THIS acceptance criterion requires is narrower and precise: swarm-memory
    // ITSELF must be found (no ENOENT/subprocess-not-found), whatever it
    // then reports.
    let (status, body) = tiny_http_get(port, "/health").expect("GET /health must be reachable once /healthz is up");
    assert!(status == 200 || status == 503, "unexpected /health status; body={body}");
    let parsed: serde_json::Value = serde_json::from_str(&body).expect("must be valid JSON");
    let error_text = parsed.get("error").and_then(|v| v.as_str()).unwrap_or("");
    assert!(
        !error_text.to_uppercase().contains("ENOENT"),
        "swarm-memory was NOT found (ENOENT) even with the PATH/SWARM_MEMORY_BIN fix applied -- the load-bearing fix failed; /health body={body}"
    );
    assert!(
        !error_text.contains("spawn swarm-memory"),
        "swarm-memory subprocess-not-found degradation surfaced even with the fix applied; /health body={body}"
    );
}

/// Adversarial negative control: proves the failure mode this story exists
/// to close is REAL and reproducible, not hypothetical -- a genuinely
/// broken $HOME (so engine.mjs's OWN internal `homedir()`-based PATH
/// prepend also can't find swarm-memory) combined with a minimal PATH and
/// NO sidecar-level fix at all (no SWARM_MEMORY_BIN, no PATH augmentation)
/// reproduces a real ENOENT. Without a test shaped like this, a test that
/// merely re-ran the happy path could pass by coincidence (e.g. because
/// some OTHER part of the codebase happens to also patch PATH) without
/// ever proving the mechanism under test actually matters.
#[test]
fn without_any_fix_a_broken_home_reproduces_a_genuine_enoent() {
    let port = 18582;
    let fake_home = std::env::temp_dir()
        .join("da-02-fake-home-no-local-bin")
        .to_str()
        .unwrap()
        .to_string();
    let _ = std::fs::create_dir_all(&fake_home);
    let base_env = [
        ("HOME", fake_home.as_str()),
        ("PATH", MINIMAL_LAUNCHD_PATH),
    ];
    // No fix_env at all: no SWARM_MEMORY_BIN, no PATH augmentation beyond
    // the minimal launchd-style base above.
    let _guard = spawn_with_env(&base_env, vec![("PORT".to_string(), port.to_string())]);

    assert!(
        wait_for_healthz(port, Duration::from_secs(10)),
        "the http server itself must still come up (PORT-only env) even though swarm-memory won't be findable"
    );
    let (status, body) = tiny_http_get(port, "/health").expect("GET /health must be reachable");
    assert_eq!(status, 503, "expected a degraded health status; body={body}");
    let parsed: serde_json::Value = serde_json::from_str(&body).expect("must be valid JSON");
    let error_text = parsed.get("error").and_then(|v| v.as_str()).unwrap_or("");
    assert!(
        error_text.to_uppercase().contains("ENOENT"),
        "expected a real, reproduced ENOENT (swarm-memory not found under a broken HOME + minimal PATH + no fix) -- got: {error_text}"
    );
}

/// The other half of the negative control: under that SAME adversarial
/// broken-$HOME environment, applying da-02's own explicit SWARM_MEMORY_BIN
/// absolute-path override (computed from the REAL $HOME, independent of
/// whatever HOME the sidecar process itself was launched with) recovers
/// swarm-memory reachability -- proving SWARM_MEMORY_BIN specifically, not
/// just incidental PATH behavior, is what closes the gap.
#[test]
fn the_swarm_memory_bin_override_recovers_even_under_a_broken_home() {
    let port = 18583;
    let fake_home = std::env::temp_dir()
        .join("da-02-fake-home-no-local-bin-2")
        .to_str()
        .unwrap()
        .to_string();
    let _ = std::fs::create_dir_all(&fake_home);
    let real_home = real_home();
    let base_env = [
        ("HOME", fake_home.as_str()),
        ("PATH", MINIMAL_LAUNCHD_PATH),
    ];
    // Fix computed from the REAL home (exactly what lib.rs's spawn_sidecar
    // does -- it reads std::env::var("HOME") of the TAURI APP's own
    // process, which is correct/real, never the sidecar child's env).
    let fix_env = sidecar::sidecar_env_vars(&real_home, Some(MINIMAL_LAUNCHD_PATH), port);
    let _guard = spawn_with_env(&base_env, fix_env);

    assert!(
        wait_for_healthz(port, Duration::from_secs(10)),
        "GET /healthz never returned 200 within the bounded wait"
    );
    let (status, body) = tiny_http_get(port, "/health").expect("GET /health must be reachable");
    let parsed: serde_json::Value = serde_json::from_str(&body).expect("must be valid JSON");
    let error_text = parsed.get("error").and_then(|v| v.as_str()).unwrap_or("");
    assert!(
        !error_text.to_uppercase().contains("ENOENT"),
        "SWARM_MEMORY_BIN override did not recover swarm-memory reachability under a broken HOME; status={status} body={body}"
    );
}
