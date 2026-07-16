// Spec 210 Phase 6 — round-robin pairing, cross-table math, Elo estimation
// (logistic/Bradley-Terry MLE with a BayesElo-style prior), and the saved-
// result shape round-trip.

import { describe, it, expect } from "vitest"
import {
  buildRoundRobinSpecs,
  roundRobinGameCount,
  buildCrossTable,
  buildStandings,
  estimateElo,
  buildRoundRobinExport,
  type CrossTable,
  type GameOutcome,
  type Participant,
  type RoundRobinPairing,
  type Seed,
} from "@chessgui/core/tournament"

const SF = "/opt/stockfish"
const RK = "/opt/reckless"

const uci = (id: string, path: string): Participant => ({
  id,
  displayName: id,
  kind: "uci",
  enginePath: path,
})
const persona = (id: string): Participant => ({
  id,
  displayName: id,
  kind: "persona",
  personaConfig: { level: 1900, temperature: 0.5, alpha: 1, lambda: 0.75, weights: "bt3" },
})

const P3 = [uci("a", SF), uci("b", RK), persona("kasparov")]

/** A completed game outcome: `result` from the WHITE side's POV. */
function ok(
  id: number,
  flipped: boolean,
  result: "1-0" | "0-1" | "1/2-1/2",
): GameOutcome {
  return {
    id,
    flipped,
    result: { Ok: { result, termination: "checkmate", plies: 10, start_fen: "x", moves: [] } },
  }
}

/** Synthesize outcomes for one pairing: `wins`/`draws`/`losses` from the FIRST
 *  participant's perspective, alternating colors like the scheduler does. */
function pairingOutcomes(
  startId: number,
  pairing: RoundRobinPairing,
  wins: number,
  draws: number,
  losses: number,
  pairingById: Map<number, RoundRobinPairing>,
): GameOutcome[] {
  const out: GameOutcome[] = []
  let id = startId
  const push = (aScore: "w" | "d" | "l") => {
    const flipped = (id - startId) % 2 === 1 // a is Black in odd games
    const result =
      aScore === "d" ? "1/2-1/2" : (aScore === "w") === !flipped ? "1-0" : "0-1"
    pairingById.set(id, pairing)
    out.push(ok(id, flipped, result))
    id++
  }
  for (let i = 0; i < wins; i++) push("w")
  for (let i = 0; i < draws; i++) push("d")
  for (let i = 0; i < losses; i++) push("l")
  return out
}

describe("buildRoundRobinSpecs — pairing generation", () => {
  it("schedules every unordered pair M times with sequential ids", () => {
    const { specs, pairingById } = buildRoundRobinSpecs(P3, 4, [], 1000, 10, 400, true)
    expect(specs).toHaveLength(roundRobinGameCount(3, 4)) // 3 pairs * 4 = 12
    expect(specs.map((s) => s.id)).toEqual(Array.from({ length: 12 }, (_, i) => i))
    // Every game belongs to a pairing; each pairing has exactly 4 games.
    const counts = new Map<string, number>()
    for (const s of specs) {
      const p = pairingById.get(s.id)!
      counts.set(`${p.a}-${p.b}`, (counts.get(`${p.a}-${p.b}`) ?? 0) + 1)
    }
    expect([...counts.entries()].sort()).toEqual([
      ["0-1", 4],
      ["0-2", 4],
      ["1-2", 4],
    ])
  })

  it("alternates colors within a pairing (flipped = first participant is Black)", () => {
    const { specs, pairingById } = buildRoundRobinSpecs(P3, 2, [], 1000, 10, 400, true)
    expect(specs).toHaveLength(6)
    for (const s of specs) {
      const p = pairingById.get(s.id)!
      const first = P3[p.a]
      const second = P3[p.b]
      expect(s.white).toBe(s.flipped ? second : first)
      expect(s.black).toBe(s.flipped ? first : second)
    }
    // Within each pairing exactly half the games are flipped.
    const flippedPerPair = new Map<string, number>()
    for (const s of specs) {
      const p = pairingById.get(s.id)!
      const key = `${p.a}-${p.b}`
      flippedPerPair.set(key, (flippedPerPair.get(key) ?? 0) + (s.flipped ? 1 : 0))
    }
    for (const n of flippedPerPair.values()) expect(n).toBe(1)
  })

  it("odd M: the pairing's first participant gets the extra White", () => {
    const { specs, pairingById } = buildRoundRobinSpecs([P3[0], P3[1]], 3, [], 1000, 10, 400, true)
    expect(specs).toHaveLength(3)
    expect(specs.filter((s) => !s.flipped)).toHaveLength(2)
    expect(pairingById.size).toBe(3)
  })

  it("carries persona participants and fills legacy paths only for UCI sides", () => {
    const { specs } = buildRoundRobinSpecs(P3, 2, [], 1000, 10, 400, true)
    for (const s of specs) {
      expect(s.white_path).toBe(s.white!.kind === "uci" ? s.white!.enginePath : "")
      expect(s.black_path).toBe(s.black!.kind === "uci" ? s.black!.enginePath : "")
    }
  })

  it("draws seeds sequentially per color-flipped pair and cycles a short pool", () => {
    const seeds: Seed[] = [
      { fen: "fen1", eval: 0.5 },
      { fen: "fen2", eval: -0.25 },
    ]
    const { specs, evalById } = buildRoundRobinSpecs(P3, 2, seeds, 1000, 10, 400, true)
    // 3 pairings x 1 seed each: fen1, fen2, then cycles back to fen1.
    expect(specs[0].start_fen).toBe("fen1")
    expect(specs[1].start_fen).toBe("fen1") // color-flipped partner shares the seed
    expect(specs[2].start_fen).toBe("fen2")
    expect(specs[4].start_fen).toBe("fen1")
    expect(evalById.get(0)?.eval).toBe(0.5)
    expect(evalById.get(2)?.eval).toBe(-0.25)
  })

  it("degenerate inputs schedule nothing", () => {
    expect(buildRoundRobinSpecs([P3[0]], 2, [], 1000, 10, 400, true).specs).toHaveLength(0)
    expect(buildRoundRobinSpecs(P3, 0, [], 1000, 10, 400, true).specs).toHaveLength(0)
    expect(roundRobinGameCount(1, 2)).toBe(0)
    expect(roundRobinGameCount(4, 2)).toBe(12)
  })
})

describe("buildCrossTable — cross-table math", () => {
  it("scores W/D/L + points per directed cell, mirrored across the diagonal", () => {
    const pairingById = new Map<number, RoundRobinPairing>()
    const outcomes = [
      ...pairingOutcomes(0, { a: 0, b: 1 }, 2, 1, 1, pairingById), // 0 vs 1: +2 =1 -1
      ...pairingOutcomes(4, { a: 0, b: 2 }, 0, 2, 0, pairingById), // 0 vs 2: all draws
      ...pairingOutcomes(6, { a: 1, b: 2 }, 3, 0, 0, pairingById), // 1 sweeps 2
    ]
    const table = buildCrossTable(3, outcomes, pairingById)
    expect(table.cells[0][0]).toBeNull()
    expect(table.cells[0][1]).toMatchObject({ wins: 2, draws: 1, losses: 1, games: 4, points: 2.5 })
    expect(table.cells[1][0]).toMatchObject({ wins: 1, draws: 1, losses: 2, games: 4, points: 1.5 })
    expect(table.cells[0][2]).toMatchObject({ wins: 0, draws: 2, losses: 0, games: 2, points: 1 })
    expect(table.cells[1][2]).toMatchObject({ wins: 3, draws: 0, losses: 0, games: 3, points: 3 })
    expect(table.cells[2][1]).toMatchObject({ wins: 0, losses: 3, points: 0 })
  })

  it("respects flipped when mapping the White result onto the pairing", () => {
    const pairingById = new Map<number, RoundRobinPairing>([
      [0, { a: 0, b: 1 }],
      [1, { a: 0, b: 1 }],
    ])
    // Game 0: a is White and wins. Game 1: a is Black and White wins (= a loses).
    const table = buildCrossTable(2, [ok(0, false, "1-0"), ok(1, true, "1-0")], pairingById)
    expect(table.cells[0][1]).toMatchObject({ wins: 1, losses: 1, points: 1 })
    expect(table.cells[1][0]).toMatchObject({ wins: 1, losses: 1, points: 1 })
  })

  it("excludes aborted and errored games", () => {
    const pairingById = new Map<number, RoundRobinPairing>([
      [0, { a: 0, b: 1 }],
      [1, { a: 0, b: 1 }],
      [2, { a: 0, b: 1 }],
    ])
    const outcomes: GameOutcome[] = [
      ok(0, false, "1-0"),
      { ...ok(1, true, "1-0"), aborted: true },
      { id: 2, flipped: false, result: { Err: "spawn failed" } },
    ]
    const table = buildCrossTable(2, outcomes, pairingById)
    expect(table.cells[0][1]).toMatchObject({ games: 1, wins: 1 })
  })

  it("standings sum the rows and sort by points", () => {
    const pairingById = new Map<number, RoundRobinPairing>()
    const outcomes = [
      ...pairingOutcomes(0, { a: 0, b: 1 }, 2, 0, 0, pairingById),
      ...pairingOutcomes(2, { a: 0, b: 2 }, 1, 1, 0, pairingById),
      ...pairingOutcomes(4, { a: 1, b: 2 }, 1, 0, 1, pairingById),
    ]
    const rows = buildStandings(buildCrossTable(3, outcomes, pairingById))
    expect(rows[0]).toMatchObject({ idx: 0, games: 4, wins: 3, draws: 1, losses: 0, points: 3.5 })
    // idx 2 (1 win + 1 draw = 1.5) outranks idx 1 (1 win = 1).
    expect(rows[1]).toMatchObject({ idx: 2, games: 4, wins: 1, draws: 1, losses: 2, points: 1.5 })
    expect(rows[2]).toMatchObject({ idx: 1, games: 4, wins: 1, draws: 0, losses: 3, points: 1 })
  })
})

describe("estimateElo — logistic MLE over the cross-table", () => {
  /** Hand-build a 2-player table where player 0 scored `points` of `games`. */
  function twoPlayer(points: number, games: number): CrossTable {
    const wins = Math.floor(points)
    const draws = Math.round((points - wins) * 2)
    const losses = games - wins - draws
    return {
      n: 2,
      cells: [
        [null, { wins, draws, losses, games, points }],
        [{ wins: losses, draws, losses: wins, games, points: games - points }, null],
      ],
    }
  }

  it("recovers the textbook value: 75% over 100 games = +190.85 Elo (raw MLE)", () => {
    const est = estimateElo(twoPlayer(75, 100), 0, { priorDraws: 0 })
    // 400*log10(0.75/0.25) = 190.848...
    expect(est[0].elo).toBe(0) // anchor
    expect(est[0].anchored).toBe(true)
    expect(est[1].elo).toBeCloseTo(-190.848, 1)
    expect(est[1].games).toBe(100)
  })

  it("a 50% score is 0 Elo, and the prior leaves it at 0", () => {
    for (const priorDraws of [0, 1, 4]) {
      const est = estimateElo(twoPlayer(50, 100), 0, { priorDraws })
      expect(est[1].elo).toBeCloseTo(0, 6)
    }
  })

  it("default prior keeps a 100% sweep finite and shrinks extremes toward 0", () => {
    const est = estimateElo(twoPlayer(10, 10)) // clean sweep, priorDraws 1 default
    expect(Number.isFinite(est[1].elo)).toBe(true)
    // 10.5/11 => 400*log10(10.5/0.5) = 528.8 — large but not infinite.
    expect(est[1].elo).toBeLessThan(-400)
    expect(est[1].elo).toBeGreaterThan(-700)
  })

  it("three players generated from the model come back consistent + transitive", () => {
    // True ratings: A=+190.85 over B, B=+190.85 over C. Expected scores:
    // A-B 75%, B-C 75%, A-C 1/(1+10^(-381.7/400)) = 90%.
    const pairingById = new Map<number, RoundRobinPairing>()
    const outcomes = [
      ...pairingOutcomes(0, { a: 0, b: 1 }, 75, 0, 25, pairingById),
      ...pairingOutcomes(100, { a: 1, b: 2 }, 75, 0, 25, pairingById),
      ...pairingOutcomes(200, { a: 0, b: 2 }, 90, 0, 10, pairingById),
    ]
    const table = buildCrossTable(3, outcomes, pairingById)
    const est = estimateElo(table, 0, { priorDraws: 0 })
    expect(est[0].elo).toBe(0)
    expect(est[1].elo).toBeCloseTo(-190.85, -1) // within ~5 Elo
    expect(est[2].elo).toBeCloseTo(-381.7, -1)
    expect(est[1].games).toBe(200)
  })

  it("standard error scales with the game count (from N games, honestly)", () => {
    const est100 = estimateElo(twoPlayer(75, 100), 0, { priorDraws: 0 })
    const est400 = estimateElo(twoPlayer(300, 400), 0, { priorDraws: 0 })
    // Analytic Fisher SE at p=0.75, n=100: (400/ln10)/sqrt(100*0.1875) = 40.1.
    expect(est100[1].se).toBeGreaterThan(30)
    expect(est100[1].se).toBeLessThan(50)
    // 4x the games => half the SE.
    expect(est400[1].se).toBeCloseTo(est100[1].se / 2, 1)
    // The anchor is fixed by definition.
    expect(est100[0].se).toBe(0)
  })

  it("a participant with no scored games gets se=Infinity, not a fake number", () => {
    const table: CrossTable = {
      n: 3,
      cells: [
        [null, { wins: 1, draws: 0, losses: 0, games: 1, points: 1 }, { wins: 0, draws: 0, losses: 0, games: 0, points: 0 }],
        [{ wins: 0, draws: 0, losses: 1, games: 1, points: 0 }, null, { wins: 0, draws: 0, losses: 0, games: 0, points: 0 }],
        [{ wins: 0, draws: 0, losses: 0, games: 0, points: 0 }, { wins: 0, draws: 0, losses: 0, games: 0, points: 0 }, null],
      ],
    }
    const est = estimateElo(table) // default prior keeps the fit well-defined
    expect(est[2].games).toBe(0)
    expect(est[2].se).toBe(Infinity)
    expect(Number.isFinite(est[2].elo)).toBe(true) // prior pins it near 0
  })

  it("anchor choice shifts, never reshapes: pairwise gaps are anchor-invariant", () => {
    const table = twoPlayer(60, 50)
    const a0 = estimateElo(table, 0, { priorDraws: 0 })
    const a1 = estimateElo(table, 1, { priorDraws: 0 })
    expect(a0[0].elo - a0[1].elo).toBeCloseTo(a1[0].elo - a1[1].elo, 6)
    expect(a1[1].elo).toBe(0)
  })
})

describe("buildRoundRobinExport — persistence shape round-trip", () => {
  it("survives JSON stringify/parse and keeps honest labels + counts", () => {
    const pairingById = new Map<number, RoundRobinPairing>()
    const outcomes = [
      ...pairingOutcomes(0, { a: 0, b: 1 }, 2, 1, 1, pairingById),
      ...pairingOutcomes(4, { a: 0, b: 2 }, 1, 0, 1, pairingById),
      ...pairingOutcomes(6, { a: 1, b: 2 }, 0, 2, 0, pairingById),
    ]
    const table = buildCrossTable(3, outcomes, pairingById)
    const est = estimateElo(table, 0)
    const participants = [
      { id: "engine-stockfish", label: "engine: stockfish 18" },
      { id: "engine-reckless", label: "engine: reckless" },
      { id: "kasparov", label: "bot: kasparov (BT3, 64% move-match)" },
    ]
    const exported = buildRoundRobinExport(
      "Round-robin — 3 participants",
      participants,
      4,
      { baseMs: 10_000, incMs: 100 },
      table,
      est,
      "2026-07-15T12:00:00.000Z",
    )

    expect(exported.version).toBe(1)
    expect(exported.kind).toBe("round-robin")
    expect(exported.totalGames).toBe(8) // 4 + 2 + 2 completed games

    const parsed = JSON.parse(JSON.stringify(exported)) as typeof exported
    expect(parsed).toEqual(exported)
    // The persona keeps its honest strength label in the saved standings.
    expect(parsed.participants[2].label).toContain("BT3")
    expect(parsed.elo).toHaveLength(3)
    expect(parsed.elo[0]).toMatchObject({ id: "engine-stockfish", elo: 0, anchored: true, se: 0 })
    // Standings are recomputable from the persisted crossTable alone.
    const rows = buildStandings({ n: parsed.participants.length, cells: parsed.crossTable })
    expect(rows.reduce((s, r) => s + r.games, 0) / 2).toBe(parsed.totalGames)
  })

  it("serializes an Infinity SE as null (JSON has no Infinity)", () => {
    const table: CrossTable = {
      n: 2,
      cells: [
        [null, { wins: 0, draws: 0, losses: 0, games: 0, points: 0 }],
        [{ wins: 0, draws: 0, losses: 0, games: 0, points: 0 }, null],
      ],
    }
    const exported = buildRoundRobinExport(
      "empty",
      [{ id: "a", label: "a" }, { id: "b", label: "b" }],
      2,
      { baseMs: 1000, incMs: 0 },
      table,
      estimateElo(table),
    )
    expect(exported.elo[1].se).toBeNull()
    expect(JSON.parse(JSON.stringify(exported)).elo[1].se).toBeNull()
  })
})
