#!/usr/bin/env python3
"""Spec 214/217: emit persona configs for the friends/family rivals.

These are PRIVATE individuals — configs and books live in data/rivals/ (gitignored,
spec 214 hard rule) and are NEVER committed. No harness runs (too few games / not
public figures); each is honestly labeled "book + Maia band, unmeasured".

Unlike the GM roster, these ARE runnable in persona-engine v1: the backend is a
Maia band (level 1100-1900), which is exactly what persona_move drives today. The
Maia band is chosen from the rival's chess.com rating in their primary time control
(rounded to the nearest available Maia band, 1100-1900), recorded with its source.

Identities are PRIVATE and are read from data/rivals/identities.json (gitignored,
never committed — spec 214 hard rule: committed text refers to rivals generically).
Schema, one entry per rival:
    { "<slug>": { "display": str, "relationship": str,
                  "rating": int, "rating_source": str } }

Emits data/rivals/{slug}.config.json. Refuses to run if data/rivals is not
gitignored (guard against an accidental commit of private data).
"""
import json, os, subprocess

REPO = "/Users/hjalti/GitHub/chessgui"
R = os.path.join(REPO, "data", "rivals")

MAIA_BANDS = [1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900]

def nearest_band(rating):
    return min(MAIA_BANDS, key=lambda b: abs(b - rating))

def load_identities():
    path = os.path.join(R, "identities.json")
    if not os.path.exists(path):
        raise SystemExit(f"Missing {path} — private identity map (see module "
                         "docstring for schema). It is deliberately not in git.")
    with open(path) as f:
        raw = json.load(f)
    return {slug: (v["display"], v["relationship"], v["rating"], v["rating_source"])
            for slug, v in raw.items()}

RIVALS = None  # loaded in main() from data/rivals/identities.json

def assert_gitignored():
    r = subprocess.run(["git", "-C", REPO, "check-ignore", "-q",
                        "data/rivals/probe.config.json"])
    if r.returncode != 0:
        raise SystemExit("REFUSING: data/rivals is not gitignored — private "
                         "rival configs must never be committable (spec 214).")

def main():
    assert_gitignored()
    rivals = load_identities()
    for slug, (display, rel, rating, src) in rivals.items():
        bp = os.path.join(R, f"{slug}.book.json")
        with open(bp) as f:
            b = json.load(f)
        band = nearest_band(rating)
        cfg = {
            "version": 1,
            "slug": slug,
            "display_name": display,
            "kind": "private-rival",
            "relationship": rel,
            "book": {"path": f"data/rivals/{slug}.book.json",
                     "max_ply": b["max_ply"],
                     "positions": b["stats"]["positions"],
                     "games": b["stats"]["games_used"]},
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
                "kind": "book + Maia band, unmeasured",
                "maia_band": band,
                "band_source": f"{src} rating {rating} -> nearest Maia band",
                "note": "NOT harness-measured (too few games / private individual). "
                        "Realism comes from the opening book + Maia policy; validated "
                        "only by the in-app 'felt like him' feedback capture.",
            },
            "private": True,
        }
        outp = os.path.join(R, f"{slug}.config.json")
        with open(outp, "w") as f:
            json.dump(cfg, f, indent=2, ensure_ascii=False)
            f.write("\n")
        print(f"wrote {slug}.config.json  band=maia-{band} "
              f"book_positions={b['stats']['positions']} (PRIVATE, gitignored)")

if __name__ == "__main__":
    main()
