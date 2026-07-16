// Headless mock for the `maia_move` command (spec 214, Tier 0). Used outside
// Tauri (Playwright / unit tests) where lc0 isn't available, so the spar loop is
// drivable end-to-end. Returns a deterministic legal move (the first one chessops
// enumerates) — enough to exchange moves and prove the wiring; it does NOT model
// human play. Dynamically imported so it never ships in the Tauri bundle.

import { Chess } from "chessops/chess";
import { parseFen } from "chessops/fen";
import { chessgroundDests } from "chessops/compat";
import type { Key } from "@lichess-org/chessground/types";
import type { PersonaMove } from "@/lib/maia";
import { applyUci, dragToUci } from "@/lib/spar";

export async function mockMaiaMove(fen: string, _level: number): Promise<PersonaMove> {
  // A small delay so the opponent "move" feels like a turn under Playwright.
  await new Promise((r) => setTimeout(r, 120));

  const setup = parseFen(fen);
  if (setup.isErr) throw new Error("mock maia_move: malformed FEN");
  const pos = Chess.fromSetup(setup.unwrap());
  if (pos.isErr) throw new Error("mock maia_move: illegal position");

  const dests = chessgroundDests(pos.unwrap()) as Map<Key, Key[]>;
  for (const [from, tos] of dests) {
    if (tos.length === 0) continue;
    const uci = dragToUci(fen, from as string, tos[0] as string);
    const ply = applyUci(fen, uci);
    if (ply) return { uci: ply.uci, san: ply.san };
  }
  throw new Error("mock maia_move: no legal moves (terminal position)");
}
