import { describe, it, expect } from "vitest"
import { Chess } from "chessops/chess"
import { makeFen } from "chessops/fen"
import { parseSan } from "chessops/san"
import {
  ECO_LINES,
  ecoForFen,
  ecoForFens,
  ecoLabel,
  ecoName,
  matchesEcoQuery,
} from "@chessgui/core/eco"

describe("ECO → opening-name lookup (spec 200)", () => {
  it("names famous codes", () => {
    expect(ecoName("B90")).toBe("Sicilian, Najdorf")
    expect(ecoName("B70")).toBe("Sicilian, Dragon")
    expect(ecoName("C60")).toBe("Ruy Lopez")
    expect(ecoName("C89")).toBe("Ruy Lopez, Marshall Attack")
    expect(ecoName("E60")).toBe("King's Indian Defence")
    expect(ecoName("A57")).toBe("Benko Gambit")
    expect(ecoName("D85")).toBe("Grünfeld, Exchange")
  })

  it("resolves every code in a family range to that family", () => {
    // B91..B99 all belong to the Najdorf block starting at B90.
    for (const code of ["B91", "B95", "B99"]) {
      expect(ecoName(code)).toBe("Sicilian, Najdorf")
    }
    // E00..E09 Catalan
    expect(ecoName("E05")).toBe("Catalan Opening")
  })

  it("covers the full A00–E99 space", () => {
    for (const letter of ["A", "B", "C", "D", "E"]) {
      for (let n = 0; n < 100; n++) {
        const code = `${letter}${String(n).padStart(2, "0")}`
        expect(ecoName(code), code).toBeTruthy()
      }
    }
  })

  it("is case/whitespace tolerant and rejects malformed codes", () => {
    expect(ecoName(" b90 ")).toBe("Sicilian, Najdorf")
    expect(ecoName("")).toBeNull()
    expect(ecoName("Z12")).toBeNull()
    expect(ecoName("B9")).toBeNull()
    expect(ecoName("B900")).toBeNull()
  })

  it("ecoLabel prints code · name, or just the input when unknown", () => {
    expect(ecoLabel("b90")).toBe("B90 · Sicilian, Najdorf")
    expect(ecoLabel("??")).toBe("??")
  })
})

describe("matchesEcoQuery — tournament ECO/opening filter (spec 210 Phase 6)", () => {
  it("an empty or whitespace query matches everything, tagged or not", () => {
    expect(matchesEcoQuery("B90", "")).toBe(true)
    expect(matchesEcoQuery(undefined, "  ")).toBe(true)
    expect(matchesEcoQuery(null, "")).toBe(true)
  })

  it("matches code prefixes at every length (volume, decade, exact)", () => {
    expect(matchesEcoQuery("B90", "B")).toBe(true)
    expect(matchesEcoQuery("B90", "B9")).toBe(true)
    expect(matchesEcoQuery("B90", "B90")).toBe(true)
    expect(matchesEcoQuery("B90", "B91")).toBe(false)
    expect(matchesEcoQuery("C65", "B")).toBe(false)
    // Case-insensitive both sides.
    expect(matchesEcoQuery("b90", "b9")).toBe(true)
  })

  it("matches opening-name substrings via the family lookup", () => {
    expect(matchesEcoQuery("B90", "najdorf")).toBe(true)
    expect(matchesEcoQuery("B90", "Sicilian")).toBe(true)
    expect(matchesEcoQuery("B70", "dragon")).toBe(true)
    expect(matchesEcoQuery("C65", "berlin")).toBe(true)
    expect(matchesEcoQuery("B90", "berlin")).toBe(false)
  })

  it("excludes untagged or malformed codes once a query is set", () => {
    expect(matchesEcoQuery(undefined, "B90")).toBe(false)
    expect(matchesEcoQuery(null, "najdorf")).toBe(false)
    expect(matchesEcoQuery("", "B")).toBe(false)
    expect(matchesEcoQuery("Z12", "sicilian")).toBe(false)
  })
})

describe("FEN → ECO classification (spec 212 seed breakdown ECO arm)", () => {
  // Replay a SAN line from the standard start; returns every FEN (root first).
  const replay = (sans: string): string[] => {
    const chess = Chess.default()
    const fens = [makeFen(chess.toSetup())]
    for (const san of sans.split(" ")) {
      const move = parseSan(chess, san)
      expect(move, `illegal SAN "${san}" in line "${sans}"`).toBeTruthy()
      chess.play(move!)
      fens.push(makeFen(chess.toSetup()))
    }
    return fens
  }

  it("every coded line replays legally and classifies to its own code", () => {
    for (const [code, sans] of ECO_LINES) {
      const fens = replay(sans) // throws inside on an illegal SAN
      expect(ecoForFen(fens[fens.length - 1]), `${code}: ${sans}`).toBe(code)
    }
  })

  it("classifies famous tabiyas", () => {
    const najdorf = replay("e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6")
    expect(ecoForFen(najdorf[najdorf.length - 1])).toBe("B90")
    const berlin = replay("e4 e5 Nf3 Nc6 Bb5 Nf6")
    expect(ecoForFen(berlin[berlin.length - 1])).toBe("C65")
  })

  it("is move-order independent (transpositions classify)", () => {
    // QGD Exchange reached via 1.c4: same position, different move order.
    const viaEnglish = replay("c4 e6 Nc3 d5 d4 Nf6 cxd5 exd5")
    expect(ecoForFen(viaEnglish[viaEnglish.length - 1])).toBe("D35")
  })

  it("tolerates en-passant-field and counter differences", () => {
    // After 1.e4, with and without the ep square recorded.
    expect(ecoForFen("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1")).toBe("B00")
    expect(ecoForFen("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1")).toBe("B00")
    expect(ecoForFen("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 5 40")).toBe("B00")
  })

  it("returns null for the start position, middlegames and garbage", () => {
    expect(ecoForFen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1")).toBeNull()
    expect(ecoForFen("r1bqk2r/pp1nn1bp/2p1p1p1/3pNp2/2PP4/6P1/PP1NPPBP/R1BQ1RK1 w kq - 4 9")).toBeNull()
    expect(ecoForFen("")).toBeNull()
    expect(ecoForFen("not a fen")).toBeNull()
  })

  it("ecoForFens picks the DEEPEST matching position of a game", () => {
    // The Najdorf line passes through B20/B27/B50/… — the last match wins.
    const fens = replay("e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Be2 e5")
    expect(ecoForFens(fens)).toBe("B90")
    expect(ecoForFens([fens[0]])).toBeNull()
    expect(ecoForFens([])).toBeNull()
  })
})
