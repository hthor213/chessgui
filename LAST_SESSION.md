# Last Session

**Date:** 2026-07-22 → 24 (live UI iteration on the Notebook, spec 226)
**Focus:** Six features built end-to-end WITH the user on real fair-play games,
each rebuilt+installed and eyeballed before the next. Then a checkpoint to hand
off to an overnight loop building the **middlegame training program** (new spec).

## What shipped (all committed, `ff85f9a` → `eac3cd3`)

1. **1…7 pad = the reader's own side.** The assessment pad now reads 7 = "I'm
   winning", 1 = "I'm losing", 4 = equal, whichever colour — the digits are a
   score, and a score means high-is-good-for-me. Stored NAG stays White-positive
   (`assessmentKeys(myColor)`); the backup/ranking/diagnosis/PGN are untouched.
   The user, as Black, had been pressing 5 for "slightly worse" because 5/7 felt
   decent — number fighting feeling. Fixed.

2. **Re-walk retraces the LAST line walked.** It stepped `children[0]` (the
   OLDEST branch) at every node; now it follows the path to the remembered
   excursion tip (`stepToward` + tip tracking in page.tsx), and stops there.
   Cold-start fallback is the freshest child, not the oldest.

3. **Eval-Map** (`◎` button, replaced `★ Best`). A board overlay: a coloured disc
   on the destination of each of the node's OWN explored candidates —
   red→yellow→green by the reader-side backed value, gray when unjudged — and
   NOTHING on a legal square never tried (coverage, on the board; the fair-play
   axiom drawn). Two moves to one square → two discs with piece letters. Native
   move-dots suppressed while on, but a move can still be played on top (existing
   line or new variation). Never draws over a `previewStep`. DOM overlay
   (`packages/ui/src/eval-map.tsx`, `packages/core/src/eval-map.ts`).

4. **The "covered" seal.** A backed-up value reads **"maybe better"** until the
   move is either directly assessed OR sealed (✓ "I've covered enough of his
   replies here"). The app never calls it firm on its own — it cannot know the
   reply list is complete, so completeness is the player's declaration (the
   fair-play axiom, again). Per-move (v1; recursive whole-line is a later
   option). Stored `node.sealed`, PGN `[%seal]`, on the purity guard.
   `NodeValue.firm`; `valueWords` prefixes "maybe".

5. **Candidates folder tree, live-rooted.** The Candidates tab is now a
   collapsible tree rooted at the LIVE position — the whole forward exploration,
   which STAYS as the cursor walks into it (clicking a move used to re-root and
   lose the tree). Cursor highlighted, ancestors auto-expand, ▸ folds/unfolds.
   Candidates is the default tab; the candidate list no longer duplicates onto
   Moves; Moves is the plain record for looking back.

6. **Build stamp** (`next.config.mjs`): footer now `<hash>-dirty · <timestamp>`
   so a rebuild is always visibly distinct (the user caught that same-day builds
   with uncommitted code looked identical). `-dirty` = tracked changes vs HEAD.

Tests 1405 (was 1389). Type-clean. `aidev check`: 0 automatable failures; the
only drift is age-warnings on untouched specs 000/001/011.

## Next session — the middlegame training program (NEW SPEC, overnight loop)

The user's live game is a **locked, boring middlegame**; they're demotivated,
"can only find moves that stall, hoping for a mistake." They want a **training
program for these positions** — GENERIC principles only (allowed under
fair-play; never the live game). Corporate-training shape: **principle → show it
→ practice it**, with **multiple-choice AND free-text** questions.

**North star:** ChessBase (but better/more modern UI). A `researcher` agent was
dispatched at checkpoint to pull ChessBase's training model — the "training
question" mechanic, Fritztrainer course structure, and the canonical games/
players for closed middlegames (Capablanca/Petrosian/Karpov/Nimzowitsch). Read
its findings (or re-run) before finalising the spec's content model.

**Deliverable of THIS handoff:** a new spec (likely `227-*` or folded into the
existing `215-training-program.md` — CHECK 215 first) with **clear, independently
buildable, Done-When-gated deliverables** so an overnight loop can build one
module at a time, verify, commit, repeat. The spec — not the implementation — is
the immediate task; write it, commit it, then the loop executes it.

## Open questions for the spec (resolve with the user or sensibly default)
- New spec number vs. extending 215? (215 already exists — read it.)
- Where do the illustrative games come from? (public-domain classics vs. the
  spec 200 database) and how are lessons authored/stored (data model).
- How does the training tab relate to fair-play lockout (it must NOT touch the
  live game; generic study only).
- Scoring/spaced-repetition for the practice questions.
