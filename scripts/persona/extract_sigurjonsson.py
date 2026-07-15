#!/usr/bin/env python3
"""Spec 214: extract the Gudmundur Sigurjonsson persona (+ peak-era slice).

Same pipeline as extract_personas.py (Fischer/Kasparov): full-header PGN,
mainline-UCI dedup, quality flags, seeded 80/20 split. Adds a peak.pgn slice
from the empirically-identified peak window (1975-1978).
"""
import sqlite3, os, io, random, collections
import chess, chess.pgn

DB = os.path.expanduser("~/Library/Application Support/com.hjalti.chessgui/games.db")
OUT = "/Users/hjalti/GitHub/chessgui/data/personas"
SEED = 214
EVAL_FRAC = 0.20
NAME = "Sigurjonsson, Gudmundur"
PEAK = (1975, 1978)  # inclusive

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

def main():
    c=sqlite3.connect(f"file:{DB}?mode=ro",uri=True); c.row_factory=sqlite3.Row
    rows=[dict(r) for r in c.execute(
        f"SELECT {','.join(COLS)} FROM games WHERE white=? OR black=?",(NAME,NAME))]
    raw_n=len(rows)

    # quality: drop empty movetext
    excluded=[]; cand=[]
    for r in rows:
        body=(r["pgn_moves"] or "").strip()
        toks=body.replace("1-0","").replace("0-1","").replace("1/2-1/2","").replace("*","").strip()
        if r["ply_count"]==0 or toks=="": excluded.append((r["id"],"no_movetext")); continue
        cand.append(r)

    # dedup on mainline UCI
    seen={}; deduped=[]; dupes=[]
    for r in cand:
        g=chess.pgn.read_game(io.StringIO(build_pgn(r)))
        key=" ".join(m.uci() for m in g.mainline_moves()) if g else None
        if key and key in seen: dupes.append((r["id"],seen[key])); continue
        if key: seen[key]=r["id"]
        deduped.append(r)

    # validate
    valid=[]; parse_errors=[]
    for r in deduped:
        g=chess.pgn.read_game(io.StringIO(build_pgn(r)))
        if g is None: parse_errors.append((r["id"],"None")); continue
        if g.errors: parse_errors.append((r["id"],str(g.errors[0]))); continue
        nm=sum(1 for _ in g.mainline_moves())
        if nm==0: excluded.append((r["id"],"zero_parsed_moves")); continue
        r["_pgn"]=build_pgn(r); r["_n"]=nm; valid.append(r)

    # seeded 80/20 split over full valid set
    rng=random.Random(SEED); order=valid[:]; rng.shuffle(order)
    n_eval=round(len(order)*EVAL_FRAC)
    eval_set=order[:n_eval]; train_set=order[n_eval:]
    eval_ids={r["id"] for r in eval_set}

    # peak slice (all peak-window games)
    peak=[r for r in valid if PEAK[0]<=(yr(r["date"]) or 0)<=PEAK[1]]
    peak_in_train=[r for r in peak if r["id"] not in eval_ids]
    peak_in_eval=[r for r in peak if r["id"] in eval_ids]

    sk=lambda r:(r["date"],r["id"])
    def write(fn,g):
        with open(os.path.join(OUT,fn),"w") as f:
            f.write("\n".join(x["_pgn"] for x in g))
            if g: f.write("\n")
    write("sigurjonsson.pgn",sorted(valid,key=sk))
    write("sigurjonsson.train.pgn",sorted(train_set,key=sk))
    write("sigurjonsson.eval.pgn",sorted(eval_set,key=sk))
    write("sigurjonsson.peak.pgn",sorted(peak,key=sk))

    # stats
    def color(g): w=sum(1 for r in g if r["white"]==NAME); return w,len(g)-w
    def dates(g):
        ds=[r["date"] for r in g if yr(r["date"])]
        return (min(ds),max(ds)) if ds else ("?","?")
    def opp_elos(g):
        e=[(r["black_elo"] if r["white"]==NAME else r["white_elo"]) for r in g]
        e=[x for x in e if x]; e.sort()
        return (len(e),e[0],e[-1],round(sum(e)/len(e))) if e else (0,None,None,None)
    def results(g):
        w=d=l=o=0
        for r in g:
            wp=r["white"]==NAME; res=r["result"]
            pr=res if wp else {"1-0":"0-1","0-1":"1-0"}.get(res,res)
            if pr=="1-0":w+=1
            elif pr=="0-1":l+=1
            elif pr=="1/2-1/2":d+=1
            else:o+=1
        return w,d,l,o

    cw,cb=color(valid); dmin,dmax=dates(valid); oe=opp_elos(valid); rr=results(valid)
    pk_res=results(peak); pk_oe=opp_elos(peak)
    import json
    out=dict(raw=raw_n,excluded=len(excluded),dupes=len(dupes),valid=len(valid),
        train=len(train_set),eval=len(eval_set),peak=len(peak),
        peak_in_train=len(peak_in_train),peak_in_eval=len(peak_in_eval),
        as_white=cw,as_black=cb,date_min=dmin,date_max=dmax,opp_elo=oe,results=rr,
        peak_results=pk_res,peak_opp_elo=pk_oe,parse_errors=parse_errors,
        excl=collections.Counter(x[1] for x in excluded),total_moves=sum(r["_n"] for r in valid))
    print(json.dumps(out,indent=2,default=str))

if __name__=="__main__":
    os.makedirs(OUT,exist_ok=True); main()
