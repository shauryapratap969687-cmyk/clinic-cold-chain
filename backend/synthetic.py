"""Reproducible physical-ish cold-chain telemetry generator."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from .features import build_feature_frame
from .thermal import thermal_step


@dataclass(frozen=True)
class SyntheticConfig:
    days: int = 240
    seed: int = 42
    clinics: int = 20
    feeders: int = 6


def _future_spoilage_labels(temperatures: np.ndarray, horizon: int = 6) -> np.ndarray:
    """Synthetic proxy: next horizon has a freeze or two-hour hot excursion."""
    unsafe_cold = temperatures < 2.0
    hot = temperatures > 8.0
    labels = np.zeros(len(temperatures), dtype=np.int8)
    # Current row is intentionally excluded: this is a next-6h prediction.
    for index in range(len(temperatures) - horizon):
        future_hot = hot[index + 1:index + horizon + 1]
        hot_pair = bool(np.any(future_hot[:-1] & future_hot[1:]))
        labels[index] = int(bool(np.any(unsafe_cold[index + 1:index + horizon + 1])) or hot_pair)
    return labels


def generate_dataset(config: SyntheticConfig | None = None, *, days: int | None = None,
                     seed: int | None = None) -> pd.DataFrame:
    """Generate hourly observations for 20 clinics and shared feeder faults.

    Feeder outages affect every clinic on that feeder.  Local faults and rare
    freezing events are independent.  The target is a documented synthetic
    proxy, not a clinical or regulatory spoilage determination.
    """
    if config is None:
        config = SyntheticConfig(days=240 if days is None else days, seed=42 if seed is None else seed)
    elif days is not None or seed is not None:
        config = SyntheticConfig(days=config.days if days is None else days,
                                 seed=config.seed if seed is None else seed,
                                 clinics=config.clinics, feeders=config.feeders)
    if not 180 <= config.days <= 365:
        raise ValueError("days must be between 180 and 365")
    n_hours = config.days * 24
    timestamps = pd.date_range("2025-01-01", periods=n_hours, freq="h", tz="UTC")
    feeder_for_clinic = np.arange(config.clinics) % config.feeders + 1
    # Weather is shared across the feeder network.  It is generated before
    # outages so the outage hazard can depend on the same rain/wind conditions
    # observed by every clinic on a feeder.  No day-of-week effect is used.
    shared_rng = np.random.default_rng([config.seed, 10_000])
    t = np.arange(n_hours)
    day_angle = 2 * np.pi * (t % 24) / 24
    year_angle = 2 * np.pi * t / (24 * 365)
    outdoor = 22 + 7 * np.sin(day_angle - np.pi / 2) + 4 * np.sin(year_angle) + shared_rng.normal(0, 1.2, n_hours)
    rain = np.clip(shared_rng.gamma(1.2, 3.0, n_hours) * (shared_rng.random(n_hours) < 0.10), 0, 45)
    wind = np.clip(10 + 5 * np.sin(day_angle) + shared_rng.normal(0, 3, n_hours), 0, 45)
    rain_stress = np.clip(rain / 12.0, 0, 4.0)
    wind_stress = np.clip((wind - 16.0) / 10.0, 0, 3.0)
    forecast_rain = np.asarray([np.clip(rain[hour + 1:hour + 7].sum(), 0, 120) for hour in range(n_hours)])
    forecast_wind = np.asarray([np.mean(wind[hour + 1:min(n_hours, hour + 7)]) if hour + 1 < n_hours else wind[hour] for hour in range(n_hours)])
    # The forecast terms are intentionally strong: this is the documented
    # synthetic mechanism that gives the outage model a learnable weather
    # signal.  In a real deployment these must be genuine ex-ante forecasts.
    forecast_rain_stress = np.clip(forecast_rain / 10.0, 0, 6.0)
    forecast_wind_stress = np.clip((forecast_wind - 14.0) / 8.0, 0, 4.0)
    weather_stress = 0.8 * rain_stress + 0.4 * wind_stress + 2.2 * forecast_rain_stress + 1.4 * forecast_wind_stress
    weather_multiplier = np.exp(np.clip(weather_stress, 0, 5))
    # Calibrate only the intercept so the mechanism changes timing, not the
    # intended overall outage rate.  The rain/wind multiplier is shared by all
    # clinics on the same feeder and is intentionally stronger than noise.
    base_start_probability = 0.0040 / float(np.mean(weather_multiplier))

    # Shared feeder events use independent reproducible streams.  Independent
    # clinic streams below keep local columns stable when feeder hazard logic
    # changes.
    feeder_outage = np.zeros((config.feeders, n_hours), dtype=bool)
    feeder_age = np.zeros((config.feeders, n_hours), dtype=float)
    feeder_hazard = np.zeros((config.feeders, n_hours), dtype=float)
    for feeder in range(config.feeders):
        feeder_rng = np.random.default_rng([config.seed, 20_000 + feeder])
        sensitivity = float(feeder_rng.uniform(0.85, 1.15))
        hour = 0
        while hour < n_hours:
            hazard = base_start_probability * sensitivity * weather_multiplier
            feeder_hazard[feeder] = hazard
            if feeder_rng.random() < min(0.25, float(hazard[hour])):
                duration = int(feeder_rng.integers(2, 8))
                feeder_outage[feeder, hour:min(n_hours, hour + duration)] = True
                hour += duration
            else:
                hour += 1
        for t in range(1, n_hours):
            feeder_age[feeder, t] = feeder_age[feeder, t - 1] + 1 if feeder_outage[feeder, t] else 0

    rows: list[dict[str, object]] = []
    all_temps: list[np.ndarray] = []
    for clinic in range(config.clinics):
        feeder_id = int(feeder_for_clinic[clinic])
        clinic_rng = np.random.default_rng([config.seed, clinic + 1])
        # Local faults are independent and tend to be short. Freeze faults are rare.
        local_fault = np.zeros(n_hours, dtype=bool)
        freeze_fault = np.zeros(n_hours, dtype=bool)
        cooling_failure = np.zeros(n_hours, dtype=bool)
        door_open_minutes = np.zeros(n_hours, dtype=float)
        for hour in range(n_hours):
            if clinic_rng.random() < 0.0020:
                local_fault[hour:min(n_hours, hour + int(clinic_rng.integers(2, 10)))] = True
            if clinic_rng.random() < 0.0008:
                freeze_fault[hour:min(n_hours, hour + int(clinic_rng.integers(2, 6)))] = True
            if clinic_rng.random() < 0.0012:
                cooling_failure[hour:min(n_hours, hour + int(clinic_rng.integers(3, 9)))] = True
            if clinic_rng.random() < 0.08:
                duration = int(clinic_rng.integers(1, 3))
                door_open_minutes[hour:min(n_hours, hour + duration)] = clinic_rng.uniform(8.0, 30.0)
        insulation_tau_hours = float(clinic_rng.uniform(20.0, 28.0))
        temps = np.empty(n_hours, dtype=float)
        humidity = np.clip(62 + 12 * np.sin(day_angle + 0.4) + clinic_rng.normal(0, 4, n_hours), 25, 98)
        temps[0] = 4.5 + clinic_rng.normal(0, 0.25)
        initial_step = thermal_step(
            temps[0], outdoor[0], power_on=not bool(feeder_outage[feeder_id - 1, 0] or local_fault[0]),
            cooling_failure=bool(cooling_failure[0]), freeze_active=bool(freeze_fault[0]),
            door_open_minutes=float(door_open_minutes[0]), insulation_tau_hours=insulation_tau_hours,
            dt_hours=0, noise_c=0,
        )
        compressor_on = np.zeros(n_hours, dtype=bool)
        compressor_duty = np.zeros(n_hours, dtype=float)
        compressor_on[0] = bool(initial_step["compressor_on"])
        compressor_duty[0] = float(initial_step["compressor_duty"])
        for hour in range(1, n_hours):
            outage = feeder_outage[feeder_id - 1, hour]
            fault = local_fault[hour]
            frozen = freeze_fault[hour]
            step = thermal_step(
                temps[hour - 1], outdoor[hour], power_on=not bool(outage or fault),
                cooling_failure=bool(cooling_failure[hour]), freeze_active=bool(frozen),
                door_open_minutes=float(door_open_minutes[hour]), insulation_tau_hours=insulation_tau_hours,
                noise_c=float(clinic_rng.normal(0, 0.08)),
            )
            temps[hour] = float(step["temperature_c"])
            compressor_on[hour] = bool(step["compressor_on"])
            compressor_duty[hour] = float(step["compressor_duty"])
        all_temps.append(temps)
        labels = _future_spoilage_labels(temps)
        for hour, stamp in enumerate(timestamps):
            rows.append({
                "timestamp": stamp,
                "clinic_id": f"CL-{clinic + 1:02d}",
                "clinic_index": clinic,
                "feeder_id": feeder_id,
                "temperature_c": round(float(temps[hour]), 4),
                "humidity_pct": round(float(humidity[hour]), 3),
                "outdoor_temp_c": round(float(outdoor[hour]), 3),
                "ambient_temp_c": round(float(outdoor[hour]), 3),
                "forecast_rain_next_6h": round(float(forecast_rain[hour]), 3),
                "forecast_wind_next_6h": round(float(forecast_wind[hour]), 3),
                "power_on": not bool(feeder_outage[feeder_id - 1, hour] or local_fault[hour]),
                "local_fault": bool(local_fault[hour]),
                "feeder_online": not bool(feeder_outage[feeder_id - 1, hour]),
                "outage_hours": float(feeder_age[feeder_id - 1, hour]),
                "feeder_weather_stress": round(float(weather_stress[hour]), 4),
                "feeder_outage_hazard": round(float(feeder_hazard[feeder_id - 1, hour]), 8),
                "door_open": bool(door_open_minutes[hour] > 0),
                "door_open_minutes": round(float(door_open_minutes[hour]), 2),
                "cooling_failure": bool(cooling_failure[hour]),
                "compressor_on": bool(compressor_on[hour]),
                "compressor_duty": round(float(compressor_duty[hour]), 4),
                "insulation_tau_hours": round(insulation_tau_hours, 3),
                "thermal_model": "newton-cooling-refrigerator-v1",
                "spoilage_proxy": int(labels[hour]),
            })
    frame = pd.DataFrame(rows)
    features = build_feature_frame(frame)
    for column in features.columns:
        frame[column] = features[column].to_numpy()
    # Last horizon rows have no complete future window and are excluded.
    frame = frame.groupby("clinic_id", group_keys=False).head(-6).reset_index(drop=True)
    frame = frame.sort_values(["feeder_id", "timestamp"], kind="stable").reset_index(drop=True)
    feeder_online = frame["feeder_online"].astype(bool)
    previous_online = feeder_online.groupby(frame["feeder_id"]).shift(1, fill_value=True)
    frame["outage_start"] = ((~feeder_online) & previous_online).astype("int8")
    future_outage = [frame["outage_start"].groupby(frame["feeder_id"]).shift(-step, fill_value=0).astype(bool) for step in range(1, 7)]
    frame["outage_start_next_6h"] = pd.concat(future_outage, axis=1).any(axis=1).astype("int8")
    # Keep the user-facing target name explicit while retaining the descriptive
    # proxy name for readers of older generated artifacts.
    frame["spoilage"] = frame["spoilage_proxy"].astype("int8")
    return frame
