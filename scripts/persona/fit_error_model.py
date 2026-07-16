#!/usr/bin/env python3
"""fit_error_model.py — spec 214 contract step 5, LOCAL half.

Consumes the MERGED corpus error model (scripts/mining/error_model.py --merge:
raw per-cell counts of moves/mistakes keyed "band|phase|eval_bucket|clock")
and fits smoothed conditional mistake-rate surfaces per Elo band:

    P(mistake | eval-before-move, phase, clock, band)

Raw cells are noisy exactly where the persona engine needs them least wrong —
sparse (eval, clock) corners where a handful of games produce rates of 0 or 1.
The fit is deliberately boring, well-understood math:

  1. Hierarchical empirical-Bayes shrinkage with pseudo-count SMOOTH_K down
     the back-off chain  global -> band -> band+phase -> band+phase+clock ->
     cell:  rate = (mistakes + K*parent) / (moves + K).  A cell with 100k
     moves keeps its raw rate; a 3-move cell collapses to its parent; an
     UNOBSERVED cell gets exactly its parent (the full grid is emitted, so
     runtime lookup is total for every band the corpus saw).
  2. A 1-2-1 kernel along the ordered eval axis, weighted by effective
     support (moves + K), so neighboring eval buckets — which are physically
     adjacent states, not arbitrary categories — inform each other without
     letting a sparse bucket drag down a heavy neighbor.

Output:
  data/personas/error_model.fit.json   full per-band fitted grids + meta
  data/personas/ERROR_MODEL_FIT.md     human-readable surface summary

Downstream (the gating chain, spec 214 hard rule "never random
noise-weakening" + acceptance bar): tune_persona.py --error-model measures
this fit as a candidate arm on held-out data; ONLY a persona whose held-out
move-match@1 improves by >= +2% absolute gets `sampling.error_model` written
into its staged v2 config, which persona.rs then honors (default OFF).

Usage:
    python3 fit_error_model.py --selftest
    python3 fit_error_model.py                      # default in/out paths
    python3 fit_error_model.py --input X --out Y --md Z
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple

GENERATOR = "fit_error_model.py v1"

REPO = Path(__file__).resolve().parents[2]
DEFAULT_INPUT = REPO / "data" / "personas" / "error_model.json"
DEFAULT_OUT = REPO / "data" / "personas" / "error_model.fit.json"
DEFAULT_MD = REPO / "data" / "personas" / "ERROR_MODEL_FIT.md"
FIXTURE = Path(__file__).parent / "fixtures" / "error_model.merged.fixture.json"

# Shrinkage pseudo-count: a cell needs ~SMOOTH_K observed moves before its own
# rate outweighs its parent's. 200 keeps 6-figure cells raw and 1-figure cells
# fully pooled; between, it interpolates.
SMOOTH_K = 200.0

# Eval-axis kernel (center-weighted). Eval buckets are ORDERED physical
# neighbors; phase/clock/band are not smoothed across (categorical).
EVAL_KERNEL = (1.0, 2.0, 1.0)

# The corpus grid (scripts/mining/error_model.py conventions, mirrored in
# persona.rs ErrorModel / persona_sim.py — keep all four in sync).
PHASES = ("opening", "middlegame", "endgame")
CLOCKS = ("600plus", "300-600", "120-300", "60-120", "30-60", "lt30", "none")
EVAL_BUCKET_CP = 50
EVAL_CLAMP_CP = 500
MISTAKE_DROP_CP = 100
EVAL_LOWERS = list(range(-EVAL_CLAMP_CP, EVAL_CLAMP_CP, EVAL_BUCKET_CP))


def eval_label(lower_cp: int) -> str:
    """Bucket label, error_model.py convention: lower edge in pawns, '+0.0'."""
    return f"{lower_cp / 100:+.1f}"


EVAL_LABELS = [eval_label(lo) for lo in EVAL_LOWERS]


def shrink(mistakes: float, moves: float, parent: float,
           k: float = SMOOTH_K) -> float:
    """Empirical-Bayes posterior mean with pseudo-count k toward `parent`."""
    return (mistakes + k * parent) / (moves + k)


def parse_counts(doc: dict) -> Dict[str, Dict[Tuple[str, str, str], List[float]]]:
    """Merged cells -> counts[band][(phase, eval_label, clock)] = [n, m]."""
    out: Dict[str, Dict[Tuple[str, str, str], List[float]]] = {}
    for key, cell in doc["cells"].items():
        band, phase, ev, clock = key.split("|")
        out.setdefault(band, {})[(phase, ev, clock)] = [
            float(cell["moves"]), float(cell["mistakes"])]
    return out


def fit(doc: dict) -> dict:
    """The fitted document (see module docstring for the method)."""
    counts = parse_counts(doc)
    total_n = sum(n for band in counts.values() for n, _ in band.values())
    total_m = sum(m for band in counts.values() for _, m in band.values())
    if total_n <= 0:
        raise ValueError("merged error model has zero classified moves")
    global_rate = total_m / total_n

    bands_out: Dict[str, dict] = {}
    for band in sorted(counts, key=lambda b: (len(b), b)):
        cells = counts[band]
        band_n = sum(n for n, _ in cells.values())
        band_m = sum(m for _, m in cells.values())
        band_rate = shrink(band_m, band_n, global_rate)

        fitted: Dict[str, float] = {}
        for phase in PHASES:
            ph = [(k, v) for k, v in cells.items() if k[0] == phase]
            ph_n = sum(v[0] for _, v in ph)
            ph_m = sum(v[1] for _, v in ph)
            phase_rate = shrink(ph_m, ph_n, band_rate)
            for clock in CLOCKS:
                cl = [(k, v) for k, v in ph if k[2] == clock]
                cl_n = sum(v[0] for _, v in cl)
                cl_m = sum(v[1] for _, v in cl)
                clock_rate = shrink(cl_m, cl_n, phase_rate)
                # Per-eval shrunk rates + effective support, then the kernel.
                base: List[float] = []
                support: List[float] = []
                for ev in EVAL_LABELS:
                    n, m = cells.get((phase, ev, clock), (0.0, 0.0))
                    base.append(shrink(m, n, clock_rate))
                    support.append(n + SMOOTH_K)
                for i, ev in enumerate(EVAL_LABELS):
                    num = den = 0.0
                    for off, kw in zip((-1, 0, 1), EVAL_KERNEL):
                        j = i + off
                        if 0 <= j < len(base):
                            num += kw * support[j] * base[j]
                            den += kw * support[j]
                    fitted[f"{phase}|{ev}|{clock}"] = round(num / den, 6)

        bands_out[band] = {
            "moves": int(band_n),
            "mistakes": int(band_m),
            "raw_rate": round(band_m / band_n, 6) if band_n else None,
            "cells": fitted,
        }

    return {
        "meta": {
            "generator": GENERATOR,
            "spec": "214 contract step 5 (fit half; counts from "
                    "scripts/mining/error_model.py)",
            "source_meta": doc.get("meta", {}),
            "fitted_at": datetime.now(timezone.utc).isoformat(),
            "method": ("hierarchical shrinkage (pseudo-count "
                       f"{SMOOTH_K:g}: global->band->phase->clock->cell) + "
                       f"{'-'.join(str(int(k)) for k in EVAL_KERNEL)} kernel "
                       "over the eval axis, support-weighted"),
            "cell_key": "phase|eval_bucket_lower|clock_bucket (per band)",
            "mistake_drop_cp": MISTAKE_DROP_CP,
            "eval_bucket_cp": EVAL_BUCKET_CP,
            "eval_clamp_cp": EVAL_CLAMP_CP,
            "bands": sorted(bands_out, key=lambda b: (len(b), b)),
            "global_rate": round(global_rate, 6),
            "total_moves": int(total_n),
            "total_mistakes": int(total_m),
        },
        "bands": bands_out,
    }


def band_cells_for(fit_doc: dict, level: int) -> Tuple[str, Dict[str, float]]:
    """The fitted cells for a persona at `level` Elo: the exact 100-band when
    the corpus has it, else the numerically nearest band present (honest
    fallback — a 2800 persona gets the strongest band the corpus saw).
    Returns (band_label_used, cells)."""
    want = (level // 100) * 100
    bands = {int(b): b for b in fit_doc["bands"]}
    if not bands:
        raise ValueError("fitted error model has no bands")
    nearest = min(bands, key=lambda b: (abs(b - want), b))
    label = bands[nearest]
    return label, fit_doc["bands"][label]["cells"]


# ---------------------------------------------------------------------------
# Markdown summary
# ---------------------------------------------------------------------------

def _mean_rate(band: dict, phase: str, clock: str) -> float:
    """Fitted mean over the eval axis for one (phase, clock) slice — a
    scalar summary for the table; the JSON keeps the full curve."""
    vals = [band["cells"][f"{phase}|{ev}|{clock}"] for ev in EVAL_LABELS]
    return sum(vals) / len(vals)


def summary_markdown(fit_doc: dict) -> str:
    meta = fit_doc["meta"]
    L: List[str] = []
    A = L.append
    A("# Corpus error model — fitted surfaces (spec 214 contract step 5)\n")
    A(f"_{meta['generator']} · {meta['fitted_at'][:16]} · "
      f"{meta['total_moves']:,} moves / {meta['total_mistakes']:,} mistakes "
      f"(global rate {meta['global_rate']:.3f}) · method: {meta['method']}._\n")
    A("Mistake = mover-POV [%eval] drop >= 1.0 pawn (no engine "
      "re-verification — distributional model, see "
      "scripts/mining/error_model.py). Eval buckets are the mover-POV eval "
      "BEFORE the move (50 cp, clamped to [-5, +5)); clock buckets are "
      "remaining seconds. HOW THIS SHIPS: consumed by tune_persona.py "
      "--error-model as a gated candidate arm — a persona config gets "
      "`sampling.error_model` ONLY on a held-out +2% move-match@1 win.\n")
    for band in meta["bands"]:
        b = fit_doc["bands"][band]
        A(f"## Band {band}\n")
        A(f"{b['moves']:,} moves, {b['mistakes']:,} mistakes, raw rate "
          f"{b['raw_rate']}.\n")
        A("Fitted mean rate by phase x clock (mean over eval buckets):\n")
        A("| phase | " + " | ".join(CLOCKS) + " |")
        A("|---|" + "--:|" * len(CLOCKS))
        for phase in PHASES:
            row = " | ".join(f"{_mean_rate(b, phase, c):.3f}" for c in CLOCKS)
            A(f"| {phase} | {row} |")
        A("")
        A("Middlegame eval curve (fitted rate at bucket lower edge, ample "
          "clock `600plus`):\n")
        picks = ["-5.0", "-3.0", "-1.0", "+0.0", "+1.0", "+3.0", "+4.5"]
        A("| eval | " + " | ".join(picks) + " |")
        A("|---|" + "--:|" * len(picks))
        A("| rate | " + " | ".join(
            f"{b['cells'][f'middlegame|{p}|600plus']:.3f}" for p in picks) + " |")
        A("")
    return "\n".join(L)


# ---------------------------------------------------------------------------
# Self-test (runs against the checked-in fixture; no corpus needed)
# ---------------------------------------------------------------------------

def selftest() -> int:
    import unittest

    fixture = json.loads(FIXTURE.read_text())

    class T(unittest.TestCase):
        def setUp(self):
            self.fit = fit(fixture)

        def test_full_grid_per_band(self):
            want = len(PHASES) * len(EVAL_LABELS) * len(CLOCKS)
            for band, b in self.fit["bands"].items():
                self.assertEqual(len(b["cells"]), want, band)
                for v in b["cells"].values():
                    self.assertGreaterEqual(v, 0.0)
                    self.assertLessEqual(v, 1.0)

        def test_heavy_cells_keep_their_raw_rate(self):
            # 100k moves at rate .05: shrinkage (K=200) and the support-
            # weighted kernel move it only marginally.
            got = self.fit["bands"]["1500"]["cells"]["middlegame|+0.0|600plus"]
            self.assertAlmostEqual(got, 0.05, delta=0.005)
            got18 = self.fit["bands"]["1800"]["cells"]["middlegame|+0.0|600plus"]
            self.assertAlmostEqual(got18, 0.03, delta=0.005)

        def test_sparse_cell_is_pooled_toward_its_parent(self):
            # 3/3 moves (raw rate 1.0) must collapse near the band/phase/clock
            # back-off, far below raw.
            got = self.fit["bands"]["1500"]["cells"]["middlegame|+4.5|600plus"]
            self.assertLess(got, 0.2)
            self.assertGreater(got, 0.0)

        def test_unobserved_cell_gets_its_backoff(self):
            # No 1500 opening lt30 data at all: the cell must sit near the
            # opening back-off chain (opening rate .02 shrunk toward band),
            # NOT near zero and NOT near the middlegame rate.
            got = self.fit["bands"]["1500"]["cells"]["opening|-2.0|lt30"]
            self.assertGreater(got, 0.01)
            self.assertLess(got, 0.1)

        def test_time_pressure_raises_the_rate(self):
            b = self.fit["bands"]["1500"]["cells"]
            self.assertGreater(b["middlegame|+0.0|lt30"],
                               b["middlegame|+0.0|600plus"])

        def test_losing_positions_have_higher_rates(self):
            b = self.fit["bands"]["1500"]["cells"]
            self.assertGreater(b["middlegame|-3.0|600plus"],
                               b["middlegame|+0.0|600plus"])

        def test_deterministic(self):
            self.assertEqual(self.fit["bands"], fit(fixture)["bands"])

        def test_band_cells_for_exact_and_nearest(self):
            band, cells = band_cells_for(self.fit, 1560)
            self.assertEqual(band, "1500")
            self.assertIn("middlegame|+0.0|600plus", cells)
            band28, _ = band_cells_for(self.fit, 2800)  # nearest = strongest
            self.assertEqual(band28, "1800")
            band9, _ = band_cells_for(self.fit, 900)
            self.assertEqual(band9, "1500")

        def test_markdown_renders_every_band(self):
            md = summary_markdown(self.fit)
            for band in self.fit["meta"]["bands"]:
                self.assertIn(f"## Band {band}", md)

        def test_eval_labels_match_the_corpus_convention(self):
            self.assertEqual(EVAL_LABELS[0], "-5.0")
            self.assertEqual(EVAL_LABELS[-1], "+4.5")
            self.assertIn("+0.0", EVAL_LABELS)
            self.assertIn("-0.5", EVAL_LABELS)

    suite = unittest.TestLoader().loadTestsFromTestCase(T)
    res = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if res.wasSuccessful() else 1


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", type=Path, default=DEFAULT_INPUT,
                    help=f"merged error_model.json (default {DEFAULT_INPUT})")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT,
                    help=f"fitted output (default {DEFAULT_OUT})")
    ap.add_argument("--md", type=Path, default=DEFAULT_MD,
                    help=f"markdown summary (default {DEFAULT_MD})")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()

    if args.selftest:
        return selftest()

    if not args.input.exists():
        print(f"[fit_error_model] input missing: {args.input}\n"
              "  (the merged corpus model is produced on the homeserver by "
              "scripts/mining/error_model.py --merge and copied to "
              "data/personas/error_model.json)", file=sys.stderr)
        return 2

    t0 = time.time()
    doc = json.loads(args.input.read_text())
    if doc.get("meta", {}).get("cell_key") != \
            "band|phase|eval_bucket_lower|clock_bucket":
        print("[fit_error_model] input is not a merged error_model.py "
              "document (meta.cell_key mismatch)", file=sys.stderr)
        return 2
    fit_doc = fit(doc)
    fit_doc["meta"]["source"] = str(args.input)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    tmp = args.out.with_suffix(".json.part")
    tmp.write_text(json.dumps(fit_doc, indent=1) + "\n")
    tmp.replace(args.out)
    args.md.write_text(summary_markdown(fit_doc))
    meta = fit_doc["meta"]
    print(f"[fit_error_model] {len(meta['bands'])} bands, "
          f"{meta['total_moves']:,} moves -> {args.out} + {args.md} "
          f"({time.time() - t0:.1f}s)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
