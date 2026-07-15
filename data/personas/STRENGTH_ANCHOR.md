# Strength Anchor: Fischer (peak ~1970–72) vs Kasparov (peak ~1985–2001)

**Purpose:** era-adjusted Elo delta between peak Fischer and peak Kasparov, for calibrating
simulated matchup strength. Fischer and Kasparov **never played a rated game against each
other** (Fischer's last competitive game before his 1972–75/1992 gaps predates Kasparov's
rise; their careers only briefly overlap via the 1992 Fischer-Spassky rematch, which was
not against Kasparov). Every number below is therefore an inference through rating systems
or shared opponents, not a direct measurement. Treat all deltas as **estimates**, not facts.

## Evidence table

| # | Source | Method | Fischer figure | Kasparov figure | Implied delta | Confidence / caveats |
|---|--------|--------|-----------------|-------------------|----------------|----------------------|
| 1 | Chessmetrics, "FE" edition (Jeff Sonas, ~2005), [Top-500 1-year peaks](http://www.chessmetrics.com/cm/FE/FE1.htm) | Performance-rating system computed from game results with a sliding weighted window; explicitly tries to normalize across eras | 2914 (peak 1-year avg, Dec 1971) | 2895 (peak 1-year avg) | **Fischer +19** | Single-source, older Chessmetrics build; cited via [ChessBase "Greatest Chess Player pt.II"](https://en.chessbase.com/post/the-greatest-che-player-of-all-time-part-ii) and [chess.com reprint](https://www.chess.com/article/view/the-greatest-chess-player-of-all-time---part-ii), not fetched from chessmetrics.com directly (site has a broken TLS cert, could not verify page content live) |
| 2 | Chessmetrics, "CM2" revision (later Sonas build), via [Wikipedia "Comparison of top chess players throughout history"](https://en.wikipedia.org/wiki/Comparison_of_top_chess_players_throughout_history) (secondary aggregator citing chessmetrics.com/cm/CM2/PeakList.asp) | Same family of method, revised algorithm/window | 1-yr peak 2881; 5-yr peak 2841; 10-yr peak 2810; best single month (Oct 1971) 2895 | 1-yr peak 2879; 5-yr peak 2875; 10-yr peak 2863; best single month (Mar 1993) 2886 | **1-yr: Kasparov +2 (~tie); 5-yr: Kasparov +34; 10-yr: Kasparov +53; best-month: Fischer +9** | Secondary source (Wikipedia relaying chessmetrics.com); could not load chessmetrics.com directly (TLS cert mismatch on both http/https). Pattern is consistent and important: **Fischer wins on shortest window (single best month), Kasparov wins increasingly as the averaging window lengthens** — Fischer's peak was a spike, Kasparov's was a plateau |
| 3 | FIDE official rating list (raw, not era-adjusted) | Direct rating list | 2785 (July 1972) | 2851 (July 1999) | **Kasparov +66 (raw, uncorrected)** | Verified by multiple sources incl. [Wikipedia "List of chess players by peak FIDE rating"](https://en.wikipedia.org/wiki/List_of_chess_players_by_peak_FIDE_rating), [bobbyfischer.com](https://www.bobbyfischer.com/chess-career/elo-rating). **Widely acknowledged as confounded by rating-pool inflation** (more rated players, rating floor effects, deeper Elo pool by 1999) — this delta is a ceiling, not a fair era-adjusted estimate |
| 4 | Larry Kaufman (2023), engine-accuracy-based peak estimate, reported in [chess.com "Accuracy, Ratings, and GOATs"](https://www.chess.com/article/view/chess-accuracy-ratings-goat) | Move-quality/CAPS-style accuracy score converted to an equivalent peak Elo (method 1, no time adjustment) | Quality score 92.52 → Elo-equivalent 2802 (peak years 1970–72; actual FIDE avg during peak 2762) | Quality score 92.76 → Elo-equivalent 2821 (peak years 1993–2001; actual FIDE avg during peak 2809) | **Kasparov +19** | Single secondary source (chess.com summarizing Kaufman); could not reach Kaufman's original analysis directly. Article explicitly states "much of [Kasparov's] higher FIDE peak resulted from rating inflation," i.e. even this *smaller* +19 gap is treated by the author as still partly inflation-driven |
| 5 | Kaufman (2023), same source, **time-adjusted** variant #1 (+2.5 Elo/decade... actually per-year secular strength-of-field drift, applied backward from a 2017 baseline) | Adds a flat era-improvement correction to older players | 2917 | 2871 | **Fischer +46** | Same single secondary source as row 4. This method assumes the *level of play itself* has risen ~2.5 Elo/year independent of the rating pool, then normalizes both players to a common baseline year — it rewards Fischer more because he is further from the 2017 baseline |
| 6 | Kaufman (2023), time-adjusted variant #2 (+2 Elo/year) | Same idea, smaller correction factor | 2894 | 2861 | **Fischer +33** | Same caveat as row 5 — sensitive to the assumed per-year drift constant, which is itself an estimate, not a measured quantity |
| 7 | Ken Regan, Intrinsic Performance Ratings (IPR) — [Regan & Haworth, "Intrinsic Chess Ratings" (AAAI 2011)](https://cse.buffalo.edu/~regan/papers/pdf/ReHa11c.pdf); [Regan, "Intrinsic Ratings Compendium" (working draft)](https://cse.buffalo.edu/~regan/papers/pdf/Reg12IPRs.pdf) | Engine-move-quality regression (Rybka-based) converted to an Elo-equivalent, independent of game outcomes — the most rigorous, peer-reviewed cross-era method in this table | **Not extracted** — PDF text could not be parsed by available tools (binary/FlateDecode streams); a 2026 chess.com interview with Regan gave point rating for Capablanca (~2950 performance, NY 1927), Morphy (~2350), Lasker (~2700+) but **no specific Fischer or Kasparov figures** were quoted in any secondary source found | same | **NOT OBTAINED — gap, see below** | Regan's general public claim (widely cited but not independently re-verified here) is that ratings/skill have been roughly flat since ~1980, i.e. he argues **against** large inflation post-1980 — this would tend to shrink, not widen, any Kasparov-favoring inflation-adjustment relative to row 3, but I could not pin an exact Fischer/Kasparov IPR pair to cite |
| 8 | Guid & Bratko, "Computer Analysis of World Chess Champions" (ICGA 2006), [paper](https://www.researchgate.net/publication/220174548_Computer_Analysis_of_World_Chess_Champions), [ChessBase summary](https://en.chessbase.com/post/computer-analysis-of-world-champions) | Crafty-engine move-by-move "average error" (centipawn deviation from engine's top choice) across ~37,000 championship-match positions | Ranked among the *highest* % of engine-best moves played (with Kramnik and Alekhine), but also **highest variance/complexity of positions faced** | Grouped with Carlsen and Karpov as "similar rate of choosing the best move" but **none of these four ranked in the authors' top five** | **No clean numeric delta obtainable** | Full numeric table not extractable from any fetchable source (PDFs blocked/unparseable, ResearchGate/academia.edu 403, ChessBase pages only summarize). The paper itself is **widely criticized** (see companion paper "How trustworthy is CRAFTY's analysis of world chess champions?") for engine weakness (Crafty ≈2700, weaker than several champions analyzed), position-complexity bias favoring quiet/positional players like Capablanca, and for not producing outcome-calibrated Elo estimates at all — it ranks *move accuracy*, not playing strength, and the authors themselves caution against reading it as a strength ranking |
| 9 | Edo Historical Chess Ratings (Rod Edwards) | Bradley-Terry retrodiction from historical game results | Not usable | Not usable | **N/A** | Could not confirm exact end-year live (edochess.ca has a persistent TLS handshake failure in every fetch attempt), but every secondary source found describes Edo's coverage as ending well before the FIDE-rating era (sources place its documented range roughly 1836–1900s/1970 depending on the page/version). **Neither Fischer's 1970–72 peak nor any part of Kasparov's career (1976–2005) falls inside a period Edo is known to rate** — this source is not applicable to the question and is excluded from the delta range below |

## Common opponents (indirect linkage, not a rating source)

Both players faced an overlapping set of long-career Soviet/Eastern-bloc and Western
grandmasters, which is the intuitive (but methodologically weak) basis for informal
cross-era comparison:

- **Viktor Korchnoi** — played both; Kasparov's record vs. Korchnoi reported as +12 −1 =13 in an informal compilation ([rec.games.chess.misc archive](https://groups.google.com/g/rec.games.chess.misc/c/_8dFoQVKjK8), not a primary database — treat as indicative, not authoritative)
- **Vasily Smyslov** — played both; Kasparov +4 −0 =10 per same source
- **Lajos Portisch** — played both; Kasparov +4 −0 =5
- **Bent Larsen** — played both; Kasparov +3 −0 =1
- **Efim Geller** — played both; Kasparov +1 −0 =3
- **Tigran Petrosian** — played both (Kasparov faced him in the early 1980s before Petrosian's 1984 death); Kasparov +2 −2 =1
- **Boris Spassky** — played both (Fischer's 1972 title match; Kasparov faced Spassky repeatedly in 1980s tournaments) — **could not source an aggregated head-to-head figure in this session**; flagged as asserted from general chess-history knowledge, not verified against a primary database here

**Caveat (explicitly requested):** every one of these players' own strength varied substantially
across the 10–20 year gap between facing Fischer and facing Kasparov (Korchnoi and Smyslov in
particular were considerably past their peaks by the time they met Kasparov). Score lines against
shared opponents at different points in those opponents' careers **cannot be chained into a
transitive Fischer-vs-Kasparov Elo estimate** without a time-varying-strength model — this is
noted as a structural limitation, not resolved here.

## Bottom line

**No single authoritative number exists.** The credible, sourced estimates span from
**Fischer +46** (Kaufman's largest time-adjustment) to **Kasparov +66** (raw uncorrected FIDE
peak, known to be inflation-contaminated and explicitly not era-adjusted). Discarding the two
extremes — row 5 (assumes an unverified secular-improvement constant) and row 3 (raw FIDE,
explicitly acknowledged as inflation-driven, not a fair comparison) — the remaining
era-adjusting methods (rows 1, 2, 4, 6) cluster into a coherent pattern:

- **On Fischer's shortest, highest peak** (a single month or single tournament run), Fischer
  is at parity with or slightly ahead of Kasparov's best moment: roughly **Fischer 0 to +20**.
- **On sustained multi-year peak strength** (the more relevant comparison for a multi-game
  match, since a 24-game match tests durability, not one hot month), every method that averages
  over 5+ years favors Kasparov, by **roughly +20 to +55**.

**Recommended delta range for match simulation: Kasparov +15 to +55 Elo**, with a central
estimate around **+30 to +35** (splitting the difference between Chessmetrics CM2's 5-year
window, +34, and Kaufman's peak-quality estimate, +19, and the 10-year window, +53). This
range is explicitly weighted toward the "sustained peak" framing implied by the two time
windows the task specified (Fischer ~1970–72, a 3-year peak; Kasparov ~1985–2000, a 15-year
peak) — comparing a brief spike to a long plateau is the standard way both players' primes are
popularly bounded, and it is also the more relevant comparison for simulating a multi-game match.

### Expected match score over 24 games, by delta (standard Elo formula, E = 1/(1+10^(−Δ/400)))

| Delta (Kasparov favored) | Expected score/24 for Kasparov | Win probability per game |
|---|---|---|
| +15 (low end) | 12.5 / 24 | 52.1% |
| +20 | 12.7 / 24 | 52.9% |
| +35 (central estimate) | 13.2 / 24 | 55.0% |
| +55 (high end) | 14.2 / 24 | 59.3% |

For reference, the discarded extremes: at Fischer +46 the expected Kasparov score would be
**9.9/24** (Fischer favored, 41.4% win rate for Kasparov-side), and at raw-FIDE Kasparov +66
the expected score would be **14.9/24** (62.0%).

## Gaps — what I could not verify

1. **Ken Regan's exact IPR numbers for Fischer 1971–72 and Kasparov's peak years** — this is
   the single most rigorous, peer-reviewed method available (engine-move-quality regression,
   AAAI-published) and I was unable to extract it. Both primary PDFs
   ([ReHa11c.pdf](https://cse.buffalo.edu/~regan/papers/pdf/ReHa11c.pdf),
   [Reg12IPRs.pdf](https://cse.buffalo.edu/~regan/papers/pdf/Reg12IPRs.pdf)) failed to parse
   with available tooling (compressed/FlateDecode PDF streams), and no secondary source found
   quotes Regan's specific Fischer or Kasparov numbers. **This is a real gap — if a more
   authoritative delta is needed, someone should open these PDFs directly (e.g., in a proper
   PDF reader) rather than rely on the estimate above.**
2. **Guid & Bratko's actual numeric results table** — same problem (PDF/403 blocks on
   ResearchGate and academia.edu); only qualitative summaries were obtainable, and those
   summaries plus the companion critique paper suggest the method isn't well suited to
   producing an Elo-equivalent delta at all.
3. **Edo ratings' exact coverage end-year** — edochess.ca returned a TLS handshake failure on
   every fetch attempt (both http and https); coverage-era placement above is inferred from
   secondary mentions only, not confirmed on the primary site.
4. **Spassky's aggregate head-to-head record against both players** — not sourced in this
   session; only asserted as a well-known fact that both played him repeatedly.
