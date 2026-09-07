pub mod sidecar;

use std::sync::Mutex;

use tauri::path::BaseDirectory;
use tauri::Manager;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Holds the running sidecar's own child handle for the app's lifetime, so
/// it isn't dropped (and so a future story -- da-03's window-wiring -- can
/// reach it, e.g. to shut the sidecar down on window close). Not read by
/// this story itself; da-02's own scope ends at "the sidecar is up and
/// healthy," never touching window lifecycle.
struct SidecarHandle(#[allow(dead_code)] Mutex<Option<CommandChild>>);

/// Resolves the real, resolved path to the bundled `src/server.mjs`
/// resource this story ships (see tauri.conf.json's `bundle.resources` --
/// `src/*.mjs` copied under the resource dir's own `src/` subdirectory,
/// preserving the exact relative layout `src/server.mjs`'s own
/// `UI_DIR = path.resolve(__dirname, "..", "ui")` computation depends on).
/// In dev (`cargo tauri dev`), Tauri's resource resolution falls back to
/// resolving resources relative to `src-tauri/` itself, so this resolves to
/// the real repo's own `../src/server.mjs` unchanged -- never a copy, never
/// a second, parallel file.
fn resolve_server_mjs_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    app
        .path()
        .resolve("src/server.mjs", BaseDirectory::Resource)
        .expect("failed to resolve bundled src/server.mjs resource path")
}

/// Spawns the `mnemosyne-node` sidecar (the vendored, unmodified platform
/// `node` binary -- see `src-tauri/binaries/mnemosyne-node-<TARGET_TRIPLE>`
/// and `tauri.conf.json`'s `bundle.externalBin`) against the bundled
/// `src/server.mjs`, with the explicit PATH/SWARM_MEMORY_BIN/PORT
/// environment fix from `sidecar.rs` -- THE load-bearing fix this story
/// exists to prove (see sidecar.rs's own doc comment and this story's own
/// acceptance criterion 4). Logs every stdout/stderr line and any spawn
/// error or early exit loudly (`log::error!`) rather than swallowing it --
/// this story adds no new silent-failure path around sidecar startup
/// (cross_cutting: loud-failure).
fn spawn_sidecar(app: &tauri::AppHandle) {
    let server_mjs_path = resolve_server_mjs_path(app);
    let server_mjs_path_str = server_mjs_path
        .to_str()
        .expect("bundled resource path must be valid UTF-8")
        .to_string();

    let home = std::env::var("HOME").unwrap_or_default();
    let inherited_path = std::env::var("PATH").ok();
    let env_vars = sidecar::sidecar_env_vars(&home, inherited_path.as_deref(), sidecar::DEFAULT_PORT);

    log::info!(
        "[da-02] spawning mnemosyne-node-{} sidecar: args={:?} PATH-fix-applied SWARM_MEMORY_BIN={}",
        sidecar::host_target_triple(),
        sidecar::sidecar_args(&server_mjs_path_str),
        sidecar::swarm_memory_bin_path(&home)
    );

    let sidecar_command = app
        .shell()
        .sidecar("mnemosyne-node")
        .expect("mnemosyne-node sidecar not found -- check bundle.externalBin in tauri.conf.json");

    let (mut rx, child) = sidecar_command
        .args(sidecar::sidecar_args(&server_mjs_path_str))
        .envs(env_vars)
        .spawn()
        .expect("failed to spawn mnemosyne-node sidecar");

    app.manage(SidecarHandle(Mutex::new(Some(child))));

    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    log::info!("[mnemosyne-node] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Stderr(line) => {
                    log::warn!("[mnemosyne-node] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Error(err) => {
                    // Loud, not swallowed: a spawn-level failure (e.g. the
                    // sidecar binary itself not found/executable) surfaces
                    // here rather than disappearing silently.
                    log::error!("[mnemosyne-node] sidecar error: {err}");
                }
                CommandEvent::Terminated(payload) => {
                    log::error!(
                        "[mnemosyne-node] sidecar exited early: code={:?} signal={:?}",
                        payload.code,
                        payload.signal
                    );
                }
                _ => {}
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      spawn_sidecar(app.handle());
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
