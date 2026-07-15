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

## Transparency (non-negotiable, wording user-decided)

Every session shows an honest disclosure before play. Two candidate wordings, user
picks (family-dynamics call, deliberately not defaulted):
- (a) Specific-but-innocuous: "games may be recorded to improve this site's players,
  including opponents modeled on the people who play here."
- (b) General now ("games may be recorded for training purposes"), with the full
  reveal as part of the Christmas match story.
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
- **Personas v1 roster**: Gudmundur (peak slice), Fischer, Kasparov + Karpov and the
  Icelandic canon (extraction pipeline exists, Lumbra OTB in app DB). Backend per
  spec 214 findings: BT3/strong-policy for GM personas, Maia bands for amateurs; the
  realism lessons from match #1/#2 (verification search, draw model) apply directly.

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
