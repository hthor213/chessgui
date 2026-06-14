//! Headless smoke test for the engine-vs-engine match runner.
//!
//! Runs ONE full game: Stockfish (white) vs Reckless (black) from the start
//! position at a short movetime, then prints the result. This does not launch
//! the Tauri app — it calls `play_game_core` directly.
//!
//! Run with:
//!   cd src-tauri && cargo run --example match_smoke

use chessgui_lib::match_runner::play_game_core;

const STOCKFISH: &str = "/opt/homebrew/bin/stockfish";
const RECKLESS: &str = "/Users/hjalti/Documents/GitHub/chessgui/engines/reckless";

#[tokio::main]
async fn main() {
    let movetime_ms = 50;
    let max_plies = 300;

    println!(
        "Playing: White=Stockfish  Black=Reckless  movetime={}ms  max_plies={}",
        movetime_ms, max_plies
    );

    match play_game_core(STOCKFISH, RECKLESS, None, movetime_ms, max_plies).await {
        Ok(game) => {
            println!("\n=== GAME COMPLETE ===");
            println!("result      = {}", game.result);
            println!("termination = {}", game.termination);
            println!("plies       = {}", game.plies);
            println!("start_fen   = {}", game.start_fen);
            println!("moves       = {}", game.moves.join(" "));
        }
        Err(e) => {
            eprintln!("ERROR: {}", e);
            std::process::exit(1);
        }
    }
}
