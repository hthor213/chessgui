// Rival opening book loader + sampler (spec 214, Tier 0 "Spar vs rival").
//
// The book is built by scripts/persona/build_rival_book.py from the rival's real
// games (dad's chess.com PGNs). Each entry is a position the rival reached after
// one of their own opening moves, weighted by how often. A sparring game starts
// from a weighted sample of the book, so the opening resembles the rival's real
// repertoire; the user plays the OPPOSITE colour (the side to move in the FEN).
//
// Provider seam: inside Tauri the book is read from the local (gitignored)
// data/rivals via the `rival_book` command; outside Tauri a small canned book is
// used so the flow is drivable headless. The mock is dynamically imported so it
// stays out of the Tauri bundle.

import { invoke } from "@tauri-apps/api/core";
import type { SparColor } from "@/lib/spar";
import { turnOf } from "@/lib/spar";

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

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** The user's colour for an entry: the side to move in the FEN, i.e. the
 *  opposite of the colour the rival played. */
export function userColorForEntry(entry: RivalBookEntry): SparColor {
  return turnOf(entry.fen);
}

/** Load the rival book. Rejects with the backend's error string when the book
 *  hasn't been built; the UI surfaces that as a "build the book" hint. */
export async function loadRivalBook(): Promise<RivalBook> {
  if (!isTauri()) {
    return import("./rival-book-mock").then((m) => m.mockRivalBook());
  }
  return invoke<RivalBook>("rival_book");
}

export interface PickOptions {
  /** Restrict to lines where the USER plays this colour (Either = no filter). */
  userColor?: SparColor;
  /** Prefer starts at least this deep, for a few moves of real opening context;
   *  falls back to shallower lines if the filter would empty the pool. */
  preferMinPly?: number;
}

/**
 * Weighted-random pick of a starting line. `rng` returns a uniform in [0, 1)
 * (injected so tests are deterministic). Filters by requested user colour, then
 * prefers lines at `preferMinPly`+ so the game starts a few moves into a real
 * opening rather than at move 1; if that empties the pool it relaxes the depth,
 * then the colour. Returns null only for an empty book.
 */
export function pickBookEntry(
  entries: RivalBookEntry[],
  rng: () => number,
  opts: PickOptions = {},
): RivalBookEntry | null {
  if (entries.length === 0) return null;
  const { userColor, preferMinPly = 3 } = opts;

  const byColor = userColor
    ? entries.filter((e) => userColorForEntry(e) === userColor)
    : entries;
  // Progressive relaxation: (colour ∧ deep) → (colour) → (all).
  const pool =
    pickPool(byColor.filter((e) => e.ply >= preferMinPly)) ??
    pickPool(byColor) ??
    entries;

  return weightedChoice(pool, rng);
}

/** A non-empty pool, or null so the caller can relax its filter. */
function pickPool(entries: RivalBookEntry[]): RivalBookEntry[] | null {
  return entries.length > 0 ? entries : null;
}

function weightedChoice(entries: RivalBookEntry[], rng: () => number): RivalBookEntry {
  const total = entries.reduce((s, e) => s + Math.max(0, e.weight), 0);
  if (total <= 0) return entries[Math.min(entries.length - 1, Math.floor(rng() * entries.length))];
  let target = rng() * total;
  for (const e of entries) {
    target -= Math.max(0, e.weight);
    if (target < 0) return e;
  }
  return entries[entries.length - 1];
}
