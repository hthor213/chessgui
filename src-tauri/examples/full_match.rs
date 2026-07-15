//! Headless eval-qualified match — prints both engines' VERSIONS first (so you
//! know exactly what ran), samples positions across an absolute-imbalance range,
//! plays them color-flipped, and reports W/D/L + Elo (Stockfish vs Reckless) ±CI.
//! Mirrors the app's eval-qualified Run.
//!
//!   cd src-tauri && cargo run --example full_match -- [games] [base_ms] [inc_ms] [imb_lo] [imb_hi]
//!   defaults: 3000 10000 100 0.0 2.4

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Instant;

use chessgui_lib::match_runner::{run_batch_core, GameSpec};

const STOCKFISH: &str = "/opt/homebrew/bin/stockfish";
const RECKLESS: &str = "/Users/hjalti/github/chessgui/engines/reckless";

/// Spawn the engine, ask UCI, return its `id name` (e.g. "Stockfish 18").
fn engine_id(path: &str) -> String {
    let mut child = match Command::new(path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return format!("<failed to spawn: {e}>"),
    };
    {
        let mut stdin = child.stdin.take().unwrap();
        let _ = writeln!(stdin, "uci");
        let _ = writeln!(stdin, "quit");
    }
    let mut name = "<unknown>".to_string();
    if let Some(out) = child.stdout.take() {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            if let Some(rest) = line.strip_prefix("id name ") {
                name = rest.trim().to_string();
                break;
            }
            if line.starts_with("uciok") {
                break;
            }
        }
    }
    let _ = child.wait();
    name
}

fn to_elo(s: f64) -> f64 {
    let c = s.clamp(1e-9, 1.0 - 1e-9);
    -400.0 * (1.0 / c - 1.0).log10()
}

#[tokio::main]
async fn main() {
    let a: Vec<String> = std::env::args().collect();
    let games: usize = a.get(1).and_then(|s| s.parse().ok()).unwrap_or(3000);
    let base_ms: u64 = a.get(2).and_then(|s| s.parse().ok()).unwrap_or(10_000);
    let inc_ms: u64 = a.get(3).and_then(|s| s.parse().ok()).unwrap_or(100);
    let imb_lo: f64 = a.get(4).and_then(|s| s.parse().ok()).unwrap_or(0.0);
    let imb_hi: f64 = a.get(5).and_then(|s| s.parse().ok()).unwrap_or(2.4);

    println!("=== ENGINES (verify versions) ===");
    println!("  Stockfish: {}", engine_id(STOCKFISH));
    println!("  Reckless : {}", engine_id(RECKLESS));
    println!(
        "TC = {}s+{}s  |  |imbalance| in [{}, {}]  |  target games = {}\n",
        base_ms as f64 / 1000.0,
        inc_ms as f64 / 1000.0,
        imb_lo,
        imb_hi,
        games
    );

    // Sample positions by |eval| bins (round-robin) from the tagged pool.
    let raw = std::fs::read_to_string("../data/tagged_positions.json")
        .expect("run from src-tauri/ so ../data resolves");
    let arr: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let bin = 0.25f64;
    let nbins = (((imb_hi - imb_lo) / bin).round() as usize).max(1);
    let mut buckets: Vec<Vec<(String, f64)>> = vec![Vec::new(); nbins];
    for p in arr.as_array().unwrap() {
        let e = p["eval_pawns"].as_f64().unwrap();
        let m = e.abs();
        if m >= imb_lo && m < imb_hi {
            let idx = (((m - imb_lo) / bin) as usize).min(nbins - 1);
            buckets[idx].push((p["fen"].as_str().unwrap().to_string(), e));
        }
    }
    let active: Vec<usize> = (0..nbins).filter(|&i| !buckets[i].is_empty()).collect();
    let need = games.div_ceil(2);
    let mut seeds: Vec<(String, f64)> = Vec::new();
    let mut cur = vec![0usize; nbins];
    while seeds.len() < need {
        let mut progressed = false;
        for &i in &active {
            if seeds.len() >= need {
                break;
            }
            if cur[i] < buckets[i].len() {
                seeds.push(buckets[i][cur[i]].clone());
                cur[i] += 1;
                progressed = true;
            }
        }
        if !progressed {
            cur.iter_mut().for_each(|c| *c = 0); // exhausted distinct positions; reuse
        }
    }

    // Color-flipped specs (Stockfish = engine A).
    let mut specs = Vec::new();
    let mut id = 0usize;
    for (fen, _e) in &seeds {
        for flipped in [false, true] {
            let (w, b) = if flipped { (RECKLESS, STOCKFISH) } else { (STOCKFISH, RECKLESS) };
            specs.push(GameSpec {
                id,
                white_path: w.into(),
                black_path: b.into(),
                start_fen: Some(fen.clone()),
                base_ms,
                inc_ms,
                max_plies: 400,
                flipped,
                adjudicate_tb: true,
                ..Default::default()
            });
            id += 1;
        }
    }
    let total = specs.len();
    let concurrency = std::thread::available_parallelism().map(|p| p.get()).unwrap_or(2);
    println!("running {total} games, concurrency {concurrency} ...");

    let cancel = Arc::new(AtomicBool::new(false));
    let start = Instant::now();
    let outcomes = run_batch_core(
        specs,
        concurrency,
        move |p| {
            if p.completed % 200 == 0 || p.completed == p.total {
                println!("  {}/{}  ({:.0}s)", p.completed, p.total, p.completed as f64);
            }
        },
        Arc::new(|_| {}),
        cancel,
    )
    .await;
    let secs = start.elapsed().as_secs_f64();

    let (mut sf_w, mut rk_w, mut draws, mut errs) = (0usize, 0, 0, 0);
    for o in &outcomes {
        match &o.result {
            Err(_) => errs += 1,
            Ok(g) => {
                if g.result == "1/2-1/2" {
                    draws += 1;
                } else if (g.result == "1-0") == !o.flipped {
                    sf_w += 1; // Stockfish (engine A) is White when !flipped
                } else {
                    rk_w += 1;
                }
            }
        }
    }
    let played = sf_w + rk_w + draws;
    let score = (sf_w as f64 + draws as f64 * 0.5) / played as f64;
    let m = score;
    let var = (sf_w as f64 * (1.0 - m).powi(2)
        + draws as f64 * (0.5 - m).powi(2)
        + rk_w as f64 * m.powi(2))
        / played as f64;
    let se = (var / played as f64).sqrt();
    let (elo, lo, hi) = (
        to_elo(score),
        to_elo((m - 1.96 * se).max(0.0)),
        to_elo((m + 1.96 * se).min(1.0)),
    );

    println!("\n=== RESULT  ({:.0}s = {:.1} min) ===", secs, secs / 60.0);
    println!("games {played}  errors {errs}");
    println!("Stockfish wins {sf_w}   Reckless wins {rk_w}   draws {draws}");
    println!(
        "Elo (Stockfish vs Reckless) = {:+.0}   95% CI [{:+.0}, {:+.0}]   {}",
        elo,
        lo,
        hi,
        if lo > 0.0 || hi < 0.0 { "SIGNIFICANT" } else { "not significant (CI includes 0)" }
    );
}
