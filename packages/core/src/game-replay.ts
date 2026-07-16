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

/** Header tags for a generated PGN. `round` is only emitted when given (the
 *  bulk tournament export numbers games; single-game handoffs don't); `date`
 *  likewise (PGN dot format, "2026.07.16" — the database's date column/filter
 *  sorts on it, so the tournament→DB save stamps the run date). */
export type PgnTags = { event?: string; date?: string; white?: string; black?: string; round?: string }

/**
 * SAN move list only (no PGN headers/numbering), reconstructed by replaying
 * `uciMoves` from `startFen`. Stops early (truncating) at the first move that
 * doesn't parse or isn't legal, same as `replayFens` — a malformed tail never
 * throws. Shared by `movesToPgn` and `numberMoves` (spec 218 "Exhibition
 * framing" checklist item — the exhibition viewer's SAN move list) so there is
 * exactly one SAN-reconstruction path for tournament games.
 */
export function sansFromUci(startFen: string, uciMoves: string[]): string[] {
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
  return sans
}

/** One numbered move-pair row: `no` is the fullmove number; `white`/`black`
 *  are the SAN for that side's move at this number (either may be absent —
 *  a Black-to-move start has no `white` at its first number; a game that
 *  ends mid-pair has no `black` at its last). */
export type NumberedPly = { no: number; white?: string; black?: string }

/**
 * Pair a flat SAN list into numbered White/Black rows (spec 218 "Move numbers"
 * ship-now item — landing here for the tournament/exhibition viewer, mirroring
 * the same fix already shipped in the spar move list: "12.Nxe5" instead of
 * prose, "so realism-feedback notes can cite" a specific move). Honors a
 * non-standard start FEN's fullmove number and side-to-move (including a
 * Black-to-move start, which opens on a bare `{ no, black }` row).
 */
export function numberMoves(startFen: string, sans: string[]): NumberedPly[] {
  const fen0 = resolveStartFen(startFen)
  const fields = fen0.split(/\s+/)
  let fullmove = parseInt(fields[5] ?? "1", 10) || 1
  let whiteToMove = (fields[1] ?? "w") !== "b"
  const rows: NumberedPly[] = []
  let cur: NumberedPly | null = null
  for (const san of sans) {
    if (whiteToMove) {
      cur = { no: fullmove, white: san }
      rows.push(cur)
    } else {
      if (cur && cur.no === fullmove && cur.black === undefined) {
        cur.black = san
      } else {
        cur = { no: fullmove, black: san }
        rows.push(cur)
      }
      fullmove++
    }
    whiteToMove = !whiteToMove
  }
  return rows
}

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
  const sans = sansFromUci(fen0, uciMoves)

  const fields = fen0.split(/\s+/)
  const isStandardStart = fen0 === INITIAL_FEN
  const header = [
    `[Event "${tags.event ?? "Tournament game"}"]`,
    ...(tags.date !== undefined ? [`[Date "${tags.date}"]`] : []),
    ...(tags.round !== undefined ? [`[Round "${tags.round}"]`] : []),
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

/** One game of a bulk multi-game PGN export (spec 210 Phase 6). */
export type PgnGameInput = {
  startFen: string
  uciMoves: string[]
  result: string
  tags?: PgnTags
}

/**
 * Concatenate many games into ONE multi-game PGN document (spec 210 Phase 6
 * bulk tournament export — distinct from the per-game "Open in Analyze"
 * handoff). Each game goes through `movesToPgn`; games are separated by a
 * blank line, the standard multi-game form every PGN reader (including the
 * spec 200 importer) expects.
 */
export function gamesToPgn(games: PgnGameInput[]): string {
  return games.map((g) => movesToPgn(g.startFen, g.uciMoves, g.result, g.tags)).join("\n")
}
