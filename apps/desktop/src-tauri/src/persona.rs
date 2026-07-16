// Persona move sampling — spec 214, Tier 0 ("Spar vs rival").
//
// The rival opponent is lc0+Maia at the rival's level: for a position we read
// the band's human-move policy (maia.rs) and *sample* a move from it, rather
// than taking the top move. Sampling at temperature 1 over the raw policy IS the
// human-likeness — a rating-R human doesn't play the single most-likely move
// every time, they play across the distribution. We never noise-weaken a strong
// engine to fake humanity (spec 214 hard rule); the humanity is the Maia policy.
//
// This module also serves the rival opening book to the UI (`rival_book`), read
// from the local, gitignored data/rivals — dad's games stay on the machine.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use shakmaty::fen::Fen;
use shakmaty::san::SanPlus;
use shakmaty::uci::UciMove;
use shakmaty::{CastlingMode, Chess, EnPassantMode, Position, Role};
use tauri::{Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::time::timeout;

use crate::maia::{self, MaiaMove, MaiaPolicy, MaiaState};

/// Moves the band assigns less mass than this are dropped before sampling: the
/// policy's long tail is noise a human of that rating essentially never plays,
/// and sampling from it would manufacture blunders the persona shouldn't make.
/// (Distinct from noise-weakening — we're trimming implausible moves, not adding
/// random ones.) If every move is below the floor we keep them all rather than
/// return nothing.
const POLICY_FLOOR: f64 = 0.01;

/// The persona's chosen move for a position.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PersonaMove {
    pub uci: String,
    pub san: String,
}

/// Inverse-CDF sample from a Maia policy at temperature 1 (raw probabilities).
/// `u` is a uniform draw in [0, 1); passing it in keeps this pure and lets tests
/// pin the outcome. Moves below `floor` are trimmed first (see `POLICY_FLOOR`);
/// remaining mass is renormalized. Returns the chosen move's UCI, or None only
/// when `moves` is empty.
pub fn sample_policy_move(moves: &[MaiaMove], floor: f64, u: f64) -> Option<String> {
    if moves.is_empty() {
        return None;
    }
    // Trim the tail; fall back to the full set if the floor removes everything.
    let kept: Vec<&MaiaMove> = moves.iter().filter(|m| m.prob >= floor).collect();
    let kept: Vec<&MaiaMove> = if kept.is_empty() {
        moves.iter().collect()
    } else {
        kept
    };

    let total: f64 = kept.iter().map(|m| m.prob.max(0.0)).sum();
    if total <= 0.0 {
        // Degenerate (all-zero) policy — fall back to a uniform pick.
        let idx = ((u.clamp(0.0, 0.999_999) * kept.len() as f64) as usize).min(kept.len() - 1);
        return Some(kept[idx].uci.clone());
    }

    let target = u.clamp(0.0, 1.0) * total;
    let mut acc = 0.0;
    for m in &kept {
        acc += m.prob.max(0.0);
        if target < acc {
            return Some(m.uci.clone());
        }
    }
    // Floating-point slack at the top end: return the last move.
    Some(kept.last().unwrap().uci.clone())
}

/// A uniform draw in [0, 1). Non-cryptographic — a time-seeded xorshift64 with an
/// atomic counter so two calls in the same nanosecond don't correlate. Adequate
/// for choosing a chess move; deliberately not used for anything security-facing.
fn uniform01() -> f64 {
    static CTR: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let c = CTR.fetch_add(1, Ordering::Relaxed);
    let mut x = nanos ^ c.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ 0x2545_F491_4F6C_DD1D;
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    // Top 53 bits -> a double in [0, 1).
    ((x >> 11) as f64) / ((1u64 << 53) as f64)
}

/// SAN for `uci` played in `fen`, for the UI move list. Validates legality (the
/// UCI comes from the Maia policy, which only lists legal moves, but we parse
/// against the real position anyway).
fn san_for(fen: &str, uci: &str) -> Result<String, String> {
    let mut pos: Chess = Fen::from_ascii(fen.as_bytes())
        .map_err(|e| format!("bad FEN: {e}"))?
        .into_position(CastlingMode::Standard)
        .map_err(|e| format!("illegal position: {e}"))?;
    let mv = UciMove::from_ascii(uci.as_bytes())
        .map_err(|e| format!("bad UCI {uci}: {e}"))?
        .to_move(&pos)
        .map_err(|e| format!("illegal move {uci}: {e}"))?;
    Ok(SanPlus::from_move_and_play_unchecked(&mut pos, mv).to_string())
}

/// FEN of the position reached by playing `uci` in `fen` — the position the
/// verification search evaluates for a candidate move. `pub(crate)` because the
/// spec-213 human-visible tree (human_search.rs) advances positions the same way.
pub(crate) fn fen_after(fen: &str, uci: &str) -> Result<String, String> {
    let mut pos: Chess = Fen::from_ascii(fen.as_bytes())
        .map_err(|e| format!("bad FEN: {e}"))?
        .into_position(CastlingMode::Standard)
        .map_err(|e| format!("illegal position: {e}"))?;
    let mv = UciMove::from_ascii(uci.as_bytes())
        .map_err(|e| format!("bad UCI {uci}: {e}"))?
        .to_move(&pos)
        .map_err(|e| format!("illegal move {uci}: {e}"))?;
    pos.play_unchecked(mv);
    Ok(Fen::from_position(&pos, EnPassantMode::Legal).to_string())
}

// ===========================================================================
// Persona engine — spec 214 "move-selection contract" steps 3, 4, 6, 8, 9.
//
// Out of book (the book phase lives in the TS frontend and is untouched) the
// persona picks a move by:
//   3. policy sampling — read the Maia band's human-move policy (maia.rs), trim
//      the noise tail (POLICY_FLOOR), and keep a candidate set (top-k count cap
//      or top-p nucleus). The sampling temperature follows a phase × clock
//      SCHEDULE (TemperatureSchedule), and a post-book style-bias window
//      (StyleBias, OFF by default) can overweight the persona's characteristic
//      move types for N plies after book exit.
//   6. endgame arm — at low non-pawn material (phase weight ≤ 8, the
//      calibration.rs endgame threshold) the candidate source switches to deep
//      fixed-depth Stockfish MultiPV top-k, still humanized through the same
//      reweight (reason arm "endgame").
//   4. verification reweight — cheap Stockfish eval of each candidate; combine
//      policy prior and eval penalty into one temperature-scaled softmax, then
//      SAMPLE from it. This keeps the human move distribution while suppressing
//      non-human blunders (the verification-search lesson from realism matches).
//   8. determinism — the draw is seeded: a per-game seed and the move's ply
//      derive the per-move RNG, so same seed + same inputs = same move.
//   9. decision log — every candidate's policy prob, verification eval, penalty
//      and final weight, plus the chosen move, the reason arm and the derived
//      seed, are returned for the realism-debugging record.
//
// The reweight is a softmax over combined logits:
//     logit_i  = alpha * ln(policy_prob_i) - lambda * eval_penalty_i
//     weight_i ∝ exp(logit_i / temperature)
// which is exactly the contract's `policy_prob^alpha * exp(-lambda*penalty)`
// with temperature as the global sharpening knob (weight_i ∝
// policy_prob_i^(alpha/T) * exp(-lambda*penalty_i/T)). Softmax form rather than
// the literal product so temperature scales the WHOLE distribution (high T = more
// random overall, the correct sign) instead of only the policy term. alpha tilts
// policy-trust vs eval, lambda sets blunder suppression. Per-persona params.
// ===========================================================================

/// Candidate-set size when `top_k`/`top_p` are unset. Matches the Python
/// reference's POLICY_TOPK (scripts/persona/exhibition_v2.py).
const DEFAULT_TOP_K: usize = 4;

/// Centipawn magnitude a forced mate maps to, so a candidate that walks into (or
/// delivers) mate dominates the eval penalty. Comfortably beyond any real cp eval.
pub(crate) const MATE_CP: i64 = 100_000;

/// Sampling + verification parameters for one persona move. Deserialized from the
/// frontend; `seed` is per-game and `ply` per-move so the RNG derives
/// deterministically (contract step 8). `seed` must stay < 2^53 so it survives
/// the JSON number round-trip from TypeScript without precision loss.
#[derive(Debug, Clone, Deserialize)]
pub struct PersonaParams {
    /// Maia rating band (the policy backend weights).
    pub level: u32,
    pub temperature: f64,
    /// Policy-prior exponent in the reweight (contract step 4).
    pub alpha: f64,
    /// Eval-penalty coefficient in the reweight (contract step 4).
    pub lambda: f64,
    /// Candidate-set count cap. Falls back to `DEFAULT_TOP_K` when both this and
    /// `top_p` are absent.
    #[serde(default)]
    pub top_k: Option<usize>,
    /// Nucleus mass for the candidate set; when set, overrides `top_k`.
    #[serde(default)]
    pub top_p: Option<f64>,
    /// Stockfish search depth for the verification eval. `None`/`0` disables
    /// verification (policy-only, reason arm "policy").
    #[serde(default)]
    pub verify_depth: Option<u32>,
    /// Per-game seed.
    pub seed: u64,
    /// Half-move index within the game.
    pub ply: u32,
    /// The persona's own remaining clock, ms. The spar loop is UNCLOCKED today,
    /// so this defaults to None (= no time-pressure spike); the match runner IS
    /// clocked and passes the mover's real clock. Contract step 3's clock
    /// dimension is implemented but only live where a clock exists.
    #[serde(default)]
    pub clock_ms: Option<i64>,
    /// Plies played since the position left the persona's book. None = book
    /// state unknown (treated as "long out of book": the style-bias window
    /// never fires). The spar frontend owns the book phase and may pass this.
    #[serde(default)]
    pub plies_since_book_exit: Option<u32>,
    /// Temperature schedule (contract step 3). None = flat `temperature`
    /// (persona engine v1 behavior, kept for older callers).
    #[serde(default)]
    pub schedule: Option<TemperatureSchedule>,
    /// Post-book style-bias window (contract step 3). None = OFF — the default
    /// until the metrics harness can gate it (spec 214 hard rule: measured
    /// improvement before style claims).
    #[serde(default)]
    pub style_bias: Option<StyleBias>,
    /// Endgame arm (contract step 6). None = disabled (v1 behavior).
    #[serde(default)]
    pub endgame: Option<EndgameArm>,
    /// Corpus error model (contract step 5). None = OFF — the default
    /// EVERYWHERE; a config carries this only after tune_persona.py's
    /// held-out +2% bar enabled it (spec 214 hard rule).
    #[serde(default)]
    pub error_model: Option<ErrorModel>,
}

/// One candidate move's full decision record (contract step 9).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PersonaCandidate {
    pub uci: String,
    pub san: String,
    /// Raw Maia policy probability for this move.
    pub policy_prob: f64,
    /// Verification eval in centipawns, mover-POV (higher = better for the
    /// persona). `None` when verification did not run.
    pub eval_cp: Option<i64>,
    /// Pawns behind the best-evaluated candidate (>= 0); 0 without verification.
    pub eval_penalty: f64,
    /// Normalized final sampling weight this candidate received.
    pub weight: f64,
}

/// The persona's move plus its per-move decision log (contract step 9).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PersonaDecision {
    pub uci: String,
    pub san: String,
    /// Which arm decided the move: "endgame" when the endgame arm supplied the
    /// candidates (contract step 6), "verify-reweight" when Stockfish
    /// verification ran, "policy" when both were skipped/unavailable (pure
    /// tempered policy).
    pub reason: String,
    /// Maia band the policy came from.
    pub band: u32,
    /// The per-move seed derived from (seed, ply); logged for reproducibility.
    pub derived_seed: u64,
    /// Detected game phase: "opening" | "middlegame" | "endgame".
    pub phase: String,
    /// The EFFECTIVE sampling temperature after the schedule (contract step 3);
    /// equals the base temperature when no schedule was supplied.
    pub temperature: f64,
    /// True when the post-book style-bias window was active AND at least one
    /// candidate matched a biased move type this move.
    pub style_bias_applied: bool,
    /// True when the error model (contract step 5) actually remixed the
    /// sampling weights this move (a rate was found AND both a mistake and a
    /// sound branch existed among the candidates).
    pub error_model_applied: bool,
    /// The fitted P(mistake) the error model looked up for this move's
    /// (phase, eval, clock) cell — logged even when the mix couldn't apply
    /// (realism-debugging record); None when the model is off, no eval
    /// evidence exists, or the cell is uncovered.
    pub mistake_rate: Option<f64>,
    pub candidates: Vec<PersonaCandidate>,
}

// ---------------------------------------------------------------------------
// Seeded RNG (contract step 8) — pure, splitmix64
// ---------------------------------------------------------------------------

fn splitmix64(mut z: u64) -> u64 {
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// The per-move seed: mix the game seed with the ply, then one splitmix64 round.
/// Deterministic in (seed, ply); different plies of the same game decorrelate.
/// `pub(crate)` so the match runner's persona arm derives per-move seeds the
/// same way the spar `persona_move` command does.
pub(crate) fn derive_seed(seed: u64, ply: u32) -> u64 {
    splitmix64(seed ^ (ply as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15))
}

/// A uniform draw in [0, 1) from a derived seed (top 53 bits of one more
/// splitmix64 step). Pure and total — the whole point of step 8.
fn uniform_from_seed(derived: u64) -> f64 {
    let z = splitmix64(derived.wrapping_add(0x9E37_79B9_7F4A_7C15));
    ((z >> 11) as f64) / ((1u64 << 53) as f64)
}

// ---------------------------------------------------------------------------
// Phase detection + temperature schedule + style bias + endgame arm
// (contract steps 3 and 6)
// ---------------------------------------------------------------------------

/// Non-pawn phase weight at or below which a position counts as an endgame.
/// Same formula and threshold as calibration.rs (minor = 1, rook = 2,
/// queen = 4, both sides; 24 at the start; 8 ≈ queens-plus-a-rook-each traded)
/// so "endgame" means the same thing across the codebase.
pub const ENDGAME_PHASE_MAX: u32 = 8;

/// Plies below which a non-endgame position counts as the opening. Matches
/// calibration.rs's MIN_PLY (positions from ply 16 on are "out of the
/// opening/book").
pub const OPENING_MAX_PLY: u32 = 16;

/// Effective-temperature clamp: never so cold sampling degenerates numerically,
/// never so hot the persona plays uniformly at random.
const MIN_EFFECTIVE_TEMP: f64 = 0.05;
const MAX_EFFECTIVE_TEMP: f64 = 3.0;

/// Prior a policy-unseen endgame-arm candidate gets: the same floor below which
/// the policy tail is trimmed elsewhere. Deep-Stockfish moves the band's policy
/// never considered enter the reweight at the floor, not at zero — so the arm
/// can actually play the strong endgame move Maia misses, while a decent
/// policy prob still outranks it (humanization).
const ENDGAME_UNSEEN_PRIOR: f64 = POLICY_FLOOR;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Opening,
    Middlegame,
    Endgame,
}

impl Phase {
    pub fn label(self) -> &'static str {
        match self {
            Phase::Opening => "opening",
            Phase::Middlegame => "middlegame",
            Phase::Endgame => "endgame",
        }
    }
}

/// Non-pawn phase weight of a position: knights + bishops ×1, rooks ×2,
/// queens ×4, both sides (24 at the standard start). The calibration.rs
/// formula, computed here from a parsed position.
pub(crate) fn phase_weight_of(pos: &Chess) -> u32 {
    let b = pos.board();
    (b.knights().count() + b.bishops().count()) as u32
        + 2 * b.rooks().count() as u32
        + 4 * b.queens().count() as u32
}

/// Game phase from material + ply. Endgame wins over the ply test (an early
/// queen-trade grind IS an endgame); otherwise low ply = opening.
pub(crate) fn phase_for(phase_weight: u32, ply: u32) -> Phase {
    if phase_weight <= ENDGAME_PHASE_MAX {
        Phase::Endgame
    } else if ply < OPENING_MAX_PLY {
        Phase::Opening
    } else {
        Phase::Middlegame
    }
}

/// Temperature schedule (contract step 3): the base temperature is multiplied
/// by a per-phase factor and a clock-pressure factor. Opening low (book-like),
/// middlegame the reference, endgame slightly converging; the clock factor
/// spikes under time pressure. All knobs are per-persona overridable; defaults
/// below are UNTUNED priors (auto-tuning is its own spec 214 checklist item).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct TemperatureSchedule {
    pub opening_mult: f64,
    pub middlegame_mult: f64,
    pub endgame_mult: f64,
    /// Own clock at or below this (ms) applies `low_time_mult`.
    pub low_time_ms: i64,
    pub low_time_mult: f64,
    /// Own clock at or below this (ms) applies `panic_mult` instead.
    pub panic_time_ms: i64,
    pub panic_mult: f64,
}

impl Default for TemperatureSchedule {
    fn default() -> Self {
        Self {
            opening_mult: 0.6,
            middlegame_mult: 1.0,
            endgame_mult: 0.8,
            low_time_ms: 30_000,
            low_time_mult: 1.5,
            panic_time_ms: 10_000,
            panic_mult: 2.25,
        }
    }
}

/// The effective sampling temperature for one move: base × phase multiplier ×
/// clock multiplier, clamped. `clock_ms = None` means unclocked (the spar loop
/// today) — clock factor 1, honestly no time-pressure dimension. Pure.
pub(crate) fn effective_temperature(
    base: f64,
    schedule: Option<&TemperatureSchedule>,
    phase: Phase,
    clock_ms: Option<i64>,
) -> f64 {
    let Some(s) = schedule else {
        return base;
    };
    let phase_mult = match phase {
        Phase::Opening => s.opening_mult,
        Phase::Middlegame => s.middlegame_mult,
        Phase::Endgame => s.endgame_mult,
    };
    let clock_mult = match clock_ms {
        Some(ms) if ms <= s.panic_time_ms => s.panic_mult,
        Some(ms) if ms <= s.low_time_ms => s.low_time_mult,
        _ => 1.0,
    };
    (base * phase_mult * clock_mult).clamp(MIN_EFFECTIVE_TEMP, MAX_EFFECTIVE_TEMP)
}

/// Post-book style-bias window (contract step 3): for `window_plies` after book
/// exit, candidates matching any of the persona's `move_types` get their policy
/// prior multiplied by `multiplier` before the reweight. v1 move types are
/// coarse, mechanical classes — "capture" | "check" | "castle" | "pawn_push" |
/// "quiet_piece" — chosen because they're cheap to classify and measurable in
/// the decision log. OFF by default everywhere (spec 214 hard rule: no style
/// claims without measured improvement); the metrics harness gates turning it on.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StyleBias {
    /// The window: active while plies_since_book_exit < window_plies.
    pub window_plies: u32,
    /// Multiplier on matching candidates' policy prior (>1 overweights the
    /// persona's characteristic move types while leaving theory).
    pub multiplier: f64,
    /// Move classes to bias; unknown labels never match (fail quiet, not loud).
    pub move_types: Vec<String>,
}

/// Whether the style-bias window is live for this move.
fn style_bias_active(bias: Option<&StyleBias>, plies_since_book_exit: Option<u32>) -> bool {
    match (bias, plies_since_book_exit) {
        (Some(b), Some(n)) => n < b.window_plies && b.multiplier != 1.0 && !b.move_types.is_empty(),
        _ => false,
    }
}

/// Does `uci` (legal in `pos`) fall in any of the listed move classes?
/// Unparseable/illegal candidates simply don't match.
fn move_matches_types(pos: &Chess, uci: &str, types: &[String]) -> bool {
    let Ok(parsed) = UciMove::from_ascii(uci.as_bytes()) else {
        return false;
    };
    let Ok(mv) = parsed.to_move(pos) else {
        return false;
    };
    types.iter().any(|t| match t.as_str() {
        "capture" => mv.is_capture(),
        "castle" => mv.is_castle(),
        "check" => {
            let mut after = pos.clone();
            after.play_unchecked(mv);
            after.is_check()
        }
        "pawn_push" => mv.role() == Role::Pawn && !mv.is_capture(),
        "quiet_piece" => mv.role() != Role::Pawn && !mv.is_capture() && !mv.is_castle(),
        _ => false,
    })
}

/// Multiply matching candidates' priors in place; returns true when at least
/// one candidate matched (the decision log's `style_bias_applied`). The softmax
/// normalizes, so no renormalization is needed here.
fn apply_style_bias(pos: &Chess, ucis: &[&str], probs: &mut [f64], bias: &StyleBias) -> bool {
    let mut any = false;
    for (i, uci) in ucis.iter().enumerate() {
        if move_matches_types(pos, uci, &bias.move_types) {
            probs[i] *= bias.multiplier.max(0.0);
            any = true;
        }
    }
    any
}

/// Endgame arm (contract step 6): at low material the CANDIDATE SOURCE switches
/// from the Maia policy to deeper fixed-depth Stockfish top-k (MultiPV) —
/// because Maia is weakest exactly where the primary rival is strongest — while
/// the move is still humanized through the same policy^alpha × exp(-lambda·
/// penalty) reweight: each Stockfish candidate's prior is its Maia policy prob
/// (or the floor when the policy never considered it). No tablebase probe yet:
/// a ≤7-man network probe per move is not "cheap" offline, and the deep fixed-
/// depth search already plays trivial endings correctly.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct EndgameArm {
    /// Non-pawn phase weight at or below which the arm engages.
    pub phase_max: u32,
    /// Fixed Stockfish depth for candidate generation (deeper than the
    /// middlegame verification's 12). 0 disables the arm.
    pub depth: u32,
    /// MultiPV candidate count.
    pub top_k: usize,
}

impl Default for EndgameArm {
    fn default() -> Self {
        Self {
            phase_max: ENDGAME_PHASE_MAX,
            depth: 16,
            top_k: 4,
        }
    }
}

// ---------------------------------------------------------------------------
// Corpus error model (contract step 5) — gated via the tuner, OFF by default
// ---------------------------------------------------------------------------

/// Corpus-derived error model (spec 214 contract step 5): the 11M-game
/// evals-on corpus's P(mistake | eval, phase, clock, band), fitted/smoothed
/// per band by scripts/persona/fit_error_model.py. A persona may consult it
/// ONLY when tune_persona.py's stage D proved a held-out +2% move-match@1
/// win — the enabled fit lands in the staged v2 config's
/// `sampling.error_model`; absent = OFF, the default everywhere.
///
/// Application is a branch-mass remix of the FINAL sampling weights, never
/// noise: candidates >= `mistake_drop_cp` behind the best form the mistake
/// branch, and the model reassigns total mass (rate, 1-rate) between the
/// branches while keeping the human distribution WITHIN each. It conditions
/// WHEN mistakes happen (human-band timing); the mistake itself is still a
/// human-plausible policy candidate (the hard rule: candidate-set realism,
/// not random weakening).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ErrorModel {
    /// Fitted P(mistake) cells for THIS persona's band, keyed
    /// "phase|eval_bucket_lower|clock_bucket" — scripts/mining/error_model.py
    /// conventions: eval is the mover-POV eval BEFORE the move in
    /// `eval_bucket_cp` buckets clamped to ±`eval_clamp_cp`, labeled by the
    /// lower edge in pawns ("+0.0"); clock buckets are remaining seconds
    /// (600plus/300-600/120-300/60-120/30-60/lt30/none).
    pub cells: HashMap<String, f64>,
    /// Tuner-searched multiplier on the fitted rate (result clamped to [0,1]).
    #[serde(default = "default_rate_scale")]
    pub rate_scale: f64,
    /// Candidates at least this many cp behind the best candidate form the
    /// mistake branch (the corpus's MISTAKE_DROP_CP definition of "mistake").
    #[serde(default = "default_mistake_drop_cp")]
    pub mistake_drop_cp: i64,
    #[serde(default = "default_eval_bucket_cp")]
    pub eval_bucket_cp: i64,
    #[serde(default = "default_eval_clamp_cp")]
    pub eval_clamp_cp: i64,
}

fn default_rate_scale() -> f64 {
    1.0
}
fn default_mistake_drop_cp() -> i64 {
    100
}
fn default_eval_bucket_cp() -> i64 {
    50
}
fn default_eval_clamp_cp() -> i64 {
    500
}

impl ErrorModel {
    /// Mover-POV cp -> the corpus's '+0.0'-style lower-edge bucket label
    /// (error_model.py `eval_bucket`; floor division so -1 cp lands in -0.5).
    fn eval_bucket_label(&self, cp: i64) -> String {
        let cp = cp.clamp(-self.eval_clamp_cp, self.eval_clamp_cp - 1);
        let lower = cp.div_euclid(self.eval_bucket_cp) * self.eval_bucket_cp;
        format!("{:+.1}", lower as f64 / 100.0)
    }

    /// The fitted mistake probability for this move's cell, x `rate_scale`,
    /// clamped to [0, 1]. None when the cell is uncovered — the model stays
    /// silent rather than inventing a rate.
    fn mistake_rate(&self, phase: Phase, eval_before_cp: i64, clock_ms: Option<i64>) -> Option<f64> {
        let key = format!(
            "{}|{}|{}",
            phase.label(),
            self.eval_bucket_label(eval_before_cp),
            clock_bucket_label(clock_ms)
        );
        self.cells
            .get(&key)
            .map(|r| (r * self.rate_scale).clamp(0.0, 1.0))
    }
}

/// Remaining clock (ms; None = unclocked, e.g. the spar loop) -> corpus
/// clock-bucket label. The corpus "none" bucket (games without [%clk] tags)
/// doubles as the unclocked bucket — both honestly mean "no clock signal".
fn clock_bucket_label(clock_ms: Option<i64>) -> &'static str {
    let Some(ms) = clock_ms else { return "none" };
    let s = ms / 1000;
    match s {
        s if s >= 600 => "600plus",
        s if s >= 300 => "300-600",
        s if s >= 120 => "120-300",
        s if s >= 60 => "60-120",
        s if s >= 30 => "30-60",
        _ => "lt30",
    }
}

/// The error-model mix (see [`ErrorModel`]): reassign the normalized sampling
/// weights' branch mass to (rate, 1-rate) across the mistake / sound split at
/// `drop_pawns`, keeping each branch's internal distribution. Returns false
/// (weights untouched) when either branch is empty or weightless — the
/// candidate set can't offer, or can't avoid, a mistake, so there is nothing
/// to time. Pure.
fn apply_error_model_mix(weights: &mut [f64], penalties: &[f64], rate: f64, drop_pawns: f64) -> bool {
    if rate <= 0.0 {
        return false;
    }
    let rate = rate.min(1.0);
    let mut mis = 0.0;
    let mut ok = 0.0;
    for (w, p) in weights.iter().zip(penalties) {
        if *p >= drop_pawns {
            mis += *w;
        } else {
            ok += *w;
        }
    }
    if mis <= 0.0 || ok <= 0.0 {
        return false;
    }
    for (w, p) in weights.iter_mut().zip(penalties) {
        if *p >= drop_pawns {
            *w *= rate / mis;
        } else {
            *w *= (1.0 - rate) / ok;
        }
    }
    true
}

/// Consult the error model for one move (both selection arms route through
/// this): the eval BEFORE the move is estimated as the best candidate's
/// mover-POV eval, so the model is only live when verification evidence
/// exists (verify reweight or endgame arm) — without evals there is no honest
/// eval bucket, and the model stays off. Returns (applied, looked-up rate).
fn consult_error_model(
    em: Option<&ErrorModel>,
    weights: &mut [f64],
    penalties: &[f64],
    eval_before_cp: Option<i64>,
    phase: Phase,
    clock_ms: Option<i64>,
) -> (bool, Option<f64>) {
    let (Some(em), Some(before)) = (em, eval_before_cp) else {
        return (false, None);
    };
    let Some(rate) = em.mistake_rate(phase, before, clock_ms) else {
        return (false, None);
    };
    let applied = apply_error_model_mix(weights, penalties, rate, em.mistake_drop_cp as f64 / 100.0);
    (applied, Some(rate))
}

/// Per-move selection context (contract steps 3 + 6 knobs plus the state they
/// condition on). Shared by the spar `persona_move` command and the match
/// runner's persona arm; `Default` = persona engine v1 behavior (flat
/// temperature, no style bias, no endgame arm, unclocked).
#[derive(Debug, Clone, Default)]
pub(crate) struct SelectContext {
    /// Half-move index (phase detection's opening test).
    pub ply: u32,
    /// Own remaining clock, ms; None = unclocked (spar today).
    pub clock_ms: Option<i64>,
    /// Plies since book exit; None = unknown (style window never fires).
    pub plies_since_book_exit: Option<u32>,
    pub schedule: Option<TemperatureSchedule>,
    pub style_bias: Option<StyleBias>,
    pub endgame: Option<EndgameArm>,
    /// Corpus error model (contract step 5); None = OFF, the gated default.
    pub error_model: Option<ErrorModel>,
}

// ---------------------------------------------------------------------------
// Candidate selection + reweight (contract steps 3, 4) — pure
// ---------------------------------------------------------------------------

/// The verification candidate set: drop the below-`floor` policy tail (falling
/// back to the full set if that empties it), sort by policy prob desc, then keep
/// either the top-p nucleus (when set) or the top-k count cap.
fn select_candidates(
    moves: &[MaiaMove],
    floor: f64,
    top_k: Option<usize>,
    top_p: Option<f64>,
) -> Vec<MaiaMove> {
    if moves.is_empty() {
        return Vec::new();
    }
    let mut kept: Vec<MaiaMove> = moves.iter().filter(|m| m.prob >= floor).cloned().collect();
    if kept.is_empty() {
        kept = moves.to_vec();
    }
    kept.sort_by(|a, b| {
        b.prob
            .partial_cmp(&a.prob)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    if let Some(p) = top_p {
        let total: f64 = kept.iter().map(|m| m.prob.max(0.0)).sum::<f64>().max(1e-12);
        let target = p.clamp(0.0, 1.0) * total;
        let mut acc = 0.0;
        let mut n = 0usize;
        for m in &kept {
            acc += m.prob.max(0.0);
            n += 1;
            if acc >= target {
                break;
            }
        }
        kept.truncate(n.max(1));
    } else {
        kept.truncate(top_k.unwrap_or(DEFAULT_TOP_K).max(1));
    }
    kept
}

/// Combined policy + verification softmax, temperature-scaled: the normalized
/// sampling weights. `penalties[i]` is pawns behind the best candidate (all
/// zero disables the eval term -> pure tempered policy). Pure.
fn reweight(policy: &[f64], penalties: &[f64], alpha: f64, lambda: f64, temperature: f64) -> Vec<f64> {
    let n = policy.len();
    debug_assert_eq!(n, penalties.len());
    if n == 0 {
        return Vec::new();
    }
    let t = temperature.max(1e-6);
    let logits: Vec<f64> = (0..n)
        .map(|i| (alpha * policy[i].max(1e-12).ln() - lambda * penalties[i]) / t)
        .collect();
    let maxl = logits.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let exps: Vec<f64> = logits.iter().map(|l| (l - maxl).exp()).collect();
    let total: f64 = exps.iter().sum();
    if total > 0.0 && total.is_finite() {
        exps.iter().map(|e| e / total).collect()
    } else {
        vec![1.0 / n as f64; n]
    }
}

/// Inverse-CDF sample from normalized weights with `u ∈ [0, 1)`. Pure.
fn sample_weighted(weights: &[f64], u: f64) -> usize {
    let target = u.clamp(0.0, 1.0);
    let mut acc = 0.0;
    for (i, w) in weights.iter().enumerate() {
        acc += w;
        if target < acc {
            return i;
        }
    }
    weights.len().saturating_sub(1)
}

/// [`reweight`] + [`sample_weighted`] in one step — the pre-error-model
/// pipeline shape, kept because the unit tests pin its exact semantics.
#[cfg(test)]
fn reweight_and_sample(
    policy: &[f64],
    penalties: &[f64],
    alpha: f64,
    lambda: f64,
    temperature: f64,
    u: f64,
) -> (usize, Vec<f64>) {
    let weights = reweight(policy, penalties, alpha, lambda, temperature);
    if weights.is_empty() {
        return (0, weights);
    }
    (sample_weighted(&weights, u), weights)
}

// ---------------------------------------------------------------------------
// Stockfish verification eval (contract step 4)
// ---------------------------------------------------------------------------

/// Locate a Stockfish binary the same way maia.rs locates lc0: env override,
/// then the usual install paths, then `which`. `None` degrades verification off.
pub fn resolve_stockfish() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("PERSONA_STOCKFISH_PATH") {
        let pb = PathBuf::from(p);
        if pb.exists() {
            return Some(pb);
        }
    }
    for cand in [
        "/opt/homebrew/bin/stockfish",
        "/usr/local/bin/stockfish",
        "/usr/bin/stockfish",
    ] {
        let pb = PathBuf::from(cand);
        if pb.exists() {
            return Some(pb);
        }
    }
    if let Ok(out) = std::process::Command::new("which").arg("stockfish").output() {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !s.is_empty() {
                let pb = PathBuf::from(&s);
                if pb.exists() {
                    return Some(pb);
                }
            }
        }
    }
    None
}

/// Parse `score cp N` / `score mate N` (side-to-move POV) from a UCI info line,
/// collapsing mate to a large centipawn magnitude. Returns `None` if the line
/// carries no score. Shared with the spec-213 leaf evaluator (human_search.rs).
pub(crate) fn parse_score_cp(line: &str) -> Option<i64> {
    let mut it = line.split_whitespace();
    while let Some(tok) = it.next() {
        if tok == "score" {
            return match it.next() {
                Some("cp") => it.next()?.parse::<i64>().ok(),
                Some("mate") => it.next()?.parse::<i64>().ok().map(|m| {
                    if m >= 0 {
                        MATE_CP - m
                    } else {
                        -MATE_CP - m
                    }
                }),
                _ => None,
            };
        }
    }
    None
}

/// Evaluate each candidate at fixed `depth` on a single Stockfish process and
/// return the mover-POV centipawn value per candidate. Fixed depth (not
/// movetime) keeps the eval reproducible for a given Stockfish build (step 8).
/// One warm process serves all candidates; it is killed on drop.
async fn verify_candidates(
    sf: &Path,
    fen: &str,
    cands: &[MaiaMove],
    depth: u32,
) -> Result<Vec<i64>, String> {
    let mut child = Command::new(sf)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("failed to start stockfish: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("stockfish: no stdin")?;
    let mut reader = BufReader::new(child.stdout.take().ok_or("stockfish: no stdout")?);

    // Handshake.
    sf_send(&mut stdin, "uci").await?;
    read_until(&mut reader, |l| l == "uciok").await?;
    sf_send(&mut stdin, "isready").await?;
    read_until(&mut reader, |l| l == "readyok").await?;

    let mut values = Vec::with_capacity(cands.len());
    for m in cands {
        // Evaluate the position AFTER the candidate move; the reported score is
        // the OPPONENT's POV (side to move there), so negate for mover-POV.
        let after = fen_after(fen, &m.uci)?;
        sf_send(&mut stdin, &format!("position fen {after}")).await?;
        let mut last: Option<i64> = None;
        sf_send(&mut stdin, &format!("go depth {}", depth.max(1))).await?;
        read_until(&mut reader, |line| {
            if line.starts_with("info ") {
                if let Some(cp) = parse_score_cp(line) {
                    last = Some(cp);
                }
            }
            line.starts_with("bestmove")
        })
        .await?;
        values.push(-last.unwrap_or(0));
    }

    let _ = sf_send(&mut stdin, "quit").await;
    Ok(values)
}

/// Parse one MultiPV info line into (multipv index, cp score side-to-move POV,
/// first pv move). Lines without `multipv` count as index 1 (MultiPV=1 output);
/// lines without a score or pv yield None. Mate scores collapse to `MATE_CP`
/// magnitudes like `parse_score_cp`.
fn parse_multipv_line(line: &str) -> Option<(usize, i64, String)> {
    if !line.starts_with("info ") {
        return None;
    }
    let toks: Vec<&str> = line.split_whitespace().collect();
    let mut multipv = 1usize;
    let mut score: Option<i64> = None;
    let mut first_pv: Option<String> = None;
    let mut i = 0;
    while i < toks.len() {
        match toks[i] {
            "multipv" => {
                multipv = toks.get(i + 1)?.parse().ok()?;
                i += 2;
            }
            "score" => {
                match toks.get(i + 1) {
                    Some(&"cp") => score = toks.get(i + 2)?.parse().ok(),
                    Some(&"mate") => {
                        score = toks.get(i + 2)?.parse::<i64>().ok().map(|m| {
                            if m >= 0 {
                                MATE_CP - m
                            } else {
                                -MATE_CP - m
                            }
                        })
                    }
                    _ => {}
                }
                i += 3;
            }
            "pv" => {
                first_pv = toks.get(i + 1).map(|s| s.to_string());
                break;
            }
            _ => i += 1,
        }
    }
    Some((multipv, score?, first_pv?))
}

/// The endgame arm's candidate source (contract step 6): Stockfish MultiPV
/// top-k at fixed `depth` on the CURRENT position. Returns (uci, cp) pairs,
/// mover-POV (side to move IS the persona), best first. Fixed depth keeps it
/// reproducible per Stockfish build, same determinism claim as
/// `verify_candidates`.
async fn sf_top_moves(
    sf: &Path,
    fen: &str,
    k: usize,
    depth: u32,
) -> Result<Vec<(String, i64)>, String> {
    let mut child = Command::new(sf)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("failed to start stockfish: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("stockfish: no stdin")?;
    let mut reader = BufReader::new(child.stdout.take().ok_or("stockfish: no stdout")?);

    sf_send(&mut stdin, "uci").await?;
    read_until(&mut reader, |l| l == "uciok").await?;
    sf_send(&mut stdin, &format!("setoption name MultiPV value {}", k.max(1))).await?;
    sf_send(&mut stdin, "isready").await?;
    read_until(&mut reader, |l| l == "readyok").await?;

    sf_send(&mut stdin, &format!("position fen {fen}")).await?;
    // Keep the LAST (deepest) line per multipv index; iteration overwrites.
    let mut best: std::collections::BTreeMap<usize, (String, i64)> =
        std::collections::BTreeMap::new();
    sf_send(&mut stdin, &format!("go depth {}", depth.max(1))).await?;
    read_until(&mut reader, |line| {
        if let Some((idx, cp, mv)) = parse_multipv_line(line) {
            best.insert(idx, (mv, cp));
        }
        line.starts_with("bestmove")
    })
    .await?;
    let _ = sf_send(&mut stdin, "quit").await;

    // BTreeMap iterates by multipv index = Stockfish's best-first order.
    Ok(best.into_values().map(|(mv, cp)| (mv, cp)).collect())
}

/// Write one line (with newline) to a Stockfish process and flush.
pub(crate) async fn sf_send(stdin: &mut tokio::process::ChildStdin, cmd: &str) -> Result<(), String> {
    stdin
        .write_all(cmd.as_bytes())
        .await
        .map_err(|e| format!("stockfish write error: {e}"))?;
    stdin
        .write_all(b"\n")
        .await
        .map_err(|e| format!("stockfish write error: {e}"))?;
    stdin
        .flush()
        .await
        .map_err(|e| format!("stockfish flush error: {e}"))?;
    Ok(())
}

/// Read lines until `predicate` matches, bounded by a generous timeout so a hung
/// engine can't wedge a move forever.
pub(crate) async fn read_until<R, F>(reader: &mut BufReader<R>, mut predicate: F) -> Result<(), String>
where
    R: tokio::io::AsyncRead + Unpin,
    F: FnMut(&str) -> bool,
{
    let fut = async {
        let mut line = String::new();
        loop {
            line.clear();
            let n = reader
                .read_line(&mut line)
                .await
                .map_err(|e| format!("stockfish read error: {e}"))?;
            if n == 0 {
                return Err("stockfish exited unexpectedly".to_string());
            }
            if predicate(line.trim()) {
                return Ok(());
            }
        }
    };
    match timeout(Duration::from_secs(30), fut).await {
        Ok(res) => res,
        Err(_) => Err("stockfish timed out".to_string()),
    }
}

// ---------------------------------------------------------------------------
// Rival opening book
// ---------------------------------------------------------------------------

/// Locate the rival book JSON (built by scripts/persona/build_rival_book.py):
/// explicit override, the app data dir, then the dev repo's data/rivals. The
/// book is gitignored and never bundled — dad's games stay local (spec 214).
fn rival_book_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Ok(p) = std::env::var("SPAR_RIVAL_BOOK") {
        let pb = PathBuf::from(p);
        if pb.exists() {
            return Some(pb);
        }
    }
    if let Ok(dir) = app.path().app_data_dir() {
        let pb = dir.join("rivals").join("dad_book.json");
        if pb.exists() {
            return Some(pb);
        }
    }
    // Dev checkout: src-tauri → apps/desktop → apps → repo root (the pre-
    // monorepo single ".." pointed at apps/desktop/data, which doesn't exist).
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .join("data")
        .join("rivals")
        .join("dad_book.json");
    if dev.exists() {
        return Some(dev);
    }
    None
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Sample a human-like move for `fen` from the Maia net at `level`. `go nodes 1`
/// policy read (via maia.rs), then temperature-1 sampling. Returns the move as
/// UCI + SAN. Errors (no lc0, terminal position, bad level) come back as strings
/// so the UI can degrade.
#[tauri::command]
pub async fn maia_move(
    app: tauri::AppHandle,
    state: State<'_, MaiaState>,
    fen: String,
    level: u32,
) -> Result<PersonaMove, String> {
    let policy = maia::query_policy(&app, state.inner(), &fen, level).await?;
    let uci = sample_policy_move(&policy.moves, POLICY_FLOOR, uniform01())
        .ok_or("Maia returned no legal moves (terminal position)")?;
    let san = san_for(&fen, &uci)?;
    Ok(PersonaMove { uci, san })
}

/// The out-of-book selection core (contract steps 3+4+6+9), given an
/// already-fetched `policy` and a per-move `derived_seed`. Shared by the spar
/// `persona_move` command and the match runner's persona arm so both surfaces
/// select moves through the exact same pipeline (spec 218: the persona arm
/// CONSUMES this contract, never redefines it). `stockfish` is the resolved
/// verification engine (`None` degrades to pure tempered policy and disables
/// the endgame arm). `ctx` carries the step-3 schedule/style knobs and the
/// step-6 endgame arm; `SelectContext::default()` = persona engine v1
/// behavior. See the module's persona-engine section for the reweight
/// semantics.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn select_move_from_policy(
    fen: &str,
    policy: &MaiaPolicy,
    alpha: f64,
    lambda: f64,
    temperature: f64,
    top_k: Option<usize>,
    top_p: Option<f64>,
    verify_depth: Option<u32>,
    derived_seed: u64,
    stockfish: Option<&Path>,
    ctx: &SelectContext,
) -> Result<PersonaDecision, String> {
    let u = uniform_from_seed(derived_seed);

    // Parse once: phase detection (steps 3+6) and style classification share it.
    let pos: Chess = Fen::from_ascii(fen.as_bytes())
        .map_err(|e| format!("bad FEN: {e}"))?
        .into_position(CastlingMode::Standard)
        .map_err(|e| format!("illegal position: {e}"))?;
    let pw = phase_weight_of(&pos);
    let phase = phase_for(pw, ctx.ply);
    let eff_temp = effective_temperature(temperature, ctx.schedule.as_ref(), phase, ctx.clock_ms);
    let bias_live = style_bias_active(ctx.style_bias.as_ref(), ctx.plies_since_book_exit);

    // Endgame arm (step 6): at low material the candidate source switches to
    // deep fixed-depth Stockfish top-k, humanized through the SAME reweight —
    // priors come from the Maia policy (floor for policy-unseen moves), the
    // MultiPV evals double as the verification evals. Any Stockfish failure
    // degrades to the normal policy arm below rather than erroring the move.
    if let (Some(arm), Some(sf)) = (ctx.endgame.as_ref(), stockfish) {
        if arm.depth > 0 && pw <= arm.phase_max {
            if let Ok(top) = sf_top_moves(sf, fen, arm.top_k, arm.depth).await {
                if !top.is_empty() {
                    let mut probs: Vec<f64> = top
                        .iter()
                        .map(|(uci, _)| {
                            policy
                                .moves
                                .iter()
                                .find(|m| m.uci == *uci)
                                .map(|m| m.prob.max(ENDGAME_UNSEEN_PRIOR))
                                .unwrap_or(ENDGAME_UNSEEN_PRIOR)
                        })
                        .collect();
                    let ucis: Vec<&str> = top.iter().map(|(uci, _)| uci.as_str()).collect();
                    let bias_applied = bias_live
                        && apply_style_bias(&pos, &ucis, &mut probs, ctx.style_bias.as_ref().unwrap());
                    let best = top.iter().map(|(_, cp)| *cp).max().unwrap_or(0);
                    let penalties: Vec<f64> = top
                        .iter()
                        .map(|(_, cp)| ((best - cp) as f64 / 100.0).max(0.0))
                        .collect();
                    let mut weights = reweight(&probs, &penalties, alpha, lambda, eff_temp);
                    // Error model (step 5): the MultiPV evals are the eval
                    // evidence; best candidate eval = eval before the move.
                    let (em_applied, em_rate) = consult_error_model(
                        ctx.error_model.as_ref(),
                        &mut weights,
                        &penalties,
                        Some(best),
                        phase,
                        ctx.clock_ms,
                    );
                    let idx = sample_weighted(&weights, u);
                    let candidates: Vec<PersonaCandidate> = top
                        .iter()
                        .enumerate()
                        .map(|(i, (uci, cp))| PersonaCandidate {
                            uci: uci.clone(),
                            san: san_for(fen, uci).unwrap_or_default(),
                            // The prior that actually drove the choice (policy
                            // prob, floored/biased) — honest decision-log value.
                            policy_prob: probs[i],
                            eval_cp: Some(*cp),
                            eval_penalty: penalties[i],
                            weight: weights[i],
                        })
                        .collect();
                    let chosen = &top[idx].0;
                    let san = san_for(fen, chosen)?;
                    // Reason arm "error-model" (contract step 9) when the mix
                    // was live AND it timed a mistake here (the chosen move is
                    // in the mistake branch); otherwise the arm that supplied
                    // the candidates keeps the credit.
                    let drop_pawns = ctx
                        .error_model
                        .as_ref()
                        .map(|em| em.mistake_drop_cp as f64 / 100.0)
                        .unwrap_or(f64::INFINITY);
                    let reason = if em_applied && penalties[idx] >= drop_pawns {
                        "error-model"
                    } else {
                        "endgame"
                    };
                    return Ok(PersonaDecision {
                        uci: chosen.clone(),
                        san,
                        reason: reason.to_string(),
                        band: policy.band,
                        derived_seed,
                        phase: phase.label().to_string(),
                        temperature: eff_temp,
                        style_bias_applied: bias_applied,
                        error_model_applied: em_applied,
                        mistake_rate: em_rate,
                        candidates,
                    });
                }
            }
        }
    }

    let cands = select_candidates(&policy.moves, POLICY_FLOOR, top_k, top_p);
    if cands.is_empty() {
        return Err("Maia returned no legal moves (terminal position)".to_string());
    }

    // Verification reweight (step 4). Skipped when disabled, unavailable, or when
    // there's nothing to choose between — pure tempered policy in those cases.
    let mut penalties = vec![0.0f64; cands.len()];
    let mut eval_cps: Vec<Option<i64>> = vec![None; cands.len()];
    let mut reason = "policy";
    let verify_on = verify_depth.is_some_and(|d| d > 0) && cands.len() > 1;
    if verify_on {
        if let Some(sf) = stockfish {
            let depth = verify_depth.unwrap();
            if let Ok(values) = verify_candidates(sf, fen, &cands, depth).await {
                let best = values.iter().copied().max().unwrap_or(0);
                for (i, v) in values.iter().enumerate() {
                    eval_cps[i] = Some(*v);
                    penalties[i] = ((best - v) as f64 / 100.0).max(0.0);
                }
                reason = "verify-reweight";
            }
            // A verification failure silently degrades to policy-only.
        }
    }

    // Post-book style-bias window (step 3): overweight matching candidates'
    // priors while leaving theory. OFF unless configured AND inside the window.
    let mut probs: Vec<f64> = cands.iter().map(|m| m.prob).collect();
    let ucis: Vec<&str> = cands.iter().map(|m| m.uci.as_str()).collect();
    let bias_applied =
        bias_live && apply_style_bias(&pos, &ucis, &mut probs, ctx.style_bias.as_ref().unwrap());

    let mut weights = reweight(&probs, &penalties, alpha, lambda, eff_temp);
    // Error model (step 5): live only with verification evidence — the best
    // candidate's mover-POV eval stands in for the eval before the move.
    let eval_before = eval_cps.iter().flatten().max().copied();
    let (em_applied, em_rate) = consult_error_model(
        ctx.error_model.as_ref(),
        &mut weights,
        &penalties,
        eval_before,
        phase,
        ctx.clock_ms,
    );
    let idx = sample_weighted(&weights, u);

    let candidates: Vec<PersonaCandidate> = cands
        .iter()
        .enumerate()
        .map(|(i, m)| PersonaCandidate {
            uci: m.uci.clone(),
            san: san_for(fen, &m.uci).unwrap_or_default(),
            // The prior that drove the choice (biased when the window fired).
            policy_prob: probs[i],
            eval_cp: eval_cps[i],
            eval_penalty: penalties[i],
            weight: weights[i],
        })
        .collect();

    let chosen = &cands[idx];
    let san = san_for(fen, &chosen.uci)?;
    // Reason arm "error-model" (contract step 9) when the mix was live AND it
    // timed a mistake here (the chosen move is in the mistake branch).
    let drop_pawns = ctx
        .error_model
        .as_ref()
        .map(|em| em.mistake_drop_cp as f64 / 100.0)
        .unwrap_or(f64::INFINITY);
    if em_applied && penalties[idx] >= drop_pawns {
        reason = "error-model";
    }
    Ok(PersonaDecision {
        uci: chosen.uci.clone(),
        san,
        reason: reason.to_string(),
        band: policy.band,
        derived_seed,
        phase: phase.label().to_string(),
        temperature: eff_temp,
        style_bias_applied: bias_applied,
        error_model_applied: em_applied,
        mistake_rate: em_rate,
        candidates,
    })
}

/// Persona engine v1 (spec 214 contract steps 3+4+8+9): pick an out-of-book move
/// for `fen` by seeded sampling from the Maia policy with a Stockfish
/// verification reweight, and return the full per-move decision log. See the
/// module's persona-engine section for the exact reweight semantics. Errors
/// (no lc0, terminal position, bad params) come back as strings so the UI can
/// degrade; a missing/failed Stockfish degrades to policy-only (reason "policy")
/// rather than erroring.
#[tauri::command]
pub async fn persona_move(
    app: tauri::AppHandle,
    state: State<'_, MaiaState>,
    fen: String,
    params: PersonaParams,
) -> Result<PersonaDecision, String> {
    let derived = derive_seed(params.seed, params.ply);
    let policy = maia::query_policy(&app, state.inner(), &fen, params.level).await?;
    let stockfish = resolve_stockfish();
    let ctx = SelectContext {
        ply: params.ply,
        clock_ms: params.clock_ms,
        plies_since_book_exit: params.plies_since_book_exit,
        schedule: params.schedule.clone(),
        style_bias: params.style_bias.clone(),
        endgame: params.endgame.clone(),
        error_model: params.error_model.clone(),
    };
    select_move_from_policy(
        &fen,
        &policy,
        params.alpha,
        params.lambda,
        params.temperature,
        params.top_k,
        params.top_p,
        params.verify_depth,
        derived,
        stockfish.as_deref(),
        &ctx,
    )
    .await
}

/// Locate the local rivals dir (gitignored, never bundled — spec 214): the app
/// data dir first, then the dev repo's data/rivals. None when neither exists.
/// (pub(crate): player_profile.rs reads profiles/writes plans in the same dir.)
pub(crate) fn rivals_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Ok(dir) = app.path().app_data_dir() {
        let d = dir.join("rivals");
        if d.is_dir() {
            return Some(d);
        }
    }
    // Dev checkout: src-tauri → apps/desktop → apps → repo root (the pre-
    // monorepo single ".." pointed at apps/desktop/data, which doesn't exist).
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .join("data")
        .join("rivals");
    if dev.is_dir() {
        return Some(dev);
    }
    None
}

/// Every locally-present private-rival persona, as `{ config, book|null }`
/// pairs — one per data/rivals/<slug>.config.json, with the matching
/// <slug>.book.json when it exists. Returns `[]` (not an error) when the dir
/// or configs are absent: private personas stay local and their absence is a
/// normal state, never an error (spec 214/218 hard rule). Unparseable files
/// are skipped for the same reason.
#[tauri::command]
pub fn rival_personas(app: tauri::AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let Some(dir) = rivals_dir(&app) else {
        return Ok(Vec::new());
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(Vec::new());
    };
    let mut paths: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.ends_with(".config.json"))
        })
        .collect();
    paths.sort();
    let mut out = Vec::new();
    for path in paths {
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(config) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        // The book lives next to its config as <slug>.book.json; the slug is
        // used as a bare file stem only (no separators), never a path.
        let book = config
            .get("slug")
            .and_then(|s| s.as_str())
            .filter(|slug| !slug.contains('/') && !slug.contains('\\'))
            .and_then(|slug| {
                let text = std::fs::read_to_string(dir.join(format!("{slug}.book.json"))).ok()?;
                serde_json::from_str::<serde_json::Value>(&text).ok()
            })
            .unwrap_or(serde_json::Value::Null);
        out.push(serde_json::json!({ "config": config, "book": book }));
    }
    Ok(out)
}

/// The rival opening book as parsed JSON, or an error if it hasn't been built.
/// The UI samples a starting line from it (spec 214, Tier 0).
#[tauri::command]
pub fn rival_book(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let path = rival_book_path(&app).ok_or(
        "rival book not found — run scripts/persona/build_rival_book.py to build data/rivals/dad_book.json",
    )?;
    let text = std::fs::read_to_string(&path).map_err(|e| format!("reading {path:?}: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("parsing {path:?}: {e}"))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn mv(uci: &str, prob: f64) -> MaiaMove {
        MaiaMove {
            uci: uci.to_string(),
            prob,
        }
    }

    #[test]
    fn samples_across_the_distribution_by_cumulative_mass() {
        // e2e4 .50, d2d4 .30, g1f3 .15, b1a3 .04, a2a3 .01. Floor .05 drops the
        // last two (both < .05); kept mass = .95. `u` scales by that total, so
        // the cumulative cut points are e4 [0,.5), d4 [.5,.8), Nf3 [.8,.95).
        let policy = vec![
            mv("e2e4", 0.50),
            mv("d2d4", 0.30),
            mv("g1f3", 0.15),
            mv("b1a3", 0.04),
            mv("a2a3", 0.01),
        ];
        // u=0 -> first move.
        assert_eq!(sample_policy_move(&policy, 0.05, 0.0).unwrap(), "e2e4");
        // target = .49 * .95 = .4655 -> still e4.
        assert_eq!(sample_policy_move(&policy, 0.05, 0.49).unwrap(), "e2e4");
        // target = .6 * .95 = .57 -> into d4's band.
        assert_eq!(sample_policy_move(&policy, 0.05, 0.6).unwrap(), "d2d4");
        // Near the top -> last kept move (Nf3); the floored moves never appear.
        assert_eq!(sample_policy_move(&policy, 0.05, 0.999).unwrap(), "g1f3");
    }

    #[test]
    fn floored_moves_are_never_selected() {
        let policy = vec![mv("e2e4", 0.98), mv("a2a3", 0.02), mv("h2h3", 0.0)];
        // Sweep u across [0,1): h2h3 (below floor) must never come back.
        for i in 0..1000 {
            let u = i as f64 / 1000.0;
            let chosen = sample_policy_move(&policy, 0.01, u).unwrap();
            assert_ne!(chosen, "h2h3", "a 0%-policy move should never be sampled");
        }
    }

    #[test]
    fn floor_removing_everything_falls_back_to_all_moves() {
        // All below the floor -> keep them all rather than return None.
        let policy = vec![mv("e2e4", 0.005), mv("d2d4", 0.004)];
        let chosen = sample_policy_move(&policy, 0.5, 0.0);
        assert_eq!(chosen.unwrap(), "e2e4");
    }

    #[test]
    fn empty_policy_returns_none() {
        assert!(sample_policy_move(&[], 0.01, 0.5).is_none());
    }

    #[test]
    fn san_for_renders_from_start_position() {
        let start = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
        assert_eq!(san_for(start, "e2e4").unwrap(), "e4");
        assert_eq!(san_for(start, "g1f3").unwrap(), "Nf3");
        assert!(san_for(start, "e2e5").is_err(), "illegal move should error");
    }

    #[test]
    fn uniform01_stays_in_unit_interval() {
        for _ in 0..10_000 {
            let u = uniform01();
            assert!((0.0..1.0).contains(&u), "u out of range: {u}");
        }
    }

    // -- Persona engine v1 (contract steps 3, 4, 8, 9) ----------------------

    #[test]
    fn derived_seed_is_deterministic_and_ply_dependent() {
        // Step 8: same (seed, ply) reproduces the same draw; different plies of
        // the same game decorrelate (spot check across a run of plies).
        assert_eq!(derive_seed(214215, 7), derive_seed(214215, 7));
        assert_eq!(uniform_from_seed(derive_seed(214215, 7)),
                   uniform_from_seed(derive_seed(214215, 7)));
        let us: Vec<f64> = (0..64)
            .map(|ply| uniform_from_seed(derive_seed(214215, ply)))
            .collect();
        // All in range and not a constant.
        assert!(us.iter().all(|u| (0.0..1.0).contains(u)));
        assert!(us.windows(2).any(|w| (w[0] - w[1]).abs() > 1e-9),
                "consecutive plies should not all collide");
        // A different game seed gives a different stream.
        assert_ne!(derive_seed(214215, 7), derive_seed(999, 7));
    }

    #[test]
    fn select_candidates_top_k_caps_after_flooring_and_sorting() {
        let moves = vec![
            mv("e2e4", 0.40),
            mv("d2d4", 0.30),
            mv("g1f3", 0.15),
            mv("c2c4", 0.10),
            mv("b1a3", 0.005), // below the 0.01 floor -> dropped
        ];
        let got = select_candidates(&moves, 0.01, Some(3), None);
        assert_eq!(
            got.iter().map(|m| m.uci.as_str()).collect::<Vec<_>>(),
            vec!["e2e4", "d2d4", "g1f3"],
            "sorted by prob desc, floored tail dropped, capped at k"
        );
    }

    #[test]
    fn select_candidates_top_p_takes_the_nucleus() {
        let moves = vec![
            mv("e2e4", 0.50),
            mv("d2d4", 0.30),
            mv("g1f3", 0.15),
            mv("c2c4", 0.05),
        ];
        // Nucleus 0.75 of total mass (=1.0): e4(.50)+d4(.30)=.80 >= .75 -> two.
        let got = select_candidates(&moves, 0.0, None, Some(0.75));
        assert_eq!(
            got.iter().map(|m| m.uci.as_str()).collect::<Vec<_>>(),
            vec!["e2e4", "d2d4"]
        );
    }

    #[test]
    fn select_candidates_floor_removing_everything_keeps_all() {
        let moves = vec![mv("e2e4", 0.006), mv("d2d4", 0.004)];
        let got = select_candidates(&moves, 0.5, Some(4), None);
        assert_eq!(got.len(), 2, "floor emptying the set falls back to all moves");
    }

    #[test]
    fn reweight_pure_policy_matches_tempered_softmax() {
        // No penalties, alpha=1, T=1 -> weights are just the renormalized policy.
        let policy = vec![0.5, 0.3, 0.2];
        let (_idx, w) = reweight_and_sample(&policy, &[0.0; 3], 1.0, 0.0, 1.0, 0.0);
        let sum: f64 = w.iter().sum();
        assert!((sum - 1.0).abs() < 1e-9);
        for (got, want) in w.iter().zip(policy.iter()) {
            assert!((got - want).abs() < 1e-9, "got {got}, want {want}");
        }
    }

    #[test]
    fn reweight_suppresses_a_policy_favored_blunder() {
        // The policy loves move 0 (0.7) but the verification says it hangs a queen
        // (9-pawn penalty); with lambda high its final weight must collapse.
        let policy = vec![0.70, 0.20, 0.10];
        let penalties = vec![9.0, 0.0, 0.0]; // pawns behind best
        let (_idx, w) = reweight_and_sample(&policy, &penalties, 1.0, 1.5, 0.5, 0.0);
        assert!(w[0] < 1e-3, "the blundering move should be all but unreachable, got {}", w[0]);
        assert!(w[1] > w[2], "the higher-policy sound move leads");
        // Sweep the unit interval: the blunder's mass is negligible. It is a
        // policy candidate (top-k by policy includes it), so verification can only
        // down-weight it, not hard-exclude it the way visit-count top-K would — a
        // vanishing slice of u still maps to it, but essentially never.
        let picks_blunder = (0..1000)
            .filter(|i| reweight_and_sample(&policy, &penalties, 1.0, 1.5, 0.5, *i as f64 / 1000.0).0 == 0)
            .count();
        assert!(picks_blunder <= 1, "queen-hang sampled {picks_blunder}/1000 — not negligible");
    }

    #[test]
    fn reweight_is_deterministic_for_fixed_u() {
        let policy = vec![0.4, 0.35, 0.25];
        let penalties = vec![0.0, 0.5, 1.0];
        let a = reweight_and_sample(&policy, &penalties, 0.8, 1.0, 0.6, 0.42);
        let b = reweight_and_sample(&policy, &penalties, 0.8, 1.0, 0.6, 0.42);
        assert_eq!(a.0, b.0, "same inputs + same u must pick the same index");
        assert_eq!(a.1, b.1);
    }

    #[test]
    fn reweight_low_temperature_sharpens_to_argmax() {
        // T -> small collapses onto the best combined-logit move; here move 1 is
        // the best (penalty 0 and decent policy), so most of the interval maps to it.
        let policy = vec![0.45, 0.40, 0.15];
        let penalties = vec![0.6, 0.0, 0.0];
        let (_idx, w) = reweight_and_sample(&policy, &penalties, 1.0, 2.0, 0.05, 0.0);
        let best = w.iter().cloned().fold(0.0, f64::max);
        assert!(best > 0.95, "cold temperature should concentrate mass, got {w:?}");
        assert!(w[1] > w[0] && w[1] > w[2]);
    }

    #[test]
    fn parse_score_cp_reads_cp_and_mate() {
        assert_eq!(parse_score_cp("info depth 12 score cp -34 nodes 1000 pv e2e4"), Some(-34));
        // Mate in +3 for the side to move maps to a large positive magnitude.
        assert_eq!(parse_score_cp("info depth 20 score mate 3 pv a1a8"), Some(MATE_CP - 3));
        assert_eq!(parse_score_cp("info depth 20 score mate -2 pv a1a8"), Some(-MATE_CP + 2));
        assert_eq!(parse_score_cp("info string no score here"), None);
    }

    #[test]
    fn fen_after_advances_the_position() {
        let start = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
        let after = fen_after(start, "e2e4").unwrap();
        // Black to move, e-pawn on e4, en-passant square e3.
        assert!(after.starts_with("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b"),
                "unexpected FEN: {after}");
        assert!(fen_after(start, "e2e5").is_err(), "illegal move should error");
    }

    // -- Phase detection + temperature schedule (contract step 3) -----------

    const START: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    // K+R+3P vs K+R+2P: phase weight 2+2 = 4 <= 8 -> endgame.
    const ENDGAME_FEN: &str = "8/5pk1/6p1/8/8/1r3P2/R5PP/6K1 w - - 0 40";

    fn pos_of(fen: &str) -> Chess {
        Fen::from_ascii(fen.as_bytes())
            .unwrap()
            .into_position(CastlingMode::Standard)
            .unwrap()
    }

    #[test]
    fn phase_weight_matches_calibration_formula() {
        // Standard start: 4 minors x1 + 4 rooks x2 + 2 queens x4 = 24.
        assert_eq!(phase_weight_of(&pos_of(START)), 24);
        // Rook endgame: two rooks -> 4.
        assert_eq!(phase_weight_of(&pos_of(ENDGAME_FEN)), 4);
    }

    #[test]
    fn phase_for_splits_opening_middlegame_endgame() {
        // Full material: ply decides opening vs middlegame at OPENING_MAX_PLY.
        assert_eq!(phase_for(24, 0), Phase::Opening);
        assert_eq!(phase_for(24, 15), Phase::Opening);
        assert_eq!(phase_for(24, 16), Phase::Middlegame);
        // Low material is an endgame regardless of ply (early queen-trade grind).
        assert_eq!(phase_for(8, 10), Phase::Endgame);
        assert_eq!(phase_for(0, 90), Phase::Endgame);
        assert_eq!(phase_for(9, 40), Phase::Middlegame);
    }

    #[test]
    fn effective_temperature_scales_by_phase_and_clock() {
        let s = TemperatureSchedule::default();
        // No schedule -> flat base (persona engine v1 behavior).
        assert_eq!(effective_temperature(0.5, None, Phase::Middlegame, None), 0.5);
        // Phase multipliers, unclocked (the spar loop today).
        assert_eq!(effective_temperature(0.5, Some(&s), Phase::Opening, None), 0.5 * 0.6);
        assert_eq!(effective_temperature(0.5, Some(&s), Phase::Middlegame, None), 0.5);
        assert_eq!(effective_temperature(0.5, Some(&s), Phase::Endgame, None), 0.5 * 0.8);
        // Clock pressure spikes: <=30s low-time, <=10s panic (contract step 3).
        assert_eq!(
            effective_temperature(0.5, Some(&s), Phase::Middlegame, Some(29_000)),
            0.5 * 1.5
        );
        assert_eq!(
            effective_temperature(0.5, Some(&s), Phase::Middlegame, Some(9_000)),
            0.5 * 2.25
        );
        // Ample time -> no spike.
        assert_eq!(
            effective_temperature(0.5, Some(&s), Phase::Middlegame, Some(120_000)),
            0.5
        );
        // Clamped at both ends.
        assert_eq!(effective_temperature(0.01, Some(&s), Phase::Opening, None), 0.05);
        assert_eq!(
            effective_temperature(2.0, Some(&s), Phase::Middlegame, Some(1_000)),
            3.0
        );
    }

    // -- Style-bias window (contract step 3, OFF by default) ----------------

    fn bias(window: u32, mult: f64, types: &[&str]) -> StyleBias {
        StyleBias {
            window_plies: window,
            multiplier: mult,
            move_types: types.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn style_bias_window_gates_correctly() {
        let b = bias(4, 1.5, &["capture"]);
        // Inside the window.
        assert!(style_bias_active(Some(&b), Some(0)));
        assert!(style_bias_active(Some(&b), Some(3)));
        // At/after the window edge.
        assert!(!style_bias_active(Some(&b), Some(4)));
        // Book state unknown -> never fires (honest default).
        assert!(!style_bias_active(Some(&b), None));
        // No bias configured -> OFF.
        assert!(!style_bias_active(None, Some(0)));
        // Neutral multiplier or empty types -> a no-op, treated as OFF.
        assert!(!style_bias_active(Some(&bias(4, 1.0, &["capture"])), Some(0)));
        assert!(!style_bias_active(Some(&bias(4, 1.5, &[])), Some(0)));
    }

    #[test]
    fn move_classification_covers_the_v1_types() {
        // Italian-ish position with a capturable pawn on e5 and castling ready.
        let fen = "r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4";
        let pos = pos_of(fen);
        let t = |s: &str| vec![s.to_string()];
        assert!(move_matches_types(&pos, "f3e5", &t("capture"))); // Nxe5
        assert!(move_matches_types(&pos, "e1g1", &t("castle"))); // O-O
        assert!(move_matches_types(&pos, "c4f7", &t("check"))); // Bxf7+ (also a capture)
        assert!(move_matches_types(&pos, "d2d4", &t("pawn_push")));
        assert!(move_matches_types(&pos, "b1c3", &t("quiet_piece")));
        // Non-matches.
        assert!(!move_matches_types(&pos, "d2d4", &t("capture")));
        assert!(!move_matches_types(&pos, "f3e5", &t("pawn_push")));
        assert!(!move_matches_types(&pos, "b1c3", &t("check")));
        // Unknown labels and garbage UCI fail quiet.
        assert!(!move_matches_types(&pos, "d2d4", &t("brilliancy")));
        assert!(!move_matches_types(&pos, "zz99", &t("capture")));
    }

    #[test]
    fn apply_style_bias_overweights_matching_candidates_only() {
        let fen = "r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4";
        let pos = pos_of(fen);
        let b = bias(4, 2.0, &["capture"]);
        let ucis = vec!["f3e5", "d2d4", "b1c3"];
        let mut probs = vec![0.2, 0.5, 0.3];
        let any = apply_style_bias(&pos, &ucis, &mut probs, &b);
        assert!(any);
        assert_eq!(probs, vec![0.4, 0.5, 0.3], "only the capture doubled");
        // No candidate matches -> untouched, reports false.
        let mut probs2 = vec![0.5, 0.5];
        let any2 = apply_style_bias(&pos, &["d2d4", "b1c3"], &mut probs2, &b);
        assert!(!any2);
        assert_eq!(probs2, vec![0.5, 0.5]);
    }

    // -- Corpus error model (contract step 5, gated via the tuner) -----------

    fn em_with(cells: &[(&str, f64)]) -> ErrorModel {
        ErrorModel {
            cells: cells.iter().map(|(k, v)| (k.to_string(), *v)).collect(),
            rate_scale: default_rate_scale(),
            mistake_drop_cp: default_mistake_drop_cp(),
            eval_bucket_cp: default_eval_bucket_cp(),
            eval_clamp_cp: default_eval_clamp_cp(),
        }
    }

    #[test]
    fn error_model_bucket_labels_match_the_corpus_convention() {
        // Mirrors scripts/mining/error_model.py eval_bucket/clock_bucket and
        // persona_sim.py's port — all four stay in sync.
        let em = em_with(&[]);
        assert_eq!(em.eval_bucket_label(0), "+0.0");
        assert_eq!(em.eval_bucket_label(49), "+0.0");
        assert_eq!(em.eval_bucket_label(50), "+0.5");
        assert_eq!(em.eval_bucket_label(-1), "-0.5"); // floor, not trunc
        assert_eq!(em.eval_bucket_label(-500), "-5.0");
        assert_eq!(em.eval_bucket_label(-9999), "-5.0"); // clamp low
        assert_eq!(em.eval_bucket_label(9999), "+4.5"); // clamp high
        assert_eq!(clock_bucket_label(None), "none");
        assert_eq!(clock_bucket_label(Some(600_000)), "600plus");
        assert_eq!(clock_bucket_label(Some(599_000)), "300-600");
        assert_eq!(clock_bucket_label(Some(29_000)), "lt30");
        assert_eq!(clock_bucket_label(Some(0)), "lt30");
    }

    #[test]
    fn error_model_rate_lookup_scales_and_clamps() {
        let mut em = em_with(&[("middlegame|+0.0|none", 0.05)]);
        em.rate_scale = 2.0;
        assert_eq!(em.mistake_rate(Phase::Middlegame, 10, None), Some(0.1));
        // Uncovered cells stay silent — wrong phase, or a clocked bucket.
        assert_eq!(em.mistake_rate(Phase::Endgame, 10, None), None);
        assert_eq!(em.mistake_rate(Phase::Middlegame, 10, Some(5_000)), None);
        // Scale can never push a rate past 1.
        em.rate_scale = 30.0;
        assert_eq!(em.mistake_rate(Phase::Middlegame, 10, None), Some(1.0));
    }

    #[test]
    fn apply_error_model_mix_reassigns_branch_mass() {
        // Candidate 2 is the only mistake (>= 1.0 pawn behind): rate 0.3 puts
        // exactly 0.3 there; the sound branch keeps its internal shape.
        let mut w = vec![0.7, 0.2, 0.1];
        let applied = apply_error_model_mix(&mut w, &[0.0, 0.0, 2.0], 0.3, 1.0);
        assert!(applied);
        assert!((w[2] - 0.3).abs() < 1e-12);
        assert!((w[0] - 0.7 * 0.7 / 0.9).abs() < 1e-12);
        assert!((w[1] - 0.2 * 0.7 / 0.9).abs() < 1e-12);
        assert!((w.iter().sum::<f64>() - 1.0).abs() < 1e-12);
    }

    #[test]
    fn apply_error_model_mix_needs_both_branches() {
        // No mistake candidate / only mistakes / zero rate: untouched, false.
        let base = vec![0.6, 0.4];
        let mut w = base.clone();
        assert!(!apply_error_model_mix(&mut w, &[0.0, 0.5], 0.3, 1.0));
        assert_eq!(w, base);
        let mut w = base.clone();
        assert!(!apply_error_model_mix(&mut w, &[1.5, 2.5], 0.3, 1.0));
        assert_eq!(w, base);
        let mut w = base.clone();
        assert!(!apply_error_model_mix(&mut w, &[0.0, 2.5], 0.0, 1.0));
        assert_eq!(w, base);
    }

    #[test]
    fn consult_error_model_requires_eval_evidence() {
        // No eval before (verification never ran) -> silent even when the
        // model covers the cell; covered cell + evidence -> rate logged.
        let em = em_with(&[("middlegame|+0.0|none", 0.5)]);
        let mut w = vec![0.7, 0.3];
        let pen = vec![0.0, 2.0];
        let (applied, rate) =
            consult_error_model(Some(&em), &mut w, &pen, None, Phase::Middlegame, None);
        assert!(!applied);
        assert_eq!(rate, None);
        assert_eq!(w, vec![0.7, 0.3]);
        let (applied, rate) =
            consult_error_model(Some(&em), &mut w, &pen, Some(10), Phase::Middlegame, None);
        assert!(applied);
        assert_eq!(rate, Some(0.5));
        assert!((w[1] - 0.5).abs() < 1e-12, "mistake branch got the rate");
        // No model at all (the default everywhere) -> silent.
        let mut w2 = vec![0.7, 0.3];
        let (applied, rate) =
            consult_error_model(None, &mut w2, &pen, Some(10), Phase::Middlegame, None);
        assert!(!applied);
        assert_eq!(rate, None);
    }

    #[tokio::test]
    async fn core_error_model_is_off_by_default_and_inert_without_evals() {
        // Default context (no model): fields honestly report OFF.
        let policy = fake_policy(vec![mv("e2e4", 0.6), mv("d2d4", 0.4)]);
        let d = select_move_from_policy(
            START, &policy, 1.0, 0.75, 0.5, Some(4), None, None, 42, None,
            &SelectContext::default(),
        )
        .await
        .unwrap();
        assert!(!d.error_model_applied);
        assert_eq!(d.mistake_rate, None);

        // Model configured but NO stockfish -> no eval evidence -> the model
        // must stay silent (never guess an eval bucket), and the decision is
        // bit-identical to the model-free one.
        let ctx = SelectContext {
            error_model: Some(em_with(&[("opening|+0.0|none", 0.9)])),
            ..Default::default()
        };
        let d2 = select_move_from_policy(
            START, &policy, 1.0, 0.75, 0.5, Some(4), None, None, 42, None, &ctx,
        )
        .await
        .unwrap();
        assert!(!d2.error_model_applied);
        assert_eq!(d2.mistake_rate, None);
        assert_eq!(d2.uci, d.uci);
        assert_eq!(d2.reason, "policy");
    }

    // -- Endgame arm plumbing (contract step 6) ------------------------------

    #[test]
    fn parse_multipv_line_reads_index_score_and_first_pv_move() {
        assert_eq!(
            parse_multipv_line("info depth 16 multipv 2 score cp -13 nodes 9 pv e2e4 e7e5"),
            Some((2, -13, "e2e4".to_string()))
        );
        // MultiPV=1 output may omit the multipv token -> index 1.
        assert_eq!(
            parse_multipv_line("info depth 10 score cp 25 pv d2d4"),
            Some((1, 25, "d2d4".to_string()))
        );
        // Mate collapses to the MATE_CP magnitude.
        assert_eq!(
            parse_multipv_line("info depth 20 multipv 1 score mate 2 pv a1a8"),
            Some((1, MATE_CP - 2, "a1a8".to_string()))
        );
        // No score / no pv / not an info line -> None.
        assert_eq!(parse_multipv_line("info depth 3 multipv 1 pv e2e4"), None);
        assert_eq!(parse_multipv_line("info depth 3 multipv 1 score cp 5"), None);
        assert_eq!(parse_multipv_line("bestmove e2e4"), None);
    }

    // -- Shared core with the step-3 context (no engines needed) ------------

    fn fake_policy(moves: Vec<MaiaMove>) -> MaiaPolicy {
        MaiaPolicy {
            band: 1700,
            moves,
            value: None,
        }
    }

    #[tokio::test]
    async fn core_reports_phase_and_scheduled_temperature() {
        // Pure policy path (no stockfish, no verify): the decision must carry
        // the detected phase and the SCHEDULED effective temperature.
        let policy = fake_policy(vec![mv("e2e4", 0.6), mv("d2d4", 0.4)]);
        let ctx = SelectContext {
            ply: 2,
            schedule: Some(TemperatureSchedule::default()),
            ..Default::default()
        };
        let d = select_move_from_policy(
            START, &policy, 1.0, 0.75, 0.5, Some(4), None, None, 42, None, &ctx,
        )
        .await
        .unwrap();
        assert_eq!(d.phase, "opening");
        assert!((d.temperature - 0.3).abs() < 1e-12, "0.5 x 0.6 opening mult");
        assert_eq!(d.reason, "policy");
        assert!(!d.style_bias_applied);

        // Default context = v1 behavior: flat temperature, phase still reported.
        let d2 = select_move_from_policy(
            START, &policy, 1.0, 0.75, 0.5, Some(4), None, None, 42, None,
            &SelectContext::default(),
        )
        .await
        .unwrap();
        assert_eq!(d2.temperature, 0.5);
        assert_eq!(d2.phase, "opening");
    }

    #[tokio::test]
    async fn core_is_seed_deterministic_with_context() {
        let policy = fake_policy(vec![mv("e2e4", 0.4), mv("d2d4", 0.35), mv("g1f3", 0.25)]);
        let ctx = SelectContext {
            ply: 20,
            plies_since_book_exit: Some(1),
            schedule: Some(TemperatureSchedule::default()),
            style_bias: Some(bias(4, 2.0, &["pawn_push"])),
            ..Default::default()
        };
        let a = select_move_from_policy(
            START, &policy, 1.0, 0.75, 0.9, Some(4), None, None, 777, None, &ctx,
        )
        .await
        .unwrap();
        let b = select_move_from_policy(
            START, &policy, 1.0, 0.75, 0.9, Some(4), None, None, 777, None, &ctx,
        )
        .await
        .unwrap();
        assert_eq!(a, b, "same seed + same context = same decision, bit for bit");
        assert!(a.style_bias_applied, "pawn pushes exist among the candidates");
        assert_eq!(a.phase, "middlegame");
    }

    #[tokio::test]
    async fn style_bias_shifts_priors_in_the_decision_log() {
        // Two candidates, equal policy; biasing captures must overweight the
        // capture's logged prior and sampling weight, deterministically.
        let fen = "r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4";
        let policy = fake_policy(vec![mv("f3e5", 0.3), mv("d2d4", 0.3)]);
        let ctx = SelectContext {
            ply: 8,
            plies_since_book_exit: Some(0),
            style_bias: Some(bias(4, 3.0, &["capture"])),
            ..Default::default()
        };
        let d = select_move_from_policy(
            &fen, &policy, 1.0, 0.75, 1.0, Some(4), None, None, 5, None, &ctx,
        )
        .await
        .unwrap();
        assert!(d.style_bias_applied);
        let cap = d.candidates.iter().find(|c| c.uci == "f3e5").unwrap();
        let quiet = d.candidates.iter().find(|c| c.uci == "d2d4").unwrap();
        assert!((cap.policy_prob - 0.9).abs() < 1e-12, "0.3 x 3.0 bias");
        assert!((quiet.policy_prob - 0.3).abs() < 1e-12);
        assert!(cap.weight > quiet.weight);

        // One ply past the window: no bias, equal weights again.
        let ctx_out = SelectContext {
            plies_since_book_exit: Some(4),
            ..ctx.clone()
        };
        let d2 = select_move_from_policy(
            &fen, &policy, 1.0, 0.75, 1.0, Some(4), None, None, 5, None, &ctx_out,
        )
        .await
        .unwrap();
        assert!(!d2.style_bias_applied);
        let w: Vec<f64> = d2.candidates.iter().map(|c| c.weight).collect();
        assert!((w[0] - w[1]).abs() < 1e-12, "outside the window the bias is gone");
    }

    // Real Stockfish: the endgame arm end-to-end through the shared core with a
    // FAKE policy (no lc0 needed). Skips gracefully without a stockfish binary.
    #[tokio::test]
    async fn real_stockfish_endgame_arm_switches_candidate_source() {
        let Some(sf) = resolve_stockfish() else {
            eprintln!("SKIP real_stockfish_endgame_arm: stockfish not installed");
            return;
        };
        // Fake band policy that never saw the position: the arm's candidates
        // must come from Stockfish MultiPV, priors floored, reason "endgame".
        let policy = fake_policy(vec![mv("g1f1", 0.5), mv("h2h3", 0.5)]);
        let ctx = SelectContext {
            ply: 78,
            endgame: Some(EndgameArm {
                phase_max: ENDGAME_PHASE_MAX,
                depth: 10, // shallow: fast but exercises the full arm
                top_k: 3,
            }),
            schedule: Some(TemperatureSchedule::default()),
            ..Default::default()
        };
        let d = select_move_from_policy(
            ENDGAME_FEN, &policy, 1.0, 0.75, 0.5, Some(4), None, Some(12), 42, Some(sf.as_path()),
            &ctx,
        )
        .await
        .expect("endgame arm should select a move with real stockfish");
        assert_eq!(d.reason, "endgame");
        assert_eq!(d.phase, "endgame");
        assert!((d.temperature - 0.5 * 0.8).abs() < 1e-12, "endgame mult applied");
        assert!(!d.candidates.is_empty() && d.candidates.len() <= 3);
        for c in &d.candidates {
            assert!(c.eval_cp.is_some(), "MultiPV evals double as verification evals");
        }
        // Deterministic: the same seed + context reproduces the same choice
        // (same stockfish build; fixed depth).
        let d2 = select_move_from_policy(
            ENDGAME_FEN, &policy, 1.0, 0.75, 0.5, Some(4), None, Some(12), 42, Some(sf.as_path()),
            &ctx,
        )
        .await
        .unwrap();
        assert_eq!(d.uci, d2.uci);

        // Middlegame material: the arm must NOT engage (reason is verify/policy).
        let mg_policy = fake_policy(vec![mv("e2e4", 0.6), mv("d2d4", 0.4)]);
        let d3 = select_move_from_policy(
            START, &mg_policy, 1.0, 0.75, 0.5, Some(4), None, None, 42, Some(sf.as_path()), &ctx,
        )
        .await
        .unwrap();
        assert_ne!(d3.reason, "endgame");
        eprintln!(
            "real_stockfish_endgame_arm: chose {} ({}), candidates {:?}",
            d.san,
            d.uci,
            d.candidates.iter().map(|c| (c.uci.clone(), c.eval_cp)).collect::<Vec<_>>()
        );
    }

    // Real Stockfish. Skips gracefully (prints and returns) when no binary is
    // found, so `cargo test` stays green on a box without it — same discipline as
    // maia.rs's real_lc0 test. Exercises the verification half end-to-end: spawn,
    // handshake, per-candidate eval, score parse, and the mover-POV negation.
    #[tokio::test]
    async fn real_stockfish_verify_candidates_from_startpos() {
        let Some(sf) = resolve_stockfish() else {
            eprintln!("SKIP real_stockfish: stockfish not installed");
            return;
        };
        let start = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
        let cands = vec![mv("e2e4", 0.5), mv("d2d4", 0.3), mv("a2a3", 0.05)];
        let values = verify_candidates(&sf, start, &cands, 10)
            .await
            .expect("verify_candidates should succeed with real stockfish");
        assert_eq!(values.len(), cands.len());
        // Mover-POV (White) at shallow depth: the start position is near-equal, so
        // every candidate's eval sits in a sane centipawn band (never a mate code).
        for v in &values {
            assert!((-500..=500).contains(v), "startpos eval out of band: {v}");
        }
        eprintln!("real_stockfish: e4={} d4={} a3={}", values[0], values[1], values[2]);
    }
}
