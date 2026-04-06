import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Chess } from "chessops/chess";
import { parseFen } from "chessops/fen";
import { parseUci } from "chessops";
import { parseUciInfo, uciMovesToSan, normalizeUciCastling, type PvLine } from "@/lib/uci-parser";

const DEFAULT_ENGINE_PATH = "/Users/hjalti/Documents/GitHub/Stockfish/src/stockfish";
const STORAGE_KEY = "engine-path";
const DEBOUNCE_MS = 50;
const DEFAULT_MULTI_PV = 3;

export type EngineMode = "analysis" | "play";

export type PlayerColor = "white" | "black";

export interface EngineState {
  isRunning: boolean;
  engineName: string | null;
  isAnalyzing: boolean;
  mode: EngineMode;
  playerColor: PlayerColor; // which side the human plays
  isThinking: boolean; // true while engine is computing its move in play mode
  scoreTurn: "white" | "black"; // which side was to move when current lines were computed
  lines: PvLine[];
  depth: number;
  nodes: number;
  nps: number;
}

function turnFromFen(fen: string): "white" | "black" {
  return fen.split(" ")[1] === "b" ? "black" : "white";
}

const initialState: EngineState = {
  isRunning: false,
  engineName: null,
  isAnalyzing: false,
  mode: "analysis",
  playerColor: "white",
  isThinking: false,
  scoreTurn: "white",
  lines: [],
  depth: 0,
  nodes: 0,
  nps: 0,
};

export function useEngine(fen: string, onBestMove?: (uciMove: string) => void, atLatestMove = true) {
  const [state, setState] = useState<EngineState>(initialState);
  const fenRef = useRef(fen);
  const isAnalyzingRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const unlistenRef = useRef<(() => void) | null>(null);
  const prevFenRef = useRef(fen);
  const onBestMoveRef = useRef(onBestMove);
  const atLatestMoveRef = useRef(atLatestMove);
  const modeRef = useRef<EngineMode>("analysis");

  const thinkingRef = useRef(false); // guards against stale bestmove responses
  const expectedFenRef = useRef(""); // FEN we asked the engine to compute on

  fenRef.current = fen;
  onBestMoveRef.current = onBestMove;
  atLatestMoveRef.current = atLatestMove;

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
      // Don't analyze terminal positions
      const setup = parseFen(position);
      if (setup.isOk) {
        const pos = Chess.fromSetup(setup.unwrap());
        if (pos.isOk && pos.unwrap().isEnd()) {
          console.log("[engine] position is terminal, skipping analysis");
          isAnalyzingRef.current = false;
          setState((s) => ({ ...s, isAnalyzing: false, lines: [], depth: 0 }));
          return;
        }
      }

      await sendCommand("stop");
      setState((s) => ({ ...s, scoreTurn: turnFromFen(position), lines: [], depth: 0, nodes: 0, nps: 0 }));
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

      // Don't ask engine to think on terminal positions (checkmate/stalemate)
      const setup = parseFen(position);
      if (setup.isOk) {
        const pos = Chess.fromSetup(setup.unwrap());
        if (pos.isOk && pos.unwrap().isEnd()) {
          console.log("[engine] position is terminal, skipping requestMove");
          setState((s) => ({ ...s, isThinking: false }));
          return;
        }
      }

      thinkingRef.current = false; // disarm any stale bestmove from a previous search
      isAnalyzingRef.current = false;
      expectedFenRef.current = position;

      // Strategy: the engine has been analyzing at MultiPV 3 during the human's
      // think time, building deep lines. Now we just need it to confirm the best
      // move on the new position. Use `go movetime 10000` (10s) — no MultiPV
      // switching needed since PV1 is already the best move. The hash table
      // retains analysis from the human's turn, so the engine starts warm.
      await sendCommand("stop");
      setState((s) => ({ ...s, isThinking: true, isAnalyzing: false, scoreTurn: turnFromFen(position), lines: [], depth: 0, nodes: 0, nps: 0 }));
      thinkingRef.current = true;
      await sendCommand(`position fen ${position}`);
      await sendCommand("isready");
      await sendCommand("go movetime 10000");
    },
    [sendCommand],
  );

  const playerColorRef = useRef<PlayerColor>("white");

  const startEngine = useCallback(
    async (path?: string, mode: EngineMode = "analysis", playerColor: PlayerColor = "white") => {
      const enginePath = path || localStorage.getItem(STORAGE_KEY) || DEFAULT_ENGINE_PATH;

      try {
        const result = await invoke<{ name: string; ready: boolean }>("start_engine", {
          path: enginePath,
        });

        localStorage.setItem(STORAGE_KEY, enginePath);
        modeRef.current = mode;
        playerColorRef.current = playerColor;

        // Always MultiPV 3 — used for both analysis and play mode
        // (bestmove handler reads PV1 for the move to play)
        await sendCommand(`setoption name MultiPV value ${DEFAULT_MULTI_PV}`);
        // Threads: use all cores minus 1 for OS headroom
        // Hash: 4096 MB is optimal for 10-30s analysis (keep hashfull < 30%)
        await sendCommand("setoption name Threads value 11");
        await sendCommand("setoption name Hash value 4096");
        await sendCommand("isready");

        setState((s) => ({
          ...s,
          isRunning: true,
          engineName: result.name,
          mode,
          playerColor,
        }));

        if (mode === "analysis") {
          startAnalysis(fenRef.current);
        } else if (mode === "play") {
          const engineColor = playerColor === "white" ? "b" : "w";
          if (fenRef.current.includes(` ${engineColor} `)) {
            // Engine's turn — make it move
            requestMove(fenRef.current);
          } else {
            // Human's turn — start background analysis
            startAnalysis(fenRef.current);
          }
        }
      } catch (e) {
        console.error("Failed to start engine:", e);
        throw e;
      }
    },
    [sendCommand, startAnalysis, requestMove],
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

  const cancelThinking = useCallback(async () => {
    thinkingRef.current = false;
    await sendCommand("stop");
    setState((s) => ({ ...s, isThinking: false }));
  }, [sendCommand]);

  const setPlayMode = useCallback(
    async (enabled: boolean, playerColor: PlayerColor = "white") => {
      if (!state.isRunning) {
        // Engine not running — start it in the requested mode
        await startEngine(undefined, enabled ? "play" : "analysis", playerColor);
        return;
      }

      await sendCommand("stop");
      isAnalyzingRef.current = false;

      if (enabled) {
        modeRef.current = "play";
        playerColorRef.current = playerColor;
        await sendCommand("isready");
        setState((s) => ({
          ...s,
          mode: "play",
          playerColor,
          isAnalyzing: false,
          isThinking: false,
          lines: [],
          depth: 0,
          nodes: 0,
          nps: 0,
        }));
        const engineColor = playerColor === "white" ? "b" : "w";
        if (fenRef.current.includes(` ${engineColor} `)) {
          requestMove(fenRef.current);
        } else {
          // Human's turn — start background analysis
          startAnalysis(fenRef.current);
        }
      } else {
        modeRef.current = "analysis";
        playerColorRef.current = "white";
        await sendCommand("isready");
        setState((s) => ({
          ...s,
          mode: "analysis",
          playerColor: "white",
          isAnalyzing: false,
          isThinking: false,
          lines: [],
          depth: 0,
          nodes: 0,
          nps: 0,
        }));
        // Resume analysis
        startAnalysis(fenRef.current);
      }
    },
    [state.isRunning, startEngine, sendCommand, requestMove, startAnalysis],
  );

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
        if (modeRef.current === "play" && thinkingRef.current) {
          // Validate bestmove is legal in the position we asked about
          if (bestmove && bestmove !== "(none)" && expectedFenRef.current) {
            const setup = parseFen(expectedFenRef.current);
            if (setup.isOk) {
              const pos = Chess.fromSetup(setup.unwrap());
              if (pos.isOk) {
                const move = parseUci(normalizeUciCastling(bestmove));
                if (!move || !pos.unwrap().isLegal(move)) {
                  console.warn("[engine] ignoring stale/illegal bestmove:", bestmove);
                  return;
                }
              }
            }
          }

          thinkingRef.current = false;
          setState((s) => ({ ...s, isThinking: false }));
          // (none) means game is over (checkmate/stalemate) — nothing to play
          if (bestmove && bestmove !== "(none)") {
            onBestMoveRef.current?.(bestmove);
          }
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
      // In play mode: if it's the engine's turn AND we're at the latest move, ask engine to move.
      // Don't auto-play when the user is navigating history (undo / arrow keys).
      const engineColor = playerColorRef.current === "white" ? "b" : "w";
      if (fen.includes(` ${engineColor} `) && atLatestMoveRef.current) {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
          requestMove(fen);
        }, 100);
      } else {
        // Human's turn — run continuous analysis so eval updates in real-time
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
          startAnalysis(fen);
        }, DEBOUNCE_MS);
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
    setPlayMode,
    requestMove,
    cancelThinking,
  };
}
