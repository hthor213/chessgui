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

Four **start modes** (user-selectable):

1. **Start Normal** — standard starting position (games differentiated only by opening play within the game)
2. **Use Opening Book** — play fixed opening moves before handing off to engines
3. **Current Position** — "play this out": seed every pair from the FEN currently on the analyze board. Defaults: engine A (Stockfish) takes the side at the bottom of the user's board, 10m+5s, 2 games (colors flip each second game); all editable before launch. Entered either from the tab's mode selector or via the board view's "Play this out" button, which jumps to the tab pre-configured. The analyze-mode game is never mutated.
4. **Eval-Qualified Positions** — the key mode for the probability map:
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

> Note (2026-07-15 verification pass): the runner shipped as `src-tauri/src/match_runner.rs`, **not** `tournament.rs`, and streams over `tauri::ipc::Channel<T>` with a `GameSpec`/`GameOutcome`/`BatchProgress` model rather than the `emit_to` + `match_id` + `tournament_start/cancel/get_result` design this spec describes. Boxes below are ticked against the shipped code where the intent is delivered; divergences are noted inline.

- [x] New Rust module `tournament.rs` with `shakmaty` dependency added to `Cargo.toml` (verified in code 2026-07-15 — module is `src-tauri/src/match_runner.rs`, not `tournament.rs`; `shakmaty = "0.30"` at `src-tauri/Cargo.toml:23`, used at `match_runner.rs:18`)
- [x] Single game loop: two UCI engines play one game to a legal terminal position (verified in code 2026-07-15, `play_game_streamed` `match_runner.rs:500-781`)
- [x] Terminal detection: checkmate, stalemate, 50-move rule, threefold repetition, insufficient material (verified in code 2026-07-15, `match_runner.rs:738` checkmate, `:743` stalemate, `:746` insufficient material, `:756` 50-move, `:759-765` threefold via Zobrist rep-counts)
- [ ] Result returned as `(result: GameResult, pgn: String)` — DIVERGES (2026-07-15): Rust `GameResult` returns a UCI move list (`moves: Vec<String>`, `match_runner.rs:138-152`), not a PGN string; PGN is assembled client-side via `movesToPgn` (`lib/game-replay.ts`). Left unticked pending user call on whether the move-list form satisfies this.
- [x] Color flip: given a starting FEN, engines swap colors and play a second game (verified in code 2026-07-15 — pairing done in TS: `buildSpecs` emits two `GameSpec`s per seed with swapped white/black paths sharing one `start_fen`, `lib/tournament.ts:437-468`)
- [x] One game can be played end-to-end and result verified in a Rust unit test (closed 2026-07-15 — `real_engine_game_terminal_result_is_checkmate`, `match_runner.rs:1977`: a hand-built mate-in-1 FEN, White `Ra1-a8#`, so the terminal `result`/`termination`/`plies`/`moves` are asserted deterministically — `"1-0"`, `"checkmate"`, 1 ply, `["a1a8"]` — regardless of engine strength, since any competent engine always takes a proven mate. Ran locally against `/opt/homebrew/bin/stockfish`, passed; skips cleanly without it like its neighbors.)

### Phase 2 — Parallel Batch Runner
- [x] Tokio-based concurrent game runner: N games scheduled, M concurrent (configurable) (verified in code 2026-07-15, `run_batch_core_evaluated` uses a `tokio::sync::Semaphore` sized by `concurrency`, `match_runner.rs:1005-1207`, `:944-949`)
- [x] Progress events emitted per completed game via Tauri `emit_to` (verified in code 2026-07-15 — emitted once per completed game via `tauri::ipc::Channel<BatchProgress>` `match_runner.rs:1183-1188,1315`, not `emit_to`)
- [x] Cancellation: `tournament_cancel` drains the queue and terminates running game processes cleanly (verified in code 2026-07-15 — `cancel_batch` sets an `AtomicBool` `match_runner.rs:1385-1388`; new games gated `:1035-1037`, in-flight abort per move `:601-603`, engines `kill_on_drop(true)` `:168`)
- [x] Batch completes and aggregates raw results (game index, start eval, result) (verified in code 2026-07-15 — `summarize()` aggregates W/D/L `match_runner.rs:911-940`, per-game id+result on `GameOutcome`; start eval tracked client-side in `evalById` `lib/tournament.ts:418-423`)
- [x] Engine process lifecycle: no zombie processes after batch ends or is cancelled (verified in code 2026-07-15 — `kill_on_drop(true)` at spawn `match_runner.rs:168,1428`, explicit `quit()` with timeout+`start_kill()` `:334-339`)

### Phase 3 — Starting-Position Pipeline
- [x] UHO-format position file (EPD/FEN list) can be loaded from disk via file picker (code-verified 2026-07-16: native `pickFile` → `read_opening_positions` Tauri command (32 MB cap, `match_runner.rs`) → `parseOpeningPositions` in `packages/core/src/tournament.ts` (bare EPD normalized, `ce` opcode → White-POV cp, bad lines counted not fatal); parsed pool held as the session's custom positions in `tournament-tab.tsx`. Supersedes the 2026-07-15 NOT FOUND note.)
- [x] Eval-tagging step: Stockfish evaluates each candidate position (fixed depth, e.g. depth 12), stores `(fen, eval_cp)` in a session cache — (code-verified 2026-07-16, supersedes the 2026-07-15 PARTIAL note): in-app `tag_positions` Tauri command (match_runner.rs, fixed `go depth 12`, White-POV, per-position TagProgress channel) wired into tournament-tab.tsx with `applyEvalTags` merge; the offline `scripts/tag_positions.py` path remains as a bulk alternative.
- [x] Sampling step: given target range and target N, sample positions so buckets are evenly represented (not all positions clustered near 0) (verified in code 2026-07-15, `buildSeeds(mode:"eval")` buckets by 0.25-pawn magnitude and round-robins across non-empty bins, `lib/tournament.ts:356-411`)
- [x] Color-flip pairing: each sampled position generates two games (A plays white, then B plays white) (verified in code 2026-07-15, `buildSpecs` `lib/tournament.ts:437-468`)
- [x] Start-mode selector: Normal / Opening Book / Eval-Qualified exposed in config struct (verified in code 2026-07-15, `StartMode = "normal" | "book" | "eval" | "current"` `lib/tournament.ts:253`)
- [x] Current-position mode: seeds from the analyze-board FEN; `flipFirst` pairing lets engine A start on the Black side (the board-bottom side); 10m+5s "rapid" TC preset; 2-game default; "Play this out" entry point in the board view. Unit-tested (`__tests__/tournament.test.ts`) and config UI verified headless (2026-07-13). An actual engine run in this mode still needs a live-app check in Tauri.

### Phase 4 — Tournament Tab UI
- [x] "Tournament" tab added to the main navigation (verified in code 2026-07-15, `app/page.tsx:481` renders the tab, mounts `TournamentTab` `:17,528`)
- [x] Engine picker: dropdown for Engine A and Engine B (MVP: Reckless vs Stockfish hardcoded, picker wired for future) (code-verified 2026-07-15: landed via 218 roster — the free-text `<input>`s were replaced by the spec:218 Participant dropdown, `lib/tournament-roster.ts` `buildTournamentRoster`)
- [x] Start-mode selector: radio/segmented control for Normal / Book / Eval-Qualified (verified in code 2026-07-15, segmented control `tournament-tab.tsx:745-767`)
- [x] Eval range inputs (min/max pawns) shown when Eval-Qualified is selected, N-games input shown for every mode — AMENDED (2026-07-15, agent call per tick-pass instruction): eval min/max stay gated on `mode === "eval"` (`tournament-tab.tsx:1071-1101` — that range is meaningless outside eval mode), but N-games (`:1137-1151`) is deliberately UNGATED — Normal/Book/Current-position all need a game count too (Current-position's own default is a specific N, 2), so eval-only gating would break every other mode's config. The original box text ("shown when Eval-Qualified is selected") is corrected here to match; code is left as-is (judged the better UX).
- [x] Run button starts the match; button becomes Cancel during run (verified in code 2026-07-15, `tournament-tab.tsx:1123-1130`)
- [x] Progress bar and "X / N games complete" counter update live from `tournament-progress` events (verified in code 2026-07-15 — `Progress value={pct}` + `{tally.completed} / {tally.total}` `tournament-tab.tsx:1148-1151`, driven live by the `BatchProgress` channel `:522-568`)
- [x] Per-game results stream into a compact running log (game #, result, start eval) (closed 2026-07-15 — new `LiveResultLog` component, `tournament-tab.tsx`, fed by a `liveLog` state array pushed to inside the existing `BatchProgress` channel handler (`onmessage`), so rows land as each game completes DURING the run, not after `play_batch` resolves. Distinct from `ResultsExplorer`, which still only populates post-completion — that component needs the full board-hop/"Open in Analyze" data a single `BatchProgress.last` doesn't carry.)

### Phase 5 — Probability Map & Visualization
- [x] Bucketing logic (TypeScript or Rust): assign each completed game to its 0.25-pawn bin (verified in code 2026-07-15, `buildProbabilityMap(..., binWidth = 0.25)` `lib/tournament.ts:509-579`)
- [x] `EvalBucket` aggregation updates live as game-result events arrive (closed 2026-07-15 — the `BatchProgress` channel handler now accumulates every completed `GameOutcome` into an in-run array and recomputes `buildProbabilityMap`/`buildEngineCurves`/`buildEngineWDL` from it on each event, `tournament-tab.tsx` `run()`; cheap at these sizes (<=10000 games) per the tick-pass note. The chart render gates were also un-tied from the final `report` so the live numbers actually reach the screen mid-run; the authoritative post-batch recompute from `result.outcomes` is unchanged.)
- [x] Stacked-bar chart renders the probability map (W/D/L % per bucket) (verified in code 2026-07-15, `ProbabilityMap` renders a stacked green/gray/red bar per bin `tournament-tab.tsx:1476-1557`)
- [x] X-axis label shows bucket range; tooltip on hover shows raw game count + percentages (verified in code 2026-07-15 — bin-center label `tournament-tab.tsx:1547-1550`, `title=` tooltip with `n=`, W/D/B counts + `avgWhiteScore` `:1532`)
- [x] Conversion-delta line overlaid on chart (actual win % vs Elo-naive expectation) (closed 2026-07-15 — `lib/tournament.ts`'s `expectedWinPct`/`CLASSICAL_LOGISTIC_K` (the same 0.4/pawn logistic shape `lib/win-prob.ts`'s no-data fallback and `lib/annotations.ts`'s eval-graph squash already use) gives each `ProbBin` an `expectedWhiteScore`/`conversionDelta`; `ProbabilityMap` overlays an amber SVG polyline through each bin's expected score, plus the tooltip now reports `expected=`/`conversionDelta=`.)
- [x] Chart is readable at a glance: color-coded (green = win, grey = draw, red = loss for higher-eval side) (verified in code 2026-07-15, `bg-green-500`/`bg-gray-500`/`bg-red-500` `tournament-tab.tsx:1500-1540`)
- [x] Completed `TournamentResult` can be exported as JSON (closed 2026-07-15 — `lib/tournament.ts`'s `buildTournamentResultExport` shapes a completed run into spec 210's `TournamentResult`/`EvalBucket` fields; an "Export JSON" button in `tournament-tab.tsx` Blob-downloads it, same object-URL pattern `app/page.tsx`'s PGN export already uses (no native Tauri save dialog yet there either).)

### Phase 6 — Post-MVP participants & tournaments

Roster-based participants (engines OR personas as named picks with per-side
assignment), the exhibition ("watch Fischer vs Kasparov"), the persona runner arm,
and the picker UI are specced in **spec:218 Bot Roster & Exhibition Play**
(consolidated there 2026-07-15, user decision). The runner-side seam lands in this
codebase area; the spec text lives in 218.

- [x] Add-engine UI: user can register any UCI binary as a named engine (a spec:218
      Participant of kind `uci`) (code-verified 2026-07-16: inline add-engine form in
      `tournament-tab.tsx` (native binary picker + name field) persisted via
      `lib/tournament-roster.ts` (`chessgui-custom-engines` storage key, stable
      `custom-<slug>` ids, remove supported); entries fold into both side dropdowns)
- [x] Round-robin tournament: N engines, each pair plays M games, full cross-table;
      persona entries appear in standings with spec:216 honest-strength labels
      (closed 2026-07-15 — participants are the spec-218 dropdown roster, engines
      AND personas: `buildRoundRobinSpecs` (`lib/tournament.ts`) schedules every
      unordered pair × M color-alternating games as ONE flat `GameSpec[]` batch
      through the existing `play_batch` runner + concurrency cap (no round-robin
      Rust code); `buildCrossTable`/`buildStandings` aggregate W/D/L + points per
      directed pairing, live off the `BatchProgress` channel. `RoundRobinSection`
      in `tournament-tab.tsx` (participant checkboxes, games/pairing, book/normal
      openings, live cross-table + standings); persona rows keep their honest
      roster labels ("bot: kasparov (BT3, 64% move-match)") in standings and in
      the saved result. Unit-tested (`__tests__/tournament-round-robin.test.ts`:
      pairing counts/color-flip/odd-M/seed-cycling, cross-table math incl.
      flipped mapping and aborted/Err exclusion); config UI Playwright-verified
      headless (defaults, totals readout, run-button gating, honest labels). An
      actual multi-engine run still needs the Tauri app (play_batch is IPC).
- [x] Elo estimation from match results (BayesElo-style or simple logistic)
      (closed 2026-07-15 — `estimateElo` (`lib/tournament.ts`): Bradley–Terry
      logistic MLE over the cross-table (the exact Elo expected-score curve,
      γ = 10^(R/400)), draws as half-wins, fitted with the convergent MM
      iteration; BayesElo-style prior of 1 virtual draw per pairing keeps clean
      sweeps finite (opt-out `priorDraws: 0` for the raw MLE); anchored to a
      named participant = 0. ± is the Fisher-information standard error from
      REAL games only, reported as "± N (from N games)" in the standings — the
      honesty labeling the box asks for. Validated against known answers in
      `__tests__/tournament-round-robin.test.ts`: 75%/100 games = ±190.85
      (textbook 400·log10(3)), 50% = 0 under any prior, three players generated
      from the model recovered transitively (±5 Elo), SE ≈ 40 at n=100/p=0.75
      and halves at 4× games, anchor-invariance of pairwise gaps.)
- [x] Tournament result persistence: save/load past tournament results to disk
      (closed 2026-07-15 — `save_tournament_result`/`list_tournament_results`/
      `load_tournament_result` commands (`match_runner.rs`) persist the
      frontend-owned `RoundRobinResultExport` JSON (camelCase + ISO
      `completedAt`, following Phase 5's export shape, plus `version`/`kind`)
      under `<app_data_dir>/tournaments/`, calibration.rs's artifact pattern;
      load key is a bare file name (traversal rejected). Tab UI: "Save result"
      after a run + a "Saved tournaments" list with per-row Load that re-renders
      the cross-table/standings/Elo from disk. Rust round-trip unit test
      (`tournament_persistence_round_trip`: save→list→load byte-identical,
      same-ms collision bump, corrupt-file skip, traversal guard); TS shape
      round-trip incl. Infinity-SE→null JSON mapping. In-Tauri save/load click
      still pending a live-app check, same as the runner itself.)
- [ ] Deeper UHO integration: filter by ECO code, opening family, or custom FEN lists
- [ ] Concurrency settings exposed in UI (max parallel games, engine thread count per game)
- [x] Gauntlet scheduling alongside round-robin (000:88; 900:17) (code-verified 2026-07-16: buildGauntletSpecs + Format picker in tournament-tab)
- [x] Export all games as one PGN file (bulk export of an entire tournament run,
      distinct from the existing per-game "Open in Analyze" PGN handoff) (000:93) (code-verified 2026-07-16: gamesToPgn multi-game export)

### Phase 7 — Neutral Evaluator & Game Browser (2026-07-13)

A third "neutral evaluator" engine scores every position of every game while the
match runs, plus a live viewer, per-move eval graphs, and a completed-game
browser. Landed together this session.

- [x] **Neutral evaluator (third engine).** `play_batch` takes `eval_path` +
  `eval_movetime_ms` (default 100ms) and streams `EvalEvent`s over a new
  `on_eval` channel. Each game spawns its own evaluator process in a decoupled
  task that consumes the game's positions off an unbounded channel and scores
  them at a fixed `go movetime` — so the players never wait on it and their
  clocks are untouched. `movetime` (not fixed depth) is deliberate: it bounds
  per-position wall cost so the evaluator keeps pace with the live stream.
  Per-ply White-POV evals attach to each `GameOutcome.evals` (Serialize +
  Deserialize, so later persistence is trivial). Evaluator path is pre-flighted
  like the players; evaluator is optional (checkbox, default ON). Rust unit test
  runs a real short game at 20ms/pos and asserts one eval per ply (+ ply 0) both
  collected and streamed.
- [x] **Auto-switch to live view on run start.** Starting a run flips the main
  view to the board so the featured game is on screen (`page.tsx` watches
  `tournamentRunning`).
- [x] **Live eval bar.** "Show evaluation bar" option; auto-checks for base time
  ≥ 60s (re-derived on TC change until the user touches it), pure helper
  `evalBarDefaultForBaseMs` unit-tested against the TC presets. When on, the
  existing `EvalBar` renders left of the live board, driven by the evaluator's
  latest White-POV score for the featured game.
- [x] **Average eval graph.** Mean eval by ply across completed games, normalized
  to engine A's perspective (games where A played Black are sign-flipped so
  color-flipped pairs don't cancel) — normalization stated in the UI label and
  unit-tested (`averageEvalByPly`).
- [x] **Per-game eval graph.** White-POV eval-by-ply for the selected game, same
  inline-SVG style as the spec-202 eval graph (`gameEvalSeries`, no chart deps).
- [x] **Game browser + board hop.** Completed-games list → select shows the game
  on a viewer board; arrow keys / step buttons / clicking the eval graph hop to
  any position (`replayFens`). "Open in Analyze" builds a PGN (`movesToPgn`) and
  loads it onto the main board.

**Verification (2026-07-13):** `cargo test` (22 pass incl. the real-engine
evaluator test), `pnpm test` (141 pass incl. eval normalization/averaging,
per-game series, eval-bar default), `pnpm tsc --noEmit` clean, `pnpm build`
succeeds. The live evaluator run, live eval bar, and graph/board rendering need
the Tauri app to exercise end-to-end (the batch runs over Tauri IPC; a plain
browser can't invoke `play_batch`, and the Chrome extension for headless UI
driving was not connected on this machine) — that check is still pending.
Results remain in-memory (persistence is a separate backlog item).

### Phase 8 — Live-viewer controls: stop / pause / auto-start / nav / throttle (2026-07-14)

A coherent control bar in the live viewer — `[Stop] [Pause/Resume] [auto-start ✓]
[Start next game] [◀ ▶ ply nav] [delay]` — plus the matching runner mechanics.
The shared, live-tunable `BatchControls` (managed Tauri state, replacing the
old cancel-only flag) is reset per run and steered by the `cancel_batch` /
`pause_batch` / `set_auto_start` / `start_next_game` / `set_move_delay` commands.

- [x] **Stop (graceful abort).** Reachable from both the tournament tab and the
  live viewer. In-flight games abort at their next move boundary and are flagged
  `aborted` on the `GameOutcome` — **excluded from every stat** (summary, Elo,
  prob-map, curves, eval-average, error list), never counted as errors. Games
  finished before the stop keep their results. Rust + TS unit-tested.
- [x] **Pause / Resume mid-game.** The runner's move loop parks between moves
  while paused; both clocks freeze (no search runs, and clocks are only ever
  debited by measured search time — verified there's no time leak), engines sit
  idle, Resume continues from exactly where it stood. Takes effect after the
  in-flight move completes (a running search isn't interrupted — documented).
  Real-engine test asserts a paused game doesn't complete until resumed.
- [x] **Auto-start next game (default ON).** Off makes the runner wait on an
  `advance` gate between games and forces concurrency to 1 (so "between games" is
  a single well-defined gap — with >1 in flight the semantics are ambiguous, so
  sequential-only; documented). The viewer's "Start next game" button lights up
  when the runner is waiting; clicking it (or re-enabling auto-start) advances.
- [x] **Back/forward ply nav.** The featured game's full per-ply frame history
  (fen + clocks + the evaluator's eval at each ply) streams to the viewer;
  ◀ ▶ / arrow keys step through it with the board AND eval bar tracking the
  viewed ply. Stepping off the tip stops following; resuming, "go live", or the
  next game snaps back to the live tip.
- [x] **Min move-display delay.** off / 0.5s / 1s / 2s, persisted with the
  tournament config, applied as a between-moves throttle in the runner (doesn't
  touch the clocks). Default 0 keeps headless batches fast; the user opts in.
  Real-engine test asserts a throttled game's wall time is floored by the delay.

**Verification (2026-07-14):** `cargo test` (26 pass incl. real-engine
stop-marks-aborted, pause-holds-until-resumed, and throttle tests), `pnpm test`
(141 pass incl. aborted-exclusion in stats and eval-average), `pnpm tsc
--noEmit` clean, `cargo build` (bin, new commands registered) + `pnpm build`
succeed. As before, the end-to-end live behavior (a real paused/throttled run,
the viewer control bar, ply-nav) needs the Tauri app — the Chrome extension for
headless UI driving was not connected on this machine, so that check is pending.

### Later / uncaptured requirements (audit 2026-07-16)

- [ ] Live-in-Tauri verification pass (still open as of 2026-07-16; +M-pool audit
      found no eyeball annotations at all beyond the "needs a live-app check" notes
      already inline): current-position run (210:137), multi-engine round-robin
      save/load clicks (210:211), Phase-7 live evaluator + graphs (210:252-259),
      Phase-8 stop/pause/throttle/ply-nav control bar (210:295-301)
- [ ] Bounded `curate_positions.py` re-run (explorer-validated, denser per-bin to
      ±1.5; the full run over-scoped and was killed; explorer cache already warmed
      at `data/openings/explorer_cache.json`) (BACKLOG.md)
- [ ] Narrow-range presets (e.g. ±0.6) where engine skill, not the advantage size,
      decides — more discriminating power per game (BACKLOG.md)
- [ ] Locate the persisted 3000-game Stockfish-18-vs-Reckless run (2026-06-15) and
      compute: real per-band W/D/L; a sign test on the |eval| ≥ 1.6 tail (replacing
      the eyeballed "Reckless won ~16 from ≥0.38 down vs SF's ~4" observation); a
      difficulty-weighted score crediting each win/save by
      `1 − expected_score(starting_eval)` (memory `project_tournament.md` PENDING ANALYSIS)
- [ ] Gradual-drift starting-position generator, a tablebase-OFF comparison run, and
      a depth-to-discovery / instructiveness metric (memory `project_tournament.md`
      Backlog)
