//! Coach line verification (user requirement 2026-07-16).
//!
//! Two capabilities, one machinery, both riding calibration.rs's Stockfish
//! driver:
//!
//! - **1-PLY** ([`eval_played_move`]): a searchmoves-restricted read of the
//!   move the user said they'd play, from the same position and at the same
//!   movetime budget as the stored best-move eval — directly comparable to
//!   `sf_cp`. Every graded calibration answer can then carry
//!   `played_move_eval_cp` + `gap_to_best_cp`, so the coach can grade the
//!   user's move (e.g. Qa4) instead of only knowing best = Bd3 +2.94.
//!
//! - **N-PLY** ([`verify_line`]): legality-validate a SAN/UCI move sequence
//!   from a start FEN, walk it with a fixed-budget eval per ply, and return
//!   per-ply evals plus a verdict. The coach follow-up uses it to CHECK a line
//!   the user describes before opining on it (see coach.rs).
//!
//! All returned evals are White-POV centipawns/mate, matching every other eval
//! in the app. The legality walk is pure and unit-tested without an engine.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use shakmaty::fen::Fen;
use shakmaty::san::SanPlus;
use shakmaty::uci::UciMove;
use shakmaty::{CastlingMode, Chess, EnPassantMode, Move, Position};

use crate::calibration::{black_to_move, Engine, RawEval, DEFAULT_STOCKFISH};

/// Per-ply engine budget, matching the calibration sampler's stored evals.
const DEFAULT_MOVETIME_MS: u64 = 500;

/// Hard cap on walked plies — a coach line is a short concrete variation, not
/// a game; this also bounds the engine work per verification.
const MAX_PLIES: usize = 16;

// ---------------------------------------------------------------------------
// Wire types (mirrored in packages/core/src/calibration-types.ts)
// ---------------------------------------------------------------------------

/// One verified ply: the move (both notations), the position it leads to, and
/// the engine's White-POV eval of that position. A `terminal` ply ends the
/// game on the board (no engine read needed — the verdict is in the rules).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerifiedPly {
    pub san: String,
    pub uci: String,
    pub fen_after: String,
    /// White-POV centipawns of the position AFTER this move; None on mates,
    /// terminal plies, or engine trouble.
    pub eval_cp: Option<i64>,
    /// White-POV mate distance of the position after this move.
    pub eval_mate: Option<i64>,
    /// "checkmate" | "stalemate" when this move ends the game; None otherwise.
    pub terminal: Option<String>,
}

/// The verdict on a whole proposed line.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LineVerification {
    /// Every supplied move parsed and was legal in sequence.
    pub legal: bool,
    /// Index (0-based ply) of the first unparseable/illegal move, if any.
    pub illegal_at: Option<usize>,
    /// That move, verbatim as supplied.
    pub illegal_move: Option<String>,
    /// White-POV eval of the START position (same budget), for the delta.
    pub start_cp: Option<i64>,
    pub start_mate: Option<i64>,
    /// The legal prefix, one entry per walked ply, each with its eval.
    pub plies: Vec<VerifiedPly>,
    /// White-POV eval after the last walked ply (copy of the last entry).
    pub end_cp: Option<i64>,
    pub end_mate: Option<i64>,
    /// end_cp − start_cp when both are centipawns; the line's net swing.
    pub delta_cp: Option<i64>,
    /// The walked line delivers checkmate on the board.
    pub ends_in_mate: bool,
}

/// The 1-ply read of the user's chosen move.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlayedMoveEval {
    /// White-POV eval of playing this move (searchmoves-restricted search
    /// from the SAME position as the stored best-move eval).
    pub eval_cp: Option<i64>,
    pub eval_mate: Option<i64>,
    /// How much worse than the stored best move, in centipawns from the
    /// MOVER's point of view (positive = worse than best; small negatives are
    /// search noise). None when either score is a mate or missing.
    pub gap_to_best_cp: Option<i64>,
}

// ---------------------------------------------------------------------------
// Pure legality walk (no engine — fully unit-tested)
// ---------------------------------------------------------------------------

/// One legally-walked ply, before any engine involvement.
#[derive(Debug, Clone)]
pub(crate) struct WalkedPly {
    pub(crate) san: String,
    pub(crate) uci: String,
    pub(crate) fen_after: String,
    pub(crate) terminal: Option<&'static str>,
}

/// The result of legality-walking a move list from a FEN.
#[derive(Debug, Clone)]
pub(crate) struct Walk {
    pub(crate) plies: Vec<WalkedPly>,
    pub(crate) illegal_at: Option<usize>,
    pub(crate) illegal_move: Option<String>,
}

/// Parse one move token — UCI first when it looks like UCI (SAN never matches
/// the strict `e2e4`/`e7e8q` shape), else SAN with check/mate suffixes.
fn parse_move(pos: &Chess, token: &str) -> Option<Move> {
    let t = token.trim();
    if let Ok(uci) = UciMove::from_ascii(t.as_bytes()) {
        if let Ok(m) = uci.to_move(pos) {
            return Some(m);
        }
    }
    SanPlus::from_ascii(t.as_bytes())
        .ok()
        .and_then(|sp| sp.san.to_move(pos).ok())
}

/// Legality-walk `moves` (SAN or UCI, freely mixed) from `fen`. Stops at the
/// first unparseable/illegal move (recorded in the result, not an error) and
/// after a game-ending move — anything after a checkmate/stalemate is illegal
/// by definition. Errs only when the FEN itself won't parse.
pub(crate) fn walk_line(fen: &str, moves: &[String]) -> Result<Walk, String> {
    let mut pos: Chess = Fen::from_ascii(fen.as_bytes())
        .map_err(|e| format!("Bad FEN: {e}"))?
        .into_position(CastlingMode::Standard)
        .map_err(|e| format!("Illegal position: {e}"))?;
    let mut plies = Vec::new();
    let mut illegal_at = None;
    let mut illegal_move = None;
    for (i, token) in moves.iter().take(MAX_PLIES).enumerate() {
        // A move after the game ended is illegal, whatever it says.
        let over = plies.last().is_some_and(|p: &WalkedPly| p.terminal.is_some());
        let m = if over { None } else { parse_move(&pos, token) };
        let Some(m) = m else {
            illegal_at = Some(i);
            illegal_move = Some(token.clone());
            break;
        };
        let san = SanPlus::from_move(pos.clone(), m).to_string();
        let uci = m.to_uci(CastlingMode::Standard).to_string();
        pos.play_unchecked(m);
        let terminal = if pos.is_checkmate() {
            Some("checkmate")
        } else if pos.is_stalemate() {
            Some("stalemate")
        } else {
            None
        };
        plies.push(WalkedPly {
            san,
            uci,
            fen_after: Fen::from_position(&pos, EnPassantMode::Legal).to_string(),
            terminal,
        });
    }
    Ok(Walk { plies, illegal_at, illegal_move })
}

// ---------------------------------------------------------------------------
// Engine walk
// ---------------------------------------------------------------------------

/// White-POV flip of a side-to-move-POV RawEval for the position in `fen`.
fn white_pov(fen: &str, ev: &RawEval) -> (Option<i64>, Option<i64>) {
    let flip = black_to_move(fen);
    (
        ev.cp.map(|v| if flip { -v } else { v }),
        ev.mate.map(|v| if flip { -v } else { v }),
    )
}

/// Walk + evaluate: the shared machinery behind both commands. Terminal plies
/// (mate/stalemate on the board) are never sent to the engine.
async fn verify_with_engine(
    engine: &mut Engine,
    fen: &str,
    moves: &[String],
    movetime_ms: u64,
) -> Result<LineVerification, String> {
    let walk = walk_line(fen, moves)?;
    let start = engine.eval(fen, movetime_ms).await?;
    let (start_cp, start_mate) = white_pov(fen, &start);

    let mut plies = Vec::with_capacity(walk.plies.len());
    let mut ends_in_mate = false;
    for wp in &walk.plies {
        let (eval_cp, eval_mate, terminal) = match wp.terminal {
            Some(t) => {
                if t == "checkmate" {
                    ends_in_mate = true;
                }
                // Stalemate is a dead draw; checkmate needs no number — the
                // SAN already says it.
                (if t == "stalemate" { Some(0) } else { None }, None, Some(t.to_string()))
            }
            None => {
                let ev = engine.eval(&wp.fen_after, movetime_ms).await?;
                let (cp, mate) = white_pov(&wp.fen_after, &ev);
                (cp, mate, None)
            }
        };
        plies.push(VerifiedPly {
            san: wp.san.clone(),
            uci: wp.uci.clone(),
            fen_after: wp.fen_after.clone(),
            eval_cp,
            eval_mate,
            terminal,
        });
    }

    let end_cp = plies.last().and_then(|p| p.eval_cp);
    let end_mate = plies.last().and_then(|p| p.eval_mate);
    let delta_cp = match (start_cp, end_cp) {
        (Some(s), Some(e)) => Some(e - s),
        _ => None,
    };
    Ok(LineVerification {
        legal: walk.illegal_at.is_none(),
        illegal_at: walk.illegal_at,
        illegal_move: walk.illegal_move,
        start_cp,
        start_mate,
        plies,
        end_cp,
        end_mate,
        delta_cp,
        ends_in_mate,
    })
}

/// Spawn/init/quit wrapper around [`verify_with_engine`] — also called from
/// coach.rs for the follow-up's line check.
pub(crate) async fn verify_line_impl(
    fen: &str,
    moves: &[String],
    stockfish_path: Option<String>,
    movetime_ms: Option<u64>,
) -> Result<LineVerification, String> {
    let sf = stockfish_path
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_STOCKFISH.to_string());
    let mt = movetime_ms.unwrap_or(DEFAULT_MOVETIME_MS).max(1);
    let mut engine = Engine::spawn(&sf).await?;
    engine.init().await?;
    let out = verify_with_engine(&mut engine, fen, moves, mt).await;
    engine.quit().await;
    out
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Verify a proposed variation: legality-check `moves` (SAN or UCI) from
/// `fen`, evaluate each ply at a fixed movetime, return per-ply White-POV
/// evals + a verdict. An illegal move is a RESULT (the verdict names it), not
/// an error — errors are reserved for bad FENs and engine trouble.
#[tauri::command]
pub async fn verify_line(
    fen: String,
    moves: Vec<String>,
    stockfish_path: Option<String>,
    movetime_ms: Option<u64>,
) -> Result<LineVerification, String> {
    verify_line_impl(&fen, &moves, stockfish_path, movetime_ms).await
}

/// Evaluate the USER's move from `fen`: a searchmoves-restricted search at the
/// same budget as the stored best-move eval, so the two numbers compare
/// apples-to-apples. `best_cp`/`best_mate` are the stored White-POV best-move
/// eval; the mover-POV gap is computed here so every caller agrees on sign.
#[tauri::command]
pub async fn eval_played_move(
    fen: String,
    move_uci: String,
    best_cp: Option<i64>,
    best_mate: Option<i64>,
    stockfish_path: Option<String>,
    movetime_ms: Option<u64>,
) -> Result<PlayedMoveEval, String> {
    // Legality first: an illegal move is a caller bug, surfaced plainly.
    let walk = walk_line(&fen, std::slice::from_ref(&move_uci))?;
    if walk.illegal_at.is_some() {
        return Err(format!("Move {move_uci} is not legal in this position"));
    }
    let uci = &walk.plies[0].uci; // normalized (castling as king-move UCI)

    let sf = stockfish_path
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_STOCKFISH.to_string());
    let mt = movetime_ms.unwrap_or(DEFAULT_MOVETIME_MS).max(1);
    let mut engine = Engine::spawn(&sf).await?;
    engine.init().await?;
    let wait = Duration::from_millis(mt.saturating_add(8000).max(8000));
    let ev = engine
        .eval_with(&fen, &format!("go movetime {mt} searchmoves {uci}"), wait)
        .await;
    engine.quit().await;
    let ev = ev?;
    let (eval_cp, eval_mate) = white_pov(&fen, &ev);
    Ok(PlayedMoveEval {
        eval_cp,
        eval_mate,
        gap_to_best_cp: gap_to_best(&fen, best_cp, best_mate, eval_cp, eval_mate),
    })
}

/// Mover-POV gap of the played move vs the best move, from White-POV inputs.
/// Positive = the played move is worse. None when either score is a mate (a
/// cp-vs-mate difference has no honest centipawn size) or missing.
fn gap_to_best(
    fen: &str,
    best_cp: Option<i64>,
    best_mate: Option<i64>,
    played_cp: Option<i64>,
    played_mate: Option<i64>,
) -> Option<i64> {
    if best_mate.is_some() || played_mate.is_some() {
        return None;
    }
    let (b, p) = (best_cp?, played_cp?);
    let white_gap = b - p;
    Some(if black_to_move(fen) { -white_gap } else { white_gap })
}

#[cfg(test)]
mod tests {
    use super::*;

    const START: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

    fn mv(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn walks_a_legal_san_line() {
        let w = walk_line(START, &mv(&["e4", "e5", "Nf3"])).unwrap();
        assert!(w.illegal_at.is_none() && w.illegal_move.is_none());
        assert_eq!(w.plies.len(), 3);
        assert_eq!(w.plies[0].san, "e4");
        assert_eq!(w.plies[0].uci, "e2e4");
        assert!(w.plies[0].fen_after.starts_with("rnbqkbnr/pppppppp/8/8/4P3/"));
        assert_eq!(w.plies[2].uci, "g1f3");
        assert!(w.plies.iter().all(|p| p.terminal.is_none()));
    }

    #[test]
    fn accepts_uci_and_san_mixed() {
        let w = walk_line(START, &mv(&["e2e4", "e5", "g1f3", "Nc6"])).unwrap();
        assert!(w.illegal_at.is_none());
        assert_eq!(w.plies.len(), 4);
        assert_eq!(w.plies[1].uci, "e7e5");
        assert_eq!(w.plies[3].san, "Nc6");
    }

    #[test]
    fn flags_the_first_illegal_move_and_keeps_the_prefix() {
        // After 1.e4 it is Black's turn — "Nf3" (a White knight move) is illegal.
        let w = walk_line(START, &mv(&["e4", "Nf3"])).unwrap();
        assert_eq!(w.illegal_at, Some(1));
        assert_eq!(w.illegal_move.as_deref(), Some("Nf3"));
        assert_eq!(w.plies.len(), 1);
        assert_eq!(w.plies[0].san, "e4");

        // Unparseable garbage counts as illegal, same contract.
        let w = walk_line(START, &mv(&["e4", "???", "Nf3"])).unwrap();
        assert_eq!(w.illegal_at, Some(1));
        assert_eq!(w.illegal_move.as_deref(), Some("???"));
    }

    #[test]
    fn mate_mid_line_marks_terminal_and_rejects_moves_after_it() {
        // Fool's mate, then a move "after the end".
        let w = walk_line(START, &mv(&["f3", "e5", "g4", "Qh4#", "Ke2"])).unwrap();
        assert_eq!(w.plies.len(), 4);
        assert_eq!(w.plies[3].san, "Qh4#");
        assert_eq!(w.plies[3].terminal, Some("checkmate"));
        // The move after mate is illegal by definition.
        assert_eq!(w.illegal_at, Some(4));
        assert_eq!(w.illegal_move.as_deref(), Some("Ke2"));

        // Mate suffix is optional on input; the rendered SAN carries it.
        let w = walk_line(START, &mv(&["f3", "e5", "g4", "Qh4"])).unwrap();
        assert!(w.illegal_at.is_none());
        assert_eq!(w.plies[3].san, "Qh4#");
        assert_eq!(w.plies[3].terminal, Some("checkmate"));
    }

    #[test]
    fn stalemate_is_terminal_too() {
        // White queen to g6 stalemates the cornered black king.
        let fen = "7k/8/8/6Q1/8/8/8/K7 w - - 0 1";
        let w = walk_line(fen, &mv(&["Qg6"])).unwrap();
        assert_eq!(w.plies[0].terminal, Some("stalemate"));
    }

    #[test]
    fn bad_fen_is_an_error_not_a_verdict() {
        assert!(walk_line("not a fen", &mv(&["e4"])).is_err());
    }

    #[test]
    fn walk_caps_at_max_plies() {
        let shuffle: Vec<String> = ["Nf3", "Nf6", "Ng1", "Ng8"]
            .iter()
            .cycle()
            .take(MAX_PLIES + 8)
            .map(|s| s.to_string())
            .collect();
        let w = walk_line(START, &shuffle).unwrap();
        assert_eq!(w.plies.len(), MAX_PLIES);
    }

    #[test]
    fn gap_is_mover_pov() {
        let white = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
        let black = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1";
        // White to move: best +0.50, played −0.20 → 70cp worse for White.
        assert_eq!(gap_to_best(white, Some(50), None, Some(-20), None), Some(70));
        // Black to move, same White-POV numbers: played is BETTER for Black...
        assert_eq!(gap_to_best(black, Some(50), None, Some(-20), None), Some(-70));
        // ...and a White-POV drop is a gain flip: best −1.00, played +0.50.
        assert_eq!(gap_to_best(black, Some(-100), None, Some(50), None), Some(150));
        // Mates on either side: no honest centipawn gap.
        assert_eq!(gap_to_best(white, None, Some(3), Some(10), None), None);
        assert_eq!(gap_to_best(white, Some(50), None, None, Some(-2)), None);
    }

    // -----------------------------------------------------------------------
    // Live engine walk (skips cleanly when no Stockfish is installed,
    // matching calibration.rs's live-test idiom)
    // -----------------------------------------------------------------------

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

    #[tokio::test]
    async fn live_verify_line_evaluates_each_ply_white_pov() {
        let Some(sf) = find_stockfish() else {
            eprintln!("skipping live_verify_line: no stockfish");
            return;
        };
        let v = verify_line_impl(START, &mv(&["e4", "e5", "Nf3"]), Some(sf), Some(30))
            .await
            .expect("verifies");
        assert!(v.legal);
        assert_eq!(v.plies.len(), 3);
        // Every non-terminal ply got a score of one kind.
        for p in &v.plies {
            assert!(p.eval_cp.is_some() || p.eval_mate.is_some(), "ply {} scored", p.san);
        }
        assert!(v.start_cp.is_some());
        assert_eq!(v.end_cp, v.plies[2].eval_cp);
        // A sane opening never leaves ±3 pawns at 30ms.
        assert!(v.end_cp.unwrap().abs() < 300);
        assert!(!v.ends_in_mate);
    }

    #[tokio::test]
    async fn live_verify_line_mate_needs_no_engine_read() {
        let Some(sf) = find_stockfish() else {
            eprintln!("skipping live_verify_mate: no stockfish");
            return;
        };
        let v = verify_line_impl(START, &mv(&["f3", "e5", "g4", "Qh4#"]), Some(sf), Some(30))
            .await
            .expect("verifies");
        assert!(v.legal);
        assert!(v.ends_in_mate);
        assert_eq!(v.plies[3].terminal.as_deref(), Some("checkmate"));
        assert!(v.plies[3].eval_cp.is_none() && v.plies[3].eval_mate.is_none());
    }

    #[tokio::test]
    async fn live_eval_played_move_gap_vs_best() {
        let Some(sf) = find_stockfish() else {
            eprintln!("skipping live_eval_played_move: no stockfish");
            return;
        };
        // Scholar's-mate position: White to move, Qxf7# is best (mate); the
        // user plays a quiet developing move instead. Use a plain position
        // and a plainly bad move: 1.e4 e5, user plays 2.Ba6?? (loses the
        // bishop) vs a stored best of +0.30.
        let fen = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
        let ev = eval_played_move(
            fen.to_string(),
            "f1a6".to_string(),
            Some(30),
            None,
            Some(sf),
            Some(50),
        )
        .await
        .expect("evaluates");
        let cp = ev.eval_cp.expect("cp score");
        assert!(cp < -150, "Ba6?? loses a piece, got {cp}");
        let gap = ev.gap_to_best_cp.expect("gap");
        assert!(gap > 150, "gap to best should be large, got {gap}");
        // An illegal move is an error, not a number.
        assert!(eval_played_move(
            fen.to_string(),
            "e1e3".to_string(),
            Some(30),
            None,
            find_stockfish(),
            Some(30),
        )
        .await
        .is_err());
    }
}
