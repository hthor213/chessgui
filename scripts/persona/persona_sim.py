#!/usr/bin/env python3
"""Pure-Python port of the persona engine's move-selection math (spec 214).

The metrics harness must EVALUATE THE SAME SEMANTICS it tunes, so this module
ports src-tauri/src/persona.rs precisely:

  * select_candidates  — policy floor (0.01) -> sort by prob desc -> top-p
                         nucleus or top-k cap (default 4).
  * reweight           — softmax over (alpha*ln(policy) - lambda*penalty) / T,
                         max-subtracted, degenerate -> uniform.
  * effective_temperature — base x phase multiplier x clock multiplier,
                         clamped to [0.05, 3.0]; no schedule -> flat base.
  * phase_weight / phase_for — calibration.rs formula (minor 1, rook 2,
                         queen 4, both sides); endgame <= 8; opening ply < 16.
  * derive_seed / uniform_from_seed — splitmix64 seeding (contract step 8).
  * penalties          — pawns behind the best CANDIDATE: max(0, (best-cp)/100).
  * endgame arm priors — Maia policy prob floored at 0.01 for every SF
                         candidate (seen or unseen).
  * style bias        — post-book style-prior window (StyleBias): for
                         window_plies after book exit, candidates in any of
                         the persona's move classes (capture | check | castle
                         | pawn_push | quiet_piece) get their policy prior
                         multiplied before the reweight. OFF by default
                         (spec 214 hard rule); tune_persona.py measures it.
  * error model       — contract step 5 (ErrorModel): the fitted corpus
                         P(mistake | eval, phase, clock, band) reassigns the
                         final sampling weights' MASS between the mistake
                         branch (candidates >= 1.0 pawn behind the best) and
                         the sound branch, keeping the human distribution
                         within each branch. OFF by default (same hard rule);
                         tune_persona.py --error-model measures it.

Documented, unavoidable divergences from the Rust runtime (kept in one place
so every consumer states the same caveats):

  * SF eval source: the harness uses the local Stockfish binary at a fixed
    depth — same resolution path (/opt/homebrew/bin/stockfish) and the same
    fixed-depth discipline as persona.rs, but evals are only reproducible per
    Stockfish build.
  * GM personas' policy backend is BT3 via lc0 `go nodes 1` (their configs
    declare `lc0-policy`); persona-engine v1 can only run Maia bands, so for
    2400+ personas the harness evaluates the declared/intended backend, not
    what v1 would play today.
  * Unclocked: the harness has no clock, so the clock multiplier is 1
    (identical to the spar loop today; the match runner is clocked).
  * float math: Python and Rust both use IEEE-754 doubles; ln/exp may differ
    in the last ulp. Irrelevant at metric scale.

Everything here is pure and unit-tested (`--selftest`).
"""

from __future__ import annotations

import math
from typing import Dict, List, Optional, Sequence, Tuple

import chess

# Constants mirrored from persona.rs (names kept identical where possible).
POLICY_FLOOR = 0.01
DEFAULT_TOP_K = 4
MATE_CP = 100_000
MIN_EFFECTIVE_TEMP = 0.05
MAX_EFFECTIVE_TEMP = 3.0
ENDGAME_PHASE_MAX = 8
OPENING_MAX_PLY = 16
ENDGAME_UNSEEN_PRIOR = POLICY_FLOOR

# TemperatureSchedule::default() in persona.rs.
DEFAULT_SCHEDULE = {
    "opening_mult": 0.6,
    "middlegame_mult": 1.0,
    "endgame_mult": 0.8,
    "low_time_ms": 30_000,
    "low_time_mult": 1.5,
    "panic_time_ms": 10_000,
    "panic_mult": 2.25,
}

_U64 = (1 << 64) - 1


# ---------------------------------------------------------------------------
# Seeded RNG (contract step 8) — splitmix64, bit-identical to persona.rs
# ---------------------------------------------------------------------------

def splitmix64(z: int) -> int:
    z &= _U64
    z = ((z ^ (z >> 30)) * 0xBF58_476D_1CE4_E5B9) & _U64
    z = ((z ^ (z >> 27)) * 0x94D0_49BB_1331_11EB) & _U64
    return (z ^ (z >> 31)) & _U64


def derive_seed(seed: int, ply: int) -> int:
    """Per-move seed: mix the game seed with the ply, one splitmix64 round."""
    return splitmix64((seed ^ ((ply * 0x9E37_79B9_7F4A_7C15) & _U64)) & _U64)


def uniform_from_seed(derived: int) -> float:
    """A uniform draw in [0, 1): top 53 bits of one more splitmix64 step."""
    z = splitmix64((derived + 0x9E37_79B9_7F4A_7C15) & _U64)
    return (z >> 11) / float(1 << 53)


# ---------------------------------------------------------------------------
# Phase detection (persona.rs phase_weight_of / phase_for)
# ---------------------------------------------------------------------------

def phase_weight(board: chess.Board) -> int:
    """Non-pawn phase weight: knights+bishops x1, rooks x2, queens x4, both
    sides (24 at the standard start). NOTE: this is persona.rs / calibration.rs
    semantics, NOT eval_harness.classify_phase (which uses 3/3/5/9 per side and
    ply<=20) — the harness's stratification labels are for sampling only; the
    SIMULATED phase must use the engine's own formula."""
    return (
        len(board.pieces(chess.KNIGHT, chess.WHITE))
        + len(board.pieces(chess.KNIGHT, chess.BLACK))
        + len(board.pieces(chess.BISHOP, chess.WHITE))
        + len(board.pieces(chess.BISHOP, chess.BLACK))
        + 2 * (len(board.pieces(chess.ROOK, chess.WHITE))
               + len(board.pieces(chess.ROOK, chess.BLACK)))
        + 4 * (len(board.pieces(chess.QUEEN, chess.WHITE))
               + len(board.pieces(chess.QUEEN, chess.BLACK)))
    )


def phase_for(pw: int, ply: int) -> str:
    """persona.rs phase_for: endgame wins over the ply test."""
    if pw <= ENDGAME_PHASE_MAX:
        return "endgame"
    if ply < OPENING_MAX_PLY:
        return "opening"
    return "middlegame"


# ---------------------------------------------------------------------------
# Temperature schedule (contract step 3)
# ---------------------------------------------------------------------------

def effective_temperature(base: float, schedule: Optional[dict], phase: str,
                          clock_ms: Optional[int] = None) -> float:
    """base x phase mult x clock mult, clamped. No schedule -> flat base
    (persona engine v1 behavior, and the config default today)."""
    if schedule is None:
        return base
    mult = {
        "opening": schedule["opening_mult"],
        "middlegame": schedule["middlegame_mult"],
        "endgame": schedule["endgame_mult"],
    }[phase]
    clock_mult = 1.0
    if clock_ms is not None:
        if clock_ms <= schedule["panic_time_ms"]:
            clock_mult = schedule["panic_mult"]
        elif clock_ms <= schedule["low_time_ms"]:
            clock_mult = schedule["low_time_mult"]
    t = base * mult * clock_mult
    return min(max(t, MIN_EFFECTIVE_TEMP), MAX_EFFECTIVE_TEMP)


# ---------------------------------------------------------------------------
# Candidate selection + reweight (contract steps 3, 4)
# ---------------------------------------------------------------------------

def select_candidates(moves: Sequence[Tuple[str, float]], floor: float,
                      top_k: Optional[int] = None,
                      top_p: Optional[float] = None) -> List[Tuple[str, float]]:
    """persona.rs select_candidates: floor-trim (fall back to all when it
    empties the set), stable sort by prob desc, nucleus or count cap."""
    if not moves:
        return []
    kept = [m for m in moves if m[1] >= floor]
    if not kept:
        kept = list(moves)
    kept.sort(key=lambda m: -m[1])  # stable, like Rust's sort_by
    if top_p is not None:
        total = max(sum(max(p, 0.0) for _, p in kept), 1e-12)
        target = min(max(top_p, 0.0), 1.0) * total
        acc, n = 0.0, 0
        for _, p in kept:
            acc += max(p, 0.0)
            n += 1
            if acc >= target:
                break
        return kept[:max(n, 1)]
    k = top_k if top_k is not None else DEFAULT_TOP_K
    return kept[:max(k, 1)]


def penalties_from_cp(values: Sequence[int]) -> List[float]:
    """Pawns behind the best CANDIDATE (persona.rs: best = max over the
    candidate evals, penalty = max(0, (best - cp)/100))."""
    if not values:
        return []
    best = max(values)
    return [max((best - v) / 100.0, 0.0) for v in values]


def reweight(policy: Sequence[float], penalties: Sequence[float], alpha: float,
             lam: float, temperature: float) -> List[float]:
    """persona.rs reweight_and_sample's weight computation (softmax over
    (alpha*ln(max(p,1e-12)) - lambda*penalty)/max(T,1e-6), max-subtracted;
    degenerate -> uniform). Returns the normalized sampling weights."""
    n = len(policy)
    assert n == len(penalties)
    if n == 0:
        return []
    t = max(temperature, 1e-6)
    logits = [(alpha * math.log(max(policy[i], 1e-12)) - lam * penalties[i]) / t
              for i in range(n)]
    maxl = max(logits)
    exps = [math.exp(l - maxl) for l in logits]
    total = sum(exps)
    if total > 0.0 and math.isfinite(total):
        return [e / total for e in exps]
    return [1.0 / n] * n


def sample_index(weights: Sequence[float], u: float) -> int:
    """Inverse-CDF sample, persona.rs style (u clamped to [0,1])."""
    target = min(max(u, 0.0), 1.0)
    acc = 0.0
    for i, w in enumerate(weights):
        acc += w
        if target < acc:
            return i
    return len(weights) - 1


# ---------------------------------------------------------------------------
# Style bias (contract step 3, persona.rs StyleBias) — the v1 style prior
# ---------------------------------------------------------------------------

# The v1 move classes (persona.rs move_matches_types). A move may fall in
# several classes ("check" is not exclusive of the others).
STYLE_MOVE_TYPES = ("capture", "check", "castle", "pawn_push", "quiet_piece")


def move_classes(board: chess.Board, uci: str) -> Tuple[str, ...]:
    """The v1 classes `uci` falls in, persona.rs semantics. Unparseable or
    illegal candidates get no classes (they'd never match in Rust either)."""
    try:
        mv = chess.Move.from_uci(uci)
    except ValueError:
        return ()
    if mv not in board.legal_moves:
        return ()
    capture = board.is_capture(mv)   # includes en passant, like shakmaty
    castle = board.is_castling(mv)
    pawn = board.piece_type_at(mv.from_square) == chess.PAWN
    out = []
    if capture:
        out.append("capture")
    if board.gives_check(mv):
        out.append("check")
    if castle:
        out.append("castle")
    if pawn and not capture:
        out.append("pawn_push")
    if not pawn and not capture and not castle:
        out.append("quiet_piece")
    return tuple(out)


def style_bias_active(bias: Optional[dict],
                      plies_since_book_exit: Optional[int]) -> bool:
    """persona.rs style_bias_active: live while plies_since_book_exit <
    window_plies; a no-op bias (mult 1.0 or no move types) is never live."""
    if bias is None or plies_since_book_exit is None:
        return False
    return (plies_since_book_exit < bias["window_plies"]
            and bias["multiplier"] != 1.0
            and bool(bias["move_types"]))


def apply_style_bias(cand_classes: Sequence[Sequence[str]],
                     priors: Sequence[float],
                     bias: dict) -> Tuple[List[float], bool]:
    """persona.rs apply_style_bias over precomputed classes: multiply matching
    candidates' priors (multiplier clamped at 0, like Rust); returns the new
    priors and whether any candidate matched (the decision log's
    `style_bias_applied`). The softmax downstream normalizes."""
    mult = max(bias["multiplier"], 0.0)
    want = set(bias["move_types"])
    out: List[float] = []
    applied = False
    for classes, p in zip(cand_classes, priors):
        if want.intersection(classes):
            out.append(p * mult)
            applied = True
        else:
            out.append(p)
    return out, applied


def endgame_priors(policy: Dict[str, float], ucis: Sequence[str]) -> List[float]:
    """Endgame-arm priors (persona.rs): each SF candidate's prior is its Maia
    policy prob floored at ENDGAME_UNSEEN_PRIOR — floored whether seen or not."""
    return [max(policy.get(u, ENDGAME_UNSEEN_PRIOR), ENDGAME_UNSEEN_PRIOR)
            for u in ucis]


# ---------------------------------------------------------------------------
# Error model (contract step 5, persona.rs ErrorModel) — gated via the tuner
# ---------------------------------------------------------------------------

# Defaults mirrored from persona.rs ErrorModel / scripts/mining/error_model.py.
ERROR_MISTAKE_DROP_CP = 100
ERROR_EVAL_BUCKET_CP = 50
ERROR_EVAL_CLAMP_CP = 500

# Clock buckets in remaining SECONDS (error_model.py CLOCK_BUCKETS).
ERROR_CLOCK_BUCKETS = ((600, "600plus"), (300, "300-600"), (120, "120-300"),
                       (60, "60-120"), (30, "30-60"), (0, "lt30"))


def eval_bucket_label(cp: int, bucket_cp: int = ERROR_EVAL_BUCKET_CP,
                      clamp_cp: int = ERROR_EVAL_CLAMP_CP) -> str:
    """Mover-POV cp -> '+0.0'-style lower-edge label (error_model.py
    eval_bucket, persona.rs ErrorModel::eval_bucket_label)."""
    cp = max(-clamp_cp, min(clamp_cp - 1, cp))
    lower = (cp // bucket_cp) * bucket_cp  # floor division, like div_euclid
    return f"{lower / 100:+.1f}"


def clock_bucket_label(clock_ms: Optional[int]) -> str:
    """Remaining clock (ms; None = unclocked) -> corpus clock-bucket label.
    The corpus 'none' bucket (games without [%clk]) doubles as the unclocked
    spar loop's bucket — honest: both mean 'no clock signal'."""
    if clock_ms is None:
        return "none"
    seconds = clock_ms // 1000
    for lo, label in ERROR_CLOCK_BUCKETS:
        if seconds >= lo:
            return label
    return "lt30"


def mistake_rate(em: dict, phase: str, eval_before_cp: int,
                 clock_ms: Optional[int] = None) -> Optional[float]:
    """persona.rs ErrorModel::mistake_rate: fitted cell lookup x rate_scale,
    clamped to [0, 1]. None when the cell is missing (no data -> the model
    stays silent rather than inventing a rate)."""
    key = "|".join((phase,
                    eval_bucket_label(eval_before_cp,
                                      em.get("eval_bucket_cp",
                                             ERROR_EVAL_BUCKET_CP),
                                      em.get("eval_clamp_cp",
                                             ERROR_EVAL_CLAMP_CP)),
                    clock_bucket_label(clock_ms)))
    rate = em.get("cells", {}).get(key)
    if rate is None:
        return None
    return min(max(rate * em.get("rate_scale", 1.0), 0.0), 1.0)


def apply_error_model(weights: Sequence[float], penalties: Sequence[float],
                      rate: float, drop_pawns: float) -> Tuple[List[float], bool]:
    """persona.rs apply_error_model_mix: split the normalized sampling weights
    into the mistake branch (candidates >= drop_pawns behind the best) and the
    sound branch, then reassign branch MASS to (rate, 1 - rate) while keeping
    the within-branch human distribution. The model conditions WHEN a mistake
    happens, never WHICH random move gets played (spec 214 hard rule). Returns
    (weights, applied); untouched/False when either branch is empty or
    weightless — nothing to time."""
    if rate <= 0.0:
        return list(weights), False
    rate = min(rate, 1.0)
    mis = sum(w for w, p in zip(weights, penalties) if p >= drop_pawns)
    ok = sum(w for w, p in zip(weights, penalties) if p < drop_pawns)
    if mis <= 0.0 or ok <= 0.0:
        return list(weights), False
    return ([w * (rate / mis if p >= drop_pawns else (1.0 - rate) / ok)
             for w, p in zip(weights, penalties)], True)


# ---------------------------------------------------------------------------
# Self-test — fixtures mirror persona.rs's unit tests where they exist
# ---------------------------------------------------------------------------

def selftest() -> int:
    import unittest

    class T(unittest.TestCase):
        def test_derive_seed_deterministic_and_ply_dependent(self):
            self.assertEqual(derive_seed(214215, 7), derive_seed(214215, 7))
            us = [uniform_from_seed(derive_seed(214215, p)) for p in range(64)]
            self.assertTrue(all(0.0 <= u < 1.0 for u in us))
            self.assertTrue(any(abs(a - b) > 1e-9 for a, b in zip(us, us[1:])))
            self.assertNotEqual(derive_seed(214215, 7), derive_seed(999, 7))

        def test_select_candidates_topk(self):
            moves = [("e2e4", 0.40), ("d2d4", 0.30), ("g1f3", 0.15),
                     ("c2c4", 0.10), ("b1a3", 0.005)]
            got = select_candidates(moves, 0.01, top_k=3)
            self.assertEqual([m for m, _ in got], ["e2e4", "d2d4", "g1f3"])

        def test_select_candidates_top_p_nucleus(self):
            moves = [("e2e4", 0.50), ("d2d4", 0.30), ("g1f3", 0.15),
                     ("c2c4", 0.05)]
            got = select_candidates(moves, 0.0, top_p=0.75)
            self.assertEqual([m for m, _ in got], ["e2e4", "d2d4"])

        def test_select_candidates_floor_fallback(self):
            got = select_candidates([("e2e4", 0.006), ("d2d4", 0.004)], 0.5,
                                    top_k=4)
            self.assertEqual(len(got), 2)

        def test_reweight_pure_policy_matches_tempered_softmax(self):
            w = reweight([0.5, 0.3, 0.2], [0.0] * 3, 1.0, 0.0, 1.0)
            self.assertAlmostEqual(sum(w), 1.0, places=9)
            for got, want in zip(w, [0.5, 0.3, 0.2]):
                self.assertAlmostEqual(got, want, places=9)

        def test_reweight_suppresses_policy_favored_blunder(self):
            w = reweight([0.70, 0.20, 0.10], [9.0, 0.0, 0.0], 1.0, 1.5, 0.5)
            self.assertLess(w[0], 1e-3)
            self.assertGreater(w[1], w[2])

        def test_reweight_low_temperature_sharpens(self):
            w = reweight([0.45, 0.40, 0.15], [0.6, 0.0, 0.0], 1.0, 2.0, 0.05)
            self.assertGreater(max(w), 0.95)
            self.assertEqual(w.index(max(w)), 1)

        def test_effective_temperature(self):
            s = dict(DEFAULT_SCHEDULE)
            self.assertEqual(effective_temperature(0.5, None, "middlegame"), 0.5)
            self.assertEqual(effective_temperature(0.5, s, "opening"), 0.5 * 0.6)
            self.assertEqual(effective_temperature(0.5, s, "endgame"), 0.5 * 0.8)
            self.assertEqual(
                effective_temperature(0.5, s, "middlegame", 29_000), 0.5 * 1.5)
            self.assertEqual(
                effective_temperature(0.5, s, "middlegame", 9_000), 0.5 * 2.25)
            self.assertEqual(
                effective_temperature(0.5, s, "middlegame", 120_000), 0.5)
            self.assertEqual(effective_temperature(0.01, s, "opening"), 0.05)
            self.assertEqual(
                effective_temperature(2.0, s, "middlegame", 1_000), 3.0)

        def test_phase_weight_and_phase_for(self):
            self.assertEqual(phase_weight(chess.Board()), 24)
            b = chess.Board("8/5pk1/6p1/8/8/1r3P2/R5PP/6K1 w - - 0 40")
            self.assertEqual(phase_weight(b), 4)
            self.assertEqual(phase_for(24, 0), "opening")
            self.assertEqual(phase_for(24, 15), "opening")
            self.assertEqual(phase_for(24, 16), "middlegame")
            self.assertEqual(phase_for(8, 10), "endgame")
            self.assertEqual(phase_for(0, 90), "endgame")
            self.assertEqual(phase_for(9, 40), "middlegame")

        def test_penalties_from_cp(self):
            self.assertEqual(penalties_from_cp([30, -20, 30]), [0.0, 0.5, 0.0])
            self.assertEqual(penalties_from_cp([]), [])

        def test_endgame_priors_floored(self):
            pol = {"a1a2": 0.5, "b1b2": 0.001}
            self.assertEqual(endgame_priors(pol, ["a1a2", "b1b2", "c1c2"]),
                             [0.5, 0.01, 0.01])

        def test_move_classification_covers_the_v1_types(self):
            # Mirrors persona.rs move_classification_covers_the_v1_types.
            b = chess.Board()
            b.push_san("Nf3")
            b.push_san("e5")   # 1.Nf3 e5?? — Nxe5 is a real capture
            self.assertIn("capture", move_classes(b, "f3e5"))
            self.assertNotIn("pawn_push", move_classes(b, "f3e5"))
            self.assertIn("pawn_push", move_classes(b, "d2d4"))
            self.assertIn("quiet_piece", move_classes(b, "b1c3"))
            self.assertEqual(move_classes(b, "not-a-move"), ())
            self.assertEqual(move_classes(b, "e5e6"), ())  # illegal (wrong side)
            castle = chess.Board(
                "r3k2r/pppq1ppp/2n2n2/3pp3/3PP3/2N2N2/PPPQ1PPP/R3K2R w KQkq - 0 8")
            self.assertIn("castle", move_classes(castle, "e1g1"))
            check = chess.Board(
                "rnbqkbnr/ppppp1pp/8/5p2/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2")
            self.assertIn("check", move_classes(check, "d1h5"))
            self.assertIn("quiet_piece", move_classes(check, "d1h5"))

        def test_style_bias_window_gates_correctly(self):
            # Mirrors persona.rs style_bias_window_gates_correctly.
            b = {"window_plies": 4, "multiplier": 1.5,
                 "move_types": ["capture"]}
            self.assertTrue(style_bias_active(b, 0))
            self.assertTrue(style_bias_active(b, 3))
            self.assertFalse(style_bias_active(b, 4))
            self.assertFalse(style_bias_active(b, None))
            self.assertFalse(style_bias_active(None, 0))
            self.assertFalse(style_bias_active(
                {"window_plies": 4, "multiplier": 1.0,
                 "move_types": ["capture"]}, 0))
            self.assertFalse(style_bias_active(
                {"window_plies": 4, "multiplier": 1.5, "move_types": []}, 0))

        def test_apply_style_bias_overweights_matching_candidates_only(self):
            bias = {"window_plies": 4, "multiplier": 2.0,
                    "move_types": ["pawn_push"]}
            got, any_ = apply_style_bias(
                [("pawn_push",), ("quiet_piece",)], [0.4, 0.6], bias)
            self.assertTrue(any_)
            self.assertEqual(got, [0.8, 0.6])
            got2, any2 = apply_style_bias(
                [("quiet_piece",), ("capture", "check")], [0.4, 0.6], bias)
            self.assertFalse(any2)
            self.assertEqual(got2, [0.4, 0.6])
            # Negative multipliers clamp at 0, like Rust's .max(0.0).
            got3, _ = apply_style_bias(
                [("pawn_push",)], [0.4],
                {"window_plies": 4, "multiplier": -1.0,
                 "move_types": ["pawn_push"]})
            self.assertEqual(got3, [0.0])

        def test_sample_index_inverse_cdf(self):
            w = [0.5, 0.3, 0.2]
            self.assertEqual(sample_index(w, 0.0), 0)
            self.assertEqual(sample_index(w, 0.49), 0)
            self.assertEqual(sample_index(w, 0.6), 1)
            self.assertEqual(sample_index(w, 0.999), 2)

        def test_error_bucket_labels_match_the_corpus_convention(self):
            # Mirrors scripts/mining/error_model.py eval_bucket/clock_bucket
            # and persona.rs ErrorModel labels.
            self.assertEqual(eval_bucket_label(0), "+0.0")
            self.assertEqual(eval_bucket_label(49), "+0.0")
            self.assertEqual(eval_bucket_label(50), "+0.5")
            self.assertEqual(eval_bucket_label(-1), "-0.5")   # floor, not trunc
            self.assertEqual(eval_bucket_label(-500), "-5.0")
            self.assertEqual(eval_bucket_label(-9999), "-5.0")  # clamp low
            self.assertEqual(eval_bucket_label(9999), "+4.5")   # clamp high
            self.assertEqual(clock_bucket_label(None), "none")
            self.assertEqual(clock_bucket_label(600_000), "600plus")
            self.assertEqual(clock_bucket_label(599_000), "300-600")
            self.assertEqual(clock_bucket_label(29_000), "lt30")
            self.assertEqual(clock_bucket_label(0), "lt30")

        def test_mistake_rate_lookup_scale_and_clamp(self):
            em = {"cells": {"middlegame|+0.0|none": 0.05},
                  "rate_scale": 2.0}
            self.assertAlmostEqual(mistake_rate(em, "middlegame", 10), 0.10)
            # Missing cell -> None (the model stays silent, never invents).
            self.assertIsNone(mistake_rate(em, "endgame", 10))
            self.assertIsNone(mistake_rate(em, "middlegame", 10, 5_000))
            # Scale can never push the rate past 1.
            em30 = {"cells": {"middlegame|+0.0|none": 0.9}, "rate_scale": 30.0}
            self.assertEqual(mistake_rate(em30, "middlegame", 10), 1.0)

        def test_apply_error_model_reassigns_branch_mass(self):
            # Candidate 2 is the only mistake (>= 1.0 pawn behind): rate 0.3
            # puts exactly 0.3 there; the sound branch keeps its shape.
            w, applied = apply_error_model([0.7, 0.2, 0.1], [0.0, 0.0, 2.0],
                                           0.3, 1.0)
            self.assertTrue(applied)
            self.assertAlmostEqual(w[2], 0.3)
            self.assertAlmostEqual(w[0], 0.7 * 0.7 / 0.9)
            self.assertAlmostEqual(w[1], 0.2 * 0.7 / 0.9)
            self.assertAlmostEqual(sum(w), 1.0)

        def test_apply_error_model_needs_both_branches(self):
            # No mistake candidate / only mistake candidates / zero rate:
            # weights untouched, applied False.
            base = [0.6, 0.4]
            self.assertEqual(apply_error_model(base, [0.0, 0.5], 0.3, 1.0),
                             (base, False))
            self.assertEqual(apply_error_model(base, [1.5, 2.5], 0.3, 1.0),
                             (base, False))
            self.assertEqual(apply_error_model(base, [0.0, 2.5], 0.0, 1.0),
                             (base, False))

    suite = unittest.TestLoader().loadTestsFromTestCase(T)
    res = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if res.wasSuccessful() else 1


if __name__ == "__main__":
    import sys
    sys.exit(selftest())
