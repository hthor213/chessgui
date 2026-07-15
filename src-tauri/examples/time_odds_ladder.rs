//! Time-odds ladder — measures Elo-per-doubling of think time for Stockfish
//! self-play ON THIS MACHINE. Each rung pits Stockfish against Stockfish where
//! the SLOW side gets exactly 2× the FAST side's base clock AND increment (one
//! doubling of compute). Because the odds are exactly 2×, the measured Elo of
//! the slow side over the fast side IS the Elo-per-doubling `b(t)` the speed/Elo
//! model in spec 216 wants — sampled at each rung's time control.
//!
//! Both sides run the same engine; the ONLY asymmetry is the clock. Positions
//! come from the tagged pool restricted to a LOW imbalance band (near-equal
//! starts), played color-flipped so board-color advantage cancels, and the slow
//! side alternates White/Black across each flipped pair.
//!
//! Results are persisted resumably to `data/calibration/ladder_<hostname>.json`:
//! finished rungs are skipped on restart unless `--force`. Cheapest rung first.
//!
//!   cd src-tauri && cargo run --release --example time_odds_ladder -- [--rung NAME] [--games N] [--engine PATH] [--out PATH] [--force]
//!
//! No args runs the whole default ladder. `--rung NAME` runs a single rung;
//! `--games N` overrides its game count (handy for a quick plumbing smoke run).

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use chessgui_lib::match_runner::{run_batch_core, GameSpec};

const STOCKFISH: &str = "/opt/homebrew/bin/stockfish";

/// One ladder rung: the FAST side's clock, and (implicitly) the SLOW side at 2×
/// both terms. `name` is the canonical identifier used on the CLI and as the
/// persisted JSON key; it is NOT recomputed from the clocks.
struct Rung {
    name: &'static str,
    fast_base_ms: u64,
    fast_inc_ms: u64,
    games: usize,
}

/// The default ladder, cheapest first. Slow side = 2× fast base AND 2× fast inc.
const LADDER: &[Rung] = &[
    Rung { name: "62ms", fast_base_ms: 500, fast_inc_ms: 50, games: 1000 },
    Rung { name: "250ms", fast_base_ms: 2000, fast_inc_ms: 200, games: 1000 },
    Rung { name: "1s", fast_base_ms: 8000, fast_inc_ms: 800, games: 500 },
    Rung { name: "5.7s", fast_base_ms: 32000, fast_inc_ms: 3200, games: 200 },
];

/// Representative seconds-per-move budget for a base+inc control, in ms, under
/// the usual ~40-move-per-game convention: `(base + 40·inc) / 40`.
fn ms_per_move(base_ms: u64, inc_ms: u64) -> u64 {
    (base_ms + 40 * inc_ms) / 40
}

fn to_elo(s: f64) -> f64 {
    let c = s.clamp(1e-9, 1.0 - 1e-9);
    -400.0 * (1.0 / c - 1.0).log10()
}

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

/// Local machine hostname (for the per-machine calibration file). Falls back to
/// "unknown" if the `hostname` command is unavailable.
fn hostname() -> String {
    Command::new("hostname")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Sample `need` near-equal start positions from the tagged pool, round-robin
/// across |eval| bins within [imb_lo, imb_hi). Mirrors full_match's sampler.
fn sample_positions(need: usize, imb_lo: f64, imb_hi: f64) -> Vec<String> {
    let raw = std::fs::read_to_string("../data/tagged_positions.json")
        .expect("run from src-tauri/ so ../data resolves");
    let arr: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let bin = 0.25f64;
    let nbins = (((imb_hi - imb_lo) / bin).round() as usize).max(1);
    let mut buckets: Vec<Vec<String>> = vec![Vec::new(); nbins];
    for p in arr.as_array().unwrap() {
        let e = p["eval_pawns"].as_f64().unwrap();
        let m = e.abs();
        if m >= imb_lo && m < imb_hi {
            let idx = (((m - imb_lo) / bin) as usize).min(nbins - 1);
            buckets[idx].push(p["fen"].as_str().unwrap().to_string());
        }
    }
    let active: Vec<usize> = (0..nbins).filter(|&i| !buckets[i].is_empty()).collect();
    let mut seeds: Vec<String> = Vec::new();
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
    seeds
}

/// Outcome tally of one rung, from the SLOW side's perspective.
struct RungResult {
    slow_wins: usize,
    draws: usize,
    fast_wins: usize,
    errs: usize,
    elapsed_s: f64,
}

/// Play one rung and tally results from the slow side's perspective.
async fn run_rung(engine: &str, rung: &Rung, games: usize) -> RungResult {
    let (slow_base, slow_inc) = (rung.fast_base_ms * 2, rung.fast_inc_ms * 2);
    let (fast_base, fast_inc) = (rung.fast_base_ms, rung.fast_inc_ms);

    // Near-equal starts; one seed per flipped pair.
    let need = games.div_ceil(2);
    let seeds = sample_positions(need, 0.0, 0.3);

    // For each seed, two games. `flipped == true` means the SLOW side is Black,
    // so it alternates color across the pair and color advantage cancels. The
    // per-side clock overrides carry the time odds; both sides are the same
    // engine, so only the clock differs.
    let mut specs = Vec::new();
    let mut id = 0usize;
    for fen in &seeds {
        for slow_is_black in [false, true] {
            let (wb, wi, bb, bi) = if slow_is_black {
                (fast_base, fast_inc, slow_base, slow_inc)
            } else {
                (slow_base, slow_inc, fast_base, fast_inc)
            };
            specs.push(GameSpec {
                id,
                white_path: engine.into(),
                black_path: engine.into(),
                start_fen: Some(fen.clone()),
                // Shared fallbacks (unused here — every side is overridden).
                base_ms: fast_base,
                inc_ms: fast_inc,
                max_plies: 400,
                flipped: slow_is_black,
                adjudicate_tb: true,
                white_base_ms: Some(wb),
                white_inc_ms: Some(wi),
                black_base_ms: Some(bb),
                black_inc_ms: Some(bi),
                // Spec-218 participant fields (persona arm) are unused by this
                // pure-UCI ladder; Default keeps the example compiling as
                // GameSpec grows.
                ..Default::default()
            });
            id += 1;
        }
    }
    let total = specs.len();
    let concurrency = std::thread::available_parallelism().map(|p| p.get()).unwrap_or(2);
    println!(
        "  rung {}: fast {}+{} vs slow {}+{}  |  {} games  |  concurrency {}",
        rung.name,
        fast_base as f64 / 1000.0,
        fast_inc as f64 / 1000.0,
        slow_base as f64 / 1000.0,
        slow_inc as f64 / 1000.0,
        total,
        concurrency,
    );

    let cancel = Arc::new(AtomicBool::new(false));
    let start = Instant::now();
    let outcomes = run_batch_core(
        specs,
        concurrency,
        move |p| {
            if p.completed % 50 == 0 || p.completed == p.total {
                println!("    {}/{}  ({:.0}s)", p.completed, p.total, start_secs(&start));
            }
        },
        Arc::new(|_| {}),
        cancel,
    )
    .await;
    let elapsed_s = start.elapsed().as_secs_f64();

    let (mut slow_wins, mut fast_wins, mut draws, mut errs) = (0usize, 0, 0, 0);
    for o in &outcomes {
        match &o.result {
            Err(_) => errs += 1,
            Ok(g) => {
                if g.result == "1/2-1/2" {
                    draws += 1;
                } else if (g.result == "1-0") == !o.flipped {
                    // Slow side is White when !flipped, so a White win (or a
                    // Black win when flipped) is a slow-side win.
                    slow_wins += 1;
                } else {
                    fast_wins += 1;
                }
            }
        }
    }
    RungResult { slow_wins, draws, fast_wins, errs, elapsed_s }
}

/// Elapsed wall seconds since `start` (avoids capturing `start` by move in the
/// progress closure ambiguously).
fn start_secs(start: &Instant) -> f64 {
    start.elapsed().as_secs_f64()
}

#[tokio::main]
async fn main() {
    // --- Arg parsing (named flags). ---
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut rung_filter: Option<String> = None;
    let mut games_override: Option<usize> = None;
    let mut engine = STOCKFISH.to_string();
    let mut out_override: Option<String> = None;
    let mut force = false;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--rung" => {
                rung_filter = args.get(i + 1).cloned();
                i += 2;
            }
            "--games" => {
                games_override = args.get(i + 1).and_then(|s| s.parse().ok());
                i += 2;
            }
            "--engine" => {
                if let Some(p) = args.get(i + 1) {
                    engine = p.clone();
                }
                i += 2;
            }
            "--out" => {
                out_override = args.get(i + 1).cloned();
                i += 2;
            }
            "--force" => {
                force = true;
                i += 1;
            }
            other => {
                eprintln!("unknown arg: {other}");
                i += 1;
            }
        }
    }

    let host = hostname();
    let out_path =
        out_override.unwrap_or_else(|| format!("../data/calibration/ladder_{host}.json"));

    println!("=== TIME-ODDS LADDER  (host {host}) ===");
    println!("  engine: {}", engine_id(&engine));
    println!("  output: {out_path}   force={force}\n");

    // Load any prior results so finished rungs can be skipped.
    let mut store: serde_json::Map<String, serde_json::Value> =
        match std::fs::read_to_string(&out_path) {
            Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
            Err(_) => serde_json::Map::new(),
        };

    // Which rungs to run, cheapest first.
    let selected: Vec<&Rung> = LADDER
        .iter()
        .filter(|r| rung_filter.as_deref().map(|f| f == r.name).unwrap_or(true))
        .collect();
    if selected.is_empty() {
        eprintln!(
            "no rung named {:?}; known: {:?}",
            rung_filter,
            LADDER.iter().map(|r| r.name).collect::<Vec<_>>()
        );
        std::process::exit(1);
    }

    let mut summary: Vec<(String, f64, f64, f64, usize)> = Vec::new();
    for rung in selected {
        if !force && store.contains_key(rung.name) {
            println!("  rung {} already done — skipping (use --force to rerun)", rung.name);
            if let Some(rec) = store.get(rung.name) {
                let elo = rec.get("elo_per_doubling").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let lo = rec.get("ci_lo").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let hi = rec.get("ci_hi").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let g = rec.get("games").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                summary.push((rung.name.to_string(), elo, lo, hi, g));
            }
            continue;
        }

        let games = games_override.unwrap_or(rung.games);
        let res = run_rung(&engine, rung, games).await;

        let played = res.slow_wins + res.fast_wins + res.draws;
        if played == 0 {
            eprintln!("  rung {}: no games completed ({} errors) — not persisted", rung.name, res.errs);
            continue;
        }
        let score = (res.slow_wins as f64 + res.draws as f64 * 0.5) / played as f64;
        let m = score;
        let var = (res.slow_wins as f64 * (1.0 - m).powi(2)
            + res.draws as f64 * (0.5 - m).powi(2)
            + res.fast_wins as f64 * m.powi(2))
            / played as f64;
        let se = (var / played as f64).sqrt();
        let (elo, lo, hi) = (
            to_elo(score),
            to_elo((m - 1.96 * se).max(0.0)),
            to_elo((m + 1.96 * se).min(1.0)),
        );

        println!(
            "  rung {} done in {:.0}s: slow {}  fast {}  draws {}  ({} errors)",
            rung.name, res.elapsed_s, res.slow_wins, res.fast_wins, res.draws, res.errs
        );
        println!(
            "    score {:.3}  Elo/doubling {:+.0}  95% CI [{:+.0}, {:+.0}]  {}\n",
            score,
            elo,
            lo,
            hi,
            if lo > 0.0 || hi < 0.0 { "SIGNIFICANT" } else { "CI includes 0" }
        );

        // Merge this rung's record and persist immediately (resumable).
        let rec = serde_json::json!({
            "rung": rung.name,
            "fast_ms": ms_per_move(rung.fast_base_ms, rung.fast_inc_ms),
            "slow_ms": ms_per_move(rung.fast_base_ms * 2, rung.fast_inc_ms * 2),
            "fast_base_ms": rung.fast_base_ms,
            "fast_inc_ms": rung.fast_inc_ms,
            "slow_base_ms": rung.fast_base_ms * 2,
            "slow_inc_ms": rung.fast_inc_ms * 2,
            "games": played,
            "w": res.slow_wins,   // slow-side perspective
            "d": res.draws,
            "l": res.fast_wins,
            "errors": res.errs,
            "score": score,
            "elo_per_doubling": elo,
            "ci_lo": lo,
            "ci_hi": hi,
            "elapsed_s": res.elapsed_s,
            "finished_at": now_unix(),
        });
        store.insert(rung.name.to_string(), rec);
        persist(&out_path, &store);
        summary.push((rung.name.to_string(), elo, lo, hi, played));
    }

    // Running summary of everything known so far.
    println!("=== LADDER SUMMARY ({}) ===", out_path);
    for (name, elo, lo, hi, g) in &summary {
        println!("  {:>6}  Elo/doubling {:+5.0}  95% CI [{:+.0}, {:+.0}]  ({} games)", name, elo, lo, hi, g);
    }
}

/// Write the calibration store, creating the parent dir if needed.
fn persist(path: &str, store: &serde_json::Map<String, serde_json::Value>) {
    if let Some(dir) = std::path::Path::new(path).parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let json = serde_json::to_string_pretty(store).unwrap();
    if let Err(e) = std::fs::write(path, json) {
        eprintln!("  WARN: failed to write {path}: {e}");
    }
}
