// In-memory calibration sampler, used outside Tauri (a plain browser under
// Playwright, or unit tests) so the whole Learn flow is drivable headless.
// `window.__TAURI_INTERNALS__` is absent there, so lib/calibration.ts routes to
// this instead of the Rust `calibration_sample` command. Dynamically imported,
// so it never ships in the Tauri bundle.

import type {
  CalibrationPosition,
  CalibrationProgress,
  CalibrationSession,
  CoachFeedback,
  CoachInput,
} from "./calibration"

// A handful of real, legal positions with plausible (fabricated) Stockfish
// ground truth — one per (band × phase) corner plus spares. The board only
// needs the FEN to be legal and the best move to be a legal UCI; the eval
// numbers are stand-ins for the real engine the desktop app runs.
const SAMPLES: CalibrationPosition[] = [
  {
    // After 1.e4 e5 2.Nf3 Nc6 3.Bb5 — Ruy López, roughly equal.
    fen: "r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3",
    sf_cp: 25,
    sf_mate: null,
    sf_best_uci: "a7a6",
    sf_best_san: "a6",
    multipv_gap_cp: 20,
    material: 0,
    band: "0-0.5",
    phase: "middlegame",
    game_id: 1001,
    ply: 6,
    white_elo: 1520,
    black_elo: 1540,
    elo_band: "<1600",
    to_move: "black",
    played_uci: "a7a6",
    played_san: "a6",
    continuation_san: ["Ba4", "Nf6"],
  },
  {
    // Italian, White slightly better development.
    fen: "r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4",
    sf_cp: 80,
    sf_mate: null,
    sf_best_uci: "c2c3",
    sf_best_san: "c3",
    multipv_gap_cp: 55,
    material: 0,
    band: "0.5-1.5",
    phase: "middlegame",
    game_id: 1002,
    ply: 6,
    white_elo: 1850,
    black_elo: 1820,
    elo_band: "1600-2000",
    to_move: "white",
    played_uci: "e1g1",
    played_san: "O-O",
    continuation_san: ["Nf6", "d3"],
  },
  {
    // Middlegame, White up a clear pawn and pressing.
    fen: "r3k2r/ppp2ppp/2n1b3/3q4/3P4/2N1B3/PPP2PPP/R2QK2R w KQkq - 0 10",
    sf_cp: 210,
    sf_mate: null,
    sf_best_uci: "d1d2",
    sf_best_san: "Qd2",
    multipv_gap_cp: 130,
    material: 0,
    band: "1.5-3",
    phase: "middlegame",
    game_id: 1003,
    ply: 18,
    white_elo: 2210,
    black_elo: 2180,
    elo_band: "2000-2400",
    to_move: "white",
    played_uci: "d1d2",
    played_san: "Qd2",
    continuation_san: ["O-O-O", "Rd8"],
  },
  {
    // K+R vs K — winning endgame.
    fen: "8/8/4k3/8/4K3/8/3R4/8 w - - 0 1",
    sf_cp: 650,
    sf_mate: null,
    sf_best_uci: "e4d4",
    sf_best_san: "Kd4",
    multipv_gap_cp: 300,
    material: 5,
    band: "3+",
    phase: "endgame",
    game_id: 1004,
    ply: 62,
    white_elo: 2600,
    black_elo: 2550,
    elo_band: "2400+",
    to_move: "white",
    played_uci: "e4d4",
    played_san: "Kd4",
    continuation_san: ["Kf6", "Rd6+"],
  },
  {
    // Pawn endgame, near-equal.
    fen: "8/5pk1/6p1/6P1/5PK1/8/8/8 w - - 0 1",
    sf_cp: 15,
    sf_mate: null,
    sf_best_uci: "f4f5",
    sf_best_san: "f5",
    multipv_gap_cp: 25,
    material: 0,
    band: "0-0.5",
    phase: "endgame",
    game_id: 1005,
    ply: 54,
    white_elo: 1500,
    black_elo: 1480,
    elo_band: "<1600",
    to_move: "white",
    played_uci: "f4f5",
    played_san: "f5",
    continuation_san: ["gxf5+", "Kxf5"],
  },
  {
    // Sharp middlegame, Black clearly better.
    fen: "r1b2rk1/pp1n1ppp/2p1pn2/q7/2BP4/2N1PN2/PP3PPP/R2Q1RK1 b - - 0 11",
    sf_cp: -170,
    sf_mate: null,
    sf_best_uci: "a5c7",
    sf_best_san: "Qc7",
    multipv_gap_cp: 90,
    material: 0,
    band: "1.5-3",
    phase: "middlegame",
    game_id: 1006,
    ply: 22,
    white_elo: 2300,
    black_elo: 2250,
    elo_band: "2000-2400",
    to_move: "black",
    played_uci: "a5c7",
    played_san: "Qc7",
    continuation_san: ["e4", "e5"],
  },
]

/**
 * Build a mock session of `n` positions by cycling the sample set, ticking
 * `onProgress` a few times to exercise the progress UI. Async so it matches the
 * real command's shape.
 */
export async function buildMockSession(
  n: number,
  onProgress?: (p: CalibrationProgress) => void,
): Promise<CalibrationSession> {
  const positions: CalibrationPosition[] = []
  for (let i = 0; i < n; i++) {
    positions.push({ ...SAMPLES[i % SAMPLES.length] })
    if (onProgress && (i % Math.max(1, Math.floor(n / 4)) === 0 || i === n - 1)) {
      onProgress({ evaluated: i + 1, accepted: i + 1, target: n })
    }
  }
  return {
    version: 2,
    n: positions.length,
    created_at: Date.now(),
    stockfish_path: "(mock)",
    positions,
  }
}

/** Canned coach critique for headless/browser runs (no API call). Echoes a
 *  couple of the input's own details so the UI wiring is visibly exercised. */
/** Canned follow-up reply for headless/browser runs (no API call). */
export async function mockCoachFollowup(rebuttal: string): Promise<string> {
  await new Promise((r) => setTimeout(r, 150))
  const gist = rebuttal.trim().slice(0, 40)
  return `That's a fair pushback ("${gist}…") — your stated reason is a real practical consideration, and the data I have can't fully settle it. Take it to the board and check the line yourself; that instinct to interrogate the engine is exactly right.`
}

export async function mockCoachFeedback(input: CoachInput): Promise<CoachFeedback> {
  await new Promise((r) => setTimeout(r, 150))
  const dir = (input.user_eval ?? 0) >= 0 ? "White" : "Black"
  return {
    note: `You leaned ${dir} here, and the engine agrees on direction — but ${
      input.sf_best_san ? `${input.sf_best_san} is the move` : "the best line"
    } and the margin is smaller than you gave. Your read is sound; the number is what drifted.`,
    cause_tags: ["scale_miscalibration"],
    reasoning_quality: "partial",
    scale_error: true,
  }
}
