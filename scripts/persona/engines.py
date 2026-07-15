"""Engine backends for the persona eval harness (spec 214, tier-1).

Each backend takes a FEN and returns a *ranking* of up to N candidate moves
(UCI strings, best first). Two families:

  * lc0 read at the policy head (`go nodes 1`, VerboseMoveStats) — the exact
    protocol used by the app's Rust service in src-tauri/src/maia.rs. Used for
    the Maia human-move nets AND for a strong official net (pure policy).
  * Stockfish MultiPV — top-N principal variations at a fixed movetime; the
    ranking is the multipv order.

The lc0 EOF-exit behaviour documented in maia.rs matters here: we keep one warm
process per net for the whole run and feed it line by line, never closing stdin
until we're done. Batch-piping the whole script makes lc0 exit before it flushes
the search, which is why this is a long-lived subprocess, not a one-shot pipe.

These wrappers are deliberately thin; the parsing is factored into pure
functions (parse_lc0_policy, parse_sf_multipv) so the harness can unit-test the
line handling without a live engine.
"""

from __future__ import annotations

import subprocess
import time
from typing import List, Optional, Tuple


# ---------------------------------------------------------------------------
# Pure parsers (unit-tested without a live engine)
# ---------------------------------------------------------------------------

def _is_uci_move(s: str) -> bool:
    if len(s) not in (4, 5):
        return False
    f = lambda c: "a" <= c <= "h"
    r = lambda c: "1" <= c <= "8"
    ok = f(s[0]) and r(s[1]) and f(s[2]) and r(s[3])
    if len(s) == 5:
        ok = ok and s[4] in "qrbn"
    return ok


def _paren_field(line: str, key: str) -> Optional[float]:
    """Extract a `(KEY value)` numeric field, e.g. `(P:  50.22%)` -> 50.22.

    Mirrors paren_field() in src-tauri/src/maia.rs so the two implementations
    read identical lc0 output the same way.
    """
    needle = "(" + key
    start = line.find(needle)
    if start < 0:
        return None
    start += len(needle)
    end = line.find(")", start)
    if end < 0:
        return None
    tok = line[start:end].strip().rstrip("%").strip()
    try:
        return float(tok)
    except ValueError:
        return None


def parse_lc0_policy(lines: List[str]) -> List[Tuple[str, float]]:
    """From a block of lc0 output lines, return (uci, prob) sorted best-first.

    Reads only `info string <move> ... (P: NN.NN%)` lines; ignores the `node`
    summary line. Probabilities are the raw policy head, as percentages/100.
    """
    out: List[Tuple[str, float]] = []
    for line in lines:
        t = line.strip()
        if not t.startswith("info string "):
            continue
        body = t[len("info string "):]
        parts = body.split()
        if not parts:
            continue
        tok = parts[0]
        if not _is_uci_move(tok):
            continue
        p = _paren_field(body, "P:")
        if p is not None:
            out.append((tok, p / 100.0))
    out.sort(key=lambda m: m[1], reverse=True)
    return out


def parse_sf_multipv(lines: List[str]) -> List[str]:
    """From Stockfish output, return the top moves ordered by multipv rank.

    Keeps the *last* reported first-move for each multipv index (deepest
    iteration) and orders by the multipv number, so the result is Stockfish's
    own ranking of the position's best lines.
    """
    by_rank: dict[int, str] = {}
    for line in lines:
        t = line.strip()
        if not t.startswith("info ") or " multipv " not in t or " pv " not in t:
            continue
        toks = t.split()
        try:
            rank = int(toks[toks.index("multipv") + 1])
            move = toks[toks.index("pv") + 1]
        except (ValueError, IndexError):
            continue
        if _is_uci_move(move):
            by_rank[rank] = move
    return [by_rank[k] for k in sorted(by_rank)]


MATE_CP = 100_000  # sentinel magnitude for a forced mate, minus its distance


def parse_sf_score_cp(lines: List[str], stm_is_white: bool) -> Optional[int]:
    """White-POV centipawn score from Stockfish output (deepest `score` line).

    Stockfish reports `score cp N` / `score mate N` from the side-to-move POV;
    we take the last such value (deepest iteration) and flip its sign to White's
    POV. Mates become a large magnitude that shrinks with distance, so a mate in
    1 outranks a mate in 5.
    """
    val: Optional[int] = None
    for line in lines:
        t = line.strip()
        if not t.startswith("info ") or " score " not in t:
            continue
        toks = t.split()
        try:
            i = toks.index("score")
            kind, num = toks[i + 1], int(toks[i + 2])
        except (ValueError, IndexError):
            continue
        if kind == "cp":
            val = num
        elif kind == "mate":
            val = (MATE_CP - abs(num)) * (1 if num > 0 else -1)
    if val is None:
        return None
    return val if stm_is_white else -val


# ---------------------------------------------------------------------------
# Live engine wrappers
# ---------------------------------------------------------------------------

class Lc0Policy:
    """One warm lc0 process bound to a single net, read at the policy head."""

    def __init__(self, lc0_path: str, weights_path: str, name: str):
        self.name = name
        self._p = subprocess.Popen(
            [lc0_path, f"--weights={weights_path}"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, bufsize=1,
        )
        self._send("uci")
        self._wait("uciok")
        self._send("setoption name VerboseMoveStats value true")
        self._send("isready")
        self._wait("readyok")

    def _send(self, cmd: str) -> None:
        assert self._p.stdin is not None
        self._p.stdin.write(cmd + "\n")
        self._p.stdin.flush()

    def _wait(self, tok: str) -> List[str]:
        assert self._p.stdout is not None
        lines: List[str] = []
        for line in self._p.stdout:
            line = line.rstrip("\n")
            lines.append(line)
            if line.startswith(tok):
                break
        return lines

    def policy(self, fen: str) -> List[Tuple[str, float]]:
        """Full (uci, prob) ranking over legal moves, best first (raw policy)."""
        self._send(f"position fen {fen}")
        self._send("go nodes 1")
        lines = self._wait("bestmove")
        return parse_lc0_policy(lines)

    def rank(self, fen: str, topk: int = 3) -> List[str]:
        return [m for m, _ in self.policy(fen)[:topk]]

    def close(self) -> None:
        try:
            self._send("quit")
            self._p.wait(timeout=5)
        except Exception:
            self._p.kill()


class StockfishMultiPV:
    """A warm Stockfish process ranking positions by MultiPV at fixed movetime."""

    def __init__(self, sf_path: str, multipv: int = 3, movetime_ms: int = 150,
                 threads: int = 1, name: str = "stockfish-mpv"):
        self.name = name
        self.multipv = multipv
        self.movetime_ms = movetime_ms
        self._p = subprocess.Popen(
            [sf_path], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, bufsize=1,
        )
        self._send("uci")
        self._wait("uciok")
        self._send(f"setoption name Threads value {threads}")
        self._send(f"setoption name MultiPV value {multipv}")
        self._send("isready")
        self._wait("readyok")

    def _send(self, cmd: str) -> None:
        assert self._p.stdin is not None
        self._p.stdin.write(cmd + "\n")
        self._p.stdin.flush()

    def _wait(self, tok: str) -> List[str]:
        assert self._p.stdout is not None
        lines: List[str] = []
        for line in self._p.stdout:
            line = line.rstrip("\n")
            lines.append(line)
            if line.startswith(tok):
                break
        return lines

    def rank(self, fen: str, topk: int = 3) -> List[str]:
        self._send(f"position fen {fen}")
        self._send(f"go movetime {self.movetime_ms}")
        lines = self._wait("bestmove")
        return parse_sf_multipv(lines)[:topk]

    def close(self) -> None:
        try:
            self._send("quit")
            self._p.wait(timeout=5)
        except Exception:
            self._p.kill()


class StockfishEval:
    """A warm Stockfish process returning a White-POV centipawn eval per FEN.

    Used only for exhibition adjudication (resign / draw thresholds), never for
    move selection — the personas move; Stockfish just judges the result.
    """

    def __init__(self, sf_path: str, movetime_ms: int = 200, threads: int = 2,
                 name: str = "stockfish-eval"):
        self.name = name
        self.movetime_ms = movetime_ms
        self._p = subprocess.Popen(
            [sf_path], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, bufsize=1,
        )
        self._send("uci")
        self._wait("uciok")
        self._send(f"setoption name Threads value {threads}")
        self._send("setoption name MultiPV value 1")
        self._send("isready")
        self._wait("readyok")

    def _send(self, cmd: str) -> None:
        assert self._p.stdin is not None
        self._p.stdin.write(cmd + "\n")
        self._p.stdin.flush()

    def _wait(self, tok: str) -> List[str]:
        assert self._p.stdout is not None
        lines: List[str] = []
        for line in self._p.stdout:
            line = line.rstrip("\n")
            lines.append(line)
            if line.startswith(tok):
                break
        return lines

    def eval_cp(self, fen: str, stm_is_white: bool) -> Optional[int]:
        self._send(f"position fen {fen}")
        self._send(f"go movetime {self.movetime_ms}")
        lines = self._wait("bestmove")
        return parse_sf_score_cp(lines, stm_is_white)

    def close(self) -> None:
        try:
            self._send("quit")
            self._p.wait(timeout=5)
        except Exception:
            self._p.kill()
