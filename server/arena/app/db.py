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
  updated_at TEXT DEFAULT (datetime('now'))
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
"""


def init(path: str) -> None:
    global _conn
    _conn = sqlite3.connect(path, check_same_thread=False)
    _conn.row_factory = sqlite3.Row
    _conn.execute("PRAGMA journal_mode=WAL")
    _conn.execute("PRAGMA foreign_keys=ON")
    _conn.executescript(SCHEMA)
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

def create_game(user_id: int, persona: str, player_color: str,
                seed: int) -> int:
    return _exec(
        "INSERT INTO games (user_id, persona, player_color, seed) "
        "VALUES (?,?,?,?)", (user_id, persona, player_color, seed))


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


def finish_game(game_id: int, result: str, reason: str) -> None:
    _exec("UPDATE games SET status='finished', result=?, result_reason=?, "
          "updated_at=datetime('now') WHERE id=?", (result, reason, game_id))


def delete_game(game_id: int) -> None:
    _exec("DELETE FROM games WHERE id=?", (game_id,))
