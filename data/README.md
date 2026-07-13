# Eval-Qualified Starting Positions (data pipeline)

Offline data tooling for the **Engine Tournament** feature (Milestone 3a).

Goal: produce a pool of chess starting positions, each tagged with a Stockfish
evaluation, so the app can later sample positions whose eval is spread across a
range (e.g. −2 … +2 pawns) **with variance** — not all the same value. This
supports the "eval-qualified starting positions" tournament mode, where each
game starts from a controlled, known imbalance.

This directory is **pure data tooling**. No Rust/frontend code is involved.

---

## Source opening books

Downloaded from the **official Stockfish testing books** repository
(`official-stockfish/books`), the same books used in Fishtest:

| File | Role | URL |
|------|------|-----|
| `UHO_4060_v3.epd` | UHO ("Unbalanced Human Openings"), White-favored imbalance window | <https://github.com/official-stockfish/books/raw/master/UHO_4060_v3.epd.zip> |
| `popularpos_lichess_v3.epd` | Popular (roughly balanced) Lichess positions | <https://github.com/official-stockfish/books/raw/master/popularpos_lichess_v3.epd.zip> |

**UHO** = *Unbalanced Human Openings* by Stefan Pohl — opening sets chosen so
one side has a slight, deliberate advantage, designed exactly for engine-vs-engine
testing where you want a non-drawish but fair starting imbalance.
The `4060` variant targets roughly +0.40 … +0.60 pawns at the book's own
reference depth. (See <https://www.sp-cc.de/> and the TalkChess UHO threads.)

Raw books live in `data/openings/` and are **gitignored** (large, downloadable).

### Building the spread pool

UHO books only contain *positive* (White-favored) imbalances, and re-evaluating
the balanced `popularpos` set at our depth clusters near zero. To get a pool
that spans **negative through positive** with even coverage, the pool is built
by mixing three slices (see the inline `python3 -c` snippet in the regenerate
steps below):

1. ~120 balanced positions from `popularpos_lichess_v3` (near 0, both signs).
2. ~120 White-favored positions from `UHO_4060_v3` (positive tail).
3. ~120 **color-mirrored** UHO positions (board flipped + colors swapped +
   side-to-move flipped), turning a "+1.0 for White" position into a
   "−1.0 for White" one (negative tail).

The mixed pool is written to `data/openings/combined_pool.epd`.

---

## How to regenerate

From the repo root (`/Users/hjalti/github/chessgui`):

```bash
# 1. Download + unzip the raw books
mkdir -p data/openings && cd data/openings
curl -sL -o UHO_4060_v3.epd.zip \
  "https://github.com/official-stockfish/books/raw/master/UHO_4060_v3.epd.zip"
curl -sL -o popularpos_lichess_v3.epd.zip \
  "https://github.com/official-stockfish/books/raw/master/popularpos_lichess_v3.epd.zip"
unzip -oq UHO_4060_v3.epd.zip
unzip -oq popularpos_lichess_v3.epd.zip
cd ../..

# 2. Build the balanced spread pool (120 balanced + 120 +imbalance + 120 mirrored -imbalance)
python3 - <<'PY'
import random
random.seed(11)

def mirror(epd):
    f = epd.split(); board, stm = f[0], f[1]
    cast = f[2] if len(f) > 2 else '-'; ep = f[3] if len(f) > 3 else '-'
    nboard = '/'.join(r.swapcase() for r in reversed(board.split('/')))
    nstm = 'b' if stm == 'w' else 'w'
    ncast = '-' if cast == '-' else (''.join(sorted(cast.swapcase())) or '-')
    nep = '-' if ep == '-' else ep[0] + str(9 - int(ep[1]))
    return f'{nboard} {nstm} {ncast} {nep} 0 1'

def load(p):
    return [ln.strip() for ln in open(p) if '/' in ln]

pop = load('data/openings/popularpos_lichess_v3.epd'); random.shuffle(pop)
uho = load('data/openings/UHO_4060_v3.epd'); random.shuffle(uho)
pool = pop[:120] + uho[120:240] + [mirror(x) for x in uho[:120]]
random.shuffle(pool)
open('data/openings/combined_pool.epd', 'w').write('\n'.join(pool) + '\n')
print('wrote', len(pool), 'positions')
PY

# 3. Tag each position with Stockfish (depth 16, White POV) -> data/tagged_positions.json
python3 scripts/tag_positions.py \
  -i data/openings/combined_pool.epd \
  -o data/tagged_positions.json \
  --depth 16 --max 360 \
  --source "official-stockfish/books: UHO_4060_v3 (+/- mirrored) + popularpos_lichess_v3"

# 4. (Optional) Demonstrate a spread sample across [-2, +2]
python3 scripts/sample_spread.py --n 16
```

`tag_positions.py` is reusable on **any** EPD/FEN file:

```bash
# Tag the first 300 UHO positions directly, depth 14:
python3 scripts/tag_positions.py -i data/openings/UHO_4060_v3.epd --depth 14 --max 300
# Use a time budget instead of depth, and random-sample the book:
python3 scripts/tag_positions.py -i data/openings/UHO_4060_v3.epd --movetime 200 --max 300 --shuffle
```

Engine path defaults to `/opt/homebrew/bin/stockfish` (override with `--engine`).

---

## `data/tagged_positions.json` schema

A JSON array of objects:

```jsonc
[
  {
    "fen": "rnbqkb1r/pp4pp/8/2p1p3/2PpP3/P4N2/1P3PPP/R1BQKB1R b KQkq - 0 1",
    "eval_cp": -101,        // integer centipawns, WHITE's point of view
    "eval_pawns": -1.01,    // eval_cp / 100, WHITE's point of view
    "source": "official-stockfish/books: UHO_4060_v3 (+/- mirrored) + popularpos_lichess_v3"
  }
]
```

- **Sign convention:** evals are normalized to **White's perspective**. UCI
  reports `score cp` from the side-to-move's POV; `tag_positions.py` flips the
  sign when it is Black to move. Positive = White is better.
- **Mate scores:** `score mate N` is clamped to a large centipawn magnitude
  (`±32000 − |N|`) so mates sort beyond any normal eval.

---

## Observed eval distribution (proof-of-concept batch)

360 positions, evaluated at depth 16, White POV:

```
count:  360
min:   -1.74    max:  +1.41
mean:  +0.03    median:  +0.15    stdev:  0.86

Histogram (0.5-pawn bins, White POV):
  [ -2.0,  -1.5):   2
  [ -1.5,  -1.0):  62
  [ -1.0,  -0.5):  57
  [ -0.5,   0.0):  35
  [  0.0,  +0.5):  76
  [ +0.5,  +1.0):  58
  [ +1.0,  +1.5):  70

in [-2, +2]: 360   outside: 0
```

The distribution is centered near 0 with real variance (stdev ≈ 0.86 pawns) and
every 0.5-pawn bin from −2.0 to +1.5 is populated, confirming the pool can
supply a spread of imbalanced starting positions rather than a single eval.

`scripts/sample_spread.py` buckets into 0.25-pawn bins and round-robins across
them to pull an evenly-spread sample (e.g. 16 positions spanning −1.74 … +1.28
with 16 distinct evals).

---

## Files

- `scripts/tag_positions.py` — EPD/FEN → Stockfish eval → tagged JSON.
- `scripts/sample_spread.py` — spread/variance sampler + bucket histogram.
- `data/tagged_positions.json` — the tagged pool (tracked).
- `data/openings/` — raw downloaded books + `combined_pool.epd` (gitignored).
