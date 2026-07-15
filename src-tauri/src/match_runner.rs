//! Headless engine-vs-engine match runner.
//!
//! This subsystem plays a single full game between two UCI engines to a
//! definitive result, using `shakmaty` for rules and termination detection.
//! It is completely independent from the interactive single-engine manager in
//! `uci.rs` — it spawns its own short-lived engine processes and drives them
//! synchronously, one move at a time.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use shakmaty::fen::Fen;
use shakmaty::uci::UciMove;
use shakmaty::zobrist::Zobrist64;
use shakmaty::{CastlingMode, Chess, Color, EnPassantMode, Position};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Semaphore;
use tokio::time::timeout;

// ============================================================================
// 7-piece endgame tablebase adjudication (Lichess public API)
// ============================================================================
//
// All endgames with <=7 men are solved. When a game reaches that point we can
// adjudicate the result under perfect play instead of letting the engines grind
// it out. We query the public Lichess tablebase
// (`https://tablebase.lichess.ovh/standard?fen=...`) and map its `category` to a
// definitive result. Everything is best-effort: any network/parse failure falls
// back to None and the game continues by normal rules.

/// A tablebase verdict from the perspective of the side to move.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TbVerdict {
    /// Side to move wins with perfect play.
    WinStm,
    /// Side to move loses with perfect play.
    LossStm,
    /// Drawn (includes cursed-win / blessed-loss, which are draws under the
    /// 50-move rule, plus unknown/maybe categories).
    Draw,
}

/// Shared HTTP client (built once) so all games pool connections.
static TB_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

/// Global FEN-keyed cache of tablebase verdicts, shared across the whole batch
/// to avoid re-querying identical positions.
static TB_CACHE: OnceLock<Mutex<HashMap<String, TbVerdict>>> = OnceLock::new();

/// Bound concurrent *uncached* requests so we stay gentle on the public API.
/// Cache hits do not consume a permit.
static TB_SEM: OnceLock<Semaphore> = OnceLock::new();

fn tb_client() -> &'static reqwest::Client {
    TB_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(6))
            .build()
            // Fall back to a default client if the builder ever fails.
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

fn tb_cache() -> &'static Mutex<HashMap<String, TbVerdict>> {
    TB_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn tb_sem() -> &'static Semaphore {
    TB_SEM.get_or_init(|| Semaphore::new(3))
}

/// Map a Lichess tablebase `category` string to a [`TbVerdict`].
///
/// "win" and "loss" are decisive under the 50-move rule. "cursed-win" /
/// "blessed-loss" are wins/losses on the board but draws once the 50-move rule
/// applies, so they map to Draw — as do "draw" and any unknown/maybe category.
fn category_to_verdict(category: &str) -> TbVerdict {
    match category {
        "win" => TbVerdict::WinStm,
        "loss" => TbVerdict::LossStm,
        _ => TbVerdict::Draw,
    }
}

/// Probe the Lichess tablebase for the given FEN.
///
/// Returns the verdict from the side-to-move's perspective, or `None` on any
/// failure (network error, timeout, non-200, parse error) so the caller can
/// gracefully fall back to normal play. Positive lookups are cached by FEN.
async fn probe_tablebase(fen: &str) -> Option<TbVerdict> {
    // Cache hit: no network, no permit.
    if let Ok(cache) = tb_cache().lock() {
        if let Some(v) = cache.get(fen) {
            return Some(*v);
        }
    }

    // Rate-limit uncached queries across the whole batch.
    let _permit = tb_sem().acquire().await.ok()?;

    let resp = tb_client()
        .get("https://tablebase.lichess.ovh/standard")
        .query(&[("fen", fen)])
        .send()
        .await
        .ok()?;

    if !resp.status().is_success() {
        return None;
    }

    let json: serde_json::Value = resp.json().await.ok()?;
    let category = json.get("category")?.as_str()?;
    let verdict = category_to_verdict(category);

    if let Ok(mut cache) = tb_cache().lock() {
        cache.insert(fen.to_string(), verdict);
    }

    Some(verdict)
}

/// Translate a [`TbVerdict`] (side-to-move perspective) into a game result
/// string given whose turn it is.
fn tb_result(verdict: TbVerdict, stm: Color) -> &'static str {
    match verdict {
        TbVerdict::WinStm => win_for(stm),
        TbVerdict::LossStm => loss_for(stm),
        TbVerdict::Draw => "1/2-1/2",
    }
}

/// Result of a completed (or adjudicated) engine-vs-engine game.
#[derive(Serialize, Debug, Clone)]
pub struct GameResult {
    /// "1-0" | "0-1" | "1/2-1/2"
    pub result: String,
    /// Reason the game ended (e.g. "checkmate", "fifty_move", "threefold",
    /// "stalemate", "insufficient_material", "max_plies", "illegal_move",
    /// "no_move").
    pub termination: String,
    /// Number of half-moves played.
    pub plies: usize,
    /// FEN of the starting position the game began from.
    pub start_fen: String,
    /// Moves played, in UCI notation.
    pub moves: Vec<String>,
}

/// A spawned UCI engine process driven headlessly.
struct EngineHandle {
    child: Child,
    stdin: ChildStdin,
    lines: Lines<BufReader<tokio::process::ChildStdout>>,
}

impl EngineHandle {
    /// Spawn an engine process and pipe stdin/stdout.
    async fn spawn(path: &str) -> Result<Self, String> {
        let mut child = Command::new(path)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("Failed to start engine '{}': {}", path, e))?;

        let stdin = child.stdin.take().ok_or("No stdin")?;
        let stdout = child.stdout.take().ok_or("No stdout")?;
        let lines = BufReader::new(stdout).lines();

        Ok(EngineHandle {
            child,
            stdin,
            lines,
        })
    }

    /// Write one line (with trailing newline) and flush.
    async fn send(&mut self, cmd: &str) -> Result<(), String> {
        self.stdin
            .write_all(cmd.as_bytes())
            .await
            .map_err(|e| format!("Write error: {}", e))?;
        self.stdin
            .write_all(b"\n")
            .await
            .map_err(|e| format!("Write error: {}", e))?;
        self.stdin
            .flush()
            .await
            .map_err(|e| format!("Flush error: {}", e))?;
        Ok(())
    }

    /// Read lines until one matches `predicate`. Bounded by `wait`.
    async fn read_until<F>(&mut self, wait: Duration, mut predicate: F) -> Result<String, String>
    where
        F: FnMut(&str) -> bool,
    {
        let fut = async {
            loop {
                match self.lines.next_line().await {
                    Ok(Some(line)) => {
                        let trimmed = line.trim();
                        if predicate(trimmed) {
                            return Ok(trimmed.to_string());
                        }
                    }
                    Ok(None) => return Err("Engine closed unexpectedly (EOF)".to_string()),
                    Err(e) => return Err(format!("Read error: {}", e)),
                }
            }
        };

        match timeout(wait, fut).await {
            Ok(res) => res,
            Err(_) => Err("Timed out waiting for engine output".to_string()),
        }
    }

    /// Run the UCI handshake: `uci` -> `uciok`, `isready` -> `readyok`,
    /// then `ucinewgame`.
    async fn init(&mut self) -> Result<(), String> {
        self.send("uci").await?;
        self.read_until(Duration::from_secs(10), |l| l == "uciok")
            .await?;
        self.send("isready").await?;
        self.read_until(Duration::from_secs(10), |l| l == "readyok")
            .await?;
        self.send("ucinewgame").await?;
        // Re-sync after ucinewgame so the engine has finished any reset work.
        self.send("isready").await?;
        self.read_until(Duration::from_secs(10), |l| l == "readyok")
            .await?;
        Ok(())
    }

    /// Ask the engine for a move given a position and the current game clock.
    ///
    /// Drives the engine with `go wtime <wtime> btime <btime> winc <winc> binc
    /// <binc>` so the engine budgets its own time. `winc_ms`/`binc_ms` are the
    /// per-side increments (equal in symmetric games, different under time
    /// odds). The clocks are clamped to at least 1ms when sent (never
    /// negative/zero). `read_wait` bounds how long we wait for `bestmove` — it
    /// should be the moving side's remaining time plus a generous margin so a
    /// hung engine is caught but a legitimately slow move is not killed.
    ///
    /// Returns the raw UCI bestmove token (e.g. "e2e4", "e7e8q") or the literal
    /// "(none)" when the engine reports no move, together with the precise wall
    /// time the search took (used to debit the moving side's clock).
    async fn bestmove(
        &mut self,
        position_cmd: &str,
        wtime_ms: i64,
        btime_ms: i64,
        winc_ms: u64,
        binc_ms: u64,
        read_wait: Duration,
    ) -> Result<(String, i64), String> {
        self.send(position_cmd).await?;

        // Clamp the clocks we advertise to >= 1ms; never send a negative/zero
        // clock (some engines choke on it).
        let wt = wtime_ms.max(1);
        let bt = btime_ms.max(1);

        // Measure wall time precisely around the search.
        let t0 = tokio::time::Instant::now();
        self.send(&format!(
            "go wtime {} btime {} winc {} binc {}",
            wt, bt, winc_ms, binc_ms
        ))
        .await?;

        let line = self
            .read_until(read_wait, |l| l.starts_with("bestmove"))
            .await?;
        let elapsed = t0.elapsed().as_millis() as i64;

        // Format: "bestmove <uci> [ponder <uci>]" or "bestmove (none)".
        let mut parts = line.split_whitespace();
        parts.next(); // "bestmove"
        let mv = parts
            .next()
            .ok_or_else(|| format!("Malformed bestmove line: '{}'", line))?;
        Ok((mv.to_string(), elapsed))
    }

    /// Evaluate a position (given by FEN) at a fixed movetime, returning the
    /// last-seen score converted to White's POV: `(cp, mate)` with at most one
    /// side populated. Used by the neutral evaluator; never touches a player's
    /// clock. `read_wait` bounds the wait for `bestmove`.
    async fn eval_at(
        &mut self,
        fen: &str,
        movetime_ms: u64,
        read_wait: Duration,
    ) -> Result<(Option<i64>, Option<i64>), String> {
        self.send(&format!("position fen {}", fen)).await?;
        let mut cp: Option<i64> = None;
        let mut mate: Option<i64> = None;
        self.send(&format!("go movetime {}", movetime_ms)).await?;
        // Read info lines until bestmove, keeping the most recent score. A mate
        // score supersedes a cp score and vice-versa (only one is meaningful).
        self.read_until(read_wait, |line| {
            if line.starts_with("info ") {
                if let Some((c, m)) = parse_info_score(line) {
                    if c.is_some() {
                        cp = c;
                        mate = None;
                    }
                    if m.is_some() {
                        mate = m;
                        cp = None;
                    }
                }
            }
            line.starts_with("bestmove")
        })
        .await?;
        // The engine reports from the side-to-move's POV; flip to White-POV.
        if fen_black_to_move(fen) {
            cp = cp.map(|v| -v);
            mate = mate.map(|v| -v);
        }
        Ok((cp, mate))
    }

    async fn quit(mut self) {
        let _ = self.send("quit").await;
        // Give it a brief moment to exit cleanly; kill_on_drop handles the rest.
        let _ = timeout(Duration::from_millis(500), self.child.wait()).await;
        let _ = self.child.start_kill();
    }
}

/// Build a `position ...` UCI command from the start FEN and the played moves.
fn position_command(start_fen: &str, is_standard_start: bool, moves: &[String]) -> String {
    let mut cmd = if is_standard_start {
        String::from("position startpos")
    } else {
        format!("position fen {}", start_fen)
    };
    if !moves.is_empty() {
        cmd.push_str(" moves ");
        cmd.push_str(&moves.join(" "));
    }
    cmd
}

/// Standard chess starting FEN.
const STANDARD_START_FEN: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/// A single move played in a game, streamed live as the game progresses.
///
/// Emitted once per applied move so a UI can watch a game move-by-move without
/// waiting for the whole game (or batch) to finish.
#[derive(Serialize, Debug, Clone)]
pub struct MoveEvent {
    /// The [`GameSpec::id`] of the game this move belongs to.
    pub game_id: usize,
    /// 1-based half-move index (the move number within the game).
    pub ply: usize,
    /// The move just played, in UCI notation (e.g. "e2e4", "e7e8q").
    pub uci: String,
    /// FEN of the position AFTER this move was applied.
    pub fen: String,
    /// White's remaining clock (ms) after this move (post-deduction + increment).
    pub wtime_ms: i64,
    /// Black's remaining clock (ms) after this move.
    pub btime_ms: i64,
}

// ============================================================================
// Neutral evaluator — a third engine that scores each position off the
// live-move stream (never on a player's clock).
// ============================================================================
//
// While the two players fight a game, an optional third UCI engine (the neutral
// evaluator, default Stockfish) scores every position at a fixed, small budget
// (`go movetime`). It runs in its OWN async task consuming the game's positions
// off a channel, so the players never wait for it and their clocks are never
// affected. `movetime` (not fixed depth) is deliberate: it bounds the per-
// position wall cost so the evaluator keeps pace with the live stream instead of
// stalling on a sharp position the way a fixed depth would.

/// One neutral-evaluator score at a single ply of a game. `ply` 0 is the start
/// position; `ply` N is the position after the Nth half-move (matching
/// [`MoveEvent::ply`]). Exactly one of `cp`/`mate` is set (both `None` if the
/// evaluator produced no score). White-POV: + favors White. Serialize +
/// Deserialize so a run's evals round-trip trivially when persistence lands.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PlyEval {
    pub ply: usize,
    pub cp: Option<i64>,
    pub mate: Option<i64>,
}

/// A neutral-evaluator score streamed live as a game plays, tagged with its
/// game id so a concurrent batch can route it to the right game. White-POV.
#[derive(Serialize, Debug, Clone)]
pub struct EvalEvent {
    pub game_id: usize,
    pub ply: usize,
    pub cp: Option<i64>,
    pub mate: Option<i64>,
}

/// Configuration for the neutral evaluator. Absent = evaluation disabled.
#[derive(Clone, Debug)]
pub struct EvalSetup {
    /// Path to the evaluator engine binary.
    pub path: String,
    /// Per-position search budget (`go movetime <ms>`).
    pub movetime_ms: u64,
}

/// Default neutral-evaluator budget (100ms): reaches ~depth 12-16 mid-game on
/// modern hardware — enough for a stable White-POV signal for the bar and the
/// shape of the eval graph — while staying cheap enough that the evaluators
/// don't materially starve the players even at high game concurrency.
pub const DEFAULT_EVAL_MOVETIME_MS: u64 = 100;

/// Parse `score cp N` / `score mate N` from a UCI `info` line. The score is from
/// the side-to-move's perspective (caller converts to White-POV). Returns
/// `(cp, mate)` with exactly one side populated, or `None` if the line carries
/// no score token.
fn parse_info_score(line: &str) -> Option<(Option<i64>, Option<i64>)> {
    let mut it = line.split_whitespace();
    while let Some(tok) = it.next() {
        if tok == "score" {
            return match it.next() {
                Some("cp") => it.next()?.parse::<i64>().ok().map(|v| (Some(v), None)),
                Some("mate") => it.next()?.parse::<i64>().ok().map(|v| (None, Some(v))),
                _ => None,
            };
        }
    }
    None
}

/// Whether it is Black to move in `fen` (active-color is the 2nd FEN field).
fn fen_black_to_move(fen: &str) -> bool {
    fen.split_whitespace().nth(1) == Some("b")
}

/// Play one full headless game between two engines.
///
/// Pure core: no Tauri dependencies. Spawns both engines, drives them
/// move-by-move, detects termination via `shakmaty`, and returns the result.
///
/// This is a thin wrapper over [`play_game_streamed`] with a no-op move
/// callback; its public signature and behavior are unchanged.
pub async fn play_game_core(
    white_path: &str,
    black_path: &str,
    start_fen: Option<String>,
    base_ms: u64,
    inc_ms: u64,
    max_plies: usize,
    adjudicate_tb: bool,
) -> Result<GameResult, String> {
    play_game_streamed(
        white_path,
        black_path,
        start_fen,
        base_ms,
        inc_ms,
        base_ms,
        inc_ms,
        max_plies,
        adjudicate_tb,
        0,
        |_| {},
        &AtomicBool::new(false),
        &AtomicBool::new(false),
        &AtomicU64::new(0),
    )
    .await
}

/// Play one full headless game, streaming each move via `on_move`.
///
/// Identical to [`play_game_core`] except that `on_move` is invoked with a
/// [`MoveEvent`] immediately after each move is successfully applied. The
/// returned [`GameResult`] is exactly what `play_game_core` would return.
///
/// `game_id` tags every emitted [`MoveEvent`] so a caller running many games
/// concurrently can correlate moves back to their game.
///
/// `paused` freezes the game between moves while set — no search runs, so both
/// clocks hold. `move_delay_ms` throttles the on-board display so each move
/// stays up at least that long (0 = no throttle). Neither affects the clocks,
/// which are only ever debited by measured search time.
pub async fn play_game_streamed(
    white_path: &str,
    black_path: &str,
    start_fen: Option<String>,
    white_base_ms: u64,
    white_inc_ms: u64,
    black_base_ms: u64,
    black_inc_ms: u64,
    max_plies: usize,
    adjudicate_tb: bool,
    game_id: usize,
    on_move: impl Fn(MoveEvent) + Send + Sync,
    cancel: &AtomicBool,
    paused: &AtomicBool,
    move_delay_ms: &AtomicU64,
) -> Result<GameResult, String> {
    // Set up the starting position.
    let (mut pos, start_fen_str, is_standard_start): (Chess, String, bool) = match &start_fen {
        Some(f) => {
            let fen = Fen::from_ascii(f.as_bytes())
                .map_err(|e| format!("Invalid start FEN: {}", e))?;
            let pos: Chess = fen
                .into_position(CastlingMode::Standard)
                .map_err(|e| format!("Illegal start position: {}", e))?;
            let is_std = f.trim() == STANDARD_START_FEN;
            (pos, f.clone(), is_std)
        }
        None => (
            Chess::default(),
            STANDARD_START_FEN.to_string(),
            true,
        ),
    };

    // Spawn and initialize both engines.
    let mut white = EngineHandle::spawn(white_path).await?;
    let mut black = EngineHandle::spawn(black_path).await?;
    white
        .init()
        .await
        .map_err(|e| format!("White engine init failed: {}", e))?;
    black
        .init()
        .await
        .map_err(|e| format!("Black engine init failed: {}", e))?;

    let mut moves: Vec<String> = Vec::new();

    // Sudden-death + increment game clock. Each side starts with its own
    // `*_base_ms` and gains its own `*_inc_ms` after each of its own moves
    // (equal for both sides in a normal game; asymmetric under time odds).
    // Signed so we can detect a flag-fall (clock crossing below zero). These
    // persist across the whole game and are NEVER reset per move.
    let mut wtime: i64 = white_base_ms as i64;
    let mut btime: i64 = black_base_ms as i64;
    // Grace for IPC/measurement jitter: only flag once the overshoot exceeds
    // this (a tiny, legitimate overrun is forgiven).
    const FLAG_GRACE_MS: i64 = 50;

    // Repetition tracking by Zobrist hash. Count the initial position too.
    let mut rep_counts: HashMap<u64, u32> = HashMap::new();
    let initial_key = pos.zobrist_hash::<Zobrist64>(EnPassantMode::Legal).0;
    rep_counts.insert(initial_key, 1);

    let finish = |white: EngineHandle,
                  black: EngineHandle,
                  result: &str,
                  termination: &str,
                  moves: Vec<String>|
     -> GameResult {
        // Engines are dropped (kill_on_drop) when the closure returns; we spawn
        // detached quit tasks so they exit cleanly without blocking.
        tokio::spawn(async move { white.quit().await });
        tokio::spawn(async move { black.quit().await });
        GameResult {
            result: result.to_string(),
            termination: termination.to_string(),
            plies: moves.len(),
            start_fen: start_fen_str.clone(),
            moves,
        }
    };

    // Adjudicate the very start position if it is already a <=7-man endgame.
    // Most games begin from the full board, so this almost never fires, but a
    // caller seeding endgame positions benefits from skipping the play-out.
    if adjudicate_tb && pos.board().occupied().count() <= 7 {
        let stm = pos.turn();
        let fen = Fen::from_position(&pos, EnPassantMode::Legal).to_string();
        if let Some(verdict) = probe_tablebase(&fen).await {
            let result = tb_result(verdict, stm);
            return Ok(finish(white, black, result, "tablebase", moves));
        }
    }

    // Wall-clock of the last move we emitted, for the display-time throttle.
    let mut last_emit = tokio::time::Instant::now();

    loop {
        // Abort promptly if the batch was cancelled (engines die on drop). This
        // bounds an in-flight game's shutdown to roughly one move's think time.
        if cancel.load(Ordering::SeqCst) {
            return Err("cancelled".to_string());
        }

        // Pause gate: hold between moves while paused. No search runs here, so
        // both clocks freeze (they are only ever debited by measured search
        // time). Cancellation still wins so a paused game can be stopped.
        while paused.load(Ordering::SeqCst) {
            if cancel.load(Ordering::SeqCst) {
                return Err("cancelled".to_string());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }

        // Adjudicate at max plies.
        if moves.len() >= max_plies {
            return Ok(finish(white, black, "1/2-1/2", "max_plies", moves));
        }

        let mover = pos.turn();

        let position_cmd = position_command(&start_fen_str, is_standard_start, &moves);

        // Ask the engine to move.
        let engine = match mover {
            Color::White => &mut white,
            Color::Black => &mut black,
        };

        // Read timeout: the moving side's remaining clock plus a generous
        // margin, floored at 5s, so a hung engine is still caught but a slow
        // (but legal) deep search is not killed prematurely.
        let remaining = match mover {
            Color::White => wtime,
            Color::Black => btime,
        };
        let read_wait =
            Duration::from_millis((remaining.max(0) as u64).saturating_add(5000).max(5000));

        let (bestmove, elapsed) = match engine
            .bestmove(&position_cmd, wtime, btime, white_inc_ms, black_inc_ms, read_wait)
            .await
        {
            Ok(m) => m,
            Err(e) => {
                // Treat a comms failure as a loss for the side to move.
                let result = loss_for(mover);
                let term = format!("engine_error: {}", e);
                return Ok(finish(white, black, result, &term, moves));
            }
        };

        // Debit the moving side's clock by the measured search time. If the
        // clock falls below zero (beyond the small jitter grace) the side has
        // flagged: it loses on time even though it produced a move. Otherwise
        // credit the increment.
        let inc = match mover {
            Color::White => white_inc_ms,
            Color::Black => black_inc_ms,
        };
        let clock = match mover {
            Color::White => &mut wtime,
            Color::Black => &mut btime,
        };
        *clock -= elapsed;
        if *clock < -FLAG_GRACE_MS {
            let result = loss_for(mover);
            return Ok(finish(white, black, result, "time_forfeit", moves));
        }
        *clock += inc as i64;

        if bestmove == "(none)" || bestmove == "0000" {
            // No move offered. If it's actually checkmate/stalemate the
            // detection below would have caught it last ply, so here it means
            // the engine resigned/failed to produce a move.
            let (result, term) = if pos.is_checkmate() {
                (loss_for(mover), "checkmate")
            } else {
                (loss_for(mover), "no_move")
            };
            return Ok(finish(white, black, result, term, moves));
        }

        // Parse + validate the move against the current position.
        let uci = match UciMove::from_ascii(bestmove.as_bytes()) {
            Ok(u) => u,
            Err(_) => {
                let result = loss_for(mover);
                return Ok(finish(white, black, result, "illegal_move", moves));
            }
        };
        let legal_move = match uci.to_move(&pos) {
            Ok(m) => m,
            Err(_) => {
                let result = loss_for(mover);
                return Ok(finish(white, black, result, "illegal_move", moves));
            }
        };

        // Apply the move.
        pos = match pos.play(legal_move) {
            Ok(p) => p,
            Err(_) => {
                let result = loss_for(mover);
                return Ok(finish(white, black, result, "illegal_move", moves));
            }
        };
        moves.push(bestmove);

        // Display throttle: keep each move on the board at least `move_delay_ms`.
        // The time already spent computing THIS move counts, so we only sleep the
        // remainder. Outside the clock accounting, so it never affects the clocks.
        let delay = move_delay_ms.load(Ordering::SeqCst);
        if delay > 0 {
            let since = last_emit.elapsed().as_millis() as u64;
            if since < delay {
                tokio::time::sleep(Duration::from_millis(delay - since)).await;
            }
        }

        // Stream the move just applied. `ply` is 1-based; the FEN reflects the
        // position AFTER this move.
        let ply = moves.len();
        let uci_str = moves[ply - 1].clone();
        let fen_after = Fen::from_position(&pos, EnPassantMode::Legal).to_string();
        on_move(MoveEvent {
            game_id,
            ply,
            uci: uci_str,
            fen: fen_after,
            wtime_ms: wtime,
            btime_ms: btime,
        });
        last_emit = tokio::time::Instant::now();

        // --- Termination checks after the move ---

        if pos.is_checkmate() {
            // The side that just moved (`mover`) delivered mate and wins.
            let result = win_for(mover);
            return Ok(finish(white, black, result, "checkmate", moves));
        }
        if pos.is_stalemate() {
            return Ok(finish(white, black, "1/2-1/2", "stalemate", moves));
        }
        if pos.is_insufficient_material() {
            return Ok(finish(
                white,
                black,
                "1/2-1/2",
                "insufficient_material",
                moves,
            ));
        }
        // 50-move rule: halfmove clock >= 100.
        if pos.halfmoves() >= 100 {
            return Ok(finish(white, black, "1/2-1/2", "fifty_move", moves));
        }
        // Threefold repetition (tracked by us).
        let key = pos.zobrist_hash::<Zobrist64>(EnPassantMode::Legal).0;
        let count = rep_counts.entry(key).or_insert(0);
        *count += 1;
        if *count >= 3 {
            return Ok(finish(white, black, "1/2-1/2", "threefold", moves));
        }

        // --- Tablebase adjudication (perfect-play result for <=7-man endgames) ---
        //
        // The game is still ongoing here. If few enough pieces remain, ask the
        // Lichess tablebase for the perfect-play verdict and end the game with
        // it. Best-effort: a None result (any failure) just continues play.
        if adjudicate_tb && pos.board().occupied().count() <= 7 {
            let stm = pos.turn();
            let fen = Fen::from_position(&pos, EnPassantMode::Legal).to_string();
            if let Some(verdict) = probe_tablebase(&fen).await {
                let result = tb_result(verdict, stm);
                return Ok(finish(white, black, result, "tablebase", moves));
            }
        }
    }
}

fn win_for(c: Color) -> &'static str {
    match c {
        Color::White => "1-0",
        Color::Black => "0-1",
    }
}

fn loss_for(c: Color) -> &'static str {
    match c {
        Color::White => "0-1",
        Color::Black => "1-0",
    }
}

/// Tauri command wrapper around [`play_game_core`].
#[tauri::command]
pub async fn play_game(
    white_path: String,
    black_path: String,
    start_fen: Option<String>,
    base_ms: u64,
    inc_ms: u64,
    max_plies: usize,
    adjudicate_tb: Option<bool>,
) -> Result<GameResult, String> {
    play_game_core(
        &white_path,
        &black_path,
        start_fen,
        base_ms,
        inc_ms,
        max_plies,
        adjudicate_tb.unwrap_or(true),
    )
    .await
}

// ============================================================================
// Milestone 2 — Parallel batch runner
// ============================================================================

/// One game to be played as part of a batch. Self-describing so the runner can
/// schedule games in any order and the caller can correlate outcomes by `id`.
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct GameSpec {
    /// Caller-assigned identifier, echoed back on the matching [`GameOutcome`].
    pub id: usize,
    pub white_path: String,
    pub black_path: String,
    pub start_fen: Option<String>,
    /// Each side's starting clock, in milliseconds (sudden-death base time).
    #[serde(default = "default_base_ms")]
    pub base_ms: u64,
    /// Increment added to a side's clock after each of its moves, in ms.
    #[serde(default = "default_inc_ms")]
    pub inc_ms: u64,
    pub max_plies: usize,
    /// Optional tag: marks this game as the color-flipped partner of another.
    /// Purely informational for the runner; callers use it to pair games.
    #[serde(default)]
    pub flipped: bool,
    /// Adjudicate <=7-man endgames via the Lichess tablebase (perfect play).
    /// Defaults to `true` so older payloads (and the default UX) keep it on.
    #[serde(default = "default_true")]
    pub adjudicate_tb: bool,
    /// Optional per-side clock overrides (time-odds matches). When `None`, the
    /// side falls back to the shared `base_ms`/`inc_ms`. These are by board
    /// COLOR, not by engine — the caller decides which engine sits on which
    /// color. The clock logic itself stays symmetric; only the starting budgets
    /// and per-move increments may differ between White and Black.
    #[serde(default)]
    pub white_base_ms: Option<u64>,
    #[serde(default)]
    pub white_inc_ms: Option<u64>,
    #[serde(default)]
    pub black_base_ms: Option<u64>,
    #[serde(default)]
    pub black_inc_ms: Option<u64>,
}

/// Default for [`GameSpec::adjudicate_tb`]: tablebase adjudication is on unless
/// the caller explicitly disables it.
fn default_true() -> bool {
    true
}

/// Default sudden-death base clock (60s) for resilience if a payload omits it.
fn default_base_ms() -> u64 {
    60_000
}

/// Default per-move increment (0.6s) for resilience if a payload omits it.
fn default_inc_ms() -> u64 {
    600
}

/// The result of attempting one [`GameSpec`]: either a completed game or an
/// error string (e.g. an engine failed to spawn).
#[derive(Serialize, Debug, Clone)]
pub struct GameOutcome {
    /// Echoes [`GameSpec::id`].
    pub id: usize,
    /// Echoes [`GameSpec::flipped`].
    pub flipped: bool,
    /// `Ok` game result, or `Err` message if the game could not be played.
    pub result: Result<GameResult, String>,
    /// Neutral-evaluator score at each ply (start position + after every move),
    /// White-POV. Empty when the evaluator is disabled or failed to start.
    #[serde(default)]
    pub evals: Vec<PlyEval>,
    /// True when the game was cut short by a stop request (not a real error).
    /// Aborted games are excluded from all result stats.
    #[serde(default)]
    pub aborted: bool,
}

/// Progress event emitted as each game in a batch completes.
#[derive(Serialize, Debug, Clone)]
pub struct BatchProgress {
    /// Number of games that have finished so far (completed or errored).
    pub completed: usize,
    /// Total number of games scheduled in the batch.
    pub total: usize,
    /// The outcome of the game that just finished.
    pub last: GameOutcome,
}

/// Aggregate raw W/D/L counts over a set of outcomes.
#[derive(Serialize, Debug, Clone, Default)]
pub struct BatchSummary {
    pub games: usize,
    pub white_wins: usize,
    pub black_wins: usize,
    pub draws: usize,
    pub errors: usize,
}

/// Tally raw results across outcomes. White/Black wins are keyed on the literal
/// game result string ("1-0" / "0-1"); everything else with a result is a draw.
pub fn summarize(outcomes: &[GameOutcome]) -> BatchSummary {
    let mut s = BatchSummary::default();
    for o in outcomes {
        // Aborted games (stopped mid-play) are not real results — skip entirely.
        if o.aborted {
            continue;
        }
        s.games += 1;
        match &o.result {
            Ok(g) => match g.result.as_str() {
                "1-0" => s.white_wins += 1,
                "0-1" => s.black_wins += 1,
                _ => s.draws += 1,
            },
            Err(_) => s.errors += 1,
        }
    }
    s
}

/// Pick a sensible default concurrency when the caller passes 0: one less than
/// the number of logical CPUs, clamped to at least 1.
fn default_concurrency() -> usize {
    let cpus = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2);
    cpus.saturating_sub(1).max(1)
}

/// Run a batch of games concurrently with a bounded concurrency limit.
///
/// Thin wrapper over [`run_batch_core_evaluated`] with no neutral evaluator; its
/// signature and behavior are unchanged (evals come back empty).
pub async fn run_batch_core(
    specs: Vec<GameSpec>,
    concurrency: usize,
    on_progress: impl Fn(BatchProgress) + Send + Sync + 'static,
    on_move: Arc<dyn Fn(MoveEvent) + Send + Sync>,
    cancel: Arc<AtomicBool>,
) -> Vec<GameOutcome> {
    let controls = BatchControls {
        cancel,
        ..Default::default()
    };
    run_batch_core_evaluated(
        specs,
        concurrency,
        on_progress,
        on_move,
        Arc::new(|_| {}),
        None,
        controls,
    )
    .await
}

/// Run a batch of games concurrently, with an optional neutral evaluator scoring
/// every position of every game off the live-move stream.
///
/// Pure core: no Tauri dependencies.
/// * `concurrency` — max games in flight at once; `0` selects a sensible default.
/// * `on_progress` — invoked once per completed game with a [`BatchProgress`].
/// * `on_move` — invoked once per move played across all games, tagged with the
///   originating game's [`GameSpec::id`]. Shared across all concurrent games.
/// * `on_eval` — invoked once per evaluated position with an [`EvalEvent`]
///   (White-POV). Shared across all games. A no-op closure disables live eval
///   streaming without disabling collection.
/// * `eval` — the neutral evaluator config; `None` disables evaluation entirely.
///   When set, each game spawns its own evaluator engine (a third process) that
///   scores that game's positions in a separate task, so the players never wait
///   on it and their clocks are untouched. The collected per-ply evals are
///   attached to the game's [`GameOutcome`].
/// * `controls` — live-tunable [`BatchControls`] (stop / pause / auto-start /
///   throttle). `cancel` is checked before launching each queued game; once
///   set, no further games launch and in-flight games abort. When `auto_start`
///   is off the runner waits on `advance` between games (and forces concurrency
///   to 1, so the pause-between-games semantics are unambiguous — with >1 games
///   in flight "between games" has no single meaning). `paused` and
///   `move_delay_ms` are threaded into each game.
///
/// Engine processes are torn down cleanly: each game owns its own short-lived
/// engine handles (spawned with `kill_on_drop`), and on cancellation we simply
/// stop scheduling new ones, so nothing leaks.
pub async fn run_batch_core_evaluated(
    specs: Vec<GameSpec>,
    concurrency: usize,
    on_progress: impl Fn(BatchProgress) + Send + Sync + 'static,
    on_move: Arc<dyn Fn(MoveEvent) + Send + Sync>,
    on_eval: Arc<dyn Fn(EvalEvent) + Send + Sync>,
    eval: Option<EvalSetup>,
    controls: BatchControls,
) -> Vec<GameOutcome> {
    let cancel = Arc::clone(&controls.cancel);
    let total = specs.len();
    // Manual "start next game" (auto_start off) means sequential play — force
    // concurrency 1 so "between games" is a single, well-defined gap.
    let manual = !controls.auto_start.load(Ordering::SeqCst);
    let limit = if manual {
        1
    } else if concurrency == 0 {
        default_concurrency()
    } else {
        concurrency
    };

    let semaphore = Arc::new(tokio::sync::Semaphore::new(limit));
    let on_progress = Arc::new(on_progress);
    let completed = Arc::new(std::sync::atomic::AtomicUsize::new(0));

    let mut handles = Vec::with_capacity(total);

    for (idx, spec) in specs.into_iter().enumerate() {
        // Stop launching new games once cancellation is requested.
        if cancel.load(Ordering::SeqCst) {
            break;
        }

        // Acquire a permit before spawning so at most `limit` games run at once.
        // If cancellation arrives while we're waiting for a permit, bail.
        let permit = match Arc::clone(&semaphore).acquire_owned().await {
            Ok(p) => p,
            Err(_) => break,
        };
        if cancel.load(Ordering::SeqCst) {
            drop(permit);
            break;
        }

        // Between-games gate: when auto-start is off, wait for the user to
        // advance before starting any game after the first. With concurrency
        // forced to 1, the permit above is only free once the previous game
        // finished, so this gap sits cleanly between two games.
        if idx > 0 && !controls.auto_start.load(Ordering::SeqCst) {
            loop {
                if cancel.load(Ordering::SeqCst) {
                    break;
                }
                // Re-derive each pass: the user may re-enable auto-start instead
                // of clicking "start next game".
                if controls.auto_start.load(Ordering::SeqCst) {
                    break;
                }
                tokio::select! {
                    _ = controls.advance.notified() => break,
                    _ = tokio::time::sleep(Duration::from_millis(150)) => {}
                }
            }
            if cancel.load(Ordering::SeqCst) {
                drop(permit);
                break;
            }
        }

        let on_progress = Arc::clone(&on_progress);
        let on_move = Arc::clone(&on_move);
        let on_eval = Arc::clone(&on_eval);
        let eval = eval.clone();
        let completed = Arc::clone(&completed);
        let cancel_game = Arc::clone(&cancel);
        let paused_game = Arc::clone(&controls.paused);
        let delay_game = Arc::clone(&controls.move_delay_ms);

        let handle = tokio::spawn(async move {
            // Permit is held for the lifetime of this game, then released here.
            let _permit = permit;

            // Spin up the neutral evaluator for this game (if enabled): a task
            // that owns a third engine and scores positions fed over a channel,
            // fully decoupled from the play loop so the players never wait on it.
            let mut eval_tx: Option<tokio::sync::mpsc::UnboundedSender<(usize, String)>> = None;
            let mut eval_join: Option<tokio::task::JoinHandle<Vec<PlyEval>>> = None;
            if let Some(setup) = eval {
                let (tx, mut rx) =
                    tokio::sync::mpsc::unbounded_channel::<(usize, String)>();
                let game_id = spec.id;
                let on_eval = Arc::clone(&on_eval);
                let join = tokio::spawn(async move {
                    let mut evals: Vec<PlyEval> = Vec::new();
                    // Best-effort: if the evaluator can't start, drain the queue
                    // so senders don't block, and return no evals.
                    let mut engine = match EngineHandle::spawn(&setup.path).await {
                        Ok(e) => e,
                        Err(_) => {
                            while rx.recv().await.is_some() {}
                            return evals;
                        }
                    };
                    if engine.init().await.is_err() {
                        while rx.recv().await.is_some() {}
                        return evals;
                    }
                    let read_wait =
                        Duration::from_millis(setup.movetime_ms.saturating_add(5000).max(5000));
                    while let Some((ply, fen)) = rx.recv().await {
                        if let Ok((cp, mate)) =
                            engine.eval_at(&fen, setup.movetime_ms, read_wait).await
                        {
                            on_eval(EvalEvent { game_id, ply, cp, mate });
                            evals.push(PlyEval { ply, cp, mate });
                        }
                    }
                    engine.quit().await;
                    evals
                });
                // Seed ply 0 (the start position) so the graph/bar have an
                // opening data point before the first move is played.
                let start_fen = spec
                    .start_fen
                    .clone()
                    .unwrap_or_else(|| STANDARD_START_FEN.to_string());
                let _ = tx.send((0, start_fen));
                eval_tx = Some(tx);
                eval_join = Some(join);
            }

            let on_move_inner = Arc::clone(&on_move);
            let eval_tx_move = eval_tx.clone();
            let result = play_game_streamed(
                &spec.white_path,
                &spec.black_path,
                spec.start_fen.clone(),
                spec.white_base_ms.unwrap_or(spec.base_ms),
                spec.white_inc_ms.unwrap_or(spec.inc_ms),
                spec.black_base_ms.unwrap_or(spec.base_ms),
                spec.black_inc_ms.unwrap_or(spec.inc_ms),
                spec.max_plies,
                spec.adjudicate_tb,
                spec.id,
                move |ev| {
                    // Feed the evaluator this position (post-move FEN) before
                    // forwarding the move on. Unbounded send never blocks play.
                    if let Some(tx) = &eval_tx_move {
                        let _ = tx.send((ev.ply, ev.fen.clone()));
                    }
                    on_move_inner(ev);
                },
                &cancel_game,
                &paused_game,
                &delay_game,
            )
            .await;

            // Close the eval channel (both sender clones) and collect the evals.
            // The evaluator lags by at most one position, so this waits briefly.
            drop(eval_tx);
            let evals = match eval_join {
                Some(join) => join.await.unwrap_or_default(),
                None => Vec::new(),
            };

            // A game cut short by the stop request is aborted, not a real error —
            // it is excluded from all stats.
            let aborted = matches!(&result, Err(e) if e == "cancelled");
            let outcome = GameOutcome {
                id: spec.id,
                flipped: spec.flipped,
                result,
                evals,
                aborted,
            };

            let done = completed.fetch_add(1, Ordering::SeqCst) + 1;
            on_progress(BatchProgress {
                completed: done,
                total,
                last: outcome.clone(),
            });

            outcome
        });

        handles.push(handle);
    }

    // Collect all launched games (in-flight ones run to completion).
    let mut outcomes = Vec::with_capacity(handles.len());
    for h in handles {
        if let Ok(outcome) = h.await {
            outcomes.push(outcome);
        }
    }

    // Stable ordering by spec id so callers get deterministic output.
    outcomes.sort_by_key(|o| o.id);
    outcomes
}

/// Pre-flight the engine binaries referenced by a batch: every distinct
/// white/black path is checked for existence and (on Unix) an executable bit
/// BEFORE any game is launched. A misconfigured path is by far the most common
/// reason a whole batch fails instantly, so we surface it once, up front, with
/// the offending path — instead of letting every game spawn-fail with the same
/// opaque error.
///
/// A path with no separator (a bare command resolved via `PATH`) is skipped:
/// we can't cheaply verify it here, and letting the spawn resolve it keeps the
/// existing PATH-based behavior working. Returns the first problem found.
fn check_engine_paths(specs: &[GameSpec]) -> Result<(), String> {
    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for spec in specs {
        for path in [spec.white_path.as_str(), spec.black_path.as_str()] {
            if !seen.insert(path) {
                continue;
            }
            check_engine_path(path)?;
        }
    }
    Ok(())
}

/// Pre-flight one engine binary: must exist, be a file, and (on Unix) carry an
/// executable bit. A bare command name (no path separator) is skipped so PATH
/// resolution keeps working. Shared by the batch preflight and the evaluator.
fn check_engine_path(path: &str) -> Result<(), String> {
    // Bare command name (no path separator): defer to PATH resolution.
    if !path.contains('/') && !path.contains('\\') {
        return Ok(());
    }
    let meta = std::fs::metadata(path)
        .map_err(|e| format!("Engine not found: '{}' ({})", path, e))?;
    if !meta.is_file() {
        return Err(format!("Engine path is not a file: '{}'", path));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o111 == 0 {
            return Err(format!("Engine is not executable: '{}'", path));
        }
    }
    Ok(())
}

/// Shared, live-tunable controls for a running batch, held as Tauri state so the
/// stop / pause / auto-start / throttle commands can steer an in-flight
/// [`play_batch`]. Cloned Arcs are threaded into every game.
#[derive(Clone)]
pub struct BatchControls {
    /// Set to stop the batch: no new games launch and in-flight games abort at
    /// their next move boundary.
    pub cancel: Arc<AtomicBool>,
    /// While set, games freeze between moves (clocks don't tick, engines idle).
    pub paused: Arc<AtomicBool>,
    /// Minimum on-board display time per move (ms); 0 = no throttle.
    pub move_delay_ms: Arc<AtomicU64>,
    /// When false, the runner waits for [`Self::advance`] before starting each
    /// game after the first (manual "start next game").
    pub auto_start: Arc<AtomicBool>,
    /// Notified to release the between-games gate (or to wake it on cancel).
    pub advance: Arc<tokio::sync::Notify>,
}

impl Default for BatchControls {
    fn default() -> Self {
        Self {
            cancel: Arc::new(AtomicBool::new(false)),
            paused: Arc::new(AtomicBool::new(false)),
            move_delay_ms: Arc::new(AtomicU64::new(0)),
            // Auto-start defaults ON: games flow without manual advance.
            auto_start: Arc::new(AtomicBool::new(true)),
            advance: Arc::new(tokio::sync::Notify::new()),
        }
    }
}

/// Tauri-managed wrapper around the shared [`BatchControls`].
#[derive(Default)]
pub struct BatchControl(pub BatchControls);

/// Response from [`play_batch`]: every outcome plus the aggregate summary.
#[derive(Serialize, Debug, Clone)]
pub struct BatchReport {
    pub outcomes: Vec<GameOutcome>,
    pub summary: BatchSummary,
}

/// Tauri command: run a batch of games, streaming per-game progress over an IPC
/// channel, and return all outcomes plus the summary.
///
/// Control: the shared [`BatchControls`] are reset at the start of each batch
/// (cancel/pause cleared; `auto_start` and `move_delay_ms` seeded from the
/// arguments), then the `cancel_batch` / `pause_batch` / `set_auto_start` /
/// `set_move_delay` / `start_next_game` commands steer the run live.
///
/// Neutral evaluator: when `eval_path` is set, a third engine scores every
/// position of every game at `eval_movetime_ms` (default
/// [`DEFAULT_EVAL_MOVETIME_MS`]) off the live-move stream — never on a player's
/// clock — streaming [`EvalEvent`]s over `on_eval` and attaching per-ply evals
/// to each [`GameOutcome`]. `eval_path` is pre-flighted like the players.
#[tauri::command]
pub async fn play_batch(
    specs: Vec<GameSpec>,
    concurrency: usize,
    on_progress: tauri::ipc::Channel<BatchProgress>,
    on_move: tauri::ipc::Channel<MoveEvent>,
    on_eval: tauri::ipc::Channel<EvalEvent>,
    eval_path: Option<String>,
    eval_movetime_ms: Option<u64>,
    auto_start: Option<bool>,
    move_delay_ms: Option<u64>,
    control: tauri::State<'_, BatchControl>,
) -> Result<BatchReport, String> {
    // Fail fast, once, if an engine binary is missing or non-executable —
    // otherwise every game spawn-fails identically and the UI shows only a
    // count. A bare command (PATH-resolved) is not checked here.
    check_engine_paths(&specs)?;

    // Pre-flight the evaluator path too so a bad path fails up front, not
    // silently as empty evals on every game.
    let eval = match eval_path {
        Some(p) if !p.trim().is_empty() => {
            check_engine_path(&p)?;
            Some(EvalSetup {
                path: p,
                movetime_ms: eval_movetime_ms.unwrap_or(DEFAULT_EVAL_MOVETIME_MS).max(1),
            })
        }
        _ => None,
    };

    // Fresh run: clear any leftover cancel/pause and seed the tunable controls
    // from the run's arguments. Reusing the same managed Arcs keeps the live
    // commands pointing at this run.
    let controls = control.0.clone();
    controls.cancel.store(false, Ordering::SeqCst);
    controls.paused.store(false, Ordering::SeqCst);
    controls
        .auto_start
        .store(auto_start.unwrap_or(true), Ordering::SeqCst);
    controls
        .move_delay_ms
        .store(move_delay_ms.unwrap_or(0), Ordering::SeqCst);

    let progress = on_progress.clone();
    let moves = on_move.clone();
    let evals = on_eval.clone();
    let outcomes = run_batch_core_evaluated(
        specs,
        concurrency,
        move |p| {
            // Best-effort: a closed channel (window gone) must not abort the run.
            let _ = progress.send(p);
        },
        Arc::new(move |ev| {
            // Best-effort, same as progress: a closed channel must not abort.
            let _ = moves.send(ev);
        }),
        Arc::new(move |ev| {
            // Best-effort, same as the others.
            let _ = evals.send(ev);
        }),
        eval,
        controls,
    )
    .await;

    let summary = summarize(&outcomes);
    Ok(BatchReport { outcomes, summary })
}

/// Tauri command: request cancellation of the currently running batch. Also
/// wakes the between-games gate so a paused-between-games run stops promptly.
#[tauri::command]
pub fn cancel_batch(control: tauri::State<'_, BatchControl>) {
    control.0.cancel.store(true, Ordering::SeqCst);
    control.0.advance.notify_one();
}

/// Tauri command: pause/resume the running batch. While paused, games freeze
/// between moves (both clocks hold, engines idle) until resumed.
#[tauri::command]
pub fn pause_batch(paused: bool, control: tauri::State<'_, BatchControl>) {
    control.0.paused.store(paused, Ordering::SeqCst);
}

/// Tauri command: toggle auto-start of the next game. Turning it ON also
/// releases any between-games gate the runner is currently sitting on.
#[tauri::command]
pub fn set_auto_start(auto_start: bool, control: tauri::State<'_, BatchControl>) {
    control.0.auto_start.store(auto_start, Ordering::SeqCst);
    if auto_start {
        control.0.advance.notify_one();
    }
}

/// Tauri command: advance past the between-games gate to start the next game.
#[tauri::command]
pub fn start_next_game(control: tauri::State<'_, BatchControl>) {
    control.0.advance.notify_one();
}

/// Tauri command: set the minimum on-board display time per move (ms); 0 = off.
#[tauri::command]
pub fn set_move_delay(delay_ms: u64, control: tauri::State<'_, BatchControl>) {
    control.0.move_delay_ms.store(delay_ms, Ordering::SeqCst);
}

/// Tauri command: return a UCI engine's `id name` (e.g. "Stockfish 18"), so the
/// app can show the actual version behind a binary path. Best-effort, 5s cap.
#[tauri::command]
pub async fn engine_id(path: String) -> Result<String, String> {
    use std::process::Stdio;
    let mut child = Command::new(&path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("spawn failed: {e}"))?;
    {
        let mut stdin = child.stdin.take().ok_or("no stdin")?;
        stdin
            .write_all(b"uci\nquit\n")
            .await
            .map_err(|e| e.to_string())?;
    }
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let mut lines = BufReader::new(stdout).lines();
    let read = async {
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(rest) = line.strip_prefix("id name ") {
                return Some(rest.trim().to_string());
            }
            if line.starts_with("uciok") {
                break;
            }
        }
        None
    };
    let name = tokio::time::timeout(Duration::from_secs(5), read)
        .await
        .ok()
        .flatten();
    let _ = child.wait().await;
    name.ok_or_else(|| "no id name in UCI output".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(id: usize, white: &str, black: &str, fen: Option<&str>) -> GameSpec {
        GameSpec {
            id,
            white_path: white.to_string(),
            black_path: black.to_string(),
            start_fen: fen.map(|s| s.to_string()),
            base_ms: 1000,
            inc_ms: 100,
            max_plies: 40,
            flipped: false,
            // Off so tests never touch the network.
            adjudicate_tb: false,
            ..Default::default()
        }
    }

    // An illegal start FEN must be rejected BEFORE any engine is spawned, so the
    // game errors instantly with a descriptive message — the failure class the
    // "current position" mode could feed in from a hand-edited/vision position.
    #[tokio::test]
    async fn illegal_start_fen_errors_without_spawning() {
        // Castling rights present but the king has moved off e1: shakmaty's
        // strict validation rejects this. Engine paths are deliberately bogus;
        // the FEN is parsed first, so they are never spawned.
        let bad_fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQ1KNR w KQkq - 0 1";
        let specs = vec![spec(0, "/no/such/engine", "/no/such/engine", Some(bad_fen))];

        let outcomes = run_batch_core(
            specs,
            1,
            |_p| {},
            Arc::new(|_ev| {}),
            Arc::new(AtomicBool::new(false)),
        )
        .await;

        assert_eq!(outcomes.len(), 1);
        match &outcomes[0].result {
            Err(e) => assert!(
                e.contains("Illegal start position"),
                "expected an illegal-position error, got: {e}"
            ),
            Ok(g) => panic!("expected an error, got a completed game: {:?}", g),
        }
        let summary = summarize(&outcomes);
        assert_eq!(summary.errors, 1);
    }

    #[test]
    fn preflight_flags_missing_engine_with_path() {
        let specs = vec![spec(0, "/opt/does-not-exist/stockfish", "/bin/sh", None)];
        let err = check_engine_paths(&specs).expect_err("missing engine should fail preflight");
        assert!(
            err.contains("/opt/does-not-exist/stockfish"),
            "error should name the offending path, got: {err}"
        );
    }

    #[test]
    fn preflight_accepts_existing_executable_and_skips_bare_commands() {
        // /bin/sh exists and is executable on every unix CI box; "stockfish"
        // (no separator) is a PATH-resolved command we intentionally skip.
        let specs = vec![spec(0, "/bin/sh", "stockfish", None)];
        assert!(check_engine_paths(&specs).is_ok());
    }

    #[test]
    fn parse_info_score_reads_cp_and_mate() {
        let cp = parse_info_score("info depth 12 seldepth 18 score cp -34 nodes 1000 pv e2e4");
        assert_eq!(cp, Some((Some(-34), None)));
        let mate = parse_info_score("info depth 20 score mate 3 pv h5f7");
        assert_eq!(mate, Some((None, Some(3))));
        // A lowerbound-flagged score still parses to its numeric value.
        let lb = parse_info_score("info depth 5 score cp 128 lowerbound pv d2d4");
        assert_eq!(lb, Some((Some(128), None)));
        // No score token → None (e.g. a currmove line).
        assert_eq!(parse_info_score("info depth 1 currmove e2e4 currmovenumber 1"), None);
    }

    #[test]
    fn fen_black_to_move_reads_active_color() {
        assert!(!fen_black_to_move(STANDARD_START_FEN));
        assert!(fen_black_to_move(
            "rnbqkbnr/pppppppp/8/8/4P3/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1"
        ));
    }

    /// Resolve a usable Stockfish path for the live-engine tests, or `None` so
    /// they skip cleanly on a box without it.
    fn find_stockfish() -> Option<String> {
        for p in ["/opt/homebrew/bin/stockfish", "/usr/local/bin/stockfish", "/usr/bin/stockfish"] {
            if std::path::Path::new(p).exists() {
                return Some(p.to_string());
            }
        }
        None
    }

    // End-to-end evaluator plumbing against a real engine at a tiny movetime:
    // a short game is played and the neutral evaluator must attach one White-POV
    // eval per streamed ply (including ply 0 for the start position) and stream
    // the same count of EvalEvents. Skips if no Stockfish is installed.
    #[tokio::test]
    async fn evaluator_attaches_and_streams_per_ply_evals() {
        let Some(sf) = find_stockfish() else {
            eprintln!("skipping evaluator_attaches_and_streams_per_ply_evals: no stockfish");
            return;
        };

        let specs = vec![spec(0, &sf, &sf, None)];
        let eval_events = Arc::new(Mutex::new(Vec::<EvalEvent>::new()));
        let sink = Arc::clone(&eval_events);

        let outcomes = run_batch_core_evaluated(
            specs,
            1,
            |_p| {},
            Arc::new(|_ev| {}),
            Arc::new(move |ev| sink.lock().unwrap().push(ev)),
            Some(EvalSetup { path: sf.clone(), movetime_ms: 20 }),
            BatchControls::default(),
        )
        .await;

        assert_eq!(outcomes.len(), 1);
        let o = &outcomes[0];
        let g = o.result.as_ref().expect("game should complete");
        // One eval per ply plus the start position (ply 0).
        assert_eq!(
            o.evals.len(),
            g.plies + 1,
            "expected {} evals (plies + start), got {}",
            g.plies + 1,
            o.evals.len()
        );
        // ply indices are 0..=plies and each carries a score.
        for (i, pe) in o.evals.iter().enumerate() {
            assert_eq!(pe.ply, i, "evals must be ordered by ply");
            assert!(
                pe.cp.is_some() || pe.mate.is_some(),
                "each ply should have a cp or mate score"
            );
        }
        // Every collected eval was also streamed live.
        assert_eq!(eval_events.lock().unwrap().len(), o.evals.len());
    }

    fn outcome(id: usize, result: Result<GameResult, String>, aborted: bool) -> GameOutcome {
        GameOutcome { id, flipped: false, result, evals: Vec::new(), aborted }
    }

    fn win(res: &str) -> Result<GameResult, String> {
        Ok(GameResult {
            result: res.to_string(),
            termination: "checkmate".to_string(),
            plies: 10,
            start_fen: STANDARD_START_FEN.to_string(),
            moves: Vec::new(),
        })
    }

    #[test]
    fn summarize_excludes_aborted_games() {
        let outcomes = vec![
            outcome(0, win("1-0"), false),
            outcome(1, win("0-1"), false),
            outcome(2, Err("cancelled".to_string()), true), // aborted mid-play
            outcome(3, Err("boom".to_string()), false),     // a real error
        ];
        let s = summarize(&outcomes);
        // The aborted game is counted nowhere — not in games, not in errors.
        assert_eq!(s.games, 3);
        assert_eq!(s.white_wins, 1);
        assert_eq!(s.black_wins, 1);
        assert_eq!(s.errors, 1);
    }

    // Stopping a running batch marks in-flight games aborted (not errors) and
    // excludes them from the summary; games finished before the stop are kept.
    #[tokio::test]
    async fn stop_marks_inflight_games_aborted() {
        let Some(sf) = find_stockfish() else {
            eprintln!("skipping stop_marks_inflight_games_aborted: no stockfish");
            return;
        };
        // Several longer games at concurrency 1 so a stop lands mid-play.
        let specs: Vec<GameSpec> = (0..4)
            .map(|i| GameSpec {
                id: i,
                white_path: sf.clone(),
                black_path: sf.clone(),
                start_fen: None,
                base_ms: 2000,
                inc_ms: 50,
                max_plies: 200,
                flipped: false,
                adjudicate_tb: false,
                ..Default::default()
            })
            .collect();
        let controls = BatchControls::default();
        let cancel = Arc::clone(&controls.cancel);
        // Stop shortly after the batch starts.
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(400)).await;
            cancel.store(true, Ordering::SeqCst);
        });
        let outcomes =
            run_batch_core_evaluated(specs, 1, |_p| {}, Arc::new(|_| {}), Arc::new(|_| {}), None, controls).await;

        // At least one game aborted; aborted games are Err but flagged aborted,
        // and the summary excludes every aborted game.
        let aborted = outcomes.iter().filter(|o| o.aborted).count();
        assert!(aborted >= 1, "expected at least one aborted game on stop");
        let s = summarize(&outcomes);
        assert_eq!(
            s.games,
            outcomes.iter().filter(|o| !o.aborted).count(),
            "summary must count only non-aborted games"
        );
        assert_eq!(s.errors, 0, "aborted games must not count as errors");
    }

    // The pause gate parks a game between moves until resumed; the clocks freeze
    // because no search runs while parked, so the game still completes normally.
    #[tokio::test]
    async fn pause_gate_holds_game_until_resumed() {
        let Some(sf) = find_stockfish() else {
            eprintln!("skipping pause_gate_holds_game_until_resumed: no stockfish");
            return;
        };
        let paused = Arc::new(AtomicBool::new(true));
        let cancel = Arc::new(AtomicBool::new(false));
        let delay = Arc::new(AtomicU64::new(0));
        let (p, c, d, sf2) = (Arc::clone(&paused), Arc::clone(&cancel), Arc::clone(&delay), sf.clone());
        let handle = tokio::spawn(async move {
            play_game_streamed(&sf2, &sf2, None, 1000, 100, 1000, 100, 30, false, 0, |_| {}, &c, &p, &d).await
        });
        // Parked at the gate (spawn+init done, no moves played): must not finish.
        tokio::time::sleep(Duration::from_millis(1500)).await;
        assert!(!handle.is_finished(), "a paused game must not complete");
        // Resume and it runs to a real result.
        paused.store(false, Ordering::SeqCst);
        let res = tokio::time::timeout(Duration::from_secs(30), handle)
            .await
            .expect("game should finish after resume")
            .expect("join ok")
            .expect("game ok");
        assert!(res.plies > 0, "resumed game should have played moves");
    }

    // The display throttle keeps each move on the board at least `move_delay_ms`,
    // so a fast game's wall time is dominated by the throttle, not the search.
    #[tokio::test]
    async fn move_delay_throttles_display() {
        let Some(sf) = find_stockfish() else {
            eprintln!("skipping move_delay_throttles_display: no stockfish");
            return;
        };
        let delay_ms: u64 = 120;
        let cancel = Arc::new(AtomicBool::new(false));
        let paused = Arc::new(AtomicBool::new(false));
        let delay = Arc::new(AtomicU64::new(delay_ms));
        // Tiny TC so search is fast and the throttle is the binding constraint.
        let t0 = tokio::time::Instant::now();
        let res = play_game_streamed(&sf, &sf, None, 60, 0, 60, 0, 16, false, 0, |_| {}, &cancel, &paused, &delay)
            .await
            .expect("game ok");
        let elapsed = t0.elapsed().as_millis() as u64;
        assert!(res.plies >= 2, "need a few moves to measure throttling");
        // Each of the plies after the first was held >= delay_ms before the next.
        let floor = (res.plies as u64 - 1) * delay_ms;
        assert!(
            elapsed >= floor,
            "throttled game took {elapsed}ms, expected >= {floor}ms ({} plies @ {delay_ms}ms)",
            res.plies
        );
    }
}
