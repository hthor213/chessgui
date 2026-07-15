#!/usr/bin/env python3
"""Persona eval harness — spec 214, tier-1.

The Hikaru-bot test made quantitative: on held-out positions from a player's own
games, how often does a candidate move-policy play the human's move? We sample
the persona's own to-move positions from their EVAL games (never the training
split), stratify across game phase, and score four policy backends by
move-match@1 and @3 — overall and per phase — plus how often the backends agree.

This is a measurement, not a product: the point is to learn what a persona CAN
capture before the app promises realism. Determinism (seeded sampling, recorded
seed) and honest reporting are the bar.

Pipeline:
  1. sample_positions()  — pure: PGN -> stratified, seeded position list.
  2. backends rank each position (lc0 policy nets, Stockfish MultiPV), cached to
     disk per (backend, fen) so a crashed run resumes without recompute.
  3. aggregate_metrics() — pure: rankings -> match@1/@3 tables + agreement.
  4. write HARNESS_RESULTS.md + harness_results.json.

Usage:
    python eval_harness.py --limit 10     # smoke test (10 positions/persona)
    python eval_harness.py                 # full run (~250 positions/persona)
    python eval_harness.py --selftest      # run pure-function unit tests
"""

from __future__ import annotations

import argparse
import io
import itertools
import json
import os
import random
import sys
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import chess
import chess.pgn

# ---------------------------------------------------------------------------
# Paths / config
# ---------------------------------------------------------------------------

REPO = Path(__file__).resolve().parents[2]
DATA_DIR = REPO / "data" / "personas"
SCRATCH = Path(
    "/private/tmp/claude-501/-Users-hjalti-GitHub-chessgui/"
    "dd40f6ca-eb35-4fc7-a3cd-6aacb33ad79b/scratchpad"
)
MAIA_DIR = SCRATCH / "maia"
STRONGNET = SCRATCH / "strongnet" / "BT3-768x15x24h-swa-2790000.pb.gz"
STRONGNET_URL = (
    "https://storage.lczero.org/files/networks-contrib/"
    "BT3-768x15x24h-swa-2790000.pb.gz"
)
STRONGNET_SHA = "e3067757d1fc2dfc66947b21d15ace0cedf4c54254fc1de83d77c378a3e8b8e1"
LC0 = "/opt/homebrew/bin/lc0"
STOCKFISH = "/opt/homebrew/bin/stockfish"

CACHE_DIR = DATA_DIR / "_cache"
SEED = 214214  # recorded for reproducibility

@dataclass(frozen=True)
class PersonaCfg:
    label: str          # row name in the report
    surname: str        # substring matched against PGN White/Black headers
    pgn: Path
    year_range: Optional[Tuple[int, int]] = None  # inclusive Date-year filter


PERSONAS = [
    PersonaCfg("fischer", "fischer", DATA_DIR / "fischer.eval.pgn"),
    PersonaCfg("kasparov", "kasparov", DATA_DIR / "kasparov.eval.pgn"),
    PersonaCfg("sigurjonsson", "sigurjonsson", DATA_DIR / "sigurjonsson.eval.pgn"),
    # Peak persona = the actual product: same held-out eval games, restricted to
    # the empirically chosen 1975-1978 peak window (37 of the 80 eval games; see
    # EXTRACTION.md). Reported as its own row so we can see whether a peak-only
    # slice is more self-consistent than the whole career.
    PersonaCfg("sigurjonsson-peak", "sigurjonsson",
               DATA_DIR / "sigurjonsson.eval.pgn", year_range=(1975, 1978)),
    # Fleet roster (spec 217, 2026-07-15): Spassky/Karpov + Icelandic canon,
    # extracted by extract_roster.py. The matcher is the FULL lowercase DB name,
    # not the bare surname — two Olafssons are in the roster and Icelandic
    # eval games routinely have another roster player as the opponent.
    PersonaCfg("spassky", "spassky, boris", DATA_DIR / "spassky.eval.pgn"),
    PersonaCfg("karpov", "karpov, anatoly", DATA_DIR / "karpov.eval.pgn"),
    PersonaCfg("fridrik-olafsson", "olafsson, fridrik",
               DATA_DIR / "fridrik-olafsson.eval.pgn"),
    PersonaCfg("margeir-petursson", "petursson, margeir",
               DATA_DIR / "margeir-petursson.eval.pgn"),
    PersonaCfg("johann-hjartarson", "hjartarson, johann",
               DATA_DIR / "johann-hjartarson.eval.pgn"),
    PersonaCfg("hannes-stefansson", "stefansson, hannes",
               DATA_DIR / "hannes-stefansson.eval.pgn"),
    PersonaCfg("helgi-olafsson", "olafsson, helgi",
               DATA_DIR / "helgi-olafsson.eval.pgn"),
    PersonaCfg("jon-l-arnason", "arnason, jon l",
               DATA_DIR / "jon-l-arnason.eval.pgn"),
    PersonaCfg("hedinn-steingrimsson", "steingrimsson, hedinn",
               DATA_DIR / "hedinn-steingrimsson.eval.pgn"),
]

PHASES = ("opening", "middlegame", "endgame")
PLY_MIN, PLY_MAX = 10, 60
TARGET_PER_PERSONA = 250

# Backend registry: name -> ("lc0", weights) or ("sf", None)
BACKENDS = [
    ("maia-1900", ("lc0", str(MAIA_DIR / "maia-1900.pb.gz"))),
    ("maia-1500", ("lc0", str(MAIA_DIR / "maia-1500.pb.gz"))),
    ("lc0-bt3", ("lc0", str(STRONGNET))),
    ("stockfish-mpv", ("sf", None)),
]


# ---------------------------------------------------------------------------
# Pure: phase classification & material
# ---------------------------------------------------------------------------

# Non-pawn, non-king piece values (classic 3/3/5/9).
_PIECE_VAL = {chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9}


def non_pawn_material(board: chess.Board, color: chess.Color) -> int:
    """Sum of N/B/R/Q values for `color` (pawns and king excluded)."""
    total = 0
    for pt, val in _PIECE_VAL.items():
        total += len(board.pieces(pt, color)) * val
    return total


def classify_phase(board: chess.Board, ply: int) -> str:
    """Bucket a position into opening / middlegame / endgame.

    Endgame is decided by simplification (both sides' non-pawn material <= 8),
    which can happen at any ply, so it is checked first. Otherwise ply 10-20 is
    opening and the rest of the 10-60 window is middlegame. This is the
    stratification named in the tier-1 brief.
    """
    npm_w = non_pawn_material(board, chess.WHITE)
    npm_b = non_pawn_material(board, chess.BLACK)
    if npm_w <= 8 and npm_b <= 8:
        return "endgame"
    if ply <= 20:
        return "opening"
    return "middlegame"


# ---------------------------------------------------------------------------
# Pure: sampling
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Position:
    persona: str
    fen: str
    actual_uci: str
    phase: str
    ply: int


def _persona_color(game: chess.pgn.Game, surname: str) -> Optional[chess.Color]:
    """Which side the persona played, by surname match in the PGN headers."""
    want = surname.lower()
    white = game.headers.get("White", "").lower()
    black = game.headers.get("Black", "").lower()
    if want in white:
        return chess.WHITE
    if want in black:
        return chess.BLACK
    return None


def _game_year(game: chess.pgn.Game) -> Optional[int]:
    """Parse the 4-digit year from the Date header, or None if unknown."""
    date = game.headers.get("Date", "")
    head = date.split(".")[0]
    return int(head) if head.isdigit() and len(head) == 4 else None


def extract_candidates(pgn_text: str, cfg: "PersonaCfg") -> List[Position]:
    """All persona-to-move positions in plies PLY_MIN..PLY_MAX, deduped by FEN.

    Ply = the half-move number about to be played (1 = White's first move). We
    keep only positions where the persona is on move and the move actually
    played is known (it is the persona's real choice — the label we score
    against). Dedup by FEN keeps positions independent so shared opening lines
    don't overweight the opening bucket.
    """
    out: List[Position] = []
    seen: set[str] = set()
    stream = io.StringIO(pgn_text)
    while True:
        game = chess.pgn.read_game(stream)
        if game is None:
            break
        color = _persona_color(game, cfg.surname)
        if color is None:
            continue
        if cfg.year_range is not None:
            yr = _game_year(game)
            if yr is None or not (cfg.year_range[0] <= yr <= cfg.year_range[1]):
                continue
        board = game.board()
        ply = 1
        for move in game.mainline_moves():
            if PLY_MIN <= ply <= PLY_MAX and board.turn == color:
                fen = board.fen()
                if fen not in seen and move in board.legal_moves:
                    seen.add(fen)
                    out.append(Position(
                        persona=cfg.label,
                        fen=fen,
                        actual_uci=move.uci(),
                        phase=classify_phase(board, ply),
                        ply=ply,
                    ))
            board.push(move)
            ply += 1
    return out


def stratified_sample(candidates: List[Position], target: int,
                      seed: int) -> List[Position]:
    """Seeded, phase-balanced sample of ~`target` positions.

    Aim for an even split across the three phases; where a phase is short of its
    quota, the shortfall is refilled from the leftover pool so the total stays
    near `target`. Deterministic given `seed`.
    """
    rng = random.Random(seed)
    by_phase: Dict[str, List[Position]] = {p: [] for p in PHASES}
    for c in candidates:
        by_phase[c.phase].append(c)
    for p in PHASES:
        by_phase[p].sort(key=lambda c: c.fen)  # stable base order
        rng.shuffle(by_phase[p])

    per_phase = target // len(PHASES)
    chosen: List[Position] = []
    leftovers: List[Position] = []
    for p in PHASES:
        take = by_phase[p][:per_phase]
        chosen.extend(take)
        leftovers.extend(by_phase[p][per_phase:])
    # Refill toward target from the remaining pool.
    rng.shuffle(leftovers)
    need = target - len(chosen)
    if need > 0:
        chosen.extend(leftovers[:need])
    chosen.sort(key=lambda c: (c.phase, c.fen))
    return chosen


# ---------------------------------------------------------------------------
# Pure: metrics
# ---------------------------------------------------------------------------

def move_match(actual: str, ranking: List[str], k: int) -> bool:
    return actual in ranking[:k]


def aggregate_metrics(
    positions: List[Position],
    rankings: Dict[str, Dict[str, List[str]]],
    backends: List[str],
) -> dict:
    """Compute match@1/@3 (overall + per phase) and pairwise top-1 agreement.

    `rankings[backend][fen]` is that backend's ranked move list for the position.
    """
    # match counters: [backend][phase or "overall"] -> [n, hit1, hit3]
    counts: Dict[str, Dict[str, List[int]]] = {
        b: defaultdict(lambda: [0, 0, 0]) for b in backends
    }
    for pos in positions:
        for b in backends:
            rank = rankings.get(b, {}).get(pos.fen, [])
            if not rank:
                continue
            hit1 = 1 if move_match(pos.actual_uci, rank, 1) else 0
            hit3 = 1 if move_match(pos.actual_uci, rank, 3) else 0
            for bucket in ("overall", pos.phase):
                c = counts[b][bucket]
                c[0] += 1
                c[1] += hit1
                c[2] += hit3

    def rate(c: List[int]) -> dict:
        n, h1, h3 = c
        return {
            "n": n,
            "match@1": round(h1 / n, 4) if n else None,
            "match@3": round(h3 / n, 4) if n else None,
        }

    match_table = {
        b: {bucket: rate(counts[b][bucket])
            for bucket in ("overall",) + PHASES if counts[b][bucket][0] > 0}
        for b in backends
    }

    # Pairwise top-1 agreement over positions both backends answered.
    agreement: Dict[str, float] = {}
    for a, b in itertools.combinations(backends, 2):
        same = tot = 0
        for pos in positions:
            ra = rankings.get(a, {}).get(pos.fen, [])
            rb = rankings.get(b, {}).get(pos.fen, [])
            if ra and rb:
                tot += 1
                if ra[0] == rb[0]:
                    same += 1
        if tot:
            agreement[f"{a} vs {b}"] = round(same / tot, 4)
    return {"match": match_table, "top1_agreement": agreement}


# ---------------------------------------------------------------------------
# Caching (resumable)
# ---------------------------------------------------------------------------

class RankCache:
    """Per-backend on-disk cache: fen -> ranked moves. Append-persisted.

    Lets a run resume after a crash without recomputing any position. One JSON
    file per backend under data/personas/_cache/.
    """

    def __init__(self, backend: str):
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        self.path = CACHE_DIR / f"rank_{backend}.json"
        self.backend = backend
        self.data: Dict[str, List[str]] = {}
        if self.path.exists():
            try:
                self.data = json.loads(self.path.read_text())
            except json.JSONDecodeError:
                self.data = {}
        self._dirty = 0

    def get(self, fen: str) -> Optional[List[str]]:
        return self.data.get(fen)

    def put(self, fen: str, ranking: List[str]) -> None:
        self.data[fen] = ranking
        self._dirty += 1
        if self._dirty >= 25:
            self.flush()

    def flush(self) -> None:
        tmp = self.path.with_suffix(".json.part")
        tmp.write_text(json.dumps(self.data))
        tmp.replace(self.path)
        self._dirty = 0


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def build_positions(limit: Optional[int]) -> Dict[str, List[Position]]:
    per_persona: Dict[str, List[Position]] = {}
    for cfg in PERSONAS:
        text = cfg.pgn.read_text()
        cands = extract_candidates(text, cfg)
        target = limit if limit else TARGET_PER_PERSONA
        sample = stratified_sample(cands, target, SEED)
        if limit:
            sample = sample[:limit]
        per_persona[cfg.label] = sample
        phase_counts = Counter(p.phase for p in sample)
        print(f"[{cfg.label}] {len(cands)} candidates -> {len(sample)} sampled "
              f"{dict(phase_counts)}", flush=True)
    return per_persona


def make_backend(spec):
    from engines import Lc0Policy, StockfishMultiPV
    name, (kind, arg) = spec
    if kind == "lc0":
        return Lc0Policy(LC0, arg, name)
    return StockfishMultiPV(STOCKFISH, multipv=3, movetime_ms=150, name=name)


def run_backend(spec, all_positions: List[Position]) -> Dict[str, List[str]]:
    """Rank every position with one backend, resuming from cache."""
    name, _ = spec
    cache = RankCache(name)
    todo = [p for p in all_positions if cache.get(p.fen) is None]
    print(f"[{name}] {len(all_positions)} positions, "
          f"{len(all_positions) - len(todo)} cached, {len(todo)} to run",
          flush=True)
    if not todo:
        return {p.fen: cache.get(p.fen) for p in all_positions}

    engine = make_backend(spec)
    t0 = time.time()
    try:
        for i, pos in enumerate(todo, 1):
            ranking = engine.rank(pos.fen, topk=3)
            cache.put(pos.fen, ranking)
            if i % 50 == 0:
                dt = time.time() - t0
                print(f"[{name}] {i}/{len(todo)}  {dt/i*1000:.0f} ms/pos",
                      flush=True)
    finally:
        cache.flush()
        engine.close()
    print(f"[{name}] done in {time.time() - t0:.1f}s", flush=True)
    return {p.fen: cache.get(p.fen) for p in all_positions}


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------

def build_report(results: dict, per_persona_positions: Dict[str, List[Position]]) -> str:
    lines: List[str] = []
    A = lines.append
    A("# Persona Eval Harness — Results (spec 214, tier-1)\n")
    A(f"_Generated {time.strftime('%Y-%m-%d %H:%M')} · seed {SEED} · "
      f"movetime 150ms (SF) · lc0 `go nodes 1` (policy)._\n")
    A("The Hikaru-bot test made quantitative: on held-out positions from each "
      "player's own EVAL games, how often does a candidate policy play the "
      "human's actual move? `match@1` = exact top move; `match@3` = actual move "
      "in the backend's top 3.\n")

    A("## Backends\n")
    A("| backend | what it is |")
    A("|---|---|")
    A("| `maia-1900` | Maia-1 human-move net, 1900 band (ceiling of Maia) — lc0 policy head |")
    A("| `maia-1500` | Maia-1 human-move net, 1500 band (contrast) — lc0 policy head |")
    A("| `lc0-bt3` | Strong official net BT3-768x15x24h (pure policy, `nodes 1`) |")
    A("| `stockfish-mpv` | Stockfish 18, MultiPV 3 @ 150ms — engine's own ranking |")
    A("")
    A(f"Strong net: `{STRONGNET.name}` (sha256 `{STRONGNET_SHA[:16]}…`, "
      f"[source]({STRONGNET_URL})).\n")

    for persona, positions in per_persona_positions.items():
        m = results[persona]["match"]
        A(f"## {persona.capitalize()}\n")
        n_total = len(positions)
        phase_counts = Counter(p.phase for p in positions)
        A(f"{n_total} sampled positions "
          f"(opening {phase_counts['opening']}, "
          f"middlegame {phase_counts['middlegame']}, "
          f"endgame {phase_counts['endgame']}).\n")

        A("### Overall move-match\n")
        A("| backend | n | match@1 | match@3 |")
        A("|---|--:|--:|--:|")
        for b, _ in BACKENDS:
            o = m.get(b, {}).get("overall")
            if o:
                A(f"| {b} | {o['n']} | {_pct(o['match@1'])} | {_pct(o['match@3'])} |")
        A("")

        A("### Per-phase match@1\n")
        A("| backend | opening | middlegame | endgame |")
        A("|---|--:|--:|--:|")
        for b, _ in BACKENDS:
            cells = []
            for ph in PHASES:
                v = m.get(b, {}).get(ph)
                cells.append(_pct(v["match@1"]) + f" (n={v['n']})" if v else "—")
            A(f"| {b} | {cells[0]} | {cells[1]} | {cells[2]} |")
        A("")

        A("### Per-phase match@3\n")
        A("| backend | opening | middlegame | endgame |")
        A("|---|--:|--:|--:|")
        for b, _ in BACKENDS:
            cells = []
            for ph in PHASES:
                v = m.get(b, {}).get(ph)
                cells.append(_pct(v["match@3"]) + f" (n={v['n']})" if v else "—")
            A(f"| {b} | {cells[0]} | {cells[1]} | {cells[2]} |")
        A("")

        A("### Backend top-1 agreement\n")
        A("| pair | agreement |")
        A("|---|--:|")
        for pair, val in results[persona]["top1_agreement"].items():
            A(f"| {pair} | {_pct(val)} |")
        A("")

    A("## Notes & caveats\n")
    A("- EVAL split only; training games were never sampled. Positions deduped "
      "by FEN so shared opening lines don't overweight the opening bucket.\n")
    A("- Maia nets top out at the 1900 band; both Fischer and Kasparov are far "
      "above that, so Maia move-match is a floor, not a fit — the point of the "
      "contrast is to see how much a *human* policy at its ceiling still "
      "recovers of a 2700+ player's choices.\n")
    A("- `match@1` against a single ground-truth move is inherently low even for "
      "a perfect model: strong positions often have several reasonable moves. "
      "Read `match@3` and cross-backend agreement alongside it.\n")
    A("- Run history: 2026-07-14 initial run (fischer, kasparov, sigurjonsson, "
      "sigurjonsson-peak; 250 pos each). 2026-07-15 fleet run added the spec-217 "
      "roster (spassky, karpov + 7 Icelandic GMs; 250 pos each, same seed/config; "
      "no net substitution — the BT3 net named above was present locally and used "
      "as-is). Sampling is seeded+deterministic and rankings are disk-cached, so "
      "earlier personas' numbers regenerate byte-identically in this report.\n")
    return "\n".join(lines)


def _pct(x: Optional[float]) -> str:
    return "—" if x is None else f"{x*100:.1f}%"


# ---------------------------------------------------------------------------
# Self-test (pure functions)
# ---------------------------------------------------------------------------

def selftest() -> int:
    import unittest
    from engines import parse_lc0_policy, parse_sf_multipv

    class T(unittest.TestCase):
        def test_npm_startpos(self):
            b = chess.Board()
            # 2N+2B+2R+Q = 6+6+10+9 = 31 per side.
            self.assertEqual(non_pawn_material(b, chess.WHITE), 31)
            self.assertEqual(non_pawn_material(b, chess.BLACK), 31)

        def test_phase_opening_vs_middlegame(self):
            b = chess.Board()
            self.assertEqual(classify_phase(b, 12), "opening")
            self.assertEqual(classify_phase(b, 30), "middlegame")

        def test_phase_endgame_by_material(self):
            # K+R vs K+R: npm 5 each -> endgame regardless of ply.
            b = chess.Board("8/8/4k3/8/8/3K4/8/R6r w - - 0 40")
            self.assertEqual(classify_phase(b, 40), "endgame")
            self.assertEqual(classify_phase(b, 15), "endgame")

        def test_parse_lc0_policy(self):
            lines = [
                "info string e2e4  (322 ) N: 0 (P: 50.22%) (Q: 0.04)",
                "info string d2d4  (293 ) N: 0 (P: 23.34%) (Q: 0.04)",
                "info string g1f3  (159 ) N: 0 (P:  4.35%) (Q: 0.04)",
                "info string node  (  20) N: 1 (P:  0.00%) (Q: 0.038)",
                "bestmove e2e4",
            ]
            ranked = parse_lc0_policy(lines)
            self.assertEqual([m for m, _ in ranked], ["e2e4", "d2d4", "g1f3"])
            self.assertAlmostEqual(ranked[0][1], 0.5022, places=4)

        def test_parse_sf_multipv(self):
            lines = [
                "info depth 10 multipv 1 score cp 30 pv e2e4 e7e5",
                "info depth 10 multipv 2 score cp 20 pv d2d4 d7d5",
                "info depth 10 multipv 3 score cp 10 pv g1f3 g8f6",
                "info depth 12 multipv 1 score cp 33 pv e2e4 c7c5",  # deeper wins
                "bestmove e2e4",
            ]
            self.assertEqual(parse_sf_multipv(lines), ["e2e4", "d2d4", "g1f3"])

        def test_move_match(self):
            self.assertTrue(move_match("e2e4", ["e2e4", "d2d4"], 1))
            self.assertFalse(move_match("d2d4", ["e2e4", "d2d4", "c2c4"], 1))
            self.assertTrue(move_match("d2d4", ["e2e4", "d2d4", "c2c4"], 3))

        def test_stratified_sample_deterministic(self):
            cands = []
            board = chess.Board()
            # Fabricate distinct positions across phases.
            for i in range(60):
                phase = PHASES[i % 3]
                cands.append(Position("x", f"fen{i}", "e2e4", phase, 15))
            a = stratified_sample(cands, 30, 123)
            b = stratified_sample(cands, 30, 123)
            c = stratified_sample(cands, 30, 999)
            self.assertEqual([p.fen for p in a], [p.fen for p in b])
            self.assertNotEqual([p.fen for p in a], [p.fen for p in c])
            self.assertEqual(len(a), 30)

        def test_aggregate_metrics(self):
            positions = [
                Position("x", "f1", "e2e4", "opening", 10),
                Position("x", "f2", "d2d4", "middlegame", 30),
            ]
            rankings = {
                "A": {"f1": ["e2e4", "a1a2", "b1b2"], "f2": ["a1a2", "d2d4", "c1c2"]},
                "B": {"f1": ["a1a2", "e2e4", "z"], "f2": ["a1a2", "b1b2", "c1c2"]},
            }
            res = aggregate_metrics(positions, rankings, ["A", "B"])
            self.assertEqual(res["match"]["A"]["overall"]["match@1"], 0.5)  # f1 hit
            self.assertEqual(res["match"]["A"]["overall"]["match@3"], 1.0)  # both in top3
            self.assertEqual(res["match"]["B"]["overall"]["match@1"], 0.0)
            # f1 tops differ (e2e4 vs a1a2), f2 tops match (a1a2) -> 0.5.
            self.assertEqual(res["top1_agreement"]["A vs B"], 0.5)

    suite = unittest.TestLoader().loadTestsFromTestCase(T)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if result.wasSuccessful() else 1


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None,
                    help="positions per persona (smoke test)")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()

    if args.selftest:
        return selftest()

    if not STRONGNET.exists():
        print(f"FATAL: strong net missing at {STRONGNET}", file=sys.stderr)
        return 2

    per_persona = build_positions(args.limit)
    all_positions = [p for ps in per_persona.values() for p in ps]
    # Dedup FENs across personas for engine calls (rankings are position-only).
    unique = {p.fen: p for p in all_positions}
    unique_positions = list(unique.values())

    rankings: Dict[str, Dict[str, List[str]]] = {}
    for spec in BACKENDS:
        rankings[spec[0]] = run_backend(spec, unique_positions)

    backend_names = [b for b, _ in BACKENDS]
    results = {}
    for persona, positions in per_persona.items():
        results[persona] = aggregate_metrics(positions, rankings, backend_names)

    # Write JSON (metrics + provenance) and Markdown.
    out_json = {
        "seed": SEED,
        "generated": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "config": {
            "ply_range": [PLY_MIN, PLY_MAX],
            "target_per_persona": args.limit or TARGET_PER_PERSONA,
            "strong_net": {"file": STRONGNET.name, "sha256": STRONGNET_SHA,
                           "url": STRONGNET_URL},
            "stockfish": {"multipv": 3, "movetime_ms": 150},
        },
        "sample_sizes": {
            persona: dict(Counter(p.phase for p in ps))
            for persona, ps in per_persona.items()
        },
        "results": results,
    }
    (DATA_DIR / "harness_results.json").write_text(json.dumps(out_json, indent=2))
    (DATA_DIR / "HARNESS_RESULTS.md").write_text(
        build_report(results, per_persona))
    print(f"\nWrote {DATA_DIR/'HARNESS_RESULTS.md'} and "
          f"{DATA_DIR/'harness_results.json'}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
