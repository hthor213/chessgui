# 224: Learn tab — rolling Elo estimate with honest uncertainty

**Status:** draft
**Depends on:** 211 (avoidance-puzzle results store — the attempt log this reads), 215 (Training/Learn surface — where the number renders)
**Related:** 213 (calibration Elo, a sibling Learn measurement), 216 (Elo-per-doubling model — house style for a provenance-flagged core estimator)

## Goal

When the user opens the **Learn** tab, show an **estimated Elo with an uncertainty band**
next to the session summary — the user's exact ask (2026-07-15):

> Unfinished Session: Elo 1238 ± 250

The number answers "how strong am I right now, on the evidence I've actually produced?" and
the ± answers "how much should you trust that?" — both stated honestly, never a single
confident figure that overclaims from thin data.

## Why an adaptive window, not an all-time average

The naive estimate — average performance over every puzzle ever solved — **hides
improvement**. The user's own scenario: 200 puzzles solved around the 1700 band (the classic
1700 stagnation), then a run of 30 at the 1850 band as they break out. An all-time average
reports ~1710 and buries the breakout under six months of old evidence. The estimate must
**follow the breakout** while the ± **communicates that the breakout is still lightly
evidenced**. That is the whole design tension this spec resolves: track recent ability fast,
but never pretend to a precision the sample doesn't support.

## What exists today (code audit, 2026-07-15)

- **Puzzle results store** — `apps/desktop/lib/puzzle-results.ts`. Every graded answer is
  appended to a localStorage attempt log (`chessgui:puzzle-results`). Each
  `PuzzleResultEntry` carries `at` (ISO datetime), `band` (`string | null`, e.g. `"1900"`),
  `kind` (`"rake" | "calm"`), `correct` (boolean), `verdict`, and a stable `key`. Everything
  else (per-band record, respawns) is **derived** from the log — one source of truth. Today
  the only aggregate is `bandRecords()`: solved/attempted per band, all-time + a 7-day recent
  window. **There is no Elo estimate anywhere.**
- **Puzzle difficulty axis** — the puzzle's difficulty is its **band** (mover Elo band from
  the source game, `"1900"`…`"2500"`), on `PuzzleRow.band` (`packages/core/src/puzzle-types.ts`,
  mirrored in `src-tauri/src/puzzles.rs`). The band string **is** the per-puzzle rating this
  spec consumes. A finer per-puzzle difficulty exists in `band_miss_rates` (per-band miss rate
  JSON) but is not required for v1 — recorded as a Tier-2 refinement below.
- **The Learn surface** — `apps/desktop/app/page.tsx` (`learnSub` state) mounts four Learn
  sub-tabs: `calibrate`, `spar`, `puzzles` (avoidance, spec:211), `training` (spec:215). The
  avoidance setup screen (`packages/ui/src/puzzles-tab.tsx`) already renders the per-band
  record. The **"Unfinished Session"** the user names is the resume-session card pattern
  (`packages/ui/src/calibration-tab.tsx:212` offers to resume an unfinished session; the
  puzzles tab has the same resume seam) — the Elo line renders alongside it.
- **Existing logistic / Elo helpers to reuse** (do not reinvent the curve):
  - `apps/desktop/lib/training-projection.ts:137` — `expectedScoreElo(diff) = 1/(1+10^(−diff/400))`,
    the standard Elo expected-score curve, already stated as the house assumption.
  - `apps/desktop/lib/explorer-stats.ts:32` — `eloDifferenceForScore(p) = −400·log10(1/p−1)`,
    clamped ±800: the single-shot FIDE performance-rating inversion. This spec generalizes it
    to per-puzzle ratings with recency weights.
  - `packages/core/src/tournament.ts:1514-1573` — a Bradley–Terry / Elo-logistic rating fit
    (`k = ln10/400`) already living in core: precedent that MLE rating estimation belongs in
    `@chessgui/core`.
  - `packages/core/src/win-prob.ts` — the house style for a pure-core estimator with
    provenance-flagged fallbacks (source: `map` / `logistic-fit` / `logistic-default`); the new
    estimator follows the same "state the model, flag every fallback" convention.

## How — the estimator (approach, decided)

A **pure function in `packages/core`** that consumes the puzzle attempt log and returns
`{ elo, sigma, n, ess, status }`. Model and window are fixed as follows.

### Model — maximum-likelihood performance rating

Each attempt `i` in the window has a puzzle rating `rᵢ` (numeric band) and an outcome
`xᵢ ∈ {0,1}` (`correct`). Under the Elo expected-score curve, ability `θ` predicts

```
pᵢ(θ) = 1 / (1 + 10^(−(θ − rᵢ)/400))      (= expectedScoreElo(θ − rᵢ))
```

The estimate `θ̂` is the recency-weighted MLE — the `θ` maximizing the weighted
log-likelihood, i.e. the root of the weighted score equation

```
Σ wᵢ · (xᵢ − pᵢ(θ)) = 0
```

which is monotone in `θ` and solved by bisection (or Newton) over a bounded Elo range. This
is exactly the FIDE performance rating (`explorer-stats.ts` `eloDifferenceForScore`)
generalized to **per-puzzle** ratings with **weights**; a uniform-weight, single-opponent-
rating special case reproduces the FIDE dp formula.

### Recency weighting

Inside the window, weight the k-th-newest attempt with an **exponential decay** whose
half-life ≈ the window size `N`:

```
wₖ = 0.5^(k / N)        (k = 0 for the newest)
```

Newest results dominate, old results fade smoothly (no hard cliff at the window edge). This
is what lets the estimate follow a breakout: as 1850-band solves accumulate, the down-weighted
1700-band history stops holding the number down.

### Adaptive window size

`N` = the **smallest** count of the most-recent (band-carrying) attempts whose resulting
standard error `σ(θ̂)` ≤ a target of **~180 Elo**, plus a small **buffer of ~5** attempts, capped
by available data. Small `N` when recent data is decisive; larger `N` when the signal is
noisy and more history is needed to pin the number down.

### Uncertainty — the ± is driven by effective sample size

Report `σ` from the **weighted Fisher information** of the fit, in **sandwich (robust) form**
so recency down-weighting genuinely widens the band rather than being ignored:

```
J = (ln10/400)² · Σ wᵢ   · pᵢ(1−pᵢ)
V = (ln10/400)² · Σ wᵢ²  · pᵢ(1−pᵢ)
Var(θ̂) ≈ V / J²          →   σ = √Var,   band = 1.96·σ   (95%)
```

Effective sample size `ESS = (Σwᵢ)² / Σwᵢ²` is the honest "how many puzzles is this really
worth" figure; a heavily recency-weighted window has a smaller ESS and therefore a wider ±.

### Category handling — what may and may not be pooled

- **Bands are the rating axis, not separate skills.** The MLE consumes each puzzle's band as
  its rating `rᵢ`, so **combining across bands is correct and required** — that is the whole
  point of a performance rating. What the estimator must **never** do is average solve-rate
  across bands (which would conflate difficulty with ability). Recorded as a Done-When
  invariant.
- **`kind` (rake vs calm) is one pool.** The estimate runs over the union of `rake` and `calm`
  attempts as a single **avoidance Elo**, because they share one results log and one session
  flow, and the store already frames calm positions as self-made rakes
  (`puzzle-results.ts` header). A future per-theme/per-kind breakdown is a parameterization,
  not a rewrite.
- **Null-band attempts are excluded** — an attempt with no `band` has no puzzle rating to
  score against, so it does not feed the estimate (it still counts in `bandRecords`).

## Behavior properties (the design's acceptance criteria)

- **Breakout converges within ~2 sessions.** A synthetic sequence of 200 solves at 1700 then
  30 at 1850 moves the estimate decisively toward ~1850 within roughly two sessions' worth of
  new attempts — not the ~1710 an all-time average reports.
- **Stagnation: flat mean, tightening ±.** A long run at one level keeps the estimate flat
  while the ± shrinks as ESS grows.
- **Sparse data refuses to guess.** Below a **minimum window of ~15** band-carrying attempts,
  show no number — render `Elo —, need N more puzzles` instead.

## UI

- On the **Learn** surface, immediately after the "Unfinished Session" / resume-session card,
  render exactly:

  ```
  Unfinished Session: Elo <e> ± <u>
  ```

  where `<e>` is the rounded estimate and `<u>` the rounded 95% half-band (e.g.
  `Elo 1238 ± 250`).
- Below the minimum window: `Unfinished Session: Elo —, need <N> more puzzles`.
- The same estimate may also appear wherever the Learn surface already summarizes progress
  (e.g. the avoidance setup screen's stats row, alongside `bandRecords`) — same core value,
  read once.

## Implementation seam

- **Estimator** — a pure module in `packages/core` (sits beside `win-prob.ts` / `time-elo.ts`),
  with **unit tests** over synthetic attempt sequences: breakout, stagnation, and sparse-data.
  No React, no storage, no I/O — takes the attempt array (or a minimal `{at, band, correct}`
  projection) and returns `{ elo, sigma, n, ess, status }`.
- **UI wiring** — the Learn/training component reads the puzzle-results store
  (`loadPuzzleResults()`), passes the log to the estimator, and renders the line.

## Non-goals (this spec)

- Persisting the estimate — it is derived on the fly from the attempt log, like every other
  puzzle-results aggregate. No new storage key.
- Per-band or per-theme sub-ratings, and the `band_miss_rates`-based finer difficulty
  (Tier-2 refinements, below).
- Reconciling the avoidance Elo with the calibration Elo (spec:213) or the Maia-rapid metric
  (spec:215) — they measure different skills and stay separate surfaces.

## Checklist

Agent-verifiable:

- [x] (code-verified 2026-07-16) Pure MLE performance-rating estimator in `packages/core` — recency-weighted logistic
      (spec:211 store as input), reusing the Elo expected-score curve
      (`expectedScoreElo`, house form `1/(1+10^(−diff/400))`).
- [x] (code-verified 2026-07-16) Adaptive window: smallest recent-N with σ ≤ ~180 Elo + ~5 buffer, capped by data; ±
      from the sandwich weighted-Fisher variance (95% band); ESS computed and exposed.
- [x] (code-verified 2026-07-16) Minimum-window guard (~15 band-carrying attempts) returns a `need N more` status
      instead of a number.
- [x] (code-verified 2026-07-16) Invariant: the estimate is a per-puzzle-rating MLE, never a solve-rate averaged across
      bands; null-band attempts excluded; rake+calm pooled as one avoidance Elo.
- [x] (code-verified 2026-07-16) Unit tests over synthetic sequences: breakout (200@1700 → 30@1850) converges toward
      ~1850 within ~2 sessions; stagnation holds the mean flat with a shrinking ±; sparse
      data (<15) returns the guard status.
- [x] (code-verified 2026-07-16: puzzles-tab.tsx renders `eloEstimateLine(estimateElo(entries))`) Learn UI renders `Unfinished Session: Elo <e> ± <u>` (and the `need N more` fallback)
      from the store via the estimator — value present in the DOM at the specified placement.

User-blocked (needs the user's eye):

- [ ] User confirms the placement is right — the line sits where they expect it after the
      "Unfinished Session" card.
- [ ] User eyeballs the number on their real attempt history and agrees it "feels right"
      (tracks their sense of current strength, and the ± reads as honest).

### Later / uncaptured requirements (audit 2026-07-16)

Tier-2 refinements — the spec prose says these are "recorded below" but no
checklist section existed for them:
- [ ] Finer per-puzzle difficulty from `band_miss_rates`, replacing the
      band-string proxy rating. (224:38-41,173-175)
- [ ] Per-kind/per-theme sub-ratings (rake vs calm, or finer themes), as a
      parameterization of the existing pooled estimator, not a rewrite.
      (224:38-41,173-175)
