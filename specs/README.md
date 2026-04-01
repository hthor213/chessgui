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
| 900 | [Backlog](900-backlog.md) | Ideas |

## Dependency Graph

```
000 Vision
 ├── 001 Board & Gameplay ← mostly done
 ├── 002 UX/UI Migration ← do before 016
 │    └── 016 Game Tree ← blocks all V2
 │         ├── 200 Database & Opening Explorer
 │         └── 202 Annotations & Eval Graph
 ├── 011 Engine Analysis ← parallel to 002
 └── 013 PGN Import/Export ← export needs 016
```

## Status Flow

`draft` → `active` → `done`
