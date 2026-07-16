// Local play-vs-engine clocks (spec 011 "Later" box, 000:81). Pure model —
// hooks/use-play-clock.ts owns the React state and ticking — plus the
// custom-time-control validation and its last-used persistence (the one
// storage-seam touch in this file). Enforcement is entirely local: the
// frontend adjudicates the flag (flag = loss), unlike the
// server-adjudicated arena clocks (spec 217). Presentation reuses
// lib/arena-moves' formatClockMs / timeControlLabel so every clock face in
// the app reads the same.

import { timeControlLabel } from "@/lib/arena-moves";
import { getProviders } from "@/lib/platform";

export type ClockColor = "white" | "black";

export interface PlayClockPreset {
  id: string;
  label: string;
  /** Base time in seconds; null = untimed (no clock at all). */
  baseS: number | null;
  /** Fischer increment per move, in seconds. */
  incS: number;
}

export const PLAY_CLOCK_PRESETS: PlayClockPreset[] = [
  { id: "untimed", label: "Untimed", baseS: null, incS: 0 },
  { id: "blitz-3+2", label: `Blitz ${timeControlLabel(180, 2)}`, baseS: 180, incS: 2 },
  { id: "blitz-5+3", label: `Blitz ${timeControlLabel(300, 3)}`, baseS: 300, incS: 3 },
  { id: "rapid-10+5", label: `Rapid ${timeControlLabel(600, 5)}`, baseS: 600, incS: 5 },
  { id: "rapid-15+10", label: `Rapid ${timeControlLabel(900, 10)}`, baseS: 900, incS: 10 },
  { id: "classical-30+20", label: `Classical ${timeControlLabel(1800, 20)}`, baseS: 1800, incS: 20 },
];

export const UNTIMED_PRESET = PLAY_CLOCK_PRESETS[0];

// --- Custom time control (spec 011) ---

/** User-entered time control: whole base minutes + whole increment seconds. */
export interface CustomTimeControl {
  baseMin: number;
  incS: number;
}

export const CUSTOM_BASE_MIN = 1; // minutes — "0 base" is spelled Untimed
export const CUSTOM_BASE_MAX = 180;
export const CUSTOM_INC_MIN = 0; // seconds
export const CUSTOM_INC_MAX = 120;

export const DEFAULT_CUSTOM_TC: CustomTimeControl = { baseMin: 10, incS: 0 };

/** True when both fields are integers inside the allowed ranges (rejects
 *  NaN from an emptied number input). */
export function isValidCustomTimeControl(tc: CustomTimeControl): boolean {
  return (
    Number.isInteger(tc.baseMin) &&
    tc.baseMin >= CUSTOM_BASE_MIN &&
    tc.baseMin <= CUSTOM_BASE_MAX &&
    Number.isInteger(tc.incS) &&
    tc.incS >= CUSTOM_INC_MIN &&
    tc.incS <= CUSTOM_INC_MAX
  );
}

/** A validated custom TC as a preset the clock model already understands. */
export function customClockPreset(tc: CustomTimeControl): PlayClockPreset {
  return {
    id: "custom",
    label: `Custom ${timeControlLabel(tc.baseMin * 60, tc.incS)}`,
    baseS: tc.baseMin * 60,
    incS: tc.incS,
  };
}

const CUSTOM_TC_KEY = "play-custom-tc";

/** Last custom TC the user started a game with; the default until then
 *  (or when the stored blob is garbage/out of range). */
export function loadCustomTimeControl(): CustomTimeControl {
  try {
    const raw = getProviders().storage.get(CUSTOM_TC_KEY);
    if (!raw) return DEFAULT_CUSTOM_TC;
    const saved = JSON.parse(raw) as Partial<CustomTimeControl>;
    const tc = { baseMin: Number(saved.baseMin), incS: Number(saved.incS) };
    return isValidCustomTimeControl(tc) ? tc : DEFAULT_CUSTOM_TC;
  } catch {
    return DEFAULT_CUSTOM_TC;
  }
}

export function saveCustomTimeControl(tc: CustomTimeControl): void {
  if (!isValidCustomTimeControl(tc)) return; // never persist an invalid TC
  getProviders().storage.set(CUSTOM_TC_KEY, JSON.stringify(tc));
}

export interface PlayClockState {
  /** Remaining ms per side, as of the moment the current turn started. */
  whiteMs: number;
  blackMs: number;
  incMs: number;
  /** Whose clock is burning wall time right now. */
  running: ClockColor;
  /** Epoch ms when the running side's turn started. */
  turnStartedAt: number;
}

/** New clock for a game starting with `turn` to move; null for untimed. */
export function startPlayClock(
  preset: PlayClockPreset,
  turn: ClockColor,
  now: number,
): PlayClockState | null {
  if (preset.baseS == null) return null;
  const baseMs = preset.baseS * 1000;
  return {
    whiteMs: baseMs,
    blackMs: baseMs,
    incMs: preset.incS * 1000,
    running: turn,
    turnStartedAt: now,
  };
}

/** Remaining ms for a side: the running side burns wall time, clamped at 0. */
export function remainingMs(clock: PlayClockState, color: ClockColor, now: number): number {
  const stored = color === "white" ? clock.whiteMs : clock.blackMs;
  if (clock.running !== color) return stored;
  return Math.max(0, stored - (now - clock.turnStartedAt));
}

/** The side whose flag has fallen (only ever the running side), or null. */
export function flaggedSide(clock: PlayClockState, now: number): ClockColor | null {
  return remainingMs(clock, clock.running, now) <= 0 ? clock.running : null;
}

/**
 * The board changed hands: charge the side whose clock was running and hand
 * the clock to `newTurn`. A completed move earns the mover the Fischer
 * increment; a take-back (moveCompleted=false) charges the thinking time but
 * pays no increment.
 */
export function advanceClock(
  clock: PlayClockState,
  newTurn: ClockColor,
  moveCompleted: boolean,
  now: number,
): PlayClockState {
  const left = remainingMs(clock, clock.running, now) + (moveCompleted ? clock.incMs : 0);
  return {
    ...clock,
    whiteMs: clock.running === "white" ? left : clock.whiteMs,
    blackMs: clock.running === "black" ? left : clock.blackMs,
    running: newTurn,
    turnStartedAt: now,
  };
}

// UCI GUIs may not send more than a signed 32-bit ms value (use-engine has
// always used this as "effectively untimed" for the human side).
const UNTIMED_MS = 2147483647;
// Never hand the engine a zero/negative budget — it must still produce a
// bestmove; the flag itself is adjudicated locally, not by the engine.
const MIN_GO_MS = 50;

/**
 * wtime/btime/winc/binc for play mode's `go`: the real game clock when one is
 * running, otherwise the spec 216 virtual pace clock (human side effectively
 * untimed — the pre-clock behavior, byte-for-byte).
 */
export function engineGoTimes(
  real: { wtimeMs: number; btimeMs: number; incMs: number } | null,
  virtual: { wtime: number; btime: number; incMs: number },
  playerColor: ClockColor,
): { wtime: number; btime: number; winc: number; binc: number } {
  if (real) {
    return {
      wtime: Math.max(MIN_GO_MS, Math.round(real.wtimeMs)),
      btime: Math.max(MIN_GO_MS, Math.round(real.btimeMs)),
      winc: real.incMs,
      binc: real.incMs,
    };
  }
  return {
    wtime: playerColor === "white" ? UNTIMED_MS : virtual.wtime,
    btime: playerColor === "black" ? UNTIMED_MS : virtual.btime,
    winc: virtual.incMs,
    binc: virtual.incMs,
  };
}
