//! Headless engine-vs-engine match runner.
//!
//! This subsystem plays a single full game between two UCI engines to a
//! definitive result, using `shakmaty` for rules and termination detection.
//! It is completely independent from the interactive single-engine manager in
//! `uci.rs` — it spawns its own short-lived engine processes and drives them
//! synchronously, one move at a time.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use shakmaty::fen::Fen;
use shakmaty::uci::UciMove;
use shakmaty::zobrist::Zobrist64;
use shakmaty::{CastlingMode, Chess, Color, EnPassantMode, Position};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, Command};
use tokio::time::timeout;

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

    /// Ask the engine for a move given a position and movetime.
    ///
    /// Returns the raw UCI bestmove token (e.g. "e2e4", "e7e8q") or the literal
    /// "(none)" when the engine reports no move.
    async fn bestmove(
        &mut self,
        position_cmd: &str,
        movetime_ms: u64,
    ) -> Result<String, String> {
        self.send(position_cmd).await?;
        self.send(&format!("go movetime {}", movetime_ms)).await?;

        // Safety budget: movetime + slack so a hung engine cannot deadlock.
        let wait = Duration::from_millis(movetime_ms) + Duration::from_secs(5);
        let line = self
            .read_until(wait, |l| l.starts_with("bestmove"))
            .await?;

        // Format: "bestmove <uci> [ponder <uci>]" or "bestmove (none)".
        let mut parts = line.split_whitespace();
        parts.next(); // "bestmove"
        let mv = parts
            .next()
            .ok_or_else(|| format!("Malformed bestmove line: '{}'", line))?;
        Ok(mv.to_string())
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

/// Play one full headless game between two engines.
///
/// Pure core: no Tauri dependencies. Spawns both engines, drives them
/// move-by-move, detects termination via `shakmaty`, and returns the result.
pub async fn play_game_core(
    white_path: &str,
    black_path: &str,
    start_fen: Option<String>,
    movetime_ms: u64,
    max_plies: usize,
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

    loop {
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

        let bestmove = match engine.bestmove(&position_cmd, movetime_ms).await {
            Ok(m) => m,
            Err(e) => {
                // Treat a comms failure as a loss for the side to move.
                let result = loss_for(mover);
                let term = format!("engine_error: {}", e);
                return Ok(finish(white, black, result, &term, moves));
            }
        };

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
    movetime_ms: u64,
    max_plies: usize,
) -> Result<GameResult, String> {
    play_game_core(&white_path, &black_path, start_fen, movetime_ms, max_plies).await
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
    pub movetime_ms: u64,
    pub max_plies: usize,
    /// Optional tag: marks this game as the color-flipped partner of another.
    /// Purely informational for the runner; callers use it to pair games.
    #[serde(default)]
    pub flipped: bool,
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
pub async fn run_batch_core(
    specs: Vec<GameSpec>,
    concurrency: usize,
    on_progress: impl Fn(BatchProgress) + Send + Sync + 'static,
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
        let completed = Arc::clone(&completed);

        let handle = tokio::spawn(async move {
            // Permit is held for the lifetime of this game, then released here.
            let _permit = permit;

            let result = play_game_core(
                &spec.white_path,
                &spec.black_path,
                spec.start_fen.clone(),
                spec.movetime_ms,
                spec.max_plies,
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
    cancel: tauri::State<'_, BatchCancel>,
) -> Result<BatchReport, String> {
    // Fresh run: clear any leftover cancellation from a previous batch.
    let flag = Arc::clone(&cancel.0);
    flag.store(false, Ordering::SeqCst);

    let progress = on_progress.clone();
    let outcomes = run_batch_core(
        specs,
        concurrency,
        move |p| {
            // Best-effort: a closed channel (window gone) must not abort the run.
            let _ = progress.send(p);
        },
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
