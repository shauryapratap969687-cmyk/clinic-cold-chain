"""Deterministic, thread-safe live simulation state."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import copy
import math
from pathlib import Path
from threading import RLock
from typing import Any

import numpy as np
import pandas as pd

from .features import build_feature_row
from .model import calibrated_probability
from . import config
from .thermal import THERMAL_HORIZON_HOURS, THERMAL_MODEL_VERSION, forecast_temperature, thermal_step, unavailable_forecast


class Simulation:
    """A manually advanced cold-chain simulation with shared feeder physics."""

    def __init__(self, bundle: dict[str, Any] | None = None, seed: int = 42) -> None:
        self.bundle = bundle
        self.model_available = bundle is not None
        self.seed = seed
        self._lock = RLock()
        self.clinic_facts = self._load_clinic_facts()
        self.reset()

    @staticmethod
    def _load_clinic_facts() -> dict[str, dict[str, Any]]:
        """Load simulated v3 backup and travel facts without requiring the CSV."""
        path = Path(__file__).resolve().parents[1] / "datasets" / "clinic_cold_chain_v3" / "clinics.csv"
        if not path.is_file():
            return {}
        try:
            frame = pd.read_csv(path)
        except (OSError, ValueError):
            return {}
        facts: dict[str, dict[str, Any]] = {}
        for row in frame.to_dict("records"):
            clinic_id = f"CL-{int(row['clinic_id']):02d}"
            distance = float(row.get("distance_from_hub_km", 0.0) or 0.0)
            facts[clinic_id] = {
                "distance_from_hub_km": distance,
                "travel_time_h": round(distance / 25.0, 2),
                "has_backup": bool(row.get("has_backup", 0)),
                "backup_runtime_full_h": float(row.get("backup_runtime_full_h", 0.0) or 0.0),
            }
        return facts

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
                facts = self.clinic_facts.get(clinic_id, {})
                insulation_tau_hours = float(self.rng.uniform(20.0, 28.0))
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
                    "ambient_temp_c": 22.0,
                    "door_open": False,
                    "door_open_minutes": 0.0,
                    "door_open_remaining_hours": 0,
                    "cooling_failure": False,
                    "compressor_on": True,
                    "compressor_duty": 0.4,
                    "insulation_tau_hours": insulation_tau_hours,
                    "thermal_model": THERMAL_MODEL_VERSION,
                    "distance_from_hub_km": float(facts.get("distance_from_hub_km", 5.0 + index * 4.0)),
                    "travel_time_h": float(facts.get("travel_time_h", (5.0 + index * 4.0) / 25.0)),
                    "has_backup": bool(facts.get("has_backup", False)),
                    "backup_runtime_full_h": float(facts.get("backup_runtime_full_h", 0.0)),
                    "sms_state": "normal",
                    "sms_alert_id": None,
                    "sms_sent_at": None,
                    "sms_reply": None,
                    "sms_reply_at": None,
                    "sms_message": None,
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
            if clinic.get("door_open_remaining_hours", 0) > 0:
                clinic["door_open_remaining_hours"] -= 1
                door_minutes = float(self.rng.uniform(8.0, 30.0))
            elif self.rng.random() < 0.08:
                duration = int(self.rng.integers(1, 3))
                clinic["door_open_remaining_hours"] = duration - 1
                door_minutes = float(self.rng.uniform(8.0, 30.0))
            else:
                door_minutes = 0.0
            clinic["door_open_minutes"] = round(door_minutes, 2)
            clinic["door_open"] = bool(door_minutes > 0)
            clinic["cooling_failure"] = bool(clinic["local_fault"])
            step = thermal_step(
                current,
                outdoor,
                power_on=clinic["power_on"],
                cooling_failure=clinic["cooling_failure"],
                freeze_active=clinic["freeze_active"],
                door_open_minutes=door_minutes,
                insulation_tau_hours=clinic["insulation_tau_hours"],
                noise_c=float(self.rng.normal(0, 0.08)),
            )
            clinic["temperature_c"] = round(float(step["temperature_c"]), 3)
            clinic["ambient_temp_c"] = round(float(outdoor), 3)
            clinic["compressor_on"] = bool(step["compressor_on"])
            clinic["compressor_duty"] = float(step["compressor_duty"])
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
            for index, clinic in enumerate(self.clinics.values()):
                clinic.setdefault("clinic_index", index)
                clinic.setdefault("ambient_temp_c", 22.0)
                clinic.setdefault("door_open", False)
                clinic.setdefault("door_open_minutes", 0.0)
                clinic.setdefault("door_open_remaining_hours", 0)
                clinic.setdefault("cooling_failure", bool(clinic.get("local_fault", False)))
                clinic.setdefault("compressor_on", bool(clinic.get("power_on", True)))
                clinic.setdefault("compressor_duty", 0.4)
                clinic.setdefault("insulation_tau_hours", 24.0)
                clinic.setdefault("thermal_model", THERMAL_MODEL_VERSION)
                facts = self.clinic_facts.get(clinic["id"], {})
                clinic.setdefault("distance_from_hub_km", float(facts.get("distance_from_hub_km", 5.0 + index * 4.0)))
                clinic.setdefault("travel_time_h", float(facts.get("travel_time_h", (5.0 + index * 4.0) / 25.0)))
                clinic.setdefault("has_backup", bool(facts.get("has_backup", False)))
                clinic.setdefault("backup_runtime_full_h", float(facts.get("backup_runtime_full_h", 0.0)))
                clinic.setdefault("sms_state", "normal")
                clinic.setdefault("sms_alert_id", None)
                clinic.setdefault("sms_sent_at", None)
                clinic.setdefault("sms_reply", None)
                clinic.setdefault("sms_reply_at", None)
                clinic.setdefault("sms_message", None)
            self.feeder_online = {int(k): bool(v) for k, v in payload["feeder_online"].items()}
            self.feeder_observations = {int(k): v for k, v in payload.get("feeder_observations", {}).items()}
            self.external_mode = bool(payload.get("external_mode", False))

    def _enter_external_mode(self) -> None:
        if not self.external_mode:
            self.external_mode = True
            self.feeder_online = {number: True for number in range(1, 7)}
            for clinic in self.clinics.values():
                clinic.update(observed_at=None, source=None, local_fault=False, freeze_active=False,
                              power_on=False, sensor_power_on=False, outage_hours=0,
                              door_open=False, door_open_minutes=0.0, cooling_failure=False,
                              compressor_on=False, compressor_duty=0.0)

    def ingest_clinic(self, payload: dict[str, Any], observed_at: str) -> None:
        with self._lock:
            self._enter_external_mode()
            clinic = self.clinics[payload["clinic_id"]]
            clinic["temperature_lag1"] = clinic["temperature_c"]
            clinic.update({key: payload[key] for key in ("temperature_c", "humidity_pct", "local_fault", "outage_hours", "source")})
            clinic["sensor_power_on"] = payload["power_on"]
            clinic["power_on"] = bool(payload["power_on"] and not payload["local_fault"] and self.feeder_online[clinic["feeder_id"]])
            clinic["cooling_failure"] = bool(payload["local_fault"])
            clinic["door_open"] = False
            clinic["door_open_minutes"] = 0.0
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

    def _thermal_forecast(self, clinic: dict[str, Any], quality: str, ambient_temp_c: float) -> dict[str, Any]:
        horizon = config.THERMAL_FORECAST_HORIZON_HOURS
        if quality != "ok" or not math.isfinite(float(clinic.get("temperature_c", float("nan")))):
            return unavailable_forecast(f"Temperature telemetry is {quality}; no simulated countdown is shown.", horizon)
        future_ambient = [
            self._weather(self.timestamp + timedelta(hours=offset))[0]
            for offset in range(1, horizon + 1)
        ]
        forecast_seed = self.seed + int(clinic["clinic_index"]) * 1009 + int(self.timestamp.timestamp() // 3600)
        forecast = forecast_temperature(
            float(clinic["temperature_c"]),
            future_ambient,
            power_on=bool(clinic.get("power_on", True)),
            cooling_failure=bool(clinic.get("cooling_failure", False)),
            freeze_active=bool(clinic.get("freeze_active", False)),
            door_open_minutes=float(clinic.get("door_open_minutes", 0.0)),
            insulation_tau_hours=float(clinic.get("insulation_tau_hours", 24.0)),
            warning_limit_c=config.HIGH_TEMP_ALARM_C,
            seed=forecast_seed,
        )
        if self.external_mode:
            forecast["reliability"] = "unreliable"
            forecast["time_to_limit_hours"] = None
            forecast["time_to_warning_hours"] = None
            forecast["time_to_critical_hours"] = None
            forecast["limit_breach_direction"] = None
            forecast["note"] = "SIMULATED forecast is limited in external telemetry mode; no operational countdown is shown."
        forecast["measured_temperature_c"] = round(float(clinic["temperature_c"]), 2)
        forecast["ambient_temperature_c"] = round(float(ambient_temp_c), 2)
        forecast["data_source"] = "simulation"
        return forecast

    @staticmethod
    def _power_cut_status(forecast: dict[str, Any]) -> str:
        if forecast.get("reliability") != "reliable":
            return "Unknown"
        measured = forecast.get("current_temperature_c")
        if isinstance(measured, (int, float)) and (measured < 2 or measured > 8):
            return "Critical"
        if forecast.get("time_to_critical_hours") is not None:
            return "Critical"
        if forecast.get("time_to_warning_hours") is not None:
            return "Warning"
        return "Safe"

    def _power_cut_forecast(self, clinic: dict[str, Any], quality: str, ambient_temp_c: float) -> dict[str, Any]:
        """Estimate a hypothetical six-hour cut without mutating simulation state."""
        horizon = THERMAL_HORIZON_HOURS
        safe_range = {"low_c": 2.0, "high_c": 8.0}
        if quality != "ok" or not math.isfinite(float(clinic.get("temperature_c", float("nan")))):
            result = unavailable_forecast(f"Temperature telemetry is {quality}; no power-cut countdown is shown.", horizon)
            result.update({"scenario": "power_cut", "safe_range_c": safe_range, "power_cut_status": "Unknown"})
            return result
        future_ambient = [
            self._weather(self.timestamp + timedelta(hours=offset))[0]
            for offset in range(1, horizon + 1)
        ]
        forecast_seed = self.seed + int(clinic["clinic_index"]) * 1009 + int(self.timestamp.timestamp() // 3600) + 500_000
        forecast = forecast_temperature(
            float(clinic["temperature_c"]),
            future_ambient,
            power_on=False,
            cooling_failure=True,
            door_open_minutes=float(clinic.get("door_open_minutes", 0.0)),
            insulation_tau_hours=float(clinic.get("insulation_tau_hours", 24.0)),
            warning_limit_c=config.HIGH_TEMP_ALARM_C,
            seed=forecast_seed,
        )
        forecast.update({
            "scenario": "power_cut",
            "safe_range_c": safe_range,
            "configured_limit_c": float(config.HIGH_TEMP_ALARM_C),
            "current_temperature_c": round(float(clinic["temperature_c"]), 2),
            "ambient_temperature_c": round(float(ambient_temp_c), 2),
            "power_cut_status": self._power_cut_status({
                **forecast, "current_temperature_c": round(float(clinic["temperature_c"]), 2)
            }),
            "note": "SIMULATED power-cut estimate assumes the compressor is unavailable and heat enters through ambient exchange, insulation, and possible door openings.",
        })
        trajectory = forecast.get("trajectory", [])
        forecast["after_1h_c"] = trajectory[0]["temperature_c"] if len(trajectory) >= 1 else None
        forecast["after_2h_c"] = trajectory[1]["temperature_c"] if len(trajectory) >= 2 else None
        forecast["after_6h_c"] = trajectory[5]["temperature_c"] if len(trajectory) >= 6 else None
        if self.external_mode:
            forecast["reliability"] = "unreliable"
            forecast["time_to_limit_hours"] = None
            forecast["time_to_warning_hours"] = None
            forecast["time_to_critical_hours"] = None
            forecast["limit_breach_direction"] = None
            forecast["power_cut_status"] = "Unknown"
            forecast["note"] = "SIMULATED power-cut estimate is limited in external telemetry mode; no operational countdown is shown."
        return forecast

    def _holdover_hours(self, clinic: dict[str, Any], quality: str, ambient_temp_c: float) -> float | None:
        if quality != "ok":
            return None
        forecast = self._power_cut_forecast(clinic, quality, ambient_temp_c)
        value = forecast.get("time_to_critical_hours")
        if value is not None and math.isfinite(float(value)):
            return max(0.0, float(value))
        return float(forecast.get("horizon_hours", THERMAL_HORIZON_HOURS))

    @staticmethod
    def _backup_left(clinic: dict[str, Any]) -> float:
        if not clinic.get("has_backup"):
            return 0.0
        full = max(0.0, float(clinic.get("backup_runtime_full_h", 0.0)))
        if clinic.get("power_on"):
            return full
        if clinic.get("sms_state") == "backup_in_use":
            return max(0.0, full - float(clinic.get("outage_hours", 0.0)))
        return 0.0

    def _sync_sms_state(self, clinic: dict[str, Any], quality: str, ambient_temp_c: float) -> None:
        """Apply the v3 simulated SMS state rules to the live sandbox."""
        if quality != "ok":
            return
        if clinic.get("power_on"):
            clinic["sms_state"] = "normal"
            clinic["sms_message"] = None
            return
        if not clinic.get("has_backup"):
            if clinic.get("sms_state") == "normal":
                clinic["sms_state"] = "critical_no_sms"
            return
        if clinic.get("sms_state") == "normal":
            holdover = self._holdover_hours(clinic, quality, ambient_temp_c)
            hours_text = "unknown" if holdover is None else f"{holdover:.1f}"
            stamp = self.timestamp.isoformat().replace("+00:00", "Z")
            clinic["sms_state"] = "critical_unconfirmed"
            clinic["sms_alert_id"] = f"SMS-{clinic['id']}-{self.timestamp.strftime('%Y%m%d%H%M')}"
            clinic["sms_sent_at"] = stamp
            clinic["sms_reply"] = None
            clinic["sms_reply_at"] = None
            clinic["sms_message"] = (
                f"SIMULATED SMS: {clinic['id']} power is OFF. Fridge stays cold for about "
                f"{hours_text} h. Is backup power working? Reply 1 = YES, 2 = NO."
            )
        if clinic.get("sms_state") == "backup_in_use" and self._backup_left(clinic) <= 0:
            clinic["sms_state"] = "backup_exhausted"

    def reply_sms(self, clinic_id: str, reply: str) -> dict[str, Any]:
        """Apply a simulated one-tap backup reply and return the full state."""
        normalized = str(reply).strip().upper()
        if normalized in {"1", "YES", "Y"}:
            answer = "YES"
        elif normalized in {"2", "NO", "N"}:
            answer = "NO"
        else:
            raise ValueError("SMS reply must be 1/YES or 2/NO")
        with self._lock:
            if clinic_id not in self.clinics:
                raise KeyError(clinic_id)
            clinic = self.clinics[clinic_id]
            ambient = self._weather(self.timestamp)[0]
            self._sync_sms_state(clinic, "ok", ambient)
            if clinic.get("power_on"):
                raise ValueError("SMS reply is only active during a simulated outage")
            if not clinic.get("has_backup"):
                raise ValueError("This clinic has no simulated backup-power SMS workflow")
            clinic["sms_reply"] = answer
            clinic["sms_reply_at"] = self.timestamp.isoformat().replace("+00:00", "Z")
            clinic["sms_state"] = "backup_in_use" if answer == "YES" else "needs_help"
            return self.state()

    def _priority_view(self, clinic: dict[str, Any], power_cut_forecast: dict[str, Any], quality: str) -> dict[str, Any]:
        ambient = float(power_cut_forecast.get("ambient_temperature_c", self._weather(self.timestamp)[0]))
        holdover = self._holdover_hours(clinic, quality, ambient)
        travel = max(0.0, float(clinic.get("travel_time_h", 0.0)))
        full_backup = max(0.0, float(clinic.get("backup_runtime_full_h", 0.0))) if clinic.get("has_backup") else 0.0
        backup_left = self._backup_left(clinic)
        sms_state = str(clinic.get("sms_state", "normal"))
        if holdover is None:
            hours_until = None
            before_slack = None
            slack = None
        else:
            before_slack = holdover - travel
            effective_backup = full_backup if sms_state == "normal" else backup_left if sms_state == "backup_in_use" else 0.0
            hours_until = holdover + effective_backup
            slack = hours_until - travel
        power_source = "grid" if clinic.get("power_on") else "battery" if sms_state == "backup_in_use" else "none"
        battery_pct = 0.0
        if full_backup > 0 and power_source == "grid":
            battery_pct = 100.0
        elif full_backup > 0 and power_source == "battery":
            battery_pct = max(0.0, min(100.0, backup_left / full_backup * 100.0))
        return {
            "distance_from_hub_km": round(float(clinic.get("distance_from_hub_km", 0.0)), 1),
            "travel_time_h": round(travel, 2),
            "has_backup": bool(clinic.get("has_backup")),
            "power_source": power_source,
            "battery_pct": round(battery_pct, 1),
            "backup_runtime_full_h": round(full_backup, 1),
            "backup_runtime_left_h": round(backup_left, 1),
            "holdover_h": None if holdover is None else round(holdover, 2),
            "hours_until_unusable": None if hours_until is None else round(max(0.0, hours_until), 2),
            "hours_to_8c_priority": None if hours_until is None else round(max(0.0, hours_until), 2),
            "priority_slack_h": None if slack is None else round(slack, 2),
            "priority_slack_before_followup_h": None if before_slack is None else round(before_slack, 2),
            "sms_state": sms_state,
            "sms": {
                "state": sms_state,
                "alert_id": clinic.get("sms_alert_id"),
                "sent_at": clinic.get("sms_sent_at"),
                "message": clinic.get("sms_message"),
                "reply": clinic.get("sms_reply"),
                "reply_at": clinic.get("sms_reply_at"),
                "reply_options": ["YES", "NO"] if clinic.get("has_backup") and not clinic.get("power_on") else [],
                "simulated": True,
            },
            "priority_rank": None,
            "priority_rank_before_followup": None,
            "priority_source": "SIMULATED v3 clinic facts + live thermal holdover",
        }

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
        quality = self._quality(clinic.get("observed_at"))
        self._sync_sms_state(clinic, quality, outdoor)
        thermal_forecast = self._thermal_forecast(clinic, quality, outdoor)
        power_cut_forecast = self._power_cut_forecast(clinic, quality, outdoor)
        priority = self._priority_view(clinic, power_cut_forecast, quality)
        too_cold = float(clinic["temperature_c"]) < 2.0
        too_hot = float(clinic["temperature_c"]) > 8.0
        thermal_violation = too_cold or too_hot
        feeder_observation = self.feeder_observations.get(clinic["feeder_id"], {})
        outage_hours = max(float(clinic["outage_hours"]),
                           float(feeder_observation.get("outage_hours", 0)) if not observation["feeder_online"] else 0)
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
        elif high_temperature_warning or clinic.get("cooling_failure") or not clinic["power_on"] or outage_hours > 0 or (probability is not None and probability >= threshold):
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
        elif clinic.get("cooling_failure"):
            status = "Cooling failure"
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
            "ambient_temp_c": round(float(outdoor), 2) if quality != "missing" else None,
            "door_open": bool(clinic.get("door_open", False)) if quality == "ok" else False,
            "door_open_minutes": round(float(clinic.get("door_open_minutes", 0.0)), 2) if quality == "ok" else None,
            "cooling_failure": bool(clinic.get("cooling_failure", False)) if quality == "ok" else False,
            "compressor_on": bool(clinic.get("compressor_on", False)) if quality == "ok" else None,
            "compressor_duty": round(float(clinic.get("compressor_duty", 0.0)), 3) if quality == "ok" else None,
            "insulation_tau_hours": round(float(clinic.get("insulation_tau_hours", 24.0)), 2) if quality == "ok" else None,
            "thermal_model": THERMAL_MODEL_VERSION,
            "thermal_forecast": thermal_forecast,
            "power_cut_forecast": power_cut_forecast,
            "humidity_pct": clinic["humidity_pct"] if quality != "missing" else None,
            "feeder_online": observation["feeder_online"] if not self.external_mode or clinic["feeder_id"] in self.feeder_observations else None,
            "feeder_data_quality": self._quality(feeder_observation.get("observed_at")) if self.external_mode else "ok",
            "forecast_rain_next_6h": round(float(forecast_rain), 2) if not self.external_mode else None,
            "forecast_wind_next_6h": round(float(wind), 2) if not self.external_mode else None,
            "outage_hours": round(outage_hours, 2),
            "risk_probability": round(float(probability), 6) if probability is not None else None, "risk_level": level, "status": status,
            "risk_source": "calibrated_model" if model_available else "rules", "data_quality": quality,
            "source": clinic.get("source"), "observed_at": clinic.get("observed_at"),
            **priority,
        }

    def state(self) -> dict[str, Any]:
        with self._lock:
            clinics = [self._clinic_view(clinic) for clinic in self.clinics.values()]
            def priority_key(row: dict[str, Any], before_followup: bool = False) -> tuple[float, float, str]:
                field = "priority_slack_before_followup_h" if before_followup else "priority_slack_h"
                value = row.get(field)
                slack = float(value) if value is not None and math.isfinite(float(value)) else float("inf")
                distance = -float(row.get("distance_from_hub_km", 0.0) or 0.0)
                return slack, distance, str(row.get("id", ""))

            ranked = sorted(clinics, key=priority_key)
            before_ranked = sorted(clinics, key=lambda row: priority_key(row, True))
            for rank, clinic in enumerate(ranked, start=1):
                clinic["priority_rank"] = rank
            for rank, clinic in enumerate(before_ranked, start=1):
                clinic["priority_rank_before_followup"] = rank
            feeders = [{"id": feeder_id, "name": f"Feeder {feeder_id}", "online": bool(self.feeder_online[feeder_id]) if not self.external_mode or feeder_id in self.feeder_observations else None,
                        "source": self.feeder_observations.get(feeder_id, {}).get("source", "simulation" if not self.external_mode else None),
                        "observed_at": self.feeder_observations.get(feeder_id, {}).get("observed_at"),
                        "data_quality": self._quality(self.feeder_observations.get(feeder_id, {}).get("observed_at")) if self.external_mode else "ok",
                        "clinic_count": sum(c["feeder_id"] == feeder_id for c in self.clinics.values())}
                       for feeder_id in range(1, 7)]
            critical = sum(c["risk_level"] == "Critical" or c.get("temperature_alarm_level") == "critical" for c in clinics)
            warning = sum(c["risk_level"] == "Warning" or c.get("temperature_alarm_level") == "warning" or c.get("cooling_failure") or not c["power_on"] for c in clinics)
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
            sms_state_counts: dict[str, int] = {}
            for clinic in clinics:
                sms_state = str(clinic.get("sms_state", "normal"))
                sms_state_counts[sms_state] = sms_state_counts.get(sms_state, 0) + 1
            return {
                "timestamp": timestamp, "horizon_hours": config.THERMAL_FORECAST_HORIZON_HOURS,
                "model_ready": self.model_available,
                "telemetry_mode": "external" if self.external_mode else "simulation",
                "telemetry_status": "Telemetry stale" if stale_count or feeder_stale_count else "Telemetry current",
                "stale_sensor_count": stale_count,
                "stale_feeder_count": feeder_stale_count,
                 "summary": {"total_clinics": 20, "powered_clinics": powered, "total_feeders": 6,
                              "active_feeders": active_feeders, "critical_clinics": critical,
                              "warning_clinics": warning, "system_health": health,
                              "priority_policy": "hours until 8°C minus travel time; farther clinic wins ties",
                              "top_priority_clinic": ranked[0]["id"] if ranked else None,
                              "sms_state_counts": sms_state_counts},
                 "thermal_forecast": {"status": "SIMULATED", "thermal_model": THERMAL_MODEL_VERSION,
                                      "horizon_hours": config.THERMAL_FORECAST_HORIZON_HOURS,
                                      "note": "Physics-based temperature forecasts use synthetic scenario inputs."},
                  "feeders": feeders, "clinics": clinics,
                  "priority": {
                      "policy": "hours_until_unusable - travel_time_h",
                      "tie_breaker": "farther distance_from_hub_km first",
                      "simulated": True,
                      "clinics": [{"id": clinic["id"], "priority_rank": clinic["priority_rank"],
                                   "priority_rank_before_followup": clinic["priority_rank_before_followup"],
                                   "priority_slack_h": clinic["priority_slack_h"],
                                   "sms_state": clinic["sms_state"]} for clinic in ranked],
                  },
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
                clinic["cooling_failure"] = True
            elif action == "restore_clinic":
                clinic = self.clinics[clinic_id]
                clinic["local_fault"] = False
                clinic["freeze_active"] = False
                clinic["cooling_failure"] = False
                clinic["door_open"] = False
                clinic["door_open_minutes"] = 0.0
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
