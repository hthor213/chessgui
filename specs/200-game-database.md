# 200: Game Database

**Status:** draft

## Goal
SQLite-backed game database for importing, storing, and searching chess game collections. This is the SCID-level feature that differentiates from web-only tools.

## Approach
- SQLite via Tauri (Rust side) for storage
- Import from PGN files (batch), Lichess API, Chess.com API
- Search by player, opening (ECO code), date range, result
- Position search: find all games reaching a given position

## Done When
- [ ] Import PGN file(s) into database
- [ ] List games with headers (players, event, result, date)
- [ ] Search/filter by player name
- [ ] Search/filter by ECO code or opening name
- [ ] Click a game to load it into the board for analysis
