# 218: Bot Roster & Exhibition Play

**Status:** draft
**Depends on:** 214 (what a persona IS — books, policies, priors, eval harness), 210 (match runner + tournament UI), 216 (honest strength labels), 213 (Maia plumbing)
**Origin:** user feedback 2026-07-15, playing the dad-sim — six items, near-verbatim:
move numbers "for easier reference in 'didn't feel like him'"; back/forward review
("wait, what did you do"); avatar pictures; "ability to select players to compete"
with engines/bots as both players ("that way I can see fischer kasparov play");
rename "Spar vs Dad" → "Play vs Bot" (dad becomes one bot, uniquely with 'improve
profile' / 'play'); bots available in tournament. Consolidated into this spec per
user decision 2026-07-15 ("yes, new spec"); spec:214/210/217 cross-reference here.

## Goal

One roster of bots — engines and personas, with faces — consumed by every surface
that fields an opponent: the Play vs Bot tab, the tournament/exhibition, and the web
arena. Pick any bot to play; pick any two to watch.

## Glossary (mentor review 2026-07-15)

- **Rival** — a real person we model (dad, the chess.com rivals); private individuals
  stay local per spec:214's hard rules.
- **Persona** — the model of a player: book + policy + priors (spec:214).
- **Bot** — a roster entry visible in the UI.
- **Participant** — the runtime object a surface spawns to field an opponent, engine
  or persona (below).

Move selection is owned by spec:214's persona engine contract; 218 owns surfacing.

## The Participant

The architectural core is one object:

```
{ id, displayName, avatar?, kind: uci | persona, enginePath | personaConfig }
```

consumed by three surfaces:

1. **Play vs Bot** (renamed from "Spar vs Dad", Learn sub-tab): human vs one roster
   entry. The private rival persona is the only entry with two actions — **Play**
   and **Improve profile** (= the shipped serious/probe spar modes, spec:214); all
   others get **Play** only.
2. **Exhibition / Tournament** (spec:210): pick any two roster entries, assign sides
   explicitly, watch them play — Fischer vs Kasparov in-app.
3. **Persona Arena** (spec:217): the web surface of the same roster; its lobby
   consumes this definition (including the avatar field) rather than redefining it.

### The persona arm (why a persona is not a UCI binary)

The match runner spawns bare binary paths and takes argmax `bestmove`. A shim script
would launch lc0 but lose temperature sampling, the persona book, the policy floor,
and the draw model — it would launch, but it would not be the persona. The seam is a
Rust Participant enum (`UciBinary(path)` | `Persona{book, weights, sampling, nodes}`)
at the single per-move call site in the game loop; the persona arm reuses the
existing Maia plumbing (extended to arbitrary weights) plus persona policy sampling.
The persona arm serves ALL personas — friends-and-family personas (Maia-band
policies + their own-game books) and GM-strength personas (the BT3 strong net)
alike; only the policy backend differs per entry (spec:214 Tier 2 config). The same
abstraction serves spec:217's server-side roster.

## Decisions (2026-07-15, user)

1. **Avatars: caricature portrait art for everyone**, based on public photos, "so
   you can see who it is" — the stylized-likeness route; no licensed-photo shipping.
   Private individuals: source photos AND generated caricatures stay local-only
   (never bundled/committed — spec:214 hard rule); public figures' caricatures may
   ship bundled.
2. **This spec is the one home** for roster/surfaces/exhibition (was: edits spread
   across 214/210).
3. **Exhibition ships now, upgrades over time**: start with Fischer and Kasparov at
   the best fidelity currently available (Maia-band first, the BT3 persona arm when
   ported), always with spec:216 honest strength labels — "to be updated" is
   acceptable and expected. Friends-and-family personas join as they are modeled
   (spec:214); the roster is not GM-only.
4. **Roster v1 = everything**: the private rival + all modeled friends/family
   (local-only entries) + Fischer + Kasparov + the Maia strength bands; future canon
   entries (spec:217 roster) appear as they're extracted.
5. **Tournament picker UI: one simple dropdown**, kind-prefixed labels — "engine:
   stockfish 18", "engine: reckless", "bot: dad", "bot: kasparov". No separate
   roster-browser screen in the tournament tab; the card-style roster browser with
   avatars belongs to Play vs Bot.
6. **Disclosure, not consent paperwork**, for using relatives' games and fielding
   their personas: the family sticker, recorded in spec:217 Transparency ("note:
   your son may use your games — study them in order to try to beat you in chess
   at Christmas"). The app is for the user, then dad; a formal ToU is deferred
   until/unless the app is ever published beyond family (user, 2026-07-15).

Implementation detail settled without user (small fork, 2026-07-15): the
back/forward review mechanic is copied in place in the spar tab first; it gets
extracted into a shared component when the exhibition viewer gains its SAN move
list, not before.

## Hard rules

spec:214's hard rules apply wholesale: personas of private individuals — including
their avatar images, source photos, books, and roster metadata — stay LOCAL
(data/rivals or app data, gitignored, never bundled); committed spec/UI text refers
to private personas generically; every persona match and roster card shows measured
strength (spec:216 curve) — no unmeasured realism claims.

## Checklist

### Ship-now polish (no roster dependency)

- [x] Move numbers in the spar/Play-vs-Bot move list (2026-07-15, user request):
      numbered move pairs, so realism-feedback notes can cite "12.Nxe5" instead of
      prose — strengthens the shipped feedback ground-truth stream (spec:214).
      (headless-verified, user eyeball pending) Later: the same fix in the
      tournament live viewer (today it shows only "game #N · move M"), landing
      with the exhibition viewer work below.
- [x] Back/forward review during a live game (2026-07-15, user request — "he
      captured with the knight on e5 and I think he captured my knight (I know he
      did), but it helps to have back/forward to see better what he's planning...
      similar to how one might ask in a friendly game 'wait, what did you do'"):
      port the spec:210 Phase 8 ply-nav pattern (per-ply frame history, arrow keys,
      snap back to live). Review-only — renders a derived position and never
      mutates the live game; board interaction suppressed while browsing; snaps
      back to live on the opponent's move or "go live". Explicitly NOT takeback
      (the destructive control / spec:010 undo is a different mechanic).
      (headless-verified, user eyeball pending)

### Roster

- [ ] Play vs Bot rename + roster: "Spar vs Dad" → "Play vs Bot"; a roster of
      Participants replaces the hardcoded rival label/book; per-entry action set
      (private rival = Play + Improve profile; all others = Play only). v1 contents
      per decision 4: everything modeled so far.
- [ ] Participant config + loader (spec:214's persona config is the `persona`
      payload; `uci` entries are named binary paths)
- [ ] Avatars: avatar field + initials fallback first (ships with zero art), then
      the caricature pipeline per decision 1 — public reference photos →
      recognizable caricature portraits; private entries' art local-only.

### Exhibition & tournament

- [ ] Participant dropdown replaces the two free-text binary paths in the
      tournament tab (decision 5 labels), with explicit per-side assignment
      (Phase 3 `flipFirst` is only half of side selection)
- [ ] Persona arm in the runner: the Participant enum at the single per-move call
      site (see "The persona arm" above)
- [ ] Managed weights: the ~190MB BT3 strong net lives outside the repo today;
      extend the existing checksummed Maia weight-download story to fetch/locate it
- [ ] Exhibition framing: batch of 1 through the existing runner as v1; featured
      single-game presentation (less stats-first); SAN move list with move numbers
      in the live viewer; spec:216 honest strength labels on every persona match
- [ ] Personas in round-robin standings with spec:216 labels (rides on spec:210
      Phase 6's round-robin item)
