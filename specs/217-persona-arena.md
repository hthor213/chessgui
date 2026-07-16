# 217: Persona Arena — the web spar that pulls dad in

**Status:** draft
**Depends on:** 214 (personas, books, realism feedback), 213 (Maia levels), homeserver
**Origin:** user idea 2026-07-15 — "they don't have karpov, kasparov, fischer,
gudmundur... that pulls him in, wanting to play... and as he plays against them we
learn more about his playing style"

## Goal

A web UI (served from the homeserver, Google auth) where invited players — dad first —
play full games against the persona roster: **peak Gudmundur Sigurjónsson** (his real
friend, at the strength dad remembers), Fischer, Kasparov, Karpov, other Icelandic
GMs. The pull is a roster chess.com cannot offer; the return is a continuous stream of
dad's games under controlled conditions (known opponent, known strength, every move in
context) feeding the spec-214 style priors and the training program's rival model.

Platform note: per the vision's platform stance (spec:000 "Platforms", 2026-07-15),
this is the project's first non-macOS surface. Web, mobile, and Windows/PC native are
first-class citizens alongside macOS; macOS remains the testing build for now, and the
others get planned only when their turn comes — this spec is web's turn.

## Transparency (non-negotiable; wording decided 2026-07-15)

Every session shows an honest disclosure before play. User decision 2026-07-15: no
consent paperwork — this is an app for the user, then dad. The disclosure is the
family sticker, near-verbatim: "note: your son may use your games — study them in
order to try to beat you in chess at Christmas." (Tournament-chess norm: moves are
recorded.) This supersedes the earlier two-candidate wording choice. A formal ToU
is deliberately deferred — it becomes a question only if the app is ever published
beyond family.
Recorded games of private individuals stay private (server-side equivalent of
data/rivals; never committed, never bundled) — same hard rule as spec 214.

## Architecture sketch

- **Frontend**: the existing Next.js board UI already runs Tauri-free in a browser;
  arena build strips Tauri-only tabs to a lobby (roster) + game screen + game history.
- **Backend (homeserver)**: move API wrapping lc0 (Maia nets + BT3) and the persona
  books; game persistence (SQLite/Postgres); per-user history. Deployed like the other
  homeserver services (Docker; the homeserver agent handles choreography).
- **Auth**: Google auth ported from the golf app. Invite-only allowlist — this is a
  family arena, not a public chess server.
- **Personas v1 roster**: Gudmundur (peak slice), Fischer, Kasparov, **Spassky** (the
  other chair in Reykjavík 1972 — and the strength-anchor's best common opponent:
  played Fischer 1972/1992 AND Kasparov in the 80s) + Karpov and the
  Icelandic canon (extraction pipeline exists, Lumbra OTB in app DB). Backend per
  spec 214 findings: BT3/strong-policy for GM personas, Maia bands for amateurs; the
  realism lessons from match #1/#2 (verification search, draw model) apply directly.
  Roster source of truth: spec:218 (Participant abstraction, roster, avatars;
  persona definitions per spec:214 Tier 2) — the lobby consumes that definition,
  including the caricature avatar field, rather than redefining it.

## Failure modes & latency (mentor review 2026-07-15)

Family-scale operations, not scaling engineering:

- **Move-latency budget**: target under ~2s per persona move, with a visible thinking
  indicator in the game screen. MEASURED (2026-07-15, Tier-0 staging): BT3 on the
  server CPU ≈ 3-4 NN evals/s → ~10s/move at the staged 32 nodes — 5x over budget.
  Options open (user decision): accept ~10s with the indicator; rebuild lc0 with the
  onednn backend (likely 2-4x); or a smaller strong net (needs harness re-validation).
  ARENA_SEARCH_NODES is env-tunable without rebuild.
- **Engine stalls**: retry, then respawn the engine process — never silently hang a
  game.
- **Disconnect/resume**: every move is persisted server-side as it happens; partial
  games are resumable.
- **Crash-restart**: the standard Docker restart policy, same as the other homeserver
  services.
- **Resource limits**: modest per-process limits — enough for a family, nothing more.

The arena DB is canonical for arena games; games are deletable on request.

## Machine calibration (spec:216 — required, 2026-07-15 user)

Dad plays on one of two machines, and BOTH need a spec:216 speed profile before
their strength labels are honest — engine strength is a fact about the machine,
not the binary:

- **Browser via homeserver (Tier 0 path)**: personas run on the SERVER, so the
  server needs its own 216 profile. Gate for Tier 0: run the bench (machine
  profile) on the homeserver; labels display as PRIOR until the compression
  ladder runs there (Tier-1 item — the ladder is hours of engine time; schedule
  around mining jobs). The laptop's measured curve does NOT transfer.
- **His own PC (future native build, spec:000 platform stance)**: first-start
  calibration — auto-bench on first launch (216 Tier 2), labels PRIOR until then.

Same rule, one sentence: any surface that fields a persona inherits spec:216's
per-machine calibration requirement before it may claim a strength.

## Cultural context

The roster is a living museum: docs/research/iceland-chess-culture.md — 1972
Match of the Century in Reykjavik, the boom generation, Fischer's return, the
per-capita math.

## The Icelandic canon (user-supplied roster + lore, 2026-07-15)

Iceland's infamous brag — "best per capita :-)", ~10 GMs at peak for ~330k people —
is the arena's flavor (candidate lobby tagline: "Best per capita"). Extraction
candidates, all public figures, check Lumbra coverage per name:
- **Friðrik Ólafsson** — Iceland's first GM, dad's-generation hero (also FIDE
  president 1978-82).
- **Margeir Pétursson** — GM AND founded MP Capital; personally helped the user with
  VC funding. Lore: **Gudmundur was always trying to beat Margeir and never quite
  made it** — a built-in arena quest ("win the game Gudmundur never got").
- **Jóhann Hjartarson** — candidates-level (beat Korchnoi in the 1988/89 candidates).
- **Hannes Stefánsson** — multiple Icelandic champion.
- **Helgi Ólafsson**, **Héðinn Steingrímsson**, and the rest of the ~10 (Jón L.
  Árnason etc.) as coverage allows.
- **Feedback**: the spar realism-feedback capture pattern ("felt like him" for people
  who knew the player) is a v2 candidate for other family members who knew these
  players.

## Data flywheel

Dad's arena games are strictly better rival-model data than his chess.com archives:
fixed known-strength opponents, full clock context, and volume that grows because he
*wants* to play. Each batch: re-run the self-analysis pipeline → update dossier →
retune style priors (gated on move-match, spec 214). The user's spar-vs-dad gets more
accurate as a direct consequence — the arena feeds the Florida milestone.

## Tiers

- **Tier 0**: LAN/Tailscale-only arena — lobby with 3 personas (Gudmundur peak,
  Fischer, Kasparov), Google auth allowlist, disclosure screen, games persisted
  server-side, dad invited in the same room (first session assisted).
- **Tier 1**: public-internet exposure (same pattern as the golf app), Karpov + more
  Icelandic GMs, per-opponent W/D/L history for the player, clocks with increment
  (match protocol from spec 215).
- **Tier 2**: batch ingest into the rival pipeline (dossier + style-prior retune per
  N new games), opt-in "felt like him" feedback for players who knew the personas,
  spectator/replay links shareable in the family.

## Non-goals

- A public chess server, ratings ladder, or chess.com competitor. Invite-only, ever.
- Engagement mechanics. The roster is the pull; there are no streaks, badges, or
  notifications nagging him to play.
- Simulating living private individuals for the roster without their knowledge —
  personas of private people require their consent (Gudmundur: dad's call to ask him,
  or keep that persona in the family-only room; revisit before Tier 1 exposure).
