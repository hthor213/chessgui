// Spec 210 Phase 6 — gauntlet scheduling alongside round-robin: one hero
// plays every other participant, non-hero participants never meet, and the
// resulting flat batch feeds the SAME cross-table/standings/Elo math as a
// round-robin (pairings are always recorded {a: heroIdx, b: j}).

import { describe, it, expect } from "vitest"
import {
  buildGauntletSpecs,
  gauntletGameCount,
  buildCrossTable,
  buildStandings,
  estimateElo,
  buildRoundRobinExport,
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

const P4 = [uci("a", SF), uci("b", RK), persona("kasparov"), uci("d", "/opt/other")]

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

describe("gauntletGameCount", () => {
  it("is (n-1) * M", () => {
    expect(gauntletGameCount(4, 2)).toBe(6)
    expect(gauntletGameCount(2, 1)).toBe(1)
    expect(gauntletGameCount(5, 3)).toBe(12)
  })

  it("degenerate inputs schedule nothing", () => {
    expect(gauntletGameCount(1, 2)).toBe(0)
    expect(gauntletGameCount(0, 2)).toBe(0)
    expect(gauntletGameCount(3, 0)).toBe(0)
  })
})

describe("buildGauntletSpecs — pairing generation", () => {
  it("the hero owns every pairing; non-hero participants never meet", () => {
    const { specs, pairingById } = buildGauntletSpecs(P4, 1, 2, [], 1000, 10, 400, true)
    expect(specs).toHaveLength(gauntletGameCount(4, 2)) // 3 opponents * 2 = 6
    expect(specs.map((s) => s.id)).toEqual([0, 1, 2, 3, 4, 5])
    const counts = new Map<string, number>()
    for (const s of specs) {
      const p = pairingById.get(s.id)!
      expect(p.a).toBe(1) // hero is always the pairing's FIRST participant
      expect(p.b).not.toBe(1)
      counts.set(`${p.a}-${p.b}`, (counts.get(`${p.a}-${p.b}`) ?? 0) + 1)
    }
    expect([...counts.entries()].sort()).toEqual([
      ["1-0", 2],
      ["1-2", 2],
      ["1-3", 2],
    ])
  })

  it("alternates colors within a pairing (flipped = hero is Black)", () => {
    const { specs, pairingById } = buildGauntletSpecs(P4, 1, 2, [], 1000, 10, 400, true)
    for (const s of specs) {
      const p = pairingById.get(s.id)!
      const hero = P4[p.a]
      const opponent = P4[p.b]
      expect(s.white).toBe(s.flipped ? opponent : hero)
      expect(s.black).toBe(s.flipped ? hero : opponent)
    }
    // Exactly half the games of each pairing are flipped.
    expect(specs.filter((s) => s.flipped)).toHaveLength(3)
  })

  it("odd M: the hero gets the extra White in every pairing", () => {
    const { specs } = buildGauntletSpecs(P4, 0, 3, [], 1000, 10, 400, true)
    expect(specs).toHaveLength(9)
    expect(specs.filter((s) => !s.flipped)).toHaveLength(6) // 2 Whites per pairing
  })

  it("carries persona participants and fills legacy paths only for UCI sides", () => {
    const { specs } = buildGauntletSpecs(P4, 2, 2, [], 1000, 10, 400, true)
    for (const s of specs) {
      expect(s.white_path).toBe(s.white!.kind === "uci" ? s.white!.enginePath : "")
      expect(s.black_path).toBe(s.black!.kind === "uci" ? s.black!.enginePath : "")
    }
  })

  it("draws one seed per color-flipped pair and cycles a short pool", () => {
    const seeds: Seed[] = [
      { fen: "fen1", eval: 0.5 },
      { fen: "fen2", eval: -0.25 },
    ]
    const { specs, evalById } = buildGauntletSpecs(P4, 0, 2, seeds, 1000, 10, 400, true)
    expect(specs[0].start_fen).toBe("fen1")
    expect(specs[1].start_fen).toBe("fen1") // color-flipped partner shares the seed
    expect(specs[2].start_fen).toBe("fen2")
    expect(specs[4].start_fen).toBe("fen1") // pool of 2 cycles for the 3rd pairing
    expect(evalById.get(0)).toEqual({ eval: 0.5 })
    expect(evalById.get(2)).toEqual({ eval: -0.25 })
  })

  it("schedules nothing for an out-of-range hero or degenerate inputs", () => {
    expect(buildGauntletSpecs(P4, 4, 2, [], 1000, 10, 400, true).specs).toHaveLength(0)
    expect(buildGauntletSpecs(P4, -1, 2, [], 1000, 10, 400, true).specs).toHaveLength(0)
    expect(buildGauntletSpecs([P4[0]], 0, 2, [], 1000, 10, 400, true).specs).toHaveLength(0)
    expect(buildGauntletSpecs(P4, 0, 0, [], 1000, 10, 400, true).specs).toHaveLength(0)
  })
})

describe("gauntlet outcomes feed the shared cross-table/standings math", () => {
  it("hero sweeps: standings put the hero on top with (n-1)*M games", () => {
    const { specs, pairingById } = buildGauntletSpecs(P4, 1, 2, [], 1000, 10, 400, true)
    // Hero wins every game regardless of color.
    const outcomes = specs.map((s) => ok(s.id, s.flipped, s.flipped ? "0-1" : "1-0"))
    const table = buildCrossTable(4, outcomes, pairingById)
    const standings = buildStandings(table)
    expect(standings[0].idx).toBe(1)
    expect(standings[0].games).toBe(6)
    expect(standings[0].points).toBe(6)
    // Opponents only ever played the hero.
    for (const row of standings.slice(1)) {
      expect(row.games).toBe(2)
      expect(row.points).toBe(0)
      expect(table.cells[row.idx][1]!.games).toBe(2)
      // Non-hero pairings stayed empty.
      for (const other of standings.slice(1)) {
        if (other.idx !== row.idx) expect(table.cells[row.idx][other.idx]!.games).toBe(0)
      }
    }
    // Elo anchored to the hero: hero exactly 0, everyone else below.
    const elo = estimateElo(table, 1)
    expect(elo.find((e) => e.idx === 1)!.elo).toBe(0)
    expect(elo.find((e) => e.idx === 1)!.anchored).toBe(true)
    for (const e of elo) if (e.idx !== 1) expect(e.elo).toBeLessThan(0)
  })
})

describe("buildRoundRobinExport kind", () => {
  const table = { n: 2, cells: [[null, { wins: 1, draws: 0, losses: 0, games: 1, points: 1 }], [{ wins: 0, draws: 0, losses: 1, games: 1, points: 0 }, null]] }
  const participants = [{ id: "a", label: "A" }, { id: "b", label: "B" }]

  it("defaults to round-robin and passes gauntlet through", () => {
    const est = estimateElo(table, 0)
    const rr = buildRoundRobinExport("n", participants, 2, { baseMs: 1, incMs: 0 }, table, est)
    expect(rr.kind).toBe("round-robin")
    const g = buildRoundRobinExport(
      "n", participants, 2, { baseMs: 1, incMs: 0 }, table, est, undefined, "gauntlet",
    )
    expect(g.kind).toBe("gauntlet")
    expect(g.completedAt).toBeTruthy() // undefined completedAt still defaults
  })
})
