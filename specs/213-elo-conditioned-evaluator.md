# 213: Elo-Conditioned Position Evaluator ("Human Eval")

**Status:** draft (design + feasibility; see `docs/research/elo-conditioned-eval-design.md`
for the technical design and validation plan)
**Depends on:** 011 (engine communication), 210 (neutral-evaluator infrastructure +
eval→win-prob machinery), the mining corpus (validation only, not runtime); informed by
`docs/research/mistake-mining-prior-art.md`.

## Goal

Chess today has two scoring systems: (a) the classical piece count in pawns, and (b) the
Stockfish eval — plus an unofficial third, the qualified commentator, who nowadays mostly
reads Stockfish anyway. Stockfish's problem: it may find an obscure move 12 plies out that
flips everything, through "non-human" moves — the "nobody would play that" moment (Magnus,
GothamChess). Its +4 is true for Stockfish and false for almost every human in the room.

This spec adds the third scoring system done right: an evaluator where you **set the Elo**.
Stockfish says +4, material says +1 — but the 1900-rated evaluator says **+1.2**, because a
1900 doesn't see the obscure resource. Slide to 2100 → +1.3. At 2650 the player sees the
idea and it jumps to **+3.1**. A true human eval, grounded in the insight and psychology of
real players at that level — not a weakened engine (weakened Stockfish is empirically
detectable as fake; see prior-art survey, Eisma et al. 2024).

The number is defined, not vibed: **Eval_R is what the position is worth when only the
moves that rating-R humans actually consider exist on the board.** The engine that knows
which moves those are is Maia (per-band human move models, U. Toronto); the engine that
scores the resulting human-visible tree is Stockfish. Full definition candidates, the
recommendation, and the validation program live in the design doc.

## What the User Sees

### Rating slider
A slider in the analysis panel, 200-Elo stops: 1100 · 1300 · 1500 · 1700 · 1900 ·
2100 · 2300 · 2500 · 2700. Stops 1100–1900 are native (Maia-1 bands); 2100+ are marked
**experimental** until the high-band model path is validated (biggest honest limitation —
see design doc §Risks). The slider ends conceptually at "∞ = Stockfish".

### Three evals side by side
Next to the existing Stockfish eval the analysis panel shows:

```
Material   +1.0
Human@1900 +1.2        ← moves with the slider
Stockfish  +4.0
```

The eval bar gains small tick marks for the three values so divergence is visible at a
glance. Perspective is always White-POV, same as every other eval in the app.

### The perception curve (flagship visual)
A mini-chart: X = rating (1100→2700→∞), Y = Eval_R for the current position. Flat at +1.2
through 2300, then a jump to +3.1 near 2500 — *the rating at which the idea becomes
visible*, readable at a glance. This is the one image that explains the feature in a
screenshot. Non-monotonic jumps are the product, not a bug.

### Tournament lab integration
The tournament's neutral evaluator (spec 210 Phase 7 — a third engine scoring every
position off the live stream without touching player clocks) is the natural host: an
optional "human evaluator" pass runs Eval_R alongside the Stockfish pass. Spec 212's error
report then labels decisive mistakes with **"visible from ~2100"** — the rating at which
the refutation enters human sight — a strictly stronger statement than "blunder".

## Delivery Tiers

| Tier | What ships | Latency | Gate |
|------|-----------|---------|------|
| **0 — Instant blend** | Single Maia-R forward pass: how much policy mass does rating R put on Stockfish's line? Blend SF eval toward a no-resource baseline accordingly. Slider is fully live. | ~15 ms/stop | lc0 + Maia weights present |
| **1 — Human-visible tree** | Restricted search: each node's candidates = top-p mass of the Maia-R policy, leaves scored by Stockfish. Produces the real +1.2 → +3.1 jump semantics. Progressive display (tier-0 instantly, tier-1 refines in). | 1–4 s/stop, background sweep for the curve | tier 0 |
| **2 — Validated calibration** | Eval_R calibrated to win-prob on the mining corpus (killer experiment E1 in the design doc); perception curve annotated with confidence; tournament/212 integration. | — | mining corpus |
| **3 — High bands + asymmetry** | Maia-2/Maia-3 path for 2100–2700; optional two sliders (R_white ≠ R_black). | — | tier 2 results |

## Runtime Dependencies

- **lc0** as the Maia inference body, spoken to over UCI exactly like every other engine in
  this app (`uci.rs` patterns). Feasibility verified on this machine 2026-07-13: brew lc0
  0.31.2 loads `maia-1500.pb.gz` on the Metal backend (M2 Max); `VerboseMoveStats` +
  `go nodes 1` returns the full root policy; warm query = **13 ms**.
- **Maia-1 weights** — nine ~1.2 MB nets (1100–1900), GPL-3.0 (compatible; chessgui is
  GPL-3.0), fetched on first use from the CSSLab GitHub release (verified reachable) and
  cached under the app's engines directory. Not bundled in the .dmg.
- **Stockfish** — already a dependency; scores leaves and provides the reference eval.
- No Python, no ONNX runtime, no new inference framework for tiers 0–1.

## Non-goals (this spec)

- A human-like *playing* bot (that's the Phase 9 / spec 211 territory; this is an
  *evaluator*).
- Personalized eval ("what does *this* player see") — Maia4All path, later.
- Move recommendations or training advice derived from Eval_R.
- Perfect fidelity above 2000 Elo at tier 1 — the slider is honest about its experimental
  range rather than pretending.
- Building or hosting model training — runtime is inference-only.

## Checklist

### Phase 1 — Inference plumbing
- [ ] `maia.rs`: lc0 process management (spawn with `--weights`, warm pool with LRU over
      bands), `VerboseMoveStats` policy parsing, `(fen, R) → Vec<(move, prob)>` API
- [ ] Weight fetcher: download + checksum + cache Maia-1 nets on first use; graceful
      "install lc0" hint when lc0 missing (brew formula exists)
- [ ] Unit test: startpos policy sums to ~1.0, known top move per band

### Phase 2 — Tier 0 + slider UI
- [ ] Instant blend evaluator (single forward pass; formula in design doc §Performance)
- [ ] Rating slider + Human@R line in the analysis panel; eval-bar tick marks
- [ ] Slider stop changes re-query within one frame budget (target < 50 ms warm)

### Phase 3 — Tier 1 human-visible tree
- [ ] Restricted expectimax/minimax search: top-p candidate sets, Stockfish leaf scoring,
      node cap, transposition cache keyed `(fen, R)`
- [ ] Progressive refinement: tier-0 value shown immediately, tier-1 replaces it
- [ ] Background sweep across all slider stops → perception curve chart
- [ ] Unit tests on synthetic policies (resource in/out of candidate set flips the eval)

### Phase 4 — Lab integration & validation
- [ ] Optional Eval_R pass in the tournament neutral evaluator (per-game, off the live
      stream, players' clocks untouched)
- [ ] 212 error report: "visible from ~R" label on decisive mistakes
- [ ] Killer experiment E1 (outcome prediction vs Stockfish eval on held-out R-vs-R
      corpus games) run and written up; tier-1 hyperparameters (p, depth, caps) frozen
      from E5 ablations
- [ ] Spec review with user after tier-1 + E1 results
