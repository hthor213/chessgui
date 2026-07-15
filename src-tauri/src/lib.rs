pub mod cbh;
pub mod calibration;
pub mod coach;
pub mod db;
pub mod maia;
pub mod persona;
mod uci;
mod vision;
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
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Mutex::new(uci::EngineState::default()))
        .manage(match_runner::BatchControl::default())
        .manage(db::DbManager::default())
        .manage(maia::MaiaState::default())
        .invoke_handler(tauri::generate_handler![
            ping,
            vision::recognize_fen,
            uci::start_engine,
            uci::send_command,
            uci::stop_engine,
            match_runner::play_game,
            match_runner::play_batch,
            match_runner::cancel_batch,
            match_runner::pause_batch,
            match_runner::set_auto_start,
            match_runner::start_next_game,
            match_runner::set_move_delay,
            match_runner::engine_id,
            db::db_import_pgn,
            db::db_import_cbh,
            db::db_list_games,
            db::db_search_position,
            db::db_get_game,
            db::db_delete_games,
            db::db_stats,
            calibration::calibration_sample,
            calibration::calibration_save_results,
            maia::maia_status,
            maia::maia_policy,
            persona::maia_move,
            persona::rival_book,
            coach::coach_feedback,
            coach::coach_followup,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
