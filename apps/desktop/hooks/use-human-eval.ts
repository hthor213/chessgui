import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import type { PvLine } from "@chessgui/core/uci-parser";
import {
  maiaStatus,
  maiaPolicy,
  MAIA_SLIDER_BANDS,
  type MaiaStatus,
  type MaiaPolicy,
} from "@/lib/maia";
import { computeHumanEval, type HumanEvalResult } from "@/lib/human-eval";
import {
  humanEvalTree,
  humanEvalSweep,
  humanEvalSweepCancel,
  type HumanTreeResult,
} from "@/lib/human-eval-tree";
import { getProviders } from "@/lib/platform";

const STORAGE_KEY = "human-eval-band";
const TREE_STORAGE_KEY = "human-eval-tree";
const DEBOUNCE_MS = 150;
/** Tier-1 debounce: longer than tier-0 — a tree search costs ~0.2–4 s. */
const TREE_DEBOUNCE_MS = 400;
/**
 * Sweep debounce: longer still, so the selected band's tree search wins the
 * shared backend TT lock first (its stop then comes from the cache when the
 * sweep reaches it) and stepping through moves never launches throwaway
 * sweeps of every stop.
 */
const SWEEP_DEBOUNCE_MS = 1200;
const CACHE_LIMIT = 64;
const TREE_CACHE_LIMIT = 32;
const SWEEP_CACHE_LIMIT = 16;

/** Persisted slider state: a band, or null for OFF (pure Stockfish). */
function loadBand(): number | null {
  const raw = getProviders().storage.get(STORAGE_KEY);
  if (!raw || raw === "off") return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

function saveBand(band: number | null) {
  getProviders().storage.set(STORAGE_KEY, band === null ? "off" : String(band));
}

function loadTreeMode(): boolean {
  return getProviders().storage.get(TREE_STORAGE_KEY) === "1";
}

function saveTreeMode(on: boolean) {
  getProviders().storage.set(TREE_STORAGE_KEY, on ? "1" : "0");
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
  /** Tier-1 (experimental) human-visible tree mode toggle. */
  tree: boolean;
  setTree: (on: boolean) => void;
  /** Tier-1 tree result for the current position/band, or null. */
  treeResult: HumanTreeResult | null;
  treeLoading: boolean;
  treeError: string | null;
  /**
   * Perception-curve points for the current position (spec 213's flagship
   * visual): one tree result per slider stop, ascending by band, filling in
   * as the background sweep lands them. Null until the sweep starts.
   */
  sweepPoints: HumanTreeResult[] | null;
  sweepLoading: boolean;
  sweepError: string | null;
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
  const [tree, setTreeState] = useState(false);
  const [cachedTree, setCachedTree] = useState<{ key: string; result: HumanTreeResult } | null>(
    null
  );
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [sweep, setSweep] = useState<{ fen: string; points: HumanTreeResult[] } | null>(null);
  const [sweepLoading, setSweepLoading] = useState(false);
  const [sweepError, setSweepError] = useState<string | null>(null);

  const cacheRef = useRef<Map<string, MaiaPolicy>>(new Map());
  const reqIdRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const treeCacheRef = useRef<Map<string, HumanTreeResult>>(new Map());
  const treeReqIdRef = useRef(0);
  const treeDebounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const sweepCacheRef = useRef<Map<string, HumanTreeResult[]>>(new Map());
  const sweepReqIdRef = useRef(0);
  const sweepDebounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Availability + persisted band, once on mount.
  useEffect(() => {
    setBandState(loadBand());
    setTreeState(loadTreeMode());
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
    if (next === null) {
      setError(null);
      setTreeError(null);
    }
  }, []);

  const setTree = useCallback((on: boolean) => {
    setTreeState(on);
    saveTreeMode(on);
    if (!on) setTreeError(null);
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

  // Tier-1: run the human-visible tree search for (analysisFen, band) when the
  // tree toggle is on. Independent of the Stockfish stream (the backend runs
  // its own leaf engine); keyed and race-guarded like the tier-0 policy fetch.
  // The tier-0 result keeps rendering while this is in flight — the tree value
  // replaces it when it lands.
  useEffect(() => {
    if (treeDebounceRef.current) clearTimeout(treeDebounceRef.current);

    if (!tree || band === null || !available || !engineRunning || !analysisFen) {
      setTreeLoading(false);
      return;
    }

    const key = `${analysisFen}|${band}`;
    const hit = treeCacheRef.current.get(key);
    if (hit) {
      setCachedTree({ key, result: hit });
      setTreeLoading(false);
      setTreeError(null);
      return;
    }

    const reqId = ++treeReqIdRef.current;
    setTreeLoading(true);
    treeDebounceRef.current = setTimeout(() => {
      humanEvalTree(analysisFen, band)
        .then((result) => {
          if (reqId !== treeReqIdRef.current) return; // superseded
          const c = treeCacheRef.current;
          c.set(key, result);
          if (c.size > TREE_CACHE_LIMIT) c.delete(c.keys().next().value as string);
          setCachedTree({ key, result });
          setTreeError(null);
          setTreeLoading(false);
        })
        .catch((e) => {
          if (reqId !== treeReqIdRef.current) return;
          setTreeError(String(e));
          setCachedTree(null);
          setTreeLoading(false);
        });
    }, TREE_DEBOUNCE_MS);

    return () => {
      if (treeDebounceRef.current) clearTimeout(treeDebounceRef.current);
    };
  }, [analysisFen, band, tree, available, engineRunning]);

  // Perception-curve sweep (spec 213 Phase 3, the flagship visual): with tree
  // mode on, sweep every slider stop for the current position in the
  // background. Points stream in one stop at a time — the chart fills in
  // progressively. Keyed on the position ONLY (`sweepEnabled` collapses the
  // gating flags), so moving the slider never restarts a sweep; the backend
  // cancels a superseded sweep per node, and the shared transposition table
  // means a restart resumes roughly where the old sweep stopped.
  const sweepEnabled = tree && band !== null && available && engineRunning;
  useEffect(() => {
    if (sweepDebounceRef.current) clearTimeout(sweepDebounceRef.current);

    if (!sweepEnabled || !analysisFen) {
      setSweepLoading(false);
      return;
    }

    const fen = analysisFen;
    const hit = sweepCacheRef.current.get(fen);
    if (hit) {
      setSweep({ fen, points: hit });
      setSweepLoading(false);
      setSweepError(null);
      return;
    }

    const reqId = ++sweepReqIdRef.current;
    let launched = false;
    setSweepLoading(true);
    sweepDebounceRef.current = setTimeout(() => {
      launched = true;
      setSweep({ fen, points: [] });
      setSweepError(null);
      humanEvalSweep(fen, [...MAIA_SLIDER_BANDS], {}, (p) => {
        if (reqId !== sweepReqIdRef.current) return; // superseded
        setSweep((cur) =>
          cur && cur.fen === fen ? { fen, points: [...cur.points, p] } : { fen, points: [p] }
        );
      })
        .then((r) => {
          if (reqId !== sweepReqIdRef.current) return;
          if (!r.cancelled) {
            const c = sweepCacheRef.current;
            c.set(fen, r.points);
            if (c.size > SWEEP_CACHE_LIMIT) c.delete(c.keys().next().value as string);
            setSweep({ fen, points: r.points });
            setSweepError(null);
          }
          setSweepLoading(false);
        })
        .catch((e) => {
          if (reqId !== sweepReqIdRef.current) return;
          setSweepError(String(e));
          setSweepLoading(false);
        });
    }, SWEEP_DEBOUNCE_MS);

    return () => {
      if (sweepDebounceRef.current) clearTimeout(sweepDebounceRef.current);
      // Free the backend promptly: a stale sweep would otherwise hold the
      // shared TT lock (and both engines) for seconds per remaining stop.
      if (launched) humanEvalSweepCancel().catch(() => {});
    };
  }, [analysisFen, sweepEnabled]);

  // Recompute the blend from the current policy + live Stockfish lines. Cheap
  // and pure, so it re-runs on every depth tick without touching lc0.
  const result = useMemo<HumanEvalResult | null>(() => {
    if (band === null || !cached) return null;
    if (cached.fen !== analysisFen || cached.band !== band) return null;
    return computeHumanEval({ fen: analysisFen, scoreTurn, lines, policy: cached.policy });
  }, [band, cached, analysisFen, scoreTurn, lines]);

  // Tree result only counts when it matches the position/band on screen.
  const treeResult = useMemo<HumanTreeResult | null>(() => {
    if (!tree || band === null || !cachedTree) return null;
    if (cachedTree.key !== `${analysisFen}|${band}`) return null;
    return cachedTree.result;
  }, [tree, band, cachedTree, analysisFen]);

  // Sweep points only count for the position on screen.
  const sweepPoints = useMemo<HumanTreeResult[] | null>(() => {
    if (!sweepEnabled || !sweep || sweep.fen !== analysisFen) return null;
    return sweep.points;
  }, [sweepEnabled, sweep, analysisFen]);

  return {
    available,
    status,
    band,
    setBand,
    result,
    loading,
    error,
    tree,
    setTree,
    treeResult,
    treeLoading,
    treeError,
    sweepPoints,
    sweepLoading,
    sweepError,
  };
}
