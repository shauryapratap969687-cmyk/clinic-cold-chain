"""Shared feature engineering for training and the live simulator.

The feature list is deliberately small and uses only information available at
the prediction timestamp.  In particular, future temperature values are never
used by :func:`build_feature_row`.
"""

from __future__ import annotations

from datetime import datetime
from typing import Mapping

import numpy as np
import pandas as pd

FEATURE_COLUMNS = [
    "temperature_c",
    "temperature_lag1",
    "temp_delta_c",
    "humidity_pct",
    "outdoor_temp_c",
    "forecast_rain_next_6h",
    "forecast_wind_next_6h",
    "hour",
    "day_of_week",
    "month",
    "is_evening",
    "too_cold",
    "power_on",
    "local_fault",
    "feeder_online",
    "outage_hours",
    "feeder_id",
    "clinic_index",
]


def add_time_columns(frame: pd.DataFrame, timestamp_column: str = "timestamp") -> pd.DataFrame:
    """Return a copy with deterministic calendar features."""
    result = frame.copy()
    dates = pd.to_datetime(result[timestamp_column], utc=True)
    result["hour"] = dates.dt.hour.astype(float)
    result["day_of_week"] = dates.dt.dayofweek.astype(float)
    result["month"] = dates.dt.month.astype(float)
    result["is_evening"] = dates.dt.hour.isin([18, 19, 20, 21, 22]).astype(float)
    return result


def build_feature_frame(frame: pd.DataFrame) -> pd.DataFrame:
    """Build model features from a historical or synthetic observations frame.

    ``temperature_lag1`` and ``temp_delta_c`` are grouped by clinic and sorted
    by timestamp.  Missing lag values are filled with the current temperature,
    which is also what the simulator uses after a reset.
    """
    result = add_time_columns(frame)
    if "clinic_id" in result:
        result = result.sort_values(["clinic_id", "timestamp"], kind="stable")
        result["temperature_lag1"] = result.groupby("clinic_id")["temperature_c"].shift(1)
    elif "temperature_lag1" not in result:
        result["temperature_lag1"] = result["temperature_c"]
    result["temperature_lag1"] = result["temperature_lag1"].fillna(result["temperature_c"])
    result["temp_delta_c"] = result["temperature_c"] - result["temperature_lag1"]
    result["too_cold"] = (result["temperature_c"] < 2.0).astype(float)
    for column in ("power_on", "local_fault", "feeder_online"):
        if column not in result:
            result[column] = 1.0 if column != "local_fault" else 0.0
    for column in ("outage_hours", "feeder_id", "clinic_index", "humidity_pct", "outdoor_temp_c",
                  "forecast_rain_next_6h", "forecast_wind_next_6h"):
        if column not in result:
            result[column] = 0.0
    return result[FEATURE_COLUMNS].astype(float)


def build_feature_row(observation: Mapping[str, object] | pd.Series, timestamp: datetime | str) -> np.ndarray:
    """Build one live prediction row using precisely the training features."""
    row = dict(observation)
    stamp = pd.Timestamp(timestamp)
    stamp = stamp.tz_localize("UTC") if stamp.tzinfo is None else stamp.tz_convert("UTC")
    temperature = float(row.get("temperature_c", 4.5))
    lag = float(row.get("temperature_lag1", temperature))
    values = {
        "temperature_c": temperature,
        "temperature_lag1": lag,
        "temp_delta_c": temperature - lag,
        "humidity_pct": float(row.get("humidity_pct", 65.0)),
        "outdoor_temp_c": float(row.get("outdoor_temp_c", 25.0)),
        "forecast_rain_next_6h": float(row.get("forecast_rain_next_6h", 0.0)),
        "forecast_wind_next_6h": float(row.get("forecast_wind_next_6h", 12.0)),
        "hour": float(stamp.hour),
        "day_of_week": float(stamp.dayofweek),
        "month": float(stamp.month),
        "is_evening": float(stamp.hour in (18, 19, 20, 21, 22)),
        "too_cold": float(temperature < 2.0),
        "power_on": float(bool(row.get("power_on", True))),
        "local_fault": float(bool(row.get("local_fault", False))),
        "feeder_online": float(bool(row.get("feeder_online", True))),
        "outage_hours": float(row.get("outage_hours", 0.0)),
        "feeder_id": float(row.get("feeder_id", 1)),
        "clinic_index": float(row.get("clinic_index", 0)),
    }
    return np.asarray([[values[name] for name in FEATURE_COLUMNS]], dtype=float)
