import { describe, expect, it } from "vitest";
import {
  BOT_DRAW_AGREED_LABEL,
  BOT_DRAW_OFFER_RULE_DESCRIPTION,
  BOT_RESIGN_RULE_DESCRIPTION,
  botResignLabel,
  ETIQUETTE,
  etiquetteAction,
  fullmoveOf,
  INITIAL_ETIQUETTE_STATE,
  markDrawOffered,
  updateEtiquette,
  type EtiquetteState,
} from "@/lib/spar-etiquette";
import { resultFromLabel } from "@/lib/spar-results";

// Spec 214 contract step 7 made real (realism audit wave R3.2): resign and
// draw-offer rules over the bot-POV chosen-candidate evals the decision log
// already carries. Both are visible rules; end labels flow through
// spar-results' EXISTING label parser — asserted round-trip below.

function afterEvals(
  evals: (number | null)[],
  fullStrength = false,
  from: EtiquetteState = INITIAL_ETIQUETTE_STATE,
): EtiquetteState {
  let s = from;
  for (const evalPawns of evals) s = updateEtiquette(s, { inBook: false, evalPawns, fullStrength });
  return s;
}

describe("resign rule — standard personas: ≤ −6 for 3 straight, move ≥ 20", () => {
  it("resigns after 3 consecutive hopeless out-of-book decisions from move 20", () => {
    const s = afterEvals([-6.5, -7.0, -8.0]);
    expect(etiquetteAction(s, 25, false)).toBe("resign");
    expect(etiquetteAction(s, 20, false)).toBe("resign");
  });

  it("never before move 20, never on a shorter streak, never above the bar", () => {
    expect(etiquetteAction(afterEvals([-6.5, -7.0, -8.0]), 19, false)).toBeNull();
    expect(etiquetteAction(afterEvals([-6.5, -7.0]), 40, false)).toBeNull();
    // −4.5 is lost but above the standard bar — a club player plays on.
    expect(afterEvals([-4.5, -4.5, -4.5]).resignStreak).toBe(0);
  });

  it("a single reprieve resets the streak", () => {
    const s = afterEvals([-6.5, -7.0, -2.0, -8.0]);
    expect(s.resignStreak).toBe(1);
    expect(etiquetteAction(s, 40, false)).toBeNull();
  });

  it("book replies and unverified decisions reset the streaks (never in book)", () => {
    let s = afterEvals([-6.5, -7.0]);
    s = updateEtiquette(s, { inBook: true, evalPawns: null, fullStrength: false });
    expect(s.resignStreak).toBe(0);
    s = afterEvals([-6.5, -7.0]);
    s = updateEtiquette(s, { inBook: false, evalPawns: null, fullStrength: false });
    expect(s.resignStreak).toBe(0);
  });
});

describe("resign rule — full-strength personas: ≤ −4 for 2 straight, move ≥ 15", () => {
  it("resigns earlier and cleaner", () => {
    const s = afterEvals([-4.5, -5.0], true);
    expect(etiquetteAction(s, 15, true)).toBe("resign");
    expect(etiquetteAction(s, 14, true)).toBeNull();
  });

  it("counts against the −4 bar, not the standard −6", () => {
    expect(afterEvals([-4.5, -4.5], true).resignStreak).toBe(2);
    expect(afterEvals([-3.5, -3.5], true).resignStreak).toBe(0);
  });
});

describe("draw offer — |eval| ≤ 0.3 for 3 own decisions (≈6 plies), move ≥ 30, once per game", () => {
  it("offers in a dead-equal position from move 30", () => {
    const s = afterEvals([0.1, -0.2, 0.0]);
    expect(etiquetteAction(s, 30, false)).toBe("offer_draw");
    expect(etiquetteAction(s, 29, false)).toBeNull();
  });

  it("a live imbalance breaks the quiet streak", () => {
    const s = afterEvals([0.1, 0.8, 0.0, 0.1]);
    expect(s.drawStreak).toBe(2);
    expect(etiquetteAction(s, 40, false)).toBeNull();
  });

  it("at most ONE offer per game — a spent offer never re-fires", () => {
    let s = afterEvals([0.1, -0.2, 0.0]);
    expect(etiquetteAction(s, 35, false)).toBe("offer_draw");
    s = markDrawOffered(s);
    expect(etiquetteAction(s, 35, false)).toBeNull();
    // Even after more quiet decisions.
    s = afterEvals([0.0, 0.1, -0.1], false, s);
    expect(etiquetteAction(s, 50, false)).toBeNull();
  });
});

describe("end labels flow through spar-results' existing parser", () => {
  it("bot resignation maps to a USER win via the '<winner> wins' pattern", () => {
    expect(resultFromLabel(botResignLabel("Kasparov", "white"), "white")).toBe("win");
    expect(resultFromLabel(botResignLabel("Kasparov", "black"), "black")).toBe("win");
  });

  it("says 'resigns', never 'resigned' — /resigned/ is the parser's USER-loss arm", () => {
    expect(botResignLabel("Dad", "white")).toBe("Dad resigns — White wins");
    expect(/resigned/i.test(botResignLabel("Dad", "white"))).toBe(false);
    // The user's own resignation still parses as a loss, untouched.
    expect(resultFromLabel("You resigned — 0-1", "white")).toBe("loss");
  });

  it("accepting the bot's offer uses the existing draw label", () => {
    expect(resultFromLabel(BOT_DRAW_AGREED_LABEL, "white")).toBe("draw");
  });
});

describe("visible rules + helpers", () => {
  it("both rules ship as human-readable tooltip text (spec 214 hard line)", () => {
    expect(BOT_RESIGN_RULE_DESCRIPTION).toMatch(/Resigns/);
    expect(BOT_RESIGN_RULE_DESCRIPTION).toMatch(/in book/);
    expect(BOT_DRAW_OFFER_RULE_DESCRIPTION).toMatch(/once per game/);
    expect(BOT_DRAW_OFFER_RULE_DESCRIPTION).toContain(String(ETIQUETTE.DRAW_MIN_FULLMOVE));
  });

  it("fullmoveOf reads FEN field 6, defaulting to 1", () => {
    expect(fullmoveOf("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1")).toBe(1);
    expect(fullmoveOf("8/8/8/8/8/8/8/K6k w - - 12 42")).toBe(42);
    expect(fullmoveOf("8/8/8/8/8/8/8/K6k w - -")).toBe(1);
  });
});
