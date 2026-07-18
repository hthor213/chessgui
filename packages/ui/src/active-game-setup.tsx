"use client"

// Active-game flag section of the position setup dialog (spec 219 A).
// Extracted from position-editor-dialog.tsx so it can be render-tested
// directly (Radix dialog content portals away under static rendering).
//
// Two modes:
// - fresh setup: the PROMINENT checkbox + optional metadata fields;
// - already-flagged game being re-edited: the flag CARRIES OVER and cannot
//   be unchecked here — spec 219 B "no bypass toggle mid-game". Without the
//   carry-over, re-running "Set up" on the same position would silently
//   mint an unflagged copy and hand the engine back mid-game.

import type { ActiveGameMeta } from "@chessgui/core/active-game"
import { SideToggle } from "@chessgui/ui/side-toggle"

export interface ActiveGameSetupValue {
  checked: boolean
  opponent: string
  chesscomUsername: string
  gameUrl: string
  /** Which side the user plays — seeded from the current board orientation,
   *  drives resume orientation. Always emitted. */
  myColor: "white" | "black"
}

export function emptyActiveGameSetup(
  chesscomUsername = "",
  myColor: "white" | "black" = "white",
): ActiveGameSetupValue {
  return { checked: false, opponent: "", chesscomUsername, gameUrl: "", myColor }
}

/** The metadata the dialog hands back on confirm; null when not flagged. */
export function activeGameMetaFromSetup(
  value: ActiveGameSetupValue,
  now: number = Date.now(),
): ActiveGameMeta | null {
  if (!value.checked) return null
  return {
    opponent: value.opponent.trim(),
    chesscomUsername: value.chesscomUsername.trim(),
    gameUrl: value.gameUrl.trim() || null,
    flaggedAt: now,
    myColor: value.myColor,
  }
}

const FIELD_CLASS =
  "bg-[#2a2825] border border-[#3a3835] rounded px-2 py-1 text-xs text-[#bababa] w-full"

function MetaField({
  label,
  value,
  onChange,
  placeholder,
  testId,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  testId: string
}) {
  return (
    <label className="flex flex-col gap-1 min-w-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        data-testid={testId}
        className={FIELD_CLASS}
      />
    </label>
  )
}

export function ActiveGameSetupSection({
  value,
  onChange,
  lockedMeta,
}: {
  value: ActiveGameSetupValue
  onChange: (next: ActiveGameSetupValue) => void
  /** Set when the game being edited is ALREADY an active game: the flag
   *  carries over unconditionally and this section only says so. */
  lockedMeta?: ActiveGameMeta | null
}) {
  if (lockedMeta) {
    return (
      <div
        data-testid="active-game-locked"
        className="rounded-lg border border-amber-700/50 bg-amber-950/30 px-4 py-3"
      >
        <p className="text-sm font-semibold text-amber-200">
          Fair-play game — analysis board only
        </p>
        <p className="text-xs text-amber-200/80 mt-1 leading-relaxed">
          This game is already flagged as a fair-play game — an ongoing
          chess.com daily game
          {lockedMeta.opponent ? ` (vs ${lockedMeta.opponent})` : ""}. The flag
          carries over to the edited position — engine help stays off until you
          mark the game finished (fair play).
        </p>
      </div>
    )
  }

  return (
    <div
      className={`rounded-lg border px-4 py-3 transition-colors ${
        value.checked
          ? "border-amber-700/60 bg-amber-950/30"
          : "border-[#3a3835] bg-[#2a2825]/50"
      }`}
    >
      <label className="flex items-start gap-3 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={value.checked}
          onChange={(e) => onChange({ ...value, checked: e.target.checked })}
          data-testid="active-game-checkbox"
          className="mt-0.5 h-4 w-4 accent-amber-500"
        />
        <span className="flex flex-col gap-1 min-w-0">
          <span
            className={`text-sm font-semibold ${
              value.checked ? "text-amber-200" : "text-[#f6f6f6]"
            }`}
          >
            Live game — analysis board only
          </span>
          <span className="text-xs text-muted-foreground leading-relaxed">
            This position is from a game that&rsquo;s still being played. All
            engine help stays off for this game — explore lines by hand, like on
            a real board. Analysis unlocks once you mark the game finished.
          </span>
        </span>
      </label>

      {value.checked && (
        <div className="mt-3 flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">I&rsquo;m playing</span>
          <SideToggle
            value={value.myColor}
            onChange={(myColor) => onChange({ ...value, myColor })}
            testId="active-game-mycolor"
            size="md"
          />
        </div>
      )}

      {value.checked && (
        <div
          className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3"
          data-testid="active-game-fields"
        >
          <MetaField
            label="Opponent"
            value={value.opponent}
            onChange={(opponent) => onChange({ ...value, opponent })}
            placeholder="opponent name"
            testId="active-game-opponent"
          />
          <MetaField
            label="Your chess.com username"
            value={value.chesscomUsername}
            onChange={(chesscomUsername) => onChange({ ...value, chesscomUsername })}
            testId="active-game-username"
          />
          <MetaField
            label="Game URL (optional)"
            value={value.gameUrl}
            onChange={(gameUrl) => onChange({ ...value, gameUrl })}
            placeholder="https://www.chess.com/game/daily/…"
            testId="active-game-url"
          />
        </div>
      )}
    </div>
  )
}
