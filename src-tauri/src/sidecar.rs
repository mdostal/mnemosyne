// sidecar.rs — da-02-node-sidecar-packaging: pure, unit-testable construction
// of the sidecar Command's args/env. Kept free of any tauri::AppHandle/shell
// dependency so it can be exercised directly (both in `cargo test`'s own
// unit tests below, AND in tests/sidecar_path_fix_realspawn.rs's real,
// non-mocked spawn-and-curl integration proof) without needing a full Tauri
// app context.
//
// THE load-bearing concern this module exists to close (see
// .pHive/epics/mnemosyne-desktop-app/stories/da-02-node-sidecar-packaging.yaml
// acceptance criterion 4, grill-record.md finding 2.1): a Tauri sidecar is
// launched by the OS (Finder/Dock/launchd), bypassing bin/mnemosyne's own
// bash wrapper entirely -- `export PATH="/opt/homebrew/bin:$HOME/.local/bin:$PATH"`
// -- so a GUI-launched sidecar process does NOT inherit that augmentation
// the way a terminal-launched `bin/mnemosyne` does. This module reproduces
// that exact augmentation on the sidecar Command's own environment, PLUS an
// explicit SWARM_MEMORY_BIN absolute-path override (the acceptance
// criterion's own documented "(or SWARM_MEMORY_BIN)" alternative) as a
// second, independent line of defense: src/engine.mjs resolves the CLI via
// `process.env.SWARM_MEMORY_BIN || "swarm-memory"`, so an absolute
// SWARM_MEMORY_BIN bypasses PATH search for that specific invocation
// entirely, even if some future change altered the PATH-prepend approach.

/// The default port src/server.mjs listens on (see src/server.mjs's own
/// `const PORT = Number(process.env.PORT || 8477)`), unchanged by this
/// story -- reproduced here as a named constant rather than a bare literal
/// scattered across lib.rs and tests.
pub const DEFAULT_PORT: u16 = 8477;

/// Reproduces bin/mnemosyne's own PATH augmentation
/// (`/opt/homebrew/bin:$HOME/.local/bin:$PATH`) verbatim, prepended onto
/// whatever PATH the sidecar happened to inherit (`inherited_path` -- pass
/// `None`/empty for a from-scratch launchd-style environment that carried no
/// PATH at all). Never DROPS the inherited PATH -- only prepends -- so any
/// other OS-standard directories (`/usr/bin`, `/bin`, ...) the process
/// legitimately inherited stay reachable too.
pub fn fixed_path_env(home: &str, inherited_path: Option<&str>) -> String {
    let inherited = inherited_path.unwrap_or("");
    format!("/opt/homebrew/bin:{home}/.local/bin:{inherited}")
}

/// The absolute, PATH-search-free path to the real `swarm-memory` CLI this
/// operator's machine resolves it to today (research step,
/// re-confirmed live on this real machine, not assumed unchanged --
/// see this story's own `context.tech_stack.swarm_memory_resolved_path`):
/// `~/.local/bin/swarm-memory`, itself a pipx-venv symlink. Passed to the
/// sidecar as `SWARM_MEMORY_BIN`, which src/engine.mjs's own
/// `process.env.SWARM_MEMORY_BIN || "swarm-memory"` resolution prefers over
/// any PATH search.
pub fn swarm_memory_bin_path(home: &str) -> String {
    format!("{home}/.local/bin/swarm-memory")
}

/// The full set of environment variables da-02's sidecar-spawn Command sets
/// explicitly (never left to silent inheritance): the PATH fix, the
/// SWARM_MEMORY_BIN absolute-path fix, and PORT. Returned as an owned
/// `Vec<(String, String)>` so both the production `app.shell().sidecar(...)
/// .envs(...)` call in lib.rs AND this story's own real (non-mocked)
/// integration test build the IDENTICAL values from this one function --
/// never two hand-copied, silently-driftable literals.
pub fn sidecar_env_vars(home: &str, inherited_path: Option<&str>, port: u16) -> Vec<(String, String)> {
    vec![
        ("PATH".to_string(), fixed_path_env(home, inherited_path)),
        ("SWARM_MEMORY_BIN".to_string(), swarm_memory_bin_path(home)),
        ("PORT".to_string(), port.to_string()),
    ]
}

/// The sidecar's own argv: a single positional arg, the bundled
/// `src/server.mjs` resource's real resolved path (dev-mode: the repo's own
/// `src/server.mjs`; packaged: `<resource_dir>/src/server.mjs` -- see
/// lib.rs's `resolve_server_mjs_path`). server.mjs takes zero CLI flags of
/// its own (PORT/SWARM_MEMORY_BIN are env-only), so this is just `[path]`.
pub fn sidecar_args(server_mjs_path: &str) -> Vec<String> {
    vec![server_mjs_path.to_string()]
}

/// This machine's real Rust host target triple, computed the same way
/// `rustc --print host-tuple` reports it (confirmed live during this
/// story's own research step: `aarch64-apple-darwin`), for constructing the
/// externalBin-convention sidecar filename
/// (`mnemosyne-node-$TARGET_TRIPLE`). Built from `cfg!` rather than reading
/// cargo's build-time `TARGET` env var (not visible to a plain `cargo test`
/// binary, only to build.rs), so it stays correct in both the compiled app
/// and this story's own tests -- macOS/aarch64 and macOS/x86_64 are the only
/// two shapes Tauri desktop macOS builds ever run on.
pub fn host_target_triple() -> &'static str {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "aarch64-apple-darwin"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "x86_64-apple-darwin"
    } else {
        panic!("mnemosyne-desktop's sidecar packaging is macOS-only as of da-02; unsupported target");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_path_env_prepends_without_dropping_inherited_path() {
        let out = fixed_path_env("/Users/mdostal", Some("/usr/bin:/bin"));
        assert_eq!(out, "/opt/homebrew/bin:/Users/mdostal/.local/bin:/usr/bin:/bin");
    }

    #[test]
    fn fixed_path_env_handles_a_genuinely_empty_inherited_path() {
        // The launchd-worst-case: a sidecar that inherited NO PATH at all.
        let out = fixed_path_env("/Users/mdostal", None);
        assert_eq!(out, "/opt/homebrew/bin:/Users/mdostal/.local/bin:");
    }

    #[test]
    fn swarm_memory_bin_path_is_absolute_and_path_search_free() {
        let out = swarm_memory_bin_path("/Users/mdostal");
        assert_eq!(out, "/Users/mdostal/.local/bin/swarm-memory");
        assert!(out.starts_with('/'), "must be absolute, never a bare PATH-searched name");
    }

    #[test]
    fn sidecar_env_vars_sets_exactly_path_swarm_memory_bin_and_port() {
        let vars = sidecar_env_vars("/Users/mdostal", Some("/usr/bin:/bin"), DEFAULT_PORT);
        let map: std::collections::HashMap<_, _> = vars.into_iter().collect();
        assert_eq!(map.len(), 3);
        assert_eq!(map["PATH"], "/opt/homebrew/bin:/Users/mdostal/.local/bin:/usr/bin:/bin");
        assert_eq!(map["SWARM_MEMORY_BIN"], "/Users/mdostal/.local/bin/swarm-memory");
        assert_eq!(map["PORT"], "8477");
    }

    #[test]
    fn sidecar_args_is_a_single_positional_server_mjs_path() {
        let args = sidecar_args("/some/resource/dir/src/server.mjs");
        assert_eq!(args, vec!["/some/resource/dir/src/server.mjs".to_string()]);
    }

    #[test]
    fn host_target_triple_matches_the_real_confirmed_research_output() {
        // This story's own research step re-confirmed `rustc --print
        // host-tuple` -> aarch64-apple-darwin live on this machine; da-01's
        // recorded research says the same. A CI runner on Intel macOS would
        // legitimately get the other arm of the cfg! branch instead.
        let t = host_target_triple();
        assert!(t == "aarch64-apple-darwin" || t == "x86_64-apple-darwin");
    }
}
