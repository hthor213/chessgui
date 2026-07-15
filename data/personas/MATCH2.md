# Persona Exhibition v2 — Fischer vs Kasparov

_Spec 214 match #2 · 2026-07-15 · seed 214215 · 24 games, alternating colors._

Each persona = opening book weighted from their own TRAIN games + BT3-768x15x24h **verification search** (visit head, Fischer 400 nodes / Kasparov 560 nodes, T=0.3, top-4). Draw model: eval-draw from move 30 + stochastic agreed draw in quiet equal positions. Stockfish @ 300000 nodes adjudicated (fixed nodes = reproducible); it never chose a move.

## Match score: Fischer 10 – 14 Kasparov

- Draws: 14/24 (58%) · White score 10/24 (42%)

| # | White | Black | Result | Plies | Termination |
|--:|---|---|:--:|--:|---|
| 1 | Fischer | Kasparov | **0-1** | 99 | White resigns |
| 2 | Kasparov | Fischer | **1/2-1/2** | 64 | Drawn (sustained equality) |
| 3 | Fischer | Kasparov | **0-1** | 70 | White resigns |
| 4 | Kasparov | Fischer | **1/2-1/2** | 95 | Draw agreed |
| 5 | Fischer | Kasparov | **1/2-1/2** | 57 | Draw agreed |
| 6 | Kasparov | Fischer | **1/2-1/2** | 113 | Draw agreed |
| 7 | Fischer | Kasparov | **1-0** | 49 | Black resigns |
| 8 | Kasparov | Fischer | **1-0** | 97 | Black resigns |
| 9 | Fischer | Kasparov | **0-1** | 96 | White resigns |
| 10 | Kasparov | Fischer | **1/2-1/2** | 79 | Drawn (sustained equality) |
| 11 | Fischer | Kasparov | **1/2-1/2** | 69 | Drawn (sustained equality) |
| 12 | Kasparov | Fischer | **1/2-1/2** | 68 | Drawn (sustained equality) |
| 13 | Fischer | Kasparov | **0-1** | 100 | White resigns |
| 14 | Kasparov | Fischer | **1/2-1/2** | 107 | Drawn (sustained equality) |
| 15 | Fischer | Kasparov | **1/2-1/2** | 36 | Draw by rule |
| 16 | Kasparov | Fischer | **1-0** | 91 | Black resigns |
| 17 | Fischer | Kasparov | **1/2-1/2** | 70 | Drawn (sustained equality) |
| 18 | Kasparov | Fischer | **0-1** | 82 | White resigns |
| 19 | Fischer | Kasparov | **0-1** | 66 | White resigns |
| 20 | Kasparov | Fischer | **0-1** | 74 | White resigns |
| 21 | Fischer | Kasparov | **1/2-1/2** | 64 | Drawn (sustained equality) |
| 22 | Kasparov | Fischer | **1/2-1/2** | 74 | Drawn (sustained equality) |
| 23 | Fischer | Kasparov | **1/2-1/2** | 58 | Draw agreed |
| 24 | Kasparov | Fischer | **1/2-1/2** | 69 | Draw agreed |

## Game 1: Fischer (W) vs Kasparov (B) — 0-1

- Opening (booked prefix): 1.e4 1...c5 2.Nf3 2...d6 3.d4 3...cxd4 4.Nxd4 4...Nf6 5.Nc3 5...a6 6.Bc4 6...e6 7.Bb3 7...Nbd7
- Left book: Fischer (White) after move 8; Kasparov (Black) after move 8.
- Biggest eval swing: **32.Kc1** (-0.19 → -1.21, White POV).
- Termination: White resigns.

## Game 2: Kasparov (W) vs Fischer (B) — 1/2-1/2

- Opening (booked prefix): 1.e4 1...c5 2.Nf3 2...d6 3.d4 3...cxd4 4.Nxd4 4...Nf6 5.Nc3 5...a6 6.f4
- Left book: Kasparov (White) after move 7; Fischer (Black) after move 6.
- Biggest eval swing: **14...Ng6** (+0.14 → -0.37, White POV).
- Termination: Drawn (sustained equality).

## Game 3: Fischer (W) vs Kasparov (B) — 0-1

- Opening (booked prefix): 1.e4 1...c5 2.Nf3 2...d6 3.d4 3...cxd4 4.Nxd4 4...Nf6 5.Nc3 5...a6 6.Bg5 6...Nc6
- Left book: Fischer (White) after move 7; Kasparov (Black) after move 7.
- Biggest eval swing: **34.Qh4** (-1.11 → -5.51, White POV).
- Termination: White resigns.

## Game 4: Kasparov (W) vs Fischer (B) — 1/2-1/2

- Opening (booked prefix): 1.e4 1...c5 2.Nf3 2...d6 3.d4 3...cxd4 4.Nxd4 4...Nf6 5.Nc3 5...a6 6.Bc4 7.Bb3
- Left book: Kasparov (White) after move 8; Fischer (Black) after move 6.
- Biggest eval swing: **13.gxh5** (-0.26 → -0.91, White POV).
- Termination: Draw agreed.

## Game 5: Fischer (W) vs Kasparov (B) — 1/2-1/2

- Opening (booked prefix): 1.e4 1...c5 2.Nf3 2...Nc6 3.d4 3...cxd4 4.Nxd4 4...e6 5.Nb5 5...d6 6.Bf4 7.Be3 8.Bg5 9.N1c3 10.Bxf6 11.Na3
- Left book: Fischer (White) after move 12; Kasparov (Black) after move 6.
- Biggest eval swing: **14...Rd8** (-0.41 → +0.00, White POV).
- Termination: Draw agreed.

## Game 6: Kasparov (W) vs Fischer (B) — 1/2-1/2

- Opening (booked prefix): 1.d4 1...d5 2.c4 2...dxc4 3.e3 6.O-O 7.Bb3 8.a4
- Left book: Kasparov (White) after move 4; Fischer (Black) after move 3.
- Biggest eval swing: **18...Bb7** (+0.15 → +0.72, White POV).
- Termination: Draw agreed.

## Game 7: Fischer (W) vs Kasparov (B) — 1-0

- Opening (booked prefix): 1.e4 1...c5 2.Nf3 2...e6 3.d3 3...Nc6 4.g3 4...d5 5.Nbd2 5...g6 6...Bg7
- Left book: Fischer (White) after move 6; Kasparov (Black) after move 7.
- Biggest eval swing: **23...Nxb2** (+2.17 → +4.47, White POV).
- Termination: Black resigns.

## Game 8: Kasparov (W) vs Fischer (B) — 1-0

- Opening (booked prefix): 1.d4 1...Nf6 2.c4 2...e6 3.Nf3 3...b6 4.a3 5.Nc3 6.cxd5 7.Qc2 8.bxc3 10.Bd3 11.Qd2
- Left book: Kasparov (White) after move 9; Fischer (Black) after move 4.
- Biggest eval swing: **47...Kd8** (+0.16 → +3.72, White POV).
- Termination: Black resigns.

## Game 9: Fischer (W) vs Kasparov (B) — 0-1

- Opening (booked prefix): 1.e4 1...c5 2.Nf3 2...d6 3.d4 3...cxd4 4.Nxd4 4...Nf6 5.Nc3 5...a6 6.h3
- Left book: Fischer (White) after move 7; Kasparov (Black) after move 6.
- Biggest eval swing: **21.Nxb7** (+1.45 → +0.02, White POV).
- Termination: White resigns.

## Game 10: Kasparov (W) vs Fischer (B) — 1/2-1/2

- Opening (booked prefix): 1.e4 1...c5 2.Nf3 2...d6 3.d4 3...cxd4 4.Nxd4 4...Nf6 5.Nc3 5...a6 6.Be3 6...e5 7.Nb3
- Left book: Kasparov (White) after move 8; Fischer (Black) after move 7.
- Biggest eval swing: **17...dxc5** (+0.05 → +0.57, White POV).
- Termination: Drawn (sustained equality).

## Game 11: Fischer (W) vs Kasparov (B) — 1/2-1/2

- Opening (booked prefix): 1.e4 1...c5 2.Nf3 2...d6 3.d4 3...cxd4 4.Nxd4 4...Nf6 5.Nc3 5...a6 6.h3
- Left book: Fischer (White) after move 7; Kasparov (Black) after move 6.
- Biggest eval swing: **12.f3** (+0.28 → -1.03, White POV).
- Termination: Drawn (sustained equality).

## Game 12: Kasparov (W) vs Fischer (B) — 1/2-1/2

- Opening (booked prefix): 1.e4 1...c5 2.Nc3 2...d6 3.Nge2
- Left book: Kasparov (White) after move 4; Fischer (Black) after move 3.
- Biggest eval swing: **23.Bxd4** (+0.36 → -0.16, White POV).
- Termination: Drawn (sustained equality).

## Game 13: Fischer (W) vs Kasparov (B) — 0-1

- Opening (booked prefix): 1.e4 1...c5 2.Nf3 2...d6 3.d4 3...cxd4 4.Nxd4 4...Nf6 5.Nc3 5...a6 6.Bc4 6...e6 7.Bb3 7...Nbd7
- Left book: Fischer (White) after move 8; Kasparov (Black) after move 8.
- Biggest eval swing: **26.Nd5** (-0.33 → -1.32, White POV).
- Termination: White resigns.

## Game 14: Kasparov (W) vs Fischer (B) — 1/2-1/2

- Opening (booked prefix): 1.d4 1...d5 2.c4 2...dxc4 3.e3
- Left book: Kasparov (White) after move 4; Fischer (Black) after move 3.
- Biggest eval swing: **15.Ba2** (-0.42 → -1.12, White POV).
- Termination: Drawn (sustained equality).

## Game 15: Fischer (W) vs Kasparov (B) — 1/2-1/2

- Opening (booked prefix): 1.e4 1...c5 2.Nf3 2...d6 3.d4 3...cxd4 4.Nxd4 4...Nf6 5.Nc3 5...a6 6.Bc4 6...e6 7.Bb3 7...b5 8.f4
- Left book: Fischer (White) after move 9; Kasparov (Black) after move 8.
- Biggest eval swing: **12...Bxg2** (-0.50 → +0.00, White POV).
- Termination: Draw by rule.

## Game 16: Kasparov (W) vs Fischer (B) — 1-0

- Opening (booked prefix): 1.d4 1...Nf6 2.c4 2...e6 3.Nc3 3...Bb4 4.Qc2 4...d5 5.cxd5 5...exd5 6.Bg5 6...h6 7.Bh4 7...c5 8.dxc5 8...Nc6 9.e3 9...g5 10.Bg3 10...Qa5 11...Ne4 12...Nxc3
- Left book: Kasparov (White) after move 11; Fischer (Black) after stayed in book.
- Biggest eval swing: **26...Rd8+** (+1.15 → +2.15, White POV).
- Termination: Black resigns.

## Game 17: Fischer (W) vs Kasparov (B) — 1/2-1/2

- Opening (booked prefix): 1.e4 1...c5 2.Nf3 2...d6 3.d4 3...cxd4 4.Nxd4 4...Nf6 5.Nc3 5...a6 6.h3
- Left book: Fischer (White) after move 7; Kasparov (Black) after move 6.
- Biggest eval swing: **20...Rg8** (-0.48 → +0.67, White POV).
- Termination: Drawn (sustained equality).

## Game 18: Kasparov (W) vs Fischer (B) — 0-1

- Opening (booked prefix): 1.d4 1...Nf6 2.Nf3 2...g6 3.c4 3...Bg7 4.Nc3 4...O-O 5...d6 6.Be2 6...e5 7.Be3 7...Qe7
- Left book: Kasparov (White) after move 5; Fischer (Black) after move 8.
- Biggest eval swing: **25.Bd3** (-0.87 → -1.99, White POV).
- Termination: White resigns.

## Game 19: Fischer (W) vs Kasparov (B) — 0-1

- Opening (booked prefix): 1.e4 1...c5 2.Nf3 2...d6 3.d4 3...cxd4 4.Nxd4 4...Nf6 5.Nc3 5...a6 6.Bc4 6...e6 7.Bb3 7...Nbd7
- Left book: Fischer (White) after move 8; Kasparov (Black) after move 8.
- Biggest eval swing: **30.Kc1** (-2.40 → -3.69, White POV).
- Termination: White resigns.

## Game 20: Kasparov (W) vs Fischer (B) — 0-1

- Opening (booked prefix): 1.e4 1...Nf6 2.e5 2...Nd5 3.d4 3...d6 4.Nf3 4...g6 5...Nb6 6...Bg7
- Left book: Kasparov (White) after move 5; Fischer (Black) after move 7.
- Biggest eval swing: **23.Nd2** (+0.01 → -2.17, White POV).
- Termination: White resigns.

## Game 21: Fischer (W) vs Kasparov (B) — 1/2-1/2

- Opening (booked prefix): 1.e4 1...c5 2.Nf3 2...d6 3.d4 3...cxd4 4.Nxd4 4...Nf6 5.Nc3 5...a6 6.Bc4 6...e6 7.Bb3 7...b5 8.f4
- Left book: Fischer (White) after move 9; Kasparov (Black) after move 8.
- Biggest eval swing: **18...Rd8** (-1.61 → -0.51, White POV).
- Termination: Drawn (sustained equality).

## Game 22: Kasparov (W) vs Fischer (B) — 1/2-1/2

- Opening (booked prefix): 1.e4 1...c5 2.Nf3 2...d6 3.d4 3...cxd4 4.Nxd4 4...Nf6 5.Nc3 5...a6 6.Be3 6...e5 7.Nb3
- Left book: Kasparov (White) after move 8; Fischer (Black) after move 7.
- Biggest eval swing: **17...dxc5** (+0.05 → +0.59, White POV).
- Termination: Drawn (sustained equality).

## Game 23: Fischer (W) vs Kasparov (B) — 1/2-1/2

- Opening (booked prefix): 1.e4 1...c5 2.Nf3 2...e6 3.d4 3...cxd4 4.Nxd4 4...Nc6 5.Nc3 5...d6 6...a6 7...Nge7 8...b5
- Left book: Fischer (White) after move 6; Kasparov (Black) after move 9.
- Biggest eval swing: **15.Bh3** (+0.87 → +0.47, White POV).
- Termination: Draw agreed.

## Game 24: Kasparov (W) vs Fischer (B) — 1/2-1/2

- Opening (booked prefix): 1.d4 1...d5 2.Nf3 2...e6 3...Be7
- Left book: Kasparov (White) after move 3; Fischer (Black) after move 4.
- Biggest eval swing: **33.h4** (+1.51 → +0.50, White POV).
- Termination: Draw agreed.

## Notes

- Move backend is a verification search read at the visit head, not `go nodes 1` policy — a search-refuted move gets too few visits to enter the top-K, so the one-ply blunder cliffs of match #1 are removed.

- Strength delta is injected solely through search nodes (Kasparov 560 / Fischer 400); no eval-noise or blunder handicap (spec 214 hard rule).

- Compute: 2476s for 24 games on warm engines.
