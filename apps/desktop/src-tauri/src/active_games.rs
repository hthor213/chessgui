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

// ---- chess.com Published-Data API proxy (spec 219 D/F) ----
//
// The webview cannot call api.chess.com directly: a cross-origin fetch from
// tauri://localhost fails with WebKit's opaque "Load failed" (user-reported
// 2026-07-20 on the live-position sync). Routing it through Rust fixes that
// and, as a bonus, lets us send the descriptive User-Agent chess.com's
// etiquette asks for — browsers strip that header as a forbidden name.
//
// Deliberately NOT a general-purpose proxy: only the public, read-only
// chess.com API prefix is reachable, so a frontend bug (or anything that
// reaches `invoke`) cannot turn this into an open request forwarder.

const CHESSCOM_ALLOWED_PREFIX: &str = "https://api.chess.com/pub/";

/// A fetch result shaped for the TS `FetchLike` seam (core/chesscom.ts):
/// transport failures are the `Err` case, while HTTP failures come back as
/// `ok: false` with the status, exactly as `fetch` would report them.
#[derive(serde::Serialize)]
pub struct ChesscomResponse {
    pub ok: bool,
    pub status: u16,
    pub body: String,
}

#[tauri::command]
pub async fn chesscom_get(url: String, user_agent: String) -> Result<ChesscomResponse, String> {
    if !url.starts_with(CHESSCOM_ALLOWED_PREFIX) {
        return Err(format!(
            "refusing to fetch {url}: only {CHESSCOM_ALLOWED_PREFIX}* is allowed"
        ));
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("building http client: {e}"))?;
    let resp = client
        .get(&url)
        .header(reqwest::header::USER_AGENT, user_agent)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|e| format!("requesting {url}: {e}"))?;
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("reading body of {url}: {e}"))?;
    Ok(ChesscomResponse {
        ok: status.is_success(),
        status: status.as_u16(),
        body,
    })
}
