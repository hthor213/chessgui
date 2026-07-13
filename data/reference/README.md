# Reference Database Pipeline

Offline tooling that builds the **reference game database** for ChessGUI — the
open, subscription-free replacement for ChessBase's *Mega Database*. It
produces filtered PGN "packs" that the app imports through its SQLite backend
(`src-tauri/src/db.rs :: db_import_pgn`, which streams from a file path at
~15k games/s and dedups on import).

**Everything under `data/reference/` is staging and gitignored** (except this
README). Downloaded dumps, filtered packs, `.stats.json` sidecars, TWIC issues,
and scratch import DBs all live here and are **never** written into a user's
database automatically. Promotion from a pack into an imported DB is an
explicit, logged step (`src-tauri/examples/import_smoke.rs`).

Provenance is carried end-to-end: each pack ships a `.stats.json` recording the
exact source, filter, and counts; the import step stamps a `source` string on
every row so any game can be traced back to its origin.

---

## Sources

| Source | What | Format | License / terms |
|---|---|---|---|
| **Lichess** open database | Monthly dumps of all rated standard games | `.pgn.zst` (zstandard) | **CC0** (public domain) — free to filter, store, redistribute |
| **Caïssabase** | Curated OTB master games (~4.9M) | Scid vs. PC (`.si4/.sg4/.sn4`) in a `.zip` | No explicit license; **site now defunct** (see below) |
| **TWIC** (The Week in Chess) | Weekly OTB games, ongoing freshness | `.pgn` inside a per-issue `.zip` | **"Free for personal use only. All rights reserved"** — do **not** redistribute |

---

## 1. Lichess quality pack (primary source)

Source: <https://database.lichess.org/> — standard rated monthly dumps,
`lichess_db_standard_rated_YYYY-MM.pgn.zst`. Licensed **CC0** (the site states
the data is in the public domain), so filtered packs can be stored and shipped
freely.

### Recipe (the app's "quality" filter)

Applied by `scripts/build_reference_pack.py`, matching game **headers** only:

- **rated** games (`Event` starts with `"Rated"`)
- **`TimeControl == "600+5"`** (10+5 blitz/rapid)
- **`WhiteElo >= 1900` AND `BlackElo >= 1900`**

Matching games are written **verbatim** (byte-preserving movetext). Dedup is
*not* done here — the Rust importer dedups on a content hash at import time, so
the pipeline can stay simple and just be honest about provenance.

### Run it for one month

```bash
# Local file already downloaded:
python3 scripts/build_reference_pack.py \
  --input data/reference/lichess_db_standard_rated_2024-01.pgn.zst \
  --output data/reference/pack_2024-01.pgn

# Or stream + decompress straight from Lichess (raw dump never lands on disk):
python3 scripts/build_reference_pack.py \
  --input https://database.lichess.org/standard/lichess_db_standard_rated_2024-01.pgn.zst \
  --output data/reference/pack_2024-01.pgn
```

Each run also writes `<output>.stats.json` (source, filter, seen/matched/errors,
matched-by-year). Flags: `--time-control` (default `600+5`, or `any`),
`--min-elo` (default `1900`), `--limit N` (stop after N matches — smoke tests),
`--max-input-bytes N` (sample the head of a huge remote month without
downloading it all), `--allow-unrated`.

Requires the `zstandard` Python package (`pip3 install zstandard`); falls back
to a `zstd`/`zstdcat` binary on `PATH` if the package is missing.

### Run the full history month-by-month

The dumps start at **2013-01** and continue monthly. Loop the months you want;
because the importer dedups, overlapping re-runs are safe:

```bash
for ym in 2023-{01..12} 2024-{01..12}; do
  python3 scripts/build_reference_pack.py \
    --input "https://database.lichess.org/standard/lichess_db_standard_rated_${ym}.pgn.zst" \
    --output "data/reference/pack_${ym}.pgn"
done
```

Then import each pack (see [Importing](#importing-a-pack)). Streaming is
resumable at month granularity — a pack that already exists can be skipped, and
a killed run just re-fetches the month it was on.

**Expected yield:** the 600+5 / 1900+ filter matches roughly **0.2% of all
games** (measured 1,346 / 621,880 on a 2024-01 sample). 10+5 was rare in the
early years and grew over time, so the yield is heavily back-weighted toward
recent months. Full-history yield is expected in the **5–12M games** range.

---

## Importing a pack

Packs are plain PGN; the app imports them through the same backend path the UI
uses. A headless example bin is provided:

```bash
cd src-tauri
cargo run --example import_smoke -- \
  ../data/reference/pack_2024-01.pgn \
  /tmp/refpack_scratch.sqlite \
  "lichess:2024-01 600+5 1900+"
```

It prints `imported / dups_skipped / errors` and before/after DB stats. The
third arg is the `source` provenance string stamped on every imported row.
Re-running the same pack against the same DB imports 0 and reports the rest as
`dups_skipped` (dedup is on a content hash — safe to re-run).

In the app itself, the same happens via the `db_import_pgn` Tauri command
against the user's real database.

---

## Smoke test (verified end-to-end)

Run against real downloaded data on 2026-07-13:

**2013-01 dump** (17 MB `.zst`, full month): 121,332 games seen → **7 matched**,
0 errors, in ~1.8s. (600+5 with both players 1900+ was genuinely rare in early
Lichess — a handful of games. All 7 verified rated / 600+5 / both Elos ≥1900.)

**2024-01 dump, first 200 MB streamed** (`--max-input-bytes 200000000
--limit 5000`): 621,880 games seen → **1,346 matched**, 0 errors, in ~13s at
**~46k games/s**. The truncated final zstd frame from the byte cap was handled
as a clean EOF (no crash).

**Import** of the 1,346-game 2024 pack via `import_smoke`: **1,346 imported, 0
dups_skipped, 0 errors** → 1,346 games / 53,232 positions, ~1,400 games/s.
Immediate re-run: **0 imported, 1,346 dups_skipped** (idempotency confirmed).

---

## 2. Caïssabase (curated OTB masters) — DEFERRED

**Status (verified 2026-07): the original site `caissabase.co.uk` is defunct**
— the domain now serves an unrelated crypto-casino affiliate page, and
community trackers (mattplayschess.com) list Caïssabase as "no longer
available." Do **not** treat `caissabase.co.uk` as a live source.

- **Historical format:** distributed as a single `.zip` (~500 MB) of **Scid vs.
  PC** database files — the standard `.si4` / `.sg4` / `.sn4` triplet. ~4.9M OTB
  games at its last known update (2022-12-19); no fixed release cadence (one
  maintainer, irregular updates).
- **License:** no explicit open license was ever published — it was "free to
  download" by informal convention only. Since the site is gone, its terms are
  moot for our purposes.

### Recommended replacement: Lumbra's Gigabase

The community-recommended live equivalent is **Lumbra's Gigabase**
(<https://lumbrasgigabase.com/>), which offers a curated OTB master-games
database **in PGN** (as well as Scid/ChessBase formats). Its PGN download drops
straight into `build_reference_pack.py` (use `--time-control any` and an
`--min-elo` suited to the master pool) or imports directly. **This pass does not
implement a Lumbra fetch** — pending a look at its exact download URLs and
stated license before wiring it in.

### Scid → PGN conversion path (if you obtain a Scid-format DB)

There is **no vendor-documented command-line `si4 → PGN` exporter** in Scid vs.
PC. Confirmed from the official docs:

- `pgnscid myfile.pgn [out]` converts the **other** direction (PGN → Scid).
- Export to PGN is documented only via the **GUI**: *Tools → Export → Current
  filter / All games → PGN* (UTF-8, no line-wrap for clean re-import).

So the practical path on macOS is: open the `.si4` base in **Scid vs. PC**
(`brew install --cask scidvspc`), then *Tools → Export → PGN*. A headless CLI
export would require driving Scid's internal Tcl export procs directly
(undocumented) — **not worth building** while Lumbra ships PGN natively.

---

## 3. TWIC (weekly freshness)

Source: <https://theweekinchess.com/twic>. Each weekly issue is a ZIP at:

```
https://theweekinchess.com/zips/twic<NNNN>g.zip
```

where `<NNNN>` is the issue number (e.g. `twic1652g.zip`), containing a single
`.pgn`. As of 2026-07 the current issue is **~1652**; 2024 spans roughly issues
**1521–1573** and 2025 roughly **1574–1626** (interpolated from dated anchor
issues — pin exact year boundaries by fetching the issue's HTML page if needed).

**Terms of use — restrictive:** TWIC states it is *"free for personal use only.
All rights are reserved."* The fetched PGN therefore stays in gitignored,
local-only staging and **must not be redistributed or committed.**

### Fetch a range

`scripts/fetch_twic.py` downloads + unzips an issue range politely
(single-threaded, `User-Agent`-identified, sleeps between requests) and is
idempotent + resumable (issues already present are skipped; 404s reported, not
fatal):

```bash
python3 scripts/fetch_twic.py --from 1600 --to 1652
# -> data/reference/twic/twic1600.pgn ... twic1652.pgn
```

Verified 2026-07-13: issue 1652 fetched cleanly (6.6 MB, **15,572 games**);
re-run correctly skipped it. Extracted PGNs are plain — import directly, or run
them through `build_reference_pack.py` if you want the same Elo/time filter
applied.

---

## Disk budget

The raw Lichess dumps are **streamed, not retained** — with URL input the
multi-GB `.zst` never touches disk. What you keep is only the filtered output:

| Artifact | Cost (measured) | Per 10M games |
|---|---|---|
| Filtered PGN pack | ~2.8 KB / game | **~28 GB** |
| Imported SQLite DB (incl. position index) | ~5.7 KB / game | **~57 GB** |

Streaming the **full history** from Lichess is on the order of a few hundred GB
of *transfer* (recent months are several GB compressed each), but the retained
footprint for a ~10M-game reference DB is roughly **28 GB of packs + 57 GB of
SQLite ≈ 85 GB**. Plan for ~100 GB free to build and import the full quality
pack comfortably. TWIC and Lumbra add only single-digit GB.

---

## Files

- `scripts/build_reference_pack.py` — streaming header-filter over `.pgn.zst`
  (or plain `.pgn`, local or URL) → filtered pack + `.stats.json`.
- `scripts/fetch_twic.py` — fetch + unzip a range of TWIC weekly issues.
- `src-tauri/examples/import_smoke.rs` — import a pack into a scratch SQLite DB
  via the real backend; reports imported / dups_skipped / errors.
- `data/reference/` — staging (gitignored): downloaded dumps, packs,
  `.stats.json`, `twic/`, scratch DBs. Only this README is tracked.
