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
const RECKLESS: &str = "/Users/hjalti/github/chessgui/engines/reckless";

#[tokio::main]
async fn main() {
    // Fast sudden-death + increment clock so the smoke test stays quick.
    let base_ms = 1000u64; // 1s base
    let inc_ms = 100u64; //  0.1s increment
    let max_plies = 300;

    println!(
        "Playing: White=Stockfish  Black=Reckless  clock={}ms+{}ms  max_plies={}",
        base_ms, inc_ms, max_plies
    );

    // Pure engine game: tablebase adjudication off so we exercise the full
    // play-out path here. (batch_smoke covers the adjudicated path.)
    let adjudicate_tb = false;

    let started = std::time::Instant::now();
    match play_game_core(STOCKFISH, RECKLESS, None, base_ms, inc_ms, max_plies, adjudicate_tb).await {
        Ok(game) => {
            println!("\n=== GAME COMPLETE ===");
            println!("result      = {}", game.result);
            println!("termination = {}", game.termination);
            println!("plies       = {}", game.plies);
            println!("wall_clock  = {:.2}s", started.elapsed().as_secs_f64());
            println!("start_fen   = {}", game.start_fen);
            println!("moves       = {}", game.moves.join(" "));
        }
        Err(e) => {
            eprintln!("ERROR: {}", e);
            std::process::exit(1);
        }
    }
}
