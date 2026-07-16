# 221: Web Client @ spliffdonk.com/chess

**Status:** draft
**Depends on:** 220 (shared-core monorepo — `apps/web` is a thin shell over
`packages/core`/`packages/ui`; the adapter interfaces defined there are what this
spec plugs web implementations into), 217 (arena backend + Google-auth allowlist,
already Up healthy on the homeserver at 127.0.0.1:8017), 011/013/202 (the features
being exposed)
**Feeds:** 217 Tier 1 (public arena exposure rides this deployment), 223 (mobile —
the responsive web client is the mobile stopgap and the base of the PWA, spec:000
platform stance)

## Goal

The first non-macOS ship (spec:000 "Platforms" — web ships FIRST). The shared-core
chess UI, served publicly at **https://www.spliffdonk.com/chess** from the
homeserver, behind the existing Caddy reverse proxy. Board, analysis, PGN, and
play-vs-personas in any browser — one codebase, so a piece-set or theme change in
`packages/ui` shows up here and on desktop with zero extra work (spec:220
single-source-of-truth rule).

## Decisions (recorded against the 2026-07-16 homeserver survey)

### Serving: static export in a compose container, NOT node, NOT bare Caddy file_server

- The app is already a pure Next.js static export (`output: 'export'`, no API
  routes, no server components doing IO) — a node container would be dead weight.
- Bare Caddy `file_server` off the repo checkout was considered and **rejected**:
  it would require the node/pnpm build toolchain on the server host and break the
  house deploy flow (every service on the box is a compose stack; deploys are
  `git pull` + `docker compose up -d --build`).
- **Chosen:** `server/web/` compose stack next to `server/arena/`. Multi-stage
  Dockerfile: node builds `apps/web` → copies `dist/` into a static-file stage
  (nginx:alpine or caddy). Container `chessgui-web`, bound **127.0.0.1:8018**
  (next free port in the 80xx web band per the port ledger; loopback-only per
  house style — exposure is Caddy 443 only).
- No engine work in this container ever → no cpu shaping needed; `mem_limit: 256m`
  as hygiene. The server resource policy (commit f9b3b0d: engines low-priority
  always, burst not flat caps) is satisfied by putting zero engine load here —
  see Engine strategy.

### Base path: `/chess` via Next `basePath`

- `apps/web/next.config.mjs` sets `basePath: '/chess'` (assets and links emit as
  `/chess/_next/...`). Caddy strips the prefix, the container serves from `/`.
- Caddy route (added via the homeserver agent, `$CADDY_RELOAD`):
  - `redir /chess /chess/ permanent` (house convention for bare paths)
  - `handle_path /chess/api/*` is NOT used — see API routing below for why the
    api matcher must be its own block and must win over the static one.
  - `handle_path /chess/*` → `reverse_proxy 127.0.0.1:8018`
- `/api/v1/*` is claimed globally by golf — the client never uses that prefix.

### Engine: hybrid — browser WASM for analysis, existing arena for play. No new server engine service.

- **Analysis = client-side stockfish WASM** (lila-stockfish-web; GPL like the
  rest of the project). Runs in a Worker behind the spec:220 `EngineProvider`
  interface — the same interface the desktop shell backs with Tauri UCI, so
  `hooks/use-engine.ts`'s debounce/pace logic is untouched. This is the only
  option that respects the server resource policy: infinite analysis is **flat**
  load, not burst, and the policy explicitly forbids flat engine load on the
  shared box. The user's own CPU pays for their own analysis.
- **Play vs personas = the existing arena API** (spec:217). Request/response
  move API, one warm lc0, bursty by construction (one move per request), already
  shaped correctly (`cpu_shares: 256`, `cpus: "4"`, `mem_limit: 6g`). The web
  client reuses `lib/arena-api.ts` verbatim — it is already pure fetch + JWT
  with no Tauri anywhere on that path.
- **No server-side streaming analysis in v1.** It would need a WebSocket variant
  of `engine-output` plus a per-user engine budget — real work, flat-load risk,
  and WASM covers the need. Recorded as a possible later tier only if WASM
  proves too weak on someone's actual hardware.
- WASM deployment detail (load-bearing): multi-threaded stockfish WASM needs
  SharedArrayBuffer, which needs cross-origin isolation. The static container
  sets `Cross-Origin-Opener-Policy: same-origin` +
  `Cross-Origin-Embedder-Policy: require-corp` on all `/chess/*` responses
  (set in the container config so it's versioned with the repo, not in the
  Caddyfile). `fetch()` with CORS (lichess explorer) is unaffected by COEP;
  verify at deploy. Single-threaded build is the fallback if isolation breaks
  anything. NNUE nets (tens of MB) lazy-load on first analysis, standard HTTP
  caching.

### API routing: arena mounted under the same origin

- Caddy block **before** the static handler: `handle /chess/api/*` +
  `uri strip_prefix /chess` → `reverse_proxy 127.0.0.1:8017`. The arena container
  sees its native `/api/*` paths unchanged; the client sets
  `NEXT_PUBLIC_ARENA_API_BASE=/chess` (same-origin relative — no CORS config
  anywhere).
- **This IS spec:217 Tier 1** (public-internet exposure of the arena). Its gates
  come with it: the ARENA_ALLOWLIST stays the only door (403 for non-listed, no
  self-serve signup), and the spec:217 non-goal — private-individual personas
  (Gudmundur) need consent revisited **before** Tier 1 exposure — becomes a
  blocking checklist item here.

### Auth: none for the static client; arena JWT for everything stateful

- The static shell is public. It is client-side only — no server state, no user
  data, no engine cost — and the code is GPL anyway. The house
  auth-before-go-live rule (Caddyfile voicebridge precedent) protects *services*;
  a pile of static files with WASM isn't one.
- Every stateful feature (play vs personas, game history, realism feedback) goes
  through the arena API and therefore through the existing Google id_token →
  allowlist → HS256 JWT flow (`server/arena/app/auth.py`, ported from golf).
  Reused as-is; no second auth system.

## Features — v1 scope

**IN** (all already portable per the 2026-07-16 portability map, or web-native):
- Board & gameplay (`components/board.tsx` is pure Chessground, ships as-is),
  game tree, move list, annotations, eval bar/graph.
- Local analysis: WASM engine, MultiPV, continuous `info` streaming — full
  desktop analysis UX.
- PGN import/export: paste + `<input type="file">` via the spec:220
  `DialogProvider`'s web `pickFile()` implementation; export = download blob.
- Opening explorer: lichess explorer API + `book.bin` over HTTP — already
  network-native, zero changes.
- Play vs personas + per-user game history: the arena page
  (`app/arena/page.tsx` + `components/arena/*`), already Tauri-free.
- Clipboard FEN/PGN: browser Clipboard API path already written.

**OUT for v1** (adapters fall back to their existing web mocks; nothing crashes,
features hide):
- Local sqlite game database + CBH import (desktop-only by design; web database
  is its own future decision — server DB vs OPFS).
- Native file dialogs (web fallback above), tournament tab (the one hard Tauri
  entanglement — desktop-only until wrapped in `TournamentRunner`), puzzles
  (grading runs Stockfish in Rust; revisit once WASM engine is in and proven),
  calibration/machine-bench (meaningless in-browser; persona strength labels
  come from the SERVER's spec:216 profile per spec:217 "Machine calibration",
  not the visitor's machine), screenshot→FEN vision and AI coach (Anthropic
  calls currently proxy through Rust; need a small server endpoint — later),
  Maia/rival/roster local features (subprocess- and private-data-bound).

## Deployment mechanics (mirror of arena's)

- Server checkout: `/home/hjalti/code/chessgui` (exists, tracks origin/main).
- Deploy = `git pull` + `docker compose up -d --build` in `server/web/`;
  executed by the homeserver agent, same choreography as arena.
- Healthcheck: `GET /chess/` via container `GET /` (static 200), standard
  restart policy.
- Caddy: the two `/chess` blocks above + reload. Port ledger claims 8018.
- Backup: going public makes arena games real user data and the survey found
  **no backup timer for `server/arena/data/arena.db`** — add one following the
  forgejo-backup.sh / systemd-timer pattern as part of this ship, since this
  spec is what exposes the arena.

## Non-goals

- A node/SSR deployment, user accounts beyond the arena allowlist, or any
  self-serve signup (spec:217: invite-only, ever).
- Server-side streaming analysis (revisit only on WASM strength evidence).
- Feature parity with desktop — the OUT list is deliberate, not debt to burn
  down immediately.
- A separate mobile build; this client is responsive and serves phones until a
  native mobile shell earns a spec.

## Done when

- [ ] `apps/web` shell exists in the workspace (spec:220), builds a static
      export with `basePath: '/chess'`, no `@tauri-apps/*` in its dependency
      graph
- [ ] WASM `EngineProvider` adapter: analysis panel streams MultiPV info lines
      in a plain browser, desktop hook logic unchanged
- [ ] COOP/COEP headers served; SharedArrayBuffer available (or single-thread
      fallback consciously accepted and recorded here)
- [ ] `server/web/` compose stack: multi-stage build, `chessgui-web` on
      127.0.0.1:8018, mem_limit set, healthcheck green
- [ ] Caddy routes live: `/chess` redirect, `/chess/api/*` → arena 8017 (strip
      `/chess`), `/chess/*` → 8018; ordering verified (api wins)
- [ ] Arena reachable through `/chess/api` with the existing Google-auth
      allowlist enforced (403 for a non-listed account, verified from outside
      the LAN)
- [ ] spec:217 Tier-1 consent gate cleared for private-individual personas
      (Gudmundur asked, or his persona held back from the public roster)
- [ ] `arena.db` backup timer installed (forgejo-backup pattern)
- [ ] Board theme/piece-set change made once in `packages/ui` shows up in both
      the deployed web client and the macOS build (spec:220 invariant, proven
      here)
- [ ] PGN paste + file import and export round-trip in Safari, Chrome, Firefox
- [ ] Reachable at https://www.spliffdonk.com/chess from the public internet
