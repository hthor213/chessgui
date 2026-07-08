#!/usr/bin/env bash
# Build the release .app bundle and install it to /Applications,
# so the desktop icon always launches the latest build.
set -euo pipefail

cd "$(dirname "$0")/.."
source "$HOME/.cargo/env"

pnpm tauri build

SRC="src-tauri/target/release/bundle/macos/ChessGUI.app"
DEST="/Applications/ChessGUI.app"

if pgrep -f "Applications/ChessGUI" >/dev/null; then
  echo "ChessGUI is running — quit it first, then re-run this script." >&2
  exit 1
fi

rm -rf "$DEST"
ditto "$SRC" "$DEST"
echo "Installed $(stat -f '%Sm' "$DEST"): $DEST"
