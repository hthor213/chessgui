# 219: Active Game Mode — OTB daily-game compliance

**Status:** draft
**Depends on:** 014 (position setup editor hosts the flag; palette fix lands there
too), 200 (finished games archive into the game database), 013 (PGN of the fetched
finished game rides the existing import path)
**Feeds:** nothing yet
**Origin:** user need 2026-07-15 — the app is being used as the equivalent of an
OTB analysis board during chess.com **Daily** games (e.g. 3 days/move), which
chess.com permits — but computer assistance is forbidden. This feature exists to
keep the user compliant.

Monorepo note: the multi-client migration (spec:220) is landing concurrently, so
components may move (packages/ui, apps/desktop) by implementation time. This spec
references components by NAME (position editor dialog, use-engine hook, analysis
panel), not by path.

## Why

Chess.com Daily chess allows moving pieces around on a separate board to think —
their own in-product Analysis board is enabled on Daily games — but bans every
form of engine/computer evaluation, in Daily as well as Live (see "Compliance
grounding" below). This app is one keystroke away from being both: a superb
analysis board AND a Stockfish front-end. Using it during a daily game is only
defensible if the engine is provably, structurally OFF for that game — not just
visually hidden. The stance of this spec: **the lockout is conservative. When in
doubt, the engine stays off.** A false negative (engine unavailable when it could
arguably run) costs a little convenience; a false positive costs the user's
chess.com account and reputation.

## What

### A. Position setup: the active-game flag

- In the position setup flow (position editor dialog, spec:014), a PROMINENT
  checkbox — not buried in an options row. Final wording (user asked for better
  copy than their draft; label + helper pattern):

  > **☐ Live game — analysis board only**
  >
  > *This position is from a game that's still being played. All engine help
  > stays off for this game — explore lines by hand, like on a real board.
  > Analysis unlocks once you mark the game finished.*

  The list actions (sections C/D) are labeled **"Continue later"** and
  **"Game finished"** to match.

- Checking it flags the game as an **ACTIVE GAME** (OTB compliance mode).
- Optional metadata fields appear when checked: opponent name, chess.com game
  URL, chess.com username (defaults to the user's own — stored per active game,
  since the user has more than one account, e.g. hjaltth / thjaltason).

### B. Engine lockout (the heart of the spec)

For a flagged game, ALL engine evaluation is disabled: analysis panel, eval bar,
eval graph, hints/recommended moves, human-eval / Elo-conditioned evaluation
(spec:213), coach output, annotations that would trigger evaluation (spec:202) —
anything engine-derived.

Enforcement rules:

- **Enforced at the engine-invocation layer, not the UI.** The gate lives where
  engine commands are issued (the use-engine hook and the Rust UCI engine
  manager): when the current game context is an active game, the engine process
  is never started for that context, and any evaluation request is refused. Hiding
  the panels is additionally required for honest UX, but hidden UI alone does NOT
  satisfy this spec.
- **Scoped to the game, not the app.** Puzzles, training, sparring, the engine
  lab, other tabs/games keep full engine access while an active game exists.
  Reopening the active game re-applies the lockout automatically — the flag
  persists with the game, so the lockout survives restarts, "Continue later",
  and resume.
- **No bypass toggle mid-game.** The flag cannot be unchecked while the game is
  active. The only two exits are: (1) "Game finished" (section D), or (2) explicit
  deletion of the active game, behind a confirmation dialog that names the
  fair-play reason (wording along the lines of: "This game was flagged as an
  active chess.com daily game. Deleting the flag re-enables engine analysis on
  this position — only do this if the game is truly over or was never real.
  Engine assistance during an ongoing game violates chess.com's Fair Play
  Policy.").
- **Conservative by default.** Any ambiguity (unknown game context, mixed
  contexts, a component that cannot determine which game it serves) resolves to
  engine OFF for that request.
- Non-engine resources stay available: the opening explorer / database
  (spec:200) is explicitly PERMITTED in Daily chess per the Fair Play Policy
  (books/databases allowed, "Daily chess only") — but any engine-generated
  evaluation attached to database content is still blocked in an active game.

### C. Continue later

- A "Continue later" action saves the active game — current tree/position plus
  metadata (opponent, chess.com username, game URL if given, last-updated
  timestamp) — to a persisted ACTIVE GAMES list, and closes it.

### D. Active games list

- A UI surface listing all active games (opponent, position preview or move
  count, last-updated).
- Actions per game:
  - **Resume** — reopens the game with the lockout re-applied.
  - **GAME IS DONE** — the app fetches the finished game from chess.com's public
    API (no auth; endpoints in "How" below), saves the real PGN into the game
    database (spec:200), marks the active game archived, and ONLY THEN re-enables
    engine analysis on it. Post-game review is explicitly allowed and encouraged —
    analyzing finished games is exactly what the rest of this app is for.
  - If the fetch fails (game not yet in the archive — the public API caches
    12–24h — or username/URL mismatch), the game stays active and locked; the
    user may retry later or paste the PGN manually, which also archives it.

### E. UX fix — piece legibility in the position editor (cross-ref spec:014)

In the position-setup editor it is very hard to tell white pieces from black on
the dark theme — it is ambiguous whether colors are flipped. Fix: render each
piece in the palette on a small WHITE backing square so piece color is
unambiguous; if legibility of pieces on the setup board itself remains poor,
consider the same treatment there. This fix is UNCONDITIONAL — it ships with the
position editor regardless of the active-game checkbox.

## How

- **Flag storage**: the active-game flag + metadata live on the persisted game
  shape (the serialized game tree already carries headers and startFen per
  spec:014); the flag is part of the game, so every load path re-applies it.
- **Lockout enforcement point**: a single guard predicate ("is this game context
  an active game?") checked at engine invocation — in the use-engine hook before
  any UCI start/go is issued, and defensively in the Rust UCI engine manager
  command layer (commands carry a game-context tag; active-game contexts are
  refused). Two layers because the frontend gate gives the scoping (per-tab /
  per-game) and the Rust gate gives the guarantee.
- **Active games persistence**: a dedicated persisted store in the app data
  directory (serialized trees + metadata, same shape as the existing saved-game
  persistence), NOT the spec:200 database — the DB is for finished/imported
  games, and spec:200 is still draft. When spec:200 lands, the archive step
  writes there; the active list itself stays a small separate store. Migration
  into the DB is a later option, not a requirement.
- **chess.com fetch** (public API, no auth, JSON):
  - `GET https://api.chess.com/pub/player/{username}/games/archives` — monthly
    archive URLs.
  - `GET https://api.chess.com/pub/player/{username}/games/{YYYY}/{MM}` — that
    month's finished games; match by game URL when stored, else by
    opponent/last-updated heuristics with user confirmation; each game object
    includes full `pgn`.
  - Optionally `GET https://api.chess.com/pub/player/{username}/games` (ongoing
    daily games) to validate/link an active game to its chess.com URL at setup
    time.
  - Etiquette per the Help Center: serial requests only (parallel may 429),
    descriptive `User-Agent` with contact info. Data is cached 12–24h server-side
    — "Game finished" may need a retry the next day; the UI says so instead of
    failing silently.
  - Endpoint field names are single-source (official announcement page, not
    hand-verified by a live call) — smoke-test with a real `curl` against one of
    the user's accounts before locking the parser.

## Compliance grounding

Fact sheet researched 2026-07-15 (quotes verbatim from primary sources; keep the
URLs — they are the audit trail for why this feature is shaped the way it is).

### Engine/computer assistance is banned — Live AND Daily (VERIFIED)

> "Do not use chess engines, software of any kind, bots, plugins, browser
> extensions, or any tools that analyze positions during play."
> "Do not use tablebases or any other resources that show the best move (in both
> Online and Daily chess)."
> "Do not perform any automated analysis or 'blunder checking' of your games in
> progress."

Source: [Fair Play Policy](https://www.chess.com/legal/fair-play)
(chess.com/legal/fair-play), fetched 2026-07-15; consistent across 3 independent
fetches.

> "Using chess programs or engines (e.g., Chessmaster, Fritz, Komodo, Houdini,
> Stockfish, Chessbase with any active UCI engine) to analyze positions in
> ongoing games is strictly prohibited."

Source: [What do I need to know about Fair Play on Chess.com?](https://support.chess.com/en/articles/8568369-what-do-i-need-to-know-about-fair-play-on-chess-com),
fetched 2026-07-15. Note the ban explicitly covers both Live and Daily.

### Physical-board / manual "OTB-style" analysis in Daily — allowed by omission (INFERENCE)

Chess.com's enumerated ban list names only software/engine tools. A physical
board (or a screen-native equivalent with the engine structurally disabled) is
not software, an engine, a bot, a plugin, or a browser extension, so it is not
named as prohibited. Chess.com's own in-product Analysis board is enabled on
Daily games, consistent with this reading.

NOT CONFIRMED as an official quote: no chess.com legal/help-center page uses the
phrase "OTB analysis" or affirmatively says physical boards are allowed. That
claim appears only in chess.com community forum threads ("Playing daily and
using a physical board is allowed... in Daily games you can use anything but an
engine — books, magazines, previously played games, newsletters, etc."; "In
daily chess using an analysis board is within the rules. That's why Chess.com
provides one.") — single-source, non-authoritative community commentary, not
policy text. Sources:
[forum: physical board next to me](https://www.chess.com/forum/view/chess-equipment/is-having-a-physical-board-next-to-me-while-i-play-chess-com-games-on-the-phone-comp),
[forum: is it legal to use a separate board?](https://www.chess.com/forum/view/livechess/is-it-legal-to-use-a-seperate-board-2).

This spec therefore cites the negative-inference argument, NOT a claim that
chess.com "explicitly allows" it — and that gap is exactly why the lockout is
conservative.

### Opening books / databases / Explorer in Daily — allowed (VERIFIED)

> "You may use Opening Explorer or other books in Daily chess only (_not_ in
> Online / Live play)."

Source: [Fair Play Policy](https://www.chess.com/legal/fair-play), fetched
2026-07-15.

> "For Daily Chess (turn-based games with several days per move): You may
> consult non-engine resources, such as books and opening databases (including
> the Chess.com Explorer), for standard and thematic games."
> "Engine analyses of these resources are not allowed."

Source: [Help Center 8568369](https://support.chess.com/en/articles/8568369-what-do-i-need-to-know-about-fair-play-on-chess-com),
fetched 2026-07-15. Together: books/databases/Explorer allowed in Daily only;
engine-generated evaluation of those resources is still banned.

### Public API (for "Game finished")

Base `https://api.chess.com/pub/` — read-only, public, no authentication
(VERIFIED on both sources below). Endpoints and fields per the
[Published-Data API announcement](https://www.chess.com/announcements/view/published-data-api)
(single-source, not hand-verified via live call this session) and
[What is the PubAPI and how do I use it?](https://support.chess.com/en/articles/9650547-what-is-the-pubapi-and-how-do-i-use-it),
fetched 2026-07-15:

- `GET /pub/player/{username}/games/to-move` — games awaiting that player's
  move (`url`, `move_by`, `last_activity`).
- `GET /pub/player/{username}/games` — all ongoing daily games (`fen`, `pgn` so
  far, `turn`, `move_by`, `time_control`).
- `GET /pub/player/{username}/games/archives` — monthly archive URLs.
- `GET /pub/player/{username}/games/{YYYY}/{MM}` — finished games JSON, each
  with full `pgn`, `fen`, `end_time`, results, optional `eco`/`accuracies`.
- `GET /pub/player/{username}/games/{YYYY}/{MM}/pgn` — same month as one
  multi-game PGN file.

Rate limiting (VERIFIED, Help Center): "Serial access is unlimited. Parallel
requests may trigger rate limiting, resulting in a '429 Too Many Requests'
response." Recommended: descriptive `User-Agent` with contact info. Data is
cached/refreshed at most every 12–24 hours (single-source, announcement page).

### Known gaps

- No official page affirmatively permits physical-board analysis in Daily —
  negative inference plus community practice only. The conservative lockout is
  the mitigation.
- API field names not hand-verified by a live HTTP call — smoke-test before
  locking the parser (see How).
- The Postman collection (chess.com/postman/collection-dev.json) — the
  machine-readable endpoint list — was not retrievable this session; pull it if
  full API surface is ever needed.

## Non-goals

- Making moves ON chess.com from this app (no write API exists; out of scope and
  out of spirit).
- Any "just this once" engine override for an active game. There is no such
  button, by design.
- Policing the user's other tools. The lockout governs THIS app's engine only.
- Live chess. This mode is for Daily (days/move) games; the app plays no role in
  Live games.

## Done-When

### Agent-verifiable

- [ ] Position setup shows the prominent active-game checkbox with the
      disclosure wording; checking it persists the flag + metadata (username
      defaulting to the user's, per-game) on the saved game shape
- [ ] With the flag set, the engine process is never spawned for that game
      context: verified at the invocation layer (use-engine hook test + Rust
      UCI manager refusal), not by checking hidden UI
- [ ] All engine-derived surfaces (analysis panel, eval bar, eval graph, hints,
      human-eval/coach) are absent/inert for the flagged game, with a visible
      "Active game — engine disabled for fair play" notice in their place
- [ ] Scoping test: with an active game open or persisted, puzzles / training /
      sparring / engine lab in other tabs retain full engine access
- [ ] Reopening (resume, restart, reload) a flagged game re-applies the lockout
- [ ] No mid-game unflag path exists; deletion requires the fair-play
      confirmation dialog naming the reason
- [ ] "Continue later" writes the game (tree + metadata + last-updated) to the
      persisted active-games store; the list UI shows it and Resume restores it
- [ ] "Game finished" fetches archives → month JSON for the stored username,
      matches the game, imports the real PGN into the database (spec:200),
      marks the entry archived, and only then allows engine analysis on it;
      fetch failure (12–24h cache) leaves the lockout in place with a retry
      path and a manual-PGN fallback
- [ ] chess.com requests are serial with a descriptive User-Agent; one live
      smoke-test against a real account confirms the field names used
- [ ] Position editor palette renders every piece on a small white backing
      square (unconditional, spec:014)

### User-blocked (needs the user's eyeball)

- [ ] User confirms the lockout matches their chess.com daily-game workflow
      (setup → think with the tree → continue later → resume → game is done →
      review)
- [ ] User confirms the checkbox wording reads right and is prominent enough
      that it cannot be missed during setup
- [ ] User confirms white vs black pieces are unambiguous in the position
      editor on the dark theme (and rules on whether the setup board itself
      also needs the backing treatment)
- [ ] User confirms the fetched PGN for a real finished game (hjaltth or
      thjaltason) matched the right game
