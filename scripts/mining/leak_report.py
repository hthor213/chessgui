#!/usr/bin/env python3
"""leak_report.py — spec 211 opening-leak report over the user's OWN games.

"Which openings do YOU bleed eval in" (specs/211-avoidance-puzzles.md:180-189,
000:114): per-opening aggregation of the user's eval drops inside the opening
phase (first --max-ply plies, default 20 = "don't be -1 by move 10"). Reuses
the mining pipeline: pgnstream for streaming PGN, mine_cliffs.parse_movetext
for movetext/[%eval] parsing, uciengine for the engine pass.

Eval sourcing (in order, per game):
  1. [%eval] tags already in the PGN — free, always used when present.
  2. A bounded quick engine pass for untagged games (chess.com archives carry
     no evals): fixed shallow depth over the opening plies only, newest games
     first, hard-capped at --limit games. No --engine => untagged games are
     skipped and counted, never silently analyzed.

Spec 219 (active-game lockout) note: this is a CLI report over COMPLETED
games — unfinished games (Result "*") are skipped outright, so no active
game is ever engine-analyzed. When this report gets UI surfacing (deferred),
the trigger must route through the app's gated engine layer, not shell out.

Per opening (ECO x the user's color) the report aggregates: games, user
moves evaluated, cp bled per game / per move (drops only, gains ignored),
leak count (single-move drops >= --leak-threshold), average eval at the end
of the opening window (user's perspective), score %, and the worst single
leak with its game link.

Output: <user>.leaks.md + <user>.leaks.json in --out-dir (default
data/rivals/, alongside the other dossier artifacts).

Requires `python-chess` (same deviation as mine_cliffs.py — SAN replay).

Typical invocation:
    python3 scripts/mining/leak_report.py --pgn data/rivals/hjaltth.pgn \\
        --user hjaltth --engine /opt/homebrew/bin/stockfish \\
        --depth 12 --limit 300
"""

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone

import pgnstream
from pgnstream import iter_games, pgn_lines
from mine_cliffs import parse_movetext
from uciengine import MATE_CP, UciEngine

try:
    import chess
except ImportError:
    sys.exit("[leak_report] python-chess is required for SAN replay:\n"
             "  python3 -m pip install --user python-chess")

GENERATOR = "leak_report.py v1"
FINISHED_RESULTS = {"1-0", "0-1", "1/2-1/2"}
SCORE = {"1-0": {"white": 1.0, "black": 0.0},
         "0-1": {"white": 0.0, "black": 1.0},
         "1/2-1/2": {"white": 0.5, "black": 0.5}}
# Single-move drops are capped so one allowed-mate doesn't drown the means.
DROP_CAP_CP = 1000

ECOURL_RE = re.compile(r"/openings/([^/?#]+)")
MOVEISH_RE = re.compile(r"\d")  # slug words carrying digits are move detail


def header(headers, key):
    v = headers.get(key.encode())
    return v.decode("utf-8", "replace") if v is not None else None


def opening_name(headers):
    """Human opening name: Opening header (lichess) or the ECOUrl slug
    (chess.com) with trailing move-detail words ("3.d3-d6") trimmed."""
    name = header(headers, "Opening")
    if name and name != "?":
        return name
    m = ECOURL_RE.search(header(headers, "ECOUrl") or "")
    if not m:
        return None
    words = m.group(1).split("-")
    while words and MOVEISH_RE.search(words[-1]):
        words.pop()
    return " ".join(words) or None


def user_color(headers, user):
    u = user.lower()
    if (header(headers, "White") or "").lower() == u:
        return "white"
    if (header(headers, "Black") or "").lower() == u:
        return "black"
    return None


def game_drops(evals, color, max_ply):
    """Per-user-move opening drops from white-perspective cp evals.

    evals[i] = eval after ply i (parse_movetext convention; index 0 = the
    first move). Drop for the move at ply i needs evals[i-1] and evals[i],
    so ply 0 is never scored — same convention as mine_cliffs'
    find_candidates. Returns (drops, end_eval_user_cp) where drops is
    [(ply, drop_cp >= 0), ...] for the user's moves only, and end_eval is
    the last known eval in the window from the user's perspective."""
    sign = 1 if color == "white" else -1
    end = min(len(evals), max_ply)
    drops = []
    end_eval = None
    for i in range(end):
        if evals[i] is not None:
            end_eval = sign * max(-DROP_CAP_CP, min(DROP_CAP_CP, evals[i]))
        mover_is_user = (i % 2 == 0) == (color == "white")
        if not mover_is_user or i == 0:
            continue
        eb, ea = evals[i - 1], evals[i]
        if eb is None or ea is None:
            continue
        drop = sign * (eb - ea)
        if drop > 0:
            drops.append((i, min(drop, DROP_CAP_CP)))
    return drops, end_eval


def engine_evals(engine, sans, depth, max_ply):
    """White-perspective cp evals after plies 0..min(max_ply,len)-1, engine
    at fixed depth. Returns the list, or None if SAN replay fails."""
    board = chess.Board()
    ucis = []
    try:
        for san in sans[:max_ply]:
            ucis.append(board.push_san(san).uci())
    except ValueError:
        return None
    evals = []
    for i in range(1, len(ucis) + 1):
        res = engine.search(chess.STARTING_FEN, depth, moves=ucis[:i])
        if res is None or 1 not in res:      # terminal: stm has no moves
            b = chess.Board()
            for u in ucis[:i]:
                b.push_uci(u)
            stm_cp = -MATE_CP if b.is_checkmate() else 0
        else:
            stm_cp = res[1].cp
        evals.append(stm_cp if i % 2 == 0 else -stm_cp)
    return evals


def collect_games(path, user, max_ply):
    """Stream the PGN, return light per-game records for the user's finished
    games (newest first) + skip stats. No Filter: personal archives aren't
    lichess-corpus-shaped (chess.com Event is 'Live Chess', not 'Rated')."""
    records = []
    skipped = {"not_user": 0, "unfinished": 0, "parse": 0, "too_short": 0}
    for headers, text, _reject, has_eval in iter_games(pgn_lines(path)):
        color = user_color(headers, user)
        if color is None:
            skipped["not_user"] += 1
            continue
        result = header(headers, "Result")
        if result not in FINISHED_RESULTS:
            skipped["unfinished"] += 1  # spec 219: never touch a live game
            continue
        movetext = " ".join(
            ln for ln in text.decode("utf-8", "replace").splitlines()
            if not ln.startswith("["))
        parsed = parse_movetext(movetext)
        if parsed is None:
            skipped["parse"] += 1
            continue
        sans, evals, _clks = parsed
        if len(sans) < 4:
            skipped["too_short"] += 1
            continue
        records.append({
            "color": color,
            "eco": header(headers, "ECO") or "?",
            "name": opening_name(headers),
            "score": SCORE[result][color],
            "date": header(headers, "UTCDate") or header(headers, "Date")
            or "",
            "time": header(headers, "UTCTime") or "",
            "link": header(headers, "Link") or header(headers, "Site") or "",
            "sans": sans[:max_ply],
            "evals": evals[:max_ply],
            "tagged": any(e is not None for e in evals[:max_ply]),
        })
    records.sort(key=lambda r: (r["date"], r["time"]), reverse=True)
    return records, skipped


def aggregate(analyzed, leak_threshold):
    """(record, evals) pairs -> {eco|color: aggregate row}."""
    agg = {}
    for rec, evals in analyzed:
        drops, end_eval = game_drops(evals, rec["color"], len(evals) + 1)
        key = f'{rec["eco"]}|{rec["color"]}'
        row = agg.setdefault(key, {
            "eco": rec["eco"], "color": rec["color"], "names": {},
            "games": 0, "moves": 0, "bled_cp": 0, "leaks": 0,
            "score_sum": 0.0, "end_eval_sum": 0, "end_eval_games": 0,
            "worst": None,
        })
        row["games"] += 1
        row["score_sum"] += rec["score"]
        if rec["name"]:
            row["names"][rec["name"]] = row["names"].get(rec["name"], 0) + 1
        if end_eval is not None:
            row["end_eval_sum"] += end_eval
            row["end_eval_games"] += 1
        # moves = the user's scoreable moves (both-side evals present)
        row["moves"] += sum(
            1 for i in range(1, len(evals))
            if (i % 2 == 0) == (rec["color"] == "white")
            and evals[i - 1] is not None and evals[i] is not None)
        for ply, drop in drops:
            row["bled_cp"] += drop
            if drop >= leak_threshold:
                row["leaks"] += 1
            if row["worst"] is None or drop > row["worst"]["drop_cp"]:
                row["worst"] = {
                    "drop_cp": drop,
                    "san": rec["sans"][ply],
                    "move_number": ply // 2 + 1,
                    "date": rec["date"],
                    "link": rec["link"],
                }
    for row in agg.values():
        names = row.pop("names")
        row["name"] = max(names, key=names.get) if names else None
    return agg


def finish_rows(agg):
    rows = []
    for row in agg.values():
        g = row["games"]
        rows.append({
            **{k: row[k] for k in ("eco", "color", "name", "games", "moves",
                                   "bled_cp", "leaks", "worst")},
            "bled_cp_per_game": round(row["bled_cp"] / g, 1),
            "acpl_opening": (round(row["bled_cp"] / row["moves"], 1)
                             if row["moves"] else None),
            "leaks_per_game": round(row["leaks"] / g, 2),
            "score_pct": round(100.0 * row["score_sum"] / g, 1),
            "avg_end_eval_cp": (round(row["end_eval_sum"]
                                      / row["end_eval_games"])
                                if row["end_eval_games"] else None),
        })
    rows.sort(key=lambda r: (-r["bled_cp_per_game"], -r["games"]))
    return rows


def eval_str(cp):
    return "—" if cp is None else f"{cp / 100:+.2f}"


def write_markdown(path, rows, meta, min_games):
    ranked = [r for r in rows if r["games"] >= min_games]
    tail = [r for r in rows if r["games"] < min_games]
    L = [f"# Opening leaks — {meta['user']}", ""]
    L.append(f"Where **{meta['user']}** bleeds eval in the first "
             f"{meta['params']['max_ply']} plies (move "
             f"{meta['params']['max_ply'] // 2}), per opening and color. "
             "Only eval LOST on the user's own moves counts; gains are "
             "ignored. A **leak** is a single move dropping ≥ "
             f"{meta['params']['leak_threshold_cp']} cp.")
    L.append("")
    L.append(f"- Games analyzed: **{meta['games_analyzed']}** "
             f"({meta['games_tagged']} with [%eval] tags, "
             f"{meta['games_engine']} via engine pass"
             + (f" at depth {meta['params']['depth']}"
                if meta['games_engine'] else "") + ")")
    if meta["games_skipped_untagged"]:
        L.append(f"- Untagged games not analyzed (engine budget "
                 f"--limit {meta['params']['limit']}"
                 + ("" if meta["params"]["engine"] else ", no --engine")
                 + f"): {meta['games_skipped_untagged']} — newest games "
                 "were analyzed first")
    L.append(f"- Skipped: {meta['skipped']}")
    L.append("")
    L.append(f"## Ranked leaks (openings with ≥ {min_games} games)")
    L.append("")
    L.append("| Opening | ECO | As | Games | cp bled/game | ACPL (open) | "
             "Leaks | Leaks/game | Avg eval @ window end | Score % |")
    L.append("|---|---|---|---:|---:|---:|---:|---:|---:|---:|")
    for r in ranked:
        L.append(f"| {r['name'] or '?'} | {r['eco']} | {r['color']} "
                 f"| {r['games']} | {r['bled_cp_per_game']} "
                 f"| {r['acpl_opening'] if r['acpl_opening'] is not None else '—'} "
                 f"| {r['leaks']} | {r['leaks_per_game']} "
                 f"| {eval_str(r['avg_end_eval_cp'])} | {r['score_pct']} |")
    if not ranked:
        L.append("| _no opening has enough analyzed games yet_ | | | | | | | | | |")
    L.append("")
    L.append("## Worst single leaks")
    L.append("")
    worst = sorted((r for r in rows if r["worst"]),
                   key=lambda r: -r["worst"]["drop_cp"])[:10]
    for r in worst:
        w = r["worst"]
        L.append(f"- **-{w['drop_cp'] / 100:.1f}** on {w['move_number']}."
                 f"{'..' if r['color'] == 'black' else ''}{w['san']} — "
                 f"{r['name'] or r['eco']} ({r['color']}), {w['date']}"
                 + (f" — {w['link']}" if w["link"] else ""))
    if not worst:
        L.append("- _none found_")
    if tail:
        L.append("")
        L.append(f"_{len(tail)} openings with < {min_games} games are in the "
                 "JSON long tail, not ranked here._")
    L.append("")
    L.append("_UI surfacing of this report is deferred (spec 211 opening-"
             "rake box). When it lands, engine calls must go through the "
             "app's spec-219-gated engine layer._")
    L.append("")
    L.append(f"_Generated by {GENERATOR} on {meta['created_at']}._")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(L) + "\n")


def parse_args():
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--pgn", required=True, help="User's full-history PGN")
    p.add_argument("--user", required=True,
                   help="Username as it appears in White/Black headers "
                        "(case-insensitive)")
    p.add_argument("--engine", default=None,
                   help="UCI engine path for untagged games; omit to use "
                        "only games that already carry [%%eval] tags.")
    p.add_argument("--depth", type=int, default=12,
                   help="Engine depth for the quick pass (default 12 — "
                        "opening positions, shallow is fine).")
    p.add_argument("--limit", type=int, default=200,
                   help="Max untagged games sent to the engine, newest "
                        "first (default 200; 0 = none). Tagged games are "
                        "free and never counted.")
    p.add_argument("--max-ply", type=int, default=20,
                   help="Opening window in plies (default 20 = spec 211's "
                        "'don't be -1 by move 10').")
    p.add_argument("--leak-threshold", type=int, default=100,
                   help="Single-move drop counted as a leak, cp "
                        "(default 100).")
    p.add_argument("--min-games", type=int, default=3,
                   help="Games needed for an opening to be ranked in the "
                        "markdown table (default 3; the rest go to the "
                        "JSON long tail).")
    p.add_argument("--threads", type=int, default=1,
                   help="Engine Threads (default 1).")
    p.add_argument("--hash-mb", type=int, default=64,
                   help="Engine Hash MB (default 64).")
    p.add_argument("--out-dir", default="data/rivals",
                   help="Output dir for <user>.leaks.{md,json} "
                        "(default data/rivals).")
    p.add_argument("--progress-every", type=int, default=25,
                   help="stderr progress line every N engine games "
                        "(0 = off).")
    p.add_argument("--no-nice", action="store_true",
                   help="Don't renice to 19 (default: self-nice, pipeline "
                        "convention).")
    return p.parse_args()


def main():
    args = parse_args()
    if not args.no_nice:
        try:
            os.nice(19)
        except OSError:
            pass
    started = time.time()

    records, skipped = collect_games(args.pgn, args.user, args.max_ply)
    print(f"[leak_report] {len(records)} finished games for {args.user} "
          f"(skipped: {skipped})", file=sys.stderr)

    analyzed = []          # (record, white-persp evals)
    n_engine = 0
    skipped_untagged = 0
    engine = None
    try:
        for rec in records:
            if rec["tagged"]:
                analyzed.append((rec, rec["evals"]))
                continue
            if args.engine is None or n_engine >= args.limit:
                skipped_untagged += 1
                continue
            if engine is None:
                engine = UciEngine(args.engine, threads=args.threads,
                                   hash_mb=args.hash_mb)
            evals = engine_evals(engine, rec["sans"], args.depth,
                                 args.max_ply)
            if evals is None:
                skipped["parse"] += 1
                continue
            n_engine += 1
            analyzed.append((rec, evals))
            if args.progress_every and n_engine % args.progress_every == 0:
                el = time.time() - started
                print(f"  [leak_report] engine games {n_engine}/"
                      f"{min(args.limit, len(records))} | {el:.0f}s",
                      file=sys.stderr, flush=True)
    finally:
        if engine is not None:
            engine.close()

    rows = finish_rows(aggregate(analyzed, args.leak_threshold))
    meta = {
        "user": args.user,
        "pgn": os.path.abspath(args.pgn),
        "games_analyzed": len(analyzed),
        "games_tagged": len(analyzed) - n_engine,
        "games_engine": n_engine,
        "games_skipped_untagged": skipped_untagged,
        "skipped": skipped,
        "params": {"depth": args.depth, "limit": args.limit,
                   "max_ply": args.max_ply,
                   "leak_threshold_cp": args.leak_threshold,
                   "min_games": args.min_games,
                   "engine": args.engine},
        "generator": GENERATOR,
        "elapsed_seconds": round(time.time() - started, 1),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }

    os.makedirs(args.out_dir, exist_ok=True)
    stem = os.path.join(args.out_dir, args.user.lower())
    with open(stem + ".leaks.json", "w", encoding="utf-8") as f:
        json.dump({"meta": meta, "openings": rows}, f, indent=2)
    write_markdown(stem + ".leaks.md", rows, meta, args.min_games)
    print(f"[leak_report] wrote {stem}.leaks.md + .json "
          f"({len(rows)} openings, {meta['elapsed_seconds']}s)",
          file=sys.stderr)


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        pgnstream.exit_on_broken_pipe()
