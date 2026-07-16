// Maia domain types (spec 213/214) — extracted to @chessgui/core (spec 220 step 5).

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
