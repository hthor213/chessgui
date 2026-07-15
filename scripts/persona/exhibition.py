#!/usr/bin/env python3
"""Persona exhibition — Fischer vs Kasparov (spec 214, tier-2 proof of concept).

Two personas play a 6-game match. Each persona is, per the tier-1 findings:

  * an OPENING BOOK weighted from that player's own TRAIN games — while the
    current position is one the player actually reached (with them to move), we
    sample among the moves they played there, by frequency; and
  * BT3 pure policy (`go nodes 1`) once out of book — the tier-1 harness showed
    a strong-engine policy, not a Maia human net, is the best move-match backend
    for players of this strength, so that is what drives the middlegame. Sampled
    at LOW temperature (near-argmax over the top few policy moves) so the games
    differ without ever picking a tail blunder.

The two never met over the board, so their books diverge within a handful of
moves; from the divergence point on, whoever is still in book follows it and the
other side is already on BT3 policy. Stockfish adjudicates (resign / draw /
cap) — it never chooses a move, it only judges the position.

This is a standalone script; no app changes. Reuses the tier-1 engine wrappers.

Usage:
    python exhibition.py            # play the 6-game match, write PGN + MD
    python exhibition.py --games 2  # shorter run
    python exhibition.py --selftest # pure-function unit tests
"""

from __future__ import annotations

import argparse
import io
import sys
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from random import Random
from typing import Dict, List, Optional, Tuple

import chess
import chess.pgn

REPO = Path(__file__).resolve().parents[2]
DATA_DIR = REPO / "data" / "personas"
SCRATCH = Path(
    "/private/tmp/claude-501/-Users-hjalti-GitHub-chessgui/"
    "dd40f6ca-eb35-4fc7-a3cd-6aacb33ad79b/scratchpad"
)
STRONGNET = SCRATCH / "strongnet" / "BT3-768x15x24h-swa-2790000.pb.gz"
LC0 = "/opt/homebrew/bin/lc0"
STOCKFISH = "/opt/homebrew/bin/stockfish"

SEED = 214214

# --- tuning ---------------------------------------------------------------
BOOK_MAX_PLY = 24        # opening book applies through move 12
POLICY_TOPK = 5          # temperature-sample among the top-K policy moves
TEMP = 0.35              # low: near-argmax, still stochastic
RESIGN_CP = 500          # |eval| beyond this ...
RESIGN_PLIES = 4         # ... sustained this many plies -> resignation
DRAW_CP = 30             # |eval| under this ...
DRAW_PLIES = 20          # ... for this many plies ...
DRAW_AFTER_PLY = 120     # ... once past move 60 -> draw
MAX_PLIES = 180
ADJUDICATE_WIN_CP = 300  # at the ply cap, a lead this big is scored as a win
SWING_CLIP = 1500        # clip evals when hunting the biggest swing


# ---------------------------------------------------------------------------
# Opening book (pure)
# ---------------------------------------------------------------------------

@dataclass
class Persona:
    name: str
    surname: str
    pgn: Path
    book: Dict[str, Counter] = field(default_factory=dict)


def _persona_color(game: chess.pgn.Game, surname: str) -> Optional[chess.Color]:
    want = surname.lower()
    if want in game.headers.get("White", "").lower():
        return chess.WHITE
    if want in game.headers.get("Black", "").lower():
        return chess.BLACK
    return None


def build_book(pgn_text: str, surname: str,
               max_ply: int = BOOK_MAX_PLY) -> Dict[str, Counter]:
    """Map each opening position (EPD) the player reached, with them to move, to
    a frequency count of the moves they played there.

    Keyed by EPD (placement + side-to-move + castling + ep), so transpositions
    merge. Only the first `max_ply` half-moves of each game are booked, keeping
    it an *opening* book rather than a full-game replay table.
    """
    book: Dict[str, Counter] = defaultdict(Counter)
    stream = io.StringIO(pgn_text)
    while True:
        game = chess.pgn.read_game(stream)
        if game is None:
            break
        color = _persona_color(game, surname)
        if color is None:
            continue
        board = game.board()
        ply = 0
        for move in game.mainline_moves():
            if ply >= max_ply:
                break
            if board.turn == color and move in board.legal_moves:
                book[board.epd()][move.uci()] += 1
            board.push(move)
            ply += 1
    return dict(book)


# ---------------------------------------------------------------------------
# Move selection (pure sampling helpers)
# ---------------------------------------------------------------------------

def sample_book_move(counter: Counter, legal_ucis: set, rng: Random) -> Optional[str]:
    """Frequency-weighted pick among the booked moves that are legal now."""
    items = [(u, c) for u, c in counter.items() if u in legal_ucis]
    if not items:
        return None
    moves, weights = zip(*items)
    return rng.choices(moves, weights=weights, k=1)[0]


def temperature_pick(policy: List[Tuple[str, float]], legal_ucis: set,
                     rng: Random, topk: int = POLICY_TOPK,
                     temp: float = TEMP) -> Optional[str]:
    """Low-temperature sample over the top-K legal policy moves.

    p_i ** (1/temp) sharpens toward the argmax; temp<1 keeps it near-best but
    non-deterministic so repeated games diverge. Restricting to the top-K first
    guarantees we never sample a tail blunder.
    """
    legal = [(u, p) for u, p in policy if u in legal_ucis][:topk]
    if not legal:
        return None
    inv = 1.0 / max(temp, 1e-6)
    weights = [max(p, 1e-9) ** inv for _, p in legal]
    moves = [u for u, _ in legal]
    return rng.choices(moves, weights=weights, k=1)[0]


# ---------------------------------------------------------------------------
# Adjudication (pure)
# ---------------------------------------------------------------------------

@dataclass
class Adjudication:
    result: Optional[str] = None   # "1-0" / "0-1" / "1/2-1/2" when decided
    reason: str = ""


def adjudicate(evals: List[int], ply: int) -> Adjudication:
    """Decide a game outcome from the White-POV eval history, or leave it open.

    Resignation: |eval| >= RESIGN_CP sustained RESIGN_PLIES plies. Draw: |eval|
    < DRAW_CP for DRAW_PLIES plies once past DRAW_AFTER_PLY. Cap: at MAX_PLIES,
    a lead >= ADJUDICATE_WIN_CP is a win, else a draw.
    """
    if len(evals) >= RESIGN_PLIES:
        tail = evals[-RESIGN_PLIES:]
        if all(e >= RESIGN_CP for e in tail):
            return Adjudication("1-0", f"Black resigns (eval >= +{RESIGN_CP/100:.0f} for {RESIGN_PLIES} plies)")
        if all(e <= -RESIGN_CP for e in tail):
            return Adjudication("0-1", f"White resigns (eval <= -{RESIGN_CP/100:.0f} for {RESIGN_PLIES} plies)")
    if ply >= DRAW_AFTER_PLY and len(evals) >= DRAW_PLIES:
        if all(abs(e) < DRAW_CP for e in evals[-DRAW_PLIES:]):
            return Adjudication("1/2-1/2", f"Drawn (|eval| < {DRAW_CP/100:.1f} for {DRAW_PLIES} plies past move 60)")
    if ply >= MAX_PLIES:
        last = evals[-1] if evals else 0
        if last >= ADJUDICATE_WIN_CP:
            return Adjudication("1-0", f"Adjudicated win, White +{last/100:.1f} at ply cap")
        if last <= -ADJUDICATE_WIN_CP:
            return Adjudication("0-1", f"Adjudicated win, Black {last/100:.1f} at ply cap")
        return Adjudication("1/2-1/2", "Drawn at ply cap")
    return Adjudication()


def biggest_swing(evals: List[int], sans: List[str],
                  movenums: List[str]) -> Optional[Tuple[str, str, int, int]]:
    """Largest one-ply White-POV eval jump: (movenum, san, before, after)."""
    best = None
    for i in range(1, len(evals)):
        a = max(-SWING_CLIP, min(SWING_CLIP, evals[i - 1]))
        b = max(-SWING_CLIP, min(SWING_CLIP, evals[i]))
        d = abs(b - a)
        if best is None or d > best[0]:
            best = (d, movenums[i], sans[i], evals[i - 1], evals[i])
    if best is None:
        return None
    return best[1], best[2], best[3], best[4]


# ---------------------------------------------------------------------------
# Game play
# ---------------------------------------------------------------------------

@dataclass
class GameResult:
    round: int
    white: str
    black: str
    result: str
    reason: str
    plies: int
    sans: List[str]
    moves: List[chess.Move]
    opening_line: str
    white_book_exit: Optional[int]
    black_book_exit: Optional[int]
    evals: List[int]
    movenums: List[str]


def _movenum(ply_index: int) -> str:
    """Human move label for the 0-based ply index (0 -> '1.', 1 -> '1...')."""
    n = ply_index // 2 + 1
    return f"{n}." if ply_index % 2 == 0 else f"{n}..."


def play_game(rnd: int, white: Persona, black: Persona,
              bt3, sfeval, rng: Random) -> GameResult:
    board = chess.Board()
    sans: List[str] = []
    moves: List[chess.Move] = []
    evals: List[int] = []
    movenums: List[str] = []
    sources: List[str] = []
    book_exit = {chess.WHITE: None, chess.BLACK: None}
    opening_sans: List[str] = []

    adj = Adjudication()
    ply = 0
    while ply < MAX_PLIES:
        mover = white if board.turn == chess.WHITE else black
        legal_ucis = {m.uci() for m in board.legal_moves}
        if not legal_ucis:
            break

        chosen: Optional[str] = None
        source = "policy"
        if ply < BOOK_MAX_PLY:
            cnt = mover.book.get(board.epd())
            if cnt:
                chosen = sample_book_move(cnt, legal_ucis, rng)
                if chosen is not None:
                    source = "book"
        if chosen is None:
            if book_exit[board.turn] is None and ply < BOOK_MAX_PLY:
                book_exit[board.turn] = ply
            pol = bt3.policy(board.fen())
            chosen = temperature_pick(pol, legal_ucis, rng)
            if chosen is None:  # defensive: fall back to a legal move
                chosen = next(iter(legal_ucis))

        move = chess.Move.from_uci(chosen)
        san = board.san(move)
        label = _movenum(ply)
        sans.append(san)
        movenums.append(label)
        moves.append(move)
        sources.append(source)
        if source == "book" and ply < BOOK_MAX_PLY:
            opening_sans.append((label, san))
        board.push(move)
        ply += 1

        # Terminal by rule?
        if board.is_checkmate():
            adj = Adjudication("1-0" if board.turn == chess.BLACK else "0-1",
                               "Checkmate")
            evals.append(RESIGN_CP if board.turn == chess.BLACK else -RESIGN_CP)
            break
        if (board.is_stalemate() or board.is_insufficient_material()
                or board.can_claim_threefold_repetition()
                or board.can_claim_fifty_moves()):
            adj = Adjudication("1/2-1/2", "Draw by rule")
            evals.append(0)
            break

        cp = sfeval.eval_cp(board.fen(), stm_is_white=(board.turn == chess.WHITE))
        evals.append(cp if cp is not None else (evals[-1] if evals else 0))

        adj = adjudicate(evals, ply)
        if adj.result is not None:
            break

    if adj.result is None:
        adj = adjudicate(evals, MAX_PLIES)
        if adj.result is None:
            adj = Adjudication("1/2-1/2", "Drawn at ply cap")

    # Opening line = the booked prefix (whichever side was still in book).
    opening_line = " ".join(
        f"{lbl}{s}" if lbl.endswith(".") and not lbl.endswith("...")
        else f"{lbl}{s}" for lbl, s in opening_sans
    ) or "(out of book immediately)"

    return GameResult(
        round=rnd, white=white.name, black=black.name,
        result=adj.result, reason=adj.reason, plies=ply,
        sans=sans, moves=moves, opening_line=opening_line,
        white_book_exit=book_exit[chess.WHITE],
        black_book_exit=book_exit[chess.BLACK],
        evals=evals, movenums=movenums,
    )


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

def game_to_pgn(gr: GameResult) -> chess.pgn.Game:
    game = chess.pgn.Game()
    game.headers["Event"] = "Persona Exhibition — Fischer vs Kasparov"
    game.headers["Site"] = "ChessGUI persona simulator (spec 214 tier-2)"
    game.headers["Date"] = time.strftime("%Y.%m.%d")
    game.headers["Round"] = str(gr.round)
    game.headers["White"] = f"{gr.white} (persona)"
    game.headers["Black"] = f"{gr.black} (persona)"
    game.headers["Result"] = gr.result
    game.headers["Backend"] = "train-book + BT3-768x15x24h policy (nodes=1, T=0.35)"
    game.headers["Adjudicator"] = "Stockfish 18 @ 200ms"
    game.headers["Termination"] = gr.reason
    node = game
    board = chess.Board()
    for mv in gr.moves:
        node = node.add_variation(mv)
        board.push(mv)
    return game


def write_pgn(results: List[GameResult], path: Path) -> None:
    with path.open("w") as f:
        for gr in results:
            print(game_to_pgn(gr), file=f, end="\n\n")


def _cp(v: int) -> str:
    if abs(v) >= 90_000:
        mate = 100_000 - abs(v)
        return f"#{'' if v > 0 else '-'}{mate}"
    return f"{v/100:+.2f}"


def build_md(results: List[GameResult], scores: Dict[str, float],
             elapsed: float) -> str:
    L: List[str] = []
    A = L.append
    A("# Persona Exhibition — Fischer vs Kasparov\n")
    A(f"_Spec 214 tier-2 proof of concept · {time.strftime('%Y-%m-%d')} · "
      f"seed {SEED} · {len(results)} games, alternating colors._\n")
    A("Each persona = opening book weighted from their own TRAIN games "
      "(Fischer: `fischer.train.pgn`; Kasparov: `kasparov.train.classical.pgn`) "
      "+ BT3-768x15x24h pure policy (`go nodes 1`) once out of book, sampled at "
      "temperature 0.35 over the top 5 policy moves. Stockfish 18 (200 ms) "
      "adjudicated; it never chose a move.\n")

    fis = scores.get("Fischer", 0.0)
    kas = scores.get("Kasparov", 0.0)
    A(f"## Match score: Fischer {fis:g} – {kas:g} Kasparov\n")

    A("| # | White | Black | Result | Plies | Termination |")
    A("|--:|---|---|:--:|--:|---|")
    for gr in results:
        A(f"| {gr.round} | {gr.white} | {gr.black} | **{gr.result}** | "
          f"{gr.plies} | {gr.reason} |")
    A("")

    for gr in results:
        A(f"## Game {gr.round}: {gr.white} (W) vs {gr.black} (B) — {gr.result}\n")
        we = gr.white_book_exit
        be = gr.black_book_exit
        A(f"- Opening (booked prefix): {gr.opening_line}")
        A(f"- Left book: {gr.white} (White) after "
          f"{'move ' + str(we // 2 + 1) if we is not None else 'stayed in book to the cap'}"
          f"; {gr.black} (Black) after "
          f"{'move ' + str(be // 2 + 1) if be is not None else 'stayed in book to the cap'}.")
        sw = biggest_swing(gr.evals, gr.sans, gr.movenums)
        if sw:
            lbl, san, before, after = sw
            A(f"- Biggest eval swing: **{lbl}{san}** "
              f"({_cp(before)} → {_cp(after)}, White POV).")
        A(f"- Termination: {gr.reason}.")
        A("")

    A("## Notes\n")
    A("- Books diverge fast (the two never met), so most games leave book in the "
      "opening and BT3 policy carries the middlegame — exactly the tier-1 finding "
      "that a strong-engine policy, not a Maia net, best fits players of this "
      "strength.\n")
    A(f"- Compute: {elapsed:.0f}s for {len(results)} games on warm engines.\n")
    return "\n".join(L)


# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------

def selftest() -> int:
    import unittest

    class T(unittest.TestCase):
        def test_book_frequency_sampling(self):
            rng = Random(1)
            cnt = Counter({"e2e4": 9, "d2d4": 1})
            picks = [sample_book_move(cnt, {"e2e4", "d2d4"}, rng) for _ in range(400)]
            self.assertGreater(picks.count("e2e4"), picks.count("d2d4") * 3)

        def test_book_respects_legality(self):
            rng = Random(1)
            cnt = Counter({"e2e4": 9, "d2d4": 1})
            self.assertEqual(sample_book_move(cnt, {"d2d4"}, rng), "d2d4")
            self.assertIsNone(sample_book_move(cnt, {"g1f3"}, rng))

        def test_temperature_favors_top(self):
            rng = Random(2)
            pol = [("a", 0.5), ("b", 0.3), ("c", 0.2)]
            legal = {"a", "b", "c"}
            picks = [temperature_pick(pol, legal, rng) for _ in range(400)]
            self.assertGreater(picks.count("a"), picks.count("c"))
            # Low temp: 'a' should dominate strongly.
            self.assertGreater(picks.count("a"), 250)

        def test_resign_adjudication(self):
            evals = [100, 200, 550, 600, 700, 800]
            adj = adjudicate(evals, 6)
            self.assertEqual(adj.result, "1-0")
            evals_b = [-600, -700, -800, -900]
            self.assertEqual(adjudicate(evals_b, 4).result, "0-1")

        def test_no_resign_when_not_sustained(self):
            evals = [600, 100, 600, 100]
            self.assertIsNone(adjudicate(evals, 4).result)

        def test_draw_adjudication_after_move60(self):
            evals = [10] * 20
            self.assertEqual(adjudicate(evals, 130).result, "1/2-1/2")
            # Same evals but before move 60 -> not adjudicated.
            self.assertIsNone(adjudicate(evals, 100).result)

        def test_cap(self):
            self.assertEqual(adjudicate([400], MAX_PLIES).result, "1-0")
            self.assertEqual(adjudicate([-400], MAX_PLIES).result, "0-1")
            self.assertEqual(adjudicate([50], MAX_PLIES).result, "1/2-1/2")

        def test_biggest_swing(self):
            evals = [20, 30, -400, -420]
            sans = ["e4", "e5", "Qh5", "Nf6"]
            nums = ["1.", "1...", "2.", "2..."]
            lbl, san, before, after = biggest_swing(evals, sans, nums)
            self.assertEqual((lbl, san), ("2.", "Qh5"))

    suite = unittest.TestLoader().loadTestsFromTestCase(T)
    return 0 if unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful() else 1


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--games", type=int, default=6)
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()
    if args.selftest:
        return selftest()

    if not STRONGNET.exists():
        print(f"FATAL: strong net missing at {STRONGNET}", file=sys.stderr)
        return 2

    from engines import Lc0Policy, StockfishEval

    fischer = Persona("Fischer", "fischer", DATA_DIR / "fischer.train.pgn")
    kasparov = Persona("Kasparov", "kasparov",
                       DATA_DIR / "kasparov.train.classical.pgn")
    for p in (fischer, kasparov):
        p.book = build_book(p.pgn.read_text(), p.surname)
        print(f"[book] {p.name}: {len(p.book)} booked positions", flush=True)

    bt3 = Lc0Policy(LC0, str(STRONGNET), "lc0-bt3")
    sfeval = StockfishEval(STOCKFISH, movetime_ms=200)
    results: List[GameResult] = []
    scores: Dict[str, float] = {"Fischer": 0.0, "Kasparov": 0.0}
    t0 = time.time()
    try:
        for i in range(args.games):
            fischer_white = (i % 2 == 0)
            white, black = ((fischer, kasparov) if fischer_white
                            else (kasparov, fischer))
            rng = Random(SEED + i)
            gr = play_game(i + 1, white, black, bt3, sfeval, rng)
            results.append(gr)
            if gr.result == "1-0":
                scores[gr.white] += 1
            elif gr.result == "0-1":
                scores[gr.black] += 1
            else:
                scores[gr.white] += 0.5
                scores[gr.black] += 0.5
            print(f"[game {gr.round}] {gr.white} vs {gr.black}: {gr.result} "
                  f"({gr.plies} plies, {gr.reason})", flush=True)
    finally:
        bt3.close()
        sfeval.close()
    elapsed = time.time() - t0

    pgn_path = DATA_DIR / "exhibition_fischer_kasparov.pgn"
    md_path = DATA_DIR / "EXHIBITION.md"
    write_pgn(results, pgn_path)
    md_path.write_text(build_md(results, scores, elapsed))
    print(f"\nFischer {scores['Fischer']:g} - {scores['Kasparov']:g} Kasparov")
    print(f"Wrote {pgn_path} and {md_path}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
