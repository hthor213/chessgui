//! Timing calibration for the tournament runner at a real time control.
//!
//! Plays a representative sample (varied openings from data/tagged_positions.json,
//! color-flipped, Stockfish vs Reckless) at Standard TC (60s + 0.6s) with
//! tablebase adjudication on, then reports wall-clock throughput, the
//! termination breakdown / adjudication rate, draw rate and average game length,
//! and extrapolates the wall-clock for a full 500-game run.
//!
//! Run with (cwd must be src-tauri so the data path resolves):
//!   cd src-tauri && cargo run --release --example calibrate -- [games]
//!
//! `games` defaults to 24. Use --release; a debug build's overhead is noise vs
//! the engines but the engines dominate either way.

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Instant;

use chessgui_lib::match_runner::{run_batch_core, GameSpec};

const STOCKFISH: &str = "/opt/homebrew/bin/stockfish";
const RECKLESS: &str = "/Users/hjalti/github/chessgui/engines/reckless";
const BASE_MS: u64 = 60_000;
const INC_MS: u64 = 600;
const MAX_PLIES: usize = 600;
const FULL_RUN: usize = 500;

#[tokio::main]
async fn main() {
    let games: usize = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(24);
    let seeds_needed = games.div_ceil(2);

    // Load varied opening FENs (evenly spaced through the tagged pool).
    let raw = std::fs::read_to_string("../data/tagged_positions.json")
        .expect("read ../data/tagged_positions.json (run from src-tauri/)");
    let arr: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let all = arr.as_array().unwrap();
    let step = (all.len() / seeds_needed).max(1);
    let fens: Vec<String> = (0..seeds_needed)
        .map(|i| all[(i * step) % all.len()]["fen"].as_str().unwrap().to_string())
        .collect();

    // Color-flipped pairs.
    let mut specs: Vec<GameSpec> = Vec::new();
    let mut id = 0usize;
    for fen in &fens {
        for flipped in [false, true] {
            let (w, b) = if flipped { (RECKLESS, STOCKFISH) } else { (STOCKFISH, RECKLESS) };
            specs.push(GameSpec {
                id,
                white_path: w.to_string(),
                black_path: b.to_string(),
                start_fen: Some(fen.clone()),
                base_ms: BASE_MS,
                inc_ms: INC_MS,
                max_plies: MAX_PLIES,
                flipped,
                adjudicate_tb: true,
            });
            id += 1;
        }
    }
    let n = specs.len();
    let concurrency = std::thread::available_parallelism().map(|p| p.get()).unwrap_or(2);

    println!(
        "Calibration: {} games  TC={}s+{}s  adjudicate_tb=on  concurrency={}  openings=eval-qualified(varied)",
        n,
        BASE_MS / 1000,
        INC_MS as f64 / 1000.0,
        concurrency
    );

    let cancel = Arc::new(AtomicBool::new(false));
    let start = Instant::now();
    let outcomes = run_batch_core(
        specs,
        concurrency,
        move |p| {
            if p.completed % 4 == 0 || p.completed == p.total {
                println!("  completed {}/{}", p.completed, p.total);
            }
        },
        Arc::new(|_ev| {}),
        cancel,
    )
    .await;
    let elapsed = start.elapsed().as_secs_f64();

    // Aggregate.
    let mut by_term: HashMap<String, usize> = HashMap::new();
    let (mut decided, mut draws, mut errors, mut total_plies) = (0usize, 0usize, 0usize, 0usize);
    for o in &outcomes {
        match &o.result {
            Ok(g) => {
                *by_term.entry(g.termination.clone()).or_insert(0) += 1;
                total_plies += g.plies;
                if g.result == "1/2-1/2" { draws += 1 } else { decided += 1 }
            }
            Err(_) => errors += 1,
        }
    }
    let played = decided + draws;
    let tb = *by_term.get("tablebase").unwrap_or(&0);

    let games_per_min = n as f64 / elapsed * 60.0;
    let est_500 = elapsed * FULL_RUN as f64 / n as f64;

    println!("\n=== CALIBRATION RESULTS ===");
    println!("wall_clock      = {:.1}s ({:.1} min)", elapsed, elapsed / 60.0);
    println!("throughput      = {:.1} games/min", games_per_min);
    println!("avg wall/game   = {:.1}s (parallel; serial-equiv {:.1}s)",
        elapsed / n as f64, elapsed * concurrency as f64 / n as f64);
    println!("draws           = {}/{} ({:.0}%)", draws, played, 100.0 * draws as f64 / played.max(1) as f64);
    println!("decisive        = {}", decided);
    println!("errors          = {}", errors);
    println!("avg plies       = {:.0}", total_plies as f64 / played.max(1) as f64);
    println!("tablebase-adjud = {}/{} ({:.0}%)", tb, played, 100.0 * tb as f64 / played.max(1) as f64);

    let mut terms: Vec<_> = by_term.into_iter().collect();
    terms.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    println!("terminations    = {}", terms.iter().map(|(t, c)| format!("{} {}", t, c)).collect::<Vec<_>>().join(", "));

    println!("\n=== EXTRAPOLATION ===");
    println!("estimated {} games @ {} lanes = {:.1} min ({:.2} h)",
        FULL_RUN, concurrency, est_500 / 60.0, est_500 / 3600.0);
    println!("oracle (<1h for 500): {}", if est_500 < 3600.0 { "PLAUSIBLE ✅" } else { "looks over 1h ❌" });
}
