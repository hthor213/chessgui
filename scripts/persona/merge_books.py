#!/usr/bin/env python3
"""Merge N opening-book sources into one persona book (spec 214, contract step 2).

The persona book is N-source BY DESIGN: chess.com archives today, arena games
(the spec 217 flywheel) as source #2, OTB-if-found later. This script merges
any number of book.json files (the build_rival_book.py format) into one book,
with the contract's three merge rules:

  1. per-source weights   — every entry weight from a source is multiplied by
                            that source's `weight` (default 1.0);
  2. recency decay        — exponential half-life: a game/source dated
                            `age_days` before the merge's `as_of` contributes
                            weight x 0.5 ** (age_days / half_life_days).
                            Dates resolve entry-level `date` first (future
                            books may carry per-entry dates), then the
                            source-level `date`; NO date means NO decay
                            (factor 1.0) — we never invent recency;
  3. time-control weights — a factor per TC class label (bullet/blitz/rapid/
                            classical or any label a source uses), resolved
                            entry-level `time_control` first, then source-
                            level; unknown/missing labels get 1.0.

  merged_weight(fen, color) = sum over sources of
      entry.weight x source.weight x 0.5**(age_days/half_life) x tc_weight

Entries merge by (fen, rival_color) — the same identity build_rival_book.py
uses — keeping the first-seen `line`/`ply` (all sources reaching the same FEN
describe the same node). Source labels are ARBITRARY strings so a new source
slots in without redesign. Output is a valid book.json (same entry shape,
float weights) that rival_book/rival-book-lookup consume unchanged, plus a
`merge` provenance block and per-entry per-source raw weights.

Weights are UNTUNED priors until the spec 214 metrics harness can measure
them (opening KL-divergence on held-out games); the defaults below are
deliberately neutral (all 1.0).

Usage:
    merge_books.py MANIFEST.json [--out PATH] [--as-of YYYY-MM-DD]
    merge_books.py --self-test

Manifest format:
    {
      "rival": "dad",
      "out": "data/rivals/dad_book.merged.json",
      "half_life_days": 730,
      "time_control_weights": {"bullet": 1.0, "blitz": 1.0, "rapid": 1.0,
                               "classical": 1.0},
      "sources": [
        {"label": "chesscom", "path": "data/rivals/dad_book.json",
         "weight": 1.0, "date": "2025-06-01", "time_control": "blitz"},
        {"label": "arena", "path": "data/rivals/dad_arena_book.json",
         "weight": 0.5, "date": "2026-07-01", "time_control": "rapid"}
      ]
    }
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import date, datetime, timezone
from pathlib import Path

# No decay when the manifest doesn't set one: a half-life must be an explicit,
# recorded choice, never a hidden default that silently reweights a persona.
DEFAULT_HALF_LIFE_DAYS = None


def parse_iso_date(s: str) -> date:
    """YYYY-MM-DD -> date. Raises ValueError on anything else (fail loud —
    a mistyped date silently skipping decay would corrupt the merge)."""
    return datetime.strptime(s.strip(), "%Y-%m-%d").date()


def recency_factor(entry_date: str | None, source_date: str | None,
                   as_of: date, half_life_days: float | None) -> float:
    """0.5 ** (age_days / half_life). Entry date wins over source date; no date
    or no half-life -> 1.0 (no decay without data). Future dates clamp to 0 age."""
    if half_life_days is None or half_life_days <= 0:
        return 1.0
    raw = entry_date or source_date
    if not raw:
        return 1.0
    age_days = max(0, (as_of - parse_iso_date(raw)).days)
    return 0.5 ** (age_days / half_life_days)


def tc_factor(entry_tc: str | None, source_tc: str | None,
              tc_weights: dict) -> float:
    """Time-control weight; entry label wins over source label; unknown -> 1.0."""
    label = entry_tc or source_tc
    if not label:
        return 1.0
    return float(tc_weights.get(label, 1.0))


def merge(sources: list[dict], as_of: date,
          half_life_days: float | None = DEFAULT_HALF_LIFE_DAYS,
          tc_weights: dict | None = None) -> list[dict]:
    """Merge loaded book documents. Each element of `sources` is
    {"label", "doc" (a parsed book.json), "weight"?, "date"?, "time_control"?}.
    Returns merged entries sorted by weight desc (build_rival_book.py order)."""
    tc_weights = tc_weights or {}
    merged: dict[tuple[str, str], dict] = {}
    labels_seen: set[str] = set()
    for src in sources:
        label = src["label"]
        if label in labels_seen:
            raise ValueError(f"duplicate source label: {label!r}")
        labels_seen.add(label)
        source_weight = float(src.get("weight", 1.0))
        source_date = src.get("date")
        source_tc = src.get("time_control")
        for e in src["doc"].get("entries", []):
            factor = (
                source_weight
                * recency_factor(e.get("date"), source_date, as_of, half_life_days)
                * tc_factor(e.get("time_control"), source_tc, tc_weights)
            )
            contribution = max(0.0, float(e["weight"])) * factor
            key = (e["fen"], e["rival_color"])
            node = merged.get(key)
            if node is None:
                # First source to reach this node names its line/ply (all
                # sources reaching the same FEN describe the same position).
                node = {
                    "fen": e["fen"],
                    "line": e["line"],
                    "ply": e["ply"],
                    "rival_color": e["rival_color"],
                    "weight": 0.0,
                    "sources": {},
                }
                merged[key] = node
            node["weight"] += contribution
            node["sources"][label] = node["sources"].get(label, 0) + e["weight"]
    ordered = sorted(merged.values(), key=lambda n: (-n["weight"], n["ply"], n["line"]))
    for n in ordered:
        n["weight"] = round(n["weight"], 6)
    return ordered


def to_document(entries: list[dict], manifest: dict, as_of: date) -> dict:
    """A valid book.json (consumers read entries/weights unchanged) plus a
    `merge` provenance block: which sources, which knobs, which as-of date."""
    white = sum(1 for e in entries if e["rival_color"] == "white")
    return {
        "version": 2,
        "generated_at": int(time.time()),
        "rival": manifest.get("rival", "unknown"),
        "merge": {
            "as_of": as_of.isoformat(),
            "half_life_days": manifest.get("half_life_days", DEFAULT_HALF_LIFE_DAYS),
            "time_control_weights": manifest.get("time_control_weights", {}),
            "sources": [
                {k: s[k] for k in ("label", "path", "weight", "date", "time_control") if k in s}
                for s in manifest["sources"]
            ],
        },
        "stats": {
            "positions": len(entries),
            "white_positions": white,
            "black_positions": len(entries) - white,
        },
        "entries": entries,
    }


def run(manifest_path: Path, out_override: Path | None, as_of_str: str | None) -> Path:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    as_of = parse_iso_date(as_of_str) if as_of_str else datetime.now(timezone.utc).date()
    loaded = []
    for s in manifest["sources"]:
        path = Path(s["path"])
        if not path.is_absolute():
            path = manifest_path.parent / path
        doc = json.loads(path.read_text(encoding="utf-8"))
        loaded.append({**s, "doc": doc})
    entries = merge(
        loaded,
        as_of=as_of,
        half_life_days=manifest.get("half_life_days", DEFAULT_HALF_LIFE_DAYS),
        tc_weights=manifest.get("time_control_weights"),
    )
    out = out_override or Path(manifest["out"])
    if not out.is_absolute():
        out = manifest_path.parent / out
    out.write_text(json.dumps(to_document(entries, manifest, as_of), indent=1) + "\n",
                   encoding="utf-8")
    total_in = sum(len(s["doc"].get("entries", [])) for s in loaded)
    print(f"merged {len(loaded)} sources, {total_in} entries in -> "
          f"{len(entries)} positions -> {out}")
    return out


# ---------------------------------------------------------------------------
# Self-test (fixture books, no I/O)
# ---------------------------------------------------------------------------

FEN_A = "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1"
FEN_B = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"


def _entry(fen, line, ply, color, weight, **extra):
    return {"fen": fen, "line": line, "ply": ply, "rival_color": color,
            "weight": weight, **extra}


def _book(entries):
    return {"version": 1, "entries": entries}


def self_test() -> int:
    as_of = date(2026, 7, 15)

    # -- per-source weights + same-node summing across sources ---------------
    chesscom = _book([_entry(FEN_A, "1.d4", 1, "white", 10),
                      _entry(FEN_B, "1.e4", 1, "white", 4)])
    arena = _book([_entry(FEN_A, "1.d4", 1, "white", 6)])
    merged = merge(
        [{"label": "chesscom", "doc": chesscom, "weight": 1.0},
         {"label": "arena", "doc": arena, "weight": 0.5}],
        as_of=as_of,
    )
    by_fen = {e["fen"]: e for e in merged}
    assert by_fen[FEN_A]["weight"] == 13.0, by_fen[FEN_A]  # 10x1 + 6x0.5
    assert by_fen[FEN_B]["weight"] == 4.0
    assert by_fen[FEN_A]["sources"] == {"chesscom": 10, "arena": 6}
    assert merged[0]["fen"] == FEN_A, "sorted by merged weight desc"

    # -- recency decay: source-level date, entry-level override --------------
    dated = _book([
        _entry(FEN_A, "1.d4", 1, "white", 8),                       # source date
        _entry(FEN_B, "1.e4", 1, "white", 8, date="2026-07-15"),    # fresh override
    ])
    merged = merge(
        [{"label": "old", "doc": dated, "date": "2024-07-15"}],     # 730 days old
        as_of=as_of, half_life_days=730,
    )
    by_fen = {e["fen"]: e for e in merged}
    assert abs(by_fen[FEN_A]["weight"] - 4.0) < 1e-9, "one half-life -> halved"
    assert by_fen[FEN_B]["weight"] == 8.0, "entry date overrides source date"

    # -- no date / no half-life -> no decay ----------------------------------
    assert recency_factor(None, None, as_of, 730) == 1.0
    assert recency_factor(None, "2020-01-01", as_of, None) == 1.0
    # Future date clamps to zero age.
    assert recency_factor("2027-01-01", None, as_of, 730) == 1.0

    # -- time-control weighting: source-level label, entry-level override ----
    tcs = _book([
        _entry(FEN_A, "1.d4", 1, "white", 10),                          # blitz (source)
        _entry(FEN_B, "1.e4", 1, "white", 10, time_control="rapid"),    # override
    ])
    merged = merge(
        [{"label": "cc", "doc": tcs, "time_control": "blitz"}],
        as_of=as_of, tc_weights={"blitz": 0.8, "rapid": 1.5},
    )
    by_fen = {e["fen"]: e for e in merged}
    assert abs(by_fen[FEN_A]["weight"] - 8.0) < 1e-9
    assert abs(by_fen[FEN_B]["weight"] - 15.0) < 1e-9
    # Unknown label -> neutral.
    assert tc_factor("bullet", None, {"blitz": 0.8}) == 1.0
    assert tc_factor(None, None, {"blitz": 0.8}) == 1.0

    # -- all three rules compose multiplicatively ----------------------------
    merged = merge(
        [{"label": "cc", "doc": _book([_entry(FEN_A, "1.d4", 1, "white", 16)]),
          "weight": 0.5, "date": "2024-07-15", "time_control": "blitz"}],
        as_of=as_of, half_life_days=730, tc_weights={"blitz": 0.5},
    )
    assert abs(merged[0]["weight"] - 2.0) < 1e-9, merged  # 16 x 0.5 x 0.5 x 0.5

    # -- colors never merge; duplicate labels fail loud -----------------------
    two_colors = _book([_entry(FEN_A, "1.d4", 1, "white", 3),
                        _entry(FEN_A, "1.d4", 1, "black", 5)])
    merged = merge([{"label": "cc", "doc": two_colors}], as_of=as_of)
    assert len(merged) == 2, "same FEN, different rival color = distinct nodes"
    try:
        merge([{"label": "x", "doc": _book([])}, {"label": "x", "doc": _book([])}],
              as_of=as_of)
        raise AssertionError("duplicate labels must be rejected")
    except ValueError:
        pass

    # -- output document is a consumable book.json ---------------------------
    doc = to_document(merged, {"rival": "dad", "sources": [
        {"label": "cc", "path": "x.json"}]}, as_of)
    assert doc["version"] == 2
    assert doc["merge"]["as_of"] == "2026-07-15"
    assert doc["stats"]["positions"] == 2
    for e in doc["entries"]:
        assert set(e) >= {"fen", "line", "ply", "rival_color", "weight"}

    print("merge_books.py self-test: all checks passed")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("manifest", nargs="?", help="merge manifest JSON")
    ap.add_argument("--out", type=Path, help="override the manifest's out path")
    ap.add_argument("--as-of", help="merge reference date YYYY-MM-DD (default: today UTC); "
                                    "pin it for reproducible merges")
    ap.add_argument("--self-test", action="store_true", help="run built-in checks, no I/O")
    args = ap.parse_args()
    if args.self_test:
        return self_test()
    if not args.manifest:
        ap.error("manifest required (or --self-test)")
    run(Path(args.manifest), args.out, args.as_of)
    return 0


if __name__ == "__main__":
    sys.exit(main())
