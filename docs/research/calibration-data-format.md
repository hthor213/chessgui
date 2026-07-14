# Eval Calibration data format

The Learn view's **Eval Calibration** feature (spec 213 data collection) writes
two kinds of JSON file under the app data directory:

```
<app_data_dir>/calibration/
  session-<created_at_ms>.json    # the positions shown, written when a session is built
  results-<saved_at_ms>.json      # the full record, written when the user finishes
```

`<app_data_dir>` is the standard Tauri app-data path (on macOS,
`~/Library/Application Support/<bundle-id>/`). These files are the ground-truth
research artifact: real human evals at a known rating, to be compared against
Stockfish in the spec-213 program (design doc §4/§5). Each `results-*.json` is
**self-contained** — it embeds the full session, so no join back to a
`session-*.json` is needed for analysis.

All engine numbers are **White-POV** (`+` favours White), matching every eval in
the app.

## `session-*.json` — `CalibrationSession`

```jsonc
{
  "version": 1,                    // schema version
  "n": 100,                        // number of positions
  "created_at": 1736808000000,     // unix ms; also the file id
  "stockfish_path": "/opt/homebrew/bin/stockfish",
  "positions": [ CalibrationPosition, ... ]
}
```

### `CalibrationPosition`

| field            | type            | meaning |
|------------------|-----------------|---------|
| `fen`            | string          | Full FEN of the position to judge. |
| `sf_cp`          | int \| null     | Stockfish eval in centipawns, White-POV; `null` on a forced mate. |
| `sf_mate`        | int \| null     | Mate distance in moves (`+` = White mates); `null` when `sf_cp` is set. |
| `sf_best_uci`    | string          | Stockfish's best move, UCI (e.g. `"g1f3"`). |
| `sf_best_san`    | string \| null  | Same move in SAN, for display. |
| `multipv_gap_cp` | int \| null     | Sharpness: `|eval(pv1) − eval(pv2)|` in cp; `null` when unavailable. |
| `material`       | int             | Material balance in points (P1 N3 B3 R5 Q9), White − Black. |
| `band`           | string          | `|SF eval|` band: `"0-0.5"`, `"0.5-1.5"`, `"1.5-3"`, `"3+"`. |
| `phase`          | string          | `"middlegame"` or `"endgame"` (non-pawn phase weight ≤ 8 → endgame). |
| `game_id`        | int             | Source game id in the local database. |
| `ply`            | int             | Half-move index of this position in that game (≥ 16, out of book). |

**Sampling** (see `src-tauri/src/calibration.rs`): candidates are drawn from the
game database's position index at `ply ≥ 16`, excluding positions where the side
to move is in check or a capture landed within ±2 plies, deduplicated by Zobrist
hash, and stratified roughly evenly across the four `|SF eval|` bands × two
phases. Each candidate is scored by a local Stockfish at 500 ms, MultiPV 2.

## `results-*.json` — `CalibrationResults`

```jsonc
{
  "version": 1,
  "finished_at": 1736808600000,    // unix ms
  "session": CalibrationSession,   // the full session (embedded)
  "answers": [ CalibrationAnswer, ... ],
  "summary": CalibrationSummary
}
```

### `CalibrationAnswer`

One per position the user reached (in session order).

| field        | type           | meaning |
|--------------|----------------|---------|
| `index`      | int            | Index into `session.positions`. |
| `eval`       | float \| null  | Perceived eval in pawns (`+` = White); `null` if skipped or left blank. |
| `why`        | string         | The user's stated reasoning (may be empty). |
| `move_uci`   | string \| null | The move they'd play, UCI; `null` if none chosen. |
| `elapsed_ms` | int            | Wall time spent on the position. |
| `skipped`    | bool           | True if the user skipped rather than answered. |

### `CalibrationSummary`

Derived scoring (recomputable from `session` + `answers` via
`lib/calibration-stats.ts`; stored for convenience). Mate scores are capped at
±12 pawns for the numeric comparisons.

| field             | type              | meaning |
|-------------------|-------------------|---------|
| `answered`        | int               | Positions with a usable eval. |
| `skipped`         | int               | Positions skipped. |
| `moveAnswers`     | int               | Answers that also picked a move. |
| `pearson`         | float \| null     | Correlation of user vs Stockfish eval (`null` if < 2 points). |
| `mae`             | float \| null     | Mean absolute error in pawns. |
| `bestMoveHitRate` | float \| null     | Fraction of move-answers matching Stockfish's best move. |
| `perBand`         | `BandStat[]`      | `{ band, count, mae }` for each of the four bands. |
| `biggestMisses`   | `Miss[]`          | Up to 10 `{ index, fen, band, userEval, sfEval, absError }`, worst first. |
