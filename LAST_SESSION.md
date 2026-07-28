# Last Session

**Date:** 2026-07-26 → 27
**Focus:** Recovering this project from the machine rebuild (the laptop was
DFU-wiped on 2026-07-25 after a macOS infostealer), then specifying **228
Narrow Lines** from the game that was in flight when the wipe happened.

Read `~/Documents/GitHub/MACHINE-REBUILD.md` before trusting any environment
claim in this repo. Its headline applies here literally: *"Source code was
recovered from a backup. Nothing else was."*

## What shipped

### Environment recovery (`add3e78`, pushed)
- **`~/.cargo/env` no longer exists.** Rust now comes from **Homebrew's rustup**
  (`/opt/homebrew/opt/rustup/bin/cargo`), which puts cargo on PATH and ships no
  env file. `scripts/install-app.sh` sourced it unconditionally under `set -e`
  and died on line 10 in under a second. Fixed to source-if-present + fail loudly
  if cargo is still missing; `CLAUDE.md`'s three build commands corrected.
- `pnpm-workspace.yaml`: resolved pnpm 11's literal `allowBuilds: sharp: set
  this to true or false` placeholder to **false** — sharp is a transitive
  optional dep of next@16 used only by the image-optimization server, and both
  shells are `output: 'export'` with `images.unoptimized`.
- **Stockfish was not installed** post-wipe. `brew install stockfish` → 18 at
  `/opt/homebrew/bin/stockfish`; verified over UCI (depth 20, `bestmove e2e4`).
- ChessGUI 0.3.0 debug built, installed to `/Applications`, **added to the Dock**,
  running.

### Data loss — diagnosed, partially recovered
- `~/Library/Application Support/com.hjalti.chessgui/` was **never restored**.
  The 96 GB emergency backup on homeserver contains Desktop/Documents/github/
  dotfiles/keychains but **no `~/Library` at all**; no `games.db` anywhere in it.
  Time Machine's oldest backup is post-rebuild. The local DB and the in-progress
  game were gone before this session started.
- **Corpus recovered:** `homeserver:~/chess/games.db` (3.45 GB, **955,819 games**,
  schema v2) copied down and swapped in. The app migrated **v2 → v5** on first
  open; `quick_check: ok`. Note `db_counts` is empty — the v5 cache table the
  migration created but does not populate.
- **Not recovered:** anything personal that lived only in the old local DB
  (own annotations, tags), and `puzzles` is 0 rows.

### chess.com import — 1,225 games
- `scripts/fetch_chesscom.py hjaltth` → 1,226 games across 38 monthly archives
  (2017/01 → 2026/07), staged at `~/Downloads/hjaltth-chesscom.pgn`.
- Imported **1,225 (1 dup, 0 errors)**. Database **955,819 → 957,044**.
- **The lost live game was recovered from the archive**: chess.com daily
  1000687368, painterdenny (1183) vs hjaltth (1220), **Chess960**, started
  2026.07.17, **drawn by agreement 2026-07-26 00:49 UTC** — it finished the day
  after the wipe. No ongoing daily games remained on the account.
- Import ran through a new **`apps/desktop/src-tauri/examples/import_pgn.rs`**
  (~25 lines over `Db::import_pgn_file`, the same path the Import button uses).
  **Still untracked — keep or delete is an open decision.**

### GitHub identity (post-incident)
- Push 403'd: the active `gh` account was **`hjalti-pid`**, which has
  `push: false` on this repo. Switched the default to **`hthor213`** (admin) and
  ran `gh auth setup-git` so git authenticates via gh's live token.
- **Deleted a stale `github.com` / `hthor213` keychain entry** that existed but
  failed to authenticate — almost certainly a rotated pre-incident credential,
  since the emergency backup carries `misc/Library-Keychains/`.

### Spec 228 — Narrow Lines (`6213aed`)
Written from the recovered game. At move 27 Black had 36 legal moves; **only 2
held** (Bxb5 −0.06, a5 −0.10) and the rest fell off a cliff to −3 and worse.
`27...a6` sits at #15, −4.20. Material was dead level and nothing hung, so the
position gave no outward sign it was decisive. White missed 29.b4! and it went
back to equal — **so the game record shows the moment as unremarkable**.

- Skill specced is **noticing a position is narrow**, not knowing the move.
- Measure is **spread** = best − median legal move (~4.2 here vs ~0.3 quiet),
  chosen because it is direction-agnostic: *narrow to hold* and *narrow to
  avoid* are the same thing, and at the board you don't yet know which you're in.
- Two construction rules that decide whether it works: the deck must be
  **majority quiet** (else step 1 is degenerate and it trains resolution while
  looking like it trains detection), and sharp cards should favour **closed,
  dull** positions — the source failure was vigilance, not calculation (Daily
  game, three days per move, no time pressure).

## Next session should start with

1. **Test spec 228's load-bearing assumption, cheaply, before building anything:**
   is sharpness perceptible at 1200–1800 *without* solving the position? If not,
   the two-step drill collapses into one and the premise fails.
2. **Decide on `examples/import_pgn.rs`** — commit (it is most of spec 225's open
   "own-games import by username" item) or delete.
3. **Fix the engine-failure message.** It currently tells macOS users their
   "pre-2013 CPU without AVX2" may be at fault — spec:222 PC-client copy leaking
   into the macOS path — and never prints the path it actually tried. Real cause
   here was plain ENOENT.
4. `specs/227-D4-review.md` — still open from the previous session, still needs
   the user's chess judgment.
5. Confirm the ↓/↑ notebook keys in a real live game (user-blocked since 226).

## Open questions / notes

- `~/Downloads/hjaltth-chesscom.pgn` (2.4 MB) is a leftover staging file,
  regenerable from the script. Keep as a re-import source, or delete.
- **`MACHINE-REBUILD.md` does not warn about the restored keychain.** It covers
  `.env` files and runtimes, but the dead credential that broke `git push` came
  from the keychain. Worth adding to the incident report on homeserver — it will
  bite the next project identically.
- **D6 lesson-assist still needs a fresh `ANTHROPIC_API_KEY`** — the one on disk
  was in the stolen set. Do not reuse it; do not dig an old value out of git
  history or the backup.
- No new credentials were created this session. One was **deleted** (the stale
  keychain entry above).
- `aidev check` noise in spec 202 (malformed Done-When lines, `node.eval` parsed
  as a shell command, rc=127) is still present and still pre-existing.
- Uncommitted `data/personas/*` tuning artifacts predate this session; untouched.
