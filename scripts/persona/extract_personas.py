#!/usr/bin/env python3
"""Spec 214 phase 1: extract Fischer + Kasparov persona datasets from the app DB.

Reads the app's SQLite games DB (read-only), pulls every game for each persona,
reconstructs full-header PGN (incl. Elos), applies per-player metadata dedup,
excludes data-quality rejects, validates every kept game with python-chess,
and writes {persona}.pgn plus seeded 80/20 train/eval splits into data/personas/.
"""
import sqlite3, sys, io, os, random, collections
import chess, chess.pgn

DB = os.path.expanduser("~/Library/Application Support/com.hjalti.chessgui/games.db")
OUT = "/Users/hjalti/GitHub/chessgui/data/personas"
SEED = 214
EVAL_FRAC = 0.20

# "Fischer, Robert J" (11 games, all 2025 World Senior 65+/Atlantic Open) is a
# namesake AMATEUR, not the world champion (d. 2008-01-17, last games 1992).
# Excluded by name — do NOT use the naive 'Fischer, Robert%' filter.
PERSONAS = {
    "fischer": ["Fischer, Robert James"],
    "kasparov": ["Kasparov, Garry"],
}

COLS = ["id","white","black","white_elo","black_elo","event","site","round",
        "date","eco","result","ply_count","source","pgn_moves"]

def esc(s): return (s or "").replace("\\","\\\\").replace('"','\\"')

def build_pgn(r):
    """Full-header PGN string from a games row (dict)."""
    h = []
    def tag(k,v): h.append(f'[{k} "{esc(str(v))}"]')
    tag("Event", r["event"]); tag("Site", r["site"]); tag("Date", r["date"])
    tag("Round", r["round"]); tag("White", r["white"]); tag("Black", r["black"])
    tag("Result", r["result"] or "*")
    if r["white_elo"] is not None: tag("WhiteElo", r["white_elo"])
    if r["black_elo"] is not None: tag("BlackElo", r["black_elo"])
    if r["eco"]: tag("ECO", r["eco"])
    body = (r["pgn_moves"] or "").strip()
    return "\n".join(h) + "\n\n" + body + "\n"

def main():
    c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    summary = {}
    for persona, names in PERSONAS.items():
        ph = ",".join("?"*len(names))
        q = (f"SELECT {','.join(COLS)} FROM games "
             f"WHERE white IN ({ph}) OR black IN ({ph})")
        rows = [dict(r) for r in c.execute(q, names+names).fetchall()]
        raw_n = len(rows)

        # --- data-quality classification ---
        excluded = []   # (id, reason)
        candidates = []
        for r in rows:
            body = (r["pgn_moves"] or "").strip()
            # strip a trailing result token to see if any moves remain
            toks = body.replace("1-0","").replace("0-1","").replace("1/2-1/2","").replace("*","").strip()
            if r["ply_count"] == 0 or toks == "":
                excluded.append((r["id"], "no_movetext"))
                continue
            candidates.append(r)

        # --- per-player dedup on the MAINLINE move sequence ---
        # The DB already dedups exact (mainline+result) at import via dup_hash, and
        # everything here is one source. A metadata key (date+opponent+result+
        # plycount) FALSELY collapses distinct games that share a partial date like
        # "1992.??.??" (whole matches carry it) — verified: such "pairs" diverge at
        # move 1. Keying on the parsed mainline UCI is the only safe identity: two
        # records with a byte-identical move sequence are the same game (catches the
        # same-mainline / different-result-token near-dup that dup_hash misses),
        # while genuinely different games are always kept.
        seen = {}
        deduped = []
        dupes = []
        for r in candidates:
            game = chess.pgn.read_game(io.StringIO(build_pgn(r)))
            key = " ".join(m.uci() for m in game.mainline_moves()) if game else None
            if key and key in seen:
                dupes.append((r["id"], seen[key]))
                continue
            if key:
                seen[key] = r["id"]
            deduped.append(r)

        # --- validate every kept game with python-chess ---
        parse_errors = []
        valid = []
        for r in deduped:
            pgn = build_pgn(r)
            game = chess.pgn.read_game(io.StringIO(pgn))
            if game is None:
                parse_errors.append((r["id"], "read_game=None")); continue
            if game.errors:
                parse_errors.append((r["id"], str(game.errors[0]))); continue
            nmoves = sum(1 for _ in game.mainline_moves())
            if nmoves == 0:
                # movetext present but no legal mainline move parsed -> reject
                excluded.append((r["id"], "zero_parsed_moves")); continue
            r["_pgn"] = pgn; r["_nmoves"] = nmoves
            valid.append(r)

        # --- seeded 80/20 split (over the validated set) ---
        rng = random.Random(SEED)
        order = valid[:]
        rng.shuffle(order)
        n_eval = round(len(order) * EVAL_FRAC)
        eval_set = order[:n_eval]
        train_set = order[n_eval:]
        eval_ids = {r["id"] for r in eval_set}

        # keep a stable on-disk order (by date then id) within each file
        def sortkey(r): return (r["date"], r["id"])
        all_sorted = sorted(valid, key=sortkey)
        train_sorted = sorted(train_set, key=sortkey)
        eval_sorted = sorted(eval_set, key=sortkey)

        def write(fn, games):
            with open(os.path.join(OUT, fn), "w") as f:
                f.write("\n".join(r["_pgn"] for r in games))
                if games: f.write("\n")

        write(f"{persona}.pgn", all_sorted)
        write(f"{persona}.train.pgn", train_sorted)
        write(f"{persona}.eval.pgn", eval_sorted)

        # --- stats ---
        def color_split(games):
            w = sum(1 for r in games if r["white"] in names)
            return w, len(games)-w
        def dates(games):
            ds = [r["date"] for r in games if r["date"] and r["date"][0:4].isdigit() and r["date"][0:4]!="0000"]
            return (min(ds), max(ds)) if ds else ("?","?")
        def opp_elos(games):
            els = []
            for r in games:
                white_is = r["white"] in names
                e = r["black_elo"] if white_is else r["white_elo"]
                if e: els.append(e)
            if not els: return (0,None,None,None)
            els.sort()
            return (len(els), min(els), max(els), round(sum(els)/len(els)))
        def results(games):
            wins=draws=losses=other=0
            for r in games:
                white_is = r["white"] in names; res=r["result"]
                persona_res = res if white_is else {"1-0":"0-1","0-1":"1-0"}.get(res,res)
                if persona_res=="1-0": wins+=1
                elif persona_res=="0-1": losses+=1
                elif persona_res=="1/2-1/2": draws+=1
                else: other+=1
            return wins,draws,losses,other

        cw,cb = color_split(valid)
        dmin,dmax = dates(valid)
        oe = opp_elos(valid)
        wn,dr,ls,ot = results(valid)
        summary[persona] = dict(
            raw=raw_n, excluded=len(excluded), dupes=len(dupes), valid=len(valid),
            train=len(train_sorted), eval=len(eval_sorted),
            as_white=cw, as_black=cb, date_min=dmin, date_max=dmax,
            opp_elo=oe, results=(wn,dr,ls,ot),
            excl_reasons=collections.Counter(x[1] for x in excluded),
            parse_errors=parse_errors, eval_ids=sorted(eval_ids),
            total_moves=sum(r["_nmoves"] for r in valid),
        )

    import json
    print(json.dumps({k:{kk:vv for kk,vv in v.items() if kk!="eval_ids"}
                      for k,v in summary.items()}, indent=2, default=str))
    # stash full summary (incl eval_ids) for the EXTRACTION.md writer
    with open("/private/tmp/claude-501/-Users-hjalti-GitHub-chessgui/dd40f6ca-eb35-4fc7-a3cd-6aacb33ad79b/scratchpad/summary.json","w") as f:
        json.dump(summary, f, default=str)

if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    main()
