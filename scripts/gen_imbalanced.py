#!/usr/bin/env python3
"""Generate realistic imbalanced positions for tournament bands UHO doesn't cover.

From each balanced opening position we read Stockfish's MultiPV per-move evals;
a move that loses ~X pawns leads to a position whose |eval| ~ X ("theory, then
one mistake"). We bucket those resulting positions into target |imbalance| bands
and keep a quota per band. Output matches tag_positions.json's schema so it can
be merged straight into data/tagged_positions.json.

Usage:
  python3 scripts/gen_imbalanced.py -i data/openings/popularpos_lichess_v3.epd \
      -o /tmp/gen.json --bands 0,0.25,0.5,0.75,1.5,1.75,2.0,2.25,2.5 \
      --per-band 40 --probe-depth 14 --multipv 40 --max-sources 800
"""
import argparse, json, random, subprocess, sys
import chess


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("-i", "--input", required=True)
    p.add_argument("-o", "--output", required=True)
    p.add_argument("-e", "--engine", default="/opt/homebrew/bin/stockfish")
    p.add_argument("--bands", default="0,0.25,0.5,0.75,1.5,1.75,2.0,2.25,2.5",
                   help="comma-separated band edges (pawns); consecutive pairs form bands")
    p.add_argument("--per-band", type=int, default=40)
    p.add_argument("--probe-depth", type=int, default=14)
    p.add_argument("--multipv", type=int, default=40)
    p.add_argument("--max-sources", type=int, default=800)
    p.add_argument("--hash", type=int, default=128)
    p.add_argument("--seed", type=int, default=7)
    return p.parse_args()


def fen_from_epd_line(line):
    parts = line.strip().split()
    if len(parts) < 4:
        return None
    fields = parts[:6]
    while len(fields) < 6:
        fields.append("0" if len(fields) == 4 else "1")
    fen = " ".join(fields[:6])
    try:
        chess.Board(fen)
        return fen
    except Exception:
        return None


class SF:
    def __init__(self, path, hash_mb, multipv):
        self.p = subprocess.Popen([path], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, text=True, bufsize=1)
        self._cmd("uci"); self._wait("uciok")
        self._cmd(f"setoption name Hash value {hash_mb}")
        self._cmd("setoption name Threads value 1")
        self._cmd(f"setoption name MultiPV value {multipv}")
        self._cmd("isready"); self._wait("readyok")

    def _cmd(self, c):
        self.p.stdin.write(c + "\n"); self.p.stdin.flush()

    def _wait(self, tok):
        for line in self.p.stdout:
            if line.startswith(tok):
                return

    def analyse(self, fen, depth):
        """Return {multipv_idx: (move_uci, score_cp_from_stm)} at final depth."""
        self._cmd("ucinewgame"); self._cmd("isready"); self._wait("readyok")
        self._cmd(f"position fen {fen}")
        self._cmd(f"go depth {depth}")
        out = {}
        for line in self.p.stdout:
            line = line.strip()
            if line.startswith("bestmove"):
                break
            if not (line.startswith("info") and " multipv " in line and " pv " in line):
                continue
            t = line.split()
            try:
                mpv = int(t[t.index("multipv") + 1])
                si = t.index("score")
                typ, val = t[si + 1], int(t[si + 2])
                if typ == "mate":
                    val = 30000 if val > 0 else -30000
                move = t[t.index("pv") + 1]
                out[mpv] = (move, val)
            except (ValueError, IndexError):
                pass
        return out

    def quit(self):
        try:
            self._cmd("quit"); self.p.wait(timeout=3)
        except Exception:
            self.p.kill()


def main():
    a = parse_args()
    random.seed(a.seed)
    edges = [float(x) for x in a.bands.split(",")]
    bands = list(zip(edges, edges[1:]))
    counts = {b: 0 for b in bands}
    quota = a.per_band

    sf = SF(a.engine, a.hash, a.multipv)
    results = []
    seen = set()
    examined = 0

    with open(a.input) as fh:
        lines = [ln for ln in fh if ln.strip()]
    random.shuffle(lines)

    for ln in lines:
        if examined >= a.max_sources or all(counts[b] >= quota for b in bands):
            break
        fen = fen_from_epd_line(ln)
        if not fen:
            continue
        examined += 1
        board = chess.Board(fen)
        white_to_move = board.turn == chess.WHITE
        info = sf.analyse(fen, a.probe_depth)
        # Each move's resulting position has |white-POV eval| ~ |score| pawns.
        for _, (uci, score) in sorted(info.items()):
            mag = abs(score) / 100.0
            for (lo, hi) in bands:
                if counts[(lo, hi)] >= quota or not (lo <= mag < hi):
                    continue
                try:
                    mv = chess.Move.from_uci(uci)
                    if mv not in board.legal_moves:
                        continue
                    board.push(mv); newfen = board.fen(); board.pop()
                except Exception:
                    continue
                if newfen in seen:
                    continue
                seen.add(newfen)
                ew = score if white_to_move else -score   # white-POV eval of result
                results.append({
                    "fen": newfen,
                    "eval_cp": int(ew),
                    "eval_pawns": round(ew / 100.0, 2),
                    "source": "gen-blunder",
                })
                counts[(lo, hi)] += 1
                break
        if examined % 25 == 0:
            filled = sum(1 for b in bands if counts[b] >= quota)
            print(f"  examined {examined}  filled {filled}/{len(bands)} bands  "
                  f"total {len(results)}", flush=True)

    sf.quit()
    with open(a.output, "w") as fh:
        json.dump(results, fh)
    print(f"wrote {len(results)} positions to {a.output}")
    for (lo, hi) in bands:
        print(f"  |{lo:.2f}-{hi:.2f}|: {counts[(lo, hi)]}")


if __name__ == "__main__":
    main()
