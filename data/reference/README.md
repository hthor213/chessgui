# Reference Database Pipeline

Offline tooling that builds the **reference game database** for ChessGUI — the
open, subscription-free replacement for ChessBase's *Mega Database*. It
produces PGN "packs" that the app imports through its SQLite backend
(`src-tauri/src/db.rs :: db_import_pgn`, which streams from a file path and
dedups on a content hash at import time).

## Topology (what lives where)

Two classes of pack, different homes:

- **OTB packs = canonical.** Over-the-board master games (Lumbra's Gigabase +
  TWIC + a future ChessBase/Mega CBH import) are the heart of the reference
  DB. Keep everything — no quality filter. Stored **locally AND on the
  homeserver**.
- **Lichess pack = homeserver-only.** Online games are bulk, so the Lichess
  quality pack is tightened to a **20–30 GB imported DB** (see calibration
  below) and lives only on the homeserver.

The homeserver holds ONE canonical everything-DB, served from there; datamining
jobs (e.g. the mistake-mining corpus) run there too.

**Everything under `data/reference/` is staging and gitignored** (except this
README). Downloaded dumps, packs, `.stats.json` sidecars, `lumbra/`, `twic/`,
and scratch import DBs all live here and are **never** auto-written into a
user's database. Promotion into an imported DB is an explicit, logged step
(`src-tauri/examples/import_smoke.rs`). Provenance is carried end-to-end: each
pack ships a `.stats.json` recording source + filter + counts, and every
imported row is stamped with a `source` string.

---

## Sources

| Source | What | Format | License / terms | Home |
|---|---|---|---|---|
| **Lumbra's Gigabase** | Curated OTB master games (~10.3M) | PGN (in `.7z`, via MEGA) | **CC BY-NC-SA 4.0** — non-commercial, attribution, share-alike | local + server |
| **TWIC** (The Week in Chess) | Weekly OTB games, ongoing freshness | `.pgn` in a per-issue `.zip` | **"Free for personal use only. All rights reserved"** — do **not** redistribute | local + server |
| **Lichess** open database | Monthly dumps of all rated standard games | `.pgn.zst` (zstandard) | **CC0** (public domain) | server only |
| *(future)* ChessBase / Mega | OTB via CBH import | CBH → PGN | proprietary; read-only interop | local + server |

> **Attribution (required by Lumbra's license):** "Lumbra's Gigabase © 2024–2026
> by Michael Jansen, licensed under CC BY-NC-SA 4.0." Non-commercial use only —
> bundling into a commercial product needs a separate license
> (business@lumbrasgigabase.com).

---

## 1. OTB — Lumbra's Gigabase (canonical, primary)

Source: <https://lumbrasgigabase.com/> — the community successor to the now-
defunct Caïssabase. The OTB set is offered as PGN split by era, delivered via
**MEGA.nz** (end-to-end encrypted — plain `curl` cannot fetch it).

Packages (OTB set; `--list` prints all, incl. the Online set we don't use):

| slug | contents | approx size (`.7z`) |
|---|---|---|
| `otb-complete` | everything (the canonical pull) | ~1.48 GB |
| `otb-2025`, `otb-2020-2024`, `otb-2015-2019`, … `otb-0001-1899` | per-era | 40–260 MB |
| `otb-elite-elo-2400` | Elo > 2400 only | ~125 MB |
| `otb-partial-2026` | current year, updated monthly (first Tuesday) | ~51 MB |

### Run it

```bash
python3 scripts/fetch_lumbra.py --list                  # inventory
python3 scripts/fetch_lumbra.py --package otb-complete   # the full OTB base
python3 scripts/fetch_lumbra.py --package otb-2025 --package otb-partial-2026
```

Requires **`megatools`** (`brew install megatools`) for the MEGA download, and
`p7zip` (`brew install p7zip`) to unpack `.7z`. The fetcher resolves each
`/download/<slug>/` redirect to its live mega.nz link, downloads with `megadl`,
extracts to `data/reference/lumbra/<slug>.pgn`, and is idempotent (a slug whose
`.pgn` already exists is skipped). OTB = import as-is (no filtering).

---

## 2. OTB — TWIC (weekly freshness)

Source: <https://theweekinchess.com/twic>. Each weekly issue is a ZIP at
`https://theweekinchess.com/zips/twic<NNNN>g.zip` (e.g. `twic1652g.zip`)
containing one `.pgn`. As of 2026-07 the current issue is ~1652; 2024 ≈ issues
1521–1573, 2025 ≈ 1574–1626 (interpolated from dated anchors).

**Terms — restrictive:** *"free for personal use only. All rights are reserved."*
Fetched issues stay in gitignored local staging and **must not be redistributed
or committed.**

```bash
python3 scripts/fetch_twic.py --from 1600 --to 1652
# -> data/reference/twic/twic1600.pgn ... twic1652.pgn
```

Polite (single-threaded, `User-Agent`, inter-request sleep), idempotent, and
resumable (existing issues skipped; 404s reported, not fatal). Extracted PGNs
are plain — import directly. Note TWIC games are also fed into Lumbra, so
importing both is expected to produce heavy dedup overlap (measured ~53% of a
TWIC issue already present after a Lumbra OTB import — the content-hash dedup
handles it correctly).

---

## 3. Lichess quality pack (server-only, calibrated to 20–30 GB)

Source: <https://database.lichess.org/> — `lichess_db_standard_rated_YYYY-MM.pgn.zst`,
licensed **CC0**, so filtered packs can be stored and served freely. Dumps run
**2013-01 → present** (162 months, ~7.95 billion games total as of 2026-06;
authoritative per-year counts at `.../standard/counts.txt`).

`scripts/build_reference_pack.py` streams + decompresses each month (file or
URL — the multi-GB `.zst` never lands on disk with URL input) and keeps games
whose **headers** match, writing matches verbatim + a `.stats.json`. Filter
flags:

- `--time-control` — comma list, e.g. `"600+5,900+10,1800+0,1800+20"` (or `any`)
- `--min-elo` — required of **both** players
- `--require-evals` — keep only games carrying `[%eval]` annotations (the
  mistake-mining corpus; also roughly halves yield)
- `--limit`, `--max-input-bytes` (sample the head of a huge remote month),
  `--allow-unrated`

`stats.json` now also breaks matches down by `matched_by_time_control`.

### Calibration (how the filter was sized)

`scripts/calibrate_lichess.py` streams the head (300 MB) of three era-sample
months once each, tallies every filter combo simultaneously, and extrapolates
to full history using the authoritative `counts.txt` per-year totals. Run
2026-07-13 (`--months 2019-06,2022-06,2025-06 --max-input-bytes 300000000`;
DB size at the measured **5.7 KB/game**):

| filter (TC = rapid 600+5,900+10 **+ classical** 1800+0,1800+20) | est. games (full history) | est. DB |
|---|---|---|
| `elo≥2000`, evals **off** | 9.26 M | ~53 GB |
| **`elo≥2000`, evals on** | **4.30 M** | **~24.7 GB ✓** |
| `elo≥2200`, evals off | 1.30 M | ~7.5 GB |
| `elo≥2200`, evals on | 0.75 M | ~4.3 GB |

(rapid-only, without the two classical TCs, runs ~10–13% smaller.) Match rates
climb sharply over time — 10+5 / 2000+ was near-zero in 2013–2016 and evals
adoption grew — so recent years dominate the yield. Numbers are order-of-
magnitude estimates (3 era anchors), not a full-history count.

### Recommended filter

**`--min-elo 2000 --time-control "600+5,900+10,1800+0,1800+20" --require-evals`**
→ **~4.3 M games ≈ 24.7 GB**, mid-window.

Rationale: it's the measured combo that lands squarely in 20–30 GB, biased to
longer time controls (includes classical) and 2000+ Elo, and — because every
kept game carries `[%eval]` — this single pack **doubles as the mistake-mining
corpus**, satisfying that requirement with one build. `elo≥2200` (evals-off,
~7.5 GB) is the smaller "elite, under budget" alternative; a pure opening-
explorer pack with **no** eval requirement would need an intermediate Elo
(~2100, between the two sampled points) to fit budget — re-run the calibrator
with `--elos 2050,2100,2150` to pin it.

### Run the full history month-by-month

```bash
for ym in 2020-{01..12} 2021-{01..12} 2022-{01..12} 2023-{01..12} \
          2024-{01..12} 2025-{01..12}; do
  python3 scripts/build_reference_pack.py \
    --input "https://database.lichess.org/standard/lichess_db_standard_rated_${ym}.pgn.zst" \
    --min-elo 2000 --time-control "600+5,900+10,1800+0,1800+20" --require-evals \
    --output "data/reference/pack_${ym}.pgn"
done
```

Resumable at month granularity; the importer dedups, so overlapping re-runs are
safe. Requires the `zstandard` package (falls back to a `zstd`/`zstdcat`
binary).

---

## Importing a pack

Packs (and raw OTB PGNs) import through the same backend the UI uses. A headless
example bin:

```bash
cd src-tauri
cargo run --example import_smoke -- \
  ../data/reference/lumbra/otb-2025.pgn /tmp/scratch.sqlite \
  "lumbra:otb-2025 (CC-BY-NC-SA-4.0)"
```

It prints `imported / dups_skipped / errors` and before/after stats; the third
arg is the `source` provenance string. Dedup is on a content hash — re-running
a pack imports 0 and reports the rest as `dups_skipped`, and importing an
overlapping source (e.g. TWIC after Lumbra) correctly skips the shared games.

---

## Verified end-to-end (2026-07-13)

**Lichess filter** (extended script): 2013-01 full month, 121,332 seen → 7
matched at the old 600+5/1900+ recipe. 2024-01 first 200 MB streamed → 1,346
matched at ~46k games/s. Multi-TC and `--require-evals` exercised on 2013-01.

**Lumbra fetch + OTB import:**

| step | result |
|---|---|
| fetch `otb-2025` | MEGA resolved, 44 MB `.7z` → 235 MB PGN, **205,418 games** |
| fetch `otb-partial-2026` | 51 MB → **142,683 games** |
| import `otb-2025` (fresh DB) | 205,418 imported, 0 dups, 0 errors, 8.30 M positions, 812 MB |
| import `otb-partial-2026` (same DB) | 142,683 imported, **0 dups vs 2025** (disjoint eras) |
| import `twic1652` (7,729 games, same DB) | **3,671 imported, 4,058 dups** (~53% already in Lumbra) |

The last row is the cross-source dedup sanity check: TWIC feeds Lumbra, and the
content-hash dedup catches the overlap without over-matching disjoint data.

---

## Disk budget

Raw Lichess dumps are **streamed, not retained** (URL input). Retained
footprint:

| Artifact | Cost (measured) | Home |
|---|---|---|
| Lichess quality pack, imported | ~5.7 KB/game → **20–30 GB** at the recommended filter | server only |
| Lumbra OTB, imported | ~4.0 KB/game (no eval comments); ~3.5–4 GB local PGN, up to ~40 GB imported for the full ~10M-game base | local + server |
| TWIC issues | single-digit GB | local + server |

Plan ~50–60 GB on the homeserver for the combined canonical DB (OTB + tightened
Lichess pack); a few GB locally for the OTB PGNs.

---

## Files

- `scripts/build_reference_pack.py` — streaming header-filter (multi-TC,
  `--require-evals`) over `.pgn.zst`/`.pgn`, local or URL → pack + `.stats.json`.
- `scripts/calibrate_lichess.py` — size the Lichess filter to a disk budget
  before building (era-sample match rates × `counts.txt` totals).
- `scripts/fetch_lumbra.py` — resolve + `megadl` + extract Lumbra OTB packages.
- `scripts/fetch_twic.py` — fetch + unzip a range of TWIC weekly issues.
- `src-tauri/examples/import_smoke.rs` — import a pack into a scratch SQLite DB
  via the real backend; reports imported / dups_skipped / errors.
- `data/reference/` — staging (gitignored): dumps, packs, `.stats.json`,
  `lumbra/`, `twic/`, scratch DBs. Only this README is tracked.
