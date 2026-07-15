#!/usr/bin/env python3
"""Consume Maia probability matrix -> rating estimate, quadratic peak, bootstrap, trend."""
import json, sys, math, random
random.seed(7)
import numpy as np

# Rescued from the 2026-07 self-report scratchpad pipeline (SELF_REPORT.md
# "Artifacts") and parameterized; estimation (quadratic peak, 200-draw
# bootstrap, first/second-half trend) is byte-identical, seed 7.
import argparse
_ap = argparse.ArgumentParser(description="Maia probability matrix -> rating estimate")
_ap.add_argument("which", nargs="?", default="rapid", choices=["rapid", "blitz"])
_ap.add_argument("--dir", required=True, help="work dir (reads self_maia_<which>.json, writes the estimate)")
_a = _ap.parse_args()
SCR = _a.dir
which = _a.which
d = json.load(open(f"{SCR}/self_maia_{which}.json"))
levels = np.array(d["levels"], float)
P = np.array(d["probs"], float)          # [n_positions, n_levels]
L = np.log(P)                             # log-likelihood per position per level
orders = np.array([p["order"] for p in d["positions"]])
n = P.shape[0]

def quad_peak(total_ll):
    # fit parabola LL = a*x^2+b*x+c over levels, vertex = -b/2a (if a<0)
    x = levels.copy()
    a,b,c = np.polyfit(x, total_ll, 2)
    if a >= 0:  # no interior max -> clamp to argmax
        return float(levels[np.argmax(total_ll)])
    peak = -b/(2*a)
    return float(np.clip(peak, levels.min(), levels.max()))

def estimate(idx):
    ll = L[idx].sum(axis=0)               # total LL per level
    argmax = float(levels[np.argmax(ll)])
    peak = quad_peak(ll)
    return argmax, peak, ll

argmax, peak, total_ll = estimate(np.arange(n))
mean_ll = total_ll / n

# bootstrap
B=200
bs_argmax=[]; bs_peak=[]
for _ in range(B):
    idx = np.random.randint(0, n, n)
    am, pk, _ = estimate(idx)
    bs_argmax.append(am); bs_peak.append(pk)
bs_argmax=np.array(bs_argmax); bs_peak=np.array(bs_peak)

def pct(a,p): return float(np.percentile(a,p))

# time trend: split games into first/second half by order
med = np.median(orders)
first = orders <= med
second = orders > med
am1,pk1,_ = estimate(np.where(first)[0])
am2,pk2,_ = estimate(np.where(second)[0])

res = {
 "which": which, "n_positions": int(n), "n_games": len(set(orders.tolist())),
 "per_level_total_LL": {int(l): round(float(v),1) for l,v in zip(levels, total_ll)},
 "per_level_mean_LL": {int(l): round(float(v),4) for l,v in zip(levels, mean_ll)},
 "argmax": int(argmax),
 "quadratic_peak": round(peak,1),
 "bootstrap_argmax_5_50_95": [pct(bs_argmax,5), pct(bs_argmax,50), pct(bs_argmax,95)],
 "bootstrap_peak_5_50_95": [round(pct(bs_peak,5),1), round(pct(bs_peak,50),1), round(pct(bs_peak,95),1)],
 "trend_first_half": {"n": int(first.sum()), "argmax": int(am1), "peak": round(pk1,1)},
 "trend_second_half": {"n": int(second.sum()), "argmax": int(am2), "peak": round(pk2,1)},
}
json.dump(res, open(f"{SCR}/self_estimate_{which}.json","w"), indent=1)
print(json.dumps(res, indent=1))
