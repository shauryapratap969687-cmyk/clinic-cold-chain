"""Optional Open-Meteo adapter with deterministic, offline-safe fallback."""

from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from threading import RLock
import time
from urllib.parse import urlencode
from urllib.request import Request, HTTPRedirectHandler, build_opener

from . import config

_lock = RLock()
_cache: dict[str, object] | None = None
_cache_key: tuple[object, ...] | None = None
_last_attempt = 0.0


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Weather redirects are not allowed")


def _fallback(now: datetime | None = None) -> dict[str, object]:
    stamp = now or datetime.now(timezone.utc)
    hour = stamp.hour + stamp.minute / 60
    day = stamp.timetuple().tm_yday
    result = {"provider": "deterministic", "source": "synthetic_context", "latitude": config.WEATHER_LATITUDE,
            "longitude": config.WEATHER_LONGITUDE, "temperature_c": round(22 + 7 * math.sin(2 * math.pi * hour / 24 - math.pi / 2), 2),
            "rain_mm": round(max(0.0, 11 + 8 * math.sin(2 * math.pi * day / 9)) if day % 7 == 0 else 0.0, 2),
            "wind_kmh": round(max(0.0, 12 + 5 * math.sin(2 * math.pi * hour / 24)), 2),
            "observed_at": stamp.isoformat().replace("+00:00", "Z"), "fallback": True,
            "cached_at": stamp.isoformat().replace("+00:00", "Z"), "stale": False}
    result["forecast_rain_next_6h"] = round(float(result["rain_mm"]) * 1.7, 2)
    result["forecast_wind_next_6h"] = result["wind_kmh"]
    return _with_sections(result)


def _with_sections(result: dict[str, object]) -> dict[str, object]:
    result["current"] = {key: result[key] for key in ("temperature_c", "rain_mm", "wind_kmh", "observed_at")}
    result["forecast6h"] = {"rain_mm": result["forecast_rain_next_6h"], "wind_max_kmh": result["forecast_wind_next_6h"]}
    result["context_only"] = True
    return result


def _number(value: object) -> float:
    result = float(value)
    if not math.isfinite(result):
        raise ValueError("Non-finite weather reading")
    return result


def get_weather() -> dict[str, object]:
    global _cache, _cache_key, _last_attempt
    if config.WEATHER_PROVIDER not in {"open-meteo", "openmeteo", "open_meteo"}:
        return _fallback()
    key = (config.WEATHER_PROVIDER, config.WEATHER_LATITUDE, config.WEATHER_LONGITUDE)
    with _lock:
        if key != _cache_key:
            _cache, _last_attempt, _cache_key = None, 0, key
        if _cache is not None and time.monotonic() - _last_attempt < config.WEATHER_CACHE_SECONDS:
            result = dict(_cache)
            age = (datetime.now(timezone.utc) - datetime.fromisoformat(str(result["observed_at"]).replace("Z", "+00:00"))).total_seconds()
            result["stale"] = bool(result["stale"] or age > max(1800, config.WEATHER_CACHE_SECONDS * 2))
            return result
        _last_attempt = time.monotonic()
        query = urlencode({"latitude": config.WEATHER_LATITUDE, "longitude": config.WEATHER_LONGITUDE,
                           "current": "temperature_2m,precipitation,wind_speed_10m",
                           "hourly": "precipitation,wind_speed_10m", "forecast_days": 2, "timezone": "UTC"})
        try:
            request = Request(f"https://api.open-meteo.com/v1/forecast?{query}", headers={"Accept": "application/json"})
            with build_opener(_NoRedirect()).open(request, timeout=min(10, config.WEATHER_TIMEOUT_SECONDS)) as response:
                data = json.loads(response.read(1_000_001).decode("utf-8"))
            current, hourly = data["current"], data["hourly"]
            observed = datetime.fromisoformat(str(current["time"]).replace("Z", "+00:00"))
            if observed.tzinfo is None:
                observed = observed.replace(tzinfo=timezone.utc)
            slots = [index for index, stamp in enumerate(hourly["time"])
                     if 0 < (datetime.fromisoformat(stamp).replace(tzinfo=timezone.utc) - observed).total_seconds() <= 21600]
            if len(slots) != 6:
                raise ValueError("Incomplete six-hour weather forecast")
            now = datetime.now(timezone.utc)
            result = _with_sections({"provider": "open-meteo", "source": "open-meteo", "latitude": config.WEATHER_LATITUDE,
                      "longitude": config.WEATHER_LONGITUDE, "temperature_c": _number(current["temperature_2m"]),
                      "rain_mm": _number(current["precipitation"]), "wind_kmh": _number(current["wind_speed_10m"]),
                      "observed_at": observed.isoformat().replace("+00:00", "Z"), "fallback": False,
                      "cached_at": now.isoformat().replace("+00:00", "Z"),
                      "stale": (now - observed).total_seconds() > max(1800, config.WEATHER_CACHE_SECONDS * 2),
                      "forecast_rain_next_6h": sum(_number(hourly["precipitation"][i]) for i in slots),
                      "forecast_wind_next_6h": max(_number(hourly["wind_speed_10m"][i]) for i in slots)})
            _cache = result
        except Exception as exc:
            result = dict(_cache) if _cache is not None else _fallback()
            result.update(fallback=True, stale=True, provider_error=type(exc).__name__)
            _cache = result
        return dict(result)
