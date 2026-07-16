// PV preview (spec 011: "Clicking a PV line previews it on the board").
//
// Pure helper: walks an engine PV (UCI move list) from a starting FEN and
// returns the position after each ply, so the UI can put any prefix of the
// line on the board without touching the game tree. Stops at the first
// unparseable/illegal move (a stale PV from a previous position previews
// nothing beyond the legal prefix).

import { Chess, castlingSide } from "chessops/chess"
import { parseFen, makeFen } from "chessops/fen"
import { makeSanAndPlay } from "chessops/san"
import { kingCastlesTo, isNormal, makeSquare } from "chessops"
import { parseEngineUci } from "@chessgui/core/uci-parser"

export type PvStep = {
  /** Position after this ply of the PV. */
  fen: string
  /** SAN of the move that produced this position. */
  san: string
  /** from/to squares for the last-move highlight (castling → king's dest). */
  lastMove: [string, string]
}

export function walkPv(startFen: string, uciMoves: string[]): PvStep[] {
  const setup = parseFen(startFen)
  if (setup.isErr) return []
  const pos = Chess.fromSetup(setup.unwrap())
  if (pos.isErr) return []
  const chess = pos.unwrap()

  const steps: PvStep[] = []
  for (const uci of uciMoves) {
    const move = parseEngineUci(chess, uci)
    if (!move || !isNormal(move) || !chess.isLegal(move)) break
    const side = castlingSide(chess, move)
    const dest = side ? kingCastlesTo(chess.turn, side) : move.to
    const lastMove: [string, string] = [makeSquare(move.from), makeSquare(dest)]
    let san: string
    try {
      san = makeSanAndPlay(chess, move)
    } catch {
      break
    }
    steps.push({ fen: makeFen(chess.toSetup()), san, lastMove })
  }
  return steps
}
