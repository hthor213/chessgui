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
compress), and it is by far the most expensive to compute honestly (§7).

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
natively (no calibration needed just to display); cheap enough for interactivity (§7);
the jump rating ("visible from ~2500") is a first-class, explainable artifact.

*Against:* minimax backup assumes the R-player *plays the best visible line perfectly* —
it models bounded perception but perfect execution, so it overestimates conversion. It is
not directly outcome-calibrated by construction (we must calibrate it empirically, §4).
And top-p of the *play* distribution is a proxy for the *consideration* set (§8.2).

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
3. **Cost.** Measured on this machine (§7): (ii) fits an interactive budget; honest (i)
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

### 1.5 Skill is a phase vector, not a scalar

The user's framing, which generalizes: "I'm a 1200 — that just means that against
another 1200 we score evenly. It says nothing about each stage of the game. I don't know
openings, my middlegame might be 1350, and I mess up endgames — 'can I get piece X to
place Y in time' and I move it to the wrong spot." A single Elo is the *integral* of
skill over the game; the evaluator should condition on the profile, not just the
integral.

**General form.** The conditioning variable is a vector

```
R⃗ = (R_opening, R_middlegame, R_endgame)
```

and scalar R is the special case where the three are linked, R⃗ = (R, R, R). The UX
follows: one slider by default, setting all three; an advanced "unlock phases" mode
splits it into three.

**Per-node conditioning.** The tree picks the Maia band by the phase of the position *at
each node*, not at the root — and this matters, because a search tree crosses phase
boundaries mid-line: a middlegame root whose critical line trades down has endgame
leaves, and a player with weak endgames should evaluate exactly those leaves worse. When
a line crosses the boundary, the conditioning switches with it. That makes "this
middlegame is good for you *if* you can play the resulting endgame" a computable
statement: the same position scores differently for a (1200, 1350, 1100) player than for
a (1200, 1200, 1500) one. Phase heuristic: reuse the one already shipped in
`calibration.rs` — non-pawn phase weight (24 at the start; ≤ 8 counts as endgame, above
as middlegame), with opening = in-book / ply < 16 (the calibration sampler's `MIN_PLY`
convention). One heuristic shared across calibration data, corpus tables, and the
evaluator, so per-phase numbers stay comparable everywhere.

**Estimating a player's vector.** The mining corpus's per-band × per-phase error tables
(already planned in the 212/Phase-9 machinery) are the yardstick: measure a player's
per-phase error rates and read off which band's norms they match — "plays middlegames
like a 1350, endgames like an 1100." Two sources, in order of arrival:
1. *Calibration sessions* (`calibration.rs`, live): sessions already stratify and record
   phase per position, so the user's perceived-eval answers yield per-phase calibration
   curves directly — the user-as-baseline datapoint is phase-resolved from day one.
2. *Imported games* (later): the player's own games give a play-based vector through the
   same per-phase error-rate machinery the corpus uses for bands.

**Honest limitation — Maia's conditioning is scalar.** Maia bands are population Elo;
per-phase conditioning is approximated by *choosing a different Maia-R per phase*. That
assumes phase-skill independence in the population nets: Maia-1350's middlegame policy
is the average middlegame of players whose *overall* rating is 1350 — not of players who
are 1200 overall with a 1350 middlegame. If phase skills correlate in the population
(they surely do, partially), the approximation is biased in a measurable direction. The
corpus tests it directly — **E6** (§4): build per-player phase profiles, then check
whose middlegame moves the "1200 overall, endgame-dragged" cohort actually matches,
Maia-1200 or Maia-1350. The answer validates (or corrects) the phase-unlock feature and
is a nice standalone result about how chess skill decomposes.

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
  the number the whole performance budget (§7) is built on.
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
  but blocked on verifying Maia-3's rating-conditioning range first (§8.1).

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

### E6 — does phase-swapped Maia match phase-skilled players?
Tests the phase-vector approximation of §1.5. Build per-player phase profiles from the
corpus (per-phase error rates vs band norms, for players with enough games), then select
the cohort whose overall rating is R but whose middlegame plays like R+Δ (e.g. 1200
overall, 1350-middlegame — the "endgame-dragged" profile). Measure whose *middlegame*
moves that cohort actually matches: Maia-1200 (conditioning on the integral) or Maia-1350
(conditioning on the phase skill), by policy log-likelihood / top-1 match on their
middlegame positions. Repeat per phase and per Δ. Outcome directly validates or corrects
the "different Maia-R per phase" approximation — and is a standalone result about whether
population nets factor by phase. Gates the phase-unlock UI: ship three sliders only after
E6 says swapping bands by phase tracks reality better than the scalar.

Two further experiments — **E-attention** and **E-history** — are defined in §5, because
they measure the *mechanisms* the evaluator's coefficients come from rather than its
end-to-end accuracy. Both run on the mining corpus using the Zobrist position machinery
that already exists in `db.rs`.

Priority order: **E1 → E-attention → E-history → E3 → E2 → E5 → E4 → E6.** E1 justifies
the feature's existence; E-attention and E-history sit right behind it because they supply
the coefficients that make tier-2 psychologically honest (§5) *and* are novel results in
their own right regardless of how the evaluator fares; E3 validates the flagship visual;
E2 ties it to the mining program; E5 tunes; E4 is the skeptic's check and can run late (it
reuses E1's artifacts); E6 is scheduled by product need — it must land before the
phase-unlock UI ships, but blocks nothing else.

## 5. Perception psychology — the coefficients that make the tree honest

The restricted tree of §1 is the *tuning mechanism*: lc0/Maia decides which moves exist,
Stockfish decides what they're worth. Left alone, that is an interpolation between two
engines. What makes it a *human* eval is that the candidate-set breadth (top-p), the
depth, and the expectimax temperature must be functions of measured human perception —
and with 4.8×10^44 chess positions you cannot tabulate perception; you need perception
**laws** that generalize from where we have data to where we don't. This section defines
the two laws we will measure first, why Maia alone doesn't already give them to us, and
how each enters the evaluator as an explicit coefficient. Both experiments run on the
mining corpus with the Zobrist position index that already exists (`db.rs`: `positions`
table, Zobrist64 over every mainline position, O(1) lookup).

### 5.1 Attention load — the confusing knight

The motivating example: ten pieces clustered on one battleground, and one objectively
inert piece parked on the far side of the board. Stockfish calculates through it
instantly — the bystander changes nothing and costs nothing. A human's move-finding
measurably degrades: the bystander consumes attention merely by existing. Perception is a
budget, and every piece on the board draws from it whether or not it participates.

**(a) What Maia already captures — and what it can't.** Honesty first: Maia was trained
on millions of humans who *were* confused in exactly such positions, so population-level
confusion is already baked into its policy — the top-p candidate set will genuinely be
noisier/flatter in cluttered positions *wherever training density exists*. What Maia
cannot give us is the isolated, quantified **mechanism**: "adding one inert bystander at
distance d costs band R x percentage points of top-move rate." A black-box policy
interpolates; a measured law generalizes — to sparse regions of position space, to
composed/edited positions the corpus never saw, and to the 2100+ bands where our data
thins out. The law is also a publishable result independent of the evaluator (the
prior-art survey found no controlled human test of this hypothesis — only coach
folklore).

**(b) Experiment E-attention: matched-pair mining.** Find corpus position pairs that are
near-identical where the action is and differ only in inert distant material, then compare
how real players at each band performed in them.

- *Action zone*, operationally: the set of squares within Chebyshev distance k (default
  k = 2, ablate) of any square involved in a capture, a check, or a piece contact (mutual
  attack between enemy pieces) within the last m plies (default m = 4).
- *Local-region Zobrist*: hash only the (piece, square) pairs inside the action zone plus
  side to move — an extension of the existing `db.rs` hashing, keyed on the zone instead
  of the whole board. Pairs (or clusters) matching on this local hash but differing
  outside the zone are the raw material.
- *Bystander*, operationally: a piece outside the action zone whose removal changes the
  Stockfish eval by < 0.15 pawns (cheap per-candidate check at shallow movetime) — i.e.
  objectively inert, so any human effect is perceptual, not positional.
- *Measurement*: per band, compare top-move-match rate (vs Stockfish best and vs the
  band's own Maia policy mode) and next-move error rate (win-prob drop ≥ 10 pp) across
  matched pairs. **Dose-response** is the point: effect size by bystander count, by piece
  type (knight vs bishop vs rook vs pawn — does the long-range-piece hypothesis show up
  as line pieces radiating phantom threats?), and by distance from the zone. Control for
  Guid–Bratko complexity of the zone itself.
- *Scale*: matched pairs are rare per position but the corpus has ~10M games × ~40
  positions each — this is precisely the "analyze millions of games" promise cashing out.

**(c) How it enters the evaluator.** Perceptual-load features computed per node, cheap
and engine-free: battleground spread (dispersion of the action zone), bystander count,
x-ray/line paths crossing the zone, total mobile pieces. These modulate the candidate-set
breadth per node per band:

```
p_eff(R, s) = p0(R) − f_R(load(s))
```

with f_R fitted from E-attention's dose-response curves (and plausibly also raising the
expectimax temperature — load degrades execution, not just perception). Under load, the
human-visible tree narrows *by measured law*, including in positions where Maia's training
data is thin — that's the generalization the mechanism buys us over trusting the policy's
implicit confusion.

### 5.2 Story-arch — history dependence ("chess is a REST API, humans are not")

For an engine, chess is stateless: identical position, identical best move, a pure
function of the FEN. Humans carry the game's story into every move. The player who lost a
piece one move ago is standing in the same position a REST call would see — but they are
in "crap, I need to fix it" mode, and they demonstrably do not play it the same way.

**(a) What Maia already sees — and what it can't.** Nuance required: lc0-format input
planes include the last 8 plies, so *short* history is technically visible to Maia-1 and
is part of what it learned. The longer arc is not: tilt accumulated across many moves,
the eval trajectory (did they just throw away a won game?), the clock state (Maia's
inputs carry no clock), and the risk-appetite shift that follows a windfall or a
disaster. Those live outside the position encoding entirely.

**(b) Experiment E-history: same position, different stories.** The `db.rs` Zobrist
index makes "identical or transposed positions reached via different histories" a
database query, not a research project — run it over the mining corpus and stratify by
the mover's state:

- *State strata*: recent eval trajectory (own blunder ≥ 10 pp win-prob within the last j
  plies, by magnitude, vs stable trajectory; separately: opponent's recent blunder — the
  windfall/relaxation case), and clock remaining/increment.
- *Measurement*: per band, move-choice deltas (agreement with Stockfish best; KL from the
  band's baseline Maia policy) and next-move error-rate deltas between strata, on the
  *same* Zobrist-identical positions.
- *Headline output*: the **post-own-blunder degradation curve** — extra error probability
  (magnitude) × how many plies it persists (duration) × band. Folklore says weaker
  players tilt harder and longer; nobody has the curve.

**(c) How it enters the evaluator.** State features h = (recent own eval swing, plies
since it, clock pressure) join the load features as modifiers of candidate breadth and
expectimax temperature: the tree's coefficients become functions of (R, load(s), h).
And one honest UX consequence: **a history-dependent eval needs the GAME, not just the
position.** On our analyze board and in the tournament viewer the game tree supplies the
history, so Eval_R can carry the story-arch term; for a bare pasted FEN there is no
story, the evaluator falls back to h = neutral (position-only prior), and the UI must say
which mode it is in rather than silently pretending the two are the same number.

### 5.3 Counting — the endgame failure family

The user's own endgame description names a third mechanism, distinct from the first two:
"can I get piece X to place Y in time — and I move it to the wrong spot." That is a
**counting / tempo-arithmetic failure**: racing calculation in *simplified* positions.
Mechanistically it is not perceptual load (§5.1) — the board is nearly empty, there are
no bystanders, branching is tiny — and not history dependence (§5.2). The position is
easy to *see* and hard to *count*: king races, pawn breakthroughs, "does my rook get back
in time," where the answer is an exact ply count and off-by-one loses.

Two design consequences:
1. **Taxonomy**: counting joins the mining taxonomy as its own cause family (alongside
   the perceptual families like long-range piece / quiet move / backward move). Its
   signature is measurable: errors concentrated in low-material positions whose
   refutation is a forced line — so endgame difficulty for humans should correlate with
   **required-count-depth** (length of the forced sequence that must be calculated
   exactly), *not* with branching factor or Guid–Bratko instability, which is the
   opposite of what middlegame difficulty looks like. That contrast is itself a testable
   prediction for the mining program.
2. **Evaluator**: in endgame-phase nodes (§1.5's phase heuristic), the candidate-set
   breadth matters less than the *depth* the band can count exactly — the depth schedule
   d(R⃗) should be phase-aware, with the endgame component calibrated against
   counting-error rates per band rather than the middlegame's perceptual-load curves.
   Tier-2+ refinement; recorded here so the endgame slider doesn't inherit a
   middlegame-shaped model by default.

### 5.4 Status of the pillars

These are tier-2 coefficients gated on the mining corpus, not tier-1 blockers — tier 1
ships with p0(R) flat and h neutral. But they are first-class design commitments, not
future footnotes: the experiments are specified now, they run on infrastructure that
already exists, each is a novel measurable result on its own, and the evaluator's claim
to be *psychological* rather than an engine blend rests on them landing.

## 6. Adaptive elicitation — the battery asks what it needs to know

The calibration battery (spec 213 Phase 0) currently shows a fixed stratified set. The
user's direction came in two steps. First: make it adaptive like the modern SAT, but on
**information gain**, not difficulty — "not more and more difficult, but rather *'what
information do you need based on prior answers'*." Then the refinement that inverts the
objective: "we don't need to lock me down in Elo (although fun to know)… it's more that
we use the human to make human mistakes — it's more about *what data do you need more
of*."

So the battery is **active learning for the model, with the person as the labeler** —
not a measurement of the person. Formally: optimal experimental design / uncertainty
sampling over the *model's* parameters. The person-measurement version (CAT/IRT over a
person profile θ) survives as a brief opening phase and a fun by-product, not as the
objective.

### 6.1 Two-phase design

**Phase A — brief profile lock-in (~10–20 positions).** A label is only usable if we
know who produced it: "a ~1300 with a 1500-ish endgame perceived this as +1.2" is data;
an anonymous "+1.2" is not. So a session opens with a short CAT-style burst that pins
the labeler's rough profile — phase vector (§1.5), eval bias/variance — just tightly
enough for their answers to be interpretable as *a known-level human's perception*.
Classic CAT machinery applies, with the multidimensional twist worth keeping: the most
informative next item may be an easy endgame count rather than a harder middlegame
(Fisher-information difficulty-matching, the SAT's "it gets harder", only falls out in
the unidimensional case). Previously collected fixed-battery sessions serve as this
phase's prior, so returning users skip most of it.

**Phase B — model-driven selection, forever after.** Every subsequent position is
chosen by what the *evaluator program* needs — three uncertainty streams, blended:

1. **Variant disagreement.** Positions where evaluator variants (band settings,
   psychology-coefficient values, top-p/depth/temperature choices) disagree most about
   what a human at the labeler's level would answer. One label here prunes model space;
   a position where every variant agrees teaches nothing, however uncertain we still
   are about the person.
2. **Coverage sparsity.** Positions from cells where the corpus is thin — rare motif ×
   load × phase × |eval| combinations, composed-position territory, unusual material
   balances. The human labeler is most valuable exactly where the millions of games are
   silent.
3. **Coefficient starvation.** Positions targeted at whichever §5 curve currently has
   the widest error bars: bystander dose-response points (§5.1), counting-depth rungs
   (§5.3), story-arch states (§5.2 — reachable in-battery by presenting a position
   *with* its game context). The selector works down the most data-starved region of
   the curve.

The person's why-text (already elicited in Phase 0) is the label's provenance — "didn't
see the knight was loose" attached to a high-load cell is exactly the cause evidence the
§5 coefficients and the 211 taxonomy need.

### 6.2 The convergence: the corpus is the item bank

Make this explicit, because it is the economic heart of the program: **the mining
corpus's per-band miss rates per position are pre-calibrated item parameters.**
P(band-R player gets this right), measured from millions of real games, is an empirical
item characteristic curve — no parametric fit required (fitting one is just
compression). And these are the *same numbers* that set spec 211's puzzle difficulty.
One measurement infrastructure, three consumers:

1. **211 avoidance puzzles** — per-band miss rates target puzzle difficulty.
2. **Adaptive elicitation** — miss rates + motif/phase/complexity tags tell the selector
   both what a position measures and where the corpus is already saturated (stream 2
   above is literally "cells with low counts in these tables").
3. **Evaluator validation** — the same tables are E1–E6's yardsticks.

Whatever the corpus pipeline computes per position, it is simultaneously building the
item bank; nothing here commissions new data work.

### 6.3 Tiering

**Tier 1 — heuristic, no corpus needed.** Phase A = widest-CI stratum sampling over the
profile cells (phase × sharpness × motif-presence × |eval| band) on what
`calibration.rs` already has. Phase B's stream 1 is computable *today*: run the
tier-0/tier-1 evaluator at a few band/coefficient settings over candidate positions and
rank by spread — the selection machinery is the evaluator itself. On-demand selection
fits the measured ~2.4–3.7 s/position sampling cost (Phase 0 smokes: v1 sampler 20
positions in 48 s; v2 Elo-labeled sampler ~3.7 s/pos, both including Stockfish
scoring) — prefetch a few candidates while the user is thinking and the latency
disappears entirely.

**Tier 2 — corpus-backed.** Streams 2 and 3 come online with the mining tables:
per-cell coverage counts and per-coefficient error bars turn "what data do you need
more of" from a heuristic into a computed quantity — expected information gain per
label, maximized across the three streams.

### 6.4 No stopping rule — a diminishing-returns readout

Profile estimation completes; data collection doesn't. There is no "session complete."
Instead: a per-dimension **diminishing-returns readout** — "counting-depth data is
saturated at your level; long-range-threat positions are the current bottleneck" — and
the session budget spends itself on the scarcest data for as long as the user keeps
answering. The "100" is a budget, and the selector's job is to make every position in
it the most valuable one available. The profile display stays on the results screen —
the user enjoys it, and Phase A keeps it honest — but it is explicitly a **by-product**:
its CIs stop driving selection the moment they are tight enough for label
interpretability.

Caveat to record now, standard in adaptive designs and easy to forget later: **adaptive
selection biases naive averages.** Once items are chosen based on previous answers (or
on model needs), raw per-cell means no longer estimate what they did under the fixed
battery — aggregate statistics in the report must come from the model/posterior, not
from raw means over an adaptively-selected sample. Phase 0's scatter/MAE views stay
valid as-is only for the fixed-battery portion.

## 7. Performance budget

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

## 8. Risks and honest limitations

### 8.1 The 2000–2700 gap (biggest product risk)
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

### 8.2 "Moves a human PLAYS" vs "resources a human SEES"
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

### 8.3 Blitz bias
Maia-1 was trained on Lichess games whose time controls skew fast (the exact filter needs
verification from the KDD paper before we write it in user-facing docs). Implication:
Eval_R models perception under *quick-game* conditions and will underrate what the same
player finds with 30 minutes on the clock. Mitigations: the depth schedule d(R) doubles as
a deliberation knob (E5 measures it); long term, corpus filtering by time control lets us
fit a "classical correction". Stated limitation until then.

### 8.4 GPL and shipping
chessgui is GPL-3.0, so GPL-3.0 Maia-1 weights and GPL lc0 are compatible outright.
Shipping posture: **fetch-on-first-use** for weights (CSSLab release URLs, checksummed,
cached) and detect-or-`brew install` for lc0 — nothing GPL-encumbered is added to the
.dmg, downloads keep provenance obvious, and attribution (Maia/CSSLab, lc0) goes in the
About panel. If the app's licensing posture ever needs to change, the Maia-3/Apache path
exists.

### 8.5 Assorted
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

## 9. Summary of recommendations

| Question | Recommendation |
|---|---|
| Semantics | Tier-1: human-visible tree (minimax over top-p Maia-R candidates, Stockfish leaves). Tier-2 knob: expectimax temperature toward rollout semantics. Rollouts = validation ground truth, not runtime. |
| Perspective | Both sides at R, one slider, White-POV display; asymmetric R deferred to tier 3. |
| Skill profiles | General form is a phase vector R⃗ = (R_opening, R_middlegame, R_endgame); slider sets all three linked, advanced mode unlocks them. Conditioning switches per NODE at phase boundaries (calibration.rs heuristic: non-pawn weight ≤ 8 = endgame; ply < 16 = opening) — endgame-weak players evaluate trade-down lines worse. Player vectors estimated from per-phase error rates vs corpus band norms; calibration sessions are phase-resolved already. Phase-swapped Maia is an independence approximation — E6 tests it and gates the unlock UI. Endgame failures are a counting family (§5.3): difficulty tracks required-count-depth, not branching. |
| Inference | lc0 subprocess + Maia-1 nets over UCI (`VerboseMoveStats`, `nodes=1`), warm per-band pool. Verified end-to-end on this machine: 13 ms warm/query. No Python/ONNX in the shipped app for tiers 0–1. |
| Instant tier | Single-forward blend: weight SF eval by the Maia-R policy mass on SF's PV move; ~15 ms per slider stop. |
| Psychology coefficients | Attention load (E-attention: matched-pair mining via action-zone local Zobrist, bystander dose-response) and story-arch state (E-history: same-position/different-history via the existing `db.rs` Zobrist index, post-blunder degradation curve) modulate candidate breadth and expectimax temperature per node — measured laws, not Maia interpolation. Tier-2, corpus-gated; history term needs game context and degrades to position-only on bare FENs. |
| Validation | E1 outcome-prediction head-to-head (Brier, per band, complexity-stratified) is the killer experiment; E-attention and E-history follow immediately (they supply the tier-2 coefficients and are novel results standalone); E3 jump audit validates the perception curve; E2 ties divergence to real human error. Player-disjoint, post-2019 splits. |
| Adaptive elicitation | The battery is active learning FOR THE MODEL — the person is the labeler, not the measurand. Phase A: brief CAT-style profile lock-in (~10–20 positions) so labels are interpretable as a known-level human's perception; the profile display is a fun by-product. Phase B: items chosen by model need — evaluator-variant disagreement (computable today), corpus-coverage sparsity, §5-coefficient starvation. Corpus per-band miss rates ARE the item parameters (same numbers as 211 puzzle difficulty — one infrastructure, three consumers). No completion state: a diminishing-returns readout per dimension; the budget spends itself on the scarcest data. Report aggregates must be model-based once selection is adaptive. |
| Biggest risk | Rating coverage above 1900. Verify Maia-2/3 ranges; label high stops experimental; never fake the 2650 number. |
