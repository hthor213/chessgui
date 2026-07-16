# 900: Backlog

Ideas and features not yet committed to a spec. Prioritize based on user need.

## High Priority (likely next after V2)
- **Play vs Engine (advanced)** — Configurable strength (Elo limit), time controls, post-game analysis review — superseded: time-based strength/pacing shipped in spec:216 (hooks/use-engine.ts EngineMode 'play', lib/time-elo.ts); real clocks tracked as Tier 1 in spec:217; post-game review tracked in spec:212 [2026-07-15]
- ~~**Full-game analysis** — Automated blunder check across all moves, classify inaccuracies/mistakes/blunders~~ → now tracked in spec:212 (draft, v0 — scoped to *tournament-game* analysis over neutral-evaluator per-ply evals; general single-game blunder-check not yet verified shipped) [2026-07-15]
- **Multi-engine comparison** — Run two engines side-by-side, compare evaluations

## Medium Priority
- **Opening repertoire builder** — User builds repertoire lines, spaced repetition drilling
- **Lichess/Chess.com API import** — Import games by username from online platforms
- **Board/piece theme picker** — Multiple board colors and piece sets
- ~~**FEN input / position editor** — Set up arbitrary positions for analysis~~ → SHIPPED, spec:014 (position editor + FEN import; all 15 boxes verified in code 2026-07-15)

## Low Priority / Future
- ~~**Engine tournament** — Round-robin or gauntlet format, live standings, PGN export~~ → now specced in spec:210 (core engine-vs-engine runner + probability map shipped, Phases 1–8; round-robin/gauntlet + Elo estimation is spec:210 Phase 6, post-MVP, not yet done) [2026-07-15]
- **Endgame tablebase integration** — Query Syzygy tablebases for perfect endgame play (partial: match_runner.rs already probes the Lichess tablebase API with a FEN-keyed cache for tournament adjudication; not yet surfaced in analysis panel or play paths) [2026-07-15]
- **Cloud sync** — Sync games and repertoires across devices
- **Move sounds** — Audio feedback on moves (piece placement, capture, check)
