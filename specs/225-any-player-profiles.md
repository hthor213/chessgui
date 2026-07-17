# 225: Any-Player Profiles & "Beat X" Training

**Status:** draft
**Depends on:** 214 (persona pipeline + engine contract), 215 (curriculum engine), 218 (roster/Participant surfacing), 211/212/213 (via 215's exercise types), data/rivals conventions
**Feeds:** 217 (arena roster — friend-on-request personas, Promise 4)

## Origin

User, 2026-07-15, near-verbatim: dad's often-played chess friend is — the user is
"pretty sure" — **Arnþór Einarsson, FIDE 2300540**. Dad's own confirmation of the
identity remains the formal gate (spec:217 Promise 4, "dad names his chess friend").
The user wants three things: (a) Arnþór added to the profiles, (b) the general
"any player profile creation" flow finished — ANY player profilable from a name plus
any of FIDE ID / chess.com handle / lichess handle / imported PGNs, (c) a **"Beat X"
training program generator** — spec:215's machinery pointed at a target player's
tendencies. First instance: **dad training to beat Arnþór**.

Strategic note, recorded deliberately: this feature is the hook that pulls dad into
the app as a user. The user explicitly accepts that dad improving makes Operation
Florida a moving target — "win either way."

## Goal

One pipeline that turns any named player into a profile, and one generator that
turns any profile into a training program aimed at beating that player.

## Part 1 — Any-player profile creation

Today each rival was profiled by hand: `scripts/fetch_chesscom.py` pulls archives,
`scripts/persona/build_rival_book.py` builds the book, per-rival stats/config files
accrete in `data/rivals/` (thjaltason, geirjon1234, gunnargunn, painterdenny, …).
Unify that into a single pipeline:

1. **Input**: player name + any of: FIDE ID, chess.com username, lichess username,
   PGN file (the OTB import path — Arnþór's corpus arrived exactly this way).
2. **Fetch/import**: chess.com via the existing `fetch_chesscom.py` (API etiquette
   preserved); lichess via its export API (same shape, new fetcher); PGN import for
   OTB/manual sources. Every imported game keeps provenance headers (`Source`,
   `SourceDate` — the arnthor SOURCES.md precedent) and a per-player `SOURCES.md`.
3. **Profile artifacts**, written to `data/rivals/<slug>.*` per existing convention
   (gitignored, spec:214 hard rules — private individuals stay LOCAL):
   - `<slug>.pgn` + `<slug>.SOURCES.md` — the corpus + provenance
   - `<slug>.stats.json` / `<slug>.profile.json` — the stats dossier (colors,
     results, opening families, phase win/loss profile)
   - `<slug>.book.json` — via `build_rival_book.py` (generalized off its hardcoded
     dad sources; `--out PATH SRC...` already exists)
   - `<slug>.config.json` — persona config via the spec:214 Tier-2 pipeline,
     **only when the sample suffices** (honesty rules below)
4. **Surfacing**: the profile appears in the roster (spec:218 `buildRoster`) gated
   on artifact existence — the same "appears only when it loaded" rule the private
   rival already uses. Persona-armed entries require `config.json`; dossier-only
   profiles appear in profile views but field no bot.
5. **Desktop UI**: an "Add player profile…" flow where the roster/Play-vs-Bot picker
   lives — name + identifier fields + PGN drop; runs the pipeline; shows an honest
   progress/verdict screen (games found, sample verdict, which artifacts were built).

### Sample-size honesty rules

Dad's book was built from 47 games; that is the calibration point.

- **≥ ~30 games**: full profile — book + dossier + persona config.
- **< ~30 games**: persona still buildable but carries a **LOW-CONFIDENCE badge**
  in every surface that shows it (roster card, in-game header) — no unmeasured
  realism claims, per spec:214's hard rule.
- **< ~10 games**: dossier only, **no persona**. The UI says why.
- Thresholds are named constants in the pipeline, not vibes scattered in UI copy;
  the verdict (count, threshold applied, badge level) is stored in the profile so
  every consumer renders the same honesty.

## Part 2 — "Beat X" training program generator

Given a target profile, generate a spec:215 `Program` aimed at beating that player:

- **Anti-book lines** (`anti_line_drill`): prepared lines that exit X's book by
  ~move 6 — the dad precedent (dad's book depth ~3 plies; the same book-depth
  analysis generalizes from `<slug>.book.json`).
- **Rake decks** (`rake_deck`, spec:211): filtered to X's favorite structures and
  opening families from the dossier.
- **Conversion training** (`endgame_playout` + phase drills): weighted toward the
  phases X statistically wins and loses — attack where he leaks, shore up where
  he grinds.
- **Spar sessions** (`spar_rival`): vs X's persona, when one exists; when the
  profile is dossier-only, the program says so and substitutes level-matched Maia
  with X's book if available.
- **Output**: a TRAINING_PLAN-style doc (the `data/rivals/TRAINING_PLAN.md`
  precedent) + an in-app program consumed by spec:215's curriculum engine —
  chapters, measured exit criteria, milestone card. Private overlays (names,
  dates) stay local per spec:215's overlay rule.

**First instantiation: dad vs Arnþór.** v1 is the LOCAL app — the user generates
the program and hands it to dad. Server-side delivery (dad running it in the arena)
is a spec:217 dependency, noted and deferred; nothing in the generator may assume
the arena exists.

## Arnþór data status (collected 2026-07-15, STAGING — user review pending)

- `data/rivals/arnthor-einarsson.pgn` — **32 classical OTB games**, 1991–2023,
  decoded from chess.com's OTB player database (playerId 828784), every move
  replayed with python-chess (0 illegal, 0 dupes). Provenance per game +
  `arnthor-einarsson.SOURCES.md`. Gitignored, verified.
- Stats: 16W/16B colors; 7 wins / 10 draws / 15 losses from his side (matches
  chess.com's 22/31/47%); avg opposition 2301 vs his 2236 — the sample skews
  toward stronger opposition. Openings confirm the fact sheet: 1.d4/1.Nf3
  English/fianchetto systems as White; solid structures (Caro-Kann, QGD,
  Symmetrical English) as Black.
- **Sufficiency verdict: MARGINAL.** 32 nominally clears the ~30 floor, but 6 games
  are a 1991-92 "Sweden" block attributed only by chess.com's player slug —
  plausible but unverified, and chess.com conflates same-named players. Without
  them: **26 games — below the persona floor** — and the corpus is stale (only 3
  games post-2018, none from his current ~2085-strength period).
- **Gate, honestly applied**: the persona milestone for Arnþór is BLOCKED on
  (a) user review of the Sweden block, (b) ideally more games. Until then the
  corpus is a style-signal dossier, not a persona book. Known further sources:
  365chess.com player page (403 to curl, needs a browser visit), timarit.is
  chess columns (pre-2011), chess-results tnr1277896 per-round data (2025-26
  team championship), Reykjavik Open bundles 2011/2016/2017 if participation
  confirms.

## Hard rules

spec:214's rules apply wholesale: profiles of private individuals — corpus, book,
dossier, config, avatar — stay LOCAL (data/rivals or app data, gitignored, never
bundled/committed); committed spec/UI text names private rivals generically except
where the user has explicitly recorded the identity (as here, per the Origin
section, with the confirmation gate stated). The friendly norm from spec:217
Promise 4 applies: dad tells his friend, same as dad was told.

## Done When

**Agent-verifiable:**
- [x] Pipeline builds a full profile end-to-end from a PGN fixture (fixture in →
      pgn/stats/book/config artifacts out, sample verdict recorded)
      (verified 2026-07-17: `python3 scripts/persona/build_player_profile.py
      --self-test` run green — synthetic fixture PGN in, book/config/profile
      artifacts out, verdict + preservation PASS checks printed)
- [x] Sample-size gates enforced by the pipeline: <30 → LOW-CONFIDENCE flag in the
      config, <10 → no config emitted, verdict says why
      (verified 2026-07-17: FULL_PERSONA_FLOOR=30 / PERSONA_MIN_GAMES=10
      (build_player_profile.py:68-74), LOW-CONFIDENCE note written into the
      config :475,:494; gates exercised by the self-test's Gate 1/2 fixtures
      (:706,:734) — same green run as above)
- [ ] Arnþór dossier (stats + book) built from the collected games IF the reviewed
      sample suffices; persona config only if the ≥30 verified floor holds
- [x] Beat-X generator produces a valid spec:215 Program + plan doc from a profile
      (test against an existing rival profile)
      (verified 2026-07-17: `buildBeatPlan` emits the spec:215 Program + the
      markdown plan (lib/beat-program.ts:170,324); terminal path
      scripts/persona/generate_beat_plan.mjs reuses the SAME generator;
      beat-program.test.ts "buildBeatPlan — the spec 215 Program" incl. the
      existing-rival-profile case — green)
- [x] Roster shows pipeline-built profiles gated on artifacts; dossier-only
      profiles field no bot
      (verified 2026-07-17: artifact-existence rule in beat-program.ts:53;
      roster.test.ts "buildRoster with pipeline profiles (spec 225)" — full
      verdict unbadged + Beat-armed, dossier-only card fields NO bot — green)
- [ ] "Add player profile…" UI flow runs the pipeline from the app

**User-blocked:**
- [ ] Dad confirms Arnþór's identity (spec:217 Promise 4 — the formal gate)
- [ ] User reviews and approves the collected Arnþór game data (esp. the 1991-92
      Sweden block)
- [ ] Dad actually uses the dad-vs-Arnþór program

### Later / uncaptured requirements (audit 2026-07-16)
- [ ] Rival-filtered opening explorer: explorer scoped to a rival's games —
      their book, where their line depth ends, their weakest lines.
      (BACKLOG "Rival mode")
- [ ] Own-games import by username (hjaltth et al.): fetch the user's own
      archives and review them under the engine-LAST discipline. (000:114;
      900 Medium) — Precise gap (2026-07-17 audit, boxed instead of shipped
      because no honest SMALL affordance exists yet): (a) the app has no
      local "this is me" identity record — own usernames are private data
      (app data / gitignored config, never committed), so the database tab
      cannot tell an own game from any other, and an engine-LAST prompt on
      EVERY game open would misapply the discipline; (b) the discipline
      itself needs an engine-gating affordance — engine lines stay hidden
      on game open until the reviewer commits a note/eval (spec 213 Phase
      0's note→rebuttal capture is the natural home); (c) the seam is
      DatabaseTab.openGame → onLoadGame(pgn) → page.tsx
      handleLoadFromDatabase — the one place a "yours → review
      engine-LAST" branch can attach. Smallest real slice once (a) exists:
      flag own games at load and start the analysis panel collapsed behind
      a "commit your take first" prompt.
- [x] Lichess export-API fetcher (only the PGN-fixture import path is boxed
      today; the lichess export API itself is not). (225:36-38)
      (verified 2026-07-17: scripts/fetch_lichess.py — single streaming
      request to lichess.org/api/games/user/{username}, identifying
      User-Agent, 429 backoff per API etiquette; invoked by
      build_player_profile.py's `--lichess` source (:180,:820))
- [ ] Server-side Beat-X delivery: dad runs his program in the arena; the
      generator stays arena-agnostic so it works local-first and
      server-hosted without a rewrite. (225:90-93)
- [ ] Rescue the rival-dossier scripts into the repo proper — analyze.py,
      openings.py, engine_h2h.py, engagement.py → `scripts/` (self_report
      was already rescued this way; these weren't). The spec:217 flywheel
      depends on rerunnable dossiers. (RIVALS_REPORT Appendix) — Partial
      2026-07-17: scripts/persona/refresh_profile.py reruns the pipeline
      (stats + book + verdict) for any pipeline profile whose corpus PGN is
      newer, replaying the stored honesty flags; the four report scripts
      remain unrescued.
- [x] Beat-X honest framing: surface that Arnþór (~2085) is ~500 points
      above dad — "beat" means "score against", not "outrate". (memory
      project_rivals.md) — Done generically 2026-07-17: buildBeatPlan takes
      the trainee's last MEASURED maia_rapid and, when the target sits
      ≥100 above it, the Program.goal and the plan doc state the gap
      ("target is ~N above your last measured level — score against, not
      outrate"); no measurement → no claim.
- [ ] Profiles/programs for the other three rivals — GEIRJON1234,
      painterdenny, gunnargunn — target: beat by next Iceland visit. (memory
      project_rivals.md) — Partial 2026-07-17: generate_beat_plan.mjs now
      synthesizes an honest BeatTarget from legacy artifacts (book corpus +
      identities.json, verdict marked as derived, not stored) and their
      BEAT.md docs are generated; full pipeline profiles still pending.
