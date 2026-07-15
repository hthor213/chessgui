# Mining-corpus scripts (spec 211 Tier-1 fuel / spec 213 validation fuel)

Builds the Lichess mining corpus per **data-strategy v3** (roadmap plan
`then-we-are-going-witty-kazoo.md`, user decision 2026-07-13): elo ≥ 1400 both
players, rated, rapid+classical time controls `600+5, 900+10, 1800+0, 1800+20`,
games with `[%eval]` annotations only, band-capped to hit a **50–60 GB /
~9–10.5 M games** budget. Blitz is deliberately excluded (7× size, noisy
time-pressure blunders). Spec 211:47–51 consumes the `[%eval]` tags for
eval-cliff mining; spec 213 (§2.4 of `docs/research/elo-conditioned-eval-design.md`,
line 258) uses the same corpus for validation. The **reference pack is the
elo≥2000 query-slice of this corpus** — build once, serve both.

Python 3 stdlib only. External binaries: `zstd`, `curl` (both on the server).
Everything heavy self-wraps in `nice -n19 ionice -c3`.

## Order of operations on the server

```bash
MIN=/data/mining          # wherever the mining volume is mounted

# 1. Download 2-3 RECENT months without filtering (resumable, rate-limited)
python3 scripts/mining/run_month.py 2026-03 --corpus-dir $MIN --download-only
python3 scripts/mining/run_month.py 2026-04 --corpus-dir $MIN --download-only

# 2. Tune the band cap (single counting pass, prints size/balance table)
nice -n19 ionice -c3 python3 scripts/mining/tune_caps.py \
    $MIN/raw/lichess_db_standard_rated_2026-03.pgn.zst \
    $MIN/raw/lichess_db_standard_rated_2026-04.pgn.zst \
    --caps 25000,50000,100000,200000
# Pick N: games/mo x planned months ~ 9-10.5M, GB in budget, balance high.

# 3. The month loop (repeat per month; each run is idempotent/restartable)
for m in 2026-05 2026-04 2026-03 ...; do
    python3 scripts/mining/run_month.py $m --corpus-dir $MIN --cap <N> \
        --limit-rate 8M
done
```

Each month lands as `$MIN/months/<month>.pgn` plus `.filter.stats.json`,
`.cap.stats.json` and a `.done.json` marker (written last, atomically).
Re-running a done month is a no-op; a crashed run resumes the download
(`curl -C -` on the kept `.part`) or redoes the filter from the still-present
raw dump. The raw `.zst` is deleted only after count verification succeeds
(games in the output file == band_cap's kept count).

## The pipeline, by hand

```bash
zstd -dc lichess_db_standard_rated_2026-05.pgn.zst \
  | python3 scripts/mining/filter_month.py --stats-json f.json \
  | python3 scripts/mining/band_cap.py --cap 50000 --stats-json c.json \
  > 2026-05.pgn
```

`filter_month.py` streams stdin→stdout one game at a time (a rejected game's
movetext is never buffered — flat memory over a ~200 GB decompressed month) and
prints running stats to stderr. `band_cap.py` keeps at most N games per
100-Elo band (band = lower of the two Elos, `build_reference_pack.py:298`
convention); add `--state counts.json` to make caps cumulative across runs.

## Smoke test (runs anywhere)

```bash
cd scripts/mining
cat fixtures/sample.pgn | python3 filter_month.py | python3 band_cap.py --cap 1
# fixture: 9 games -> 3 pass the filter (bands 1600,2100,1600) -> cap 1 keeps 2
```

## Tier-1 eval-cliff puzzle generator (spec 211:45-51)

`mine_cliffs.py` consumes the built months and emits avoidance-puzzle rows:

```bash
python3 scripts/mining/mine_cliffs.py ~/chess-corpus/months/*.pgn \
    --engine <stockfish> --depth 16 --out-dir ~/chess-corpus/puzzles \
    --threads 2 --limit 20000        # bounded first batch per month
```

Cliff = [%eval] within ±1.0 before the move (mover's perspective), ≤ −1.5
(or mate) after. Every candidate is re-verified with local Stockfish at the
fixed `--depth` — refutation confirmed at ≥ 1.5, pre-position not already
lost/won, ≥ 3 reasonable alternatives via MultiPV (within 0.5 of best AND
above −1.0, spec 211's grading thresholds). Output is one
`<month>.cliffs.jsonl` per input (row schema in `mine_cliffs.py --help`)
plus a `.cliffs.done.json` marker (idempotent; a `--limit`-capped run gets
NO marker so a later full run redoes the month).
`import_puzzles.py <db> *.jsonl` loads them into the spec's `puzzles`
SQLite table with UNIQUE(fen, trap_uci) dedup.

Two deviations from the corpus builder's rules: it needs **python-chess**
for SAN replay (`python3 -m pip install --user python-chess` on the server
— hand-rolled move legality is the one chess-math wheel not worth
reinventing), and throughput is engine-bound (~1.2 s/candidate at depth 16
× 1 thread; a full 1.4M-game month has candidates in the ~10⁶ range, so
budget with `--limit`, `--threads`, or depth — never run a month open-ended
without checking the candidate stats first).

Fixture tests (positive White + Black cliffs, calm negative, fabricated
[%eval] that re-verification must reject, pre-window gate):

```bash
python3 scripts/mining/test_mine_cliffs.py   # needs stockfish on PATH or $STOCKFISH
```

## Decisions to confirm (spec-silent choices made here)

1. **Time controls are the calibrated four** (`600+5,900+10,1800+0,1800+20`),
   not "all Lichess rapid+classical speeds". That's what data-strategy v3
   literally pins and what the size calibration was measured against; a
   speed-category filter (base + 40×increment) would admit more TCs and
   invalidate the 50–60 GB estimate. Override with `--time-control` if v3 is
   reinterpreted.
2. **Band caps are per month**, not corpus-cumulative (run_month passes no
   `--state`). Tuning is per-month ("tune N on 2–3 recent full months"), and
   per-month caps keep every month restartable in isolation. Cumulative mode
   exists (`band_cap.py --state`) if corpus-level flattening is wanted instead.
3. **Within a capped band the kept games are the earliest in the dump**
   (first-come-first-kept; the dump is chronological). True per-band random
   sampling would need reservoir sampling + a second pass or in-memory
   buffering of the whole month's accepted set. Flag if within-month
   selection bias matters for the miss-rate statistics.
4. **No upper Elo cut**: bands above 2200 stay (they're tiny and the cap only
   trims over-full low bands, per v3). The 2000+ slice doubles as the
   reference pack, so keeping the top is deliberate.
5. **One PGN file per month** in `months/` rather than appending to a single
   growing file — that's the "append to a corpus directory" reading that
   stays idempotent (a re-run can never double-append).
6. **`curl` (not stdlib urllib) for downloads** — resume (`-C -`),
   `--limit-rate`, and retries come free and battle-tested.
7. **Unknown-Elo games** reaching band_cap (can't happen via filter_month,
   which requires both Elos) go to band `"?"` and are capped like any band.
8. **Band width 100 Elo** — matches `build_reference_pack.py` and the
   calibration samplers; specs 211/213 talk about bands ("1650–1750",
   "1400–2200 band-balanced") without pinning edges.
