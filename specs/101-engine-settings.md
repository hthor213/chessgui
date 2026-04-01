# 101: Engine Settings Panel

**Status:** draft

## Goal
Expose Stockfish configuration (Threads, Hash, MultiPV) in a settings UI so users can tune analysis performance.

## Approach
- Settings modal or drawer accessible from AnalysisPanel
- Send `setoption` UCI commands when values change
- Persist settings to localStorage
- Apply on engine start

## Done When
- [ ] UI to configure Threads, Hash size, and MultiPV (1-5)
- [ ] Changes sent to engine via UCI setoption
- [ ] Settings persist across app restarts
- [ ] Changing MultiPV immediately updates the number of PV lines shown
