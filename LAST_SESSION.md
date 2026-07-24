# Last Session

**Date:** 2026-07-24 (overnight autonomous loop — spec 227 Concept Lessons)
**Focus:** Built spec **227 "Concept Lessons"** end-to-end, D1→D6, as a self-paced
`/loop` where each deliverable was one `/workflows` run (scout → implement +
self-test → **adversarial verify**), gated in the main loop (independent
tsc/tests/verify), and committed to `main` per deliverable. All six shipped.

## What shipped (all committed, `e54bfe7` → `4cda71e`)

1. **D1 — schema + loader + grader** `e54bfe7`. `packages/core/src/lessons.ts`:
   Course/Module/Illustration/FocusNote/Question types; `loadCourse()` throws on
   any content-bar violation (every `explain`/`modelAnswer`, every `source`) —
   never a half-load; `gradeChooseMove()` is 960-safe via chessops
   `parseSan→makeSan`. Fixture course + 18 tests.
2. **D2 — question engine (pure)** `8c7bfa8`. `lesson-grade.ts` (typed graders +
   `scoreModule`, free_text excluded from the auto denominator) and
   `lesson-progress.ts` (append-only dated log, `resumePoint`, timestamps
   injected). 20 tests. FS deferred to the StorageProvider.
3. **D3 — lesson player UI** `f252e88`. Lessons = a **Learn sub-tab taking no
   props** (fair-play decoupled by construction). Three-beat player over a pure,
   unit-tested reducer `lesson-player.ts` (14 tests incl. the wrong-move →
   bespoke-`ask.explain` path). Interleaved predict-the-move works. **/verify
   caught a spoiler** (model-game strip showed the answer during the pause) —
   fixed + re-verified.
4. **D4 — first course "Playing Closed & Locked Positions"** `3a91027`. All 8
   modules authored, registered as the primary course, 20-test whole-course
   legality gate (every PGN legal, every accept SAN legal). **Content needs your
   chess judgment — see `specs/227-D4-review.md`** (`39a4ffa`).
5. **D5 — fair-play guard** `bf1c12f`. Transitive import-graph BFS: hard-bans
   use-chess-game/use-engine/engine-session as UNREACHABLE; model-gates the two
   PURE edges (a predicate + a NAG constant) reached via `game-tree.ts`. Proven
   to bite (injected forbidden imports → RED).
6. **D6 — optional assist-graded free-text** `4cda71e`. Off by default
   (`lessonAssistGrade:false`), gated on `hasNativeEngine`; Rust `grade_free_text`
   mirrors `coach.rs`; pure prompt/parse in `lesson-assist.ts`. Self-grade path
   untouched; still passes D5. **Live LLM round-trip needs your ANTHROPIC_API_KEY
   — not autonomously verified.**

Tests **1494** (was 1405) across 98 files. `pnpm tsc` clean, Rust compiles,
`pnpm build` clean. Debug `.app` rebuilt + installed to /Applications.

## Needs your eyeball (user-blocked — the loop cannot verify these)
1. **`specs/227-D4-review.md`** — the content-judgment list. Headlines:
   M1/M5/M8 all reuse **Karpov–Unzicker 1974**; the **M6 Petrosian-vs-Tal
   centrepiece is composed, not the real games**; M3/M6/M7 lean composed. M2
   (Botvinnik–Capablanca 1938) is the verified-real template. All content is
   data-driven JSON — edits need no code change; the legality test re-runs.
2. **Does M1 land the motivational reframe** — the whole reason you asked for this.
3. **D6 live path** — set `lessonAssistGrade` on with an ANTHROPIC_API_KEY and
   confirm the free-text grade + feedback reads well.
4. **The flow feels like a course, not a quiz** — open Learn → Lessons and walk it.

## Notes / drift
- `aidev check`: 0 NEW failures from this work. Pre-existing noise: spec 202 has
  two malformed Done-When lines (`node.eval` parsed as a shell command, rc=127) —
  worth a one-line fix in 202 sometime. Drift = the usual age-warnings on
  000/001/011.
- Uncommitted `data/personas/*` tuning artifacts were present at session start and
  left untouched (unrelated to 227).
