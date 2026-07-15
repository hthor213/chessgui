# Persona Eval Harness — Results (spec 214, tier-1)

_Generated 2026-07-14 19:04 · seed 214214 · movetime 150ms (SF) · lc0 `go nodes 1` (policy)._

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

## Notes & caveats

- EVAL split only; training games were never sampled. Positions deduped by FEN so shared opening lines don't overweight the opening bucket.

- Maia nets top out at the 1900 band; both Fischer and Kasparov are far above that, so Maia move-match is a floor, not a fit — the point of the contrast is to see how much a *human* policy at its ceiling still recovers of a 2700+ player's choices.

- `match@1` against a single ground-truth move is inherently low even for a perfect model: strong positions often have several reasonable moves. Read `match@3` and cross-backend agreement alongside it.
