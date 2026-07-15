# Persona Eval Harness — Results (spec 214, tier-1)

_Generated 2026-07-15 14:43 · seed 214214 · movetime 150ms (SF) · lc0 `go nodes 1` (policy)._

The Hikaru-bot test made quantitative: on held-out positions from each player's own EVAL games, how often does a candidate policy play the human's actual move? `match@1` = exact top move; `match@3` = actual move in the backend's top 3.

## Backends

| backend | what it is |
|---|---|
| `maia-1900` | Maia-1 human-move net, 1900 band (ceiling of Maia) — lc0 policy head |
| `maia-1500` | Maia-1 human-move net, 1500 band (contrast) — lc0 policy head |
| `lc0-bt3` | Strong official net BT3-768x15x24h (pure policy, `nodes 1`) |
| `stockfish-mpv` | Stockfish 18, MultiPV 3 @ 150ms — engine's own ranking |

Strong net: `BT3-768x15x24h-swa-2790000.pb.gz` (sha256 `e3067757d1fc2dfc…`, [source](https://storage.lczero.org/files/networks-contrib/BT3-768x15x24h-swa-2790000.pb.gz)).

## Fischer

250 sampled positions (opening 89, middlegame 134, endgame 27).

### Overall move-match

| backend | n | match@1 | match@3 |
|---|--:|--:|--:|
| maia-1900 | 250 | 40.4% | 70.8% |
| maia-1500 | 250 | 38.0% | 64.0% |
| lc0-bt3 | 250 | 60.4% | 84.0% |
| stockfish-mpv | 250 | 63.2% | 84.4% |

### Per-phase match@1

| backend | opening | middlegame | endgame |
|---|--:|--:|--:|
| maia-1900 | 40.5% (n=89) | 42.5% (n=134) | 29.6% (n=27) |
| maia-1500 | 34.8% (n=89) | 41.8% (n=134) | 29.6% (n=27) |
| lc0-bt3 | 57.3% (n=89) | 59.7% (n=134) | 74.1% (n=27) |
| stockfish-mpv | 58.4% (n=89) | 63.4% (n=134) | 77.8% (n=27) |

### Per-phase match@3

| backend | opening | middlegame | endgame |
|---|--:|--:|--:|
| maia-1900 | 75.3% (n=89) | 65.7% (n=134) | 81.5% (n=27) |
| maia-1500 | 68.5% (n=89) | 59.0% (n=134) | 74.1% (n=27) |
| lc0-bt3 | 77.5% (n=89) | 85.8% (n=134) | 96.3% (n=27) |
| stockfish-mpv | 80.9% (n=89) | 84.3% (n=134) | 96.3% (n=27) |

### Backend top-1 agreement

| pair | agreement |
|---|--:|
| maia-1900 vs maia-1500 | 67.2% |
| maia-1900 vs lc0-bt3 | 46.4% |
| maia-1900 vs stockfish-mpv | 39.2% |
| maia-1500 vs lc0-bt3 | 41.2% |
| maia-1500 vs stockfish-mpv | 35.2% |
| lc0-bt3 vs stockfish-mpv | 65.6% |

## Kasparov

250 sampled positions (opening 84, middlegame 83, endgame 83).

### Overall move-match

| backend | n | match@1 | match@3 |
|---|--:|--:|--:|
| maia-1900 | 250 | 39.6% | 74.8% |
| maia-1500 | 250 | 34.4% | 66.4% |
| lc0-bt3 | 250 | 63.6% | 86.8% |
| stockfish-mpv | 250 | 64.4% | 86.4% |

### Per-phase match@1

| backend | opening | middlegame | endgame |
|---|--:|--:|--:|
| maia-1900 | 44.0% (n=84) | 36.1% (n=83) | 38.6% (n=83) |
| maia-1500 | 32.1% (n=84) | 36.1% (n=83) | 34.9% (n=83) |
| lc0-bt3 | 61.9% (n=84) | 61.5% (n=83) | 67.5% (n=83) |
| stockfish-mpv | 58.3% (n=84) | 71.1% (n=83) | 63.9% (n=83) |

### Per-phase match@3

| backend | opening | middlegame | endgame |
|---|--:|--:|--:|
| maia-1900 | 75.0% (n=84) | 71.1% (n=83) | 78.3% (n=83) |
| maia-1500 | 65.5% (n=84) | 63.9% (n=83) | 69.9% (n=83) |
| lc0-bt3 | 83.3% (n=84) | 84.3% (n=83) | 92.8% (n=83) |
| stockfish-mpv | 84.5% (n=84) | 87.9% (n=83) | 86.8% (n=83) |

### Backend top-1 agreement

| pair | agreement |
|---|--:|
| maia-1900 vs maia-1500 | 69.2% |
| maia-1900 vs lc0-bt3 | 50.4% |
| maia-1900 vs stockfish-mpv | 40.8% |
| maia-1500 vs lc0-bt3 | 43.2% |
| maia-1500 vs stockfish-mpv | 37.2% |
| lc0-bt3 vs stockfish-mpv | 62.8% |

## Sigurjonsson

250 sampled positions (opening 105, middlegame 137, endgame 8).

### Overall move-match

| backend | n | match@1 | match@3 |
|---|--:|--:|--:|
| maia-1900 | 250 | 38.8% | 68.0% |
| maia-1500 | 250 | 32.4% | 64.0% |
| lc0-bt3 | 250 | 53.6% | 76.4% |
| stockfish-mpv | 250 | 52.0% | 82.0% |

### Per-phase match@1

| backend | opening | middlegame | endgame |
|---|--:|--:|--:|
| maia-1900 | 41.9% (n=105) | 36.5% (n=137) | 37.5% (n=8) |
| maia-1500 | 30.5% (n=105) | 34.3% (n=137) | 25.0% (n=8) |
| lc0-bt3 | 52.4% (n=105) | 54.0% (n=137) | 62.5% (n=8) |
| stockfish-mpv | 51.4% (n=105) | 51.8% (n=137) | 62.5% (n=8) |

### Per-phase match@3

| backend | opening | middlegame | endgame |
|---|--:|--:|--:|
| maia-1900 | 66.7% (n=105) | 68.6% (n=137) | 75.0% (n=8) |
| maia-1500 | 56.2% (n=105) | 69.3% (n=137) | 75.0% (n=8) |
| lc0-bt3 | 73.3% (n=105) | 78.1% (n=137) | 87.5% (n=8) |
| stockfish-mpv | 83.8% (n=105) | 80.3% (n=137) | 87.5% (n=8) |

### Backend top-1 agreement

| pair | agreement |
|---|--:|
| maia-1900 vs maia-1500 | 66.0% |
| maia-1900 vs lc0-bt3 | 44.8% |
| maia-1900 vs stockfish-mpv | 32.4% |
| maia-1500 vs lc0-bt3 | 38.8% |
| maia-1500 vs stockfish-mpv | 29.6% |
| lc0-bt3 vs stockfish-mpv | 55.6% |

## Sigurjonsson-peak

250 sampled positions (opening 104, middlegame 146, endgame 0).

### Overall move-match

| backend | n | match@1 | match@3 |
|---|--:|--:|--:|
| maia-1900 | 250 | 38.4% | 65.6% |
| maia-1500 | 250 | 32.0% | 60.4% |
| lc0-bt3 | 250 | 52.4% | 78.4% |
| stockfish-mpv | 250 | 49.6% | 81.6% |

### Per-phase match@1

| backend | opening | middlegame | endgame |
|---|--:|--:|--:|
| maia-1900 | 41.3% (n=104) | 36.3% (n=146) | — |
| maia-1500 | 28.8% (n=104) | 34.2% (n=146) | — |
| lc0-bt3 | 50.0% (n=104) | 54.1% (n=146) | — |
| stockfish-mpv | 46.2% (n=104) | 52.0% (n=146) | — |

### Per-phase match@3

| backend | opening | middlegame | endgame |
|---|--:|--:|--:|
| maia-1900 | 67.3% (n=104) | 64.4% (n=146) | — |
| maia-1500 | 55.8% (n=104) | 63.7% (n=146) | — |
| lc0-bt3 | 71.2% (n=104) | 83.6% (n=146) | — |
| stockfish-mpv | 79.8% (n=104) | 82.9% (n=146) | — |

### Backend top-1 agreement

| pair | agreement |
|---|--:|
| maia-1900 vs maia-1500 | 71.2% |
| maia-1900 vs lc0-bt3 | 46.8% |
| maia-1900 vs stockfish-mpv | 36.8% |
| maia-1500 vs lc0-bt3 | 40.0% |
| maia-1500 vs stockfish-mpv | 33.2% |
| lc0-bt3 vs stockfish-mpv | 60.8% |

## Spassky

250 sampled positions (opening 88, middlegame 94, endgame 68).

### Overall move-match

| backend | n | match@1 | match@3 |
|---|--:|--:|--:|
| maia-1900 | 250 | 40.0% | 70.4% |
| maia-1500 | 250 | 34.0% | 64.4% |
| lc0-bt3 | 250 | 53.6% | 82.8% |
| stockfish-mpv | 250 | 50.8% | 86.4% |

### Per-phase match@1

| backend | opening | middlegame | endgame |
|---|--:|--:|--:|
| maia-1900 | 37.5% (n=88) | 33.0% (n=94) | 52.9% (n=68) |
| maia-1500 | 30.7% (n=88) | 30.9% (n=94) | 42.6% (n=68) |
| lc0-bt3 | 47.7% (n=88) | 58.5% (n=94) | 54.4% (n=68) |
| stockfish-mpv | 53.4% (n=88) | 50.0% (n=94) | 48.5% (n=68) |

### Per-phase match@3

| backend | opening | middlegame | endgame |
|---|--:|--:|--:|
| maia-1900 | 73.9% (n=88) | 59.6% (n=94) | 80.9% (n=68) |
| maia-1500 | 65.9% (n=88) | 51.1% (n=94) | 80.9% (n=68) |
| lc0-bt3 | 76.1% (n=88) | 84.0% (n=94) | 89.7% (n=68) |
| stockfish-mpv | 90.9% (n=88) | 80.8% (n=94) | 88.2% (n=68) |

### Backend top-1 agreement

| pair | agreement |
|---|--:|
| maia-1900 vs maia-1500 | 64.4% |
| maia-1900 vs lc0-bt3 | 41.6% |
| maia-1900 vs stockfish-mpv | 36.4% |
| maia-1500 vs lc0-bt3 | 37.6% |
| maia-1500 vs stockfish-mpv | 32.0% |
| lc0-bt3 vs stockfish-mpv | 52.4% |

## Karpov

250 sampled positions (opening 83, middlegame 84, endgame 83).

### Overall move-match

| backend | n | match@1 | match@3 |
|---|--:|--:|--:|
| maia-1900 | 250 | 38.4% | 67.6% |
| maia-1500 | 250 | 34.8% | 65.2% |
| lc0-bt3 | 250 | 50.4% | 82.0% |
| stockfish-mpv | 250 | 44.8% | 83.6% |

### Per-phase match@1

| backend | opening | middlegame | endgame |
|---|--:|--:|--:|
| maia-1900 | 41.0% (n=83) | 38.1% (n=84) | 36.1% (n=83) |
| maia-1500 | 28.9% (n=83) | 36.9% (n=84) | 38.6% (n=83) |
| lc0-bt3 | 43.4% (n=83) | 46.4% (n=84) | 61.5% (n=83) |
| stockfish-mpv | 37.4% (n=83) | 53.6% (n=84) | 43.4% (n=83) |

### Per-phase match@3

| backend | opening | middlegame | endgame |
|---|--:|--:|--:|
| maia-1900 | 67.5% (n=83) | 65.5% (n=84) | 69.9% (n=83) |
| maia-1500 | 63.9% (n=83) | 60.7% (n=84) | 71.1% (n=83) |
| lc0-bt3 | 80.7% (n=83) | 78.6% (n=84) | 86.8% (n=83) |
| stockfish-mpv | 87.9% (n=83) | 83.3% (n=84) | 79.5% (n=83) |

### Backend top-1 agreement

| pair | agreement |
|---|--:|
| maia-1900 vs maia-1500 | 66.0% |
| maia-1900 vs lc0-bt3 | 40.8% |
| maia-1900 vs stockfish-mpv | 32.0% |
| maia-1500 vs lc0-bt3 | 37.2% |
| maia-1500 vs stockfish-mpv | 29.6% |
| lc0-bt3 vs stockfish-mpv | 59.2% |

## Fridrik-olafsson

250 sampled positions (opening 104, middlegame 142, endgame 4).

### Overall move-match

| backend | n | match@1 | match@3 |
|---|--:|--:|--:|
| maia-1900 | 250 | 43.2% | 69.2% |
| maia-1500 | 250 | 36.0% | 61.6% |
| lc0-bt3 | 250 | 55.2% | 82.8% |
| stockfish-mpv | 250 | 52.8% | 81.2% |

### Per-phase match@1

| backend | opening | middlegame | endgame |
|---|--:|--:|--:|
| maia-1900 | 39.4% (n=104) | 45.1% (n=142) | 75.0% (n=4) |
| maia-1500 | 35.6% (n=104) | 35.2% (n=142) | 75.0% (n=4) |
| lc0-bt3 | 52.9% (n=104) | 57.0% (n=142) | 50.0% (n=4) |
| stockfish-mpv | 52.9% (n=104) | 52.1% (n=142) | 75.0% (n=4) |

### Per-phase match@3

| backend | opening | middlegame | endgame |
|---|--:|--:|--:|
| maia-1900 | 71.2% (n=104) | 67.6% (n=142) | 75.0% (n=4) |
| maia-1500 | 61.5% (n=104) | 60.6% (n=142) | 100.0% (n=4) |
| lc0-bt3 | 80.8% (n=104) | 83.8% (n=142) | 100.0% (n=4) |
| stockfish-mpv | 83.7% (n=104) | 78.9% (n=142) | 100.0% (n=4) |

### Backend top-1 agreement

| pair | agreement |
|---|--:|
| maia-1900 vs maia-1500 | 66.0% |
| maia-1900 vs lc0-bt3 | 49.6% |
| maia-1900 vs stockfish-mpv | 36.8% |
| maia-1500 vs lc0-bt3 | 44.0% |
| maia-1500 vs stockfish-mpv | 33.2% |
| lc0-bt3 vs stockfish-mpv | 59.2% |

## Margeir-petursson

250 sampled positions (opening 84, middlegame 83, endgame 83).

### Overall move-match

| backend | n | match@1 | match@3 |
|---|--:|--:|--:|
| maia-1900 | 250 | 47.6% | 72.8% |
| maia-1500 | 250 | 44.4% | 66.4% |
| lc0-bt3 | 250 | 60.8% | 86.4% |
| stockfish-mpv | 250 | 62.8% | 87.6% |

### Per-phase match@1

| backend | opening | middlegame | endgame |
|---|--:|--:|--:|
| maia-1900 | 47.6% (n=84) | 49.4% (n=83) | 45.8% (n=83) |
| maia-1500 | 41.7% (n=84) | 49.4% (n=83) | 42.2% (n=83) |
| lc0-bt3 | 52.4% (n=84) | 65.1% (n=83) | 65.1% (n=83) |
| stockfish-mpv | 60.7% (n=84) | 65.1% (n=83) | 62.6% (n=83) |

### Per-phase match@3

| backend | opening | middlegame | endgame |
|---|--:|--:|--:|
| maia-1900 | 72.6% (n=84) | 69.9% (n=83) | 75.9% (n=83) |
| maia-1500 | 63.1% (n=84) | 66.3% (n=83) | 69.9% (n=83) |
| lc0-bt3 | 81.0% (n=84) | 90.4% (n=83) | 87.9% (n=83) |
| stockfish-mpv | 84.5% (n=84) | 87.9% (n=83) | 90.4% (n=83) |

### Backend top-1 agreement

| pair | agreement |
|---|--:|
| maia-1900 vs maia-1500 | 74.8% |
| maia-1900 vs lc0-bt3 | 51.2% |
| maia-1900 vs stockfish-mpv | 42.8% |
| maia-1500 vs lc0-bt3 | 49.2% |
| maia-1500 vs stockfish-mpv | 43.6% |
| lc0-bt3 vs stockfish-mpv | 63.6% |

## Johann-hjartarson

250 sampled positions (opening 91, middlegame 124, endgame 35).

### Overall move-match

| backend | n | match@1 | match@3 |
|---|--:|--:|--:|
| maia-1900 | 250 | 41.2% | 72.0% |
| maia-1500 | 250 | 36.4% | 65.2% |
| lc0-bt3 | 250 | 50.8% | 81.6% |
| stockfish-mpv | 250 | 56.4% | 81.2% |

### Per-phase match@1

| backend | opening | middlegame | endgame |
|---|--:|--:|--:|
| maia-1900 | 39.6% (n=91) | 40.3% (n=124) | 48.6% (n=35) |
| maia-1500 | 35.2% (n=91) | 34.7% (n=124) | 45.7% (n=35) |
| lc0-bt3 | 50.5% (n=91) | 49.2% (n=124) | 57.1% (n=35) |
| stockfish-mpv | 56.0% (n=91) | 54.0% (n=124) | 65.7% (n=35) |

### Per-phase match@3

| backend | opening | middlegame | endgame |
|---|--:|--:|--:|
| maia-1900 | 79.1% (n=91) | 68.5% (n=124) | 65.7% (n=35) |
| maia-1500 | 68.1% (n=91) | 61.3% (n=124) | 71.4% (n=35) |
| lc0-bt3 | 78.0% (n=91) | 81.5% (n=124) | 91.4% (n=35) |
| stockfish-mpv | 85.7% (n=91) | 77.4% (n=124) | 82.9% (n=35) |

### Backend top-1 agreement

| pair | agreement |
|---|--:|
| maia-1900 vs maia-1500 | 74.8% |
| maia-1900 vs lc0-bt3 | 46.8% |
| maia-1900 vs stockfish-mpv | 39.6% |
| maia-1500 vs lc0-bt3 | 41.2% |
| maia-1500 vs stockfish-mpv | 38.0% |
| lc0-bt3 vs stockfish-mpv | 59.2% |

## Hannes-stefansson

250 sampled positions (opening 88, middlegame 101, endgame 61).

### Overall move-match

| backend | n | match@1 | match@3 |
|---|--:|--:|--:|
| maia-1900 | 250 | 40.0% | 67.2% |
| maia-1500 | 250 | 36.8% | 63.2% |
| lc0-bt3 | 250 | 56.0% | 77.2% |
| stockfish-mpv | 250 | 56.4% | 84.8% |

### Per-phase match@1

| backend | opening | middlegame | endgame |
|---|--:|--:|--:|
| maia-1900 | 38.6% (n=88) | 32.7% (n=101) | 54.1% (n=61) |
| maia-1500 | 30.7% (n=88) | 32.7% (n=101) | 52.5% (n=61) |
| lc0-bt3 | 51.1% (n=88) | 60.4% (n=101) | 55.7% (n=61) |
| stockfish-mpv | 55.7% (n=88) | 58.4% (n=101) | 54.1% (n=61) |

### Per-phase match@3

| backend | opening | middlegame | endgame |
|---|--:|--:|--:|
| maia-1900 | 62.5% (n=88) | 65.3% (n=101) | 77.0% (n=61) |
| maia-1500 | 53.4% (n=88) | 61.4% (n=101) | 80.3% (n=61) |
| lc0-bt3 | 70.5% (n=88) | 80.2% (n=101) | 82.0% (n=61) |
| stockfish-mpv | 93.2% (n=88) | 79.2% (n=101) | 82.0% (n=61) |

### Backend top-1 agreement

| pair | agreement |
|---|--:|
| maia-1900 vs maia-1500 | 60.0% |
| maia-1900 vs lc0-bt3 | 41.6% |
| maia-1900 vs stockfish-mpv | 36.8% |
| maia-1500 vs lc0-bt3 | 38.8% |
| maia-1500 vs stockfish-mpv | 36.4% |
| lc0-bt3 vs stockfish-mpv | 61.2% |

## Helgi-olafsson

250 sampled positions (opening 85, middlegame 88, endgame 77).

### Overall move-match

| backend | n | match@1 | match@3 |
|---|--:|--:|--:|
| maia-1900 | 250 | 41.6% | 69.6% |
| maia-1500 | 250 | 40.0% | 67.2% |
| lc0-bt3 | 250 | 60.0% | 85.2% |
| stockfish-mpv | 250 | 56.8% | 84.0% |

### Per-phase match@1

| backend | opening | middlegame | endgame |
|---|--:|--:|--:|
| maia-1900 | 37.6% (n=85) | 44.3% (n=88) | 42.9% (n=77) |
| maia-1500 | 37.6% (n=85) | 38.6% (n=88) | 44.2% (n=77) |
| lc0-bt3 | 52.9% (n=85) | 67.0% (n=88) | 59.7% (n=77) |
| stockfish-mpv | 55.3% (n=85) | 61.4% (n=88) | 53.2% (n=77) |

### Per-phase match@3

| backend | opening | middlegame | endgame |
|---|--:|--:|--:|
| maia-1900 | 70.6% (n=85) | 65.9% (n=88) | 72.7% (n=77) |
| maia-1500 | 63.5% (n=85) | 67.0% (n=88) | 71.4% (n=77) |
| lc0-bt3 | 76.5% (n=85) | 87.5% (n=88) | 92.2% (n=77) |
| stockfish-mpv | 85.9% (n=85) | 84.1% (n=88) | 81.8% (n=77) |

### Backend top-1 agreement

| pair | agreement |
|---|--:|
| maia-1900 vs maia-1500 | 74.0% |
| maia-1900 vs lc0-bt3 | 46.8% |
| maia-1900 vs stockfish-mpv | 40.0% |
| maia-1500 vs lc0-bt3 | 43.6% |
| maia-1500 vs stockfish-mpv | 37.6% |
| lc0-bt3 vs stockfish-mpv | 60.8% |

## Jon-l-arnason

250 sampled positions (opening 91, middlegame 123, endgame 36).

### Overall move-match

| backend | n | match@1 | match@3 |
|---|--:|--:|--:|
| maia-1900 | 250 | 41.2% | 66.4% |
| maia-1500 | 250 | 34.4% | 62.0% |
| lc0-bt3 | 250 | 54.0% | 79.6% |
| stockfish-mpv | 250 | 50.0% | 83.6% |

### Per-phase match@1

| backend | opening | middlegame | endgame |
|---|--:|--:|--:|
| maia-1900 | 42.9% (n=91) | 39.8% (n=123) | 41.7% (n=36) |
| maia-1500 | 36.3% (n=91) | 34.2% (n=123) | 30.6% (n=36) |
| lc0-bt3 | 47.2% (n=91) | 56.9% (n=123) | 61.1% (n=36) |
| stockfish-mpv | 51.6% (n=91) | 53.7% (n=123) | 33.3% (n=36) |

### Per-phase match@3

| backend | opening | middlegame | endgame |
|---|--:|--:|--:|
| maia-1900 | 67.0% (n=91) | 64.2% (n=123) | 72.2% (n=36) |
| maia-1500 | 60.4% (n=91) | 61.0% (n=123) | 69.4% (n=36) |
| lc0-bt3 | 78.0% (n=91) | 79.7% (n=123) | 83.3% (n=36) |
| stockfish-mpv | 83.5% (n=91) | 86.2% (n=123) | 75.0% (n=36) |

### Backend top-1 agreement

| pair | agreement |
|---|--:|
| maia-1900 vs maia-1500 | 75.2% |
| maia-1900 vs lc0-bt3 | 46.8% |
| maia-1900 vs stockfish-mpv | 34.0% |
| maia-1500 vs lc0-bt3 | 40.4% |
| maia-1500 vs stockfish-mpv | 30.8% |
| lc0-bt3 vs stockfish-mpv | 54.4% |

## Hedinn-steingrimsson

250 sampled positions (opening 91, middlegame 140, endgame 19).

### Overall move-match

| backend | n | match@1 | match@3 |
|---|--:|--:|--:|
| maia-1900 | 250 | 40.0% | 68.8% |
| maia-1500 | 250 | 38.4% | 64.0% |
| lc0-bt3 | 250 | 55.6% | 80.0% |
| stockfish-mpv | 250 | 53.6% | 84.8% |

### Per-phase match@1

| backend | opening | middlegame | endgame |
|---|--:|--:|--:|
| maia-1900 | 39.6% (n=91) | 40.7% (n=140) | 36.8% (n=19) |
| maia-1500 | 34.1% (n=91) | 40.7% (n=140) | 42.1% (n=19) |
| lc0-bt3 | 59.3% (n=91) | 55.0% (n=140) | 42.1% (n=19) |
| stockfish-mpv | 57.1% (n=91) | 55.0% (n=140) | 26.3% (n=19) |

### Per-phase match@3

| backend | opening | middlegame | endgame |
|---|--:|--:|--:|
| maia-1900 | 70.3% (n=91) | 68.6% (n=140) | 63.2% (n=19) |
| maia-1500 | 67.0% (n=91) | 62.1% (n=140) | 63.2% (n=19) |
| lc0-bt3 | 78.0% (n=91) | 80.7% (n=140) | 84.2% (n=19) |
| stockfish-mpv | 86.8% (n=91) | 84.3% (n=140) | 79.0% (n=19) |

### Backend top-1 agreement

| pair | agreement |
|---|--:|
| maia-1900 vs maia-1500 | 72.0% |
| maia-1900 vs lc0-bt3 | 45.2% |
| maia-1900 vs stockfish-mpv | 38.4% |
| maia-1500 vs lc0-bt3 | 42.0% |
| maia-1500 vs stockfish-mpv | 34.8% |
| lc0-bt3 vs stockfish-mpv | 53.2% |

## Notes & caveats

- EVAL split only; training games were never sampled. Positions deduped by FEN so shared opening lines don't overweight the opening bucket.

- Maia nets top out at the 1900 band; both Fischer and Kasparov are far above that, so Maia move-match is a floor, not a fit — the point of the contrast is to see how much a *human* policy at its ceiling still recovers of a 2700+ player's choices.

- `match@1` against a single ground-truth move is inherently low even for a perfect model: strong positions often have several reasonable moves. Read `match@3` and cross-backend agreement alongside it.
