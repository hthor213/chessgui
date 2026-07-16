// Endgame tablebase surfacing (spec 900 backlog) — the pure half.
//
// The desktop shell's Rust side already probes the Lichess tablebase
// (match_runner.rs, FEN-keyed cache) for tournament adjudication; the
// `tablebase_probe` command re-exposes it richly (WDL category, DTZ/DTM,
// ranked moves) for the analysis panel. This module holds the types that
// mirror that command's wire shape and the two gating predicates every
// caller must clear first:
//
//   1. eligibility — the tablebase only covers positions with <=7 men;
//   2. the spec 219 active-game lockout — a tablebase verdict IS
//      engine-class assistance (a perfect evaluation plus the best move),
//      so for a flagged active chess.com daily game it must be OFF,
//      exactly like the UCI engine. The Rust command refuses locked
//      contexts defensively (layer 2); this predicate is layer 1.

import { engineAllowedForGame, type ActiveGameMeta } from "./active-game"

/** Positions with more men than this are not in the Lichess tablebase. */
export const TABLEBASE_MAX_MEN = 7

/** One ranked move from the probe (best first, as Lichess sorts them).
 *  The API is one ply deep — there is no full PV to surface. */
export interface TbMoveInfo {
  uci: string
  san: string
  /** Outcome AFTER the move, from the opponent's perspective (Lichess
   *  convention): "loss" here means this move wins for the side to move. */
  category: string
  dtz: number | null
}

/** Wire shape of the Rust `tablebase_probe` command's result. */
export interface TbProbe {
  /** Outcome from the side-to-move's perspective ("win", "loss", "draw",
   *  "cursed-win", "blessed-loss", ...). */
  category: string
  dtz: number | null
  dtm: number | null
  moves: TbMoveInfo[]
}

/** Count the men on the board from a FEN's piece-placement field. */
export function fenMenCount(fen: string): number {
  const board = fen.trim().split(/\s+/)[0] ?? ""
  let count = 0
  for (const ch of board) if (/[a-zA-Z]/.test(ch)) count++
  return count
}

/** Whether the position is even worth probing (<=7 men, non-empty FEN). */
export function tablebaseEligible(fen: string): boolean {
  const men = fenMenCount(fen)
  return men > 0 && men <= TABLEBASE_MAX_MEN
}

/**
 * Spec 219 gate: tablebase lookups are engine-class assistance and follow
 * the exact same lockout as the engine — allowed only when the game is
 * known NOT to be an active chess.com daily game (`null`); `undefined`
 * (ambiguous) resolves to OFF, per the spec's conservative stance.
 */
export function tablebaseAllowedForGame(
  activeGame: ActiveGameMeta | null | undefined,
): boolean {
  return engineAllowedForGame(activeGame)
}

/**
 * Human-readable verdict from White's perspective for the WDL badge.
 * `turn` is the side to move in the probed position (the probe's category
 * is side-to-move relative).
 */
export function tbVerdictLabel(category: string, turn: "white" | "black"): string {
  const stm = turn === "white" ? "White" : "Black"
  const opp = turn === "white" ? "Black" : "White"
  switch (category) {
    case "win":
      return `${stm} wins`
    case "loss":
      return `${opp} wins`
    case "cursed-win":
    case "blessed-loss":
      return "Draw (50-move rule)"
    default:
      return "Draw"
  }
}
