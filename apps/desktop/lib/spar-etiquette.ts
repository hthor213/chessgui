// Resign + draw-offer etiquette (spec 214 contract step 7 made real —
// realism audit wave R3.2).
//
// A human opponent resigns lost positions and offers draws in dead-equal
// ones; the shipped bot did neither (draw ACCEPTANCE only, lib/spar.ts).
// Both rules read the bot-POV chosen-candidate eval the step-9 decision log
// already carries — no new search. Both are VISIBLE rules (spec 214 hard
// line, same tooltip treatment as spar.ts's DRAW_OFFER_RULE_DESCRIPTION):
// the descriptions below ship verbatim into the UI, never hidden dice.
//
// Eval evidence exists only on the bot's own out-of-book decisions (one per
// 2 plies of game), so "consecutive" counts own decisions: the draw rule's
// "quiet for 6 plies" is 3 consecutive own decisions. Book replies carry no
// eval and reset both streaks — the bot never resigns or offers in book.

import type { SparColor } from "@/lib/spar";

export const ETIQUETTE = {
  /** Resign: chosen eval at or below this (pawns, bot POV)... */
  RESIGN_EVAL_PAWNS: -6.0,
  /** ...for this many consecutive out-of-book own decisions... */
  RESIGN_STREAK: 3,
  /** ...and not before this fullmove. */
  RESIGN_MIN_FULLMOVE: 20,
  /** Full-strength (BT3-backed) personas resign earlier and cleaner: a GM
   *  doesn't grind a lost position against hope. */
  STRONG_RESIGN_EVAL_PAWNS: -4.0,
  STRONG_RESIGN_STREAK: 2,
  STRONG_RESIGN_MIN_FULLMOVE: 15,
  /** Draw offer: |eval| within this (pawns)... */
  DRAW_EVAL_PAWNS: 0.3,
  /** ...for this many consecutive own decisions (≈ 6 plies of game)... */
  DRAW_STREAK: 3,
  /** ...from this fullmove on. At most ONE offer per game. */
  DRAW_MIN_FULLMOVE: 30,
} as const;

export interface EtiquetteState {
  /** Consecutive out-of-book own decisions at/below the resign threshold. */
  resignStreak: number;
  /** Consecutive out-of-book own decisions inside the draw band. */
  drawStreak: number;
  /** The single per-game draw offer has been spent. */
  drawOffered: boolean;
}

export const INITIAL_ETIQUETTE_STATE: EtiquetteState = {
  resignStreak: 0,
  drawStreak: 0,
  drawOffered: false,
};

export interface EtiquetteObservation {
  /** True for a book reply — no eval evidence, streaks reset. */
  inBook: boolean;
  /** Bot-POV chosen-candidate eval in pawns; null = unverified decision. */
  evalPawns: number | null;
  /** Full-strength/BT3 persona (the stricter resign thresholds apply). */
  fullStrength: boolean;
}

/** Fold one own reply (book or decision) into the streaks. */
export function updateEtiquette(s: EtiquetteState, o: EtiquetteObservation): EtiquetteState {
  if (o.inBook || o.evalPawns == null) return { ...s, resignStreak: 0, drawStreak: 0 };
  const resignAt = o.fullStrength ? ETIQUETTE.STRONG_RESIGN_EVAL_PAWNS : ETIQUETTE.RESIGN_EVAL_PAWNS;
  return {
    resignStreak: o.evalPawns <= resignAt ? s.resignStreak + 1 : 0,
    drawStreak: Math.abs(o.evalPawns) <= ETIQUETTE.DRAW_EVAL_PAWNS ? s.drawStreak + 1 : 0,
    drawOffered: s.drawOffered,
  };
}

export type EtiquetteAction = "resign" | "offer_draw" | null;

/** What the bot does after the decision just folded in: resign beats offer;
 *  `fullmove` is the move the decision was made on. */
export function etiquetteAction(
  s: EtiquetteState,
  fullmove: number,
  fullStrength: boolean,
): EtiquetteAction {
  const streak = fullStrength ? ETIQUETTE.STRONG_RESIGN_STREAK : ETIQUETTE.RESIGN_STREAK;
  const minMove = fullStrength ? ETIQUETTE.STRONG_RESIGN_MIN_FULLMOVE : ETIQUETTE.RESIGN_MIN_FULLMOVE;
  if (s.resignStreak >= streak && fullmove >= minMove) return "resign";
  if (!s.drawOffered && s.drawStreak >= ETIQUETTE.DRAW_STREAK && fullmove >= ETIQUETTE.DRAW_MIN_FULLMOVE) {
    return "offer_draw";
  }
  return null;
}

/** Spend the game's single draw offer. */
export function markDrawOffered(s: EtiquetteState): EtiquetteState {
  return { ...s, drawOffered: true };
}

/** Fullmove number from a FEN (field 6, 1-indexed; defaults to 1). */
export function fullmoveOf(fen: string): number {
  const n = parseInt(fen.split(" ")[5] ?? "1", 10);
  return Number.isFinite(n) ? n : 1;
}

// ---------------------------------------------------------------------------
// Visible rules + end labels
// ---------------------------------------------------------------------------

/** Shown verbatim as the tooltip on the resignation end state. */
export const BOT_RESIGN_RULE_DESCRIPTION =
  "Resigns when its own eval has stood at least 6 pawns down for 3 straight out-of-book moves, from move 20 on (full-strength personas: 4 pawns down for 2 straight moves, from move 15). Never resigns while still in book.";

/** Shown verbatim as the tooltip on the bot's draw-offer prompt. */
export const BOT_DRAW_OFFER_RULE_DESCRIPTION =
  "Offers a draw at most once per game, when its eval has stayed within ±0.3 pawns for its last 3 out-of-book moves (about 6 plies), from move 30 on.";

/**
 * End label for a bot resignation, phrased through spar-results'
 * resultFromLabel EXISTING "<winner> wins" pattern — and deliberately
 * "resigns", never "resigned": /resigned/ is that parser's USER-loss arm
 * (the "You resigned" manual end), tried first.
 */
export function botResignLabel(opponent: string, userColor: SparColor): string {
  const winner = userColor === "white" ? "White" : "Black";
  return `${opponent} resigns — ${winner} wins`;
}

/** Accepting the bot's offer ends through the same label the user-offered
 *  draw already uses (resultFromLabel's /draw/ arm — no new pattern). */
export const BOT_DRAW_AGREED_LABEL = "Draw agreed — ½–½";
