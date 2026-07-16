//! Active-games store (spec 219 C/D): chess.com daily games in progress,
//! saved via "Continue later" and archived via "Game finished".
//!
//! The document's shape (serialized game trees + metadata) is owned by the
//! TypeScript side (core/active-game.ts `ActiveGamesStore`); this module
//! just persists the raw JSON at `<app_data_dir>/active_games.json` — the
//! same app-data-dir pattern as machine.rs's profile store. Deliberately
//! NOT the spec 200 game database: that holds finished/imported games.

use std::path::PathBuf;

use tauri::Manager;

/// `<app_data_dir>/active_games.json`, creating the dir if absent.
fn store_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("active_games.json"))
}

/// The stored document, or None if nothing has been saved yet.
#[tauri::command]
pub fn active_games_load(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let file = store_path(&app)?;
    match std::fs::read_to_string(&file) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("reading {file:?}: {e}")),
    }
}

/// Persist the whole document. Rejects non-JSON so a frontend bug can't
/// clobber the store with something load() would then choke on.
#[tauri::command]
pub fn active_games_save(app: tauri::AppHandle, json: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&json)
        .map_err(|e| format!("refusing to save malformed active-games JSON: {e}"))?;
    let file = store_path(&app)?;
    std::fs::write(&file, json).map_err(|e| format!("writing {file:?}: {e}"))
}
