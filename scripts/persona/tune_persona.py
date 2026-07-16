#!/usr/bin/env python3
"""Spec 214 metrics harness + auto-tuning loop.

Extends the tier-1 eval harness (eval_harness.py) with the three missing
human-likeness metrics and an offline optimizer for the persona engine's
sampling parameters. The harness EVALUATES THE SAME SEMANTICS IT TUNES: the
reweight math is ported 1:1 from src-tauri/src/persona.rs into persona_sim.py
(divergences documented there), and metrics definitions live in metrics214.py.

Pipeline per persona:
  1. Positions: the SAME seeded, phase-stratified held-out sample the tier-1
     harness used (eval split only, dedup by FEN, plies 10-60, seed 214214).
  2. Engine numbers, disk-cached and resumable:
       - full policy distribution from the persona's declared backend
         (BT3 via lc0 `go nodes 1` for GM personas; a Maia band for rivals),
       - fixed-depth Stockfish evals of each candidate + the actual move +
         the engine's best move (depth 12 — the configs' verify_depth),
       - the endgame arm's MultiPV top-4 at depth 16 where the SIMULATED
         phase (persona.rs formula) is endgame.
  3. Pure metric evaluation at any (alpha, lambda, T, schedule):
     move-match@1/@3 (argmax), expected match@1, NLL, ACPL profile,
     error-timing, opening KL (book + policy over the first 12 plies).
  4. Tuning (seeded, deterministic, pure math over the cached numbers):
       Stage A - coordinate descent on (alpha, lambda) maximizing argmax
                 move-match@1 on the TUNE half (ties: match@3, then NLL).
                 Temperature cannot be tuned against argmax match — softmax is
                 monotonic in the logits, so the ranking is T-invariant; and
                 maximizing EXPECTED match@1 in T degenerates to T -> 0
                 (a deterministic argmax bot — exactly what spec 214's hard
                 rule forbids faking humanity with). Hence:
       Stage B - coordinate descent on (T, opening_mult, endgame_mult)
                 minimizing held-out NLL (a proper scoring rule: minimized by
                 matching the human move DISTRIBUTION).
  5. Acceptance bar (spec 214): argmax move-match@1 on the untouched TEST half
     improves by >= +2% absolute over the config defaults. Bar met -> emit a
     NEW config snapshot (<slug>.config.v2.json; v1 is never mutated) as a
     STAGED artifact — promotion to the live config is an explicit later step.

Usage:
    python tune_persona.py --selftest
    python tune_persona.py --personas kasparov --limit 20    # smoke
    python tune_persona.py --personas kasparov,karpov,hannes-stefansson,dad
"""

from __future__ import annotations

import argparse
import io
import json
import re
import sys
import time
import zlib
from collections import Counter, defaultdict
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import chess
import chess.pgn

import metrics214 as mx
import persona_sim as sim
from eval_harness import (
    DATA_DIR, LC0, MAIA_DIR, PERSONAS, SEED, STOCKFISH, STRONGNET,
    TARGET_PER_PERSONA, PersonaCfg, Position, extract_candidates,
    stratified_sample,
)

REPO = Path(__file__).resolve().parents[2]
RIVALS_DIR = REPO / "data" / "rivals"

VERIFY_DEPTH = 12          # configs' verify_depth (persona.rs middlegame verify)
ENDGAME_DEPTH = 16         # persona.rs EndgameArm default
ENDGAME_TOP_K = 4
TOP_K = 4
OPENING_K_PLIES = 12       # opening-KL window: the persona's first 6 moves
OOB_OPENING_CAP = 150      # max out-of-book opening positions sent to engines
BUDGET_MIN_DEFAULT = 30.0  # per-persona wall-clock cap (soft; scope-reducing)

GRID = {
    "alpha": [0.5, 0.7, 0.85, 1.0, 1.2, 1.5, 2.0],
    "lambda": [0.0, 0.25, 0.5, 0.75, 1.0, 1.5, 2.5],
    "temperature": [0.2, 0.3, 0.4, 0.5, 0.65, 0.8, 1.0, 1.3],
    "opening_mult": [0.4, 0.6, 0.8, 1.0],
    "endgame_mult": [0.5, 0.8, 1.0, 1.3],
}
MAX_SWEEPS = 4

# The shipped config defaults (all 15 configs carry the same sampling block;
# no schedule field -> flat temperature, persona-engine v1 behavior).
DEFAULT_PARAMS = {"alpha": 1.0, "lambda": 0.75, "temperature": 0.5,
                  "schedule": None}


# ---------------------------------------------------------------------------
# Disk caches (idempotent + resumable; one JSON per kind per data root)
# ---------------------------------------------------------------------------

class JsonCache:
    def __init__(self, root: Path, name: str):
        root.mkdir(parents=True, exist_ok=True)
        self.path = root / f"{name}.json"
        self.data: dict = {}
        if self.path.exists():
            try:
                self.data = json.loads(self.path.read_text())
            except json.JSONDecodeError:
                self.data = {}
        self._dirty = 0

    def get(self, key: str):
        return self.data.get(key)

    def put(self, key: str, value) -> None:
        self.data[key] = value
        self._dirty += 1
        if self._dirty >= 50:
            self.flush()

    def flush(self) -> None:
        if self._dirty == 0 and self.path.exists():
            return
        tmp = self.path.with_suffix(".json.part")
        tmp.write_text(json.dumps(self.data))
        tmp.replace(self.path)
        self._dirty = 0


class EngineFarm:
    """Lazy, cached access to the engines this run needs."""

    def __init__(self, cache_root: Path):
        self._lc0: Dict[str, object] = {}
        self._sf = None
        self.caches = {
            "evals_d12": JsonCache(cache_root, f"tune_evals_d{VERIFY_DEPTH}"),
            "evals_d16": JsonCache(cache_root, f"tune_evals_d{ENDGAME_DEPTH}"),
            "best_d12": JsonCache(cache_root, f"tune_best_d{VERIFY_DEPTH}"),
            "mpv_d16": JsonCache(
                cache_root, f"tune_mpv{ENDGAME_TOP_K}_d{ENDGAME_DEPTH}"),
        }
        self._policy_caches: Dict[str, JsonCache] = {}
        self._cache_root = cache_root

    def policy_cache(self, backend: str) -> JsonCache:
        if backend not in self._policy_caches:
            self._policy_caches[backend] = JsonCache(
                self._cache_root, f"tune_policy_{backend}")
        return self._policy_caches[backend]

    def lc0(self, backend: str, weights: str):
        if backend not in self._lc0:
            from engines import Lc0Policy
            self._lc0[backend] = Lc0Policy(LC0, weights, backend)
        return self._lc0[backend]

    def sf(self):
        if self._sf is None:
            from engines import StockfishDepth
            self._sf = StockfishDepth(STOCKFISH)
        return self._sf

    def policy(self, backend: str, weights: str, fen: str) -> List[Tuple[str, float]]:
        cache = self.policy_cache(backend)
        hit = cache.get(fen)
        if hit is not None:
            return [(u, p) for u, p in hit]
        pol = self.lc0(backend, weights).policy(fen)
        cache.put(fen, pol)
        return pol

    def eval_after(self, fen: str, uci: str, depth: int) -> Optional[int]:
        name = "evals_d12" if depth == VERIFY_DEPTH else "evals_d16"
        key = f"{fen}|{uci}"
        hit = self.caches[name].get(key)
        if hit is not None:
            return hit
        val = self.sf().eval_after(fen, uci, depth)
        if val is not None:
            self.caches[name].put(key, val)
        return val

    def best_move(self, fen: str) -> Optional[str]:
        hit = self.caches["best_d12"].get(fen)
        if hit is not None:
            return hit
        mv = self.sf().best_move(fen, VERIFY_DEPTH)
        if mv is not None:
            self.caches["best_d12"].put(fen, mv)
        return mv

    def multipv(self, fen: str) -> List[Tuple[str, int]]:
        hit = self.caches["mpv_d16"].get(fen)
        if hit is not None:
            return [(u, cp) for u, cp in hit]
        top = self.sf().multipv_top(fen, ENDGAME_TOP_K, ENDGAME_DEPTH)
        self.caches["mpv_d16"].put(fen, top)
        return top

    def flush(self) -> None:
        for c in self.caches.values():
            c.flush()
        for c in self._policy_caches.values():
            c.flush()

    def close(self) -> None:
        self.flush()
        for e in self._lc0.values():
            e.close()  # type: ignore[attr-defined]
        if self._sf is not None:
            self._sf.close()


# ---------------------------------------------------------------------------
# Record building (engine-facing; everything downstream is pure)
# ---------------------------------------------------------------------------

def build_records(positions: List[Position], farm: EngineFarm, backend: str,
                  weights: str, deadline: float) -> Tuple[List[dict], dict]:
    """One record per position with every number the pure evaluator needs.
    Stops early (scope reduction, not corruption) when `deadline` passes."""
    records: List[dict] = []
    skipped = {"terminal_policy": 0, "eval_failed": 0, "budget_cut": 0}
    for pos in positions:
        if time.time() > deadline:
            skipped["budget_cut"] += 1
            continue
        policy = farm.policy(backend, weights, pos.fen)
        if not policy:
            skipped["terminal_policy"] += 1
            continue
        board = chess.Board(pos.fen)
        phase = sim.phase_for(sim.phase_weight(board), pos.ply)

        arm = "policy"
        if phase == "endgame":
            top = farm.multipv(pos.fen)
            if top:
                arm = "endgame"
                cand_ucis = [u for u, _ in top]
                cand_evals: List[Optional[int]] = [cp for _, cp in top]
                cand_priors = sim.endgame_priors(dict(policy), cand_ucis)
                depth = ENDGAME_DEPTH
        if arm == "policy":
            cands = sim.select_candidates(policy, sim.POLICY_FLOOR, TOP_K)
            cand_ucis = [u for u, _ in cands]
            cand_priors = [p for _, p in cands]
            cand_evals = [farm.eval_after(pos.fen, u, VERIFY_DEPTH)
                          for u in cand_ucis]
            depth = VERIFY_DEPTH
        if any(v is None for v in cand_evals):
            skipped["eval_failed"] += 1
            continue

        # ACPL reference: best over candidates + the actual move + SF's own
        # best move, all measured through the same after-move fixed-depth eval.
        if pos.actual_uci in cand_ucis:
            actual_cp = cand_evals[cand_ucis.index(pos.actual_uci)]
        else:
            actual_cp = farm.eval_after(pos.fen, pos.actual_uci, depth)
        if actual_cp is None:
            skipped["eval_failed"] += 1
            continue
        pool = list(cand_evals) + [actual_cp]
        best_uci = farm.best_move(pos.fen)
        if best_uci and best_uci not in cand_ucis and best_uci != pos.actual_uci:
            ref = farm.eval_after(pos.fen, best_uci, depth)
            if ref is not None:
                pool.append(ref)
        best_cp = max(pool)  # type: ignore[type-var]

        records.append({
            "fen": pos.fen,
            "ply": pos.ply,
            "phase": phase,
            "arm": arm,
            "actual": pos.actual_uci,
            "cand_ucis": cand_ucis,
            "cand_priors": cand_priors,
            "cand_evals": cand_evals,
            "cpl_actual": mx.cpl(best_cp, actual_cp),
            "cand_cpls": [mx.cpl(best_cp, v) for v in cand_evals],
        })
    farm.flush()
    return records, skipped


# ---------------------------------------------------------------------------
# Pure evaluation at a parameter point
# ---------------------------------------------------------------------------

def record_weights(rec: dict, params: dict) -> List[float]:
    """The persona's final sampling weights for one record — persona.rs
    semantics via persona_sim (penalties over CANDIDATES only, scheduled
    temperature, unclocked)."""
    t = sim.effective_temperature(params["temperature"], params.get("schedule"),
                                  rec["phase"], clock_ms=None)
    penalties = sim.penalties_from_cp(rec["cand_evals"])
    return sim.reweight(rec["cand_priors"], penalties, params["alpha"],
                        params["lambda"], t)


def evaluate(records: List[dict], params: dict) -> dict:
    """All metrics at one parameter point. Pure and deterministic."""
    n = len(records)
    if n == 0:
        return {"n": 0}
    hit1 = hit3 = 0
    exp1 = nll_sum = 0.0
    per_phase = {p: [0, 0, 0] for p in mx.PHASES}  # n, hit1, hit3
    rows = []
    for rec in records:
        w = record_weights(rec, params)
        u, a = rec["cand_ucis"], rec["actual"]
        h1 = mx.match_at(u, w, a, 1)
        h3 = mx.match_at(u, w, a, 3)
        hit1 += h1
        hit3 += h3
        pp = per_phase[rec["phase"]]
        pp[0] += 1
        pp[1] += h1
        pp[2] += h3
        exp1 += mx.expected_match1(u, w, a)
        nll_sum += mx.nll(u, w, a)
        rows.append({"phase": rec["phase"], "ply": rec["ply"],
                     "cpl_actual": rec["cpl_actual"],
                     "cand_cpls": rec["cand_cpls"], "weights": w})
    out = {
        "n": n,
        "match@1": round(hit1 / n, 4),
        "match@3": round(hit3 / n, 4),
        "expected_match@1": round(exp1 / n, 4),
        "nll": round(nll_sum / n, 4),
        "per_phase": {p: {"n": c[0],
                          "match@1": round(c[1] / c[0], 4) if c[0] else None,
                          "match@3": round(c[2] / c[0], 4) if c[0] else None}
                      for p, c in per_phase.items() if c[0]},
    }
    out.update(mx.acpl_profiles(rows))
    return out


# ---------------------------------------------------------------------------
# Tuning (seeded coordinate descent; pure math over cached records)
# ---------------------------------------------------------------------------

def split_tune_test(records: List[dict], label: str) -> Tuple[List[dict], List[dict]]:
    """Deterministic 50/50 split (seeded by run seed + persona label)."""
    import random
    idx = list(range(len(records)))
    random.Random(SEED * 1_000_003 + zlib.crc32(label.encode())).shuffle(idx)
    half = len(idx) // 2
    tune = [records[i] for i in idx[:half]]
    test = [records[i] for i in idx[half:]]
    return tune, test


def _schedule_with(opening_mult: float, endgame_mult: float) -> dict:
    s = dict(sim.DEFAULT_SCHEDULE)
    s["opening_mult"] = opening_mult
    s["middlegame_mult"] = 1.0  # pinned: resolves base-T x multiplier degeneracy
    s["endgame_mult"] = endgame_mult
    return s


def tune(records_tune: List[dict]) -> Tuple[dict, dict]:
    """Two-stage coordinate descent (see module docstring). Returns
    (tuned_params, trace)."""
    trace = {"stage_a": [], "stage_b": [], "sweeps_a": 0, "sweeps_b": 0}

    # Stage A: (alpha, lambda) vs argmax match@1; ties -> match@3, then -NLL.
    cur = {"alpha": DEFAULT_PARAMS["alpha"], "lambda": DEFAULT_PARAMS["lambda"],
           "temperature": DEFAULT_PARAMS["temperature"], "schedule": None}

    def score_a(p: dict) -> tuple:
        m = evaluate(records_tune, p)
        return (m["match@1"], m["match@3"], -m["nll"])

    best = score_a(cur)
    for sweep in range(MAX_SWEEPS):
        changed = False
        for key in ("alpha", "lambda"):
            for val in GRID[key]:
                cand = dict(cur)
                cand[key] = val
                s = score_a(cand)
                if s > best:
                    best, cur, changed = s, cand, True
        trace["stage_a"].append({"sweep": sweep, "alpha": cur["alpha"],
                                 "lambda": cur["lambda"],
                                 "match@1": best[0], "match@3": best[1]})
        trace["sweeps_a"] = sweep + 1
        if not changed:
            break

    # Stage B: (T, opening_mult, endgame_mult) vs NLL, alpha/lambda frozen.
    sched = {"temperature": cur["temperature"], "opening_mult": 1.0,
             "endgame_mult": 1.0}

    def params_b(sb: dict) -> dict:
        return {"alpha": cur["alpha"], "lambda": cur["lambda"],
                "temperature": sb["temperature"],
                "schedule": _schedule_with(sb["opening_mult"],
                                           sb["endgame_mult"])}

    def score_b(sb: dict) -> float:
        return evaluate(records_tune, params_b(sb))["nll"]

    best_nll = score_b(sched)
    for sweep in range(MAX_SWEEPS):
        changed = False
        for key in ("temperature", "opening_mult", "endgame_mult"):
            for val in GRID[key]:
                cand = dict(sched)
                cand[key] = val
                s = score_b(cand)
                if s < best_nll:
                    best_nll, sched, changed = s, cand, True
        trace["stage_b"].append({"sweep": sweep, **sched, "nll": best_nll})
        trace["sweeps_b"] = sweep + 1
        if not changed:
            break

    return params_b(sched), trace


# ---------------------------------------------------------------------------
# Opening KL data
# ---------------------------------------------------------------------------

_MOVENUM = re.compile(r"^\d+\.(\.\.)?")


def book_parent_map(book_path: Path) -> Dict[str, Dict[str, float]]:
    """From a book.json (entries keyed by the position AFTER the persona's
    move, with the SAN line that reached it), rebuild parent-position ->
    {persona_move_uci: weight}."""
    book = json.loads(book_path.read_text())
    out: Dict[str, Dict[str, float]] = defaultdict(dict)
    for e in book.get("entries", []):
        board = chess.Board()
        ok = True
        toks = [t for t in (_MOVENUM.sub("", t) for t in e["line"].split()) if t]
        for san in toks[:-1]:
            try:
                board.push_san(san)
            except ValueError:
                ok = False
                break
        if not ok or not toks:
            continue
        parent = board.fen()
        try:
            mv = board.parse_san(toks[-1])
        except ValueError:
            continue
        w = float(e.get("weight", 0))
        out[parent][mv.uci()] = out[parent].get(mv.uci(), 0.0) + w
    return dict(out)


def opening_positions(pgn_text: str, cfg: PersonaCfg,
                      surnames: Optional[List[str]] = None) -> Dict[str, dict]:
    """Persona-to-move positions in the first OPENING_K_PLIES plies of the
    eval games: fen -> {visits, real: Counter, ply}."""
    names = [s.lower() for s in (surnames or [cfg.surname])]
    out: Dict[str, dict] = {}
    stream = io.StringIO(pgn_text)
    while True:
        game = chess.pgn.read_game(stream)
        if game is None:
            break
        white = game.headers.get("White", "").lower()
        black = game.headers.get("Black", "").lower()
        color = None
        if any(s in white for s in names):
            color = chess.WHITE
        elif any(s in black for s in names):
            color = chess.BLACK
        if color is None:
            continue
        board = game.board()
        ply = 1
        for move in game.mainline_moves():
            if ply > OPENING_K_PLIES:
                break
            if board.turn == color and move in board.legal_moves:
                fen = board.fen()
                rec = out.setdefault(fen, {"visits": 0, "real": Counter(),
                                           "ply": ply})
                rec["visits"] += 1
                rec["real"][move.uci()] += 1
            board.push(move)
            ply += 1
    return out


def opening_kl_entries(open_pos: Dict[str, dict], parent_map: Dict[str, Dict[str, float]],
                       farm: EngineFarm, backend: str, weights: str,
                       params: dict, deadline: float) -> List[dict]:
    """Assemble metrics214.opening_kl() entries: book distribution while in
    book, reweighted policy out of book (capped at OOB_OPENING_CAP positions,
    highest-visit first)."""
    entries: List[dict] = []
    oob: List[Tuple[str, dict]] = []
    for fen, rec in open_pos.items():
        if fen in parent_map:
            entries.append({"visits": rec["visits"], "real": dict(rec["real"]),
                            "persona": dict(parent_map[fen]), "source": "book"})
        else:
            oob.append((fen, rec))
    oob.sort(key=lambda kv: (-kv[1]["visits"], kv[0]))
    for i, (fen, rec) in enumerate(oob):
        if i >= OOB_OPENING_CAP or time.time() > deadline:
            entries.append({"visits": rec["visits"], "real": dict(rec["real"]),
                            "persona": None, "source": "none"})
            continue
        policy = farm.policy(backend, weights, fen)
        if not policy:
            entries.append({"visits": rec["visits"], "real": dict(rec["real"]),
                            "persona": None, "source": "none"})
            continue
        cands = sim.select_candidates(policy, sim.POLICY_FLOOR, TOP_K)
        ucis = [u for u, _ in cands]
        evals = [farm.eval_after(fen, u, VERIFY_DEPTH) for u in ucis]
        if any(v is None for v in evals):
            entries.append({"visits": rec["visits"], "real": dict(rec["real"]),
                            "persona": None, "source": "none"})
            continue
        t = sim.effective_temperature(params["temperature"],
                                      params.get("schedule"),
                                      sim.phase_for(sim.phase_weight(chess.Board(fen)), rec["ply"]),
                                      None)
        w = sim.reweight([p for _, p in cands], sim.penalties_from_cp(evals),
                         params["alpha"], params["lambda"], t)
        entries.append({"visits": rec["visits"], "real": dict(rec["real"]),
                        "persona": dict(zip(ucis, w)), "source": "policy"})
    farm.flush()
    return entries


# ---------------------------------------------------------------------------
# Personas under tuning
# ---------------------------------------------------------------------------

def gm_target(label: str) -> dict:
    cfg = next(c for c in PERSONAS if c.label == label)
    return {
        "label": label,
        "cfg": cfg,
        "surnames": [cfg.surname],
        "backend": "lc0-bt3",
        "weights": str(STRONGNET),
        "book": DATA_DIR / f"{label}.book.json",
        "config_v1": DATA_DIR / f"{label}.config.json",
        "cache_root": DATA_DIR / "_cache",
        "out_dir": DATA_DIR,
        "private": False,
        "kl_leak_note": None,
    }


DAD_USERNAMES = ["thjaltason", "thorsenior2"]
DAD_PGNS = [RIVALS_DIR / "thjaltason.pgn", RIVALS_DIR / "Thorsenior2.pgn"]
DAD_EVAL_FRACTION = 0.2
DAD_MIN_POSITIONS = 60
DAD_MAIA_LEVEL = 1800  # Tier 0 spars dad at maia-1700/1800; upper band used


def build_dad_eval_split() -> Tuple[str, dict]:
    """Date-ordered held-out split of dad's STANDARD games (both accounts).
    Returns (eval_pgn_text, info). The split is written to data/rivals/ so the
    run is reproducible; data/rivals is gitignored — dad's games stay local."""
    games: List[Tuple[str, str]] = []  # (date, pgn_text)
    for path in DAD_PGNS:
        if not path.exists():
            continue
        stream = io.StringIO(path.read_text())
        while True:
            game = chess.pgn.read_game(stream)
            if game is None:
                break
            variant = game.headers.get("Variant", "").lower()
            if variant and variant not in ("standard", "chess", "normal"):
                continue
            if game.headers.get("SetUp") == "1" or "FEN" in game.headers:
                continue
            names = (game.headers.get("White", "") + "|"
                     + game.headers.get("Black", "")).lower()
            if not any(u in names for u in DAD_USERNAMES):
                continue
            date = game.headers.get("UTCDate") or game.headers.get("Date", "")
            games.append((date, str(game)))
    games.sort(key=lambda g: g[0])
    n_eval = max(int(len(games) * DAD_EVAL_FRACTION), 1)
    eval_games = games[-n_eval:]
    text = "\n\n".join(g for _, g in eval_games) + "\n"
    info = {"standard_games": len(games), "eval_games": n_eval,
            "eval_date_range": [eval_games[0][0], eval_games[-1][0]]
            if eval_games else None}
    out = RIVALS_DIR / "dad.eval.pgn"
    out.write_text(text)
    return text, info


def dad_target() -> Optional[dict]:
    text, info = build_dad_eval_split()
    cfg = PersonaCfg("dad", DAD_USERNAMES[0], RIVALS_DIR / "dad.eval.pgn")
    return {
        "label": "dad",
        "cfg": cfg,
        "surnames": DAD_USERNAMES,
        "backend": f"maia-{DAD_MAIA_LEVEL}",
        "weights": str(MAIA_DIR / f"maia-{DAD_MAIA_LEVEL}.pb.gz"),
        "book": RIVALS_DIR / "dad_book.json",
        "config_v1": None,  # dad has a book, not a persona config file
        "cache_root": RIVALS_DIR / "_cache",
        "out_dir": RIVALS_DIR,
        "private": True,
        "split_info": info,
        "kl_leak_note": ("dad's book was built from ALL his standard games "
                         "(no train/eval split existed), so the opening-KL "
                         "eval games are IN the book — treat dad's KL as a "
                         "consistency check, not a held-out measurement. "
                         "Move-match/ACPL/error-timing are clean: Maia was "
                         "not fit to dad."),
    }


def extract_dad_positions(text: str, cfg: PersonaCfg) -> List[Position]:
    """Dad plays under two usernames; run the harness extractor once per
    username and merge (dedup by FEN)."""
    cands: List[Position] = []
    seen = set()
    for name in DAD_USERNAMES:
        c = PersonaCfg("dad", name, cfg.pgn)
        for p in extract_candidates(text, c):
            if p.fen not in seen:
                seen.add(p.fen)
                cands.append(p)
    return cands


# ---------------------------------------------------------------------------
# Per-persona run
# ---------------------------------------------------------------------------

def run_persona(target: dict, limit: Optional[int], budget_min: float) -> dict:
    t0 = time.time()
    deadline = t0 + budget_min * 60.0
    label = target["label"]
    cfg: PersonaCfg = target["cfg"]
    text = cfg.pgn.read_text()
    if label == "dad":
        cands = extract_dad_positions(text, cfg)
    else:
        cands = extract_candidates(text, cfg)
    goal = limit or TARGET_PER_PERSONA
    positions = stratified_sample(cands, goal, SEED)
    if limit:
        positions = positions[:limit]
    print(f"[{label}] {len(cands)} candidates -> {len(positions)} positions",
          flush=True)
    if label == "dad" and len(positions) < DAD_MIN_POSITIONS and not limit:
        return {"label": label, "status": "skipped",
                "reason": f"only {len(positions)} held-out positions "
                          f"(< {DAD_MIN_POSITIONS}) — data does not permit "
                          "tuning", "candidates": len(cands),
                "split_info": target.get("split_info")}

    farm = EngineFarm(target["cache_root"])
    try:
        records, skipped = build_records(positions, farm, target["backend"],
                                         target["weights"], deadline)
        print(f"[{label}] {len(records)} records "
              f"(skipped {skipped}) in {time.time()-t0:.0f}s", flush=True)

        tune_recs, test_recs = split_tune_test(records, label)
        before_tune = evaluate(tune_recs, DEFAULT_PARAMS)
        before_test = evaluate(test_recs, DEFAULT_PARAMS)
        tuned_params, trace = tune(tune_recs)
        after_tune = evaluate(tune_recs, tuned_params)
        after_test = evaluate(test_recs, tuned_params)

        # Determinism check: pure evaluation twice, and the tuner re-run, must
        # reproduce bit-identically from the same cached numbers.
        assert evaluate(test_recs, tuned_params) == after_test
        assert tune(tune_recs)[0] == tuned_params

        # Opening KL (reported, never optimized) at defaults and tuned params.
        open_pos = opening_positions(text, cfg, target["surnames"])
        pmap = book_parent_map(target["book"]) if target["book"].exists() else {}
        kl_default = mx.opening_kl(opening_kl_entries(
            open_pos, pmap, farm, target["backend"], target["weights"],
            DEFAULT_PARAMS, deadline))
        kl_tuned = mx.opening_kl(opening_kl_entries(
            open_pos, pmap, farm, target["backend"], target["weights"],
            tuned_params, deadline))

        delta = round(after_test["match@1"] - before_test["match@1"], 4)
        bar_met = delta >= 0.02
        runtime_s = round(time.time() - t0, 1)
        result = {
            "label": label,
            "status": "ok",
            "backend": target["backend"],
            "n_positions": len(positions),
            "n_records": len(records),
            "skipped": skipped,
            "split": {"tune": len(tune_recs), "test": len(test_recs),
                      "seed": SEED},
            "default_params": DEFAULT_PARAMS,
            "tuned_params": tuned_params,
            "tuning_trace": trace,
            "metrics": {
                "tune_half": {"default": before_tune, "tuned": after_tune},
                "test_half": {"default": before_test, "tuned": after_test},
            },
            "opening_kl": {"default": kl_default, "tuned": kl_tuned,
                           "k_plies": OPENING_K_PLIES,
                           "leak_note": target["kl_leak_note"]},
            "acceptance": {
                "bar": "+2% absolute argmax move-match@1 on the test half",
                "delta_match@1_test": delta,
                "met": bar_met,
            },
            "runtime_s": runtime_s,
            "budget_min": budget_min,
        }
        if "split_info" in target:
            result["split_info"] = target["split_info"]
        return result
    finally:
        farm.close()


# ---------------------------------------------------------------------------
# Config snapshot emission (only when the bar is met)
# ---------------------------------------------------------------------------

def emit_config_v2(target: dict, result: dict) -> Optional[Path]:
    """Write <slug>.config.v2.json next to v1 (v1 untouched — snapshot
    immutability). The v2 file is a STAGED artifact: nothing in the app loads
    *.config.v2.json; promotion (renaming into the live slot) is an explicit,
    human-approved step."""
    v1_path: Optional[Path] = target["config_v1"]
    if v1_path is None or not v1_path.exists():
        return None
    v2_path = v1_path.with_name(v1_path.name.replace(".config.json",
                                                     ".config.v2.json"))
    cfg = json.loads(v1_path.read_text())
    tp = result["tuned_params"]
    cfg["version"] = 2
    cfg["sampling"] = {
        "level": cfg.get("sampling", {}).get("level", 1900),
        "temperature": tp["temperature"],
        "alpha": tp["alpha"],
        "lambda": tp["lambda"],
        "top_k": TOP_K,
        "verify_depth": VERIFY_DEPTH,
        "schedule": tp["schedule"],
    }
    cfg["tuning"] = {
        "date": time.strftime("%Y-%m-%d"),
        "script": "scripts/persona/tune_persona.py",
        "seed": SEED,
        "objective": ("stage A: argmax move-match@1 (alpha/lambda); "
                      "stage B: held-out NLL (temperature + phase mults)"),
        "split": result["split"],
        "before_test": {k: result["metrics"]["test_half"]["default"][k]
                        for k in ("match@1", "match@3", "expected_match@1",
                                  "nll")},
        "after_test": {k: result["metrics"]["test_half"]["tuned"][k]
                       for k in ("match@1", "match@3", "expected_match@1",
                                 "nll")},
        "predecessor": v1_path.name,
        "status": "staged — not loaded by the app; promotion is an explicit "
                  "step",
    }
    v2_path.write_text(json.dumps(cfg, indent=2) + "\n")
    return v2_path


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------

def _fmt_params(p: dict) -> str:
    s = p.get("schedule")
    sched = ("flat" if s is None else
             f"opening x{s['opening_mult']}, endgame x{s['endgame_mult']}")
    return (f"alpha={p['alpha']}, lambda={p['lambda']}, "
            f"T={p['temperature']} ({sched})")


def report_markdown(results: List[dict], total_s: float) -> str:
    L: List[str] = []
    A = L.append
    A("\n---\n")
    A(f"## Tuning run — spec 214 metrics harness + auto-tuning "
      f"({time.strftime('%Y-%m-%d %H:%M')})\n")
    A(f"_Script `scripts/persona/tune_persona.py` · seed {SEED} · "
      f"reweight math ported 1:1 from src-tauri/src/persona.rs "
      f"(persona_sim.py) · SF depth {VERIFY_DEPTH} verify / depth "
      f"{ENDGAME_DEPTH} endgame arm · total {total_s/60:.1f} min._\n")
    A("Metric definitions: metrics214.py. move-match@1/@3 are ARGMAX-by-"
      "final-sampling-weight (temperature-invariant); expected match@1 is "
      "the mass the sampler puts on the human move; NLL is the proper "
      "scoring rule that fits temperature; ACPL profile and error timing "
      "are teacher-forced on the same held-out positions; opening KL is "
      "KL(real || book+policy) over the first "
      f"{OPENING_K_PLIES} plies, visit-weighted.\n")
    A("Tuning: coordinate descent — stage A (alpha, lambda) maximizes "
      "move-match@1 on the tune half; stage B (T, opening/endgame mults) "
      "minimizes NLL. The test half is untouched by the optimizer; the "
      "acceptance bar (+2% absolute match@1) is judged there.\n")
    for r in results:
        A(f"### {r['label']}\n")
        if r["status"] != "ok":
            A(f"SKIPPED: {r['reason']}\n")
            continue
        A(f"Backend `{r['backend']}` · {r['n_records']} records "
          f"(of {r['n_positions']} positions; skipped {r['skipped']}) · "
          f"tune/test {r['split']['tune']}/{r['split']['test']} · "
          f"runtime {r['runtime_s']/60:.1f} min (cap {r['budget_min']:.0f}).\n")
        A(f"- defaults: {_fmt_params(r['default_params'])}")
        A(f"- tuned:    {_fmt_params(r['tuned_params'])}\n")
        A("| metric (test half) | default | tuned |")
        A("|---|--:|--:|")
        td = r["metrics"]["test_half"]["default"]
        tt = r["metrics"]["test_half"]["tuned"]
        for k in ("match@1", "match@3", "expected_match@1", "nll"):
            A(f"| {k} | {td[k]} | {tt[k]} |")
        for k in ("acpl_shape_similarity", "error_timing_similarity"):
            A(f"| {k} | {td.get(k)} | {tt.get(k)} |")
        kd, kt = r["opening_kl"]["default"], r["opening_kl"]["tuned"]
        A(f"| opening KL (nats) | {kd['kl_nats']} | {kt['kl_nats']} |")
        A("")
        A(f"ACPL profile (test, default params): real {td['real_acpl']} vs "
          f"persona {td['persona_acpl']}; tuned persona {tt['persona_acpl']}.")
        A(f"Opening KL coverage {kd['visit_coverage']} "
          f"(book share {kd['book_share_of_covered']}).")
        if r["opening_kl"]["leak_note"]:
            A(f"CAVEAT: {r['opening_kl']['leak_note']}")
        acc = r["acceptance"]
        A(f"\n**Acceptance bar ({acc['bar']}): "
          f"delta {acc['delta_match@1_test']:+.4f} -> "
          f"{'MET' if acc['met'] else 'NOT MET'}.**\n")
    return "\n".join(L)


# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------

def selftest() -> int:
    import unittest

    def mkrec(phase="middlegame", ply=30, actual="a", priors=(0.5, 0.3, 0.2),
              evals=(10, 0, -200), cpl_actual=0):
        ucis = ["a", "b", "c"][:len(priors)]
        best = max(evals)
        return {"fen": "x", "ply": ply, "phase": phase, "arm": "policy",
                "actual": actual, "cand_ucis": ucis,
                "cand_priors": list(priors), "cand_evals": list(evals),
                "cpl_actual": cpl_actual,
                "cand_cpls": [mx.cpl(best, v) for v in evals]}

    class T(unittest.TestCase):
        def test_evaluate_deterministic(self):
            recs = [mkrec(), mkrec(actual="b", priors=(0.2, 0.7, 0.1))]
            a = evaluate(recs, DEFAULT_PARAMS)
            b = evaluate(recs, DEFAULT_PARAMS)
            self.assertEqual(a, b)
            self.assertEqual(a["n"], 2)

        def test_evaluate_matches_hand_computation(self):
            # Single record, flat T: weights = softmax((ln p - 0.75*pen)/0.5).
            rec = mkrec()
            m = evaluate([rec], DEFAULT_PARAMS)
            self.assertEqual(m["match@1"], 1.0)  # "a": top prior, top eval
            self.assertEqual(m["match@3"], 1.0)
            self.assertGreater(m["expected_match@1"], 0.5)

        def test_split_deterministic_and_disjoint(self):
            recs = [mkrec(ply=i) for i in range(10, 60)]
            a1, b1 = split_tune_test(recs, "x")
            a2, b2 = split_tune_test(recs, "x")
            self.assertEqual(a1, a2)
            self.assertEqual(b1, b2)
            self.assertEqual(len(a1) + len(b1), len(recs))
            a3, _ = split_tune_test(recs, "y")
            self.assertNotEqual([r["ply"] for r in a1],
                                [r["ply"] for r in a3])

        def test_tune_finds_lambda_when_human_plays_best_eval(self):
            # Actual move always the best-eval candidate but policy prefers
            # another: the optimizer must push lambda up (eval trust).
            recs = []
            for i in range(40):
                recs.append(mkrec(actual="b", priors=(0.6, 0.3, 0.1),
                                  evals=(-150, 50, -300), ply=20 + i % 30))
            tuned, _ = tune(recs)
            base = evaluate(recs, DEFAULT_PARAMS)["match@1"]
            after = evaluate(recs, tuned)["match@1"]
            self.assertGreaterEqual(after, base)
            self.assertEqual(after, 1.0)
            self.assertGreater(tuned["lambda"], 0.75)

        def test_tune_is_deterministic(self):
            recs = [mkrec(actual=["a", "b", "c"][i % 3], ply=10 + i)
                    for i in range(30)]
            self.assertEqual(tune(recs)[0], tune(recs)[0])

        def test_record_weights_temperature_invariance_of_ranking(self):
            rec = mkrec()
            for t in (0.2, 0.5, 1.3):
                p = dict(DEFAULT_PARAMS, temperature=t)
                w = record_weights(rec, p)
                self.assertEqual(mx.weight_ranking(rec["cand_ucis"], w)[0],
                                 "a")

        def test_book_parent_map_roundtrip(self):
            import tempfile
            book = {"entries": [
                {"fen": "after-e4", "line": "1.e4", "ply": 1, "weight": 3},
                {"fen": "after-d4", "line": "1.d4", "ply": 1, "weight": 1},
                {"fen": "x", "line": "1.e4 c5 2.Nf3", "ply": 3, "weight": 2},
            ]}
            with tempfile.NamedTemporaryFile("w", suffix=".json",
                                             delete=False) as fh:
                json.dump(book, fh)
                path = Path(fh.name)
            pm = book_parent_map(path)
            start = chess.Board().fen()
            self.assertEqual(pm[start], {"e2e4": 3.0, "d2d4": 1.0})
            b = chess.Board()
            b.push_san("e4")
            b.push_san("c5")
            self.assertEqual(pm[b.fen()], {"g1f3": 2.0})
            path.unlink()

        def test_opening_positions_counts_visits(self):
            pgn = ('[White "Kasparov, Garry"]\n[Black "Someone"]\n\n'
                   "1. e4 c5 2. Nf3 d6 *\n\n"
                   '[White "Kasparov, Garry"]\n[Black "Other"]\n\n'
                   "1. e4 e5 2. Nf3 Nc6 *\n")
            cfg = PersonaCfg("kasparov", "kasparov", Path("/dev/null"))
            got = opening_positions(pgn, cfg)
            start = chess.Board().fen()
            self.assertEqual(got[start]["visits"], 2)
            self.assertEqual(got[start]["real"], {"e2e4": 2})

    suite = unittest.TestLoader().loadTestsFromTestCase(T)
    res = unittest.TextTestRunner(verbosity=2).run(suite)
    if res.wasSuccessful():
        print("\nrunning persona_sim + metrics214 selftests…")
        return sim.selftest() or mx.selftest()
    return 1


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--personas", default="kasparov,karpov,hannes-stefansson,dad")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--budget-min", type=float, default=BUDGET_MIN_DEFAULT)
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--no-report", action="store_true",
                    help="skip HARNESS_RESULTS.md / config emission (smoke)")
    args = ap.parse_args()

    if args.selftest:
        return selftest()

    if not STRONGNET.exists():
        print(f"FATAL: strong net missing at {STRONGNET}", file=sys.stderr)
        return 2

    wanted = [s.strip() for s in args.personas.split(",") if s.strip()]
    targets = []
    for name in wanted:
        if name == "dad":
            t = dad_target()
            if t:
                targets.append(t)
        else:
            targets.append(gm_target(name))

    t0 = time.time()
    results = []
    for target in targets:
        r = run_persona(target, args.limit, args.budget_min)
        results.append(r)
        out_json = target["out_dir"] / f"tuning_{target['label']}.json"
        out_json.write_text(json.dumps(r, indent=2) + "\n")
        print(f"[{target['label']}] wrote {out_json}", flush=True)
        if (not args.no_report and r["status"] == "ok"
                and r["acceptance"]["met"]):
            v2 = emit_config_v2(target, r)
            if v2:
                print(f"[{target['label']}] bar MET -> staged {v2}", flush=True)

    total_s = time.time() - t0
    if not args.no_report:
        public = [r for r in results
                  if not next(t for t in targets
                              if t["label"] == r["label"])["private"]]
        private = [r for r in results if r not in public]
        if public:
            md = report_markdown(public, total_s)
            with (DATA_DIR / "HARNESS_RESULTS.md").open("a") as fh:
                fh.write(md)
            print(f"appended tuning section to {DATA_DIR/'HARNESS_RESULTS.md'}")
        if private:
            md = report_markdown(private, total_s)
            with (RIVALS_DIR / "TUNING_DAD.md").open("a") as fh:
                fh.write(md)
            print(f"appended private tuning section to "
                  f"{RIVALS_DIR/'TUNING_DAD.md'}")
    print(f"total {total_s/60:.1f} min")
    return 0


if __name__ == "__main__":
    sys.exit(main())
