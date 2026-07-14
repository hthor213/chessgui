# Elo-Conditioned Position Evaluator — Technical Design

*Design + feasibility document, 2026-07-13. Companion to spec 213. Builds on
`docs/research/mistake-mining-prior-art.md` (Maia line, licensing, complexity metrics) and
the spec 210 tournament lab (neutral evaluator, eval→win-prob machinery). Feasibility
probes in this doc were run on this machine (M2 Max) on 2026-07-13.*

## 1. The object we are defining

We want a function **Eval_R(position)** — the value of a position *as perceived by a
rating-R human* — such that:

- When Stockfish's +4 rests on a resource no R-rated player would find, Eval_R stays near
  the no-resource value (+1.2), and jumps toward +4 at the rating where the resource
  enters human sight. This jump behavior is the product.
- The number is on the familiar pawns scale so it can sit next to material and Stockfish
  evals, but it must be *calibratable to win probability* so we can test it against
  reality instead of arguing about it.
- It is computable interactively (a slider on the analysis board).

The key asset is Maia (CSSLab, U. Toronto): per-rating-band neural models trained to
predict the move a human at that rating actually plays (move-match 46–52% for Maia-1,
peaking at its own band — see prior-art survey §1). Maia gives us, for any position and
band R, a probability distribution over moves: *what R-players do here*.

### 1.1 Candidate semantics

**(i) Rollout semantics.** Eval_R(s) = expected game outcome if both sides play like
rating-R humans from s onward:

```
Eval_R(s) = E[outcome | a_t ~ Maia-R policy for the side to move, from s to terminal]
```

Estimated by sampling N policy rollouts (or by a learned outcome model as a shortcut —
see §1.4). Reported as win-prob, converted to a "pawns-equivalent" via the inverse of a
calibrated sigmoid (§3.1).

*For:* this is the definitionally correct "expected score", directly validatable against
real game outcomes — the cleanest science. It automatically excludes the obscure resource
(rating-R rollouts never play it) *and* automatically includes future conversion
difficulty ("R-players botch this endgame half the time"), which is exactly the tournament
lab's question ("how reliable is this edge?").

*Against:* it conflates two things the user may want separated — *perception of the
current position* and *future error rates*. A trivially winning but long position can
score 0.75 not because R-players don't see they're winning but because they'll blunder
later. It also regresses toward the mean in quiet positions (both sides err, evals
compress), and it is by far the most expensive to compute honestly (§5).

**(ii) Human-visible-tree semantics.** A minimax search over a *restricted* tree: at each
node, the candidate set is the smallest set of moves covering the top-p probability mass
(e.g. p = 0.8) of the Maia-R policy for the side to move; leaves are scored by Stockfish
(shallow fixed budget); values back up by minimax.

```
Eval_R(s) = minimax over T_R(s),  T_R = tree where children(n) = top-p(Maia-R(n))
            leaf value = Stockfish eval (White POV)
```

If Stockfish's +4 requires an out-of-set move anywhere along the line, the resource simply
does not exist in T_R and Eval_R never sees it. As R rises, the move enters the candidate
set and the eval jumps — this *directly* produces the user's +1.2 → +3.1 behavior, at a
specific and reportable rating threshold.

*For:* matches the product vision exactly; output is in Stockfish-comparable pawns
natively (no calibration needed just to display); cheap enough for interactivity (§5);
the jump rating ("visible from ~2500") is a first-class, explainable artifact.

*Against:* minimax backup assumes the R-player *plays the best visible line perfectly* —
it models bounded perception but perfect execution, so it overestimates conversion. It is
not directly outcome-calibrated by construction (we must calibrate it empirically, §4).
And top-p of the *play* distribution is a proxy for the *consideration* set (§6.4).

**(iii) Hybrids.**
- *Depth-scheduled visible tree:* tree depth d(R) grows with rating (a 1500 calculates
  shorter lines than a 2600). One more knob; plausibly real; calibratable from the corpus
  (does adding depth-vs-R improve outcome prediction?).
- *Error-injection expectimax:* same restricted tree, but back up **expectimax over the
  Maia-R probabilities** instead of minimax — nodes average over what R-players actually
  play (renormalized within the candidate set) rather than assuming the best visible move.
  This is rollout semantics computed exactly on a truncated tree: it re-introduces
  bounded *execution* on top of bounded *perception*, and interpolates between (i) and
  (ii) with a single temperature parameter (temperature 0 = minimax (ii); temperature 1 =
  truncated (i)).

### 1.2 Recommendation: tier-1 = human-visible tree (ii), with (iii)-expectimax as the tier-2 refinement knob, and (i) as the validation ground truth

Reasoning:

1. **Product fit.** The user's framing — "the 1900 evaluator doesn't see the obscure
   resource; at 2650 it jumps" — *is* semantics (ii). It answers "what is this position
   worth at rating R", not "what score will R-players average from here", and it yields
   the jump rating as an explainable output.
2. **Display without ceremony.** (ii) produces pawns on the Stockfish scale natively.
   (i) produces a win-prob that must be inverted through a band-specific sigmoid before it
   can sit on the eval bar, and the compressed-toward-0.5 behavior would make the slider
   feel mushy (everything drifts toward equality as R drops, even clearly won positions).
3. **Cost.** Measured on this machine (§5): (ii) fits an interactive budget; honest (i)
   is minutes per position over the UCI path and needs a batched-inference build-out or a
   value-model shortcut before it's usable live.
4. **Science is still served.** (i) remains the ground truth for validation: experiment
   E1 (§4) tests whether (ii)'s calibrated output predicts real R-vs-R outcomes, and E5
   ablates (ii) vs expectimax vs the value-head shortcut of (i). If minimax-(ii) loses
   badly to expectimax on Brier score, the expectimax temperature becomes the tier-2
   default — the architecture is shared, so this is a parameter change, not a rewrite.

### 1.3 Whose perception? Perspective consistency

**Recommendation: viewer-symmetric, both sides at rating R, reported White-POV.** One
slider = "the level of the game being imagined". At each node of the tree, the candidate
set comes from the Maia-R policy *for the side to move at that node* — so both players are
R-rated, symmetric by construction. The final number is White-POV like every eval in the
app; flipping the board or moving the slider never changes sign conventions, only the
value. This keeps the eval bar, the perception curve, and the 212 error-report labels
coherent as the slider moves.

Rejected for tier 1: *side-to-move-only conditioning* (whose R applies flips every ply —
incoherent as a position property) and *asymmetric R_white/R_black* (genuinely useful —
"I'm 1900, my opponent is 2200, is this +4 real for me?" — and the machinery trivially
supports per-side policies, but it's a second slider and a UX question; deferred to
tier 3).

Non-monotonicity note: Eval_R is **not** guaranteed monotone in R, and genuinely shouldn't
be — a 2100 may see the attacking idea but not the defense, scoring the position *higher*
than a 2400 who sees both. The perception curve should display this honestly rather than
smoothing it away; docs and UI copy must frame jumps and dips as signal.

### 1.4 The Maia value head (potential shortcut for (i))

Leela-format nets carry a value head, and Maia's was trained on *human game outcomes in
its own band* — if reliable, a single forward pass approximates rollout semantics (i) for
free. **Unverified**: the value-loss weight in Maia's training config was small, and the
head's calibration quality is unknown; the KDD paper doesn't evaluate it. Our probe
confirmed the head is exposed (root Q ≈ −0.076 for the tested position). Treat it as a
free extra predictor to include in E1/E5 — if it calibrates well on the corpus, it becomes
the instant-tier backbone; if not, we've spent nothing.

## 2. Assets and the inference path

### 2.1 Model inventory

| Model | Bands | License | Form | Runtime need |
|---|---|---|---|---|
| Maia-1 | 9 nets, 1100–1900 (100-Elo steps) | GPL-3.0 | Leela-format protobuf (~1.2 MB/net) | lc0 |
| Maia-2 | unified, skill-aware attention (conditioning range to verify — paper says "full rating range"; repo examples center on 1100–2000) | GPL-3.0 | PyTorch | Python or ONNX export |
| Maia-3 | "Chessformer", 57.1% top-1; conditioning range **to verify** | Apache-2.0 | HF transformer, 79M params (`UofTCSSLab/Maia3-79M`, public, ungated — verified 2026-07-13) | candle/ONNX/Python |

Both GPL models are license-compatible (chessgui is GPL-3.0, forced by Chessground).

### 2.2 Feasibility probe results (this machine, 2026-07-13)

All verified by actually running them, not from docs:

- **lc0 0.31.2 is already installed** (`/opt/homebrew/bin/lc0`, brew formula current at
  0.32.1). GPL-3.0-or-later.
- **`maia-1500.pb.gz` downloads from the CSSLab GitHub release** (1.2 MB, HTTP 302 to a
  release asset — live).
- **lc0 loads the net on the Metal backend** ("Initialized metal backend on device Apple
  M2 Max"); cold start ≈ 1 s including weight load.
- **Full root policy is extractable over plain UCI**: `setoption name VerboseMoveStats
  value true` + `go nodes 1` emits one `info string <move> ... (P: x.xx%) ...` line per
  legal move (32/32 in the test position), plus the root Q (value head). No source
  patching, no ONNX, no Python.
- **Warm per-position latency: 13 ms** (84 ms for the first query after load). This is
  the number the whole performance budget (§5) is built on.
- One caveat found: lc0 exits on stdin EOF mid-search, so the driver must hold the pipe
  open — exactly how `uci.rs` already manages engines, so this is free.

### 2.3 Recommended inference path (tiers 0–1)

**lc0 subprocess speaking UCI, one process per band, warm LRU pool.** A new
`src-tauri/src/maia.rs` module mirroring the `uci.rs` engine-management patterns:

- Spawn `lc0 --weights=<band>.pb.gz`, set `VerboseMoveStats`, keep warm. ~20 MB RSS per
  process; a pool of 3 (current band ± one slider stop) covers slider locality, and even
  all 9 warm is cheap.
- Policy API: `maia_policy(fen, band) -> Vec<(uci_move, prob)>` parsing the `P:` lines.
  `nodes=1` is mandatory — Maia is meant to be read at the policy head; adding search
  nodes "un-humanizes" it (documented Maia usage; also the Eisma result: search+human-net
  drifts back toward engine-like play).
- Weights: fetched on first use from the CSSLab release URL, checksummed, cached under the
  app's engines dir (same pattern as the Reckless binary in `engines/`). Do **not** bundle
  in the .dmg — keeps GPL distribution obligations simple (we distribute a fetcher; the
  app itself is GPL anyway, so bundling is *legal*, just heavier) and keeps the artifact
  small. lc0 itself: detect at known paths; offer `brew install lc0` guidance when absent.
- Pin/verify the lc0 major version at spawn (`uci` handshake reports it); old-format net
  support has historically been stable but a version check costs one line and prevents a
  silent-garbage failure mode if a future lc0 drops SE-ResNet support.

**Why not the alternatives (for tiers 0–1):**
- *Python sidecar (Maia-2/3 native):* a Python runtime inside a Tauri .app is a packaging
  and code-signing tax we've avoided so far; wrong trade for a desktop product's first
  tier.
- *ONNX export + ort crate:* the right eventual path for high bands and for batched
  rollouts (E5 offline experiments can use Python freely — it's the *shipped app* that
  shouldn't), but it's real engineering (export fidelity, quantization, Metal EP) with
  zero benefit at 13 ms/query for nine 1.2 MB nets.
- *candle + Maia-3 safetensors:* plausible tier-3 path for 2100–2700 (Apache-2.0 helps if
  licensing posture ever changes); 79M params ≈ tens of ms per forward on Metal — fine —
  but blocked on verifying Maia-3's rating-conditioning range first (§6.1).

### 2.4 Other assets in play

- **Mining corpus** (being built): est. 9–10.5M lichess games, 1400–2200, band-balanced,
  all with `[%eval]` labels. This is the validation fuel (§4) — Stockfish evals come free
  with the corpus, so E1/E2 need no mass re-analysis.
- **Guid–Bratko complexity** (eval instability across depth — the only difficulty metric
  validated against human error rates; prior-art §4): the control variable in E2 and the
  moderator variable in E1's "where does Eval_R win" analysis.
- **Tournament lab eval→win-prob machinery** (spec 210/212): the empirical
  eval-bucket→W/D/L map and the logistic-fit fallback are exactly the calibration
  apparatus §3.1 needs — reuse, don't rebuild.

## 3. Output scale and calibration

### 3.1 Two readouts, one number

Internally Eval_R is computed in pawns (Stockfish leaf units). For display we keep pawns
(the familiar scale). For *validation and win-prob display* we map through a calibrated
sigmoid: `P(win-equiv) = σ(a_R · eval + b_R)` fit per band on the corpus (expected points:
win=1, draw=0.5). The fit reuses the 212 logistic machinery. The inverse map also defines
the "pawns-equivalent" readout for any rollout-semantics number, so all semantics
candidates can be displayed on the same bar.

Note the subtlety: the sigmoid slope a_R itself shrinks at lower ratings (a +2 edge
converts less reliably at 1400 than at 2200 — the tournament lab has already demonstrated
the analogous effect for engines). This is a second, separate way rating enters the
system, and it's worth surfacing in the UI eventually ("+1.2, which at 1900 converts at
~64%"), but tier 1 keeps the pawns display and uses the sigmoid only for validation.

## 4. Validation design — "analyze millions of games"

The standing question for every semantics/hyperparameter choice: **does Eval_R describe
real R-rated humans better than Stockfish does?** All experiments run on the mining
corpus; positions are sampled one-per-game (avoid intra-game correlation), splits are by
game *and by player* (player-disjoint train/val/test), band-stratified.

**Contamination control:** Maia-1 was trained on Lichess games up to ~2019. Restrict
validation to corpus games from later years (the corpus build should record game dates) so
we never test Maia on its own training games.

### E1 — the killer experiment: outcome prediction head-to-head
On held-out positions from real R-vs-R games: predictors = {material count, Stockfish
`[%eval]`, Eval_R, (Maia-R value head)}. Each predictor gets its own logistic calibration
on the training split (fair fight), then predicts expected points on test.
**Metrics:** Brier score (primary), log-loss, AUC (win-vs-rest), reliability diagrams per
band. **The claim being tested:** Brier(Eval_R) < Brier(SF eval) within band R.
**The interesting cut:** stratify by Guid–Bratko complexity and by |SF eval| — the
hypothesis is that Eval_R's win concentrates in high-complexity / big-eval positions
(exactly the "+4 that isn't real at 1900" territory). If Eval_R only ties SF overall but
dominates in that stratum, the feature is still fully justified — that stratum is the
product.

### E2 — divergence predicts human error
Define divergence D(s, R) = |winprob_R(SF eval) − winprob_R(Eval_R)|. Test: does D predict
whether the R-band player to move errs on the *next* move (win-prob drop ≥ 10 pp, per the
212/mining thresholds), with Guid–Bratko complexity as a control (incremental validity —
logistic regression, report ΔAUC over complexity alone)? Ties directly to the mining
taxonomy: within cause-labeled misses, D should concentrate in the "hard-to-see" causes
(long-range piece, quiet move, backward move) rather than simple hung pieces. A positive
result means the evaluator and the mistake-mining taxonomy are seeing the same underlying
object from two sides.

### E3 — the jump audit
Curated set (~200 positions) with a known obscure resource: mined "refutation missed by
band X, found by band Y" positions (the mining pipeline produces these natively) plus
hand-picked "nobody would play that" classics. For each, compute the perception curve and
locate the jump rating R*. Test: R* correlates with the empirical crossover rating at
which corpus players actually start finding the move (conditional find-rate ≥ 50%). This
is the experiment that validates the *flagship visual* specifically, and it's novel — the
find-rate crossover is measurable in our corpus both ways.

### E4 — conditioning matters (diagonal dominance)
Cross-prediction matrix: Brier(Eval_R applied to band-R′ games) for all (R, R′) pairs.
Eval_R must predict its own band best (diagonal dominance). Guards against the failure
mode where Eval_R is just "a noisier, lower Stockfish" that helps every band equally —
i.e., where the slider position doesn't actually mean anything.

### E5 — semantics & hyperparameter ablations
On a fixed validation slice: minimax-(ii) vs expectimax-(iii) (temperature sweep) vs
value-head-(i) vs tier-0 instant blend; top-p ∈ {0.6, 0.7, 0.8, 0.9}; depth schedule
d(R) ∈ {fixed 4, fixed 6, 4+R/400}; node caps. Selection metric: Brier from E1's protocol.
Output: frozen tier-1 defaults + a documented sensitivity table (if results are flat
across p, say so — that's important honesty about how sharp the definition really is).

Priority order: **E1 → E3 → E2 → E5 → E4.** E1 justifies the feature's existence; E3
validates the flagship visual; E2 ties it to the mining program; E5 tunes; E4 is the
skeptic's check and can run last (it reuses E1's artifacts).

## 5. Performance budget

Grounded in the measured 13 ms warm policy query (§2.2). Costs are per (position, R).

### Tier 0 — instant blend (slider must feel live)
1 Maia forward (13 ms) + Stockfish eval already on screen (the analysis engine or the 210
neutral evaluator is running anyway) + material count (free).

```
Eval_R^fast = w·SF + (1−w)·anchor
w = mass the Maia-R policy assigns to the first move of Stockfish's PV
    (smoothed; optionally averaged over the first two PV plies)
anchor = second-PV eval when MultiPV≥2 is available, else material eval
```

Interpretation: if R-players overwhelmingly play the move Stockfish's +4 rests on, the +4
is human-real at R; if the policy barely considers it, the position is worth its fallback
value. This is a one-forward-pass approximation of semantics (ii) at depth 1, honest
enough for a live slider and a strong E5 baseline. Cost per slider stop ≈ **15 ms**; full
9-stop perception curve ≈ 150 ms. Truly interactive.

### Tier 1 — human-visible tree
Per node: 1 Maia forward (13 ms, warm pool). Per leaf: 1 shallow Stockfish eval
(`movetime` 10–20 ms, persistent process — same deliberate movetime-not-depth choice as
the 210 neutral evaluator, to bound wall cost). Branching at p = 0.8 is typically 3–6
moves; depth 5–7 plies; **node cap 200–500** with transposition table keyed `(fen, R)`.

Worst-case: 400 nodes × 13 ms + 200 leaves × 15 ms ≈ **8 s**. Typical with cache hits and
early cutoffs: **1–4 s**. Strategy for interactivity:
- Progressive: tier-0 renders in one frame, tier-1 replaces it when done (badge shows
  which tier is displayed).
- Slider sweep in background: compute the current stop first, then fan out to the other 8
  (they're independent; the lc0 pool and one extra Stockfish keep it off the analysis
  engine's cores — same resource-isolation discipline as the neutral evaluator). Full
  curve ≈ 10–30 s in background; fine for an analysis tool, and cached per position.
- LRU cache `(fen, R) → eval` across the session; a game review touches each position
  once.

### Rollout semantics (i), for the record
Honest rollouts: ~200 rollouts × ~60 plies × 13 ms ≈ **2.6 minutes** per (position, R)
over the UCI path — not interactive, not even patient-background. Viable only via batched
inference (ONNX/candle, thousands of forwards/s batched on Metal) or the value-head
shortcut (1 forward). This cost asymmetry is a large part of why (ii) is tier-1. Offline
(E5) rollouts in Python on the corpus are fine.

## 6. Risks and honest limitations

### 6.1 The 2000–2700 gap (biggest product risk)
Maia-1 tops out at **1900**. The user's headline story ends at 2650. Options, in order of
preference:
1. **Verify Maia-2/Maia-3 conditioning ranges** (Maia-2's skill-aware attention and
   Maia-3's conditioning were built to generalize across ratings, but the reliable top of
   their ranges — and data density above ~2300 — must be checked in the papers/repos and
   then *empirically* via E4 diagonal dominance on 2200+ games before we put a number on
   the slider). Maia-3 being Apache-2.0 with public weights makes it the likely vehicle.
2. **Blend toward the engine**: above the top validated band, interpolate the candidate
   sets between Maia-top-band and Stockfish MultiPV — defensible as "approaching engine
   sight" but it's a model of a model; must be labeled experimental in the UI.
3. **Fine-tune on our corpus** (1400–2200) — extends validated coverage to 2200, not
   2650.
Data reality above 2500: even on Lichess, high-rated *classical* games are sparse and
titled-player pools are stylistically distinct. Honesty requirement: slider stops above
the validated ceiling render with an "experimental" treatment; the perception curve greys
out that region. Do not fake precision at 2650 — the feature's credibility rests on the
validated middle of the slider.

### 6.2 "Moves a human PLAYS" vs "resources a human SEES"
Maia's training target is the *played* move; our object is the *consideration set*. A
2200 may see a sacrifice, calculate it, and reject it — it was visible but never played;
conversely a move can be played on general principles without its point being seen. The
design bridges the gap three ways:
1. **Top-p, not top-k**: taking the top-p mass at generous p (0.8+) admits every move
   with non-trivial play probability — a strict superset of typical play and a first-order
   proxy for consideration. E5's p-sweep measures how much this matters empirically.
2. **Stretch mode**: union the candidate sets of bands R and R+200 — "moves this player
   or a slightly stronger one would play" — as an explicit consideration-set widener,
   ablated in E5.
3. **The long-term fix is our own data**: the mining pipeline's per-feature conditional
   miss-rates ("given a long-range refutation exists, band R misses it 78% of the time")
   are direct measurements of *seeing*, not playing. A recalibration layer that adjusts
   candidate-inclusion using those feature-conditional rates is the novel contribution
   this project can make on top of Maia — spec 211's taxonomy and this evaluator converge
   there. Not tier-1; flagged as the research payoff.
The residual gap is stated in the UI docs: Eval_R models *practically available* moves,
which is slightly narrower than *perceptible* ideas.

### 6.3 Blitz bias
Maia-1 was trained on Lichess games whose time controls skew fast (the exact filter needs
verification from the KDD paper before we write it in user-facing docs). Implication:
Eval_R models perception under *quick-game* conditions and will underrate what the same
player finds with 30 minutes on the clock. Mitigations: the depth schedule d(R) doubles as
a deliberation knob (E5 measures it); long term, corpus filtering by time control lets us
fit a "classical correction". Stated limitation until then.

### 6.4 GPL and shipping
chessgui is GPL-3.0, so GPL-3.0 Maia-1 weights and GPL lc0 are compatible outright.
Shipping posture: **fetch-on-first-use** for weights (CSSLab release URLs, checksummed,
cached) and detect-or-`brew install` for lc0 — nothing GPL-encumbered is added to the
.dmg, downloads keep provenance obvious, and attribution (Maia/CSSLab, lc0) goes in the
About panel. If the app's licensing posture ever needs to change, the Maia-3/Apache path
exists.

### 6.5 Assorted
- **lc0 version drift**: old-format SE-ResNet nets have loaded for years, but pin/probe
  the lc0 version at spawn and fail loudly (verified working: 0.31.2; formula stable:
  0.32.1).
- **Value-head reliability** (§1.4): unmeasured; use only after it survives E1.
- **Non-monotone curve confusion**: users will report dips as bugs. UI copy must frame
  the perception curve correctly from day one (§ spec 213).
- **Resource contention**: Eval_R passes must never starve the user's analysis engine or
  tournament players — same isolation discipline the neutral evaluator already
  established (own processes, bounded movetime, decoupled task).
- **Validation contamination** (§4): enforce the post-2019 game filter in every
  experiment; it's the kind of leak that silently manufactures a positive E1.

## 7. Summary of recommendations

| Question | Recommendation |
|---|---|
| Semantics | Tier-1: human-visible tree (minimax over top-p Maia-R candidates, Stockfish leaves). Tier-2 knob: expectimax temperature toward rollout semantics. Rollouts = validation ground truth, not runtime. |
| Perspective | Both sides at R, one slider, White-POV display; asymmetric R deferred to tier 3. |
| Inference | lc0 subprocess + Maia-1 nets over UCI (`VerboseMoveStats`, `nodes=1`), warm per-band pool. Verified end-to-end on this machine: 13 ms warm/query. No Python/ONNX in the shipped app for tiers 0–1. |
| Instant tier | Single-forward blend: weight SF eval by the Maia-R policy mass on SF's PV move; ~15 ms per slider stop. |
| Validation | E1 outcome-prediction head-to-head (Brier, per band, complexity-stratified) is the killer experiment; E3 jump audit validates the perception curve; E2 ties divergence to real human error. Player-disjoint, post-2019 splits. |
| Biggest risk | Rating coverage above 1900. Verify Maia-2/3 ranges; label high stops experimental; never fake the 2650 number. |
