import { describe, it, expect } from "vitest";
import { GameTree } from "@/lib/game-tree";
import { shouldEngineMove } from "@/hooks/use-engine";

function line(sans: string[]): GameTree {
  const t = GameTree.create();
  for (const san of sans) {
    const id = t.addMoveSan(san);
    expect(id).not.toBeNull();
  }
  t.goToEnd();
  return t;
}

const turnOf = (fen: string) => (fen.split(" ")[1] === "b" ? "black" : "white");

describe("GameTree.takeBack — play-mode take-back (truncating)", () => {
  it("removes the user's move AND the engine's reply, landing on the user's turn (user = White)", () => {
    // e4=user e5=engine Nf3=user Nc6=engine; cursor at Nc6, White to move.
    const t = line(["e4", "e5", "Nf3", "Nc6"]);
    const nf3 = t.currentLine()[2].id;
    const nc6 = t.currentLine()[3].id;

    expect(t.takeBack("white")).toBe(true);

    // Landed on e5, White (user) to move; Nf3 and Nc6 are gone from the tree.
    expect(t.currentNode().san).toBe("e5");
    expect(turnOf(t.currentNode().fen)).toBe("white");
    expect(t.atEnd()).toBe(true); // truncated → cursor is the live tip
    expect(t.get(nf3)).toBeUndefined();
    expect(t.get(nc6)).toBeUndefined();
    expect(t.mainlineNodes().map((n) => n.san)).toEqual(["", "e4", "e5"]);
  });

  it("removes only the user's move when the engine hasn't replied yet (user = White)", () => {
    // e4=user e5=engine Nf3=user (engine still thinking); cursor at Nf3, Black to move.
    const t = line(["e4", "e5", "Nf3"]);
    expect(turnOf(t.currentNode().fen)).toBe("black");

    expect(t.takeBack("white")).toBe(true);

    expect(t.currentNode().san).toBe("e5");
    expect(turnOf(t.currentNode().fen)).toBe("white");
    expect(t.mainlineNodes().map((n) => n.san)).toEqual(["", "e4", "e5"]);
  });

  it("works when the user plays Black (engine moves first)", () => {
    // e4=engine e5=user Nf3=engine Nc6=user Bb5=engine; cursor Bb5, Black(user) to move.
    const t = line(["e4", "e5", "Nf3", "Nc6", "Bb5"]);
    expect(turnOf(t.currentNode().fen)).toBe("black");

    expect(t.takeBack("black")).toBe(true);

    // Removes the user's Nc6 and the engine's Bb5; lands on Nf3, Black to move.
    expect(t.currentNode().san).toBe("Nf3");
    expect(turnOf(t.currentNode().fen)).toBe("black");
    expect(t.mainlineNodes().map((n) => n.san)).toEqual(["", "e4", "e5", "Nf3"]);
  });

  it("repeated take-backs peel off one full move each and finally reach the start", () => {
    const t = line(["e4", "e5", "Nf3", "Nc6"]);
    expect(t.takeBack("white")).toBe(true); // → e5
    expect(t.currentNode().san).toBe("e5");
    expect(t.takeBack("white")).toBe(true); // → root
    expect(t.atStart()).toBe(true);
    expect(t.mainlineNodes().map((n) => n.san)).toEqual([""]);
    // Nothing left to take back.
    expect(t.takeBack("white")).toBe(false);
  });

  it("is a no-op at the game start", () => {
    const t = GameTree.create();
    expect(t.takeBack("white")).toBe(false);
    expect(t.atStart()).toBe(true);
  });
});

describe("shouldEngineMove — engine only plays at the live tip on its turn", () => {
  const base = { mode: "play" as const, isRunning: true, playerColor: "white" as const };

  it("plays when it's the engine's turn at the latest move", () => {
    expect(shouldEngineMove({ ...base, turn: "black", atLatestMove: true })).toBe(true);
  });

  it("does NOT play after a take-back (user's turn, at the tip)", () => {
    expect(shouldEngineMove({ ...base, turn: "white", atLatestMove: true })).toBe(false);
  });

  it("does NOT play while reviewing history (engine's turn but not at the tip)", () => {
    expect(shouldEngineMove({ ...base, turn: "black", atLatestMove: false })).toBe(false);
  });

  it("never plays in analysis mode or when the engine isn't running", () => {
    expect(shouldEngineMove({ ...base, mode: "analysis", turn: "black", atLatestMove: true })).toBe(false);
    expect(shouldEngineMove({ ...base, isRunning: false, turn: "black", atLatestMove: true })).toBe(false);
  });

  it("respects the human's color (user = Black → engine plays White's turns)", () => {
    expect(shouldEngineMove({ ...base, playerColor: "black", turn: "white", atLatestMove: true })).toBe(true);
    expect(shouldEngineMove({ ...base, playerColor: "black", turn: "black", atLatestMove: true })).toBe(false);
  });
});
