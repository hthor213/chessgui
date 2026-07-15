# 216: Machine Speed Profile & Time-Compression Elo Model

**Status:** draft
**Depends on:** 210 (engine lab runs the calibration ladder), 011 (UCI plumbing)
**Feeds:** 214 (persona matches at honest strength labels), 210 (watchable tournaments),
Play-vs-engine pacing

## Goal

Answer "how strong is the engine *actually* playing, on *this* machine, at *this*
speed?" — and let the user pick a time format and a playback pace as two independent
knobs. No engine crippling: we **characterize** the machine instead. The output is a
per-machine **speed-up Elo equivalence**: compressing a time control by factor C costs
a known (measured, nonlinear) number of Elo for search engines — and exactly zero for
policy personas (Maia/BT3-policy), whose strength is time-invariant.

## The model

- Strength is a function of **compute per move** (nodes ≈ nps × seconds), not
  wall-clock. `Elo(t) ≈ a + b·log₂(t)`: near-linear in log-time, so the nonlinearity
  the user sensed lives in `b` (Elo per doubling, ~50–100 for SF-class engines,
  shrinking at longer controls).
- **Machine profile**: run engine bench once (per engine) → nps. Stored locally
  (`machine_profile.json`): hostname, engine, nps, threads, hash, date. A 4× nps gap
  between machines ≈ 2 doublings ≈ 2b Elo at equal wall-clock. Profiles are
  per-machine by construction (laptop and homeserver each get their own).
- **Curve source, two stages**: ship with literature priors (b ≈ 70, flagged as
  PRIOR in the UI); a background **time-odds ladder** in the engine lab (SF vs SF at
  1×/2×/4×/8×/16× budgets, N games per rung) measures `b(t)` on this machine and
  overwrites the prior (flagged MEASURED once ≥2 rungs have CI excluding zero).
- **Pacing ≠ strength.** Playback pace is theater. For policy personas the engine
  answers in milliseconds and the pacing delay is free. For search engines, pace
  below the compute budget is impossible; pace above it is free delay.

## UI

1. **Pick time format first** (40/2.5h+16/hr classical, 25+10, 3+2, …) — defines the
   simulated clocks shown on screen and the narrative.
2. **Pacing slider** ("play back at ___"): floor = 1.25× measured minimum
   (user-move/window-drag buffer) and an observability floor in watch mode; ceiling =
   real time.
3. **Live Elo readout on the slider**: search engines → "≈ face value − N Elo at this
   pace" from the curve; personas → "no strength change (policy persona)".
4. Same slider in **Play vs engine**: user's clock is real, engine's is virtual.
   Recommended default depends on format, matching how humans use opponent time:
   blitz → engine visibly "thinks" so the user can think; classical → just enough
   delay to think on the opponent's time, never 30 real minutes.

## Tiers

- **Tier 0**: machine profile (bench command + storage), prior curve in
  `lib/time-elo.ts` (curve, compression→ΔElo, PRIOR/MEASURED flag), pacing slider +
  Elo readout in Tournament watch mode and Play vs engine.
- **Tier 1**: time-odds ladder runner in the engine lab (background /loop), measured
  `b(t)` persisted into the machine profile, UI flips PRIOR→MEASURED, per-rung CI
  shown in the lab.
- **Tier 2**: cross-machine equivalence (laptop↔homeserver profiles → "server at 60s
  ≈ laptop at 22s"), per-engine curves (Reckless vs SF), auto re-bench on hardware
  change detection.

## Non-goals

- Weakening engines by throttling nps or injecting noise (Turing-test evidence says
  never — see docs/research mistake-mining survey).
- Cloud benchmark databases; profiles are local facts about local machines.

## Checklist

### Tier 0 — SHIPPED 2026-07-15 (b5c403c, c19ae57, 1666b6b)
- [x] `machine_profile`: bench invocation + nps capture + JSON storage
- [x] `lib/time-elo.ts`: prior curve, ΔElo(compression), PRIOR/MEASURED flag, tests (22)
- [x] Tournament watch: format picker + pacing slider + Elo readout
- [x] Play vs engine: pacing slider (default 20s/move = legacy clock exactly)
- [x] Floors: 1.25× compute buffer + watch-mode observability floor (machine-min
      is a 0.05s placeholder until the ladder measures it)

### Tier 1
- [x] Time-odds ladder runner (engine lab, resumable rungs) — smoke-verified
      +89 Elo/doubling at the 62ms rung, 20 games
- [ ] `b(t)` fit + CI, persisted to machine profile
- [ ] UI flips to MEASURED with rung count
