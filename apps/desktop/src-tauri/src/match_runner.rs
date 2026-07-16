//! Headless engine-vs-engine match runner.
//!
//! This subsystem plays a single full game between two UCI engines to a
//! definitive result, using `shakmaty` for rules and termination detection.
//! It is completely independent from the interactive single-engine manager in
//! `uci.rs` — it spawns its own short-lived engine processes and drives them
//! synchronously, one move at a time.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use shakmaty::fen::Fen;
use shakmaty::uci::UciMove;
use shakmaty::zobrist::Zobrist64;
use shakmaty::{CastlingMode, Chess, Color, EnPassantMode, Position};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin};
use tokio::sync::Semaphore;
use tokio::time::timeout;

use crate::maia::MaiaProcess;
use crate::persona::{self, PersonaDecision};

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

// ---- Tablebase surfacing (spec 900 backlog: analysis-panel WDL/DTZ) ----
//
// The adjudication path above only needs a win/draw/loss verdict; the
// analysis panel wants the raw category plus DTZ/DTM and the ranked move
// list, so this richer probe keeps its own FEN-keyed cache while reusing the
// shared HTTP client and rate-limit semaphore. It also seeds the verdict
// cache, so an analysis lookup doubles as a warm adjudication entry.

/// Positions with more men than this are not in the Lichess tablebase.
pub const TABLEBASE_MAX_MEN: usize = 7;

/// Count the men on the board from a FEN's piece-placement field.
fn fen_men_count(fen: &str) -> usize {
    fen.split_whitespace()
        .next()
        .map(|board| board.chars().filter(|c| c.is_ascii_alphabetic()).count())
        .unwrap_or(0)
}

/// One ranked move from the tablebase response (best first, as Lichess
/// sorts them). The API is one ply deep — there is no full PV to surface.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TbMoveInfo {
    pub uci: String,
    pub san: String,
    /// Outcome category AFTER the move, from the opponent's perspective
    /// (Lichess convention): "loss" here means this move wins for us.
    pub category: String,
    pub dtz: Option<i64>,
}

/// Rich tablebase result for the analysis panel.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TbProbe {
    /// Outcome from the side-to-move's perspective ("win", "loss", "draw",
    /// "cursed-win", "blessed-loss", ...).
    pub category: String,
    pub dtz: Option<i64>,
    pub dtm: Option<i64>,
    pub moves: Vec<TbMoveInfo>,
}

/// FEN-keyed cache of rich probes, mirroring [`TB_CACHE`] for verdicts.
static TB_PROBE_CACHE: OnceLock<Mutex<HashMap<String, TbProbe>>> = OnceLock::new();

fn tb_probe_cache() -> &'static Mutex<HashMap<String, TbProbe>> {
    TB_PROBE_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

// Spec 219: a tablebase lookup IS engine-class assistance — it hands the
// user a perfect evaluation and best move. For a flagged active chess.com
// daily game it must be structurally OFF, exactly like the UCI engine, so
// this command mirrors uci.rs's defensive context refusal (layer 2; the
// frontend gate in use-tablebase.ts is layer 1).
const TABLEBASE_LOCKED_ERROR: &str = "Tablebase refused: this game is flagged as an active chess.com daily game (fair play lockout, spec 219)";

/// Probe the Lichess tablebase for the analysis panel (spec 900 backlog).
///
/// `Ok(None)` when the position has more than [`TABLEBASE_MAX_MEN`] men or
/// the lookup fails (offline, non-200, parse error) — the panel just shows
/// nothing. `Err` only for the spec 219 lockout refusal.
#[tauri::command]
pub async fn tablebase_probe(fen: String, context: Option<String>) -> Result<Option<TbProbe>, String> {
    if crate::uci::context_is_locked(context.as_deref()) {
        return Err(TABLEBASE_LOCKED_ERROR.to_string());
    }
    if fen_men_count(&fen) > TABLEBASE_MAX_MEN {
        return Ok(None);
    }

    if let Ok(cache) = tb_probe_cache().lock() {
        if let Some(p) = cache.get(&fen) {
            return Ok(Some(p.clone()));
        }
    }

    // Same politeness budget as adjudication probes — they share the permit
    // pool, so a running tournament and the panel can't stack requests.
    let _permit = match tb_sem().acquire().await {
        Ok(p) => p,
        Err(_) => return Ok(None),
    };

    let resp = match tb_client()
        .get("https://tablebase.lichess.ovh/standard")
        .query(&[("fen", fen.as_str())])
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r,
        _ => return Ok(None),
    };
    let json: serde_json::Value = match resp.json().await {
        Ok(j) => j,
        Err(_) => return Ok(None),
    };

    let category = match json.get("category").and_then(|c| c.as_str()) {
        Some(c) => c.to_string(),
        None => return Ok(None),
    };
    let moves = json
        .get("moves")
        .and_then(|m| m.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    Some(TbMoveInfo {
                        uci: m.get("uci")?.as_str()?.to_string(),
                        san: m.get("san")?.as_str()?.to_string(),
                        category: m.get("category")?.as_str()?.to_string(),
                        dtz: m.get("dtz").and_then(|d| d.as_i64()),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let probe = TbProbe {
        category,
        dtz: json.get("dtz").and_then(|d| d.as_i64()),
        dtm: json.get("dtm").and_then(|d| d.as_i64()),
        moves,
    };

    if let Ok(mut cache) = tb_probe_cache().lock() {
        cache.insert(fen.clone(), probe.clone());
    }
    // Seed the adjudication cache too — the verdict is already in hand.
    if let Ok(mut cache) = tb_cache().lock() {
        cache.insert(fen, category_to_verdict(&probe.category));
    }

    Ok(Some(probe))
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
    /// Both sides' remaining clocks (white_ms, black_ms) AFTER each move —
    /// `clocks_ms[i]` pairs with `moves[i]` (post-deduction + increment, the
    /// same values [`MoveEvent`] streams live). Spec 212 tier-1 gap: the swing
    /// labeler needs per-move clocks from a persisted outcome, not just the
    /// live stream. Additive: omitted from JSON when empty (same pattern as
    /// `GameOutcome::persona_logs`), so existing consumers are unaffected.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub clocks_ms: Vec<(i64, i64)>,
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
        let mut child = crate::engine_path::engine_command(path)
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

    /// Set one UCI option and re-sync (`isready` -> `readyok`) so the engine
    /// has applied it before the next command. Engines ignore unknown option
    /// names per the UCI protocol, so this is safe against engines that don't
    /// expose the option (they still answer `readyok`).
    async fn set_option(&mut self, name: &str, value: &str) -> Result<(), String> {
        self.send(&format!("setoption name {} value {}", name, value))
            .await?;
        self.send("isready").await?;
        self.read_until(Duration::from_secs(10), |l| l == "readyok")
            .await?;
        Ok(())
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
    ) -> Result<(Option<i64>, Option<i64>, Option<String>), String> {
        self.eval_with(fen, &format!("go movetime {}", movetime_ms), read_wait)
            .await
    }

    /// Evaluate a position (given by FEN) under an arbitrary `go ...` command,
    /// returning the last-seen score converted to White's POV. Shared core of
    /// [`Self::eval_at`] (movetime, the live neutral evaluator) and the
    /// fixed-depth eval-tagging pass (spec 210 Phase 3), which wants
    /// machine-independent tags rather than a wall-clock budget.
    async fn eval_with(
        &mut self,
        fen: &str,
        go_cmd: &str,
        read_wait: Duration,
    ) -> Result<(Option<i64>, Option<i64>, Option<String>), String> {
        self.send(&format!("position fen {}", fen)).await?;
        let mut cp: Option<i64> = None;
        let mut mate: Option<i64> = None;
        // First move of the PV that accompanied the most recent score — the
        // evaluator's best move in this position (spec 212 "best-move gap if
        // the evaluator reported a PV"). No POV flip: it is a move, not a score.
        let mut best: Option<String> = None;
        self.send(go_cmd).await?;
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
                    if let Some(mv) = parse_info_pv_first(line) {
                        best = Some(mv);
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
        Ok((cp, mate, best))
    }

    async fn quit(mut self) {
        let _ = self.send("quit").await;
        // Give it a brief moment to exit cleanly; kill_on_drop handles the rest.
        let _ = timeout(Duration::from_millis(500), self.child.wait()).await;
        let _ = self.child.start_kill();
    }
}

// ============================================================================
// Persona participants (spec 218 "the persona arm" + spec 214 move contract)
// ============================================================================
//
// A match participant is either a bare UCI binary (argmax `bestmove`, byte-for-
// byte the historical runner) or a PERSONA: lc0+policy sampling with a Stockfish
// verification reweight, per spec 214's move-selection contract. The seam is a
// `Player` enum at the single per-move call site in the game loop. A UCI player
// owns an `EngineHandle`; a persona player owns its own warm lc0 process (a
// `MaiaProcess`, one per game, mirroring how each game owns its engine handles)
// plus a resolved Stockfish path for the verification arm. The persona's move
// selection reuses `persona::select_move_from_policy` — the SAME contract the
// spar `persona_move` command runs — so the two surfaces can never diverge.

/// A persona participant resolved to runnable form: absolute paths located and
/// weights ensured by the command layer, so the pure runner core stays free of
/// Tauri/app-data dependencies. Sampling parameters are spec 214 contract knobs.
#[derive(Clone, Debug)]
pub struct PersonaRuntime {
    /// lc0 binary that serves the policy head.
    pub lc0_path: PathBuf,
    /// Weights file (a Maia band net or a managed strong net, e.g. BT3).
    pub weights_path: PathBuf,
    /// Stockfish for the verification reweight; `None` = pure tempered policy.
    pub stockfish_path: Option<PathBuf>,
    /// Label for the returned policies / decision log (Maia band or GM ceiling).
    pub band: u32,
    pub alpha: f64,
    pub lambda: f64,
    pub temperature: f64,
    pub top_k: Option<usize>,
    pub top_p: Option<f64>,
    pub verify_depth: Option<u32>,
    /// Per-game RNG seed (contract step 8): same seed + same snapshot = same game.
    pub seed: u64,
    /// Temperature schedule (contract step 3): phase × clock. The runner IS
    /// clocked, so the clock dimension is live here (the mover's remaining
    /// clock feeds it each move).
    pub schedule: Option<persona::TemperatureSchedule>,
    /// Post-book style-bias window (contract step 3). The runner plays with no
    /// book today, so book-exit ply is unknown and the window never fires —
    /// plumbed now so arena books (spec 217) slot in without redesign.
    pub style_bias: Option<persona::StyleBias>,
    /// Endgame arm (contract step 6): deep fixed-depth SF top-k at low material.
    pub endgame: Option<persona::EndgameArm>,
    /// Corpus error model (contract step 5). None = OFF — only a config the
    /// tuner enabled (held-out +2% bar, spec 214) ever carries one.
    pub error_model: Option<persona::ErrorModel>,
}

/// A persona player: a warm lc0 process bound to the persona's net, driven once
/// per move through the spec 214 selection contract.
struct PersonaPlayer {
    proc: MaiaProcess,
    stockfish: Option<PathBuf>,
    alpha: f64,
    lambda: f64,
    temperature: f64,
    top_k: Option<usize>,
    top_p: Option<f64>,
    verify_depth: Option<u32>,
    seed: u64,
    schedule: Option<persona::TemperatureSchedule>,
    style_bias: Option<persona::StyleBias>,
    endgame: Option<persona::EndgameArm>,
    error_model: Option<persona::ErrorModel>,
}

impl PersonaPlayer {
    async fn spawn(rt: &PersonaRuntime) -> Result<Self, String> {
        let proc = MaiaProcess::spawn(&rt.lc0_path, &rt.weights_path, rt.band).await?;
        Ok(Self {
            proc,
            stockfish: rt.stockfish_path.clone(),
            alpha: rt.alpha,
            lambda: rt.lambda,
            temperature: rt.temperature,
            top_k: rt.top_k,
            top_p: rt.top_p,
            verify_depth: rt.verify_depth,
            seed: rt.seed,
            schedule: rt.schedule.clone(),
            style_bias: rt.style_bias.clone(),
            endgame: rt.endgame.clone(),
            error_model: rt.error_model.clone(),
        })
    }

    /// Select the persona's move for `fen` (contract steps 3+4+6+8+9),
    /// returning the UCI move, the wall time it took (debited to the persona's
    /// clock like an engine's search), and the full per-move decision log.
    /// `own_clock_ms` is the persona's remaining clock — the runner is clocked,
    /// so the temperature schedule's clock dimension is live here.
    async fn bestmove(
        &self,
        fen: &str,
        ply: u32,
        own_clock_ms: i64,
    ) -> Result<(String, i64, PersonaDecision), String> {
        let t0 = tokio::time::Instant::now();
        let policy = self.proc.query(fen).await?;
        let derived = persona::derive_seed(self.seed, ply);
        let ctx = persona::SelectContext {
            ply,
            clock_ms: Some(own_clock_ms),
            // The runner has no book phase today: book-exit ply is unknown, so
            // the style-bias window stays inert (spec 214 honest default).
            plies_since_book_exit: None,
            schedule: self.schedule.clone(),
            style_bias: self.style_bias.clone(),
            endgame: self.endgame.clone(),
            error_model: self.error_model.clone(),
        };
        let decision = persona::select_move_from_policy(
            fen,
            &policy,
            self.alpha,
            self.lambda,
            self.temperature,
            self.top_k,
            self.top_p,
            self.verify_depth,
            derived,
            self.stockfish.as_deref(),
            &ctx,
        )
        .await?;
        let elapsed = t0.elapsed().as_millis() as i64;
        Ok((decision.uci.clone(), elapsed, decision))
    }
}

/// One side of a game: a UCI engine or a persona. The per-move call site
/// dispatches on this; the UCI arm is the unchanged historical behavior.
enum Player {
    Uci(EngineHandle),
    Persona(Box<PersonaPlayer>),
}

impl Player {
    fn is_persona(&self) -> bool {
        matches!(self, Player::Persona(_))
    }

    /// Ask this player for its move. `position_cmd` drives a UCI engine (its
    /// exact historical input); `fen` + `ply` + `own_clock_ms` (the mover's
    /// remaining clock, feeding the temperature schedule's clock dimension)
    /// drive a persona. Returns the UCI move, the elapsed wall time, and — for
    /// personas — the decision log.
    #[allow(clippy::too_many_arguments)]
    async fn bestmove(
        &mut self,
        position_cmd: &str,
        fen: &str,
        wtime_ms: i64,
        btime_ms: i64,
        winc_ms: u64,
        binc_ms: u64,
        read_wait: Duration,
        ply: u32,
        own_clock_ms: i64,
    ) -> Result<(String, i64, Option<PersonaDecision>), String> {
        match self {
            Player::Uci(h) => {
                let (mv, elapsed) = h
                    .bestmove(position_cmd, wtime_ms, btime_ms, winc_ms, binc_ms, read_wait)
                    .await?;
                Ok((mv, elapsed, None))
            }
            Player::Persona(p) => {
                let (mv, elapsed, decision) = p.bestmove(fen, ply, own_clock_ms).await?;
                Ok((mv, elapsed, Some(decision)))
            }
        }
    }

    async fn quit(self) {
        match self {
            Player::Uci(h) => h.quit().await,
            // The persona's lc0 process is killed on drop (kill_on_drop); its
            // per-move Stockfish verifier is already gone (spawned+dropped per move).
            Player::Persona(_) => {}
        }
    }
}

/// How to build a [`Player`] for one side, before the (post-FEN-validation)
/// spawn. Borrows so the runner core needs no owned/resolved copies.
/// `threads` (spec 210 Phase 6 "engine thread count per game") is applied via
/// `setoption name Threads` right after the UCI handshake; `None` leaves the
/// engine at its own default (the byte-for-byte historical behavior).
pub(crate) enum PlayerSpec<'a> {
    Uci {
        path: &'a str,
        threads: Option<u32>,
    },
    Persona(&'a PersonaRuntime),
}

impl<'a> PlayerSpec<'a> {
    /// Spawn the player, applying the UCI handshake for engines. `side`
    /// ("White"/"Black") only labels a UCI init failure, preserving the exact
    /// historical error strings.
    async fn spawn(self, side: &str) -> Result<Player, String> {
        match self {
            PlayerSpec::Uci { path, threads } => {
                let mut h = EngineHandle::spawn(path).await?;
                h.init()
                    .await
                    .map_err(|e| format!("{side} engine init failed: {}", e))?;
                // Per-game thread count. Only sent when configured (>= 1), so
                // the no-threads path is unchanged; unknown-option engines
                // ignore the name and still ack the isready sync.
                if let Some(t) = threads.filter(|t| *t >= 1) {
                    h.set_option("Threads", &t.to_string())
                        .await
                        .map_err(|e| format!("{side} engine init failed: {}", e))?;
                }
                Ok(Player::Uci(h))
            }
            PlayerSpec::Persona(rt) => Ok(Player::Persona(Box::new(PersonaPlayer::spawn(rt).await?))),
        }
    }
}

/// A persona participant's per-move decision log entry, attached to the game's
/// [`GameOutcome`]. Additive: absent (empty) for pure-UCI games.
#[derive(Serialize, Debug, Clone)]
pub struct PersonaLogEntry {
    /// 1-based half-move index (matches [`MoveEvent::ply`]).
    pub ply: usize,
    /// Side that moved: "white" | "black".
    pub color: String,
    /// The full spec 214 decision record (candidates, evals, chosen move, arm).
    pub decision: PersonaDecision,
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
    /// The evaluator's best move (first PV move, UCI) in this position, when
    /// its info stream reported one (spec 212 "best-move gap" plumbing).
    /// Additive: omitted from JSON when absent, so existing consumers and
    /// previously-serialized runs are unaffected.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub best: Option<String>,
}

/// A neutral-evaluator score streamed live as a game plays, tagged with its
/// game id so a concurrent batch can route it to the right game. White-POV.
#[derive(Serialize, Debug, Clone)]
pub struct EvalEvent {
    pub game_id: usize,
    pub ply: usize,
    pub cp: Option<i64>,
    pub mate: Option<i64>,
    /// The evaluator's best move (first PV move, UCI), when reported. Mirrors
    /// [`PlyEval::best`]; omitted from JSON when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub best: Option<String>,
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

/// First move of the `pv` in a UCI `info` line (the engine's best move for the
/// searched position), or `None` when the line carries no PV.
fn parse_info_pv_first(line: &str) -> Option<String> {
    let mut it = line.split_whitespace();
    while let Some(tok) = it.next() {
        if tok == "pv" {
            return it.next().map(|s| s.to_string());
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
///
/// Thin wrapper over [`play_game_streamed_impl`] with two UCI participants; its
/// public signature and behavior are unchanged (persona logs, always empty here,
/// are dropped).
#[allow(clippy::too_many_arguments)]
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
    play_game_streamed_impl(
        PlayerSpec::Uci { path: white_path, threads: None },
        PlayerSpec::Uci { path: black_path, threads: None },
        start_fen,
        white_base_ms,
        white_inc_ms,
        black_base_ms,
        black_inc_ms,
        max_plies,
        adjudicate_tb,
        game_id,
        on_move,
        cancel,
        paused,
        move_delay_ms,
    )
    .await
    .map(|(result, _logs)| result)
}

/// Play one full headless game between two [`PlayerSpec`]s (UCI engine or
/// persona), streaming each move via `on_move`. Returns the [`GameResult`] plus
/// any persona per-move decision logs (empty for pure-UCI games). This is the
/// shared game loop; [`play_game_streamed`] is the UCI-only wrapper over it.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn play_game_streamed_impl(
    white_spec: PlayerSpec<'_>,
    black_spec: PlayerSpec<'_>,
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
) -> Result<(GameResult, Vec<PersonaLogEntry>), String> {
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

    // Spawn and initialize both players (UCI handshake for engines) — AFTER the
    // FEN is validated above, so an illegal start position errors without ever
    // spawning a process (preserving the historical no-spawn-on-bad-FEN behavior).
    let mut white = white_spec.spawn("White").await?;
    let mut black = black_spec.spawn("Black").await?;

    // Persona per-move decision logs (spec 214 contract step 9); attached to the
    // game's outcome. Stays empty for pure-UCI games.
    let mut persona_logs: Vec<PersonaLogEntry> = Vec::new();

    let mut moves: Vec<String> = Vec::new();

    // Per-move clocks (white_ms, black_ms) after each move, paired with
    // `moves` by index (spec 212 tier-1 clock persistence). Mutex (not RefCell)
    // so the game future stays Send for tokio::spawn — the `finish` closure
    // below (which only borrows) drains it while the game loop keeps pushing
    // between calls; no lock is ever held across an await.
    let clocks_ms: std::sync::Mutex<Vec<(i64, i64)>> = std::sync::Mutex::new(Vec::new());

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

    let finish = |white: Player,
                  black: Player,
                  result: &str,
                  termination: &str,
                  moves: Vec<String>|
     -> GameResult {
        // Players are dropped (engines/lc0 processes are kill_on_drop) when the
        // closure returns; we spawn detached quit tasks so they exit cleanly
        // without blocking.
        tokio::spawn(async move { white.quit().await });
        tokio::spawn(async move { black.quit().await });
        GameResult {
            result: result.to_string(),
            termination: termination.to_string(),
            plies: moves.len(),
            start_fen: start_fen_str.clone(),
            // Truncate to the moves actually recorded (they are pushed in
            // lockstep, so this is a no-op guard) and drain.
            clocks_ms: {
                let mut c = std::mem::take(&mut *clocks_ms.lock().unwrap());
                c.truncate(moves.len());
                c
            },
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
            return Ok((finish(white, black, result, "tablebase", moves), std::mem::take(&mut persona_logs)));
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
            return Ok((finish(white, black, "1/2-1/2", "max_plies", moves), std::mem::take(&mut persona_logs)));
        }

        let mover = pos.turn();

        let position_cmd = position_command(&start_fen_str, is_standard_start, &moves);

        // A persona reads the current position by FEN (not the UCI move list); a
        // UCI engine ignores it. Compute it only when the mover is a persona so
        // the UCI hot path is byte-for-byte unchanged.
        let mover_is_persona = match mover {
            Color::White => white.is_persona(),
            Color::Black => black.is_persona(),
        };
        let cur_fen = if mover_is_persona {
            Fen::from_position(&pos, EnPassantMode::Legal).to_string()
        } else {
            String::new()
        };
        // 0-based half-move index for the persona's seeded RNG (contract step 8).
        let ply_idx = moves.len() as u32;

        // Ask the moving player for its move.
        let player = match mover {
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

        let (bestmove, elapsed, decision) = match player
            .bestmove(
                &position_cmd,
                &cur_fen,
                wtime,
                btime,
                white_inc_ms,
                black_inc_ms,
                read_wait,
                ply_idx,
                // The mover's own remaining clock: the persona's temperature
                // schedule conditions on it (contract step 3, clock dimension).
                remaining,
            )
            .await
        {
            Ok(m) => m,
            Err(e) => {
                // Treat a comms failure as a loss for the side to move.
                let result = loss_for(mover);
                let term = format!("engine_error: {}", e);
                return Ok((finish(white, black, result, &term, moves), std::mem::take(&mut persona_logs)));
            }
        };

        // Record the persona's per-move decision log (contract step 9). `ply` is
        // 1-based to match `MoveEvent::ply` (the move about to be applied).
        if let Some(decision) = decision {
            persona_logs.push(PersonaLogEntry {
                ply: moves.len() + 1,
                color: match mover {
                    Color::White => "white",
                    Color::Black => "black",
                }
                .to_string(),
                decision,
            });
        }

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
            return Ok((finish(white, black, result, "time_forfeit", moves), std::mem::take(&mut persona_logs)));
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
            return Ok((finish(white, black, result, term, moves), std::mem::take(&mut persona_logs)));
        }

        // Parse + validate the move against the current position.
        let uci = match UciMove::from_ascii(bestmove.as_bytes()) {
            Ok(u) => u,
            Err(_) => {
                let result = loss_for(mover);
                return Ok((finish(white, black, result, "illegal_move", moves), std::mem::take(&mut persona_logs)));
            }
        };
        let legal_move = match uci.to_move(&pos) {
            Ok(m) => m,
            Err(_) => {
                let result = loss_for(mover);
                return Ok((finish(white, black, result, "illegal_move", moves), std::mem::take(&mut persona_logs)));
            }
        };

        // Apply the move.
        pos = match pos.play(legal_move) {
            Ok(p) => p,
            Err(_) => {
                let result = loss_for(mover);
                return Ok((finish(white, black, result, "illegal_move", moves), std::mem::take(&mut persona_logs)));
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

        // Record the post-move clocks (same values the MoveEvent carries) so a
        // completed GameResult keeps them (spec 212 tier-1 clock persistence).
        clocks_ms.lock().unwrap().push((wtime, btime));

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
            return Ok((finish(white, black, result, "checkmate", moves), std::mem::take(&mut persona_logs)));
        }
        if pos.is_stalemate() {
            return Ok((finish(white, black, "1/2-1/2", "stalemate", moves), std::mem::take(&mut persona_logs)));
        }
        if pos.is_insufficient_material() {
            return Ok((finish(white, black, "1/2-1/2", "insufficient_material", moves), std::mem::take(&mut persona_logs)));
        }
        // 50-move rule: halfmove clock >= 100.
        if pos.halfmoves() >= 100 {
            return Ok((finish(white, black, "1/2-1/2", "fifty_move", moves), std::mem::take(&mut persona_logs)));
        }
        // Threefold repetition (tracked by us).
        let key = pos.zobrist_hash::<Zobrist64>(EnPassantMode::Legal).0;
        let count = rep_counts.entry(key).or_insert(0);
        *count += 1;
        if *count >= 3 {
            return Ok((finish(white, black, "1/2-1/2", "threefold", moves), std::mem::take(&mut persona_logs)));
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
                return Ok((finish(white, black, result, "tablebase", moves), std::mem::take(&mut persona_logs)));
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

/// Whether a [`Participant`] is a UCI binary or a persona (spec 218).
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ParticipantKind {
    Uci,
    Persona,
}

/// The runtime object a surface spawns to field an opponent (spec 218 "The
/// Participant"): one roster entry, engine or persona. This is the wire shape the
/// tournament/exhibition UI sends; the exact (camelCase) field names are the
/// contract the frontend consumes — `{ id, displayName, kind, enginePath?,
/// personaConfig? }`.
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Participant {
    /// Stable roster id (echoed in labels/logs).
    pub id: String,
    /// Human-facing name shown in the picker/standings.
    pub display_name: String,
    pub kind: ParticipantKind,
    /// Engine binary path — required when `kind == uci`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine_path: Option<String>,
    /// Persona configuration — required when `kind == persona`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub persona_config: Option<PersonaConfig>,
}

/// A persona participant's move-selection config (spec 214 Tier 2). Mirrors the
/// spar `persona_move` params plus a policy-backend selector (`weights`): the
/// Maia band `level` by default, or a named managed strong net (e.g. "bt3") for
/// GM personas. camelCase field names are the frontend contract.
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PersonaConfig {
    /// Maia band selector, and the decision-log strength label.
    pub level: u32,
    pub temperature: f64,
    pub alpha: f64,
    pub lambda: f64,
    #[serde(default)]
    pub top_k: Option<usize>,
    #[serde(default)]
    pub top_p: Option<f64>,
    #[serde(default)]
    pub verify_depth: Option<u32>,
    /// Named managed net overriding the Maia band policy backend (e.g. "bt3").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weights: Option<String>,
    /// Per-persona base RNG seed (contract step 8); mixed with the game id so
    /// each game in a batch is distinct yet reproducible. Defaults to 0.
    #[serde(default)]
    pub seed: Option<u64>,
    /// Temperature schedule (contract step 3). Absent = the untuned default
    /// schedule — phase × clock scaling ships ON for runner personas. Nested
    /// fields are snake_case on the wire (they mirror the spar `persona_move`
    /// params, which are snake_case throughout).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule: Option<persona::TemperatureSchedule>,
    /// Post-book style-bias window (contract step 3). Absent = OFF — the spec
    /// 214 hard rule keeps it off until measured. (Inert in the runner anyway:
    /// no book, so book-exit ply is unknown.)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style_bias: Option<persona::StyleBias>,
    /// Endgame arm (contract step 6). Absent = the default arm, ON (degrades
    /// to the policy arm when Stockfish is missing).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endgame: Option<persona::EndgameArm>,
    /// Corpus error model (contract step 5). Absent = OFF — the spec 214
    /// hard rule keeps mistake timing off until tune_persona.py's held-out
    /// +2% bar enables it for a persona (fit: fit_error_model.py).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_model: Option<persona::ErrorModel>,
}

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
    /// Per-game UCI `Threads` for BOTH players (spec 210 Phase 6 "engine
    /// thread count per game"), applied via `setoption name Threads` after
    /// each engine's handshake. `None` (the default, and every pre-existing
    /// payload) leaves the engines at their own defaults. Personas ignore it
    /// (lc0's backend threading is its own concern).
    #[serde(default)]
    pub threads: Option<u32>,
    /// Optional participant for White (spec 218). When present it supersedes
    /// `white_path`: the command layer normalizes a UCI participant's
    /// `engine_path` into `white_path` and resolves a persona participant into
    /// `white_runtime`. Absent = the legacy `white_path` UCI behavior.
    #[serde(default)]
    pub white: Option<Participant>,
    #[serde(default)]
    pub black: Option<Participant>,
    /// Resolved persona runtimes, filled by the command layer from `white`/`black`
    /// persona participants. Never serialized (the frontend sends participants,
    /// not resolved paths); the pure runner core reads these to spawn the arm.
    #[serde(skip)]
    pub white_runtime: Option<PersonaRuntime>,
    #[serde(skip)]
    pub black_runtime: Option<PersonaRuntime>,
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
    /// Per-move persona decision logs (spec 214 contract step 9), one per persona
    /// move in this game. Additive: omitted from the JSON for pure-UCI games, so
    /// existing consumers are unaffected.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub persona_logs: Vec<PersonaLogEntry>,
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
                        if let Ok((cp, mate, best)) =
                            engine.eval_at(&fen, setup.movetime_ms, read_wait).await
                        {
                            on_eval(EvalEvent { game_id, ply, cp, mate, best: best.clone() });
                            evals.push(PlyEval { ply, cp, mate, best });
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
            // A resolved persona runtime supersedes the UCI path for its side; a
            // pure-UCI game reads the (byte-for-byte) legacy `*_path` fields.
            let white_spec = match &spec.white_runtime {
                Some(rt) => PlayerSpec::Persona(rt),
                None => PlayerSpec::Uci { path: &spec.white_path, threads: spec.threads },
            };
            let black_spec = match &spec.black_runtime {
                Some(rt) => PlayerSpec::Persona(rt),
                None => PlayerSpec::Uci { path: &spec.black_path, threads: spec.threads },
            };
            let (result, persona_logs) = match play_game_streamed_impl(
                white_spec,
                black_spec,
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
            .await
            {
                Ok((r, logs)) => (Ok(r), logs),
                Err(e) => (Err(e), Vec::new()),
            };

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
                persona_logs,
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
        for (runtime, path) in [
            (&spec.white_runtime, spec.white_path.as_str()),
            (&spec.black_runtime, spec.black_path.as_str()),
        ] {
            // A persona side has no engine binary to pre-flight (it drives lc0,
            // already resolved). An empty path is a persona-only spec's other
            // field or an intentionally unset side — skip it too.
            if runtime.is_some() || path.is_empty() {
                continue;
            }
            if !seen.insert(path) {
                continue;
            }
            check_engine_path(path)?;
        }
    }
    Ok(())
}

/// Resolve every game spec's participants (spec 218) before play: a UCI
/// participant's `enginePath` is normalized into the side's `*_path`; a persona
/// participant is resolved into a runnable [`PersonaRuntime`] (lc0 located,
/// weights ensured — possibly a 190MB download — Stockfish located for the
/// verification arm). Runs once up front so a bad config or missing net fails the
/// whole batch fast rather than silently per game. Weight files are ensured once
/// per distinct (band, net) and reused across games.
async fn resolve_participants(
    app: &tauri::AppHandle,
    specs: &mut [GameSpec],
) -> Result<(), String> {
    let lc0 = crate::maia::resolve_lc0();
    let stockfish = persona::resolve_stockfish();
    let mut weight_cache: HashMap<String, PathBuf> = HashMap::new();

    for spec in specs.iter_mut() {
        let game_id = spec.id;
        if let Some(p) = spec.white.take() {
            match resolve_one(app, p, game_id, &lc0, &stockfish, &mut weight_cache).await? {
                ResolvedSide::Uci(path) => spec.white_path = path,
                ResolvedSide::Persona(rt) => spec.white_runtime = Some(rt),
            }
        }
        if let Some(p) = spec.black.take() {
            match resolve_one(app, p, game_id, &lc0, &stockfish, &mut weight_cache).await? {
                ResolvedSide::Uci(path) => spec.black_path = path,
                ResolvedSide::Persona(rt) => spec.black_runtime = Some(rt),
            }
        }
    }
    Ok(())
}

/// One resolved side: either a normalized UCI binary path or a persona runtime.
enum ResolvedSide {
    Uci(String),
    Persona(PersonaRuntime),
}

/// Resolve a single [`Participant`] into a runnable side.
async fn resolve_one(
    app: &tauri::AppHandle,
    p: Participant,
    game_id: usize,
    lc0: &Option<PathBuf>,
    stockfish: &Option<PathBuf>,
    weight_cache: &mut HashMap<String, PathBuf>,
) -> Result<ResolvedSide, String> {
    match p.kind {
        ParticipantKind::Uci => {
            let path = p
                .engine_path
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| format!("participant '{}' is kind=uci but has no enginePath", p.id))?;
            Ok(ResolvedSide::Uci(path))
        }
        ParticipantKind::Persona => {
            let cfg = p.persona_config.ok_or_else(|| {
                format!("participant '{}' is kind=persona but has no personaConfig", p.id)
            })?;
            let lc0_path = lc0.clone().ok_or(
                "lc0 not found — install it with: brew install lc0 (required for persona participants)",
            )?;
            let key = format!("{}|{}", cfg.level, cfg.weights.as_deref().unwrap_or(""));
            let weights_path = match weight_cache.get(&key) {
                Some(w) => w.clone(),
                None => {
                    let w = crate::maia::resolve_persona_weights(app, cfg.level, cfg.weights.as_deref())
                        .await?;
                    weight_cache.insert(key, w.clone());
                    w
                }
            };
            // Per-game seed (contract step 8): mix the persona base seed with the
            // game id so each game in the batch is distinct yet reproducible.
            let seed = persona::derive_seed(cfg.seed.unwrap_or(0), game_id as u32);
            Ok(ResolvedSide::Persona(PersonaRuntime {
                lc0_path,
                weights_path,
                stockfish_path: stockfish.clone(),
                band: cfg.level,
                alpha: cfg.alpha,
                lambda: cfg.lambda,
                temperature: cfg.temperature,
                top_k: cfg.top_k,
                top_p: cfg.top_p,
                verify_depth: cfg.verify_depth,
                seed,
                // Schedule + endgame arm default ON (untuned defaults, same as
                // the spar loop's DEFAULT_PERSONA_PARAMS); style bias only when
                // explicitly configured (spec 214 hard rule).
                schedule: Some(cfg.schedule.clone().unwrap_or_default()),
                style_bias: cfg.style_bias.clone(),
                endgame: Some(cfg.endgame.clone().unwrap_or_default()),
                // Error model only when explicitly configured — the tuner
                // gates it (spec 214); there is no default-ON variant.
                error_model: cfg.error_model.clone(),
            }))
        }
    }
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
    app: tauri::AppHandle,
    mut specs: Vec<GameSpec>,
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
    // Resolve roster participants (spec 218) first: normalize UCI participants to
    // their binary path and resolve persona participants to runnable runtimes
    // (lc0 + weights ensured). A bad persona config or missing net fails the whole
    // batch here, up front.
    resolve_participants(&app, &mut specs).await?;

    // Fail fast, once, if an engine binary is missing or non-executable —
    // otherwise every game spawn-fails identically and the UI shows only a
    // count. A bare command (PATH-resolved) is not checked here. Persona sides
    // (resolved above) carry no binary and are skipped.
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
    let mut child = crate::engine_path::engine_command(&path)
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

// ============================================================================
// Phase 6 — tournament result persistence (spec 210)
// ============================================================================
//
// Completed tournament results (the frontend's `RoundRobinResultExport` JSON,
// built in lib/tournament.ts) are saved under `<app_data_dir>/tournaments/`,
// one file per result — the same app-data JSON-artifact pattern
// calibration.rs uses for its sessions/results. The payload is stored as an
// opaque `serde_json::Value` so the on-disk schema is owned by the frontend
// (versioned there via `version`/`kind`); only the few fields the saved-
// results list renders are picked out here, with safe defaults.

/// Metadata for one saved tournament result file, for the saved-results list.
/// Field names are snake_case on the wire (no `rename_all`), mirrored by
/// lib/tournament.ts's `SavedTournamentMeta`.
#[derive(Serialize, Debug, Clone)]
pub struct SavedTournamentMeta {
    /// Bare file name (never a path) — the load key.
    pub file: String,
    pub name: String,
    pub completed_at: String,
    pub total_games: u64,
    pub kind: String,
}

/// Write `result` to `dir/tournament-<unix_ms>.json`, returning the file name.
/// Pure-ish core (no AppHandle) so the round-trip is unit-testable.
pub fn save_tournament_result_in(
    dir: &std::path::Path,
    result: &serde_json::Value,
) -> Result<String, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    // Millisecond names could collide under a same-ms double-save; bump until free.
    let mut name = format!("tournament-{ms}.json");
    let mut bump = 0u32;
    while dir.join(&name).exists() {
        bump += 1;
        name = format!("tournament-{ms}-{bump}.json");
    }
    let json = serde_json::to_string_pretty(result).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(&name), json).map_err(|e| e.to_string())?;
    Ok(name)
}

/// List saved results in `dir`, newest first (by file name, which embeds the
/// save timestamp). Unreadable/non-JSON files are skipped, not errors — one
/// corrupt file must not hide the rest.
pub fn list_tournament_results_in(
    dir: &std::path::Path,
) -> Result<Vec<SavedTournamentMeta>, String> {
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        // No directory yet = nothing saved yet.
        Err(_) => return Ok(out),
    };
    for entry in entries.flatten() {
        let file = entry.file_name().to_string_lossy().into_owned();
        if !file.ends_with(".json") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(entry.path()) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        let str_of = |key: &str| v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_string();
        out.push(SavedTournamentMeta {
            file,
            name: str_of("name"),
            completed_at: str_of("completedAt"),
            total_games: v.get("totalGames").and_then(|x| x.as_u64()).unwrap_or(0),
            kind: str_of("kind"),
        });
    }
    out.sort_by(|a, b| b.file.cmp(&a.file));
    Ok(out)
}

/// Read one saved result back. `file` must be a bare name from the listing —
/// separators/`..` are rejected so the command can't be steered outside the
/// tournaments directory.
pub fn load_tournament_result_in(
    dir: &std::path::Path,
    file: &str,
) -> Result<serde_json::Value, String> {
    if file.contains('/') || file.contains('\\') || file.contains("..") {
        return Err(format!("Invalid result file name: {file}"));
    }
    let path = dir.join(file);
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("Corrupt result file {file}: {e}"))
}

/// `<app_data_dir>/tournaments`, created if absent (same layout as
/// calibration.rs's `calibration_dir`).
fn tournaments_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("tournaments");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Tauri command: persist a completed tournament result. Returns the file name
/// (the key `load_tournament_result` takes).
#[tauri::command]
pub fn save_tournament_result(
    app: tauri::AppHandle,
    result: serde_json::Value,
) -> Result<String, String> {
    save_tournament_result_in(&tournaments_dir(&app)?, &result)
}

/// Tauri command: list saved tournament results, newest first.
#[tauri::command]
pub fn list_tournament_results(
    app: tauri::AppHandle,
) -> Result<Vec<SavedTournamentMeta>, String> {
    list_tournament_results_in(&tournaments_dir(&app)?)
}

/// Tauri command: load one saved tournament result by file name.
#[tauri::command]
pub fn load_tournament_result(
    app: tauri::AppHandle,
    file: String,
) -> Result<serde_json::Value, String> {
    load_tournament_result_in(&tournaments_dir(&app)?, &file)
}

/// Byte cap for `read_opening_positions`. The largest published UHO books are
/// a few MB of text; the cap only exists so a mispicked huge file (e.g. a
/// binary) can't flood the IPC channel.
const OPENING_FILE_MAX_BYTES: u64 = 32 * 1024 * 1024;

/// Read a user-picked EPD/FEN opening-positions file (spec 210 Phase 3:
/// "loaded from disk via file picker"). Returns the raw text — line parsing
/// lives client-side (`parseOpeningPositions`, packages/core/src/tournament.ts)
/// next to the seed sampling that consumes it. Pure core (no AppHandle) so the
/// cap and error paths are unit-testable, matching the persistence fns above.
pub fn read_opening_positions_in(path: &str, max_bytes: u64) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("Failed to read {path}: {e}"))?;
    if meta.len() > max_bytes {
        return Err(format!(
            "{path} is {} bytes — over the {max_bytes}-byte cap for a position file",
            meta.len()
        ));
    }
    std::fs::read_to_string(path).map_err(|e| format!("Failed to read {path}: {e}"))
}

/// Tauri command: read an EPD/FEN opening-positions file for the tournament tab.
#[tauri::command]
pub fn read_opening_positions(path: String) -> Result<String, String> {
    read_opening_positions_in(&path, OPENING_FILE_MAX_BYTES)
}

// ============================================================================
// Phase 3 — in-app eval-tagging of opening positions (spec 210)
// ============================================================================
//
// "Stockfish evaluates each candidate position (fixed depth, e.g. depth 12),
// stores (fen, eval_cp) in a session cache." One engine process evaluates the
// batch sequentially at a FIXED DEPTH — not movetime like the live neutral
// evaluator — so the tags are machine-independent (the point of tagging is a
// stable label, not keeping pace with a stream). The session cache itself is
// frontend-owned (keyed by FEN in the tournament tab), so re-tagging the same
// pool costs nothing; this side just evaluates whatever FENs it is handed.

/// One eval-tagged position: the engine's score converted to White's POV.
/// Exactly one of `cp`/`mate` is set (both `None` if no score was produced).
#[derive(Serialize, Debug, Clone)]
pub struct PositionTag {
    pub fen: String,
    pub cp: Option<i64>,
    pub mate: Option<i64>,
}

/// Progress event streamed once per tagged position.
#[derive(Serialize, Debug, Clone)]
pub struct TagProgress {
    pub completed: usize,
    pub total: usize,
}

/// Default tagging depth — spec 210 Phase 3's own example ("fixed depth, e.g.
/// depth 12"): deep enough for a stable opening eval, shallow enough that a
/// few hundred positions tag in well under a minute.
pub const DEFAULT_TAG_DEPTH: u32 = 12;

/// Generous per-position wait for the fixed-depth search. Depth 12 resolves in
/// well under a second on any machine that runs this app; the cap only exists
/// so a hung engine fails the pass instead of wedging it forever.
const TAG_READ_WAIT: Duration = Duration::from_secs(60);

/// Evaluate every FEN at a fixed depth with one engine process, streaming
/// per-position progress. Pure core (no Tauri) so it is unit-testable against
/// a real engine. Fails fast on the first engine error — the FENs are
/// syntax-validated client-side before they get here, so an error means the
/// engine itself is broken and every later eval would fail the same way.
pub async fn tag_positions_core(
    engine_path: &str,
    fens: &[String],
    depth: u32,
    on_progress: impl Fn(TagProgress),
) -> Result<Vec<PositionTag>, String> {
    let mut engine = EngineHandle::spawn(engine_path).await?;
    engine
        .init()
        .await
        .map_err(|e| format!("Tagging engine init failed: {}", e))?;
    let go_cmd = format!("go depth {}", depth.max(1));
    let mut tags = Vec::with_capacity(fens.len());
    for (i, fen) in fens.iter().enumerate() {
        let (cp, mate, _best) = engine
            .eval_with(fen, &go_cmd, TAG_READ_WAIT)
            .await
            .map_err(|e| format!("Eval-tagging failed at position {} ({}): {}", i + 1, fen, e))?;
        tags.push(PositionTag { fen: fen.clone(), cp, mate });
        on_progress(TagProgress { completed: i + 1, total: fens.len() });
    }
    engine.quit().await;
    Ok(tags)
}

/// Tauri command: eval-tag a batch of opening positions (spec 210 Phase 3
/// "Eval-tagging step") at a fixed depth, streaming progress per position.
#[tauri::command]
pub async fn tag_positions(
    engine_path: String,
    fens: Vec<String>,
    depth: Option<u32>,
    on_progress: tauri::ipc::Channel<TagProgress>,
) -> Result<Vec<PositionTag>, String> {
    // Same up-front pre-flight the batch players and evaluator get.
    check_engine_path(&engine_path)?;
    tag_positions_core(
        &engine_path,
        &fens,
        depth.unwrap_or(DEFAULT_TAG_DEPTH),
        move |p| {
            // Best-effort: a closed channel (window gone) must not abort the pass.
            let _ = on_progress.send(p);
        },
    )
    .await
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

    // Real-engine game, terminal RESULT value asserted (spec 210 Phase 1
    // tick-pass gap, 2026-07-15: the other real-engine tests here assert on
    // plies/eval/abort/pause, none on the actual `result` string). Seeded from
    // a hand-built mate-in-1 (White Ra1 -> Ra8#, king boxed in by its own
    // pawns) so the assertion is deterministic regardless of engine strength —
    // Stockfish (or any competent engine) always takes a proven mate over any
    // other move, so White wins by checkmate in exactly one ply. Skips
    // cleanly on a box without Stockfish, like its neighbors.
    #[tokio::test]
    async fn real_engine_game_terminal_result_is_checkmate() {
        let Some(sf) = find_stockfish() else {
            eprintln!("skipping real_engine_game_terminal_result_is_checkmate: no stockfish");
            return;
        };
        let mate_in_1_fen = "6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1";
        let specs = vec![spec(0, &sf, &sf, Some(mate_in_1_fen))];

        let outcomes = run_batch_core(
            specs,
            1,
            |_p| {},
            Arc::new(|_ev| {}),
            Arc::new(AtomicBool::new(false)),
        )
        .await;

        assert_eq!(outcomes.len(), 1);
        let g = outcomes[0]
            .result
            .as_ref()
            .unwrap_or_else(|e| panic!("expected a completed game, got error: {e}"));
        assert_eq!(g.result, "1-0", "White should win by delivering Ra8#");
        assert_eq!(g.termination, "checkmate");
        assert_eq!(g.plies, 1, "the mate is in exactly one ply");
        assert_eq!(g.moves, vec!["a1a8".to_string()]);
        // Per-move clocks persist in lockstep with moves (spec 212 tier-1).
        assert_eq!(g.clocks_ms.len(), 1, "one clock pair per move");
        assert!(g.clocks_ms[0].0 > 0 && g.clocks_ms[0].1 > 0);
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

    // ---- tablebase_probe gating (spec 900 surfacing + spec 219 lockout) ----

    #[test]
    fn fen_men_count_counts_pieces_only() {
        assert_eq!(fen_men_count(STANDARD_START_FEN), 32);
        assert_eq!(fen_men_count("4k3/8/8/8/8/8/8/4K2Q w - - 0 1"), 3);
        assert_eq!(fen_men_count(""), 0);
    }

    // Spec 219 layer 2: an active-game context is refused before any cache
    // or network access — same defensive stance as uci.rs.
    #[tokio::test]
    async fn tablebase_probe_refuses_active_game_context() {
        let err = tablebase_probe(
            "4k3/8/8/8/8/8/8/4K2Q w - - 0 1".to_string(),
            Some("active-game:https://chess.com/game/123".to_string()),
        )
        .await
        .expect_err("locked context must be refused");
        assert!(err.contains("fair play"), "got: {err}");
    }

    // >7 men is out of tablebase range: Ok(None) without touching the
    // network (the start position would 404 anyway, but we never ask).
    #[tokio::test]
    async fn tablebase_probe_skips_positions_over_seven_men() {
        let res = tablebase_probe(STANDARD_START_FEN.to_string(), None)
            .await
            .expect("no error for a big position");
        assert!(res.is_none());
    }

    // Unrestricted context tag passes the gate (the probe itself may then
    // fail offline, which is fine — it must not be a lockout refusal).
    #[tokio::test]
    async fn tablebase_probe_allows_unrestricted_context() {
        let res = tablebase_probe(
            "4k3/8/8/8/8/8/8/4K2Q w - - 0 1".to_string(),
            Some("unrestricted".to_string()),
        )
        .await;
        assert!(res.is_ok(), "unrestricted context must not be refused: {res:?}");
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
        // The evaluator's PV plumbing (spec 212 best-move gap): Stockfish
        // reports a pv on scored info lines, so best moves should be captured.
        assert!(
            o.evals.iter().any(|pe| pe.best.is_some()),
            "expected at least one evaluator best move to be captured"
        );
        // Per-move clocks persist alongside the moves.
        assert_eq!(g.clocks_ms.len(), g.plies, "one clock pair per move");
    }

    fn outcome(id: usize, result: Result<GameResult, String>, aborted: bool) -> GameOutcome {
        GameOutcome { id, flipped: false, result, evals: Vec::new(), aborted, persona_logs: Vec::new() }
    }

    fn win(res: &str) -> Result<GameResult, String> {
        Ok(GameResult {
            result: res.to_string(),
            termination: "checkmate".to_string(),
            plies: 10,
            start_fen: STANDARD_START_FEN.to_string(),
            moves: Vec::new(),
            clocks_ms: Vec::new(),
        })
    }

    #[test]
    fn parse_info_pv_first_reads_best_move() {
        assert_eq!(
            parse_info_pv_first("info depth 12 score cp -34 nodes 1000 pv e2e4 e7e5"),
            Some("e2e4".to_string())
        );
        // No pv token → None (e.g. a bare score or currmove line).
        assert_eq!(parse_info_pv_first("info depth 1 score cp 10"), None);
        assert_eq!(parse_info_pv_first("info depth 1 currmove e2e4"), None);
    }

    // GameResult JSON stays byte-compatible for old consumers: clocks_ms is
    // omitted when empty (same additive pattern as persona_logs) and present
    // as [w,b] pairs when recorded; PlyEval.best is omitted when None.
    #[test]
    fn additive_fields_skip_when_empty() {
        let bare = serde_json::to_string(&GameResult {
            result: "1-0".to_string(),
            termination: "checkmate".to_string(),
            plies: 0,
            start_fen: STANDARD_START_FEN.to_string(),
            moves: Vec::new(),
            clocks_ms: Vec::new(),
        })
        .unwrap();
        assert!(!bare.contains("clocks_ms"), "empty clocks_ms must be omitted: {bare}");

        let with = serde_json::to_string(&GameResult {
            result: "1-0".to_string(),
            termination: "checkmate".to_string(),
            plies: 1,
            start_fen: STANDARD_START_FEN.to_string(),
            moves: vec!["e2e4".to_string()],
            clocks_ms: vec![(59_500, 60_000)],
        })
        .unwrap();
        assert!(with.contains("\"clocks_ms\":[[59500,60000]]"), "got: {with}");

        let pe = serde_json::to_string(&PlyEval { ply: 0, cp: Some(20), mate: None, best: None }).unwrap();
        assert!(!pe.contains("best"), "absent best must be omitted: {pe}");
        // An old serialized PlyEval (no `best`) still deserializes.
        let old: PlyEval = serde_json::from_str("{\"ply\":3,\"cp\":-12,\"mate\":null}").unwrap();
        assert_eq!(old.ply, 3);
        assert_eq!(old.best, None);
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

    // ---- Persona participants (spec 218 persona arm) ----------------------

    // The exact camelCase wire shape the tournament/exhibition UI sends. This
    // locks the serde field names the frontend stream consumes — no engine needed.
    #[test]
    fn participant_wire_shape_matches_spec_218() {
        let persona = r#"{
            "id": "kasparov",
            "displayName": "Garry Kasparov",
            "kind": "persona",
            "personaConfig": {
                "level": 1900, "temperature": 0.5, "alpha": 1.0, "lambda": 0.75,
                "topK": 4, "verifyDepth": 12, "weights": "bt3", "seed": 214214
            }
        }"#;
        let p: Participant = serde_json::from_str(persona).expect("persona participant deserializes");
        assert_eq!(p.id, "kasparov");
        assert_eq!(p.display_name, "Garry Kasparov");
        assert_eq!(p.kind, ParticipantKind::Persona);
        let cfg = p.persona_config.expect("persona carries a config");
        assert_eq!(cfg.level, 1900);
        assert_eq!(cfg.top_k, Some(4));
        assert_eq!(cfg.verify_depth, Some(12));
        assert_eq!(cfg.weights.as_deref(), Some("bt3"));
        assert_eq!(cfg.seed, Some(214214));
        // Step 3/5/6 knobs are optional on the wire; absent = None (the resolver
        // then defaults schedule + endgame ON, style bias + error model OFF).
        assert!(cfg.schedule.is_none() && cfg.style_bias.is_none() && cfg.endgame.is_none());
        assert!(cfg.error_model.is_none());

        // And when present they deserialize (camelCase field names on the
        // config, snake_case inside the nested structs — the spar wire shape).
        let with_knobs = r#"{
            "id": "dad", "displayName": "Dad", "kind": "persona",
            "personaConfig": {
                "level": 1700, "temperature": 0.5, "alpha": 1.0, "lambda": 0.75,
                "schedule": {"opening_mult": 0.7, "panic_time_ms": 8000},
                "styleBias": {"window_plies": 4, "multiplier": 1.5, "move_types": ["capture"]},
                "endgame": {"depth": 14},
                "errorModel": {"cells": {"middlegame|+0.0|none": 0.05}, "rate_scale": 1.5}
            }
        }"#;
        let p: Participant = serde_json::from_str(with_knobs).expect("knobbed persona deserializes");
        let cfg = p.persona_config.unwrap();
        let sched = cfg.schedule.unwrap();
        assert_eq!(sched.opening_mult, 0.7);
        assert_eq!(sched.panic_time_ms, 8000);
        assert_eq!(sched.middlegame_mult, 1.0, "unset schedule fields keep defaults");
        assert_eq!(cfg.style_bias.unwrap().move_types, vec!["capture"]);
        let arm = cfg.endgame.unwrap();
        assert_eq!(arm.depth, 14);
        assert_eq!(arm.phase_max, persona::ENDGAME_PHASE_MAX);
        let em = cfg.error_model.unwrap();
        assert_eq!(em.cells.get("middlegame|+0.0|none"), Some(&0.05));
        assert_eq!(em.rate_scale, 1.5);
        assert_eq!(em.mistake_drop_cp, 100, "unset error-model knobs keep defaults");

        let uci = r#"{"id":"sf","displayName":"Stockfish 18","kind":"uci","enginePath":"/opt/homebrew/bin/stockfish"}"#;
        let p: Participant = serde_json::from_str(uci).expect("uci participant deserializes");
        assert_eq!(p.kind, ParticipantKind::Uci);
        assert_eq!(p.engine_path.as_deref(), Some("/opt/homebrew/bin/stockfish"));
        assert!(p.persona_config.is_none());
    }

    // A GameSpec may carry participants on the wire; the resolved runtimes never
    // appear in JSON and default to None on deserialization.
    #[test]
    fn game_spec_accepts_participants_on_the_wire() {
        let json = r#"{
            "id": 0, "white_path": "", "black_path": "", "max_plies": 4,
            "white": {"id":"sf","displayName":"SF","kind":"uci","enginePath":"/bin/sf"},
            "black": {"id":"dad","displayName":"Dad","kind":"persona",
                      "personaConfig":{"level":1700,"temperature":0.5,"alpha":1.0,"lambda":0.75}}
        }"#;
        let spec: GameSpec = serde_json::from_str(json).expect("spec with participants deserializes");
        assert_eq!(spec.white.as_ref().unwrap().kind, ParticipantKind::Uci);
        assert_eq!(spec.black.as_ref().unwrap().kind, ParticipantKind::Persona);
        assert!(spec.white_runtime.is_none() && spec.black_runtime.is_none());
    }

    // Per-game Threads (spec 210 Phase 6 "engine thread count per game") is
    // additive on the wire: absent on every pre-existing payload (None), and a
    // plain number when the tab sends it.
    #[test]
    fn game_spec_threads_is_additive_on_the_wire() {
        let without = r#"{"id":0,"white_path":"a","black_path":"b","max_plies":4}"#;
        let spec: GameSpec = serde_json::from_str(without).expect("legacy spec deserializes");
        assert_eq!(spec.threads, None);

        let with = r#"{"id":0,"white_path":"a","black_path":"b","max_plies":4,"threads":4}"#;
        let spec: GameSpec = serde_json::from_str(with).expect("threads spec deserializes");
        assert_eq!(spec.threads, Some(4));
    }

    // Real-engine game with a per-game thread count: the `setoption name
    // Threads` + isready sync must not wedge the handshake, and the game must
    // still complete normally. Same deterministic mate-in-1 seed as
    // real_engine_game_terminal_result_is_checkmate. Skips without Stockfish.
    #[tokio::test]
    async fn real_engine_game_with_threads_completes() {
        let Some(sf) = find_stockfish() else {
            eprintln!("skipping real_engine_game_with_threads_completes: no stockfish");
            return;
        };
        let mate_in_1_fen = "6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1";
        let mut s = spec(0, &sf, &sf, Some(mate_in_1_fen));
        s.threads = Some(2);

        let outcomes = run_batch_core(
            vec![s],
            1,
            |_p| {},
            Arc::new(|_ev| {}),
            Arc::new(AtomicBool::new(false)),
        )
        .await;

        assert_eq!(outcomes.len(), 1);
        let g = outcomes[0]
            .result
            .as_ref()
            .unwrap_or_else(|e| panic!("expected a completed game, got error: {e}"));
        assert_eq!(g.result, "1-0");
        assert_eq!(g.termination, "checkmate");
    }

    // Fixed-depth eval-tagging (spec 210 Phase 3): one engine process tags a
    // small batch, scores are White-POV regardless of the side to move, and
    // progress fires once per position. Skips without Stockfish.
    #[tokio::test]
    async fn tag_positions_core_tags_white_pov_with_progress() {
        let Some(sf) = find_stockfish() else {
            eprintln!("skipping tag_positions_core_tags_white_pov_with_progress: no stockfish");
            return;
        };
        let fens = vec![
            // Standard start: roughly balanced.
            STANDARD_START_FEN.to_string(),
            // White up a rook with BLACK to move: the raw side-to-move score is
            // negative, so a large positive tag proves the White-POV flip.
            "1nbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b Kk - 0 1".to_string(),
        ];
        let progress = std::sync::Mutex::new(Vec::new());
        let tags = tag_positions_core(&sf, &fens, 8, |p| {
            progress.lock().unwrap().push((p.completed, p.total));
        })
        .await
        .expect("tagging should succeed");

        assert_eq!(tags.len(), 2);
        assert_eq!(tags[0].fen, fens[0]);
        // The start position must score, and score near equality.
        let start_cp = tags[0].cp.expect("start position has a cp score");
        assert!(start_cp.abs() < 150, "start ~balanced, got {start_cp}cp");
        // A clean rook up is decisively White-positive from White's POV even
        // though Black is to move (cp, or an eventual mate for White).
        let rook_up = &tags[1];
        let decisive = rook_up.cp.map(|v| v > 150).unwrap_or(false)
            || rook_up.mate.map(|m| m > 0).unwrap_or(false);
        assert!(
            decisive,
            "rook-up-for-White should tag White-positive, got cp={:?} mate={:?}",
            rook_up.cp, rook_up.mate
        );
        assert_eq!(
            *progress.lock().unwrap(),
            vec![(1, 2), (2, 2)],
            "one progress event per position"
        );
    }

    /// Resolve a usable lc0 + maia-1500 weights for the persona-arm test, or
    /// `None` so it skips cleanly on a box without lc0 or offline.
    async fn find_persona_deps() -> Option<(PathBuf, PathBuf)> {
        let lc0 = crate::maia::resolve_lc0()?;
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("maia-test-cache");
        let weights = crate::maia::ensure_weights(1500, &dir).await.ok()?;
        Some((lc0, weights))
    }

    // End-to-end persona arm: a persona (Maia-1500 policy + Stockfish verification
    // reweight) as White vs Stockfish as Black, two half-moves headless. Proves
    // the enum dispatches the persona at the per-move call site, that its move is
    // legal and applied, and that a per-move decision log is attached to the
    // outcome. Skips cleanly without lc0/weights/stockfish.
    #[tokio::test]
    async fn persona_vs_uci_two_moves_logs_a_decision() {
        let Some((lc0, weights)) = find_persona_deps().await else {
            eprintln!("skipping persona_vs_uci_two_moves: no lc0/maia weights");
            return;
        };
        let Some(sf) = find_stockfish() else {
            eprintln!("skipping persona_vs_uci_two_moves: no stockfish");
            return;
        };

        let rt = PersonaRuntime {
            lc0_path: lc0,
            weights_path: weights,
            stockfish_path: Some(PathBuf::from(&sf)),
            band: 1500,
            alpha: 1.0,
            lambda: 0.75,
            temperature: 0.5,
            top_k: Some(4),
            top_p: None,
            verify_depth: Some(6), // shallow: fast but exercises the verify arm
            seed: 214218,
            schedule: Some(persona::TemperatureSchedule::default()),
            style_bias: None,
            endgame: Some(persona::EndgameArm::default()),
            error_model: None,
        };

        let cancel = AtomicBool::new(false);
        let paused = AtomicBool::new(false);
        let delay = AtomicU64::new(0);
        let (result, logs) = play_game_streamed_impl(
            PlayerSpec::Persona(&rt),
            PlayerSpec::Uci { path: &sf, threads: None },
            None,
            5000, 0, 5000, 0,
            2,      // two half-moves then max_plies adjudication
            false,  // no tablebase network
            0,
            |_| {},
            &cancel,
            &paused,
            &delay,
        )
        .await
        .expect("persona-vs-uci game should play");

        assert!(result.plies >= 1, "at least White's persona move was played");
        // White is the persona → exactly its ply-1 move is logged.
        assert_eq!(logs.len(), 1, "one persona decision (White, ply 1)");
        let entry = &logs[0];
        assert_eq!(entry.ply, 1);
        assert_eq!(entry.color, "white");
        assert!(!entry.decision.uci.is_empty(), "the chosen move is recorded");
        assert_eq!(
            entry.decision.uci, result.moves[0],
            "the logged decision is the move actually applied"
        );
        assert!(
            entry.decision.reason == "policy" || entry.decision.reason == "verify-reweight",
            "reason arm should be a persona arm, got {}",
            entry.decision.reason
        );
        assert!(!entry.decision.candidates.is_empty(), "candidates are logged");
    }

    // -----------------------------------------------------------------------
    // Phase 6 — tournament result persistence
    // -----------------------------------------------------------------------

    /// Save -> list -> load round-trip against a scratch directory, plus the
    /// path-traversal guard on the load key.
    #[test]
    fn tournament_persistence_round_trip() {
        let dir = std::env::temp_dir().join(format!(
            "chessgui-tournament-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));

        // Empty (nonexistent) dir lists as empty, not an error.
        assert_eq!(list_tournament_results_in(&dir).unwrap().len(), 0);

        let result = serde_json::json!({
            "version": 1,
            "kind": "round-robin",
            "name": "Test RR",
            "completedAt": "2026-07-15T12:00:00.000Z",
            "gamesPerPairing": 2,
            "totalGames": 6,
            "participants": [{ "id": "engine-stockfish", "label": "engine: stockfish" }],
            "crossTable": [[null]],
            "elo": [],
        });
        let file = save_tournament_result_in(&dir, &result).expect("save succeeds");
        assert!(file.starts_with("tournament-") && file.ends_with(".json"));

        // A same-ms second save must not clobber the first.
        let file2 = save_tournament_result_in(&dir, &result).expect("second save succeeds");
        assert_ne!(file, file2);

        let list = list_tournament_results_in(&dir).expect("list succeeds");
        assert_eq!(list.len(), 2);
        let meta = list.iter().find(|m| m.file == file).expect("saved file listed");
        assert_eq!(meta.name, "Test RR");
        assert_eq!(meta.kind, "round-robin");
        assert_eq!(meta.total_games, 6);
        assert_eq!(meta.completed_at, "2026-07-15T12:00:00.000Z");

        let loaded = load_tournament_result_in(&dir, &file).expect("load succeeds");
        assert_eq!(loaded, result, "loaded JSON is byte-for-byte the saved value");

        // Path traversal is rejected.
        assert!(load_tournament_result_in(&dir, "../secrets.json").is_err());
        assert!(load_tournament_result_in(&dir, "a/b.json").is_err());

        // A corrupt sidecar file is skipped by the listing, not fatal.
        std::fs::write(dir.join("garbage.json"), "{not json").unwrap();
        assert_eq!(list_tournament_results_in(&dir).unwrap().len(), 2);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `read_opening_positions_in` round-trips a text file, errors on a
    /// missing path, and enforces the byte cap (tested with a tiny cap so the
    /// test never writes megabytes).
    #[test]
    fn read_opening_positions_round_trip_and_cap() {
        let dir = std::env::temp_dir().join(format!(
            "chessgui-openings-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("book.epd");
        let text = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - ce 25;\n";
        std::fs::write(&file, text).unwrap();
        let path = file.to_string_lossy().into_owned();

        assert_eq!(read_opening_positions_in(&path, 1024).unwrap(), text);
        assert!(read_opening_positions_in(&path, 8).is_err(), "over-cap file rejected");
        assert!(
            read_opening_positions_in(&dir.join("missing.epd").to_string_lossy(), 1024).is_err(),
            "missing file is a descriptive error"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
