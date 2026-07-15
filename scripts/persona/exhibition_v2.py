#!/usr/bin/env python3
"""Persona exhibition v2 — Fischer vs Kasparov (spec 214, match #2 harness).

This is match #2. It keeps everything the match-#1 realism audit
(`data/personas/REALISM1.md`) found *realistic* — frequency-weighted own-game
opening books, color alternation, seeded reproducibility — and replaces the four
things it found *unrealistic*, without ever faking humanness by noise-weakening
or injecting blunders (spec 214 forbids that; human-likeness comes from the book
and the policy, never from random error):

  1. VERIFICATION SEARCH instead of `go nodes 1`. Each move is chosen from a
     small lc0 search (`go nodes N`, N ~= 400-600) read at the *visit* head, not
     the raw policy head. A move that policy loves but the search refutes gets
     almost no visits, so it drops out of the top-K — this is what kills the
     single-ply 2+ pawn blunder cliffs that drove match #1's 75% decisive rate.
     Temperature sampling over the top-K visits is retained for variety.

  2. PERSONA DIFFERENTIATION via search depth. Kasparov searches more nodes than
     Fischer; that is the *only* strength knob, so the injected delta is
     attributable to one number and calibratable with `--pilot`. Per spec 214 no
     eval-noise or blunder handicap is used. Target: Kasparov ~+30..35 Elo over
     Fischer (STRENGTH_ANCHOR.md sustained-peak range).

  3. A DRAW MODEL: eval-draw adjudication from move 30 (|eval| < 0.5 sustained),
     plus a seeded stochastic agreed-draw in quiet, equal, simplified positions.
     Threefold/50-move/stalemate/insufficient are honored as in v1. Tuned toward
     the historical World-Championship 40-60% draw band via `--pilot`.

  4. A FIXED-NODE ADJUDICATOR: Stockfish at `go nodes 300000` instead of
     `movetime 200ms`, so every adjudication decision is reproducible from the
     seed alone, independent of machine and load.

Standalone script; no app changes. Reuses the tier-1 engine wrappers in
`engines.py` (v1's `exhibition.py` is left untouched as a committed baseline).

Usage:
    python exhibition_v2.py                 # 24-game match -> PGN + MATCH2.md
    python exhibition_v2.py --games 4       # short smoke run
    python exhibition_v2.py --pilot         # calibration self-match + Elo delta
    python exhibition_v2.py --selftest      # pure-function unit tests
"""

from __future__ import annotations

import argparse
import io
import math
import os
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

# The strong net (190 MB) is shared and lives in a session scratchpad; keep v1's
# location, but allow an env override and a couple of fallbacks so the harness is
# not pinned to one session id.
_NET_NAME = "BT3-768x15x24h-swa-2790000.pb.gz"
_NET_CANDIDATES = [
    os.environ.get("LC0_NET", ""),
    "/private/tmp/claude-501/-Users-hjalti-GitHub-chessgui/"
    "dd40f6ca-eb35-4fc7-a3cd-6aacb33ad79b/scratchpad/strongnet/" + _NET_NAME,
    str(REPO / "scratchpad" / "strongnet" / _NET_NAME),
]


def _find_net() -> Optional[Path]:
    for c in _NET_CANDIDATES:
        if c and Path(c).exists():
            return Path(c)
    return None


LC0 = "/opt/homebrew/bin/lc0"
STOCKFISH = "/opt/homebrew/bin/stockfish"

SEED = 214215  # new seed family for match #2 (v1 used 214214)

# --- tuning ---------------------------------------------------------------
BOOK_MAX_PLY = 24         # opening book applies through move 12

# Verification-search defaults (per-persona overridable via PersonaConfig).
FISCHER_NODES = 400
KASPAROV_NODES = 560      # 1.4x Fischer -> ~34 Elo at ~70 Elo/doubling (target +30..35)
POLICY_TOPK = 4           # sample among the top-K by *visits*
TEMP = 0.30               # low: near the search's best move, still stochastic

# Termination / adjudication.
RESIGN_CP = 350           # |eval| beyond this ... (humanized from v1's 500)
RESIGN_PLIES = 4          # ... sustained this many plies -> resignation
MAX_PLIES = 180
ADJUDICATE_WIN_CP = 300   # at the ply cap, a lead this big is scored as a win
SWING_CLIP = 1500

# Draw model.
DRAW_CP = 50              # eval-draw: |eval| under this (0.50 pawns) ...
DRAW_PLIES = 12           # ... sustained this many plies ...
DRAW_AFTER_PLY = 60       # ... once past move 30 -> draw
DRAW_AFTER_JITTER = 16    # per-game +[0,16]-ply jitter on the gate (de-cluster draws)
DRAW_PLIES_JITTER = 2     # per-game +/-2-ply jitter on the sustained window
AGREE_CP = 40             # agreed draw: recent evals within this of 0
AGREE_MIN_PLY = 50        # ... only past move 25 ...
AGREE_QUIET_PLIES = 6     # ... after this many plies with no capture/check ...
AGREE_PROB = 0.10         # ... offered/accepted with this per-ply probability

# Fixed-node Stockfish adjudicator.
ADJ_NODES = 300_000


# ---------------------------------------------------------------------------
# Persona config + opening book (pure)
# ---------------------------------------------------------------------------

@dataclass
class PersonaConfig:
    """A persona = a name, its own-game opening book, and its search strength.

    Strength lives entirely in `nodes` (verification-search depth). `temp`/`topk`
    are per-persona so tier-3 style priors can differentiate play without
    touching strength; match #2 keeps them equal across personas so the Elo delta
    is attributable to `nodes` alone.
    """
    name: str
    surname: str
    pgn: Path
    nodes: int = FISCHER_NODES
    temp: float = TEMP
    topk: int = POLICY_TOPK
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
    a frequency count of the moves they played there. Transpositions merge on
    EPD; only the first `max_ply` half-moves are booked."""
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
# lc0 verification-search parsing + move selection (pure)
# ---------------------------------------------------------------------------

from engines import (  # noqa: E402  (deliberate: reuse the tier-1 wrappers)
    Lc0Policy, StockfishEval, parse_sf_score_cp, _is_uci_move, _paren_field,
)


def parse_lc0_search(lines: List[str]) -> List[Tuple[str, int, float, float]]:
    """Parse VerboseMoveStats from a `go nodes N` search.

    Returns (uci, visits, policy, q) per legal move, sorted by visits desc (then
    policy), best first. The `node` summary line is skipped (its token 'node' is
    not a UCI move). `visits` is lc0's search count N — the signal that has
    'seen' the tactics, unlike the raw policy prior P used at nodes=1.
    """
    out: List[Tuple[str, int, float, float]] = []
    for line in lines:
        t = line.strip()
        if not t.startswith("info string "):
            continue
        body = t[len("info string "):]
        parts = body.split()
        if not parts or not _is_uci_move(parts[0]):
            continue
        uci = parts[0]
        # Visits: bare "N:      75 (+ 7)" — take the integer right after "N:".
        visits = 0
        idx = body.find("N:")
        if idx >= 0:
            tail = body[idx + 2:].split()
            if tail:
                try:
                    visits = int(tail[0])
                except ValueError:
                    visits = 0
        p = _paren_field(body, "P:")
        q = _paren_field(body, "Q:")
        out.append((uci, visits, (p or 0.0) / 100.0, q if q is not None else 0.0))
    out.sort(key=lambda m: (m[1], m[2]), reverse=True)
    return out


def temperature_pick_visits(stats: List[Tuple[str, int, float, float]],
                            legal_ucis: set, rng: Random,
                            topk: int = POLICY_TOPK,
                            temp: float = TEMP) -> Optional[str]:
    """Low-temperature sample over the top-K legal moves *by visit count*.

    Restricting to the top-K by search visits guarantees a search-refuted move
    (few/zero visits) can never be sampled — the mechanism that removes the
    one-ply blunder cliffs. Within the top-K, weight_i = visits_i ** (1/temp);
    temp<1 sharpens toward the most-visited (best) move while staying stochastic.
    Falls back to policy weighting only if the whole top-K has zero visits.
    """
    cand = [(u, n, p) for (u, n, p, _q) in stats if u in legal_ucis]
    if not cand:
        return None
    cand.sort(key=lambda t: (t[1], t[2]), reverse=True)
    top = cand[:topk]
    inv = 1.0 / max(temp, 1e-6)
    moves = [u for u, _, _ in top]
    if sum(n for _, n, _ in top) <= 0:
        weights = [max(p, 1e-9) ** inv for _, _, p in top]
    else:
        weights = [max(float(n), 1e-9) ** inv for _, n, _ in top]
    return rng.choices(moves, weights=weights, k=1)[0]


def sample_book_move(counter: Counter, legal_ucis: set,
                     rng: Random) -> Optional[str]:
    """Frequency-weighted pick among the booked moves that are legal now."""
    items = [(u, c) for u, c in counter.items() if u in legal_ucis]
    if not items:
        return None
    moves, weights = zip(*items)
    return rng.choices(moves, weights=weights, k=1)[0]


# ---------------------------------------------------------------------------
# Adjudication + draw model (pure)
# ---------------------------------------------------------------------------

@dataclass
class Adjudication:
    result: Optional[str] = None   # "1-0" / "0-1" / "1/2-1/2" when decided
    reason: str = ""


def eval_draw_reached(evals: List[int], ply: int, cp: int = DRAW_CP,
                      plies: int = DRAW_PLIES,
                      after: int = DRAW_AFTER_PLY) -> bool:
    """|eval| under `cp` for `plies` consecutive plies, past `after` -> draw."""
    return (ply >= after and len(evals) >= plies
            and all(abs(e) < cp for e in evals[-plies:]))


def adjudicate(evals: List[int], ply: int,
               draw_after: int = DRAW_AFTER_PLY,
               draw_plies: int = DRAW_PLIES) -> Adjudication:
    """Decide an outcome from the White-POV eval history, or leave it open.

    Resignation: |eval| >= RESIGN_CP sustained RESIGN_PLIES. Eval-draw: quiet
    equality past move 30, where `draw_after`/`draw_plies` carry each game's
    seeded jitter (so equal games don't all draw at the same ply). Cap: at
    MAX_PLIES a lead >= ADJUDICATE_WIN_CP wins, else draw. (The stochastic agreed
    draw is applied in the play loop, since it needs the rng and the
    recent-quiescence context.)
    """
    if len(evals) >= RESIGN_PLIES:
        tail = evals[-RESIGN_PLIES:]
        if all(e >= RESIGN_CP for e in tail):
            return Adjudication("1-0", "Black resigns")
        if all(e <= -RESIGN_CP for e in tail):
            return Adjudication("0-1", "White resigns")
    if eval_draw_reached(evals, ply, DRAW_CP, draw_plies, draw_after):
        return Adjudication("1/2-1/2", "Drawn (sustained equality)")
    if ply >= MAX_PLIES:
        last = evals[-1] if evals else 0
        if last >= ADJUDICATE_WIN_CP:
            return Adjudication("1-0", "White adjudicated at move cap")
        if last <= -ADJUDICATE_WIN_CP:
            return Adjudication("0-1", "Black adjudicated at move cap")
        return Adjudication("1/2-1/2", "Drawn at move cap")
    return Adjudication()


def agreed_draw(evals: List[int], quiet_plies: int, ply: int, rng: Random,
                prob: float = AGREE_PROB, cp: int = AGREE_CP,
                min_ply: int = AGREE_MIN_PLY,
                quiet_needed: int = AGREE_QUIET_PLIES) -> bool:
    """Seeded stochastic agreed draw in a quiet, equal, simplified position.

    Gated on: past `min_ply`; `quiet_needed` recent plies with no capture/check;
    the last two evals within `cp` of zero. Then accepted with probability
    `prob`. This is the modal game of real elite matches (a short/mid agreed
    draw) that match #1 had no mechanism for — and it only fires when neither
    side is better, so it never throws away a won game.
    """
    if ply < min_ply or quiet_plies < quiet_needed or len(evals) < 2:
        return False
    if any(abs(e) > cp for e in evals[-2:]):
        return False
    return rng.random() < prob


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
class MatchOptions:
    use_book: bool = True
    max_plies: int = MAX_PLIES
    draw_prob: float = AGREE_PROB
    diversify_plies: int = 0        # first N plies at high temp/topk (pilot only)
    diversify_temp: float = 1.0
    diversify_topk: int = 8
    per_ply_eval: bool = True       # eval each ply (adjudication); off = eval @ end


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
    n = ply_index // 2 + 1
    return f"{n}." if ply_index % 2 == 0 else f"{n}..."


def _is_quiet_ply(board_before: chess.Board, move: chess.Move,
                  board_after: chess.Board) -> bool:
    """A ply is quiet if it is neither a capture nor gives check."""
    return not board_before.is_capture(move) and not board_after.is_check()


def play_game(rnd: int, white: PersonaConfig, black: PersonaConfig,
              bt3, sfeval, rng: Random,
              opts: Optional[MatchOptions] = None) -> GameResult:
    opts = opts or MatchOptions()
    # Per-game seeded jitter on the eval-draw gate + sustained window, so equal
    # games don't all draw at exactly the same ply. Drawn from this game's rng,
    # so reproducibility from the seed holds.
    draw_after = DRAW_AFTER_PLY + rng.randint(0, DRAW_AFTER_JITTER)
    draw_plies = DRAW_PLIES + rng.randint(-DRAW_PLIES_JITTER, DRAW_PLIES_JITTER)
    board = chess.Board()
    sans: List[str] = []
    moves: List[chess.Move] = []
    evals: List[int] = []
    movenums: List[str] = []
    book_exit = {chess.WHITE: None, chess.BLACK: None}
    opening_sans: List[Tuple[str, str]] = []
    quiet_plies = 0

    adj = Adjudication()
    ply = 0
    while ply < opts.max_plies:
        mover = white if board.turn == chess.WHITE else black
        legal_ucis = {m.uci() for m in board.legal_moves}
        if not legal_ucis:
            break

        chosen: Optional[str] = None
        source = "policy"
        if opts.use_book and ply < BOOK_MAX_PLY:
            cnt = mover.book.get(board.epd())
            if cnt:
                chosen = sample_book_move(cnt, legal_ucis, rng)
                if chosen is not None:
                    source = "book"
        if chosen is None:
            if book_exit[board.turn] is None and ply < BOOK_MAX_PLY:
                book_exit[board.turn] = ply
            if ply < opts.diversify_plies:
                temp, topk = opts.diversify_temp, opts.diversify_topk
            else:
                temp, topk = mover.temp, mover.topk
            stats = bt3.search(board.fen(), mover.nodes)
            chosen = temperature_pick_visits(stats, legal_ucis, rng, topk, temp)
            if chosen is None:  # defensive: any legal move
                chosen = next(iter(legal_ucis))

        move = chess.Move.from_uci(chosen)
        san = board.san(move)
        label = _movenum(ply)
        board_before = board.copy(stack=False)
        sans.append(san)
        movenums.append(label)
        moves.append(move)
        if source == "book" and ply < BOOK_MAX_PLY:
            opening_sans.append((label, san))
        board.push(move)
        ply += 1

        quiet_plies = quiet_plies + 1 if _is_quiet_ply(board_before, move, board) else 0

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

        if opts.per_ply_eval:
            cp = sfeval.eval_cp(board.fen(),
                                stm_is_white=(board.turn == chess.WHITE))
            evals.append(cp if cp is not None else (evals[-1] if evals else 0))
            if agreed_draw(evals, quiet_plies, ply, rng, opts.draw_prob):
                adj = Adjudication("1/2-1/2", "Draw agreed")
                break
            adj = adjudicate(evals, ply, draw_after, draw_plies)
            if adj.result is not None:
                break

    if adj.result is None:
        # No per-ply eval (pilot) or hit the cap: a single terminal eval decides.
        if not evals or not opts.per_ply_eval:
            cp = sfeval.eval_cp(board.fen(),
                                stm_is_white=(board.turn == chess.WHITE))
            evals.append(cp if cp is not None else 0)
        adj = adjudicate(evals, max(ply, MAX_PLIES) if ply >= opts.max_plies else ply,
                         draw_after, draw_plies)
        if adj.result is None:
            last = evals[-1]
            if last >= ADJUDICATE_WIN_CP:
                adj = Adjudication("1-0", "White adjudicated at move cap")
            elif last <= -ADJUDICATE_WIN_CP:
                adj = Adjudication("0-1", "Black adjudicated at move cap")
            else:
                adj = Adjudication("1/2-1/2", "Drawn at move cap")

    opening_line = " ".join(f"{lbl}{s}" for lbl, s in opening_sans) \
        or "(out of book immediately)"

    return GameResult(
        round=rnd, white=white.name, black=black.name,
        result=adj.result, reason=adj.reason, plies=ply,
        sans=sans, moves=moves, opening_line=opening_line,
        white_book_exit=book_exit[chess.WHITE],
        black_book_exit=book_exit[chess.BLACK],
        evals=evals, movenums=movenums,
    )


# ---------------------------------------------------------------------------
# Live engine wrappers (verification search + fixed-node adjudicator)
# ---------------------------------------------------------------------------

class Lc0Search(Lc0Policy):
    """lc0 read at the *visit* head after a small `go nodes N` search."""

    def search(self, fen: str, nodes: int) -> List[Tuple[str, int, float, float]]:
        self._send(f"position fen {fen}")
        self._send(f"go nodes {max(1, nodes)}")
        lines = self._wait("bestmove")
        return parse_lc0_search(lines)


class StockfishFixedNodesEval(StockfishEval):
    """Adjudicator eval at a fixed node budget -> seed-reproducible across machines."""

    def __init__(self, sf_path: str, nodes: int = ADJ_NODES, threads: int = 2,
                 name: str = "stockfish-eval-nodes"):
        super().__init__(sf_path, threads=threads, name=name)
        self.nodes = nodes

    def eval_cp(self, fen: str, stm_is_white: bool) -> Optional[int]:
        self._send(f"position fen {fen}")
        self._send(f"go nodes {self.nodes}")
        lines = self._wait("bestmove")
        return parse_sf_score_cp(lines, stm_is_white)


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

BACKEND_DESC = ("train-book + BT3-768x15x24h verification search "
                "(visit head), Fischer nodes={f} / Kasparov nodes={k}, T={t}")


def game_to_pgn(gr: GameResult, fnodes: int, knodes: int,
                adj_nodes: int = ADJ_NODES) -> chess.pgn.Game:
    game = chess.pgn.Game()
    game.headers["Event"] = "Persona Exhibition v2 — Fischer vs Kasparov"
    game.headers["Site"] = "ChessGUI persona simulator (spec 214, match #2)"
    game.headers["Date"] = time.strftime("%Y.%m.%d")
    game.headers["Round"] = str(gr.round)
    game.headers["White"] = f"{gr.white} (persona)"
    game.headers["Black"] = f"{gr.black} (persona)"
    game.headers["Result"] = gr.result
    game.headers["Backend"] = BACKEND_DESC.format(f=fnodes, k=knodes, t=TEMP)
    game.headers["Adjudicator"] = f"Stockfish @ {adj_nodes} nodes"
    game.headers["Termination"] = gr.reason
    node = game
    for mv in gr.moves:
        node = node.add_variation(mv)
    return game


def write_pgn(results: List[GameResult], path: Path,
              fnodes: int, knodes: int, adj_nodes: int = ADJ_NODES) -> None:
    with path.open("w") as f:
        for gr in results:
            print(game_to_pgn(gr, fnodes, knodes, adj_nodes), file=f, end="\n\n")


def _cp(v: int) -> str:
    if abs(v) >= 90_000:
        mate = 100_000 - abs(v)
        return f"#{'' if v > 0 else '-'}{mate}"
    return f"{v/100:+.2f}"


def build_md(results: List[GameResult], scores: Dict[str, float],
             elapsed: float, fnodes: int, knodes: int,
             adj_nodes: int = ADJ_NODES) -> str:
    L: List[str] = []
    A = L.append
    n = len(results)
    draws = sum(1 for gr in results if gr.result == "1/2-1/2")
    white_pts = sum((1.0 if gr.result == "1-0" else 0.5 if gr.result == "1/2-1/2"
                     else 0.0) for gr in results)
    A("# Persona Exhibition v2 — Fischer vs Kasparov\n")
    A(f"_Spec 214 match #2 · {time.strftime('%Y-%m-%d')} · seed {SEED} · "
      f"{n} games, alternating colors._\n")
    A("Each persona = opening book weighted from their own TRAIN games + "
      f"BT3-768x15x24h **verification search** (visit head, Fischer {fnodes} "
      f"nodes / Kasparov {knodes} nodes, T={TEMP}, top-{POLICY_TOPK}). Draw model: "
      "eval-draw from move 30 + stochastic agreed draw in quiet equal positions. "
      f"Stockfish @ {adj_nodes} nodes adjudicated (fixed nodes = reproducible); "
      "it never chose a move.\n")

    fis = scores.get("Fischer", 0.0)
    kas = scores.get("Kasparov", 0.0)
    A(f"## Match score: Fischer {fis:g} – {kas:g} Kasparov\n")
    A(f"- Draws: {draws}/{n} ({100*draws/n:.0f}%) · White score "
      f"{white_pts:g}/{n} ({100*white_pts/n:.0f}%)\n")

    A("| # | White | Black | Result | Plies | Termination |")
    A("|--:|---|---|:--:|--:|---|")
    for gr in results:
        A(f"| {gr.round} | {gr.white} | {gr.black} | **{gr.result}** | "
          f"{gr.plies} | {gr.reason} |")
    A("")

    for gr in results:
        A(f"## Game {gr.round}: {gr.white} (W) vs {gr.black} (B) — {gr.result}\n")
        we, be = gr.white_book_exit, gr.black_book_exit
        A(f"- Opening (booked prefix): {gr.opening_line}")
        A(f"- Left book: {gr.white} (White) after "
          f"{'move ' + str(we // 2 + 1) if we is not None else 'stayed in book'}"
          f"; {gr.black} (Black) after "
          f"{'move ' + str(be // 2 + 1) if be is not None else 'stayed in book'}.")
        sw = biggest_swing(gr.evals, gr.sans, gr.movenums)
        if sw:
            lbl, san, before, after = sw
            A(f"- Biggest eval swing: **{lbl}{san}** "
              f"({_cp(before)} → {_cp(after)}, White POV).")
        A(f"- Termination: {gr.reason}.")
        A("")

    A("## Notes\n")
    A("- Move backend is a verification search read at the visit head, not "
      "`go nodes 1` policy — a search-refuted move gets too few visits to enter "
      "the top-K, so the one-ply blunder cliffs of match #1 are removed.\n")
    A("- Strength delta is injected solely through search nodes "
      f"(Kasparov {knodes} / Fischer {fnodes}); no eval-noise or blunder handicap "
      "(spec 214 hard rule).\n")
    A(f"- Compute: {elapsed:.0f}s for {n} games on warm engines.\n")
    return "\n".join(L)


# ---------------------------------------------------------------------------
# Pilot calibration
# ---------------------------------------------------------------------------

def elo_from_score(s: float) -> float:
    s = min(max(s, 1e-9), 1 - 1e-9)
    return -400.0 * math.log10(1.0 / s - 1.0)


def run_pilot(kas: PersonaConfig, fis: PersonaConfig, bt3, sfeval,
              n_games: int, plies: int, seed: int) -> str:
    """Self-match Kasparov-config vs Fischer-config from diversified openings, no
    books, capped at `plies`. Prints Kasparov's score, the implied Elo delta, and
    a 95% CI, so the node settings can be tuned. Returns a one-line summary."""
    opts = MatchOptions(use_book=False, max_plies=plies, draw_prob=AGREE_PROB,
                        diversify_plies=6, per_ply_eval=False)
    results = []  # per-game Kasparov points (1 / 0.5 / 0)
    w = d = l = 0
    t0 = time.time()
    for i in range(n_games):
        kas_white = (i % 2 == 0)
        white, black = (kas, fis) if kas_white else (fis, kas)
        rng = Random(seed + i)
        gr = play_game(i + 1, white, black, bt3, sfeval, rng, opts)
        if gr.result == "1/2-1/2":
            pts = 0.5; d += 1
        elif (gr.result == "1-0") == kas_white:
            pts = 1.0; w += 1
        else:
            pts = 0.0; l += 1
        results.append(pts)
        print(f"[pilot {i+1}/{n_games}] K-{'W' if kas_white else 'B'} "
              f"{gr.result} ({gr.plies}p, {gr.reason})", flush=True)
    n = len(results)
    s = sum(results) / n
    # SE of the mean from observed per-game outcomes.
    var = sum((r - s) ** 2 for r in results) / n
    se = math.sqrt(var / n)
    lo, hi = max(1e-9, s - 1.96 * se), min(1 - 1e-9, s + 1.96 * se)
    elapsed = time.time() - t0
    summary = (
        f"Pilot: Kasparov-config {s*n:g}/{n} vs Fischer-config "
        f"(+{w} ={d} -{l}), score {s:.3f} [95% CI {lo:.3f}, {hi:.3f}]. "
        f"Elo delta {elo_from_score(s):+.0f} "
        f"[{elo_from_score(lo):+.0f}, {elo_from_score(hi):+.0f}]. "
        f"nodes K={kas.nodes}/F={fis.nodes}, cap {plies}p, {elapsed:.0f}s.")
    print("\n" + summary, flush=True)
    return summary


# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------

def selftest() -> int:
    import unittest

    class T(unittest.TestCase):
        def test_parse_lc0_search(self):
            lines = [
                "info string e2e4  (322 ) N:      37 (+ 0) (P:  8.46%) (Q:  0.03985) ",
                "info string d2d4  (293 ) N:      79 (+ 9) (P: 12.74%) (Q:  0.05157) ",
                "info string g2g4  (378 ) N:       0 (+ 0) (P:  0.80%) (Q:  0.00000) ",
                "info string node  (  20) N:     401 (+16) (P: 95.30%) (Q:  0.03454) ",
                "bestmove d2d4 ponder d7d5",
            ]
            stats = parse_lc0_search(lines)
            self.assertEqual(stats[0][0], "d2d4")   # most visits first
            self.assertEqual(stats[0][1], 79)
            self.assertEqual([s[0] for s in stats], ["d2d4", "e2e4", "g2g4"])
            self.assertNotIn("node", [s[0] for s in stats])

        def test_visit_pick_excludes_low_visit_blunder(self):
            # A move policy loves (high P) but the search refuted (0 visits) must
            # never be sampled — the anti-blunder guarantee.
            rng = Random(3)
            stats = [("d2d4", 80, 0.13, 0.05), ("e2e4", 37, 0.08, 0.04),
                     ("h2h4", 5, 0.02, -0.03),
                     ("g2g4", 0, 0.40, -0.48)]  # high policy, refuted
            legal = {s[0] for s in stats}
            picks = [temperature_pick_visits(stats, legal, rng, topk=3, temp=0.30)
                     for _ in range(500)]
            self.assertEqual(picks.count("g2g4"), 0)
            self.assertGreater(picks.count("d2d4"), picks.count("e2e4"))

        def test_visit_pick_policy_fallback_when_no_visits(self):
            rng = Random(1)
            stats = [("a1a2", 0, 0.6, 0.0), ("b1b2", 0, 0.3, 0.0)]
            legal = {"a1a2", "b1b2"}
            picks = [temperature_pick_visits(stats, legal, rng, topk=2, temp=0.3)
                     for _ in range(400)]
            self.assertGreater(picks.count("a1a2"), picks.count("b1b2"))

        def test_book_frequency_and_legality(self):
            rng = Random(1)
            cnt = Counter({"e2e4": 9, "d2d4": 1})
            picks = [sample_book_move(cnt, {"e2e4", "d2d4"}, rng) for _ in range(400)]
            self.assertGreater(picks.count("e2e4"), picks.count("d2d4") * 3)
            self.assertEqual(sample_book_move(cnt, {"d2d4"}, rng), "d2d4")
            self.assertIsNone(sample_book_move(cnt, {"g1f3"}, rng))

        def test_resign_adjudication(self):
            self.assertEqual(adjudicate([100, 400, 400, 380, 360], 5).result, "1-0")
            self.assertEqual(adjudicate([-400, -420, -500, -600], 4).result, "0-1")
            self.assertIsNone(adjudicate([400, 100, 400, 100], 4).result)

        def test_eval_draw_from_move30(self):
            evals = [10] * 12
            self.assertTrue(eval_draw_reached(evals, 62))
            self.assertFalse(eval_draw_reached(evals, 40))   # before move 30
            self.assertEqual(adjudicate([10] * 12, 62).result, "1/2-1/2")

        def test_adjudicate_respects_jittered_gate(self):
            # A game whose seeded gate jitter pushed the open to ply 70 must not
            # draw at 62, but must at 72 — the de-clustering mechanism.
            evals = [10] * 14
            self.assertIsNone(adjudicate(evals, 62, draw_after=70, draw_plies=12).result)
            self.assertEqual(adjudicate(evals, 72, draw_after=70, draw_plies=12).result,
                             "1/2-1/2")
            # A widened sustained window (14) is honored: only 12 equal plies is
            # not yet enough.
            self.assertIsNone(adjudicate([10] * 12, 80, draw_after=70,
                                         draw_plies=14).result)

        def test_agreed_draw_gates(self):
            rng = Random(0)
            # Not quiet enough -> never.
            self.assertFalse(agreed_draw([5, -5], 2, 60, rng, prob=1.0))
            # Not equal -> never.
            self.assertFalse(agreed_draw([200, 5], 8, 60, rng, prob=1.0))
            # Before min ply -> never.
            self.assertFalse(agreed_draw([5, -5], 8, 40, rng, prob=1.0))
            # All gates open, prob=1 -> always.
            self.assertTrue(agreed_draw([5, -5], 8, 60, rng, prob=1.0))
            # prob=0 -> never even when eligible.
            self.assertFalse(agreed_draw([5, -5], 8, 60, rng, prob=0.0))

        def test_cap(self):
            self.assertEqual(adjudicate([400], MAX_PLIES).result, "1-0")
            self.assertEqual(adjudicate([-400], MAX_PLIES).result, "0-1")
            self.assertEqual(adjudicate([50], MAX_PLIES).result, "1/2-1/2")

        def test_biggest_swing(self):
            lbl, san, before, after = biggest_swing(
                [20, 30, -400, -420], ["e4", "e5", "Qh5", "Nf6"],
                ["1.", "1...", "2.", "2..."])
            self.assertEqual((lbl, san), ("2.", "Qh5"))

        def test_elo_from_score(self):
            self.assertAlmostEqual(elo_from_score(0.5), 0.0, places=6)
            self.assertGreater(elo_from_score(0.55), 30)
            self.assertLess(elo_from_score(0.55), 40)

    suite = unittest.TestLoader().loadTestsFromTestCase(T)
    return 0 if unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful() else 1


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def _load_personas() -> Tuple[PersonaConfig, PersonaConfig]:
    fischer = PersonaConfig("Fischer", "fischer",
                            DATA_DIR / "fischer.train.pgn", nodes=FISCHER_NODES)
    kasparov = PersonaConfig("Kasparov", "kasparov",
                             DATA_DIR / "kasparov.train.classical.pgn",
                             nodes=KASPAROV_NODES)
    for p in (fischer, kasparov):
        p.book = build_book(p.pgn.read_text(), p.surname)
        print(f"[book] {p.name}: {len(p.book)} booked positions "
              f"(nodes={p.nodes})", flush=True)
    return fischer, kasparov


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--games", type=int, default=24)
    ap.add_argument("--fischer-nodes", type=int, default=FISCHER_NODES)
    ap.add_argument("--kasparov-nodes", type=int, default=KASPAROV_NODES)
    ap.add_argument("--draw-prob", type=float, default=AGREE_PROB)
    ap.add_argument("--adj-nodes", type=int, default=ADJ_NODES)
    ap.add_argument("--pilot", action="store_true",
                    help="run a calibration self-match and print the Elo delta")
    ap.add_argument("--pilot-games", type=int, default=40)
    ap.add_argument("--pilot-plies", type=int, default=50)
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()
    if args.selftest:
        return selftest()

    net = _find_net()
    if net is None:
        print(f"FATAL: strong net {_NET_NAME} not found in any known location",
              file=sys.stderr)
        return 2

    fischer, kasparov = _load_personas()
    fischer.nodes = args.fischer_nodes
    kasparov.nodes = args.kasparov_nodes

    bt3 = Lc0Search(LC0, str(net), "lc0-bt3-search")
    sfeval = StockfishFixedNodesEval(STOCKFISH, nodes=args.adj_nodes)
    try:
        if args.pilot:
            run_pilot(kasparov, fischer, bt3, sfeval,
                      args.pilot_games, args.pilot_plies, SEED + 9000)
            return 0

        results: List[GameResult] = []
        scores: Dict[str, float] = {"Fischer": 0.0, "Kasparov": 0.0}
        opts = MatchOptions(use_book=True, draw_prob=args.draw_prob)
        t0 = time.time()
        for i in range(args.games):
            fischer_white = (i % 2 == 0)
            white, black = ((fischer, kasparov) if fischer_white
                            else (kasparov, fischer))
            rng = Random(SEED + i)
            gr = play_game(i + 1, white, black, bt3, sfeval, rng, opts)
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
        elapsed = time.time() - t0
    finally:
        bt3.close()
        sfeval.close()

    pgn_path = DATA_DIR / "match2_fischer_kasparov.pgn"
    md_path = DATA_DIR / "MATCH2.md"
    write_pgn(results, pgn_path, fischer.nodes, kasparov.nodes, args.adj_nodes)
    md_path.write_text(build_md(results, scores, elapsed,
                                fischer.nodes, kasparov.nodes, args.adj_nodes))
    print(f"\nFischer {scores['Fischer']:g} - {scores['Kasparov']:g} Kasparov")
    print(f"Wrote {pgn_path} and {md_path}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
