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

## Error observability (from the coach "request failed" post-mortem, 2026-07-14)
The AI coach silently failed for an entire session because (a) no Rust-side
logging exists anywhere (no tauri-plugin-log, no eprintln), and (b) the
calibration UI collapses every error into "request failed" via substring
matching (components/calibration-tab.tsx RevealCard). The real error —
`invalid args: missing field to_move` — was sitting in React state, unreadable.
- Register tauri-plugin-log (or at minimum eprintln on command errors) so
  installed-app failures leave a trace in Console.app.
- Surface the raw error string in the coach hint (e.g. title/tooltip) instead
  of a two-bucket substring match.
- Also observed once in the live smoke test: the coach note contained leaked
  tool-call markup (`</antml...><parameter name="note">` prefix) under strict
  tool mode — watch for it; add a sanitizer in parse_response if it recurs.

## Ideas — See spec:900
Play vs engine (advanced), full-game analysis, multi-engine, opening repertoire, Lichess/Chess.com import, themes, FEN editor, engine tournament, tablebases, cloud sync, move sounds.
