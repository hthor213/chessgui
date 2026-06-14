//! Headless smoke test for the parallel batch runner (Milestone 2).
//!
//! Builds N=20 GameSpecs of Stockfish (white) vs Reckless (black) from the
//! start position at a short movetime, then runs them concurrently with a
//! bounded concurrency limit (= available_parallelism). Prints incremental
//! progress, the aggregate summary, and total wall-clock time. This does not
//! launch the Tauri app — it calls `run_batch_core` directly.
//!
//! Run with:
//!   cd src-tauri && cargo run --example batch_smoke

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Instant;

use chessgui_lib::match_runner::{run_batch_core, summarize, GameSpec};

const STOCKFISH: &str = "/opt/homebrew/bin/stockfish";
const RECKLESS: &str = "/Users/hjalti/Documents/GitHub/chessgui/engines/reckless";

#[tokio::main]
async fn main() {
    let n = 20usize;
    let movetime_ms = 50u64;
    let max_plies = 300usize;
    let concurrency = std::thread::available_parallelism()
        .map(|p| p.get())
        .unwrap_or(2);

    println!(
        "Batch: {} games  White=Stockfish  Black=Reckless  movetime={}ms  max_plies={}  concurrency={}",
        n, movetime_ms, max_plies, concurrency
    );

    let specs: Vec<GameSpec> = (0..n)
        .map(|id| GameSpec {
            id,
            white_path: STOCKFISH.to_string(),
            black_path: RECKLESS.to_string(),
            start_fen: None,
            movetime_ms,
            max_plies,
            flipped: false,
        })
        .collect();

    let cancel = Arc::new(AtomicBool::new(false));

    // Count streamed moves to prove the on_move callback fires.
    let move_count = Arc::new(AtomicUsize::new(0));
    let move_count_cb = Arc::clone(&move_count);

    let start = Instant::now();
    let outcomes = run_batch_core(
        specs,
        concurrency,
        move |p| {
            println!("completed {}/{}", p.completed, p.total);
        },
        Arc::new(move |_ev| {
            move_count_cb.fetch_add(1, Ordering::SeqCst);
        }),
        cancel,
    )
    .await;
    let elapsed = start.elapsed();

    let summary = summarize(&outcomes);

    println!("\n=== BATCH SUMMARY ===");
    println!("games       = {}", summary.games);
    println!("white_wins  = {}", summary.white_wins);
    println!("black_wins  = {}", summary.black_wins);
    println!("draws       = {}", summary.draws);
    println!("errors      = {}", summary.errors);
    println!("move_events = {}", move_count.load(Ordering::SeqCst));
    println!("wall_clock  = {:.2}s", elapsed.as_secs_f64());

    // Surface any errors for debugging.
    for o in &outcomes {
        if let Err(e) = &o.result {
            eprintln!("game {} errored: {}", o.id, e);
        }
    }
}
