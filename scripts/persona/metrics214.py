#!/usr/bin/env python3
"""Human-likeness metrics for spec 214 ("Human-likeness metrics & acceptance").

Pure functions only — the tuner feeds them cached engine numbers. Definitions
implemented (all on held-out splits):

  * move-match@1/@3 — two readings for a STOCHASTIC policy:
      - argmax: actual move is the top-weight candidate (@1) or in the top 3
        by final sampling weight (@3). Temperature-INVARIANT (softmax is
        monotonic in the logits), so it identifies alpha/lambda only.
      - expected match@1: the probability mass the sampler puts on the actual
        move (0 when the move isn't in the candidate set). Temperature-
        sensitive; reported, and NLL (below) is used to fit temperature.
  * NLL — mean negative log-likelihood of the actual move under the sampled
    distribution (floored at MISS_PROB for moves outside the candidate set).
    A proper scoring rule: minimized by matching the human distribution, so
    it does NOT collapse temperature to zero the way expected-match@1 would.
  * ACPL-profile similarity — per-phase mean centipawn loss (capped at
    CPL_CAP), persona vs real, on the SAME positions (teacher-forced: the
    persona is asked "what would you play here", not free-rolled). Shape
    similarity = 1 - total-variation distance between the profiles normalized
    to sum 1.
  * error-timing similarity — where mistakes (cpl >= MISTAKE_CP) fall along
    the game, as a distribution over ply bins; persona mass is the EXPECTED
    mistake mass (sum of candidate weights on mistake moves). Similarity =
    1 - TV distance.
  * opening KL — KL(real || persona) of per-position move distributions over
    the first K plies, visit-weighted; persona distribution comes from the
    book while in book, else from the reweighted policy. Persona probs are
    floored at KL_EPS and renormalized over the union support so a real move
    the persona never plays costs ln(p/eps), not infinity.
"""

from __future__ import annotations

import math
from collections import defaultdict
from typing import Dict, List, Optional, Sequence, Tuple

CPL_CAP = 1000        # cap a single move's centipawn loss (standard ACPL cap)
MISTAKE_CP = 100      # cpl at/above this counts as a mistake
MISS_PROB = 1e-3      # likelihood floor when the actual move isn't a candidate
KL_EPS = 1e-4         # persona-prob floor in the opening KL
PLY_BINS = ((10, 19), (20, 29), (30, 39), (40, 49), (50, 60))
PHASES = ("opening", "middlegame", "endgame")


def ply_bin(ply: int) -> str:
    for lo, hi in PLY_BINS:
        if lo <= ply <= hi:
            return f"{lo}-{hi}"
    return "other"


def cpl(best_cp: int, move_cp: int, cap: int = CPL_CAP) -> int:
    """Centipawn loss of a move vs the best evaluated move, clamped to
    [0, cap]."""
    return min(max(best_cp - move_cp, 0), cap)


# ---------------------------------------------------------------------------
# Move-match on a weighted candidate set
# ---------------------------------------------------------------------------

def weight_ranking(ucis: Sequence[str], weights: Sequence[float]) -> List[str]:
    """Candidates ordered by final sampling weight, descending, stable."""
    order = sorted(range(len(ucis)), key=lambda i: -weights[i])
    return [ucis[i] for i in order]

def match_at(ucis: Sequence[str], weights: Sequence[float], actual: str,
             k: int) -> bool:
    return actual in weight_ranking(ucis, weights)[:k]

def expected_match1(ucis: Sequence[str], weights: Sequence[float],
                    actual: str) -> float:
    for u, w in zip(ucis, weights):
        if u == actual:
            return w
    return 0.0

def nll(ucis: Sequence[str], weights: Sequence[float], actual: str) -> float:
    return -math.log(max(expected_match1(ucis, weights, actual), MISS_PROB))


# ---------------------------------------------------------------------------
# Distribution similarity helpers
# ---------------------------------------------------------------------------

def _normalize(d: Dict[str, float]) -> Optional[Dict[str, float]]:
    total = sum(d.values())
    if total <= 0:
        return None
    return {k: v / total for k, v in d.items()}

def tv_similarity(p: Dict[str, float], q: Dict[str, float]) -> Optional[float]:
    """1 - total-variation distance between two (unnormalized, nonnegative)
    distributions over the same key space. None when either side is empty."""
    pn, qn = _normalize(p), _normalize(q)
    if pn is None or qn is None:
        return None
    keys = set(pn) | set(qn)
    return 1.0 - 0.5 * sum(abs(pn.get(k, 0.0) - qn.get(k, 0.0)) for k in keys)


# ---------------------------------------------------------------------------
# ACPL profile + error timing over per-position records
# ---------------------------------------------------------------------------

def acpl_profiles(rows: Sequence[dict]) -> dict:
    """rows: {phase, ply, cpl_actual, cand_cpls: [int], weights: [float]}.
    Returns per-phase real/persona ACPL, shape similarity, and error-timing
    distributions + similarity (see module docstring for definitions)."""
    real_sum: Dict[str, float] = defaultdict(float)
    real_n: Dict[str, int] = defaultdict(int)
    sim_sum: Dict[str, float] = defaultdict(float)
    sim_n: Dict[str, int] = defaultdict(int)
    real_mist: Dict[str, float] = defaultdict(float)
    sim_mist: Dict[str, float] = defaultdict(float)
    real_mist_phase: Dict[str, float] = defaultdict(float)
    sim_mist_phase: Dict[str, float] = defaultdict(float)

    for r in rows:
        ph, b = r["phase"], ply_bin(r["ply"])
        real_sum[ph] += min(r["cpl_actual"], CPL_CAP)
        real_n[ph] += 1
        exp_cpl = sum(w * min(c, CPL_CAP)
                      for w, c in zip(r["weights"], r["cand_cpls"]))
        sim_sum[ph] += exp_cpl
        sim_n[ph] += 1
        if r["cpl_actual"] >= MISTAKE_CP:
            real_mist[b] += 1.0
            real_mist_phase[ph] += 1.0
        pm = sum(w for w, c in zip(r["weights"], r["cand_cpls"])
                 if c >= MISTAKE_CP)
        sim_mist[b] += pm
        sim_mist_phase[ph] += pm

    real_acpl = {p: real_sum[p] / real_n[p] for p in PHASES if real_n[p]}
    sim_acpl = {p: sim_sum[p] / sim_n[p] for p in PHASES if sim_n[p]}
    return {
        "real_acpl": {k: round(v, 1) for k, v in real_acpl.items()},
        "persona_acpl": {k: round(v, 1) for k, v in sim_acpl.items()},
        "acpl_shape_similarity": _round(tv_similarity(real_acpl, sim_acpl)),
        "real_mistakes_total": sum(real_mist.values()),
        "persona_expected_mistakes_total": round(sum(sim_mist.values()), 2),
        "error_timing_real": {k: real_mist[k] for k in sorted(real_mist)},
        "error_timing_persona": {k: round(sim_mist[k], 2)
                                 for k in sorted(sim_mist)},
        "error_timing_similarity": _round(tv_similarity(real_mist, sim_mist)),
        "error_phase_similarity": _round(
            tv_similarity(real_mist_phase, sim_mist_phase)),
    }


def _round(x: Optional[float], nd: int = 4) -> Optional[float]:
    return None if x is None else round(x, nd)


# ---------------------------------------------------------------------------
# Opening KL
# ---------------------------------------------------------------------------

def opening_kl(entries: Sequence[dict]) -> dict:
    """entries: one per persona-to-move opening position, each
    {visits: int, real: {uci: count}, persona: {uci: prob} | None,
     source: 'book'|'policy'|'none'}.

    KL(real || persona) per position, visit-weighted; persona probs floored at
    KL_EPS over the union support and renormalized. Positions with no persona
    distribution (source 'none') are excluded and reported as uncovered."""
    total_visits = sum(e["visits"] for e in entries)
    covered = [e for e in entries if e["persona"]]
    cov_visits = sum(e["visits"] for e in covered)
    book_visits = sum(e["visits"] for e in covered if e["source"] == "book")
    if not covered:
        return {"kl_nats": None, "positions": len(entries), "covered": 0,
                "visit_coverage": 0.0, "book_share_of_covered": None}

    acc = 0.0
    for e in covered:
        real = _normalize({k: float(v) for k, v in e["real"].items()})
        keys = set(real) | set(e["persona"])
        q = {k: max(e["persona"].get(k, 0.0), KL_EPS) for k in keys}
        qt = sum(q.values())
        q = {k: v / qt for k, v in q.items()}
        kl = sum(p * math.log(p / q[k]) for k, p in real.items() if p > 0)
        acc += e["visits"] * kl
    return {
        "kl_nats": round(acc / cov_visits, 4),
        "positions": len(entries),
        "covered": len(covered),
        "visit_coverage": round(cov_visits / total_visits, 4) if total_visits else 0.0,
        "book_share_of_covered": round(book_visits / cov_visits, 4),
    }


# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------

def selftest() -> int:
    import unittest

    class T(unittest.TestCase):
        def test_match_and_expected(self):
            u, w = ["a", "b", "c"], [0.2, 0.5, 0.3]
            self.assertEqual(weight_ranking(u, w), ["b", "c", "a"])
            self.assertTrue(match_at(u, w, "b", 1))
            self.assertFalse(match_at(u, w, "a", 2))
            self.assertTrue(match_at(u, w, "a", 3))
            self.assertEqual(expected_match1(u, w, "c"), 0.3)
            self.assertEqual(expected_match1(u, w, "z"), 0.0)
            self.assertAlmostEqual(nll(u, w, "z"), -math.log(MISS_PROB))

        def test_cpl_and_bins(self):
            self.assertEqual(cpl(50, -100), 150)
            self.assertEqual(cpl(50, 80), 0)
            self.assertEqual(cpl(100_000, 0), CPL_CAP)
            self.assertEqual(ply_bin(10), "10-19")
            self.assertEqual(ply_bin(60), "50-60")

        def test_tv_similarity(self):
            self.assertEqual(tv_similarity({"a": 1.0}, {"a": 2.0}), 1.0)
            self.assertEqual(tv_similarity({"a": 1.0}, {"b": 1.0}), 0.0)
            self.assertIsNone(tv_similarity({}, {"a": 1.0}))
            self.assertAlmostEqual(
                tv_similarity({"a": 3, "b": 1}, {"a": 1, "b": 1}), 0.75)

        def test_acpl_profiles(self):
            rows = [
                {"phase": "opening", "ply": 12, "cpl_actual": 0,
                 "cand_cpls": [0, 200], "weights": [0.5, 0.5]},
                {"phase": "middlegame", "ply": 30, "cpl_actual": 150,
                 "cand_cpls": [0, 0], "weights": [0.5, 0.5]},
            ]
            m = acpl_profiles(rows)
            self.assertEqual(m["real_acpl"], {"opening": 0.0,
                                              "middlegame": 150.0})
            self.assertEqual(m["persona_acpl"], {"opening": 100.0,
                                                 "middlegame": 0.0})
            self.assertEqual(m["real_mistakes_total"], 1.0)
            self.assertEqual(m["persona_expected_mistakes_total"], 0.5)
            # Real mistakes all in 30-39; persona's expected all in 10-19.
            self.assertEqual(m["error_timing_similarity"], 0.0)
            self.assertEqual(m["acpl_shape_similarity"], 0.0)

        def test_acpl_identical_profiles(self):
            rows = [{"phase": "opening", "ply": 12, "cpl_actual": 120,
                     "cand_cpls": [120], "weights": [1.0]}]
            m = acpl_profiles(rows)
            self.assertEqual(m["acpl_shape_similarity"], 1.0)
            self.assertEqual(m["error_timing_similarity"], 1.0)

        def test_opening_kl_perfect_match_is_zero(self):
            e = [{"visits": 4, "real": {"e2e4": 3, "d2d4": 1},
                  "persona": {"e2e4": 0.75, "d2d4": 0.25}, "source": "book"}]
            r = opening_kl(e)
            self.assertAlmostEqual(r["kl_nats"], 0.0, places=3)
            self.assertEqual(r["visit_coverage"], 1.0)
            self.assertEqual(r["book_share_of_covered"], 1.0)

        def test_opening_kl_missing_move_is_finite(self):
            e = [{"visits": 1, "real": {"e2e4": 1},
                  "persona": {"d2d4": 1.0}, "source": "policy"}]
            r = opening_kl(e)
            self.assertIsNotNone(r["kl_nats"])
            self.assertLess(r["kl_nats"], math.log(1.0 / KL_EPS) + 1)

        def test_opening_kl_uncovered(self):
            e = [{"visits": 2, "real": {"e2e4": 2}, "persona": None,
                  "source": "none"}]
            r = opening_kl(e)
            self.assertIsNone(r["kl_nats"])
            self.assertEqual(r["visit_coverage"], 0.0)

    suite = unittest.TestLoader().loadTestsFromTestCase(T)
    res = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if res.wasSuccessful() else 1


if __name__ == "__main__":
    import sys
    sys.exit(selftest())
