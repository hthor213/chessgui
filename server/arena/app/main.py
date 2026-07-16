"""Persona Arena Tier-0 move API (spec 217).

Routes (all /api/* behind JWT except /health and /api/auth/google-login):
  POST /api/auth/google-login {id_token}      -> {jwt, user}   (invite-only)
  GET  /api/personas                          -> Tier-0 roster + disclosure
  POST /api/game {persona, player_color}      -> game state (persona moves
                                                 first if it has White)
  GET  /api/games                             -> my games
  GET  /api/game/{id}                         -> full state (resume)
  POST /api/game/{id}/move {uci}              -> player move + persona reply
  POST /api/game/{id}/resign                  -> resign
  DELETE /api/game/{id}                       -> delete (spec: deletable on request)
"""

import hashlib
import os
import random
import threading
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


class CreateGameRequest(BaseModel):
    persona: str
    player_color: str  # 'white' | 'black'


class MoveRequest(BaseModel):
    uci: str


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
            "moves": [{"ply": m["ply"], "uci": m["uci"], "san": m["san"],
                       "mover": m["mover"], "arm": m["arm"]} for m in moves]}


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
    seed = random.SystemRandom().randrange(2**31)
    game_id = db.create_game(user["id"], req.persona, req.player_color, seed)
    game = db.get_game(game_id)
    if req.player_color == "black":
        try:
            _persona_reply(game, chess.Board())
        except EngineStall as e:
            raise HTTPException(503, str(e))
    return _game_state(game)


@app.get("/api/games")
def my_games(user: dict = Depends(current_user)):
    return {"games": db.list_games(user["id"])}


@app.get("/api/game/{game_id}")
def get_game(game_id: int, user: dict = Depends(current_user)):
    game = _own_active_game(game_id, user)
    if game["status"] == "active":
        # Resume path: if a persona reply is pending (e.g. a prior engine
        # stall answered 503 after persisting the player move), play it now.
        board = _board_of(game)
        persona_turn = (board.turn == chess.WHITE) != (game["player_color"]
                                                       == "white")
        if persona_turn and not board.is_game_over(claim_draw=True):
            try:
                _persona_reply(game, board)
            except EngineStall as e:
                raise HTTPException(503, str(e))
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
    try:
        move = chess.Move.from_uci(req.uci)
    except ValueError:
        raise HTTPException(400, "Bad UCI move")
    if move not in board.legal_moves:
        raise HTTPException(400, "Illegal move")
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


@app.delete("/api/game/{game_id}")
def delete_game(game_id: int, user: dict = Depends(current_user)):
    _own_active_game(game_id, user)
    db.delete_game(game_id)
    return {"deleted": game_id}
