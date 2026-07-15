# 212: Tournament Game Analysis

**Status:** draft (v0 — for user iteration)
**Depends on:** 210 (tournament + neutral-evaluator per-ply evals), 200 (database, for storing
analyzed runs later); feeds and borrows from the Phase 9 mistake-mining methodology.

## Goal

Turn a finished tournament from a scoreboard into an explanation. After N games we can say
*who* won; this spec is about *why* — where each game was decided, what kinds of errors each
engine makes, and which starting conditions favor whom. The user reviews any finding by
hopping straight to the position (viewer supports per-game selection + position hop).

## Inputs

- Per-game move list + clocks + termination (already in GameRecord).
- **Per-ply evaluations from the neutral evaluator** (the "third engine") — white-POV cp/mate
  at fixed budget. This is the analysis substrate; no re-analysis pass needed for tier-1.
- The run's own **probability map** (eval-bucket → W/D/L for THESE engines at THIS TC).

## Analyses

### 1. Error report per game — self-calibrated thresholds
Classify each move by **win-probability swing, not raw centipawns** — and derive the
eval→win-prob curve from our own lab data (the probability map the tournament already
computes) instead of borrowing lichess constants tuned for humans. A -1.5 swing in a dead
draw band matters less than -0.6 across the conversion cliff.
- Labels: inaccuracy / mistake / blunder at configurable win-prob-drop thresholds
  (defaults e.g. 5/10/20 percentage points, engine-perspective).
- Each labeled move records: ply, mover (engine), eval before/after, best-move gap if the
  evaluator reported a PV, clock remaining.

### 2. Decisive moment per game
The single largest win-prob swing = "where the game was decided." Surfaced in the game list
(e.g. "decided at move 34, Reckless blunder") and clickable → hop to that position.

### 3. Per-engine error profile
Aggregated over the run: errors per 100 moves by label × game phase (opening/middle/endgame
by material+ply heuristic) × clock pressure (sub-N-seconds flag). Output: a compact table
per engine + delta view ("Reckless blunders 3.1× more in endgames under 30s").

### 4. Trajectory views
- Individual game eval graph (in the viewer bundle already).
- Average trajectory across games, sign-normalized to engine A (in the bundle already).
- Added by this spec: **band trajectories** — mean ± spread by starting-eval bucket, i.e.
  "games starting +1.0: how does the advantage typically evolve for each engine?"

### 5. Seed/opening breakdown
Group results by starting-position family (ECO where known, else eval bucket + tags from the
curated pools): per-family score for engine A, flagging families with lopsided results.
Answers "which kinds of positions does each engine misplay?"

### 6. Termination quality
Beyond the existing termination counts: cross-classification of errors with terminations — e.g. how
many losses were "converted cleanly by opponent" vs "self-inflicted single blunder" vs
"ground down with no single error ≥ mistake" (the last is the interesting engine-gap signal).

### 7. Analyze-in-depth handoff
Any game opens in the main Analyze board (tree + annotations); the error report's labeled
moves arrive as NAGs + comments on the tree (?!/?/?? per label, comment = win-prob swing),
so the full annotation/eval-graph toolchain applies. Optionally re-run deeper analysis there.

### 8. Phase 9 bridge (forward-looking, non-blocking)
The same refutation-feature extraction planned for human blunders (piece geometry, line
length, quiet-vs-forcing, motif) runs on engine errors too — engine-vs-human error-profile
contrast is itself a finding (and a human-likeness metric for the future bot: does its error
profile match the human band it imitates?).

## Non-goals (this spec)
- Persisting runs to the database (BACKLOG's past-competitions selector; design GameRecord
  evals so it's trivial later).
- Deep multi-PV re-analysis passes (the evaluator's quick pass is tier-1; a "deep verify
  decisive moments" pass can come later).
- Human-game analysis (that's Phase 9 / spec:211's domain — this spec is the engine-lab lens).

## Checklist
- [x] Eval→win-prob curve derived from the run's own probability map (fallback: logistic fit)
      — `lib/win-prob.ts` (isotonic over ≥5-game bins, logistic tails/fallback)
- [x] Per-move win-prob swing labeling (config thresholds); unit tests on synthetic evals
      — `computeMoveSwings` @ 5/10/20pp; 21 tests. Both former gaps CLOSED:
      `bestMoveGapCp` now populated from the evaluator's PV (`PlyEval.best`,
      match_runner.rs `eval_at` captures the first pv move; gap = mover-POV cp
      loss, 0 when the played move IS the PV move, null without a PV) and
      per-move clocks persist in `GameResult.clocks_ms` (`[w_ms,b_ms]` per
      move, additive serde skip-if-empty like persona_logs; `computeMoveSwings`
      falls back to them when no stream clocks are supplied). Tests:
      `tournament-analysis.test.ts` (clocks fallback + gap, white/black POV),
      Rust `parse_info_pv_first_reads_best_move` / `additive_fields_skip_when_empty`
      + real-engine assertions (clocks per move, PV captured).
- [x] Game list shows decisive moment + error counts per game; click → hop to position
      — ResultsExplorer rows: "decided m34 · <engine>" + ??/?/?! counts
      (`analyzeGame`); row click hops to the decisive ply, viewer adds a
      decisive-moment line + per-labeled-move chips, each a hop
      (`tournament-analysis-render.test.ts` asserts the markers).
- [x] Per-engine error profile table (label × phase × clock pressure) + delta view
      — `buildErrorProfiles`/`errorProfileDelta` (lib/tournament-analysis.ts):
      per-100-scored-moves rates by phase (material+fullmove heuristic:
      endgame ≤13 non-pawn points, opening ≤ fullmove 10) × sub-N-seconds flag
      (30s capped at base/2); `ErrorProfileSection` renders both tables + B/A
      ratio rows. Unit-tested with float-exact fixtures.
- [x] Band trajectories (mean ± spread by starting bucket)
      — `buildBandTrajectories`: 0.5-pawn buckets of the ENGINE-A-perspective
      start eval (flipped games sign-folded like averageEvalByPly), mean ±
      population sd per ply; `BandTrajectorySection` renders one mean±1sd
      chart per band. Exact mean/sd fixtures in tests.
- [x] Seed/opening family breakdown table
      — `buildSeedBreakdown`: family = curated-pool tag (tagged_positions
      `source`) × |eval| bucket (sign is arbitrary under color flip), plus a
      "standard start" family; per-family A score with lopsided flag (≥4
      games, ≥25pp from even). NOTE: no FEN→ECO table exists in the app
      (lib/eco.ts maps ECO code→name, not FEN→ECO), so the spec's "ECO where
      known" arm is not implementable yet — pool tag + bucket is the shipped
      family key.
- [x] Termination-quality cross table
      — `buildTerminationQuality`: termination × loser-error class (ground
      down = no loser move ≥ mistake / single blunder / multi-error, plus
      winner-clean "converted cleanly" and an `unscored` column for games
      without evals); `TerminationQualitySection` renders it.
- [x] "Open in Analyze" carries labels as NAGs/comments onto the tree
      — `annotatedGamePgn` extends the existing movesToPgn→parsePgnToTrees
      handoff: $6/$2/$4 NAGs, win-prob-swing comments (+ best-move gap +
      "Decisive moment."), and `[%eval]` tags so the Analyze eval graph
      populates too. Round-trip test walks the tree and finds nag/comment/eval
      on the blunder node.
- [ ] Spec review with user after tier-1 lands
