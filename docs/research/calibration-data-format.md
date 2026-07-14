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

**Schema version.** The `version` field on both files is `2` at time of writing.
v2 added the known-Elo game context per position (`white_elo`, `black_elo`,
`elo_band`, `to_move`, `played_uci`, `played_san`, `continuation_san`). v1 files
stay readable — a reader should treat those fields as optional/absent for `version < 2`.

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
| `white_elo`      | int \| null     | *(v2)* White's Elo in the source game. |
| `black_elo`      | int \| null     | *(v2)* Black's Elo in the source game. |
| `elo_band`       | string          | *(v2)* Average-Elo band: `"<1600"`, `"1600-2000"`, `"2000-2400"`, `"2400+"`. |
| `to_move`        | string          | *(v2)* `"white"` or `"black"` — whose move `played_*` is (matches the FEN turn). |
| `played_uci`     | string \| null  | *(v2)* The move actually played from this position in the source game, UCI. |
| `played_san`     | string \| null  | *(v2)* Same move in SAN. |
| `continuation_san` | string[]      | *(v2)* The next up-to-three moves after the played one, SAN. |

Each answered position is therefore **triple-labelled**: the Stockfish eval, the
user's perceived eval + reasoning, and what a rated human actually played. The
Elo context is stored but **never shown in the answering UI** (it would anchor
the user's eval); the results screen reveals the played move only after answering.

**Sampling** (see `src-tauri/src/calibration.rs`): v2 samples **only Elo-known
games** (≈95% of the corpus), drawing an **equal candidate slice per Elo band**
(so the artifact spans skill levels despite the corpus skewing strong — ~70% of
games are 2400+). One position per game is taken at a random `ply ≥ 16` (which,
unlike the ply-40 position index, reaches real endgames). Positions where the
side to move is in check or a capture landed within ±2 plies are excluded, and
positions are deduplicated by Zobrist hash. Candidates are stratified across the
four `|SF eval|` bands × four Elo bands and scored by a local Stockfish at
500 ms, MultiPV 2. (Phase — middlegame/endgame — is captured and reported but is
no longer a hard stratum; Elo replaced it, since endgames are too sparse to
bucket on but now at least appear.)

## `results-*.json` — `CalibrationResults`

```jsonc
{
  "version": 2,
  "finished_at": 1736808600000,    // unix ms
  "show_reveal": true,             // was the post-answer reveal shown (vs a blind run)?
  "show_coach": true,              // was AI coach feedback enabled (else no API calls)?
  "session": CalibrationSession,   // the full session (embedded)
  "answers": [ CalibrationAnswer, ... ],
  "summary": CalibrationSummary
}
```

`show_reveal` records whether the user saw Stockfish's answer after each
position. A **blind** session (`false`) is methodologically distinct data — no
between-position feedback, so no within-session learning — and analysis should
segregate the two. When `true`, `answer_locked_at` on each answer guarantees the
eval was committed before the reveal was visible.

### `CalibrationAnswer`

One per position the user reached (in session order).

| field        | type           | meaning |
|--------------|----------------|---------|
| `index`      | int            | Index into `session.positions`. |
| `eval`       | float \| null  | Perceived eval in pawns (`+` = White); `null` if skipped or left blank. |
| `why`        | string         | The user's stated reasoning (may be empty). |
| `move_uci`   | string \| null | The move they'd play, UCI; `null` if none chosen. |
| `elapsed_ms` | int            | Wall time from position-shown to submit (includes typing). |
| `think_ms`   | int \| null    | Think time: position-shown → first interaction (first keystroke or board move). The meaningful metric — typing time is not thinking time. `null` if never interacted, or for answers that predate this field. |
| `time_excluded` | bool        | The user asked not to count their time here (distracted), or the answer predates `think_ms`. The answer still counts for eval accuracy; only time analysis ignores it. |
| `answer_locked_at` | int         | Unix-ms the answer was committed — stamped *before* any second look or reveal renders, so neither could have influenced the answer. `0` for answers predating this field. |
| `revised_eval` | float \| null | Second-look revised eval in pawns, or `null` if not revised. The original `eval`/`why` are never mutated. |
| `revision_note` | string \| null | One-line note on what the second look caught (e.g. "missed the Qe1"), or `null`. |
| `revised_at` | int \| null     | Unix-ms of the revision, or `null`. |
| `coach`      | `CoachFeedback` \| null | The AI coach's critique of the written reasoning (added async after the reveal), or `null` if the coach was off / unavailable. |
| `skipped`    | bool           | True if the user skipped rather than answered. |

### `CoachFeedback`

Claude reads the user's *reasoning* (not just their number) on the reveal and
diagnoses where it diverged from the engine evidence — grounded only in the
Stockfish line and game continuation passed to it (it never invents variations).
Model: `claude-opus-4-8`. Structured via a forced, strict tool call.

| field               | type     | meaning |
|---------------------|----------|---------|
| `note`              | string   | 2-4 sentence coach note addressed to the user. |
| `cause_tags`        | string[] | Cause labels from the fixed vocabulary below. |
| `reasoning_quality` | string   | `"sound"` \| `"partial"` \| `"flawed"`. |
| `scale_error`       | bool     | Direction right, magnitude off (calibration vs perception). |

**Cause-tag vocabulary** (fixed; the first machine labeler for the mistake
taxonomy — keep in sync with `src-tauri/src/coach.rs`): `missed_piece`,
`miscounted_exchange`, `overlooked_defender`, `overlooked_attacker`,
`missed_tactic`, `wrong_plan_priority`, `king_safety_misjudged`,
`endgame_technique`, `scale_miscalibration`, `sound_reasoning`.

The **second look** is an optional step between commit and reveal (still no
engine info shown), so a revision measures the user's own fresh glance, not a
reaction to feedback. Self-correction rate and magnitude (how often a second
look catches a real miss, and by how much) is a per-band skill signature —
`revised_eval − eval` against `sf_cp` tells you whether the correction moved
toward or away from the engine.

Answers are listed in **presentation order** and each carries its `index`, so
learning / drift effects over a session are analysable.

Answers written before `think_ms` existed are upgraded on load: `think_ms` → `null`,
`time_excluded` → `true` (a distracted early session must not pollute the timing
stats). Sessions are held in `localStorage` and resume across app restarts — the
expected usage is 100 positions over several evenings.

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
| `medianThinkMs`   | float \| null     | Median think time (ms) over time-included, interacted answers. |
| `timeExcludedCount` | int             | Answers whose time was excluded (user-marked or upgraded). |
| `perBand`         | `BandStat[]`      | `{ band, count, mae }` for each of the four bands. |
| `biggestMisses`   | `Miss[]`          | Up to 10 `{ index, fen, band, userEval, sfEval, absError }`, worst first. |
