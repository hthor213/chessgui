// Player-card content for the two cards flanking the board (spec 001 / 202).
//
// Both cards derive EVERYTHING they show — name, subtitle, avatar, clock,
// performance — from the board color they represent, and that color comes from
// the CURRENT board orientation (topColor / bottomColor in page.tsx). Fixing a
// card to "Black on top" desyncs the moment the board is flipped or a Set-up
// dialog changes the side to move; pinning both cards to this one pure mapping
// makes the desync unrepresentable.

import type { SidePerformance } from "./performance-elo"

export type ChessColor = "white" | "black"

export interface PlayerCardModel {
  color: ChessColor
  /** Short avatar text ("You", "SF", or a name initial). */
  avatar: string
  name: string
  /** Elo / engine role line under the name. */
  subtitle: string
  clock: string
  performance: SidePerformance | null
}

export interface PlayerCardInput {
  /** The board color this card represents (topColor or bottomColor). */
  color: ChessColor
  isPlayMode: boolean
  /** The human's color in play mode (the engine takes the other side). */
  playerColor: ChessColor
  headers: Record<string, string>
  engineName: string
  humanClock: string
  engineClock: string
  performance: { white: SidePerformance | null; black: SidePerformance | null }
  /** Per-game performance only shows in analyze mode with the engine unlocked. */
  showPerformance: boolean
}

export function playerCardModel(input: PlayerCardInput): PlayerCardModel {
  const {
    color,
    isPlayMode,
    playerColor,
    headers,
    engineName,
    humanClock,
    engineClock,
    performance,
    showPerformance,
  } = input
  const colorLabel = color === "white" ? "White" : "Black"

  if (isPlayMode) {
    // The human plays one color, the engine the other — whichever end of the
    // board each sits on. Clocks follow the same split.
    const isUser = color === playerColor
    return {
      color,
      avatar: isUser ? "You" : "SF",
      name: isUser ? `You (${colorLabel})` : engineName || "Stockfish",
      subtitle: isUser ? "" : `Engine (${colorLabel})`,
      clock: isUser ? humanClock : engineClock,
      performance: null,
    }
  }

  const name = headers[colorLabel] || colorLabel
  return {
    color,
    avatar: name[0] || colorLabel[0],
    name,
    subtitle: headers[`${colorLabel}Elo`] || "---",
    clock: "--:--",
    performance: showPerformance ? performance[color] : null,
  }
}
