# Persona Exhibition — Fischer vs Kasparov

_Spec 214 tier-2 proof of concept · 2026-07-14 · seed 214214 · 24 games, alternating colors._

Each persona = opening book weighted from their own TRAIN games (Fischer: `fischer.train.pgn`; Kasparov: `kasparov.train.classical.pgn`) + BT3-768x15x24h pure policy (`go nodes 1`) once out of book, sampled at temperature 0.35 over the top 5 policy moves. Stockfish 18 (200 ms) adjudicated; it never chose a move.

## Match score: Fischer 13 – 11 Kasparov

| # | White | Black | Result | Plies | Termination |
|--:|---|---|:--:|--:|---|
| 1 | Fischer | Kasparov | **1/2-1/2** | 120 | Drawn (|eval| < 0.3 for 20 plies past move 60) |
| 2 | Kasparov | Fischer | **1-0** | 47 | Black resigns (eval >= +5 for 4 plies) |
| 3 | Fischer | Kasparov | **1/2-1/2** | 88 | Draw by rule |
| 4 | Kasparov | Fischer | **1-0** | 89 | Black resigns (eval >= +5 for 4 plies) |
| 5 | Fischer | Kasparov | **1-0** | 109 | Black resigns (eval >= +5 for 4 plies) |
| 6 | Kasparov | Fischer | **1/2-1/2** | 149 | Drawn (|eval| < 0.3 for 20 plies past move 60) |
| 7 | Fischer | Kasparov | **1-0** | 129 | Black resigns (eval >= +5 for 4 plies) |
| 8 | Kasparov | Fischer | **1-0** | 111 | Black resigns (eval >= +5 for 4 plies) |
| 9 | Fischer | Kasparov | **1-0** | 66 | Black resigns (eval >= +5 for 4 plies) |
| 10 | Kasparov | Fischer | **1-0** | 83 | Black resigns (eval >= +5 for 4 plies) |
| 11 | Fischer | Kasparov | **1/2-1/2** | 78 | Draw by rule |
| 12 | Kasparov | Fischer | **0-1** | 118 | White resigns (eval <= -5 for 4 plies) |
| 13 | Fischer | Kasparov | **1-0** | 103 | Black resigns (eval >= +5 for 4 plies) |
| 14 | Kasparov | Fischer | **1/2-1/2** | 61 | Draw by rule |
| 15 | Fischer | Kasparov | **1-0** | 35 | Black resigns (eval >= +5 for 4 plies) |
| 16 | Kasparov | Fischer | **0-1** | 74 | White resigns (eval <= -5 for 4 plies) |
| 17 | Fischer | Kasparov | **1-0** | 79 | Black resigns (eval >= +5 for 4 plies) |
| 18 | Kasparov | Fischer | **1-0** | 43 | Black resigns (eval >= +5 for 4 plies) |
| 19 | Fischer | Kasparov | **1-0** | 95 | Black resigns (eval >= +5 for 4 plies) |
| 20 | Kasparov | Fischer | **1-0** | 91 | Black resigns (eval >= +5 for 4 plies) |
| 21 | Fischer | Kasparov | **1-0** | 115 | Black resigns (eval >= +5 for 4 plies) |
| 22 | Kasparov | Fischer | **1-0** | 75 | Black resigns (eval >= +5 for 4 plies) |
| 23 | Fischer | Kasparov | **0-1** | 102 | White resigns (eval <= -5 for 4 plies) |
| 24 | Kasparov | Fischer | **1/2-1/2** | 70 | Draw by rule |

## Game 1: Fischer (W) vs Kasparov (B) — 1/2-1/2

- Opening (booked prefix): 1.e4 1...c5 2.Nf3 2...e6 3.d4 3...cxd4 4.Nxd4 4...Nf6 5.Nc3 5...Nc6
- Left book: Fischer (White) after move 6; Kasparov (Black) after move 6.
- Biggest eval swing: **20.Nxc5** (+2.99 → -0.77, White POV).
- Termination: Drawn (|eval| < 0.3 for 20 plies past move 60).

## Game 2: Kasparov (W) vs Fischer (B) — 1-0

- Opening (booked prefix): 1.e4 1...e5 2.Nf3 2...Nc6 3.Bb5 3...Bc5 4...Nf6 5...Bb6
- Left book: Kasparov (White) after move 4; Fischer (Black) after move 6.
- Biggest eval swing: **15...Bxd6** (-4.20 → +2.32, White POV).
- Termination: Black resigns (eval >= +5 for 4 plies).

## Game 3: Fischer (W) vs Kasparov (B) — 1/2-1/2

- Opening (booked prefix): 1.e4 1...c5 2.Nf3 2...d6 3.d4 3...cxd4 4.Nxd4 4...Nf6 5.Nc3 5...a6 6.h3
- Left book: Fischer (White) after move 7; Kasparov (Black) after move 6.
- Biggest eval swing: **34.Bg6** (+0.00 → -1.94, White POV).
- Termination: Draw by rule.

## Game 4: Kasparov (W) vs Fischer (B) — 1-0

- Opening (booked prefix): 1.e4 1...c5 2.Nf3 2...d6 3.d4 3...cxd4 4.Nxd4 4...Nf6 5.Nc3 5...a6 6.Be3 6...e5 7.Nb3 8.f3 9.Qd2
- Left book: Kasparov (White) after move 10; Fischer (Black) after move 7.
- Biggest eval swing: **28...Nxg3** (+0.87 → +3.20, White POV).
- Termination: Black resigns (eval >= +5 for 4 plies).

## Game 5: Fischer (W) vs Kasparov (B) — 1-0

- Opening (booked prefix): 1.e4 1...c5 2.Nf3 2...d6 3.d4 3...cxd4 4.Nxd4 4...Nf6 5.Nc3 5...a6 6.h3
- Left book: Fischer (White) after move 7; Kasparov (Black) after move 6.
- Biggest eval swing: **54...Rxa7** (+5.64 → #15, White POV).
- Termination: Black resigns (eval >= +5 for 4 plies).

## Game 6: Kasparov (W) vs Fischer (B) — 1/2-1/2

- Opening (booked prefix): 1.e4 1...c5 2.Nf3 2...d6 3.Bb5+ 3...Bd7
- Left book: Kasparov (White) after move 4; Fischer (Black) after move 4.
- Biggest eval swing: **57...Rxb2** (-5.03 → +0.00, White POV).
- Termination: Drawn (|eval| < 0.3 for 20 plies past move 60).

## Game 7: Fischer (W) vs Kasparov (B) — 1-0

- Opening (booked prefix): 1.e4 1...c5 2.Nf3 2...d6 3.Nc3 3...Nf6 5...a6 6.Bg5 6...e6 7.f4 7...Qb6 8.Qd2 8...Qxb2 9.Rb1 9...Qa3 10.f5 10...Nc6 11.fxe6 11...fxe6 12.Nxc6 12...bxc6
- Left book: Fischer (White) after move 4; Kasparov (Black) after move 4.
- Biggest eval swing: **60...Be7** (+0.22 → +2.16, White POV).
- Termination: Black resigns (eval >= +5 for 4 plies).

## Game 8: Kasparov (W) vs Fischer (B) — 1-0

- Opening (booked prefix): 1.d4 1...Nf6 2.c4 2...g6 3.Nc3 3...Bg7 4.e4 4...d6 5.f3 5...e5 6...O-O
- Left book: Kasparov (White) after move 6; Fischer (Black) after move 7.
- Biggest eval swing: **22.b3** (-1.49 → -3.39, White POV).
- Termination: Black resigns (eval >= +5 for 4 plies).

## Game 9: Fischer (W) vs Kasparov (B) — 1-0

- Opening (booked prefix): 1.e4 1...c5 2.Nf3 2...d6 3.d4 3...cxd4 4.Nxd4 4...Nf6 5.Nc3 5...a6 6.h3
- Left book: Fischer (White) after move 7; Kasparov (Black) after move 6.
- Biggest eval swing: **31...Kd7** (+0.85 → +4.87, White POV).
- Termination: Black resigns (eval >= +5 for 4 plies).

## Game 10: Kasparov (W) vs Fischer (B) — 1-0

- Opening (booked prefix): 1.d4 1...Nf6 2.c4 2...e6 3.Nf3 3...c5 4.d5 4...exd5 5.cxd5 5...g6
- Left book: Kasparov (White) after move 6; Fischer (Black) after move 6.
- Biggest eval swing: **14...Ngxe5** (+1.23 → +2.52, White POV).
- Termination: Black resigns (eval >= +5 for 4 plies).

## Game 11: Fischer (W) vs Kasparov (B) — 1/2-1/2

- Opening (booked prefix): 1.e4 1...c5 2.Nf3 2...d6 3.d4 3...cxd4 4.Nxd4 4...Nf6 5.Nc3 5...a6 6.Bc4 6...e6 7.Bb3 7...b5 8.f4 9.Na4
- Left book: Fischer (White) after move 10; Kasparov (Black) after move 8.
- Biggest eval swing: **32...c3** (-5.04 → -0.61, White POV).
- Termination: Draw by rule.

## Game 12: Kasparov (W) vs Fischer (B) — 0-1

- Opening (booked prefix): 1.e4 1...c5 2.Nf3 2...e6 3.d4 3...cxd4 4.Nxd4 4...a6 5.Nc3 5...Nc6
- Left book: Kasparov (White) after move 6; Fischer (Black) after move 6.
- Biggest eval swing: **36...Bc4** (-1.11 → +0.00, White POV).
- Termination: White resigns (eval <= -5 for 4 plies).

## Game 13: Fischer (W) vs Kasparov (B) — 1-0

- Opening (booked prefix): 1.e4 1...c5 2.Nf3 2...d6 3.Nc3 3...Nf6 5...a6 6.h3
- Left book: Fischer (White) after move 4; Kasparov (Black) after move 4.
- Biggest eval swing: **16...Rd8** (-0.11 → +2.39, White POV).
- Termination: Black resigns (eval >= +5 for 4 plies).

## Game 14: Kasparov (W) vs Fischer (B) — 1/2-1/2

- Opening (booked prefix): 1.c4 1...g6 2.e4
- Left book: Kasparov (White) after move 3; Fischer (Black) after move 2.
- Biggest eval swing: **27.Nxe6** (+1.28 → +0.23, White POV).
- Termination: Draw by rule.

## Game 15: Fischer (W) vs Kasparov (B) — 1-0

- Opening (booked prefix): 1.e4 1...c5 2.Nf3 2...d6 3.d4 3...cxd4 4.Nxd4 4...Nf6 5.Nc3 5...a6 6.Bc4 6...e6 7.Bb3 7...b5 8.f4 9.Na4
- Left book: Fischer (White) after move 10; Kasparov (Black) after move 8.
- Biggest eval swing: **15...Rd8** (+0.00 → +3.21, White POV).
- Termination: Black resigns (eval >= +5 for 4 plies).

## Game 16: Kasparov (W) vs Fischer (B) — 0-1

- Opening (booked prefix): 1.c4 1...Nf6 2.Nf3 2...g6 3.Nc3 3...Bg7 4.g3
- Left book: Kasparov (White) after move 5; Fischer (Black) after move 4.
- Biggest eval swing: **16.Bb2** (+0.24 → -1.69, White POV).
- Termination: White resigns (eval <= -5 for 4 plies).

## Game 17: Fischer (W) vs Kasparov (B) — 1-0

- Opening (booked prefix): 1.e4 1...c5 2.Nf3 2...d6 3.d4 3...cxd4 4.Nxd4 4...Nf6 5.Nc3 5...a6 6.h3
- Left book: Fischer (White) after move 7; Kasparov (Black) after move 6.
- Biggest eval swing: **35...Raa5** (+1.48 → +4.08, White POV).
- Termination: Black resigns (eval >= +5 for 4 plies).

## Game 18: Kasparov (W) vs Fischer (B) — 1-0

- Opening (booked prefix): 1.d4 1...Nf6 2.c4 2...c5 3.d5 3...d6 4.Nc3 4...g6 5.e4 5...Bg7 6.Be2
- Left book: Kasparov (White) after move 7; Fischer (Black) after move 6.
- Biggest eval swing: **20...Kd8** (+0.00 → +5.33, White POV).
- Termination: Black resigns (eval >= +5 for 4 plies).

## Game 19: Fischer (W) vs Kasparov (B) — 1-0

- Opening (booked prefix): 1.e4 1...c5 2.Nf3 2...d6 3.d4 3...cxd4 4.Nxd4 4...Nf6 5.Nc3 5...a6 6.Bc4 6...e6 7.Bb3 7...Nbd7
- Left book: Fischer (White) after move 8; Kasparov (Black) after move 8.
- Biggest eval swing: **19...g6** (+0.15 → +2.70, White POV).
- Termination: Black resigns (eval >= +5 for 4 plies).

## Game 20: Kasparov (W) vs Fischer (B) — 1-0

- Opening (booked prefix): 1.d4 1...Nf6 2.c4 2...g6 3.Nc3 3...Bg7 4.e4 4...d6 5.f3 5...O-O 6.Be3 6...Nc6 7...a6 8...Rb8 9.h4
- Left book: Kasparov (White) after move 7; Fischer (Black) after move 9.
- Biggest eval swing: **32...Rb6** (+1.33 → +4.21, White POV).
- Termination: Black resigns (eval >= +5 for 4 plies).

## Game 21: Fischer (W) vs Kasparov (B) — 1-0

- Opening (booked prefix): 1.e4 1...e5 2.Nf3 2...Nc6 3.Bb5 3...a6 4.Bxc6 4...dxc6 5.O-O 5...f6 6.d4 6...Bg4 7.dxe5 7...Qxd1 8.Rxd1 8...fxe5 9.Rd3 9...Bd6
- Left book: Fischer (White) after move 10; Kasparov (Black) after move 10.
- Biggest eval swing: **41...Rxf2** (+0.22 → +4.00, White POV).
- Termination: Black resigns (eval >= +5 for 4 plies).

## Game 22: Kasparov (W) vs Fischer (B) — 1-0

- Opening (booked prefix): 1.d4 1...Nf6 2.Nf3 2...g6 3.c4 3...Bg7 4.Nc3 4...O-O 5...d6 6.Be2 6...e5 7.Be3 7...Qe7 8...Ne8 9...f5
- Left book: Kasparov (White) after move 5; Fischer (Black) after move 10.
- Biggest eval swing: **27...Rxe3** (+2.44 → +5.82, White POV).
- Termination: Black resigns (eval >= +5 for 4 plies).

## Game 23: Fischer (W) vs Kasparov (B) — 0-1

- Opening (booked prefix): 1.e4 1...c5 2.Nf3 2...d6 3.d4 3...cxd4 4.Nxd4 4...Nf6 5.Nc3 5...a6 6.Bc4 6...e6 7.Bb3 7...Nbd7
- Left book: Fischer (White) after move 8; Kasparov (Black) after move 8.
- Biggest eval swing: **44.Rff7** (-2.82 → -4.09, White POV).
- Termination: White resigns (eval <= -5 for 4 plies).

## Game 24: Kasparov (W) vs Fischer (B) — 1/2-1/2

- Opening (booked prefix): 1.e4 1...c5 2.Nf3 2...d6 3.d4 3...cxd4 4.Nxd4 4...Nf6 5.Nc3 5...a6 6.f4
- Left book: Kasparov (White) after move 7; Fischer (Black) after move 6.
- Biggest eval swing: **27.Qf8** (+3.73 → +0.00, White POV).
- Termination: Draw by rule.

## Notes

- Books diverge fast (the two never met), so most games leave book in the opening and BT3 policy carries the middlegame — exactly the tier-1 finding that a strong-engine policy, not a Maia net, best fits players of this strength.

- Compute: 474s for 24 games on warm engines.
