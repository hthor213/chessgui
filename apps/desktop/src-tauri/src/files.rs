//! Text-file IPC for the native open/save dialogs (spec 013).
//!
//! The webview cannot read or write arbitrary filesystem paths, so once
//! tauri-plugin-dialog has produced a path (open picker for PGN import,
//! save dialog for PGN export) these two commands move the file contents
//! across the IPC boundary. Same shape as match_runner's
//! `read_opening_positions`, which predates this module and stays put with
//! the tournament code it serves.

/// Byte cap for `read_text_file`. Big enough for any hand-picked PGN
/// (multi-game files included); only exists so a mispicked huge/binary
/// file can't flood the IPC channel.
const TEXT_FILE_MAX_BYTES: u64 = 32 * 1024 * 1024;

/// Core of `read_text_file`, cap injectable so the error path is testable.
pub fn read_text_file_in(path: &str, max_bytes: u64) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("Failed to read {path}: {e}"))?;
    if meta.len() > max_bytes {
        return Err(format!(
            "{path} is {} bytes — over the {max_bytes}-byte cap for a text file",
            meta.len()
        ));
    }
    std::fs::read_to_string(path).map_err(|e| format!("Failed to read {path}: {e}"))
}

/// Tauri command: read a user-picked text file (PGN import, spec 013).
#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    read_text_file_in(&path, TEXT_FILE_MAX_BYTES)
}

/// Tauri command: write text to a path the user chose in the native save
/// dialog (PGN export, spec 013). Overwrites — the dialog already asked
/// about replacing an existing file.
#[tauri::command]
pub fn write_text_file(path: String, text: String) -> Result<(), String> {
    std::fs::write(&path, text).map_err(|e| format!("Failed to write {path}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("files-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir.join(name)
    }

    #[test]
    fn write_then_read_roundtrips() {
        let path = temp_path("roundtrip.pgn");
        let pgn = "[Event \"?\"]\n\n1. e4 e5 *\n";
        write_text_file(path.to_string_lossy().into_owned(), pgn.to_string()).unwrap();
        let back = read_text_file(path.to_string_lossy().into_owned()).unwrap();
        assert_eq!(back, pgn);
    }

    #[test]
    fn write_overwrites_existing_file() {
        let path = temp_path("overwrite.pgn");
        let p = path.to_string_lossy().into_owned();
        write_text_file(p.clone(), "old contents".to_string()).unwrap();
        write_text_file(p.clone(), "new".to_string()).unwrap();
        assert_eq!(read_text_file(p).unwrap(), "new");
    }

    #[test]
    fn read_missing_file_errors() {
        let err = read_text_file("/definitely/not/a/real/file.pgn".to_string()).unwrap_err();
        assert!(err.contains("Failed to read"), "got: {err}");
    }

    #[test]
    fn read_over_cap_errors() {
        let path = temp_path("big.pgn");
        std::fs::write(&path, "x".repeat(64)).unwrap();
        let err = read_text_file_in(&path.to_string_lossy(), 16).unwrap_err();
        assert!(err.contains("over the 16-byte cap"), "got: {err}");
    }
}
