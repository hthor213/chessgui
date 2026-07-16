#!/usr/bin/env python3
"""Spec 218 "Own-persona entry": build the local player's SELF persona.

The user's own games live in data/rivals/ (gitignored) under the hjaltth
account archive, plus a handful of recent user-vs-rival games that so far exist
only in the rival's archive (thjaltason.pgn) — build_rival_book's username
matching harvests only the hjaltth side from either file, so including both is
safe and duplicates nothing (verified 2026-07-15: zero Link-header overlap).

Emits, next to the other private personas (never committed — spec 214 hard rule):
  - data/rivals/self.book.json    (the user's own opening book, rival pipeline)
  - data/rivals/self.config.json  (kind "self" — lib/roster.ts gates the "You"
                                   roster entry on this config + its book)

The Maia band comes from the self-report's measured move-quality estimate
(data/rivals/SELF_REPORT.md: rapid quadratic-fit peak ~1198, engaged games) —
NOT from the displayed chess.com rating, which the report shows understates
move quality by 600+ points. Unlike the friends/family configs this band IS
measured (Maia policy-head on 1,224 real games), and the label says so.

Refuses to run if data/rivals is not gitignored (same guard as
build_rival_configs.py).
"""
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_rival_book import build, to_document, MAX_PLY  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
R = REPO / "data" / "rivals"

# The user's chess.com username; matched (case-insensitively) against the
# White/Black headers, so games in the rival's archive where the user is not
# a player are skipped automatically.
SELF_USERNAME = "hjaltth"
SOURCES = [
    (SELF_USERNAME, R / "hjaltth.pgn"),
    (SELF_USERNAME, R / "thjaltason.pgn"),
]

MAIA_BANDS = [1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900]
# SELF_REPORT.md headline: rapid (deliberate play) quadratic-fit peak 1198,
# bootstrap 90% interval 1100-1304. Rapid over blitz: the spar surface is
# untimed, so deliberate-play strength is the honest number.
SELF_MAIA_ESTIMATE = 1198
SELF_ESTIMATE_SOURCE = (
    "Maia policy-head move-quality estimate, rapid engaged games "
    "(data/rivals/SELF_REPORT.md, 2026-07-14): peak 1198, 90% CI 1100-1304"
)


def nearest_band(rating: int) -> int:
    return min(MAIA_BANDS, key=lambda b: abs(b - rating))


def assert_gitignored() -> None:
    r = subprocess.run(["git", "-C", str(REPO), "check-ignore", "-q",
                        "data/rivals/self.config.json"])
    if r.returncode != 0:
        raise SystemExit("REFUSING: data/rivals is not gitignored — the self "
                         "persona must never be committable (spec 214).")


def main() -> int:
    assert_gitignored()
    missing = [str(p) for _, p in SOURCES if not p.exists()]
    if missing:
        print(f"error: source PGN(s) not found: {', '.join(missing)}", file=sys.stderr)
        return 1

    entries, stats = build(SOURCES, max_ply=MAX_PLY)
    book = to_document(entries, stats, rival="self", max_ply=MAX_PLY)
    book_path = R / "self.book.json"
    book_path.write_text(json.dumps(book, indent=1), encoding="utf-8")
    print(f"wrote {book_path}")
    print(f"  {stats.used}/{stats.games} games used "
          f"({stats.skipped_non_standard} non-standard, "
          f"{stats.skipped_rival_absent} self absent)")
    print(f"  {book['stats']['positions']} unique positions "
          f"({book['stats']['white_positions']} white, "
          f"{book['stats']['black_positions']} black)")

    band = nearest_band(SELF_MAIA_ESTIMATE)
    cfg = {
        "version": 1,
        "slug": "self",
        "display_name": "You",
        "kind": "self",
        "relationship": "self",
        "book": {"path": "data/rivals/self.book.json",
                 "max_ply": book["max_ply"],
                 "positions": book["stats"]["positions"],
                 "games": book["stats"]["games_used"]},
        "backend": {"kind": "maia", "level": band,
                    "net": f"maia-{band}.pb.gz"},
        "runnable_in_engine_v1": True,   # Maia band = persona_move's native path
        "sampling": {
            "level": band,
            "temperature": 0.5,
            "alpha": 1.0,
            "lambda": 0.75,
            "top_k": 4,
            "verify_depth": 12,
        },
        "strength_label": {
            "kind": "book + Maia band, Maia-estimated",
            "maia_band": band,
            "band_source": f"{SELF_ESTIMATE_SOURCE} -> nearest Maia band",
            "note": "Band is the self-report's measured Maia move-quality "
                    "estimate (not the displayed chess.com rating, which the "
                    "report shows understates move quality).",
        },
        "private": True,
    }
    cfg_path = R / "self.config.json"
    with open(cfg_path, "w") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"wrote {cfg_path}  band=maia-{band} (PRIVATE, gitignored)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
