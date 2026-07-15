// Typed wrapper over the Rust Maia policy service (src-tauri/src/maia.rs).
//
// Maia is a per-rating human move model; for a position and band it returns the
// probability a rating-R human plays each legal move. Tier-0 of the
// Elo-conditioned evaluator (spec 213) reads one such distribution per slider
// stop and blends the Stockfish eval toward a no-resource baseline by how much
// mass band R puts on Stockfish's move.

import { invoke } from "@tauri-apps/api/core";

/**
 * Slider stops: 200-Elo steps over the bands Maia-1 actually ships (1100–1900).
 * Above 1900 there is no Maia-1 net, so tier-0 cannot be computed there — the
 * high-band path (Maia-2/3) is a later tier. `null` = slider OFF = pure Stockfish.
 */
export const MAIA_SLIDER_BANDS = [1100, 1300, 1500, 1700, 1900] as const;

/** The top band with a validated native net; stops above this would be experimental. */
export const MAIA_MAX_NATIVE_BAND = 1900;

export interface MaiaMove {
  uci: string;
  /** Policy probability in [0, 1]. */
  prob: number;
}

export interface MaiaPolicy {
  band: number;
  moves: MaiaMove[];
  /** Root value-head Q (side-to-move POV), or null if lc0 didn't report it. */
  value: number | null;
}

export interface MaiaStatus {
  lc0_available: boolean;
  lc0_path: string | null;
  bands: number[];
  cached_bands: number[];
}

/** A persona's chosen move (spec 214 Tier 0): sampled from the Maia policy, with
 *  its SAN for the move list. */
export interface PersonaMove {
  uci: string;
  san: string;
}

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * A human-like move for `fen` from the Maia net at `level` (spec 214 "Spar vs
 * rival"): the Rust command reads the `go nodes 1` policy and samples from it at
 * temperature 1 — sampling, not argmax, is what makes it play like a human of
 * that rating. Outside Tauri (Playwright / unit tests) a mock returns a canned
 * legal move so the spar flow is drivable headless.
 */
export async function maiaMove(fen: string, level: number): Promise<PersonaMove> {
  if (!isTauri()) {
    return import("./maia-mock").then((m) => m.mockMaiaMove(fen, level));
  }
  return invoke<PersonaMove>("maia_move", { fen, level });
}

/** lc0 availability + which band weights are already cached. Never throws. */
export async function maiaStatus(): Promise<MaiaStatus> {
  try {
    return await invoke<MaiaStatus>("maia_status");
  } catch {
    // Not in a Tauri shell (web dev), or the command failed: treat as absent.
    return { lc0_available: false, lc0_path: null, bands: [], cached_bands: [] };
  }
}

/** Root policy for `fen` at `band`. Rejects with the backend's error string. */
export async function maiaPolicy(fen: string, band: number): Promise<MaiaPolicy> {
  return invoke<MaiaPolicy>("maia_policy", { fen, band });
}
