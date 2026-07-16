# Last Session

**Date:** 2026-07-15 (full-day marathon: /start ~09:30 → checkpoint ~17:30; agent-team waves)
**Focus:** "Finish building all specs, build all personas." Platform stance decided; spec 218
born from dad-sim feedback + GPT mentor review triaged; persona engine built end-to-end;
15-persona fleet with harness scores; Arena Tier 0 staged on the homeserver; tournament lab
completed (round-robin, Elo, analysis suite); training loop closed. ~20 commits, all pushed;
app installed to /Applications.

## What changed
- **Platform (000)**: macOS/web/mobile/PC all first-class; macOS stays the test build. Web
  first via spec:217 (the dad honeypot).
- **Spec 218 (NEW)**: Bot Roster & Exhibition Play — six user decisions recorded (caricature
  avatars from public photos; one spec home; ship-now exhibition fidelity with honest labels;
  roster v1 = everything; flat kind-prefixed tournament dropdown; disclosure-not-consent,
  ToU deferred unless published). Glossary: rival/persona/bot/Participant.
- **Persona engine (214)**: canonical 9-step move-selection contract (GPT mentor review,
  triaged with user) + IMPLEMENTED: seeded tempered sampling over Maia/BT3 policy, SF
  verification reweight, temperature schedule (phase; clock live in runner), endgame arm
  (SF MultiPV at low material — dad's strength is exactly Maia's weakness), per-move decision
  logs, persona snapshots, merge_books.py (N-source: chess.com + arena + OTB-if-found).
  Style bias structurally OFF until the metrics harness gates it.
- **Persona fleet**: 12 public GMs (Fischer, Kasparov, Spassky, Karpov, 8 Icelandic incl.
  Gudmundur peak-slice) extracted + books + configs + FULL harness run (N=250: BT3
  move-match@1 50-64%, beats maia-1900 everywhere); 3 private rivals local-only (identities
  moved to gitignored data/rivals/identities.json after an agent hardcoded them — caught
  pre-push, amended).
- **Play vs Bot (ex Spar vs Dad)**: card roster, initials avatars, honesty gate
  (gatePersonaLevel — BT3 GMs play their real books at labeled ~1900 approximation in spar;
  full strength in Tournament), move numbers, back/forward review, counts-toward-training
  toggle.
- **Tournament (210/212/218)**: Participant dropdown (engines+personas, measured labels),
  exhibition view (watch Fischer-Kasparov in-app), round-robin + Bradley-Terry Elo ± SE,
  live streaming/buckets/conversion overlay/JSON export, full analysis suite (error profiles,
  band trajectories, termination quality, annotated Open-in-Analyze), result persistence.
- **Learn/Training (213/215/211)**: range elicitation (log-spaced, new sessions only),
  per-deck results, play-it-out with conversion verdicts (endgame_playout live), spar-results
  persistence + trajectory projection to the Florida milestone, monthly measurement pipeline
  (self_report scripts rescued from expiring scratchpad).
- **Arena Tier 0 (217)**: frontend /arena entry (login → family-sticker disclosure → lobby →
  game → history) + FastAPI backend STAGED on homeserver (chessgui-arena container, loopback
  :8017, lc0+BT3 built and sha-verified, per-move SQLite persistence, stall retry/respawn,
  allowlist). Smoke-tested: create → move → persona reply.
- **Mining (211)**: 20k-puzzle eval-cliff batch RUNNING on server (tmux mine211, engine
  re-verified, ~3.7k rows in month 1 at last check). Generator + importer committed and
  fixture-tested (23 tests).
- **Polish (011/200/001)**: engine cleanup on quit (orphan fix), PV click preview, Lichess
  explorer fallback, multi-DB switcher, performance ratings, ECO names, PGN import progress,
  Cmd+O. Tick-passes reconciled 210/014/001/213 checklists with file:line evidence.

## Post-checkpoint additions (before sign-off ~18:30)
- **Rake solver SHIPPED (c19a63c)**: puzzles table in app DB, many-correct grading with
  honest safe_unverified, animated rake-replay, Training rake_deck launches real decks.
  Import picker ready for the server's 20k batch.
- **Machine calibration rule (2daff06)**: every play surface needs its own 216 profile —
  homeserver bench DONE (1.53x laptop single-thread, +0.6 doublings; labels PRIOR until a
  server ladder); dad's future PC build = first-start auto-bench.
- **Hobby-server resource policy (f9b3b0d)**: engines low-priority always; interactive
  burst 4 cores, batch 2 cores niced, <=40% sustained; arena container re-cap 6->4 at next
  deploy touch.
- **DAD DISCLOSURE DELIVERED (31e3c18)**: full FB Messenger pitch (translation in spec:217)
  — consent concern CLOSED. Six promises now commitments: own-persona play (dad vs himself),
  first-person "I'd never do this" feedback (Tier 1 now), Fischer-Kasparov spectating
  (Tier 1), friend-on-request personas, the named 10-GM roster (already built+measured),
  the data flywheel.
- **wip commit 71db879**: wave-7 streams stopped at sign-off, tree green (524 JS + 117 Rust
  tests): 211 session flow, 213 adaptive Phase A + human-visible tree search
  (human_search.rs), 214 metrics/tuning tooling, error_model.py (server job staged in tmux
  error_model — verify it launched). NOT verified end-to-end — resume workflow
  wf_e197b321-658 (script in session workflows dir) or review each stream before building on
  it. Wave-6 metrics/auto-tuning agent died with the session mid-optimization
  (tuning_kasparov.json is partial output; tune_persona.py is committed — rerun locally).

## Known issues / open (user decisions + eyeballs)
1. **Arena latency**: BT3 ≈ 10s/move at 32 nodes vs 2s budget (spec:217 notes options:
   accept / onednn rebuild / smaller net). Then go-live steps: Caddy route, Google client ID,
   dad's email in ARENA_ALLOWLIST, container re-cap to 4 cores, deploy /arena frontend.
2. Mining batch finishing on server (tmux mine211) → import via the in-app puzzles picker.
4. USER EYEBALLS pending on ~everything shipped headless-only today: Play vs Bot roster,
   exhibition, persona engine feel (defaults untuned: temp 0.5, alpha 1.0, lambda 0.75),
   move numbers/review, range elicitation, play-it-out, training trajectory, arena mock flow.
5. Avatars: caricature pipeline blocked on image-generation capability (initials ship).
6. Librarian: 4 flags (3 cosmetic prose-form, 1 = 200-band gap question for user).

## Next session should start with
1. CODE FIRST (30 min): verify the wip commit 71db879 stream by stream — resume workflow
   wf_e197b321-658 (cached agents replay; the three local streams re-verify and tick specs)
   or hand-review; check tmux error_model actually launched on the server; rerun
   tune_persona.py for the wave-6 tuning that died mid-run. Rebuild + install app.
2. USER: eyeball pass in the installed app (Play vs Bot → dad-sim with the new engine;
   Fischer-Kasparov exhibition; calibration with range elicitation → play it out; Avoidance
   solver). Decision logs are joinable against "didn't feel like him" now.
3. Arena go-live (dad is PITCHED and waiting): latency decision → Caddy route + Google
   client ID + allowlist + re-cap container + deploy /arena → invite dad, first session
   assisted. Then the promised Tier-1 items: own-persona entry, first-person feedback,
   spectating.
4. Mining import when the batch completes; remaining big NOW items after wave-7 lands:
   211 solver session polish, 213 Phase-3 follow-ups, 214 auto-tuning acceptance runs,
   213 E-experiments on the server (serialize with mining/error-model).

---

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

