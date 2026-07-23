// The Eval-Map: my explored moves, coloured on the board (spec 226).

import { describe, expect, it } from "vitest";
import { GameTree } from "../src/game-tree";
import { backupTree } from "../src/notebook";
import { buildEvalMap, evalMapColor } from "../src/eval-map";

describe("evalMapColor", () => {
  it("runs red → yellow → green over the reader's-side scale", () => {
    expect(evalMapColor(-3)).toBe("hsl(0 65% 45%)"); // losing → red
    expect(evalMapColor(0)).toBe("hsl(60 65% 45%)"); // equal → yellow
    expect(evalMapColor(3)).toBe("hsl(120 65% 45%)"); // winning → green
  });
  it("is gray when the line was never judged", () => {
    expect(evalMapColor(null)).toBe("hsl(0 0% 48%)");
  });
});

describe("buildEvalMap", () => {
  it("marks each own candidate on its destination, coloured by my side", () => {
    const t = GameTree.create();
    const e4 = t.addMoveSan("e4")!;
    const e5 = t.addMoveSan("e5")!; // live: White to move, two candidates
    // Two White candidates off e5, sharing nothing.
    const bc4 = t.addMoveSan("Bc4")!;
    t.goTo(e5);
    const nf3 = t.addMoveSan("Nf3")!;
    t.setAssessment(bc4, 2, "human"); // good for White
    t.setAssessment(nf3, -2, "human"); // bad for White
    const values = backupTree(t, "white");

    const marks = buildEvalMap(t, values, e5, "white");
    const byDest = new Map(marks.map((m) => [m.destKey, m]));
    // Bc4 lands on c4 with a bishop letter, green-ish (good for White).
    expect(byDest.get("c4")?.letter).toBe("B");
    expect(byDest.get("c4")?.mine).toBe(2);
    // The disc carries the child node id so a click can navigate into it.
    expect(byDest.get("c4")?.childId).toBe(bc4);
    // Nf3 lands on f3 with a knight letter, red-ish (bad for White).
    expect(byDest.get("f3")?.letter).toBe("N");
    expect(byDest.get("f3")?.mine).toBe(-2);
    void e4;
  });

  it("flips the colour value to the reader's side for Black", () => {
    const t = GameTree.create();
    t.addMoveSan("e4");
    const e5 = t.addMoveSan("e5")!;
    const nf3 = t.addMoveSan("Nf3")!; // a White move judged good for White
    t.setAssessment(nf3, 2, "human");
    const values = backupTree(t, "black");
    // From Black's side the same +2 (White better) reads as −2.
    const marks = buildEvalMap(t, values, e5, "black");
    expect(marks.find((m) => m.destKey === "f3")?.mine).toBe(-2);
  });

  it("is gray for a move played but never judged", () => {
    const t = GameTree.create();
    t.addMoveSan("e4");
    const e5 = t.addMoveSan("e5")!;
    t.addMoveSan("Nf3"); // no assessment anywhere below it
    const marks = buildEvalMap(t, backupTree(t, "white"), e5, "white");
    const f3 = marks.find((m) => m.destKey === "f3");
    expect(f3?.mine).toBeNull();
    expect(f3?.color).toBe("hsl(0 0% 48%)");
  });

  it("shows a pawn's from-file, so two pieces on one square read apart", () => {
    // A position where White, on move, can take d5 with both the c3-knight and
    // the e4-pawn: 1.e4 Nf6 2.Nc3 d5 — White to move, black pawn on d5.
    const t = GameTree.create();
    t.addMoveSan("e4");
    t.addMoveSan("Nf6");
    t.addMoveSan("Nc3");
    const branch = t.addMoveSan("d5")!;
    const exd5 = t.addMoveSan("exd5")!;
    t.goTo(branch);
    const nxd5 = t.addMoveSan("Nxd5")!;
    const marks = buildEvalMap(t, backupTree(t, "white"), branch, "white");
    const d5 = marks.filter((m) => m.destKey === "d5");
    expect(d5).toHaveLength(2);
    const letters = d5.map((m) => m.letter).sort();
    expect(letters).toEqual(["N", "e"]); // knight + the e-pawn's file
    void exd5;
    void nxd5;
  });

  it("ignores supplied moves — only my own candidates get a disc", () => {
    const t = GameTree.create();
    t.addMoveSan("e4");
    const e5 = t.addMoveSan("e5")!;
    const nf3 = t.addMoveSan("Nf3")!;
    // Mark it as a supplied/played move, not the user's own candidate.
    t.get(nf3)!.src = "played";
    const marks = buildEvalMap(t, backupTree(t, "white"), e5, "white");
    expect(marks.find((m) => m.destKey === "f3")).toBeUndefined();
  });
});
