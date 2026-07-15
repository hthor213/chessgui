"""Google auth for the arena — ported from golf-trip-planner backend/api/auth.py
(same flow: verify Google ID token -> allowlist check -> issue HS256 JWT).
Invite-only per spec 217: an email not on the allowlist gets 403, never a
self-serve account."""

from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

import jwt
from google.oauth2 import id_token
from google.auth.transport import requests as google_requests

from . import config


def verify_google_token(token: str) -> Optional[Dict[str, Any]]:
    """Verify a Google ID token; return {email, name, avatar_url,
    email_verified} or None. Identical logic to the golf app."""
    if not config.GOOGLE_CLIENT_ID:
        return None
    try:
        idinfo = id_token.verify_oauth2_token(
            token, google_requests.Request(), config.GOOGLE_CLIENT_ID
        )
        if idinfo["iss"] not in ("accounts.google.com",
                                 "https://accounts.google.com"):
            return None
        return {
            "email": idinfo["email"],
            "name": idinfo.get("name", ""),
            "avatar_url": idinfo.get("picture", ""),
            "email_verified": idinfo.get("email_verified", False),
        }
    except Exception as e:  # noqa: BLE001 — same catch-all as the golf app
        print(f"[Auth] Google token verification failed: {e}")
        return None


def create_jwt(user_id: int, email: str) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "email": email,
        "iat": now,
        "exp": now + timedelta(days=config.JWT_EXPIRY_DAYS),
    }
    return jwt.encode(payload, config.JWT_SECRET,
                      algorithm=config.JWT_ALGORITHM)


def verify_jwt(token: str) -> Optional[Dict[str, Any]]:
    try:
        payload = jwt.decode(token, config.JWT_SECRET,
                             algorithms=[config.JWT_ALGORITHM])
        payload["sub"] = int(payload["sub"])
        return payload
    except jwt.InvalidTokenError as e:
        print(f"[Auth] Invalid JWT: {e}")
        return None
