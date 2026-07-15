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
- **Tier 2 — persona = book + policy + priors, surfaced through a bot roster**:
  persona config format (name, book source, policy backend, strength, priors, avatar
  asset — privacy rules below); the **Participant** abstraction (see "Play vs Bot"
  section) consumed by every surface that fields a bot; "Spar vs Dad" renamed to
  **Play vs Bot** with a roster and per-entry action set; persona-vs-persona via
  match runner **in-app** (the exhibition — pick any two roster entries, assign
  sides, watch; runner seam specced in spec:210 Phase 6); personas selectable as
  tournament participants (same seam). Honest strength labels for persona matches
  come from the spec:216 measured curve.
- **Tier 3 — style priors that matter**: simplification appetite (trade-seeking bias),
  opening-phase fidelity vs middlegame drift, endgame automatics. Only priors that
  measurably improve move-match survive (no vibes-based parameters).

## Play vs Bot — the roster (2026-07-15 user feedback)

**Origin:** user feedback 2026-07-15, playing the dad-sim — rename "Spar vs Dad" to
"Play vs Bot": "dad becomes one bot in a roster; the only one that's different: dad
has the options 'improve profile' / 'play'. Others just 'play'." Plus: avatar
pictures for the bots, "ability to select players to compete" with engines/bots as
BOTH players ("watch e.g. Fischer vs Kasparov play"), and the bots "available in
tournament".

The architectural core is one object, the **Participant**:

```
{ id, displayName, avatar?, kind: uci | persona, enginePath | personaConfig }
```

consumed by three surfaces:

1. **Play vs Bot** (the renamed Learn sub-tab entry): human vs one roster entry.
   The private rival persona is the only entry with two actions — **Play** and
   **Improve profile** (= the shipped serious/probe spar modes); all others get
   **Play** only.
2. **Exhibition / Tournament** (spec:210 Phase 6): pick any two roster entries
   (engine or persona), assign sides explicitly, watch them play — Fischer vs
   Kasparov in-app, §2's promise.
3. **Persona Arena** (spec:217): the web surface of the same roster; its lobby
   consumes this definition (including the avatar field) rather than redefining it.

A persona is NOT a UCI binary — the runner spawns bare paths and takes argmax
`bestmove`; a shim script would launch lc0 but lose temperature sampling, the
persona book, the policy floor, and the draw model. It would launch, but it would
not be the persona. The runner integration therefore goes through a Participant
seam at the per-move call site (Rust enum, detail in spec:210 Phase 6), never a
shim.

Two items in the same feedback batch are pure spar-UI polish, independent of the
roster and shippable immediately (see Checklist): move numbers in the spar move
list, and back/forward review during a live game.

## Hard rules

- Never noise-weaken engines to fake humanity (Turing-test evidence, docs/research) —
  human-likeness comes from Maia-class policies and books, not random blunders.
- Personas of private individuals stay LOCAL (data/rivals is gitignored); only
  historical public figures (Fischer, Kasparov) may ship as bundled examples.
- Every persona carries its eval-harness scores in the UI — no unmeasured realism claims.
  Roster cards and exhibition matches show measured strength (spec:216 curve) the same way.
- The LOCAL rule above extends to avatar images and roster metadata: a private
  rival's photo and personal details live in data/rivals (or app data), never
  bundled, never committed. Committed spec/UI text refers to "the private rival
  persona" generically — the rename/roster adds nothing about him beyond what this
  spec already discloses. The roster must not create a path around spec:217's
  consent rule for living private individuals.

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
- [ ] Persona config format + loader
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
- [ ] Style priors, gated on measured move-match improvement
- [ ] Move numbers in the spar move list (2026-07-15, user request): numbered move
      pairs in the spar display, so realism-feedback notes can cite "12.Nxe5"
      instead of prose — strengthens the shipped feedback ground-truth stream.
      Later: the same fix in the tournament live viewer (which has no move list at
      all, only "game #N · move M"), landing naturally with the exhibition viewer
      work (spec:210 Phase 6).
- [ ] Back/forward review during a live spar game (2026-07-15, user request — "he
      captured with the knight on e5 and I think he captured my knight (I know he
      did), but it helps to have back/forward to see better what he's planning...
      similar to how one might ask in a friendly game 'wait, what did you do'"):
      port the spec:210 Phase 8 ply-nav pattern (per-ply frame history, arrow keys,
      snap back to live) into the spar board. Review-only — browsing renders a
      derived position and never mutates the live game; board interaction is
      suppressed while browsing; snaps back to live on the opponent's move or "go
      live". Explicitly NOT takeback (the existing destructive control / spec:010
      undo is a different mechanic).
- [ ] Play vs Bot roster (2026-07-15, user request): rename the "Spar vs Dad" entry
      to "Play vs Bot"; a roster of Participants replaces the hardcoded rival
      label/book; per-entry action set (private rival persona = Play + Improve
      profile, i.e. the shipped serious/probe modes; all others = Play only). v1
      roster contents are an open question below.
- [ ] Avatars on roster entries (2026-07-15, user request): persona config gains an
      avatar asset field; v1 rendering = initials/monogram fallback (ships with zero
      art). Private individuals' avatar images are local-only files, never
      bundled/committed (hard rule above); bundled imagery for public figures is
      gated on the rights open question below. spec:217's lobby consumes the same
      field.
- [ ] Personas as selectable tournament/exhibition players (2026-07-15, user request
      — engines/bots as both players, per-side selection, "watch e.g. Fischer vs
      Kasparov play"; and bots "available in tournament"): Participant abstraction
      registered with the match runner; picker + per-side assignment + persona
      runner arm specced in spec:210 Phase 6. v1 exhibition = batch of 1 via the
      existing runner with UCI + Maia-band participants; GM personas (BT3 net +
      own-game book + draw model, today script-only in scripts/persona/) follow.
      Every persona match carries a spec:216 honest strength label.

## Open questions (user decisions pending — do not default)

1. **Avatar art for real people.** Photos of Fischer/Kasparov carry rights/likeness
   issues (photo licensing; personality rights vary by jurisdiction and
   post-mortem). Options: (a) licensed/public-domain photos, (b) generated/stylized
   portraits (weaker rights exposure, but "AI portrait of a real GM" has its own
   taste question), (c) initials/monogram tiles (zero risk, ships today, matches
   the v1 checklist item). Separately for the private rival: a photo is fine
   *locally* — is a local-file picker enough, or a stylized portrait too?
2. **New spec 218 vs edits spread across 214/210?** No item strictly requires a new
   spec, but the Participant abstraction touches 214 + 210 + 217; a single "Bot
   Roster & Exhibition Play" spec (218 is the next free number) would be the one
   home, with 214/210/217 each carrying a one-line cross-reference. Currently
   specced as spread edits; user's call whether to consolidate.
3. **Fidelity bar for in-app Fischer vs Kasparov.** Exhibition with Maia-band
   personas is cheap; the *real* GM personas need the BT3 net (~190MB, currently
   scratchpad-only), the own-game book, and the draw model ported to Rust. Is a
   "watchable but honest-labelled approximation first" acceptable, or is the
   exhibition not worth shipping until the full persona arm exists?
4. **v1 roster contents.** Just the private rival + Maia strength bands, or should
   the two GM personas appear immediately (greyed/"coming soon" vs absent until
   playable)?
5. **Shared review-nav component?** Does the back/forward review mechanic get
   extracted and shared between spar and the tournament live viewer (one
   implementation), or is a second copy in the spar tab acceptable for speed?
6. **Consent status for the private rival persona beyond the local app.** spec:217
   already gates arena exposure on asking him; the rename/roster changes no
   exposure, but if avatars or roster sync ever touch the web arena, that
   conversation gates it. Has it happened?
