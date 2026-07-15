# Persona datasets — extraction record (spec 214, phase 1)

Validation-persona game sets for the persona simulator. Extracted from the app's
SQLite game DB (`~/Library/Application Support/com.hjalti.chessgui/games.db`,
955,819 games, source `cbh:Database` — a Lumbra/ChessBase OTB import) on
**2026-07-14**. Reproduce with `scripts/`-independent script archived at
`extract_personas.py` (kept in the session scratchpad; move into `scripts/` if we
re-run this).

Both personas are historical public figures, so these files MAY be committed
(spec 214 "Hard rules"). Left **uncommitted** pending review.

## Files

| File | Games | Purpose |
|------|-------|---------|
| `fischer.pgn` | 322 | All Bobby Fischer games (full set) |
| `fischer.train.pgn` | 258 | Persona-book / policy build set (80%) |
| `fischer.eval.pgn` | 64 | Held-out eval set (20%) — **never** used for book building |
| `kasparov.pgn` | 1637 | All Garry Kasparov games (full set) |
| `kasparov.train.pgn` | 1310 | Build set (80%) |
| `kasparov.eval.pgn` | 327 | Held-out eval set (20%) |
| `kasparov.train.classical.pgn` | 1098 | **Classical-only** train view (train minus 212 speed/exhibition) — the persona book source |
| `sigurjonsson.pgn` | 401 | All Gudmundur Sigurjonsson games (full set) |
| `sigurjonsson.train.pgn` | 321 | Build set (80%) |
| `sigurjonsson.eval.pgn` | 80 | Held-out eval set (20%) |
| `sigurjonsson.peak.pgn` | 176 | **Peak-era slice (1975–1978)** — the persona-at-full-strength product |

Every game carries full headers including `WhiteElo`/`BlackElo` (when known) and
`ECO`. The `.train`/`.eval` files are the authoritative split; the harness must
sample eval positions from `*.eval.pgn` only.

## Selection filters

- **Fischer:** `White = 'Fischer, Robert James'` (exactly). **322 games.**
- **Kasparov:** `White/Black = 'Kasparov, Garry'` (exactly). **1637 games.**
- **Sigurjonsson:** `White/Black = 'Sigurjonsson, Gudmundur'` (exactly). **401 games.**
  No namesake mixing: the only other `Sigurjonsson,*` are different first names
  (`Stefan Th.` 6, `Brynjar Logi` 1); the `Sigurjonsson, G%` filter uniquely
  resolves to Gudmundur. All 401 span 1968–2003 with own Elo ~2440–2523 —
  consistent with the single real GM (b. 1947, GM 1975). No date/Elo outliers.

### Namesake exclusion (Fischer) — IMPORTANT

The naive `Fischer, Robert%` filter (which yields the "333 expected") pulls in an
**amateur namesake**. 11 games under the variant **`Fischer, Robert J`** are dated
**2025** at the *33rd World Senior 65+* and *3rd Atlantic Ind Day Open*, versus
sub-1900 opponents (e.g. Devlin, Brian, 1444). Bobby Fischer died **2008-01-17**
and played his last games in the **1992** Spassky rematch, so any 2025 game under
that name is a different person. These 11 are **excluded**; the real Bobby Fischer
is exactly `Fischer, Robert James` (322).

Other name families ruled out: `Kasparov, Sergey` (521 — a different GM),
`Kasparov, Aram` (16), `Kasparov/Crumiller` (1); the many other `Fischer,*`
(Daniel, Emil Fiete, etc.).

## Deduplication

**0 duplicates found** in either persona after correcting the dedup key.

- The DB already removes exact `(mainline UCI + result)` duplicates at import
  (`dup_hash`, `src-tauri/src/db.rs`). All persona games share one source, so the
  only near-dup that could survive is *same mainline, different result token*.
- Dedup key = **the parsed mainline UCI sequence** (via python-chess). Two records
  with a byte-identical move sequence are the same game; genuinely different games
  are always kept.
- **Rejected approach (documented so we don't repeat it):** a metadata key of
  `(date, opponent, result, ply_count)` *falsely* flagged 6 pairs as dupes. Cause:
  partial dates like `1992.??.??` are shared by every game of a match, so distinct
  games collided on the key. Verified by comparing mainlines — the "pairs" diverge
  at move 1. That key would have silently dropped 6 real games.

## Held-out split

- **Seed: 214** (`random.Random(214)`), `EVAL_FRAC = 0.20`.
- Procedure: validated games in DB-scan order → `random.shuffle` → first 20% =
  eval, remainder = train. Files then sorted by `(date, id)` for stable diffs.
- Verified: `train ∩ eval = ∅`, `train ∪ eval = all`, eval fraction 0.199 / 0.200.
- The committed `*.eval.pgn` / `*.train.pgn` files are the source of truth for
  membership (regenerating requires the same DB scan order + seed 214).

## Data-quality flags

- **Missing movetext / result-only / truncated: 0.** No game had an empty mainline
  or a bare result token. Shortest games: Fischer 24 plies, Kasparov 21 plies
  (legit miniatures/short draws, not stubs). Longest: 224 / 236 plies.
- **Parse errors: 0.** Every game in all 6 files parses cleanly with
  python-chess 1.11.2 (`game.errors` empty, ≥1 legal mainline move each).
- **Elo coverage:** Fischer 86/322 games have a known opponent Elo (the Elo era
  barely overlaps his career — most 1950s–70s games have none); Kasparov
  **1637/1637** fully Elo-tagged. The eval harness's ACPL-by-Elo and Elo-matched
  policy selection can only use the Elo-known subset for Fischer.
- **Kasparov is a CLASSICAL persona — speed games kept in full set, excluded from
  the book.** Decision (team lead): keep blitz/rapid in `kasparov.pgn` /
  `.train.pgn` / `.eval.pgn` for completeness, but build the persona book and the
  headline harness from a classical-only view, `kasparov.train.classical.pgn`.
  - **Correction to my earlier report:** I first flagged only ~40 exhibitions
    (the visually-obvious 2011–2016 rapid/blitz). That was wrong — a word-boundary
    regex silently missed the `5'`-style minute markers. The real speed/exhibition
    footprint is **252 games across 1987–2016** (blitz, rapid, active chess:
    Internet blitz 5' (1998), Paris Immopar rapid (1990–92), World-ch blitz (1988),
    Munich Intel Express blitz, Saint Louis Ultimate Blitz (2016), etc.).
  - **Classical exclusion rule** (reproducible): drop games whose `Event` matches
    an explicit speed marker — `\bblitz\b`, `\brapid\b`, `\bactive\b`, or a minute
    marker (`5'` / `3'` / `'5`), case-insensitive — **OR** a known rapid/TV
    exhibition event: `Zuerich Kortschnoj KO` (Korchnoi jubilee rapid knockout,
    2001) and `Moscow TV` (TV exhibition, 1987). Everything else is classical.
    (Team-lead call: these two carry no speed keyword but are not classical
    tournament play; better to lose 10 genuine games than admit 10 speed games.)
  - **`kasparov.train.classical.pgn` = 1310 train − 212 speed = 1098 games**
    (verified: 0 residual speed games, 0 parse errors). Full set: **1375 classical
    / 262 speed** (252 by keyword + 10 by the two named exhibition events).
  - The harness may report move-match with and without speed games as a robustness
    check; the eval split (`kasparov.eval.pgn`) is left unfiltered so both views
    score against the same held-out positions.
- **Partial dates:** many games carry `YYYY.??.??` (no month/day). Fine for
  splitting and style stats; only affects fine-grained chronological ordering.

## Profile

### Fischer (322 games)
- Date range: **1956 – 1992** (Elo era barely applies; d. 2008, last games 1992).
- Color: 153 White / 169 Black.
- Result (Fischer POV): **137 W / 138 D / 47 L.**
- Opponent Elo (86 known): min 2450, max 2660, avg 2591 — all GM-strength.
- Contains the complete 1972 Reykjavik WC match (21 games) + the 1992 Spassky
  rematch (30 match + 11 training games).

### Kasparov (1637 games)
- Date range: **1979 – 2016** (peak classical career + later exhibitions).
- Color: 820 White / 817 Black.
- Result (Kasparov POV): **728 W / 767 D / 141 L / 1 other.**
- Opponent Elo (1637 known): min 2360, max 2807, avg 2646.

### Sigurjonsson (401 games)
- Date range: **1968 – 2003** (Elo era covers his whole career).
- Color: 204 White / 197 Black.
- Result (Sigurjonsson POV): **71 W / 232 D / 98 L** (draw-heavy, as expected for a
  positional GM against strong OTB fields).
- Opponent Elo (all 401 known): min 2410, max 2705, avg 2494 — solid GM opposition.
- 0 duplicates, 0 excluded, 0 parse errors; shortest game 21 plies (legit).

## Peak-era analysis (Sigurjonsson)

The product for the "play dad's old friend at full strength" use case is
`sigurjonsson.peak.pgn`. The peak window was chosen **empirically** from per-year
performance, not by assumption. Per-year (POV Sigurjonsson; perfR = avg-opp-Elo +
400·(2·score−1)):

| Year | Games | Score% | avg Opp | own Elo | perfR |
|-----:|------:|-------:|--------:|--------:|------:|
| 1973 | 7  | 57.1 | 2429 | 2470 | 2486 |
| 1974 | 23 | 43.5 | 2483 | 2478 | 2431 |
| **1975** | **34** | **50.0** | **2482** | **2475** | **2482** |
| **1976** | **67** | **53.7** | **2514** | **2523** | **2544** |
| **1977** | **47** | **43.6** | **2513** | **2520** | **2461** |
| **1978** | **28** | **50.0** | **2513** | **2503** | **2513** |
| 1979 | 20 | 32.5 | 2523 | 2490 | 2383 |
| 1980 | 30 | 35.0 | 2500 | 2475 | 2380 |
| 1982 | 32 | 57.8 | 2463 | 2441 | 2525 |

**Chosen peak window: 1975–1978 (176 games).** Rationale:
- **1976 is the single peak year** on every axis — own Elo ceiling (2523), best
  performance rating (2544), most active (67 games), positive score against the
  strongest average field (2514).
- His **rating plateau at ~2503–2523 runs 1975–1978**; the GM title (1975) is the
  natural start.
- **1979 is a sharp, sustained decline** (32.5%, perfR 2383; 1980 similar) — a
  clean cutoff. The 1982 blip (57.8%) is a lone good year amid decline at a lower
  own Elo (2441), so it's excluded from "full strength".
- Peak slice performance: 39 W / 97 D / 40 L vs avg opponent Elo **2507** (≈2505
  performance) — genuinely his strongest, world-elite-facing chess.

`sigurjonsson.peak.pgn` contains **all** 176 peak-window games. For a leakage-free
harness eval of the peak persona, note the split overlap: **139** peak games are in
`sigurjonsson.train.pgn` and **37** are in `sigurjonsson.eval.pgn` — build the peak
book from the 139 train-side peak games and evaluate on the 37 eval-side ones.

## Verification (spot checks)

- **Fischer–Spassky, 1972 WC Game 6** (R6, 1972.07.23): present, Fischer White,
  `1.c4 e6 2.Nf3 d5`, **1-0**. ✓
- **Kasparov–Topalov, Wijk aan Zee 1999** (R4, 1999.01.20 — "Kasparov's
  Immortal"): present, Kasparov White, `1.e4 d6 2.d4 Nf6 3.Nc3 g6` (Pirc), **1-0**,
  87 plies. ✓
- Full 21-game 1972 Fischer–Spassky match verified present.
- **Sigurjonsson peak-era opposition** (authenticity check): the 1975–1978 slice
  includes games vs Korchnoi (2670), Portisch (2630), Larsen (2625), Polugaevsky
  (2620), Hort (2620), Geller (2620), Smejkal — the world-elite field of the era,
  confirming this is the real GM, not a namesake. 16 peak games vs 2600+ opponents.

## Fleet roster extraction (spec 217, 2026-07-15)

Spassky + Karpov + the Icelandic canon, extracted by `scripts/persona/
extract_roster.py` (same pipeline: read-only app DB, empty-movetext rejects,
mainline-UCI dedup, python-chess validation, seeded 80/20 split, seed 214).
Name variants were swept with LIKE queries over surname / first-name /
transliterations from ICELAND_ROSTER.md; each player has exactly ONE spelling
in the Lumbra OTB DB (no "Jon Loftur Arnason", no "Hannes Hlifar Stefansson",
no bare "Spassky, Boris"). Nobody fell below the 100-game floor. Full stats:
`_cache/roster_summary.json`.

| persona | DB name | raw | dupes | parse rejects | valid | train/eval | dates | own Elo (min–max, avg) |
|---|---|--:|--:|--:|--:|---|---|---|
| spassky | Spassky, Boris Vasilievich | 1181 | 0 | 0 | 1181 | 945/236 | 1970–2009 | 2535–2690, 2601 |
| karpov | Karpov, Anatoly | 2959 | 0 | 1 | 2958 | 2366/592 | 1971–2016 | 2540–2785, 2704 |
| fridrik-olafsson | Olafsson, Fridrik | 343 | 0 | 0 | 343 | 274/69 | 1971–2013 | 2416–2570, 2529 |
| margeir-petursson | Petursson, Margeir | 972 | 0 | 0 | 972 | 778/194 | 1979–2026 | 2382–2590, 2526 |
| johann-hjartarson | Hjartarson, Johann | 1097 | 0 | 0 | 1097 | 878/219 | 1979–2026 | 2270–2640, 2556 |
| hannes-stefansson | Stefansson, Hannes | 1363 | 0 | 0 | 1363 | 1090/273 | 1987–2026 | 2335–2604, 2543 |
| helgi-olafsson | Olafsson, Helgi | 899 | 0 | 0 | 899 | 719/180 | 1978–2026 | 2420–2595, 2512 |
| jon-l-arnason | Arnason, Jon L | 686 | 0 | 0 | 686 | 549/137 | 1978–2026 | 2404–2590, 2498 |
| hedinn-steingrimsson | Steingrimsson, Hedinn | 315 | 0 | 0 | 315 | 252/63 | 1991–2025 | 2410–2574, 2509 |

Namesake check: every persona's own-Elo floor is ≥2270 and the date spans
match the real careers (Spassky's DB coverage starts at 1970 — Lumbra's Elo-era
cut, not a data problem; Karpov runs to 2016 exhibitions; the active Icelanders
run to 2026). The small same-surname players found in the sweep (Olafsson
Olafur Orn/Thorvardur, Petursson Gudni/Stefan Mar, Karpov Vladyslav/Vadim/…)
are excluded by the exact-name filter. Karpov's one parse reject is
Polgar–Karpov, Lindsborg 2004 (corrupt SAN `Ne2` at move 1 in the source).

Opening books (`{slug}.book.json`, build_rival_book.py v1 format, max_ply 24)
are built from TRAIN splits only, so held-out eval games never leak into a
book. `sigurjonsson-peak.book.json` uses the 139 train-side games of the
1975–1978 peak window (see "Peak-era analysis" above). Persona configs
(`{slug}.config.json`) carry backend + sampling defaults + the measured
harness label; see HARNESS_RESULTS.md.
