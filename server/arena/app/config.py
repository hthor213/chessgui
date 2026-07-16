"""Arena backend config (spec 217 Tier 0). Everything from env, with defaults
matching the docker-compose layout. No secrets in code."""

import os

# --- paths ---
DB_PATH = os.getenv("ARENA_DB_PATH", "/app/data/arena.db")
PERSONA_DIR = os.getenv("ARENA_PERSONA_DIR", "/app/personas")
LC0_PATH = os.getenv("LC0_PATH", "/usr/local/bin/lc0")
LC0_NET_PATH = os.getenv("LC0_NET_PATH", "/nets/BT3-768x15x24h-swa-2790000.pb.gz")
# Pinned sha (src-tauri/src/maia.rs MANAGED_NETS); verified at startup.
LC0_NET_SHA256 = os.getenv(
    "LC0_NET_SHA256",
    "e3067757d1fc2dfc66947b21d15ace0cedf4c54254fc1de83d77c378a3e8b8e1",
)

# --- auth (pattern ported from golf-trip-planner backend/api/auth.py) ---
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "")
JWT_SECRET = os.getenv("JWT_SECRET_KEY", "")
JWT_ALGORITHM = os.getenv("JWT_ALGORITHM", "HS256")
JWT_EXPIRY_DAYS = int(os.getenv("JWT_EXPIRY_DAYS", "7"))
# Invite-only allowlist (spec 217: family arena, never public). Comma-separated.
ALLOWLIST = [e.strip().lower() for e in os.getenv("ARENA_ALLOWLIST", "").split(",")
             if e.strip()]

# --- engine (Tier 0: one warm lc0, 1-2 concurrent games, mining job shares box) ---
LC0_THREADS = int(os.getenv("LC0_THREADS", "4"))
ENGINE_MOVE_TIMEOUT_S = float(os.getenv("ENGINE_MOVE_TIMEOUT_S", "30"))
# Verification-search depth (exhibition_v2 match #2 arm). Overridable per deploy
# after measuring CPU nps; spec latency budget is ~2s/move.
SEARCH_NODES = int(os.getenv("ARENA_SEARCH_NODES", "120"))
TOP_K = int(os.getenv("ARENA_TOP_K", "4"))
TEMP = float(os.getenv("ARENA_TEMP", "0.30"))

# --- exhibitions (spec 217 Promise 3: persona-vs-persona spectate/replay) ---
# Resource policy (spec 217 "Resource limits", hobby-server rule): an
# exhibition is batch-shaped load, so it must never crowd out interactive
# games. Three levers, all env-tunable without rebuild:
#   - one exhibition at a time (enforced in main.py, not a config knob);
#   - a per-move node cap, defaulting to the interactive budget (same realism
#     arm) — lower it per deploy if the box degrades;
#   - a pause between moves, so sustained engine load stays bursty and any
#     interactive persona move wins the shared move lock in between.
EXHIBITION_SEARCH_NODES = int(os.getenv("ARENA_EXHIBITION_NODES",
                                        str(SEARCH_NODES)))
EXHIBITION_MOVE_PAUSE_S = float(os.getenv("ARENA_EXHIBITION_MOVE_PAUSE_S",
                                          "1.0"))
# Hard termination guarantee: adjudicate a draw at this many plies — a
# runaway shuffle game must not hold the exhibition slot (and the engine)
# for hours.
EXHIBITION_MAX_PLIES = int(os.getenv("ARENA_EXHIBITION_MAX_PLIES", "400"))

# --- private personas (spec 217 Promise 1: play against YOURSELF) ---
# Per-user gating: the logged-in player's own persona appears in their lobby
# and nobody else's. The email->slug map is env-only ("email:slug" pairs,
# comma-separated) so no private identity ever lands in code or git; the
# artifacts ({slug}.config.json + book, build_rival_configs.py format —
# build_self_persona.py emits the same shape for the user's own "You" entry,
# spec 218; `--arena-staging` there prints the deploy list) live in a
# server-private dir — the server-side equivalent of data/rivals (spec 214
# hard rule: never committed, never bundled). Missing artifacts skip the
# persona at startup; it appears in the owner's lobby once they land.
PRIVATE_PERSONA_DIR = os.getenv("ARENA_PRIVATE_PERSONA_DIR",
                                "/app/private-personas")
PRIVATE_PERSONAS = dict(
    pair.strip().lower().split(":", 1)
    for pair in os.getenv("ARENA_PRIVATE_PERSONAS", "").split(",")
    if ":" in pair)

# Maia nets (private amateur personas run their Maia band, not BT3 — a
# ~1300-rated persona on the BT3 arm would be a lie). Same /nets mount as the
# BT3 net. Sha-pinned per band (spec 218 own-persona entry): digests copied
# from apps/desktop/src-tauri/src/maia.rs CHECKSUMS — our own record of the
# CSSLab v1.0 release bytes (no upstream-signed manifest exists). Verified in
# persona.load_private_roster; a mismatched net skips the persona at startup,
# never half-loads it. A basename absent from this map is NOT rejected —
# experimental nets registered via env stay usable, only known bands are pinned.
MAIA_NET_DIR = os.getenv("ARENA_MAIA_NET_DIR", "/nets")
MAIA_NET_SHA256 = {
    "maia-1100.pb.gz": "e1cf1cd0c96b8a4fa6a275f4b9fd54ed1ffebf9fe44641b9fceded310e9619c4",
    "maia-1200.pb.gz": "ead4ba953f233ae732999ebc1e2b675378148527ebcfad2f0acbc5e4c224d98e",
    "maia-1300.pb.gz": "36195f87bf4761834baa0bf87472b18509a7261a9d7d6f1a8443261369a733f2",
    "maia-1400.pb.gz": "d5353ea6766356dad2d28920c6692f37a5f30963767f1a3105d33b4d0af011e8",
    "maia-1500.pb.gz": "35ab6f20421d59e1df3b17c5a5016947af4c6761368ef84044a9a9c7619a9a00",
    "maia-1600.pb.gz": "d2c9e5948581acf4b9fc0b1e720c5dc0fe64ce80cfc4a239d3f8a42e1176c876",
    "maia-1700.pb.gz": "d277eacd792d340a30abb464dc65127254e65cac57abca17facc469889b96478",
    "maia-1800.pb.gz": "0031ad7c4256b1fd09fbebd28418d644d68b26cd2a45df4967ccf5c7ec9c4965",
    "maia-1900.pb.gz": "e2f565f42d7cd9f122557e6dc4eb84e5bbaedceda1d404dc485d3611c7c97a12",
}
# Out-of-book node budget for Maia-backed personas. Deliberately small: the
# visit head converges to the Maia policy quickly, and a deep search would
# play ABOVE the band. Unmeasured — tune via realism feedback (Promise 2).
MAIA_SEARCH_NODES = int(os.getenv("ARENA_MAIA_SEARCH_NODES", "16"))

# --- roster (spec 217): Tier-0 trio + Tier-1 unlock (Karpov, Spassky, the
# Icelandic canon). Every default slug's artifacts ({slug}.config.json +
# {slug}.book.json) verified present in data/personas, 2026-07-15; personas
# whose artifacts are missing at startup are skipped, not invented
# (persona.load_roster). Env override unchanged: ARENA_ROSTER.
ROSTER_SLUGS = [s.strip() for s in os.getenv(
    "ARENA_ROSTER",
    "sigurjonsson-peak,fischer,kasparov,"          # Tier 0
    "karpov,spassky,"                              # Tier 1: the other chairs
    "fridrik-olafsson,margeir-petursson,johann-hjartarson,hannes-stefansson,"
    "helgi-olafsson,hedinn-steingrimsson,jon-l-arnason",  # Icelandic canon
).split(",") if s.strip()]

# Transparency disclosure (spec 217, near-verbatim family sticker, 2026-07-15).
DISCLOSURE = ("note: your son may use your games — study them in order to try "
              "to beat you in chess at Christmas.")
