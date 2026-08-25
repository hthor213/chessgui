# 214: Persona Simulator

**Status:** draft
**Depends on:** 210 (match runner/tournament), 213 (Maia plumbing), data/rivals (rival mode)

## Goal

Play against a *persona* — a named player's style rendered as an opponent — and watch
personas play each other. A persona is NOT the person (no cloud uploads of dads): it is
(a) an **opening book** weighted from that player's real games, (b) a **move policy**
matched to their strength — Maia nets for ≤1900, stronger backends above — and
(c) **style priors** measured from their games (simplification appetite, aggression,
time-of-collapse profile). The Hikaru-bot test, made quantitative: on held-out positions
from the player's real games, how often does the persona play the human's move?

## Why Fischer and Kasparov first

1. **Evaluation**: they have thousands of recorded games (already in the app DB via
   Lumbra) — enough to hold out hundreds of positions and measure move-match rate,
   opening-distribution fidelity, and ACPL profile match. Dad has ~45 usable standard
   games; personas must be validated where data is dense before we trust them where
   it's sparse.
2. **The exhibition**: Fischer vs Kasparov through the tournament tab. Nobody doesn't
   want this.

## Tiers

- **Tier 0 — dad-sim v0 (rival sparring)**: play-vs-engine where the opponent is
  lc0+Maia at the rival's level (dad: maia-1700/1800, `go nodes 1` per maia.rs) and the
  game STARTS from the rival's book (weighted sample from their real openings,
  data/rivals dossier lines). No style priors yet. Honest label in UI: "a 1750
  playing dad's openings".
- **Tier 1 — persona eval harness**: extract Fischer + Kasparov games from the app DB →
  held-out split → measure move-match@1/@3 for candidate policies (Maia levels for
  low-Elo personas; for 2700+ use lc0 full-policy and Stockfish-multipv-rerank blends).
  Report per-phase match rates. This tells us what a persona CAN capture before we
  promise anything.
- **Tier 2 — persona = book + policy + priors**: persona config format (name, book
  source, policy backend, strength, priors, avatar asset — privacy rules below) and
  its loader. This tier owns what a persona IS; how personas are SURFACED — the bot
  roster, Play vs Bot, exhibitions, tournament participation, avatars — is
  spec:218's domain.
- **Tier 3 — style priors that matter**: simplification appetite (trade-seeking bias),
  opening-phase fidelity vs middlegame drift, endgame automatics. Only priors that
  measurably improve move-match survive (no vibes-based parameters).

## Hard rules

- Never noise-weaken engines to fake humanity (Turing-test evidence, docs/research) —
  human-likeness comes from Maia-class policies and books, not random blunders.
- Personas of private individuals stay LOCAL (data/rivals is gitignored); only
  historical public figures (Fischer, Kasparov) may ship as bundled examples.
- Every persona carries its eval-harness scores in the UI — no unmeasured realism claims.
  Roster cards and exhibition matches show measured strength (spec:216 curve) the same way.
- The LOCAL rule above extends to avatar images (including caricature source
  photos) and roster metadata: a private rival's photo and personal details live in
  data/rivals (or app data), never bundled, never committed. Committed spec/UI text
  refers to "the private rival persona" generically — the spec:218 roster adds
  nothing about him beyond what this spec already discloses.

## Persona engine — the move-selection contract

**Origin:** GPT mentor spec review 2026-07-15, triaged with user. This section is the
canonical definition of how a persona selects a move. spec:218's persona arm (the
Participant enum) CONSUMES this contract and never redefines it; spec:217's server-side
personas run the same pipeline.

The pipeline, per move:

1. **Inputs**: current position, the persona snapshot (see "Persona snapshots" below),
   clock state (own + opponent), the game's RNG seed, and — Tier 3 only — opponent
   context (archetype conditioning, see Tier 3 additions).
2. **Book phase**: while the position is in book, play the persona's recorded reply,
   frequency-weighted across alternatives (shipped behavior — see the move-by-move
   rival book checklist item). The book is **N-source by design**: chess.com archives
   + arena games (the spec:217 flywheel) + OTB-if-found. Merge rules are specified up
   front so a new source slots in without redesign: per-source weights, recency decay,
   and time-control weighting. Honest note: dad's OTB chase found identity
   (FIDE-confirmed) but ZERO recorded game moves so far — skak.is and chess-results
   carry results and ratings, rarely amateur moves — so OTB is a designed-for, not yet
   existing, source.
3. **Out of book — policy sampling**: sample from the persona's policy backend (Maia
   band or BT3, per config) with top-k/top-p + temperature. The **temperature schedule
   varies by phase and clock**: opening low (book-like), middlegame higher, spikes
   under time pressure. A **style-bias window** applies for N moves after book exit:
   the persona's characteristic tendencies are overweighted while leaving theory.
4. **Verification reweight**: cheap Stockfish eval of the top k candidate moves;
   `final_score = policy_prob^alpha * exp(-lambda * eval_penalty)`; alpha/lambda are
   per-persona parameters. Keeps the human move distribution while suppressing
   non-human blunders — this formalizes the verification-search lesson from realism
   matches #1/#2.
5. **Corpus-derived error model**: from the 11M-game evals-on corpus, learn
   P(mistake | eval, phase, clock, Elo band); mistakes appear only with human-band
   timing. The hard rule stands: this is never random noise-weakening.
6. **Endgame arm**: at low material, switch backends — deeper filtered Stockfish (or
   tablebase when trivial), humanized through the same verification reweight — because
   Maia is weakest exactly where the primary rival is strongest (his endgame record at
   fast time controls).
7. **Draw/resign model**: the existing scripts/persona draw model is canonicalized
   here as part of the contract (visible-rule requirement from the spar-modes item
   applies unchanged). (Audit 2026-08-24: shipped reality is draw ACCEPTANCE only,
   via the visible material/quietness rule in apps/desktop/lib/spar.ts — the bot
   never resigns and never offers. The resign/offer arms are wave R3 below.)
8. **Determinism**: move selection is stochastic by design but SEEDED — a per-game
   seed is logged; the same seed + the same snapshot reproduces the game.
   (Audit 2026-08-24: the book phase breaks this — rival-book-lookup.ts samples
   with unseeded Math.random. Wave R1 folds the book draw into the seeded stream.)
9. **Per-move decision log**: policy probabilities, verification evals, the chosen
   move, and the reason arm (book / policy / verify-reweight / error-model / endgame).
   This is the realism-debugging record: "didn't feel like him" feedback joins
   against it.
10. **Think-time model** (added by the 2026-08-24 realism audit): every selected
    move also emits a think-time, computed from the decision the pipeline already
    made — no new search needed, the inputs are all in the step-9 decision log.
    Signals: candidate-weight entropy (one dominant candidate → snap move),
    forcedness (recaptures, only-moves, book replies → near-instant), eval swing
    vs the previous position (surprise → long think), phase, and remaining clock
    (compressed in time trouble; occasional deep sinks on critical middlegame
    decisions). Per-band distribution parameters, fit from corpus move-times where
    the source carries clocks (chess.com archives include clock comments), honest
    priors otherwise. The spar UI schedules the reply on this delay; unclocked
    spar uses the same model with a relaxed cap so tempo still reads human.
    (Status 2026-08-25: implemented as apps/desktop/lib/spar-think-time.ts,
    wired for book AND engine replies — wave R1.1 below. The uniform
    1s–5%-of-remaining draw in apps/desktop/lib/spar-clock.ts is the
    SUPERSEDED placeholder, no longer used by spar, kept only as the
    never-self-flag reference its own comments describe. Honest gap: the
    distribution table is one global set of priors — per-band parameters and
    the corpus fit have NOT happened, and ThinkTimeInput carries no band
    input yet; that fit is wave-R2-shaped open work.)

## Persona snapshots

A persona ships as an **immutable versioned bundle**: config + book build + weights
reference + sampling parameters. Every match and exhibition records the snapshot
version it played under; any prior/book/parameter change produces a NEW snapshot.
Reproducibility rule: same seed + same snapshot = same game.

## Human-likeness metrics & acceptance

Metrics, all measured on held-out splits:
- **move-match@1/@3** (the existing harness metric)
- **ACPL-profile similarity** (per-phase centipawn-loss shape, not just the mean)
- **error-TIMING similarity** (when mistakes happen — phase, clock, eval context)
- **opening KL-divergence** (persona's opening distribution vs the player's real one)

Acceptance bar for ANY engine or prior change: a measurable held-out improvement
(e.g. move-match@1 +2% absolute) OR an explicit user realism verdict from the shipped
feedback capture. An offline auto-tuning loop (optimize alpha/lambda/temperature/
priors against held-out) is a checklist item below.

## Tier 3 additions (mentor review 2026-07-15)

- **Opponent-ARCHETYPE conditioning**: condition on the opponent's style cluster +
  rating differential, trained on ALL games — per-specific-opponent data is
  insufficient (Fischer–Tal is ~11 classical games; Fischer never played Kasparov).
  Specific opponents get book-level flavor only. Testable exception: for the private
  rival, a light personal bias from his real games vs people he knows.
- **Sequence/plan coherence**: a 2–4 move plan memory biasing consistent follow-ups.

Both gated on the acceptance bar above, like everything else.

## Time model

Cross-ref spec:216 (machine speed / time-compression Elo model). Personas exhibit
human time behavior — the private rival moves fast — and the clock state conditions
the temperature schedule (contract step 3) and the error model (step 5). The
think-time side of this is now contract step 10; the clock-conditioning side is
dead in spar today because the UI never passes clock_ms (see the realism audit
below, wave R1).

## Realism audit — 2026-08-24

User verdict: the bots don't feel very realistic. Traced through the shipped code,
the finding is NOT that the architecture is wrong — the contract's selection
machinery is live and human-model-based exactly as specified (book →
Maia/BT3 policy head at `go nodes 1` → top-4 candidates ≥1% → SF depth-12 veto →
tempered softmax, persona.rs `select_move_from_policy`). The finding is that
**four of the five humanizing subsystems are inert in actual human play, while
every always-ON piece pushes play stronger and narrower than the labeled band**:

1. **No think-time model** — likely the single loudest tell. Clock off (the spar
   default): replies land as fast as compute allows. Clock on: a uniform draw in
   [1s, 5% of remaining] (spar-clock.ts), independent of position, phase, and
   eval. Never a long think on a critical move, never a snap recapture pattern.
2. **Clock conditioning is dead in spar** — the panic-temperature spikes and
   clock-bucketed error machinery exist and are tested, but the spar UI never
   passes `clock_ms` (spar-tab.tsx personaMove call), so against a human they
   never fire. They are live only in the engine-vs-engine match runner.
3. **Error model OFF everywhere** — built and fitted (error_model.fit.json), but
   the gating tuner run (stage D, +2% bar) never happened, so no config carries
   it. Result: mistakes are i.i.d. and rate-flattened by the λ veto — no
   clustering, no tilt, no time-scramble collapse. Human error is bursty; this
   is a Poisson sprinkle.
4. **Style bias OFF everywhere** — same unpassed gate. Out of book, two
   different 1500 personas differ only by book and seed; "style" today is
   openings-only.
5. **Always-ON pieces overshoot the band**: the endgame arm feeds depth-16
   Stockfish candidates to every band (a "1300" that shuffles a middlegame then
   converts R+P endings cleanly is a strong tell); the top-4/≥1% candidate cap
   makes off-policy moves — creative ones AND rare human lapses — unplayable;
   and all 12 committed GM configs carry the identical untuned defaults
   (T 0.5 / α 1.0 / λ 0.75 / top-4 / depth-12), so every persona shares one
   error personality.
6. **Contract drift, stated plainly**: step 7 claimed a draw/resign model that
   ships as acceptance-only (annotated in place); the Time-model section was
   aspirational (now step 10); book sampling breaks the step-8 seed story
   (annotated in place). This audit re-syncs the spec to reality; the plan
   below closes the gaps.

Surface note: the web arena (spec:217/221 server) runs a deliberately simpler
Tier-0 pipeline (visit head at nodes 120/16, T 0.30, no verify, no schedule, no
endgame arm, no error model). The user plays the DESKTOP spar (Learn → Play vs
Bot) — this plan targets the desktop pipeline; converging the arena onto the
same contract stays a spec:217 concern, cross-ref'd from here.

### The plan — three waves

**Wave R1 — wire up what's already built** (days, no new ML):

- **R1.1 Think-time model** — contract step 10. Small pure-TS function in the
  spar layer over the decision log the Rust core already returns.
- **R1.2 Pass `clock_ms` from spar** — one plumbing change activates the
  already-tested panic temperature and clock-bucket machinery.
- **R1.3 Band-scale the endgame arm** — depth becomes a function of band
  (e.g. ~1300 → depth 6–8, GM/BT3 keeps 16) and SF candidates BLEND with the
  Maia prior rather than replace it. A 1300 should botch endings at 1300-rate.
- **R1.4 Seeded book sampling** — fold the book draw into the per-game seeded
  stream so step 8 holds from move 1.

**Wave R2 — run the gated work that was specced but never executed**:

- **R2.1 Error-model enablement** — run tune_persona.py stage D per band and
  per persona against the corpus (the recovered 957k-game store raises the
  ceiling here); commit qualifying configs. The bar is unchanged: ≥ +2%
  absolute held-out match@1, or an explicit realism-feedback verdict.
- **R2.2 Tuner rerun** — per-band/per-persona α/λ/T + schedule multipliers +
  style-bias gates; wave 6 died with outputs untracked, so this time the
  tuning_*.json outputs and config updates are COMMITTED as part of the item.

**Wave R3 — new capability, all gated on the acceptance bar**:

- **R3.1 Tilt/momentum state** — a small per-game hidden state (recent blunder,
  worsening eval trend, time trouble) modulating T and λ for the next N moves.
  Cheap atop the error model; it is the missing "human collapses" dynamic —
  today every move is memoryless.
- **R3.2 Resign + draw-offer model** — contract step 7 made real, from the eval
  the verifier already computes, persona-conditioned (Fischer never offers;
  a club player resigns down a rook). Visible-rule requirement unchanged.
- **R3.3 Band-parameterized candidate width** — top-k/top-p become per-band
  config so weak personas can occasionally play genuinely off-policy moves.
- **R3.4 Match-runner books** — the runner's persona arm gets the opening book
  (match_runner.rs has none today), so Fischer–Kasparov exhibitions open like
  Fischer and Kasparov, not like BT3's taste.

## Data

- Fischer, Kasparov: app DB (Lumbra OTB). Extraction query by player name, dedup.
- Gudmundur Sigurjonsson (Icelandic GM, dad's old friend — the persona dad wants to play
  AT HIS PEAK, since the real friend has dropped in rating and grown shy of playing):
  401 games in app DB, 1968–2003; peak-era slice identified empirically (prior: GM 1975,
  peak mid-late 70s). The first PERSONAL persona with GM-density data — and the bridge
  use case: dad becomes a user. Cross-ref chessgames.com pid 37448 (reference only).
- Dad (Thorarinn Hjaltason, Icelandic amateur OTB): not in local DB (checked 2026-07-14,
  all spellings). Chase skak.is / chess-results.com for recorded games; expect rating
  history + results, few or no move records. chess.com: 45 standard + 339 Chess960 games
  (data/rivals).

## Checklist

- [x] Tier 0 (2026-07-15): rival book sampler (weighted from data/rivals PGNs) + maia_play command
      (lc0, go nodes 1, level param) + "Spar vs rival" UI entry from Learn or Play
- [x] Fischer/Kasparov (+Sigurjonsson) extraction (2026-07-15): from app DB → data/personas/ (gitignored is fine;
      public-figure games may be committed if useful)
- [x] Held-out eval harness (2026-07-15, results in data/personas/HARNESS_RESULTS.md — strong-engine policy beats Maia at every tested strength; BT3 = GM-persona backend): move-match@1/@3, per phase, per policy backend
- [x] Persona config format + loader (code-verified 2026-07-15)
- [x] Realism feedback capture (2026-07-15, user request; SHIPPED e158101 — plus
      confidence chips gut-feel/fairly-sure, never "certain"): "felt like him" /
      "didn't feel like him" buttons in the spar UI, tappable at any point during
      or after a game; the negative REQUIRES a free-text why, the positive makes
      it optional. Each entry stores verdict + note + game context (PGN so far,
      ply, level) locally (private data, never bundled/committed for private
      rivals). This is the ground-truth stream that style priors (below) are
      tuned and validated against.
- [x] Persona vs persona v0 (2026-07-15, script not match-runner): Kasparov 3.5-2.5 Fischer, data/personas/EXHIBITION.md
- [x] Dad OTB data chase (2026-07-15): identity confirmed (KR, b.1947, FIDE 2316668, standard 1591-converted), zero recorded games — dad-sim stays chess.com-book+Maia (skak.is, chess-results) — results/rating even if no moves
- [x] Spar modes + game controls (2026-07-15, user request; SHIPPED 6145613): mode picked at game
      start — "Serious spar" vs "Improve his personality" (probe). Probe mode
      adds an End game button (abort, no result, never counts toward metrics) for
      the stop→feedback→try-again loop; Resign and Offer draw exist in BOTH
      modes. Draw acceptance uses an engine eval if a one-shot eval command
      exists, else an honest material/quietness rule — either way the rule is
      visible in the UI (tooltip), never hidden dice. Probe mode states honestly
      that feedback tunes the NEXT persona iteration, not this game.
- [x] Move-by-move rival book (2026-07-15, SHIPPED 6145613, supersedes drop-into-line as default):
      spar starts at move 1; while the position matches the rival's real games
      the persona replies with his recorded reply (frequency-weighted across
      alternatives), then Maia takes over out of book. The drop-into-line start
      stays as a secondary option.
- [x] Style priors, gated on measured move-match improvement (code-verified
      2026-07-16: `tune_persona.py` Stage C searches a 30-candidate grid (5 move
      classes × mults 0.5/1.5/2.0 × windows 4/8 plies after book exit) on the tune
      half atop Stage-A/B params, judges once on the untouched test half, and only
      enables at ≥ +2% absolute match@1 (`STYLE_BAR`); `persona_sim.py` ports
      persona.rs StyleBias 1:1 with mirrored selftests; `emit_config_v2` writes
      `sampling.style_bias` only when the gate passes, else null)
- [x] Persona engine v1 (mentor review 2026-07-15; implemented same day — Rust
      persona_move: policy-head candidates, tempered softmax over
      alpha·ln(policy)−lambda·penalty, splitmix64 seeded per game+ply, decision
      log stored locally; spar out-of-book moves wired through it; 72 Rust +
      276 JS tests pass incl. a live-Stockfish verify test; NOT yet run
      end-to-end in the Tauri app — user eyeball pending; default params
      untuned, auto-tuning is its own item): contract steps 3+4+8+9 minimal —
      policy sampling with temperature, verification reweight, seeded determinism,
      per-move decision log
- [x] N-source book merge rules (2026-07-15): scripts/persona/merge_books.py —
      per-source weights × exponential half-life recency decay (half-life is an
      explicit manifest choice, never a hidden default; no date = no decay) ×
      time-control-label weights; entry-level date/TC override source-level;
      source labels are arbitrary strings so arena games (spec 217) slot in as
      source #2 without redesign; output stays a consumable book.json (float
      weights) + a merge-provenance block + per-entry per-source raw weights;
      fixture self-tested (--self-test). Factor VALUES ship neutral (1.0) —
      untuned until the metrics harness can measure opening KL.
- [x] Temperature schedule (2026-07-15): phase × clock in the shared Rust core
      (persona.rs TemperatureSchedule) — phase from calibration.rs's thresholds
      (endgame = non-pawn phase weight ≤ 8; opening = ply < 16), clock spikes
      at ≤30s/≤10s. CAVEATS, honestly: the spar loop is unclocked, so the clock
      dimension is only LIVE in the match runner (the mover's real clock feeds
      it per move); multipliers (0.6/1.0/0.8, ×1.5/×2.25) are untuned priors —
      auto-tuning item below. The post-book style-bias window (StyleBias: N
      plies after book exit, multiplier on v1 move classes capture/check/
      castle/pawn_push/quiet_piece) is implemented + tested but OFF by default
      everywhere per the hard rule — the metrics harness gates turning it on,
      and the spar UI doesn't pass book-exit ply yet. Effective temperature +
      phase + bias flag land in the per-move decision log.
- [x] Corpus error model: P(mistake | eval, phase, clock, Elo band) from the
      11M-game evals-on corpus, human-band timing only (contract step 5) —
      (code-verified 2026-07-16): fitted surface shipped
      (scripts/persona/fit_error_model.py: hierarchical empirical-Bayes
      shrinkage global→band→phase→clock→cell + support-weighted 1-2-1 kernel
      on the eval axis, TOTAL 3×20×7 grid per band, 10 selftests; output
      data/personas/error_model.fit.json). Runtime mix wired in persona.rs
      (`sampling.error_model`, decision log carries the arm) with a 1:1
      Python port + mirrored selftests in scripts/persona/persona_sim.py.
      OFF by default everywhere per the hard rule — enablement is
      tuner-gated: tune_persona.py --error-model stage-D arm searches
      rate_scale on the tune half, judges once on the untouched test half,
      writes the config only at ≥ +2% absolute match@1; that qualifying
      tuner run has not happened yet.
- [x] Endgame arm (2026-07-15): at non-pawn phase weight ≤ 8 the candidate
      source switches to fixed-depth (16) Stockfish MultiPV top-4, humanized
      through the SAME reweight — each SF candidate's prior is its Maia policy
      prob, floored at 0.01 for policy-unseen moves — reason arm "endgame" in
      the decision log; wired into BOTH spar persona_move and the runner's
      persona arm via the shared core (defaults ON in both); degrades to the
      policy arm when Stockfish is missing. No tablebase branch: the ≤7-man
      probe is a network call per move (not "cheap"), and depth-16 SF already
      plays trivial endings correctly — revisit if a local TB lands. (Note,
      2026-07-16 audit: `tablebase_probe` shipped in the analysis panel
      per spec:900, but it queries the Lichess online tablebase API, not a
      local Syzygy install — the "network call per move, not cheap" reasoning
      above still applies as written; see checklist item below for the
      re-evaluation this trigger actually calls for.)
- [x] Metrics harness + auto-tuning loop: move-match@1/@3, ACPL-profile,
      error-timing, opening KL on held-out splits; offline optimization of
      alpha/lambda/temperature/priors against them (code-verified 2026-07-15)

### Realism waves (audit 2026-08-24) — priority order within each wave

- [x] R1.1 Think-time model (contract step 10; 2026-08-25): pure-TS over the
      decision log — apps/desktop/lib/spar-think-time.ts (candidate entropy,
      forcedness, eval swing vs the persona's previous decision, phase, clock
      compression), applied to book AND engine replies, unclocked spar too;
      the sampled think-time + the rival's clock at decision time land in the
      step-9 decision log so tempo feedback can join. HONEST GAP (open): one
      global prior table, no per-band parameters, no corpus fit yet — see the
      step-10 status note above.
- [x] R1.2 (2026-08-25) Pass clock_ms from the spar UI to persona_move
      (spar-tab.tsx) so panic temperature + clock-bucketed behavior fire
      against humans.
- [x] R1.3 Band-scaled endgame arm (2026-08-25): bandSamplingParams
      (lib/persona.ts) — depth ≤1200→6, ≤1500→8, ≤1900→10, full-strength/BT3
      16; SF candidates UNION with policy-only extras scored by the verifier
      so the Maia prior blends rather than being replaced (persona.rs).
- [x] R1.4 Seeded book sampling (2026-08-25): the whole rival turn (book
      draw + think-time) draws from one mulberry32 stream seeded off
      (gameSeed, ply) — rivalTurnRng in lib/seeded-rng.ts; Math.random is
      gone from the reply path.
- [x] R2.1 Error-model enablement measured (2026-08-25, homeserver run):
      tune_persona.py stage D ran for all 12 committed GM personas against
      error_model.fit.json — NO persona's rate_scale beat the no-model
      baseline on the tune half, so the error model stays OFF everywhere,
      now as a measured verdict (recorded per persona in HARNESS_RESULTS.md)
      instead of an unrun gate. Re-measure after the think-time corpus fit
      and against clock-conditioned spar data (the fit's clock axis finally
      gets live data now that R1.2 shipped).
- [x] R2.2 Tuner rerun (2026-08-25, homeserver; absorbs the 2026-07-16
      "Rerun tune_persona.py" item): stages A–D over the 12 committed GM
      personas, 250 held-out positions each, seed 214214 — tuning_*.json ×12
      + HARNESS_RESULTS.md COMMITTED this time. Honest outcome: 11 of 12
      failed the +2% bar (untuned defaults stay, with evidence); ONE gate
      passed — johann-hjartarson's style prior (quiet_piece ×2.0, 8 plies
      post-book, +2.4% held-out) — config.v2 promoted into the live slot,
      and the config→spar plumbing for style_bias/schedule (roster +
      samplingParamsFor) shipped with it. Tooling made seat-portable:
      eval_harness.py paths overridable via CHESSGUI_NET_SCRATCH /
      CHESSGUI_LC0 / CHESSGUI_STOCKFISH (BT3 net staged at
      ~/chess/strongnet, sha-verified). STILL OPEN: the private rival ("dad")
      — his data/rivals dossier exists only on the Mac seat; run
      `--personas dad` there. R3.1 tilt constants were NOT measured by this
      run (stage grid doesn't cover them) — still open under R3.1.
- [x] R3.1 Tilt/momentum state modulating T and λ (2026-08-25):
      lib/spar-tilt.ts, per-game hidden state (recent blunder / worsening
      trend / time trouble), multipliers logged per move. GATING DRIFT,
      stated plainly: ships always-ON in spar with hand-tuned constants
      (T ×1.3–1.6, λ ×0.6–0.7) and no per-persona config gate — the
      acceptance-bar run this wave's header requires has NOT happened; the
      R2 tuner rerun must measure it or grow the config knob to back it out.
- [x] R3.2 Resign + draw-offer model (2026-08-25): lib/spar-etiquette.ts,
      from the verifier's own evals, visible rules (tooltips on the end
      state / offer prompt), one offer per game, never in book. HONEST GAP
      (open): conditioned on fullStrength only, not per-persona — "Fischer
      never offers" needs config knobs that don't exist yet; same
      acceptance-bar caveat as R3.1.
- [x] R3.3 Per-band candidate width (2026-08-25): top_k + policy_floor in
      bandSamplingParams (≤1300 → top-6/0.005, ≤1600 → top-5/0.008, else
      top-4/0.01), wired in spar, playouts, and the tournament roster.
      NOTE: in spar the band table is deliberately spread AFTER the config's
      sampling overrides (all committed configs carry identical untuned
      defaults) — flip that order when R2.2 commits tuned per-persona values.
- [x] R3.4 Match-runner persona arm gets the opening book (2026-08-25):
      PersonaBook + seeded book_decision (reason arm "book", book sha in the
      snapshot id; zero-node/wrong-shape JSON honestly degrades to bookless)
      in match_runner.rs, wired end-to-end — the private rival's roster
      entry forwards the path his book actually loaded from (`rival_book`
      now reports it) as `bookPath`, and GM personas resolve the committed
      data/personas/<slug>.book.json by participant id runner-side, so
      Fischer–Kasparov exhibitions open like Fischer and Kasparov.

### Later / uncaptured requirements (audit 2026-07-16)
- [ ] Opponent-archetype conditioning (+light personal bias); 2-4-move
      plan-coherence memory; gated on acceptance bar. (214:129-138)
- [ ] Immutable versioned snapshots; matches record version; seed+snapshot
      reproduces. (214:109-114)
- [ ] Spar UI passes book-exit ply so the style-bias window can be enabled
      once the metrics harness gates it. (214:222-224 caveat in ticked box)
- [ ] Tune source/recency/TC weights (ship-neutral 1.0) once opening-KL is
      measurable. (214:213-214)
- [ ] Re-evaluate the persona endgame arm's no-tablebase decision now that
      `tablebase_probe` (Lichess online API, not local) exists in the
      analysis panel; wire in a local/bundled TB path if one becomes cheap
      enough for per-move use. (214:237; 900:18)
- [ ] E2E Tauri + user eyeball on persona v1 (contract steps 3+4+8+9).
      (user-blocked: needs the user in the app) (214:201-203 "user eyeball
      pending" in ticked box)
- [ ] If more OTB depth is wanted on the private rival: skák.is archived
      lists, chess-results manual browse, Wayback. (dad_otb_research.md)
- [ ] Materialism prior candidate: mine accept/decline on material offers;
      gate on held-out move-match. (dad_persona_feedback.md)
- [ ] Compactness/risk-aversion prior: measure early pawn advances past
      rank 4 + concession rate vs Maia-1700; middlegame marked realistic —
      DO NOT touch. (dad_persona_feedback.md)
- [ ] Personalized per-player modeling (Maia4All, ~20 games) — later-path
      owning item. (prior-art concl. 3; elo-design §8.2)
- [ ] Unified Phase-9 mistake taxonomy: per-band taxonomy deliverable — bot
      errs for HUMAN reasons (candidate-set omission, not noise), currently
      spread across 211/213/214. (memory chessbase-parity moonshot)

## Cognitive-gate pipeline proposal — evaluated 2026-07-17

A user-supplied design ("Cognitive Humanizer Pipeline": multi-Elo Maia
candidate harvesting → depth-throttled "horizon" search per band →
shallow-vs-deep WDL differential to find band-invisible traps → persona
style faders) was evaluated against what already exists. Verdict, so no
future session re-litigates it:

**Already built (proposal converges with the architecture):**
- Steps 1–2 are substantially `human_search.rs` (Eval_R): Maia-policy
  candidate generation IS the human perception filter, bounded tree depth +
  fixed-depth SF leaves IS the horizon — more principled than raw
  depth-throttled Stockfish, because the candidate set (not the depth knob)
  carries the band's blindness.
- Step 3's "trap invisible to the band" is spec 213's "visible from ~R"
  mistake labels (213 checklist, Eval_R pass in the tournament evaluator).
- Step 4's faders are the wave-14 tuner-gated persona wiring plus the
  style-prior mining items already queued (materialism/compactness priors).

**Adopted (new, actionable):**
- **Depth-differential puzzle difficulty**: for each mined puzzle, find the
  minimal SF depth at which the trap's refutation registers; store it as
  `visible_from_depth` on the puzzles table. Serves spec 211/224 finer
  difficulty. HONESTY GATE: depth is a *prior*, not a rating — the
  depth→Elo mapping must be calibrated against Tier-2 band miss-rates
  before any UI claims "2100+ puzzle" (213's measured-not-vibes rule).
- **Multi-band Maia candidate harvest** in `persona_move`: query the
  persona's band ± one neighbor and pool candidates before the tunable
  faders pick — widens the human candidate set without synthetic lines.
  Design lands in the move-selection contract; implementation follows the
  managed-net port (spec 218 queue item) so both touch persona.rs once.
- **Expected-score (WDL) space for cliff grading** in `mine_cliffs.py`
  Tier-2: a fixed centipawn cliff threshold over-counts cliffs in decided
  positions and under-counts them near equality; win-prob conversion
  (packages/core/src/win-prob.ts is the reference curve) normalizes this.
  Fold into the Tier-2 methodology (gated on the mining sign-off).

**Rejected:**
- Replacing the corpus-fit error model (error_model.fit.json) with pure
  depth throttling — the measured model already encodes band-conditional
  blunder rates from real games; depth throttling is the weaker proxy the
  proposal itself argues against.
- The fixed "Depth 6 casual … Depth 14 Masters" mapping — unvalidated;
  any depth↔band mapping must come out of the E1/corpus experiments.

## Open questions

Resolved 2026-07-15 — the 2026-07-15 feedback batch (roster, avatars, exhibition,
review nav, move numbers) and all six of its open questions were consolidated into
spec:218; the decisions are recorded there under "Decisions".
