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

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use shakmaty::fen::Fen;
use shakmaty::san::SanPlus;
use shakmaty::uci::UciMove;
use shakmaty::{CastlingMode, Chess, EnPassantMode, Position};
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
/// verification search evaluates for a candidate move.
fn fen_after(fen: &str, uci: &str) -> Result<String, String> {
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
// Persona engine v1 — spec 214 "move-selection contract" steps 3, 4, 8, 9.
//
// Out of book (the book phase lives in the TS frontend and is untouched) the
// persona picks a move by:
//   3. policy sampling — read the Maia band's human-move policy (maia.rs), trim
//      the noise tail (POLICY_FLOOR), and keep a candidate set (top-k count cap
//      or top-p nucleus).
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
const MATE_CP: i64 = 100_000;

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
    /// Which arm decided the move: "verify-reweight" when Stockfish verification
    /// ran, "policy" when it was skipped/unavailable (pure tempered policy).
    pub reason: String,
    /// Maia band the policy came from.
    pub band: u32,
    /// The per-move seed derived from (seed, ply); logged for reproducibility.
    pub derived_seed: u64,
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

/// Combined policy + verification softmax, temperature-scaled, then inverse-CDF
/// sampled with `u ∈ [0, 1)`. `penalties[i]` is pawns behind the best candidate
/// (all zero disables the eval term -> pure tempered policy). Returns the chosen
/// index and the normalized weights (for the decision log). Pure.
fn reweight_and_sample(
    policy: &[f64],
    penalties: &[f64],
    alpha: f64,
    lambda: f64,
    temperature: f64,
    u: f64,
) -> (usize, Vec<f64>) {
    let n = policy.len();
    debug_assert_eq!(n, penalties.len());
    if n == 0 {
        return (0, Vec::new());
    }
    let t = temperature.max(1e-6);
    let logits: Vec<f64> = (0..n)
        .map(|i| (alpha * policy[i].max(1e-12).ln() - lambda * penalties[i]) / t)
        .collect();
    let maxl = logits.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let exps: Vec<f64> = logits.iter().map(|l| (l - maxl).exp()).collect();
    let total: f64 = exps.iter().sum();
    let weights: Vec<f64> = if total > 0.0 && total.is_finite() {
        exps.iter().map(|e| e / total).collect()
    } else {
        vec![1.0 / n as f64; n]
    };

    let target = u.clamp(0.0, 1.0);
    let mut acc = 0.0;
    for (i, w) in weights.iter().enumerate() {
        acc += w;
        if target < acc {
            return (i, weights);
        }
    }
    (n - 1, weights)
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
/// carries no score.
fn parse_score_cp(line: &str) -> Option<i64> {
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

/// Write one line (with newline) to a Stockfish process and flush.
async fn sf_send(stdin: &mut tokio::process::ChildStdin, cmd: &str) -> Result<(), String> {
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
async fn read_until<R, F>(reader: &mut BufReader<R>, mut predicate: F) -> Result<(), String>
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
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
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

/// The out-of-book selection core (contract steps 3+4+9), given an
/// already-fetched `policy` and a per-move `derived_seed`. Shared by the spar
/// `persona_move` command and the match runner's persona arm so both surfaces
/// select moves through the exact same pipeline (spec 218: the persona arm
/// CONSUMES this contract, never redefines it). `stockfish` is the resolved
/// verification engine (`None` degrades to pure tempered policy). See the
/// module's persona-engine section for the reweight semantics.
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
) -> Result<PersonaDecision, String> {
    let u = uniform_from_seed(derived_seed);

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

    let probs: Vec<f64> = cands.iter().map(|m| m.prob).collect();
    let (idx, weights) =
        reweight_and_sample(&probs, &penalties, alpha, lambda, temperature, u);

    let candidates: Vec<PersonaCandidate> = cands
        .iter()
        .enumerate()
        .map(|(i, m)| PersonaCandidate {
            uci: m.uci.clone(),
            san: san_for(fen, &m.uci).unwrap_or_default(),
            policy_prob: m.prob,
            eval_cp: eval_cps[i],
            eval_penalty: penalties[i],
            weight: weights[i],
        })
        .collect();

    let chosen = &cands[idx];
    let san = san_for(fen, &chosen.uci)?;
    Ok(PersonaDecision {
        uci: chosen.uci.clone(),
        san,
        reason: reason.to_string(),
        band: policy.band,
        derived_seed,
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
    )
    .await
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
