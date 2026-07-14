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

Two psychological pillars make this a *human* eval rather than an engine blend (design
doc §5 — measured on the mining corpus, they become the tree's tuning coefficients):

1. **Attention — the confusing knight.** Ten pieces battle on one flank; one objectively
   inert piece sits far away. Stockfish calculates through it instantly; a human's
   move-finding degrades — the bystander consumes attention just by existing. With
   4.8×10^44 positions you can't tabulate perception; you measure the *law*
   (matched-pair mining: same local battleground ± distant inert material, dose-response
   by bystander count/type/distance) and let it narrow the candidate set under
   perceptual load.
2. **Story-arch — chess is a REST API, humans are not.** Identical position, identical
   best move — but the player who just lost a piece a move ago is in "crap, I need to
   fix it" mode and plays it differently. Same-position-different-history pairs (a
   query, thanks to the existing Zobrist position index) yield the post-blunder
   degradation curve per band; recent eval swing and clock become state modifiers. One
   consequence: the full Eval_R wants the *game*, not just the FEN — a bare pasted
   position falls back to position-only mode, and the UI says which mode it's showing.

And one structural correction to the rating axis itself: **skill is a phase vector, not
a scalar** (design doc §1.5). The user's framing: "I'm a 1200 — that just means vs
another 1200 we score evenly. It says nothing about each stage: I don't know openings,
my middlegame might be 1350, and I mess up endgames — 'can I get piece X to place Y in
time' and I move it to the wrong spot." The general conditioning variable is
R⃗ = (R_opening, R_middlegame, R_endgame); the scalar slider is the linked special case.
The evaluator picks the band by the phase *at each node*, so a middlegame line that
trades down gets its endgame leaves evaluated with the endgame skill — "good for you
*if* you can play the resulting endgame" becomes computable. The endgame example is also
its own error family — counting/tempo arithmetic, distinct from perceptual load (design
doc §5.3). This applies to the user-as-baseline too: calibration sessions already record
phase per position, so their datapoint is phase-resolved from the start.

## What the User Sees

### Rating slider
A slider in the analysis panel, 200-Elo stops: 1100 · 1300 · 1500 · 1700 · 1900 ·
2100 · 2300 · 2500 · 2700. Stops 1100–1900 are native (Maia-1 bands); 2100+ are marked
**experimental** until the high-band model path is validated (biggest honest limitation —
see design doc §Risks). The slider ends conceptually at "∞ = Stockfish".

By default the one slider sets all three phase ratings linked. An advanced **"unlock
phases"** control splits it into three sliders — opening / middlegame / endgame — for
profiles like (1200, 1350, 1100). Ships only after the phase-swap approximation passes
its corpus test (E6, design doc §1.5/§4).

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
The tournament's neutral evaluator (spec:210 Phase 7 — a third engine scoring every
position off the live stream without touching player clocks) is the natural host: an
optional "human evaluator" pass runs Eval_R alongside the Stockfish pass. Spec 212's error
report then labels decisive mistakes with **"visible from ~2100"** — the rating at which
the refutation enters human sight — a strictly stronger statement than "blunder".

## Delivery Tiers

| Tier | What ships | Latency | Gate |
|------|-----------|---------|------|
| **0 — Instant blend** | Single Maia-R forward pass: how much policy mass does rating R put on Stockfish's line? Blend SF eval toward a no-resource baseline accordingly. Slider is fully live. | ~15 ms/stop | lc0 + Maia weights present |
| **1 — Human-visible tree** | Restricted search: each node's candidates = top-p mass of the Maia-R policy, leaves scored by Stockfish. Produces the real +1.2 → +3.1 jump semantics. Progressive display (tier-0 instantly, tier-1 refines in). | 1–4 s/stop, background sweep for the curve | tier 0 |
| **2 — Validated calibration + psychology coefficients** | Eval_R calibrated to win-prob on the mining corpus (killer experiment E1 in the design doc); perceptual-load (E-attention) and history/state (E-history) coefficients modulate candidate breadth per node; perception curve annotated with confidence; tournament/212 integration. | — | mining corpus |
| **3 — High bands, asymmetry & phase unlock** | Maia-2/Maia-3 path for 2100–2700; optional two sliders (R_white ≠ R_black); "unlock phases" mode (R⃗ per phase, per-node conditioning already built in tier 1). | — | tier 2 results; E6 for phase unlock |

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

- A human-like *playing* bot (that's the Phase 9 / spec:211 territory; this is an
  *evaluator*).
- Personalized eval ("what does *this* player see") — Maia4All path, later.
- Move recommendations or training advice derived from Eval_R.
- Perfect fidelity above 2000 Elo at tier 1 — the slider is honest about its experimental
  range rather than pretending.
- Building or hosting model training — runtime is inference-only.

## Checklist

### Phase 0 — Human ground-truth collection (Eval Calibration)
The design's validation program (§4/§5) needs real human evals at a known level to
compare against Stockfish. The **Eval Calibration** feature (Learn view) collects them:
show a stratified set of positions, elicit the user's perceived eval + reasoning +
optional move, and score them against Stockfish. Files are the research artifact.
- [x] `calibration.rs` sampler: stratified (|SF eval| band × phase) random positions
      from the games DB, ply ≥ 16, check-excluded, capture-window-excluded, Zobrist-
      deduped; scored by local Stockfish (500 ms, MultiPV 2). `calibration_sample` /
      `calibration_save_results` commands; JSON artifacts under `app_data_dir/calibration`.
      Schema in `docs/research/calibration-data-format.md`. Real-DB smoke (n=20): 48 s
      (~2.4 s/pos), fills the eval bands.
- [x] Learn UI (`components/calibration-tab.tsx`): intro → per-position (White-bottom
      board, eval input, why, optional move) → results (user-vs-SF scatter, Pearson,
      MAE, per-band + per-phase tables, best-move hit rate, biggest misses → analyze
      board); incremental localStorage persistence + unfinished-session resume. Verified
      headless.
- [x] **Sampler v2 — known-Elo game context:** samples only Elo-known games (95.4% of
      the 955k corpus: 911,585 games have both Elos), one position per game (design-doc
      §4 one-per-game), stratified across four Elo bands **and** four `|SF eval|` bands.
      Each position carries `white_elo`/`black_elo`/`played_*`/`continuation_san`,
      making every answer triple-labelled (SF eval · user eval · what a rated human
      played). Schema versioned (v2; v1 stays readable). Real-DB n=20 smoke: Elo bands
      balanced 5/5/5/5, eval bands span incl. `3+`, ~3.7 s/pos.
- [x] **Endgame coverage** (was the honest gap): resolved by v2 sampling games directly
      at a random ply instead of via the ply-40 position index — endgames now appear
      (7/20 in the smoke). Deeper still (very long games) remains bounded by nothing but
      game length.
- [x] **Elicitation UX:** post-answer reveal (SF eval/best/margin + played move; answer
      structurally locked first — `answer_locked_at`) with a blind-mode option; optional
      **second look** revision before feedback (self-correction = a per-band skill
      signature); **think_ms** (shown→first-interaction) + a "don't count my time" toggle,
      median reported. All recorded per the data-format doc.
- [x] **AI coach (opus) — reasoning critic + cause-tag labeler** (`coach.rs`): reads the
      user's *written* reasoning on the reveal and diagnoses the gap vs the engine
      evidence (grounded only in the provided SF line + game continuation, never invents
      variations); returns a coach note + structured `{cause_tags, reasoning_quality,
      scale_error}` from a fixed 10-tag vocabulary — the taxonomy's first machine labeler.
      Async (never blocks), graceful without a key, `show_coach` setting recorded. Live
      smoke on the e7-exchange miscount correctly tagged `miscounted_exchange` +
      `overlooked_defender` + `scale_miscalibration`.
- [ ] Collect a real self-rated session (user is the ~1300/1650-puzzle datapoint) and
      fold it into the E1 corpus once the evaluator exists.
- [ ] **Adaptive elicitation** (design doc §6): active learning FOR THE MODEL — "we use
      the human to make human mistakes; what data do you need more of." Phase A: brief
      profile lock-in (~10–20 positions) so labels read as a known-level human's
      perception — the profile display stays as a fun by-product. Phase B: every next
      position chosen by model need — evaluator-variant disagreement (computable today
      by running the evaluator at multiple settings and ranking spread), corpus-coverage
      sparsity, §5-coefficient starvation; the why-text is the label's provenance.
      On-demand sampling ~2.4–3.7 s/pos measured, prefetch while the user thinks. No
      completion state: a diminishing-returns readout ("counting data saturated;
      long-range threats are the bottleneck") and the session budget spends itself on
      the scarcest data.

- [ ] Single-labeler scope (2026-07-14): the user can only generate authentic perception
      data at their own band — expertise can't be simulated in either direction. Division of
      labor: the corpus is the multi-Elo labeler (moves + outcomes at every band); the user
      supplies the inside of the error (stated evals, reasoning text, cause tags) at one
      band — instrument calibration, not population sampling. Their unique asset is
      longitudinal: if they climb 1300→1900 inside the system, which error classes dissolve
      first (scale calibration vs template-blindness vs rake-stepping) is data no
      cross-sectional corpus contains. Preserve session history accordingly; never discard
      old sessions on schema upgrades.
- [ ] Sampler v3 — stratify by training value, not engine-pawn bands (from calibration
      session 2026-07-14): for a 1300 aiming at 1900, +0.3 vs +0.9 in a middlegame is
      immaterial — the win-prob curve at that level is flat there (212's curve quantifies
      this) — EXCEPT with a material imbalance, where conversion is mechanical and the curve
      is steep. Engine-pawn bands measure the perception curve (user-as-labeler purpose);
      training the user wants a different axis: sample where outcomes at the student's band
      actually diverge. Two purposes, two samplers; the session records its sampler version
      so the data streams stay separable.

      **v3 design (decided 2026-07-14).** SESSION_VERSION 3. Four decks with quotas per
      100 (still interleaved across elo bands like v2):
      - `conversion` 30: |eval| in [0.75, 3.5] AND (|material| ≥ 2 or a minor-piece
        imbalance), advantage on the material side — "you're better and it's the
        convertible kind"; per the user's standing report this is where sub-2000 rating
        points live.
      - `critical` 25: multipv_gap_cp ≥ 100 — the move genuinely matters (proto-rake;
        real rake decks arrive with spec 211 tier-1).
      - `endgame` 25: existing phase detection — the v1 hole (2/100).
      - `level` 20: |eval| < 0.5 middlegames — kept deliberately small but present:
        the user's worst band (MAE 1.01 vs 0.50) is imagined advantage in equal
        positions, so it stays as targeted training, not filler.
      Overlap priority: endgame > conversion > critical > level; a candidate fills the
      first matching deck with an unmet quota. Each position stores its `deck` (shown as
      a chip in the reveal + results grouping). PV plumbing ships with v3: capture up to
      6 plies of PV1 as SAN (`sf_pv_san`) during the scoring pass, pass it in CoachInput,
      and let the coach cite the line (the no-inventing rule stays; the "admit when the
      justification is outside your data" guard now only applies when no PV is present).
- [ ] PV plumbing for the coach (2026-07-14, the ...b5 Benoni case): CoachInput carries only
      best-move + margin, so when the engine's move needs a tactical justification the coach
      cannot give it — and it invented a positional story ("gains space") for a move that is
      justified only by ...Nxe4/...Qa5+ regaining the pawn. Sampler v3 must store a short PV
      (≈6 plies, SAN, and ideally PV2) per position at sampling time; pass it in CoachInput
      so the coach can explain the tactic from data; optionally render it in the reveal. A
      prompt guard (coach.rs) now forbids positional stories for material-hanging moves in
      the meantime.
- [ ] Range elicitation (from calibration session 2026-07-14): replace point-value quick
      buttons with log-spaced RANGES (+0.1–0.3, 0.3–0.6, 0.6–1.0, 1–2, 2–4, 4+ and mirrored),
      matching Weber-Fechner discrimination — nobody distinguishes 1.6 from 1.8, and forcing
      a point answer (0.5-vs-1.0 grid) adds pure input noise to MAE. Answers become ranges in
      the schema (keep point back-compat for v1/v2 answers); scoring goes range-aware (error =
      distance from range edge, 0 inside). Coach input carries the range so it critiques what
      the student actually asserted. New-session boundary only — never mid-session (mixing
      point and range answers muddies the per-player curve).

### Phase 1 — Inference plumbing
- [x] `maia.rs`: lc0 process management (spawn with `--weights`, warm pool with LRU over
      bands, cap 3, `kill_on_drop`), `VerboseMoveStats` policy parsing, `(fen, R) →
      Vec<(move, prob)>` + value-head API. `maia_status`/`maia_policy` commands; typed
      TS wrapper in `lib/maia.ts`. Version-sanity-checks the lc0 id-name at spawn.
- [x] Weight fetcher: download + SHA-256 checksum (pinned from the CSSLab v1.0 release,
      2026-07-14) + atomic cache of Maia-1 nets under `app_data_dir/maia` on first use;
      graceful "brew install lc0" hint in the UI when lc0 is missing. Download is
      injectable so tests never hit the network.
- [x] Unit tests: policy parser (e2e4/d2d4 masses, value head); weight-manager
      download/verify/cache/mismatch with an injected fetcher; **real-lc0** startpos at
      band 1500 — 20 moves, sums to ~1.0, e2e4/d2d4 prominent (cold 90 ms / warm 2 ms).

### Phase 2 — Tier 0 + slider UI
- [x] Instant blend evaluator (single Maia forward pass; `w·SF + (1−w)·anchor`, formula
      in design doc §7). Pure TS in `lib/human-eval.ts`, vitest-covered. Consumes the
      existing Stockfish stream from `use-engine` (no second SF spawned). Mate scores
      mapped to a bounded pawn-equivalent so the blend stays sane.
- [x] Rating slider (Off · 1100 · 1300 · 1500 · 1700 · 1900 — the 200-Elo stops over
      Maia-1's native bands) + Material / Human@R / Stockfish readout in the analysis
      panel; honest "≈ fast" tier-0 badge and top-band ceiling note; slider state
      persists (localStorage). Deferred: eval-bar tick marks (readout carries the
      divergence for now); stops above 1900 (need the high-band model, a later tier).
- [x] Slider stop changes re-query within one frame budget: warm Maia query ~13 ms,
      session LRU cache keyed `(fen, band)` makes revisited stops instant; disabled
      behind an install hint when lc0 is absent.

### Phase 3 — Tier 1 human-visible tree
- [ ] Restricted expectimax/minimax search: top-p candidate sets, Stockfish leaf scoring,
      node cap, transposition cache keyed `(fen, R)`
- [ ] Per-node phase conditioning: band chosen by the node's phase via the
      `calibration.rs` heuristic (non-pawn weight ≤ 8 = endgame; ply < 16 = opening),
      switching at boundaries mid-line; scalar slider = linked R⃗
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
- [ ] E-attention (design doc §5.1): action-zone local-Zobrist matched-pair mining on
      the corpus; bystander dose-response curves per band → perceptual-load
      coefficients for candidate breadth
- [ ] E-history (design doc §5.2): same-position/different-history query via the
      Zobrist position index; post-own-blunder degradation curve (magnitude × duration
      × band) → state modifiers; analyze board passes game history, bare-FEN mode
      degrades to position-only with a UI indicator
- [ ] E-imbalance (from calibration session 2026-07-14, bishop-pair note): Elo-dependent
      feature values. Query: SF-equal positions (|eval| < 0.3) with a bishop-pair-vs-knight
      imbalance, bucketed by Elo band; measure the bishop-pair side's actual score per band
      and convert to pawns via the 212 win-prob curve. Hypothesis: bishops are perceptually
      cheap (pressure without calculation) while a knight's value needs deep lines, so the
      imbalance is worth more at low Elo and decays toward the engine's ~0 with rating.
      First real query candidate once the mining corpus lands. Generalizes to other
      imbalances (opposite-color bishops, rook-vs-two-minors) if the pipeline is cheap.
- [ ] E-conversion (advantage decay): condition on SF eval bucket (e.g. +3..+5) × position
      complexity (bestMoveGapCp / 212 swing volatility); measure conversion rate (expected
      score) per band. Hypothesis: a "clean material" +4 barely decays with rating; a
      "deep-only" +4 decays steeply (2800 keeps most of it, 2100 a fraction). This is the
      curve the rating slider should ultimately report. NOTE the perception/conversion
      distinction: calibration sessions measure what a player of rating R *perceives* the
      position to be worth; the corpus measures what R actually *converts*. Eval_R targets
      conversion; perception data calibrates the coach — and the perception−conversion gap
      per player is itself a signal (intuition outrunning judgment or vice versa).
- [ ] E-template (false pattern match, from calibration session 2026-07-14): human eval is
      partly case-based — retrieved from the nearest experienced position, not computed —
      so a one-pawn difference that changes later conversion options inherits the wrong
      template eval. Reuses E-attention's action-zone local-Zobrist matched-pair mining:
      find sibling positions (same local pattern, ≥1 pawn/detail apart) with a large SF
      eval gap; measure per band how often players choose the same plan in both siblings
      (template-driven) and the loss taken in the exception sibling → template-blindness
      rate per band. Prediction: errors on near-template exceptions are biased toward the
      template's eval, not merely noisier. Future coach cause-tag candidate
      ("false_template" — evaluated the remembered position, not the board); do NOT add to
      the tag vocabulary until the taxonomy doc + coach.rs CAUSE_TAGS move together.
- [ ] E6 (design doc §1.5/§4): per-player phase profiles from the corpus; does the
      endgame-dragged cohort's middlegame match Maia of its overall rating or of its
      phase rating — gates the "unlock phases" UI
- [ ] Per-phase player-vector estimation: per-phase error rates vs corpus band norms
      ("plays middlegames like a 1350"); calibration sessions feed per-phase curves
- [ ] Spec review with user after tier-1 + E1 results
