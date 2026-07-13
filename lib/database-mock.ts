// In-memory mock of the game database (spec 200), used outside Tauri so the
// Database tab is fully drivable in a plain browser (Playwright) and in unit
// tests. It mirrors the Rust backend's *semantics* — header filters, sort,
// exact dedup, Zobrist-equivalent position search with next-move readout — by
// reusing the app's own chessops-based PGN parser and game tree, so positions
// and FENs are computed exactly as the real board computes them.
//
// This module is only ever loaded via dynamic import from lib/database.ts when
// `window.__TAURI_INTERNALS__` is absent, so it does not ship in the Tauri
// bundle. State is a module-level singleton that persists for the session.

import { parsePgnToTrees, treeToPgn } from "@/lib/pgn"
import { GameTree } from "@/lib/game-tree"
import type {
  DatabaseApi,
  DbStats,
  GameFilter,
  GameHeader,
  ImportReport,
  PositionHit,
  Sort,
} from "@/lib/database"

// Mirror the backend's ply cap so the mock's position index has the same reach.
const PLY_CAP = 40

/** One indexed mainline position and the move played from it. */
type IndexedPosition = {
  epd: string
  ply: number
  nextSan: string | null
  nextUci: string | null
}

type MockGame = {
  id: number
  header: GameHeader
  tree: GameTree
  positions: IndexedPosition[]
  dupKey: string
}

/** Board part of a FEN (placement, turn, castling, ep) — the transposition key. */
function epd(fen: string): string {
  return fen.split(" ").slice(0, 4).join(" ")
}

/**
 * Walk a tree's mainline, deriving the compact UCI list and the position index
 * (each position plus the move played next), exactly as the Rust importer does.
 */
function indexTree(tree: GameTree): { positions: IndexedPosition[]; uci: string[] } {
  const positions: IndexedPosition[] = []
  const uci: string[] = []
  let node = tree.root()
  let ply = 0
  while (true) {
    const childId = node.children[0]
    const child = childId ? tree.get(childId) : undefined
    if (ply <= PLY_CAP) {
      positions.push({
        epd: epd(node.fen),
        ply,
        nextSan: child?.san ?? null,
        nextUci: child?.uci ?? null,
      })
    }
    if (!child) break
    uci.push(child.uci)
    node = child
    ply += 1
  }
  return { positions, uci }
}

function headerFromTree(id: number, tree: GameTree, source: string): GameHeader {
  const h = tree.headers
  const num = (k: string): number | null => {
    const v = parseInt(h[k] ?? "", 10)
    return Number.isFinite(v) ? v : null
  }
  // ply_count = mainline length (positions include ply 0, so subtract it).
  let plies = 0
  let node = tree.root()
  while (node.children[0]) {
    node = tree.get(node.children[0])!
    plies += 1
  }
  return {
    id,
    white: h.White ?? "",
    black: h.Black ?? "",
    white_elo: num("WhiteElo"),
    black_elo: num("BlackElo"),
    event: h.Event ?? "",
    site: h.Site ?? "",
    round: h.Round ?? "",
    date: h.Date ?? "",
    eco: h.ECO ?? "",
    result: h.Result ?? "*",
    ply_count: plies,
    source,
  }
}

class MockDb implements DatabaseApi {
  private games: MockGame[] = []
  private nextId = 1
  private dupKeys = new Set<string>()

  constructor() {
    this.ingest(SEED_PGN, "seed")
  }

  /** Parse a PGN blob, dedup, and add. Returns per-import counts. */
  private ingest(pgn: string, source: string): ImportReport {
    const report: ImportReport = { imported: 0, dups_skipped: 0, errors: 0 }
    let trees: GameTree[]
    try {
      trees = parsePgnToTrees(pgn)
    } catch {
      report.errors += 1
      return report
    }
    for (const tree of trees) {
      const { positions, uci } = indexTree(tree)
      if (uci.length === 0 && Object.keys(tree.headers).length === 0) {
        report.errors += 1
        continue
      }
      const result = tree.headers.Result ?? "*"
      const dupKey = `${uci.join(" ")}|${result}`
      if (this.dupKeys.has(dupKey)) {
        report.dups_skipped += 1
        continue
      }
      this.dupKeys.add(dupKey)
      const id = this.nextId++
      this.games.push({
        id,
        header: headerFromTree(id, tree, source),
        tree,
        positions,
        dupKey,
      })
      report.imported += 1
    }
    return report
  }

  async importPgn(args: { source: string; text?: string }): Promise<ImportReport> {
    return this.ingest(args.text ?? "", args.source || "import")
  }

  async listGames(
    filter: GameFilter,
    limit: number,
    offset: number,
    sort?: Sort,
  ): Promise<GameHeader[]> {
    const has = (s?: string) => !!s && s.trim().length > 0
    const like = (hay: string, needle: string) =>
      hay.toLowerCase().includes(needle.toLowerCase())

    let rows = this.games.map((g) => g.header).filter((h) => {
      if (has(filter.player) && !like(h.white, filter.player!) && !like(h.black, filter.player!))
        return false
      if (has(filter.white) && !like(h.white, filter.white!)) return false
      if (has(filter.black) && !like(h.black, filter.black!)) return false
      if (has(filter.event) && !like(h.event, filter.event!)) return false
      if (has(filter.eco) && !h.eco.toUpperCase().startsWith(filter.eco!.toUpperCase()))
        return false
      if (has(filter.date_from) && h.date < filter.date_from!) return false
      if (has(filter.date_to) && h.date > filter.date_to!) return false
      if (has(filter.result) && h.result !== filter.result) return false
      if (filter.min_elo != null) {
        const w = h.white_elo ?? -Infinity
        const b = h.black_elo ?? -Infinity
        if (w < filter.min_elo && b < filter.min_elo) return false
      }
      return true
    })

    const dir = sort?.dir === "asc" ? 1 : -1
    const col = sort?.by
    rows = rows.slice().sort((a, b) => {
      if (col) {
        const av = (a as any)[col]
        const bv = (b as any)[col]
        const cmp =
          typeof av === "number" || typeof bv === "number"
            ? (av ?? -Infinity) - (bv ?? -Infinity)
            : String(av ?? "").localeCompare(String(bv ?? ""))
        if (cmp !== 0) return cmp * dir
      }
      // Tie-break / default: newest id first (matches backend `id DESC`).
      return b.id - a.id
    })

    return rows.slice(offset, offset + limit)
  }

  async searchPosition(fen: string, limit = 200): Promise<PositionHit[]> {
    const target = epd(fen.trim())
    const hits: PositionHit[] = []
    for (const g of this.games) {
      const p = g.positions.find((pos) => pos.epd === target)
      if (!p) continue
      hits.push({
        game_id: g.id,
        white: g.header.white,
        black: g.header.black,
        white_elo: g.header.white_elo,
        black_elo: g.header.black_elo,
        result: g.header.result,
        date: g.header.date,
        ply: p.ply,
        next_uci: p.nextUci,
        next_san: p.nextSan,
      })
      if (hits.length >= limit) break
    }
    return hits
  }

  async getGame(id: number): Promise<string | null> {
    const g = this.games.find((x) => x.id === id)
    return g ? treeToPgn(g.tree) : null
  }

  async deleteGames(ids: number[]): Promise<number> {
    const set = new Set(ids)
    const before = this.games.length
    this.games = this.games.filter((g) => {
      if (set.has(g.id)) {
        this.dupKeys.delete(g.dupKey)
        return false
      }
      return true
    })
    return before - this.games.length
  }

  async stats(): Promise<DbStats> {
    const positions = this.games.reduce((n, g) => n + g.positions.length, 0)
    return { games: this.games.length, positions }
  }
}

// ---------------------------------------------------------------------------
// Seed corpus — distinct legal games with repeated players/ECOs and several
// shared early positions (Sicilians, 1.e4 e5 lines, a QGD transposition) so
// filters and position search both return something to look at.
// ---------------------------------------------------------------------------

type Seed = {
  white: string
  black: string
  welo: number
  belo: number
  event: string
  date: string
  eco: string
  result: string
  moves: string
}

const SEEDS: Seed[] = [
  { white: "Carlsen, Magnus", black: "Nakamura, Hikaru", welo: 2855, belo: 2780, event: "Norway Chess", date: "2024.05.28", eco: "B90", result: "1-0", moves: "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6" },
  { white: "Firouzja, Alireza", black: "Carlsen, Magnus", welo: 2790, belo: 2855, event: "Norway Chess", date: "2024.05.29", eco: "B90", result: "1/2-1/2", moves: "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Be3 e5" },
  { white: "Nakamura, Hikaru", black: "Firouzja, Alireza", welo: 2780, belo: 2790, event: "Candidates", date: "2024.04.10", eco: "B33", result: "0-1", moves: "e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 Nf6 Nc3 e5" },
  { white: "Ding, Liren", black: "Nepomniachtchi, Ian", welo: 2780, belo: 2770, event: "Candidates", date: "2024.04.11", eco: "B33", result: "1-0", moves: "e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 Nf6 Nc3 e5 Ndb5 d6" },
  { white: "Carlsen, Magnus", black: "Caruana, Fabiano", welo: 2855, belo: 2805, event: "Sinquefield Cup", date: "2023.11.20", eco: "C67", result: "1/2-1/2", moves: "e4 e5 Nf3 Nc6 Bb5 Nf6 O-O Nxe4 d4" },
  { white: "Nakamura, Hikaru", black: "Ding, Liren", welo: 2780, belo: 2780, event: "Sinquefield Cup", date: "2023.11.21", eco: "C54", result: "1-0", moves: "e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d4" },
  { white: "Caruana, Fabiano", black: "Carlsen, Magnus", welo: 2805, belo: 2855, event: "Tata Steel", date: "2024.01.15", eco: "C42", result: "1/2-1/2", moves: "e4 e5 Nf3 Nf6 Nxe5 d6 Nf3 Nxe4 d4" },
  { white: "Firouzja, Alireza", black: "Nakamura, Hikaru", welo: 2790, belo: 2780, event: "Tata Steel", date: "2024.01.16", eco: "C84", result: "1-0", moves: "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7" },
  { white: "Nepomniachtchi, Ian", black: "Ding, Liren", welo: 2770, belo: 2780, event: "World Championship", date: "2023.04.09", eco: "D37", result: "1/2-1/2", moves: "d4 Nf6 c4 e6 Nc3 d5 Bg5 Be7" },
  { white: "Ding, Liren", black: "Carlsen, Magnus", welo: 2780, belo: 2855, event: "World Championship", date: "2023.04.12", eco: "A13", result: "0-1", moves: "c4 Nf6 Nc3 e6 d4 d5 Bg5 Be7" },
  { white: "Carlsen, Magnus", black: "Ding, Liren", welo: 2855, belo: 2780, event: "Norway Chess", date: "2024.06.01", eco: "E60", result: "1-0", moves: "d4 Nf6 c4 g6 Nc3 Bg7 e4 d6" },
  { white: "Caruana, Fabiano", black: "Nepomniachtchi, Ian", welo: 2805, belo: 2770, event: "Candidates", date: "2024.04.14", eco: "E20", result: "1/2-1/2", moves: "d4 Nf6 c4 e6 Nc3 Bb4" },
  { white: "Nakamura, Hikaru", black: "Caruana, Fabiano", welo: 2780, belo: 2805, event: "Tata Steel", date: "2024.01.20", eco: "D15", result: "0-1", moves: "d4 d5 c4 c6 Nf3 Nf6 Nc3 dxc4" },
  { white: "Ding, Liren", black: "Firouzja, Alireza", welo: 2780, belo: 2790, event: "Candidates", date: "2024.04.15", eco: "B15", result: "1-0", moves: "e4 c6 d4 d5 Nc3 dxe4 Nxe4" },
  { white: "Nepomniachtchi, Ian", black: "Carlsen, Magnus", welo: 2770, belo: 2855, event: "Tata Steel", date: "2024.01.22", eco: "C15", result: "1/2-1/2", moves: "e4 e6 d4 d5 Nc3 Bb4" },
  { white: "Carlsen, Magnus", black: "Nepomniachtchi, Ian", welo: 2855, belo: 2770, event: "Norway Chess", date: "2024.06.02", eco: "A34", result: "1-0", moves: "c4 c5 Nf3 Nf6 Nc3 Nc6" },
  { white: "Firouzja, Alireza", black: "Ding, Liren", welo: 2790, belo: 2780, event: "Sinquefield Cup", date: "2023.11.24", eco: "B44", result: "0-1", moves: "e4 c5 Nf3 e6 d4 cxd4 Nxd4 Nc6" },
  { white: "Caruana, Fabiano", black: "Nakamura, Hikaru", welo: 2805, belo: 2780, event: "Sinquefield Cup", date: "2023.11.25", eco: "C45", result: "1-0", moves: "e4 e5 Nf3 Nc6 d4 exd4 Nxd4 Nf6" },
]

function seedToPgn(s: Seed): string {
  const tags = [
    `[Event "${s.event}"]`,
    `[Site "?"]`,
    `[Date "${s.date}"]`,
    `[Round "?"]`,
    `[White "${s.white}"]`,
    `[Black "${s.black}"]`,
    `[Result "${s.result}"]`,
    `[WhiteElo "${s.welo}"]`,
    `[BlackElo "${s.belo}"]`,
    `[ECO "${s.eco}"]`,
  ].join("\n")
  // Number the movetext (chessops parses unnumbered too, but this is closer to
  // real PGN). White moves get "N.", black moves follow.
  const sans = s.moves.split(/\s+/)
  let text = ""
  for (let i = 0; i < sans.length; i++) {
    if (i % 2 === 0) text += `${i / 2 + 1}. `
    text += `${sans[i]} `
  }
  return `${tags}\n\n${text}${s.result}\n`
}

const SEED_PGN = SEEDS.map(seedToPgn).join("\n")

/** The session-singleton mock, exposed to lib/database.ts's provider seam. */
export const mockDatabase: DatabaseApi = new MockDb()

/** A fresh, independent mock instance — for tests that mutate state. */
export function createMockDatabase(): DatabaseApi {
  return new MockDb()
}
