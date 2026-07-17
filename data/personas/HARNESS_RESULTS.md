# Persona Eval Harness — Results (spec 214, tier-1)

_Generated 2026-07-15 14:45 · seed 214214 · movetime 150ms (SF) · lc0 `go nodes 1` (policy)._

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

- Run history: 2026-07-14 initial run (fischer, kasparov, sigurjonsson, sigurjonsson-peak; 250 pos each). 2026-07-15 fleet run added the spec-217 roster (spassky, karpov + 7 Icelandic GMs; 250 pos each, same seed/config; no net substitution — the BT3 net named above was present locally and used as-is). Sampling is seeded+deterministic and rankings are disk-cached, so earlier personas' numbers regenerate byte-identically in this report.

---

## Tuning run — spec 214 metrics harness + auto-tuning (2026-07-16 02:23)

_Script `scripts/persona/tune_persona.py` · seed 214214 · reweight math ported 1:1 from src-tauri/src/persona.rs (persona_sim.py) · SF depth 12 verify / depth 16 endgame arm · total 19.6 min._

Metric definitions: metrics214.py. move-match@1/@3 are ARGMAX-by-final-sampling-weight (temperature-invariant); expected match@1 is the mass the sampler puts on the human move; NLL is the proper scoring rule that fits temperature; ACPL profile and error timing are teacher-forced on the same held-out positions; opening KL is KL(real || book+policy) over the first 12 plies, visit-weighted.

Tuning: coordinate descent — stage A (alpha, lambda) maximizes move-match@1 on the tune half; stage B (T, opening/endgame mults) minimizes NLL; stage C grid-searches candidate style priors (persona.rs StyleBias: one v1 move class x multiplier x post-book window, with plies-since-book-exit reconstructed from the eval games). The test half is untouched by the optimizers; the acceptance bar (+2% absolute match@1) is judged there — for params AND, separately, for the style prior, which ships OFF unless its own held-out delta meets the bar.

### sigurjonsson-peak

Backend `lc0-bt3` · 250 records (of 250 positions; skipped {'terminal_policy': 0, 'eval_failed': 0, 'budget_cut': 0}) · tune/test 125/125 · runtime 1.4 min (cap 30).

- defaults: alpha=1.0, lambda=0.75, T=0.5 (flat)
- tuned:    alpha=0.5, lambda=1.5, T=0.65 (opening x0.4, endgame x1.0)

| metric (test half) | default | tuned |
|---|--:|--:|
| match@1 | 0.56 | 0.536 |
| match@3 | 0.776 | 0.768 |
| expected_match@1 | 0.4859 | 0.4526 |
| nll | 1.8868 | 1.8862 |
| acpl_shape_similarity | 0.8383 | 0.8348 |
| error_timing_similarity | 0.3965 | 0.4241 |
| opening KL (nats) | 1.1403 | 1.1594 |

ACPL profile (test, default params): real {'opening': 7.8, 'middlegame': 17.9, 'endgame': 74.0} vs persona {'opening': 6.9, 'middlegame': 10.1, 'endgame': 23.5}; tuned persona {'opening': 3.7, 'middlegame': 10.1, 'endgame': 18.9}.
Opening KL coverage 1.0 (book share 0.7521).

**Acceptance bar (+2% absolute argmax move-match@1 on the test half): delta -0.0240 -> NOT MET.**

Style prior (stage C, 30 candidates): no candidate beat the no-prior baseline on the tune half.

Error model (stage D, corpus band 1900, 4 scales): no rate_scale beat the no-model baseline on the tune half. Coverage (test half): 125.

### fischer

Backend `lc0-bt3` · 250 records (of 250 positions; skipped {'terminal_policy': 0, 'eval_failed': 0, 'budget_cut': 0}) · tune/test 125/125 · runtime 1.4 min (cap 30).

- defaults: alpha=1.0, lambda=0.75, T=0.5 (flat)
- tuned:    alpha=0.7, lambda=0.0, T=0.5 (opening x1.0, endgame x0.5)

| metric (test half) | default | tuned |
|---|--:|--:|
| match@1 | 0.632 | 0.616 |
| match@3 | 0.816 | 0.808 |
| expected_match@1 | 0.5766 | 0.519 |
| nll | 1.4698 | 1.5276 |
| acpl_shape_similarity | 0.924 | 0.8723 |
| error_timing_similarity | 0.63 | 0.4124 |
| opening KL (nats) | 0.9512 | 0.9419 |

ACPL profile (test, default params): real {'opening': 8.8, 'middlegame': 8.5, 'endgame': 5.9} vs persona {'opening': 6.0, 'middlegame': 7.3, 'endgame': 6.6}; tuned persona {'opening': 9.1, 'middlegame': 16.5, 'endgame': 7.8}.
Opening KL coverage 1.0 (book share 0.8255).

**Acceptance bar (+2% absolute argmax move-match@1 on the test half): delta -0.0160 -> NOT MET.**

Style prior (stage C, 30 candidates): no candidate beat the no-prior baseline on the tune half.

Error model (stage D, corpus band 1900, 4 scales): no rate_scale beat the no-model baseline on the tune half. Coverage (test half): 125.

### kasparov

Backend `lc0-bt3` · 250 records (of 250 positions; skipped {'terminal_policy': 0, 'eval_failed': 0, 'budget_cut': 0}) · tune/test 125/125 · runtime 0.1 min (cap 30).

- defaults: alpha=1.0, lambda=0.75, T=0.5 (flat)
- tuned:    alpha=1.0, lambda=0.0, T=0.5 (opening x0.8, endgame x1.0)

| metric (test half) | default | tuned |
|---|--:|--:|
| match@1 | 0.696 | 0.656 |
| match@3 | 0.904 | 0.888 |
| expected_match@1 | 0.5885 | 0.5618 |
| nll | 1.2459 | 1.2833 |
| acpl_shape_similarity | 0.9833 | 0.8947 |
| error_timing_similarity | 0.8138 | 0.684 |
| opening KL (nats) | 0.6773 | 0.682 |

ACPL profile (test, default params): real {'opening': 5.1, 'middlegame': 11.9, 'endgame': 15.3} vs persona {'opening': 3.9, 'middlegame': 8.1, 'endgame': 10.2}; tuned persona {'opening': 4.0, 'middlegame': 22.4, 'endgame': 21.0}.
Opening KL coverage 0.9368 (book share 0.9053).

**Acceptance bar (+2% absolute argmax move-match@1 on the test half): delta -0.0400 -> NOT MET.**

Style prior (stage C, 30 candidates): best = pawn_push x1.5 for 4 plies after book exit; held-out match@1 0.656 -> 0.656 (delta +0.0000, bar +0.02) -> **measured, below the bar — stays off**. Live windows (test half): {'4': 16, '8': 31}.

Error model (stage D, corpus band 1900, 4 scales): no rate_scale beat the no-model baseline on the tune half. Coverage (test half): 125.

### karpov

Backend `lc0-bt3` · 250 records (of 250 positions; skipped {'terminal_policy': 0, 'eval_failed': 0, 'budget_cut': 0}) · tune/test 125/125 · runtime 2.1 min (cap 30).

- defaults: alpha=1.0, lambda=0.75, T=0.5 (flat)
- tuned:    alpha=0.7, lambda=0.75, T=0.5 (opening x1.0, endgame x0.8)

| metric (test half) | default | tuned |
|---|--:|--:|
| match@1 | 0.504 | 0.504 |
| match@3 | 0.792 | 0.792 |
| expected_match@1 | 0.4311 | 0.419 |
| nll | 1.9782 | 1.9067 |
| acpl_shape_similarity | 0.8221 | 0.8336 |
| error_timing_similarity | None | None |
| opening KL (nats) | 0.6811 | 0.6781 |

ACPL profile (test, default params): real {'opening': 11.4, 'middlegame': 9.3, 'endgame': 7.4} vs persona {'opening': 4.0, 'middlegame': 7.4, 'endgame': 3.1}; tuned persona {'opening': 5.1, 'middlegame': 8.3, 'endgame': 3.3}.
Opening KL coverage 0.9623 (book share 0.9409).

**Acceptance bar (+2% absolute argmax move-match@1 on the test half): delta +0.0000 -> NOT MET.**

Style prior (stage C, 30 candidates): no candidate beat the no-prior baseline on the tune half.

Error model (stage D, corpus band 1900, 4 scales): no rate_scale beat the no-model baseline on the tune half. Coverage (test half): 125.

### spassky

Backend `lc0-bt3` · 250 records (of 250 positions; skipped {'terminal_policy': 0, 'eval_failed': 0, 'budget_cut': 0}) · tune/test 125/125 · runtime 2.0 min (cap 30).

- defaults: alpha=1.0, lambda=0.75, T=0.5 (flat)
- tuned:    alpha=0.5, lambda=1.5, T=0.65 (opening x0.8, endgame x1.0)

| metric (test half) | default | tuned |
|---|--:|--:|
| match@1 | 0.552 | 0.552 |
| match@3 | 0.832 | 0.848 |
| expected_match@1 | 0.4834 | 0.4471 |
| nll | 1.6602 | 1.6124 |
| acpl_shape_similarity | 0.9878 | 0.9807 |
| error_timing_similarity | None | None |
| opening KL (nats) | 1.0206 | 1.0019 |

ACPL profile (test, default params): real {'opening': 6.1, 'middlegame': 7.6, 'endgame': 7.8} vs persona {'opening': 6.0, 'middlegame': 8.0, 'endgame': 8.2}; tuned persona {'opening': 6.6, 'middlegame': 8.5, 'endgame': 7.8}.
Opening KL coverage 0.9548 (book share 0.8794).

**Acceptance bar (+2% absolute argmax move-match@1 on the test half): delta +0.0000 -> NOT MET.**

Style prior (stage C, 30 candidates): no candidate beat the no-prior baseline on the tune half.

Error model (stage D, corpus band 1900, 4 scales): no rate_scale beat the no-model baseline on the tune half. Coverage (test half): 125.

### fridrik-olafsson

Backend `lc0-bt3` · 250 records (of 250 positions; skipped {'terminal_policy': 0, 'eval_failed': 0, 'budget_cut': 0}) · tune/test 125/125 · runtime 1.3 min (cap 30).

- defaults: alpha=1.0, lambda=0.75, T=0.5 (flat)
- tuned:    alpha=0.85, lambda=0.75, T=0.65 (opening x1.0, endgame x0.8)

| metric (test half) | default | tuned |
|---|--:|--:|
| match@1 | 0.528 | 0.52 |
| match@3 | 0.808 | 0.808 |
| expected_match@1 | 0.4819 | 0.4477 |
| nll | 1.9675 | 1.9529 |
| acpl_shape_similarity | 0.9787 | 0.9583 |
| error_timing_similarity | 0.7325 | 0.6058 |
| opening KL (nats) | 1.6171 | 1.5591 |

ACPL profile (test, default params): real {'opening': 9.0, 'middlegame': 16.1, 'endgame': 0.0} vs persona {'opening': 4.9, 'middlegame': 9.5, 'endgame': 0.1}; tuned persona {'opening': 5.8, 'middlegame': 12.4, 'endgame': 0.2}.
Opening KL coverage 1.0 (book share 0.6498).

**Acceptance bar (+2% absolute argmax move-match@1 on the test half): delta -0.0080 -> NOT MET.**

Style prior (stage C, 30 candidates): best = pawn_push x0.5 for 4 plies after book exit; held-out match@1 0.52 -> 0.52 (delta +0.0000, bar +0.02) -> **measured, below the bar — stays off**. Live windows (test half): {'4': 5, '8': 17}.

Error model (stage D, corpus band 1900, 4 scales): no rate_scale beat the no-model baseline on the tune half. Coverage (test half): 125.

### margeir-petursson

Backend `lc0-bt3` · 250 records (of 250 positions; skipped {'terminal_policy': 0, 'eval_failed': 0, 'budget_cut': 0}) · tune/test 125/125 · runtime 2.0 min (cap 30).

- defaults: alpha=1.0, lambda=0.75, T=0.5 (flat)
- tuned:    alpha=0.5, lambda=0.75, T=0.5 (opening x1.0, endgame x1.3)

| metric (test half) | default | tuned |
|---|--:|--:|
| match@1 | 0.632 | 0.632 |
| match@3 | 0.848 | 0.848 |
| expected_match@1 | 0.5739 | 0.4987 |
| nll | 1.4715 | 1.4964 |
| acpl_shape_similarity | 0.8699 | 0.8695 |
| error_timing_similarity | None | None |
| opening KL (nats) | 1.1164 | 1.096 |

ACPL profile (test, default params): real {'opening': 6.4, 'middlegame': 7.0, 'endgame': 5.2} vs persona {'opening': 3.5, 'middlegame': 7.4, 'endgame': 5.7}; tuned persona {'opening': 5.3, 'middlegame': 10.3, 'endgame': 9.5}.
Opening KL coverage 0.951 (book share 0.85).

**Acceptance bar (+2% absolute argmax move-match@1 on the test half): delta +0.0000 -> NOT MET.**

Style prior (stage C, 30 candidates): best = quiet_piece x2.0 for 4 plies after book exit; held-out match@1 0.632 -> 0.632 (delta +0.0000, bar +0.02) -> **measured, below the bar — stays off**. Live windows (test half): {'4': 7, '8': 18}.

Error model (stage D, corpus band 1900, 4 scales): no rate_scale beat the no-model baseline on the tune half. Coverage (test half): 125.

### johann-hjartarson

Backend `lc0-bt3` · 250 records (of 250 positions; skipped {'terminal_policy': 0, 'eval_failed': 0, 'budget_cut': 0}) · tune/test 125/125 · runtime 1.6 min (cap 30).

- defaults: alpha=1.0, lambda=0.75, T=0.5 (flat)
- tuned:    alpha=0.5, lambda=2.5, T=1.3 (opening x1.0, endgame x0.5)

| metric (test half) | default | tuned |
|---|--:|--:|
| match@1 | 0.528 | 0.616 |
| match@3 | 0.792 | 0.792 |
| expected_match@1 | 0.5014 | 0.4324 |
| nll | 1.9204 | 1.9541 |
| acpl_shape_similarity | 0.9745 | 0.8282 |
| error_timing_similarity | 0.8797 | 0.5997 |
| opening KL (nats) | 0.8599 | 0.8497 |

ACPL profile (test, default params): real {'opening': 5.1, 'middlegame': 13.2, 'endgame': 8.2} vs persona {'opening': 5.0, 'middlegame': 11.4, 'endgame': 6.8}; tuned persona {'opening': 10.0, 'middlegame': 12.9, 'endgame': 4.6}.
Opening KL coverage 0.9855 (book share 0.8741).

**Acceptance bar (+2% absolute argmax move-match@1 on the test half): delta +0.0880 -> MET.**

Style prior (stage C, 30 candidates): best = quiet_piece x2.0 for 8 plies after book exit; held-out match@1 0.616 -> 0.624 (delta +0.0080, bar +0.02) -> **measured, below the bar — stays off**. Live windows (test half): {'4': 17, '8': 26}.

Error model (stage D, corpus band 1900, 4 scales): no rate_scale beat the no-model baseline on the tune half. Coverage (test half): 125.

### hannes-stefansson

Backend `lc0-bt3` · 250 records (of 250 positions; skipped {'terminal_policy': 0, 'eval_failed': 0, 'budget_cut': 0}) · tune/test 125/125 · runtime 1.8 min (cap 30).

- defaults: alpha=1.0, lambda=0.75, T=0.5 (flat)
- tuned:    alpha=1.2, lambda=0.25, T=0.5 (opening x1.0, endgame x1.0)

| metric (test half) | default | tuned |
|---|--:|--:|
| match@1 | 0.56 | 0.552 |
| match@3 | 0.752 | 0.736 |
| expected_match@1 | 0.4741 | 0.4706 |
| nll | 2.0295 | 2.0465 |
| acpl_shape_similarity | 0.883 | 0.8462 |
| error_timing_similarity | 0.8154 | 0.8808 |
| opening KL (nats) | 0.9247 | 0.9305 |

ACPL profile (test, default params): real {'opening': 9.3, 'middlegame': 29.2, 'endgame': 21.6} vs persona {'opening': 4.4, 'middlegame': 11.1, 'endgame': 5.0}; tuned persona {'opening': 4.5, 'middlegame': 16.3, 'endgame': 5.4}.
Opening KL coverage 0.9383 (book share 0.8887).

**Acceptance bar (+2% absolute argmax move-match@1 on the test half): delta -0.0080 -> NOT MET.**

Style prior (stage C, 30 candidates): best = pawn_push x2.0 for 4 plies after book exit; held-out match@1 0.552 -> 0.552 (delta +0.0000, bar +0.02) -> **measured, below the bar — stays off**. Live windows (test half): {'4': 11, '8': 24}.

Error model (stage D, corpus band 1900, 4 scales): no rate_scale beat the no-model baseline on the tune half. Coverage (test half): 125.

### helgi-olafsson

Backend `lc0-bt3` · 250 records (of 250 positions; skipped {'terminal_policy': 0, 'eval_failed': 0, 'budget_cut': 0}) · tune/test 125/125 · runtime 2.0 min (cap 30).

- defaults: alpha=1.0, lambda=0.75, T=0.5 (flat)
- tuned:    alpha=1.0, lambda=0.75, T=0.65 (opening x1.0, endgame x0.8)

| metric (test half) | default | tuned |
|---|--:|--:|
| match@1 | 0.592 | 0.592 |
| match@3 | 0.832 | 0.832 |
| expected_match@1 | 0.5377 | 0.521 |
| nll | 1.7315 | 1.704 |
| acpl_shape_similarity | 0.9072 | 0.8868 |
| error_timing_similarity | 0.0884 | 0.1548 |
| opening KL (nats) | 1.0972 | 1.086 |

ACPL profile (test, default params): real {'opening': 7.9, 'middlegame': 8.9, 'endgame': 7.1} vs persona {'opening': 5.2, 'middlegame': 10.1, 'endgame': 6.5}; tuned persona {'opening': 6.0, 'middlegame': 12.0, 'endgame': 6.7}.
Opening KL coverage 0.9019 (book share 0.8388).

**Acceptance bar (+2% absolute argmax move-match@1 on the test half): delta +0.0000 -> NOT MET.**

Style prior (stage C, 30 candidates): best = quiet_piece x2.0 for 8 plies after book exit; held-out match@1 0.592 -> 0.616 (delta +0.0240, bar +0.02) -> **ENABLED**. Live windows (test half): {'4': 12, '8': 24}.

Error model (stage D, corpus band 1900, 4 scales): no rate_scale beat the no-model baseline on the tune half. Coverage (test half): 125.

### jon-l-arnason

Backend `lc0-bt3` · 250 records (of 250 positions; skipped {'terminal_policy': 0, 'eval_failed': 0, 'budget_cut': 0}) · tune/test 125/125 · runtime 1.6 min (cap 30).

- defaults: alpha=1.0, lambda=0.75, T=0.5 (flat)
- tuned:    alpha=0.7, lambda=0.5, T=0.5 (opening x1.0, endgame x1.3)

| metric (test half) | default | tuned |
|---|--:|--:|
| match@1 | 0.544 | 0.528 |
| match@3 | 0.816 | 0.816 |
| expected_match@1 | 0.445 | 0.4108 |
| nll | 1.974 | 1.9366 |
| acpl_shape_similarity | 0.9162 | 0.9132 |
| error_timing_similarity | 0.5432 | 0.549 |
| opening KL (nats) | 0.7508 | 0.7361 |

ACPL profile (test, default params): real {'opening': 5.7, 'middlegame': 21.0, 'endgame': 16.4} vs persona {'opening': 3.6, 'middlegame': 12.7, 'endgame': 6.9}; tuned persona {'opening': 4.8, 'middlegame': 17.1, 'endgame': 9.1}.
Opening KL coverage 1.0 (book share 0.8479).

**Acceptance bar (+2% absolute argmax move-match@1 on the test half): delta -0.0160 -> NOT MET.**

Style prior (stage C, 30 candidates): best = pawn_push x1.5 for 8 plies after book exit; held-out match@1 0.528 -> 0.536 (delta +0.0080, bar +0.02) -> **measured, below the bar — stays off**. Live windows (test half): {'4': 10, '8': 23}.

Error model (stage D, corpus band 1900, 4 scales): no rate_scale beat the no-model baseline on the tune half. Coverage (test half): 125.

### hedinn-steingrimsson

Backend `lc0-bt3` · 250 records (of 250 positions; skipped {'terminal_policy': 0, 'eval_failed': 0, 'budget_cut': 0}) · tune/test 125/125 · runtime 1.4 min (cap 30).

- defaults: alpha=1.0, lambda=0.75, T=0.5 (flat)
- tuned:    alpha=0.85, lambda=0.75, T=0.65 (opening x0.8, endgame x1.0)

| metric (test half) | default | tuned |
|---|--:|--:|
| match@1 | 0.656 | 0.656 |
| match@3 | 0.856 | 0.856 |
| expected_match@1 | 0.5722 | 0.5311 |
| nll | 1.3563 | 1.3806 |
| acpl_shape_similarity | 0.9374 | 0.9423 |
| error_timing_similarity | 0.5135 | 0.5427 |
| opening KL (nats) | 1.3394 | 1.3155 |

ACPL profile (test, default params): real {'opening': 7.1, 'middlegame': 14.6, 'endgame': 7.1} vs persona {'opening': 5.4, 'middlegame': 10.1, 'endgame': 3.5}; tuned persona {'opening': 5.9, 'middlegame': 12.6, 'endgame': 4.3}.
Opening KL coverage 1.0 (book share 0.619).

**Acceptance bar (+2% absolute argmax move-match@1 on the test half): delta +0.0000 -> NOT MET.**

Style prior (stage C, 30 candidates): best = capture x2.0 for 4 plies after book exit; held-out match@1 0.656 -> 0.648 (delta -0.0080, bar +0.02) -> **measured, below the bar — stays off**. Live windows (test half): {'4': 9, '8': 18}.

Error model (stage D, corpus band 1900, 4 scales): no rate_scale beat the no-model baseline on the tune half. Coverage (test half): 125.
