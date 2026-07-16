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

Arena half (spec 218 own-persona entry / spec 217 Promise 1): the same two
artifacts, staged server-side, put "You" in the owner's arena lobby via the
existing private-persona gating (dad's mechanism — server/arena/app/config.py
PRIVATE_PERSONAS + persona.load_private_roster). Export steps:

  1. Build (run this script with no args), then run
         build_self_persona.py --arena-staging
     to print the staging list (paths + sha256) for the deploy agent.
  2. scp self.config.json + self.book.json into the arena host's
     server/arena/private-personas/ mount (gitignored — never committed,
     never bundled; spec 214 hard rule).
  3. Drop the config's Maia net (maia-<band>.pb.gz; pinned sha and download
     URL in the staging list) into the server/arena/nets/ mount. The server
     verifies it against config.MAIA_NET_SHA256 at startup and skips the
     persona on mismatch.
  4. Append "<owner-email>:self" to ARENA_PRIVATE_PERSONAS in
     server/arena/.env (email = the owner's arena Google account; env-only —
     no private identity in code or git) and restart the container. The "You"
     entry then appears in that account's lobby and nobody else's.
"""
import hashlib
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


# Pinned Maia-net digests, copied from apps/desktop/src-tauri/src/maia.rs
# CHECKSUMS (our own record of the CSSLab v1.0 release bytes; mirrored in
# server/arena/app/config.py MAIA_NET_SHA256 — three copies by design, each
# side verifies independently with no cross-runtime import).
MAIA_NET_SHA256 = {
    1100: "e1cf1cd0c96b8a4fa6a275f4b9fd54ed1ffebf9fe44641b9fceded310e9619c4",
    1200: "ead4ba953f233ae732999ebc1e2b675378148527ebcfad2f0acbc5e4c224d98e",
    1300: "36195f87bf4761834baa0bf87472b18509a7261a9d7d6f1a8443261369a733f2",
    1400: "d5353ea6766356dad2d28920c6692f37a5f30963767f1a3105d33b4d0af011e8",
    1500: "35ab6f20421d59e1df3b17c5a5016947af4c6761368ef84044a9a9c7619a9a00",
    1600: "d2c9e5948581acf4b9fc0b1e720c5dc0fe64ce80cfc4a239d3f8a42e1176c876",
    1700: "d277eacd792d340a30abb464dc65127254e65cac57abca17facc469889b96478",
    1800: "0031ad7c4256b1fd09fbebd28418d644d68b26cd2a45df4967ccf5c7ec9c4965",
    1900: "e2f565f42d7cd9f122557e6dc4eb84e5bbaedceda1d404dc485d3611c7c97a12",
}
MAIA_RELEASE_BASE = "https://github.com/CSSLab/maia-chess/releases/download/v1.0"
# The desktop app's net cache — a net already downloaded locally can be scp'd
# from here instead of re-downloaded (same bytes, verified either way).
MAIA_LOCAL_CACHE = (Path.home() / "Library" / "Application Support"
                    / "com.hjalti.chessgui" / "maia")


def nearest_band(rating: int) -> int:
    return min(MAIA_BANDS, key=lambda b: abs(b - rating))


def assert_gitignored() -> None:
    r = subprocess.run(["git", "-C", str(REPO), "check-ignore", "-q",
                        "data/rivals/self.config.json"])
    if r.returncode != 0:
        raise SystemExit("REFUSING: data/rivals is not gitignored — the self "
                         "persona must never be committable (spec 214).")


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def arena_staging() -> int:
    """Print the deploy-agent staging list (paths + sha256) for the arena
    half of the spec-218 own-persona entry. Reads the built artifacts —
    run the build first. Deliberately prints no email: the owner-email:slug
    pair is env-only on the server (spec 214: no private identity in git)."""
    cfg_path, book_path = R / "self.config.json", R / "self.book.json"
    missing = [str(p) for p in (cfg_path, book_path) if not p.exists()]
    if missing:
        print(f"error: build first — missing {', '.join(missing)}",
              file=sys.stderr)
        return 1
    cfg = json.loads(cfg_path.read_text())
    band = cfg["backend"]["level"]
    net_name = cfg["backend"]["net"]
    cached = MAIA_LOCAL_CACHE / net_name

    print("arena staging list (spec 218 own-persona entry — hand to the "
          "deploy agent):")
    print()
    print("  copy to server/arena/private-personas/ (host mount; gitignored):")
    for p in (cfg_path, book_path):
        print(f"    {p}")
        print(f"      sha256 {_sha256(p)}")
    print()
    print("  copy to server/arena/nets/ (host mount; verified at startup):")
    print(f"    {net_name}")
    print(f"      sha256 {MAIA_NET_SHA256[band]}  (pinned, maia.rs CHECKSUMS)")
    if cached.exists():
        print(f"      local copy: {cached}")
    else:
        print(f"      download: {MAIA_RELEASE_BASE}/{net_name}")
    print()
    print("  server/arena/.env:")
    print("    ARENA_PRIVATE_PERSONAS += \"<owner-email>:self\"  "
          "(owner's arena Google account; comma-separated pairs)")
    print()
    print("  then: docker compose restart; check /health private_personas "
          "count and the startup log for '[persona] private' skips.")
    return 0


def main() -> int:
    if "--arena-staging" in sys.argv[1:]:
        return arena_staging()
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
