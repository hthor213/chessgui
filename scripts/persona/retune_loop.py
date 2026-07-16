#!/usr/bin/env python3
"""Spec 217 Tier 2 retune-loop driver: arena batch -> merged book -> retune.

One command for the data flywheel ("each batch: re-run the self-analysis
pipeline -> update dossier -> retune style priors, gated on move-match,
spec 214"). It chains the existing scripts rather than reimplementing them:

  1. export_arena_book.py  (only when --db is given) — arena SQLite ->
     data/rivals/<rival>_arena_book.json;
  2. merge_books.py MANIFEST — folds the arena book into the rival's merged
     book (the manifest names the sources; this driver adds nothing to it);
  3. tune_persona.py --personas <rival> — the spec 214 harness, whose own
     move-match acceptance bar gates any staged v2 config.

Each step runs via subprocess with this interpreter, fail-fast: a non-zero
step aborts the loop (a half-merged book must never feed the tuner).

--min-games N is the "per N new games" gate from the spec's Tier 2 line:
after the export step, the loop stops (exit 0, nothing stale is overwritten)
unless the exported book used at least N games. The gate needs an export to
measure, so it requires --db.

--dry-run prints the exact commands (and the gate decision as "would check")
without running anything — safe to run anywhere, used by the self-test.

Usage:
    retune_loop.py MANIFEST --rival dad [--db arena.sqlite] [--user EMAIL]
                   [--min-games 25] [--as-of YYYY-MM-DD]
                   [--limit N] [--budget-min M] [--dry-run]
    retune_loop.py --self-test
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent


def build_commands(args: argparse.Namespace) -> list[list[str]]:
    """The pipeline as argv lists — pure function of args, so the self-test
    can pin the exact invocations without running anything."""
    py = sys.executable
    cmds: list[list[str]] = []
    if args.db:
        cmd = [py, str(SCRIPTS_DIR / "export_arena_book.py"), str(args.db),
               "--rival", args.rival, "--out", str(args.arena_out)]
        if args.user:
            cmd += ["--user", args.user]
        cmds.append(cmd)
    merge = [py, str(SCRIPTS_DIR / "merge_books.py"), str(args.manifest)]
    if args.as_of:
        merge += ["--as-of", args.as_of]
    cmds.append(merge)
    tune = [py, str(SCRIPTS_DIR / "tune_persona.py"),
            "--personas", args.rival]
    if args.limit is not None:
        tune += ["--limit", str(args.limit)]
    if args.budget_min is not None:
        tune += ["--budget-min", str(args.budget_min)]
    cmds.append(tune)
    return cmds


def games_used(book_path: Path) -> int:
    """games_used from an exported book's stats block (the gate's measure)."""
    doc = json.loads(book_path.read_text(encoding="utf-8"))
    return int(doc["stats"]["games_used"])


def run_pipeline(args: argparse.Namespace) -> int:
    cmds = build_commands(args)
    gate_after = 0 if args.db else None  # gate sits after the export step
    for i, cmd in enumerate(cmds):
        shown = " ".join(cmd)
        if args.dry_run:
            print(f"[dry-run] {shown}")
            if gate_after == i and args.min_games:
                print(f"[dry-run] would stop here unless "
                      f"{args.arena_out} has games_used >= {args.min_games}")
            continue
        print(f"[retune-loop] {shown}")
        rc = subprocess.run(cmd).returncode
        if rc != 0:
            print(f"[retune-loop] step failed (exit {rc}); aborting — "
                  f"nothing downstream was touched", file=sys.stderr)
            return rc
        if gate_after == i and args.min_games:
            n = games_used(args.arena_out)
            if n < args.min_games:
                print(f"[retune-loop] gate: only {n} arena games "
                      f"(< {args.min_games}); stopping before merge/retune")
                return 0
            print(f"[retune-loop] gate: {n} arena games >= {args.min_games}, "
                  f"continuing")
    return 0


# ---------------------------------------------------------------------------
# Self-test — command construction, the gate, and the dry-run path. No
# subprocesses, no engines, no real books.
# ---------------------------------------------------------------------------

def _args(**over) -> argparse.Namespace:
    base = dict(manifest=Path("m.json"), rival="dad", db=None, user=None,
                arena_out=Path("data/rivals/dad_arena_book.json"),
                min_games=None, as_of=None, limit=None, budget_min=None,
                dry_run=True)
    base.update(over)
    return argparse.Namespace(**base)


def self_test() -> int:
    import tempfile
    ok = True

    def check(cond: bool, msg: str):
        nonlocal ok
        print(f"  [{'PASS' if cond else 'FAIL'}] {msg}")
        if not cond:
            ok = False

    # 1. Merge-only pipeline: exactly merge -> tune, in that order.
    cmds = build_commands(_args())
    check(len(cmds) == 2, "no --db -> 2 steps (merge, tune)")
    check(cmds[0][1].endswith("merge_books.py") and "m.json" in cmds[0],
          "step 1 is merge_books with the manifest")
    check(cmds[1][1].endswith("tune_persona.py")
          and cmds[1][-2:] == ["--personas", "dad"],
          "step 2 is tune_persona --personas <rival>")

    # 2. Full pipeline: export first, with db/rival/out/user threaded through.
    cmds = build_commands(_args(db=Path("arena.sqlite"), user="dad@x.com",
                                limit=20, budget_min=5.0, as_of="2026-07-15"))
    check(len(cmds) == 3 and cmds[0][1].endswith("export_arena_book.py"),
          "--db -> export step prepended")
    check("arena.sqlite" in cmds[0] and "--user" in cmds[0]
          and "dad@x.com" in cmds[0], "export gets db path and --user")
    check(cmds[1][-2:] == ["--as-of", "2026-07-15"],
          "--as-of forwarded to merge_books")
    check("--limit" in cmds[2] and "20" in cmds[2]
          and "--budget-min" in cmds[2] and "5.0" in cmds[2],
          "--limit/--budget-min forwarded to tune_persona")

    # 3. Every step uses this interpreter (no PATH-dependent 'python').
    check(all(c[0] == sys.executable for c in cmds),
          "all steps run under sys.executable")

    # 4. The gate reads games_used, and dry-run executes nothing.
    with tempfile.TemporaryDirectory() as td:
        book = Path(td) / "book.json"
        book.write_text(json.dumps({"stats": {"games_used": 7}}))
        check(games_used(book) == 7, "gate reads stats.games_used")
        rc = run_pipeline(_args(db=Path("nonexistent.sqlite"),
                                arena_out=book, min_games=100, dry_run=True))
        check(rc == 0, "dry-run succeeds with nonexistent inputs (prints only)")

    return 0 if ok else 1


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Arena retune loop: export -> merge -> tune_persona.")
    ap.add_argument("manifest", nargs="?", type=Path,
                    help="merge_books.py manifest JSON")
    ap.add_argument("--rival", default="dad",
                    help="rival slug (export label + tune_persona persona)")
    ap.add_argument("--db", type=Path,
                    help="arena SQLite DB; when given, the export step runs")
    ap.add_argument("--user", help="account email filter for the export step")
    ap.add_argument("--arena-out", type=Path, default=None,
                    help="exported arena book path (default "
                         "data/rivals/<rival>_arena_book.json; must match the "
                         "manifest's arena source path)")
    ap.add_argument("--min-games", type=int,
                    help="stop after export unless it used >= N games "
                         "(requires --db)")
    ap.add_argument("--as-of", help="forwarded to merge_books.py")
    ap.add_argument("--limit", type=int, help="forwarded to tune_persona.py")
    ap.add_argument("--budget-min", type=float,
                    help="forwarded to tune_persona.py")
    ap.add_argument("--dry-run", action="store_true",
                    help="print the commands, run nothing")
    ap.add_argument("--self-test", action="store_true",
                    help="run built-in checks and exit")
    args = ap.parse_args()

    if args.self_test:
        print("retune_loop self-test:")
        return self_test()
    if not args.manifest:
        ap.error("manifest required (or --self-test)")
    if args.min_games and not args.db:
        ap.error("--min-games needs --db (the gate measures the export)")
    if args.arena_out is None:
        repo = SCRIPTS_DIR.parents[1]
        args.arena_out = repo / "data" / "rivals" / f"{args.rival}_arena_book.json"
    return run_pipeline(args)


if __name__ == "__main__":
    sys.exit(main())
