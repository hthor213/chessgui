import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { parseUciInfo, uciMovesToSan, type PvLine } from "../lib/uciParser";

const DEFAULT_ENGINE_PATH = "/Users/hjalti/Documents/GitHub/Stockfish/src/stockfish";
const STORAGE_KEY = "engine-path";
const DEBOUNCE_MS = 50;
const DEFAULT_MULTI_PV = 3;

export type EngineMode = "analysis" | "play";

export interface EngineState {
  isRunning: boolean;
  engineName: string | null;
  isAnalyzing: boolean;
  mode: EngineMode;
  isThinking: boolean; // true while engine is computing its move in play mode
  lines: PvLine[];
  depth: number;
  nodes: number;
  nps: number;
}

const initialState: EngineState = {
  isRunning: false,
  engineName: null,
  isAnalyzing: false,
  mode: "analysis",
  isThinking: false,
  lines: [],
  depth: 0,
  nodes: 0,
  nps: 0,
};

export function useEngine(fen: string, onBestMove?: (uciMove: string) => void) {
  const [state, setState] = useState<EngineState>(initialState);
  const fenRef = useRef(fen);
  const isAnalyzingRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const unlistenRef = useRef<(() => void) | null>(null);
  const prevFenRef = useRef(fen);
  const onBestMoveRef = useRef(onBestMove);
  const modeRef = useRef<EngineMode>("analysis");

  const thinkingRef = useRef(false); // guards against stale bestmove responses

  fenRef.current = fen;
  onBestMoveRef.current = onBestMove;

  const sendCommand = useCallback(async (cmd: string) => {
    try {
      console.log("[engine] >>", cmd);
      await invoke("send_command", { command: cmd });
    } catch (e) {
      console.error("[engine] send failed:", cmd, e);
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

  const requestMove = useCallback(
    async (position: string) => {
      console.log("[engine] requestMove called, fen:", position);
      thinkingRef.current = false; // disarm any stale bestmove from a previous stop
      await sendCommand("stop");
      // Small delay to let the engine flush its stale bestmove response
      await new Promise((r) => setTimeout(r, 50));
      thinkingRef.current = true;
      setState((s) => ({ ...s, isThinking: true, lines: [], depth: 0, nodes: 0, nps: 0 }));
      await sendCommand(`position fen ${position}`);
      await sendCommand("go movetime 10000");
    },
    [sendCommand],
  );

  const startEngine = useCallback(
    async (path?: string, mode: EngineMode = "analysis") => {
      const enginePath = path || localStorage.getItem(STORAGE_KEY) || DEFAULT_ENGINE_PATH;

      try {
        const result = await invoke<{ name: string; ready: boolean }>("start_engine", {
          path: enginePath,
        });

        localStorage.setItem(STORAGE_KEY, enginePath);
        modeRef.current = mode;

        // In play mode: MultiPV 1, max strength. In analysis: MultiPV 3.
        const multiPv = mode === "play" ? 1 : DEFAULT_MULTI_PV;
        await sendCommand(`setoption name MultiPV value ${multiPv}`);
        if (mode === "play") {
          await sendCommand("setoption name Threads value 8");
          await sendCommand("setoption name Hash value 512");
        }
        await sendCommand("isready");

        setState((s) => ({
          ...s,
          isRunning: true,
          engineName: result.name,
          mode,
        }));

        if (mode === "analysis") {
          startAnalysis(fenRef.current);
        }
        // In play mode, we wait for the user to move first (user is white)
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
      console.log("[engine] <<", line);

      // Handle bestmove in play mode
      if (line.startsWith("bestmove ")) {
        const parts = line.split(/\s+/);
        const bestmove = parts[1];
        // Only process if we're actually waiting for a play-mode bestmove
        // (thinkingRef guards against stale bestmove from a stopped go infinite)
        if (modeRef.current === "play" && thinkingRef.current && bestmove && bestmove !== "(none)") {
          thinkingRef.current = false;
          setState((s) => ({ ...s, isThinking: false }));
          onBestMoveRef.current?.(bestmove);
        }
        return;
      }

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

  // Auto-analyze on position change (debounced) / auto-play in play mode
  useEffect(() => {
    const fenChanged = prevFenRef.current !== fen;
    prevFenRef.current = fen;

    if (!fenChanged || !state.isRunning) return;

    if (modeRef.current === "play") {
      // In play mode: if it's black's turn, ask engine to move
      if (fen.includes(" b ")) {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
          requestMove(fen);
        }, 100);
      }
    } else {
      // Analysis mode: re-analyze on position change
      if (!isAnalyzingRef.current) return;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        startAnalysis(fen);
      }, DEBOUNCE_MS);
    }

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [fen, state.isRunning, startAnalysis, requestMove]);

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
    requestMove,
  };
}
