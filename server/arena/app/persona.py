"""Persona move selection — the spec-214 contract, Tier-0 subset.

Implemented arms (honest inventory):
  step 2  book phase: the committed {slug}.book.json (build_rival_book format:
          entries keyed by the position AFTER the persona's move + rival_color;
          we index by EPD so transpositions merge, matching the exhibition
          harness semantics), frequency-weighted sampling.
  step 3  out of book: lc0 BT3 verification search read at the visit head,
          top-k temperature sampling (exhibition_v2 / match #2 arm — realism
          verdict 6.9/10, supersedes raw policy-only which match #1 showed
          blunder-cliffs on). No phase/clock temperature schedule yet.
  step 8  determinism: per-game seed, per-ply RNG stream.
  step 9  per-move decision log persisted with each persona move.

NOT implemented in Tier 0: step 4 Stockfish verification reweight (the visit
head serves as verification), step 5 corpus error model, step 6 endgame arm,
step 7 draw/resign model (a human opponent adjudicates their own games)."""

import json
import os
import random
from collections import defaultdict
from typing import Any, Dict, List, Optional, Tuple

import chess

from . import config
from .engine import Lc0Search


class Persona:
    def __init__(self, slug: str, cfg: dict, book_index: dict):
        self.slug = slug
        self.display_name = cfg["display_name"]
        self.bio = cfg["bio"]
        self.book = book_index          # epd -> [(uci, weight)] for this persona
        sampling = cfg.get("sampling", {})
        self.top_k = int(sampling.get("top_k", config.TOP_K))
        self.nodes = config.SEARCH_NODES


def _index_book(path: str) -> dict:
    """entries[] have fen (position AFTER the move), line, rival_color, weight.
    Recover the move: parent EPD -> [(uci, weight)] by replaying `line`."""
    with open(path) as f:
        book = json.load(f)
    idx: dict = defaultdict(list)
    for e in book["entries"]:
        tokens = [t for t in e["line"].replace(".", ". ").split()
                  if not t.rstrip(".").isdigit()]
        board = chess.Board()
        try:
            for san in tokens:
                board.push_san(san)
        except ValueError:
            continue
        if board.fen() != e["fen"]:
            continue  # line/fen disagree; skip rather than guess
        board.pop()
        move = board.parse_san(tokens[-1])
        idx[board.epd()].append((move.uci(), e["weight"]))
    return dict(idx)


def load_roster() -> Dict[str, Persona]:
    roster: Dict[str, Persona] = {}
    for slug in config.TIER0_SLUGS:
        cfg_path = os.path.join(config.PERSONA_DIR, f"{slug}.config.json")
        book_path = os.path.join(config.PERSONA_DIR, f"{slug}.book.json")
        with open(cfg_path) as f:
            cfg = json.load(f)
        roster[slug] = Persona(slug, cfg, _index_book(book_path))
    return roster


def _rng(seed: int, ply: int) -> random.Random:
    return random.Random(f"{seed}:{ply}")


def select_move(persona: Persona, board: chess.Board, seed: int,
                engine: Lc0Search) -> Tuple[chess.Move, str, Dict[str, Any]]:
    """Returns (move, arm, decision_log). Raises EngineStall upward if the
    engine fails twice — the game stays active and resumable."""
    rng = _rng(seed, board.ply())
    legal = {m.uci() for m in board.legal_moves}

    booked = [(u, w) for u, w in persona.book.get(board.epd(), [])
              if u in legal]
    if booked:
        moves, weights = zip(*booked)
        uci = rng.choices(moves, weights=weights, k=1)[0]
        log = {"arm": "book", "candidates": booked}
        return chess.Move.from_uci(uci), "book", log

    stats = engine.search(board.fen(), persona.nodes)
    cand = [(u, n, p) for (u, n, p, _q) in stats if u in legal]
    if not cand:  # should not happen on a legal position; fail loud, resumable
        raise RuntimeError("engine returned no legal candidates")
    cand.sort(key=lambda t: (t[1], t[2]), reverse=True)
    top = cand[:persona.top_k]
    inv = 1.0 / max(config.TEMP, 1e-6)
    if sum(n for _, n, _ in top) <= 0:
        weights = [max(p, 1e-9) ** inv for _, _, p in top]
    else:
        weights = [max(float(n), 1e-9) ** inv for _, n, _ in top]
    uci = rng.choices([u for u, _, _ in top], weights=weights, k=1)[0]
    log = {"arm": "search", "nodes": persona.nodes,
           "top": [{"uci": u, "visits": n, "policy": round(p, 4)}
                   for u, n, p in top],
           "chosen": uci}
    return chess.Move.from_uci(uci), "search", log
