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

### F. The live position — never lose your place (user need 2026-07-20)

**The problem.** A fair-play game IS an analysis board: the whole point is to
push the pieces around by hand. But the tree records exploration and reality in
the same shape, so after playing a ten-move idea the user cannot tell which node
is the actual game — and ends up opening chess.com to check. Ten undos to get
back is the symptom; "wait, was this the position, or one after it?" is the
disease.

**The fix, in one sentence:** the game carries a pointer to the real position,
that pointer is refreshed from chess.com rather than from memory, and one button
always returns to it.

- **`liveNodeId`** — a node id on the active-game flag marking the position as
  it actually stands in the real game. Node ids are stable across save/load
  (`GameTree.fromJSON` rebuilds them verbatim), so the pointer survives
  "Continue later", resume, and restart along with everything else on the flag.

- **chess.com is the source of truth, not the user.** Ongoing daily games are
  public: `GET /pub/player/{username}/games` returns each in-progress game with
  its full `pgn` so far, current `fen`, and whose `turn` it is (VERIFIED by live
  call 2026-07-20 — see "Public API" below). On open, on resume, and on an
  explicit **Sync** button, the app fetches the game, replays its move list, and
  pins `liveNodeId` to the tip. The user never hand-advances the pointer, so it
  cannot drift from reality — which is the entire point of the feature.

  - **Cadence: on open/resume + manual Sync only** (user decision 2026-07-20).
    No background polling. Daily games move on a scale of hours; steady
    background traffic buys nothing and risks the 429 the etiquette rules warn
    about.
  - **Reconciliation rule:** chess.com's line is the mainline. Replaying it
    descends into existing matching children and promotes them into the mainline
    slot where the user had branched; non-matching branches are preserved as
    variations. Exploration is never destroyed, but it never outranks reality
    either.
  - **Fair play:** this reads the user's own game's public move list. No engine,
    no evaluation, no third-party assistance — it shows the user the position
    they are already looking at on chess.com. The Fair Play Policy bans engines,
    tablebases, and analysis tools; a read of published game data is none of
    those. Request etiquette is the existing one: serial, descriptive
    `User-Agent`.
  - If the game has no stored `gameUrl`, sync auto-discovers it by matching the
    ongoing-games response (by opponent), then stores it for exact matching
    thereafter. If the game is absent from the response, it has ended — the user
    is pointed at "Game finished" (section D) rather than left with a stale
    pointer.

- **Sync also settles which side the user is on.** The ongoing-games response
  names the two sides as player-profile URLs (`"black":
  ".../pub/player/hjaltth"`), so `myColor` is derivable rather than guessed:
  sync parses the username out and writes it to the flag, backfilling games
  that predate the field. This closes a standing annoyance — the orientation
  mechanism has been in place since 2026-07-17 (`setOrientation(meta.myColor)`
  on resume), but `myColor` was only ever set by the manual per-game toggle, so
  in practice games opened White-side-down and the user flipped the board every
  single time. The manual toggle stays as an override for games the API can't
  speak to, and Flip stays available everywhere, in every game — this changes
  the DEFAULT only: *whatever side I am playing is closest to me when the game
  opens*.

- **Advancing prunes the history behind it.** When sync moves the live pointer
  forward, every exploration branch hanging off a position STRICTLY BEFORE the
  new live node is deleted. Those lines explore positions the game has already
  left — they can never be played, and left in place they bury the actual game
  under nested parentheses within a handful of moves (user-reported with a
  screenshot 2026-07-20: a 7-move game whose move list was already mostly dead
  variations). The real history — the played path itself — is never touched;
  only side branches off it are. Branches AT or AFTER the live position are
  current exploration and always survive.

  Noted as a deliberate data loss: analysis (including comments and NAGs) on a
  dead line is discarded without prompting. That is the user's call — "the
  explore subtree is only valuable for current/future". If it ever bites, the
  softening is to spare branches carrying comments/NAGs rather than to stop
  pruning.

- **Exploring is bounded to the live position and forward.** From `liveNodeId`
  the user may play anything, as deep as they like — that is the analysis board.
  Browsing BACK past the live position is always allowed, but the board goes
  **view-only** there and an inline message says so, offering the return button
  (user decision 2026-07-20: hard block, no escape hatch). Rationale: branches
  growing off stale positions are exactly what makes the tree unreadable, and
  the block costs nothing that browsing plus returning does not already give.

- **The badge must not resize the board.** The live/exploring indicator renders
  as an overlay positioned INSIDE the board element (the same mechanism the
  promotion dialog already uses), never as a sibling above or below it. A label
  in normal flow would shrink the board, which the user explicitly ruled out.
  States: `● LIVE · <side> to move · synced <n>m ago` / `⑂ EXPLORING · n moves
  from live` / `⑂ BEHIND the live position · n moves back`.

- **"Back to current position"** joins the existing move-navigation row beneath
  the board (spec 202's nav bar), so it costs no vertical space either. It is
  the feature's reason for existing: one click home from any depth, with no
  counting and no second-guessing.

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
  far, `turn`, `move_by`, `time_control`). **VERIFIED by live call 2026-07-20**
  against `hjaltth` (returned an in-progress Chess960 daily game with all of
  `url`, `pgn`, `fen`, `turn`, `move_by`, `last_activity`, `rules`,
  `time_control`) and `thjaltason` (empty `games` array). Note the shape
  difference from the month archive: here `white`/`black` are **player-profile
  URL strings**, not objects with `username`. This is the endpoint section F's
  sync is built on.
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

## Decisions (2026-07-17)

- **Terminology**: the user-facing name everywhere is **"fair-play game"**
  (user-picked over "ongoing game"/"live game"/"active game" after the
  feature answered to three names at once). Code identifiers stay
  `ActiveGame*`.
- **Delete vs Archive**: deleting a flagged game DISCARDS it — if it backs
  the game on the board, the board is cleared; deletion never lifts the
  lockout in place (the old behavior silently unlocked the engine on the
  still-loaded position). Archive — which saves the finished game to the
  database — is the only path that unlocks analysis on the board copy.

## Decisions (2026-07-20 — section F)

- **Pointer advance**: driven by a chess.com sync, not by the user's clicks.
  The user's own framing was "if games are public during play then auto-advance
  is ideal, otherwise I click one ply at a time" — the live call settled it:
  they are public, so the app syncs and the manual-click fallback is not built.
- **Behind the live position**: hard block, view-only board, no escape hatch.
  Considered and rejected: an "explore from here anyway" link for retrospective
  by-hand study. It can come back if the block ever bites in practice.
- **Sync cadence**: on open/resume plus a manual Sync button. No background
  poll, no notifications.
- **Badge placement**: overlay inside the board element. A label in normal flow
  above or below the board is explicitly forbidden — it shrinks the board.
  SUPERSEDED same day, see below: the pill covered the position, so only the
  view-only block stayed on the board.

## Decisions (2026-07-20 — the fair-play layout)

The user supplied chess.com's own Daily screen as the reference: "this is the
layout chess.com has, which people are very used to."

- **Two columns in fair-play games, three everywhere else.** Board plus a
  single tabbed panel. This is affordable *precisely* in fair-play mode: the
  normal third column exists for the eval bar, analysis panel and eval graph,
  every one of which the lockout already hides. Analysis and play modes keep
  the three-column layout untouched.
- **The panel is tabbed: Moves | Openings.** This answers "do we need the
  opening explorer?" — yes, and it earns a tab rather than a corner. It is one
  of the only aids chess.com PERMITS in Daily play (the verified Fair Play
  Policy quote above), so with the engine structurally off it is the most
  valuable legal tool on screen. chess.com calls its own tab "Openings" too.
- **Move record as a three-column table** — number | White | Black — plus the
  per-move time, which the PGN's `[%clk]` already carries (for chess.com Daily
  it is time SPENT, not remaining). Variations can't sit in a White|Black grid,
  so they break out as full-width indented blocks; that stays readable only
  because the prune above keeps dead lines out of the tree.
- **Column assignment is derived from each move's own FEN, not from `ply`.**
  `ply` counts from the tree root, so a game set up with Black to move — normal
  here, since fair-play games come from the position editor — would file every
  Black move in the White column. The node FEN carries the side to move and the
  fullmove counter exactly. Generalized the same day into
  `core/game-tree.ts`'s `moverIsWhite` / `moveSlot` and applied everywhere the
  mover's colour mattered — see below.
- **Fair-play status is ONE LINE**, not a card: a lock glyph, the live/exploring
  state, whose move it is, and the sync age, with the actions as small buttons
  on the same row. User: "no need to waste so much space on the fair play
  banner — that's just a one line notification somewhere."
- **NOTHING of the live-position UI renders over the board.** Two attempts were
  made and both were rejected for the same reason: the status pill covered the
  top-left corner, then the replay bar covered pieces near the bottom edge
  (user screenshots, 2026-07-20). The argument for keeping an on-board element
  — "it explains why the pieces won't move, which only reads where the pieces
  are" — lost to the simpler fact that the panel header is already on screen
  and already says it. The board shows the position and nothing else.

  Consequence accepted: during replay a piece drag does nothing with no
  feedback at the point of the gesture. The board's view-only cursor and the
  panel's "Replay · N moves back" carry it. Revisit only if that actually
  confuses in use.
- **Navigation moved to the panel's foot**, chess.com-style, including
  "⟲ Current".
- **Going back is REPLAY, not a refusal.** The first version washed the board
  and said "You can only explore from the current position", which read as an
  error for what is simply a mode — pressing ⏮ is a normal thing to do. Now:
  no wash (you went back in order to LOOK at the position), no alarm colour, a
  compact bar reading "Replay · N moves back", and a ▶ button beside "⟲
  Current" so stepping forward through the game is offered rather than implied.

  The user's reasoning, worth preserving because it shapes the feature: chess
  is evaluated as if by a stateless machine, but people are not stateless —
  they carry memory and feeling, and a mistake made while trying to repair an
  earlier mistake is a real pattern. Replaying how the position went wrong is
  how that gets interrupted. The moves stay locked (branches off stale
  positions are still what makes the tree unreadable), but the tone should
  invite the review, not scold it.

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

- [x] Position setup shows the prominent active-game checkbox with the
      disclosure wording; checking it persists the flag + metadata (username
      defaulting to the user's, per-game) on the saved game shape
      (code-verified 2026-07-15)
- [x] With the flag set, the engine process is never spawned for that game
      context: verified at the invocation layer (use-engine hook test + Rust
      UCI manager refusal), not by checking hidden UI (code-verified
      2026-07-15: guard-predicate unit tests + grep of every use-engine
      start path + Rust `context_is_locked` tests)
- [x] All engine-derived surfaces (analysis panel, eval bar, eval graph, hints,
      human-eval/coach) are absent/inert for the flagged game, with a visible
      "Active game — engine disabled for fair play" notice in their place
      (code-verified 2026-07-15)
- [x] Scoping test: with an active game open or persisted, puzzles / training /
      sparring / engine lab in other tabs retain full engine access
      (code-verified 2026-07-15: those paths never produce an active-game
      context tag; Rust allows untagged/unrestricted)
- [x] Reopening (resume, restart, reload) a flagged game re-applies the lockout
      (code-verified 2026-07-15)
- [x] No mid-game unflag path exists; deletion requires the fair-play
      confirmation dialog naming the reason (code-verified 2026-07-15)
- [x] "Continue later" writes the game (tree + metadata + last-updated) to the
      persisted active-games store; the list UI shows it and Resume restores it
      (code-verified 2026-07-15)
- [x] "Game finished" fetches archives → month JSON for the stored username,
      matches the game, imports the real PGN into the database (spec:200),
      marks the entry archived, and only then allows engine analysis on it;
      fetch failure (12–24h cache) leaves the lockout in place with a retry
      path and a manual-PGN fallback (code-verified 2026-07-15)
- [x] chess.com requests are serial with a descriptive User-Agent; one live
      smoke-test against a real account confirms the field names used
      (code-verified 2026-07-15: live curl vs hjaltth archives + 2026/07
      month — `archives`, `games[].pgn/url/end_time/white.username` all
      present as parsed)
- [x] Position editor palette renders every piece on a small white backing
      square (unconditional, spec:014) (code-verified 2026-07-15)

#### Section F — the live position

- [ ] `liveNodeId` rides the active-game flag and survives a save/load round
      trip: flag a game, explore, "Continue later", resume — the pointer still
      names the same node
- [ ] Sync against the live ongoing-games endpoint pins `liveNodeId` to the
      tip of chess.com's move list, and re-syncing after the opponent moves
      advances it by the real plies (no user input involved)
- [ ] Reconciliation preserves exploration: a user variation that diverges from
      chess.com's line survives as a variation, and chess.com's line ends up in
      the mainline slot
- [ ] A game with no stored `gameUrl` gets one auto-discovered from the
      ongoing-games response; a game absent from that response reports "this
      game has ended — use Game finished" rather than silently keeping a stale
      pointer
- [ ] Board is view-only strictly behind `liveNodeId`, with the inline message
      and the return button; at or ahead of it, moves branch freely
- [ ] "Back to current position" returns from arbitrary depth in one click,
      including from inside a variation
- [ ] The badge is an overlay: board pixel dimensions are identical with the
      badge showing and hidden (no reflow)
- [ ] Chess960 round-trips: the live `hjaltth` game (`1000687368`) syncs its
      full move list rather than importing 0 plies
- [ ] Advancing the pointer prunes dead branches: a variation hanging off a
      position before the new live node is gone after sync, one hanging off the
      live node or after it survives, and the played path is intact
- [ ] Fair-play games render two columns (board + tabbed panel); analysis and
      play modes still render three
- [ ] Moves tab shows the three-column table with per-move times; Openings tab
      hosts the explorer; the explorer is mounted ONCE (not also hidden in the
      left column, which would double its position queries)
- [ ] Exploration past the live node renders dimmed beneath the "exploring"
      divider, and a row split across the boundary dims only its Black cell
- [ ] A game set up with Black to move files its moves in the Black column
- [ ] Sync derives `myColor` from the ongoing-games response and backfills it
      on records that lack it; opening the `hjaltth` game (where the user is
      Black) puts Black at the bottom with no manual flip, and Flip still works

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
