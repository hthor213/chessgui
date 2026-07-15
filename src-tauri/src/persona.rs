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

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use shakmaty::fen::Fen;
use shakmaty::san::SanPlus;
use shakmaty::uci::UciMove;
use shakmaty::{CastlingMode, Chess};
use tauri::{Manager, State};

use crate::maia::{self, MaiaMove, MaiaState};

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
}
