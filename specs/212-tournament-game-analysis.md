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
      — `computeMoveSwings` @ 5/10/20pp; 21 tests. Gaps: `bestMoveGapCp` always null
      (needs evaluator PV plumbing), per-move clocks not persisted by match_runner
- [ ] Game list shows decisive moment + error counts per game; click → hop to position
- [ ] Per-engine error profile table (label × phase × clock pressure) + delta view
- [ ] Band trajectories (mean ± spread by starting bucket)
- [ ] Seed/opening family breakdown table
- [ ] Termination-quality cross table
- [ ] "Open in Analyze" carries labels as NAGs/comments onto the tree
- [ ] Spec review with user after tier-1 lands
