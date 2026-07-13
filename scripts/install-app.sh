#!/usr/bin/env bash
# Build the .app bundle and install it to /Applications, so the Dock icon
# always launches the latest build. Usage:
#   scripts/install-app.sh           # release build + install
#   scripts/install-app.sh --debug   # debug build + install (fast, daily driver)
#   scripts/install-app.sh --no-build  # install whichever bundle is newest
set -euo pipefail

cd "$(dirname "$0")/.."
source "$HOME/.cargo/env"

MODE="${1:-}"
DEBUG_APP="src-tauri/target/debug/bundle/macos/ChessGUI.app"
RELEASE_APP="src-tauri/target/release/bundle/macos/ChessGUI.app"

case "$MODE" in
  --debug)    pnpm tauri build --debug; SRC="$DEBUG_APP" ;;
  --no-build)
    # newest existing bundle wins
    if [[ -d "$DEBUG_APP" && ( ! -d "$RELEASE_APP" || "$DEBUG_APP" -nt "$RELEASE_APP" ) ]]; then
      SRC="$DEBUG_APP"
    elif [[ -d "$RELEASE_APP" ]]; then
      SRC="$RELEASE_APP"
    else
      echo "No built ChessGUI.app found — run pnpm tauri build [--debug] first." >&2; exit 1
    fi ;;
  *)          pnpm tauri build; SRC="$RELEASE_APP" ;;
esac

DEST="/Applications/ChessGUI.app"

# Quit a running copy gracefully so the Dock relaunches the fresh install.
if pgrep -f "Applications/ChessGUI" >/dev/null; then
  osascript -e 'tell application "ChessGUI" to quit' 2>/dev/null || true
  sleep 1
fi

rm -rf "$DEST"
ditto "$SRC" "$DEST"
VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$DEST/Contents/Info.plist")
echo "Installed ChessGUI $VERSION -> $DEST (from $SRC)"
