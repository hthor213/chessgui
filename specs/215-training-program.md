# 215: Training Program — the curriculum engine

**Status:** draft
**Depends on:** 213 (calibration/Learn), 214 (spar/persona), 211 (rake decks, when mined), 212 (win-prob)
**Realizes:** vision modules 8 (Tactics Training) + 9 (Game Review) as a guided program

## Goal

The training plan lives IN the app, not in a markdown file: a **program** with
**chapters** (phases with objectives and exit criteria), **exercises** (daily blocks that
launch real app features), **progress tracking** (check-offs + measured metrics), and
**milestones**. The user's program: **Road to 1900 FIDE**, first milestone the December
2026 rival match ("Florida"). The ultimate goal outlives the milestone.

## Design

### Program model (data-driven, JSON)
- `Program { name, goal, milestones[], chapters[] }`
- `Chapter { title, window (dates), objectives[], exercise_mix (per-week counts by type),
  exit_criteria[] (MEASURED: e.g. "maia_rapid >= 1350", "eg_conversion >= 0.50",
  "flag_rate < 0.10", "calib_mae_level < 0.7"), unlocks }`
- `Exercise types` (enum, extensible): `calibration_session` (launch Learn v3 deck),
  `spar_rival` (launch Spar vs rival at level), `endgame_playout` (play-it-out from a
  conversion/endgame position), `rake_deck` (spec:211, when mined), `anti_line_drill`
  (play the prepared line vs persona book), `long_game_review` (import + engine-LAST
  review discipline), `rest` (explicitly scheduled — protects the rating signal).
- The GENERIC program ships with the app (bundled JSON, "Road to 1900"). PRIVATE
  overlays (rival names, match dates, personal notes) merge from a local file in app
  data / data/rivals — never bundled, never committed.

### Training tab UI
- **Today**: the day's blocks from the current chapter's weekly template; each block is
  a launch button into the real feature + a check-off; skipped is fine (life happens),
  streaks are gentle not guilt-driven.
- **Program view**: chapters as a timeline with objectives, exit criteria as live
  gauges (measured values vs targets), current chapter highlighted.
- **Measurement panel**: the monthly needle — Maia estimate (rapid, from the
  self-analysis pipeline), endgame conversion %, flag net, calibration MAE by band,
  spar score vs rival level. Manual "run monthly measurement" button at first
  (invokes the fetch+estimate scripts); automation later.
- **Milestone card**: days remaining, gap to target, honest trajectory line
  (win-prob framing from 212: "at current pace: X wins in 10 expected").

### Measurement plumbing
- Metrics land in a local `training_metrics.json` (append-only, dated points).
- Sources: calibration sessions (already persisted), spar results (persist per game),
  Maia estimate (scripts/persona pipeline; manual trigger first), flag/EG stats
  (re-run of the self-analysis on a fresh archive fetch).

### Honest-by-design rules
- Exit criteria are measured, never vibes; a chapter that misses criteria says so and
  extends rather than silently advancing.
- No fake gamification inflation: scores are the real numbers from real games.
- The program is editable: chapters/exercise mixes are data, and the coach dialogue's
  lessons should feed manual adjustments (later: suggested adjustments).

## Tiers
- **Tier 0 (first build — SHIPPED 2026-07-15, c8cbdea)**: Training tab with bundled Road-to-1900 program + local
  overlay; Today view with launch/check-off for the exercise types that EXIST
  (calibration_session, spar_rival, long_game_review as external check-off); chapter
  timeline; manual metrics entry + the baseline row; milestone card with countdown.
- **Tier 1**: endgame_playout exercise (needs 211 play-it-out), rake_deck (needs corpus
  tier-1), spar results persistence feeding the measurement panel automatically.
  Persistence MUST carry declared intent: "counts toward training" toggle at game
  start (default ON from Training-tab launches, ask on ad-hoc Learn-tab launches)
  + save-as serious/test at game end; pace/eval anomaly detection may flag a game
  for reclassification but never silently excludes (2026-07-15, from first live
  spar: user's probe games must not pollute the rating signal).
  - *Progress 2026-07-15 — spar results persistence BUILT*: completed games
    auto-record at game end (lib/spar-results + hooks/use-spar-results, one hook
    call in spar-tab); serious counts by default, probe stored flagged and never
    counts; anomaly flags (short game / early resign — length proxies until the
    spar loop has clocks) shown next to the score, never excluded; per-game
    "counts" reclassification lives in the Training tab's Spar games card.
    DEVIATION: the game-START intent toggle is currently the existing
    Serious/Probe mode picker (intent by mode) — a dedicated per-game toggle on
    the spar config screen remains open (spar-tab owned by parallel work).
    endgame_playout + rake_deck still blocked on 211/corpus.
- **Tier 2**: monthly measurement automation (fetch + Maia estimate from the app),
  trajectory projection via 212 win-prob, coach-suggested program adjustments.
  - *Progress 2026-07-15 — measurement automation BUILT (script + import, the
    smaller honest step)*: the self-report pipeline was rescued from scratchpad
    into scripts/self_report/ (engage → analyze → maia → stats, logic
    byte-identical, parameterized) with scripts/measure_monthly.py orchestrating
    fetch → metrics → data/rivals/training_metrics.json; the Training tab's
    Measurements panel imports that file (idempotent merge keyed by (at, metric))
    and refreshes spar_score fully in-app from the stored spar games. NOT an
    in-app spawn: the run is minutes of lc0 + network — a silent button would be
    dishonest UX; revisit when there's a progress surface. Verified: profile-only
    run reproduces the report baselines (flag_net −85, eg_conversion 0.431).
  - *Progress 2026-07-15 — trajectory projection BUILT*: lib/training-projection
    (least-squares trend over dated points, ≥2 required; Elo expected-score
    framing "X/10 expected", model stated in the copy) renders on the Today view
    as measured line + dashed projection + target hairline, labeled "a
    projection, not a promise". Note: 212's win-prob curve maps engine EVALS, not
    rating gaps — the Elo logistic is used instead and said so in code comments.
    Coach-suggested adjustments still open.

## Cultural context

Why the December match matters beyond the scoreboard:
docs/research/iceland-chess-culture.md (the 1972 Reykjavik inheritance).

## Non-goals
- Cloud sync, social features, coach-marketplace anything.
- Motivational-app theatrics. The user is an adult with a bet to win.

## Content: Road to 1900 (v1, from data/rivals/TRAINING_PLAN.md)
Chapters 1–3 = Operation Florida phases (rakes+clock / conversion / rival taper) with
their measured exit criteria; Milestone: Florida match (Dec 2026, protocol notes in the
private overlay). Chapters 4+ (post-milestone, to 1900 FIDE): drafted after Florida
with the same measurement discipline — the engine doesn't assume the journey ends at
the first boss.
