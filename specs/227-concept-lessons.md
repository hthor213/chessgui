# 227: Concept Lessons — principle → illustrate → practice

**Status:** draft
**Depends on:** 001 (board/gameplay), 013 (PGN), 016 (game tree), 202 (annotations)
**Relates to:** 215 (training program — can schedule a lesson as an exercise type),
226 (the Notebook — shares the fair-play boundary), 200 (database — a source of
illustrative games)
**Realizes:** vision — a ChessBase-class *learning* product, better and more modern

> North star: **ChessBase / Fritztrainer**, but with a cleaner, modern UI. Their
> model — a concept explained by a coach, illustrated on annotated master games,
> then drilled with interactive "training questions" — is the shape to beat. See
> **§ North Star** for the specifics that pin the content model. This spec is the
> engine and the first course; the engine is generic, the first course is the one
> the user needs now: **playing closed / locked middlegames.**

## Why

The user's live game is a **locked, maneuvering middlegame**. Their own words:
*"I'm barely motivated to continue — I can only find moves that stall things,
hoping for a mistake."* That is the exact gap this closes: closed positions are
not "stall and pray", they have **plans** (maneuver to your best square, create a
second weakness, time a pawn break), and those plans are **learnable generic
principles** — which the fair-play doctrine explicitly ALLOWS, because they are
about chess-in-general, never about the position on the board right now.

The pedagogy is corporate-LMS shaped, in the user's words: **"first say the
principle, then show it, then practice it"**, with **multiple-choice AND
free-text** questions. That three-beat loop is the unit of the whole system.

## The fair-play line (hard boundary)

- A lesson is **generic study**. It teaches principles and drills them on
  **canonical master games and composed study positions** — NEVER the user's own
  live game, and never a position derived from it.
- The lesson player has **no connection to the live game state**. It does not read
  the active fair-play game's tree, FEN, or notebook. It is its own surface.
- Engine evaluation is **allowed inside a lesson** (it is not the live game): a
  lesson may show an eval, a best line, or grade a "find the move" question against
  a known answer. This is the one place in the app where that is fine, because the
  study position is public knowledge, not the game the user is playing for real.
- Corollary: the lesson library must be reachable **without** an active game, and
  must never surface a lesson "about" the current position.

## What — the three-beat module

Every module is one **principle**, and runs the same three beats:

1. **Principle** — state it plainly first. A short markdown lesson: the idea, why
   it holds, the one sentence to remember. (ChessBase's coach-explains-the-concept
   beat.) Text, optionally a single diagram.
2. **Illustrate** — show it on the board. One or more **annotated master games or
   fragments**: the board steps through the line with commentary pinned to the key
   moves, pausing on the positions where the principle bites. (ChessBase's
   model-game beat.) Reuses the existing board + move list + annotations.
3. **Practice** — drill it. Questions (below), scored, with the explanation on
   reveal. Two placements, and the north-star mechanic favours the first:
   - **Interleaved (preferred):** the practice IS the model game — as the board
     steps through an illustrative game, it **pauses at the turning points and
     asks the user to predict the move** (a `choose_move` question in place). This
     is ChessBase's "training question" / "Move by Move" format. A module may set
     `interleave: true` on an illustration to turn its focus plies into questions.
   - **Block:** a separate set of questions after the illustration, for the ones
     that are not "predict this move" (multiple-choice on the idea, free-text on
     the plan).

   **Bespoke feedback is the differentiator, not the verdict.** A wrong answer
   must explain *the specific mistake* ("this rushes the break before the pieces
   are ready — the c5 push just loses the d5 pawn"), not merely reveal the right
   move. Every question's `explain`/`modelAnswer` is written to that bar.

## Question types

- `multiple_choice` — a prompt (optionally over a board position) and 2–4 options;
  one correct; an explanation revealed after answering. General knowledge or
  "which plan is right here".
- `choose_move` — a board position; the user **plays a move on the board**; graded
  against a set of accepted SAN moves; explanation on reveal. (The "find the move"
  training question — the ChessBase signature.)
- `free_text` — a prompt (optionally over a position); the user **writes the plan
  in prose**; then a **model answer + rubric** is revealed. Grading tiers:
  - **Tier A (MVP): self-graded.** The user reads the model answer and marks
    themselves (got-it / partial / missed). Honest, offline, zero dependency.
  - **Tier B (later): assist-graded.** The free text + model answer + rubric go to
    a model (the app's existing AI plumbing) for a score and feedback. Optional,
    behind a setting; never required. NOT the live game, so it is fair-play clean.

## Data model (data-driven JSON, bundled + extensible)

```
Course   { id, title, blurb, level, modules: ModuleRef[] }
Module   {
  id, title,
  principle:   { markdown, remember (one sentence), diagramFen? },
  illustrations: Illustration[],
  questions:   Question[],
}
Illustration { title, pgn, source, startPly?, interleave?: boolean, focus: FocusNote[] }
FocusNote  { ply, text, ask?: { prompt, accept: string[] /*SAN*/, explain } }
             // ask + interleave → the board pauses here and asks the user to
             // predict the move (the ChessBase "training question")
Question =   // the "block" practice questions, after / beside the illustration
  | { kind: "multiple_choice", fen?, prompt, options: string[], correct: number, explain }
  | { kind: "choose_move",     fen,  prompt, accept: string[] /*SAN*/, explain }
  | { kind: "free_text",       fen?, prompt, modelAnswer, rubric: string[] }
```

- `explain` / `modelAnswer` MUST name the mistake, not just the answer (north-star
  bar). A test can assert every question carries a non-empty `explain`/`modelAnswer`.
- `source` on every illustration is REQUIRED — public-domain classic or clearly
  licensed, cited (see the fair-play / clean-room stance below).

- Courses/modules ship as **bundled JSON** with the app (versioned in-repo under
  e.g. `packages/core/src/lessons/` or `apps/desktop/lessons/`). The **schema** is
  the contract; content is data, so new courses are added without code changes.
- Illustrative games are **public-domain classics** (pre-1923 and well-known
  master games), carried as PGN in the course file with their source cited in a
  `source` field. No licensed ChessBase content is copied — clean-room, same as
  the CBH stance.
- Progress is stored locally (`lesson_progress.json`, append-only, dated):
  per-module completion, per-question score, self-grade for free-text.

## The lesson player (UI)

- A **Lessons** surface (a tab or route, reachable with no active game):
  **course list → module list (with progress) → the module player**.
- **Module player** runs the three beats in order, one screen each, with a stepper:
  - *Principle*: the markdown + "remember" line, a Start button.
  - *Illustrate*: the board with the annotated game; prev/next steps the line;
    the focus note for the current ply shows beside the board; auto-pauses on
    focus plies. Modern, uncluttered — the north-star UI bar.
  - *Practice*: one question at a time; answer → immediate feedback + explanation →
    next. A module-end score card.
- Dense and functional, not marketing polish: this is a study tool.

## North Star — ChessBase's training model (sourced 2026-07-24)

**The signature mechanic — the "training question"** (used across ChessBase
Magazine's "Training with experts", most Fritztrainer courses, and Master Class):
- A presenter video plays while the game runs on the board; at a **critical
  position it pauses and asks the user to ENTER A MOVE on the board** (not
  multiple choice). Points are awarded for a correct answer (exact scoring rules
  are unpublished — treat as simple correct/partial credit).
- **The differentiator is the feedback**: on a wrong or skipped answer the
  presenter's video **resumes with an explanation of the specific mistake**, not
  just "the answer was X." Bespoke correction, not a puzzle verdict.
- The questions are **interspersed inside the annotated model game**, not a
  separate quiz block — the exercise IS the game (Simon Williams' "Move by Move"
  predict-the-move format is the same idea). Density example: Master Class Vol.13
  (Petrosian) = 98 games → 285 training questions (~2.9 per game).

**Course structure** (inferred from Master Class / Sokolov, not an official
template): concept intro → **model games grouped by theme** (not chronology) →
training questions at the turning points inside those games → a database of the
source games shipped alongside for independent study.

**Their strategy/middlegame catalogue**: Daniel King's **"Power Play"** (flagship
middlegame-themes series), Ivan Sokolov's **"Understanding Middlegame Strategies"
Vol. 1–9** (dynamic pawns, hanging pawns/IQP, the Hedgehog, opening-specific
structures) — the closest thing to a pawn-structure curriculum. Master Class
volumes are player-centric annotated-game collections.

**Where ChessBase treats the canon of closed/positional play** (their own
framing): **Petrosian** (Master Class 13 — prophylaxis/defence), **Karpov**
(Master Class 6 — squeeze/restriction), **Capablanca** (Master Class 4 — clean
technique). Note: **Nimzowitsch and Rubinstein are book-canon (My System,
Rubinstein collections) but NOT ChessBase courses** — keep them for the ideas,
don't cite them as "ChessBase does this".

**The gap = our opening.** ChessBase has **no standalone, player-independent
course on "prophylaxis" or "playing closed positions" as a technique** — their
teaching is game-first and player-centric, and the principle only emerges from
the games. This spec is deliberately **principle-first** ("say it, then show it,
then practice it"), which is the user's ask AND the differentiator: a modern,
concept-led closed-positions course is exactly what their catalogue lacks. We
adopt their best mechanic (predict-the-move with bespoke mistake feedback,
interleaved into real master games) and lead with the principle they bury.

**Illustrative canon for closed/locked/maneuvering play**: see the dedicated
**§ The closed-middlegame roster** below (the user's picks, 2026-07-24), which
maps ten teachers to the principles they best illustrate. Nimzowitsch's ideas
(blockade, overprotection, prophylaxis vocabulary) remain the conceptual
backbone. Structures/breaks: King's Indian / Benoni (closed centre, wing play),
Carlsbad (minority attack).

## First course — "Playing Closed & Locked Positions" (the content deliverable)

Working module list (one principle each; the loop builds them one at a time):

1. **Stalling is not a plan.** The motivational reframe: closed positions have
   real plans. Name the four: maneuver, restrict, second weakness, time the break.
2. **The plan comes from the pawn structure.** Play where you have space / on the
   side your pawn chain points; attack the base of the chain.
3. **Improve your worst piece; maneuver to the best square.** Outposts, knight
   routes, the slow regroup. Knights ≥ bishops in blocked positions.
4. **Prophylaxis.** Ask what the opponent wants; prevent the break before your own.
5. **The principle of two weaknesses.** One weakness holds; create a second and
   stretch the defense.
6. **Timing the pawn break (the lever).** When and how to open — and when NOT to.
7. **Patience & waiting moves.** Don't rush; don't create weaknesses; make the
   opponent move first (zugzwang-flavored maneuvering).
8. **Space & restriction.** Convert a space edge; deny counterplay.

Each module = principle + 1–2 illustrative classic games + 3–5 mixed questions
(at least one `choose_move` and one `free_text` per module).

## The closed-middlegame roster (the user's picks, 2026-07-24)

The ten teachers for this course, in the user's own characterization, each mapped
to the module(s) it best illustrates. **This is the sourcing list for D4**: when
a module needs a model game, draw it from that principle's players below. A note
on rights: **game move-scores are facts and freely usable** (any era, modern
included) — it is *annotations* that must be original/clean-room, so any of these
players' games may be carried as PGN with our OWN commentary and a `source` cite.
Prefer historical games where a clean public annotation tradition exists; modern
players (Carlsen, Kramnik, Gukesh) give relatable, contemporary examples.

| Player | What they teach (user) | Best for module(s) |
|---|---|---|
| **Petrosian** — "Iron Tigran", ultimate prophylaxis; anticipates and neutralizes the opponent's plan before it forms; improves his own pieces behind locked chains | prophylaxis; the **blunting exchange sacrifice** (a signature to teach on its own) | **4** (prophylaxis), **3** (maneuvering) |
| **Karpov** — the "boa constrictor"; passive, unassuming maneuvers that suffocate; restricts space until the opponent has no active move | restriction, denying counterplay, the slow squeeze | **8** (space & restriction), **7** (patience) |
| **Carlsen** — unmatched accuracy in quiet complex middlegames; maneuvers through closed structures, pushes the complexity threshold, grinds deep into the endgame | maneuvering + carrying an edge into the endgame; when *not* to force it | **3**, **6**, **7**; the "grind into a won endgame" thread |
| **Kramnik** — Karpov-influenced positional depth; technical precision in closed/semi-closed structures; neutralized Kasparov's attack with the solid Berlin | neutralizing the opponent's activity, solidity, the prophylactic exchange into a safe structure | **4** (prophylaxis/neutralize), **2** (structure) |
| **Botvinnik** — the scientific Soviet-school patriarch; deep strategic planning for closed systems; structure over immediate tactics | **the plan comes from the structure**; long-range planning as a skill | **2** (plan from structure) |
| **Smyslov** — harmonic piece placement; in positions with no attack, maneuvers his forces onto their absolute optimal squares | improving the worst piece; optimal squares/outposts | **3** (improve your worst piece) |
| **Capablanca** — legendary intuitive feel for closed middlegames; finds the right pawn break and optimal piece configuration without heavy calculation | reading the position for the correct **break** and configuration; clarity | **6** (timing the break), **2**, **3** |
| **Gukesh** — modern elite; mature, precise positional play navigating complex closed maneuvering phases | contemporary examples across the closed-play modules (relatability, freshness) | **3**, **7** (modern illustrations) |
| **Tal** — the counter-case: unparalleled at **calculating sacrifices to break open a locked center** and shatter a closed structure | the *other* side of Module 6 — when the answer to a closed position is to blow it open | **6** (when/how to open — the tactical break) |
| **Fischer** — supreme clarity; keeps his pieces active even in closed structures; logically prepares breaks to transition into a winning endgame | active piece play in closed positions; preparing the break to reach a won endgame | **6**, **8**, active-piece thread |

Two teaching notes fall straight out of this roster and belong in the content:
- **Petrosian vs. Tal as a pair** is the module-6 lesson in miniature — the
  prophylactic "keep it closed and improve" instinct against the "calculate a sac
  and blow it open" instinct. Teaching them side by side IS the principle of
  *when* to open.
- **Karpov → Kramnik → Carlsen → Gukesh** is one lineage (restriction and
  technical squeeze, updated each generation) — a natural progression to show the
  same idea across eras, which the player-centric ChessBase courses never do.

## Non-goals

- Not a spaced-repetition SRS engine (progress tracking is enough for v1; SRS is a
  later tier if it earns its place).
- Not tied to the user's rating program (215 may *schedule* a module, but 227 does
  not own the curriculum).
- No live-game coupling of any kind (see the fair-play line).

## Done-When — deliverables for the overnight loop

Each is independently buildable, testable, and committable. Build in order; a
later one may assume the earlier ones. Every code deliverable ships with tests.

### D1 — Lesson schema + loader (core, no UI)
- [ ] `Course`/`Module`/`Illustration`/`Question` types in
      `packages/core/src/lessons.ts`, matching the data model above.
- [ ] A loader that reads bundled course JSON and validates it against the schema
      (bad course → clear error, never a silent half-load).
- [ ] A tiny fixture course (1 module, one of each question kind, one illustration
      with an `interleave` focus-note that carries an `ask`) used by tests.
- [ ] Unit tests: schema validation (accept the fixture, reject malformed); a
      `choose_move` grader that accepts any SAN in `accept` and rejects others;
      and a content-bar test — **every question and every `ask` carries a
      non-empty `explain`/`modelAnswer`, and every illustration carries a
      `source`** (a course that violates either fails to load).

### D2 — Question engine (core, pure)
- [ ] Pure graders for all three kinds: `multiple_choice` (index match),
      `choose_move` (SAN membership, 960-safe like the rest of the tree),
      `free_text` (returns the model answer + rubric for reveal; no auto-grade in
      MVP). Return a typed result `{ correct, explanation }`.
- [ ] A per-module scorer: N questions → score + per-question outcomes.
- [ ] Progress store: read/write `lesson_progress.json` (append-only, dated),
      with tests for round-trip and "resume where I left off".

### D3 — Lesson player UI (desktop shell)
- [ ] A **Lessons** route/tab reachable with NO active game.
- [ ] Course list → module list (with progress badges) → module player.
- [ ] The module player runs the three beats (principle → illustrate → practice)
      with a stepper; the *Illustrate* beat steps the annotated game on the board
      with focus notes; the *Practice* beat runs questions one at a time with
      immediate feedback and a score card.
- [ ] **Interleaved predict-the-move**: on an `interleave` illustration, the board
      pauses at each `ask` focus-ply and waits for the user to play a move; a
      correct move continues the game, a wrong one shows the **bespoke mistake
      explanation** before continuing (the ChessBase mechanic).
- [ ] `choose_move` questions accept a real move played on the board; `free_text`
      reveals the model answer + a self-grade control.
- [ ] Verified in the headless browser (the /verify skill) before "done".

### D4 — First course content: "Playing Closed & Locked Positions"
- [ ] Draw model games from **§ The closed-middlegame roster** — the module→player
      mapping there is the sourcing plan (e.g. Module 4 prophylaxis → Petrosian;
      Module 8 restriction → Karpov; Module 6 open-it-up → Capablanca vs. Tal).
- [ ] Module 1 ("Stalling is not a plan") authored end-to-end as the template:
      principle markdown, ≥1 illustrative game with focus notes, ≥3 questions incl.
      one `choose_move` and one `free_text`, every `explain`/`modelAnswer` naming
      the mistake, every illustration `source`-cited.
- [ ] Modules 2–8 authored to the same bar, one at a time, each committed on its
      own so the loop can checkpoint per module.
- [ ] Rights: the game MOVE-SCORE is a fact and may be carried for any game, any
      era; ANNOTATIONS must be our own (clean-room, same stance as CBH). Every
      illustration carries a `source` cite; a test asserts no illustration ships
      without one.
- [ ] Suggested module-6 centrepiece: a **Petrosian (keep-it-closed) vs. Tal
      (blow-it-open)** pairing, so the lesson on *when* to open teaches both
      instincts against each other.

### D5 — Fair-play guard (correctness, not cosmetic)
- [ ] A test proves the lesson surface imports nothing from the live-game/notebook
      modules and reads no active-game state — the boundary is structural.
- [ ] The Lessons surface renders and functions with no game loaded.

### D6 — (later tier, optional) assist-graded free-text
- [ ] Behind a setting, a `free_text` answer + model answer + rubric can be scored
      by the app's existing AI plumbing, with feedback; never required, never on
      by default, and explicitly OK under fair-play (study, not the live game).

### User-blocked (needs the user's eyeball)
- [ ] The three-beat flow feels like a course, not a quiz bolted on.
- [ ] Module 1 actually moves the needle on motivation — the reframe lands.
- [ ] The illustrative games are the right ones for the principle (chess judgment).
- [ ] Free-text self-grading is honest and not busywork.
