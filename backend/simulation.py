"""Deterministic, thread-safe live simulation state."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import copy
import math
from threading import RLock
from typing import Any

import numpy as np
import pandas as pd

from .features import build_feature_row
from .model import calibrated_probability
from . import config


class Simulation:
    """A manually advanced cold-chain simulation with shared feeder physics."""

    def __init__(self, bundle: dict[str, Any] | None = None, seed: int = 42) -> None:
        self.bundle = bundle
        self.model_available = bundle is not None
        self.seed = seed
        self._lock = RLock()
        self.reset()

    def reset(self) -> dict[str, Any]:
        with self._lock:
            self.timestamp = pd.Timestamp("2025-01-01T08:00:00Z")
            self.rng = np.random.default_rng(self.seed)
            self.feeder_online = {number: True for number in range(1, 7)}
            self.external_mode = False
            self.feeder_observations: dict[int, dict[str, Any]] = {}
            self.clinics: dict[str, dict[str, Any]] = {}
            for index in range(20):
                clinic_id = f"CL-{index + 1:02d}"
                self.clinics[clinic_id] = {
                    "id": clinic_id,
                    "name": f"Clinic {index + 1}",
                    "feeder_id": index % 6 + 1,
                    "clinic_index": index,
                    "temperature_c": round(4.35 + float(self.rng.normal(0, 0.12)), 3),
                    "temperature_lag1": 4.35,
                    "humidity_pct": 66.0,
                    "local_fault": False,
                    "freeze_active": False,
                    "outage_hours": 0.0,
                    "power_on": True,
                    "sensor_power_on": True,
                    "source": "simulation",
                    "observed_at": datetime.now(timezone.utc).isoformat(),
                }
            return self.state()

    @staticmethod
    def _weather(timestamp: pd.Timestamp) -> tuple[float, float, float, float]:
        hour = timestamp.hour + timestamp.minute / 60
        outdoor = 22 + 7 * np.sin(2 * np.pi * hour / 24 - np.pi / 2) + 4 * np.sin(2 * np.pi * timestamp.dayofyear / 365)
        rain = max(0.0, 11 + 8 * np.sin(2 * np.pi * timestamp.dayofyear / 9)) if timestamp.dayofyear % 7 == 0 else 0.0
        wind = max(0.0, 12 + 5 * np.sin(2 * np.pi * hour / 24) + 2 * np.cos(timestamp.dayofyear))
        humidity = float(np.clip(64 + 12 * np.sin(2 * np.pi * hour / 24 + 0.4), 25, 98))
        return float(outdoor), float(rain), float(wind), humidity

    def _advance_one_hour(self) -> None:
        self.timestamp += timedelta(hours=1)
        outdoor, rain, wind, humidity = self._weather(self.timestamp)
        for clinic in self.clinics.values():
            feeder_online = self.feeder_online[clinic["feeder_id"]]
            clinic["temperature_lag1"] = clinic["temperature_c"]
            if not feeder_online or clinic["local_fault"]:
                clinic["outage_hours"] += 1
            else:
                clinic["outage_hours"] = 0.0
            clinic["power_on"] = bool(feeder_online and not clinic["local_fault"])
            current = float(clinic["temperature_c"])
            if clinic["freeze_active"]:
                target, rate = -1.0, 0.5
            elif not clinic["power_on"]:
                target, rate = 9.0, 0.25
            else:
                target, rate = 4.5 + 0.05 * (outdoor - 22), 0.16
            noise = float(self.rng.normal(0, 0.04))
            clinic["temperature_c"] = round(current + rate * (target - current) + noise, 3)
            clinic["humidity_pct"] = humidity

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return copy.deepcopy({"version": 1, "seed": self.seed, "timestamp": self.timestamp.isoformat(),
                                  "rng_state": self.rng.bit_generator.state, "clinics": self.clinics,
                                  "feeder_online": self.feeder_online, "external_mode": self.external_mode,
                                  "feeder_observations": self.feeder_observations})

    def restore_snapshot(self, payload: dict[str, Any]) -> None:
        with self._lock:
            if payload.get("version") != 1:
                raise ValueError("Unsupported runtime snapshot version")
            self.seed = int(payload["seed"])
            self.timestamp = pd.Timestamp(payload["timestamp"])
            self.rng = np.random.default_rng(self.seed)
            self.rng.bit_generator.state = payload["rng_state"]
            self.clinics = copy.deepcopy(payload["clinics"])
            self.feeder_online = {int(k): bool(v) for k, v in payload["feeder_online"].items()}
            self.feeder_observations = {int(k): v for k, v in payload.get("feeder_observations", {}).items()}
            self.external_mode = bool(payload.get("external_mode", False))

    def _enter_external_mode(self) -> None:
        if not self.external_mode:
            self.external_mode = True
            self.feeder_online = {number: True for number in range(1, 7)}
            for clinic in self.clinics.values():
                clinic.update(observed_at=None, source=None, local_fault=False, freeze_active=False,
                              power_on=False, sensor_power_on=False, outage_hours=0)

    def ingest_clinic(self, payload: dict[str, Any], observed_at: str) -> None:
        with self._lock:
            self._enter_external_mode()
            clinic = self.clinics[payload["clinic_id"]]
            clinic["temperature_lag1"] = clinic["temperature_c"]
            clinic.update({key: payload[key] for key in ("temperature_c", "humidity_pct", "local_fault", "outage_hours", "source")})
            clinic["sensor_power_on"] = payload["power_on"]
            clinic["power_on"] = bool(payload["power_on"] and not payload["local_fault"] and self.feeder_online[clinic["feeder_id"]])
            clinic["observed_at"] = observed_at

    def ingest_feeder(self, payload: dict[str, Any], observed_at: str) -> None:
        with self._lock:
            self._enter_external_mode()
            feeder_id = payload["feeder_id"]
            self.feeder_online[feeder_id] = payload["online"]
            self.feeder_observations[feeder_id] = {**payload, "observed_at": observed_at}
            for clinic in self.clinics.values():
                if clinic["feeder_id"] == feeder_id:
                    clinic["power_on"] = bool(payload["online"] and clinic["sensor_power_on"] and not clinic["local_fault"])

    @staticmethod
    def _quality(observed_at: str | None) -> str:
        if not observed_at:
            return "missing"
        stamp = datetime.fromisoformat(observed_at.replace("Z", "+00:00"))
        return "stale" if (datetime.now(timezone.utc) - stamp).total_seconds() > config.TELEMETRY_STALE_SECONDS else "ok"

    def _clinic_view(self, clinic: dict[str, Any]) -> dict[str, Any]:
        outdoor, rain, wind, _ = self._weather(self.timestamp)
        forecast_rain = max(0.0, rain * 1.7)
        observation = {
            **clinic,
            "outdoor_temp_c": outdoor,
            "forecast_rain_next_6h": forecast_rain,
            "forecast_wind_next_6h": wind,
            "feeder_online": self.feeder_online[clinic["feeder_id"]],
        }
        too_cold = float(clinic["temperature_c"]) < 2.0
        too_hot = float(clinic["temperature_c"]) > 8.0
        thermal_violation = too_cold or too_hot
        feeder_observation = self.feeder_observations.get(clinic["feeder_id"], {})
        outage_hours = max(float(clinic["outage_hours"]),
                           float(feeder_observation.get("outage_hours", 0)) if not observation["feeder_online"] else 0)
        quality = self._quality(clinic.get("observed_at"))
        high_temperature_warning = (quality == "ok"
                                     and float(clinic["temperature_c"]) > config.HIGH_TEMP_ALARM_C
                                     and not thermal_violation)
        temperature_alarm = quality == "ok" and (thermal_violation or high_temperature_warning)
        if quality != "ok":
            temperature_alarm_level = None
            temperature_alarm_message = f"Temperature telemetry {quality}; alarm status unknown"
        elif thermal_violation:
            temperature_alarm_level = "critical"
            temperature_alarm_message = "Temperature is outside the safe 2°C to 8°C range"
        elif high_temperature_warning:
            temperature_alarm_level = "warning"
            temperature_alarm_message = f"Temperature is above the {config.HIGH_TEMP_ALARM_C:g}°C early-warning threshold"
        else:
            temperature_alarm_level = None
            temperature_alarm_message = "Temperature is within the configured cold-chain range"
        model_available = (self.model_available and self.bundle is not None and not self.external_mode
                           and quality == "ok" and not thermal_violation)
        probability = None
        threshold = 0.5
        if model_available:
            try:
                probability = calibrated_probability(self.bundle, build_feature_row(observation, self.timestamp))
                threshold = float(self.bundle.get("threshold", 0.5))
                if not math.isfinite(probability) or not 0 <= probability <= 1 or not math.isfinite(threshold) or not 0 <= threshold <= 1:
                    raise ValueError("Invalid model probability or threshold")
            except Exception:
                # A damaged/unavailable artifact must not suppress safeguards.
                model_available = False
                self.model_available = False
        if not model_available:
            probability = None
        if quality != "ok":
            level = "Unknown"
        elif thermal_violation or (not model_available and outage_hours >= 2) or (probability is not None and probability >= max(0.5, threshold)):
            level = "Critical"
        elif high_temperature_warning or not clinic["power_on"] or outage_hours > 0 or (probability is not None and probability >= threshold):
            level = "Warning"
        else:
            level = "Safe"
        if quality != "ok":
            status = "Telemetry " + quality
        elif thermal_violation:
            status = "Cold-chain violation"
        elif not observation["feeder_online"]:
            status = "Feeder outage"
        elif clinic["local_fault"]:
            status = "Local fault"
        elif clinic["freeze_active"]:
            status = "Freeze event"
        elif high_temperature_warning:
            status = "High-temperature warning"
        elif level == "Warning":
            status = "Elevated risk"
        else:
            status = "Online"
        return {
            "id": clinic["id"], "name": clinic["name"], "feeder_id": clinic["feeder_id"],
            "power_on": bool(clinic["power_on"]), "local_fault": bool(clinic["local_fault"]),
            "temperature_c": round(float(clinic["temperature_c"]), 2) if quality != "missing" else None,
            "too_cold": too_cold if quality == "ok" else False,
            "too_hot": too_hot if quality == "ok" else False,
            "temperature_alarm": temperature_alarm,
            "temperature_alarm_level": temperature_alarm_level,
            "temperature_alarm_threshold_c": float(config.HIGH_TEMP_ALARM_C),
            "temperature_alarm_message": temperature_alarm_message,
            "humidity_pct": clinic["humidity_pct"] if quality != "missing" else None,
            "feeder_online": observation["feeder_online"] if not self.external_mode or clinic["feeder_id"] in self.feeder_observations else None,
            "feeder_data_quality": self._quality(feeder_observation.get("observed_at")) if self.external_mode else "ok",
            "forecast_rain_next_6h": round(float(forecast_rain), 2) if not self.external_mode else None,
            "forecast_wind_next_6h": round(float(wind), 2) if not self.external_mode else None,
            "outage_hours": round(outage_hours, 2),
            "risk_probability": round(float(probability), 6) if probability is not None else None, "risk_level": level, "status": status,
            "risk_source": "calibrated_model" if model_available else "rules", "data_quality": quality,
            "source": clinic.get("source"), "observed_at": clinic.get("observed_at"),
        }

    def state(self) -> dict[str, Any]:
        with self._lock:
            clinics = [self._clinic_view(clinic) for clinic in self.clinics.values()]
            feeders = [{"id": feeder_id, "name": f"Feeder {feeder_id}", "online": bool(self.feeder_online[feeder_id]) if not self.external_mode or feeder_id in self.feeder_observations else None,
                        "source": self.feeder_observations.get(feeder_id, {}).get("source", "simulation" if not self.external_mode else None),
                        "observed_at": self.feeder_observations.get(feeder_id, {}).get("observed_at"),
                        "data_quality": self._quality(self.feeder_observations.get(feeder_id, {}).get("observed_at")) if self.external_mode else "ok",
                        "clinic_count": sum(c["feeder_id"] == feeder_id for c in self.clinics.values())}
                       for feeder_id in range(1, 7)]
            critical = sum(c["risk_level"] == "Critical" or c.get("temperature_alarm_level") == "critical" for c in clinics)
            warning = sum(c["risk_level"] == "Warning" or c.get("temperature_alarm_level") == "warning" or not c["power_on"] for c in clinics)
            # Never count a stale last-known power reading as currently powered.
            powered = sum(c["power_on"] and c["data_quality"] == "ok" for c in clinics)
            active_feeders = sum(feeder["online"] is True and feeder["data_quality"] == "ok" for feeder in feeders)
            stale_count = sum(c["data_quality"] != "ok" for c in clinics)
            feeder_stale_count = sum(f["data_quality"] != "ok" for f in feeders)
            health = "Critical" if critical else ("Warning" if warning or active_feeders < 6 else "Healthy")
            if (stale_count or feeder_stale_count) and not critical:
                health = "Unknown"
            timestamp = self.timestamp.isoformat().replace("+00:00", "Z")
            if self.external_mode:
                stamps = [c["observed_at"] for c in clinics if c.get("observed_at")]
                stamps.extend(f["observed_at"] for f in feeders if f.get("observed_at"))
                timestamp = max(stamps) if stamps else timestamp
            return {
                "timestamp": timestamp, "horizon_hours": 6,
                "model_ready": self.model_available,
                "telemetry_mode": "external" if self.external_mode else "simulation",
                "telemetry_status": "Telemetry stale" if stale_count or feeder_stale_count else "Telemetry current",
                "stale_sensor_count": stale_count,
                "stale_feeder_count": feeder_stale_count,
                "summary": {"total_clinics": 20, "powered_clinics": powered, "total_feeders": 6,
                             "active_feeders": active_feeders, "critical_clinics": critical,
                             "warning_clinics": warning, "system_health": health},
                "feeders": feeders, "clinics": clinics,
            }

    def simulate(self, action: str, feeder_id: int | None = None, clinic_id: str | None = None,
                 hours: int | None = None) -> dict[str, Any]:
        with self._lock:
            if action == "reset":
                return self.reset()
            if self.external_mode:
                raise ValueError("External telemetry is active; explicitly reset before simulation changes")
            if action == "advance":
                for _ in range(hours or 1):
                    self._advance_one_hour()
            elif action == "trip_feeder":
                self.feeder_online[feeder_id] = False  # validated by API and direct callers can use valid IDs
                for clinic in self.clinics.values():
                    if clinic["feeder_id"] == feeder_id:
                        clinic["power_on"] = False
            elif action == "restore_feeder":
                self.feeder_online[feeder_id] = True
                for clinic in self.clinics.values():
                    if clinic["feeder_id"] == feeder_id and not clinic["local_fault"]:
                        clinic["outage_hours"] = 0.0
                        clinic["power_on"] = True
            elif action == "local_fault":
                clinic = self.clinics[clinic_id]
                clinic["local_fault"] = True
                clinic["power_on"] = False
            elif action == "restore_clinic":
                clinic = self.clinics[clinic_id]
                clinic["local_fault"] = False
                clinic["freeze_active"] = False
                clinic["power_on"] = self.feeder_online[clinic["feeder_id"]]
                if clinic["power_on"]:
                    clinic["outage_hours"] = 0.0
            elif action == "freeze_clinic":
                clinic = self.clinics[clinic_id]
                clinic["freeze_active"] = True
                clinic["temperature_lag1"] = clinic["temperature_c"]
                clinic["temperature_c"] = -0.5
            now = datetime.now(timezone.utc).isoformat()
            for clinic in self.clinics.values():
                clinic["observed_at"] = now
            return self.state()
