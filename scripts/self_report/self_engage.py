#!/usr/bin/env python3
"""Per-game engagement scoring to exclude 'distracted' games. Cheap signals only."""
import chess, chess.pgn, json, sys, re
from collections import defaultdict
from datetime import datetime
import numpy as np

# Rescued from the 2026-07 self-report scratchpad pipeline (SELF_REPORT.md
# "Artifacts") and parameterized; the scoring logic is byte-identical.
import argparse
_ap = argparse.ArgumentParser(description="Engagement filter: flag 'distracted' games")
_ap.add_argument("--pgn", required=True, help="user's full-history PGN")
_ap.add_argument("--user", required=True, help="chess.com username as it appears in headers")
_ap.add_argument("--out", required=True, help="output dir for self_engagement.json")
_a = _ap.parse_args()
PGN = _a.pgn
USER = _a.user
OUT = _a.out
PVAL = {chess.PAWN:1, chess.KNIGHT:3, chess.BISHOP:3, chess.ROOK:5, chess.QUEEN:9}

def timeclass(tc):
    if tc.startswith("1/") or tc=="-": return "daily"
    if "+" in tc: base,inc=tc.split("+"); base=int(base); inc=int(inc)
    else: base=int(tc); inc=0
    est=base+40*inc
    return "bullet" if est<180 else ("blitz" if est<600 else "rapid")

def tc_params(tc):
    if tc.startswith("1/") or tc=="-": return None,0
    if "+" in tc: base,inc=tc.split("+"); return int(base),int(inc)
    return int(tc),0

def clk_to_s(s):
    # 0:09:59.4
    h,m,sec=s.split(":"); return int(h)*3600+int(m)*60+float(sec)

def material(board, color):
    return sum(PVAL[pt]*len(board.pieces(pt,color)) for pt in PVAL)

games=[]
with open(PGN, encoding="utf-8", errors="replace") as f:
    while True:
        g=chess.pgn.read_game(f)
        if g is None: break
        games.append(g)

feats=[]
for g in games:
    h=g.headers
    white=h.get("White",""); black=h.get("Black","")
    if USER not in (white,black): continue
    user_white = white==USER
    res=h.get("Result","")
    if res=="1-0": score=1.0 if user_white else 0.0
    elif res=="0-1": score=1.0 if not user_white else 0.0
    elif res=="1/2-1/2": score=0.5
    else: score=None
    tc=h.get("TimeControl",""); tcl=timeclass(tc); base,inc=tc_params(tc)
    term=h.get("Termination","").lower()
    link=h.get("Link","")

    # walk moves, collect user clocks + final board
    board=g.board()
    user_clocks=[]   # remaining clock (s) after each user move
    n_user=0; n_plies=0
    node=g
    for node in g.mainline():
        mv=node.move; n_plies+=1
        mover_white = board.turn==chess.WHITE
        is_user = (mover_white==user_white)
        board.push(mv)
        if is_user:
            n_user+=1
            cm=node.comment
            m=re.search(r"%clk\s+([0-9:.]+)", cm)
            user_clocks.append(clk_to_s(m.group(1)) if m else None)

    # time spent per user move
    frac_instant=None; max_think=None
    if base is not None and any(c is not None for c in user_clocks) and len(user_clocks)>=4:
        spent=[]
        prev=base
        for c in user_clocks:
            if c is None: spent.append(None); continue
            s=prev - c + inc
            spent.append(s); prev=c
        real=[s for s in spent[2:] if s is not None and s>=0]  # skip first 2 moves
        if real:
            frac_instant=sum(1 for s in real if s<=1.0)/len(real)
            max_think=max(real)/base if base else 0

    # final material diff (user - opp)
    md = material(board, chess.WHITE if user_white else chess.BLACK) - \
         material(board, chess.BLACK if user_white else chess.WHITE)

    is_loss = score==0.0
    is_win  = score==1.0
    long_tc = tcl in ("rapid","daily")   # slow controls: instant/flag means stepping away
    abandoned_loss = ("abandon" in term) and is_loss
    timeout_loss = ("time" in term and "insufficient" not in term) and is_loss
    # flagging while even/ahead only signals disengagement in SLOW controls;
    # in blitz/bullet, losing on time up material is normal clock play, not distraction.
    flag_even_or_better = timeout_loss and md >= 0 and long_tc
    resign_loss = ("resignation" in term) and is_loss
    short_resign_even = resign_loss and n_plies<=25 and md >= -1
    very_short_loss = is_loss and n_plies<=16
    # rushed: a burst of near-instant moves is only disengagement in a SLOW game
    # AND only when it was not a clean win (fast play in a won position is fine).
    rushed_rapid_loss = long_tc and (not is_win) and (frac_instant is not None) and frac_instant>=0.5

    feats.append(dict(link=link, tcl=tcl, score=score, n_plies=n_plies, n_user=n_user,
                      term=term, md=md, frac_instant=frac_instant, max_think=max_think,
                      abandoned_loss=int(abandoned_loss), flag_even_or_better=int(flag_even_or_better),
                      short_resign_even=int(short_resign_even), very_short_loss=int(very_short_loss),
                      rushed_rapid_loss=int(rushed_rapid_loss), timeout_loss=int(timeout_loss)))

# disengagement score: higher = more distracted. Driven by drive-by markers, not by
# fast play per se. Symmetric in principle; signals just correlate with poor results.
for f in feats:
    f["diseng"]= ( 2.0*f["flag_even_or_better"]      # walked away, flagged while even/ahead (slow TC)
                 + 2.0*f["abandoned_loss"]           # abandoned the game
                 + 1.5*f["short_resign_even"]        # drive-by resign, material intact
                 + 1.0*f["rushed_rapid_loss"]        # blitzed out a slow game and lost
                 + 0.5*f["very_short_loss"] )        # generic early collapse

# exclusion: own median + 1.5*SD on the composite (computed over serious games rapid+blitz+daily; bullet always fast)
pop=[f for f in feats]
scores=np.array([f["diseng"] for f in pop])
med=float(np.median(scores)); sd=float(np.std(scores))
thr=med+1.5*sd
for f in feats: f["excluded"]=int(f["diseng"]>thr)

excl=[f for f in feats if f["excluded"]]
json.dump({"threshold":thr,"median":med,"sd":sd,
           "excluded_links":[f["link"] for f in excl],
           "feats":feats},
          open(f"{OUT}/self_engagement.json","w"))

print(f"total games (user): {len(feats)}", file=sys.stderr)
print(f"diseng median={med:.3f} sd={sd:.3f} threshold={thr:.3f}", file=sys.stderr)
print(f"EXCLUDED: {len(excl)} ({100*len(excl)/len(feats):.1f}%)", file=sys.stderr)
byc=defaultdict(lambda:[0,0])
for f in feats:
    byc[f["tcl"]][0]+=1; byc[f["tcl"]][1]+=f["excluded"]
for k,(n,e) in byc.items(): print(f"  {k}: {e}/{n} excluded", file=sys.stderr)
# reasons
r=defaultdict(int)
for f in excl:
    if f["flag_even_or_better"]: r["flag_even_or_better"]+=1
    if f["abandoned_loss"]: r["abandoned_loss"]+=1
    if f["short_resign_even"]: r["short_resign_even"]+=1
    if f["rushed_rapid_loss"]: r["rushed_rapid_loss"]+=1
    if f["very_short_loss"]: r["very_short_loss"]+=1
print("reason tallies (non-exclusive):", dict(r), file=sys.stderr)
print("\n== EXAMPLE EXCLUDED GAMES ==", file=sys.stderr)
excl_sorted=sorted(excl, key=lambda f:-f["diseng"])
for f in excl_sorted[:8]:
    print(f"  {f['link']} tcl={f['tcl']} plies={f['n_plies']} md={f['md']} "
          f"term={f['term'][:28]} fracInst={f['frac_instant']} diseng={f['diseng']:.2f}", file=sys.stderr)
