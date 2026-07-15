// Move-by-move rival book lookup (spec 214, "Move-by-move rival book").
//
// The book (dad_book.json / rival-book-mock.ts) stores one entry per position
// reached immediately after one of the rival's own moves — build_rival_book.py
// walks every game and records (or increments the weight of) an entry at
// EVERY ply where the rival just moved, not only the deepest. So each entry
// already IS a distinct node in the rival's decision trie, weighted by how
// many of his real games reached that exact position. To answer "what does he
// play from THIS position" we only need to strip each entry's own trailing
// move (his reply) and index by the position immediately before it — no need
// to decompose a longer entry's interior plies, since the book already carries
// every rival-move node as its own entry. Entries that land on the same
// "before" position (reached via different games, or even a different move
// order — see normalizeFenKey) have their weights summed at build time, so the
// reply distribution at each node is frequency-weighted across every line
// through it (spec 214: "merge with weights summed across entries").

import { Chess } from "chessops/chess";
import { parseFen, makeFen } from "chessops/fen";
import { parseSan } from "chessops/san";
import { makeEngineUci } from "@/lib/uci-parser";
import type { RivalBookEntry } from "@/lib/rival-book";
import type { SparColor } from "@/lib/spar";

/** The standard start position — exported so callers (e.g. the "from move 1"
 *  spar start) don't hand-roll their own copy of this string. */
export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export interface RivalReply {
  san: string;
  weight: number;
}

/** normalized-position -> weighted rival replies recorded at that node. */
export type RivalMoveMap = Map<string, RivalReply[]>;

/**
 * Position identity for the lookup: piece placement + side to move + castling
 * rights + en passant square only — dropping the halfmove clock and fullmove
 * number so the same position reached via a different move order (or a
 * different one of the rival's games) still lands on the same trie node.
 */
export function normalizeFenKey(fen: string): string {
  return fen.split(" ").slice(0, 4).join(" ");
}

/** "1.e4 c5 2.Nf3" -> ["e4", "c5", "Nf3"] — strip the book's move-number
 *  prefixes (build_rival_book.py's `_san_with_number`: only White tokens ever
 *  carry one, as "N.san"; Black tokens are bare). */
function tokenizeLine(line: string): string[] {
  return line
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.replace(/^\d+\.+/, ""));
}

/** Replay SAN tokens from the standard start position, returning the final
 *  FEN — or null on the first illegal/unparseable token (defensive: a
 *  corrupt book entry is skipped, not crashed on). */
function replaySan(tokens: string[]): string | null {
  const setup = parseFen(START_FEN);
  if (setup.isErr) return null;
  const posResult = Chess.fromSetup(setup.unwrap());
  if (posResult.isErr) return null;
  const pos = posResult.unwrap();
  for (const token of tokens) {
    const move = parseSan(pos, token);
    if (!move) return null;
    pos.play(move);
  }
  return makeFen(pos.toSetup());
}

/**
 * Build the move-by-move lookup for one rival colour. A spar session fixes
 * the rival's colour for its whole duration, so the map is built once per
 * game (or once at book-load time per colour, then reused) rather than once
 * for the whole book regardless of who's playing which side.
 */
export function buildRivalMoveMap(entries: RivalBookEntry[], rivalColor: SparColor): RivalMoveMap {
  const raw = new Map<string, Map<string, number>>();
  for (const entry of entries) {
    if (entry.rival_color !== rivalColor) continue;
    const tokens = tokenizeLine(entry.line);
    if (tokens.length === 0) continue;
    const reply = tokens[tokens.length - 1];
    const beforeFen = replaySan(tokens.slice(0, -1));
    if (!beforeFen) continue;
    const key = normalizeFenKey(beforeFen);
    let repliesAtNode = raw.get(key);
    if (!repliesAtNode) {
      repliesAtNode = new Map();
      raw.set(key, repliesAtNode);
    }
    const weight = Math.max(0, entry.weight);
    repliesAtNode.set(reply, (repliesAtNode.get(reply) ?? 0) + weight);
  }
  const map: RivalMoveMap = new Map();
  for (const [key, replies] of raw) {
    map.set(
      key,
      [...replies.entries()].map(([san, weight]) => ({ san, weight })),
    );
  }
  return map;
}

/** Weighted-random pick among a node's replies (rng in [0,1), injected for
 *  deterministic tests — same convention as rival-book.ts's pickBookEntry). */
function weightedChoice(replies: RivalReply[], rng: () => number): RivalReply {
  const total = replies.reduce((s, r) => s + Math.max(0, r.weight), 0);
  if (total <= 0) {
    return replies[Math.min(replies.length - 1, Math.floor(rng() * replies.length))];
  }
  let target = rng() * total;
  for (const r of replies) {
    target -= Math.max(0, r.weight);
    if (target < 0) return r;
  }
  return replies[replies.length - 1];
}

/**
 * Look up the rival's move-by-move reply at `fen` — a weighted sample across
 * every book line through that exact position — or null if the position is
 * out of book, in which case the caller falls back to maiaMove (spec 214:
 * "Out of book → maiaMove as today").
 */
export function lookupRivalReply(map: RivalMoveMap, fen: string, rng: () => number): RivalReply | null {
  const replies = map.get(normalizeFenKey(fen));
  if (!replies || replies.length === 0) return null;
  return weightedChoice(replies, rng);
}

/**
 * SAN -> UCI at `fen`, in engine-style castling notation (matches what
 * lib/spar.ts's applyUci/parseEngineUci expect) — or null if the SAN doesn't
 * parse/apply at that exact position (defensive: a stale/mismatched entry
 * falls out of book rather than crashing the game).
 */
export function replySanToUci(fen: string, san: string): string | null {
  const setup = parseFen(fen);
  if (setup.isErr) return null;
  const posResult = Chess.fromSetup(setup.unwrap());
  if (posResult.isErr) return null;
  const pos = posResult.unwrap();
  const move = parseSan(pos, san);
  if (!move) return null;
  return makeEngineUci(pos, move);
}
