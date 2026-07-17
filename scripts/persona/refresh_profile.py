#!/usr/bin/env python3
"""Spec 225: refresh a rival's derived artifacts when the corpus changed.

For each pipeline-built profile (a <slug>.profile.json with a `sample`
verdict — the build_player_profile.py record), compare the corpus PGN's
mtime against the derived stats.json/book.json. When the PGN is newer (new
games landed) or a derived artifact is missing, rerun the pipeline FROM THE
STORED RECORD — name, aliases, unverified-event rule, dossier-only reason,
rating override — so a refresh never silently drops the honesty flags the
original run carried. Otherwise do nothing. Idempotent: a second run right
after a refresh prints up-to-date for every slug.

Legacy rivals (pre-pipeline chess.com dumps in profile.json) are skipped
with a printed reason — regenerating THEIR stats.json would change its shape
under consumers; run build_player_profile.py deliberately to migrate one.

Usage:
    refresh_profile.py <slug> [<slug>...]
    refresh_profile.py --all              # every pipeline profile in data/rivals
    refresh_profile.py --self-test
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import build_player_profile as bpp

# Auto-generated dossier-only reason (sample_verdict) vs an operator-provided
# --dossier-only REASON: only the latter must be replayed on refresh.
_AUTO_DOSSIER_RE = re.compile(r"^\d+ verified games < persona minimum \d+$")


def load_pipeline_profile(rivals: Path, slug: str) -> dict | None:
    p = rivals / f"{slug}.profile.json"
    if not p.exists():
        return None
    try:
        doc = json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    return doc if isinstance(doc, dict) and isinstance(doc.get("sample"), dict) else None


def options_from_profile(rivals: Path, profile: dict) -> bpp.Options:
    """Reconstruct the pipeline Options from the stored profile record.
    Online usernames become ALIASES (matching PGN headers), never fetch
    sources — a refresh is offline, corpus-in -> artifacts-out."""
    slug = profile["slug"]
    sample = profile["sample"]
    identity = profile.get("identity") or {}
    aliases = [u for u in (identity.get("chesscom"), identity.get("lichess")) if u]

    rating = profile.get("rating") or {}
    src = rating.get("source") or ""
    # Corpus-derived (or absent) ratings are recomputed; operator overrides
    # (--rating/--rating-source) are replayed verbatim.
    replay_rating = rating.get("value") is not None and not src.startswith("corpus Elo headers")

    dossier_only = None
    if sample.get("verdict") == bpp.VERDICT_DOSSIER:
        first = (sample.get("reasons") or [None])[0]
        if first and not _AUTO_DOSSIER_RE.match(first):
            dossier_only = first

    book_path = rivals / f"{slug}.book.json"
    max_ply = bpp.book_builder.MAX_PLY
    if book_path.exists():
        try:
            max_ply = int(json.loads(book_path.read_text(encoding="utf-8"))["max_ply"])
        except (json.JSONDecodeError, KeyError, TypeError, ValueError):
            pass

    return bpp.Options(
        name=profile["display_name"],
        slug=slug,
        fide_id=identity.get("fide_id"),
        pgns=[rivals / f"{slug}.pgn"],
        aliases=aliases,
        out_dir=rivals,
        rating=rating.get("value") if replay_rating else None,
        rating_source=rating.get("source") if replay_rating else None,
        relationship=profile.get("relationship") or "player",
        unverified_event=sample.get("unverified_rule"),
        dossier_only=dossier_only,
        max_ply=max_ply,
    )


def refresh(rivals: Path, slug: str) -> str:
    """Returns what happened: 'refreshed' | 'up-to-date' | a skip reason."""
    pgn = rivals / f"{slug}.pgn"
    if not pgn.exists():
        return f"skipped: no {slug}.pgn corpus"
    profile = load_pipeline_profile(rivals, slug)
    if profile is None:
        return "skipped: not a pipeline profile (legacy artifacts) — run build_player_profile.py to migrate"

    derived = [rivals / f"{slug}.stats.json", rivals / f"{slug}.book.json"]
    stale = [d.name for d in derived if not d.exists() or d.stat().st_mtime < pgn.stat().st_mtime]
    if not stale:
        return "up-to-date"

    bpp.run_pipeline(options_from_profile(rivals, profile))
    return f"refreshed ({', '.join(stale)} were older than the corpus)"


def self_test() -> int:
    import tempfile
    import time

    ok = True

    def check(cond: bool, msg: str):
        nonlocal ok
        print(f"  [{'PASS' if cond else 'FAIL'}] {msg}")
        if not cond:
            ok = False

    with tempfile.TemporaryDirectory(prefix="refresh-selftest-") as td_s:
        td = Path(td_s)
        name = "Testy Refresh"
        slug = "testy-refresh"
        pgn = td / f"{slug}.pgn"
        pgn.write_text(bpp._fixture_pgn(12, name), encoding="utf-8")
        bpp.run_pipeline(bpp.Options(name=name, slug=slug, pgns=[pgn], out_dir=td))

        check(refresh(td, slug) == "up-to-date", "fresh artifacts -> up-to-date")

        # Corpus grows: pgn newer than the derived artifacts -> refresh, and
        # the new sample verdict reflects the new count.
        time.sleep(1.1)  # mtime granularity
        pgn.write_text(bpp._fixture_pgn(32, name), encoding="utf-8")
        check(refresh(td, slug).startswith("refreshed"), "newer pgn -> refreshed")
        prof = json.loads((td / f"{slug}.profile.json").read_text(encoding="utf-8"))
        check(prof["sample"]["games"] == 32, "refresh recounts the corpus (32 games)")
        check(prof["sample"]["verdict"] == bpp.VERDICT_FULL, "32 games -> verdict full")
        check(refresh(td, slug) == "up-to-date", "idempotent: second run is a no-op")

        # An operator --dossier-only reason survives the refresh.
        bpp.run_pipeline(bpp.Options(name=name, slug=slug, pgns=[pgn], out_dir=td,
                                     dossier_only="STAGING: review pending"))
        time.sleep(1.1)
        pgn.write_text(bpp._fixture_pgn(33, name), encoding="utf-8")
        check(refresh(td, slug).startswith("refreshed"), "staged corpus refreshes too")
        prof = json.loads((td / f"{slug}.profile.json").read_text(encoding="utf-8"))
        check(prof["sample"]["verdict"] == bpp.VERDICT_DOSSIER
              and "STAGING: review pending" in prof["sample"]["reasons"],
              "refresh replays the stored --dossier-only reason")

        # Legacy (non-pipeline) profiles are skipped, never overwritten.
        legacy = td / "legacy-guy.profile.json"
        legacy.write_text('{"username": "legacy-guy"}', encoding="utf-8")
        (td / "legacy-guy.pgn").write_text(bpp._fixture_pgn(3, "Legacy Guy"), encoding="utf-8")
        check(refresh(td, "legacy-guy").startswith("skipped: not a pipeline profile"),
              "legacy profile skipped")
        check(legacy.read_text(encoding="utf-8") == '{"username": "legacy-guy"}',
              "legacy profile untouched")

    return 0 if ok else 1


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Regenerate a rival's stats/book (full pipeline rerun) when the corpus PGN is newer.")
    ap.add_argument("slugs", nargs="*", help="rival slugs (e.g. arnthor-einarsson)")
    ap.add_argument("--all", action="store_true",
                    help="refresh every pipeline profile found in data/rivals")
    ap.add_argument("--rivals-dir", type=Path, default=bpp.RIVALS_DIR)
    ap.add_argument("--self-test", action="store_true", help="run built-in checks and exit")
    args = ap.parse_args()

    if args.self_test:
        print("refresh_profile self-test:")
        return self_test()

    rivals = args.rivals_dir
    slugs = list(args.slugs)
    if args.all:
        slugs += sorted(p.name.removesuffix(".profile.json") for p in rivals.glob("*.profile.json")
                        if load_pipeline_profile(rivals, p.name.removesuffix(".profile.json"))
                        and p.name.removesuffix(".profile.json") not in slugs)
    if not slugs:
        ap.error("pass slugs or --all (or use --self-test)")

    for slug in slugs:
        print(f"{slug}: {refresh(rivals, slug)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
