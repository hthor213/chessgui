#!/usr/bin/env python3
"""Monthly training measurement (spec 215, Tier 2).

Runs the self-report pipeline end to end and appends this month's metric
points to a measurement file the Training tab imports:

    fetch (chess.com archives)                 scripts/fetch_chesscom.py
      -> engagement filter                     scripts/self_report/self_engage.py
      -> profile + Maia position sampler       scripts/self_report/self_analyze.py
      -> lc0/Maia policy matrix (9 nets)       scripts/self_report/self_maia.py
      -> rating estimate (quad peak+bootstrap) scripts/self_report/self_stats.py
      -> data/rivals/training_metrics.json     (merged, keyed by (at, metric))

Metrics produced (definitions stated in each point's note, so a future
change of definition is visible, not silent):
  maia_rapid    — quadratic-peak Maia estimate, rapid games
  eg_conversion — endgame score fraction, rapid+blitz, engaged games only
  flag_net      — timeout wins minus timeout losses, engaged games only

Usage:
    python3 scripts/measure_monthly.py --user <chesscom-username>
        [--skip-fetch]   reuse the existing PGN (no network)
        [--skip-maia]    profile-only metrics (eg_conversion, flag_net) —
                         skips the multi-minute lc0 run
        [--emit-json]    also print the new points to stdout
        [--nets DIR]     Maia weights dir (default: the app's cache; missing
                         nets are downloaded from the CSSLab v1.0 release)

Deliberately a script, not an in-app spawn (the "smaller honest step",
spec 215 Tier 2): the full run is minutes of lc0 plus network fetches, which
deserves a terminal with visible progress, not a silent button. The app's
"Import measurements…" button reads this script's output file.

Needs: python-chess, numpy, lc0 (brew install lc0).
"""
import argparse
import datetime as dt
import json
import os
import subprocess
import sys
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SELF_REPORT = os.path.join(REPO, "scripts", "self_report")
RIVALS = os.path.join(REPO, "data", "rivals")
METRICS_FILE = os.path.join(RIVALS, "training_metrics.json")
DEFAULT_NETS = os.path.expanduser("~/Library/Application Support/com.hjalti.chessgui/maia")
# Same source the app itself downloads from (src-tauri/src/maia.rs RELEASE_BASE).
RELEASE_BASE = "https://github.com/CSSLab/maia-chess/releases/download/v1.0"
LEVELS = [1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900]


def run(cmd: list[str]) -> None:
    print(f"$ {' '.join(cmd)}", file=sys.stderr)
    subprocess.run(cmd, check=True)


def ensure_nets(netdir: str) -> None:
    os.makedirs(netdir, exist_ok=True)
    for lv in LEVELS:
        path = os.path.join(netdir, f"maia-{lv}.pb.gz")
        if os.path.exists(path):
            continue
        url = f"{RELEASE_BASE}/maia-{lv}.pb.gz"
        print(f"downloading {url}", file=sys.stderr)
        with urllib.request.urlopen(url, timeout=60) as r, open(path, "wb") as f:
            f.write(r.read())


def load_json(path: str):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def merge_points(existing: list[dict], new: list[dict]) -> list[dict]:
    """Same rule as the app's mergeMetricPoints: key (at, metric), a changed
    value supersedes (moved to the end so latest-of-metric reads it)."""
    merged = list(existing)
    for p in new:
        idx = next(
            (i for i, e in enumerate(merged) if e["at"] == p["at"] and e["metric"] == p["metric"]),
            None,
        )
        if idx is not None:
            if merged[idx].get("value") == p["value"] and merged[idx].get("note", "") == p.get("note", ""):
                continue
            merged.pop(idx)
        merged.append(p)
    return merged


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--user", required=True, help="chess.com username (your own account)")
    ap.add_argument("--skip-fetch", action="store_true")
    ap.add_argument("--skip-maia", action="store_true")
    ap.add_argument("--emit-json", action="store_true")
    ap.add_argument("--nets", default=DEFAULT_NETS)
    ap.add_argument("--lc0", default="/opt/homebrew/bin/lc0")
    ap.add_argument("--positions", type=int, default=1200, help="Maia sample cap")
    args = ap.parse_args()

    pgn = os.path.join(RIVALS, f"{args.user}.pgn")
    work = os.path.join(RIVALS, "self_report")  # gitignored with the rest of data/rivals
    os.makedirs(work, exist_ok=True)
    py = sys.executable

    if not args.skip_fetch:
        run([py, os.path.join(REPO, "scripts", "fetch_chesscom.py"), args.user, "-o", pgn])
    elif not os.path.exists(pgn):
        sys.exit(f"--skip-fetch but no PGN at {pgn}")

    run([py, os.path.join(SELF_REPORT, "self_engage.py"), "--pgn", pgn, "--user", args.user, "--out", work])
    run([py, os.path.join(SELF_REPORT, "self_analyze.py"), "--pgn", pgn, "--user", args.user, "--out", work])

    month = dt.date.today().strftime("%Y-%m")
    points: list[dict] = []

    part1 = load_json(os.path.join(work, "self_part1.json"))
    eg = part1.get("endgame_record_rapidblitz") or part1.get("endgame_record")
    if eg and eg.get("n"):
        points.append({
            "at": month,
            "metric": "eg_conversion",
            "value": round(eg["score_pct"] / 100.0, 3),
            "note": f"endgame score, rapid+blitz, engaged games (n={eg['n']})",
        })
    time_term = (part1.get("termination_modes") or {}).get("time") or {}
    flag_net = int(time_term.get("win", 0)) - int(time_term.get("loss", 0))
    points.append({
        "at": month,
        "metric": "flag_net",
        "value": flag_net,
        "note": "timeout wins minus losses, engaged games, all-time",
    })

    if not args.skip_maia:
        if not os.path.exists(args.lc0):
            sys.exit(f"lc0 not found at {args.lc0} (brew install lc0), or pass --lc0")
        ensure_nets(args.nets)
        run([py, os.path.join(SELF_REPORT, "self_maia.py"), "rapid", str(args.positions),
             "--dir", work, "--nets", args.nets, "--lc0", args.lc0])
        run([py, os.path.join(SELF_REPORT, "self_stats.py"), "rapid", "--dir", work])
        est = load_json(os.path.join(work, "self_estimate_rapid.json"))
        lo, _, hi = est["bootstrap_peak_5_50_95"]
        points.append({
            "at": month,
            "metric": "maia_rapid",
            "value": round(est["quadratic_peak"]),
            "note": f"quad peak, bootstrap 5–95%: {round(lo)}–{round(hi)} (n={est['n_positions']})",
        })

    existing = []
    if os.path.exists(METRICS_FILE):
        existing = load_json(METRICS_FILE).get("points", [])
    merged = merge_points(existing, points)
    with open(METRICS_FILE, "w", encoding="utf-8") as f:
        json.dump({"generated_at": dt.datetime.now().isoformat(timespec="seconds"),
                   "points": merged}, f, indent=1)
    print(f"wrote {METRICS_FILE} ({len(points)} new/updated points this run)", file=sys.stderr)
    print("import it in the app: Training tab -> Measurements -> Import measurements…", file=sys.stderr)

    if args.emit_json:
        json.dump(points, sys.stdout, indent=1)
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
