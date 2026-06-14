# Backlog

## Current Priority — Foundation & Migration
- ~~Board & gameplay~~ → spec:001 (mostly done)
- UX/UI migration (Next.js + Tailwind + shadcn) → spec:002
- ~~Engine analysis~~ → spec:011 (partially done, engine wiring works)
- ~~PGN import~~ → spec:013 (import works, export pending)

## Next Up — Game Tree & V2
- Game Tree data model → spec:016 (foundational, blocks V2)
- Game database + opening explorer → spec:200
- Annotations + eval graph → spec:202

## Engine Tournament (spec:210) — follow-ups
- **Past-competitions selector**: persist each tournament run (config + outcomes + summary) and add a UI picker to browse/reload past results — so you can review a result (and its charts) without re-running. (Right now the report is in-memory only; a chart/analysis fix isn't visible until you run another tournament.)
- Curated position pool: bounded re-run of scripts/curate_positions.py (explorer-validated, denser per-bin to ±1.5). The full run over-scoped and was killed; explorer cache is warmed at data/openings/explorer_cache.json.
- Narrow-range presets (e.g. ±0.6) where engine skill, not the advantage size, decides — more discriminating power per game.

## Ideas — See spec:900
Play vs engine (advanced), full-game analysis, multi-engine, opening repertoire, Lichess/Chess.com import, themes, FEN editor, engine tournament, tablebases, cloud sync, move sounds.
