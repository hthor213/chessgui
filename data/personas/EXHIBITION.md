# Persona Exhibition — Fischer vs Kasparov

_Spec 214 tier-2 proof of concept · 2026-07-14 · seed 214214 · 6 games, alternating colors._

Each persona = opening book weighted from their own TRAIN games (Fischer: `fischer.train.pgn`; Kasparov: `kasparov.train.classical.pgn`) + BT3-768x15x24h pure policy (`go nodes 1`) once out of book, sampled at temperature 0.35 over the top 5 policy moves. Stockfish 18 (200 ms) adjudicated; it never chose a move.

## Match score: Fischer 2.5 – 3.5 Kasparov

| # | White | Black | Result | Plies | Termination |
|--:|---|---|:--:|--:|---|
| 1 | Fischer | Kasparov | **1/2-1/2** | 120 | Drawn (|eval| < 0.3 for 20 plies past move 60) |
| 2 | Kasparov | Fischer | **1-0** | 47 | Black resigns (eval >= +5 for 4 plies) |
| 3 | Fischer | Kasparov | **1/2-1/2** | 87 | Draw by rule |
| 4 | Kasparov | Fischer | **1-0** | 89 | Black resigns (eval >= +5 for 4 plies) |
| 5 | Fischer | Kasparov | **1-0** | 109 | Black resigns (eval >= +5 for 4 plies) |
| 6 | Kasparov | Fischer | **1/2-1/2** | 145 | Drawn (|eval| < 0.3 for 20 plies past move 60) |

## Game 1: Fischer (W) vs Kasparov (B) — 1/2-1/2

- Opening (booked prefix): 1.e4 1...c5 2.Nf3 2...e6 3.d4 3...cxd4 4.Nxd4 4...Nf6 5.Nc3 5...Nc6
- Left book: Fischer (White) after move 6; Kasparov (Black) after move 6.
- Biggest eval swing: **19.Rc1** (+3.63 → -0.29, White POV).
- Termination: Drawn (|eval| < 0.3 for 20 plies past move 60).

## Game 2: Kasparov (W) vs Fischer (B) — 1-0

- Opening (booked prefix): 1.e4 1...e5 2.Nf3 2...Nc6 3.Bb5 3...Bc5 4...Nf6 5...Bb6
- Left book: Kasparov (White) after move 4; Fischer (Black) after move 6.
- Biggest eval swing: **15...Bxd6** (-4.03 → +2.26, White POV).
- Termination: Black resigns (eval >= +5 for 4 plies).

## Game 3: Fischer (W) vs Kasparov (B) — 1/2-1/2

- Opening (booked prefix): 1.e4 1...c5 2.Nf3 2...d6 3.d4 3...cxd4 4.Nxd4 4...Nf6 5.Nc3 5...a6 6.h3
- Left book: Fischer (White) after move 7; Kasparov (Black) after move 6.
- Biggest eval swing: **34.Bg6** (+0.00 → -1.98, White POV).
- Termination: Draw by rule.

## Game 4: Kasparov (W) vs Fischer (B) — 1-0

- Opening (booked prefix): 1.e4 1...c5 2.Nf3 2...d6 3.d4 3...cxd4 4.Nxd4 4...Nf6 5.Nc3 5...a6 6.Be3 6...e5 7.Nb3 8.f3 9.Qd2
- Left book: Kasparov (White) after move 10; Fischer (Black) after move 7.
- Biggest eval swing: **43...Rg6** (+3.73 → +6.31, White POV).
- Termination: Black resigns (eval >= +5 for 4 plies).

## Game 5: Fischer (W) vs Kasparov (B) — 1-0

- Opening (booked prefix): 1.e4 1...c5 2.Nf3 2...d6 3.d4 3...cxd4 4.Nxd4 4...Nf6 5.Nc3 5...a6 6.h3
- Left book: Fischer (White) after move 7; Kasparov (Black) after move 6.
- Biggest eval swing: **54...Rxa7** (+5.36 → +9.50, White POV).
- Termination: Black resigns (eval >= +5 for 4 plies).

## Game 6: Kasparov (W) vs Fischer (B) — 1/2-1/2

- Opening (booked prefix): 1.e4 1...c5 2.Nf3 2...d6 3.Bb5+ 3...Bd7
- Left book: Kasparov (White) after move 4; Fischer (Black) after move 4.
- Biggest eval swing: **57...Rxb2** (-5.14 → +0.00, White POV).
- Termination: Drawn (|eval| < 0.3 for 20 plies past move 60).

## Notes

- Books diverge fast (the two never met), so most games leave book in the opening and BT3 policy carries the middlegame — exactly the tier-1 finding that a strong-engine policy, not a Maia net, best fits players of this strength.

- Compute: 139s for 6 games on warm engines.
