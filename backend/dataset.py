"""Training-data loading and normalization for the packaged clinic dataset.

The v3 archive is simulated hourly clinic data.  Its field names are more
descriptive than the original generator's canonical model fields, so this
module maps the observed fridge/weather columns into the existing feature
contract without exposing future labels or priority/SMS outcomes as inputs.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from .features import FEATURE_COLUMNS, build_feature_frame


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DATASET_PATH = REPOSITORY_ROOT / "datasets" / "clinic_cold_chain_v3" / "synthetic_clinic_data.csv"

# These are outcomes, hidden truth, or post-alert fields.  They may remain in
# the saved dataset for review, but must never enter the model feature matrix.
FORBIDDEN_MODEL_COLUMNS = frozenset({
    "breach_next_6h",
    "breach_next_6h_new",
    "cold_chain_breach",
    "true_fridge_temp_c",
    "hours_until_unusable",
    "sms_state",
    "follow_up_reply",
    "priority_rank",
    "priority_rank_before_followup",
    "priority_slack_h",
    "hours_to_8c_priority",
})


def _clinic_index(values: pd.Series) -> tuple[pd.Series, pd.Series]:
    numeric = pd.to_numeric(values, errors="coerce")
    if numeric.notna().all():
        indexes = numeric.astype(int) - 1
        labels = numeric.map(lambda value: f"CL-{int(value):02d}")
        return labels, indexes.astype(float)

    labels = values.astype(str)
    existing = pd.to_numeric(labels.str.extract(r"(\d+)$", expand=False), errors="coerce")
    if existing.notna().all():
        return labels, (existing.astype(int) - 1).astype(float)
    categories = {value: index for index, value in enumerate(sorted(labels.unique()))}
    return labels, labels.map(categories).astype(float)


def _numeric(frame: pd.DataFrame, column: str, default: float | None = None) -> pd.Series:
    if column in frame:
        return pd.to_numeric(frame[column], errors="coerce")
    if default is None:
        return pd.Series(np.nan, index=frame.index, dtype=float)
    return pd.Series(float(default), index=frame.index, dtype=float)


def _normalize_v3(frame: pd.DataFrame) -> pd.DataFrame:
    required = {"timestamp", "clinic_id", "feeder_id", "fridge_temp_c", "breach_next_6h"}
    missing = sorted(required.difference(frame.columns))
    if missing:
        raise ValueError(f"dataset is missing required v3 columns: {', '.join(missing)}")

    result = frame.copy()
    result["timestamp"] = pd.to_datetime(result["timestamp"], utc=True, errors="coerce")
    if result["timestamp"].isna().any():
        raise ValueError("dataset contains an invalid timestamp")
    result["clinic_id"], result["clinic_index"] = _clinic_index(result["clinic_id"])
    result["feeder_id"] = _numeric(result, "feeder_id", 1.0)

    # v3 names the ambient/weather temperature temperature_c and the observed
    # fridge probe fridge_temp_c.  Preserve the model contract by assigning the
    # fridge probe to temperature_c and ambient weather to outdoor_temp_c.
    ambient = _numeric(result, "temperature_c", 25.0)
    result["temperature_c"] = _numeric(result, "fridge_temp_c")
    result["temperature_lag1"] = _numeric(result, "fridge_temp_lag1_c")
    result["temp_delta_c"] = _numeric(result, "fridge_temp_delta_c")
    result["outdoor_temp_c"] = ambient
    result["forecast_rain_next_6h"] = _numeric(result, "forecast_rain_next_6h_mm", 0.0)
    result["forecast_wind_next_6h"] = _numeric(result, "forecast_max_wind_next_6h_kmh", 0.0)

    if "power_source" in result:
        result["power_on"] = result["power_source"].map({"grid": 1.0, "battery": 1.0, "none": 0.0})
    else:
        result["power_on"] = _numeric(result, "power_on")
    result["local_fault"] = _numeric(result, "local_fault", 0.0)
    result["feeder_online"] = _numeric(result, "feeder_online", 1.0)
    result["outage_hours"] = _numeric(result, "outage_hours", 0.0)

    target = _numeric(result, "breach_next_6h")
    valid_target = target.notna()
    result = result.loc[valid_target].copy()
    result["spoilage"] = target.loc[valid_target].astype("int8")
    result["spoilage_proxy"] = result["spoilage"]

    result = result.sort_values(["clinic_id", "timestamp"], kind="stable").reset_index(drop=True)
    features = build_feature_frame(result)
    for column in FEATURE_COLUMNS:
        result[column] = features[column].to_numpy()
    return result


def normalize_training_frame(frame: pd.DataFrame) -> pd.DataFrame:
    """Return a frame satisfying the existing training feature/target contract."""
    if "fridge_temp_c" in frame.columns and "breach_next_6h" in frame.columns:
        return _normalize_v3(frame)
    if "spoilage" not in frame.columns:
        raise ValueError("dataset must contain either v3 breach_next_6h or spoilage target")

    result = frame.copy()
    result["timestamp"] = pd.to_datetime(result["timestamp"], utc=True, errors="coerce")
    if result["timestamp"].isna().any():
        raise ValueError("dataset contains an invalid timestamp")
    result["spoilage"] = pd.to_numeric(result["spoilage"], errors="raise").astype("int8")
    if "spoilage_proxy" not in result:
        result["spoilage_proxy"] = result["spoilage"]
    features = build_feature_frame(result)
    for column in FEATURE_COLUMNS:
        result[column] = features[column].to_numpy()
    return result.reset_index(drop=True)


def load_training_dataset(path: str | Path) -> tuple[pd.DataFrame, dict[str, Any]]:
    """Load a CSV and return normalized rows plus provenance metadata."""
    dataset_path = Path(path).expanduser().resolve()
    if not dataset_path.is_file():
        raise FileNotFoundError(f"training dataset not found: {dataset_path}")
    frame = pd.read_csv(dataset_path, low_memory=False)
    normalized = normalize_training_frame(frame)
    forbidden_features = sorted(FORBIDDEN_MODEL_COLUMNS.intersection(FEATURE_COLUMNS))
    if forbidden_features:
        raise ValueError(f"forbidden outcome fields entered the feature contract: {forbidden_features}")
    try:
        display_path = str(dataset_path.relative_to(REPOSITORY_ROOT))
    except ValueError:
        display_path = str(dataset_path)
    return normalized, {
        "source": "packaged clinic_cold_chain_v3" if dataset_path == DEFAULT_DATASET_PATH.resolve() else "external CSV",
        "path": display_path,
        "raw_rows": int(len(frame)),
        "rows": int(len(normalized)),
        "columns": int(len(frame.columns)),
        "clinic_count": int(normalized["clinic_id"].nunique()),
        "target": "breach_next_6h mapped to spoilage",
    }
