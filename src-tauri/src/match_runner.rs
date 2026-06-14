//! Headless engine-vs-engine match runner.
//!
//! This subsystem plays a single full game between two UCI engines to a
//! definitive result, using `shakmaty` for rules and termination detection.
//! It is completely independent from the interactive single-engine manager in
//! `uci.rs` — it spawns its own short-lived engine processes and drives them
//! synchronously, one move at a time.

use std::collections::HashMap;
use std::time::Duration;

use serde::Serialize;
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
