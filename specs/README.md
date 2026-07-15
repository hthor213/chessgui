# Specs

Feature specs live here. They define **what** we're building and **when it's done** — before implementation starts.

## Band Numbering

`{NNN}-{slug}.md` — band-based numbering, kebab-case slug.

| Band      | Purpose                                      |
|-----------|----------------------------------------------|
| 000       | Vision — singleton north-star document        |
| 001-009   | Foundation — building blocks everything needs |
| 010-099   | (reserved)                                   |
| 100-199   | (reserved)                                   |
| 200-299   | V2 — database, opening tree, annotations     |
| 900-999   | Backlog — uncommitted ideas                  |

## Active Specs

| # | Name | Status |
|---|------|--------|
| 000 | [Vision](000-vision.md) | Active |
| 001 | [Board & Gameplay](001-board-gameplay.md) | Mostly done |
| 002 | [UX/UI Migration](002-ux-ui-migration.md) | Draft |
| 011 | [Engine Analysis](011-engine-analysis.md) | Partially done |
| 013 | [PGN Import/Export](013-pgn-import-export.md) | Partially done |
| 016 | [Game Tree](016-game-tree.md) | Draft |
| 200 | [Database & Opening Explorer](200-game-database-opening-explorer.md) | Draft |
| 202 | [Annotations & Eval Graph](202-annotations-eval-graph.md) | Draft |
| 210 | [Engine Tournament & Win-Probability Lab](210-engine-tournament.md) | Draft |
| 211 | [Avoidance Puzzles — "Don't Step On the Rake"](211-avoidance-puzzles.md) | Draft |
| 212 | [Tournament Game Analysis](212-tournament-game-analysis.md) | Draft |
| 213 | [Elo-Conditioned Position Evaluator](213-elo-conditioned-evaluator.md) | Draft |
| 214 | [Persona Simulator](214-persona-simulator.md) | Draft |
| 215 | [Training Program — the curriculum engine](215-training-program.md) | Draft |
| 216 | [Machine Speed Profile & Time-Compression Elo Model](216-machine-speed-elo-model.md) | Draft |
| 217 | [Persona Arena](217-persona-arena.md) | Draft |
| 218 | [Bot Roster & Exhibition Play](218-bot-roster.md) | Draft |
| 900 | [Backlog](900-backlog.md) | Ideas |

(Index gap fixed 2026-07-15: 214–217 existed on disk but were unlisted. Next free
number in the 21x band: 219.)

## Dependency Graph

```
000 Vision
 ├── 001 Board & Gameplay ← mostly done
 ├── 002 UX/UI Migration ← do before 016
 │    └── 016 Game Tree ← blocks all V2
 │         ├── 200 Database & Opening Explorer
 │         └── 202 Annotations & Eval Graph
 ├── 011 Engine Analysis ← parallel to 002
 │    └── 210 Engine Tournament & Win-Probability Lab
 │         ├── 212 Tournament Game Analysis
 │         ├── 216 Machine Speed / Time-Compression Elo Model → feeds 214 + 210 labels
 │         └── 214 Persona Simulator (also needs 213)
 │              ├── 215 Training Program (also needs 211, 212, 213)
 │              ├── 218 Bot Roster & Exhibition Play (also needs 210, 216)
 │              └── 217 Persona Arena (web surface; roster via 218, personas per 214)
 └── 013 PGN Import/Export ← export needs 016

211 Avoidance Puzzles ─→ 215
213 Elo-Conditioned Evaluator ─→ 214, 215
```

## Status Flow

`draft` → `active` → `done`
