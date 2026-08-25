// Persona think-time model (spec 214 contract step 10; realism audit wave
// R1.1 — the loudest realism tell was replies landing at compute speed).
//
// One pure function computes the rival's think-time in ms from the decision
// the pipeline already made — no new search, every input is already in the
// step-9 decision log: candidate weights (a dominant candidate is a snap
// move, a close call is a real think), the reason arm (book replies are
// recall, not computation), forcedness (only-moves and recaptures come near-
// instant), eval swing vs the previous own decision (surprise → long think),
// phase, and the remaining clock (compressed hard in time trouble). The
// caller supplies the rng — the seeded per-turn stream (lib/seeded-rng) —
// so the sampled time is reproducible under the logged game seed.
//
// All constants are honest priors tuned for FEEL, not fitted from corpus
// move-times yet (that fit is the rest of contract step 10); they live in
// one exported table so a future fit replaces numbers, not structure.

import { Chess } from "chessops/chess";
import { parseFen } from "chessops/fen";
import type { PersonaDecision } from "@/lib/persona";

export const THINK_TIME = {
  /** Book replies: recalled, not computed — brisk but human (ms). */
  BOOK_MIN_MS: 400,
  BOOK_MAX_MS: 1500,
  /** Only-moves and immediate recaptures: the snap pattern (ms). */
  FORCED_MIN_MS: 300,
  FORCED_MAX_MS: 900,
  /** One dominant candidate (top weight > DOMINANT_WEIGHT): a quick decision. */
  SNAP_MIN_MS: 1000,
  SNAP_MAX_MS: 4000,
  DOMINANT_WEIGHT: 0.8,
  /** The middle ground between dominant and close-call. */
  NORMAL_MIN_MS: 1500,
  NORMAL_MAX_MS: 6000,
  /** Close call (top weight < CLOSE_TOP_WEIGHT, or top-2 gap < CLOSE_GAP):
   *  a real think. */
  CLOSE_MIN_MS: 5000,
  CLOSE_MAX_MS: 20_000,
  CLOSE_TOP_WEIGHT: 0.5,
  CLOSE_GAP: 0.15,
  /** Rare deep tank on middlegame close calls — the "sits for a long time on
   *  the critical decision" pattern. */
  TANK_PROB: 0.06,
  TANK_MULT: 2.5,
  /** Surprise: the best candidate's eval fell at least this many pawns vs the
   *  previous own decision — something went wrong, he stops and thinks. */
  SURPRISE_DROP_PAWNS: 1.0,
  SURPRISE_MULT: 1.5,
  /** Phase multipliers: openings are rehearsed, endgames semi-technical. */
  OPENING_MULT: 0.6,
  ENDGAME_MULT: 0.8,
  /** Ply-based opening fallback when no decision carries a phase (book arm). */
  OPENING_PLY_MAX: 20,
  /** Clocked: never spend more than this fraction of the remaining clock. */
  CLOCK_FRACTION_CAP: 0.08,
  /** Time-trouble compression: hard under 30s, brutal under 10s. */
  LOW_TIME_MS: 30_000,
  LOW_TIME_MULT: 0.4,
  PANIC_TIME_MS: 10_000,
  PANIC_MULT: 0.15,
  /** Clocked floor (the panic floor from the audit), itself clamped to half
   *  the remaining time so the sampled delay ALONE can never flag — the
   *  never-self-flag property lib/spar-clock's placeholder draw had. */
  CLOCKED_FLOOR_MS: 150,
  /** Never-self-flag cap: at most max(200ms, 10% of remaining), kept from
   *  the placeholder's contract (the 8% fraction cap is tighter except at
   *  very low remaining, where the min of the two still holds). */
  SELF_FLAG_CAP_MIN_MS: 200,
  SELF_FLAG_CAP_FRACTION: 0.1,
  /** Unclocked: still thinks (the pre-audit spar replied instantly), with a
   *  relaxed cap so tempo reads human without wasting the user's evening. */
  UNCLOCKED_FLOOR_MS: 300,
  UNCLOCKED_CAP_MS: 12_000,
} as const;

/** Forcedness signals (contract step 10): patterns humans answer instantly. */
export interface ForcednessSignals {
  /** Exactly one legal move in the position. */
  onlyMove: boolean;
  /** The chosen move captures on the square the opponent just captured on. */
  recapture: boolean;
}

/**
 * Compute the forcedness signals for the chosen reply at `fen`: only legal
 * move (via chessops), and recapture-on-the-same-square (the opponent's last
 * ply was a capture — SAN carries the "x" — and the chosen move lands on its
 * destination square, which necessarily takes the piece that just landed).
 */
export function forcednessSignals(
  fen: string,
  chosenUci: string,
  lastPly: { san: string; uci: string } | null,
): ForcednessSignals {
  return {
    onlyMove: onlyLegalMove(fen),
    recapture:
      !!lastPly && lastPly.san.includes("x") && chosenUci.slice(2, 4) === lastPly.uci.slice(2, 4),
  };
}

function onlyLegalMove(fen: string): boolean {
  const setup = parseFen(fen);
  if (setup.isErr) return false;
  const posResult = Chess.fromSetup(setup.unwrap());
  if (posResult.isErr) return false;
  let count = 0;
  for (const [, dests] of posResult.unwrap().allDests()) {
    count += dests.size();
    if (count > 1) return false;
  }
  return count === 1;
}

/** Best verified candidate eval in pawns (mover POV = bot POV — every
 *  decision is for the bot's own move), or null when nothing was verified. */
export function bestCandidateEvalPawns(d: PersonaDecision): number | null {
  let best: number | null = null;
  for (const c of d.candidates) {
    if (c.eval_cp == null) continue;
    if (best == null || c.eval_cp > best) best = c.eval_cp;
  }
  return best == null ? null : best / 100;
}

/** The CHOSEN candidate's verified eval in pawns (bot POV), or null. */
export function chosenCandidateEvalPawns(d: PersonaDecision): number | null {
  const chosen = d.candidates.find((c) => c.uci === d.uci);
  return chosen?.eval_cp == null ? null : chosen.eval_cp / 100;
}

export interface ThinkTimeInput {
  /** The reason arm: "book" for a book reply, else the decision's own reason
   *  ("policy" | "verify-reweight" | "endgame"). */
  reason: string;
  /** The persona decision, null for a book reply (no decision exists there). */
  decision: PersonaDecision | null;
  /** Half-move index of the reply (the phase fallback when no decision). */
  ply: number;
  /** The rival's remaining clock in ms; null = unclocked spar. */
  remainingClockMs: number | null;
  /** Best-candidate eval (bot POV, pawns) from the rival's PREVIOUS own
   *  decision — the surprise signal's baseline; null when unknown. */
  prevOwnBestEvalPawns: number | null;
  forced: ForcednessSignals;
  /** Seeded per-turn stream (lib/seeded-rng) — consumed once for the base
   *  draw, plus once more on middlegame close calls (the tank roll). */
  rng: () => number;
}

/** The rival's think-time in ms for one selected move. Pure given its rng. */
export function sparThinkTimeMs(input: ThinkTimeInput): number {
  const T = THINK_TIME;
  const { decision, rng } = input;
  const phase = decision?.phase ?? (input.ply < T.OPENING_PLY_MAX ? "opening" : "middlegame");

  // Base draw from the arm. Forcedness wins (a forced book move is still a
  // snap), then book recall, then the candidate-weight shape.
  let lo: number;
  let hi: number;
  let closeCall = false;
  if (input.forced.onlyMove || input.forced.recapture) {
    lo = T.FORCED_MIN_MS;
    hi = T.FORCED_MAX_MS;
  } else if (input.reason === "book" || !decision) {
    lo = T.BOOK_MIN_MS;
    hi = T.BOOK_MAX_MS;
  } else {
    const weights = decision.candidates.map((c) => c.weight).sort((a, b) => b - a);
    const top = weights[0] ?? 1;
    const gap = top - (weights[1] ?? 0);
    if (weights.length >= 2 && (top < T.CLOSE_TOP_WEIGHT || gap < T.CLOSE_GAP)) {
      closeCall = true;
      lo = T.CLOSE_MIN_MS;
      hi = T.CLOSE_MAX_MS;
    } else if (top > T.DOMINANT_WEIGHT || weights.length < 2) {
      lo = T.SNAP_MIN_MS;
      hi = T.SNAP_MAX_MS;
    } else {
      lo = T.NORMAL_MIN_MS;
      hi = T.NORMAL_MAX_MS;
    }
  }
  let t = lo + rng() * (hi - lo);

  // Rare deep tank — middlegame close calls only.
  if (closeCall && phase === "middlegame" && rng() < T.TANK_PROB) t *= T.TANK_MULT;

  // Surprise: the position got materially worse since his last decision.
  const best = decision ? bestCandidateEvalPawns(decision) : null;
  if (
    best != null &&
    input.prevOwnBestEvalPawns != null &&
    best <= input.prevOwnBestEvalPawns - T.SURPRISE_DROP_PAWNS
  ) {
    t *= T.SURPRISE_MULT;
  }

  // Phase.
  if (phase === "opening") t *= T.OPENING_MULT;
  else if (phase === "endgame") t *= T.ENDGAME_MULT;

  // Clock bounds.
  const rem = input.remainingClockMs;
  if (rem == null) {
    t = Math.min(Math.max(t, T.UNCLOCKED_FLOOR_MS), T.UNCLOCKED_CAP_MS);
  } else {
    if (rem <= 0) return 0;
    if (rem <= T.PANIC_TIME_MS) t *= T.PANIC_MULT;
    else if (rem <= T.LOW_TIME_MS) t *= T.LOW_TIME_MULT;
    const cap = Math.min(
      rem * T.CLOCK_FRACTION_CAP,
      Math.max(T.SELF_FLAG_CAP_MIN_MS, rem * T.SELF_FLAG_CAP_FRACTION),
    );
    const floor = Math.min(T.CLOCKED_FLOOR_MS, rem / 2);
    t = Math.max(Math.min(t, cap), floor);
  }
  return Math.round(t);
}
