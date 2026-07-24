# 227 D4 — content review (needs your chess judgment)

The overnight loop authored all 8 modules of **"Playing Closed & Locked
Positions"** to the *automatable* bar and proved it: every illustration PGN is
legal (played move-by-move through chessops), `loadCourse` accepts the course,
the content bar holds (every `explain`/`modelAnswer`, every `source`), and every
`accept` SAN is legal in its FEN (20-test gate in `closed-positions.test.ts`).
Verified in the headless browser too.

**What the loop CANNOT verify — and needs your eye:** whether a game is the
*real* attributed game, whether it's the *right* game for the principle, and
whether the teaching lands. Ranked by how much they'd bug you:

## 1. One game carries three modules — Karpov–Unzicker, Nice 1974
M1 (*Stalling is not a plan*), M5 (*Two weaknesses*), and M8 (*Space &
restriction*) **all use the same game** (Closed Ruy Lopez / Chigorin, moves
1–16). It's a genuinely great squeeze and the move-score verifies as real, but
leaning a third of the course on one Karpov game undercuts the roster's whole
point (Botvinnik, Smyslov, Petrosian, Tal, Carlsen, Gukesh…). **Decide:** keep
it in one module and re-source the other two.

## 2. The M6 centrepiece is composed, not the real pairing
The spec's marquee idea was a **real Petrosian (keep-it-closed) vs. Tal
(blow-it-open)** pairing taught side by side. What shipped in M6 is **two
composed theory lines** with "Petrosian"/"Tal" as *stylistic labels*, honestly
disclosed in the `source` field — not actual games by them. Legal and
on-theme, but it isn't the pairing you asked for. **Decide:** supply the two
real games (e.g. a Petrosian prophylactic grind + a Tal central sac) and I'll
drop them in.

## 3. Composed-heavy modules
M3 (*Improve your worst piece*), M6, and M7 (*Patience*) lean on **composed
positions** rather than master games — the authors chose honesty over
reproducing a game they weren't sure of. Fine for drilling a mechanic, weaker
for "here's how a great player did it." Upgrade where you have a favourite game.

## The solid one
**M2 (*Plan from the structure*)** uses **Botvinnik–Capablanca, AVRO 1938**,
verified move-for-move real (truncated before 30.Ba3!! since the lesson is about
the structural plan). This is the template for what the others should be.

## Per-module game ledger
| M | Principle | Game(s) | Confidence |
|---|---|---|---|
| 1 | Stalling is not a plan | Karpov–Unzicker, Nice 1974 (1–16) | real, but reused |
| 2 | Plan from structure | Botvinnik–Capablanca, AVRO 1938 + French Advance (composed Q) | **high / real** |
| 3 | Improve worst piece | KID Classical theory line + composed outpost | theory + composed |
| 4 | Prophylaxis | Berlin queen-trade line + Closed Ruy maneuver (theory) | high (theory, not one game) |
| 5 | Two weaknesses | Karpov–Unzicker, Nice 1974 (**reused**) + composed rook ending | real, but reused |
| 6 | Timing the break | Composed "Petrosian" + composed "Tal" + composed KID | **all composed** |
| 7 | Patience & waiting | Composed teaching positions | composed |
| 8 | Space & restriction | Karpov–Unzicker, Nice 1974 (**reused**) + composed outpost | real, but reused |

## Also worth a glance (pedagogy, not correctness)
- Do the `explain`/`modelAnswer` strings actually *name the mistake* well, or do
  some just restate the answer? (Spot-checked M1/M3 read well; you'll judge the rest.)
- Does M1 land the motivational reframe — the one thing you're building this for?
- Are the `choose_move` answers the *best* move, not merely *a legal* move?
  (Legality is proven; "best" is judgment.)

Everything here is data-driven JSON in `packages/core/src/lessons/closed-positions.json`
— edits need no code change, and the legality test re-runs on any change.
