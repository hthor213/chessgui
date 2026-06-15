mod uci;
pub mod match_runner;

use std::sync::Mutex;

#[tauri::command]
fn ping() -> String {
    "pong".to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(Mutex::new(uci::EngineState::default()))
        .manage(match_runner::BatchCancel::default())
        .invoke_handler(tauri::generate_handler![
            ping,
            uci::start_engine,
            uci::send_command,
            uci::stop_engine,
            match_runner::play_game,
            match_runner::play_batch,
            match_runner::cancel_batch,
            match_runner::engine_id,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
