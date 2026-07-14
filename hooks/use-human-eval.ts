import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import type { PvLine } from "@/lib/uci-parser";
import { maiaStatus, maiaPolicy, type MaiaStatus, type MaiaPolicy } from "@/lib/maia";
import { computeHumanEval, type HumanEvalResult } from "@/lib/human-eval";

const STORAGE_KEY = "human-eval-band";
const DEBOUNCE_MS = 150;
const CACHE_LIMIT = 64;

/** Persisted slider state: a band, or null for OFF (pure Stockfish). */
function loadBand(): number | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw || raw === "off") return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

function saveBand(band: number | null) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, band === null ? "off" : String(band));
}

interface CachedPolicy {
  key: string; // `${fen}|${band}`
  fen: string;
  band: number;
  policy: MaiaPolicy;
}

interface UseHumanEvalArgs {
  /** Position the Stockfish `lines` were computed for ("" before first search). */
  analysisFen: string;
  /** Side to move when `lines` were computed. */
  scoreTurn: "white" | "black";
  /** Live Stockfish PV lines (multipv 1..N). */
  lines: PvLine[];
  /** Whether the analysis engine is running (no SF eval to blend otherwise). */
  engineRunning: boolean;
}

export interface UseHumanEval {
  /** lc0 present — when false the UI hides the feature behind an install hint. */
  available: boolean;
  status: MaiaStatus | null;
  /** Selected band, or null for OFF. */
  band: number | null;
  setBand: (band: number | null) => void;
  /** Tier-0 blend for the current position/band, or null when unavailable. */
  result: HumanEvalResult | null;
  loading: boolean;
  error: string | null;
}

/**
 * Drives tier-0 of the Elo-conditioned evaluator. Fetches the Maia policy for
 * `(analysisFen, band)` — keyed on those two only, so Stockfish depth ticks don't
 * re-query — and recomputes the blend whenever the Stockfish lines update. All
 * failures degrade to `result: null` / `error`; the analysis flow never breaks.
 */
export function useHumanEval({
  analysisFen,
  scoreTurn,
  lines,
  engineRunning,
}: UseHumanEvalArgs): UseHumanEval {
  const [status, setStatus] = useState<MaiaStatus | null>(null);
  const [band, setBandState] = useState<number | null>(null);
  const [cached, setCached] = useState<CachedPolicy | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cacheRef = useRef<Map<string, MaiaPolicy>>(new Map());
  const reqIdRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Availability + persisted band, once on mount.
  useEffect(() => {
    setBandState(loadBand());
    let cancelled = false;
    maiaStatus().then((s) => {
      if (!cancelled) setStatus(s);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const setBand = useCallback((next: number | null) => {
    setBandState(next);
    saveBand(next);
    if (next === null) setError(null);
  }, []);

  const available = status?.lc0_available ?? false;

  // Fetch the Maia policy for (analysisFen, band). Debounced; cached per key;
  // race-guarded so a stale response never overwrites a newer one.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (band === null || !available || !engineRunning || !analysisFen) {
      setLoading(false);
      return;
    }

    const key = `${analysisFen}|${band}`;
    const hit = cacheRef.current.get(key);
    if (hit) {
      setCached({ key, fen: analysisFen, band, policy: hit });
      setLoading(false);
      setError(null);
      return;
    }

    const reqId = ++reqIdRef.current;
    setLoading(true);
    debounceRef.current = setTimeout(() => {
      maiaPolicy(analysisFen, band)
        .then((policy) => {
          if (reqId !== reqIdRef.current) return; // superseded
          const c = cacheRef.current;
          c.set(key, policy);
          if (c.size > CACHE_LIMIT) c.delete(c.keys().next().value as string);
          setCached({ key, fen: analysisFen, band, policy });
          setError(null);
          setLoading(false);
        })
        .catch((e) => {
          if (reqId !== reqIdRef.current) return;
          setError(String(e));
          setCached(null);
          setLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [analysisFen, band, available, engineRunning]);

  // Recompute the blend from the current policy + live Stockfish lines. Cheap
  // and pure, so it re-runs on every depth tick without touching lc0.
  const result = useMemo<HumanEvalResult | null>(() => {
    if (band === null || !cached) return null;
    if (cached.fen !== analysisFen || cached.band !== band) return null;
    return computeHumanEval({ fen: analysisFen, scoreTurn, lines, policy: cached.policy });
  }, [band, cached, analysisFen, scoreTurn, lines]);

  return { available, status, band, setBand, result, loading, error };
}
