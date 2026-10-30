"""Small dependency-free signed bearer token and password boundary."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from dataclasses import dataclass
from typing import Any, Callable

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from . import config

try:
    import bcrypt
except ImportError:  # local minimal environments can still verify legacy records
    bcrypt = None

ROLES = {"clinic_operator", "grid_operator", "admin", "authority", "auditor"}
_bearer = HTTPBearer(auto_error=False)


@dataclass(frozen=True)
class Principal:
    username: str
    role: str
    user_id: int | None = None
    clinic_id: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {"username": self.username, "role": self.role, "user_id": self.user_id, "clinic_id": self.clinic_id}


def hash_password(password: str, iterations: int = 310_000) -> str:
    if bcrypt is not None:
        return "bcrypt$" + bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode("ascii")
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations)
    return f"pbkdf2_sha256${iterations}${_b64(salt)}${_b64(digest)}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        if encoded.startswith("bcrypt$"):
            return bcrypt is not None and bcrypt.checkpw(password.encode(), encoded[7:].encode("ascii"))
        algorithm, iteration_text, salt_text, digest_text = encoded.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        iterations = int(iteration_text)
        expected = _unb64(digest_text)
        actual = hashlib.pbkdf2_hmac("sha256", password.encode(), _unb64(salt_text), iterations)
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _unb64(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def issue_token(principal: Principal) -> str:
    now = int(time.time())
    header = {"alg": "HS256", "typ": "JWT"}
    payload = {"sub": principal.username, "role": principal.role, "uid": principal.user_id, "cid": principal.clinic_id, "iat": now,
               "exp": now + config.TOKEN_TTL_SECONDS}
    encoded_header = _b64(json.dumps(header, separators=(",", ":")).encode())
    encoded_payload = _b64(json.dumps(payload, separators=(",", ":")).encode())
    message = f"{encoded_header}.{encoded_payload}".encode()
    signature = hmac.new(config.SECRET_KEY.encode(), message, hashlib.sha256).digest()
    return f"{encoded_header}.{encoded_payload}.{_b64(signature)}"


def decode_token(token: str) -> Principal:
    try:
        if len(token) > 8192:
            raise ValueError("token too long")
        encoded_header, encoded_payload, encoded_signature = token.split(".", 2)
        message = f"{encoded_header}.{encoded_payload}".encode()
        expected = hmac.new(config.SECRET_KEY.encode(), message, hashlib.sha256).digest()
        if not hmac.compare_digest(expected, _unb64(encoded_signature)):
            raise ValueError("invalid signature")
        header = json.loads(_unb64(encoded_header))
        payload = json.loads(_unb64(encoded_payload))
        if not isinstance(header, dict) or not isinstance(payload, dict):
            raise ValueError("invalid token structure")
        if header.get("alg") != "HS256" or int(payload.get("exp", 0)) <= int(time.time()):
            raise ValueError("expired token")
        role = str(payload["role"])
        if role not in ROLES:
            raise ValueError("unknown role")
        clinic_id = payload.get("cid")
        return Principal(username=str(payload["sub"]), role=role, user_id=payload.get("uid"), clinic_id=str(clinic_id) if clinic_id else None)
    except (ValueError, KeyError, TypeError, OverflowError, json.JSONDecodeError, UnicodeDecodeError):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired bearer token")


def current_principal(request: Request, credentials: HTTPAuthorizationCredentials | None = Depends(_bearer)) -> Principal:
    if credentials is None:
        if config.AUTH_MODE == "demo":
            role = config.DEMO_ROLE if config.DEMO_ROLE in ROLES else "clinic_operator"
            return Principal(config.DEMO_USERNAME, role, clinic_id=None)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Bearer token required")
    principal = decode_token(credentials.credentials)
    store = request.app.state.get_storage()
    user = store.user_by_username(principal.username)
    if (not user or user["id"] != principal.user_id or user["role"] not in ROLES
            or (config.AUTH_MODE == "required" and principal.username == "demo-operator")):
        raise HTTPException(status_code=401, detail="User is inactive or unavailable")
    return Principal(user["username"], user["role"], user["id"], user.get("clinic_id"))


def require_roles(*roles: str) -> Callable[..., Principal]:
    allowed = set(roles)
    if not allowed.issubset(ROLES):
        raise ValueError(f"unsupported role in policy: {allowed - ROLES}")

    def dependency(principal: Principal = Depends(current_principal)) -> Principal:
        if principal.role not in allowed and not (principal.role == "authority" and "admin" in allowed):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Role is not permitted for this operation")
        return principal

    return dependency
