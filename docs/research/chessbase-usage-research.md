# Research: What ChessBase Usage Data Says About the Seven-Module Feature Map

**Question posed in specs/000-vision.md:** the app is organized around seven core modules (Board & Navigation, Analysis Engine, Game Tree & Annotation, Game Database, Opening Explorer, Play vs. Engine, Engine Tournament) — *"should there be more?"*

**Date researched:** 2026-07-14. **Method:** web search across chess.com forums, ChessPub, lichess blogs, coach/GM blogs, and reddit-style query phrasings (see Gaps section — Reddit itself returned no directly indexable threads through this search tool; chess.com forums served as the closest available substitute for casual/serious player discussion).

---

## TL;DR

**Stay at seven, but retarget module 5 (Opening Explorer) and treat two things as load-bearing that aren't currently modules: own-game mistake review and tactics training.** The evidence is consistent and comes from multiple independent angles:

- Coaches and the strongest forum consensus (Dan Heisman's framework, ChessMood's 1500–2000 roadmap, multiple chess.com threads) put the crossover point where **opening/database work starts mattering more than tactics right around 1800–2000 rating** — i.e., almost exactly at the user's target of 1900. Below that, tactical sharpness and endgame technique dominate outcomes; deep repertoire/database work is reported as low-yield.
- What GMs and titled players say they actually use ChessBase for is narrow and specific: **opponent-specific prep** (GM Noël Studer's five-step method), **reference-database queries** (find-games-by-pattern/structure, build a repertoire from filtered results), and **engine-assisted post-game review**. This is a smaller slice than the full ChessBase feature surface, and it maps cleanly onto modules 4 (Database) and 5 (Opening Explorer) — confirming those two modules earn their place for the *upper* range of the user's journey, not as a day-one priority.
- The single most-repeated piece of advice across every source type — coach blogs, forum threads, an IM's own blog, a 1200→2100 player's own account — is **systematic review of your own games**, with engine assistance as the last step, not the first. This is already adjacent to the app's Learn tab (per memory: eval-calibration + AI coach), but it is not currently a named module in the vision doc, and the evidence says it should be treated as one, not as a side feature.
- **Tactics training** (puzzles, calculation drills) is the other universally-cited pillar for the 1200–1900 range, and it's currently absent from the seven modules entirely.
- Things NOT supported by evidence at the user's stage: **opponent prep dossiers** (explicitly called a GM-only workflow, "difficult to imitate" below ~2200 FIDE, per Studer), **repertoire spaced-repetition tooling** (no forum or coach source flagged this as commonly used or missed — likely because Chessable already owns that niche and nobody described replacing it), and a standalone **endgame tablebase browsing UI** (matches the vision doc's existing non-goal — no source argued for this as a UI feature rather than an engine backend).

Recommendation in one line: **don't add a module for GM-only workflows (prep dossiers); do add or formalize "Tactics Training" and elevate "Game Review / Mistake Analysis" (which the Learn tab already starts) to a named core module, because those are what the evidence says actually moves someone from ~1300 to ~1900.**

---

## Q1: What people love about ChessBase (why power users keep paying)

| Claim | Source | Confidence |
|---|---|---|
| "You can use it without an internet connection... full and complete access to your work and files" — offline reliability is a top-cited reason to stick with it | Falkentyne (self-identified NM), chess.com forum ["questions about chessbase?"](https://www.chess.com/forum/view/chess-equipment/questions-about-chessbase) | Single-source, credentialed poster |
| "98% of anything you'd ever need is in there" across ChessBase + Fritz combined | agatti1970 (self-identified ChessBase-affiliated moderator), same thread | Single-source; likely has a vendor-adjacent bias, note as such |
| "a one stop place to analyze, store, catalog my games" — powerful engine, master games, and personal notes unified | blackinght, same thread | Single-source, anonymous forum user |
| Repertoire building via "merge games" — combining similar games, comparing engine analysis against personal notes, building/maintaining a repertoire over time | agatti1970, chess.com ["En Croissant"](https://www.chess.com/forum/view/chess-equipment/en-croissant) thread | Single-source |
| Deep repertoire prep, professional collaboration/annotation features cited by a self-identified professional coach (2050 FIDE) as reasons to keep using ChessBase over free alternatives | Underkkover, same thread | Single-source, moderately credible (stated credentials) |
| Database search by pattern/theme ("find games where a particular pawn structure occurs"), engine-cloud integration, structured repertoire building | madratter7 and Kromok2, chess.com ["Is chessbase worth it?"](https://www.chess.com/forum/view/chess-equipment/is-chessbase-worth-it) | Single-source, anonymous |
| GM-level: reference database (Mega Database + weekly TWIC updates) is described as "the command center for opening work," used to profile opponent style/errors (ChessBase's "Style Report" feature) | ChessBase's own marketing content, [en.chessbase.com "How to prepare against an opponent"](https://en.chessbase.com/post/how-to-prepare-against-an-opponent-with-chessbase-16-and-no-database) | Vendor source — treat as a feature description, not independent endorsement |

**Synthesis:** the love is concentrated in three things — (1) offline, all-in-one reliability, (2) database search sophisticated enough to find games by pattern/structure/theme rather than just player name, (3) repertoire-building workflows that merge/filter/annotate at scale. None of the praise cited is about the board UI, the engine panel, or anything module 1/2/6/7 already covers — which lines up with the project's philosophy that those core interaction modules are table stakes, not differentiators.

## Q2: What people want changed (recurring complaints)

| Complaint | Source | Severity/audience |
|---|---|---|
| "Chessbase is also the buggiest program in existence" — feature bloat causing "spaghetti code" | Falkentyne (NM), [chess.com forum](https://www.chess.com/forum/view/chess-equipment/questions-about-chessbase) | Serious-user complaint (credentialed poster naming a specific mechanism — accreted features, not a casual gripe) |
| Learning curve + hardware/software cost together are prohibitive; "price of an appropriate laptop and cost of chessbase is high" | JBabkes (self-described class player since 1986), same thread | Casual-to-serious; long-tenured user, so weighted higher than a first-time complainer |
| Confusing, undocumented UI elements (e.g. eval bar changing color with no in-app explanation) | Puttpurtle, same thread | Casual UX complaint |
| Most amateur users exploit only "10-20% potential" of the available features — i.e., the bloat is real even by an insider's own admission | agatti1970 (ChessBase-affiliated), same thread | Notable because it's an admission from someone with incentive to defend the product |
| "$800 ... to find out if it will improve their training" — price skepticism, ROI doubt, independent of any specific feature complaint | blackinght, same thread | Casual-to-serious; pricing complaint, not feature complaint |
| "SpanishStallion" calls ChessBase "completely irrelevant" given free Stockfish + freely findable games online | [chess.com "Is chessbase worth it?"](https://www.chess.com/forum/view/chess-equipment/is-chessbase-worth-it) | Casual/dismissive — an extreme minority view, flagged as such by other posters in-thread |
| A moderator's one-line dismissal of a $600 purchase as a "waste" with no elaboration | MaddyCole, [chess.com "$600 version vs yearly subscription"](https://www.chess.com/forum/view/general/chessbase-600-version-vs-yearly-subscription) | Weak evidence — no reasoning given, included only for completeness |

**Synthesis:** the serious-user complaints (bugs from feature bloat, low utilization of the feature surface, high combined cost) map directly onto the project's stated philosophy ("ChessBase has 20 ways to do the same thing... we aim for 80% of the feature surface but 99% of daily-use value"). No complaint in the evidence gathered was about a *missing* feature — every complaint was about excess, cost, or reliability, which argues for the app staying lean rather than growing the module count defensively.

## Q3: What titled players/GMs actually use it for

The clearest primary-ish source is **GM Noël Studer's own published methodology** ([nextlevelchess.com](https://nextlevelchess.com/how-to-prepare-like-a-grandmaster/)), a five-step workflow: gather opponent data (chess.com/lichess/chess-results.com/FIDE profiles) → analyze their games → decide likely opening lines → analyze critical positions → build a review file — using **ChessBase 16 + Mega Database + weekly TWIC updates** as the core tool. Studer is explicit that opponent-specific prep is a GM-tier practice: *"this is a Grandmaster approach and difficult to imitate 100%."* For sub-2200-FIDE players he recommends compressing the entire process to about one hour and one likely opening line — i.e., he himself draws the line between GM workflow and club-player workflow right around 2200, well above the user's 1900 target.

GM Anish Giri, in an interview, describes his preparation as engine-and-cloud-centric ("I never hide the fact that I use Chessify engines for my preparation... It's just what I use full-time now") rather than emphasizing the database side — suggesting even at the top, tooling emphasis varies by player and the "reference DB + prep + novelty-checking + engine" bundle isn't a rigid formula, more a toolkit players draw from differently. ([chessify.me interview](https://chessify.me/blog/interview-with-anish-giri) — vendor blog, direct quote, but curated/selected by a vendor with a promotional interest, so treat the specific tool endorsement as lower-confidence than the general workflow description.)

General secondary claims (2–4 focused hours/day on openings during tournament prep, using Mega Database + Stockfish/Leela + cloud analysis + engine-match self-testing) are aggregator-level and not attributed to a named individual — labeled **inference/estimate**, not verified fact.

Attempts to find direct AMA/interview transcripts with a title-holder saying "here is exactly my daily ChessBase workflow" beyond Studer's article did not surface strong sources in this pass (see Gaps).

**Synthesis, refining the prior:** "reference database + prep against opponents + novelty checking + engine analysis" is directionally correct but the evidence specifically **brackets opponent-dossier prep as a GM/2200+-only practice**, not something club players should build a whole module around trying to replicate. The engine-analysis and reference-database pieces (modules 2, 4, 5) are validated as GM-relevant; the opponent-dossier piece is validated as *not* relevant to the user's 1300→1900 goal.

## Q4: The improver question — what actually moved people from ~1300 to ~1900

This is the most consistent finding across every source type, and it's a genuine consensus, not a single opinion:

- **Dan Heisman's framework**, quoted approvingly in a chess.com thread, states plainly that deep opening/database knowledge provides "negligible benefits below 1800" — at 1200, "the player who plays better tactically will win in either case." ([chess.com: "Why not to 'waste' time studying openings, when GM's do it?"](https://www.chess.com/forum/view/chess-openings/why-not-to-quotwastequot-time-studying-openings-when-gms-do-it))
- **ragchess.com's rating-banded guide** puts it on a timeline that matches the user's exact target: 1000–1600 → master one opening each color, focus tactics; 1600–1900 → start exploring multiple openings via engine, learn pawn structures/positional concepts, begin endgame study; **above 1900** → "use ChessBase to analyze grandmaster games," mix up repertoire. ([ragchess.com](https://www.ragchess.com/chess-improvement-guide-based-on-your-rating/) — single-author blog, no stated credentials, treat as an informed opinion rather than a verified fact, but it independently reproduces the same 1900-ish crossover as the Heisman-quoting thread.)
- **ChessMood's 1500–2000 roadmap** (a commercial training platform run by titled coaches) allocates study time 50% tactics / 30% openings / 10% middlegame / 10% endgame for this exact band — tactics remain the largest single bucket even up to 2000 rating. Notably, **it never mentions ChessBase, databases, or repertoire software** as part of the roadmap. ([chessmood.com](https://chessmood.com/chess-study-plans/for-advanced-players))
- **IM-authored lichess blog** ("datajunkie") argues puzzle-rating gains don't transfer to game tactics unless training is matched to the specific failure mode (pattern recognition vs. calculation) and diagnosed from your own games — reinforcing that tactics training plus own-game diagnosis, not database work, is the lever at this stage. ([lichess.org/@/datajunkie](https://lichess.org/@/datajunkie/blog/why-your-tactics-arent-improving/5lcSErLF))
- **A real 1200→2100 journey** (chess.com forum, self-reported: 11,896 blitz + 996 rapid games over 4 years, 2700 puzzle rating after 239 hours of tactics training): the poster's own account leads with tactics volume and "analysis tool on all my games, at minimum all my losses" — and only mentions importing games *into* ChessBase as a later-stage refinement once already well past 1900, for deeper Stockfish-assisted study. ([chess.com: "from 1200 to 2100"](https://www.chess.com/forum/view/general/from-1200-to-2100-on-chess-com-some-pieces-of-advice-and-anecdotes))
- **Coach Nate Solon's** published game-review framework (aimed broadly but validated down to 1000-rated commenters) puts engines *last* in a five-step process (write your own thoughts first → find critical positions → find patterns across games → ask a stronger player → only then check the engine), and casually assumes *some* database/study-tracking exists ("a Chessbase file, Lichess study, or Chess.com library") but never treats the database itself as the improvement lever — it's just where games are stored. ([newinchess.com](https://www.newinchess.com/blog/post/how-to-review-your-game))
- **The explicit contrarian data point** requested: a chess.com poster states flatly *"you don't need opening preparation to get to 2100"* — directly contradicting any assumption that opening-explorer depth is required through the user's target range. ([chess.com: "Is chessbase worth it?"](https://www.chess.com/forum/view/chess-equipment/is-chessbase-worth-it))
- Countersignal at the *top* of the range: the same thread's original poster is **1900–2000 rated and specifically asking how to manage a growing repertoire**, having outgrown SCID/Lichess study tools — evidence that repertoire/database tooling needs turn on almost exactly where the user is headed, not before.

**Bottom line for Q4, stated plainly because the user asked for it explicitly:** the coach/forum consensus says database and opening-explorer depth is genuinely low-value below ~1800–1900, and the two things that reliably show up in every 1300→1900-range improvement account are (1) high-volume tactics training and (2) disciplined review of your own losses, engine-assisted but not engine-led. This is a real, repeated pattern across independent sources (a commercial coaching platform, an IM's personal blog, a coach's published framework, and an anonymous player's own multi-year account) — not a single opinion.

---

## Path to 1900 synthesis (for the user specifically)

Given the target is ~1300 → ~1900 est., the evidence says the highest-leverage things to have *in the app*, in rough priority order, are:

1. **Tactics training** — not currently a module. Every source in Q4 treats this as the dominant lever below 1900. Currently absent from the seven-module map entirely.
2. **Own-game review / mistake analysis, engine-assisted but engine-last** — adjacent to what the Learn tab (per project memory: eval-calibration training + AI coach) is already building, but not named as a core module in the vision doc. The evidence says this deserves to be one, not a side feature riding on the Analysis Engine module.
3. **Modules 1, 2, 3 (Board, Analysis Engine, Game Tree/Annotation)** — validated as necessary infrastructure for both of the above; no change needed.
4. **Modules 4 and 5 (Game Database, Opening Explorer)** — validated, but the evidence says their payoff window opens around 1900, i.e., at the *end* of this journey, not the start. Keep them, but they're not what gets the user from 1300 to 1900; they're what matters *after*.
5. **Module 6 (Play vs. Engine)** and **Module 7 (Engine Tournament)** — no direct forum/coach evidence either way in this research pass (nobody discussed these as improvement levers, positively or negatively); treat their inclusion as resting on the project's own stated goals (practice, engine-testing fun) rather than on improvement-journey evidence.
6. **Not supported for this user's stage:** opponent prep dossiers (explicitly GM/2200+-tier per Studer), repertoire spaced-repetition tooling (no source flagged as needed or missing), standalone endgame tablebase browsing UI (matches existing non-goal, no counter-evidence found).

## Recommendation on the module map

**Should there be more modules? A qualified yes — two, not seven-plus-many.**

- **Add "Tactics Training"** as a named module (puzzle sets, calculation drills, ideally sourced/tagged by pattern the way ChessTempo/lichess puzzles are) — every single source that discusses the 1300–1900 range names this as the top lever, and it's currently not represented anywhere in the seven modules.
- **Elevate "Game Review / Mistake Analysis"** from an implicit sub-feature of Analysis Engine (blunder-check, per module 2) to its own named module — the evidence-backed workflow (your-own-thoughts-first, then patterns across games, then engine-last) is richer than a per-move blunder threshold and is exactly what the project's existing Learn tab / Elo-conditioned evaluator work (per project memory) is already building toward. Naming it as a core module would make the vision doc match what's already being built.
- **Do not add** opponent-prep dossiers, repertoire spaced-repetition tooling, or endgame-tablebase-browsing-as-a-UI — none of these cleared the bar of "serious players actually use this day-to-day at the user's target level," and two of them are already explicit non-goals in the vision doc for good reason (the Studer opponent-prep bracket, and the existing "we use tablebases for engine eval, not as a standalone feature" non-goal, are both corroborated rather than contradicted by this research).
- **Keep modules 4 and 5 (Database, Opening Explorer)** exactly as scoped — the evidence says they're correctly built for later in the user's journey, not that they're miscategorized.

---

## Gaps and what could not be verified

- **Reddit (r/chess, r/TournamentChess) itself did not surface as directly indexable through this search tool** across multiple query phrasings, including `site:reddit.com` operators. chess.com forums served as the closest available substitute for casual/serious-player discussion; ChessPub was reachable only via a search snippet (one repertoire-maintenance thread title), not fetched directly, so ChessPub content in this report is thin.
- **No direct GM/IM "here is my literal daily ChessBase workflow" interview transcript** was found beyond Studer's own published article and the Giri interview snippet — the "2–4 hours/day on openings, Mega Database + Stockfish/Leela + cloud analysis" claim is an **aggregator-level estimate**, not attributed to a named individual, and should be treated as such.
- **YouTube transcripts** (explicitly requested as a source type) were not searched in this pass — a follow-up could mine GM YouTube "how I prepare" videos (e.g., Daniel Naroditsky, Eric Rosen, GothamChess interviews) for additional direct-quote evidence, particularly for the improver-journey question.
- **Quora** was not directly searched; general web search substituted.
- Poster credibility on chess.com forums is **self-reported and unverifiable** (e.g., "NM," "2050 FIDE") — treated as single-source claims throughout, not verified facts.
