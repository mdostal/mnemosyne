#!/usr/bin/env bash
# docs/install.sh -- Mnemosyne install script
# (aha-03-install-script-and-readme, epic: mnemosyne-agent-harness-install)
#
# Published verbatim at https://mdostal.github.io/mnemosyne/install.sh (this
# repo's GitHub Pages already serves /docs off main -- no separate deploy
# step). Usage, per README.md's Quickstart:
#
#   curl -fsSL https://mdostal.github.io/mnemosyne/install.sh | bash
#
# Mnemosyne is "private": true in package.json -- there is no
# package-registry install to wrap, so this script automates the same
# gh-repo-clone / npm-install sequence README.md's manual Quickstart already
# documents, then links `bin/mnemosyne` onto PATH. Per design-discussion.md
# §1.2, this script deliberately does ONLY that -- it prints, but never
# runs, `mnemosyne agent init` as a separate, explicit next step, since that
# command mutates a harness's own real MCP/skill config and shouldn't happen
# silently as part of a single curl|bash chain.
#
# What this script does:
#   1. git clone (shallow, --depth 1) this repo into a default location.
#      Idempotent: if a clone already exists there (a real .git dir), it
#      `git pull`s instead of re-cloning -- safe to re-run.
#   2. npm install inside the clone.
#   3. Symlinks bin/mnemosyne onto PATH at ~/.local/bin/mnemosyne -- this
#      operator's own established machine convention for CLI tools (e.g.
#      ~/.local/bin/{codex,graphify,swarm-memory} are all symlinks into
#      their real install locations).
#   4. Prints (never runs) `mnemosyne agent init` as the next step, plus one
#      line naming what it does.
#
# Overrides (mainly for isolated testing -- never required for a normal
# install; a plain `curl -fsSL ... | bash` with no env vars set uses the
# real defaults below):
#   MNEMOSYNE_REPO_URL      repo URL/path to clone (default: the real
#                            mdostal/mnemosyne GitHub repo)
#   MNEMOSYNE_INSTALL_DIR   clone target directory (default: ~/.local/share/mnemosyne/repo)
#   MNEMOSYNE_BIN_DIR       directory to symlink `mnemosyne` into (default: ~/.local/bin)
#
# Note on the default MNEMOSYNE_INSTALL_DIR: nested one level under
# ~/.local/share/mnemosyne/ (a "repo/" subdirectory), not that directory
# itself -- a running Mnemosyne service's own data (its log file, notes/)
# already lives directly in ~/.local/share/mnemosyne/ on a machine that has
# ever run this service, so cloning straight into it would collide with
# real, unrelated files. The safety check below (refuse to overwrite a
# non-git directory) would catch that collision rather than corrupt
# anything, but the nested path avoids it happening at all.

set -euo pipefail

REPO_URL="${MNEMOSYNE_REPO_URL:-https://github.com/mdostal/mnemosyne}"
INSTALL_DIR="${MNEMOSYNE_INSTALL_DIR:-$HOME/.local/share/mnemosyne/repo}"
BIN_DIR="${MNEMOSYNE_BIN_DIR:-$HOME/.local/bin}"

log() { printf '%s\n' "$*"; }
err() { printf '%s\n' "$*" >&2; }

# --- 1. clone (or update an existing clone) ---------------------------------
if [ -d "$INSTALL_DIR/.git" ]; then
  log "mnemosyne: existing clone found at $INSTALL_DIR -- updating (git pull) instead of re-cloning"
  git -C "$INSTALL_DIR" pull --ff-only
elif [ -e "$INSTALL_DIR" ]; then
  err "mnemosyne: $INSTALL_DIR already exists and is not a git clone -- refusing to overwrite it."
  err "Set MNEMOSYNE_INSTALL_DIR to a different location and re-run, or remove $INSTALL_DIR yourself first."
  exit 1
else
  log "mnemosyne: cloning $REPO_URL (shallow) into $INSTALL_DIR"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi

# --- 2. npm install -----------------------------------------------------------
log "mnemosyne: npm install in $INSTALL_DIR"
(cd "$INSTALL_DIR" && npm install)

# --- 3. link bin/mnemosyne onto PATH -----------------------------------------
mkdir -p "$BIN_DIR"
LINK_PATH="$BIN_DIR/mnemosyne"
REAL_BIN="$INSTALL_DIR/bin/mnemosyne"

if [ -L "$LINK_PATH" ] || [ ! -e "$LINK_PATH" ]; then
  ln -sf "$REAL_BIN" "$LINK_PATH"
  log "mnemosyne: linked $LINK_PATH -> $REAL_BIN"
else
  err "mnemosyne: $LINK_PATH already exists and is not a symlink -- leaving it untouched."
  err "Add $INSTALL_DIR/bin to your PATH manually, or remove $LINK_PATH yourself and re-run to link it."
fi

# --- 4. print (never run) the next step --------------------------------------
log ""
log "Mnemosyne installed at $INSTALL_DIR ($LINK_PATH on PATH)."
log ""
log "Next step (not run automatically -- registers Mnemosyne's MCP server and"
log "skills with your agent harness, so it's a separate, explicit, operator-confirmed action):"
log ""
log "  mnemosyne agent init"
log ""
log "This detects Claude Code and/or Codex CLI on PATH, registers Mnemosyne as an"
log "MCP server for each, and (Claude Code only) installs its usage skills into"
log "~/.claude/skills/. Run \`mnemosyne agent status\` first to preview state"
log "without changing anything."
