#!/usr/bin/env python3
"""Spec 214 "Persona config format + loader": emit one config JSON per persona.

A persona config is the roster's future data source: it points at the opening
book, the policy backend + net, the persona-engine v1 default sampling params,
the measured harness label, and the extraction provenance. The field names in
the `sampling` block match the Rust `PersonaParams` serde names EXACTLY (per
persona-engine, 2026-07-15) so the loader consumes them 1:1:
  level, temperature, alpha, lambda, top_k, verify_depth.
seed/ply are RUNTIME-only (frontend supplies them) and are deliberately absent.

Backend note (persona-engine v1): persona_move only drives Maia bands via
`level` (1100-1900). It has no BT3 strong-net policy arm yet, so GM personas
whose backend is BT3 are NOT engine-runnable in v1 — the config records the
backend anyway (correct home for it; the loader wants it when the engine grows
a BT3 arm) and flags runnable=false. Amateur/Maia personas (data/rivals) are
runnable today; they get their own generator path with runnable=true.

Public personas -> data/personas/{slug}.config.json (committable).
Reads: data/personas/_cache/roster_summary.json, each {slug}.book.json,
harness_results.json. Prints what it wrote.
"""
import json, os, hashlib, collections
import chess.pgn, io

REPO = "/Users/hjalti/GitHub/chessgui"
P = os.path.join(REPO, "data", "personas")

# persona-engine v1 PersonaParams defaults (serde field names, exact).
SAMPLING_DEFAULTS = {
    "level": 1900,          # Maia band selector; ceiling for GM-class fallback
    "temperature": 0.5,
    "alpha": 1.0,           # policy-prior exponent (reweight, contract step 4)
    "lambda": 0.75,         # eval-penalty / blunder-suppression coefficient
    "top_k": 4,
    "verify_depth": 12,     # Stockfish `go depth` for verification reweight
}

BT3 = {
    "kind": "lc0-policy",
    "net": {
        "file": "BT3-768x15x24h-swa-2790000.pb.gz",
        "sha256": "e3067757d1fc2dfc66947b21d15ace0cedf4c54254fc1de83d77c378a3e8b8e1",
        "url": "https://storage.lczero.org/files/networks-contrib/"
               "BT3-768x15x24h-swa-2790000.pb.gz",
    },
}

# slug -> display name + short bio tag (public figures; spec 217 canon).
DISPLAY = {
    "fischer": ("Robert James Fischer", "11th World Champion (1972)"),
    "kasparov": ("Garry Kasparov", "13th World Champion (1985-2000)"),
    "sigurjonsson-peak": ("Guðmundur Sigurjónsson (peak 1975-78)",
                          "Iceland's 2nd GM; dad's old friend, at full strength"),
    "spassky": ("Boris Spassky", "10th World Champion; the other chair, Reykjavík 1972"),
    "karpov": ("Anatoly Karpov", "12th World Champion (1975-85)"),
    "fridrik-olafsson": ("Friðrik Ólafsson",
                        "Iceland's first GM (1958); FIDE President 1978-82"),
    "margeir-petursson": ("Margeir Pétursson",
                        "GM; founded MP Bank — 'win the game Gudmundur never got'"),
    "johann-hjartarson": ("Jóhann Hjartarson",
                        "Candidates quarterfinalist (beat Korchnoi, 1988)"),
    "hannes-stefansson": ("Hannes Hlífar Stefánsson",
                        "13x Icelandic champion — the record"),
    "helgi-olafsson": ("Helgi Ólafsson", "6x Icelandic champion"),
    "jon-l-arnason": ("Jón L. Árnason", "World U17 champion 1977; 3x Icelandic champion"),
    "hedinn-steingrimsson": ("Héðinn Steingrímsson", "World U12 champion 1987; GM 2007"),
}

# Which harness backend is each persona's product backend (spec 214: GM=BT3).
# All roster personas are 2400-2700 GMs -> BT3, not runnable in engine v1.
PERSONA_ORDER = ["fischer", "kasparov", "spassky", "karpov",
                 "fridrik-olafsson", "margeir-petursson",
                 "johann-hjartarson", "hannes-stefansson", "helgi-olafsson",
                 "jon-l-arnason", "hedinn-steingrimsson", "sigurjonsson-peak"]

# fischer/kasparov predate roster_summary.json; count from their own PGN splits.
def _count_pgn(path):
    n = 0
    with open(path) as f:
        while chess.pgn.read_game(f) is not None:
            n += 1
    return n

def load_harness():
    with open(os.path.join(P, "harness_results.json")) as f:
        return json.load(f)

def book_meta(slug):
    bp = os.path.join(P, f"{slug}.book.json")
    with open(bp) as f:
        b = json.load(f)
    return {"path": f"data/personas/{slug}.book.json",
            "max_ply": b["max_ply"],
            "positions": b["stats"]["positions"],
            "games": b["stats"]["games_used"]}

def main():
    roster = json.load(open(os.path.join(P, "_cache", "roster_summary.json")))
    harness = load_harness()
    hres = harness["results"]
    hdate = harness["generated"][:10]
    n = harness["config"]["target_per_persona"]

    wrote = []
    for slug in PERSONA_ORDER:
        display, bio = DISPLAY[slug]
        # extraction provenance: roster_summary for roster; special-case peak
        if slug == "sigurjonsson-peak":
            db_names = ["Sigurjonsson, Gudmundur"]
            data = {"note": "peak-era slice 1975-1978, empirically chosen "
                            "(see EXTRACTION.md)",
                    "book_games": book_meta(slug)["games"],
                    "date_range": "1975-1978"}
        elif slug in ("fischer", "kasparov"):
            dbn = {"fischer": ["Fischer, Robert James"],
                   "kasparov": ["Kasparov, Garry"]}[slug]
            db_names = dbn
            data = {"games": _count_pgn(os.path.join(P, f"{slug}.pgn")),
                    "train": _count_pgn(os.path.join(P, f"{slug}.train.pgn")),
                    "eval": _count_pgn(os.path.join(P, f"{slug}.eval.pgn")),
                    "note": "extracted 2026-07-14 (extract_personas.py); "
                            "see EXTRACTION.md"}
        else:
            r = roster[slug]
            db_names = r["names"]
            data = {"games": r["valid"], "train": r.get("train"),
                    "eval": r.get("eval"),
                    "date_range": f"{r['date_min']}–{r['date_max']}",
                    "as_white": r["as_white"], "as_black": r["as_black"]}

        # harness label: BT3 = the GM product backend
        hm = hres[slug]["match"]["lc0-bt3"]["overall"]
        harness_label = {
            "backend": "lc0-bt3",
            "match@1": hm["match@1"], "match@3": hm["match@3"],
            "n": hm["n"], "date": hdate,
            "note": "held-out move-match; BT3 strong-net policy "
                    "(GM-class backend per spec 214). Maia bands are a floor "
                    "for 2400+ players — see HARNESS_RESULTS.md."}

        cfg = {
            "version": 1,
            "slug": slug,
            "display_name": display,
            "bio": bio,
            "kind": "public-figure",
            "db_names": db_names,
            "book": book_meta(slug),
            "backend": BT3,
            "runnable_in_engine_v1": False,  # BT3 policy arm not yet in persona_move
            "runnable_note": "persona-engine v1 drives Maia bands only (level "
                             "1100-1900); this BT3-backed GM persona awaits the "
                             "engine's strong-net policy arm (later tier).",
            "sampling": dict(SAMPLING_DEFAULTS),
            "harness": harness_label,
            "data": data,
        }
        outp = os.path.join(P, f"{slug}.config.json")
        with open(outp, "w") as f:
            json.dump(cfg, f, indent=2, ensure_ascii=False)
            f.write("\n")
        wrote.append((slug, hm["match@1"], hm["match@3"], hm["n"]))
        print(f"wrote {slug}.config.json  match@1={hm['match@1']} "
              f"match@3={hm['match@3']} n={hm['n']}")
    return wrote

if __name__ == "__main__":
    main()
