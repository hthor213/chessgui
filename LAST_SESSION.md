# Last Session

**Date:** 2026-07-20 → 22 (multi-day marathon on /loop + workflows, then live UI iteration)
**Focus:** Two features built end to end with the user — spec 219 F (the live
position: a fair-play game that knows where it actually is) and spec 226 (the
Notebook: minimax with a person as the evaluation function). 14 commits, all
LOCAL/UNPUSHED. App rebuilt+installed ~15×. Tests 1101 → 1389.

## What shipped

**219 F — the live position.** chess.com publishes ongoing daily games, so the
board stops asking the user where the game is: sync replays the real move list,
pins a `liveNodeId`, prunes dead branches behind it, derives `myColor`. Moves
refused behind live; stepping back is REPLAY, not a refusal. Fair-play games
drop to chess.com's two-column shape (board + tabbed panel), affordable only
there because the third column holds engine surfaces the lockout hides. Late
fix: a Chess960 game set up on the WRONG rules (standard interpretation, no
castling rights / variant) was hiding castling from the user's own legal moves
the whole game and reporting the opponent's O-O as a divergence — now rebuilt
from chess.com when the foundation disagrees (`1c9f3a5`).

**226 — the Notebook (sections A–L, J, H, E, I, K).** Assessments as NAGs (one
keystroke), strict minimax backup, coverage against the user's OWN candidate
list, opponent likelihood, lexicographic ordering (objective → practical →
Copeland → exploration), pairwise head-to-heads with recorded reasons, compare
mode with two boards. The game archives PURE; the notebook extracts to its own
training store (gated two layers, inverted default — it holds engine verdicts
joined to positions). Post-game diagnosis splits "played badly" into blind spot
/ misjudgement / selection error / opponent-model error. Sharpness. The
Candidates table (Kotov's list, sortable, no default sort). No mainline past
the live position — the branches are peers. Tree navigation: retreat to branch
head, jump to best line, and ghost re-walk (the piece you played slides out and
back as a shadow, origin dims).

## The load-bearing ideas (in specs 219 F, 226, with reasoning attached)

- **The axiom (user's word):** *"If I'm bad at chess, I deserve to lose."* The
  app may DISPLAY state; it may never RECOMMEND. No legal-move list, no
  suggested move, no "look here". Coverage is against the user's own candidates
  precisely so the gap between what they saw and what mattered survives — that
  gap is the training signal.
- **The Notebook Doctrine:** no engine verdict reachable at machine speed.
  Content can be anything; RETRIEVAL is constrained. The friction is
  load-bearing.
- **Effort is not quality:** the same law drives sharpness, branch width, AND
  the fact that retreat stops at the branch head (not at forks — forks mark
  where you flailed). Nothing navigates or ranks by effort.
- **Revealed preference:** the move you PLAYED outranks the symbol you typed.
  A gap between them is analysis-vs-intuition, which the engine breaks three
  ways — not a scold.
- **Two artifacts:** the game is a shared fact (archived pure); the training
  record is about the player (private, its own store).
- **Nothing over the board** (rejected twice); **no UI text below 13px.**

## Bugs the adversarial audits / the user caught (all "quietly wrong")

hope-chess through the practical axis; the practical tie-break inverted for a
Black player; imported NAGs counting as the user's judgement; a second door
into the games table via db.saveGame; the purity guard missing variations/NAGs;
sync-appended moves looking like the user's own candidates; the Candidates
table self-granting a width-sort exemption; the prune eating the training
record; the diagnosis assuming the notebook drove every move; and the 960
wrong-foundation board. Also a 202 correctness fix (mover colour from FEN, not
ply parity — was scoring blunders as brilliancies).

## NOT VERIFIED BY THE USER'S EYE

The whole Notebook was built while the user was away; they have since eyeballed
and confirmed: the live sync, the two-column layout, the peer move list, the
960 rebuild, and the ghost re-walk feel. Still unconfirmed on screen: the
Candidates table, compare mode, and the post-game review. Green tests are
evidence of logic, not legibility — three UI rounds this session came back on
code that passed its tests.

Checklist artifact: https://claude.ai/code/artifact/d4e05050-4062-4550-ac9d-845b4647be18

## User's own read at checkpoint (2026-07-22)

*"We have a good fair-play feature, but missing the x-factor (I think —
everything I asked for is working, but I feel there is something missing) — but
then there is the rest of the application: the training, the databases, and
everything else in the vision."* So: fair-play is functionally complete and the
user wants to PIVOT to the rest of the vision (spec 000). The "missing x-factor"
is a real open question, not a bug — worth a fresh-eyes design pass, but not the
priority.

## Next session

1. **`git push origin main`** — 14 commits waiting (the whole fair-play + Notebook body).
2. **Pivot to the vision (spec 000):** the user named training and databases.
   Read specs/000-vision.md fresh and pick the next big rock — likely spec 200
   (database & opening explorer) or spec 215 (training program), both draft.
3. **The x-factor question** for fair-play: parked, not dropped. If it surfaces,
   it's a design pass, not a fix.
4. Deferred in 226, specified but unbuilt: the "I'm worse, play for chances"
   mode; conjoint fit over the preference log; `chosenBy` capture at move-commit
   (until then selection errors never fire); wiring the nav to keys (it's on
   buttons); the position editor detecting a 960 arrangement at setup.
5. Older backlog untouched: TournamentRunner/EngineProvider refactor (220),
   anti_line_drill (215), ResultsExplorer port, mobile triage (223), the 19
   user decisions from 2026-07-17.


---

**Date:** 2026-07-17 (overnight marathon: /start ~22:00 → checkpoint ~05:00; diagnose → /loop + workflows)
**Focus:** User-reported hangs diagnosed and fixed; then "/loop all remaining specs" — four
parallel implementation batches (20 items) + a session-wide adversarial review (11 verified
fixes). ~25 commits on main, app rebuilt+installed 6×. PUSH BLOCKED: gh token lacks
`workflow` scope (pc-build.yml) — user must run `gh auth refresh -s workflow`, then push.

## What changed
- **Two freeze bugs, one root** (200): launch hang = v4 material backfill (956k games, one
  transaction) inside Db::open behind the DbManager mutex → removed from open path, batched
  + resumable; out-of-process tools/material-backfill ran the million games in ~6 min (user's
  homeserver plan descoped: measured 23k games/s made it a laptop job). Continue-later hang =
  Database-tab mount: search_position ORDER-BY sorted ~1M start-position rows (10.4s→0.01s)
  + stats() COUNT over 38M rows (8.4s→db_counts cache). Post-mortem + read-pool/FTS5/lock-
  alarm ideas in BACKLOG.md.
- **Fair-play games** (219): terminology unified (user pick); delete now clears the board —
  never silently unlocks the engine on a still-loaded ongoing game. Decisions recorded in 219.
- **Calibration** (213): past reports reopenable (results-*.json → same ResultsScreen);
  Phase-B stat segregation (pooled vs selection-clean, RESULTS_VERSION 7); blind/reveal
  prior split; win-prob readout; raw-error tooltip.
- **Training profiles** (225): who's-training picker; ALL personal keys per-profile
  (overlay/metrics/log/start/program/measure-user + spar/playout stores); mechanism recorded
  in 225. Rival label is free text — "Arnthor" was just a typed value; dad's account
  (thorsenior2) has a pipeline profile so a Beat-X program generates for him.
- **Puzzles** (211): 38,894 mined cliffs imported (two 20k monthly batches from homeserver;
  mining continues for 2026-01+); depth-differential difficulty prototype
  (visible_from_depth column + scripts/mining/depth_differential.py, honesty-gated).
- **Personas** (214/218): snapshots (content-hash ids on every decision/game record); BT3
  managed net serves in Play vs Bot (honesty gate untouched, decision log records serving
  backend); spar increment clocks (5+3/10+5/15+10, flag=loss, freeze-on-end) + book-exit
  style-bias wiring; per-process net verification (was 190MB SHA per move).
- **Tournament** (210/212/213): React #310 crash on Start fixed (hook below early return in
  LiveGameView); opt-in Eval_R pass → "visible from ~R" badges; eval presets; shared
  use-ply-review hook (2 call sites ported).
- **Database** (200): cross-DB merge (batched, dedup, per-slice mutex release); player-
  filtered explorer + opening-leaks view (bounded, EXPLAIN-verified); CBA arrows/highlights
  decoded on CBH import.
- **Web/mobile** (221/223): responsive pass (stacked layout, accordions, touch targets, no
  horizontal scroll at 375px) — NOT visually verified on a device yet.
- **Docs/CI** (222): pc-build.yml committed (push blocked, see above); pc-install.is.md
  (Icelandic, for dad).
- **Specs**: evidence tick-sweep across 11 specs; cognitive-gate proposal evaluated into 214
  (adopt 3 / reject 2); 225 gap notes. 214 checklist evaluation section is authoritative.
- **Review**: 4-dimension adversarial workflow over the 93-file session diff → 11 verified
  integration bugs fixed (merge mutex hold + stale db_counts, leaf-slot miss, snapshot-id vs
  served backend, reopened-report bias flag, phantom spar flag, profile-scoping leaks ×3,
  slug collisions, stale leak report).

## Constraints/decisions
- Long jobs: batch-committed + resumable, heavy compute → homeserver at 15% CPU (memory
  feedback-long-jobs). Fair-play lockout is one-way on delete. Honesty gates untouched:
  depth→Elo mapping and BT3 strength labels await measured calibration.

## Next session start
1. USER DECISIONS (19 queued; full list in the session's inventory workflow output): the big
   four — (a) avatar caricature source photos + likeness approval (gates the requested
   avatars, spec 218); (b) mining-methodology sign-off (scripts/mining/README.md) — unlocks
   full 11M-corpus run, Tier-2/3 difficulty, personalized decks; (c) the ~30-min guided
   walkthrough of code-done-but-uneyeballed features (list in specs/900 "Pending user
   walkthrough" + tick-sweep notes); (d) web DB story (server-backed vs sql.js/OPFS).
2. `gh auth refresh -s workflow` then `git push origin main` (25 unpushed commits).
3. User verifies in the running app: tournament Start (crash fix), Play vs Bot scroll,
   fair-play delete/board-clear, Fair-play games list, calibration Past reports, training
   profile picker ("Add person…" → dad), avoidance puzzles now populated (Elo after 15
   attempts), spar clocks.
4. Large items deliberately left for fresh context: TournamentRunner/EngineProvider refactor
   (220), anti_line_drill (215), coach-suggested program adjustments (215), ResultsExplorer
   port onto use-ply-review, native mobile triage (223).
5. Homeserver: puzzle mining months 2026-01+ still running (tmux mine211) — pull + import
   when done (data/puzzles/, import_puzzles.py).

---

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

