"""Persona Arena Tier-0 move API (spec 217).

Routes (all /api/* behind JWT except /health and /api/auth/google-login):
  POST /api/auth/google-login {id_token}      -> {jwt, user}   (invite-only)
  GET  /api/personas                          -> Tier-0 roster + disclosure
  POST /api/game {persona, player_color,
                  clock_initial_s?, clock_increment_s?}
                                              -> game state (persona moves
                                                 first if it has White;
                                                 clock optional — 217 Tier 1)
  GET  /api/games                             -> my games
  GET  /api/stats                             -> my per-persona W/D/L record
                                                 (217 Tier 1)
  GET  /api/game/{id}                         -> full state (resume)
  POST /api/game/{id}/move {uci}              -> player move + persona reply
  POST /api/game/{id}/resign                  -> resign
  POST /api/game/{id}/feedback {ply, note?}   -> "I would never do this" on a
                                                 persona move (217 Promise 2)
  POST /api/game/{id}/realism {verdict, note?}-> post-game "felt like him" /
                                                 "didn't feel like him" verdict
                                                 (217 Tier 2; one per game,
                                                 re-submit updates)
  POST /api/game/{id}/share                   -> {token} share a finished game
                                                 as a read-only family replay
                                                 link (217 Tier 2; idempotent)
  DELETE /api/game/{id}/share                 -> revoke the replay link
  GET  /api/replay/{token}                    -> read-only replay, NO auth —
                                                 the token IS the capability
                                                 (unguessable, revocable)
  DELETE /api/game/{id}                       -> delete (spec: deletable on request)
"""

import hashlib
import os
import random
import secrets
import threading
import time
from contextlib import asynccontextmanager
from typing import Optional

import chess
from fastapi import Depends, FastAPI, HTTPException, Request
from pydantic import BaseModel

from . import auth, config, db, persona as persona_mod
from .engine import EngineStall, Lc0Search

_engine: Optional[Lc0Search] = None
_roster = {}
_private_roster = {}   # owner email -> their OWN persona (spec 217 Promise 1)
_maia_engines = {}     # net_path -> warm Lc0Search, spawned on first use
_move_lock = threading.Lock()  # Tier 0: persona moves serialized (1-2 games)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _engine, _roster, _private_roster
    os.makedirs(os.path.dirname(config.DB_PATH), exist_ok=True)
    db.init(config.DB_PATH)
    for email in config.ALLOWLIST:
        db.ensure_user(email)
    _roster = persona_mod.load_roster()
    _private_roster = persona_mod.load_private_roster()
    for email in list(_private_roster):
        if _private_roster[email].slug in _roster:
            # A private slug must never shadow a public one — game rows key
            # personas by slug, and a collision would misroute _persona_of.
            print(f"[arena] private persona '{_private_roster[email].slug}' "
                  "shadows a roster slug; dropped")
            del _private_roster[email]
    with open(config.LC0_NET_PATH, "rb") as f:  # pinned sha (maia.rs MANAGED_NETS)
        got = hashlib.sha256(f.read()).hexdigest()
    if got != config.LC0_NET_SHA256:
        raise RuntimeError(f"BT3 net checksum mismatch: {got}")
    _engine = Lc0Search()  # warm net load at startup, not on first move
    yield
    _engine = None


app = FastAPI(title="Persona Arena (Tier 0)", lifespan=lifespan)


# --- auth plumbing (golf-app pattern) ---

def current_user(request: Request) -> dict:
    h = request.headers.get("authorization", "")
    if not h.startswith("Bearer "):
        raise HTTPException(401, "JWT required")
    payload = auth.verify_jwt(h[7:])
    if not payload:
        raise HTTPException(401, "Invalid or expired token")
    user = db.get_user_by_id(payload["sub"])
    if not user:
        raise HTTPException(401, "User not found")
    return user


class GoogleLoginRequest(BaseModel):
    id_token: str


# Clock bounds (spec 217 Tier 1 "clocks with increment"; the concrete match
# control from spec 215 lives in its private overlay, so the server accepts a
# sane range and the client offers presets). Seconds.
CLOCK_INITIAL_MIN_S, CLOCK_INITIAL_MAX_S = 30, 3 * 3600
CLOCK_INCREMENT_MAX_S = 180


class CreateGameRequest(BaseModel):
    persona: str
    player_color: str  # 'white' | 'black'
    # Both optional: omitted = no clock (the Tier-0 behavior, unchanged).
    clock_initial_s: Optional[int] = None
    clock_increment_s: Optional[int] = None


class MoveRequest(BaseModel):
    uci: str


class MoveFeedbackRequest(BaseModel):
    ply: int
    note: str = ""  # optional free text ("...because he'd never trade queens here")


class GameRealismRequest(BaseModel):
    verdict: str    # 'felt_like' | 'did_not_feel_like' (spar vocabulary, spec 214)
    note: str = ""  # optional free text


@app.get("/health")
def health():
    # Count only — private slugs/owners never leave the server unscoped.
    return {"status": "ok", "engine": _engine is not None,
            "roster": sorted(_roster),
            "private_personas": len(_private_roster)}


@app.post("/api/auth/google-login")
def google_login(req: GoogleLoginRequest):
    g = auth.verify_google_token(req.id_token)
    if not g:
        raise HTTPException(401, "Invalid Google token")
    if not g.get("email_verified"):
        raise HTTPException(401, "Email not verified by Google")
    email = g["email"].lower()
    if email not in config.ALLOWLIST:
        raise HTTPException(403, "Invite-only. Ask Hjalti to add you.")
    user = db.ensure_user(email)
    db.update_login(user["id"], g.get("name", ""), g.get("avatar_url", ""))
    return {"jwt": auth.create_jwt(user["id"], email),
            "user": db.get_user_by_id(user["id"])}


def _user_roster(user: dict) -> dict:
    """The roster as THIS user sees it (spec 217 Promise 1): the shared
    Tier-0 personas, plus the logged-in player's own private persona —
    visible in their lobby and nobody else's."""
    roster = dict(_roster)
    own = _private_roster.get(user["email"])
    if own:
        roster[own.slug] = own
    return roster


@app.get("/api/personas")
def personas(user: dict = Depends(current_user)):
    return {"disclosure": config.DISCLOSURE,
            "personas": [{"slug": p.slug, "display_name": p.display_name,
                          "bio": p.bio, "private": p.private,
                          "strength_label": p.strength_label}
                         for p in _user_roster(user).values()]}


# --- game helpers ---

def _board_of(game: dict) -> chess.Board:
    board = chess.Board()
    for m in db.get_moves(game["id"]):
        board.push(chess.Move.from_uci(m["uci"]))
    return board


def _game_state(game: dict) -> dict:
    moves = db.get_moves(game["id"])
    board = chess.Board()
    for m in moves:
        board.push(chess.Move.from_uci(m["uci"]))
    return {"id": game["id"], "persona": game["persona"],
            "player_color": game["player_color"], "status": game["status"],
            "result": game["result"], "result_reason": game["result_reason"],
            "fen": board.fen(), "disclosure": config.DISCLOSURE,
            "clock": _clock_state(game, board),
            "moves": [{"ply": m["ply"], "uci": m["uci"], "san": m["san"],
                       "mover": m["mover"], "arm": m["arm"]} for m in moves]}


# --- clock helpers (spec 217 Tier 1: clocks with increment) ---
#
# Server-authoritative, lazily adjudicated: white_ms/black_ms are the
# remaining time when turn_started_at was stamped, and the side to move burns
# wall-clock from there. No background timer exists at family scale — an
# expired flag falls on the next request that looks at the game (move, GET,
# resume), which is exactly when anyone can observe it.

def _side_to_move(board: chess.Board) -> str:
    return "white" if board.turn == chess.WHITE else "black"


def _remaining_ms(game: dict, color: str) -> int:
    """True remaining time for the side to move, right now."""
    stored = game["white_ms" if color == "white" else "black_ms"]
    elapsed = int((time.time() - game["turn_started_at"]) * 1000)
    return stored - elapsed


def _flag_fall(game_id: int, color: str) -> None:
    """`color` lost on time — flag = loss (spec 217 Tier 1), no increment."""
    db.set_clock(game_id, color, 0, None)
    db.finish_game(game_id, "0-1" if color == "white" else "1-0", "flag")


def _flag_if_overdue(game: dict, board: chess.Board) -> dict:
    """Adjudicate an expired clock on an active game; returns the (possibly
    finished) fresh game row. The clock keeps running while the player is
    away — resume restores the position AND the honest clock, it never
    pauses it."""
    if game["status"] != "active" or game["clock_initial_s"] is None:
        return game
    color = _side_to_move(board)
    if _remaining_ms(game, color) <= 0:
        _flag_fall(game["id"], color)
        return db.get_game(game["id"])
    return game


def _clock_state(game: dict, board: chess.Board) -> Optional[dict]:
    """Wire shape: remaining ms per side already adjusted to *now*, so the
    client only counts down locally from the response — it never needs the
    server's turn_started_at (no clock-skew arithmetic client-side)."""
    if game["clock_initial_s"] is None:
        return None
    white_ms, black_ms = game["white_ms"], game["black_ms"]
    running = None
    if game["status"] == "active" and game["turn_started_at"] is not None:
        running = _side_to_move(board)
        rem = max(0, _remaining_ms(game, running))
        if running == "white":
            white_ms = rem
        else:
            black_ms = rem
    return {"initial_s": game["clock_initial_s"],
            "increment_s": game["clock_increment_s"],
            "white_ms": white_ms, "black_ms": black_ms, "running": running}


def _finish_if_over(game_id: int, board: chess.Board) -> bool:
    o = board.outcome(claim_draw=True)
    if o is None:
        return False
    db.finish_game(game_id, o.result(), o.termination.name.lower())
    return True


def _persona_of(game: dict) -> persona_mod.Persona:
    """Resolve a game's persona: the shared roster, or — for a private slug —
    the game owner's own persona. 503 (not 500) if the artifacts vanished
    between deploys: the game stays active and resumable, same contract as an
    engine stall."""
    p = _roster.get(game["persona"])
    if p:
        return p
    owner = db.get_user_by_id(game["user_id"])
    own = _private_roster.get(owner["email"]) if owner else None
    if own and own.slug == game["persona"]:
        return own
    raise HTTPException(503, f"Persona '{game['persona']}' unavailable")


def _engine_for(p: persona_mod.Persona) -> Lc0Search:
    """BT3 by default; a Maia-backed private persona gets its own warm lc0,
    spawned on first use (only under _move_lock) so a lobby that never plays
    the private persona never pays the net load."""
    if not p.net_path:
        return _engine
    eng = _maia_engines.get(p.net_path)
    if eng is None:
        eng = _maia_engines[p.net_path] = Lc0Search(p.net_path)
    return eng


def _persona_reply(game: dict, board: chess.Board) -> None:
    p = _persona_of(game)
    with _move_lock:
        move, arm, log = persona_mod.select_move(p, board, game["seed"],
                                                 _engine_for(p))
    # The persona plays under the same clock rules as the player: its think
    # time (including any _move_lock queue wait) burns its clock, and if the
    # search outlasts the flag, the flag wins — the computed move is thrown
    # away, exactly as an arbiter would rule.
    if game["clock_initial_s"] is not None:
        color = _side_to_move(board)
        rem = _remaining_ms(game, color)
        if rem <= 0:
            _flag_fall(game["id"], color)
            return
        db.set_clock(game["id"], color,
                     rem + game["clock_increment_s"] * 1000, time.time())
    san = board.san(move)
    ply = board.ply()
    board.push(move)
    db.add_move(game["id"], ply, move.uci(), san, "persona", arm, log)
    _finish_if_over(game["id"], board)


def _own_active_game(game_id: int, user: dict) -> dict:
    game = db.get_game(game_id)
    if not game or game["user_id"] != user["id"]:
        raise HTTPException(404, "Game not found")
    return game


# --- game routes ---

@app.post("/api/game")
def create_game(req: CreateGameRequest, user: dict = Depends(current_user)):
    # Per-user roster: another user's private persona is "unknown" here, not
    # forbidden — its existence is itself private (spec 217 Promise 1).
    if req.persona not in _user_roster(user):
        raise HTTPException(400, f"Unknown persona: {req.persona}")
    if req.player_color not in ("white", "black"):
        raise HTTPException(400, "player_color must be 'white' or 'black'")
    if req.clock_initial_s is None:
        if req.clock_increment_s is not None:
            raise HTTPException(400, "clock_increment_s needs clock_initial_s")
    else:
        if not (CLOCK_INITIAL_MIN_S <= req.clock_initial_s
                <= CLOCK_INITIAL_MAX_S):
            raise HTTPException(
                400, f"clock_initial_s must be {CLOCK_INITIAL_MIN_S}-"
                     f"{CLOCK_INITIAL_MAX_S}")
        if not (0 <= (req.clock_increment_s or 0) <= CLOCK_INCREMENT_MAX_S):
            raise HTTPException(
                400, f"clock_increment_s must be 0-{CLOCK_INCREMENT_MAX_S}")
    seed = random.SystemRandom().randrange(2**31)
    # White's clock starts at creation — including the persona's, when the
    # player takes Black and the persona opens.
    game_id = db.create_game(user["id"], req.persona, req.player_color, seed,
                             req.clock_initial_s, req.clock_increment_s,
                             time.time() if req.clock_initial_s else None)
    game = db.get_game(game_id)
    if req.player_color == "black":
        try:
            _persona_reply(game, chess.Board())
        except EngineStall as e:
            raise HTTPException(503, str(e))
    # Re-fetch: _persona_reply may have finished the game (with clocks it
    # can flag on the very first move) — never answer from the stale row.
    return _game_state(db.get_game(game_id))


@app.get("/api/games")
def my_games(user: dict = Depends(current_user)):
    return {"games": db.list_games(user["id"])}


@app.get("/api/stats")
def my_stats(user: dict = Depends(current_user)):
    """Spec 217 Tier 1: per-opponent W/D/L history for the logged-in player.
    Aggregated in SQL (db.wdl_by_persona); finished games only, scoped to
    this user — one row per persona faced."""
    return {"records": db.wdl_by_persona(user["id"])}


@app.get("/api/game/{game_id}")
def get_game(game_id: int, user: dict = Depends(current_user)):
    game = _own_active_game(game_id, user)
    if game["status"] == "active":
        # Resume path: if a persona reply is pending (e.g. a prior engine
        # stall answered 503 after persisting the player move), play it now.
        board = _board_of(game)
        # Expired clock first (either side's): the flag fell while nobody was
        # looking; adjudicate before asking the engine for anything.
        game = _flag_if_overdue(game, board)
        if game["status"] != "active":
            return _game_state(game)
        persona_turn = (board.turn == chess.WHITE) != (game["player_color"]
                                                       == "white")
        if persona_turn and not board.is_game_over(claim_draw=True):
            try:
                _persona_reply(game, board)
            except EngineStall as e:
                raise HTTPException(503, str(e))
            # _persona_reply may finish the game (mate, or its own flag) —
            # re-fetch so the row we answer from is never stale.
            game = db.get_game(game_id)
    return _game_state(game)


@app.post("/api/game/{game_id}/move")
def play_move(game_id: int, req: MoveRequest,
              user: dict = Depends(current_user)):
    game = _own_active_game(game_id, user)
    if game["status"] != "active":
        raise HTTPException(409, "Game is finished")
    board = _board_of(game)
    player_is_white = game["player_color"] == "white"
    if board.turn != (chess.WHITE if player_is_white else chess.BLACK):
        raise HTTPException(409, "Not your turn")
    # The player's flag may have fallen before this move arrived — the flag
    # wins over the move (200 with the finished state, not an error: the
    # client just renders the loss).
    game = _flag_if_overdue(game, board)
    if game["status"] != "active":
        return _game_state(game)
    try:
        move = chess.Move.from_uci(req.uci)
    except ValueError:
        raise HTTPException(400, "Bad UCI move")
    if move not in board.legal_moves:
        raise HTTPException(400, "Illegal move")
    if game["clock_initial_s"] is not None:
        # Increment applied server-side on completing the move; the same
        # set_clock stamp starts the persona's clock.
        rem = _remaining_ms(game, "white" if player_is_white else "black")
        db.set_clock(game_id, "white" if player_is_white else "black",
                     rem + game["clock_increment_s"] * 1000, time.time())
    san = board.san(move)
    ply = board.ply()
    board.push(move)
    db.add_move(game_id, ply, req.uci, san, "player")  # persisted FIRST
    if not _finish_if_over(game_id, board):
        try:
            _persona_reply(db.get_game(game_id), board)
        except EngineStall as e:
            # Player move is already persisted; game resumes via GET+retry.
            raise HTTPException(503, f"Engine stalled, move saved: {e}")
    return _game_state(db.get_game(game_id))


@app.post("/api/game/{game_id}/resign")
def resign(game_id: int, user: dict = Depends(current_user)):
    game = _own_active_game(game_id, user)
    if game["status"] != "active":
        raise HTTPException(409, "Game is finished")
    result = "0-1" if game["player_color"] == "white" else "1-0"
    db.finish_game(game_id, result, "player resigned")
    return _game_state(db.get_game(game_id))


@app.post("/api/game/{game_id}/feedback")
def move_feedback(game_id: int, req: MoveFeedbackRequest,
                  user: dict = Depends(current_user)):
    """Spec 217 Promise 2: in-game "I would never do this" on a persona move
    (the spec-214 realism-feedback capture, ported). Move + persona are read
    back from the DB rather than trusted from the client, so a feedback row
    can never disagree with the game record it annotates. Works on active AND
    finished games — feedback is welcome while reviewing afterwards too."""
    game = _own_active_game(game_id, user)  # ownership check only (any status)
    target = next((m for m in db.get_moves(game_id) if m["ply"] == req.ply),
                  None)
    if target is None:
        raise HTTPException(400, f"No move at ply {req.ply}")
    if target["mover"] != "persona":
        raise HTTPException(400, "Feedback targets a persona move")
    fid = db.add_move_feedback(game_id, req.ply, target["uci"], target["san"],
                               game["persona"], req.note.strip())
    return {"id": fid, "game_id": game_id, "ply": req.ply}


@app.post("/api/game/{game_id}/realism")
def game_realism(game_id: int, req: GameRealismRequest,
                 user: dict = Depends(current_user)):
    """Spec 217 Tier 2: post-game "felt like him" verdict — whole-game
    realism, distinct from the per-move never-feedback above. One-tap on the
    game-over panel; finished games only (the verdict is about the completed
    game, not a position). Re-submitting updates the row — the retune wants
    the player's final read, not a vote history."""
    game = _own_active_game(game_id, user)  # ownership check (any status)
    if game["status"] != "finished":
        raise HTTPException(409, "Game not finished")
    if req.verdict not in ("felt_like", "did_not_feel_like"):
        raise HTTPException(400,
                            "verdict must be felt_like or did_not_feel_like")
    db.set_game_feedback(game_id, game["persona"], req.verdict,
                         req.note.strip())
    return {"game_id": game_id, "verdict": req.verdict}


@app.post("/api/game/{game_id}/share")
def share_game(game_id: int, user: dict = Depends(current_user)):
    """Spec 217 Tier 2: mint (or return) the read-only family replay token
    for a finished game. Idempotent — sharing twice hands back the same link.
    128-bit urlsafe token: the token IS the capability, so unguessable is the
    whole security model (family scale, revocable below, and deleting the
    game kills the link with it)."""
    game = _own_active_game(game_id, user)  # ownership check (any status)
    if game["status"] != "finished":
        raise HTTPException(409, "Game not finished")
    token = game["share_token"]
    if not token:
        token = secrets.token_urlsafe(16)
        db.set_share_token(game_id, token)
    return {"token": token}


@app.delete("/api/game/{game_id}/share")
def revoke_share(game_id: int, user: dict = Depends(current_user)):
    _own_active_game(game_id, user)  # ownership check (any status)
    db.clear_share_token(game_id)
    return {"revoked": game_id}


@app.get("/api/replay/{token}")
def shared_replay(token: str):
    """Read-only replay by share token — deliberately NO auth (spec 217
    Tier 2: 'replay links shareable in the family', recipients have no
    login). Finished games only ever carry a token; 404 covers unknown,
    revoked, and deleted alike so the response never confirms whether a
    guessed token once existed. Exposes the game record only — no user id,
    email, seed, or decision logs."""
    game = db.get_game_by_share_token(token)
    if not game or game["status"] != "finished":
        raise HTTPException(404, "Replay not found")
    owner = db.get_user_by_id(game["user_id"])
    return {"persona": game["persona"],
            "player_color": game["player_color"],
            "player_name": (owner or {}).get("name") or "",
            "result": game["result"],
            "result_reason": game["result_reason"],
            "created_at": game["created_at"],
            "moves": [{"ply": m["ply"], "uci": m["uci"], "san": m["san"],
                       "mover": m["mover"], "arm": m["arm"]}
                      for m in db.get_moves(game["id"])]}


@app.delete("/api/game/{game_id}")
def delete_game(game_id: int, user: dict = Depends(current_user)):
    _own_active_game(game_id, user)
    db.delete_game(game_id)
    return {"deleted": game_id}
