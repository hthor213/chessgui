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

# --- Tier 0 roster (spec 217): Gudmundur peak, Fischer, Kasparov ---
TIER0_SLUGS = [s.strip() for s in os.getenv(
    "ARENA_ROSTER", "sigurjonsson-peak,fischer,kasparov").split(",") if s.strip()]

# Transparency disclosure (spec 217, near-verbatim family sticker, 2026-07-15).
DISCLOSURE = ("note: your son may use your games — study them in order to try "
              "to beat you in chess at Christmas.")
