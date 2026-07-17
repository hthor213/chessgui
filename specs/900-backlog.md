# 900: Backlog

Ideas and features not yet committed to a spec. Prioritize based on user need.

## High Priority (likely next after V2)
- **Play vs Engine (advanced)** — Configurable strength (Elo limit), time controls, post-game analysis review — superseded: time-based strength/pacing shipped in spec:216 (hooks/use-engine.ts EngineMode 'play', lib/time-elo.ts); real clocks tracked as Tier 1 in spec:217; post-game review tracked in spec:212 [2026-07-15]
- ~~**Full-game analysis** — Automated blunder check across all moves, classify inaccuracies/mistakes/blunders~~ → now tracked in spec:212 (draft, v0 — scoped to *tournament-game* analysis over neutral-evaluator per-ply evals; general single-game blunder-check not yet verified shipped) [2026-07-15]
- ~~**Multi-engine comparison** — Run two engines side-by-side, compare evaluations~~ → SHIPPED (verified 2026-07-16: `packages/ui/src/engine-compare-panel.tsx` + `packages/core/src/engine-session.ts`, wired into `apps/desktop/app/page.tsx`, present in both desktop and web bundles). Spec home: no dedicated numbered spec — lives here in 900 and in spec:011 ("Later / uncaptured requirements", where the dangling spec:902 reference to a broader multi-engine side-by-side concept was fixed 2026-07-16; that broader item is still an open spec-home decision, distinct from this shipped compare-panel feature)

## Medium Priority
- ~~**Opening repertoire builder** — User builds repertoire lines, spaced repetition drilling~~ → SHIPPED (code-verified 2026-07-16): repertoire extracted from the user's own PGN (lib/repertoire.ts, cards = positions reached ≥2× in first 10 moves, transpositions merged), spaced-repetition drills with 1/3/7/16/35/90d ladder (lib/repertoire-results.ts), drill UI in packages/ui/src/repertoire-tab.tsx; user eyeball pending
- **Lichess/Chess.com API import** — Import games by username from online platforms
- **Board/piece theme picker** — Multiple board colors and piece sets
  - [ ] Board/piece theme picker (audit 2026-07-16): a one-file change once
        spec:220's shared `packages/ui` seam lands, so it isn't duplicated
        per platform shell. (000:35; this entry)
- ~~**FEN input / position editor** — Set up arbitrary positions for analysis~~ → SHIPPED, spec:014 (position editor + FEN import; all 15 boxes verified in code 2026-07-15)
- **Repertoire coverage tracking** (audit 2026-07-16)
  - [ ] Repertoire "define your own lines" + coverage tracking against them —
        the shipped repertoire feature (line 11 above) is extraction +
        spaced-repetition drills only; user-authored line definitions and
        coverage-vs-defined-lines tracking remain unbuilt. (000:74)

## Low Priority / Future
- ~~**Engine tournament** — Round-robin or gauntlet format, live standings, PGN export~~ → now specced in spec:210 (core engine-vs-engine runner + probability map shipped, Phases 1–8; round-robin/gauntlet + Elo estimation is spec:210 Phase 6, post-MVP, not yet done) [2026-07-15]
- ~~**Endgame tablebase integration** — Query Syzygy tablebases for perfect endgame play~~ → SHIPPED (code-verified 2026-07-16): `tablebase_probe` Tauri command (match_runner.rs, rich WDL/DTZ/DTM + ranked moves, ≤7-men gate, FEN-keyed cache, refuses spec:219 locked active-game contexts) surfaced in the analysis panel via packages/ui/src/tablebase-section.tsx + use-tablebase.ts; user eyeball pending [2026-07-16]
- **Cloud sync** — Sync games and repertoires across devices
- **Move sounds** — Audio feedback on moves (piece placement, capture, check)

## Requirements audit 2026-07-16 — no-home / NEW-spec bucket

Items from the 2026-07-16 requirements audit that belong to no existing spec.
Parked here per audit rule (no new spec files created that night); each entry
names its eventual home decision.

- [ ] **Rust-side error logging** — `tauri-plugin-log` or `eprintln` on command
      errors so failures leave a Console.app trace (cross-cutting; coach
      post-mortem 2026-07-14). Small spec or stays here.
- [ ] **Native macOS menu bar** — real app menus with keyboard shortcuts
      (000:120 Principles #1 "native feel").
- [ ] **Lichess CC0 tactic puzzle decks** — standard find-the-tactic decks from
      the lichess CC0 dump; named "later" in 000:100 and 211:83, owned nowhere.
- [ ] **Unified spaced-rep schedule store decision** — 211:70-72 references a
      "Phase 6 spec, to be written" that never was; repertoire drills shipped
      their own ladder independently (lib/repertoire-results.ts). Decide: write
      the unifying spec or record the divergence as permanent.
- [ ] **Data licensing & corpus lifecycle spec** — hard legal constraints
      currently only in memory/archive: Lumbra personal-use / NEVER
      redistribute; TWIC/Mega personal-use; OTB archive PERMANENT, never
      pruned; mining corpus prunable to 20-30GB only after artifact
      extraction; reference pack = elo≥2000 slice; band-cap tuning +
      homeserver corpus deploy pending. One spec (or a spec:200 section).
- [ ] **Lichess Board API online layer** (parity Phase 7) — spec when reached;
      note the tension with 000's non-goal "online play against strangers"
      (Board API own-games play is the sanctioned path; chess.com stays
      forbidden).
- [ ] **Phase 5 novelty detection — user call needed** — conflicts with 000's
      rejection of prep dossiers; needs an explicit user decision whether
      Phase 5 of the parity roadmap stands.
- [ ] **AI-feature model policy** — record in a spec: accuracy over cost,
      Opus-tier + parallel-read verification as default, never pre-optimize
      (feedback_model_choice.md; currently memory-only).
- [ ] **Thinking mode is spec-orphaned** — shipped 2026-07-11 (Opus consensus
      screenshot→FEN, Chess960 castling rule, regression script) with no spec
      home; write the shipped entry (here or a small spec).
- [ ] **BACKLOG.md reconciliation** — features themselves are covered by
      specs 013/210; strike the stale "PGN export pending" line and the
      past-competitions entry in BACKLOG.md. (210:259 in-memory prose already
      fixed 2026-07-16.)
- [ ] **GM YouTube transcript mining** — optional, low priority
      (chessbase-usage-research.md Gaps); parked here, may be dropped.
- [ ] Session-ops (tracked so they aren't lost, not features): verify wip
      71db879 stream-by-stream (213/214 carry 07-16 code-verified notes, the
      verification itself is untracked — tick with evidence, rebuild+install);
      run the /librarian passes in LIBRARIAN_FLAGS.md (3 cosmetic fixes +
      200-band gap user decision; supersede/archive/status flips from the
      audit are partially done as of 2026-07-16 — 001-project-setup archived,
      011-stockfish-uci + 012 superseded, 010 closed into 016).

## Pending user walkthrough (2026-07-17)

Cross-spec tick-sweep leftovers: the code half of each item verified green,
but the claim itself is user-visible (or needs the user's own auth/eyes), so
per feedback_testing.md the box stays open until the user confirms.

- **220:248** — `pnpm tauri dev` and `scripts/install-app.sh --debug` green on
  the workspace layout. pnpm-workspace.yaml is in place (partial note on the
  item); the two live runs need the user's machine + eyes on the running app.
- **222 pc-build workflow push + first tag build** — the workflow IS committed
  on main (968bcb7; tag-triggered tauri-action matrix verified in-file), but
  the hthor213 gh token still lacks the `workflow` scope (checked 2026-07-17
  via `gh auth status`), so pushing `.github/workflows/pc-build.yml` will be
  rejected until the user runs `gh auth refresh -s workflow` (interactive).
  After the push, tag a `v*` build and confirm release artifacts appear.
