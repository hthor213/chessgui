# 100: Best Move Arrows

**Status:** draft

## Goal
Draw arrows on the board showing the engine's best move(s), like Lichess's blue arrows. Chessground supports this via its `drawable` API.

## Approach
- Use top PV line's first move from `useEngine` state
- Convert UCI move to from/to squares
- Pass as `drawable.autoShapes` to Chessground
- Toggle on/off via UI button or keyboard shortcut

## Done When
- [ ] Blue arrow drawn for engine's #1 best move
- [ ] Arrow updates in real-time as engine analyzes
- [ ] Arrow clears when analysis is paused
- [ ] Toggle via UI control
