import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { parseUciInfo, uciMovesToSan, type PvLine } from "../lib/uciParser";

const DEFAULT_ENGINE_PATH = "/Users/hjalti/Documents/GitHub/Stockfish/src/stockfish";
const STORAGE_KEY = "engine-path";
const DEBOUNCE_MS = 50;
const DEFAULT_MULTI_PV = 3;

export interface EngineState {
  isRunning: boolean;
  engineName: string | null;
  isAnalyzing: boolean;
  lines: PvLine[];
  depth: number;
  nodes: number;
  nps: number;
}

const initialState: EngineState = {
  isRunning: false,
  engineName: null,
  isAnalyzing: false,
  lines: [],
  depth: 0,
  nodes: 0,
  nps: 0,
};

export function useEngine(fen: string) {
  const [state, setState] = useState<EngineState>(initialState);
  const fenRef = useRef(fen);
  const isAnalyzingRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const unlistenRef = useRef<(() => void) | null>(null);
  const prevFenRef = useRef(fen);

  fenRef.current = fen;

  const sendCommand = useCallback(async (cmd: string) => {
    try {
      await invoke("send_command", { command: cmd });
    } catch {
      // Engine may have stopped
    }
  }, []);

  const startAnalysis = useCallback(
    async (position: string) => {
      await sendCommand("stop");
      setState((s) => ({ ...s, lines: [], depth: 0, nodes: 0, nps: 0 }));
      await sendCommand(`position fen ${position}`);
      await sendCommand("go infinite");
      isAnalyzingRef.current = true;
      setState((s) => ({ ...s, isAnalyzing: true }));
    },
    [sendCommand],
  );

  const stopAnalysis = useCallback(async () => {
    await sendCommand("stop");
    isAnalyzingRef.current = false;
    setState((s) => ({ ...s, isAnalyzing: false }));
  }, [sendCommand]);

  const startEngine = useCallback(
    async (path?: string) => {
      const enginePath = path || localStorage.getItem(STORAGE_KEY) || DEFAULT_ENGINE_PATH;

      try {
        const result = await invoke<{ name: string; ready: boolean }>("start_engine", {
          path: enginePath,
        });

        localStorage.setItem(STORAGE_KEY, enginePath);

        // Set MultiPV before starting analysis
        await sendCommand(`setoption name MultiPV value ${DEFAULT_MULTI_PV}`);
        await sendCommand("isready");

        setState((s) => ({
          ...s,
          isRunning: true,
          engineName: result.name,
        }));

        // Start analyzing current position
        startAnalysis(fenRef.current);
      } catch (e) {
        console.error("Failed to start engine:", e);
        throw e;
      }
    },
    [sendCommand, startAnalysis],
  );

  const stopEngine = useCallback(async () => {
    try {
      await invoke("stop_engine");
    } catch {
      // ignore
    }
    isAnalyzingRef.current = false;
    setState(initialState);
  }, []);

  const toggleAnalysis = useCallback(async () => {
    if (isAnalyzingRef.current) {
      await stopAnalysis();
    } else {
      await startAnalysis(fenRef.current);
    }
  }, [stopAnalysis, startAnalysis]);

  // Subscribe to engine output events
  useEffect(() => {
    let cancelled = false;

    listen<string>("engine-output", (event) => {
      if (cancelled) return;
      const line = event.payload;

      const info = parseUciInfo(line);
      if (!info) return;

      const sanMoves = uciMovesToSan(fenRef.current, info.pv);

      const pvLine: PvLine = {
        multipv: info.multipv,
        score: info.score,
        depth: info.depth,
        sanMoves,
        uciMoves: info.pv,
      };

      setState((s) => {
        if (!s.isRunning) return s;

        const newLines = [...s.lines];
        const idx = newLines.findIndex((l) => l.multipv === info.multipv);
        if (idx >= 0) {
          newLines[idx] = pvLine;
        } else {
          newLines.push(pvLine);
          newLines.sort((a, b) => a.multipv - b.multipv);
        }

        return {
          ...s,
          lines: newLines,
          depth: info.multipv === 1 ? info.depth : s.depth,
          nodes: info.nodes ?? s.nodes,
          nps: info.nps ?? s.nps,
        };
      });
    }).then((unlisten) => {
      if (cancelled) {
        unlisten();
      } else {
        unlistenRef.current = unlisten;
      }
    });

    return () => {
      cancelled = true;
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
  }, []);

  // Auto-analyze on position change (debounced)
  useEffect(() => {
    // Only re-analyze when the fen actually changed, not when isRunning flips
    const fenChanged = prevFenRef.current !== fen;
    prevFenRef.current = fen;

    if (!fenChanged || !state.isRunning || !isAnalyzingRef.current) return;

    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(() => {
      startAnalysis(fen);
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [fen, state.isRunning, startAnalysis]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      invoke("stop_engine").catch(() => {});
    };
  }, []);

  return {
    state,
    startEngine,
    stopEngine,
    toggleAnalysis,
  };
}
