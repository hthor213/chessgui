//! Headless engine-vs-engine match runner.
//!
//! This subsystem plays a single full game between two UCI engines to a
//! definitive result, using `shakmaty` for rules and termination detection.
//! It is completely independent from the interactive single-engine manager in
//! `uci.rs` — it spawns its own short-lived engine processes and drives them
//! synchronously, one move at a time.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
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
    /// Drives the engine with `go wtime <wtime> btime <btime> winc <inc> binc
    /// <inc>` so the engine budgets its own time. The clocks are clamped to at
    /// least 1ms when sent (never negative/zero). `read_wait` bounds how long we
    /// wait for `bestmove` — it should be the moving side's remaining time plus a
    /// generous margin so a hung engine is caught but a legitimately slow move is
    /// not killed.
    ///
    /// Returns the raw UCI bestmove token (e.g. "e2e4", "e7e8q") or the literal
    /// "(none)" when the engine reports no move, together with the precise wall
    /// time the search took (used to debit the moving side's clock).
    async fn bestmove(
        &mut self,
        position_cmd: &str,
        wtime_ms: i64,
        btime_ms: i64,
        inc_ms: u64,
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
            wt, bt, inc_ms, inc_ms
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
        max_plies,
        adjudicate_tb,
        0,
        |_| {},
        &AtomicBool::new(false),
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
pub async fn play_game_streamed(
    white_path: &str,
    black_path: &str,
    start_fen: Option<String>,
    base_ms: u64,
    inc_ms: u64,
    max_plies: usize,
    adjudicate_tb: bool,
    game_id: usize,
    on_move: impl Fn(MoveEvent) + Send + Sync,
    cancel: &AtomicBool,
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

    // Sudden-death + increment game clock. Each side starts with `base_ms` and
    // gains `inc_ms` after each of its own moves. Signed so we can detect a
    // flag-fall (clock crossing below zero). These persist across the whole game
    // and are NEVER reset per move.
    let mut wtime: i64 = base_ms as i64;
    let mut btime: i64 = base_ms as i64;
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

    loop {
        // Abort promptly if the batch was cancelled (engines die on drop). This
        // bounds an in-flight game's shutdown to roughly one move's think time.
        if cancel.load(Ordering::SeqCst) {
            return Err("cancelled".to_string());
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
            .bestmove(&position_cmd, wtime, btime, inc_ms, read_wait)
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
        let clock = match mover {
            Color::White => &mut wtime,
            Color::Black => &mut btime,
        };
        *clock -= elapsed;
        if *clock < -FLAG_GRACE_MS {
            let result = loss_for(mover);
            return Ok(finish(white, black, result, "time_forfeit", moves));
        }
        *clock += inc_ms as i64;

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
#[derive(Serialize, Deserialize, Debug, Clone)]
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
    let mut s = BatchSummary {
        games: outcomes.len(),
        ..Default::default()
    };
    for o in outcomes {
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
/// Pure core: no Tauri dependencies.
/// * `concurrency` — max games in flight at once; `0` selects a sensible default.
/// * `on_progress` — invoked once per completed game with a [`BatchProgress`].
/// * `cancel` — checked before launching each queued game; once set, no further
///   games are launched (in-flight games are allowed to finish). Whatever has
///   completed is returned.
///
/// Engine processes are torn down cleanly: each game owns its own short-lived
/// engine handles (spawned with `kill_on_drop`), and on cancellation we simply
/// stop scheduling new ones, so nothing leaks.
/// * `on_move` — invoked once per move played across all games, tagged with the
///   originating game's [`GameSpec::id`]. Shared across all concurrent games.
pub async fn run_batch_core(
    specs: Vec<GameSpec>,
    concurrency: usize,
    on_progress: impl Fn(BatchProgress) + Send + Sync + 'static,
    on_move: Arc<dyn Fn(MoveEvent) + Send + Sync>,
    cancel: Arc<AtomicBool>,
) -> Vec<GameOutcome> {
    let total = specs.len();
    let limit = if concurrency == 0 {
        default_concurrency()
    } else {
        concurrency
    };

    let semaphore = Arc::new(tokio::sync::Semaphore::new(limit));
    let on_progress = Arc::new(on_progress);
    let completed = Arc::new(std::sync::atomic::AtomicUsize::new(0));

    let mut handles = Vec::with_capacity(total);

    for spec in specs {
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

        let on_progress = Arc::clone(&on_progress);
        let on_move = Arc::clone(&on_move);
        let completed = Arc::clone(&completed);
        let cancel_game = Arc::clone(&cancel);

        let handle = tokio::spawn(async move {
            // Permit is held for the lifetime of this game, then released here.
            let _permit = permit;

            let result = play_game_streamed(
                &spec.white_path,
                &spec.black_path,
                spec.start_fen.clone(),
                spec.base_ms,
                spec.inc_ms,
                spec.max_plies,
                spec.adjudicate_tb,
                spec.id,
                move |ev| on_move(ev),
                &cancel_game,
            )
            .await;

            let outcome = GameOutcome {
                id: spec.id,
                flipped: spec.flipped,
                result,
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

/// Shared cancellation flag, managed as Tauri state so a `cancel_batch` command
/// can request that an in-flight [`play_batch`] stop launching new games.
#[derive(Default)]
pub struct BatchCancel(pub Arc<AtomicBool>);

/// Response from [`play_batch`]: every outcome plus the aggregate summary.
#[derive(Serialize, Debug, Clone)]
pub struct BatchReport {
    pub outcomes: Vec<GameOutcome>,
    pub summary: BatchSummary,
}

/// Tauri command: run a batch of games, streaming per-game progress over an IPC
/// channel, and return all outcomes plus the summary.
///
/// Cancellation: the shared [`BatchCancel`] flag is reset at the start of each
/// batch, then a `cancel_batch` command can set it to request a clean stop.
#[tauri::command]
pub async fn play_batch(
    specs: Vec<GameSpec>,
    concurrency: usize,
    on_progress: tauri::ipc::Channel<BatchProgress>,
    on_move: tauri::ipc::Channel<MoveEvent>,
    cancel: tauri::State<'_, BatchCancel>,
) -> Result<BatchReport, String> {
    // Fresh run: clear any leftover cancellation from a previous batch.
    let flag = Arc::clone(&cancel.0);
    flag.store(false, Ordering::SeqCst);

    let progress = on_progress.clone();
    let moves = on_move.clone();
    let outcomes = run_batch_core(
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
        Arc::clone(&flag),
    )
    .await;

    let summary = summarize(&outcomes);
    Ok(BatchReport { outcomes, summary })
}

/// Tauri command: request cancellation of the currently running batch.
#[tauri::command]
pub fn cancel_batch(cancel: tauri::State<'_, BatchCancel>) {
    cancel.0.store(true, Ordering::SeqCst);
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
