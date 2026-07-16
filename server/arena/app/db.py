"""SQLite persistence for the arena (spec 217 failure modes: every move is
persisted as it happens; partial games resumable; arena DB canonical; games
deletable on request). Family-scale: one sqlite3 connection guarded by a lock.
Private games stay server-side — the DB lives in a bind-mounted, gitignored
data/ dir, same hard rule as data/rivals (spec 214)."""

import json
import sqlite3
import threading
from typing import Any, Dict, List, Optional

_lock = threading.Lock()
_conn: Optional[sqlite3.Connection] = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  name TEXT DEFAULT '',
  avatar_url TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  last_login TEXT
);
CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  persona TEXT NOT NULL,
  player_color TEXT NOT NULL CHECK (player_color IN ('white','black')),
  seed INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','finished')),
  result TEXT,               -- '1-0' / '0-1' / '1/2-1/2'
  result_reason TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  -- Clock (spec 217 Tier 1: clocks with increment). NULL clock_initial_s =
  -- no clock (every pre-clock game, and games created without one).
  -- white_ms/black_ms are the remaining time AT turn_started_at; the side to
  -- move burns wall-clock from there, so the true remaining is derived, and
  -- the clock survives restarts/resume without a background timer.
  clock_initial_s INTEGER,
  clock_increment_s INTEGER,
  white_ms INTEGER,
  black_ms INTEGER,
  turn_started_at REAL,      -- unix epoch: when the side to move's clock started
  -- Shareable family replay link (spec 217 Tier 2): an unguessable token that
  -- opens a read-only replay WITHOUT login. NULL = not shared. Uniqueness is
  -- enforced by idx_games_share_token (an ALTER-added column can't carry
  -- UNIQUE, so fresh and migrated DBs use the same index).
  share_token TEXT
);
CREATE TABLE IF NOT EXISTS moves (
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  ply INTEGER NOT NULL,
  uci TEXT NOT NULL,
  san TEXT NOT NULL,
  mover TEXT NOT NULL CHECK (mover IN ('player','persona')),
  arm TEXT,                  -- 'book' / 'search' (persona moves only)
  decision_log TEXT,         -- JSON: candidates, weights, timings (spec 214 step 9)
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (game_id, ply)
);
CREATE TABLE IF NOT EXISTS move_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  ply INTEGER NOT NULL,
  uci TEXT NOT NULL,
  san TEXT NOT NULL,
  persona TEXT NOT NULL,     -- denormalized: survives even if games change shape
  note TEXT DEFAULT '',      -- free text, optional ("...because he'd lose the bishop")
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS game_feedback (
  -- Spec 217 Tier 2: post-game "felt like him" verdict — whole-game realism,
  -- distinct from per-move move_feedback. game_id as PRIMARY KEY = one
  -- verdict per game; re-submitting updates it (the player changed their
  -- mind, and the retune wants their final read, not a vote history).
  game_id INTEGER PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
  persona TEXT NOT NULL,     -- denormalized, same rule as move_feedback
  verdict TEXT NOT NULL CHECK (verdict IN ('felt_like','did_not_feel_like')),
  note TEXT DEFAULT '',      -- free text, optional
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
"""


def init(path: str) -> None:
    global _conn
    _conn = sqlite3.connect(path, check_same_thread=False)
    _conn.row_factory = sqlite3.Row
    _conn.execute("PRAGMA journal_mode=WAL")
    _conn.execute("PRAGMA foreign_keys=ON")
    _conn.executescript(SCHEMA)
    # Migration: CREATE TABLE IF NOT EXISTS never adds columns to an existing
    # table, and the staged homeserver DB predates clocks (spec 217 Tier 1).
    # Pre-clock rows keep NULL clock_initial_s = "no clock", so old games
    # resume exactly as before.
    have = {r[1] for r in _conn.execute("PRAGMA table_info(games)")}
    for col, decl in (("clock_initial_s", "INTEGER"),
                      ("clock_increment_s", "INTEGER"),
                      ("white_ms", "INTEGER"),
                      ("black_ms", "INTEGER"),
                      ("turn_started_at", "REAL"),
                      ("share_token", "TEXT")):
        if col not in have:
            _conn.execute(f"ALTER TABLE games ADD COLUMN {col} {decl}")
    # After the ALTERs so a migrated DB has the column before the index
    # references it (SCHEMA's executescript runs first and would fail there).
    _conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_games_share_token "
                  "ON games(share_token) WHERE share_token IS NOT NULL")
    _conn.commit()


def _rows(q: str, args: tuple = ()) -> List[Dict[str, Any]]:
    with _lock:
        return [dict(r) for r in _conn.execute(q, args).fetchall()]


def _exec(q: str, args: tuple = ()) -> int:
    with _lock:
        cur = _conn.execute(q, args)
        _conn.commit()
        return cur.lastrowid


# --- users (allowlist-provisioned; login only refreshes profile) ---

def ensure_user(email: str) -> Dict[str, Any]:
    _exec("INSERT OR IGNORE INTO users (email) VALUES (?)", (email.lower(),))
    return _rows("SELECT * FROM users WHERE email=?", (email.lower(),))[0]


def get_user_by_email(email: str) -> Optional[Dict[str, Any]]:
    r = _rows("SELECT * FROM users WHERE email=?", (email.lower(),))
    return r[0] if r else None


def get_user_by_id(uid: int) -> Optional[Dict[str, Any]]:
    r = _rows("SELECT * FROM users WHERE id=?", (uid,))
    return r[0] if r else None


def update_login(uid: int, name: str, avatar_url: str) -> None:
    _exec("UPDATE users SET last_login=datetime('now'), name=?, avatar_url=? "
          "WHERE id=?", (name, avatar_url, uid))


# --- games ---

def create_game(user_id: int, persona: str, player_color: str, seed: int,
                clock_initial_s: Optional[int] = None,
                clock_increment_s: Optional[int] = None,
                turn_started_at: Optional[float] = None) -> int:
    """Clocked when clock_initial_s is set: both sides start with the full
    initial time and White's clock starts at turn_started_at (creation) —
    the persona's own first-move think time counts when it has White."""
    if clock_initial_s is None:
        return _exec(
            "INSERT INTO games (user_id, persona, player_color, seed) "
            "VALUES (?,?,?,?)", (user_id, persona, player_color, seed))
    ms = clock_initial_s * 1000
    return _exec(
        "INSERT INTO games (user_id, persona, player_color, seed, "
        "clock_initial_s, clock_increment_s, white_ms, black_ms, "
        "turn_started_at) VALUES (?,?,?,?,?,?,?,?,?)",
        (user_id, persona, player_color, seed, clock_initial_s,
         clock_increment_s or 0, ms, ms, turn_started_at))


def get_game(game_id: int) -> Optional[Dict[str, Any]]:
    r = _rows("SELECT * FROM games WHERE id=?", (game_id,))
    return r[0] if r else None


def list_games(user_id: int) -> List[Dict[str, Any]]:
    return _rows(
        "SELECT g.*, (SELECT COUNT(*) FROM moves m WHERE m.game_id=g.id) "
        "AS n_moves FROM games g WHERE user_id=? ORDER BY id DESC", (user_id,))


def get_moves(game_id: int) -> List[Dict[str, Any]]:
    return _rows("SELECT * FROM moves WHERE game_id=? ORDER BY ply", (game_id,))


def add_move(game_id: int, ply: int, uci: str, san: str, mover: str,
             arm: Optional[str] = None,
             decision_log: Optional[dict] = None) -> None:
    """Persisted-then-answered: this commits before the API replies (spec 217
    disconnect/resume rule)."""
    _exec("INSERT INTO moves (game_id, ply, uci, san, mover, arm, decision_log)"
          " VALUES (?,?,?,?,?,?,?)",
          (game_id, ply, uci, san, mover, arm,
           json.dumps(decision_log) if decision_log else None))
    _exec("UPDATE games SET updated_at=datetime('now') WHERE id=?", (game_id,))


def add_move_feedback(game_id: int, ply: int, uci: str, san: str,
                      persona: str, note: str) -> int:
    """Spec 217 Promise 2: "I would never do this" capture — the spec-214
    realism-feedback pattern ported to the arena. Move + persona are
    denormalized from the moves/games rows at write time so each feedback
    row is self-contained for the Tier-2 style-prior retune."""
    return _exec(
        "INSERT INTO move_feedback (game_id, ply, uci, san, persona, note) "
        "VALUES (?,?,?,?,?,?)", (game_id, ply, uci, san, persona, note))


def list_move_feedback(game_id: int) -> List[Dict[str, Any]]:
    return _rows("SELECT * FROM move_feedback WHERE game_id=? ORDER BY id",
                 (game_id,))


def set_game_feedback(game_id: int, persona: str, verdict: str,
                      note: str) -> None:
    """Spec 217 Tier 2: post-game "felt like him" verdict — upsert, one row
    per game (the player's latest read wins; see the schema comment)."""
    _exec("INSERT INTO game_feedback (game_id, persona, verdict, note) "
          "VALUES (?,?,?,?) ON CONFLICT(game_id) DO UPDATE SET "
          "persona=excluded.persona, verdict=excluded.verdict, "
          "note=excluded.note, updated_at=datetime('now')",
          (game_id, persona, verdict, note))


def get_game_feedback(game_id: int) -> Optional[Dict[str, Any]]:
    r = _rows("SELECT * FROM game_feedback WHERE game_id=?", (game_id,))
    return r[0] if r else None


# --- share tokens (spec 217 Tier 2: family replay links, no login) ---

def set_share_token(game_id: int, token: str) -> None:
    _exec("UPDATE games SET share_token=? WHERE id=?", (token, game_id))


def clear_share_token(game_id: int) -> None:
    _exec("UPDATE games SET share_token=NULL WHERE id=?", (game_id,))


def get_game_by_share_token(token: str) -> Optional[Dict[str, Any]]:
    r = _rows("SELECT * FROM games WHERE share_token=?", (token,))
    return r[0] if r else None


def wdl_by_persona(user_id: int) -> List[Dict[str, Any]]:
    """Spec 217 Tier 1: per-opponent W/D/L record from the player's side.
    Finished games only (an active game has no result yet); win/loss is the
    result crossed with player_color — the same mapping the client's history
    badge uses (lib/arena-moves.ts arenaResultBadge)."""
    return _rows(
        "SELECT persona, "
        "SUM(CASE WHEN (result='1-0' AND player_color='white') "
        "          OR (result='0-1' AND player_color='black') "
        "    THEN 1 ELSE 0 END) AS wins, "
        "SUM(CASE WHEN result='1/2-1/2' THEN 1 ELSE 0 END) AS draws, "
        "SUM(CASE WHEN (result='0-1' AND player_color='white') "
        "          OR (result='1-0' AND player_color='black') "
        "    THEN 1 ELSE 0 END) AS losses "
        "FROM games WHERE user_id=? AND status='finished' "
        "GROUP BY persona ORDER BY persona", (user_id,))


def set_clock(game_id: int, color: str, remaining_ms: int,
              turn_started_at: Optional[float]) -> None:
    """Commit one side's clock after its move: remaining time (increment
    already applied by the caller) plus the moment the OTHER side's clock
    starts. Persisted-then-answered, same rule as add_move — a restart
    resumes the clock from here (spec 217 disconnect/resume)."""
    col = "white_ms" if color == "white" else "black_ms"
    _exec(f"UPDATE games SET {col}=?, turn_started_at=?, "
          "updated_at=datetime('now') WHERE id=?",
          (remaining_ms, turn_started_at, game_id))


def finish_game(game_id: int, result: str, reason: str) -> None:
    _exec("UPDATE games SET status='finished', result=?, result_reason=?, "
          "updated_at=datetime('now') WHERE id=?", (result, reason, game_id))


def delete_game(game_id: int) -> None:
    _exec("DELETE FROM games WHERE id=?", (game_id,))
