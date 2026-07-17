# Backlog

This file is a thin index. The working detail — status, verification evidence,
and open items — lives in the numbered specs and in `specs/900-backlog.md`
(the parking lot for ideas with no spec home yet). Reconciled against both
2026-07-16 per the requirements-audit box in `specs/900-backlog.md:66-69`.

## Foundation & Migration
- Board & gameplay → spec:001 (status: active, mostly done — UX design pass remaining)
- UX/UI migration (Next.js + Tailwind + shadcn) → spec:002 (status: done)
- Engine analysis → spec:011 (status: active, partially done)
- PGN import/export → spec:013 (status: implemented — full round-trip import+export with variations/annotations; native Tauri file dialog deferred)

## Game Tree & V2
- Game Tree data model → spec:016 (status: implemented (core); PGN variation import/export deferred to 013)
- Game database + opening explorer → spec:200 (status: draft)
- Annotations + eval graph → spec:202 (status: draft)

## Engine Tournament
- All follow-up items (past-competitions persistence/browser, curated position
  pool re-run, narrow-range presets, live-in-Tauri verification pass) are
  tracked in spec:210's "Later / uncaptured requirements" section — see
  `specs/210-engine-tournament.md`. Do not duplicate them here.

## Database scalability (post-mortem, 2026-07-17)
Two app-freeze bugs in two days shared one architecture smell: every DB
command funnels through DbManager's single mutex-guarded connection, so any
one slow query freezes the whole UI (launch hang: v4 material backfill inside
Db::open; continue-later hang: search_position ORDER-BY sort of ~1M rows +
stats() COUNT over 38M rows). Both hot paths are fixed, but the blast-radius
problem remains latent:
- **Read-connection pool**: WAL already supports concurrent readers; giving
  read-only commands (list/search/stats/explorer) their own connections would
  bound any future slow query to its own tab instead of the whole app.
- **Text search is the next latent freeze**: list_games player/text filters
  use `LIKE '%…%'` full scans (db.rs comment admits it; needs FTS5 + sync
  triggers at 956k games).
- **Guardrail idea**: debug-assert/log any Tauri command that holds the
  DbManager lock >250ms, so the next unbounded query surfaces in dev instead
  of in a user hang.

## Error observability / Rival mode / other parked ideas
Retired from this file 2026-07-16 — both were exact duplicates of items
already tracked in `specs/900-backlog.md`'s "Requirements audit 2026-07-16 —
no-home / NEW-spec bucket" (Rust-side error logging) and now fully absorbed
into spec:225 (Any-Player Profiles & "Beat X" Training) plus spec:215
(Training Program), which generalize the original "beat dad" rival-mode idea
(explorer filtering, anti-lines, rake decks, spar sessions) to any named
rival. See those specs for current status.

## Ideas — See spec:900
Play vs engine (advanced), full-game analysis, multi-engine, opening
repertoire, Lichess/Chess.com import, themes, FEN editor, engine tournament,
tablebases, cloud sync, move sounds — `specs/900-backlog.md` is the
authoritative, actively-maintained index of these; several are already
shipped there (verified 2026-07-16) even though the short list above still
names them as "ideas."
