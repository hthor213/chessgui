// Rival-book domain types (spec 214) — extracted to @chessgui/core
// (spec 220 step 5).

import type { SparColor } from "./spar-types";

export interface RivalBookEntry {
  fen: string;
  /** SAN line with move numbers, e.g. "1.e4 c5 2.Nf3". */
  line: string;
  ply: number;
  /** The colour the rival played in the game this line came from. */
  rival_color: SparColor;
  weight: number;
}

export interface RivalBook {
  version: number;
  max_ply: number;
  rival: string;
  entries: RivalBookEntry[];
  stats?: Record<string, number>;
}
