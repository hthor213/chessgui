//! Default engine resolution + engine process spawning, per OS (spec 222).
//!
//! Where "the engine" lives on a fresh install, before the user has picked a
//! binary with the spec 011 file picker. Resolution order (spec 222 Tier 0):
//!   1. the bundled Stockfish sidecar (Tauri `bundle.externalBin` — the
//!      bundler drops it next to the app executable on every OS),
//!   2. a PATH lookup for `stockfish` / `stockfish.exe`,
//!   3. on macOS only: the pre-sidecar Homebrew constant, keeping today's
//!      behavior until spec 220 unifies the sidecar story on all three OSes.
//! The user-set path (spec 011) overrides all of this on the frontend side
//! (lib/engine-settings.ts `loadEnginePath`), which is what makes the file
//! picker the escape hatch for CPUs the bundled AVX2 build can't run on.

use std::ffi::OsStr;
use std::path::PathBuf;

#[cfg(windows)]
const ENGINE_BINARY: &str = "stockfish.exe";
#[cfg(not(windows))]
const ENGINE_BINARY: &str = "stockfish";

/// Homebrew default (Apple Silicon) — the constant that used to live in
/// shared frontend code before spec 220 killed it out of there.
#[cfg(target_os = "macos")]
const HOMEBREW_STOCKFISH: &str = "/opt/homebrew/bin/stockfish";

/// The bundled sidecar, if this install has one. Tauri places `externalBin`
/// binaries in the same directory as the main executable on every target
/// (Windows install dir, Linux `usr/bin` in .deb/AppImage, macOS
/// `Contents/MacOS`), with the target-triple suffix stripped.
fn sidecar_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let candidate = exe.parent()?.join(ENGINE_BINARY);
    candidate.is_file().then_some(candidate)
}

/// First `stockfish` on the given PATH-shaped variable, absolute.
fn path_lookup_in(path_var: &OsStr) -> Option<PathBuf> {
    std::env::split_paths(path_var)
        .filter(|dir| !dir.as_os_str().is_empty())
        .map(|dir| dir.join(ENGINE_BINARY))
        .find(|candidate| candidate.is_file())
}

/// The shell-default engine binary for this OS, or "" when nothing is found
/// (Windows/Linux with no sidecar and no PATH hit — the frontend turns that
/// into the plain-language file-picker prompt, spec 222 AVX2 escape hatch).
pub fn resolve_default_engine_path() -> String {
    if let Some(p) = sidecar_path() {
        return p.to_string_lossy().into_owned();
    }
    if let Some(p) = std::env::var_os("PATH").and_then(|v| path_lookup_in(&v)) {
        return p.to_string_lossy().into_owned();
    }
    // GUI-launched macOS apps don't inherit the shell PATH, so the PATH scan
    // above misses Homebrew — fall back to the historical constant verbatim
    // (returned even if absent, matching pre-222 behavior: the start error
    // then names the path the user expects to see).
    #[cfg(target_os = "macos")]
    return HOMEBREW_STOCKFISH.to_string();
    #[cfg(not(target_os = "macos"))]
    String::new()
}

/// A `tokio::process::Command` for a UCI engine child. On Windows this sets
/// CREATE_NO_WINDOW so an engine start doesn't flash a console window (spec
/// 222 platform quirks ledger) — use this instead of `Command::new` for
/// every engine spawn.
#[allow(unused_mut)]
pub fn engine_command(program: impl AsRef<OsStr>) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(program);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    cmd
}

/// Resolved fresh on every call rather than cached: the sidecar only exists
/// in bundled installs and PATH can change between launches.
#[tauri::command]
pub fn default_engine_path() -> String {
    resolve_default_engine_path()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_lookup_finds_engine_in_fabricated_path() {
        let dir = std::env::temp_dir().join(format!("engine-path-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("mkdir");
        let bin = dir.join(ENGINE_BINARY);
        std::fs::write(&bin, b"#!/bin/sh\n").expect("write stub");

        let path_var = std::env::join_paths([dir.clone()]).expect("join_paths");
        assert_eq!(path_lookup_in(&path_var), Some(bin));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn path_lookup_misses_cleanly() {
        let dir = std::env::temp_dir().join("engine-path-test-definitely-absent");
        let path_var = std::env::join_paths([dir]).expect("join_paths");
        assert_eq!(path_lookup_in(&path_var), None);
    }

    // macOS keeps its Homebrew default even with no sidecar and an empty
    // PATH scan — pre-222 behavior preserved verbatim (spec 222 decision).
    #[cfg(target_os = "macos")]
    #[test]
    fn macos_default_is_never_empty() {
        assert!(!resolve_default_engine_path().is_empty());
    }
}
