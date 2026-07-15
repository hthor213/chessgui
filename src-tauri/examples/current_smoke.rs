//! Headless smoke test for the Tournament "Current Position" mode.
//!
//! Builds the EXACT `GameSpec`s the "current" start mode produces (a pair of
//! color-flipped games from a user-supplied FEN, matching the 10m+5s rapid
//! default) and runs them through the real batch runner with real engine
//! binaries, printing each outcome verbatim. Covers the start position, a
//! mid-game position (both colors to move), the flipFirst pairing, and a live
//! en-passant square. Uses a SHORT time control so healthy games finish fast.
//!
//! Run with:
//!   cd src-tauri && cargo run --example current_smoke

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use chessgui_lib::match_runner::{run_batch_core, GameOutcome, GameSpec};

const STOCKFISH: &str = "/opt/homebrew/bin/stockfish";
const RECKLESS: &str = "/Users/hjalti/github/chessgui/engines/reckless";

/// Mirror of lib/tournament.ts buildSpecs for a single seed FEN.
fn build_current_specs(fen: &str, base_ms: u64, inc_ms: u64, flip_first: bool) -> Vec<GameSpec> {
    let mut specs = Vec::new();
    let order = if flip_first {
        [true, false]
    } else {
        [false, true]
    };
    let mut id = 0usize;
    for flipped in order {
        specs.push(GameSpec {
            id,
            white_path: if flipped { RECKLESS } else { STOCKFISH }.to_string(),
            black_path: if flipped { STOCKFISH } else { RECKLESS }.to_string(),
            start_fen: Some(fen.to_string()),
            base_ms,
            inc_ms,
            max_plies: 600,
            flipped,
            adjudicate_tb: true,
            ..Default::default()
        });
        id += 1;
    }
    specs
}

async fn run_case(label: &str, fen: &str, flip_first: bool) {
    // Short TC so a healthy game finishes quickly, but the runner path is identical.
    let base_ms = 5_000u64;
    let inc_ms = 100u64;
    let specs = build_current_specs(fen, base_ms, inc_ms, flip_first);

    println!("\n================ CASE: {label} ================");
    println!("fen        = {fen}");
    println!("flip_first = {flip_first}");

    let started = std::time::Instant::now();
    let outcomes: Vec<GameOutcome> = run_batch_core(
        specs,
        2,
        |_p| {},
        Arc::new(|_ev| {}),
        Arc::new(AtomicBool::new(false)),
    )
    .await;
    let elapsed = started.elapsed().as_secs_f64();

    println!("elapsed    = {elapsed:.3}s");
    for o in &outcomes {
        match &o.result {
            Ok(g) => println!(
                "  game {} flipped={} => OK  {} ({}) plies={}",
                o.id, o.flipped, g.result, g.termination, g.plies
            ),
            Err(e) => println!("  game {} flipped={} => ERR  {}", o.id, o.flipped, e),
        }
    }
}

#[tokio::main]
async fn main() {
    // 1) Standard start position (what the board shows on a fresh app).
    run_case(
        "start position",
        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        false,
    )
    .await;

    // 2) A normal mid-game position, White to move (1.e4 e5 2.Nf3 Nc6).
    run_case(
        "midgame white-to-move",
        "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 4 3",
        false,
    )
    .await;

    // 3) Same but Black to move, exercising flipFirst=true (engineASide=black).
    run_case(
        "midgame black-to-move + flipFirst",
        "r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 5 3",
        true,
    )
    .await;

    // 4) A position with a live en-passant square (chessops emits ep only when a
    //    capture is legal — verify shakmaty accepts it).
    run_case(
        "en-passant square set",
        "rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 4",
        false,
    )
    .await;
}
