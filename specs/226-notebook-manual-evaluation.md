# 226: The Notebook — human evaluation tree (minimax without an engine)

**Status:** draft
**Depends on:** 016 (game tree — the branch structure this evaluates), 202
(annotations — position-assessment NAGs and the `[%…]` comment-tag convention
are the storage), 219 (fair-play mode — this feature's home, and the source of
its hardest constraint), 013 (PGN — everything here must round-trip)
**Feeds:** 215 (training — "where was my judgement wrong" is a curriculum
signal), 211 (avoidance puzzles — the sharpness axis is the same idea)
**Origin:** user 2026-07-20, while looking at a fair-play variation tree: *"a
crazy, but beautiful, idea that could change how people evaluate chess —
ranking of branches good/bad… I'm basically trying to take whatever could be
done with a pencil/paper/chessboard to the next level."*

## Why

A chess engine answers "what is the best move" and refuses to tell you anything
about how *you* think. Under the spec:219 fair-play lockout there is no engine
at all — so the app currently offers a strong human nothing but a board and a
move list. That's a wasted opportunity: the thing a serious player actually
does over a three-day move is build a tree of candidate lines by hand, judge the
leaves, and reason backwards.

That method is old and well documented — Kotov's tree of analysis in *Think Like
a Grandmaster*: enumerate your candidate moves, examine each branch exactly
once, do not wander. Its weakness has always been bookkeeping. You lose track of
which branches you judged, you re-examine the same line three times, and by move
40 you cannot remember whether you already refuted the piece sacrifice.

This spec is the bookkeeping. The human supplies the evaluation; the app
supplies the search discipline and the backing-up. It is, precisely, the
Shannon/Turing 1950 minimax formulation with a person as the evaluation
function — which is also why it involves **no engine whatsoever** and is legal
during a live Daily game.

### Two co-equal goals

The notebook serves two purposes of equal standing, and neither is subordinate
to the other:

1. **Think better during the game.** Hold a bigger tree than working memory
   allows, stop re-examining the same line, and reason backwards from judged
   leaves without losing your place. This is the immediate, practical payoff.
2. **Produce a faithful recording of how this player actually thought** — which
   lines they saw, which they never considered, how they judged them, what they
   expected the opponent to do. That record is diagnosable afterwards, and the
   diagnosis is what builds the training program (spec 215, spec 225).

The second goal is the one that gets forgotten, so it is stated at length below
— not because it outranks the first, but because "make the position easier to
play right now" is the pressure that will quietly erode it.

Goal 2 inverts what would otherwise look like a design flaw. Measuring coverage
against the user's own fallible candidate list — rather than against the true
legal-move list — means a line can read "examined" when a refutation was never
considered. That is not a bug to fix. **The gap between what the player saw and
what mattered is the most valuable thing the record produces**, and any feature
that quietly fills that gap destroys it.

Hence the axiom this spec is built on, in the user's words:

> *"If I get a list of all legal moves, that's like an outsider pointing out to
> me things I missed. If I missed a candidate move, I need to train more."*
>
> *"If I'm bad at chess, I need to train and get better and I deserve to lose.
> That's the key. That is an axiom."*

From which follows the design law governing every UI decision here:

> **The app may display state. It may never recommend.**

A notebook is passive: you notice the half-empty column because you are reading
your own page, not because it tapped you on the shoulder. Coverage bars are
legitimate — they are your own handwriting reflected back. A prompt saying
"you should look at Bd4 next" is not, however it was derived. No arrows, no
attention-directing banners, no ranking by where effort is missing.

So when two designs compete, both goals get asked: *which helps me think better
now*, and *which produces the better record afterwards*. Neither automatically
wins. What does override both is the axiom — a design that helps in either
direction by supplying chess the player did not produce themselves is out,
regardless of how much it helps.

## What

### A. Assessment — the human evaluation function

At any node the user assigns a **position assessment** using the standard
seven-point vocabulary, because that is exactly what they would write on paper
and it already round-trips through PGN as NAGs (spec 202):

| Symbol | Meaning | NAG |
|--------|---------|-----|
| `+−` | White is winning | 18 |
| `±` | White is clearly better | 16 |
| `⩲` | White is slightly better | 14 |
| `=` | equal | 10 |
| `⩱` | Black is slightly better | 15 |
| `∓` | Black is clearly better | 17 |
| `−+` | Black is winning | 19 |

Entry must be **fast** — single keystrokes at the current node. The value of the
feature is judging as you explore, not stopping to fill in a form.

Three distinct states, never conflated:
- **assessed** — the user has judged it.
- **explored but unassessed** — a node exists; no judgement yet.
- **unexplored** — a legal move nobody has looked at.

### B. Backing-up — strict minimax

A node's **backed-up value** is the best child value for the side to move: max
at the user's nodes, min at the opponent's. Not an average, not a weighting.

This is the answer to the question that prompted the spec — *"I've evaluated
9 of 10 legal moves and the 10th is brilliant, should that move the needle?"*
Under minimax the 10th move **is** the value of the position and the other nine
contribute nothing, because you only have to find one good move. Averaging
would destroy exactly the information that matters. What the other nine tell you
is not value but **sharpness** (section E).

### C. Coverage — measured against the user's own candidate list

Every node reports how much of it the user has looked at — **against the
candidates they themselves named**, never against the true legal-move list:

```
b4    = … +−     2 of my 6 candidates
```

The app never enumerates legal moves, never counts them, and never reveals that
more exist. Naming candidates is the player's job and its failures are the
training signal (see "The real purpose" above and section H).

Two consequences to hold onto, both deliberate:

- **The app must never say "fully examined."** The honest phrasing is "all
  candidates examined", because the set was the user's and may have been
  incomplete. Wording that implies objective completeness is forbidden — it
  would be the app vouching for a claim it cannot support.
- **The uncertainty range is bounded by vision, not by chess.** A range reads
  "as far as I could see", not "objectively". A line can be exhaustively
  covered and still lose to a move that was never on the list.

Coverage is displayed **beside** the value and never mixed into it. It carries a
property that falls out of minimax and is the most honest thing in the feature:

- At the user's nodes, further search can only **raise** the max → the current
  value is a floor.
- At opponent nodes, further search can only **lower** the min → the value
  **decays as you check more of their replies**.

So "this looks winning, but I've only checked 2 of 25 of their answers" is a
rigorous statement, and the number moves against you the more honest you are.
That is the discipline that stops a player falling in love with a line, and the
UI must present it prominently rather than as a footnote.

### D. Practical ranking — the opponent is not an engine

Minimax assumes the opponent finds the best move every time. Real opponents do
not, and the user has knowledge no engine has: *how likely is this person to go
wrong here*. Each opponent reply therefore carries **two independent
judgements**:

- **How good is it** → the assessment (section A), feeding minimax.
- **How likely is he to play it** → three buckets: **likely / possible /
  unlikely**, stored as relative weights and normalised across the replies
  actually assessed, so the user never has to make percentages add up.

**Combination is lexicographic: objective value first, practical chances only
as a tie-break.** In the user's own words: *"if two moves from me are equal, but
one has a higher probability the opponent will make a mistake — that sorts the
two previously equal moves."*

This ordering is a safety property, not a preference. Pure expectimax rewards
hope-chess: offered a clean draw and a losing move the opponent might not
punish, a weighted average will recommend the losing move. Lexicographic
ordering makes that structurally impossible — practical chances can never
promote an objectively worse move.

Deferred, not rejected: an explicit "I'm worse, play for chances" mode that
inverts the priority. When genuinely losing, practical chances *are* the
objective. It should be a deliberate act, never a silent default.

### E. Sharpness (later)

`9 bad / 1 brilliant` and `10 good` have the same minimax value and completely
opposite practical character — the first is where a human goes wrong over the
board. Sharpness = how many legal moves reach the node's value. Not in the first
version; recorded here because it is the natural second axis and it connects to
spec 211's avoidance puzzles.

### F. Display — sorting, not rewriting

Variations render best-first by backed-up value (then by practical tie-break),
but **the stored tree and the PGN mainline are untouched**. The order the user
explored in is real history and is not overwritten by their later conclusions.
A toggle switches between "as I explored" and "as I rank". Committing an order
into the tree may come later, as an explicit action.

### G. The Notebook Doctrine — the compliance architecture

The user's constraint, in their words: the notebook is the only evidence
available during a live game; they may write anything into it — including
Stockfish's verdict written down *after* a game — but they must **read it
linearly**. Notebooks may be organised (by month, by opponent). No search.

The rule this reduces to:

> **No engine verdict may be reachable at machine speed.** Human-speed linear
> reading is permitted over anything. Position-indexed query is permitted only
> over corpora that contain no engine evaluation at all.

The reasoning matters, so it is recorded rather than just the rule:

- **Content is not the problem; retrieval is.** Reading a book written with
  engine help is studying, and books are explicitly permitted in Daily play. A
  note reading *"K+Q vs K+R — drive the king to the corner"* is knowledge, not
  assistance, however it was learned.
- **Position-indexed retrieval over one's own notes is the danger.** Every game
  gets reviewed with an engine afterwards, so over months a searchable notebook
  silently becomes an engine-evaluation lookup table keyed by FEN. Querying it
  mid-game is consulting Stockfish with extra steps and a time delay. The
  laundering is invisible and it is still cheating.
- **The friction is load-bearing.** Linear reading is safe *because* it is slow
  and unreliable, exactly as a physical notebook is. Removing the friction
  removes the compliance.

Architectural consequences:

- The notebook store exposes **no by-FEN query** to any fair-play surface —
  enforced at the query layer, not in the UI, with the same two-layer treatment
  as the engine lockout (a TypeScript guard plus a Rust-side refusal), so it
  cannot be re-enabled by accident.
- The **opening explorer stays available** (spec 219 already keeps it; chess.com
  names it as permitted). It is position-indexed but contains only human game
  frequencies and results, so it cannot launder an engine verdict — but it must
  therefore serve frequencies and results **only**, never any stored engine
  evaluation from the spec 200 database. Any store that has both position
  indexing *and* engine-derived content must be unreachable in a fair-play game.
- **Provenance on every assessment.** A judgement made during a live game is
  stamped human-only. Post-game engine review writes to a **separate field** and
  never overwrites it, so the node carries both, labelled, permanently:

  ```
  18. b4    my: ⩲   (live, human-only)
            sf: −0.4 ∓  (reviewed 2026-07-22)
            → overrated by roughly one band
  ```

  Without the separation the distinction is lost after the first review — and
  with it goes both the compliance guarantee and the answer to "where is my
  judgement actually wrong", which is the point of keeping notes at all.

The standard being applied is stricter than the letter of the Fair Play Policy
in places, deliberately. The user's acceptance test: if anyone from chess.com or
an opponent inspected the system, the reaction should be *"this is crazy good,
you should sell it"* — never a question about whether it was assistance.

### H. Post-game diagnosis — the second goal's payoff

Once the game is finished and the lockout lifts (spec 219 D), the engine reviews
the same tree. Comparing the human record against the engine's verdict
decomposes "I played badly" into **three separately trainable failures**:

| Failure | What the comparison shows | What it trains |
|---------|---------------------------|----------------|
| **Blind spot** | A move that mattered was never on the candidate list at all | Candidate generation — seeing the moves |
| **Misjudgement** | The move was listed, but assessed wrongly (`⩲` where the engine says `∓`) | Positional evaluation |
| **Opponent-model error** | A reply marked *unlikely* was played, or *likely* never came | Reading this specific opponent |

These are different skills with different remedies, and no existing tool
separates them — because no existing tool records what the player considered
*before* seeing the answer. That record only exists because the app refused to
supply the legal-move list. This is the payoff for the axiom in section "The
real purpose".

Feeds spec 215 (the curriculum engine) and spec 225 (per-opponent profiles).
Blind spots suggest calculation and candidate-move training; misjudgements
suggest positional study, ideally on the specific structure; opponent-model
errors refine that opponent's profile for the next game.

#### Why the move was played — the assumption that wasn't true

The classification above quietly assumed every played move came out of the
notebook. It does not, and the user caught it from the live game (2026-07-21):

> *"I made a move b6 because I gave up :-) meaning, I didn't quite understand
> my notebook - it was a gut feel, so make a note of that so future analysis of
> the notebook doesn't get wrong info."*

Run the diagnosis over that decision and it sees "rated something else best,
played b6" and reports a **selection error** — prescribing training for
choosing badly. The truth is the opposite: nothing was chosen *from*, because
the analysis was unreadable. The remedy is a UI fix, not chess study, and the
finding would have sent the player in exactly the wrong direction while
sounding authoritative.

So `PlayedMove` carries **`chosenBy`**: `notebook` | `gut` | `forced` | `other`.
Deliberately coarse — this gets answered mid-game, and a taxonomy nobody can be
bothered to use records nothing.

- **Only `notebook` licenses a selection-error finding.** Unrecorded counts as
  unknown, not as `notebook` — the conservative default every other gate in
  this feature uses. The class therefore stays dormant until provenance is
  actually recorded, which is the right way round: never claiming a selection
  error beats claiming one wrongly.
- Blind spots, misjudgements and opponent-model errors are **unaffected**.
  Those are claims about what the player saw and judged, which stay true
  whether or not the analysis drove the move.
- `gut` is not a failure and must never be reported as one. A strong player
  plays on feel constantly. What it *is* is a signal about the tool: a game
  full of `gut` at decisions where the notebook held a confident answer is the
  app failing to be readable, and it belongs in that report rather than in the
  player's.

Known gap: nothing records `chosenBy` yet — it needs a prompt at the moment the
real move is committed (a three-way tap, not a form). Until then the field is
always unknown and selection errors never fire.

Bounded honestly: a single game yields a handful of data points. Aggregate
across notebooks before claiming a pattern, and label small samples as such —
the same sample-size gate spec 225 already applies to player profiles.

#### Revealed preference — the played move outranks the typed symbol (user 2026-07-21)

> *"I may not state my top ranked line … I search and search, and when I think
> I see an opportunity I'll go on chess.com and make a move, so the notebook
> needs to look at the move I made and consider that top … worth noting the
> discrepancy in post-game analysis."*

The player reasons in symbols but COMMITS in a move, and the commit is the truer
statement. Many decisions never get an assessment at all — the search runs, an
opportunity is felt, a move is played. So the notebook's ranking has two
sources, and the move wins: an assessment orders the candidates until one is
played, and from then on the **played move is the top of that decision**,
whatever the symbols say. It costs no input — sync already reveals it (it is the
candidate that continues to the next live position) and the decision log already
records the peers that were ranked, so the two are there to compare for free.

This RE-FRAMES the selection-error class above, which had it backwards. A gap
between the assessment-top and the played move is not "you chose wrong". It is a
disagreement between two decision systems — analysis and intuition — and the
engine breaks the tie three ways:

- ranked X, played Y, engine says **X** → trust the analysis next time (the
  only case that resembles an error, and it is a trust error, not a chess one)
- ranked X, played Y, engine says **Y** → intuition beat calculation here; the
  symbols were miscalibrated for this kind of position
- engine says neither matters → no signal

The value is telling the player WHICH instrument to believe in WHICH kind of
position, per opponent and structure over many games. That is a far better
curriculum signal than a scold, and it is only available because the record
keeps both the reasoned ranking and the committed move.

### I. What the tree reveals — width, and the head-to-head (user 2026-07-21)

Assessments answer "how good is this position". They do not answer the question
the player is actually asking, which is "which of these do I want to play". Two
candidates that back up to the same value are not therefore equal, and this
section is about what separates them.

#### Branch width, reported but never ranked on

Alongside coverage, each candidate reports how many of the opponent's replies
the user has marked **likely**: *"3 likely · 5 of my 7 examined"*.

The user's observation is sound chess — a narrower branch is worth something
because a human has fewer chances to go wrong in it, which is a practical fact
no engine will ever tell you, since engines do not tire or miscalculate.

But width is **displayed beside coverage and never ranked on**, because it is
drawn from the user's own labels and therefore inherits their effort: three
likely replies rather than four may mean the position is narrower, or may mean
they looked harder at the other one. Width is only comparable at equal
coverage — the same non-uniform-depth problem as section C, wearing a different
hat. Ranking on it would let an under-explored branch win for being
under-explored, and would also be the app passing judgement on the shape of the
tree, which section "The app may display state" forbids.

#### The head-to-head — pairwise preference with a recorded reason

When two candidates tie, the user compares them directly:

- **The representative position** of a branch is found by walking the
  most-likely path to its end: at the opponent's nodes take the reply the user
  marked most likely, at the user's own nodes take their best-assessed move,
  until the line runs out (bounded, so a long line cannot run away). That is
  the position they would most probably actually reach, which is the one worth
  looking at.
- **Compare mode** puts both positions on screen as two full boards, with the
  panel stepping aside. Looking hard at two positions IS the task at that
  moment, and small boards are exactly what makes a position hard to judge.
- The user picks one and says **why** — free text, with optional one-tap tags
  (safer king, clearer plan, fewer ways to go wrong, …).

Why this is worth more than more assessment:

1. **It asks a question a human can answer reliably.** "Is this ⩲ or ±?" is
   hard and the answers will be inconsistent between Tuesday and Friday.
   "Which of these two would I rather have?" is answered instantly and
   consistently. People compare far better than they score.
2. **The reason is the training data.** Accumulated over a season, those
   recorded whys — and the cases where the engine later disagrees — describe
   the player's taste and locate where it is systematically wrong. That is
   goal 2 paying off in a way assessments alone cannot deliver.

It stays inside the axiom: the app selects nothing and evaluates nothing. It
puts two of the user's own positions side by side and writes down what they say.

#### How a preference affects the order

Preferences are pairwise, and pairwise preferences from a human are **not
guaranteed to be transitive** — A over B, B over C, C over A is a perfectly
ordinary thing for a person to feel. So the ranking must not assume a total
order it cannot have.

Among objectively-tied siblings, order by **Copeland score**: the number of
recorded head-to-head wins against the others in that tie group. It degrades
gracefully under intransitivity (a 3-cycle simply scores 1-1-1 and falls
through to the next key) rather than producing an order that depends on
comparison sequence. Full key order becomes:

    objective value → practical chances → Copeland score → exploration order

A preference never crosses an objective-value boundary, for the same reason
practical chances never do.

### K. No mainline past the live position (user 2026-07-21)

> *"would it not be more natural to say (exploring) … that's just what I tried
> first, not what I think is best … these are all variations"*

In a game record the mainline is **what was played**. Past the live position
nothing was played, so the mainline slot there means only *what I typed first* —
and rendering that branch in the game's own column while its siblings get
parenthesised states a preference the player never expressed. It is the same
false hierarchy as the ordering problem in section I, wearing the tree's
clothes.

So the move table ENDS at the live position. Below the divider, every branch out
of it is a peer: same indentation, no parentheses, none in the game's column.
Nesting resumes normally INSIDE each peer, where the player really is following
a sequence.

Two arguments, and the second is the stronger one:

1. **Honesty.** They are peers, so they look like peers.
2. **Reordering.** The user's own point: peers can be re-sorted as the ranking
   changes, the way engine lines trade places in a MultiPV readout. With a
   privileged mainline a re-rank is a *structural* event — parentheses
   appearing, indentation shifting, one line dropping out of the game's own
   column and another climbing into it. *"Would be strange if the mainline
   jumps down and something else up to mainline."* A flat peer list makes
   ranking usable rather than jarring, which is what the ranking is for.

Rejected: writing `?` in the empty mainline cell. In chess notation `?` already
means *mistake*, so `18… ?` would read as a judgement on the move rather than
as "undecided".

Note for whoever touches this next: the previous behaviour — an in-row divider
plus dimmed exploration cells — had NO test coverage at all, which is why a
structural rewrite broke nothing. It has coverage now: rows stop at live, peers
are equal, and a re-rank is a reorder rather than a promotion.

### L. Navigating your own tree — retreat and re-walk (user 2026-07-21)

The problem: you play a move into a line, go eight moves deep, decide it is not
great — but you cannot remember what you actually played at the start, and ten
undos leave you unsure whether you are back where you meant to be. Answer with
the BOARD, not the move list: the board *shows* the move, the list only names it.

**Retreat = jump to the branch head.** From anywhere in a peer line, one key
lands on its head — the move you first played off the live position. Nothing
deeper is a well-defined stop, and this is why:

- **A fork is not a decision point, and the app must not treat it as one.** The
  tempting idea — stop retreat at each node where you had more than one
  candidate — was rejected, because forks mark where you *flailed*, not where
  you found the answer. In a closed position you may branch widely out of
  confusion while the move that decides the game is a single narrow line you
  stumbled on clean. Stopping retreat at "where I worked hardest" would route
  you toward the noise and away from the find. This is the same law as sharpness
  (section E) and width (section I): **effort is not quality**, and the app
  never navigates by effort.
- The player asked directly, "do I also need to start marking big moments?" No.
  The app will not ask for it (the input budget is already spent on symbols and
  buckets) and will not guess it either, because guessing means judging effort
  or importance, which it does not do.

**Re-walk = preview-then-commit.** From a node, one tap ghosts the move you
played from here last time — the piece slides to its square and back, the board
answering "this is what you did" — with the cursor unmoved and nothing
committed. Tap again to make it and advance; play anything else to diverge. Your
own move shown back to you is DISPLAY of your state, not a recommendation: the
axiom bars the app from supplying chess you did not produce, and this is chess
you produced.

**Jump to your best line.** One key goes to the head of your top-ranked peer.
The ranking is your own (section I's key order), so this is navigation to your
own conclusion, the keyboard twin of clicking the top of the ranked peer list —
never the app's chess. Once a move has been played from the live position, that
move is the top (revealed preference, section H), so the key follows the commit
rather than the symbols.

Two keys — up through your branch head, down through your line with a preview —
plus a jump to your best. Nothing new to mark, nothing rendered as a suggestion,
the board carrying every answer it can.

### J. Two artifacts — the game is saved pure (user 2026-07-21)

> *"we need a parallel database / different table / pgn++ … that's my training
> database with a pointer to this game, but not saved in this game … when
> concluded this game is saved pure = as played"*

The notebook produces two things with different owners, different lifetimes and
different homes, and conflating them is a mistake worth naming up front.

**The game** is a historical fact. Two people played it; it belongs to both of
them and to the record. On conclusion it is archived to the spec 200 database
**exactly as played** — the real PGN from chess.com, no assessments, no
likelihoods, no preferences, no coverage. It is exportable, importable
elsewhere, comparable with anyone else's copy, and identical to what the
opponent has. Nothing about the user's thinking is welded into it.

**The training record** is about the player, not the game. It is private, it is
the interesting half, and it lives in its own store with a **pointer to the
archived game** — never inside it. It holds:

- the candidate set at every decision, *including what was never considered*
- assessments with their provenance stamps
- likelihood labels, and afterwards what the opponent actually played
- preferences: winner, loser, reason, tags
- coverage and width at each decision — how hard they looked, how wide it was
- joined in after the game: the engine's verdicts, and the three failure classes
  from section H (blind spot / misjudgement / opponent-model error)

**Why the separation earns its keep.** The questions worth asking are
cross-game, not within-game — *"when a piece is inactive I tend to lose sight of
it and leave it out of my evaluations"* is a pattern over dozens of games, found
by characterising the moves that never made it onto a candidate list. That needs
a store shaped for query across games, joined to engine verdicts, with the
player as the unit of analysis. A game file is shaped for none of that, and
stuffing it in would corrupt the archive for no gain.

It also keeps the compliance story simple: the archived game is unremarkable and
identical to the opponent's copy, and everything personal sits somewhere it can
be inspected on its own terms.

**Capture happens at SYNC time, before the prune — not at archive.**

Spec 219 F prunes exploration behind the live position every time the game
advances. The user asked for it and it is right: dead lines bury the move list
within a few moves. But those branches ARE the candidate sets this record is
made of, so extracting at archive time reads a tree the prune has been emptying
for days.

Measured on the real painterdenny game (2026-07-21), after the user asked
whether they had ever ranked b6:

| | nodes | assessments | branch points |
|---|---|---|---|
| board, 10:07 | 131 | 17 | 9 |
| store, 12:14 (one sync later) | 36 | 0 | 0 |

So each sync snapshots the decisions FIRST and accumulates them on the
active-game record; the prune then runs purely for readability, and the archive
builds the record from the log merged with whatever the tree still holds.

The merge rule is load-bearing: **a capture is never replaced by one naming
fewer candidates.** Once a node has been pruned every later sync re-extracts it
holding only the move that was played, and last-write-wins would overwrite the
good snapshot with that — reintroducing the loss through the very mechanism
meant to prevent it.

**The doctrine still binds it.** During a live game the training store is
subject to the same rule as the notebooks: no position-indexed retrieval, ever
(section G) — and it is the store most dangerous to expose, since it will hold
engine verdicts joined to positions. It is a post-game instrument. Feature
extraction and pattern finding belong to the spec 215 pipeline; this section
fixes only where the data lives and what shape it has.

**On the ranking maths.** Copeland is what the user can compute with a pencil
and a matrix today, so it is what ships. But the tags recorded with each
preference are, structurally, **conjoint attributes** — every head-to-head
carrying `[safer king] [clearer plan]` is one row of a design matrix. So the
preference log is already the raw data for a conjoint fit, yielding part-worth
utilities per attribute ("how much do I actually pay for king safety versus a
clear plan") rather than one undifferentiated preference order. That is the
natural evolution once the log is long enough; recorded here so the shape of the
data is not narrowed in the meantime.

## How

- **Assessments**: position-assessment NAGs on the node (spec 202 storage,
  already parsed, already exported, already rendered).
- **Likelihood**: a PGN comment tag alongside the existing `[%clk]` / `[%eval]`
  convention — e.g. `[%lik 2]` — so it round-trips through PGN with no schema
  change. `splitComment` already strips `[%…]` tags from display text.
- **Provenance**: a comment tag on the same principle, recording whether the
  assessment predates engine review.
- **Backed-up value, coverage, ordering**: all derived on read. No persistence,
  no cache invalidation, no migration. The tree is small enough that recomputing
  on every keystroke is free.
- **Engine separation**: human assessment and engine eval occupy different
  fields on the node; the ranking reads only the human one. This is what makes
  the feature safe to run inside the lockout.
- **Preferences** (section I) are pairwise and belong to no single node, so
  while the game is being played they ride the working tree as their own list —
  `{parentId, winnerId, loserId, reason, tags, at}` — persisted through
  localStorage and the active-games store. PGN has nowhere to put them, and
  that is correct rather than a gap: on conclusion they move to the training
  record, not into the archived game (section J).

## Non-goals

- Any engine involvement in producing, seeding, or suggesting an assessment.
  The evaluation function is the human; that is the entire premise.
- **Supplying, counting, or hinting at legal moves the user did not name.** Not
  a legal-move list, not a count, not a "22 replies remain" figure, not a
  highlight, not a nudge toward an unexamined branch. Every one of these
  overwrites the blind-spot record that section H depends on. This is the
  single most important non-goal in the spec, and the most tempting to violate
  because each individual instance looks helpful.
- A search guide that says what to examine next. Considered and rejected: it
  ranks by stakes, which means judging the position, which is the user's job.
  Passive coverage bars convey the same fact without pointing.
- Seeding opponent likelihood from rival profiles (spec 225) during a live game.
  Manual only. Revisit only after the feature has proven itself.
- Percentages, elaborate weighting schemes, or "confidence intervals" over
  human judgement. Three buckets and seven symbols.
- Replacing the flowing move list or the annotation bar. This is an additional
  reading of the same tree.

## Done-When

### Agent-verifiable

- [x] Assessing a node with a single keystroke stores the matching NAG and the
      value appears in the move list
- [x] Backed-up value is max at the user's nodes and min at the opponent's,
      verified on a hand-built tree including the "9 bad, 1 brilliant" case —
      the node takes the brilliant value
- [x] Coverage counts examined-vs-named-candidates, and NO surface anywhere
      exposes a legal-move list, a legal-move count, or a count of unexamined
      replies — grep-verifiable, and the phrase "fully examined" appears
      nowhere
- [x] Post-game review classifies each divergence as blind spot / misjudgement
      / opponent-model error, on a fixture game with one of each
- [x] Exploring one more losing opponent reply LOWERS a line's backed-up value;
      exploring one more good move for the user RAISES it — the decay property
      holds in both directions
- [x] Likelihood buckets normalise across assessed siblings and never alter the
      objective ordering — an objectively worse move is never sorted above a
      better one, whatever its likelihood
- [x] Assessments and likelihoods survive a PGN export/import round trip
- [x] Display sorting changes render order only: the serialized tree, the
      mainline, and the exported PGN are byte-identical before and after
- [ ] The notebook store rejects a by-FEN query originating from a fair-play
      context, at the query layer, with a Rust-side refusal as the second line
- [ ] The opening explorer surfaces no engine-derived evaluation in a fair-play
      game (frequencies and results only)
- [ ] A post-game engine review writes to the engine field and leaves the
      human assessment and its provenance stamp untouched

#### Section I — width and the head-to-head

- [x] Each candidate reports how many replies the user marked likely, beside
      its coverage — and nothing anywhere sorts on that count
- [x] The representative position walks most-likely at the opponent's nodes and
      best-assessed at the user's own, stops when the line ends, and is bounded
      against a runaway walk
- [x] Compare mode shows two full-size boards with the panel stepped aside;
      leaving it restores the previous view and cursor exactly
- [x] A recorded preference orders objectively-tied siblings by Copeland score,
      and an intransitive 3-cycle (A>B, B>C, C>A) produces a stable order
      rather than one that depends on the order the comparisons were made in
- [x] A preference never promotes a candidate above one with a better objective
      value, whatever the reason recorded
- [x] Preference reason + tags survive a save/load round trip through the
      active-games store

#### Section J — the two artifacts

- [x] Archiving a finished game writes the real PGN to the spec 200 database
      with NO notebook content: no assessment NAGs the user added, no
      likelihood tags, no preferences, no coverage. Byte-comparable with the
      PGN chess.com served.
- [x] The training record is written to its own store, carries a pointer to the
      archived game, and holds the candidate sets including the moves that were
      never considered
- [x] The training store rejects a position-indexed query originating from a
      fair-play context, at the query layer, exactly as the notebook store does
      — it is the more dangerous of the two, since it holds engine verdicts
      joined to positions

### User-blocked (needs the user's eyeball)

- [ ] The assessment keystrokes are fast enough to use *while* exploring rather
      than as a separate pass — the feature's whole premise
- [ ] The coverage warning reads as useful discipline rather than nagging
- [ ] The lexicographic ordering matches the user's actual judgement on a real
      position from a live game
- [ ] User confirms the notebook workflow is one they'd defend unprompted to
      chess.com
- [ ] After a real game, the three-way diagnosis tells the user something they
      did not already know about their own play — the feature's actual payoff,
      and the thing that justifies every restriction above
