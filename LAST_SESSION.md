# Last Session

**Date:** 2026-04-09
**Focus:** Cerebellum opening book integration
**Status:** Book replaced, code simplified, type-checks pass. Needs smoke test vs Magnus bot.

## What happened
- **Replaced opening book:** Old 5.8MB generic Polyglot book → Cerebellum Light 3Merge (170MB, 10.9M engine-analyzed positions). All moves calculated by Stockfish with graph-consistent scores.
- **Simplified opening-book.ts:** Removed Lichess Masters API and online/offline fallback. Now Cerebellum-only — instant local lookups, no internet dependency.
- **Research:** Evaluated Cerebellum Light, Perfect 2023, GOI 7, Lichess API, and pure-engine approaches. Cerebellum is the strongest publicly available book.

## Why
- Previous book led to -0.83 disadvantage by move 8 in King's Indian Defense vs Magnus bot on chess.com
- Cerebellum's engine-verified positions should avoid theoretically dubious lines
- Expected ~50 Elo improvement from book quality alone

## Known issues
1. 170MB book loaded into browser memory on first use (fine for Tauri desktop, would be bad for web)
2. Debug logging still present (carried over from prior session)
3. Threads still hardcoded to 11
4. `lichess-bot/` directory exists — unrelated side project, untracked

## What's next
### IMMEDIATE: Smoke test opening book
1. Play vs chess.com Magnus bot — verify Cerebellum picks better opening lines
2. Check console for `[opening-book] Cerebellum book move:` logs
3. Compare opening evaluation to previous -0.83 KID result

### AFTER SMOKE TEST
- spec:016 — Game Tree (variations, annotations)
- Remove debug logging
- V1 features (100-102): best move arrows, engine settings

## Dev commands
```bash
source "$HOME/.cargo/env" && pnpm tauri dev
pnpm test            # vitest
pnpm tsc --noEmit    # Type check
```

## Key files changed this session
```
lib/opening-book.ts         # Simplified to Cerebellum-only (was Lichess API + Polyglot fallback)
public/book.bin             # Replaced with Cerebellum Light 3Merge (170MB)
```

## Files changed prior session (uncommitted)
```
hooks/use-engine.ts         # Full move history, MultiPV 1 in play, isready sync
app/page.tsx                # Pass uciMoves/startFen/currentMoveIndex to useEngine
package.json / pnpm-lock    # cm-polyglot dependency
```
