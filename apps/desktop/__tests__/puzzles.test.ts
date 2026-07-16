// Avoidance puzzle grading + deck plumbing (spec 211 Tier 1).
//
// The grading fixtures are REAL rows from the mine_cliffs.py dry run over
// data/reference/pack_2024-01_partial.pgn — the same batch bundled for the
// Rust tests (src-tauri/tests/fixtures/cliffs.jsonl) and seeded into the
// browser mock.

import { describe, expect, it } from "vitest"
import {
  bandForRating,
  gradeMove,
  LOST_THRESHOLD_CP,
  summarize,
  type MoveCheck,
  type PuzzleRow,
} from "@/lib/puzzles"
import { mockPuzzles } from "@/lib/puzzles-mock"

/** Dry-run row #1: black to move, Be6?? loses ~3 pawns to f4!. */
const PUZZLE: PuzzleRow = {
  id: 1,
  fen: "r1b2rk1/pp3ppp/2p5/4n3/4P3/2N3P1/PP2BPP1/R3R1K1 b - - 2 19",
  trap_uci: "c8e6",
  trap_san: "Be6",
  refutation_line: ["f2f4", "e5d7", "f4f5", "e6a2", "a1a2", "d7e5", "e1a1", "a7a6", "g3g4", "a8d8"],
  played_reply_san: "b3",
  safe_threshold: 50,
  eval_before_cp: -10,
  eval_after_cp: -364,
  verified_pre_best_cp: -19,
  verified_after_cp: -317,
  n_alternatives: 4,
  mate: false,
  mover: "black",
  ply: 37,
  band: "2100",
  white_elo: 2006,
  black_elo: 2120,
  source_game_id: "BjxhCc8a",
  site: "https://lichess.org/BjxhCc8a",
  date: "2024.01.01",
  time_control: "600+5",
  themes: [],
  band_miss_rates: null,
  engine_verify_depth: 16,
}

function check(cp: number | null, mate: number | null = null, pv: string[] = []): MoveCheck {
  return { cp_mover: cp, mate_mover: mate, pv, depth: 16 }
}

describe("gradeMove — many-correct semantics", () => {
  it("fails the stored trap move and replays the stored refutation", () => {
    const g = gradeMove(PUZZLE, "c8e6", null)
    expect(g.verdict).toBe("trap")
    expect(g.correct).toBe(false)
    expect(g.replayLine).toEqual(PUZZLE.refutation_line)
    expect(g.note).toContain("Be6")
    expect(g.note).toContain("-3.2") // verified_after_cp = -317
  })

  it("the trap fails even when an engine check is supplied", () => {
    // The stored refutation is authoritative for the stored trap.
    const g = gradeMove(PUZZLE, "c8e6", check(-317))
    expect(g.verdict).toBe("trap")
    expect(g.replayLine).toEqual(PUZZLE.refutation_line)
  })

  it("passes a move within the safe window of the verified best", () => {
    // best −19, threshold 50 → anything ≥ −69 is fully safe.
    const g = gradeMove(PUZZLE, "g7g6", check(-30))
    expect(g.verdict).toBe("safe")
    expect(g.correct).toBe(true)
    expect(g.replayLine).toEqual([])
  })

  it("passes a mediocre-but-not-losing move, with a note", () => {
    // below best − threshold (−69) but above the lost bar (−100).
    const g = gradeMove(PUZZLE, "h7h6", check(-80))
    expect(g.verdict).toBe("inaccuracy")
    expect(g.correct).toBe(true)
    expect(g.note).toContain("not best")
  })

  it("fails a different losing move and replays the engine PV", () => {
    const pv = ["e2c4", "g8h8", "c4f7"]
    const g = gradeMove(PUZZLE, "f8e8", check(-LOST_THRESHOLD_CP, null, pv))
    expect(g.verdict).toBe("blunder")
    expect(g.correct).toBe(false)
    expect(g.replayLine).toEqual(pv)
  })

  it("mate against the mover fails; mate for the mover is safe", () => {
    const lost = gradeMove(PUZZLE, "f7f5", check(null, -4, ["e2h5"]))
    expect(lost.verdict).toBe("blunder")
    expect(lost.correct).toBe(false)
    expect(lost.replayLine).toEqual(["e2h5"])

    const winning = gradeMove(PUZZLE, "e5f3", check(null, 3))
    expect(winning.verdict).toBe("safe")
    expect(winning.correct).toBe(true)
  })

  it("honest fallback: non-trap move without an engine is unverified, never confirmed", () => {
    const g = gradeMove(PUZZLE, "g7g6", null)
    expect(g.verdict).toBe("safe_unverified")
    expect(g.correct).toBe(true)
    expect(g.note).toContain("unverified")
  })

  it("boundary: exactly best − threshold is safe; exactly −lost is a fail", () => {
    expect(gradeMove(PUZZLE, "g7g6", check(-69)).verdict).toBe("safe")
    expect(gradeMove(PUZZLE, "g7g6", check(-70)).verdict).toBe("inaccuracy")
    expect(gradeMove(PUZZLE, "g7g6", check(-100)).verdict).toBe("blunder")
    expect(gradeMove(PUZZLE, "g7g6", check(-99)).verdict).toBe("inaccuracy")
  })
})

describe("bandForRating", () => {
  it("maps ratings to the generator's 100-Elo bands, clamped to the corpus", () => {
    expect(bandForRating(1723)).toBe("1700")
    expect(bandForRating(1700)).toBe("1700")
    expect(bandForRating(900)).toBe("1400") // corpus floor
    expect(bandForRating(2800)).toBe("2400") // TAIL RULE ceiling
    expect(bandForRating(null)).toBeNull()
    expect(bandForRating(NaN)).toBeNull()
  })
})

describe("summarize", () => {
  it("tallies correct, rakes and unverified answers", () => {
    const sum = summarize([
      { puzzleId: 1, verdict: "safe", correct: true },
      { puzzleId: 2, verdict: "trap", correct: false },
      { puzzleId: 3, verdict: "safe_unverified", correct: true },
      { puzzleId: 4, verdict: "inaccuracy", correct: true },
      { puzzleId: 5, verdict: "blunder", correct: false },
    ])
    expect(sum).toEqual({ total: 5, correct: 3, rakes: 2, unverified: 1 })
  })
})

describe("puzzles mock (the plain-browser backend)", () => {
  it("seeds real dry-run puzzles and reports stats", async () => {
    const stats = await mockPuzzles.stats()
    expect(stats.total).toBeGreaterThanOrEqual(3)
    expect(stats.bands.map((b) => b.band)).toContain("2100")
  })

  it("deck honors band and tops up when the band is thin", async () => {
    const only = await mockPuzzles.deck({ band: "1900", count: 1 })
    expect(only).toHaveLength(1)
    expect(only[0].band).toBe("1900")
    const deck = await mockPuzzles.deck({ band: "1900", count: 3 })
    expect(deck).toHaveLength(3)
    expect(new Set(deck.map((p) => p.id)).size).toBe(3)
  })

  it("imports JSONL with validation and dedup", async () => {
    const before = (await mockPuzzles.stats()).total
    const fresh = JSON.stringify({
      fen: "8/8/8/8/8/8/8/K6k w - - 0 1",
      trap_uci: "a1a2",
      refutation_line: ["h1h2"],
      safe_threshold_cp: 50,
      engine_verify_depth: 16,
      created_at: "t",
    })
    const bad = `not json\n{"fen": "x"}\n${fresh}\n${fresh}`
    const rep = await mockPuzzles.importPuzzles({ text: bad })
    expect(rep.imported).toBe(1)
    expect(rep.dups_skipped).toBe(1)
    expect(rep.errors).toBe(2)
    expect((await mockPuzzles.stats()).total).toBe(before + 1)
  })

  it("has no engine: checkMove resolves null (the honest fallback)", async () => {
    await expect(mockPuzzles.checkMove("", "", 16)).resolves.toBeNull()
  })
})
