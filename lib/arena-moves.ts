// Small, pure helpers shared by the game screen and the history replay view
// (components/arena/game-screen.tsx, components/arena/history-screen.tsx) —
// pairing the server's flat, ply-ordered ArenaMove[] into numbered White/
// Black rows, and turning `status`/`result`/`resultReason` into a readable
// label. The server already assigns `ply` (0-based half-move count) and SAN
// per move (server/arena/app/main.py's `_game_state`), so this is grouping
// and wording, never chess reconstruction — that's lib/game-replay.ts's job,
// used only where the server doesn't already hand back SAN (the replay
// view's per-ply FEN stepping).

import type { ArenaGameState, ArenaMove } from "@/lib/arena-api"

export interface ArenaMoveRow {
  no: number
  white?: ArenaMove
  black?: ArenaMove
}

export function pairArenaMoves(moves: ArenaMove[]): ArenaMoveRow[] {
  const rows: ArenaMoveRow[] = []
  for (const m of moves) {
    const no = Math.floor(m.ply / 2) + 1
    if (m.ply % 2 === 0) {
      rows.push({ no, white: m })
    } else {
      const last = rows[rows.length - 1]
      if (last && last.no === no && !last.black) last.black = m
      else rows.push({ no, black: m })
    }
  }
  return rows
}

/** python-chess Termination enum names (lowercased) plus the backend's own
 *  literal "player resigned" — humanized for display. Falls back to
 *  underscore-to-space for anything not explicitly listed rather than
 *  hiding an unrecognized reason. */
export function humanizeArenaResultReason(reason: string | null): string | null {
  if (!reason) return null
  switch (reason) {
    case "checkmate":
      return "Checkmate"
    case "stalemate":
      return "Stalemate"
    case "insufficient_material":
      return "Insufficient material"
    case "fivefold_repetition":
      return "Fivefold repetition"
    case "threefold_repetition":
      return "Threefold repetition"
    case "seventyfive_moves":
      return "75-move rule"
    case "fifty_moves":
      return "50-move rule"
    default:
      return reason.replace(/_/g, " ")
  }
}

export function arenaStatusLabel(game: ArenaGameState): string | null {
  if (game.status !== "finished") return null
  if (game.resultReason === "player resigned") return "You resigned."
  const youAreWhite = game.playerColor === "white"
  const isDraw = game.result === "1/2-1/2"
  const youWon = game.result === (youAreWhite ? "1-0" : "0-1")
  const reason = humanizeArenaResultReason(game.resultReason)
  if (isDraw) return reason ? `Draw — ${reason}` : "Draw"
  const outcome = youWon ? "You win!" : "You lose."
  return reason ? `${reason} — ${outcome}` : outcome
}

/** Short result badge for a history row ("Win" / "Loss" / "Draw" / "In progress"). */
export function arenaResultBadge(
  status: ArenaGameState["status"],
  result: ArenaGameState["result"],
  playerColor: ArenaGameState["playerColor"],
): string {
  if (status !== "finished") return "In progress"
  if (result === "1/2-1/2") return "Draw"
  const youWon = result === (playerColor === "white" ? "1-0" : "0-1")
  return youWon ? "Win" : "Loss"
}
