#!/usr/bin/env python3
"""uciengine.py — minimal persistent UCI client for the mining scripts.

Spec 211 Tier-1 requires every eval cliff to be re-verified with local
Stockfish at fixed depth ("refutation must be engine-confirmed ... don't
trust [%eval] alone", specs/211-avoidance-puzzles.md:50-51). This module is
the plumbing for that: one long-lived engine process, fixed-depth searches,
MultiPV support for the ≥3-reasonable-alternatives filter.

Scores are returned from the SIDE-TO-MOVE perspective (UCI convention),
with mate-in-N mapped onto the cp scale as ±(MATE_CP - N) so threshold
comparisons treat "allows mate" as the deepest possible cliff.

Stdlib only.
"""

import subprocess

MATE_CP = 10000  # mate-in-N maps to ±(MATE_CP - N); always beats any cp gate


def mate_to_cp(n):
    """UCI 'score mate n' -> cp-scale int (n>0: stm mates, n<0: stm is mated)."""
    return (MATE_CP - n) if n > 0 else (-MATE_CP - n)


class SearchLine:
    """One MultiPV entry of a finished search."""

    __slots__ = ("cp", "mate", "pv")

    def __init__(self, cp, mate, pv):
        self.cp = cp        # score on the cp scale (mate already mapped)
        self.mate = mate    # raw mate distance, or None for a cp score
        self.pv = pv        # list of UCI move strings

    @property
    def move(self):
        return self.pv[0] if self.pv else None


class UciEngine:
    """Persistent UCI engine. search() runs fixed-depth, returns MultiPV lines."""

    def __init__(self, path, threads=1, hash_mb=128, nice_prefix=None):
        cmd = list(nice_prefix or []) + [path]
        self.proc = subprocess.Popen(
            cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, bufsize=1)
        self._multipv = 1
        self._send("uci")
        self._wait_for("uciok")
        self._setoption("Threads", threads)
        self._setoption("Hash", hash_mb)
        self._sync()

    def _send(self, line):
        self.proc.stdin.write(line + "\n")
        self.proc.stdin.flush()

    def _wait_for(self, token):
        for line in self.proc.stdout:
            if line.strip() == token:
                return
        raise RuntimeError(f"engine died waiting for '{token}'")

    def _setoption(self, name, value):
        self._send(f"setoption name {name} value {value}")

    def _sync(self):
        self._send("isready")
        self._wait_for("readyok")

    def search(self, fen, depth, moves=None, multipv=1):
        """Fixed-depth search. Returns {rank: SearchLine} (rank 1 = best),
        or None if the position is terminal (bestmove (none))."""
        if multipv != self._multipv:
            self._setoption("MultiPV", multipv)
            self._multipv = multipv
            self._sync()
        pos = f"position fen {fen}"
        if moves:
            pos += " moves " + " ".join(moves)
        self._send(pos)
        self._send(f"go depth {depth}")

        lines = {}
        for raw in self.proc.stdout:
            tok = raw.split()
            if not tok:
                continue
            if tok[0] == "bestmove":
                if tok[1] == "(none)":
                    return None
                return lines
            if tok[0] != "info" or "score" not in tok or "pv" not in tok:
                continue
            # Bound scores are progress noise, not final iteration results.
            if "lowerbound" in tok or "upperbound" in tok:
                continue
            rank = int(tok[tok.index("multipv") + 1]) if "multipv" in tok else 1
            si = tok.index("score")
            kind, val = tok[si + 1], int(tok[si + 2])
            cp, mate = (mate_to_cp(val), val) if kind == "mate" else (val, None)
            pv = tok[tok.index("pv") + 1:]
            lines[rank] = SearchLine(cp, mate, pv)  # last seen = deepest
        raise RuntimeError("engine died mid-search")

    def close(self):
        try:
            self._send("quit")
            self.proc.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            self.proc.kill()
