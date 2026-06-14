#!/usr/bin/env python3
"""
tag_positions.py — Re-evaluate opening positions with Stockfish and tag each
with a centipawn evaluation (from White's point of view).

Reads an EPD or PGN/EPD-style file of starting positions (e.g. a UHO
"Unbalanced Human Openings" book), drives Stockfish over UCI to evaluate each
position to a fixed depth or movetime, and writes a JSON array of:

    {"fen": str, "eval_cp": int, "eval_pawns": float, "source": str}

eval_cp / eval_pawns are normalized to White's perspective. (UCI reports the
score from the side-to-move's perspective; we flip the sign when it's Black to
move.) Mate scores are clamped to a large centipawn value.

Pure stdlib + subprocess. No third-party dependencies.

Usage:
    python3 scripts/tag_positions.py \
        --input data/openings/UHO_4060_v3.epd \
        --output data/tagged_positions.json \
        --depth 16 \
        --max 300

    python3 scripts/tag_positions.py -i book.epd --movetime 200 --max 300
"""

import argparse
import json
import os
import random
import subprocess
import sys
import time

# Clamp value for mate scores, in centipawns (32 pawns ~ decisive).
MATE_CP = 32000


def parse_args():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("-i", "--input", required=True,
                   help="Input EPD/FEN file (one position per line).")
    p.add_argument("-o", "--output", default="data/tagged_positions.json",
                   help="Output JSON file (default: data/tagged_positions.json).")
    p.add_argument("-e", "--engine", default="/opt/homebrew/bin/stockfish",
                   help="Path to the UCI engine (default: Stockfish at homebrew path).")
    g = p.add_mutually_exclusive_group()
    g.add_argument("-d", "--depth", type=int, default=16,
                   help="Search depth per position (default: 16).")
    g.add_argument("-m", "--movetime", type=int, default=None,
                   help="Search time per position in ms (overrides --depth).")
    p.add_argument("-n", "--max", type=int, default=300,
                   help="Maximum number of positions to tag (default: 300).")
    p.add_argument("--threads", type=int, default=1,
                   help="Engine Threads option (default: 1).")
    p.add_argument("--hash", type=int, default=128,
                   help="Engine Hash MB option (default: 128).")
    p.add_argument("--shuffle", action="store_true",
                   help="Randomly sample positions from the file instead of "
                        "taking the first N (gives a wider opening variety).")
    p.add_argument("--seed", type=int, default=42,
                   help="RNG seed used when --shuffle is set (default: 42).")
    p.add_argument("--source", default=None,
                   help="Source label stored in each entry "
                        "(default: basename of the input file).")
    return p.parse_args()


def looks_like_fen(token_fields):
    """A FEN/EPD starts with a board field containing ranks separated by '/'.
    The second field is the side to move (w/b)."""
    if len(token_fields) < 2:
        return False
    board, stm = token_fields[0], token_fields[1]
    return "/" in board and stm in ("w", "b")


def fen_from_epd_line(line):
    """Extract a full FEN from an EPD line.

    EPD = '<board> <stm> <castling> <ep> [operations...]'. It lacks the
    halfmove/fullmove counters that full FEN has, so we synthesize them
    (0 1). If the line is already a full 6-field FEN we use it as-is.
    Returns a normalized 6-field FEN string, or None if not parseable.
    """
    line = line.strip()
    if not line or line.startswith("#"):
        return None
    fields = line.split()
    if not looks_like_fen(fields):
        return None
    board, stm = fields[0], fields[1]
    castling = fields[2] if len(fields) > 2 else "-"
    ep = fields[3] if len(fields) > 3 else "-"
    # Halfmove / fullmove: use real values only if they are plain integers
    # (EPD operations like 'bm', 'id' are not). Otherwise synthesize.
    halfmove = "0"
    fullmove = "1"
    if len(fields) > 4 and fields[4].isdigit():
        halfmove = fields[4]
    if len(fields) > 5 and fields[5].isdigit():
        fullmove = fields[5]
    return f"{board} {stm} {castling} {ep} {halfmove} {fullmove}"


def iter_positions(path, limit, shuffle, seed):
    """Yield up to `limit` (fen, side_to_move) pairs from the EPD/FEN file."""
    if shuffle:
        # Reservoir-free approach: read all candidate lines, sample.
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            lines = [ln for ln in f if "/" in ln]
        rng = random.Random(seed)
        rng.shuffle(lines)
        source = lines
    else:
        source = open(path, "r", encoding="utf-8", errors="replace")

    count = 0
    try:
        for line in source:
            fen = fen_from_epd_line(line)
            if fen is None:
                continue
            stm = fen.split()[1]
            yield fen, stm
            count += 1
            if count >= limit:
                break
    finally:
        if not shuffle:
            source.close()


class Engine:
    """Minimal blocking UCI driver."""

    def __init__(self, path, threads, hash_mb):
        self.proc = subprocess.Popen(
            [path],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
        )
        self._send("uci")
        self._wait_for("uciok")
        self._send(f"setoption name Threads value {threads}")
        self._send(f"setoption name Hash value {hash_mb}")
        self._send("isready")
        self._wait_for("readyok")

    def _send(self, cmd):
        self.proc.stdin.write(cmd + "\n")
        self.proc.stdin.flush()

    def _wait_for(self, token):
        for line in self.proc.stdout:
            if line.strip() == token or line.strip().startswith(token):
                return

    def evaluate(self, fen, depth=None, movetime=None):
        """Return (eval_cp_white_pov, raw_info_line). cp is from White POV."""
        stm = fen.split()[1]
        self._send("ucinewgame")
        self._send(f"position fen {fen}")
        if movetime is not None:
            self._send(f"go movetime {movetime}")
        else:
            self._send(f"go depth {depth}")

        last_score = None  # (kind, value) from side-to-move POV
        for line in self.proc.stdout:
            line = line.strip()
            if line.startswith("info ") and " score " in line:
                parsed = self._parse_score(line)
                if parsed is not None:
                    last_score = parsed
            elif line.startswith("bestmove"):
                break

        if last_score is None:
            return None
        kind, value = last_score
        if kind == "cp":
            cp = value
        else:  # mate
            # Positive mate => side-to-move is mating; clamp toward MATE_CP.
            cp = MATE_CP - abs(value) if value > 0 else -(MATE_CP - abs(value))
        # Flip to White POV if Black is to move.
        if stm == "b":
            cp = -cp
        return cp

    @staticmethod
    def _parse_score(info_line):
        toks = info_line.split()
        try:
            idx = toks.index("score")
        except ValueError:
            return None
        kind = toks[idx + 1]
        value = int(toks[idx + 2])
        return kind, value

    def quit(self):
        try:
            self._send("quit")
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()


def main():
    args = parse_args()

    if not os.path.isfile(args.input):
        sys.exit(f"Input file not found: {args.input}")
    if not os.path.isfile(args.engine):
        sys.exit(f"Engine not found: {args.engine}")

    source_label = args.source or os.path.basename(args.input)
    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)

    mode = (f"movetime {args.movetime}ms" if args.movetime
            else f"depth {args.depth}")
    print(f"Tagging up to {args.max} positions from {args.input} "
          f"({mode}, source='{source_label}')")

    engine = Engine(args.engine, args.threads, args.hash)
    results = []
    start = time.time()
    try:
        for n, (fen, _stm) in enumerate(
                iter_positions(args.input, args.max, args.shuffle, args.seed), 1):
            cp = engine.evaluate(fen, depth=args.depth, movetime=args.movetime)
            if cp is None:
                continue
            results.append({
                "fen": fen,
                "eval_cp": int(cp),
                "eval_pawns": round(cp / 100.0, 2),
                "source": source_label,
            })
            if n % 25 == 0:
                elapsed = time.time() - start
                rate = n / elapsed if elapsed else 0
                print(f"  ...{n} positions tagged "
                      f"({elapsed:.0f}s, {rate:.1f}/s)")
    finally:
        engine.quit()

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2)

    elapsed = time.time() - start
    print(f"Done: {len(results)} positions -> {args.output} "
          f"in {elapsed:.0f}s")


if __name__ == "__main__":
    main()
