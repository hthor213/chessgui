"use client"

// Shared back/forward ply review (spec 218): one model for every viewer that
// replays a growing list of positions — the tournament LiveGameView, the spar
// review cursor, the arena exhibition screen. The cursor is null while the
// viewer follows the live tip (the newest position) and a concrete index once
// the user steps back to review; review NEVER mutates the underlying game.

import { useCallback, useEffect, useState } from "react"

/** null = following the live tip; a number = reviewing that position index. */
export type ReviewCursor = number | null

/** The concrete position index the cursor points at, clamped to [min, tip]. */
export function reviewIndex(cursor: ReviewCursor, tip: number, min = 0): number {
  return Math.max(min, cursor === null ? tip : Math.min(cursor, tip))
}

/** One step toward the start; clamps at `min`. No-op while there is nothing
 *  behind the tip to review (an empty game never enters review mode). */
export function reviewBack(cursor: ReviewCursor, tip: number, min = 0): ReviewCursor {
  if (tip <= min) return cursor
  return Math.max(min, reviewIndex(cursor, tip, min) - 1)
}

/** One step toward the tip. Reaching the tip resumes following (null) when
 *  `resumeAtTip` — the LiveGameView/spar behavior; the arena exhibition
 *  screen instead parks AT the tip and resumes only via its Live button. */
export function reviewForward(
  cursor: ReviewCursor,
  tip: number,
  min = 0,
  resumeAtTip = true,
): ReviewCursor {
  if (tip <= min) return cursor
  const next = reviewIndex(cursor, tip, min) + 1
  return next >= tip ? (resumeAtTip ? null : Math.min(next, tip)) : next
}

export type PlyReview = {
  /** Raw cursor — null while following the tip (some call sites key off it). */
  cursor: ReviewCursor
  /** Resolved position index in [min, tip]. */
  index: number
  /** True while the viewer tracks the live tip (cursor === null). */
  following: boolean
  /** True at the newest position — following, or parked on the tip. */
  atTip: boolean
  back: () => void
  forward: () => void
  toStart: () => void
  /** Jump to the newest position and resume following it. */
  toTip: () => void
  /** Jump straight to a position index (a move-list click). Stored raw — a
   *  seek to the tip reviews it pinned rather than resuming the follow. */
  seek: (index: number) => void
}

export function usePlyReview({
  tip,
  min = 0,
  keyboard = true,
  resumeAtTip = true,
}: {
  /** Index of the newest position (the live tip). */
  tip: number
  /** Earliest reviewable index (spar uses -1 for "before the first ply"). */
  min?: number
  /** Bind ArrowLeft/ArrowRight on window. Skipped while focus sits in an
   *  editable element, exactly like the hand-rolled handlers this replaces. */
  keyboard?: boolean
  /** Whether stepping forward onto the tip resumes following it. */
  resumeAtTip?: boolean
}): PlyReview {
  const [cursor, setCursor] = useState<ReviewCursor>(null)

  const back = useCallback(() => setCursor((c) => reviewBack(c, tip, min)), [tip, min])
  const forward = useCallback(
    () => setCursor((c) => reviewForward(c, tip, min, resumeAtTip)),
    [tip, min, resumeAtTip],
  )
  const toStart = useCallback(() => setCursor((c) => (tip <= min ? c : min)), [tip, min])
  const toTip = useCallback(() => setCursor(null), [])
  const seek = useCallback((index: number) => setCursor(index), [])

  useEffect(() => {
    if (!keyboard) return
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.tagName === "SELECT" ||
          el.isContentEditable)
      ) {
        return
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault()
        back()
      } else if (e.key === "ArrowRight") {
        e.preventDefault()
        forward()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [keyboard, back, forward])

  const index = reviewIndex(cursor, tip, min)
  const following = cursor === null
  return {
    cursor,
    index,
    following,
    atTip: following || index >= tip,
    back,
    forward,
    toStart,
    toTip,
    seek,
  }
}
