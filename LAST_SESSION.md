# Last Session

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
