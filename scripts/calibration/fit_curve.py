#!/usr/bin/env python3
"""Fit the measured b(t) speed->Elo curve from a time-odds ladder run and write
it into this machine's profile (spec 216, Tier 1).

Each ladder rung is a controlled 2x-compute doubling: the slow side gets exactly
2x the fast side's base AND increment, so its measured score over the fast side
IS the Elo-per-doubling `b` at that time control. We anchor that `b` at the
GEOMETRIC MEAN of the two sides' seconds-per-move -- which is the midpoint of the
doubling interval on the log2-seconds axis the model is linear in. The result is
a set of `BAnchor` points ({log2Sec, b}) matching `lib/time-elo.ts`'s `EloCurve`,
written as:

    "curve": {
      "source": "measured",
      "b": [{"log2Sec": ..., "b": ...}, ...],   # ascending in log2Sec
      "rungs": N,
      "fitted_at": "<ISO-8601 UTC>",
      "machine_min_seconds": <float>           # fastest clean rung, see below
    }

`machine_min_seconds` is the LADDER-MEASURED per-move floor (spec 216 tier-0
checklist: the 0.05s machine-min is a placeholder "until the ladder measures
it"): the fastest per-move budget (fast_ms) of any rung that finished all its
games without engine errors — demonstrated playable on this machine, not
guessed. The UI's pacing floor reads it off the curve.

Spec 216 gate: a rung only anchors the curve if its 95% CI excludes zero. With
fewer than 2 such rungs we stay on the PRIOR curve and write nothing (216:30).

Per-engine curves (216 Tier 2): the curve lands in the profile's
`engines[<name>].curve` entry (creating it if needed) — `--engine` names the
entry, defaulting to the profile's top-level `engine_name`. When the target IS
the top-level engine the top-level `curve` is written too, keeping legacy
consumers on the same figures.

    python3 scripts/calibration/fit_curve.py [--ladder PATH] [--profile PATH]
                                             [--hostname NAME] [--engine NAME]
                                             [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PROFILE = (
    Path.home()
    / "Library"
    / "Application Support"
    / "com.hjalti.chessgui"
    / "machine_profile.json"
)


def hostname() -> str:
    """Match the ladder runner's hostname resolution (it shells out to `hostname`)."""
    try:
        out = subprocess.check_output(["hostname"], text=True).strip()
        if out:
            return out
    except Exception:
        pass
    import socket

    return socket.gethostname() or "unknown"


def ci_excludes_zero(rung: dict) -> bool:
    """A rung anchors the curve only if its 95% CI is entirely on one side of 0."""
    lo = rung.get("ci_lo")
    hi = rung.get("ci_hi")
    if lo is None or hi is None:
        return False
    return lo > 0 or hi < 0


def anchor_for(rung: dict) -> dict:
    """{log2Sec, b} for one rung: b at the geometric-mean seconds/move."""
    fast_ms = float(rung["fast_ms"])
    slow_ms = float(rung["slow_ms"])
    geo_sec = math.sqrt(fast_ms * slow_ms) / 1000.0
    return {"log2Sec": math.log2(geo_sec), "b": float(rung["elo_per_doubling"])}


def build_curve(ladder: dict) -> tuple[list[dict], int, int]:
    """Return (anchors ascending in log2Sec, n_qualifying, n_total)."""
    rungs = [r for r in ladder.values() if isinstance(r, dict)]
    qualifying = [r for r in rungs if ci_excludes_zero(r)]
    anchors = sorted((anchor_for(r) for r in qualifying), key=lambda a: a["log2Sec"])
    return anchors, len(qualifying), len(rungs)


def machine_min_seconds(ladder: dict) -> float | None:
    """The ladder-measured per-move floor: the fastest fast-side budget among
    rungs that completed games with zero engine errors. A rung needn't anchor
    the curve (CI gate) to prove the machine can PLAY at its speed. None when
    no rung ran cleanly."""
    clean = [
        float(r["fast_ms"]) / 1000.0
        for r in ladder.values()
        if isinstance(r, dict)
        and r.get("games", 0) > 0
        and r.get("errors", 0) == 0
        and r.get("fast_ms")
    ]
    return min(clean) if clean else None


def main() -> int:
    ap = argparse.ArgumentParser(description="Fit the measured b(t) curve into the machine profile.")
    ap.add_argument("--ladder", type=Path, default=None, help="ladder_<host>.json (default: data/calibration/ladder_<host>.json)")
    ap.add_argument("--profile", type=Path, default=DEFAULT_PROFILE, help="machine_profile.json to merge into")
    ap.add_argument("--hostname", type=str, default=None, help="override hostname used to locate the default ladder file")
    ap.add_argument("--engine", type=str, default=None, help="engine `id name` this ladder measured (default: the profile's top-level engine_name) — the curve lands in that engines[] entry (spec 216 Tier 2 per-engine curves)")
    ap.add_argument("--dry-run", action="store_true", help="print the fitted curve but do not write the profile")
    args = ap.parse_args()

    host = args.hostname or hostname()
    ladder_path = args.ladder or (REPO_ROOT / "data" / "calibration" / f"ladder_{host}.json")

    if not ladder_path.exists():
        print(f"no ladder file at {ladder_path} -- run the time_odds_ladder example first", file=sys.stderr)
        return 1
    ladder = json.loads(ladder_path.read_text())
    if not isinstance(ladder, dict) or not ladder:
        print(f"ladder file {ladder_path} is empty or malformed", file=sys.stderr)
        return 1

    anchors, n_qual, n_total = build_curve(ladder)
    print(f"ladder {ladder_path.name}: {n_total} rung(s), {n_qual} with 95% CI excluding zero")
    for a in anchors:
        print(f"  anchor  log2Sec {a['log2Sec']:+.3f}  ({2 ** a['log2Sec']:.3f}s/move)  b {a['b']:+.1f} Elo/doubling")

    floor = machine_min_seconds(ladder)
    if floor is not None:
        print(f"  machine-min floor  {floor:.3f}s/move (fastest clean rung)")
    else:
        print("  no clean rung -- machine-min floor stays at the tier-0 placeholder")

    # Spec 216: MEASURED requires >= 2 rungs whose CI excludes zero.
    if n_qual < 2:
        print(
            f"only {n_qual} qualifying rung(s) (need >= 2) -- staying on the PRIOR curve, nothing written.",
            file=sys.stderr,
        )
        return 2

    curve = {
        "source": "measured",
        "b": anchors,
        "rungs": n_qual,
        "fitted_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
    }
    if floor is not None:
        curve["machine_min_seconds"] = floor

    if args.dry_run:
        print("\n--dry-run: curve that WOULD be written:")
        print(json.dumps(curve, indent=2))
        return 0

    if not args.profile.exists():
        print(
            f"no machine profile at {args.profile} -- bench this machine first (machine_bench), "
            "then rerun so the curve merges into the existing profile.",
            file=sys.stderr,
        )
        return 1
    profile = json.loads(args.profile.read_text())
    if not isinstance(profile, dict):
        print(f"machine profile {args.profile} is malformed (expected a JSON object)", file=sys.stderr)
        return 1

    # Per-engine curve (spec 216 Tier 2): land the fit in this engine's
    # engines[] entry; mirror to the top-level curve only when the target IS
    # the top-level engine (a Reckless ladder must not overwrite SF's curve).
    target = args.engine or profile.get("engine_name")
    wrote = []
    if target:
        engines = profile.setdefault("engines", {})
        entry = engines.setdefault(target, {})
        if not isinstance(entry, dict):
            entry = engines[target] = {}
        entry["curve"] = curve
        wrote.append(f'engines["{target}"].curve')
    if not target or target == profile.get("engine_name"):
        profile["curve"] = curve
        wrote.append("curve (top-level)")
    args.profile.parent.mkdir(parents=True, exist_ok=True)
    args.profile.write_text(json.dumps(profile, indent=2) + "\n")
    print(f"\nwrote MEASURED curve ({n_qual} anchors) into {args.profile}: {', '.join(wrote)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
