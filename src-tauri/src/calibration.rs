//! Eval Calibration (spec 213 data collection).
//!
//! A calibration *session* is a set of positions drawn from the game database,
//! each scored by a local Stockfish, that the user rates by eye — their
//! perceived eval and a one-line reason. Comparing those human numbers to
//! Stockfish is the "lower-end datapoint" the spec-213 human-eval program needs
//! as ground truth (design doc §4/§5: real R-rated humans, not a weakened
//! engine).
//!
//! This module builds a session: it samples candidate positions from `db.rs`,
//! filters and stratifies them by Stockfish eval band and game phase, and writes
//! the session as a JSON research artifact. The user's answers come back from
//! the frontend and are persisted by [`calibration_save_results`]. The on-disk
//! schema is documented in `docs/research/calibration-data-format.md`.

use std::collections::HashSet;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use shakmaty::san::San;
use shakmaty::uci::UciMove;
use shakmaty::{CastlingMode, Chess};
use shakmaty::fen::Fen;
use tauri::ipc::Channel;
use tauri::Manager;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, Command};
use tokio::time::timeout;

use crate::db::{self, Db, SampledPosition};

/// On-disk schema version for session and result files. v2 adds known-Elo game
/// context per position (`white_elo`/`black_elo`/`played_*`/`continuation_san`/
/// `elo_band`); v1 files stay readable (the added fields are simply absent).
const SESSION_VERSION: u32 = 2;

/// Default Stockfish binary (Homebrew, Apple Silicon). Overridable per call.
pub const DEFAULT_STOCKFISH: &str = "/opt/homebrew/bin/stockfish";

/// Positions are drawn from ply 16 on, out of the opening/book.
const MIN_PLY: i64 = 16;

/// Non-pawn phase weight at or below which a position counts as an endgame
/// (24 at the start; ~queens-plus-a-rook-each traded). Above it: middlegame.
const ENDGAME_PHASE_MAX: u32 = 8;

/// Per-position Stockfish budget.
const DEFAULT_MOVETIME_MS: u64 = 500;

/// The four player-Elo bands the sample spans (average of the two players'
/// Elos): each `(min, max_exclusive, label)`. The top band's max is open.
const ELO_BANDS: [(i64, i64, &str); 4] = [
    (0, 1600, "<1600"),
    (1600, 2000, "1600-2000"),
    (2000, 2400, "2000-2400"),
    (2400, 100000, "2400+"),
];

/// Number of strata: |SF eval| band (4) × Elo band (4). Phase is captured and
/// reported but not a hard stratum — endgames are too sparse in the corpus to
/// bucket on (see the coverage note in spec 213); Elo, which has data across all
/// bands, replaces it as the second stratification axis (user directive, v2).
const N_EVAL_BANDS: usize = 4;
const N_BUCKETS: usize = N_EVAL_BANDS * ELO_BANDS.len();

// ---------------------------------------------------------------------------
// Serde boundary types (mirrored in lib/calibration.ts)
// ---------------------------------------------------------------------------

/// One calibration position: the board to judge plus the Stockfish ground truth
/// it will be compared against. All engine numbers are White-POV, matching every
/// other eval in the app.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalibrationPosition {
    pub fen: String,
    /// White-POV centipawns (None when the position is a forced mate).
    pub sf_cp: Option<i64>,
    /// White-POV mate distance in moves (+ = White mates); None when `sf_cp` is set.
    pub sf_mate: Option<i64>,
    /// Stockfish's best move, UCI (e.g. "g1f3").
    pub sf_best_uci: String,
    /// That move in SAN, for display; None if it couldn't be rendered.
    pub sf_best_san: Option<String>,
    /// Sharpness: |eval(pv1) − eval(pv2)| in centipawns when a second line
    /// exists and both are cp scores; None otherwise (one legal move, or a mate).
    pub multipv_gap_cp: Option<i64>,
    /// Material balance in points (P1 N3 B3 R5 Q9), White minus Black.
    pub material: i32,
    /// |SF eval| band label: "0-0.5" | "0.5-1.5" | "1.5-3" | "3+".
    pub band: String,
    /// Game phase: "middlegame" | "endgame".
    pub phase: String,
    pub game_id: i64,
    pub ply: i64,
    // --- v2: known-Elo game context (never shown in the answering UI, to avoid
    //     anchoring the user's eval; revealed only after they answer) ---
    pub white_elo: Option<i64>,
    pub black_elo: Option<i64>,
    /// Average-Elo band of the source game: one of `ELO_BANDS`' labels.
    pub elo_band: String,
    /// Side to move: "white" | "black" — whose move `played_*` is.
    pub to_move: String,
    /// The move actually played from this position in the source game.
    pub played_uci: Option<String>,
    pub played_san: Option<String>,
    /// The next up-to-three moves after the played one, SAN.
    pub continuation_san: Vec<String>,
}

/// A whole calibration session, returned to the UI and written to disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalibrationSession {
    pub version: u32,
    /// Requested number of positions.
    pub n: usize,
    /// Unix-ms creation time; also the session file id.
    pub created_at: i64,
    pub stockfish_path: String,
    pub positions: Vec<CalibrationPosition>,
}

/// Progress ticked to the UI as the sampler works. `evaluated` counts candidates
/// Stockfish-scored; `accepted` counts positions kept; `target` is `n`.
#[derive(Debug, Clone, Serialize)]
pub struct CalibrationProgress {
    pub evaluated: usize,
    pub accepted: usize,
    pub target: usize,
}

// ---------------------------------------------------------------------------
// Stratification helpers
// ---------------------------------------------------------------------------

/// |SF eval| band index and label from a White-POV score. Any mate lands in the
/// top band. `cp`/`mate` are as reported (POV-independent for a magnitude).
fn eval_band(cp: Option<i64>, mate: Option<i64>) -> (usize, &'static str) {
    let pawns = if mate.is_some() {
        f64::INFINITY
    } else {
        (cp.unwrap_or(0) as f64 / 100.0).abs()
    };
    if pawns < 0.5 {
        (0, "0-0.5")
    } else if pawns < 1.5 {
        (1, "0.5-1.5")
    } else if pawns < 3.0 {
        (2, "1.5-3")
    } else {
        (3, "3+")
    }
}

/// Phase index (0 = middlegame, 1 = endgame) and label from the non-pawn phase
/// weight.
fn phase_of(phase_weight: u32) -> (usize, &'static str) {
    if phase_weight <= ENDGAME_PHASE_MAX {
        (1, "endgame")
    } else {
        (0, "middlegame")
    }
}

/// Elo-band index and label for a candidate, from the average of the two
/// players' Elos. Defaults to the top band if an Elo is somehow missing (v2
/// samples only Elo-known games, so this is a belt-and-braces fallback).
fn elo_band_of(white_elo: Option<i64>, black_elo: Option<i64>) -> (usize, &'static str) {
    let avg = match (white_elo, black_elo) {
        (Some(w), Some(b)) => (w + b) / 2,
        _ => return (ELO_BANDS.len() - 1, ELO_BANDS[ELO_BANDS.len() - 1].2),
    };
    for (i, (lo, hi, label)) in ELO_BANDS.iter().enumerate() {
        if avg >= *lo && avg < *hi {
            return (i, label);
        }
    }
    (ELO_BANDS.len() - 1, ELO_BANDS[ELO_BANDS.len() - 1].2)
}

// ---------------------------------------------------------------------------
// Stockfish driver (MultiPV eval; mirrors the engine handling in match_runner)
// ---------------------------------------------------------------------------

/// Raw Stockfish read for one position, side-to-move POV before the White-POV flip.
struct RawEval {
    cp: Option<i64>,
    mate: Option<i64>,
    /// |cp(pv1) − cp(pv2)|, POV-invariant; None unless both lines are cp scores.
    gap_cp: Option<i64>,
    best_uci: Option<String>,
}

struct Engine {
    child: Child,
    stdin: ChildStdin,
    lines: Lines<BufReader<tokio::process::ChildStdout>>,
}

impl Engine {
    async fn spawn(path: &str) -> Result<Self, String> {
        let mut child = Command::new(path)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("Failed to start Stockfish '{}': {}", path, e))?;
        let stdin = child.stdin.take().ok_or("No stdin")?;
        let stdout = child.stdout.take().ok_or("No stdout")?;
        let lines = BufReader::new(stdout).lines();
        Ok(Engine { child, stdin, lines })
    }

    async fn send(&mut self, cmd: &str) -> Result<(), String> {
        self.stdin
            .write_all(cmd.as_bytes())
            .await
            .map_err(|e| format!("Write error: {}", e))?;
        self.stdin
            .write_all(b"\n")
            .await
            .map_err(|e| format!("Write error: {}", e))?;
        self.stdin.flush().await.map_err(|e| format!("Flush error: {}", e))
    }

    async fn read_until<F>(&mut self, wait: Duration, mut pred: F) -> Result<String, String>
    where
        F: FnMut(&str) -> bool,
    {
        let fut = async {
            loop {
                match self.lines.next_line().await {
                    Ok(Some(line)) => {
                        let trimmed = line.trim();
                        if pred(trimmed) {
                            return Ok(trimmed.to_string());
                        }
                    }
                    Ok(None) => return Err("Stockfish closed unexpectedly (EOF)".to_string()),
                    Err(e) => return Err(format!("Read error: {}", e)),
                }
            }
        };
        match timeout(wait, fut).await {
            Ok(res) => res,
            Err(_) => Err("Timed out waiting for Stockfish".to_string()),
        }
    }

    /// Handshake, then request two principal variations.
    async fn init(&mut self) -> Result<(), String> {
        self.send("uci").await?;
        self.read_until(Duration::from_secs(10), |l| l == "uciok").await?;
        self.send("setoption name MultiPV value 2").await?;
        self.send("isready").await?;
        self.read_until(Duration::from_secs(10), |l| l == "readyok").await?;
        Ok(())
    }

    /// Evaluate `fen` at a fixed movetime, returning the last-seen scores for
    /// pv1/pv2 and the engine's best move. Scores are side-to-move POV.
    async fn eval(&mut self, fen: &str, movetime_ms: u64) -> Result<RawEval, String> {
        self.send(&format!("position fen {}", fen)).await?;
        let mut pv1: (Option<i64>, Option<i64>) = (None, None);
        let mut pv1_first: Option<String> = None;
        let mut pv2_cp: Option<i64> = None;
        self.send(&format!("go movetime {}", movetime_ms)).await?;
        let wait = Duration::from_millis(movetime_ms.saturating_add(8000).max(8000));
        let bestline = self
            .read_until(wait, |line| {
                if line.starts_with("info ") {
                    if let Some((idx, cp, mate, first)) = parse_multipv_line(line) {
                        if idx == 1 {
                            pv1 = (cp, mate);
                            if first.is_some() {
                                pv1_first = first;
                            }
                        } else if idx == 2 && cp.is_some() {
                            pv2_cp = cp;
                        }
                    }
                }
                line.starts_with("bestmove")
            })
            .await?;

        // "bestmove <uci> [ponder <uci>]" — authoritative best move.
        let best_uci = bestline
            .split_whitespace()
            .nth(1)
            .filter(|m| *m != "(none)" && *m != "0000")
            .map(|m| m.to_string())
            .or(pv1_first);

        let gap_cp = match (pv1.0, pv2_cp) {
            (Some(a), Some(b)) => Some((a - b).abs()),
            _ => None,
        };
        Ok(RawEval {
            cp: pv1.0,
            mate: pv1.1,
            gap_cp,
            best_uci,
        })
    }

    async fn quit(mut self) {
        let _ = self.send("quit").await;
        let _ = timeout(Duration::from_millis(500), self.child.wait()).await;
        let _ = self.child.start_kill();
    }
}

/// Parse a `multipv` index, score, and first PV move from a UCI `info` line.
/// Returns None if the line carries none of them. Score is side-to-move POV.
fn parse_multipv_line(line: &str) -> Option<(u32, Option<i64>, Option<i64>, Option<String>)> {
    let mut idx = 1u32; // engines omit `multipv` when MultiPV=1
    let mut cp = None;
    let mut mate = None;
    let mut first = None;
    let mut it = line.split_whitespace();
    while let Some(tok) = it.next() {
        match tok {
            "multipv" => {
                if let Some(v) = it.next() {
                    idx = v.parse().unwrap_or(1);
                }
            }
            "score" => match it.next() {
                Some("cp") => cp = it.next().and_then(|v| v.parse().ok()),
                Some("mate") => mate = it.next().and_then(|v| v.parse().ok()),
                _ => {}
            },
            "pv" => {
                first = it.next().map(|s| s.to_string());
                break; // score always precedes pv on a UCI info line
            }
            _ => {}
        }
    }
    if cp.is_none() && mate.is_none() && first.is_none() {
        return None;
    }
    Some((idx, cp, mate, first))
}

/// Whether it is Black to move in `fen` (2nd FEN field).
fn black_to_move(fen: &str) -> bool {
    fen.split_whitespace().nth(1) == Some("b")
}

/// SAN for `uci` played in `fen`, or None if either won't parse.
fn san_for(fen: &str, uci: &str) -> Option<String> {
    let pos: Chess = Fen::from_ascii(fen.as_bytes())
        .ok()?
        .into_position(CastlingMode::Standard)
        .ok()?;
    let m = UciMove::from_ascii(uci.as_bytes()).ok()?.to_move(&pos).ok()?;
    Some(San::from_move(&pos, m).to_string())
}

// ---------------------------------------------------------------------------
// The sampler
// ---------------------------------------------------------------------------

/// Turn a sampled candidate + its Stockfish read into a finished position,
/// converting the engine score to White-POV. The returned bucket index is over
/// the |SF eval| band × Elo band strata.
fn finish_position(cand: &SampledPosition, ev: RawEval) -> (CalibrationPosition, usize) {
    let flip = black_to_move(&cand.fen);
    let sf_cp = ev.cp.map(|v| if flip { -v } else { v });
    let sf_mate = ev.mate.map(|v| if flip { -v } else { v });
    let (band_i, band) = eval_band(sf_cp, sf_mate);
    let (_phase_i, phase) = phase_of(cand.phase);
    let (elo_i, elo_band) = elo_band_of(cand.white_elo, cand.black_elo);
    let best = ev.best_uci.unwrap_or_default();
    let san = if best.is_empty() {
        None
    } else {
        san_for(&cand.fen, &best)
    };
    let pos = CalibrationPosition {
        fen: cand.fen.clone(),
        sf_cp,
        sf_mate,
        sf_best_uci: best,
        sf_best_san: san,
        multipv_gap_cp: ev.gap_cp,
        material: cand.material,
        band: band.to_string(),
        phase: phase.to_string(),
        game_id: cand.game_id,
        ply: cand.ply,
        white_elo: cand.white_elo,
        black_elo: cand.black_elo,
        elo_band: elo_band.to_string(),
        to_move: if cand.white_to_move { "white" } else { "black" }.to_string(),
        played_uci: cand.played_uci.clone(),
        played_san: cand.played_san.clone(),
        continuation_san: cand.continuation_san.clone(),
    };
    (pos, band_i * ELO_BANDS.len() + elo_i)
}

/// Round-robin merge several candidate lists into one, so consuming the front of
/// the result stays balanced across the source bands.
fn interleave(mut bands: Vec<Vec<SampledPosition>>) -> Vec<SampledPosition> {
    let total: usize = bands.iter().map(|b| b.len()).sum();
    let mut out = Vec::with_capacity(total);
    // Reverse each so we can pop from the cheap end while preserving order.
    for b in &mut bands {
        b.reverse();
    }
    let mut any = true;
    while any {
        any = false;
        for b in &mut bands {
            if let Some(x) = b.pop() {
                out.push(x);
                any = true;
            }
        }
    }
    out
}

/// Build a stratified session of `n` positions.
///
/// An Elo-balanced candidate pool is drawn from the DB, then Stockfish scores
/// candidates that pass the cheap filters (not in check, not adjacent to a
/// capture, not a duplicate position) until each of the 16 strata (|SF eval|
/// band × Elo band) reaches its share of `n`. Stockfish work is bounded:
/// scored-but-not-needed positions are kept and used to top up to `n` if some
/// stratum can't fill, so no evaluation is wasted.
async fn build_session(
    db_path: String,
    n: usize,
    stockfish_path: String,
    movetime_ms: u64,
    on_progress: Option<Channel<CalibrationProgress>>,
) -> Result<CalibrationSession, String> {
    // Draw an Elo-balanced candidate pool on a blocking thread (rusqlite + the
    // RANDOM scans must not block the async runtime): an equal slice per Elo
    // band, round-robin interleaved so acceptance stays balanced even if the
    // evaluation budget cuts the loop short. Bands are drawn evenly precisely
    // because the corpus is lopsided (70% of games are 2400+), so a plain random
    // draw would starve the low bands the artifact most wants to span.
    let per_band = ((n as i64 * 2) / ELO_BANDS.len() as i64).clamp(40, 2000);
    let pool: Vec<SampledPosition> = tokio::task::spawn_blocking(move || {
        let db = Db::open(&db_path).map_err(|e| e.to_string())?;
        let mut bands: Vec<Vec<SampledPosition>> = Vec::with_capacity(ELO_BANDS.len());
        for (lo, hi, _) in ELO_BANDS {
            let got = db
                .sample_positions_in_elo_band(lo, hi, MIN_PLY, per_band)
                .map_err(|e| e.to_string())?;
            bands.push(got);
        }
        Ok::<_, String>(interleave(bands))
    })
    .await
    .map_err(|e| format!("Sampling task failed: {}", e))??;

    if pool.is_empty() {
        return Err(
            "No Elo-known positions available to sample — is the game database empty or unbuilt?"
                .to_string(),
        );
    }

    let mut engine = Engine::spawn(&stockfish_path).await?;
    engine.init().await?;

    // Distribute n across 8 strata; the first (n % 8) get one extra.
    let mut caps = [n / N_BUCKETS; N_BUCKETS];
    for c in caps.iter_mut().take(n % N_BUCKETS) {
        *c += 1;
    }
    let mut counts = [0usize; N_BUCKETS];
    let mut accepted: Vec<CalibrationPosition> = Vec::with_capacity(n);
    let mut leftovers: Vec<CalibrationPosition> = Vec::new();
    let mut seen: HashSet<i64> = HashSet::new();
    let mut evaluated = 0usize;
    // Bound the engine work so a lopsided pool can't run forever.
    let max_evals = (n * 3).max(n + 40);

    for cand in &pool {
        if accepted.len() >= n || evaluated >= max_evals {
            break;
        }
        if cand.in_check || cand.near_capture {
            continue;
        }
        if !seen.insert(cand.zobrist) {
            continue;
        }

        let ev = match engine.eval(&cand.fen, movetime_ms).await {
            Ok(ev) => ev,
            Err(e) => {
                engine.quit().await;
                return Err(e);
            }
        };
        evaluated += 1;
        let (pos, bucket) = finish_position(cand, ev);
        if counts[bucket] < caps[bucket] {
            counts[bucket] += 1;
            accepted.push(pos);
        } else {
            leftovers.push(pos);
        }
        if let Some(ch) = &on_progress {
            let _ = ch.send(CalibrationProgress {
                evaluated,
                accepted: accepted.len(),
                target: n,
            });
        }
    }
    engine.quit().await;

    // Top up from already-scored leftovers when a rare stratum couldn't fill.
    if accepted.len() < n {
        for pos in leftovers {
            if accepted.len() >= n {
                break;
            }
            accepted.push(pos);
        }
    }

    Ok(CalibrationSession {
        version: SESSION_VERSION,
        n: accepted.len(),
        created_at: now_ms(),
        stockfish_path,
        positions: accepted,
    })
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// `<app_data_dir>/calibration`, created if absent.
fn calibration_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("calibration");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

// ---------------------------------------------------------------------------
// Tauri command layer
// ---------------------------------------------------------------------------

/// Create a stratified calibration session, write it to
/// `<app_data_dir>/calibration/session-<created_at>.json`, and return it.
#[tauri::command]
pub async fn calibration_sample(
    app: tauri::AppHandle,
    n: usize,
    db_path: Option<String>,
    stockfish_path: Option<String>,
    movetime_ms: Option<u64>,
    on_progress: Channel<CalibrationProgress>,
) -> Result<CalibrationSession, String> {
    let n = n.clamp(1, 500);
    let path = db::resolve_db_path(&app, db_path)?;
    let sf = stockfish_path
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_STOCKFISH.to_string());
    let mt = movetime_ms.unwrap_or(DEFAULT_MOVETIME_MS).max(1);

    let session = build_session(path, n, sf, mt, Some(on_progress)).await?;

    let dir = calibration_dir(&app)?;
    let file = dir.join(format!("session-{}.json", session.created_at));
    let json = serde_json::to_string_pretty(&session).map_err(|e| e.to_string())?;
    std::fs::write(&file, json).map_err(|e| e.to_string())?;

    Ok(session)
}

/// Persist a completed calibration result (session ref + answers + timings +
/// summary stats, assembled by the frontend to the documented schema) to
/// `<app_data_dir>/calibration/results-<timestamp>.json`. Returns the path.
#[tauri::command]
pub fn calibration_save_results(
    app: tauri::AppHandle,
    results: serde_json::Value,
) -> Result<String, String> {
    let dir = calibration_dir(&app)?;
    let file = dir.join(format!("results-{}.json", now_ms()));
    let json = serde_json::to_string_pretty(&results).map_err(|e| e.to_string())?;
    std::fs::write(&file, json).map_err(|e| e.to_string())?;
    Ok(file.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use shakmaty::Position;

    #[test]
    fn eval_band_boundaries() {
        assert_eq!(eval_band(Some(0), None).1, "0-0.5");
        assert_eq!(eval_band(Some(49), None).1, "0-0.5");
        assert_eq!(eval_band(Some(50), None).1, "0.5-1.5");
        assert_eq!(eval_band(Some(-149), None).1, "0.5-1.5");
        assert_eq!(eval_band(Some(150), None).1, "1.5-3");
        assert_eq!(eval_band(Some(-299), None).1, "1.5-3");
        assert_eq!(eval_band(Some(300), None).1, "3+");
        assert_eq!(eval_band(None, Some(5)).1, "3+");
        assert_eq!(eval_band(None, Some(-2)).1, "3+");
    }

    #[test]
    fn phase_split() {
        assert_eq!(phase_of(24).1, "middlegame");
        assert_eq!(phase_of(9).1, "middlegame");
        assert_eq!(phase_of(8).1, "endgame");
        assert_eq!(phase_of(0).1, "endgame");
    }

    #[test]
    fn parses_multipv_info_line() {
        let (idx, cp, mate, first) =
            parse_multipv_line("info depth 18 multipv 2 score cp -34 nodes 5 pv e2e4 e7e5").unwrap();
        assert_eq!(idx, 2);
        assert_eq!(cp, Some(-34));
        assert_eq!(mate, None);
        assert_eq!(first.as_deref(), Some("e2e4"));

        let (idx, _cp, mate, _) =
            parse_multipv_line("info depth 20 multipv 1 score mate 3 pv h5f7").unwrap();
        assert_eq!(idx, 1);
        assert_eq!(mate, Some(3));

        // No multipv token (MultiPV=1 engines) defaults to line 1.
        let (idx, cp, _, _) = parse_multipv_line("info depth 5 score cp 128 pv d2d4").unwrap();
        assert_eq!(idx, 1);
        assert_eq!(cp, Some(128));

        assert!(parse_multipv_line("info string just a note").is_none());
    }

    #[test]
    fn san_for_startpos() {
        let start = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
        assert_eq!(san_for(start, "g1f3").as_deref(), Some("Nf3"));
        assert_eq!(san_for(start, "e2e4").as_deref(), Some("e4"));
        assert!(san_for(start, "e2e5").is_none()); // illegal
    }

    /// The White-POV flip: a Black-to-move position with a side-to-move-negative
    /// score should come out positive (good for White) after `finish_position`.
    #[test]
    fn white_pov_flip() {
        let cand = SampledPosition {
            game_id: 1,
            ply: 20,
            // Black to move, roughly balanced material.
            fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1".to_string(),
            in_check: false,
            material: 0,
            phase: 24,
            near_capture: false,
            zobrist: 42,
            white_elo: Some(1500),
            black_elo: Some(1500), // avg 1500 → Elo band 0 (<1600)
            white_to_move: false,
            played_uci: Some("e7e5".to_string()),
            played_san: Some("e5".to_string()),
            continuation_san: vec!["Nf3".to_string()],
        };
        let ev = RawEval {
            cp: Some(-120), // Black to move sees −1.2 → White is +1.2
            mate: None,
            gap_cp: Some(30),
            best_uci: Some("e7e5".to_string()),
        };
        let (pos, bucket) = finish_position(&cand, ev);
        assert_eq!(pos.sf_cp, Some(120));
        assert_eq!(pos.band, "0.5-1.5");
        assert_eq!(pos.phase, "middlegame");
        assert_eq!(pos.sf_best_san.as_deref(), Some("e5"));
        assert_eq!(pos.elo_band, "<1600");
        assert_eq!(pos.to_move, "black");
        assert_eq!(pos.played_san.as_deref(), Some("e5"));
        // band 1 (0.5-1.5) × Elo band 0 (<1600) → bucket 1*4 + 0 = 4.
        assert_eq!(bucket, 4);
    }

    #[test]
    fn elo_band_boundaries() {
        assert_eq!(elo_band_of(Some(1400), Some(1500)).1, "<1600"); // avg 1450
        assert_eq!(elo_band_of(Some(1600), Some(1600)).1, "1600-2000");
        assert_eq!(elo_band_of(Some(2100), Some(2300)).1, "2000-2400"); // avg 2200
        assert_eq!(elo_band_of(Some(2500), Some(2700)).1, "2400+");
        assert_eq!(elo_band_of(None, Some(2000)).1, "2400+"); // fallback
    }

    // -----------------------------------------------------------------------
    // End-to-end sampler (scratch DB + real Stockfish at a tiny movetime)
    // -----------------------------------------------------------------------

    /// Resolve a usable Stockfish, or None so the live test skips cleanly.
    fn find_stockfish() -> Option<String> {
        for p in [
            "/opt/homebrew/bin/stockfish",
            "/usr/local/bin/stockfish",
            "/usr/bin/stockfish",
        ] {
            if std::path::Path::new(p).exists() {
                return Some(p.to_string());
            }
        }
        None
    }

    /// Generate `n` distinct legal random games (~`plies` plies) as one PGN blob
    /// — enough position depth (ply ≥ 16) for the sampler to draw from. A tiny
    /// LCG keeps it deterministic and dependency-free.
    fn synth_pgn(n: usize, plies: usize) -> String {
        use shakmaty::san::San;
        let mut out = String::new();
        let mut rng: u64 = 0x1234_5678_9abc_def0;
        let next = |rng: &mut u64| {
            *rng = rng
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            *rng >> 33
        };
        for i in 0..n {
            let mut pos = Chess::default();
            let mut moves = String::new();
            let mut fullmove = 1;
            let mut white = true;
            for _ in 0..plies {
                let legal = pos.legal_moves();
                if legal.is_empty() {
                    break;
                }
                let m = legal[(next(&mut rng) as usize) % legal.len()];
                let san = San::from_move(&pos, m).to_string();
                if white {
                    moves.push_str(&format!("{fullmove}. {san} "));
                } else {
                    moves.push_str(&format!("{san} "));
                    fullmove += 1;
                }
                white = !white;
                pos.play_unchecked(m);
            }
            // Spread Elos across all four bands so the v2 Elo-band sampler has
            // candidates everywhere.
            let elo = [1450, 1800, 2200, 2600][i % 4];
            out.push_str(&format!(
                "[Event \"Synth\"]\n[White \"W{i}\"]\n[Black \"B{i}\"]\n[WhiteElo \"{elo}\"]\n[BlackElo \"{elo}\"]\n[Result \"*\"]\n[ECO \"A00\"]\n\n{moves}*\n\n"
            ));
        }
        out
    }

    #[tokio::test]
    async fn samples_stratified_deduped_check_free_session() {
        let Some(sf) = find_stockfish() else {
            eprintln!("skipping samples_stratified_...: no stockfish");
            return;
        };

        // Scratch DB seeded with enough synthetic games to have a pool.
        let db_file = std::env::temp_dir().join(format!("calib-test-{}.db", now_ms()));
        let path = db_file.to_string_lossy().into_owned();
        {
            let mut db = Db::open(&path).unwrap();
            db.import_pgn_str(&synth_pgn(200, 34), "synth").unwrap();
            assert!(db.stats().unwrap().positions > 100);
        }

        let n = 6;
        let session = build_session(path.clone(), n, sf, 20, None)
            .await
            .expect("session builds");

        // Fills the request from a healthy pool.
        assert_eq!(session.positions.len(), n, "session filled to n");
        assert_eq!(session.n, n);
        assert_eq!(session.version, SESSION_VERSION);

        let mut fens = HashSet::new();
        for p in &session.positions {
            // Dedup: no position repeats.
            assert!(fens.insert(p.fen.clone()), "positions are distinct");
            // Check-exclusion: the side to move is never in check.
            let pos: Chess = Fen::from_ascii(p.fen.as_bytes())
                .unwrap()
                .into_position(CastlingMode::Standard)
                .unwrap();
            assert!(!pos.is_check(), "sampled positions exclude checks: {}", p.fen);
            // Stratification labels are well-formed.
            assert!(
                ["0-0.5", "0.5-1.5", "1.5-3", "3+"].contains(&p.band.as_str()),
                "valid band label: {}",
                p.band
            );
            assert!(["middlegame", "endgame"].contains(&p.phase.as_str()));
            // A best move was read for a non-terminal position.
            assert!(!p.sf_best_uci.is_empty(), "best move present");
            // v2 context: Elo-known, banded, with the played move captured.
            assert!(p.white_elo.is_some() && p.black_elo.is_some(), "Elos present");
            assert!(
                ["<1600", "1600-2000", "2000-2400", "2400+"].contains(&p.elo_band.as_str()),
                "valid Elo band: {}",
                p.elo_band
            );
            assert!(["white", "black"].contains(&p.to_move.as_str()));
            assert!(p.played_uci.is_some(), "played move captured");
            // to_move must agree with the FEN's active colour.
            let fen_white = p.fen.contains(" w ");
            assert_eq!(fen_white, p.to_move == "white", "to_move matches FEN turn");
        }

        // Best-effort cleanup (WAL sidecars included).
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{path}{suffix}"));
        }
    }

    /// Manual smoke against the real games database, reporting sampler timing and
    /// the stratification actually achieved. Run with:
    ///   CALIB_SMOKE_DB="<path>/games.db" cargo test --release -- \
    ///     --ignored --nocapture real_db_smoke
    #[tokio::test]
    #[ignore = "manual; needs the real games.db via CALIB_SMOKE_DB and a stockfish"]
    async fn real_db_smoke() {
        use std::collections::BTreeMap;
        use std::time::Instant;
        let Some(sf) = find_stockfish() else {
            eprintln!("skipping real_db_smoke: no stockfish");
            return;
        };
        let Ok(db_path) = std::env::var("CALIB_SMOKE_DB") else {
            eprintln!("skipping real_db_smoke: set CALIB_SMOKE_DB to the games.db path");
            return;
        };

        let n = 20;
        let t0 = Instant::now();
        let session = build_session(db_path, n, sf, DEFAULT_MOVETIME_MS, None)
            .await
            .expect("real-DB session builds");
        let secs = t0.elapsed().as_secs_f64();

        let mut by_elo: BTreeMap<String, usize> = BTreeMap::new();
        let mut by_eval: BTreeMap<String, usize> = BTreeMap::new();
        let mut by_phase: BTreeMap<String, usize> = BTreeMap::new();
        let both_elo = session
            .positions
            .iter()
            .filter(|p| p.white_elo.is_some() && p.black_elo.is_some())
            .count();
        for p in &session.positions {
            *by_elo.entry(p.elo_band.clone()).or_default() += 1;
            *by_eval.entry(p.band.clone()).or_default() += 1;
            *by_phase.entry(p.phase.clone()).or_default() += 1;
        }
        println!(
            "\n=== calibration real_db_smoke: n={} built in {:.1}s ({:.1}s/pos) ===",
            session.positions.len(),
            secs,
            secs / session.positions.len().max(1) as f64
        );
        println!(
            "  both Elos known: {}/{} ({:.0}%)",
            both_elo,
            session.positions.len(),
            100.0 * both_elo as f64 / session.positions.len().max(1) as f64
        );
        println!("  by Elo band:   {by_elo:?}");
        println!("  by eval band:  {by_eval:?}");
        println!("  by phase:      {by_phase:?}");
        // Sample a played-move reveal to eyeball the game context.
        if let Some(p) = session.positions.iter().find(|p| p.played_san.is_some()) {
            println!(
                "  e.g. game {} ply {} ({} {:?}): played {}",
                p.game_id,
                p.ply,
                p.to_move,
                if p.to_move == "white" { p.white_elo } else { p.black_elo },
                p.played_san.as_deref().unwrap_or("?")
            );
        }
        assert_eq!(session.positions.len(), n);
    }
}
