#!/usr/bin/env bash
# Fetch the sha256-pinned official Stockfish sidecar binary for a build
# target (spec 222). Binaries are downloaded at build time and verified
# against the pins below — they are never vendored into git (see .gitignore:
# apps/desktop/src-tauri/binaries/).
#
# Usage:
#   scripts/fetch-stockfish-sidecar.sh <windows-x64|linux-x64|macos-arm64|host>
#
# Drops the engine at
#   apps/desktop/src-tauri/binaries/stockfish-<rust-triple>[.exe]
# which is exactly what `bundle.externalBin: ["binaries/stockfish"]` in
# tauri.windows.conf.json / tauri.linux.conf.json expects; the Tauri bundler
# strips the triple suffix and ships the binary next to the app executable.
#
# Pin provenance: sha256 of the official release archives from
# github.com/official-stockfish/Stockfish, release sf_18, computed 2026-07-15.
# GPL-3.0 redistribution is license-clean — this app is GPL-3.0 too (spec 222
# engine strategy). AVX2 is the deliberate floor: pre-2013 CPUs use the spec
# 011 file picker instead (spec 222 "AVX2 is the default; the file picker is
# the escape hatch").
#
# macos-arm64 is supported here ahead of the bundle wiring (macOS keeps its
# Homebrew default until spec 220 unifies the sidecar story) so the
# download/verify path is testable on the laptop and ready for that day.

set -euo pipefail

STOCKFISH_RELEASE="sf_18"
BASE_URL="https://github.com/official-stockfish/Stockfish/releases/download/${STOCKFISH_RELEASE}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST_DIR="${REPO_ROOT}/apps/desktop/src-tauri/binaries"

TARGET="${1:-host}"

if [[ "$TARGET" == "host" ]]; then
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) TARGET="macos-arm64" ;;
    Linux-x86_64) TARGET="linux-x64" ;;
    MINGW*-x86_64 | MSYS*-x86_64 | CYGWIN*-x86_64) TARGET="windows-x64" ;;
    *)
      echo "error: unsupported host $(uname -s)-$(uname -m); pass a target explicitly" >&2
      exit 1
      ;;
  esac
fi

# Per-target: release asset, its pinned sha256, the Rust target triple (the
# suffix Tauri externalBin requires), and the binary's path inside the archive.
case "$TARGET" in
  windows-x64)
    ASSET="stockfish-windows-x86-64-avx2.zip"
    SHA256="6f6c272ebd6ea594377715235c8a7326f75940ef4f4f856f45106028fe6ae900"
    TRIPLE="x86_64-pc-windows-msvc"
    INNER="stockfish/stockfish-windows-x86-64-avx2.exe"
    EXT=".exe"
    ;;
  linux-x64)
    ASSET="stockfish-ubuntu-x86-64-avx2.tar"
    SHA256="536c0c2c0cf06450df0bfb5e876ef0d3119950703a8f143627f990c7b5417964"
    TRIPLE="x86_64-unknown-linux-gnu"
    INNER="stockfish/stockfish-ubuntu-x86-64-avx2"
    EXT=""
    ;;
  macos-arm64)
    ASSET="stockfish-macos-m1-apple-silicon.tar"
    SHA256="4d77c4aa3ad9bd1ea8111f2ac5a4620fe7ebf998d6893bf828d49ccd579c8cb0"
    TRIPLE="aarch64-apple-darwin"
    INNER="stockfish/stockfish-macos-m1-apple-silicon"
    EXT=""
    ;;
  *)
    echo "error: unknown target '$TARGET' (want windows-x64 | linux-x64 | macos-arm64 | host)" >&2
    exit 1
    ;;
esac

DEST="${DEST_DIR}/stockfish-${TRIPLE}${EXT}"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# Already fetched and still matching the pinned archive's binary? The marker
# file records which archive digest produced the current binary.
MARKER="${DEST}.sha256"
if [[ -f "$DEST" && -f "$MARKER" && "$(cat "$MARKER")" == "$SHA256" ]]; then
  echo "sidecar up to date: $DEST (release ${STOCKFISH_RELEASE})"
  exit 0
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

echo "downloading ${ASSET} (${STOCKFISH_RELEASE}) ..."
curl -fsSL -o "${WORK_DIR}/${ASSET}" "${BASE_URL}/${ASSET}"

ACTUAL="$(sha256_of "${WORK_DIR}/${ASSET}")"
if [[ "$ACTUAL" != "$SHA256" ]]; then
  echo "error: sha256 mismatch for ${ASSET}" >&2
  echo "  expected: ${SHA256}" >&2
  echo "  actual:   ${ACTUAL}" >&2
  exit 1
fi
echo "sha256 verified: ${ACTUAL}"

case "$ASSET" in
  *.zip)
    # Git Bash on the Windows CI runner has no unzip; 7-Zip is preinstalled.
    if command -v unzip >/dev/null 2>&1; then
      unzip -q "${WORK_DIR}/${ASSET}" "$INNER" -d "$WORK_DIR"
    else
      (cd "$WORK_DIR" && 7z x -y "$ASSET" "$INNER" >/dev/null)
    fi
    ;;
  *.tar) tar -xf "${WORK_DIR}/${ASSET}" -C "$WORK_DIR" "$INNER" ;;
esac

if [[ ! -f "${WORK_DIR}/${INNER}" ]]; then
  echo "error: ${INNER} not found inside ${ASSET}" >&2
  exit 1
fi

mkdir -p "$DEST_DIR"
cp "${WORK_DIR}/${INNER}" "$DEST"
chmod +x "$DEST"
echo "$SHA256" > "$MARKER"

echo "sidecar ready: $DEST"
