import { useState, useEffect, useRef, useCallback } from "react";
import { getProviders } from "@/lib/platform";
import { Chess } from "chessops/chess";
import { parseFen } from "chessops/fen";
import { parseUciInfo, uciMovesToSan, parseEngineUci, type PvLine } from "@/lib/uci-parser";
import {
  defaultEnginePath,
  clearEnginePath,
  defaultEngineSettings,
  loadEnginePath,
  loadEngineSettings,
  saveEnginePath,
  saveEngineSettings,
  type EngineSettings,
} from "@/lib/engine-settings";
import { getOpeningBookMove } from "@/lib/opening-book";

const DEBOUNCE_MS = 50;

// Engine pacing in play mode (spec 216 UI:4 — "Same slider in Play vs engine
// ... engine's is virtual"). Persisted separately from EngineSettings since
// it governs move timing, not the UCI options applied between searches.
const ENGINE_PACE_STORAGE_KEY = "engine-pace-seconds";
// Reproduces the pre-216 hardcoded 10min+5s clock exactly (see
// clockForPaceSeconds below), so an untouched slider changes nothing.
const DEFAULT_ENGINE_PACE_SECONDS = 20;

function loadEnginePaceSeconds(): number {
  if (typeof window === "undefined") return DEFAULT_ENGINE_PACE_SECONDS;
  const raw = localStorage.getItem(ENGINE_PACE_STORAGE_KEY);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_ENGINE_PACE_SECONDS;
}

/**
 * Seconds-per-move -> a UCI wtime/winc pair. Fixes the increment at 25% of
 * the target and the base pool at a 40-move (MOVE_BUDGET) buffer of the
 * remainder, so lib/time-elo.ts's own averaging model — secondsPerMoveOf =
 * base/40 + increment — reproduces the target exactly: at the default 20s
 * this is base=600000ms/inc=5000ms, i.e. the original hardcoded clock.
 */
function clockForPaceSeconds(paceSeconds: number): { baseMs: number; incMs: number } {
  const s = Math.max(0.1, paceSeconds);
  const incMs = Math.max(50, Math.round(s * 250));
  const baseMs = Math.max(incMs, Math.round(s * 30000));
  return { baseMs, incMs };
}

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
  analysisFen: string; // position the current `lines` were computed for ("" before first search)
  lines: PvLine[];
  depth: number;
  nodes: number;
  nps: number;
}

function turnFromFen(fen: string): "white" | "black" {
  return fen.split(" ")[1] === "b" ? "black" : "white";
}

/**
 * Whether the engine should play a move for the current position. True only in
 * play mode when it's the engine's turn AND the board is at the live tip. So
 * reviewing history, or taking a move back (which lands on the user's turn),
 * never makes the engine re-play its move. Pure + exported for testing.
 */
export function shouldEngineMove(s: {
  mode: EngineMode;
  isRunning: boolean;
  turn: "white" | "black";
  playerColor: PlayerColor;
  atLatestMove: boolean;
}): boolean {
  if (!s.isRunning || s.mode !== "play") return false;
  const engineColor: "white" | "black" = s.playerColor === "white" ? "black" : "white";
  return s.turn === engineColor && s.atLatestMove;
}

const initialState: EngineState = {
  isRunning: false,
  engineName: null,
  isAnalyzing: false,
  mode: "analysis",
  playerColor: "white",
  isThinking: false,
  scoreTurn: "white",
  analysisFen: "",
  lines: [],
  depth: 0,
  nodes: 0,
  nps: 0,
};

const INITIAL_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function buildPositionCommand(startFen: string, uciMoves: string[], upToIndex: number): string {
  const moves = uciMoves.slice(0, upToIndex + 1);
  const isStandard = startFen === INITIAL_FEN;
  const base = isStandard ? "position startpos" : `position fen ${startFen}`;
  return moves.length > 0 ? `${base} moves ${moves.join(" ")}` : base;
}

export function useEngine(
  fen: string,
  onBestMove?: (uciMove: string) => void,
  atLatestMove = true,
  uciMoves: string[] = [],
  startFen: string = INITIAL_FEN,
  currentMoveIndex = -1,
) {
  const [state, setState] = useState<EngineState>(initialState);
  // Settings start at defaults for SSR consistency; hydrated from
  // localStorage after mount (same pattern as the saved game state).
  const [settings, setSettings] = useState<EngineSettings>(defaultEngineSettings);
  const settingsRef = useRef(settings);
  // Hash/Threads values last sent to the running engine process — lets us
  // skip redundant setoptions (re-sending Hash makes Stockfish reallocate
  // and clear the table, which would wreck analysis continuity).
  const appliedOptionsRef = useRef<{ hash: number; threads: number } | null>(null);
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
  
  // Real-time opponent clock simulation state (starts at 10|5, i.e. the
  // default 20s/move pace — see clockForPaceSeconds)
  const engineClockRef = useRef<{wtime: number, btime: number}>({ wtime: 600000, btime: 600000 });
  const turnStartTimeRef = useRef<number>(0);
  // Engine pacing (spec 216 UI:4): seconds/move the engine's virtual clock
  // budgets it. Starts at the SSR-safe default; hydrated from localStorage
  // after mount (same pattern as engine settings).
  const [enginePaceSeconds, setEnginePaceSecondsState] = useState<number>(DEFAULT_ENGINE_PACE_SECONDS);
  const enginePaceSecondsRef = useRef<number>(DEFAULT_ENGINE_PACE_SECONDS);
  useEffect(() => {
    const loaded = loadEnginePaceSeconds();
    enginePaceSecondsRef.current = loaded;
    setEnginePaceSecondsState(loaded);
  }, []);
  const setEnginePaceSeconds = useCallback((seconds: number) => {
    const clamped = Math.max(0.1, seconds);
    enginePaceSecondsRef.current = clamped;
    setEnginePaceSecondsState(clamped);
    try {
      localStorage.setItem(ENGINE_PACE_STORAGE_KEY, String(clamped));
    } catch {
      // localStorage unavailable — pace just won't persist
    }
  }, []);
  const uciMovesRef = useRef(uciMoves);
  const startFenRef = useRef(startFen);
  const moveIndexRef = useRef(currentMoveIndex);

  fenRef.current = fen;
  onBestMoveRef.current = onBestMove;
  atLatestMoveRef.current = atLatestMove;
  uciMovesRef.current = uciMoves;
  startFenRef.current = startFen;
  moveIndexRef.current = currentMoveIndex;

  // User-selected engine binary (spec 011). SSR-safe default, hydrated from
  // localStorage after mount (same pattern as engine settings).
  const [enginePath, setEnginePathState] = useState<string>(defaultEnginePath);

  useEffect(() => {
    const loaded = loadEngineSettings();
    settingsRef.current = loaded;
    setSettings(loaded);
    setEnginePathState(loadEnginePath());
  }, []);

  const sendCommand = useCallback(async (cmd: string) => {
    try {
      console.log("[engine] >>", cmd);
      await getProviders().engine.sendCommand(cmd);
    } catch (e) {
      console.error("[engine] send failed:", cmd, e);
    }
  }, []);

  // Send Hash/Threads to the engine if they differ from what it already has.
  // Only call between searches (after "stop" + "isready").
  const applyEngineOptions = useCallback(async () => {
    const s = settingsRef.current;
    const applied = appliedOptionsRef.current;
    if (applied?.hash === s.hash && applied?.threads === s.threads) return;
    await sendCommand(`setoption name Threads value ${s.threads}`);
    await sendCommand(`setoption name Hash value ${s.hash}`);
    appliedOptionsRef.current = { hash: s.hash, threads: s.threads };
  }, [sendCommand]);

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
      await sendCommand("isready"); // sync: wait for engine to fully stop
      await applyEngineOptions(); // pick up Hash/Threads changed mid-session
      // Play mode: MultiPV 1 keeps hash focused on best line for stronger play
      // Analysis mode: user-configured MultiPV shows candidate lines
      const mpv = modeRef.current === "play" ? 1 : settingsRef.current.multiPv;
      await sendCommand(`setoption name MultiPV value ${mpv}`);
      setState((s) => ({ ...s, scoreTurn: turnFromFen(position), analysisFen: position, lines: [], depth: 0, nodes: 0, nps: 0 }));
      const posCmd = buildPositionCommand(startFenRef.current, uciMovesRef.current, moveIndexRef.current);
      await sendCommand(posCmd);
      await sendCommand("go infinite");
      isAnalyzingRef.current = true;
      setState((s) => ({ ...s, isAnalyzing: true }));
    },
    [sendCommand, applyEngineOptions],
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

      // Check opening book first!
      const bookMove = await getOpeningBookMove(position);
      if (bookMove) {
        console.log("[engine] Playing book move!", bookMove);
        thinkingRef.current = false;

        // Slight delay so the UI feels somewhat realistic. Guard at fire time:
        // if the user took the move back (or navigated / left play mode) during
        // the delay, the board has moved off `position` — don't play a stale
        // reply onto it. (The engine-search path is already guarded by
        // thinkingRef in the bestmove listener.)
        setTimeout(() => {
          if (modeRef.current !== "play" || fenRef.current !== position) return;
          setState((s) => ({ ...s, isThinking: false }));
          if (onBestMoveRef.current) {
            onBestMoveRef.current(bookMove);
          }
        }, 600);
        return;
      }

      thinkingRef.current = false; // disarm any stale bestmove from a previous search
      isAnalyzingRef.current = false;
      expectedFenRef.current = position;

      // Engine was analyzing at MultiPV 1 during human's turn, hash table is warm.
      // Just stop, sync, send new position, and search.
      await sendCommand("stop");
      await sendCommand("isready"); // sync: wait for engine to fully stop
      await applyEngineOptions(); // pick up Hash/Threads changed mid-session
      setState((s) => ({ ...s, isThinking: true, isAnalyzing: false, scoreTurn: turnFromFen(position), lines: [], depth: 0, nodes: 0, nps: 0 }));
      thinkingRef.current = true;
      turnStartTimeRef.current = Date.now();
      
      const posCmd = buildPositionCommand(startFenRef.current, uciMovesRef.current, moveIndexRef.current);
      await sendCommand(posCmd);
      const playerColor = playerColorRef.current;
      const wtime = playerColor === "white" ? 2147483647 : engineClockRef.current.wtime;
      const btime = playerColor === "black" ? 2147483647 : engineClockRef.current.btime;
      const { incMs } = clockForPaceSeconds(enginePaceSecondsRef.current);

      await sendCommand(`go wtime ${wtime} btime ${btime} winc ${incMs} binc ${incMs}`);
    },
    [sendCommand, applyEngineOptions],
  );

  const playerColorRef = useRef<PlayerColor>("white");

  const startEngine = useCallback(
    async (path?: string, mode: EngineMode = "analysis", playerColor: PlayerColor = "white") => {
      const requestedPath = path || loadEnginePath();
      const engine = getProviders().engine;

      let result: { name: string; ready: boolean };
      try {
        result = await engine.startEngine(requestedPath);
        saveEnginePath(requestedPath);
        setEnginePathState(requestedPath);
      } catch (e) {
        // A stale stored path (e.g. an engine binary that has since moved or been
        // deleted) shouldn't permanently wedge the engine. If the failed path was
        // not already the shell's default, clear it and retry with the default.
        if (requestedPath !== defaultEnginePath()) {
          console.warn(`Engine path "${requestedPath}" failed (${e}); retrying with default.`);
          clearEnginePath();
          result = await engine.startEngine(defaultEnginePath());
          saveEnginePath(defaultEnginePath());
          setEnginePathState(defaultEnginePath());
        } else {
          console.error("Failed to start engine:", e);
          throw e;
        }
      }

      try {
        modeRef.current = mode;
        playerColorRef.current = playerColor;

        // Fresh engine process: forget previously-applied options and send
        // the user's configured Hash/Threads.
        appliedOptionsRef.current = null;
        await applyEngineOptions();
        await sendCommand("isready");

        // Reset match clock for the new session, sized to the current pace.
        const { baseMs: paceBaseMs } = clockForPaceSeconds(enginePaceSecondsRef.current);
        engineClockRef.current = { wtime: paceBaseMs, btime: paceBaseMs };
        turnStartTimeRef.current = Date.now();

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
    [sendCommand, applyEngineOptions, startAnalysis, requestMove],
  );

  // Persist new settings and apply them to a running engine. Hash/Threads
  // are sent between searches; MultiPV takes effect by restarting analysis.
  const updateSettings = useCallback(
    async (next: EngineSettings) => {
      const prev = settingsRef.current;
      settingsRef.current = next;
      saveEngineSettings(next);
      setSettings(next);

      const engineFacing =
        prev.hash !== next.hash || prev.threads !== next.threads || prev.multiPv !== next.multiPv;
      if (!engineFacing || !state.isRunning) return;

      // Don't interrupt the engine mid-move in play mode — the new options
      // are picked up by applyEngineOptions on the next search.
      if (thinkingRef.current) return;

      if (isAnalyzingRef.current) {
        // startAnalysis stops, syncs, applies options and MultiPV, restarts
        await startAnalysis(fenRef.current);
      } else {
        await sendCommand("stop");
        await sendCommand("isready");
        await applyEngineOptions();
      }
    },
    [state.isRunning, startAnalysis, sendCommand, applyEngineOptions],
  );

  // Persist a newly picked engine binary (spec 011). If an engine is running,
  // restart on the new binary in the same mode/side; otherwise the path is
  // simply used on the next start.
  const updateEnginePath = useCallback(
    async (path: string) => {
      if (path === enginePath) return;
      saveEnginePath(path);
      setEnginePathState(path);
      if (!state.isRunning) return;

      await getProviders().engine.stopEngine().catch(() => {});
      isAnalyzingRef.current = false;
      await startEngine(path, modeRef.current, playerColorRef.current);
    },
    [enginePath, state.isRunning, startEngine],
  );

  const stopEngine = useCallback(async () => {
    try {
      await getProviders().engine.stopEngine();
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

    getProviders().engine.onEngineLine((line) => {
      if (cancelled) return;
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
                const move = parseEngineUci(pos.unwrap(), bestmove);
                if (!move || !pos.unwrap().isLegal(move)) {
                  console.warn("[engine] ignoring stale/illegal bestmove:", bestmove);
                  return;
                }
              }
            }
          }

          thinkingRef.current = false;
          setState((s) => ({ ...s, isThinking: false }));
          
          // Decrement internal clock to simulate a real opponent
          const timeSpent = Date.now() - turnStartTimeRef.current;
          const isWhiteTurn = expectedFenRef.current?.includes(" w ");
          const { incMs: paceIncMs } = clockForPaceSeconds(enginePaceSecondsRef.current);
          if (isWhiteTurn) {
            engineClockRef.current.wtime = Math.max(1000, engineClockRef.current.wtime - timeSpent + paceIncMs);
          } else {
            engineClockRef.current.btime = Math.max(1000, engineClockRef.current.btime - timeSpent + paceIncMs);
          }
          
          turnStartTimeRef.current = Date.now(); // Clock reset for human's stopwatch

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
      // The engine plays only when it's its turn AND we're at the live tip.
      // After a take-back (truncates to the user's turn) or while the user
      // reviews history, shouldEngineMove is false, so the engine waits for the
      // user's move instead of re-thinking/replaying its own.
      const engineTurn = shouldEngineMove({
        mode: "play",
        isRunning: true,
        turn: turnFromFen(fen),
        playerColor: playerColorRef.current,
        atLatestMove: atLatestMoveRef.current,
      });
      if (engineTurn) {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
          requestMove(fen);
        }, 100);
      } else {
        // Human's turn (or reviewing) — run continuous analysis so the eval
        // stays live. Never makes a move.
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
      getProviders().engine.stopEngine().catch(() => {});
    };
  }, []);

  return {
    state,
    settings,
    updateSettings,
    enginePath,
    updateEnginePath,
    startEngine,
    stopEngine,
    toggleAnalysis,
    setPlayMode,
    requestMove,
    cancelThinking,
    clockRef: engineClockRef,
    turnStartTimeRef,
    enginePaceSeconds,
    setEnginePaceSeconds,
  };
}
