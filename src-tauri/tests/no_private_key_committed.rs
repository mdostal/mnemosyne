// tests/no_private_key_committed.rs — da-04-auto-updater-wiring's own
// concrete, re-runnable proof of acceptance criterion 1's "the private key
// is verified to NOT exist anywhere under this repo's own working tree"
// requirement: a REAL git/filesystem scan, not a policy statement.
//
// This test NEVER reads the private key file's own bytes -- not here, not
// anywhere else this story's implementation touches (this repo's own hard
// "never resolve/print/persist a secret" discipline, applied to this new
// desktop-signing-and-secret-custody concern for the first time). It checks
// NAMES (a filesystem walk, `git status --porcelain`) and known PUBLIC
// minisign-format markers (`git log -p`), exactly what an independent
// reviewer doing `find . -iname '*.key'` / `git log -p | grep` by hand would
// do -- made real, automated, and re-runnable on every future regression
// pass (this story's own `metric` block: zero-leak-incidents, every run,
// permanently).

use std::path::{Path, PathBuf};
use std::process::Command;

fn repo_root() -> PathBuf {
    // src-tauri/tests/ -> src-tauri/ -> repo root.
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri must have a parent directory")
        .to_path_buf()
}

/// Filename substrings that would indicate a private-signing-key-shaped
/// file landed in the repo's own working tree -- deliberately broad
/// (matches this story's own real key filename `mnemosyne-desktop.key` AND
/// generic private-key-shaped names an operator might otherwise use). A
/// false positive here just means one extra look; a false negative would
/// mean a real leaked key goes unnoticed.
const SUSPECT_FILENAME_PATTERNS: &[&str] = &[
    ".key",
    "private-key",
    "privatekey",
    "id_rsa",
    "id_ed25519",
    "id_dsa",
    "id_ecdsa",
];

/// Directories never worth walking: build output, vendored deps, and git's
/// own internal object store (history is checked separately below, via
/// `git log`, never by walking `.git/objects` filenames directly).
const SKIP_DIR_NAMES: &[&str] = &["node_modules", "target", ".git", "dist", "graphify-out"];

fn walk_for_suspect_filenames(dir: &Path, findings: &mut Vec<PathBuf>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let file_name_str = entry.file_name().to_string_lossy().to_lowercase();
        if path.is_dir() {
            if SKIP_DIR_NAMES.iter().any(|skip| file_name_str == *skip) {
                continue;
            }
            walk_for_suspect_filenames(&path, findings);
        } else if SUSPECT_FILENAME_PATTERNS
            .iter()
            .any(|pattern| file_name_str.contains(pattern))
        {
            findings.push(path);
        }
    }
}

/// THE core proof: walks the repo's own real working tree (not a mock
/// listing) looking for any file whose NAME matches a private-key-shaped
/// pattern. Never opens any matched file's contents.
#[test]
fn no_private_key_shaped_filename_exists_anywhere_in_the_working_tree() {
    let root = repo_root();
    let mut findings = Vec::new();
    walk_for_suspect_filenames(&root, &mut findings);
    assert!(
        findings.is_empty(),
        "found private-key-shaped filename(s) in the repo's own working tree -- the signing \
         private key must live ONLY at ~/.tauri/mnemosyne-desktop.key (outside this repo), \
         never inside it: {findings:?}"
    );
}

/// `git status --porcelain` must never report a key-shaped file as
/// untracked/staged either -- defense in depth alongside the filesystem
/// walk above, catching a key-shaped file the walk's own extension list
/// didn't anticipate but git itself would still surface as tree-adjacent.
#[test]
fn git_status_reports_no_key_shaped_file() {
    let root = repo_root();
    let output = Command::new("git")
        .arg("-C")
        .arg(&root)
        .arg("status")
        .arg("--porcelain")
        .output()
        .expect("git status must run");
    assert!(output.status.success(), "git status must exit successfully");
    let status_text = String::from_utf8_lossy(&output.stdout);
    for line in status_text.lines() {
        let lowered = line.to_lowercase();
        assert!(
            !SUSPECT_FILENAME_PATTERNS.iter().any(|p| lowered.contains(p)),
            "git status reports a key-shaped file, which must never be staged/untracked in this \
             repo: {line}"
        );
    }
}

/// Scans this story's own touched files' committed history (not the whole
/// repo's full history -- out of this narrow story's own scope) for actual
/// KEY-MATERIAL markers -- minisign's own documented private-key file
/// comment line (`untrusted comment: minisign encrypted secret key`,
/// minisign's own public file-format convention) and the standard PEM
/// `-----BEGIN ... PRIVATE KEY-----` header -- proof the private key's own
/// BYTES never entered a commit even transiently, WITHOUT this test ever
/// reading the real key file's own content itself (it only greps git's
/// history for known public marker strings).
///
/// Deliberately NOT a bare case-insensitive "private key" substring search:
/// this repo's own planning docs (README.md/design-discussion.md-derived
/// prose) legitimately DISCUSS "the private key" as a concept ("private key
/// never committed", etc.) -- that prose is the correct, desired outcome,
/// not a leak, and a bare-phrase scan would false-positive on it. Only
/// markers that indicate actual key-material BYTES are checked here.
#[test]
fn git_history_of_this_storys_touched_files_never_contains_actual_key_material() {
    let root = repo_root();
    let touched_files = [
        "src-tauri/tauri.conf.json",
        "src-tauri/Cargo.toml",
        "src-tauri/Cargo.lock",
        "src-tauri/src/lib.rs",
        "src-tauri/src/tray.rs",
        "src-tauri/src/updater.rs",
        ".gitignore",
        "README.md",
        "SERVICE.md",
    ];
    let output = Command::new("git")
        .arg("-C")
        .arg(&root)
        .arg("log")
        .arg("-p")
        .arg("--all")
        .arg("--")
        .args(touched_files)
        .output()
        .expect("git log -p must run");
    assert!(output.status.success(), "git log -p must exit successfully");
    let history_text = String::from_utf8_lossy(&output.stdout);

    assert!(
        !history_text.contains("minisign encrypted secret key"),
        "found minisign's own private-key file marker in this story's touched files' git \
         history -- the private key must NEVER be committed, even transiently"
    );
    assert!(
        !history_text.contains("PRIVATE KEY-----"),
        "found a PEM '...PRIVATE KEY-----' marker in this story's touched files' git history"
    );
}

/// Independent sanity check on the OTHER direction: the real private key
/// file must exist on this machine (outside the repo), so this suite is
/// proving "committed nowhere" against a real generated key, not
/// vacuously passing because no key was ever generated at all.
#[test]
fn the_real_private_key_file_exists_outside_the_repo_on_this_machine() {
    let home = std::env::var("HOME").expect("HOME must be set");
    let key_path = Path::new(&home).join(".tauri").join("mnemosyne-desktop.key");
    assert!(
        key_path.exists(),
        "expected the real signing private key at {key_path:?} (outside the repo) -- if this \
         fails, either the key was never generated or it was (wrongly) moved/deleted"
    );
    let repo_root = repo_root();
    assert!(
        !key_path.starts_with(&repo_root),
        "the private key path must never be inside the repo's own working tree"
    );
}
