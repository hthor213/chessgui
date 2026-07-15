#!/usr/bin/env python3
"""PART 1: own-game profile for the given user + position sampler for PART 2."""
import chess, chess.pgn, json, sys
from collections import defaultdict, Counter
from datetime import datetime

# Rescued from the 2026-07 self-report scratchpad pipeline (SELF_REPORT.md
# "Artifacts") and parameterized; the profiling/sampling logic is byte-identical.
import argparse
_ap = argparse.ArgumentParser(description="Own-game profile + Maia position sampler")
_ap.add_argument("--pgn", required=True, help="user's full-history PGN")
_ap.add_argument("--user", required=True, help="chess.com username as it appears in headers")
_ap.add_argument("--out", required=True, help="work dir (reads self_engagement.json, writes part1 + samples)")
_a = _ap.parse_args()
PGN = _a.pgn
USER = _a.user
OUT = _a.out

def timeclass(tc):
    if tc.startswith("1/") or tc == "-": return "daily"
    if "+" in tc:
        base, inc = tc.split("+"); base=int(base); inc=int(inc)
    else:
        base=int(tc); inc=0
    est = base + 40*inc
    if est < 180: return "bullet"
    if est < 600: return "blitz"
    return "rapid"

PVAL = {chess.KNIGHT:3, chess.BISHOP:3, chess.ROOK:5, chess.QUEEN:9}
def nonpawn_material(board, color):
    return sum(PVAL[pt]*len(board.pieces(pt,color)) for pt in PVAL)

games=[]
with open(PGN, encoding="utf-8", errors="replace") as f:
    while True:
        g = chess.pgn.read_game(f)
        if g is None: break
        games.append(g)
print(f"parsed {len(games)} games", file=sys.stderr)

records=[]
for g in games:
    h=g.headers
    white=h.get("White",""); black=h.get("Black","")
    if USER not in (white, black): continue
    color = "white" if white==USER else "black"
    res = h.get("Result","")
    if res=="1-0": score = 1.0 if color=="white" else 0.0
    elif res=="0-1": score = 1.0 if color=="black" else 0.0
    elif res=="1/2-1/2": score = 0.5
    else: score = None
    tc = h.get("TimeControl",""); tcl = timeclass(tc)
    date = h.get("UTCDate", h.get("Date","")).replace(".","-")
    try: dt = datetime.strptime(date, "%Y-%m-%d")
    except: dt = None
    opp = black if color=="white" else white
    userelo = h.get("WhiteElo" if color=="white" else "BlackElo","")
    try: userelo=int(userelo)
    except: userelo=None
    oppelo = h.get("BlackElo" if color=="white" else "WhiteElo","")
    try: oppelo=int(oppelo)
    except: oppelo=None
    term = h.get("Termination",""); eco = h.get("ECO","")
    mainline = list(g.mainline_moves())
    tmp=g.board(); opening=[]
    for m in mainline[:6]:
        try: opening.append(tmp.san(m)); tmp.push(m)
        except: break
    nmoves=len(mainline)
    reached_eg=False; tmp=g.board()
    for i,m in enumerate(mainline):
        tmp.push(m)
        if i>=20 and nonpawn_material(tmp, chess.WHITE)<=8 and nonpawn_material(tmp, chess.BLACK)<=8:
            reached_eg=True; break
    records.append(dict(color=color, score=score, tc=tc, tcl=tcl, date=date, dt=dt,
                        opp=opp, userelo=userelo, oppelo=oppelo, term=term, eco=eco,
                        opening=" ".join(opening), nmoves=nmoves, reached_eg=reached_eg,
                        result=res, link=h.get("Link","")))

records.sort(key=lambda r: r["dt"] or datetime(1970,1,1))

# engagement filter: exclude distracted games (built by self_engage.py)
eng=json.load(open(f"{OUT}/self_engagement.json"))
EXCLUDED=set(eng["excluded_links"])
for r in records: r["excluded"]=r["link"] in EXCLUDED

def wdl(rs):
    w=sum(1 for r in rs if r["score"]==1.0); l=sum(1 for r in rs if r["score"]==0.0); d=sum(1 for r in rs if r["score"]==0.5)
    n=w+l+d; pct=(w+0.5*d)/n*100 if n else 0
    return w,l,d,n,pct

def build_report(records):
    report={}
    byclass=defaultdict(list)
    for r in records: byclass[r["tcl"]].append(r)
    report["by_timeclass"]={k:{"w":wdl(v)[0],"l":wdl(v)[1],"d":wdl(v)[2],"n":wdl(v)[3],"score_pct":round(wdl(v)[4],1)} for k,v in byclass.items()}

    traj=defaultdict(list)
    for r in records:
        if r["userelo"] and r["dt"]: traj[r["tcl"]].append((r["date"], r["userelo"]))
    report["rating_trajectory"]={}
    for k,v in traj.items():
        if not v: continue
        yearly=defaultdict(list)
        for d,e in v: yearly[d[:4]].append(e)
        report["rating_trajectory"][k]={yr:{"n":len(es),"mean":round(sum(es)/len(es)),"min":min(es),"max":max(es)} for yr,es in sorted(yearly.items())}
        report["rating_trajectory"][k]["_first"]=v[0]; report["rating_trajectory"][k]["_last"]=v[-1]

    def opening_report(color):
        rs=[r for r in records if r["color"]==color and r["opening"]]
        byop=defaultdict(list)
        for r in rs: byop[r["opening"]].append(r)
        rows=[]
        for op,v in byop.items():
            w,l,d,n,pct=wdl(v)
            if n>=5: rows.append(dict(line=op,n=n,w=w,l=l,d=d,score_pct=round(pct,1)))
        rows.sort(key=lambda x:-x["n"])
        return rows
    report["openings_white"]=opening_report("white")
    report["openings_black"]=opening_report("black")

    allr=[r for r in records if r["score"] is not None]
    report["avg_game_moves"]=round(sum(r["nmoves"] for r in allr)/len(allr),1)
    eg=[r for r in allr if r["reached_eg"]]
    report["endgame_reached_pct"]=round(len(eg)/len(allr)*100,1)
    w,l,d,n,pct=wdl(eg)
    report["endgame_record"]={"w":w,"l":l,"d":d,"n":n,"score_pct":round(pct,1)}
    noneg=[r for r in allr if not r["reached_eg"]]
    report["non_endgame_record"]={k:v for k,v in zip(["w","l","d","n","score_pct"],[*wdl(noneg)[:4],round(wdl(noneg)[4],1)])}
    egser=[r for r in eg if r["tcl"] in ("rapid","blitz")]
    report["endgame_record_rapidblitz"]={k:v for k,v in zip(["w","l","d","n","score_pct"],[*wdl(egser)[:4],round(wdl(egser)[4],1)])}

    term=Counter()
    for r in allr:
        t=r["term"].lower()
        if "resignation" in t: mode="resignation"
        elif "checkmate" in t: mode="checkmate"
        elif "time" in t and "insufficient" not in t: mode="time"
        elif "agreement" in t: mode="draw_agreement"
        elif "repetition" in t: mode="repetition"
        elif "stalemate" in t: mode="stalemate"
        elif "insufficient" in t: mode="insufficient"
        elif "abandon" in t: mode="abandoned"
        else: mode="other"
        term[(mode,"win" if r["score"]==1.0 else ("draw" if r["score"]==0.5 else "loss"))]+=1
    tm=defaultdict(dict)
    for (mode,outcome),c in term.items(): tm[mode][outcome]=c
    report["termination_modes"]=dict(tm)

    losses=[r for r in allr if r["score"]==0.0]
    buckets={"<=20":0,"21-40":0,"41-60":0,">60":0}
    for r in losses:
        nm=r["nmoves"]
        if nm<=20: buckets["<=20"]+=1
        elif nm<=40: buckets["21-40"]+=1
        elif nm<=60: buckets["41-60"]+=1
        else: buckets[">60"]+=1
    report["loss_length_buckets"]=buckets
    report["total_losses"]=len(losses)

    oppc=Counter(r["opp"] for r in records)
    report["top_opponents"]=[]
    for opp,c in oppc.most_common(8):
        rs=[r for r in records if r["opp"]==opp]
        w,l,d,n,pct=wdl(rs)
        ecos=Counter(r["opening"] for r in rs if r["opening"]).most_common(4)
        report["top_opponents"].append(dict(opp=opp,n=n,w=w,l=l,d=d,score_pct=round(pct,1),
                                            top_lines=[{"line":o,"n":cc} for o,cc in ecos]))
    return report

filtered=[r for r in records if not r["excluded"]]
report=build_report(filtered)
report["_filter"]={"total_games":len(records),"excluded":len(records)-len(filtered),
                   "kept":len(filtered)}
json.dump(report, open(f"{OUT}/self_part1.json","w"), indent=1)
json.dump(build_report(records), open(f"{OUT}/self_part1_unfiltered.json","w"), indent=1)
print("PART1 done (filtered + unfiltered)", file=sys.stderr)

def sample(tcl, n_games, first_ply=9, last_ply=80):
    # engaged games only, most-recent n_games
    rs=[r for r in records if r["tcl"]==tcl and r["score"] is not None and not r["excluded"]]
    rs=sorted(rs, key=lambda r: r["dt"] or datetime(1970,1,1))
    recent=rs[-n_games:]
    linkset={r["link"] for r in recent}
    order={r["link"]:i for i,r in enumerate(recent)}
    positions=[]
    for g in games:
        link=g.headers.get("Link","")
        if link not in linkset: continue
        user_is_white = g.headers.get("White","")==USER
        board=g.board()
        for ply,m in enumerate(g.mainline_moves(), start=1):
            if first_ply<=ply<=last_ply and (board.turn==chess.WHITE)==user_is_white:
                positions.append(dict(fen=board.fen(), move=m.uci(), ply=ply, link=link, order=order[link]))
            board.push(m)
    return positions

rapid_pos=sample("rapid", 150)
blitz_pos=sample("blitz", 150)
json.dump({"rapid":rapid_pos,"blitz":blitz_pos,
           "n_rapid_games":len({p['link'] for p in rapid_pos}),
           "n_blitz_games":len({p['link'] for p in blitz_pos})},
          open(f"{OUT}/self_samples.json","w"))
print(f"sampled (engaged only) rapid={len(rapid_pos)} blitz={len(blitz_pos)}", file=sys.stderr)
