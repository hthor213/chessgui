#!/usr/bin/env python3
"""Spec 214/217: extract the persona-fleet roster from the app DB.

Spassky + Karpov + the Icelandic canon (spec 217 "Icelandic canon" section).
Same pipeline as extract_personas.py / extract_sigurjonsson.py: full-header
PGN from the read-only app DB, empty-movetext rejects, mainline-UCI dedup,
python-chess validation, seeded 80/20 train/eval split per persona.

Name variants were checked against the DB up front (LIKE sweeps over
surname/first-name/diacritic-transliterations per data/personas/
ICELAND_ROSTER.md); each persona lists every matching DB spelling. Personas
with <100 valid games are reported and skipped (no files written).

Usage: python3 extract_roster.py
Writes {slug}.pgn / {slug}.train.pgn / {slug}.eval.pgn to data/personas/
and prints a JSON summary (also saved to data/personas/_cache/roster_summary.json).
"""
import sqlite3, os, io, random, collections, json
import chess, chess.pgn

DB = os.path.expanduser("~/Library/Application Support/com.hjalti.chessgui/games.db")
OUT = "/Users/hjalti/GitHub/chessgui/data/personas"
SEED = 214
EVAL_FRAC = 0.20
MIN_GAMES = 100

# slug -> exact DB name spellings (verified 2026-07-15 against the 955k-game
# Lumbra OTB DB; LIKE sweeps found exactly one spelling per player — the
# transliterated forms from ICELAND_ROSTER.md; no "Jon Loftur Arnason",
# no "Hannes Hlifar Stefansson", no bare "Spassky, Boris" variant exists).
PERSONAS = {
    "spassky": ["Spassky, Boris Vasilievich"],
    "karpov": ["Karpov, Anatoly"],
    "fridrik-olafsson": ["Olafsson, Fridrik"],
    "margeir-petursson": ["Petursson, Margeir"],
    "johann-hjartarson": ["Hjartarson, Johann"],
    "hannes-stefansson": ["Stefansson, Hannes"],
    "helgi-olafsson": ["Olafsson, Helgi"],
    "jon-l-arnason": ["Arnason, Jon L"],
    "hedinn-steingrimsson": ["Steingrimsson, Hedinn"],
}

COLS = ["id","white","black","white_elo","black_elo","event","site","round",
        "date","eco","result","ply_count","source","pgn_moves"]

def esc(s): return (s or "").replace("\\","\\\\").replace('"','\\"')
def yr(d):
    y=(d or "")[:4]; return int(y) if y.isdigit() and y!="0000" else None

def build_pgn(r):
    h=[]
    def tag(k,v): h.append(f'[{k} "{esc(str(v))}"]')
    tag("Event",r["event"]); tag("Site",r["site"]); tag("Date",r["date"])
    tag("Round",r["round"]); tag("White",r["white"]); tag("Black",r["black"])
    tag("Result",r["result"] or "*")
    if r["white_elo"] is not None: tag("WhiteElo",r["white_elo"])
    if r["black_elo"] is not None: tag("BlackElo",r["black_elo"])
    if r["eco"]: tag("ECO",r["eco"])
    return "\n".join(h)+"\n\n"+(r["pgn_moves"] or "").strip()+"\n"

def extract_one(c, slug, names):
    ph=",".join("?"*len(names))
    rows=[dict(r) for r in c.execute(
        f"SELECT {','.join(COLS)} FROM games WHERE white IN ({ph}) OR black IN ({ph})",
        names+names)]
    raw_n=len(rows)

    # quality: drop empty movetext
    excluded=[]; cand=[]
    for r in rows:
        body=(r["pgn_moves"] or "").strip()
        toks=body.replace("1-0","").replace("0-1","").replace("1/2-1/2","").replace("*","").strip()
        if r["ply_count"]==0 or toks=="": excluded.append((r["id"],"no_movetext")); continue
        cand.append(r)

    # dedup on the parsed mainline UCI (same rationale as extract_personas.py:
    # metadata keys falsely collapse partial-date match games)
    seen={}; deduped=[]; dupes=[]
    for r in cand:
        g=chess.pgn.read_game(io.StringIO(build_pgn(r)))
        key=" ".join(m.uci() for m in g.mainline_moves()) if g else None
        if key and key in seen: dupes.append((r["id"],seen[key])); continue
        if key: seen[key]=r["id"]
        deduped.append(r)

    # validate with python-chess
    valid=[]; parse_errors=[]
    for r in deduped:
        g=chess.pgn.read_game(io.StringIO(build_pgn(r)))
        if g is None: parse_errors.append((r["id"],"None")); continue
        if g.errors: parse_errors.append((r["id"],str(g.errors[0]))); continue
        nm=sum(1 for _ in g.mainline_moves())
        if nm==0: excluded.append((r["id"],"zero_parsed_moves")); continue
        r["_pgn"]=build_pgn(r); r["_n"]=nm; valid.append(r)

    # stats helpers
    def color(g): w=sum(1 for r in g if r["white"] in names); return w,len(g)-w
    def dates(g):
        ds=[r["date"] for r in g if yr(r["date"])]
        return (min(ds),max(ds)) if ds else ("?","?")
    def own_elos(g):
        e=[(r["white_elo"] if r["white"] in names else r["black_elo"]) for r in g]
        e=[x for x in e if x]; e.sort()
        return (len(e),e[0],e[-1],round(sum(e)/len(e))) if e else (0,None,None,None)
    def opp_elos(g):
        e=[(r["black_elo"] if r["white"] in names else r["white_elo"]) for r in g]
        e=[x for x in e if x]; e.sort()
        return (len(e),e[0],e[-1],round(sum(e)/len(e))) if e else (0,None,None,None)
    def results(g):
        w=d=l=o=0
        for r in g:
            wp=r["white"] in names; res=r["result"]
            pr=res if wp else {"1-0":"0-1","0-1":"1-0"}.get(res,res)
            if pr=="1-0":w+=1
            elif pr=="0-1":l+=1
            elif pr=="1/2-1/2":d+=1
            else:o+=1
        return w,d,l,o
    by_year=collections.Counter(yr(r["date"]) for r in valid if yr(r["date"]))

    summary=dict(
        names=names, raw=raw_n, excluded=len(excluded), dupes=len(dupes),
        valid=len(valid), parse_errors=parse_errors,
        excl=dict(collections.Counter(x[1] for x in excluded)),
        as_white=color(valid)[0], as_black=color(valid)[1],
        date_min=dates(valid)[0], date_max=dates(valid)[1],
        own_elo=own_elos(valid), opp_elo=opp_elos(valid),
        results=results(valid), total_moves=sum(r["_n"] for r in valid),
        years_first_last_top5=dict(sorted(by_year.items())[:2]
                                   + sorted(by_year.items())[-2:]),
    )

    if len(valid) < MIN_GAMES:
        summary["skipped"]=f"only {len(valid)} valid games (<{MIN_GAMES})"
        return summary

    # seeded 80/20 split
    rng=random.Random(SEED); order=valid[:]; rng.shuffle(order)
    n_eval=round(len(order)*EVAL_FRAC)
    eval_set=order[:n_eval]; train_set=order[n_eval:]
    sk=lambda r:(r["date"],r["id"])
    def write(fn,g):
        with open(os.path.join(OUT,fn),"w") as f:
            f.write("\n".join(x["_pgn"] for x in g))
            if g: f.write("\n")
    write(f"{slug}.pgn",sorted(valid,key=sk))
    write(f"{slug}.train.pgn",sorted(train_set,key=sk))
    write(f"{slug}.eval.pgn",sorted(eval_set,key=sk))
    summary.update(train=len(train_set), eval=len(eval_set))
    return summary

def main():
    c=sqlite3.connect(f"file:{DB}?mode=ro",uri=True); c.row_factory=sqlite3.Row
    out={}
    for slug,names in PERSONAS.items():
        out[slug]=extract_one(c,slug,names)
        print(f"[{slug}] valid={out[slug]['valid']}"
              + (f" SKIPPED: {out[slug]['skipped']}" if "skipped" in out[slug] else
                 f" train={out[slug]['train']} eval={out[slug]['eval']}"), flush=True)
    print(json.dumps(out,indent=2,default=str))
    os.makedirs(os.path.join(OUT,"_cache"),exist_ok=True)
    with open(os.path.join(OUT,"_cache","roster_summary.json"),"w") as f:
        json.dump(out,f,indent=2,default=str)

if __name__=="__main__":
    os.makedirs(OUT,exist_ok=True); main()
