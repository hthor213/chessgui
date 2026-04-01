# 201: Opening Tree Explorer

**Status:** draft
**Depends on:** 200 (game database — the tree is computed from database games)

## Goal
Show move frequency and win/draw/loss statistics from the game database for the current position. SCID's killer feature.

## Architecture (informed by ChessX)

ChessX computes the opening tree via `OpeningTree` + `OpeningTreeThread`:
1. For the current position, query all games in the database that reach this position (via position index)
2. For each matching game, look at what move was played next
3. Aggregate into `MoveData`: move, count, white wins, draws, black wins, avg Elo, performance
4. Display sorted by frequency

They also overlay **Lichess opening explorer API** data when local database is empty or as a supplement. Their `LichessOpening` class queries the Lichess explorer endpoint.

### Data Model

```typescript
interface OpeningMove {
  san: string;           // e.g., "Nf3"
  uci: string;           // e.g., "g1f3"
  count: number;         // total games
  whiteWins: number;
  draws: number;
  blackWins: number;
  avgElo?: number;       // average player Elo
  performance?: number;  // performance rating
}
```

### Computation

**Local database** (Rust side):
```sql
SELECT m.san, COUNT(*) as count,
  SUM(CASE WHEN g.result = '1-0' THEN 1 END) as white_wins,
  SUM(CASE WHEN g.result = '1/2-1/2' THEN 1 END) as draws,
  SUM(CASE WHEN g.result = '0-1' THEN 1 END) as black_wins
FROM positions p
JOIN games g ON p.game_id = g.id
JOIN moves m ON m.game_id = g.id AND m.ply = p.ply + 1
WHERE p.zobrist = ?
GROUP BY m.san
ORDER BY count DESC
```

**Lichess API fallback**: `GET https://explorer.lichess.ovh/lichess?fen={fen}&speeds=blitz,rapid,classical`

### UI

Horizontal stacked bar chart per move (white/draw/black as segments), like Lichess:

```
Nf3   4,521  ████████░░░░██  52% / 28% / 20%
e4    3,890  ███████░░░░░██  48% / 30% / 22%
d4    2,102  ██████░░░░░███  45% / 25% / 30%
```

Clicking a move plays it on the board and updates the tree for the new position.

### Threading

Tree computation should be async (Tauri command) so the UI doesn't freeze on large databases. ChessX uses a dedicated `OpeningTreeThread` — we get this for free with Tauri's async commands.

## Done When
- [ ] Panel shows all moves played from current position in the database
- [ ] Each move shows game count and result percentages (stacked bar)
- [ ] Moves sorted by frequency (configurable: by count, by performance)
- [ ] Clicking a move plays it on the board
- [ ] Updates as user navigates through moves
- [ ] Lichess API fallback when local database is empty
- [ ] Average Elo and performance rating shown per move
- [ ] Tree computation is async — no UI freeze on large databases
