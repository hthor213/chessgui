#!/usr/bin/env python3
"""e1_outcome_prediction.py — spec 213 Phase 4, killer experiment E1.

Outcome prediction head-to-head on real R-vs-R games from the app's games DB
(docs/research/elo-conditioned-eval-design.md §4): per held-out position, the
predictors {material count, Stockfish eval, Eval_R (tier-1 human-visible
tree), Maia value head} each get their own logistic calibration on the train
split, then predict expected points (1 / 0.5 / 0, White POV) on the test
split. Metrics: Brier (primary), log-loss, AUC (win-vs-rest), reliability
bins — per band and pooled. The claim under test: Brier(Eval_R) < Brier(SF)
within band R.

Eval_R here is a UCI-level REIMPLEMENTATION of the app's tier-1 search
(apps/desktop/src-tauri/src/human_search.rs), not an invocation of it: the
tier-1 code is a Tauri command with no headless entry point, and the full E1
run happens on the homeserver where the .app cannot run. The port replicates
the Rust semantics exactly — top-p nucleus (prob desc, ties by UCI asc,
smallest prefix >= top_p, clamped to [1, max_candidates]), negamax backup,
fixed-depth single-threaded Stockfish leaves with `ucinewgame` per leaf,
node budget degrading to leaves, EPD-keyed depth-aware transposition cache,
MATE_CP = 100000 — and --selftest proves the port on the same synthetic-tree
fixtures as the Rust unit tests. E1 runs the linked scalar band (per-node
phase conditioning is the identity when R_opening = R_middlegame = R_endgame).

Protocol per the design doc §4:
  * one position per game, random ply >= --min-ply, not in check, not
    terminal-adjacent (ply <= ply_count - 8);
  * R-vs-R only: both Elos known, |white - black| <= --max-elo-diff, average
    within +-50 of a Maia band (1100..1900);
  * player-disjoint train/test split (name-hash buckets; games pairing a
    train player with a test player are dropped);
  * contamination control: --min-year (default 2020) — moot for the current
    OTB corpus (Lumbra 2025) but enforced so a future lichess import cannot
    silently leak Maia-1 training games (trained on lichess <= 2019);
  * hyperparameter freeze (E5-lite): a small top-p x depth grid ablated on a
    train-split subset; the Brier-best config is frozen into results.json
    and used for the main pass.

Resumable: samples.jsonl is written once (atomic), ablation.jsonl and
evals.jsonl are append-only and re-scanned on start, so a killed run loses
at most one position. Low-priority friendly: --nice renices the script and
every engine it spawns; engines are single-threaded throughout.

Requires python-chess (same single deviation from stdlib as scripts/mining):
    python3 -m pip install --user python-chess
Engines: stockfish + lc0 on PATH (or --stockfish/--lc0). Maia weights are
fetched on demand (sha256-pinned from maia.rs) into --maia-dir.

Local smoke:
    python3 scripts/e1_outcome_prediction.py --quick
Homeserver full run (after copying games.db over):
    python3 scripts/e1_outcome_prediction.py --db ~/chess/games.db \\
        --out ~/chess/e1 --per-band 2000 --nice 19
Selftest (no engines, no DB):
    python3 scripts/e1_outcome_prediction.py --selftest
"""

import argparse
import hashlib
import json
import math
import os
import random
import re
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.request

try:
    import chess
except ImportError:
    sys.exit("[e1] python-chess is required:\n"
             "  python3 -m pip install --user python-chess")

GENERATOR = "e1_outcome_prediction.py v1"

# Mirrors human_search.rs / persona.rs constants (do not drift them apart).
MATE_CP = 100_000
DEFAULT_TOP_P = 0.80
DEFAULT_MAX_CANDIDATES = 4
DEFAULT_DEPTH = 3
DEFAULT_MAX_NODES = 300
DEFAULT_LEAF_DEPTH = 10

MAIA_BANDS = [1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900]
MAIA_RELEASE_BASE = "https://github.com/CSSLab/maia-chess/releases/download/v1.0"
# SHA-256 pins copied verbatim from apps/desktop/src-tauri/src/maia.rs
# (our own record of the validated CSSLab v1.0 bytes, 2026-07-14).
MAIA_CHECKSUMS = {
    1100: "e1cf1cd0c96b8a4fa6a275f4b9fd54ed1ffebf9fe44641b9fceded310e9619c4",
    1200: "ead4ba953f233ae732999ebc1e2b675378148527ebcfad2f0acbc5e4c224d98e",
    1300: "36195f87bf4761834baa0bf87472b18509a7261a9d7d6f1a8443261369a733f2",
    1400: "d5353ea6766356dad2d28920c6692f37a5f30963767f1a3105d33b4d0af011e8",
    1500: "35ab6f20421d59e1df3b17c5a5016947af4c6761368ef84044a9a9c7619a9a00",
    1600: "d2c9e5948581acf4b9fc0b1e720c5dc0fe64ce80cfc4a239d3f8a42e1176c876",
    1700: "d277eacd792d340a30abb464dc65127254e65cac57abca17facc469889b96478",
    1800: "0031ad7c4256b1fd09fbebd28418d644d68b26cd2a45df4967ccf5c7ec9c4965",
    1900: "e2f565f42d7cd9f122557e6dc4eb84e5bbaedceda1d404dc485d3611c7c97a12",
}

DEFAULT_DB = os.path.expanduser(
    "~/Library/Application Support/com.hjalti.chessgui/games.db")
DEFAULT_MAIA_DIR = os.path.expanduser(
    "~/Library/Application Support/com.hjalti.chessgui/maia")

# E5-lite ablation grid: the design doc's top-p sweep at the default depth,
# plus a depth sweep at the default top-p. config id = "p<top_p>_d<depth>".
ABLATION_GRID = [
    {"top_p": 0.6, "depth": 3},
    {"top_p": 0.7, "depth": 3},
    {"top_p": 0.8, "depth": 3},   # tier-1 shipping default
    {"top_p": 0.9, "depth": 3},
    {"top_p": 0.8, "depth": 2},
    {"top_p": 0.8, "depth": 4},
]


def config_id(cfg):
    return "p{:.2f}_d{}".format(cfg["top_p"], cfg["depth"])


# ---------------------------------------------------------------------------
# Packed move decoding (shakmaty PackedUciMove, 2 bytes LE per move)
# ---------------------------------------------------------------------------
# Layout (shakmaty 0.30.0 src/packed.rs): bits 0-5 from-square, 6-11
# to-square, 12-14 promotion role (1=P..6=K, 0=none), 15 special (put/null —
# never present in mainline game blobs; treated as decode failure).

_ROLE_CHAR = {1: "p", 2: "n", 3: "b", 4: "r", 5: "q", 6: "k"}


def _sq_name(idx):
    return "abcdefgh"[idx % 8] + str(idx // 8 + 1)


def decode_packed_moves(blob):
    """Packed BLOB -> list of UCI strings. Raises ValueError on junk."""
    if len(blob) % 2 != 0:
        raise ValueError("odd blob length %d" % len(blob))
    out = []
    for i in range(0, len(blob), 2):
        le = blob[i] | (blob[i + 1] << 8)
        if le >> 15:
            raise ValueError("special move in mainline at index %d" % (i // 2))
        frm, to = le & 0x3F, (le >> 6) & 0x3F
        role = (le >> 12) & 0x7
        uci = _sq_name(frm) + _sq_name(to)
        if role:
            if role not in _ROLE_CHAR:
                raise ValueError("bad promotion role %d" % role)
            uci += _ROLE_CHAR[role]
        out.append(uci)
    return out


# ---------------------------------------------------------------------------
# Engines
# ---------------------------------------------------------------------------

def _resolve_binary(explicit, names):
    """persona.rs resolve_stockfish() order: explicit, known paths, PATH."""
    if explicit:
        if os.path.exists(explicit):
            return explicit
        sys.exit("[e1] engine not found: %s" % explicit)
    for name in names:
        for cand in ("/opt/homebrew/bin/" + name, "/usr/local/bin/" + name,
                     "/usr/bin/" + name):
            if os.path.exists(cand):
                return cand
        try:
            out = subprocess.run(["which", name], capture_output=True,
                                 text=True)
            if out.returncode == 0 and out.stdout.strip():
                return out.stdout.strip()
        except OSError:
            pass
    return None


class UciProcess:
    """Line-oriented UCI child. Children inherit the parent's niceness."""

    def __init__(self, cmd):
        self.proc = subprocess.Popen(
            cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, bufsize=1)

    def send(self, line):
        self.proc.stdin.write(line + "\n")
        self.proc.stdin.flush()

    def read_until(self, pred):
        lines = []
        while True:
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError("engine exited unexpectedly")
            line = line.rstrip("\n")
            lines.append(line)
            if pred(line):
                return lines

    def close(self):
        try:
            self.send("quit")
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()


def parse_score_cp(line):
    """persona.rs parse_score_cp: mate m -> +-(MATE_CP - |m|) with sign."""
    toks = line.split()
    for i, tok in enumerate(toks):
        if tok == "score" and i + 2 < len(toks):
            kind, val = toks[i + 1], toks[i + 2]
            try:
                v = int(val)
            except ValueError:
                return None
            if kind == "cp":
                return v
            if kind == "mate":
                return MATE_CP - v if v >= 0 else -MATE_CP - v
            return None
    return None


class SfEval:
    """human_search.rs SfLeaf: warm single-threaded SF, fixed-depth evals,
    `ucinewgame` before every eval so results are visit-order independent."""

    def __init__(self, path):
        self.p = UciProcess([path])
        self.p.send("uci")
        self.p.read_until(lambda l: l == "uciok")
        self.p.send("setoption name Threads value 1")
        self.p.send("isready")
        self.p.read_until(lambda l: l == "readyok")

    def eval_cp(self, fen, depth):
        """Side-to-move POV cp at fixed depth."""
        self.p.send("ucinewgame")
        self.p.send("isready")
        self.p.read_until(lambda l: l == "readyok")
        self.p.send("position fen %s" % fen)
        self.p.send("go depth %d" % depth)
        last = [0]

        def scan(line):
            if line.startswith("info "):
                cp = parse_score_cp(line)
                if cp is not None:
                    last[0] = cp
            return line.startswith("bestmove")

        self.p.read_until(scan)
        return last[0]

    def close(self):
        self.p.close()


_UCI_MOVE_RE = re.compile(r"^[a-h][1-8][a-h][1-8][nbrqk]?$")
_PAREN_FIELD_RE = {}


def _paren_field(line, key):
    """maia.rs paren_field: `(P:  50.22%)` -> 50.22."""
    rx = _PAREN_FIELD_RE.get(key)
    if rx is None:
        rx = re.compile(re.escape("(" + key) + r"\s*([-+.\d]+)%?\s*\)")
        _PAREN_FIELD_RE[key] = rx
    m = rx.search(line)
    if not m:
        return None
    try:
        return float(m.group(1))
    except ValueError:
        return None


def parse_policy_lines(lines):
    """maia.rs parse_policy over raw engine lines -> (moves, value).
    moves = [(uci, prob)], value = root value-head Q (side-to-move POV)."""
    moves, value = [], None
    for raw in lines:
        t = raw.strip()
        if not t.startswith("info string "):
            continue
        body = t[len("info string "):]
        tok = body.split(None, 1)[0] if body.split() else ""
        if _UCI_MOVE_RE.match(tok):
            pct = _paren_field(body, "P:")
            if pct is not None:
                moves.append((tok, pct / 100.0))
        elif tok == "node" and value is None:
            value = _paren_field(body, "Q:")
    return moves, value


class MaiaPolicyClient:
    """One warm lc0 bound to one band (maia.rs MaiaProcess): VerboseMoveStats
    + `go nodes 1` reads the raw policy head — search would un-humanize it."""

    def __init__(self, lc0_path, weights_path, band):
        self.band = band
        self.p = UciProcess([lc0_path, "--weights=%s" % weights_path])
        self.p.send("uci")
        lines = self.p.read_until(lambda l: l == "uciok")
        idn = next((l[len("id name "):] for l in lines
                    if l.startswith("id name ")), "")
        if "lc0" not in idn.lower():
            raise RuntimeError("engine does not identify as lc0: %r" % idn)
        self.p.send("setoption name VerboseMoveStats value true")
        self.p.send("isready")
        self.p.read_until(lambda l: l == "readyok")

    def query(self, fen):
        """-> ([(uci, prob)], value_q). Serialized on the process."""
        self.p.send("position fen %s" % fen)
        self.p.send("go nodes 1")
        lines = self.p.read_until(lambda l: l.startswith("bestmove"))
        moves, value = parse_policy_lines(lines)
        if not moves:
            raise RuntimeError("lc0 returned no policy for %s" % fen)
        return moves, value

    def close(self):
        self.p.close()


def ensure_maia_weights(band, maia_dir):
    """Fetch-on-first-use with the pinned sha256, atomic write (maia.rs
    ensure_weights). Returns the weights path."""
    os.makedirs(maia_dir, exist_ok=True)
    path = os.path.join(maia_dir, "maia-%d.pb.gz" % band)
    expected = MAIA_CHECKSUMS[band]
    if os.path.exists(path):
        with open(path, "rb") as f:
            if hashlib.sha256(f.read()).hexdigest() == expected:
                return path
        print("[e1] cached maia-%d weights fail checksum; refetching" % band)
    url = "%s/maia-%d.pb.gz" % (MAIA_RELEASE_BASE, band)
    print("[e1] fetching %s" % url)
    with urllib.request.urlopen(url, timeout=60) as resp:
        data = resp.read()
    got = hashlib.sha256(data).hexdigest()
    if got != expected:
        raise RuntimeError("maia-%d checksum mismatch (expected %s, got %s)"
                           % (band, expected, got))
    fd, tmp = tempfile.mkstemp(dir=maia_dir)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    os.replace(tmp, path)
    return path


# ---------------------------------------------------------------------------
# Tier-1 human-visible tree (port of human_search.rs)
# ---------------------------------------------------------------------------

def restrict_candidates(moves, top_p, max_candidates):
    """Top-p nucleus, byte-for-byte with human_search.rs: sort prob desc
    (ties by UCI asc — total, stable), smallest prefix with cumulative mass
    >= top_p, clamped to [1, max_candidates]."""
    ordered = sorted(moves, key=lambda m: (-m[1], m[0]))
    cap = max(max_candidates, 1)
    out, mass = [], 0.0
    for m in ordered:
        if len(out) >= cap or (out and mass >= top_p):
            break
        mass += m[1]
        out.append(m)
    return out


class HumanSearch:
    """Negamax over the rating-R-visible tree. Linked scalar band only (the
    E1 protocol) — with R_opening = R_middlegame = R_endgame the per-node
    phase conditioning of human_search.rs is the identity, so it is omitted.

    policy_fn(fen) -> [(uci, prob)]; leaf_fn(fen) -> side-to-move POV cp.
    `tt` maps key -> (depth, cp): depth-aware reuse for interior entries,
    leaf entries under a band-free key shared across configs of one position.
    """

    def __init__(self, policy_fn, leaf_fn, top_p, max_candidates, depth,
                 max_nodes, leaf_depth, band, tt=None):
        self.policy_fn = policy_fn
        self.leaf_fn = leaf_fn
        self.top_p = top_p
        self.max_candidates = max_candidates
        self.depth = depth
        self.max_nodes = max_nodes
        self.leaf_depth = leaf_depth
        self.band = band
        self.tt = tt if tt is not None else {}
        self.nodes = 0
        self.leaf_evals = 0
        self.tt_hits = 0

    def _tt_key(self, epd):
        return "%s|%d|%d|%.3f|%d" % (epd, self.band, self.leaf_depth,
                                     self.top_p, self.max_candidates)

    def _leaf_key(self, epd):
        return "%s|leaf|%d" % (epd, self.leaf_depth)

    def _leaf_value(self, board, epd):
        lkey = self._leaf_key(epd)
        hit = self.tt.get(lkey)
        if hit is not None:
            self.tt_hits += 1
            return hit[1]
        cp = self.leaf_fn(board.fen())
        self.leaf_evals += 1
        self.tt[lkey] = (0, cp)
        return cp

    def _search(self, board, depth, ply):
        """-> side-to-move POV cp."""
        # Terminal nodes need no policy and no engine.
        if not any(board.legal_moves):
            return -(MATE_CP - ply) if board.is_check() else 0
        if board.is_insufficient_material():
            return 0

        epd = board.epd()  # en_passant="legal" default matches shakmaty
        key = self._tt_key(epd)
        hit = self.tt.get(key)
        if hit is not None and hit[0] >= depth:
            self.tt_hits += 1
            return hit[1]

        self.nodes += 1
        if depth == 0 or self.nodes > self.max_nodes:
            return self._leaf_value(board, epd)

        policy = self.policy_fn(board.fen())
        legal = {m.uci() for m in board.legal_moves}
        visible = restrict_candidates(
            [m for m in policy if m[0] in legal],
            self.top_p, self.max_candidates)
        if not visible:
            # Policy carried no legal move: score as a leaf, don't fail.
            return self._leaf_value(board, epd)

        best = -(2 * MATE_CP)
        for uci, _prob in visible:
            board.push(chess.Move.from_uci(uci))
            v = -self._search(board, depth - 1, ply + 1)
            board.pop()
            if v > best:
                best = v
        self.tt[key] = (depth, best)
        return best

    def search_root(self, fen):
        """-> dict with White-POV cp + stats (HumanSearchResult shape)."""
        board = chess.Board(fen)
        cp_mover = self._search(board, self.depth, 0)
        cp_white = cp_mover if board.turn == chess.WHITE else -cp_mover
        return {"band": self.band, "cp_white": cp_white,
                "nodes": self.nodes, "leaf_evals": self.leaf_evals,
                "tt_hits": self.tt_hits}


def material_cp(board):
    """Classical count, White POV cp (P/N/B/R/Q = 1/3/3/5/9)."""
    vals = {chess.PAWN: 100, chess.KNIGHT: 300, chess.BISHOP: 300,
            chess.ROOK: 500, chess.QUEEN: 900, chess.KING: 0}
    total = 0
    for piece in board.piece_map().values():
        v = vals[piece.piece_type]
        total += v if piece.color == chess.WHITE else -v
    return total


# ---------------------------------------------------------------------------
# Sampling from the games DB
# ---------------------------------------------------------------------------

def nearest_band(avg_elo):
    """Nearest Maia band iff within +-50 (half the band spacing), else None."""
    band = min(MAIA_BANDS, key=lambda b: abs(b - avg_elo))
    return band if abs(band - avg_elo) <= 50 else None


def player_bucket(name, test_frac):
    """Deterministic player -> split. Bucket 0..999 by name sha256."""
    norm = " ".join(name.strip().lower().split())
    h = int.from_bytes(hashlib.sha256(norm.encode()).digest()[:4], "big")
    return "test" if (h % 1000) < int(test_frac * 1000) else "train"


def game_split(white, black, test_frac):
    """Player-disjoint: both-test -> test, both-train -> train, mixed -> None."""
    w, b = player_bucket(white, test_frac), player_bucket(black, test_frac)
    return w if w == b else None


def year_of(date_str):
    m = re.match(r"^(\d{4})", date_str or "")
    return int(m.group(1)) if m else None


def sample_positions(db_path, bands, per_band, seed, min_ply, max_elo_diff,
                     min_year, test_frac):
    """One position per selected game -> list of sample dicts. Deterministic
    for a given (db contents, args): candidate ids are ordered by game id and
    drawn with a fixed-seed RNG; the ply is drawn from a per-game RNG."""
    con = sqlite3.connect("file:%s?mode=ro" % db_path, uri=True)
    con.row_factory = sqlite3.Row
    print("[e1] scanning eligible games (bands %s)..." %
          ",".join(str(b) for b in bands))
    rows = con.execute(
        "SELECT id, white, black, white_elo, black_elo, result, date,"
        "       ply_count"
        "  FROM games"
        " WHERE white_elo IS NOT NULL AND black_elo IS NOT NULL"
        "   AND result IN ('1-0', '0-1', '1/2-1/2')"
        "   AND ply_count >= ?"
        "   AND abs(white_elo - black_elo) <= ?"
        " ORDER BY id",
        (min_ply + 8, max_elo_diff)).fetchall()

    by_band = {b: [] for b in bands}
    for r in rows:
        band = nearest_band((r["white_elo"] + r["black_elo"]) / 2.0)
        if band not in by_band:
            continue
        y = year_of(r["date"])
        if y is not None and y < min_year:
            continue
        split = game_split(r["white"], r["black"], test_frac)
        if split is None:
            continue
        by_band[band].append((r, split))

    rng = random.Random(seed)
    samples, skipped = [], 0
    for band in bands:
        pool = by_band[band]
        chosen = pool if len(pool) <= per_band else rng.sample(pool, per_band)
        print("[e1] band %d: %d eligible, sampling %d"
              % (band, len(pool), len(chosen)))
        for r, split in chosen:
            blob = con.execute("SELECT moves FROM games WHERE id = ?",
                               (r["id"],)).fetchone()[0]
            s = _position_from_game(r, blob, band, split, seed, min_ply)
            if s is None:
                skipped += 1
            else:
                samples.append(s)
    con.close()
    if skipped:
        print("[e1] skipped %d games (decode/replay/no clean ply)" % skipped)
    samples.sort(key=lambda s: (s["band"], s["game_id"]))
    return samples


def _position_from_game(row, blob, band, split, seed, min_ply):
    try:
        ucis = decode_packed_moves(blob)
    except ValueError:
        return None
    hi = min(len(ucis), row["ply_count"]) - 8
    if hi < min_ply:
        return None
    grng = random.Random((seed << 32) ^ row["id"])
    board = chess.Board()
    # Try a handful of plies; reject checks and terminal positions
    # (calibration.rs sampler conventions).
    for ply in grng.sample(range(min_ply, hi + 1), min(8, hi - min_ply + 1)):
        board.reset()
        try:
            for uci in ucis[:ply]:
                board.push(chess.Move.from_uci(uci))
        except (ValueError, AssertionError):
            return None  # blob/mainline mismatch; skip the game
        if board.is_check() or not any(board.legal_moves) \
                or board.is_insufficient_material():
            continue
        result_pts = {"1-0": 1.0, "0-1": 0.0, "1/2-1/2": 0.5}[row["result"]]
        return {
            "sample_id": "g%d" % row["id"],
            "game_id": row["id"],
            "band": band,
            "split": split,
            "ply": ply,
            "fen": board.fen(),
            "white_elo": row["white_elo"],
            "black_elo": row["black_elo"],
            "result": row["result"],
            "points_white": result_pts,
            "date": row["date"],
        }
    return None


# ---------------------------------------------------------------------------
# Calibration + metrics (pure python; two-parameter logistic per predictor)
# ---------------------------------------------------------------------------

def _sigmoid(z):
    if z >= 0:
        return 1.0 / (1.0 + math.exp(-z))
    e = math.exp(z)
    return e / (1.0 + e)


def fit_logistic(xs, ys, iters=200):
    """Fit P(y) = sigmoid(a*x + b) by Newton-Raphson on cross-entropy with
    fractional targets y in [0, 1]. Returns (a, b). x is standardized
    internally for conditioning; (a, b) are in original units."""
    n = len(xs)
    if n == 0:
        return 0.0, 0.0
    mu = sum(xs) / n
    sd = math.sqrt(sum((x - mu) ** 2 for x in xs) / n) or 1.0
    zs = [(x - mu) / sd for x in xs]
    a, b = 0.0, 0.0
    for _ in range(iters):
        ga = gb = 0.0
        haa = hab = hbb = 1e-9
        for z, y in zip(zs, ys):
            p = _sigmoid(a * z + b)
            d = p - y
            w = max(p * (1.0 - p), 1e-9)
            ga += d * z
            gb += d
            haa += w * z * z
            hab += w * z
            hbb += w
        det = haa * hbb - hab * hab
        if abs(det) < 1e-12:
            break
        da = (gb * hab - ga * hbb) / det
        db = (ga * hab - gb * haa) / det
        a += da
        b += db
        if abs(da) < 1e-10 and abs(db) < 1e-10:
            break
    return a / sd, b - a * mu / sd


def brier(ps, ys):
    return sum((p - y) ** 2 for p, y in zip(ps, ys)) / len(ps)


def log_loss(ps, ys):
    tot = 0.0
    for p, y in zip(ps, ys):
        p = min(max(p, 1e-6), 1.0 - 1e-6)
        tot += -(y * math.log(p) + (1.0 - y) * math.log(1.0 - p))
    return tot / len(ps)


def auc_win_vs_rest(ps, ys):
    """Mann-Whitney AUC, positives = wins (y == 1), ties get average rank.
    None when a class is empty."""
    pos = [p for p, y in zip(ps, ys) if y == 1.0]
    neg = [p for p, y in zip(ps, ys) if y < 1.0]
    if not pos or not neg:
        return None
    ranked = sorted((p, i < len(pos)) for i, p in enumerate(pos + neg))
    rank_sum, i = 0.0, 0
    while i < len(ranked):
        j = i
        while j < len(ranked) and ranked[j][0] == ranked[i][0]:
            j += 1
        avg_rank = (i + j + 1) / 2.0  # 1-based average rank of the tie block
        rank_sum += avg_rank * sum(1 for k in range(i, j) if ranked[k][1])
        i = j
    u = rank_sum - len(pos) * (len(pos) + 1) / 2.0
    return u / (len(pos) * len(neg))


def reliability_bins(ps, ys, nbins=10):
    bins = []
    for i in range(nbins):
        lo, hi = i / nbins, (i + 1) / nbins
        sel = [(p, y) for p, y in zip(ps, ys)
               if lo <= p < hi or (i == nbins - 1 and p == 1.0)]
        if sel:
            bins.append({"bin": [lo, hi], "n": len(sel),
                         "mean_pred": sum(p for p, _ in sel) / len(sel),
                         "mean_outcome": sum(y for _, y in sel) / len(sel)})
    return bins


def paired_bootstrap_brier_diff(ps_a, ps_b, ys, n_boot=1000, seed=7):
    """CI for Brier(a) - Brier(b) on the same test items (negative favors a).
    Returns (mean, lo95, hi95)."""
    n = len(ys)
    rng = random.Random(seed)
    diffs = []
    per_item = [((a - y) ** 2 - (b - y) ** 2)
                for a, b, y in zip(ps_a, ps_b, ys)]
    for _ in range(n_boot):
        s = 0.0
        for _ in range(n):
            s += per_item[rng.randrange(n)]
        diffs.append(s / n)
    diffs.sort()
    return (sum(diffs) / n_boot,
            diffs[int(0.025 * n_boot)], diffs[int(0.975 * n_boot)])


CLAMP_CP = 1000  # leverage guard for the logistic fit (mates -> +-10 pawns)


def predictor_x(record, name):
    """Raw predictor -> calibration input. cp predictors in clamped pawns,
    the value head raw (already in [-1, 1], side-agnostic White POV)."""
    v = record[name]
    if name == "maia_value_white":
        return v
    return max(-CLAMP_CP, min(CLAMP_CP, v)) / 100.0


PREDICTORS = ["material_cp", "sf_cp", "eval_r_cp", "maia_value_white"]


def evaluate_predictors(samples, evals, predictors=PREDICTORS):
    """Calibrate on train, score on test — per band and pooled. Returns the
    results dict for results.json."""
    joined = []
    for s in samples:
        e = evals.get(s["sample_id"])
        if e is None:
            continue
        if any(e.get(p) is None for p in predictors):
            continue
        joined.append({**s, **e})

    out = {"n_joined": len(joined), "bands": {}, "pooled": None}
    bands = sorted({r["band"] for r in joined})
    groups = [("band:%d" % b, [r for r in joined if r["band"] == b])
              for b in bands]
    groups.append(("pooled", joined))

    for label, rows in groups:
        train = [r for r in rows if r["split"] == "train"]
        test = [r for r in rows if r["split"] == "test"]
        entry = {"n_train": len(train), "n_test": len(test), "predictors": {}}
        if len(train) < 30 or len(test) < 30:
            entry["skipped"] = "too few samples for a stable fit"
        else:
            ys_test = [r["points_white"] for r in test]
            preds = {}
            for name in predictors:
                a, b = fit_logistic([predictor_x(r, name) for r in train],
                                    [r["points_white"] for r in train])
                ps = [_sigmoid(a * predictor_x(r, name) + b) for r in test]
                preds[name] = ps
                entry["predictors"][name] = {
                    "calibration": {"a": a, "b": b},
                    "brier": brier(ps, ys_test),
                    "log_loss": log_loss(ps, ys_test),
                    "auc_win_vs_rest": auc_win_vs_rest(ps, ys_test),
                    "reliability": reliability_bins(ps, ys_test),
                }
            mean, lo, hi = paired_bootstrap_brier_diff(
                preds["eval_r_cp"], preds["sf_cp"], ys_test)
            entry["brier_diff_eval_r_minus_sf"] = {
                "mean": mean, "ci95": [lo, hi],
                "eval_r_wins": hi < 0,
                "sf_wins": lo > 0,
            }
        key = label.split(":", 1)
        if key[0] == "band":
            out["bands"][key[1]] = entry
        else:
            out["pooled"] = entry
    return out


# ---------------------------------------------------------------------------
# Resumable run state
# ---------------------------------------------------------------------------

def args_fingerprint(args):
    """Everything that would change WHICH positions are sampled. A changed
    fingerprint in an existing --out dir aborts instead of mixing corpora."""
    key = {k: getattr(args, k) for k in
           ("db", "seed", "per_band", "bands", "min_ply", "max_elo_diff",
            "min_year", "test_frac")}
    return hashlib.sha256(
        json.dumps(key, sort_keys=True).encode()).hexdigest()[:16]


def load_jsonl(path):
    rows = []
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        rows.append(json.loads(line))
                    except json.JSONDecodeError:
                        break  # torn tail from a killed run; drop the rest
    return rows


def append_jsonl(path, row):
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(row, separators=(",", ":")) + "\n")


def write_atomic(path, text):
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path) or ".")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


# ---------------------------------------------------------------------------
# Pipeline stages
# ---------------------------------------------------------------------------

def stage_samples(args, paths):
    if os.path.exists(paths["samples"]):
        samples = load_jsonl(paths["samples"])
        print("[e1] resuming with %d existing samples" % len(samples))
        return samples
    samples = sample_positions(
        args.db, args.bands, args.per_band, args.seed, args.min_ply,
        args.max_elo_diff, args.min_year, args.test_frac)
    if not samples:
        sys.exit("[e1] no eligible positions sampled — check --bands / DB")
    write_atomic(paths["samples"],
                 "".join(json.dumps(s, separators=(",", ":")) + "\n"
                         for s in samples))
    print("[e1] wrote %d samples" % len(samples))
    return samples


class EngineFarm:
    """Owns the SF process and at most one lc0 at a time; work is fed to it
    band-grouped so band switches (process restarts) are rare."""

    def __init__(self, args):
        self.sf_path = _resolve_binary(args.stockfish, ["stockfish"])
        self.lc0_path = _resolve_binary(args.lc0, ["lc0"])
        if not self.sf_path:
            sys.exit("[e1] stockfish not found — brew install stockfish "
                     "or pass --stockfish")
        if not self.lc0_path:
            sys.exit("[e1] lc0 not found — brew install lc0 or pass --lc0")
        self.maia_dir = args.maia_dir
        self.sf = SfEval(self.sf_path)
        self.lc0 = None

    def maia(self, band):
        if self.lc0 is not None and self.lc0.band == band:
            return self.lc0
        if self.lc0 is not None:
            self.lc0.close()
        weights = ensure_maia_weights(band, self.maia_dir)
        self.lc0 = MaiaPolicyClient(self.lc0_path, weights, band)
        return self.lc0

    def close(self):
        self.sf.close()
        if self.lc0 is not None:
            self.lc0.close()


def eval_r_for(sample, farm, args, top_p, depth, shared_tt, policy_cache):
    """One tier-1 search. policy_cache memoizes (fen -> policy/value) so the
    ablation grid re-uses root/interior policies across configs; shared_tt
    carries band-free leaf entries across configs of the same position."""
    lc0 = farm.maia(sample["band"])

    def policy_fn(fen):
        hit = policy_cache.get(fen)
        if hit is None:
            hit = lc0.query(fen)
            policy_cache[fen] = hit
        return hit[0]

    def leaf_fn(fen):
        return farm.sf.eval_cp(fen, args.leaf_depth)

    hs = HumanSearch(policy_fn, leaf_fn, top_p, args.max_candidates, depth,
                     args.max_nodes, args.leaf_depth, sample["band"],
                     tt=shared_tt)
    return hs.search_root(sample["fen"])


def stage_ablation(args, paths, samples, farm, state):
    """E5-lite: freeze (top_p, depth) by train-subset Brier. Resumable via
    ablation.jsonl; the frozen choice is recorded in state.json."""
    if state.get("frozen_config"):
        return state["frozen_config"]
    if args.no_ablation:
        frozen = {"top_p": args.top_p, "depth": args.depth,
                  "source": "defaults (--no-ablation)"}
        state["frozen_config"] = frozen
        save_state(paths, state)
        return frozen

    train = [s for s in samples if s["split"] == "train"]
    rng = random.Random(args.seed + 1)
    subset = train if len(train) <= args.ablate_n \
        else rng.sample(train, args.ablate_n)
    subset.sort(key=lambda s: (s["band"], s["game_id"]))

    done = {}  # (config_id, sample_id) -> eval_r_cp
    for row in load_jsonl(paths["ablation"]):
        done[(row["config"], row["sample_id"])] = row["eval_r_cp"]

    total = len(subset) * len(ABLATION_GRID)
    print("[e1] ablation: %d positions x %d configs (%d already done)"
          % (len(subset), len(ABLATION_GRID), len(done)))
    t0 = time.time()
    n_new = 0
    for s in subset:
        shared_tt, policy_cache = {}, {}
        for cfg in ABLATION_GRID:
            cid = config_id(cfg)
            if (cid, s["sample_id"]) in done:
                continue
            r = eval_r_for(s, farm, args, cfg["top_p"], cfg["depth"],
                           shared_tt, policy_cache)
            append_jsonl(paths["ablation"],
                         {"config": cid, "sample_id": s["sample_id"],
                          "eval_r_cp": r["cp_white"], "nodes": r["nodes"],
                          "leaf_evals": r["leaf_evals"]})
            done[(cid, s["sample_id"])] = r["cp_white"]
            n_new += 1
            if n_new % 25 == 0:
                rate = n_new / (time.time() - t0)
                print("[e1] ablation %d/%d (%.2f evals/s)"
                      % (len(done), total, rate))

    # Score each config: fit + Brier on the subset (2 params on >= ~10^2
    # points; in-sample optimism is negligible at this parameter count).
    scores = {}
    for cfg in ABLATION_GRID:
        cid = config_id(cfg)
        xs, ys = [], []
        for s in subset:
            v = done.get((cid, s["sample_id"]))
            if v is not None:
                xs.append(max(-CLAMP_CP, min(CLAMP_CP, v)) / 100.0)
                ys.append(s["points_white"])
        if len(xs) < 30:
            continue
        a, b = fit_logistic(xs, ys)
        scores[cid] = brier([_sigmoid(a * x + b) for x in xs], ys)
    if not scores:
        frozen = {"top_p": args.top_p, "depth": args.depth,
                  "source": "defaults (ablation subset too small)"}
    else:
        best = min(scores, key=scores.get)
        cfg = next(c for c in ABLATION_GRID if config_id(c) == best)
        frozen = {"top_p": cfg["top_p"], "depth": cfg["depth"],
                  "source": "ablation argmin train-subset Brier",
                  "subset_n": len(subset),
                  "scores": {k: round(v, 6) for k, v in sorted(scores.items())}}
    print("[e1] frozen hyperparams: top_p=%.2f depth=%d (%s)"
          % (frozen["top_p"], frozen["depth"], frozen["source"]))
    state["frozen_config"] = frozen
    save_state(paths, state)
    return frozen


def stage_evals(args, paths, samples, farm, frozen):
    """Main predictor pass: material, SF eval, Maia value head, Eval_R at the
    frozen config. Appends one evals.jsonl row per position; resumable."""
    done = {r["sample_id"]: r for r in load_jsonl(paths["evals"])}
    pending = [s for s in samples if s["sample_id"] not in done]
    pending.sort(key=lambda s: (s["band"], s["game_id"]))  # band-grouped
    print("[e1] main pass: %d positions (%d already done)"
          % (len(pending), len(done)))
    t0, n_new = time.time(), 0
    for s in pending:
        board = chess.Board(s["fen"])
        mat = material_cp(board)
        sf_cp_stm = farm.sf.eval_cp(s["fen"], args.sf_depth)
        sf_cp = sf_cp_stm if board.turn == chess.WHITE else -sf_cp_stm

        shared_tt, policy_cache = {}, {}
        r = eval_r_for(s, farm, args, frozen["top_p"], frozen["depth"],
                       shared_tt, policy_cache)
        # Root policy was memoized by the search; its Q is the value head.
        _moves, value_q = policy_cache.get(s["fen"], (None, None))
        value_white = None
        if value_q is not None:
            value_white = value_q if board.turn == chess.WHITE else -value_q

        row = {"sample_id": s["sample_id"], "material_cp": mat,
               "sf_cp": sf_cp, "eval_r_cp": r["cp_white"],
               "maia_value_white": value_white, "nodes": r["nodes"],
               "leaf_evals": r["leaf_evals"], "tt_hits": r["tt_hits"]}
        append_jsonl(paths["evals"], row)
        done[s["sample_id"]] = row
        n_new += 1
        if n_new % 10 == 0:
            rate = n_new / (time.time() - t0)
            eta = (len(pending) - n_new) / rate if rate > 0 else 0
            print("[e1] main %d/%d (%.2f pos/s, eta %.0f min)"
                  % (len(done), len(samples), rate, eta / 60))
    return done


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------

def _fmt(v, digits=4):
    return "-" if v is None else ("%.*f" % (digits, v))


def render_summary_md(results, args, frozen, runtime_s):
    r = results
    lines = [
        "# E1 — outcome prediction vs Stockfish eval (spec 213 Phase 4)",
        "",
        "Generated by %s on %s. Runtime %.0f s.%s" % (
            GENERATOR, time.strftime("%Y-%m-%d %H:%M"), runtime_s,
            " **QUICK SMOKE — numbers are not evidence.**"
            if args.quick else ""),
        "",
        "DB: `%s` | seed %d | per-band %d | bands %s" % (
            args.db, args.seed, args.per_band,
            ",".join(str(b) for b in args.bands)),
        "",
        "Eval_R: tier-1 human-visible tree (UCI reimplementation of "
        "human_search.rs), linked scalar band = the game's band.",
        "",
        "## Frozen tier-1 hyperparameters",
        "",
        "| knob | value |",
        "|---|---|",
        "| top_p | %.2f |" % frozen["top_p"],
        "| depth | %d |" % frozen["depth"],
        "| max_candidates | %d |" % args.max_candidates,
        "| max_nodes | %d |" % args.max_nodes,
        "| leaf_depth (SF) | %d |" % args.leaf_depth,
        "| selection | %s |" % frozen["source"],
        "",
    ]
    if frozen.get("scores"):
        lines += ["Ablation Brier per config (train subset, n=%d): %s" %
                  (frozen.get("subset_n", 0),
                   ", ".join("`%s`=%.4f" % kv
                             for kv in sorted(frozen["scores"].items()))),
                  ""]

    lines += ["## Head-to-head (test split)", "",
              "| group | n_test | material | SF eval | **Eval_R** | value head"
              " | Brier(Eval_R − SF) [95% CI] | verdict |",
              "|---|---|---|---|---|---|---|---|"]
    groups = [("band %s" % b, r["bands"][b]) for b in sorted(r["bands"])]
    groups.append(("pooled", r["pooled"]))
    for label, e in groups:
        if e is None:
            continue
        if e.get("skipped"):
            lines.append("| %s | %d | — | — | — | — | %s | — |"
                         % (label, e["n_test"], e["skipped"]))
            continue
        p = e["predictors"]
        d = e["brier_diff_eval_r_minus_sf"]
        verdict = ("**Eval_R wins**" if d["eval_r_wins"]
                   else "SF wins" if d["sf_wins"] else "inconclusive")
        lines.append(
            "| %s | %d | %s | %s | **%s** | %s | %+.4f [%+.4f, %+.4f] | %s |"
            % (label, e["n_test"],
               _fmt(p["material_cp"]["brier"]), _fmt(p["sf_cp"]["brier"]),
               _fmt(p["eval_r_cp"]["brier"]),
               _fmt(p["maia_value_white"]["brier"]),
               d["mean"], d["ci95"][0], d["ci95"][1], verdict))
    lines += [
        "",
        "Brier score, lower is better (draws = 0.5). Full metrics "
        "(log-loss, AUC win-vs-rest, reliability bins, calibration "
        "coefficients) in `results.json`.",
        "",
        "## Honest caveats",
        "",
        "- Corpus is OTB (Lumbra); Maia-1 is trained on lichess blitz/rapid —"
        " band semantics differ between the two rating pools.",
        "- Sub-1400 bands are nearly empty in this corpus; their rows are"
        " skipped or noisy.",
        "- Ablation selects on in-sample train-subset Brier (2-parameter"
        " fits; optimism is small but nonzero).",
        "- Complexity stratification (Guid-Bratko) is future work — this run"
        " reports overall metrics only.",
    ]
    return "\n".join(lines) + "\n"


def save_state(paths, state):
    write_atomic(paths["state"], json.dumps(state, indent=2))


# ---------------------------------------------------------------------------
# Selftest (pure logic — no DB, no engines, no network)
# ---------------------------------------------------------------------------

def selftest():
    fails = []
    total = [0]

    def check(name, cond):
        total[0] += 1
        print("  %s %s" % ("ok " if cond else "FAIL", name))
        if not cond:
            fails.append(name)

    # Packed move decode: pack a few by hand per the shakmaty layout.
    def pack(frm, to, role=0):
        le = frm | (to << 6) | (role << 12)
        return bytes([le & 0xFF, le >> 8])

    e2, e4 = 12, 28          # e2 = file 4 rank 1 -> 8*1+4
    blob = pack(e2, e4) + pack(52, 60, 5)  # e2e4, e7e8q
    check("decode_packed_moves", decode_packed_moves(blob) == ["e2e4", "e7e8q"])
    try:
        decode_packed_moves(pack(0, 0) + b"\x00\x80")
        check("decode rejects special bit", False)
    except ValueError:
        check("decode rejects special bit", True)

    # Nucleus restriction — the human_search.rs unit tests, ported.
    moves = [("a2a3", 0.05), ("e2e4", 0.50), ("d2d4", 0.30), ("g1f3", 0.15)]
    r = restrict_candidates(moves, 0.80, 4)
    check("top-p smallest prefix", [m[0] for m in r] == ["e2e4", "d2d4"])
    r = restrict_candidates(moves, 0.81, 4)
    check("top-p boundary admits third", len(r) == 3 and r[2][0] == "g1f3")
    r = restrict_candidates([("e2e4", 0.4), ("d2d4", 0.35)], 0.0, 4)
    check("clamp min one", len(r) == 1 and r[0][0] == "e2e4")
    r = restrict_candidates([("e2e4", 0.4), ("d2d4", 0.35), ("g1f3", 0.25)],
                            1.0, 2)
    check("cap beats mass", len(r) == 2)
    r = restrict_candidates([("d2d4", 0.5), ("e2e4", 0.5)], 0.4, 4)
    check("tie-break by uci asc", r[0][0] == "d2d4")

    # Minimax fixture from human_search.rs: root {e4,d4}; e4:{e5,c5}
    # leaves +120/-80 (White POV); d4:{d5,Nf6} leaves +30/+10.
    # Hand minimax: root = +10 via d4 Nf6. Leaf tables are side-to-move POV.
    start = chess.Board()

    def epd_after(ucis):
        b = chess.Board()
        for u in ucis:
            b.push(chess.Move.from_uci(u))
        return b.epd()

    policy_tbl = {
        start.epd(): [("e2e4", 0.5), ("d2d4", 0.5)],
        epd_after(["e2e4"]): [("e7e5", 0.6), ("c7c5", 0.4)],
        epd_after(["d2d4"]): [("d7d5", 0.6), ("g8f6", 0.4)],
    }
    # White-POV leaves converted to mover POV (Black to move at leaves? No —
    # after two plies White is to move again, so mover POV == White POV).
    leaf_tbl = {
        epd_after(["e2e4", "e7e5"]): 120,
        epd_after(["e2e4", "c7c5"]): -80,
        epd_after(["d2d4", "d7d5"]): 30,
        epd_after(["d2d4", "g8f6"]): 10,
    }
    calls = {"leaf": 0}

    def policy_fn(fen):
        return policy_tbl[chess.Board(fen).epd()]

    def leaf_fn(fen):
        calls["leaf"] += 1
        return leaf_tbl[chess.Board(fen).epd()]

    hs = HumanSearch(policy_fn, leaf_fn, 1.0, 4, 2, 300, 1, 1500)
    res = hs.search_root(start.fen())
    check("minimax exact (+10)", res["cp_white"] == 10)
    check("minimax leaf count", res["leaf_evals"] == 4 and calls["leaf"] == 4)

    # Repeat search served from the shared TT.
    hs2 = HumanSearch(policy_fn, leaf_fn, 1.0, 4, 2, 300, 1, 1500, tt=hs.tt)
    res2 = hs2.search_root(start.fen())
    check("tt reuse", res2["cp_white"] == 10 and res2["leaf_evals"] == 0
          and calls["leaf"] == 4)

    # The spec's named test: resource in/out of the nucleus flips the eval.
    policy_tbl2 = {
        start.epd(): [("e2e4", 1.0)],
        epd_after(["e2e4"]): [("e7e5", 0.70), ("b8a6", 0.29)],
    }
    leaf_tbl2 = {
        epd_after(["e2e4", "e7e5"]): 50,
        epd_after(["e2e4", "b8a6"]): -300,
    }

    def policy_fn2(fen):
        return policy_tbl2[chess.Board(fen).epd()]

    def leaf_fn2(fen):
        return leaf_tbl2[chess.Board(fen).epd()]

    blind = HumanSearch(policy_fn2, leaf_fn2, 0.70, 4, 2, 300, 1, 1500)
    sighted = HumanSearch(policy_fn2, leaf_fn2, 0.99, 4, 2, 300, 1, 1500)
    check("resource invisible -> +50",
          blind.search_root(start.fen())["cp_white"] == 50)
    check("resource visible -> -300",
          sighted.search_root(start.fen())["cp_white"] == -300)

    # Node budget degrades to shallower leaves, never fails.
    leaf_tbl3 = dict(leaf_tbl)
    leaf_tbl3[epd_after(["e2e4"])] = 80    # Black to move: mover POV
    leaf_tbl3[epd_after(["d2d4"])] = -10

    def leaf_fn3(fen):
        return leaf_tbl3[chess.Board(fen).epd()]

    hs3 = HumanSearch(policy_fn, leaf_fn3, 1.0, 4, 2, 1, 1, 1500)
    check("node budget -> depth-1 semantics",
          hs3.search_root(start.fen())["cp_white"] == 10)

    # Terminal positions.
    mated = "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3"
    hs4 = HumanSearch(lambda f: [], lambda f: 0, 0.8, 4, 2, 300, 1, 1500)
    check("checkmate scores -MATE_CP",
          hs4.search_root(mated)["cp_white"] == -MATE_CP)
    stale = "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1"
    hs5 = HumanSearch(lambda f: [], lambda f: 0, 0.8, 4, 2, 300, 1, 1500)
    check("stalemate scores 0", hs5.search_root(stale)["cp_white"] == 0)

    # parse_score_cp mate mapping (persona.rs semantics).
    check("score cp", parse_score_cp("info depth 10 score cp -34 pv") == -34)
    check("score mate +3",
          parse_score_cp("info score mate 3") == MATE_CP - 3)
    check("score mate -2",
          parse_score_cp("info score mate -2") == -MATE_CP + 2)

    # Policy line parsing on captured lc0 0.31.2 output (maia.rs fixture).
    lc0_lines = [
        "info string b1a3  (34  ) N:       0 (+ 0) (P:  0.04%) (Q:  0.04017)",
        "info string e2e4  (322 ) N:       0 (+ 0) (P: 50.22%) (Q:  0.04017)",
        "info string node  (  20) N:       1 (+ 0) (P:  0.00%) (Q:  0.03821)",
        "bestmove e2e4",
    ]
    moves, value = parse_policy_lines(lc0_lines)
    check("lc0 policy parse", dict(moves)["e2e4"] == 0.5022
          and abs(value - 0.03821) < 1e-9)

    # Logistic fit recovers a known curve.
    rng = random.Random(42)
    a_true, b_true = 1.4, -0.3
    xs = [rng.uniform(-4, 4) for _ in range(4000)]
    ys = [1.0 if rng.random() < _sigmoid(a_true * x + b_true) else 0.0
          for x in xs]
    a, b = fit_logistic(xs, ys)
    check("logistic fit recovers params",
          abs(a - a_true) < 0.15 and abs(b - b_true) < 0.15)

    # Metrics sanity.
    check("brier perfect", brier([1.0, 0.0], [1.0, 0.0]) == 0.0)
    check("auc separable",
          auc_win_vs_rest([0.9, 0.8, 0.2, 0.1], [1, 1, 0, 0.5]) == 1.0)
    check("auc ties", auc_win_vs_rest([0.5, 0.5], [1, 0]) == 0.5)

    # Material count.
    check("material startpos", material_cp(chess.Board()) == 0)
    check("material up a rook", material_cp(chess.Board(
        "rnbqkbn1/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQq - 0 1")) == 500)

    # Split determinism + disjointness.
    s1 = game_split("Carlsen, Magnus", "Carlsen, Magnus", 0.25)
    s2 = game_split("carlsen,  magnus", "CARLSEN, MAGNUS", 0.25)
    check("split normalizes names", s1 == s2 and s1 in ("train", "test"))
    check("mixed pairing dropped", all(
        game_split(a, b, 0.25) is None
        or player_bucket(a, 0.25) == player_bucket(b, 0.25)
        for a, b in [("A", "B"), ("C", "D"), ("E", "F")]))

    print("[e1] selftest: %d checks, %d failures" % (total[0], len(fails)))
    return 1 if fails else 0


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def parse_args(argv=None):
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--db", default=DEFAULT_DB,
                   help="Path to the app's games.db (sqlite).")
    p.add_argument("--out", default="data/e1",
                   help="Output/state directory (resume point).")
    p.add_argument("--quick", action="store_true",
                   help="Smoke mode: tiny sample, shallow engines, no "
                        "ablation. Proves the pipeline, not the science.")
    p.add_argument("--selftest", action="store_true",
                   help="Run pure-logic unit tests and exit.")
    p.add_argument("--seed", type=int, default=213)
    p.add_argument("--per-band", type=int, default=2000)
    p.add_argument("--bands", default="1400,1500,1600,1700,1800,1900",
                   help="Comma list of Maia bands to sample "
                        "(sub-1400 is nearly empty in the OTB corpus).")
    p.add_argument("--min-ply", type=int, default=16)
    p.add_argument("--max-elo-diff", type=int, default=150)
    p.add_argument("--min-year", type=int, default=2020,
                   help="Contamination control (Maia-1 trained on lichess "
                        "<= 2019).")
    p.add_argument("--test-frac", type=float, default=0.25,
                   help="Player-bucket fraction assigned to test.")
    # Engines + tier-1 knobs (defaults = human_search.rs shipping defaults).
    p.add_argument("--stockfish", default=None)
    p.add_argument("--lc0", default=None)
    p.add_argument("--maia-dir", default=DEFAULT_MAIA_DIR)
    p.add_argument("--sf-depth", type=int, default=12,
                   help="Fixed depth for the standalone SF-eval predictor.")
    p.add_argument("--leaf-depth", type=int, default=DEFAULT_LEAF_DEPTH)
    p.add_argument("--top-p", type=float, default=DEFAULT_TOP_P)
    p.add_argument("--depth", type=int, default=DEFAULT_DEPTH)
    p.add_argument("--max-candidates", type=int,
                   default=DEFAULT_MAX_CANDIDATES)
    p.add_argument("--max-nodes", type=int, default=DEFAULT_MAX_NODES)
    # Ablation (E5-lite).
    p.add_argument("--no-ablation", action="store_true",
                   help="Skip the hyperparameter grid; freeze the defaults.")
    p.add_argument("--ablate-n", type=int, default=400,
                   help="Train-subset size for the ablation grid.")
    p.add_argument("--nice", type=int, default=10,
                   help="Renice this process (engines inherit). 0 disables.")
    args = p.parse_args(argv)
    args.bands = sorted({int(b) for b in args.bands.split(",") if b.strip()})
    for b in args.bands:
        if b not in MAIA_BANDS:
            p.error("band %d has no Maia-1 net (valid: %s)"
                    % (b, MAIA_BANDS))
    if args.quick:
        args.per_band = min(args.per_band, 6)
        args.bands = [b for b in args.bands if b in (1700, 1900)] or [1700]
        args.sf_depth = min(args.sf_depth, 8)
        args.leaf_depth = min(args.leaf_depth, 6)
        args.depth = min(args.depth, 2)
        args.no_ablation = True
    return args


def main():
    args = parse_args()
    if args.selftest:
        sys.exit(selftest())

    if args.nice > 0:
        try:
            os.nice(args.nice)
        except OSError:
            pass

    if not os.path.exists(args.db):
        sys.exit("[e1] games DB not found: %s (pass --db)" % args.db)
    os.makedirs(args.out, exist_ok=True)
    paths = {k: os.path.join(args.out, v) for k, v in {
        "state": "state.json", "samples": "samples.jsonl",
        "ablation": "ablation.jsonl", "evals": "evals.jsonl",
        "results": "results.json", "summary": "summary.md"}.items()}

    fp = args_fingerprint(args)
    state = {}
    if os.path.exists(paths["state"]):
        with open(paths["state"], encoding="utf-8") as f:
            state = json.load(f)
        if state.get("fingerprint") not in (None, fp):
            sys.exit("[e1] %s holds a run with different sampling args "
                     "(fingerprint %s != %s) — use a fresh --out"
                     % (args.out, state.get("fingerprint"), fp))
    state["fingerprint"] = fp
    state.setdefault("started_at", time.strftime("%Y-%m-%dT%H:%M:%S"))
    save_state(paths, state)

    t0 = time.time()
    samples = stage_samples(args, paths)

    farm = EngineFarm(args)
    try:
        frozen = stage_ablation(args, paths, samples, farm, state)
        evals = stage_evals(args, paths, samples, farm, frozen)
    finally:
        farm.close()

    results = evaluate_predictors(samples, evals)
    runtime = time.time() - t0
    payload = {
        "generator": GENERATOR,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "quick": args.quick,
        "db": args.db,
        "args": {k: v for k, v in vars(args).items()
                 if k not in ("stockfish", "lc0")},
        "frozen_hyperparams": {
            **{k: v for k, v in state["frozen_config"].items()},
            "max_candidates": args.max_candidates,
            "max_nodes": args.max_nodes,
            "leaf_depth": args.leaf_depth,
        },
        "n_samples": len(samples),
        "runtime_seconds": round(runtime, 1),
        "results": results,
    }
    write_atomic(paths["results"], json.dumps(payload, indent=2))
    write_atomic(paths["summary"],
                 render_summary_md(results, args, state["frozen_config"],
                                   runtime))
    print("[e1] wrote %s and %s" % (paths["results"], paths["summary"]))
    if args.quick:
        print("[e1] QUICK SMOKE complete — pipeline executes; numbers are "
              "not evidence.")


if __name__ == "__main__":
    main()
