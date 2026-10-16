"""Environment-backed operational-prototype configuration.

Demo is an explicit NO-SECURITY authentication bypass for isolated local use.
Required mode fails closed without explicit credentials and a strong secret.
Neither mode establishes clinical validation or certification.
"""

from __future__ import annotations

import os
import math
import secrets
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent


def env(name: str, default: str) -> str:
    return os.getenv(name, default).strip()


AUTH_MODE = env("COLDCHAIN_AUTH_MODE", "demo").lower()
_EPHEMERAL_SECRET = secrets.token_urlsafe(48)
SECRET_KEY = env("COLDCHAIN_SECRET_KEY", _EPHEMERAL_SECRET if AUTH_MODE == "demo" else "")
DB_PATH = Path(env("COLDCHAIN_DB_PATH", str(BASE_DIR / "data" / "coldchain.db")))
TOKEN_TTL_SECONDS = int(env("COLDCHAIN_TOKEN_TTL_SECONDS", "3600"))
DEMO_USERNAME = env("COLDCHAIN_DEMO_USERNAME", "demo-operator" if AUTH_MODE == "demo" else "")
DEMO_PASSWORD = env("COLDCHAIN_DEMO_PASSWORD", "demo-password-change-me" if AUTH_MODE == "demo" else "")
# Local convenience identity keeps the existing all-controls demo usable;
# deployments should set this and COLDCHAIN_AUTH_MODE explicitly.
DEMO_ROLE = env("COLDCHAIN_DEMO_ROLE", "admin")

WEATHER_PROVIDER = env("COLDCHAIN_WEATHER_PROVIDER", "deterministic").lower()
WEATHER_LATITUDE = float(env("COLDCHAIN_WEATHER_LATITUDE", "0"))
WEATHER_LONGITUDE = float(env("COLDCHAIN_WEATHER_LONGITUDE", "0"))
WEATHER_TIMEOUT_SECONDS = float(env("COLDCHAIN_WEATHER_TIMEOUT_SECONDS", "3"))
TELEMETRY_STALE_SECONDS = int(env("COLDCHAIN_TELEMETRY_STALE_SECONDS", "900"))
WEATHER_CACHE_SECONDS = int(env("COLDCHAIN_WEATHER_CACHE_SECONDS", "300"))
ALERT_ESCALATION_SECONDS = int(env("COLDCHAIN_ALERT_ESCALATION_SECONDS", "300"))
WORKER_INTERVAL_SECONDS = float(env("COLDCHAIN_WORKER_INTERVAL_SECONDS", "5"))
HIGH_TEMP_ALARM_C = float(env("COLDCHAIN_HIGH_TEMP_ALARM_C", "6.0"))


def validate() -> None:
    """Fail before serving; configuration remains monkeypatchable in tests."""
    if AUTH_MODE not in {"demo", "required"}:
        raise ValueError("COLDCHAIN_AUTH_MODE must be demo or required")
    if DEMO_ROLE not in {"admin", "grid_operator", "clinic_operator", "auditor"}:
        raise ValueError("COLDCHAIN_DEMO_ROLE is invalid")
    if AUTH_MODE == "required":
        if not DEMO_USERNAME or DEMO_USERNAME == "demo-operator":
            raise ValueError("Required mode needs an explicit COLDCHAIN_DEMO_USERNAME (not the demo identity)")
        if len(DEMO_PASSWORD) < 12 or DEMO_PASSWORD == "demo-password-change-me":
            raise ValueError("Required mode needs an explicit COLDCHAIN_DEMO_PASSWORD of at least 12 characters")
        if SECRET_KEY == _EPHEMERAL_SECRET or len(SECRET_KEY) < 32 or len(set(SECRET_KEY)) < 12:
            raise ValueError("Required mode needs a strong explicit COLDCHAIN_SECRET_KEY (32+ characters)")
    if TOKEN_TTL_SECONDS <= 0 or TELEMETRY_STALE_SECONDS <= 0 or ALERT_ESCALATION_SECONDS <= 0:
        raise ValueError("Token, telemetry, and escalation durations must be positive")
    if not 1 <= WORKER_INTERVAL_SECONDS <= 60 or not 0 < WEATHER_TIMEOUT_SECONDS <= 10:
        raise ValueError("Worker interval must be 1..60 seconds and weather timeout 0..10 seconds")
    if WEATHER_CACHE_SECONDS < 1:
        raise ValueError("Weather cache duration must be positive")
    if not math.isfinite(HIGH_TEMP_ALARM_C) or not 2 <= HIGH_TEMP_ALARM_C < 8:
        raise ValueError("COLDCHAIN_HIGH_TEMP_ALARM_C must be finite and in the range 2..8 (exclusive of 8)")
    if not math.isfinite(WEATHER_LATITUDE) or not -90 <= WEATHER_LATITUDE <= 90:
        raise ValueError("Invalid weather latitude")
    if not math.isfinite(WEATHER_LONGITUDE) or not -180 <= WEATHER_LONGITUDE <= 180:
        raise ValueError("Invalid weather longitude")


def ensure_config_dirs() -> None:
    """Create only the local persistence parent directory when needed."""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
