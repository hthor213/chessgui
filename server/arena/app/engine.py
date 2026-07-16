"""Warm lc0 process at the BT3 net, verification-search arm.

Protocol is byte-for-byte the one in scripts/persona/engines.py (Lc0Policy) and
exhibition_v2.parse_lc0_search: VerboseMoveStats + `go nodes N`, read at the
VISIT head — the match-#2 mechanism that removes single-ply blunder cliffs.

Stall handling per spec 217: every read has a deadline; on timeout we probe
with isready (retry), and if the probe also times out we kill and respawn the
process. A move request never hangs the API."""

import queue
import subprocess
import threading
import time
from typing import List, Optional, Tuple

from . import config


def _is_uci_move(s: str) -> bool:
    if len(s) not in (4, 5):
        return False
    ok = ("a" <= s[0] <= "h" and "1" <= s[1] <= "8"
          and "a" <= s[2] <= "h" and "1" <= s[3] <= "8")
    if len(s) == 5:
        ok = ok and s[4] in "qrbn"
    return ok


def _paren_field(line: str, key: str) -> Optional[float]:
    start = line.find("(" + key)
    if start < 0:
        return None
    start += len(key) + 1
    end = line.find(")", start)
    if end < 0:
        return None
    tok = line[start:end].strip().rstrip("%").strip()
    try:
        return float(tok)
    except ValueError:
        return None


def parse_lc0_search(lines: List[str]) -> List[Tuple[str, int, float, float]]:
    """(uci, visits, policy, q) per legal move, sorted visits desc then policy.
    Same parse as exhibition_v2 (match #2)."""
    out: List[Tuple[str, int, float, float]] = []
    for line in lines:
        t = line.strip()
        if not t.startswith("info string "):
            continue
        body = t[len("info string "):]
        parts = body.split()
        if not parts or not _is_uci_move(parts[0]):
            continue
        visits = 0
        idx = body.find("N:")
        if idx >= 0:
            tail = body[idx + 2:].split()
            if tail:
                try:
                    visits = int(tail[0])
                except ValueError:
                    visits = 0
        p = _paren_field(body, "P:")
        q = _paren_field(body, "Q:")
        out.append((parts[0], visits, (p or 0.0) / 100.0,
                    q if q is not None else 0.0))
    out.sort(key=lambda m: (m[1], m[2]), reverse=True)
    return out


class EngineStall(Exception):
    pass


class Lc0Search:
    """One warm lc0 bound to a net — the BT3 net by default, or a per-persona
    net (Maia bands for private amateur personas, spec 217 Promise 1).
    Thread-safe via an external lock in the caller (Tier 0 serializes persona
    moves — 1-2 concurrent games)."""

    def __init__(self, net_path: Optional[str] = None):
        self._net_path = net_path or config.LC0_NET_PATH
        self._p: Optional[subprocess.Popen] = None
        self._q: Optional[queue.Queue] = None
        self.lock = threading.Lock()
        self._spawn()

    def _spawn(self) -> None:
        self._p = subprocess.Popen(
            [config.LC0_PATH, f"--weights={self._net_path}",
             f"--threads={config.LC0_THREADS}"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, bufsize=1,
        )
        self._q = queue.Queue()
        threading.Thread(target=self._reader, args=(self._p, self._q),
                         daemon=True).start()
        self._send("uci")
        self._wait("uciok", timeout=60)
        self._send("setoption name VerboseMoveStats value true")
        self._send("isready")
        self._wait("readyok", timeout=120)  # first isready loads the 190MB net
        # Warm-up: the first `go` pays backend compute init (~12s measured on
        # this box); eat it at spawn so no game move ever does.
        self._send("position startpos")
        self._send("go nodes 2")
        self._wait("bestmove", timeout=120)

    @staticmethod
    def _reader(p: subprocess.Popen, q: queue.Queue) -> None:
        for line in p.stdout:
            q.put(line.rstrip("\n"))
        q.put(None)  # EOF sentinel

    def _send(self, cmd: str) -> None:
        self._p.stdin.write(cmd + "\n")
        self._p.stdin.flush()

    def _wait(self, tok: str, timeout: float) -> List[str]:
        lines: List[str] = []
        deadline = time.monotonic() + timeout
        while True:
            remain = deadline - time.monotonic()
            if remain <= 0:
                raise EngineStall(f"lc0 timed out waiting for '{tok}'")
            try:
                line = self._q.get(timeout=min(remain, 1.0))
            except queue.Empty:
                continue
            if line is None:
                raise EngineStall("lc0 process exited (EOF)")
            lines.append(line)
            if line.startswith(tok):
                return lines

    def respawn(self) -> None:
        try:
            self._p.kill()
        except Exception:
            pass
        self._spawn()

    def search(self, fen: str, nodes: int) -> List[Tuple[str, int, float, float]]:
        """Verification search; retry once, then respawn (never hang)."""
        for attempt in (1, 2):
            try:
                self._send(f"position fen {fen}")
                self._send(f"go nodes {nodes}")
                lines = self._wait("bestmove",
                                   timeout=config.ENGINE_MOVE_TIMEOUT_S)
                return parse_lc0_search(lines)
            except (EngineStall, BrokenPipeError, OSError) as e:
                print(f"[Engine] attempt {attempt} failed: {e}; respawning lc0")
                self.respawn()
        raise EngineStall("lc0 failed twice; game left resumable")
