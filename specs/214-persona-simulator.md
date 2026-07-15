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
- **Tier 2 — persona = book + policy + priors**: persona config format (name, book
  source, policy backend, strength, priors); persona-vs-persona via match runner;
  "play vs persona" UI entry.
- **Tier 3 — style priors that matter**: simplification appetite (trade-seeking bias),
  opening-phase fidelity vs middlegame drift, endgame automatics. Only priors that
  measurably improve move-match survive (no vibes-based parameters).

## Hard rules

- Never noise-weaken engines to fake humanity (Turing-test evidence, docs/research) —
  human-likeness comes from Maia-class policies and books, not random blunders.
- Personas of private individuals stay LOCAL (data/rivals is gitignored); only
  historical public figures (Fischer, Kasparov) may ship as bundled examples.
- Every persona carries its eval-harness scores in the UI — no unmeasured realism claims.

## Data

- Fischer, Kasparov: app DB (Lumbra OTB). Extraction query by player name, dedup.
- Dad (Thorarinn Hjaltason, Icelandic amateur OTB): not in local DB (checked 2026-07-14,
  all spellings). Chase skak.is / chess-results.com for recorded games; expect rating
  history + results, few or no move records. chess.com: 45 standard + 339 Chess960 games
  (data/rivals).

## Checklist

- [ ] Tier 0: rival book sampler (weighted from data/rivals PGNs) + maia_play command
      (lc0, go nodes 1, level param) + "Spar vs rival" UI entry from Learn or Play
- [ ] Fischer/Kasparov extraction from app DB → data/personas/ (gitignored is fine;
      public-figure games may be committed if useful)
- [ ] Held-out eval harness: move-match@1/@3, per phase, per policy backend
- [ ] Persona config format + loader
- [ ] Persona vs persona through match runner (Fischer–Kasparov exhibition)
- [ ] Dad OTB data chase (skak.is, chess-results) — results/rating even if no moves
- [ ] Style priors, gated on measured move-match improvement
