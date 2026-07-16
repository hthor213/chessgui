pub mod cbh;
pub mod calibration;
pub mod coach;
pub mod db;
pub mod machine;
pub mod maia;
pub mod persona;
pub mod puzzles;
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
            match_runner::save_tournament_result,
            match_runner::list_tournament_results,
            match_runner::load_tournament_result,
            db::db_import_pgn,
            db::db_import_cbh,
            db::db_list_games,
            db::db_search_position,
            db::db_get_game,
            db::db_delete_games,
            db::db_stats,
            puzzles::puzzles_import,
            puzzles::puzzles_deck,
            puzzles::puzzles_get,
            puzzles::puzzles_stats,
            puzzles::puzzle_check_move,
            calibration::calibration_sample,
            calibration::calibration_save_results,
            machine::machine_bench,
            machine::machine_profile_get,
            maia::maia_status,
            maia::maia_policy,
            persona::maia_move,
            persona::persona_move,
            persona::rival_book,
            persona::rival_personas,
            coach::coach_feedback,
            coach::coach_followup,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Spec 011: "Engine process cleaned up on app quit". kill_on_drop
            // does NOT fire on process exit (destructors never run), so the
            // analysis engine and any warm lc0 pool processes would outlive
            // the app as orphans. RunEvent::Exit fires once, after the last
            // window closes and before the process terminates — kill every
            // long-lived child registry here. (match_runner/persona engines
            // are per-game, owned by batch tasks that cancel with the run.)
            if let tauri::RunEvent::Exit = event {
                use tauri::Manager;
                if let Ok(mut engine) = app.state::<Mutex<uci::EngineState>>().lock() {
                    engine.shutdown();
                }
                tauri::async_runtime::block_on(app.state::<maia::MaiaState>().shutdown());
            }
        });
}
