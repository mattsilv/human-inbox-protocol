#!/usr/bin/env bash
# HIP updater for macOS. Pull the latest code, rebuild, and restart the daemon so
# a `hip update` (or `git pull`) is fully live with one command.
#
# Because `hip` is npm-linked to this checkout, BOTH the CLI and the launchd daemon
# run from dist/. So an update is: refresh source -> rebuild dist/ -> restart daemon.
# Idempotent and safe to re-run.
#
# Usage:
#   scripts/update.sh            # pull (if a remote exists), rebuild, restart daemon
#   scripts/update.sh --no-pull  # rebuild current checkout only, then restart

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DO_PULL=1
while [ $# -gt 0 ]; do
  case "$1" in
    --no-pull) DO_PULL=0; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

say()  { printf '\033[1;36m==>\033[0m %s\n' "$1"; }
ok()   { printf '\033[1;32m  ok\033[0m %s\n' "$1"; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$1" >&2; exit 1; }

# 1. Pull latest (only when this is a git checkout with a configured remote) -----
if [ "$DO_PULL" -eq 1 ] && [ -d .git ] && git remote | grep -q .; then
  say "Pulling latest"
  git pull --ff-only || die "git pull failed (dirty tree or diverged) — resolve, then re-run."
  ok "now at $(git rev-parse --short HEAD)"
else
  say "No remote (or --no-pull) — rebuilding the current checkout"
fi

# 2. Dependencies + build (prepare also builds; build again is cheap + explicit) -
say "Installing dependencies and building"
npm install --no-audit --no-fund >/dev/null
npm run build >/dev/null
[ -f dist/cli/index.js ] || die "build produced no dist/cli/index.js"
ok "built dist/"

# 3. Native binding for the current node ABI -----------------------------------
if ! node -e 'require("better-sqlite3")' >/dev/null 2>&1; then
  say "Rebuilding better-sqlite3 for this node ABI"
  npm rebuild better-sqlite3 >/dev/null 2>&1 || die "better-sqlite3 rebuild failed — is Xcode CLT installed? (\`xcode-select --install\`)"
  node -e 'require("better-sqlite3")' >/dev/null 2>&1 || die "better-sqlite3 still does not load."
fi
ok "better-sqlite3 loads"

# 4. Restart the daemon so it runs the new dist/ -------------------------------
LABEL="ai.hip.daemon"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
if launchctl list 2>/dev/null | grep -q "$LABEL"; then
  say "Restarting the daemon"
  # kickstart -k restarts the running service in place; fall back to unload/load.
  launchctl kickstart -k "gui/$(id -u)/$LABEL" 2>/dev/null \
    || { launchctl unload "$PLIST" 2>/dev/null || true; launchctl load "$PLIST"; }
  sleep 1
  ok "daemon restarted"
  hip status || true
else
  say "Daemon is not running under launchd."
  printf '  If you run it manually, restart it: stop the \033[1mhip serve\033[0m process, then start it again.\n'
  printf '  To run it in the background from now on: launchctl load %s\n' "$PLIST"
fi

printf '\n'
ok "update complete"
