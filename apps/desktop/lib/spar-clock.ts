// Spar time controls (spec 215, increment TCs in local spar — the training
// program's Christmas-match goal is played at increment TCs like 10+5).
//
// Thin layer over the Play-mode Fischer clock model (lib/play-clock, driven by
// hooks/use-play-clock): the spar screen reuses startPlayClock / advanceClock /
// flaggedSide unchanged and only needs its own preset list (off + the three
// match TCs), the recorded TC string, the persona's think-time draw, and the
// flag-fall result label. Enforcement stays local, flag = loss, exactly like
// Play mode.

import { timeControlLabel } from "@/lib/arena-moves"
import type { ClockColor, PlayClockPreset } from "@/lib/play-clock"

/** Off + the match increment TCs (spec 215): 5+3, 10+5, 15+10. Off keeps the
 *  pre-clock spar behavior byte-for-byte (no clock, no think delay). */
export const SPAR_TC_PRESETS: PlayClockPreset[] = [
  { id: "off", label: "Off", baseS: null, incS: 0 },
  { id: "5+3", label: timeControlLabel(300, 3), baseS: 300, incS: 3 },
  { id: "10+5", label: timeControlLabel(600, 5), baseS: 600, incS: 5 },
  { id: "15+10", label: timeControlLabel(900, 10), baseS: 900, incS: 10 },
]

export const SPAR_TC_OFF = SPAR_TC_PRESETS[0]

/** The TC string recorded in a spar-result entry ("10+5"), or null when
 *  unclocked — training aggregates filter on it later (spec 215). */
export function sparTimeControlLabel(preset: PlayClockPreset): string | null {
  return preset.baseS == null ? null : timeControlLabel(preset.baseS, preset.incS)
}

/**
 * How long the persona "thinks" on its own clock, in ms. No persona time
 * model exists yet (persona.rs / machine.rs carry none), so this is a bounded
 * uniform draw — a plausibility bound, never a claim about the player's real
 * pace: [1s, 5% of remaining], with the floor dropping to half the remaining
 * time when under 2s so the sampled delay alone can never flag the persona
 * (real engine latency on top still can — that flag is honest).
 */
export function personaThinkTimeMs(remainingMs: number, rng: () => number = Math.random): number {
  if (remainingMs <= 0) return 0
  const lo = Math.min(1000, remainingMs / 2)
  const hi = Math.max(lo, remainingMs * 0.05)
  return Math.floor(lo + rng() * (hi - lo)) // floor: never lands ON the flag
}

/** End label for a fallen flag, phrased so spar-results' resultFromLabel maps
 *  it through its existing "… wins" patterns — no new pattern to keep in sync. */
export function flagResultLabel(flagged: ClockColor): string {
  return flagged === "white"
    ? "White lost on time — Black wins"
    : "Black lost on time — White wins"
}
