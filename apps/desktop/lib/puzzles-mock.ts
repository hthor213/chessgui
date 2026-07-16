// In-memory mock of the puzzles backend (spec 211), used outside Tauri so the
// Avoidance solver is fully drivable in a plain browser (Playwright) and in
// unit tests. Mirrors the Rust backend's semantics: JSONL row validation
// (required fields; the board-legality checks live in Rust only — chessops
// validation here would drag the full move stack into the mock for little
// gain), dedup on (fen, trap_uci), band filter with top-up.
//
// Deck order is INSERTION order (deterministic), not random — documented
// difference from the Rust path, deliberate so headless tests can predict
// which puzzle comes first.
//
// checkMove returns null: there is no engine in a plain browser, and the
// honest fallback is "unverified", never a fabricated score.
//
// Seeded with three REAL rows from the mine_cliffs.py dry run over
// data/reference/pack_2024-01_partial.pgn (the same 12-row batch bundled at
// src-tauri/tests/fixtures/cliffs.jsonl).

// Value import straight from core (not "@/lib/puzzles") — the mock must not
// pull the provider seam in at runtime.
import { OPENING_MAX_PLY } from "@chessgui/core/puzzle-types"
import type {
  DeckRequest,
  MoveCheck,
  PuzzleImportReport,
  PuzzleRow,
  PuzzlesApi,
  PuzzleStats,
} from "@/lib/puzzles"

type JsonRecord = Record<string, unknown>

const SEED_JSONL = `
{"fen": "r1b2rk1/pp3ppp/2p5/4n3/4P3/2N3P1/PP2BPP1/R3R1K1 b - - 2 19", "trap_uci": "c8e6", "trap_san": "Be6", "refutation_line": ["f2f4", "e5d7", "f4f5", "e6a2", "a1a2", "d7e5", "e1a1", "a7a6", "g3g4", "a8d8"], "played_reply_san": "b3", "safe_threshold_cp": 50, "eval_before_cp": -10, "eval_after_cp": -364, "verified_pre_best_cp": -19, "verified_after_cp": -317, "n_alternatives": 4, "mate": false, "mover": "black", "ply": 37, "band": "2100", "white_elo": 2006, "black_elo": 2120, "source_game_id": "BjxhCc8a", "site": "https://lichess.org/BjxhCc8a", "date": "2024.01.01", "time_control": "600+5", "engine_verify_depth": 16, "created_at": "2026-07-15T19:58:55.740354+00:00"}
{"fen": "6k1/1p3p1p/p2npBp1/3p4/3P4/1P2P2P/1P2KPP1/8 w - - 1 31", "trap_uci": "e2d2", "trap_san": "Kd2", "refutation_line": ["d6e4", "d2d3", "e4f6", "b3b4", "b7b5", "h3h4", "g6g5", "h4g5", "f6d7", "d3c3"], "played_reply_san": "Kf8", "safe_threshold_cp": 50, "eval_before_cp": -39, "eval_after_cp": -504, "verified_pre_best_cp": -44, "verified_after_cp": -425, "n_alternatives": 4, "mate": false, "mover": "white", "ply": 60, "band": "1900", "white_elo": 1976, "black_elo": 1959, "source_game_id": "1gqYTJcW", "site": "https://lichess.org/1gqYTJcW", "date": "2024.01.01", "time_control": "600+5", "engine_verify_depth": 16, "created_at": "2026-07-15T19:59:10.788122+00:00"}
{"fen": "3Q4/1p3k1p/p1q3p1/P3Pp2/5N1P/1b6/6P1/7K w - - 3 39", "trap_uci": "d8h8", "trap_san": "Qh8", "refutation_line": ["c6c1", "h1h2", "c1f4", "g2g3", "f4f2", "h2h3", "f2f3", "h8h7", "f7e6", "h7g6"], "played_reply_san": "Qc1+", "safe_threshold_cp": 50, "eval_before_cp": 12, "eval_after_cp": -432, "verified_pre_best_cp": 36, "verified_after_cp": -365, "n_alternatives": 4, "mate": false, "mover": "white", "ply": 76, "band": "2100", "white_elo": 2116, "black_elo": 1957, "source_game_id": "J6ssXzlx", "site": "https://lichess.org/J6ssXzlx", "date": "2024.01.01", "time_control": "600+5", "engine_verify_depth": 16, "created_at": "2026-07-15T19:59:16.977450+00:00"}
`

const puzzles: PuzzleRow[] = []
let nextId = 1

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null
}

/** Validate one generator record; mirrors the Rust required-field checks. */
function toRow(rec: JsonRecord): PuzzleRow | null {
  const fen = str(rec.fen)
  const trap = str(rec.trap_uci)
  const safeThreshold = num(rec.safe_threshold_cp)
  const depth = num(rec.engine_verify_depth)
  const createdAt = str(rec.created_at)
  const refutation = Array.isArray(rec.refutation_line)
    ? rec.refutation_line.filter((m): m is string => typeof m === "string")
    : null
  if (!fen || !trap || safeThreshold == null || depth == null || !createdAt) return null
  if (!refutation || refutation.length === 0) return null
  return {
    id: nextId++,
    fen,
    trap_uci: trap,
    trap_san: str(rec.trap_san),
    refutation_line: refutation,
    played_reply_san: str(rec.played_reply_san),
    safe_threshold: safeThreshold,
    eval_before_cp: num(rec.eval_before_cp),
    eval_after_cp: num(rec.eval_after_cp),
    verified_pre_best_cp: num(rec.verified_pre_best_cp),
    verified_after_cp: num(rec.verified_after_cp),
    n_alternatives: num(rec.n_alternatives),
    mate: rec.mate === true,
    mover: str(rec.mover),
    ply: num(rec.ply),
    band: str(rec.band),
    white_elo: num(rec.white_elo),
    black_elo: num(rec.black_elo),
    source_game_id: str(rec.source_game_id),
    site: str(rec.site),
    date: str(rec.date),
    time_control: str(rec.time_control),
    themes: Array.isArray(rec.themes)
      ? rec.themes.filter((t): t is string => typeof t === "string")
      : [],
    band_miss_rates: str(rec.band_miss_rates),
    engine_verify_depth: depth,
  }
}

function importText(text: string): PuzzleImportReport {
  const report: PuzzleImportReport = { imported: 0, dups_skipped: 0, errors: 0 }
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let rec: JsonRecord
    try {
      rec = JSON.parse(trimmed) as JsonRecord
    } catch {
      report.errors++
      continue
    }
    const row = toRow(rec)
    if (!row) {
      report.errors++
      continue
    }
    if (puzzles.some((p) => p.fen === row.fen && p.trap_uci === row.trap_uci)) {
      report.dups_skipped++
      continue
    }
    puzzles.push(row)
    report.imported++
  }
  return report
}

// Seed once at module load (dynamic import keeps this out of the Tauri bundle).
importText(SEED_JSONL)

export const mockPuzzles: PuzzlesApi = {
  async importPuzzles(args): Promise<PuzzleImportReport> {
    if (!args.text) {
      throw new Error("The browser mock imports pasted/read text only — file paths need the desktop app")
    }
    return importText(args.text)
  },

  async deck(req: DeckRequest): Promise<PuzzleRow[]> {
    // maxPly (opening decks) is a hard filter, like the Rust path: NULL
    // plies never qualify and the band top-up stays inside the cap.
    const maxPly = req.maxPly ?? null
    const pool =
      maxPly === null ? puzzles : puzzles.filter((p) => p.ply !== null && p.ply < maxPly)
    const inBand = req.band ? pool.filter((p) => p.band === req.band) : []
    const picked = req.band ? inBand.slice(0, req.count) : pool.slice(0, req.count)
    if (picked.length < req.count) {
      const ids = new Set(picked.map((p) => p.id))
      for (const p of pool) {
        if (picked.length >= req.count) break
        if (!ids.has(p.id)) picked.push(p)
      }
    }
    return picked
  },

  async getPuzzle(id: number): Promise<PuzzleRow | null> {
    return puzzles.find((p) => p.id === id) ?? null
  },

  async stats(): Promise<PuzzleStats> {
    const byBand = new Map<string, number>()
    for (const p of puzzles) {
      if (p.band) byBand.set(p.band, (byBand.get(p.band) ?? 0) + 1)
    }
    return {
      total: puzzles.length,
      opening: puzzles.filter((p) => p.ply !== null && p.ply < OPENING_MAX_PLY).length,
      bands: [...byBand.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([band, count]) => ({ band, count })),
    }
  },

  async checkMove(): Promise<MoveCheck | null> {
    return null // no engine in a plain browser — the caller reports "unverified"
  },
}
