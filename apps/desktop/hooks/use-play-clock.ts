import { useCallback, useEffect, useRef, useState } from "react";
import {
  advanceClock,
  flaggedSide,
  remainingMs,
  startPlayClock,
  type ClockColor,
  type PlayClockPreset,
  type PlayClockState,
} from "@/lib/play-clock";

/**
 * React owner of the local play-vs-engine clock (spec 011, 000:81).
 * `movesLength`/`tipTurn` describe the game's live tip: a length change means
 * the board changed hands (a move landed, or a take-back), which is what
 * switches the clock — review navigation never touches it. Flag enforcement
 * is local: a 100ms watcher adjudicates flag = loss; the page reacts to
 * `flagged` (stops the engine, locks the board, shows the result).
 */
export function usePlayClock(movesLength: number, tipTurn: ClockColor) {
  const [preset, setPreset] = useState<PlayClockPreset | null>(null);
  const [clock, setClock] = useState<PlayClockState | null>(null);
  const [flagged, setFlagged] = useState<ClockColor | null>(null);
  const clockRef = useRef(clock);
  clockRef.current = clock;
  const flaggedRef = useRef(flagged);
  flaggedRef.current = flagged;

  const start = useCallback((p: PlayClockPreset, turn: ClockColor) => {
    setPreset(p);
    setClock(startPlayClock(p, turn, Date.now())); // null for untimed
    setFlagged(null);
  }, []);

  const stop = useCallback(() => {
    setPreset(null);
    setClock(null);
    setFlagged(null);
  }, []);

  // The tip moved: charge the side that was thinking and hand the clock over.
  // Growth = a real move (increment paid); shrinkage = take-back (no
  // increment). Same length = navigation or a reload — clock untouched.
  const prevLenRef = useRef(movesLength);
  useEffect(() => {
    const prev = prevLenRef.current;
    prevLenRef.current = movesLength;
    if (movesLength === prev || flaggedRef.current) return;
    setClock((c) => (c ? advanceClock(c, tipTurn, movesLength > prev, Date.now()) : c));
  }, [movesLength, tipTurn]);

  // Flag watcher — local enforcement, flag = loss.
  const hasClock = clock !== null;
  useEffect(() => {
    if (!hasClock || flagged) return;
    const iv = setInterval(() => {
      const c = clockRef.current;
      if (!c || flaggedRef.current) return;
      const f = flaggedSide(c, Date.now());
      if (f) setFlagged(f);
    }, 100);
    return () => clearInterval(iv);
  }, [hasClock, flagged]);

  // Stable getter for use-engine's `go` command (real clock when timed).
  const getEngineClock = useCallback(() => {
    const c = clockRef.current;
    if (!c) return null;
    const now = Date.now();
    return {
      wtimeMs: remainingMs(c, "white", now),
      btimeMs: remainingMs(c, "black", now),
      incMs: c.incMs,
    };
  }, []);

  // Stable predicate for callbacks that must not act after the flag fell
  // (e.g. an in-flight bestmove landing after "stop").
  const isFlagged = useCallback(() => flaggedRef.current != null, []);

  return { preset, clock, flagged, start, stop, getEngineClock, isFlagged };
}
