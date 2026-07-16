// Small, pure helpers shared by the game screen and the history replay view
// (components/arena/game-screen.tsx, components/arena/history-screen.tsx) —
// pairing the server's flat, ply-ordered ArenaMove[] into numbered White/
// Black rows, and turning `status`/`result`/`resultReason` into a readable
// label. The server already assigns `ply` (0-based half-move count) and SAN
// per move (server/arena/app/main.py's `_game_state`), so this is grouping
// and wording, never chess reconstruction — that's lib/game-replay.ts's job,
// used only where the server doesn't already hand back SAN (the replay
// view's per-ply FEN stepping).

import type {
  ArenaExhibitionMove,
  ArenaExhibitionState,
  ArenaGameState,
  ArenaMove,
  ArenaSharedReplay,
} from "@chessgui/core/arena-api"

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
    case "flag":
      // The backend's literal reason for a loss on time (spec 217 Tier 1
      // clocks — server/arena/app/main.py `_flag_fall`).
      return "Flag fell"
    case "move_cap":
      // Exhibition adjudication (spec 217 Promise 3 resource policy): the
      // runner draws a shuffle game at ARENA_EXHIBITION_MAX_PLIES rather
      // than hold the engine for hours.
      return "Adjudicated at the move cap"
    case "stopped":
      return "Stopped"
    case "engine stall":
      return "Engine stalled"
    case "interrupted":
      return "Interrupted by a server restart"
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

/** Spectator-voice result label for a shared replay (spec 217 Tier 2 family
 *  replay links) — never "You win!": the person opening the link didn't play
 *  the game. Names come from the replay payload; an empty playerName falls
 *  back to a neutral "Player". */
export function arenaSharedStatusLabel(replay: ArenaSharedReplay): string {
  const playerName = replay.playerName || "Player"
  const whiteName = replay.playerColor === "white" ? playerName : replay.persona
  const blackName = replay.playerColor === "black" ? playerName : replay.persona
  if (replay.resultReason === "player resigned") return `${playerName} resigned.`
  const reason = humanizeArenaResultReason(replay.resultReason)
  if (replay.result === "1/2-1/2") return reason ? `Draw — ${reason}` : "Draw"
  if (replay.result === "1-0" || replay.result === "0-1") {
    const winner = replay.result === "1-0" ? whiteName : blackName
    return reason ? `${winner} wins — ${reason}` : `${winner} wins`
  }
  // No result on a shared replay should be impossible (tokens exist for
  // finished games only) — degrade to the reason rather than invent one.
  return reason ?? ""
}

/** Pair an exhibition's flat move list into numbered rows — same parity rule
 *  as pairArenaMoves; the structural type keeps one implementation serving
 *  both shapes (ArenaMove has `mover`, exhibition moves don't). */
export function pairExhibitionMoves(moves: ArenaExhibitionMove[]): {
  no: number
  white?: ArenaExhibitionMove
  black?: ArenaExhibitionMove
}[] {
  return pairArenaMoves(moves as ArenaMove[])
}

/** Spectator-voice result label for a persona-vs-persona exhibition (spec
 *  217 Promise 3) — nobody watching played the game, so names only. A null
 *  result with a reason ("Stopped", "Engine stalled", …) is a run that ended
 *  without a chess result. Null while the exhibition is still active. */
export function arenaExhibitionStatusLabel(
  ex: Pick<ArenaExhibitionState, "status" | "result" | "resultReason" | "whiteName" | "blackName">,
): string | null {
  if (ex.status !== "finished") return null
  const reason = humanizeArenaResultReason(ex.resultReason)
  if (ex.result === "1/2-1/2") return reason ? `Draw — ${reason}` : "Draw"
  if (ex.result === "1-0" || ex.result === "0-1") {
    const winner = ex.result === "1-0" ? ex.whiteName : ex.blackName
    return reason ? `${winner} wins — ${reason}` : `${winner} wins`
  }
  return reason ?? "Finished"
}

/** The share link itself: same /arena route, `?replay=<token>` — the page
 *  routes to the read-only replay view (no login) when it sees the param.
 *  Built from the CURRENT origin+path so it works on LAN, Tailscale, or a
 *  future public host without configuration. */
export function arenaReplayUrl(token: string): string {
  if (typeof window === "undefined") return `?replay=${encodeURIComponent(token)}`
  return `${window.location.origin}${window.location.pathname}?replay=${encodeURIComponent(token)}`
}

/** Clock face text (spec 217 Tier 1): "1:02:03" with hours, else "15:00";
 *  under 10 seconds, tenths ("0:07.4") — the only moment tenths matter. */
export function formatClockMs(ms: number): string {
  const clamped = Math.max(0, ms)
  const totalS = Math.floor(clamped / 1000)
  const h = Math.floor(totalS / 3600)
  const m = Math.floor((totalS % 3600) / 60)
  const s = totalS % 60
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
  if (totalS < 10) return `0:0${s}.${Math.floor((clamped % 1000) / 100)}`
  return `${m}:${String(s).padStart(2, "0")}`
}

/** Chess-idiomatic time-control label: 900s+10s -> "15+10" (minutes+seconds
 *  increment); sub-minute initial shows seconds ("30s+0"). */
export function timeControlLabel(initialS: number, incrementS: number): string {
  const base = initialS % 60 === 0 ? String(initialS / 60) : `${initialS}s`
  return `${base}+${incrementS}`
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
