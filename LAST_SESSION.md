# Last Session

**Date:** 2026-07-14/15 (day session + overnight /loop, ~14:00–02:45)
**Focus:** Coach fixed and grown into a dialogue; sampler v3; the 11M-game corpus built;
rival mode (dad + 4 others analyzed); persona simulator (Fischer/Kasparov/Sigurjónsson);
Operation Florida training program, on paper AND as an in-app Training tab. 30 commits,
all pushed; app installed to /Applications.

## What changed
- **Coach (spec 213)**: root-caused "Coach unavailable (request failed)" — v1 sessions
  lack to_move; serde rejected every invoke before the API call. Fixed at coachInputFor
  (derive from FEN), regression-tested both sides of the boundary. Then three prompt
  guards from live feedback (absolute pawns not ratios; input-grid granularity; no
  positional stories for tactically-justified moves — the ...b5 case, engine-verified).
  NEW: rebuttal dialogue — user replies to the note, coach_followup answers once,
  grounded; both stored on the answer (new fields, normalized on upgrade).
- **Learn UX**: X/✓ commit flow (move+eval required, why optional), ✕ take back with
  real board reset, second-look step retired, chrome fonts bumped, deck chip
  reveal-only (anchor leak caught in review).
- **Sampler v3 (spec 213)**: four training-value decks (conversion 30/critical 25/
  endgame 25/level 20), deck chips, PV capture (6 plies SAN) → coach can cite lines.
- **Corpus (spec 211)**: four user decisions taken (8-TC broad — exact set recovered
  from transcript and now IN the spec; 200k/band per-month; 10M games). Built on the
  homeserver: **11,008,005 games / 36.2 GB / 8 months**, all verified; reference slice
  elo≥2000 = 1,828,465 games. TAIL RULE: top usable band 2300+/2400+ merged. Raw .zst
  kept; 294 GB free. build_reference_pack.py fixed on main (202d5e3) — server checkout
  predates it, git pull there.
- **Research**: ChessBase usage study → vision now NINE modules (added Tactics Training
  + Game Review; rejected dossiers/repertoire-SRS/tablebase-UI). Improver consensus:
  tactics volume + engine-LAST own-game review carry 1200→1900.
- **Rival mode (BACKLOG + data/rivals/, all gitignored)**: fetched chess.com archives —
  dad (Thorsenior2+thjaltason, identity confirmed: Þórarinn Hjaltason, b.1947, KR,
  traffic engineer, FIDE-conv 1591; lore-corrected real level ~1600 FIDE), user
  (hjaltth, 1224 games), father-in-law, neighbor, gunnargunn. Dossiers + self-report
  with distraction filter (40 non-games, all losses). HEADLINES: user's move quality
  ~1200-1300 lichess (rapid IMPROVING ~1100→1300), displayed 537 is conversion+clock
  not selection; endgame conversion 42% vs 50.4%; dad's opening-depth story BUSTED
  (losses: 1 opening/7 middlegame/5 endgame; his EG record 12-4-2 at 10s/move —
  correspondence blitzer). Anti-lines: Rossolimo/Moscow/Italian.
- **Personas (spec 214, NEW)**: Fischer(322)/Kasparov(1637, classical view 1375)/
  Sigurjónsson(401, peak 1975-78) extracted+split (committed — public figures). Eval
  harness MEASURED: strong-engine policy beats Maia at every tested strength; BT3 ties
  SF at 10x cheaper = GM-persona backend; Maia stays right for amateur levels. First
  exhibition: **Kasparov 3.5–2.5 Fischer**. Spar vs Dad SHIPPED (Learn sub-tab,
  Maia 1500-1900 selector, dad's book local-only).
- **Training (spec 215, NEW)**: Operation Florida plan (data/rivals/TRAINING_PLAN.md,
  private) — user promised to beat dad (max ~1550 FIDE) at Christmas in Florida; target
  ~1500-1550 lichess by mid-Dec; 3 phases; clocks-with-increment match protocol. Tier-0
  Training tab SHIPPED: Road-to-1900 bundled (privacy-clean), Today/Program/metrics/
  milestone, launches real features.

## Known issues / open
1. Range elicitation (spec 213 Phase 0) designed but NOT built — next-session boundary
   feature alongside v3 sessions.
2. Spec 211 tier-1 eval-cliff generator: corpus is ready on the server; generator not
   started. This is the Training tab's missing rake_deck exercise.
3. Play-it-out (211/215 tier 1) not built — the endgame_playout exercise renders as
   check-off only.
4. Librarian: 3 flags pending.
5. User eyeballs pending: Spar vs Dad live game, Training tab start + milestone overlay
   (check the baseline row renders), v3 calibration session, coach dialogue on-device.
6. Offered, not confirmed: estimated-band readout on results screen.

## Next session should start with
1. USER: play one Spar game vs dad-sim + start the Training program (set the Florida
   milestone in the overlay) + begin a fresh v3 calibration session. Report coach
   dialogue quality + spar realism.
2. CODE: spec 211 tier-1 eval-cliff generator against ~/chess-corpus/months/*.pgn on
   the homeserver (rake decks unlock the training program's core exercise), then
   play-it-out, then range elicitation. /librarian for the 3 flags.
3. SERVER: git pull in ~/code/chessgui (picks up build_reference_pack.py fix).

---

**Date:** 2026-07-14 (overnight autonomous /loop session, ~00:30–05:15)
**Focus:** User's calibration position-9 sequence analysis; board-flip fix; then an
agent-team sweep of every outstanding topic — explorer polish, CBH import UI, spec 212
tier-1, librarian, and the full spec-211 corpus pipeline + server staging.

## What changed (6 commits, all pushed; debug app installed to /Applications)
- **Learn:** calibration board now shows side-to-move at the bottom (39fc580) — reverses
  the old "always White so + = White" choice; eval signs stay absolute. Headless-verified
  both directions.
- **Database:** opening explorer auto-updates on position change (200ms debounce) and
  explorer moves are click-to-play on the game tree (7591e08). In-app ChessBase import:
  `db_import_cbh` command + native picker + progress bar (049a739) — compile/unit-verified;
  the picker→progress→banner flow still needs one manual run against a real .cbh.
- **Spec 211:** `scripts/mining/` corpus pipeline (ff30527) — streaming filter, band caps,
  idempotent month loop, cap tuning; fixture-tested end-to-end.
- **Spec 212 tier-1:** `lib/win-prob.ts` + 21 tests (b4b937d) — map-derived isotonic
  win-prob curve, swing labeling. Checklist items 1–2 ticked; gaps noted in spec.
- **Librarian:** 4 convention flags fixed (42602ad); 200-band gap flag left (likely reserve).
- **Chess analysis delivered:** position 9 — user's +1.0 vs engine +0.91, but 18.Qe4
  (played) → −0.13 vs 18.Ne4 +0.78; the miss was 18...dxe5! (opens d-file so Qd7 defends
  d5, wins the tension) then 19...Qe6! gaining tempo on the queen. Lesson recorded:
  knight-before-queen into shared strong squares; check opponent pawn-captures before
  "forcing" queen moves. (User's screenshot never attached — reconstructed from the
  session's localStorage.)

## Homeserver state (staged, HOLDING — recon agent standing by)
sf_18 BMI2 (`~/bin/stockfish`, bench-verified) + pgn-extract installed; repo pulled;
2026-05 + 2026-06 dumps (~58 GB) in `~/chess-corpus/raw/`; tuning tables in
`~/chess-corpus/tune_*.out`. **Four decisions needed before the month-loop build**
(full tables + rationale in spec:211 "Mining corpus status"):
1. TC scope: strict 4-TC (~526k games/mo, caps useless, ~19 mo to 10M) vs broadened
   8-TC rapid+classical (~1.58M/mo, 100k cap flattens 1400–2000). Broadened recommended.
2. Cap N under broadened: 100k (≈12 mo) vs 200k (≈7 mo).
3. Per-month vs corpus-cumulative caps.
4. Games vs GB target: 10M games ≈ 33 GB at real 3.3 KB/game — "50–60 GB and ~10M games"
   can't both hold.

## Next session should start with
1. User answers the four corpus decisions above → ping/redispatch the homeserver agent to
   run the month loop (raws already staged; `scripts/mining/README.md` has invocation),
   then the reference slice (elo≥2000 subset).
2. User manually tests CBH import in the installed app (Database tab → Import… →
   "ChessBase (.cbh)…", e.g. Testsets/nunn.cbh) and eyeballs the flipped Learn board +
   explorer click-to-play on real data (only mock-verified).
3. User continues calibration (position 10+) and actually invokes the AI coach (tonight's
   9 answers all have coach:null) so its verbatim quality can be reviewed.
4. Also open: cancel button for CBH import, evaluator PV plumbing for bestMoveGapCp +
   per-move clock persistence in match_runner (spec 212 gaps), spec 212 UI (checklist
   item 3), missing-image follow-up if the user wanted more than position 9 discussed.

---

**Date:** 2026-07-13/14 (one marathon session)
**Focus:** The ChessBase-replacement roadmap — researched, planned, and Phases 0–3 largely
built; plus the spec-213 Elo-conditioned evaluator (design + tier-0) and the Learn-tab
calibration system with the user as ground-truth labeler.

## What the system does now
ChessGUI is a chess workbench: **Play/Analyze** (variation tree, annotations + eval graph,
PGN round-trip, engine settings/arrows, take-back, captured trays, tier-0 **Elo eval slider**
1100–1900 via Maia-over-lc0); **Tournament** (neutral third-engine evaluator, live viewer
with eval bar + stop/pause/auto-start-gate/ply-nav/move-delay controls, per-game + averaged
eval graphs, game browser, play-current-position-out); **Database** (955,819 games — user's
Mega via new clean-room CBH importer + Lumbra OTB + TWIC — SQLite, Zobrist position search,
dedup proven cross-source); **Learn** (eval-calibration sessions: stratified known-Elo
positions, eval+why+move elicitation, think-time with honesty button, second-look revision,
post-answer reveal with **Opus AI-coach** reading the user's reasoning + cause tags,
per-phase results, resume-across-days). Version 0.3.0; `scripts/install-app.sh` keeps
/Applications current on every build.

## What changed this session (highlights; ~30 commits, all pushed)
- Roadmap researched by agent fleet (community/features/formats/legal) → full plan at
  `~/.claude/plans/then-we-are-going-witty-kazoo.md`; data strategy v3 (3 corpora, recipes
  CALIBRATED against real Lichess dumps; Caïssabase dead → Lumbra; mining corpus = elo≥1400
  rapid+classical evals-on band-capped 50–60GB; reference pack = its elo≥2000 slice).
- Specs 016 (game tree) IMPLEMENTED, 011 closed, 013 + 202 implemented, 200 backend+UI+data
  pipeline, 210 evaluator/viewer/controls; NEW specs 211 (avoidance puzzles), 212 (tournament
  game analysis), 213 (Elo-conditioned evaluator + deep design doc incl. perception
  psychology, phase vectors, model-driven adaptive elicitation).
- CBH importer (`src-tauri/src/cbh.rs`, clean-room): 99.9995% of the user's 606k-game
  ChessBase DB converts; Mega imported into the app DB.
- Research: mistake-mining prior-art survey (`docs/research/`) — our cause-labeled method
  appears unpublished; Maia licenses compatible; never noise-weaken engines (Turing-test
  evidence).
- User's calibration: 8/100 positions answered; emerging signature = sound move selection,
  inflated eval scale, branch-selection optimism (pos-8 minimax error, engine-verified).
- Tests: 23 → 172 JS + 38 Rust. Every UI feature headless-verified (Playwright); build
  gotchas documented (dist/dev corruption, cargo-clean rlib fix, key-handler input guards).

## Known issues / open
1. **Homeserver unreachable** (VPN down, laptop on 192.168.0.x) — blocks: capacity recon,
   corpus builds (mining + reference), canonical-DB deploy. First unblock when VPN returns.
2. Band-cap N needs a tuning run on 2–3 recent full months before the corpus build.
3. Live-engine eyeballs pending (user): tournament evaluator end-to-end, pause/clock-freeze
   feel, Elo-slider divergence on real positions, AI-coach note quality on position 9+.
4. Calibration endgame coverage thin pre-v2 sessions; sampler v2 fixed it for NEW sessions.
5. Librarian: 5 flags pending (new specs + duplicate legacy numbering) — run /librarian.
6. .2cbh format has no open reader (watch); Lumbra fetch = personal-use license (never
   redistribute; commercial use needs a license).

## Next session should start with
1. If VPN is up: homeserver recon (re-dispatch the homeserver agent) → corpus build plan
   (band-cap tuning → mining-corpus month loop → reference slice) — this unblocks spec 211
   Tier-1 generation, 213 validation experiments E1/E-attention/E-history, and Phase 9.
2. User continues calibration (position 9+, now with AI coach); review the coach's verbatim
   quality on their answers — tune the prompt if it freelances beyond the engine lines.
3. Smaller: in-app CBH import UI (`db_import_cbh` command + picker), opening-explorer
   auto-update/click-to-play polish, /librarian sweep, spec 212 tier-1 (win-prob labeling —
   evaluator data is already flowing).
