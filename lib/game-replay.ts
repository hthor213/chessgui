// Replay a tournament game's UCI move list back into positions. Used by the
// Tournament tab to (a) hop the viewer board to any ply of a completed game and
// (b) build a PGN to hand a game off to the Analyze board. Pure; leans on
// chessops for legality, SAN, and FEN — no board rendering here.

import { Chess, normalizeMove } from "chessops/chess"
import { parseFen, makeFen, INITIAL_FEN } from "chessops/fen"
import { parseUci } from "chessops"
import { makeSan } from "chessops/san"

/** Resolve a start FEN, treating empty/blank as the standard start. */
function resolveStartFen(startFen: string): string {
  return startFen && startFen.trim() ? startFen.trim() : INITIAL_FEN
}

/**
 * The FEN after each ply of a game: `fens[0]` is the start position, `fens[i]`
 * is the position after the i-th half-move. Replay stops early (and the array
 * is truncated) at the first move that doesn't parse or isn't legal, so a
 * malformed tail never throws.
 */
export function replayFens(startFen: string, uciMoves: string[]): string[] {
  const fen0 = resolveStartFen(startFen)
  const setup = parseFen(fen0)
  if (!setup.isOk) return [fen0]
  const posR = Chess.fromSetup(setup.unwrap())
  if (!posR.isOk) return [fen0]
  const pos = posR.unwrap()
  const fens = [makeFen(pos.toSetup())]
  for (const uci of uciMoves) {
    const raw = parseUci(uci)
    if (!raw) break
    const mv = normalizeMove(pos, raw)
    if (!pos.isLegal(mv)) break
    pos.play(mv)
    fens.push(makeFen(pos.toSetup()))
  }
  return fens
}

/** Header tags for a generated PGN. */
export type PgnTags = { event?: string; white?: string; black?: string }

/**
 * Build a PGN string from a game's start FEN + UCI move list + result. SAN is
 * reconstructed by replaying; a non-standard start emits `[SetUp]`/`[FEN]` and
 * correct move numbering (including a Black-to-move start). Round-trips through
 * `parsePgnToTrees`, so it can seed the Analyze board directly.
 */
export function movesToPgn(
  startFen: string,
  uciMoves: string[],
  result: string,
  tags: PgnTags = {},
): string {
  const fen0 = resolveStartFen(startFen)
  const setup = parseFen(fen0)
  const posR = setup.isOk ? Chess.fromSetup(setup.unwrap()) : undefined

  const sans: string[] = []
  if (posR && posR.isOk) {
    const pos = posR.unwrap()
    for (const uci of uciMoves) {
      const raw = parseUci(uci)
      if (!raw) break
      const mv = normalizeMove(pos, raw)
      if (!pos.isLegal(mv)) break
      sans.push(makeSan(pos, mv))
      pos.play(mv)
    }
  }

  const fields = fen0.split(/\s+/)
  const isStandardStart = fen0 === INITIAL_FEN
  const header = [
    `[Event "${tags.event ?? "Tournament game"}"]`,
    `[White "${tags.white ?? "White"}"]`,
    `[Black "${tags.black ?? "Black"}"]`,
    `[Result "${result}"]`,
  ]
  if (!isStandardStart) {
    header.push(`[SetUp "1"]`, `[FEN "${fen0}"]`)
  }

  let fullmove = parseInt(fields[5] ?? "1", 10) || 1
  let whiteToMove = (fields[1] ?? "w") !== "b"
  const tokens: string[] = []
  for (let i = 0; i < sans.length; i++) {
    if (whiteToMove) tokens.push(`${fullmove}.`)
    else if (i === 0) tokens.push(`${fullmove}...`)
    tokens.push(sans[i])
    if (!whiteToMove) fullmove++
    whiteToMove = !whiteToMove
  }
  tokens.push(result)

  return `${header.join("\n")}\n\n${tokens.join(" ")}\n`
}
