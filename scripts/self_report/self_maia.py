#!/usr/bin/env python3
"""PART 2: Maia rating estimate from real user moves via lc0 policy head."""
import json, subprocess, sys, random, math, os
from collections import defaultdict

# Rescued from the 2026-07 self-report scratchpad pipeline (SELF_REPORT.md
# "Artifacts") and parameterized; the estimation protocol is byte-identical
# (lc0 `go nodes 1` policy read, P(user_move) floored at 0.1%, seed 42).
import argparse
_ap = argparse.ArgumentParser(description="Maia policy-head rating matrix from real user moves")
_ap.add_argument("which", nargs="?", default="rapid", choices=["rapid", "blitz"])
_ap.add_argument("target", nargs="?", type=int, default=1200, help="max positions to sample")
_ap.add_argument("--dir", required=True, help="work dir (reads self_samples.json, writes the matrix)")
_ap.add_argument("--nets", required=True, help="dir holding maia-<band>.pb.gz weights")
_ap.add_argument("--lc0", default="/opt/homebrew/bin/lc0")
_a = _ap.parse_args()
SCR = _a.dir
NETDIR = _a.nets
LC0 = _a.lc0
LEVELS = [1100,1200,1300,1400,1500,1600,1700,1800,1900]
FLOOR = 0.001  # 0.1%
random.seed(42)

for _lv in LEVELS:
    if not os.path.exists(f"{NETDIR}/maia-{_lv}.pb.gz"):
        sys.exit(f"missing net {NETDIR}/maia-{_lv}.pb.gz — run measure_monthly.py, which downloads them")

pool = json.load(open(f"{SCR}/self_samples.json"))
which = _a.which
target = _a.target
positions = pool[which]
if len(positions) > target:
    positions = random.sample(positions, target)
positions.sort(key=lambda p:(p["order"], p["ply"]))
print(f"[{which}] using {len(positions)} positions from {len({p['link'] for p in positions})} games", file=sys.stderr)

class Net:
    def __init__(self, level):
        self.level=level
        self.p=subprocess.Popen([LC0, f"--weights={NETDIR}/maia-{level}.pb.gz"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, bufsize=1)
        self._send("uci"); self._wait("uciok")
        self._send("setoption name VerboseMoveStats value true")
        self._send("isready"); self._wait("readyok")
    def _send(self,s): self.p.stdin.write(s+"\n"); self.p.stdin.flush()
    def _wait(self,tok):
        for line in self.p.stdout:
            if line.startswith(tok): return
    def policy(self, fen):
        self._send(f"position fen {fen}")
        self._send("go nodes 1")
        probs={}
        for line in self.p.stdout:
            line=line.strip()
            if line.startswith("bestmove"): break
            if line.startswith("info string"):
                t=line.split()
                mv=t[2]
                if mv=="node": continue
                if "(P:" in line:
                    i=line.index("(P:")
                    frac=line[i+3:].split("%")[0].strip()
                    try: probs[mv]=float(frac)/100.0
                    except: pass
        return probs
    def close(self):
        try: self._send("quit"); self.p.wait(timeout=5)
        except: self.p.kill()

# collect P(user_move) per level per position
# matrix[pi][level] = prob
per_pos = [dict() for _ in positions]
for level in LEVELS:
    net=Net(level)
    for pi,pos in enumerate(positions):
        pr=net.policy(pos["fen"])
        p=pr.get(pos["move"], 0.0)
        per_pos[pi][level]=max(p, FLOOR)
    net.close()
    ll=sum(math.log(per_pos[pi][level]) for pi in range(len(positions)))
    print(f"  level {level}: total_LL={ll:.1f}", file=sys.stderr)

# save matrix + orders for downstream stats
out={"which":which,
     "positions":[{"order":p["order"],"ply":p["ply"]} for p in positions],
     "probs":[[per_pos[pi][lv] for lv in LEVELS] for pi in range(len(positions))],
     "levels":LEVELS}
json.dump(out, open(f"{SCR}/self_maia_{which}.json","w"))
print(f"[{which}] saved matrix", file=sys.stderr)
