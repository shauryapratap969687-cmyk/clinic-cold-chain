"""Reproducible physical-ish cold-chain telemetry generator."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from .features import build_feature_frame


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
    rng = np.random.default_rng(config.seed)
    n_hours = config.days * 24
    timestamps = pd.date_range("2025-01-01", periods=n_hours, freq="h", tz="UTC")
    feeder_for_clinic = np.arange(config.clinics) % config.feeders + 1
    # A modest number of shared events keeps the natural class imbalance.
    feeder_outage = np.zeros((config.feeders, n_hours), dtype=bool)
    feeder_age = np.zeros((config.feeders, n_hours), dtype=float)
    for feeder in range(config.feeders):
        hour = 0
        while hour < n_hours:
            if rng.random() < 0.0018:
                duration = int(rng.integers(2, 8))
                feeder_outage[feeder, hour:min(n_hours, hour + duration)] = True
                hour += duration
            else:
                hour += 1
        for t in range(1, n_hours):
            feeder_age[feeder, t] = feeder_age[feeder, t - 1] + 1 if feeder_outage[feeder, t] else 0

    # Seasonal/daily weather shared across clinics, plus tiny local variation.
    t = np.arange(n_hours)
    day_angle = 2 * np.pi * (t % 24) / 24
    year_angle = 2 * np.pi * t / (24 * 365)
    outdoor = 22 + 7 * np.sin(day_angle - np.pi / 2) + 4 * np.sin(year_angle) + rng.normal(0, 1.2, n_hours)
    rain = np.clip(rng.gamma(1.2, 3.0, n_hours) * (rng.random(n_hours) < 0.10), 0, 45)
    wind = np.clip(10 + 5 * np.sin(day_angle) + rng.normal(0, 3, n_hours), 0, 45)
    rows: list[dict[str, object]] = []
    all_temps: list[np.ndarray] = []
    for clinic in range(config.clinics):
        feeder_id = int(feeder_for_clinic[clinic])
        # Local faults are independent and tend to be short. Freeze faults are rare.
        local_fault = np.zeros(n_hours, dtype=bool)
        freeze_fault = np.zeros(n_hours, dtype=bool)
        for hour in range(n_hours):
            if rng.random() < 0.0020:
                local_fault[hour:min(n_hours, hour + int(rng.integers(2, 10)))] = True
            if rng.random() < 0.0008:
                freeze_fault[hour:min(n_hours, hour + int(rng.integers(2, 6)))] = True
        temps = np.empty(n_hours, dtype=float)
        humidity = np.clip(62 + 12 * np.sin(day_angle + 0.4) + rng.normal(0, 4, n_hours), 25, 98)
        temps[0] = 4.5 + rng.normal(0, 0.25)
        for hour in range(1, n_hours):
            outage = feeder_outage[feeder_id - 1, hour]
            fault = local_fault[hour]
            frozen = freeze_fault[hour]
            target = 4.5 + 0.05 * (outdoor[hour] - 22) + rng.normal(0, 0.08)
            if outage or fault:
                # Power loss causes a realistic, gradual warming excursion.
                target += 6.0 if outage else 5.5
                rate = 0.28 if outage else 0.34
            else:
                rate = 0.16
            if frozen:
                target = -1.0
                rate = 0.46
            temps[hour] = temps[hour - 1] + rate * (target - temps[hour - 1]) + rng.normal(0, 0.10)
            if not (outage or fault or frozen):
                temps[hour] = np.clip(temps[hour], 2.5, 6.8)
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
                "forecast_rain_next_6h": round(float(np.clip(rain[hour:hour + 6].sum(), 0, 120)), 3),
                "forecast_wind_next_6h": round(float(np.mean(wind[hour:min(n_hours, hour + 6)])), 3),
                "power_on": not bool(feeder_outage[feeder_id - 1, hour] or local_fault[hour]),
                "local_fault": bool(local_fault[hour]),
                "feeder_online": not bool(feeder_outage[feeder_id - 1, hour]),
                "outage_hours": float(feeder_age[feeder_id - 1, hour]),
                "spoilage_proxy": int(labels[hour]),
            })
    frame = pd.DataFrame(rows)
    features = build_feature_frame(frame)
    for column in features.columns:
        frame[column] = features[column].to_numpy()
    # Last horizon rows have no complete future window and are excluded.
    frame = frame.groupby("clinic_id", group_keys=False).head(-6).reset_index(drop=True)
    # Keep the user-facing target name explicit while retaining the descriptive
    # proxy name for readers of older generated artifacts.
    frame["spoilage"] = frame["spoilage_proxy"].astype("int8")
    return frame
