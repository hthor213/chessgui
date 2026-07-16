# 223: Mobile Client (iOS/Android)

**Status:** draft
**Depends on:** 220 (shared-core monorepo — packages/core + packages/ui are the
prerequisite for ANY new shell), 221 (web client — the v1 mobile answer builds on it),
217 (arena backend serves the moves)
**Feeds:** 000 (platform stance: web, mobile, PC first-class alongside macOS)
**Sequencing:** LAST of the platform wave (220 → 221 → 222 → 223). Do not start
until the web client is live at https://www.spliffdonk.com/chess — mobile v1 is
that deployment, made pocket-sized.

## What

A phone-usable chess client: play the persona roster (spec:217), review games, run
the board one-handed on a 6-inch screen. Same board, same piece graphics, same theme
as every other client — the single-source-of-truth rule (spec:220) means a piece-set
change in `packages/ui` shows up on the phone with zero mobile-specific work.

## Why

Dad's arena habit (spec:217) shouldn't require sitting at a computer, and the data
flywheel grows with every game he can play from the couch. Mobile is also the
cheapest platform to add *if* we resist building a fifth codebase: the portability
work is already paid for by spec:220/221.

## The v1 decision: PWA of the web client, not Tauri 2 mobile

Two honest candidates, evaluated 2026-07-16:

**Tauri 2 mobile** (iOS/Android shells over the shared core, same pattern as
`apps/desktop`):
- Pro: one shell family for all native targets; Rust side could eventually run a
  real engine process on Android.
- Con (decisive, three-fold):
  1. **App Store friction.** iOS distribution means an Apple developer account,
     signing, provisioning, and review — for an invite-only family app. Worse:
     this project is GPL-3.0 (Chessground), and GPL-on-the-App-Store is a known
     legal conflict (FSF position; VLC's removal is the precedent). Sideload/
     TestFlight workarounds exist but add recurring re-provisioning chores.
  2. **No engine win at v1.** Tauri mobile shells render the same WebView; iOS
     forbids spawning subprocesses, so the desktop UCI-over-stdin path
     (`hooks/use-engine.ts`) doesn't port. A native mobile engine means net-new
     Rust (linked-in Stockfish) — real work for zero v1 benefit when the arena
     server already plays the moves.
  3. **It's a fourth and fifth build target** (Xcode + Android toolchains) for a
     one-person project, before the second (web) has shipped.

**PWA of the web client (spec:221)** — RECOMMENDED for v1:
- The web client is already deployed, auth'd (Google + allowlist), and
  engine-backed (arena at 127.0.0.1:8017 behind Caddy). Mobile v1 = manifest +
  icons + service worker + touch/layout work in `packages/ui`, all of which the
  web client benefits from too.
- Zero store friction: "Add to Home Screen" on both platforms; updates ship by
  deploying to the homeserver, no review cycle.
- Trade-off accepted and recorded: no local engine (see Engine below), no push
  notifications (explicitly a NON-goal per spec:217 — no nagging), iOS PWA storage
  is evictable (fine — the arena DB is canonical, spec:217; the phone caches,
  never owns).

Tauri 2 mobile is **deferred, not rejected**: it becomes worth revisiting only if
(a) on-device engine analysis becomes a required mobile feature, or (b) Android
sideload distribution of a native shell buys something the PWA can't. Record the
revisit trigger here rather than keeping a zombie workstream open.

## Engine on mobile

- **v1: remote only.** Persona moves come from the arena API
  (`lib/arena-api.ts` — pure fetch + JWT, already portable). Request/response fits
  play; the phone fields no persona itself, so the spec:216 calibration burden
  stays on the SERVER's machine profile (already required by spec:217 Tier 0).
  Strength labels shown on mobile are the server's labels.
- **Later: WASM local analysis** behind the `EngineProvider` interface (spec:220).
  Costs to weigh when the time comes: SharedArrayBuffer needs the COOP/COEP headers
  the spec:221 static container already sets (versioned in the repo, not in the
  Caddyfile); multi-threaded WASM Stockfish is a memory and battery
  hog on phones; and the moment a phone runs its own engine it inherits spec:216's
  per-machine calibration rule ("any surface that fields a persona…", spec:217).
  None of that blocks v1.

## Touch-first board

All of this lands in `packages/ui` (shared Board component), gated by pointer type
— not a mobile fork:

- **Tap-tap as primary, drag as secondary.** Chessground supports both natively
  (`selectable` + `draggable`); enable both, tune drag for touch (larger
  `draggable.distance`, ghost piece at finger offset so the thumb doesn't hide the
  piece).
- **Scroll/zoom containment**: `touch-action: none` on the board element, viewport
  meta with `user-scalable=no` on the shell page, suppress pull-to-refresh —
  a drag must never scroll the page.
- **Promotion UI**: the desktop `promotion-dialog.tsx` overlay is too small for
  thumbs. Mobile gets a bottom-sheet picker with 4 large targets (Q/R/B/N), plus an
  "always queen" setting for blitz-style play. Same component, responsive variant.
- **Move confirmation** (setting, default off): optional tap-to-confirm for
  fat-finger protection in slow games — dad plays classical paces (spec:216 UI).
- Premoves: deferred. Arena play is turn-based with ~2-10s persona latency
  (spec:217 latency budget); premove adds complexity for no felt gain at v1.

## Small-screen layout

The desktop three-column grid (`app/page.tsx`) becomes a single-column,
portrait-first stack:

- **Board full-width**, `min(100vw, 100dvh − chrome)` so it never overflows; safe
  area insets respected (notch, home indicator).
- **Eval bar** rotates to a thin horizontal strip above/below the board (or stays
  hidden during arena play — the arena deliberately doesn't show live eval to the
  human player anyway).
- **Move list + analysis + chat/feedback** collapse into a swipeable bottom sheet
  or tab strip under the board; the spec:214/217 realism-feedback affordance ("I
  would never play this…") must survive the collapse — it's promise #2 to dad.
- **Lobby** (roster with avatars per spec:218) reflows to a vertical card list —
  it's the app's front door on mobile.
- Landscape: board left, panel right — nice-to-have, not v1-blocking.
- Explicitly OUT on mobile: tournament tab (the most Tauri-entangled surface,
  desktop-only per the portability audit), database import (CBH is desktop-only by
  design), calibration lab.

## Offline story (honest version)

v1 is **online-mostly** and says so:

- Service worker caches the app shell + board assets → instant loads, and the app
  opens (rather than a browser error page) with no signal.
- Play requires the server: personas run server-side and every move persists to the
  arena DB as it happens (spec:217 disconnect/resume). A dropped connection
  mid-game resumes cleanly — that's the offline feature that actually matters.
- Offline-viewable: last-fetched game history and the board sandbox (local moves,
  chessops is pure client code). No offline persona play, no offline analysis,
  until WASM lands.
- Storage: the `KVStore` interface from spec:220 (not raw localStorage) so iOS
  eviction loses only cache, never truth.

## In v1 / deferred

**IN v1:** installable PWA (manifest, icons, service worker), Google-auth arena
play against the full roster, touch board (tap-tap + drag, bottom-sheet promotion),
portrait single-column layout, realism-feedback input, game history + resume,
theme/pieces inherited from `packages/ui` unchanged.

**Deferred:** Tauri native shells (revisit triggers above), WASM local engine +
streaming analysis, push notifications (non-goal per spec:217), tournament runner,
database/puzzles/training tabs, landscape polish, premoves.

## Non-goals

- A separate mobile codebase or mobile-specific board fork. If a layout needs a
  mobile-only component variant, it lives in `packages/ui` next to the desktop one.
- App Store presence. Invite-only family software distributes via a URL.
- Engagement mechanics on the phone — no badges, no notification nudges (spec:217).

## Done-When

- [x] PWA manifest + icons + service worker added to the web client
      (`apps/web`); Lighthouse reports installable (code-verified 2026-07-16:
      manifest.webmanifest, generated icons, sw.js offline shell, production-only
      registration in pwa.tsx; static export + check-no-tauri pass — Lighthouse
      run itself still pending)
- [ ] Board is touch-correct: tap-tap and drag both work; a drag never scrolls
      or zooms the page (`touch-action` containment verified in mobile Safari
      emulation)
- [ ] Bottom-sheet promotion picker shipped; "always queen" setting works
- [ ] Portrait single-column layout: board full-width, move list/analysis in
      bottom sheet, safe-area insets applied, no horizontal scroll at 375px width
- [ ] Lobby reflows to vertical roster cards on narrow viewports
- [ ] Realism-feedback input reachable during a mobile game (promise #2, spec:217)
- [ ] Offline shell: airplane-mode open shows the app + cached history, not a
      browser error; reconnect resumes an in-flight arena game
- [ ] `KVStore` used for all mobile-visible persistence (no raw localStorage in
      shared packages)
- [ ] USER-BLOCKED: install to home screen and play one full arena game on a real
      iPhone (Safari)
- [ ] USER-BLOCKED: same on a real Android phone (Chrome)
- [ ] USER-BLOCKED: dad plays one arena game from his phone; latency + touch UX
      judged acceptable by him, not by us
- [ ] Revisit-trigger note kept current: if on-device analysis becomes a mobile
      requirement, reopen the Tauri-2-mobile evaluation in this spec
