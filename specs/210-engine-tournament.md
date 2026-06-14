# 210: Engine Tournament & Win-Probability Lab

**Status:** draft
**Depends on:** 011 (engine communication — UCI process management), 001 (board & gameplay)

## Goal

A "Tournament" tab where the user runs engine-vs-engine matches headless and in parallel to study how a starting advantage converts to results. The headline experiment: run ~500 games between two engines from starting positions spread across an eval range (e.g. −2 to +2 pawns, with deliberate variance), with colors flipped for fairness, and produce a **probability map** — for each starting-eval bucket, what percentage of the time did the higher-eval side win, draw, or lose? I.e. "given this side was +X at the start, how often did they convert it?"

This is a research/analysis tool, not a matchmaking or rating system. The output answers the question a chess player actually asks: *how reliable is this kind of edge?*

## Architecture Overview

### Two Subsystems — Tournament Runner vs Interactive Engine

The existing `uci.rs` is built for interactive analysis and play: it runs one engine, streams every move to the UI, and is controlled by the user in real time. The tournament runner is a **separate headless subsystem** with different requirements:

- Spawns **pairs** of engine processes concurrently (one per game, or pooled)
- Runs games to completion internally using `shakmaty` for move legality and termination (no UI involvement per move)
- Streams only coarse-grained progress events (game completed, batch progress %) to the frontend
- Lives in a new Rust module, e.g. `src-tauri/src/tournament.rs`

No external match-runner binary (not cutechess, not fastchess). All game logic runs in-process via `shakmaty`.

### Engine Configuration

**MVP engines:**
- **Reckless v0.9.0** — `engines/reckless` (already downloaded)
- **Stockfish** — `/opt/homebrew/bin/stockfish`

Architecture must allow adding more engines and running round-robin brackets (post-MVP). Each engine is represented as a named path + optional UCI option overrides.

### Starting Positions — UHO-Style with Eval Tagging

Three **start modes** (user-selectable):

1. **Start Normal** — standard starting position (games differentiated only by opening play within the game)
2. **Use Opening Book** — play fixed opening moves before handing off to engines
3. **Eval-Qualified Positions** — the key mode for the probability map:
   - Load a UHO-style (Unbalanced Human Openings) position set from a file
   - Re-evaluate each position with Stockfish to get its current eval (not just the file's label)
   - Sample across the −2..+2 range with controlled **variance** — not all games near the same eval; intentionally spread across buckets
   - Each position is played **twice** (colors flipped) for fairness

The UHO eval-tagging pipeline runs as a pre-game setup step (Stockfish evaluates each candidate position at shallow depth, results cached).

## Probability Map

### Bucketing

Bin the starting eval into ~0.25-pawn-wide buckets across the chosen range. Example buckets for −2..+2:

```
[−2.0, −1.75), [−1.75, −1.50), ..., [−0.25, 0), [0, +0.25), ..., [+1.75, +2.0]
```

### Per-Bucket Metrics

For each bucket, after all games finish, report:

| Field | Description |
|-------|-------------|
| `bucket` | Eval range, e.g. `+1.25..+1.50` |
| `games` | Total games played from this bucket |
| `win_pct` | Win % for the higher-eval side |
| `draw_pct` | Draw % |
| `loss_pct` | Loss % (higher-eval side lost) |
| `conversion_delta` | `win_pct − expected_win_pct` — how much better/worse than a naive Elo-equivalent prediction |

### Visualization

The probability map is rendered as a chart in the Tournament tab: X-axis = starting eval bucket, Y-axis = result percentage (stacked bar per bucket: win/draw/loss). A reference line can overlay the "expected" conversion from classical Elo math for comparison.

### Data Model (TypeScript)

```typescript
interface EvalBucket {
  rangeMin: number;       // e.g. 1.25
  rangeMax: number;       // e.g. 1.50
  games: number;
  winPct: number;         // higher-eval side
  drawPct: number;
  lossPct: number;
  conversionDelta: number;
}

interface TournamentResult {
  engineA: string;
  engineB: string;
  totalGames: number;
  startMode: "normal" | "book" | "eval-qualified";
  evalRange: [number, number];
  buckets: EvalBucket[];
  completedAt: string;    // ISO timestamp
}
```

## Tauri Commands & Events

### Commands (Rust → frontend callable)
- `tournament_start(config)` — validates config, spawns batch runner, returns match ID
- `tournament_cancel(match_id)` — sends cancellation signal to running batch
- `tournament_get_result(match_id)` — returns `TournamentResult` when done

### Events (Rust → frontend, streamed during run)
- `tournament-progress` — `{ match_id, games_done, games_total, current_pgn? }`
- `tournament-game-result` — `{ match_id, game_index, result, start_eval, pgn }` — fired per completed game so the chart updates live
- `tournament-complete` — `{ match_id }` — fires when all games finish or are cancelled

## Done When

### Phase 1 — Engine-vs-Engine Core
- [ ] New Rust module `tournament.rs` with `shakmaty` dependency added to `Cargo.toml`
- [ ] Single game loop: two UCI engines play one game to a legal terminal position
- [ ] Terminal detection: checkmate, stalemate, 50-move rule, threefold repetition, insufficient material
- [ ] Result returned as `(result: GameResult, pgn: String)`
- [ ] Color flip: given a starting FEN, engines swap colors and play a second game
- [ ] One game can be played end-to-end and result verified in a Rust unit test

### Phase 2 — Parallel Batch Runner
- [ ] Tokio-based concurrent game runner: N games scheduled, M concurrent (configurable)
- [ ] Progress events emitted per completed game via Tauri `emit_to`
- [ ] Cancellation: `tournament_cancel` drains the queue and terminates running game processes cleanly
- [ ] Batch completes and aggregates raw results (game index, start eval, result)
- [ ] Engine process lifecycle: no zombie processes after batch ends or is cancelled

### Phase 3 — Starting-Position Pipeline
- [ ] UHO-format position file (EPD/FEN list) can be loaded from disk via file picker
- [ ] Eval-tagging step: Stockfish evaluates each candidate position (fixed depth, e.g. depth 12), stores `(fen, eval_cp)` in a session cache
- [ ] Sampling step: given target range and target N, sample positions so buckets are evenly represented (not all positions clustered near 0)
- [ ] Color-flip pairing: each sampled position generates two games (A plays white, then B plays white)
- [ ] Start-mode selector: Normal / Opening Book / Eval-Qualified exposed in config struct

### Phase 4 — Tournament Tab UI
- [ ] "Tournament" tab added to the main navigation
- [ ] Engine picker: dropdown for Engine A and Engine B (MVP: Reckless vs Stockfish hardcoded, picker wired for future)
- [ ] Start-mode selector: radio/segmented control for Normal / Book / Eval-Qualified
- [ ] Eval range inputs (min/max pawns) and N-games input (default 500) shown when Eval-Qualified is selected
- [ ] Run button starts the match; button becomes Cancel during run
- [ ] Progress bar and "X / N games complete" counter update live from `tournament-progress` events
- [ ] Per-game results stream into a compact running log (game #, result, start eval)

### Phase 5 — Probability Map & Visualization
- [ ] Bucketing logic (TypeScript or Rust): assign each completed game to its 0.25-pawn bin
- [ ] `EvalBucket` aggregation updates live as `tournament-game-result` events arrive
- [ ] Stacked-bar chart renders the probability map (W/D/L % per bucket)
- [ ] X-axis label shows bucket range; tooltip on hover shows raw game count + percentages
- [ ] Conversion-delta line overlaid on chart (actual win % vs Elo-naive expectation)
- [ ] Chart is readable at a glance: color-coded (green = win, grey = draw, red = loss for higher-eval side)
- [ ] Completed `TournamentResult` can be exported as JSON

### Phase 6 — Post-MVP (tracked here, not yet scoped)
- [ ] Add-engine UI: user can register any UCI binary as a named engine
- [ ] Round-robin tournament: N engines, each pair plays M games, full cross-table
- [ ] Elo estimation from match results (BayesElo-style or simple logistic)
- [ ] Tournament result persistence: save/load past tournament results to disk
- [ ] Deeper UHO integration: filter by ECO code, opening family, or custom FEN lists
- [ ] Concurrency settings exposed in UI (max parallel games, engine thread count per game)
