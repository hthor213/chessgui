# Last Session

**Date:** 2026-07-24 → 25 (overnight autonomous loop, then an interactive
fair-play design pass + keyboard polish)
**Focus:** Built spec **227 "Concept Lessons"** end-to-end (D1→D6) as a self-paced
`/loop`, each deliverable one `/workflows` run (scout → implement + self-test →
adversarial verify), gated in the main loop and committed to `main`. Then, with
the user: resolved the fair-play stance, shipped the in-app **About Fair Play**
page, and rebound the notebook navigation keys.

## What shipped

### Spec 227 — Concept Lessons (`e54bfe7` → `b559634`) — status: built
- **D1** `e54bfe7` — schema + `loadCourse` (content-bar enforced) + 960-safe
  `gradeChooseMove` + fixture. 18 tests.
- **D2** `8c7bfa8` — pure question engine: graders, `scoreModule` (free_text
  excluded from the auto denominator), append-only `lesson-progress`. 20 tests.
- **D3** `f252e88` — lesson player UI, a Learn sub-tab taking no props (fair-play
  decoupled by construction). Three beats over a pure reducer `lesson-player.ts`
  (14 tests incl. wrong-move → bespoke `ask.explain`). /verify caught + fixed a
  spoiler (model-game strip showed the answer during the pause).
- **D4** `3a91027` — course "Playing Closed & Locked Positions", 8 modules,
  20-test legality gate. **Content needs review → `specs/227-D4-review.md`
  (`39a4ffa`).**
- **D5** `bf1c12f` — fair-play guard as a transitive import-graph BFS; hard-bans
  use-chess-game/use-engine/engine-session as UNREACHABLE, model-gates the two
  pure edges. Proven to bite.
- **D6** `4cda71e` — optional assist-graded free-text, off by default, reuses
  `coach.rs` via a new `grade_free_text` Rust command. Live round-trip needs the
  user's ANTHROPIC_API_KEY.
- **Fair-play stance resolved** (`c774524`, `fffdc14`): the boundary is
  *derivation, not resemblance*; engine eval IS allowed in training; the one
  guardrail is an **exact-match block at manual position setup** vs active games
  (not built — a constraint for when position-setup-into-training exists).
- **About Fair Play page** `b559634` — user's approved copy, dialog from the
  Lessons header, static/fair-play-clean, verified headless.

### Spec 226 — Notebook (`f874020`)
- Rebound notebook nav to the keyboard: **↓ = current** (`goToLive`), **↑ =
  re-walk** (`handleRewalk`); ←/→ = back/forward, 1-7 = rating. Spec-001 sibling
  variation cycling moved to **Shift+↑ / Shift+↓**. tsc-clean + smoke-tested.

Tests **1494** (was 1405), tsc clean, Rust compiles, `pnpm build` clean.

## Next session should start with
1. **`specs/227-D4-review.md`** — the highest-value item; needs the user's chess
   judgment. Headlines: M1/M5/M8 all reuse Karpov–Unzicker 1974; the M6
   Petrosian-vs-Tal centrepiece is composed, not the real games; M3/M6/M7 lean
   composed. M2 (Botvinnik–Capablanca 1938) is the verified-real template. All
   content is data-driven JSON — swaps need no code change; legality test re-runs.
2. **Confirm the ↓/↑ keyboard bindings in a real live game** (user-blocked in
   spec 226) — built + tsc-clean but not behaviorally confirmed with a walked line.
3. **D6 live path** — set `lessonAssistGrade` on with an ANTHROPIC_API_KEY and
   sanity-check the free-text grade + feedback quality.
4. **Refresh the installed app** — `scripts/install-app.sh --debug` (the /Applications
   build predates the About Fair Play page and the keyboard rebind).

## Open questions / notes
- Shift+↑/↓ for variation cycling was preserved rather than dropped; if the user
  never uses it in the notebook flow, those chords can be freed.
- `aidev check`: pre-existing noise in spec 202 (two malformed Done-When lines,
  `node.eval` parsed as a shell command, rc=127) — worth a one-line fix sometime.
  Not from this work.
- Uncommitted `data/personas/*` tuning artifacts predate this session; untouched.
- New: `feedback_fairplay_derivation` memory records the resolved stance.
