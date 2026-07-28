# 228: Narrow Lines — training the sense that *this move matters*

**Status:** draft
**Depends on:** 219 (finished-game fetch + fair-play chokepoint), 202 (per-ply
evals), 226 (the user's own evaluations — the calibration input), 211 (drill
format), 200 (the 957k-game corpus), 215 (where drills are served)

## Why

In [chess.com daily 1000687368](https://www.chess.com/game/daily/1000687368)
(painterdenny 1183 vs hjaltth 1220, Chess960, drawn), Black played **27...a6**.
The position looked quiet: material dead level, no checks, nothing hanging.

It wasn't quiet. Across Black's 36 legal moves the evaluation ranged from
**−0.06 to −7.71**. The best move held the game; the typical move lost it by
four pawns. Black picked one of the losing ones. White then failed to find the
punishment (29.b4!) and the game returned to equal and was drawn.

Two facts make this the spec's target:

1. **The position was decisive and gave no outward sign of it.** No tactic to
   spot, no material imbalance — just a quiet-looking moment where the choice
   was worth four pawns.
2. **Nothing recorded that it happened.** The game is a draw. The eval spiked
   and came back. Every tool that grades a game by what happened to you shows
   this moment as unremarkable — so the misjudgement survives and repeats.

**The skill being trained is not "play a5." It is noticing that a position is
one where the move matters.** Once that alarm fires, the user slows down and
calculates; the specific move is then findable. The alarm not firing is the
actual failure, and it is trainable independently of any particular position.

## The measure

For a position, rank every legal move by evaluation. Then:

- **Spread** = eval(best) − eval(median legal move).
  Here ≈ **4.2**. A genuinely quiet position is ~0.3.
- **Positional content** = |eval| − |material balance|.
  Here material is **level** and the best line is worth several pawns, so the
  entire value of the position is positional — nothing about the piece count
  hints at what is at stake.
- **Calibration gap** = |user's evaluation − engine evaluation|, where the user
  has recorded one via spec:226.

The user's name for this is **narrow lines** — and the term is deliberately
direction-agnostic: *narrow to hold* (only a couple of moves save it, as here)
and *narrow to avoid* (only a couple of moves ruin it) are the same phenomenon
seen from opposite ends. Both demand the identical response: *stop, this one
counts.*

That is why the measure is spread and not a count of good or bad moves. A count
forces a direction the player does not know yet at the moment they need the
alarm — at the board you cannot tell whether you are hunting for the one saving
move or dodging the one losing move until after you have looked. Spread fires in
both cases.

A position enters the training set on **high spread + low material explanation**.
The calibration gap orders the queue: positions where the user's own assessment
was furthest from the truth come first.

## What

### A. Finished games only

Per spec:219 and spec:227 (boundary settled as *derivation, not resemblance*).

- Eligibility comes from the fetched record's terminal result, never from the
  user asserting a game is over.
- A game with an active spec:219 OTB flag is ineligible regardless.
- Guard the entry point, not the downstream analysis.

### B. Find the decisive moments

Sweep the user's moves. For each, rank the legal moves and compute spread.
Flag high-spread moments **whether or not the user erred there** — surviving a
critical position by luck is as instructive as failing one, and the game record
shows neither.

Where the opponent failed to punish (as here), say so explicitly. That is the
information the game record destroys.

### C. The drill: judge the position, then justify it

**The deck must be mostly quiet positions.** This is the single most important
construction rule and the easiest to get wrong. If every card is sharp, the user
knows before looking that the answer to step 1 is "sharp", step 1 becomes
degenerate, and the alarm is never exercised — the deck would train resolution
while appearing to train detection. Quiet decoys must be mixed in at a
realistic base rate (most positions in a real game are quiet), and the user must
not be able to infer sharpness from the fact that a card was served.

**Untimed by default.** The source failure was not a time failure: this was a
Daily game at three days per move: the user had effectively unlimited time and
still did not look. The position was closed and dull and the alarm never fired.
That is a **vigilance** failure, not a calculation one, and it is exactly what an
untimed drill targets. Whether the trained alarm also transfers to blitz is a
separate question this spec does not need to answer — see open questions.

The corollary for deck construction: **prefer closed, quiet-looking positions**
among the sharp cards. A sharp position that looks sharp is not where this user
loses; a sharp position that looks boring is.

Cards are served cold through spec:215 — position only, no game, no opponent,
no eval. The user answers in two steps:

1. **"Does this move matter?"** — quiet / sharp. This is the alarm being
   trained, and it is answerable without calculating.
2. If sharp: **find the moves that hold.**

Step 1 is the point. Step 2 is the check that step 1 was more than a guess.

Scoring tracks the two independently: alarm accuracy (does the user's sharp/quiet
call match the spread?) and resolution accuracy (having noticed, can they find
the move?). These fail in different ways and want different remediation.

### D. Calibration against the user's own evaluations

Spec:226 already records the user's manual evaluation of positions they have
walked. Where one exists for a flagged position, store the gap. A user who
consistently reads sharp positions as quiet has a specific, nameable defect —
and the trend over time is the measure of whether this feature works.

### E. Deck construction

Seed decks from the user's own games first — their own misjudgements, in their
own openings. Extend from the corpus once the schema supports it (see How).

Reserve **held-out cards** never served during training. Improvement is reported
only against held-out results; anything else measures recall.

## How

- Ranking, spread, and classification are pure functions over an evaluated
  position → `packages/core`, fixture-tested, no React, no Tauri.
- **Cost is the design constraint.** Spread requires a MultiPV sweep over *all*
  legal moves, not a single best-move search — roughly an order of magnitude
  more engine time per position. Sweeping every ply of every game is not
  viable. Use a cheap single-PV first pass to shortlist candidate moments, then
  the full sweep only on the shortlist.
- Moderate depth is sufficient for spread; the ordering stabilises well before
  the absolute evals do. Do not pay for depth the metric does not need.
- **Corpus extension is blocked on schema.** `positions` is
  `(zobrist, game_id, ply)` indexed on `zobrist` — an exact-position hash with
  no FEN and no structural data. It can answer "find this exact position" and
  nothing else. Mining the 957k-game corpus for high-spread positions requires
  either a stored per-position key or an offline replay sweep, and is a
  prerequisite for section E's second half — possibly belonging in spec:200.
- Fetch reuses spec:219's chess.com client; tests never hit the network.

## Non-goals

- **Not a move-by-move annotator** — spec:202 does that.
- **Not teaching specific moves or motifs.** The output is a calibrated alarm,
  not a repertoire.
- **Not opening prep.**
- **Not live-game help.** See section A.

## Done-When

### Agent-verifiable

- [ ] Given the fixture position
      `2krb2r/p1n5/1p3qp1/1NpP1p1p/P1P1pP1P/1P2Q1P1/3RB1K1/1R6 b - - 6 27`,
      the ranker returns **36 legal moves**.
- [ ] Computed spread for that position is **≥ 3.0** and the position is
      classified **sharp**.
- [ ] A quiet control position from the same game scores spread **≤ 1.0** and
      classifies **quiet** — the metric must separate the two, not just fire.
- [ ] A constructed deck is **majority quiet**: sharp cards are a minority, and
      a test asserts the ratio. A deck of all-sharp cards must be rejected by
      construction, not merely discouraged.
- [ ] Card order carries no signal: sharp and quiet cards are interleaved such
      that position in the deck does not predict the answer.
- [ ] The moment is marked **unpunished**: White's 29.Rc1 returned the
      evaluation to within ±0.25 of level.
- [ ] Material balance at the fixture position is computed as **level**, and
      positional content is therefore reported as the full magnitude.
- [ ] A game with no terminal result, or with an active spec:219 OTB flag, is
      rejected **before any engine call is made** — a test fails if an engine
      session is constructed at all.
- [ ] Chess960 survives end to end (`variant` + `start_fen` preserved); the
      fixture game is Chess960 and a standard-only path mis-analyses it silently.
- [ ] Ranking is deterministic at fixed depth: two runs flag identical moments.
- [ ] Held-out cards are never returned by the scheduler.
- [ ] `pnpm test` and `pnpm tsc` clean.

### Needs judgment

- [ ] **The sharp/quiet threshold matches the user's felt experience.** Tuned
      against a sample of their 1,225 imported games. This is the highest-risk
      item: a threshold that fires on everything trains nothing.
- [ ] Step-1 cards are answerable *without* calculating — if the only way to
      call a position sharp is to solve it, the alarm is not being trained.
- [ ] Spread at moderate depth agrees with spread at high depth on ordering,
      confirming the cost shortcut in How is safe.
- [ ] Alarm accuracy on held-out cards improves over a month of drilling. This
      is the only real test of the whole spec.

## Open questions

- **Is spread the right statistic?** Best-minus-median is one choice;
  best-minus-second, variance, or "count of moves within 0.5 of best" are
  others. Best-minus-median was chosen because it is robust to a single
  alternative move and to the good/bad-move direction. Worth validating against
  a labelled sample before building on it.
- **Can the alarm be trained at all?** The spec assumes sharpness is detectable
  from features a 1200–1800 player can perceive without calculation. If it turns
  out spread is only knowable by solving the position, step 1 collapses into
  step 2 and the premise fails. **This is the assumption to test first, cheaply,
  before building any of the rest.**
- **Does the untimed alarm transfer to fast time controls?** Expected to, and
  the expectation is reasonable: classical and blitz strength track each other
  closely across players — there is no population of 2750-classical / 850-blitz
  players — so the underlying skill is largely shared and time control modulates
  rather than replaces it. Recognition is the component most likely to carry,
  since blitz leans on it harder than long games do.

  The honest caveat is that this is a cross-player correlation, which does not
  by itself establish within-player *training* transfer. Shared skill explains
  the correlation equally well without untimed drilling moving a blitz rating.

  Either way the spec does not depend on it — the source failure happened at
  three days per move. If transfer becomes a goal it wants its own measurement
  (blitz-rating trend against drilling volume), and a timed drill mode is the
  obvious experiment. Do not add one until the untimed alarm demonstrably works.
- **Where does corpus mining live** — here or spec:200? It is a database
  capability other features would share.
- **Trigger** — manual, or automatic when spec:219 sees a game end? Manual is
  the safer default given the live-game boundary in section A.
