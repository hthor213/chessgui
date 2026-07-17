# 220: Multi-Client Architecture & Shared Core

**Status:** draft
**Depends on:** 002 (UI migration — component layer must be settled before it moves),
011 (engine analysis — defines the engine surface being abstracted), 217 (persona
arena — the server backend the web client talks to)
**Feeds:** 221 (web client — ships FIRST), 222 (PC builds of the Tauri shell,
incl. dad's Windows auto-bench per spec:217), 223 (mobile shells)
**Origin:** platform stance in spec:000 + spec:217 ("web, mobile, and Windows/PC
native are first-class citizens alongside macOS") — this spec is the structural
prerequisite for all of them.

## Goal

One codebase, four clients (macOS, web, PC, mobile) — without forking the UI.
The invariant that drives everything: **board, piece graphics, themes, and game
UI have a single source of truth.** Changing a piece set or a board color is ONE
change that every client picks up on its next build. The shape that guarantees
this is a shared-core pnpm-workspace monorepo: portable chess logic and UI live
in `packages/`, and each platform is a thin shell in `apps/` that injects its
platform capabilities through adapter interfaces.

The frontend already half-wants this: a 2026-07 portability audit found exactly
14 files import Tauri directly (2 hooks + 9 lib wrappers + 3 components), and 8
of the 9 lib wrappers already ship `isTauri()` + browser mocks — the app boots
Tauri-free in a browser by design (that's how the spec:217 arena page works).
The job is to formalize that accidental seam into named interfaces and split the
flat layout into packages, **incrementally, with `pnpm tauri dev` green after
every step**. No big-bang.

## Target layout

```
pnpm-workspace.yaml
packages/
  core/          # @chessgui/core — pure TS, zero React, zero platform APIs.
                 # chessops game state, game-tree, PGN/FEN, uci-parser,
                 # win-prob, annotations, eco, time-elo, tournament math,
                 # arena-api client (already pure fetch+JWT).
                 # Also: the adapter INTERFACE definitions (types only).
  ui/            # @chessgui/ui — React components + the single-source
                 # board/theme assets (see below). Chessground wrapper,
                 # move-list, analysis-panel, eval-graph, shadcn kit, dialogs.
                 # Depends on core; consumes adapters via props/context, never
                 # imports a platform SDK.
apps/
  desktop/       # today's app/ + src-tauri/, unchanged in function.
                 # Tauri adapter implementations (invoke/listen/Channel),
                 # all @tauri-apps/* deps live ONLY here.
                 # PC (spec:222) = Windows/Linux builds of THIS shell — not a
                 # new app, just per-platform engine-path defaults and bundling.
  web/           # spec:221 — same Next.js static export minus Tauri deps.
                 # HTTP adapter (arena server) + optional WASM engine worker.
                 # Deploys to the homeserver behind Caddy at
                 # https://www.spliffdonk.com/chess.
  mobile/        # spec:223, later — Tauri 2 iOS/Android WebView shells reusing
                 # the web shell's adapter strategy. Placeholder until its turn.
```

Ordering note: **the web shell ships first** (spec:221 → spliffdonk.com/chess,
honoring the homeserver resource policy — engines low-priority always, burst
not flat caps, per spec:217 f9b3b0d). The migration below is sequenced so the
web shell can be cut as soon as the packages exist, before mobile is even
scaffolded.

## Adapter interfaces — the seam, named

The hooks/lib layer is the seam (audit-confirmed: ~90 other frontend files reach
platform capabilities only through it). Four interfaces absorb the 14 direct
Tauri importers. Interfaces are types in `packages/core`; each shell registers
implementations at boot (context/provider injection — no `isTauri()` branching
left in shared code).

### EngineProvider
Everything that ultimately runs an engine or an engine-backed Rust command.
- `hooks/use-engine.ts` — UCI lifecycle (`start_engine`, `send_command`,
  `stop_engine`) + the `listen("engine-output")` line stream. Core of the
  interface: `{ start, send, stop, onLine }`. The line stream is the only
  frontend `listen()`; it maps to a WASM-worker `postMessage` (web-local) or a
  WebSocket (server engine). Design the interface so BOTH back it — the arena's
  request/response move API covers *play*, not streaming *analysis*.
- `hooks/use-machine-profile.ts` — `machine_profile_get`, `machine_bench`
  (spec:216 calibration; web benches its WASM engine or defers to the server's
  profile, per spec:217 "Machine calibration").
- `lib/maia.ts`, `lib/persona.ts`, `lib/roster.ts`, `lib/rival-book.ts`,
  `lib/human-eval-tree.ts`, `lib/calibration.ts` (sampling arm) — persona/AI
  move sources; web backs these with the arena HTTP API (spec:217 already
  re-implements persona moves server-side).
- `lib/puzzles.ts` `puzzle_check_move` — Stockfish-backed; rides EngineProvider,
  not DatabaseProvider.
- `components/tournament-tab.tsx` — the worst seam violation (~15 invokes,
  9 Channel sites, 3 streaming channels per batch). Verdict: **desktop-only
  initially**; wrap behind a `TournamentRunner` sub-interface of EngineProvider
  later. Non-desktop shells hide the tab.
- AI-proxy commands (`recognize_fen`, `coach_feedback`/`coach_followup`) are
  Anthropic HTTP calls proxied through Rust today — they move to a shared
  server endpoint eventually, but interface-wise they hang off EngineProvider's
  shell-services corner until then.

### DatabaseProvider
- `lib/database.ts` — the 7 `db_*` commands (import PGN/CBH with progress
  Channels, list, search-position, get, delete, stats). Already falls back to
  `database-mock.ts` off-Tauri; the mock's shape IS the interface draft. CBH
  import stays desktop-only (flagged capability, not a separate interface).
- `lib/puzzles.ts` — deck/import/get/stats (all but `puzzle_check_move`).
- Tournament result persistence (`save/list/load_tournament_result`) when
  TournamentRunner lands.
- Web backend: server DB via the arena API (house choice per spec:217 — the
  arena DB is canonical for arena games); sql.js/OPFS is a later local option.

### DialogProvider
- `components/database-tab.tsx` — dynamic `plugin-dialog` file-open (2 sites)
  → `pickFile()`; web uses `<input type=file>` / File System Access API.
- `components/engine-settings-dialog.tsx` — the ONE static top-level plugin
  import in a component; must become injected or it drags `@tauri-apps/*` into
  web bundles.
- Clipboard (`lib/recognize-position.ts`, already dual-path with a browser
  Clipboard-API fallback) — formalized here as `readClipboardImage/Text`.

### StorageProvider
- The 21 `localStorage` call sites (`engine-settings`, `spar-results`,
  `puzzle-results`, `db-registry`, `training-program`, …) → a `KVStore`
  interface. localStorage backs desktop and web; mobile WebViews get an
  explicit adapter rather than praying.
- Owns platform config: `lib/engine-settings.ts:24`'s hardcoded
  `DEFAULT_ENGINE_PATH = "/opt/homebrew/bin/stockfish"` is a macOS-ism that
  moves to the desktop shell's provider defaults (spec:222 needs Windows/Linux
  defaults in the same slot).

## Single-source theming & assets

Already 90% true; formalize it so it can't regress:

- **Pieces + board texture**: imported as CSS in exactly one place —
  `components/board.tsx` (chessground base/brown/cburnett, piece SVGs as CSS
  data-URIs, no image files in `public/`). Becomes
  `packages/ui/board-theme.css`. Swapping a piece set = editing one import.
- **Square-state overrides** (`last-move`/`selected`/`move-dest` colors in
  `app/globals.css`) move out of the app shell to sit next to the board
  component in `packages/ui` — shells must not each carry a copy.
- **App theme tokens**: `tailwind.config.ts` hardcodes hex colors. Convert to
  CSS custom properties in a shared `packages/ui/tailwind-preset.ts`; each
  shell's tailwind config only extends the preset. One token change → all four
  clients.
- Rule going forward: a shell may not declare a color, piece asset, or board
  style locally. If a shell needs a visual difference, it becomes a preset
  variable.

## Incremental migration plan

Each step is independently committable and leaves `pnpm tauri dev` and
`scripts/install-app.sh` working. Order matters: seam first, workspace second,
moves last — the moves are then mechanical.

1. **Heal the three seam violations** (no layout change):
   `engine-settings-dialog.tsx` static plugin import → injected DialogProvider;
   `database-tab.tsx` file dialogs → `pickFile()`; `tournament-tab.tsx` fenced
   as desktop-only behind a capability flag. Gate: `grep` for `@tauri-apps`
   outside hooks/ + lib/ returns nothing.
2. **Name the interfaces**: add `lib/platform/` with the four interface types +
   a `TauriProviders` implementation wrapping today's invoke/listen/Channel
   calls; the existing `*-mock.ts` files become the browser stub providers.
   The 14 importers now import the provider, never `@tauri-apps/api` directly.
   Kill the `/opt/homebrew` constant into TauriProviders' defaults.
3. **KVStore pass**: route the 21 localStorage sites through StorageProvider.
   Mechanical; batch with tests on `engine-settings` and `spar-results`.
4. **Workspace scaffolding, zero moves**: add `pnpm-workspace.yaml` listing the
   repo root as a package. Verify dev + build + install-app.sh. This isolates
   the tooling risk from the file-move risk.
5. **Extract `packages/core`**: move the pure lib modules (chessops state,
   game-tree, pgn, fen, uci-parser, win-prob, annotations, time-elo, tournament
   math, arena-api) + the interface types. Rewrite `@/lib/x` → `@chessgui/core`
   (mechanical, ~half the ~100-file import churn; one commit, `pnpm tsc
   --noEmit` gate).
6. **Extract `packages/ui`**: components + board-theme.css + square-state CSS +
   tailwind preset. Same rewrite/gate discipline.
7. **Move the shell**: `app/` + `src-tauri/` → `apps/desktop`; update
   `tauri.conf.json` frontendDist, `scripts/install-app.sh`, and the
   `next.config.mjs` git-info shell-out (duplicated per shell, per-app is
   fine). `@tauri-apps/*` deps move to `apps/desktop/package.json` only.
8. **Cut `apps/web`** (spec:221 takes over from here): same Next static export,
   HTTP/WASM providers, no Tauri deps. Static-export constraints are already
   satisfied repo-wide (no server components doing IO, no API routes,
   `images.unoptimized`) — keep them as a hard rule for `packages/ui`.

## What does NOT move

- **`src-tauri/` stays the desktop engine host.** The 40 registered Rust
  commands (uci, match_runner, db, puzzles, calibration, machine, maia,
  persona, coach, vision) are the desktop implementation of the providers —
  they are not "backend to extract", they're `apps/desktop`'s native half.
- **`server/arena/` stays the server-side persona/engine host** (spec:217).
  The web client is a consumer of it, not a replacement for it. No engine
  logic gets duplicated between src-tauri and the arena; they implement the
  same EngineProvider contract from opposite sides.
- **`scripts/mining/`, corpus jobs, data pipelines** — server/laptop batch
  tooling, untouched by the frontend split.
- **`data/rivals` privacy rule** (spec:214/217) — unaffected but restated:
  nothing in packages/ may embed private-individual data; roster privacy is a
  provider concern, enforced server-side or in the desktop shell.

## Risks

- **Next.js static export**: the whole portability story assumes `output:
  'export'` keeps working across shells. Any future feature that wants API
  routes or server components breaks two shells at once — the constraint is
  now architectural, not incidental. Document it in `packages/ui`'s README.
- **GPL-3.0 propagation**: Chessground (GPL) lives in `packages/ui`, so every
  shell that uses the shared board is GPL — which is the project's license
  anyway. Rule: all workspace packages stay GPL-3.0; no "MIT the core later"
  ambitions without replacing the board layer. State the license in each
  package.json at extraction time.
- **Path-alias churn**: ~100 files rewrite `@/*` → `@chessgui/*`. Mechanical
  but merge-hostile — schedule steps 5–6 in quiet windows, one package per
  commit, `tsc --noEmit` + existing tests as the gate. In-flight branches
  rebase painfully; warn before starting.
- **Tooling drift**: pnpm workspace + Tauri + Next static export is a
  well-trodden combo but tauri.conf's relative paths and install-app.sh both
  hardcode today's layout; step 4's "workspace with zero moves" exists
  precisely to shake this out cheaply.
- **tournament-tab.tsx** (~3,100 lines) violates the seam AND any file-size
  cap; fencing it desktop-only is containment, not a fix. Its TournamentRunner
  refactor is real work — tracked here as post-split, not a blocker.

## Non-goals

- Rewriting the UI, the board, or the engine plumbing — this is a *relayout*
  with interface extraction, not a redesign.
- A public component library. `packages/ui` serves this project's four shells,
  nothing else.
- Server-side rendering, per-shell visual forks, or platform-specific piece
  sets — the single-source rule is the point.
- Mobile implementation detail — spec:223's problem; this spec only guarantees
  mobile finds a seam it can implement.

## Done when

- [x] Step-1 seam heal: `grep -r "@tauri-apps" --include="*.tsx" components/`
      returns zero hits; tournament tab hidden off-desktop (code-verified 2026-07-15)
- [x] Four provider interfaces (EngineProvider, DatabaseProvider,
      DialogProvider, StorageProvider) defined as types with a Tauri
      implementation and a browser stub each; the 14 former direct importers
      import providers only (code-verified 2026-07-15)
- [x] `DEFAULT_ENGINE_PATH` macOS constant gone from shared code (lives in
      desktop provider defaults) (code-verified 2026-07-15)
- [x] KVStore: zero bare `localStorage.` call sites outside the StorageProvider
      implementations (code-verified 2026-07-15)
- [ ] `pnpm-workspace.yaml` in place; `pnpm tauri dev` and
      `scripts/install-app.sh --debug` verified green (workspace, pre-move)
      (partial 2026-07-17: pnpm-workspace.yaml is in place at the repo root;
      the dev-mode + install-build "green" halves need a live run — listed in
      900-backlog "Pending user walkthrough (2026-07-17)")
- [x] `packages/core` extracted: zero React/DOM/platform imports inside it
      (verifiable via its package.json deps + `tsc`), all tests moved with it
      still passing (code-verified 2026-07-15)
- [x] `packages/ui` extracted with `board-theme.css`, square-state CSS, and the
      tailwind preset; `app/globals.css` no longer contains cg-board rules (code-verified 2026-07-15)
- [ ] Single-source proof: change the piece-set import in
      `packages/ui/board-theme.css` once → desktop build AND web build both
      show the new pieces, no other file touched
- [x] `apps/desktop` holds app/ + src-tauri/; `@tauri-apps/*` appears in no
      other package.json; macOS build + install works as before (code-verified 2026-07-15)
- [ ] `apps/web` builds a static export with zero Tauri code in the bundle
      (bundle grep), boots against browser/HTTP providers — handoff point to
      spec:221
- [x] All workspace package.json files declare GPL-3.0 (code-verified 2026-07-15)
- [x] specs/README.md index + dependency graph updated with 220→221/222/223

### Later / uncaptured requirements (audit 2026-07-16)

- [ ] TournamentRunner refactor: wrap `components/tournament-tab.tsx` (~3,100
      lines, file-size-cap violation; desktop-only containment today) behind a
      `TournamentRunner` sub-interface of EngineProvider once the workspace
      split settles. (220:92-94, 221-223)
- [ ] AI-proxy commands (`recognize_fen`, `coach_feedback`/`coach_followup`)
      move from Rust-proxied Anthropic calls to a shared server endpoint, so
      the web client gets vision + coach too. (220:95-98; spec:221)
- [x] Document the Next.js static-export hard constraint in a `packages/ui`
      README so it isn't rediscovered by breaking it. (220:203-207)
      (verified 2026-07-17: packages/ui/README.md "Static export (load-bearing)"
      — no API routes, no IO-doing server components, images.unoptimized, plus
      the platform-seam rule)
- [ ] Web-local database story — user decision: server DB via the arena API
      (current house choice) vs sql.js/OPFS local. (220:109; spec:221)
