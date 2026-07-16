// Headless mock for the `persona_move` command (spec 214, persona engine v1).
// Used outside Tauri (Playwright / unit tests) where lc0 + Stockfish aren't
// available, so the spar loop is drivable end-to-end. Returns a deterministic
// legal move (the first one chessops enumerates) wrapped in a single-candidate
// decision — enough to exchange moves and prove the wiring; it does NOT model
// human play or run verification. Dynamically imported so it never ships in the
// Tauri bundle.

import { Chess } from "chessops/chess";
import { parseFen } from "chessops/fen";
import { chessgroundDests } from "chessops/compat";
import type { Key } from "@lichess-org/chessground/types";
import type { PersonaDecision, PersonaParams } from "@/lib/persona";
import { applyUci, dragToUci } from "@/lib/spar";

export async function mockPersonaMove(
  fen: string,
  params: PersonaParams,
): Promise<PersonaDecision> {
  // A small delay so the opponent "move" feels like a turn under Playwright.
  await new Promise((r) => setTimeout(r, 120));

  const setup = parseFen(fen);
  if (setup.isErr) throw new Error("mock persona_move: malformed FEN");
  const pos = Chess.fromSetup(setup.unwrap());
  if (pos.isErr) throw new Error("mock persona_move: illegal position");

  const dests = chessgroundDests(pos.unwrap()) as Map<Key, Key[]>;
  for (const [from, tos] of dests) {
    if (tos.length === 0) continue;
    const uci = dragToUci(fen, from as string, tos[0] as string);
    const ply = applyUci(fen, uci);
    if (ply) {
      return {
        uci: ply.uci,
        san: ply.san,
        reason: "policy",
        band: params.level,
        // Mirrors the Rust derived-seed mix closely enough for a headless stub.
        derived_seed: (params.seed ^ (params.ply * 0x9e3779b1)) >>> 0,
        // Step-3 log fields, coarsely mirrored: ply-only phase guess (the mock
        // never counts material) and the flat base temperature (no schedule).
        phase: params.ply < 16 ? "opening" : "middlegame",
        temperature: params.temperature,
        style_bias_applied: false,
        error_model_applied: false,
        mistake_rate: null,
        candidates: [
          {
            uci: ply.uci,
            san: ply.san,
            policy_prob: 1,
            eval_cp: null,
            eval_penalty: 0,
            weight: 1,
          },
        ],
      };
    }
  }
  throw new Error("mock persona_move: no legal moves (terminal position)");
}
