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
    def __init__(self, slug: str, cfg: dict, book_index: dict,
                 net_path: Optional[str] = None):
        self.slug = slug
        self.display_name = cfg["display_name"]
        self.bio = cfg.get("bio", "")   # private-rival configs carry no bio
        self.book = book_index          # epd -> [(uci, weight)] for this persona
        sampling = cfg.get("sampling", {})
        self.top_k = int(sampling.get("top_k", config.TOP_K))
        # net_path None -> the shared BT3 engine. Private amateur personas get
        # their own net (Maia band) and a smaller out-of-book node budget —
        # deep search on ANY net would play above the band.
        self.net_path = net_path
        self.nodes = config.MAIA_SEARCH_NODES if net_path else config.SEARCH_NODES
        self.private = bool(cfg.get("private"))
        self.strength_label = _strength_label(cfg)


def _strength_label(cfg: dict) -> Optional[str]:
    """Honest lobby label (spec 216 hard rule: no unmeasured strength claims).
    Private-rival configs (build_rival_configs.py) carry strength_label; GM
    personas get theirs client-side from persona-manifest.ts, so None here."""
    sl = cfg.get("strength_label")
    if not sl:
        return None
    band = sl.get("maia_band")
    return f"own book + Maia {band}, unmeasured" if band else sl.get("kind")


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
    """spec 217 Tier 1: only personas whose artifacts are present and loadable
    unlock — a slug whose config or book is missing from the mount is skipped
    with a log line (same contract as load_private_roster), never invented."""
    roster: Dict[str, Persona] = {}
    for slug in config.ROSTER_SLUGS:
        cfg_path = os.path.join(config.PERSONA_DIR, f"{slug}.config.json")
        book_path = os.path.join(config.PERSONA_DIR, f"{slug}.book.json")
        missing = [p for p in (cfg_path, book_path) if not os.path.exists(p)]
        if missing:
            print(f"[persona] '{slug}': missing {', '.join(missing)}; skipped")
            continue
        with open(cfg_path) as f:
            cfg = json.load(f)
        roster[slug] = Persona(slug, cfg, _index_book(book_path))
    return roster


def load_private_roster() -> Dict[str, Persona]:
    """spec 217 Promise 1: owner email -> that player's OWN persona, shown in
    their lobby and nobody else's. Never raises on missing artifacts — the
    persona simply appears once {slug}.config.json + its book (+ the Maia net
    its backend names) land in PRIVATE_PERSONA_DIR (server-private, the
    data/rivals equivalent; spec 214 hard rule: never committed)."""
    roster: Dict[str, Persona] = {}
    for email, slug in config.PRIVATE_PERSONAS.items():
        cfg_path = os.path.join(config.PRIVATE_PERSONA_DIR,
                                f"{slug}.config.json")
        if not os.path.exists(cfg_path):
            print(f"[persona] private '{slug}': missing {cfg_path}; skipped")
            continue
        with open(cfg_path) as f:
            cfg = json.load(f)
        # book.path is repo-relative in build_rival_configs.py output; only
        # the basename means anything inside the container mount.
        rel = cfg.get("book", {}).get("path", f"{slug}.book.json")
        book_path = os.path.join(config.PRIVATE_PERSONA_DIR,
                                 os.path.basename(rel))
        if not os.path.exists(book_path):
            print(f"[persona] private '{slug}': missing {book_path}; skipped")
            continue
        backend = cfg.get("backend", {})
        net_path = None
        if backend.get("kind") == "maia":
            net_path = os.path.join(config.MAIA_NET_DIR, backend["net"])
            if not os.path.exists(net_path):
                print(f"[persona] private '{slug}': missing Maia net "
                      f"{net_path}; skipped")
                continue
        p = Persona(slug, cfg, _index_book(book_path), net_path)
        p.private = True  # gating fact, not a config opinion
        roster[email] = p
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
