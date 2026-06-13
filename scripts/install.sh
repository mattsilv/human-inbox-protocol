#!/usr/bin/env bash
# HIP one-shot installer for macOS.
#
# Idempotent: safe to re-run. Walks every fragile step that has bitten a fresh
# install and verifies it before moving on:
#   1. Node >= 20 present
#   2. npm dependencies installed
#   3. TypeScript built to dist/
#   4. better-sqlite3 native binding loads for THIS node ABI (no prebuilt exists
#      for current Node versions, so it is compiled from source on demand)
#   5. `hip` is on PATH via a global symlink
#   6. config/token/actors/LaunchAgent seeded by `hip install`
#
# Usage:
#   scripts/install.sh                 # install + seed, do not start the daemon
#   scripts/install.sh --start         # also load the LaunchAgent (auto-start daemon)
#   scripts/install.sh --owner "Matt"  # set the owner actor display name

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

OWNER_NAME=""
DO_START=0
while [ $# -gt 0 ]; do
  case "$1" in
    --start) DO_START=1; shift ;;
    --owner) OWNER_NAME="${2:-}"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

say()  { printf '\033[1;36m==>\033[0m %s\n' "$1"; }
ok()   { printf '\033[1;32m  ok\033[0m %s\n' "$1"; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$1" >&2; exit 1; }

# 1. Node version ------------------------------------------------------------
command -v node >/dev/null 2>&1 || die "node not found — install Node 20+ first (e.g. \`brew install node\`)."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "node $(node -v) is too old — HIP needs Node 20+."
ok "node $(node -v) (ABI $(node -p 'process.versions.modules'))"

# 2. Dependencies ------------------------------------------------------------
say "Installing npm dependencies"
npm install --no-audit --no-fund >/dev/null
ok "dependencies installed"

# 3. Build -------------------------------------------------------------------
say "Building TypeScript"
npm run build >/dev/null
[ -f dist/cli/index.js ] || die "build produced no dist/cli/index.js"
ok "built dist/"

# 4. Native binding ----------------------------------------------------------
# better-sqlite3 ships prebuilds only for some node ABIs; on a mismatch the
# binding throws at require-time. Rebuild from source when it does not load.
say "Verifying better-sqlite3 native binding"
if ! node -e 'require("better-sqlite3")' >/dev/null 2>&1; then
  say "  binding missing for this node ABI — compiling from source"
  npm rebuild better-sqlite3 >/dev/null 2>&1 || die "better-sqlite3 rebuild failed — is the Xcode CLT installed? (\`xcode-select --install\`)"
  node -e 'require("better-sqlite3")' >/dev/null 2>&1 || die "better-sqlite3 still does not load after rebuild."
fi
ok "better-sqlite3 loads"

# 5. PATH symlink ------------------------------------------------------------
# `npm link` registers ./ globally and symlinks the `hip` bin onto PATH.
say "Linking the \`hip\` command onto PATH"
npm link >/dev/null 2>&1 || die "npm link failed — re-run with sudo or check npm global prefix permissions."
command -v hip >/dev/null 2>&1 || die "\`hip\` is not on PATH after link — check \`npm prefix -g\`/bin is in your PATH."
HIP_VER="$(hip --version 2>/dev/null || true)"
[ -n "$HIP_VER" ] || die "\`hip --version\` produced no output — the linked binary is not executing."
ok "hip $HIP_VER on PATH ($(command -v hip))"

# 6. Seed config + actors + LaunchAgent --------------------------------------
say "Seeding config, token, actors, and LaunchAgent"
if [ -n "$OWNER_NAME" ]; then
  hip install --owner-name "$OWNER_NAME"
else
  hip install
fi

# 7. Optional auto-start -----------------------------------------------------
PLIST="$HOME/Library/LaunchAgents/ai.hip.daemon.plist"
if [ "$DO_START" -eq 1 ]; then
  say "Loading the LaunchAgent (daemon auto-starts now and at login)"
  launchctl unload "$PLIST" >/dev/null 2>&1 || true
  launchctl load "$PLIST" || die "launchctl load failed."
  sleep 1
  hip status
else
  printf '\n'
  say "Done. Start the daemon with either:"
  printf '    hip serve                       # foreground, this terminal\n'
  printf '    launchctl load %s   # background, auto-start at login\n' "$PLIST"
  printf '  Then: \033[1mhip status\033[0m  and  \033[1mhip inbox\033[0m\n'
fi
